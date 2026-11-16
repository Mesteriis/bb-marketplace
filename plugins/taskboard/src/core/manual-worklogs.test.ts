import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSqliteStore, MIGRATIONS } from "../adapters/bb/sqlite-store.ts";
import { createLifecycleStore } from "../adapters/bb/lifecycle-store.ts";
import { createBoard, createTask } from "./board.ts";
import { prepareWorklog } from "./manual-worklogs.ts";
import { submitTimeEntry } from "./lifecycle.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeProjects, createFakeRunSpawner, createFakeWorklogSink } from "./testing/fakes.ts";

it("logs time without a development run and preserves the task status (SQLite)", async () => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const deps = { store: createSqliteStore(db), lifecycle: createLifecycleStore(db), clock: createFakeClock(), idgen: createFakeId(), credentials: createFakeCredentials(), projects: createFakeProjects(), runSpawner: createFakeRunSpawner(), worklogs: createFakeWorklogSink() };
  const board = createBoard("Local", deps);
  const task = createTask({ boardId: board.id, title: "Investigation" }, deps);
  const input = { taskId: task.id, entryId: "manual-1", durationSeconds: 1800, comment: "Investigated" };
  const entry = prepareWorklog(input, deps);
  expect(prepareWorklog(input, deps).id).toBe(entry.id);
  const log = await submitTimeEntry({ entryId: entry.id, durationSeconds: 1800, comment: "Investigated" }, deps);
  expect(log.durationSeconds).toBe(1800);
  expect(log.comment).toBe("Investigated");
  expect(deps.store.getTask(task.id)?.status).toBe(task.status);
  expect(deps.lifecycle.listRunsForTask(task.id)).toEqual([]);
  expect(deps.lifecycle.listWorklogsForTask(task.id)).toHaveLength(1);
  await expect(submitTimeEntry({ entryId: entry.id, durationSeconds: 1800, comment: "Investigated" }, deps)).rejects.toThrow(/submitted/);
  expect(() => prepareWorklog({ ...input, durationSeconds: 0 }, deps)).toThrow();
  db.close();
});
