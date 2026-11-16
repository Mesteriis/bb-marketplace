import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBoard, createTask } from "../../core/board.ts";
import { completeRun, recoverLifecycle, submitTimeEntry, takeIntoWork, updateTimeEntry, type LifecycleDeps } from "../../core/lifecycle.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeProjects, createFakeRunSpawner, createFakeWorklogSink } from "../../core/testing/fakes.ts";
import { createLifecycleStore } from "./lifecycle-store.ts";
import { createSqliteStore, MIGRATIONS } from "./sqlite-store.ts";

function makeDeps() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const store = createSqliteStore(db);
  const lifecycle = createLifecycleStore(db);
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock(new Date("2026-06-01T09:00:00.000Z"));
  const deps: LifecycleDeps = { store, lifecycle, projects: createFakeProjects(), runSpawner: createFakeRunSpawner(), worklogs: createFakeWorklogSink(), credentials, clock, idgen };
  return { deps, store, lifecycle, clock };
}

describe("SQLite persistence and nullable thread_id", () => {
  it("upgrades a pre-null schema preserving runs/time entries/worklogs", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS.slice(0, -5)) db.exec(migration);
    db.exec("INSERT INTO runs (id, task_id, project_id, environment_id, thread_id, branch_name, start_status_id, next_status_id, state, started_at, completed_at, duration_seconds, delivered_summary) VALUES ('r1','t1','p1',NULL,'th1','B','c1','c2','active','x',NULL,NULL,NULL)");
    db.exec("INSERT INTO runs (id, task_id, project_id, environment_id, thread_id, branch_name, start_status_id, next_status_id, state, started_at, completed_at, duration_seconds, delivered_summary) VALUES ('r0','t0','p0',NULL,'','','c1','c2','provisioning','x',NULL,NULL,NULL)");
    db.exec("INSERT INTO time_entries (id, run_id, task_id, state, duration_seconds, comment, created_at, submitted_at) VALUES ('e1','r1','t1','pending',3600,'','x',NULL)");
    db.exec("INSERT INTO worklogs (id, task_id, run_id, remote, remote_id, duration_seconds, comment, started_at, created_at) VALUES ('w1','t1','r1',0,NULL,3600,'','x','y')");
    for (const migration of MIGRATIONS) db.exec(migration);
    const lifecycle = createLifecycleStore(db);
    expect(lifecycle.getRun("r1")?.threadId).toBe("th1");
    // legacy empty-string thread_id is migrated to NULL.
    expect(lifecycle.getRun("r0")?.threadId).toBeNull();
    expect(lifecycle.getTimeEntry("e1")?.id).toBe("e1");
    expect(lifecycle.listWorklogsForTask("t1")).toHaveLength(1);
    // nullable now: save a provisioning run with null threadId.
    lifecycle.saveRun({ id: "r2", taskId: "t1", projectId: "p1", environmentId: null, threadId: null, branchName: null, startStatusId: "c1", nextStatusId: "c2", state: "provisioning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    expect(lifecycle.getRun("r2")?.threadId).toBeNull();
  });

  it("a clean database accepts a null thread_id run", () => {
    const { deps, lifecycle } = makeDeps();
    lifecycle.saveRun({ id: "r1", taskId: "t1", projectId: "p1", environmentId: null, threadId: null, branchName: null, startStatusId: "c1", nextStatusId: "c2", state: "provisioning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    expect(lifecycle.getRun("r1")?.threadId).toBeNull();
  });

  it("recovery marks interrupted provisioning/spawning runs unknown", () => {
    const { deps, lifecycle } = makeDeps();
    lifecycle.saveRun({ id: "p1", taskId: "t1", projectId: "p1", environmentId: null, threadId: null, branchName: null, startStatusId: "c1", nextStatusId: "c2", state: "provisioning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    lifecycle.saveRun({ id: "s1", taskId: "t1", projectId: "p1", environmentId: null, threadId: null, branchName: null, startStatusId: "c1", nextStatusId: "c2", state: "spawning", startedAtIso: "x", completedAtIso: null, durationSeconds: null, deliveredSummary: null });
    const result = recoverLifecycle(deps);
    expect(result.recoveredRuns).toBe(2);
    expect(lifecycle.getRun("p1")?.state).toBe("unknown");
    expect(lifecycle.getRun("s1")?.state).toBe("unknown");
  });

  it("full takeIntoWork -> complete -> edit -> submit over real SQLite", async () => {
    const { deps, store, lifecycle, clock } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    const run = await takeIntoWork({ taskId: task.id, projectId: "proj_1", startStatusId: board.columns[0].id, nextStatusId: board.columns[1].id }, deps);
    expect(run.threadId).toBe("thread_1");
    clock.advance(3_600_000);
    const entry = await completeRun({ runId: run.id }, deps);
    const updated = updateTimeEntry({ entryId: entry.id, durationSeconds: 1200, comment: "done" }, deps);
    expect(updated.durationSeconds).toBe(1200);
    const worklog = await submitTimeEntry({ entryId: entry.id, durationSeconds: 1200, comment: "done" }, deps);
    expect(worklog.durationSeconds).toBe(1200);
    expect(store.getTask(task.id)?.status).toBe(board.columns[1].id);
    expect(lifecycle.getRun(run.id)?.state).toBe("completed");
    expect(lifecycle.getTimeEntry(entry.id)?.state).toBe("submitted");
  });
});
