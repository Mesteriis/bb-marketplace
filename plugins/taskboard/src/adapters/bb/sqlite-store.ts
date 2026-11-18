// TaskStore on the plugin's own SQLite database (better-sqlite3).
import type Database from "better-sqlite3";
import type { Board, Column, Connection, Task } from "../../core/model.ts";
import type { TaskStore } from "../../core/ports.ts";

export const MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT)",
  "CREATE TABLE IF NOT EXISTS columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS columns_board_idx ON columns (board_id, ord)",
  "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local', origin_key TEXT, origin_url TEXT, labels TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS tasks_board_idx ON tasks (board_id, sort_order)",
  "CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, edition TEXT NOT NULL, base_url TEXT NOT NULL, email TEXT, project_key TEXT NOT NULL DEFAULT '', jql TEXT NOT NULL DEFAULT '', has_credential INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS credentials (connection_id TEXT PRIMARY KEY, sealed TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT, thread_id TEXT NOT NULL, branch_name TEXT, start_status_id TEXT NOT NULL, next_status_id TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_seconds INTEGER, delivered_summary TEXT)",
  "CREATE INDEX IF NOT EXISTS runs_task_idx ON runs (task_id)",
  "CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, duration_seconds INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, submitted_at TEXT)",
  "CREATE TABLE IF NOT EXISTS worklogs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, remote INTEGER NOT NULL DEFAULT 0, remote_id TEXT, duration_seconds INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS time_entries_run_idx ON time_entries (run_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS worklogs_run_idx ON worklogs (run_id)",
  // runs.thread_id becomes nullable for provisioning/failed runs (append-only rebuild).
  "CREATE TABLE runs_v2 (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT, thread_id TEXT, branch_name TEXT, start_status_id TEXT NOT NULL, next_status_id TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_seconds INTEGER, delivered_summary TEXT)",
  "INSERT INTO runs_v2 (id, task_id, project_id, environment_id, thread_id, branch_name, start_status_id, next_status_id, state, started_at, completed_at, duration_seconds, delivered_summary) SELECT id, task_id, project_id, environment_id, NULLIF(thread_id, ''), branch_name, start_status_id, next_status_id, state, started_at, completed_at, duration_seconds, delivered_summary FROM runs",
  "DROP TABLE runs",
  "ALTER TABLE runs_v2 RENAME TO runs",
  "CREATE INDEX IF NOT EXISTS runs_task_idx ON runs (task_id)",
  "ALTER TABLE tasks ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1",
];

type BoardRow = { id: string; name: string; connection_id: string | null };
type ColumnRow = { id: string; board_id: string; name: string; ord: number };
type TaskRow = {
  id: string;
  board_id: string;
  title: string;
  description: string;
  status: string;
  origin: string;
  origin_key: string | null;
  origin_url: string | null;
  labels: string;
  created_at: string;
  updated_at: string;
  sort_order: number;
  in_scope: number;
};
type ConnectionRow = {
  id: string;
  name: string;
  edition: string;
  base_url: string;
  email: string | null;
  project_key: string;
  jql: string;
  has_credential: number;
  created_at: string;
  updated_at: string;
};

function toBoard(row: BoardRow): Board {
  return { id: row.id, name: row.name, connectionId: row.connection_id };
}

function toColumn(row: ColumnRow): Column {
  return { id: row.id, boardId: row.board_id, name: row.name, order: row.ord };
}

function parseLabels(labels: string): string[] {
  try {
    const value = JSON.parse(labels);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status,
    origin: row.origin === "jira" ? "jira" : "local",
    originKey: row.origin_key,
    originUrl: row.origin_url,
    labels: parseLabels(row.labels),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order,
    inScope: row.in_scope !== 0,
  };
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    edition: row.edition === "server" ? "server" : "cloud",
    baseUrl: row.base_url,
    email: row.email,
    projectKey: row.project_key,
    jql: row.jql,
    hasCredential: row.has_credential === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteStore(db: Database.Database): TaskStore {
  const upsertBoard = db.prepare(
    "INSERT INTO boards (id, name, connection_id) VALUES (@id, @name, @connectionId) ON CONFLICT(id) DO UPDATE SET name = excluded.name, connection_id = excluded.connection_id",
  );
  const upsertColumn = db.prepare(
    "INSERT INTO columns (id, board_id, name, ord) VALUES (@id, @boardId, @name, @order) ON CONFLICT(id) DO UPDATE SET name = excluded.name, ord = excluded.ord",
  );
  const upsertTask = db.prepare(
    "INSERT INTO tasks (id, board_id, title, description, status, origin, origin_key, origin_url, labels, created_at, updated_at, sort_order, in_scope) VALUES (@id, @boardId, @title, @description, @status, @origin, @originKey, @originUrl, @labels, @createdAt, @updatedAt, @sortOrder, @inScope) ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status, origin = excluded.origin, origin_key = excluded.origin_key, origin_url = excluded.origin_url, labels = excluded.labels, updated_at = excluded.updated_at, sort_order = excluded.sort_order, in_scope = excluded.in_scope",
  );
  const upsertConnection = db.prepare(
    "INSERT INTO connections (id, name, edition, base_url, email, project_key, jql, has_credential, created_at, updated_at) VALUES (@id, @name, @edition, @baseUrl, @email, @projectKey, @jql, @hasCredential, @createdAt, @updatedAt) ON CONFLICT(id) DO UPDATE SET name = excluded.name, edition = excluded.edition, base_url = excluded.base_url, email = excluded.email, project_key = excluded.project_key, jql = excluded.jql, has_credential = excluded.has_credential, updated_at = excluded.updated_at",
  );

  return {
    transaction(fn) {
      const run = db.transaction(fn);
      return run();
    },

    listBoards() {
      return (db.prepare("SELECT id, name, connection_id FROM boards ORDER BY name").all() as BoardRow[]).map(toBoard);
    },
    getBoard(id) {
      const row = db.prepare("SELECT id, name, connection_id FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
      return row === undefined ? null : toBoard(row);
    },
    saveBoard(board) {
      upsertBoard.run({ id: board.id, name: board.name, connectionId: board.connectionId });
    },
    deleteBoard(id) {
      this.transaction(() => {
        db.prepare("DELETE FROM tasks WHERE board_id = ?").run(id);
        db.prepare("DELETE FROM columns WHERE board_id = ?").run(id);
        db.prepare("DELETE FROM boards WHERE id = ?").run(id);
      });
    },

    listColumns(boardId) {
      return (db.prepare("SELECT id, board_id, name, ord FROM columns WHERE board_id = ? ORDER BY ord").all(boardId) as ColumnRow[]).map(toColumn);
    },
    saveColumns(boardId, columns) {
      this.transaction(() => {
        db.prepare("DELETE FROM columns WHERE board_id = ?").run(boardId);
        for (const column of columns) upsertColumn.run({ id: column.id, boardId, name: column.name, order: column.order });
      });
    },

    listTasks(boardId) {
      return (
        db
          .prepare("SELECT id, board_id, title, description, status, origin, origin_key, origin_url, labels, created_at, updated_at, sort_order, in_scope FROM tasks WHERE board_id = ? ORDER BY sort_order, created_at")
          .all(boardId) as TaskRow[]
      ).map(toTask);
    },
    getTask(id) {
      const row = db.prepare("SELECT id, board_id, title, description, status, origin, origin_key, origin_url, labels, created_at, updated_at, sort_order, in_scope FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      return row === undefined ? null : toTask(row);
    },
    saveTask(task) {
      upsertTask.run({
        id: task.id,
        boardId: task.boardId,
        title: task.title,
        description: task.description,
        status: task.status,
        origin: task.origin,
        originKey: task.originKey,
        originUrl: task.originUrl,
        labels: JSON.stringify(task.labels),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        sortOrder: task.sortOrder,
        inScope: task.inScope === false ? 0 : 1,
      });
    },
    deleteTask(id) {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    },

    listConnections() {
      return (
        db.prepare("SELECT id, name, edition, base_url, email, project_key, jql, has_credential, created_at, updated_at FROM connections ORDER BY name").all() as ConnectionRow[]
      ).map(toConnection);
    },
    getConnection(id) {
      const row = db.prepare("SELECT id, name, edition, base_url, email, project_key, jql, has_credential, created_at, updated_at FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
      return row === undefined ? null : toConnection(row);
    },
    saveConnection(connection) {
      upsertConnection.run({
        id: connection.id,
        name: connection.name,
        edition: connection.edition,
        baseUrl: connection.baseUrl,
        email: connection.email,
        projectKey: connection.projectKey,
        jql: connection.jql,
        hasCredential: connection.hasCredential ? 1 : 0,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      });
    },
    deleteConnection(id) {
      db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    },
  };
}
