// Ports: what the core needs from its host. Each host supplies adapters.
import type { Board, Column, Connection, Task } from "./model.ts";
import type { TaskRun, TimeEntry, WorklogRecord } from "./lifecycle.ts";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}

/** Synchronous persistence. The BB adapter is better-sqlite3; a Tauri host
 * could be a Rust command returning rows. */
export interface TaskStore {
  transaction<T>(fn: () => T): T;

  listBoards(): Board[];
  getBoard(id: string): Board | null;
  saveBoard(board: Board): void;
  /** Cascades to the board's columns and tasks. */
  deleteBoard(id: string): void;

  listColumns(boardId: string): Column[];
  /** Replaces the board's columns (idempotent within a transaction). */
  saveColumns(boardId: string, columns: Column[]): void;

  listTasks(boardId: string): Task[];
  getTask(id: string): Task | null;
  saveTask(task: Task): void;
  deleteTask(id: string): void;

  listConnections(): Connection[];
  getConnection(id: string): Connection | null;
  saveConnection(connection: Connection): void;
  deleteConnection(id: string): void;
}

/** Stores one secret (API token / personal access token) per connection. The
 * core never persists the plain secret; it is read back only while a request
 * is built. */
export interface CredentialStore {
  put(connectionId: string, secret: string): void;
  get(connectionId: string): string | null;
  delete(connectionId: string): void;
}

// ---- Take-into-work lifecycle ports ----

/** Persists task runs, pending time entries and worklogs across restarts. */
export interface LifecycleStore {
  saveRun(run: TaskRun): void;
  deleteRun(id: string): void;
  getRun(id: string): TaskRun | null;
  listRunsForTask(taskId: string): TaskRun[];
  getRunByThread(threadId: string): TaskRun | null;
  saveTimeEntry(entry: TimeEntry): void;
  getTimeEntry(id: string): TimeEntry | null;
  getTimeEntryByRun(runId: string): TimeEntry | null;
  listPendingTimeEntries(): TimeEntry[];
  saveWorklog(worklog: WorklogRecord): void;
  listWorklogsForTask(taskId: string): WorklogRecord[];
  /** Atomically marks a run completed and inserts its (unique) time entry. */
  claimCompletion(runId: string, completed: TaskRun, entry: TimeEntry): { claimed: boolean; existingEntry: TimeEntry | null };
  /** Durable pending -> submitting claim, persisting the exact submitted values. */
  claimSubmission(entryId: string, durationSeconds: number, comment: string): boolean;
  failSubmission(entryId: string, state: "failed" | "unknown"): void;
  /** Atomically persists the worklog and marks the entry submitted. */
  completeSubmission(entryId: string, submitted: TimeEntry, worklog: WorklogRecord): void;
  recoverSubmittingEntries(): number;
  recoverProvisioningRuns(): number;
  listTimeEntriesByTask(taskId: string): TimeEntry[];
}

/** Lists projects the owner can take work into. */
export interface ProjectProvider {
  listProjects(): Promise<{ id: string; name: string }[]>;
}

/** Creates a worktree/branch and a new agent thread in one step. */
export interface RunSpawner {
  spawn(input: {
    projectId: string;
    branchName: string;
    title: string;
    prompt: string;
    metadata: Record<string, string>;
  }): Promise<{ threadId: string; environmentId: string | null; branchName: string | null }>;
  /** Reconciles a possibly-spawned thread by runId: an object when found, null
   * when provably absent, undefined when it cannot be determined. */
  reconcile(runId: string, projectId: string): Promise<{ threadId: string; environmentId: string | null; branchName: string | null } | null | undefined>;
}

/** Submits a remote worklog (Jira Cloud/Server). Local tasks store locally. */
export interface WorklogSink {
  submitRemoteWorklog(input: {
    connectionId: string;
    issueKey: string;
    durationSeconds: number;
    comment: string;
    startedAtIso: string;
  }): Promise<{ id: string }>;
}
