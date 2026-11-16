import { registerWorklogTools } from "./src/adapters/bb/worklog-tools.ts";
// Makosh Taskboard — BB backend entry.
//
// Composition root: builds the BB implementations of the core's ports and
// exposes the core over BB RPC. Credentials (API token / PAT) never leave
// this process except as a one-way Authorization header to the configured
// Jira origin; public connection records carry only a hasCredential flag.
import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createCredentialStore,
  generateVaultKey,
  isVaultKey,
} from "./src/adapters/bb/credential-store.ts";
import { createSqliteStore, MIGRATIONS } from "./src/adapters/bb/sqlite-store.ts";
import {
  listAssignedJiraProjects,
  fetchJiraKanban,
  jiraKanbanClientFor,
  prepareWorklog,
  DomainError,
  applyTransition,
  createBoard,
  createConnection,
  createTask,
  deleteBoard,
  deleteConnection,
  deleteTask,
  fetchIssues,
  jiraClientFor,
  listBoards,
  listConnections,
  listTasks,
  moveTask,
  rpcSchemas,
  updateBoard,
  updateConnection,
  updateTask,
  cancelRun,
  completeRun,
  finishWork,
  listPendingTimeEntries,
  listRunsForTask,
  listWorklogsForTask,
  submitTimeEntry,
  takeIntoWork,
  recoverLifecycle,
  resolveTimeEntry,
  retryTimeEntry,
  updateTimeEntry,
  type BoardDeps,
  type ConnectionDeps,
  type LifecycleDeps,
  type SyncDeps,
} from "./src/core/index.ts";
import { createProjectProvider, createRunSpawner, createWorklogSink } from "./src/adapters/bb/bb-lifecycle.ts";
import { createLifecycleStore } from "./src/adapters/bb/lifecycle-store.ts";

export const rpcContract = defineRpcContract(rpcSchemas);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    vaultKey: {
      type: "string",
      label: "Credential encryption key",
      description:
        "32-byte base64 key that encrypts Jira credentials. Generated on first load; changing it means re-entering every credential.",
      secret: true,
      experimental_schema: z.string().refine(isVaultKey, "Must be a 32-byte key in base64"),
    },
  });

  let { vaultKey } = await settings.get();
  if (vaultKey === undefined) {
    vaultKey = generateVaultKey();
    await settings.experimental_set({ vaultKey });
  }

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createSqliteStore(db);
  const credentials = createCredentialStore(db, vaultKey);
  const clock = { now: () => new Date() };
  const idgen = { newId: () => randomUUID() };

  const boardDeps: BoardDeps = { store, idgen, clock };
  const connectionDeps: ConnectionDeps = { store, credentials, idgen, clock };
  const syncDeps: SyncDeps = { store, credentials, idgen, clock } as SyncDeps;
  const lifecycleDeps: LifecycleDeps = {
    store,
    lifecycle: createLifecycleStore(db),
    projects: createProjectProvider(bb),
    runSpawner: createRunSpawner(bb),
    worklogs: createWorklogSink(syncDeps),
    credentials,
    clock,
    idgen,
  };
  const recovered = recoverLifecycle(lifecycleDeps);
  if (recovered.unknownEntries > 0 || recovered.recoveredRuns > 0) {
    bb.log.info("recovered " + recovered.unknownEntries + " unknown time entries, " + recovered.recoveredRuns + " interrupted runs");
  }

  function toRefusal(error: unknown): Error {
    if (error instanceof experimental_PluginRpcRefusal) return error;
    if (error instanceof DomainError) {
      const code =
        error.kind === "not_found" ? "not_found" : error.kind === "conflict" ? "conflict" : "invalid";
      return new experimental_PluginRpcRefusal({ code, message: error.message });
    }
    const name = error instanceof Error ? error.name : "unknown";
    bb.log.error("request failed: " + name);
    return new experimental_PluginRpcRefusal({ code: "invalid", message: "The request failed; try again" });
  }

  async function run<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRefusal(error);
    }
  }

  bb.rpc.register(rpcContract, {
    jira_projects: ({ connectionId }) => run(async () => ({ projects: await listAssignedJiraProjects(connectionId, syncDeps) })),
    jira_boards: ({ connectionId, projectKey }) => run(async () => ({ boards: await jiraKanbanClientFor(connectionId, syncDeps).boards(projectKey) })),
    jira_kanban: ({ connectionId, projectKey, jiraBoardId }) => run(() => fetchJiraKanban(connectionId, projectKey, jiraBoardId, syncDeps)),
    boards_list: () => run(() => ({ boards: listBoards(boardDeps) })),
    tasks_list: ({ boardId }) => run(() => listTasks(boardId, boardDeps)),
    connections_list: () => run(() => ({ connections: listConnections(connectionDeps) })),
    transitions_list: ({ connectionId, issueKey }) =>
      run(async () => ({ transitions: await jiraClientFor(connectionId, syncDeps).getTransitions(issueKey) })),
    board_create: ({ name }) => run(() => ({ board: createBoard(name, boardDeps) })),
    board_update: (input) => run(() => ({ board: updateBoard(input, boardDeps) })),
    board_delete: ({ boardId }) => run(() => { deleteBoard(boardId, boardDeps); return { ok: true as const }; }),
    task_create: (input) => run(() => ({ task: createTask(input, boardDeps) })),
    task_update: (input) => run(() => ({ task: updateTask(input, boardDeps) })),
    task_move: ({ taskId, status }) => run(() => moveTask(taskId, status, syncDeps).then((task) => ({ task }))),
    task_delete: ({ taskId }) => run(() => { deleteTask(taskId, boardDeps); return { ok: true as const }; }),
    connection_create: (input) => run(() => ({ connection: createConnection(input, connectionDeps) })),
    connection_update: (input) => run(() => ({ connection: updateConnection(input, connectionDeps) })),
    connection_delete: ({ connectionId }) => run(() => { deleteConnection(connectionId, connectionDeps); return { ok: true as const }; }),
    connection_test: ({ connectionId }) => run(async () => { await jiraClientFor(connectionId, syncDeps).myself(); return { ok: true as const }; }),
    jira_fetch: ({ connectionId }) => run(() => fetchIssues(connectionId, syncDeps)),
    jira_transition: ({ connectionId, issueKey, transitionId }) =>
      run(() => applyTransition(connectionId, issueKey, transitionId, syncDeps).then((task) => ({ task }))),
    projects_list: () => run(() => lifecycleDeps.projects.listProjects().then((projects) => ({ projects }))),
    run_take: (input) => run(() => takeIntoWork(input, lifecycleDeps).then((run) => ({ run }))),
    run_list: ({ taskId }) => run(() => ({ runs: listRunsForTask(taskId, lifecycleDeps) })),
    run_complete: (input) => run(() => completeRun(input, lifecycleDeps).then((timeEntry) => ({ timeEntry }))),
    time_entry_update: (input) => run(() => ({ timeEntry: updateTimeEntry(input, lifecycleDeps) })),
    worklog_prepare: (input) => run(() => ({ timeEntry: prepareWorklog(input, lifecycleDeps) })),
    time_entry_submit: (input) => run(() => submitTimeEntry(input, lifecycleDeps).then((worklog) => ({ worklog }))),
    time_entries_pending: () => run(() => ({ entries: listPendingTimeEntries(lifecycleDeps) })),
    jira_worklogs_list: ({ taskId }) => run(async () => {
      const task = store.getTask(taskId);
      const board = task ? store.getBoard(task.boardId) : null;
      if (!task || task.origin !== "jira" || !task.originKey || !board?.connectionId) throw new DomainError("not_found", "Connected Jira task not found");
      return { worklogs: await jiraClientFor(board.connectionId, syncDeps).listWorklogs(task.originKey) };
    }),
    worklogs_list: ({ taskId }) => run(() => ({ worklogs: listWorklogsForTask(taskId, lifecycleDeps) })),
    time_entries_by_task: ({ taskId }) => run(() => ({ entries: lifecycleDeps.lifecycle.listTimeEntriesByTask(taskId) })),
    time_entry_retry: ({ entryId }) => run(() => ({ timeEntry: retryTimeEntry(entryId, lifecycleDeps) })),
    time_entry_resolve: (input) => run(() => ({ worklog: resolveTimeEntry(input, lifecycleDeps) })),
    run_cancel: ({ runId }) => run(() => { cancelRun(runId, lifecycleDeps); return { ok: true as const }; }),
  });

  // Explicit, thread-scoped completion. Idle or failed turns never complete a
  // run: only this tool (or the UI's Complete action) does.
  bb.agents.registerTool({
    name: "finish_work",
    description:
      "Mark this thread's task work as complete and record what was delivered. Only available on threads that have an active Taskboard run.",
    parameters: z.object({ summary: z.string().min(1).max(4000) }),
    async execute(params, ctx) {
      try {
        await finishWork({ threadId: ctx.threadId, summary: params.summary }, lifecycleDeps);
        return "Task completed. A time entry is now pending for the owner to review and confirm in Taskboard.";
      } catch (error) {
        const message = error instanceof Error ? error.message : "finish_work failed";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  });

  const worklogTools = registerWorklogTools(bb, lifecycleDeps);

  bb.agents.configure((context) => {
    const hasRun = typeof context.pluginMetadata.runId === "string";
    return { tools: hasRun ? [...worklogTools, "finish_work"] : worklogTools, skills: [] };
  });
}
