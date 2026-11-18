import { createJiraKanbanClient } from "./jira-kanban.ts";
// Jira import and status transitions. Imported issues coexist with local
// tasks in the same board; their origin ("jira") and originKey keep them
// traceable back to the tracker, and a transition writes back to Jira before
// the local column moves.
//
// Concurrency: every mutation that touches a board's columns or tasks
// (fetch, transition, remote move) is serialized per connection, so two
// concurrent operations cannot replace columns with a stale snapshot or
// interleave a preflight with another POST.
import { moveLocalTask } from "./board.ts";
import type { BoardDeps } from "./board.ts";
import { resolveJiraAuth } from "./connections.ts";
import { DomainError } from "./errors.ts";
import { createJiraClient, type FetchLike, type JiraClient, type JiraIssueSummary } from "./jira.ts";
import { boundedText, COLUMNS_MAX, NAME_MAX, taskSchema, type Board, type Column, type Task } from "./model.ts";
import type { CredentialStore, IdGenerator, TaskStore } from "./ports.ts";

export interface SyncDeps extends BoardDeps {
  credentials: CredentialStore;
  fetchFn?: FetchLike;
}

// Board-scoped serialization keyed by connection id (a connection owns at
// most one board). Operations never re-enter the lock.
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  chains.set(key, run);
  void run
    .finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    })
    .catch(() => {});
  return run;
}

function connectionKey(connectionId: string): string {
  return "conn:" + connectionId;
}

export function jiraClientFor(connectionId: string, deps: SyncDeps): JiraClient {
  const auth = resolveJiraAuth(connectionId, deps);
  return createJiraClient(auth, deps.fetchFn);
}

function boardForConnection(connectionId: string, deps: SyncDeps): { board: Board; columns: Column[] } {
  const existing = deps.store.listBoards().find((board) => board.connectionId === connectionId);
  if (existing !== undefined) {
    return { board: existing, columns: deps.store.listColumns(existing.id) };
  }
  const connection = deps.store.getConnection(connectionId);
  const name = connection === null ? "Jira" : connection.name;
  const id = deps.idgen.newId();
  const board: Board = { id, name, connectionId };
  deps.store.saveBoard(board);
  const columns: Column[] = ["To do", "In progress", "Done"].map((columnName, order) => ({
    id: deps.idgen.newId(),
    boardId: id,
    name: columnName,
    order,
  }));
  deps.store.saveColumns(id, columns);
  return { board, columns };
}

/** A Jira status name normalized to a bounded column name ("" → No status). */
function statusColumnName(statusName: string): string {
  const trimmed = statusName.trim();
  return trimmed === "" ? "No status" : boundedText(trimmed, NAME_MAX);
}

/** Returns the column id for a status name, appending a new column if needed. */
function columnForStatus(boardId: string, statusName: string, columns: Column[], deps: SyncDeps): Column {
  const name = statusColumnName(statusName);
  const existing = columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  if (existing !== undefined) return existing;
  if (columns.length >= COLUMNS_MAX) {
    throw new DomainError("conflict", "This board is at its column limit (" + COLUMNS_MAX + ")");
  }
  const maxOrder = columns.reduce((max, column) => Math.max(max, column.order), -1);
  const column: Column = { id: deps.idgen.newId(), boardId, name, order: maxOrder + 1 };
  const next = [...columns, column];
  deps.store.saveColumns(boardId, next);
  columns.splice(0, columns.length, ...next);
  return column;
}

/** Validates a task against the wire schema; returns false for a poisoned row. */
function isValidTask(task: Task): boolean {
  return taskSchema.safeParse(task).success;
}

function upsertFromIssue(board: Board, column: Column, issue: JiraIssueSummary, deps: SyncDeps, inScope = true): boolean {
  const title = issue.summary.trim() === "" ? issue.key : issue.summary.trim();
  if (title === "" || issue.key === "") return false;
  const existing = deps.store
    .listTasks(board.id)
    .find((task) => task.origin === "jira" && task.originKey === issue.key);
  const now = deps.clock.now().toISOString();
  if (existing !== undefined) {
    const next: Task = {
      ...existing,
      inScope,
      title,
      status: column.id,
      originUrl: issue.url,
      labels: issue.labels,
      description: issue.description,
      updatedAt: now,
    };
    if (!isValidTask(next)) return false;
    deps.store.saveTask(next);
    return true;
  }
  const maxOrder = deps.store.listTasks(board.id).reduce((max, task) => Math.max(max, task.sortOrder), -1);
  const task: Task = {
    id: deps.idgen.newId(),
    boardId: board.id,
    title,
    description: issue.description,
    status: column.id,
    origin: "jira",
    inScope,
    originKey: issue.key,
    originUrl: issue.url,
    labels: issue.labels,
    createdAt: now,
    updatedAt: now,
    sortOrder: maxOrder + 1,
  };
  if (!isValidTask(task)) return false;
  deps.store.saveTask(task);
  return true;
}

export function defaultJql(_connection: { projectKey: string; jql: string }): string {
  return "assignee = currentUser() ORDER BY project ASC, updated DESC";
}

export async function fetchIssues(
  connectionId: string,
  deps: SyncDeps,
): Promise<{ imported: number; total: number | null; truncated: boolean }> {
  const connection = deps.store.getConnection(connectionId);
  if (connection === null) throw new DomainError("not_found", "Connection not found");
  const jql = defaultJql(connection);
  return serialize(connectionKey(connectionId), () => fetchIssuesInner(connectionId, jql, deps));
}

async function fetchIssuesInner(
  connectionId: string,
  jql: string,
  deps: SyncDeps,
): Promise<{ imported: number; total: number | null; truncated: boolean }> {
  const { board } = boardForConnection(connectionId, deps);
  const client = jiraClientFor(connectionId, deps);
  const { issues, total, truncated } = await client.listIssues(jql);

  // Revalidate after the await: the connection or board may have been deleted.
  if (deps.store.getConnection(connectionId) === null || deps.store.getBoard(board.id) === null) {
    return { imported: 0, total, truncated };
  }

  // Re-read columns AFTER the await: within the lock nothing else can have
  // mutated them, but never persist a snapshot captured before an await.
  const columns = deps.store.listColumns(board.id);

  // Validate the resulting column count before any mutation, so a partial
  // import cannot push the board past the schema's column cap.
  const existingNames = new Set(columns.map((column) => column.name.toLowerCase()));
  const newNames = new Set<string>();
  for (const issue of issues) {
    const name = statusColumnName(issue.statusName).toLowerCase();
    if (!existingNames.has(name)) newNames.add(name);
  }
  if (columns.length + newNames.size > COLUMNS_MAX) {
    throw new DomainError("conflict", "This board would need more than " + COLUMNS_MAX + " columns");
  }

  let imported = 0;
  deps.store.transaction(() => {
    if (!truncated) {
      const keys = new Set(issues.map((issue) => issue.key));
      for (const task of deps.store.listTasks(board.id)) {
        if (task.origin === "jira" && !keys.has(task.originKey ?? "")) deps.store.saveTask({ ...task, inScope: false });
      }
    }
    for (const issue of issues) {
      const column = columnForStatus(board.id, issue.statusName, columns, deps);
      if (upsertFromIssue(board, column, issue, deps)) imported += 1;
    }
  });
  return { imported, total, truncated };
}

function findTransitionByName(transitions: { id: string; toName: string }[], columnName: string) {
  return transitions.find((transition) => transition.toName.toLowerCase() === columnName.toLowerCase());
}

export function applyTransition(
  connectionId: string,
  issueKey: string,
  transitionId: string,
  deps: SyncDeps,
): Promise<Task> {
  return serialize(connectionKey(connectionId), () => applyTransitionInner(connectionId, issueKey, transitionId, deps));
}

async function applyTransitionInner(
  connectionId: string,
  issueKey: string,
  transitionId: string,
  deps: SyncDeps,
): Promise<Task> {
  const client = jiraClientFor(connectionId, deps);
  const transitions = await client.getTransitions(issueKey);
  const match = transitions.find((transition) => transition.id === transitionId);
  if (match === undefined) throw new DomainError("not_found", "Transition not found");
  const board = deps.store.listBoards().find((candidate) => candidate.connectionId === connectionId);
  if (board === undefined) throw new DomainError("not_found", "Board not found");
  const task = deps.store
    .listTasks(board.id)
    .find((entry) => entry.origin === "jira" && entry.originKey === issueKey);
  if (task === undefined) throw new DomainError("not_found", "Task not found");

  // Preflight column capacity BEFORE any remote POST: a transition to a new
  // status that would exceed the column cap is refused without a POST.
  const currentColumns = deps.store.listColumns(board.id);
  const targetName = statusColumnName(match.toName);
  const exists = currentColumns.some((column) => column.name.toLowerCase() === targetName.toLowerCase());
  if (!exists && currentColumns.length >= COLUMNS_MAX) {
    throw new DomainError("conflict", "This board is at its column limit (" + COLUMNS_MAX + ")");
  }

  // Revalidate BEFORE any POST, then resolve a FRESH client so the POST uses
  // the current credential (or refuses when the secret/connection is gone),
  // never the auth retained across the transitions GET.
  const currentBoard = deps.store.getBoard(board.id);
  if (deps.store.getConnection(connectionId) === null) {
    throw new DomainError("not_found", "Connection no longer exists");
  }
  if (currentBoard === null || currentBoard.connectionId !== connectionId) {
    throw new DomainError("not_found", "Board no longer linked to this connection");
  }
  if (deps.store.getTask(task.id) === null) {
    throw new DomainError("not_found", "Task no longer exists");
  }

  const freshClient = jiraClientFor(connectionId, deps);
  await freshClient.transition(issueKey, transitionId);

  // Revalidate after the POST: the board, connection or task may be gone.
  if (deps.store.getConnection(connectionId) === null || deps.store.getBoard(board.id) === null) {
    throw new DomainError("not_found", "Board no longer exists");
  }
  const currentTask = deps.store.getTask(task.id);
  if (currentTask === null) throw new DomainError("not_found", "Task no longer exists");

  const freshColumns = deps.store.listColumns(board.id);
  const column = columnForStatus(board.id, match.toName, freshColumns, deps);
  const next: Task = { ...currentTask, status: column.id, updatedAt: deps.clock.now().toISOString() };
  if (!isValidTask(next)) throw new DomainError("conflict", "The transition result could not be stored");
  deps.store.saveTask(next);
  return next;
}

export function moveTask(taskId: string, status: string, deps: SyncDeps): Promise<Task> {
  const task = deps.store.getTask(taskId);
  if (task === null) throw new DomainError("not_found", "Task not found");
  if (task.origin !== "jira" || task.originKey === null) {
    return Promise.resolve(moveLocalTask(taskId, status, deps));
  }
  const board = deps.store.getBoard(task.boardId);
  const connectionId = board?.connectionId ?? null;
  if (connectionId === null) throw new DomainError("invalid", "This Jira task has no connection");
  return serialize(connectionKey(connectionId), () => moveTaskInner(taskId, status, deps));
}

async function moveTaskInner(taskId: string, status: string, deps: SyncDeps): Promise<Task> {
  const task = deps.store.getTask(taskId);
  if (task === null) throw new DomainError("not_found", "Task not found");
  const columns = deps.store.listColumns(task.boardId);
  const target = columns.find((column) => column.id === status);
  if (target === undefined) throw new DomainError("invalid", "Unknown status column");
  const board = deps.store.getBoard(task.boardId);
  const connectionId = board?.connectionId ?? null;
  if (connectionId === null) throw new DomainError("invalid", "This Jira task has no connection");
  const client = jiraClientFor(connectionId, deps);
  const transitions = await client.getTransitions(task.originKey!);
  const match = findTransitionByName(transitions, target.name);
  if (match === undefined) {
    throw new DomainError("conflict", "No Jira transition leads to this column");
  }

  // Revalidate BEFORE any POST, then resolve a FRESH client so the POST uses
  // the current credential, never the auth retained across the transitions GET.
  const currentBoard = deps.store.getBoard(task.boardId);
  if (deps.store.getConnection(connectionId) === null) {
    throw new DomainError("not_found", "Connection no longer exists");
  }
  if (currentBoard === null || currentBoard.connectionId !== connectionId) {
    throw new DomainError("not_found", "Board no longer linked to this connection");
  }
  if (deps.store.getTask(taskId) === null) {
    throw new DomainError("not_found", "Task no longer exists");
  }

  const freshClient = jiraClientFor(connectionId, deps);
  await freshClient.transition(task.originKey!, match.id);

  // Revalidate after the POST: the connection, board or task may be gone.
  if (deps.store.getConnection(connectionId) === null || deps.store.getBoard(task.boardId) === null) {
    throw new DomainError("not_found", "Board no longer exists");
  }
  const currentTask = deps.store.getTask(taskId);
  if (currentTask === null) throw new DomainError("not_found", "Task no longer exists");

  const next: Task = { ...currentTask, status: target.id, updatedAt: deps.clock.now().toISOString() };
  if (!isValidTask(next)) throw new DomainError("conflict", "The move result could not be stored");
  deps.store.saveTask(next);
  return next;
}


export function jiraKanbanClientFor(connectionId: string, deps: SyncDeps) {
  return createJiraKanbanClient(resolveJiraAuth(connectionId, deps), deps.fetchFn);
}

export async function fetchJiraKanban(connectionId: string, projectKey: string, jiraBoardId: number, deps: SyncDeps) {
  return serialize(connectionKey(connectionId), async () => {
    const originalBoard = deps.store.listBoards().find(board => board.connectionId === connectionId);
    if (!originalBoard) throw new DomainError("not_found", "Connected board not found");
    const client = jiraKanbanClientFor(connectionId, deps);
    const boards = await client.boards(projectKey);
    if (!boards.some(board => board.id === jiraBoardId)) throw new DomainError("not_found", "Jira board is not available for this project");
    const columns = await client.columns(jiraBoardId);
    const issues = await client.issues(jiraBoardId, projectKey);
    resolveJiraAuth(connectionId, deps);
    const board = deps.store.getBoard(originalBoard.id);
    if (!board || board.connectionId !== connectionId) throw new DomainError("not_found", "Board was removed");
    const storedColumns = deps.store.listColumns(board.id);
    const items: { task: Task; statusId: string }[] = [];
    deps.store.transaction(() => {
      for (const issue of issues) {
        const existing = deps.store.listTasks(board.id).find(task => task.origin === "jira" && task.originKey === issue.key);
        const column = columnForStatus(board.id, issue.statusName, storedColumns, deps);
        if (upsertFromIssue(board, column, issue, deps, existing?.inScope !== false && existing !== undefined)) {
          const task = deps.store.listTasks(board.id).find(task => task.origin === "jira" && task.originKey === issue.key)!;
          items.push({ task, statusId: issue.statusId });
        }
      }
    });
    return { columns, items };
  });
}


/** Project picker follows the last completed assigned-task fetch, not the
 * board cache: viewing teammates' tasks must not expand the project choices. */
export async function listAssignedJiraProjects(connectionId: string, deps: SyncDeps) {
  const board = deps.store.listBoards().find(board => board.connectionId === connectionId);
  const keys = new Set(board ? deps.store.listTasks(board.id)
    .filter(task => task.origin === "jira" && task.inScope !== false && task.originKey)
    .map(task => task.originKey!.replace(/-\d+$/, "")) : []);
  if (keys.size === 0) return [];
  const projects = await jiraKanbanClientFor(connectionId, deps).projects();
  return projects.filter(project => keys.has(project.key));
}
