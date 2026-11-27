import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Checkpoint, JobStore } from "../../core/job-store.ts";
import { OperationJob } from "../../core/model.ts";
import { createSqliteJobStore } from "./job-store-sqlite.ts";
import { MIGRATIONS } from "./migrations.ts";

const date = "2026-11-27T00:00:00.000Z";
const job: OperationJob = {
  id: "223e4567-e89b-42d3-a456-426614174000",
  plan: {
    id: "123e4567-e89b-42d3-a456-426614174000",
    kind: "copy",
    createdAt: date,
    initiator: { kind: "agent", threadId: "thr_test" },
    sourceEndpoint: "host:test",
    targetEndpoint: "host:test",
    items: [{
      source: { endpoint: "host:test", path: { segments: [{ t: "Отчёты" }, { b: "/w==" }] } },
      target: { endpoint: "host:test", path: { segments: [{ t: "Копия" }, { b: "/w==" }] } },
      kind: "file",
      fingerprint: { size: "18446744073709551615", mtimeNs: null },
    }],
    conflictPolicy: "ask",
    route: "same-endpoint",
    verify: "size",
    totalBytes: "18446744073709551615",
    digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  state: "pending",
  awaitsOwner: true,
  currentItem: null,
  pendingConflict: null,
  progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "18446744073709551615" },
  items: [{ outcome: "pending", error: null }],
  error: null,
  createdAt: date,
  updatedAt: date,
};
const secondId = "223e4567-e89b-42d3-a456-426614174001";
const checkpoint: Checkpoint = {
  jobId: job.id,
  itemIndex: 0,
  phase: "copying",
  bytesDone: "18446744073709551615",
  tempName: ".Копия.partial",
};

let directory: string;
let filename: string;
let db: Database.Database;
let store: JobStore;
// The SDK applies the ordered SQL in a transaction.
function migrate(database: Database.Database): void {
  database.transaction(() => {
    for (const sql of MIGRATIONS) database.exec(sql);
  })();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "commander-job-store-"));
  filename = join(directory, "jobs.sqlite");
  db = new Database(filename);
  migrate(db);
  store = createSqliteJobStore(db);
});

afterEach(() => {
  try {
    db?.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("round-trips Cyrillic, a raw name segment and uint64 max without loss", async () => {
  expect(await store.get(job.id)).toBeNull();
  await store.create(job);
  expect(await store.get(job.id)).toStrictEqual(job);
  expect(db.prepare("SELECT initiator_kind, thread_id, awaits_owner FROM jobs").get())
    .toEqual({ initiator_kind: "agent", thread_id: "thr_test", awaits_owner: 1 });
});

test("rejects duplicate ids without replacing the original job", async () => {
  await store.create(job);
  await expect(store.create({ ...job, awaitsOwner: false })).rejects.toMatchObject({ code: "already_exists" });
  expect(await store.get(job.id)).toStrictEqual(job);
});

test("compare-and-swap accepts only the first transition across connections", async () => {
  await store.create(job);
  const peerDb = new Database(filename);
  try {
    const peer = createSqliteJobStore(peerDb);
    expect(await Promise.all([
      store.update(job.id, { state: "running" }, "pending"),
      peer.update(job.id, { state: "cancelled" }, "pending"),
    ])).toEqual([true, false]);
    expect(await peer.get(job.id)).toMatchObject({ state: "running", awaitsOwner: false });
    expect(await peer.update(secondId, { state: "running" }, "pending")).toBe(false);
  } finally {
    peerDb.close();
  }
});

test("clears owner approval on pending exit and rejects setting it on a running job", async () => {
  await store.create(job);
  await expect(store.update(job.id, { state: "running", awaitsOwner: true }, "pending")).rejects.toThrow();
  expect(await store.get(job.id)).toStrictEqual(job);
  expect(await store.update(job.id, { state: "running" }, "pending")).toBe(true);
  const running = { ...job, state: "running", awaitsOwner: false };
  expect(await store.get(job.id)).toStrictEqual(running);
  await expect(store.update(job.id, { awaitsOwner: true }, "running")).rejects.toThrow();
  expect(await store.get(job.id)).toStrictEqual(running);
  await expect(store.create({ ...job, id: secondId, state: "running" })).rejects.toThrow();
  expect(await store.get(secondId)).toBeNull();
});

test("rejects a patch that breaks the operation job invariants", async () => {
  await store.create(job);
  await expect(store.update(job.id, { currentItem: 1 }, "pending")).rejects.toThrow();
  await expect(store.update(job.id, { items: [] }, "pending")).rejects.toThrow();
  expect(await store.get(job.id)).toStrictEqual(job);
});

test("lists matching states in descending update order before applying the limit", async () => {
  await store.create(job);
  await store.create({ ...job, id: secondId, updatedAt: "2026-11-27T01:00:00.000Z" });
  expect((await store.list({ states: ["pending"], limit: 1 })).map(({ id }) => id)).toEqual([secondId]);
  expect(await store.list({ states: [], limit: 10 })).toEqual([]);
  expect(await store.list({ limit: 0 })).toEqual([]);
});

test("returns a damaged job as unknown without hiding healthy jobs", async () => {
  await store.create(job);
  await store.create({ ...job, id: secondId });
  db.prepare("UPDATE jobs SET plan_json = ? WHERE id = ?").run("{broken", job.id);
  const jobs = await store.list({ limit: 10 });
  expect(jobs).toHaveLength(2);
  expect(jobs).toContainEqual({ ...job, id: secondId });
  expect(await store.get(job.id)).toMatchObject({
    id: job.id, state: "unknown", awaitsOwner: false,
    error: { code: "internal", retryable: false },
  });
  const unknown = await store.list({ states: ["unknown"], limit: 10 });
  expect(unknown.map(({ id }) => id)).toEqual([job.id]);
  expect(OperationJob.safeParse(unknown[0]).success).toBe(true);
  expect(await store.update(job.id, { state: "running" }, "pending")).toBe(false);
});

test("stores the latest checkpoint per item and reopens both jobs and checkpoints", async () => {
  await store.create(job);
  expect(await store.lastCheckpoint(job.id, 0)).toBeNull();
  await store.checkpoint(checkpoint);
  expect(db.prepare("SELECT temp_path_json FROM checkpoints").pluck().get())
    .toBe('{"segments":[{"t":".Копия.partial"}]}');
  await store.checkpoint({ ...checkpoint, itemIndex: 1 });
  await store.checkpoint({ ...checkpoint, phase: "committed", tempName: null });

  db.close();
  db = new Database(filename);
  store = createSqliteJobStore(db);

  expect(await store.get(job.id)).toStrictEqual(job);
  expect(await store.lastCheckpoint(job.id, 0))
    .toStrictEqual({ ...checkpoint, phase: "committed", tempName: null });
  expect(await store.lastCheckpoint(job.id, 1)).toStrictEqual({ ...checkpoint, itemIndex: 1 });
});

test("creation keeps the newest 1000 terminal jobs and prunes their old checkpoints", async () => {
  await store.create(job);
  const oldestId = "00000000-0000-4000-8000-000000000000";
  db.exec(`
    WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
    INSERT INTO jobs
    SELECT printf('00000000-0000-4000-8000-%012d', n), plan_json,
      CASE n % 4 WHEN 0 THEN 'completed' WHEN 1 THEN 'failed'
        WHEN 2 THEN 'cancelled' ELSE 'unknown' END,
      progress_json, NULL, NULL, items_json, NULL, created_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, printf('+%d seconds', n)),
      initiator_kind, thread_id, 0
    FROM seq CROSS JOIN jobs WHERE id = '223e4567-e89b-42d3-a456-426614174000';
  `);
  await store.checkpoint({ ...checkpoint, jobId: oldestId });
  await store.checkpoint(checkpoint);

  await store.create({ ...job, id: secondId, state: "interrupted", awaitsOwner: false });

  expect(await store.get(oldestId)).toBeNull();
  expect(await store.lastCheckpoint(oldestId, 0)).toBeNull();
  expect(await store.lastCheckpoint(job.id, 0)).toStrictEqual(checkpoint);
  expect(await store.get(secondId)).toMatchObject({ state: "interrupted" });
  expect(await store.get(job.id)).toStrictEqual(job);
  expect(await store.list({ states: ["completed", "failed", "cancelled", "unknown"], limit: 2000 }))
    .toHaveLength(1000);
});

test("reapplying the migration SQL preserves existing rows", async () => {
  await store.create(job);
  migrate(db);
  expect(await createSqliteJobStore(db).get(job.id)).toStrictEqual(job);
});
