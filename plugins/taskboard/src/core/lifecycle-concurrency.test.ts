import { describe, expect, it } from "vitest";
import { createBoard, createTask } from "./board.ts";
import { DomainError } from "./errors.ts";
import { completeRun, recoverLifecycle, submitTimeEntry, takeIntoWork, type LifecycleDeps, type TaskRun, type TimeEntry } from "./lifecycle.ts";
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
  return { deps, store, lifecycle, runSpawner, worklogs };
}

describe("durable completion claim", () => {
  it("two concurrent completeRun calls create exactly one entry", async () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id }, deps);
    const results = await Promise.allSettled([completeRun({ runId: run.id }, deps), completeRun({ runId: run.id }, deps)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(lifecycle.timeEntries.filter((e) => e.runId === run.id)).toHaveLength(1);
  });
});

describe("durable submission claim", () => {
  it("a second submit while the first POST is held is refused and no duplicate worklog is stored", async () => {
    const { deps, store, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
    store.saveBoard({ ...board, connectionId: "conn1" });
    let release: (value: { id: string }) => void = () => {};
    const gate = new Promise<{ id: string }>((resolve) => { release = resolve; });
    deps.worklogs = { submitRemoteWorklog: () => gate } as typeof deps.worklogs;
    const entry: TimeEntry = { id: "e1", runId: "r1", taskId: task.id, state: "pending", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
    lifecycle.saveTimeEntry(entry);
    const first = submitTimeEntry({ entryId: "e1", durationSeconds: 3600, comment: "done" }, deps);
    expect(lifecycle.getTimeEntry("e1")?.state).toBe("submitting");
    await expect(submitTimeEntry({ entryId: "e1", durationSeconds: 3600, comment: "again" }, deps)).rejects.toMatchObject({ kind: "conflict" });
    release({ id: "wl1" });
    await first;
    expect(lifecycle.worklogs).toHaveLength(1);
  });

  it("recovery marks a submitting entry unknown after a crash", () => {
    const { deps, lifecycle } = makeDeps();
    const entry: TimeEntry = { id: "e1", runId: "r1", taskId: "t1", state: "submitting", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
    lifecycle.saveTimeEntry(entry);
    const result = recoverLifecycle(deps);
    expect(result.unknownEntries).toBe(1);
    expect(lifecycle.getTimeEntry("e1")?.state).toBe("unknown");
  });
});

describe("ambiguous spawn reconciliation", () => {
  it("adopts a thread created before a lost reply, without re-spawning", async () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const created = new Map<string, { threadId: string; environmentId: string | null; branchName: string | null }>();
    let first = true;
    deps.runSpawner = {
      async spawn(input) {
        if (first) {
          first = false;
          created.set(input.metadata.runId, { threadId: "thread_1", environmentId: "env_1", branchName: input.branchName });
          throw new Error("lost reply");
        }
        throw new Error("must not re-spawn");
      },
      async reconcile(runId) { return created.get(runId) ?? null; },
    } as typeof deps.runSpawner;
    const input = { taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id };
    await expect(takeIntoWork(input, deps)).rejects.toThrow(/lost reply/);
    expect(lifecycle.runs[0].state).toBe("spawning");
    const run = await takeIntoWork(input, deps);
    expect(run.threadId).toBe("thread_1");
    expect(lifecycle.runs).toHaveLength(1);
  });

  it("an indeterminate reconcile surfaces owner recovery and never re-spawns", async () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run: TaskRun = { id: "r1", taskId: task.id, projectId: "proj_1", environmentId: null, threadId: null, branchName: null, startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id, state: "spawning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null };
    lifecycle.saveRun(run);
    let spawns = 0;
    deps.runSpawner = { async spawn() { spawns += 1; throw new Error("should not spawn"); }, async reconcile() { return undefined; } } as typeof deps.runSpawner;
    const input = { taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id };
    await expect(takeIntoWork(input, deps)).rejects.toMatchObject({ kind: "conflict" });
    expect(spawns).toBe(0);
    expect(lifecycle.runs[0].state).toBe("unknown");
  });

  it("cancelRun refuses an uncertain (spawning/unknown) run", async () => {
    const { deps, lifecycle } = makeDeps();
    const { cancelRun } = await import("./lifecycle.ts");
    lifecycle.saveRun({ id: "s1", taskId: "t", projectId: "p1", environmentId: null, threadId: null, branchName: null, startStatusId: "c1", nextStatusId: "c2", state: "spawning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    expect(() => cancelRun("s1", deps)).toThrowError(/uncertain/);
    expect(lifecycle.runs).toHaveLength(1);
  });

  it("cancelRun removes a no-resource run so the owner can change project/status", async () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    deps.runSpawner = { spawn: async () => { throw new DomainError("invalid", "boom"); }, reconcile: async () => null } as typeof deps.runSpawner;
    const input = { taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id };
    await expect(takeIntoWork(input, deps)).rejects.toMatchObject({ kind: "invalid" });
    expect(lifecycle.runs[0].state).toBe("failed");
    const { cancelRun } = await import("./lifecycle.ts");
    cancelRun(lifecycle.runs[0].id, deps);
    expect(lifecycle.runs).toHaveLength(0);
  });
});

describe("resumable provisioning", () => {
  it("retains the run and resumes without re-spawning after a denied start transition", async () => {
    const { deps, store, lifecycle, runSpawner } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
    const input = { taskId: task.id, projectId: "proj_1", startStatusId: board.columns[1].id, nextStatusId: board.columns[2].id };
    await expect(takeIntoWork(input, deps)).rejects.toMatchObject({ kind: "invalid" });
    expect(lifecycle.runs).toHaveLength(1);
    expect(lifecycle.runs[0].threadId).toBe("thread_1");
    expect(runSpawner.calls).toHaveLength(1);
    await expect(takeIntoWork(input, deps)).rejects.toMatchObject({ kind: "invalid" });
    expect(runSpawner.calls).toHaveLength(1);
    expect(lifecycle.runs).toHaveLength(1);
  });
});
