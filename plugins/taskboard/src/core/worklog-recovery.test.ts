import { describe, expect, it } from "vitest";
import { createBoard, createTask } from "./board.ts";
import { DomainError } from "./errors.ts";
import { resolveTimeEntry, retryTimeEntry, submitTimeEntry, type LifecycleDeps, type TimeEntry } from "./lifecycle.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeLifecycleStore, createFakeProjects, createFakeRunSpawner, createFakeStore, createFakeWorklogSink } from "./testing/fakes.ts";

function makeDeps() {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock(new Date("2026-06-01T09:00:00.000Z"));
  const lifecycle = createFakeLifecycleStore();
  const deps: LifecycleDeps = { store, lifecycle, projects: createFakeProjects(), runSpawner: createFakeRunSpawner(), worklogs: createFakeWorklogSink(), credentials, clock, idgen };
  return { deps, store, lifecycle };
}

function seedJiraEntry(deps: LifecycleDeps): TimeEntry {
  const board = createBoard("B", deps);
  const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
  deps.store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
  deps.store.saveBoard({ ...board, connectionId: "conn1" });
  const entry: TimeEntry = { id: "e1", runId: "r1", taskId: task.id, state: "pending", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
  deps.lifecycle.saveTimeEntry(entry);
  return entry;
}

describe("worklog failure classification", () => {
  it("persists the exact edited duration/comment with the submitting claim", async () => {
    const { deps, lifecycle } = makeDeps();
    seedJiraEntry(deps);
    deps.worklogs = { submitRemoteWorklog: async () => { throw new DomainError("network", "Could not reach the Jira server"); } } as typeof deps.worklogs;
    await expect(submitTimeEntry({ entryId: "e1", durationSeconds: 1200, comment: "edited" }, deps)).rejects.toMatchObject({ kind: "network" });
    const entry = lifecycle.getTimeEntry("e1")!;
    expect(entry.state).toBe("unknown");
    expect(entry.durationSeconds).toBe(1200);
    expect(entry.comment).toBe("edited");
    const worklog = resolveTimeEntry({ entryId: "e1" }, deps);
    expect(worklog.durationSeconds).toBe(1200);
    expect(worklog.comment).toBe("edited");
  });

  it("a lost-response / network failure is unknown and not auto-retryable", async () => {
    const { deps, lifecycle } = makeDeps();
    seedJiraEntry(deps);
    deps.worklogs = { submitRemoteWorklog: async () => { throw new DomainError("http", "The Jira server returned an unexpected response"); } } as typeof deps.worklogs;
    await expect(submitTimeEntry({ entryId: "e1", durationSeconds: 3600, comment: "done" }, deps)).rejects.toMatchObject({ kind: "http" });
    expect(lifecycle.getTimeEntry("e1")?.state).toBe("unknown");
    expect(() => retryTimeEntry("e1", deps)).toThrowError(/known-failed/);
    expect(lifecycle.worklogs).toHaveLength(0);
  });

  it("an explicit auth rejection is failed and retryable", async () => {
    const { deps, lifecycle } = makeDeps();
    seedJiraEntry(deps);
    deps.worklogs = { submitRemoteWorklog: async () => { throw new DomainError("auth", "Authentication failed"); } } as typeof deps.worklogs;
    await expect(submitTimeEntry({ entryId: "e1", durationSeconds: 3600, comment: "done" }, deps)).rejects.toMatchObject({ kind: "auth" });
    expect(lifecycle.getTimeEntry("e1")?.state).toBe("failed");
    expect(retryTimeEntry("e1", deps).state).toBe("pending");
  });

  it("resolveTimeEntry records an owner-confirmed worklog without a POST", () => {
    const { deps, lifecycle } = makeDeps();
    const board = createBoard("B", deps);
    const task = createTask({ boardId: board.id, title: "T", status: board.columns[0].id }, deps);
    deps.store.saveTask({ ...task, origin: "jira", originKey: "B-1" });
    const entry: TimeEntry = { id: "e1", runId: "r1", taskId: task.id, state: "unknown", durationSeconds: 3600, comment: "", createdAtIso: "x", submittedAtIso: null };
    lifecycle.saveTimeEntry(entry);
    const worklog = resolveTimeEntry({ entryId: "e1", remoteId: "10001" }, deps);
    expect(worklog.remoteId).toBe("10001");
    expect(lifecycle.getTimeEntry("e1")?.state).toBe("submitted");
    expect(lifecycle.worklogs).toHaveLength(1);
  });
});
