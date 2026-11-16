import { describe, expect, it } from "vitest";
import { createBoard, createTask } from "./board.ts";
import { DomainError } from "./errors.ts";
import {
  completeRun,
  finishWork,
  submitTimeEntry,
  takeIntoWork,
  updateTimeEntry,
  type LifecycleDeps,
  type TaskRun,
  type TimeEntry,
} from "./lifecycle.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeLifecycleStore, createFakeProjects, createFakeRunSpawner, createFakeStore, createFakeWorklogSink } from "./testing/fakes.ts";

function makeDeps() {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock(new Date("2026-06-01T09:00:00.000Z"));
  const lifecycle = createFakeLifecycleStore();
  const runSpawner = createFakeRunSpawner();
  const worklogs = createFakeWorklogSink();
  const deps: LifecycleDeps = { store, lifecycle, projects: createFakeProjects(), runSpawner, worklogs, credentials, clock, idgen };
  return { deps, store, lifecycle, runSpawner, worklogs, clock };
}

describe("takeIntoWork", () => {
  it("spawns a run, creates a thread, and moves the task to the start status", async () => {
    const { deps, store, runSpawner } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "Ship it", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id }, deps);
    expect(run.state).toBe("active");
    expect(run.threadId).toBe("thread_1");
    expect(run.environmentId).toBe("env_1");
    expect(run.branchName).toBe("local-" + task.id);
    expect(store.getTask(task.id)?.status).toBe(board.columns[1].id);
    expect(runSpawner.calls).toHaveLength(1);
    expect(runSpawner.calls[0].metadata.taskId).toBe(task.id);
    expect(runSpawner.calls[0].metadata.runId).toBe(run.id);
  });

  it("refuses a second run while one is active", async () => {
    const { deps } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const input = { taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id };
    await takeIntoWork(input, deps);
    await expect(takeIntoWork(input, deps)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("a failed spawn retains a failed run and leaves the task unmoved", async () => {
    const { deps, store, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    deps.runSpawner = { spawn: async () => { throw new DomainError("invalid", "boom"); }, reconcile: async () => null };
    await expect(takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id }, deps)).rejects.toThrow(/boom/);
    expect(lifecycle.runs).toHaveLength(1);
    expect(lifecycle.runs[0].state).toBe("failed");
    expect(store.getTask(task.id)?.status).toBe(board.columns[0].id);
  });
});

describe("completeRun and finishWork", () => {
  it("transitions to the target and creates a pending time entry with elapsed duration", async () => {
    const { deps, store, clock } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id }, deps);
    clock.advance(3_600_000);
    const entry = await completeRun({ runId: run.id, deliveredSummary: "done" }, deps);
    expect(store.getTask(task.id)?.status).toBe(board.columns[2].id);
    expect(entry.state).toBe("pending");
    expect(entry.durationSeconds).toBe(3600);
    const savedRun = deps.lifecycle.getRun(run.id)!;
    expect(savedRun.state).toBe("completed");
    expect(savedRun.deliveredSummary).toBe("done");
  });

  it("is idempotent: a second complete returns the same pending entry", async () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id }, deps);
    const first = await completeRun({ runId: run.id }, deps);
    const second = await completeRun({ runId: run.id }, deps);
    expect(second.id).toBe(first.id);
    expect(lifecycle.timeEntries.filter((e) => e.runId === run.id)).toHaveLength(1);
  });

  it("finishWork verifies the originating thread", async () => {
    const { deps } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id }, deps);
    await expect(finishWork({ threadId: "wrong-thread", summary: "x" }, deps)).rejects.toMatchObject({ kind: "not_found" });
    const entry = await finishWork({ threadId: run.threadId!, summary: "shipped" }, deps);
    expect(entry.state).toBe("pending");
  });

  it("a denied transition keeps the run active and creates no entry", async () => {
    const { deps, store, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[2].id }, deps);
    await expect(completeRun({ runId: run.id }, deps)).rejects.toMatchObject({ kind: "invalid" });
    expect(deps.lifecycle.getRun(run.id)?.state).toBe("active");
    expect(lifecycle.timeEntries).toHaveLength(0);
  });
});

describe("time entries and worklogs", () => {
  it("stores a local worklog and refuses duplicate submission", async () => {
    const { deps, worklogs, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id }, deps);
    const entry = await completeRun({ runId: run.id }, deps);
    const worklog = await submitTimeEntry({ entryId: entry.id, durationSeconds: 1800, comment: "worked" }, deps);
    expect(worklog.remote).toBe(false);
    expect(worklog.durationSeconds).toBe(1800);
    expect(worklogs.calls).toHaveLength(0);
    await expect(submitTimeEntry({ entryId: entry.id, durationSeconds: 1800, comment: "again" }, deps)).rejects.toMatchObject({ kind: "conflict" });
    expect(lifecycle.worklogs).toHaveLength(1);
  });

  it("submits a remote worklog once for a Jira task", async () => {
    const { deps, store, lifecycle, worklogs } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
    store.saveBoard({ ...board, connectionId: "conn1" });
    const run: TaskRun = { id: "run1", taskId: task.id, projectId: "proj_1", environmentId: "env1", threadId: "thread1", branchName: "B-1", startStatusId: board.columns[0].id, nextStatusId: board.columns[0].id, state: "completed", startedAtIso: "2026-06-01T09:00:00.000Z", completedAtIso: "2026-06-01T10:00:00.000Z", durationSeconds: 3600, deliveredSummary: null };
    lifecycle.saveRun(run);
    const entry: TimeEntry = { id: "entry1", runId: "run1", taskId: task.id, state: "pending", durationSeconds: 3600, comment: "", createdAtIso: "2026-06-01T10:00:00.000Z", submittedAtIso: null };
    lifecycle.saveTimeEntry(entry);
    const worklog = await submitTimeEntry({ entryId: entry.id, durationSeconds: 3600, comment: "done" }, deps);
    expect(worklog.remote).toBe(true);
    expect(worklogs.calls).toHaveLength(1);
    expect(worklogs.calls[0].issueKey).toBe("B-1");
  });

  it("updates a pending entry without submitting", async () => {
    const { deps, lifecycle } = makeDeps();
    const entry: TimeEntry = { id: "entry1", runId: "run1", taskId: "task1", state: "pending", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
    lifecycle.saveTimeEntry(entry);
    const updated = updateTimeEntry({ entryId: entry.id, durationSeconds: 1200, comment: "half" }, deps);
    expect(updated.durationSeconds).toBe(1200);
    expect(updated.comment).toBe("half");
    expect(updated.state).toBe("pending");
  });
});
