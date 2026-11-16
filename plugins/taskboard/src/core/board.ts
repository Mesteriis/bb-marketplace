// Local board and task CRUD. A board owns ordered columns; tasks carry an
// origin ("local" or "jira") and an optional Jira issue key so local and
// imported work coexist in the same view.
import { DomainError } from "./errors.ts";
import { DEFAULT_COLUMN_NAMES, type BoardUpdateInput, type BoardView, type Column, type Task, type TaskCreateInput, type TaskUpdateInput } from "./model.ts";
import type { Clock, IdGenerator, TaskStore } from "./ports.ts";

export interface BoardDeps {
  store: TaskStore;
  idgen: IdGenerator;
  clock: Clock;
}

export function listBoards(deps: BoardDeps): BoardView[] {
  return deps.store.listBoards().map((board) => ({
    ...board,
    columns: deps.store.listColumns(board.id),
  }));
}

export function getBoard(boardId: string, deps: BoardDeps): BoardView {
  const board = deps.store.getBoard(boardId);
  if (board === null) throw new DomainError("not_found", "Board not found");
  return { ...board, columns: deps.store.listColumns(board.id) };
}

export function createBoard(name: string, deps: BoardDeps): BoardView {
  const trimmed = name.trim();
  if (trimmed === "") throw new DomainError("invalid", "Name is required");
  const id = deps.idgen.newId();
  deps.store.saveBoard({ id, name: trimmed, connectionId: null });
  const columns: Column[] = DEFAULT_COLUMN_NAMES.map((columnName, order) => ({
    id: deps.idgen.newId(),
    boardId: id,
    name: columnName,
    order,
  }));
  deps.store.saveColumns(id, columns);
  return { id, name: trimmed, connectionId: null, columns };
}

export function updateBoard(input: BoardUpdateInput, deps: BoardDeps): BoardView {
  const board = deps.store.getBoard(input.boardId);
  if (board === null) throw new DomainError("not_found", "Board not found");
  const name = input.name.trim();
  if (name === "") throw new DomainError("invalid", "Name is required");

  const existingColumns = deps.store.listColumns(input.boardId);
  const existingIds = new Set(existingColumns.map((column) => column.id));

  // A connected board (or one holding cached Jira tasks) keeps its columns
  // owned by Jira: names are fixed and columns cannot be added or removed.
  // Only the board name and the column order may change here.
  const isRemoteBoard =
    board.connectionId !== null || deps.store.listTasks(input.boardId).some((task) => task.origin === "jira");
  if (isRemoteBoard) {
    const byId = new Map(existingColumns.map((column) => [column.id, column]));
    if (input.columns.length !== existingColumns.length) {
      throw new DomainError("conflict", "Columns cannot be added or removed on a Jira board");
    }
    for (const columnInput of input.columns) {
      const current = columnInput.id !== undefined ? byId.get(columnInput.id) : undefined;
      if (current === undefined) throw new DomainError("conflict", "Columns cannot be added or removed on a Jira board");
      if (current.name !== columnInput.name.trim()) {
        throw new DomainError("conflict", "Column names are managed by Jira");
      }
    }
  }

  // Validate every column id before any write: unique, and belonging to this
  // board, so an upsert can never move another board's column.
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const columns: Column[] = input.columns.map((columnInput, order) => {
    const columnName = columnInput.name.trim();
    if (columnName === "") throw new DomainError("invalid", "Column name is required");
    const nameKey = columnName.toLowerCase();
    if (seenNames.has(nameKey)) throw new DomainError("invalid", "Columns must have unique names");
    seenNames.add(nameKey);
    const id = columnInput.id ?? deps.idgen.newId();
    if (columnInput.id !== undefined && !existingIds.has(columnInput.id)) {
      throw new DomainError("invalid", "Column does not belong to this board");
    }
    if (seenIds.has(id)) throw new DomainError("invalid", "Columns must have unique ids");
    seenIds.add(id);
    return { id, boardId: input.boardId, name: columnName, order };
  });

  // All writes in one transaction: board, columns, and re-homing.
  deps.store.transaction(() => {
    deps.store.saveBoard({ ...board, name });
    deps.store.saveColumns(input.boardId, columns);
    const ids = new Set(columns.map((column) => column.id));
    for (const task of deps.store.listTasks(input.boardId)) {
      if (!ids.has(task.status)) {
        deps.store.saveTask({ ...task, status: columns[0]!.id, updatedAt: deps.clock.now().toISOString() });
      }
    }
  });
  return { ...board, name, columns };
}

export function deleteBoard(boardId: string, deps: BoardDeps): void {
  deps.store.deleteBoard(boardId);
}

export function listTasks(boardId: string, deps: BoardDeps): { columns: Column[]; tasks: Task[] } {
  return { columns: deps.store.listColumns(boardId), tasks: deps.store.listTasks(boardId) };
}

export function createTask(input: TaskCreateInput, deps: BoardDeps): Task {
  const board = deps.store.getBoard(input.boardId);
  if (board === null) throw new DomainError("not_found", "Board not found");
  const columns = deps.store.listColumns(input.boardId);
  if (columns.length === 0) throw new DomainError("invalid", "Board has no columns");
  const status = input.status ?? columns[0]!.id;
  if (!columns.some((column) => column.id === status)) throw new DomainError("invalid", "Unknown status column");
  const title = input.title.trim();
  if (title === "") throw new DomainError("invalid", "Title is required");
  const now = deps.clock.now().toISOString();
  const maxOrder = deps.store.listTasks(input.boardId).reduce((max, task) => Math.max(max, task.sortOrder), -1);
  const task: Task = {
    id: deps.idgen.newId(),
    boardId: input.boardId,
    title,
    description: input.description ?? "",
    status,
    origin: "local",
    originKey: null,
    originUrl: null,
    labels: [],
    createdAt: now,
    updatedAt: now,
    sortOrder: maxOrder + 1,
  };
  deps.store.saveTask(task);
  return task;
}

export function updateTask(input: TaskUpdateInput, deps: BoardDeps): Task {
  const task = deps.store.getTask(input.taskId);
  if (task === null) throw new DomainError("not_found", "Task not found");
  if (task.origin === "jira") throw new DomainError("conflict", "Imported Jira tasks are read-only");
  const title = input.title !== undefined ? input.title.trim() : task.title;
  if (title === "") throw new DomainError("invalid", "Title is required");
  const next: Task = {
    ...task,
    title,
    description: input.description ?? task.description,
    updatedAt: deps.clock.now().toISOString(),
  };
  deps.store.saveTask(next);
  return next;
}

export function moveLocalTask(taskId: string, status: string, deps: BoardDeps): Task {
  const task = deps.store.getTask(taskId);
  if (task === null) throw new DomainError("not_found", "Task not found");
  const columns = deps.store.listColumns(task.boardId);
  if (!columns.some((column) => column.id === status)) throw new DomainError("invalid", "Unknown status column");
  const next: Task = { ...task, status, updatedAt: deps.clock.now().toISOString() };
  deps.store.saveTask(next);
  return next;
}

export function deleteTask(taskId: string, deps: BoardDeps): void {
  deps.store.deleteTask(taskId);
}
