// The host-free API surface the taskboard page consumes. app.tsx builds an
// implementation from BB RPC; a test builds one from fakes.
import type { BoardView, Column, Connection, ConnectionCreateInput, ConnectionUpdateInput, JiraTransition, Task, TaskRun, TimeEntry, WorklogRecord } from "../core/index.ts";

export interface TaskboardApi {
  listBoards(): Promise<BoardView[]>;
  listConnections(): Promise<Connection[]>;
  listTasks(boardId: string): Promise<{ columns: Column[]; tasks: Task[] }>;
  createBoard(name: string): Promise<BoardView>;
  updateBoard(input: { boardId: string; name: string; columns: { id?: string; name: string; order: number }[] }): Promise<BoardView>;
  deleteBoard(boardId: string): Promise<void>;
  createTask(input: { boardId: string; title: string; description?: string; status?: string }): Promise<Task>;
  updateTask(input: { taskId: string; title?: string; description?: string }): Promise<Task>;
  moveTask(taskId: string, status: string): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  createConnection(input: ConnectionCreateInput): Promise<Connection>;
  updateConnection(input: ConnectionUpdateInput): Promise<Connection>;
  deleteConnection(connectionId: string): Promise<void>;
  testConnection(connectionId: string): Promise<void>;
  fetchIssues(connectionId: string): Promise<{ imported: number; total: number | null; truncated: boolean }>;
  listTransitions(connectionId: string, issueKey: string): Promise<JiraTransition[]>;
  applyTransition(connectionId: string, issueKey: string, transitionId: string): Promise<Task>;
  listProjects(): Promise<{ id: string; name: string }[]>;
  takeIntoWork(input: { taskId: string; projectId: string; startStatusId: string; nextStatusId: string }): Promise<TaskRun>;
  cancelRun(runId: string): Promise<void>;
  listRuns(taskId: string): Promise<TaskRun[]>;
  completeRun(input: { runId: string; deliveredSummary?: string }): Promise<TimeEntry>;
  updateTimeEntry(input: { entryId: string; durationSeconds: number; comment: string }): Promise<TimeEntry>;
  submitTimeEntry(input: { entryId: string; durationSeconds: number; comment: string }): Promise<WorklogRecord>;
  listPendingTimeEntries(): Promise<TimeEntry[]>;
  listTimeEntriesByTask(taskId: string): Promise<TimeEntry[]>;
  retryTimeEntry(entryId: string): Promise<TimeEntry>;
  resolveTimeEntry(input: { entryId: string; remoteId?: string }): Promise<WorklogRecord>;
}

export type Notify = (kind: "error" | "success" | "info", message: string) => void;

export const noNotify: Notify = () => {};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
