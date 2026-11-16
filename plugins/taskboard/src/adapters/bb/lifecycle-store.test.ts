import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { TaskRun, TimeEntry, WorklogRecord } from "../../core/lifecycle.ts";
import { createLifecycleStore } from "./lifecycle-store.ts";
import { MIGRATIONS } from "./sqlite-store.ts";

function makeStore() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return createLifecycleStore(db);
}

describe("sqlite LifecycleStore", () => {
  it("round-trips a run, a time entry and a worklog", () => {
    const store = makeStore();
    const run: TaskRun = { id: "r1", taskId: "t1", projectId: "p1", environmentId: "e1", threadId: "th1", branchName: "DEMO-1", startStatusId: "c1", nextStatusId: "c2", state: "active", startedAtIso: "2026-06-01T09:00:00.000Z", completedAtIso: null, durationSeconds: null, deliveredSummary: null };
    store.saveRun(run);
    expect(store.getRun("r1")?.threadId).toBe("th1");
    expect(store.getRunByThread("th1")?.id).toBe("r1");
    expect(store.listRunsForTask("t1")).toHaveLength(1);

    const entry: TimeEntry = { id: "e1", runId: "r1", taskId: "t1", state: "pending", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
    store.saveTimeEntry(entry);
    expect(store.getTimeEntryByRun("r1")?.id).toBe("e1");
    expect(store.listPendingTimeEntries()).toHaveLength(1);

    const worklog: WorklogRecord = { id: "w1", taskId: "t1", runId: "r1", remote: true, remoteId: "10001", durationSeconds: 3600, comment: "done", startedAtIso: "x", createdAtIso: "y" };
    store.saveWorklog(worklog);
    expect(store.listWorklogsForTask("t1")[0].remoteId).toBe("10001");

    store.deleteRun("r1");
    expect(store.getRun("r1")).toBeNull();
  });

  it("claimCompletion rolls back the run when the entry insert fails unexpectedly", () => {
    const store = makeStore();
    store.saveRun({ id: "r1", taskId: "t1", projectId: "p1", environmentId: null, threadId: "th1", branchName: "B", startStatusId: "c1", nextStatusId: "c2", state: "active", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    const completed: TaskRun = { id: "r1", taskId: "t1", projectId: "p1", environmentId: null, threadId: "th1", branchName: "B", startStatusId: "c1", nextStatusId: "c2", state: "completed", startedAtIso: "x", completedAtIso: "y", durationSeconds: 60, deliveredSummary: null };
    const badEntry = { id: "e1", runId: "r1", taskId: "t1", state: "pending", durationSeconds: Number.NaN, comment: "", createdAtIso: "x", submittedAtIso: null } as TimeEntry;
    expect(() => store.claimCompletion("r1", completed, badEntry)).toThrow();
    expect(store.getRun("r1")?.state).toBe("active");
    expect(store.getTimeEntryByRun("r1")).toBeNull();
  });
});
