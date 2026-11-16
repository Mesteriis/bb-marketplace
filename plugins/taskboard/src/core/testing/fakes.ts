// In-memory implementations of the core's ports for tests.
import type { TaskRun, TimeEntry, WorklogRecord } from "../lifecycle.ts";
import type { Board, Column, Connection, Task } from "../model.ts";
import type { Clock, CredentialStore, IdGenerator, LifecycleStore, ProjectProvider, RunSpawner, TaskStore, WorklogSink } from "../ports.ts";

export function createFakeClock(start?: Date): Clock & { advance(ms: number): void } {
  let now = start ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    now: () => now,
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}

export function createFakeId(): IdGenerator {
  let n = 0;
  return { newId: () => "id_" + ++n };
}

export function createFakeCredentials(): CredentialStore {
  const secrets = new Map<string, string>();
  return {
    put(id, secret) {
      secrets.set(id, secret);
    },
    get(id) {
      return secrets.get(id) ?? null;
    },
    delete(id) {
      secrets.delete(id);
    },
  };
}

export function createFakeStore(): TaskStore {
  const boards = new Map<string, Board>();
  const columnsByBoard = new Map<string, Column[]>();
  const tasksByBoard = new Map<string, Task[]>();
  const connections = new Map<string, Connection>();
  return {
    transaction(fn) {
      return fn();
    },
    listBoards() {
      return [...boards.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    getBoard(id) {
      return boards.get(id) ?? null;
    },
    saveBoard(board) {
      boards.set(board.id, board);
    },
    deleteBoard(id) {
      boards.delete(id);
      columnsByBoard.delete(id);
      tasksByBoard.delete(id);
    },
    listColumns(boardId) {
      return columnsByBoard.get(boardId) ?? [];
    },
    saveColumns(boardId, columns) {
      columnsByBoard.set(boardId, [...columns]);
    },
    listTasks(boardId) {
      return tasksByBoard.get(boardId) ?? [];
    },
    getTask(id) {
      for (const tasks of tasksByBoard.values()) {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task !== undefined) return task;
      }
      return null;
    },
    saveTask(task) {
      const list = tasksByBoard.get(task.boardId) ?? [];
      const index = list.findIndex((candidate) => candidate.id === task.id);
      if (index >= 0) list[index] = task;
      else list.push(task);
      tasksByBoard.set(task.boardId, list);
    },
    deleteTask(id) {
      for (const [boardId, tasks] of tasksByBoard) {
        tasksByBoard.set(boardId, tasks.filter((task) => task.id !== id));
      }
    },
    listConnections() {
      return [...connections.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    getConnection(id) {
      return connections.get(id) ?? null;
    },
    saveConnection(connection) {
      connections.set(connection.id, connection);
    },
    deleteConnection(id) {
      connections.delete(id);
    },
  };
}

export function createFakeLifecycleStore(): LifecycleStore & {
  runs: TaskRun[];
  timeEntries: TimeEntry[];
  worklogs: WorklogRecord[];
} {
  const runs: TaskRun[] = [];
  const timeEntries: TimeEntry[] = [];
  const worklogs: WorklogRecord[] = [];
  return {
    runs,
    timeEntries,
    worklogs,
    saveRun(run) {
      const index = runs.findIndex((entry) => entry.id === run.id);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
    },
    deleteRun(id) {
      const index = runs.findIndex((entry) => entry.id === id);
      if (index >= 0) runs.splice(index, 1);
    },
    getRun(id) {
      return runs.find((entry) => entry.id === id) ?? null;
    },
    listRunsForTask(taskId) {
      return runs.filter((entry) => entry.taskId === taskId);
    },
    getRunByThread(threadId) {
      return runs.find((entry) => entry.threadId === threadId) ?? null;
    },
    saveTimeEntry(entry) {
      const index = timeEntries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) timeEntries[index] = entry;
      else timeEntries.push(entry);
    },
    getTimeEntry(id) {
      return timeEntries.find((entry) => entry.id === id) ?? null;
    },
    getTimeEntryByRun(runId) {
      return timeEntries.find((entry) => entry.runId === runId) ?? null;
    },
    listPendingTimeEntries() {
      return timeEntries.filter((entry) => entry.state === "pending");
    },
    saveWorklog(worklog) {
      worklogs.push(worklog);
    },
    listWorklogsForTask(taskId) {
      return worklogs.filter((entry) => entry.taskId === taskId);
    },
    claimCompletion(runId, completed, entry) {
      const existing = runs.find((run) => run.id === runId);
      if (existing !== undefined && existing.state !== "active") {
        return { claimed: false, existingEntry: timeEntries.find((e) => e.runId === runId) ?? null };
      }
      const existingEntry = timeEntries.find((e) => e.runId === runId) ?? null;
      if (existingEntry !== null) return { claimed: false, existingEntry };
      this.saveRun(completed);
      this.saveTimeEntry(entry);
      return { claimed: true, existingEntry: null };
    },
    claimSubmission(entryId, durationSeconds, comment) {
      const entry = timeEntries.find((e) => e.id === entryId);
      if (entry === undefined || entry.state !== "pending") return false;
      entry.state = "submitting";
      entry.durationSeconds = durationSeconds;
      entry.comment = comment;
      return true;
    },
    failSubmission(entryId, state) {
      const entry = timeEntries.find((e) => e.id === entryId);
      if (entry !== undefined && entry.state === "submitting") entry.state = state;
    },
    completeSubmission(entryId, submitted, worklog) {
      this.saveWorklog(worklog);
      const entry = timeEntries.find((e) => e.id === entryId);
      if (entry !== undefined) Object.assign(entry, submitted);
    },
    recoverSubmittingEntries() {
      let count = 0;
      for (const entry of timeEntries) if (entry.state === "submitting") { entry.state = "unknown"; count += 1; }
      return count;
    },
    recoverProvisioningRuns() {
      let count = 0;
      for (const run of runs) {
        if ((run.state === "provisioning" || run.state === "spawning") && (run.threadId === null || run.threadId === "")) { run.state = "unknown"; count += 1; }
      }
      return count;
    },
    listTimeEntriesByTask(taskId) {
      return timeEntries.filter((entry) => entry.taskId === taskId);
    },
  };
}

export function createFakeProjects(names: string[] = ["Alpha", "Beta"]): ProjectProvider {
  return { listProjects: async () => names.map((name, index) => ({ id: "proj_" + (index + 1), name })) };
}

export function createFakeRunSpawner(): RunSpawner & { calls: Array<{ projectId: string; branchName: string; title: string; metadata: Record<string, string> }>; spawnedThreads: Map<string, { threadId: string; environmentId: string; branchName: string | null }> } {
  const calls: Array<{ projectId: string; branchName: string; title: string; metadata: Record<string, string> }> = [];
  const spawnedThreads = new Map<string, { threadId: string; environmentId: string; branchName: string | null }>();
  return {
    calls,
    spawnedThreads,
    async spawn(input) {
      calls.push(input);
      const n = calls.length;
      const thread = { threadId: "thread_" + n, environmentId: "env_" + n, branchName: input.branchName };
      spawnedThreads.set(input.metadata.runId, thread);
      return thread;
    },
    async reconcile(runId, _projectId) {
      return spawnedThreads.get(runId) ?? null;
    },
  };
}

export function createFakeWorklogSink(): WorklogSink & { calls: Array<{ connectionId: string; issueKey: string; durationSeconds: number; comment: string }> } {
  const calls: Array<{ connectionId: string; issueKey: string; durationSeconds: number; comment: string }> = [];
  return {
    calls,
    async submitRemoteWorklog(input) {
      calls.push(input);
      return { id: "wl_" + calls.length };
    },
  };
}
