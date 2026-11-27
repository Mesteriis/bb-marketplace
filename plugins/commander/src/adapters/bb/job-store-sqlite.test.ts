import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
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
    targetDir: { endpoint: "host:test", path: { segments: [{ t: "Копия" }] } },
    items: [{
      source: { endpoint: "host:test", path: { segments: [{ t: "Отчёты" }, { b: "/w==" }] } },
      target: { endpoint: "host:test", path: { segments: [{ t: "Копия" }, { b: "/w==" }] } },
      kind: "file",
      fingerprint: { size: "18446744073709551615", mtimeNs: null },
      expectTarget: "absent",
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
  phase: "prepared",
  bytesDone: "18446744073709551615",
  tempPath: { segments: [{ t: "Копии" }, { b: "/w==" }, { t: ".Копия.partial" }] },
  tempFingerprint: {
    size: "18446744073709551615",
    mtimeNs: "1732665600000000001",
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  via: "copy",
  writing: { offset: "18446744073709551612", length: 3 },
  cleanup: {
    tempPath: { segments: [{ t: "Копии" }, { b: "/w==" }, { t: ".staged" }] },
    tempFingerprint: { size: "18446744073709551615", mtimeNs: "1732665600123456789" },
  },
  sourceHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  targetPath: { segments: [{ t: "Копии" }, { b: "/w==" }, { t: "Копия" }] },
  expectTarget: { size: "12", mtimeNs: "1732665600000000000" },
  verified: { size: "18446744073709551615", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  committed: { size: "18446744073709551615", mtimeNs: "1732665600123456789" },
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

test("CAS accepts only the first transition with the expected state", async () => {
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
  await expect(store.update(job.id, { state: "running", awaitsOwner: true }, "pending")).rejects.toThrow("Owner approval requires a pending job");
  expect(await store.get(job.id)).toStrictEqual(job);
  expect(await store.update(job.id, { state: "running" }, "pending")).toBe(true);
  const running = { ...job, state: "running", awaitsOwner: false };
  expect(await store.get(job.id)).toStrictEqual(running);
  await expect(store.update(job.id, { awaitsOwner: true }, "running")).rejects.toThrow("Owner approval requires a pending job");
  expect(await store.get(job.id)).toStrictEqual(running);
  await expect(store.create({ ...job, id: secondId, state: "running" })).rejects.toThrow("Owner approval requires a pending job");
  expect(await store.get(secondId)).toBeNull();
});

test("rejects a patch that breaks the operation job invariants", async () => {
  await store.create(job);
  await expect(store.update(job.id, { currentItem: 1 }, "pending")).rejects.toThrow("Current item is outside the job");
  await expect(store.update(job.id, { items: [] }, "pending")).rejects.toThrow("Expected one outcome per plan item");
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
    plan: {
      kind: "delete",
      targetDir: null,
      items: [{ source: null, target: null, expectTarget: null }],
    },
    error: { code: "internal", retryable: false },
  });
  const unknown = await store.list({ states: ["unknown"], limit: 10 });
  expect(unknown.map(({ id }) => id)).toEqual([job.id]);
  expect(OperationJob.safeParse(unknown[0]).success).toBe(true);
  expect(await store.update(job.id, { state: "running" }, "pending")).toBe(false);
});

test("reopens every checkpoint field and replaces nullable and optional fields on upsert", async () => {
  await store.create(job);
  expect(await store.lastCheckpoint(job.id, 0)).toBeNull();
  await store.checkpoint(checkpoint);
  await store.checkpoint({ ...checkpoint, itemIndex: 1 });
  const renamed: Checkpoint = { ...checkpoint, itemIndex: 2, phase: "committed", via: "rename" };
  await store.checkpoint(renamed);

  const replacement: Checkpoint = {
    jobId: job.id,
    itemIndex: 1,
    phase: "committed",
    bytesDone: "12",
    tempPath: null,
    targetPath: { segments: [{ t: "Копии" }, { b: "/w==" }] },
    expectTarget: "absent",
    verified: null,
  };
  await store.checkpoint(replacement);
  expect(db.prepare(`
    SELECT temp_path_json, target_path_json, expect_target_json, verified_json, committed_json,
      temp_fingerprint_json, via, writing_json, cleanup_json, source_hash
    FROM checkpoints WHERE item_index = 1
  `).get()).toEqual({
    temp_path_json: null,
    target_path_json: '{"segments":[{"t":"Копии"},{"b":"/w=="}]}',
    expect_target_json: '"absent"',
    verified_json: null,
    committed_json: null,
    temp_fingerprint_json: null,
    via: null,
    writing_json: null,
    cleanup_json: null,
    source_hash: null,
  });

  db.close();
  db = new Database(filename);
  store = createSqliteJobStore(db);

  expect(await store.get(job.id)).toStrictEqual(job);
  expect(await store.lastCheckpoint(job.id, 0)).toStrictEqual(checkpoint);
  expect(await store.lastCheckpoint(job.id, 1)).toStrictEqual(replacement);
  expect(await store.lastCheckpoint(job.id, 2)).toStrictEqual(renamed);
});

function seedTerminalJobs(count: number, firstOffset: number): void {
  db.prepare(`
    WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < @count)
    INSERT INTO jobs
    SELECT printf('00000000-0000-4000-8000-%012d', n), plan_json,
      CASE n % 4 WHEN 0 THEN 'completed' WHEN 1 THEN 'failed'
        WHEN 2 THEN 'cancelled' ELSE 'unknown' END,
      progress_json, NULL, NULL, items_json, NULL, created_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, printf('+%d seconds', n + @firstOffset)),
      initiator_kind, thread_id, 0
    FROM seq CROSS JOIN jobs WHERE id = @templateId
  `).run({ count, firstOffset, templateId: job.id });
}

test("creation keeps the newest 1000 terminal jobs and prunes their old checkpoints", async () => {
  await store.create(job);
  const oldestId = "00000000-0000-4000-8000-000000000000";
  seedTerminalJobs(1001, 0);
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

test("normalizes stored dates and prunes the earlier terminal job at the 1000-job boundary", async () => {
  db.function("unixepoch", { varargs: true }, () => {
    throw new Error("This SQLite has no unixepoch subsec support");
  });
  await store.create({
    ...job,
    createdAt: "2026-11-27T00:00:00Z",
    updatedAt: "2026-11-27T00:00:00Z",
    state: "completed",
    awaitsOwner: false,
  });
  await store.create({
    ...job,
    id: secondId,
    state: "completed",
    awaitsOwner: false,
    updatedAt: "2026-11-27T00:00:00.500Z",
  });
  const older = await store.get(job.id);
  const beforePrune = (await store.list({ states: ["completed"], limit: 2 })).map(({ id }) => id);
  seedTerminalJobs(999, 1);
  await store.create({ ...job, id: "223e4567-e89b-42d3-a456-426614174002" });

  expect(await store.get(job.id)).toBeNull();
  expect(await store.get(secondId)).toMatchObject({ updatedAt: "2026-11-27T00:00:00.500Z" });
  expect(beforePrune).toEqual([secondId, job.id]);
  expect(older).toMatchObject({
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
  });
  expect(await store.update(secondId, { updatedAt: "2026-11-27T00:00:01Z" }, "completed")).toBe(true);
  expect(await store.get(secondId)).toMatchObject({ updatedAt: "2026-11-27T00:00:01.000Z" });
});

test("prunes a damaged pending job as terminal unknown", async () => {
  await store.create(job);
  seedTerminalJobs(1000, 1);
  db.prepare("UPDATE jobs SET plan_json = ? WHERE id = ?").run("{broken", job.id);
  expect(await store.list({ states: ["completed", "failed", "cancelled", "unknown"], limit: 2000 }))
    .toHaveLength(1001);

  await store.create({ ...job, id: secondId });
  expect(await store.get(job.id)).toBeNull();
  expect(await store.list({ states: ["completed", "failed", "cancelled", "unknown"], limit: 2000 }))
    .toHaveLength(1000);
});

test("counts stored terminal jobs in SQLite without decoding them during create", async () => {
  await store.create({ ...job, state: "completed", awaitsOwner: false });
  seedTerminalJobs(1000, 1);
  let terminalCounts = 0;
  const peer = new Database(filename, {
    verbose(sql) {
      if (typeof sql === "string" && /SELECT count\(\*\) FROM jobs WHERE state IN/i.test(sql)) {
        terminalCounts++;
      }
    },
  });
  const parse = vi.spyOn(OperationJob, "parse");
  try {
    await createSqliteJobStore(peer).create({ ...job, id: secondId, state: "failed", awaitsOwner: false });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(terminalCounts).toBe(1);
    expect(peer.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(1000);
  } finally {
    parse.mockRestore();
    peer.close();
  }
});

test("rejects plan in a patch even if the replacement plan matches the new outcomes", async () => {
  await store.create(job);
  const patch = {
    plan: { ...job.plan, items: [job.plan.items[0], job.plan.items[0]] },
    items: [job.items[0], job.items[0]],
  };
  try {
    await expect(store.update(job.id, patch, "pending")).rejects.toThrow(
      new CommanderError("internal", "Job update contains an unsupported field"),
    );
  } finally {
    expect(await store.get(job.id)).toStrictEqual(job);
  }
});

test("rejects a checkpoint after its job is pruned without creating an orphan", async () => {
  await store.create({ ...job, state: "completed", awaitsOwner: false });
  seedTerminalJobs(1000, 1);
  await store.create({ ...job, id: secondId });
  expect(await store.get(job.id)).toBeNull();

  try {
    await expect(store.checkpoint(checkpoint)).rejects.toMatchObject({
      name: "CommanderError", code: "not_found", message: "Job not found",
    });
  } finally {
    expect(await store.lastCheckpoint(job.id, 0)).toBeNull();
  }
});

test("assigns distinct stable UUIDs from rowid and preserves valid initiators on damaged rows", async () => {
  await store.create(job);
  await store.create({ ...job, id: secondId });
  const damage = db.prepare("UPDATE jobs SET rowid = ?, id = ?, plan_json = '{broken', initiator_kind = ?, thread_id = ? WHERE id = ?");
  damage.run("9007199254740992", "damaged-1", "agent", "thr_test", job.id);
  damage.run("9007199254740993", "damaged-2", "agent", "", secondId);

  const first = await store.get("damaged-1");
  const second = await store.get("damaged-2");
  expect(first).toMatchObject({
    id: "00000000-0020-8000-8000-000000000000",
    state: "unknown",
    plan: { initiator: { kind: "agent", threadId: "thr_test" } },
  });
  expect(second).toMatchObject({
    id: "00000000-0020-8000-8000-000000000001",
    state: "unknown",
    plan: { initiator: { kind: "owner" } },
  });
  db.close();
  db = new Database(filename);
  store = createSqliteJobStore(db);
  expect(await store.list({ states: ["unknown"], limit: 2 })).toStrictEqual([first, second]);
});

test("a damaged row keeps its UUID after a neighbor is pruned and the database reopens", async () => {
  const alias = "00000000-0000-8000-8000-000000000400";
  const neighborId = "223e4567-e89b-42d3-a456-426614174003";
  await store.create({
    ...job,
    id: neighborId,
    state: "completed",
    awaitsOwner: false,
    updatedAt: "2026-11-26T00:00:00.000Z",
  });
  await store.create(job);
  seedTerminalJobs(999, 1);
  db.prepare("UPDATE jobs SET rowid = 1024, id = 'damaged', updated_at = ? WHERE id = ?")
    .run("2026-11-28T00:00:00.000Z", job.id);

  const [damaged] = await store.list({ states: ["unknown"], limit: 1 });
  expect(damaged).toMatchObject({ id: alias, state: "unknown" });
  expect(await store.get(alias)).toStrictEqual(damaged);

  await store.create({ ...job, id: secondId });
  expect(await store.get(neighborId)).toBeNull();

  db.close();
  db = new Database(filename);
  store = createSqliteJobStore(db);
  expect(await store.list({ states: ["unknown"], limit: 1 })).toStrictEqual([damaged]);
  expect(await store.get(alias)).toStrictEqual(damaged);
});

test.each([
  "00000000-0000-8000-8000-00000000002a",
  "00000000-0000-8000-8000-00000000002A",
  "00000000-0020-8000-8000-000000000000",
])("reserves %s even in an empty database", async (id) => {
  await expect(store.create({ ...job, id })).rejects.toMatchObject({
    code: "already_exists", message: "Job already exists",
  });
  expect(await store.get(id)).toBeNull();
});

test("only the exact damaged UUID resolves to the row and is reserved during create", async () => {
  const alias = "00000000-0000-8000-8000-00000000002a";
  const unrelatedId = "ffffffff-0000-8000-8000-00000000002a";
  await store.create(job);
  db.prepare("UPDATE jobs SET rowid = 42, id = 'damaged' WHERE id = ?").run(job.id);
  const [damaged] = await store.list({ states: ["unknown"], limit: 1 });

  expect(damaged.id).toBe(alias);
  expect(await store.get(alias)).toStrictEqual(damaged);
  expect(await store.get(unrelatedId)).toBeNull();
  await expect(store.create({ ...job, id: alias })).rejects.toMatchObject({
    code: "already_exists", message: "Job already exists",
  });
  expect(await store.get(alias)).toStrictEqual(damaged);

  await expect(store.update(alias, { state: "running" }, "unknown")).rejects.toMatchObject({
    code: "internal", message: "Damaged job aliases are read-only",
  });
  await expect(store.checkpoint({ ...checkpoint, jobId: alias })).rejects.toMatchObject({
    code: "internal", message: "Damaged job aliases are read-only",
  });
  expect(await store.get(alias)).toStrictEqual(damaged);

  const unrelated = { ...job, id: unrelatedId };
  await store.create(unrelated);
  expect(await store.get(unrelatedId)).toStrictEqual(unrelated);
});

test("ordinary UUIDv4 jobs still support creation, update and checkpoint writes", async () => {
  await store.create(job);
  expect(await store.update(job.id, { state: "running" }, "pending")).toBe(true);
  await store.checkpoint(checkpoint);
  expect(await store.get(job.id)).toStrictEqual({ ...job, state: "running", awaitsOwner: false });
  expect(await store.lastCheckpoint(job.id, 0)).toStrictEqual(checkpoint);
});

test("SQLite rejects setting awaits_owner directly on a running job", async () => {
  await store.create({ ...job, state: "running", awaitsOwner: false });
  expect(() => db.prepare("UPDATE jobs SET awaits_owner = 1 WHERE id = ?").run(job.id))
    .toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));
  expect(await store.get(job.id)).toMatchObject({ state: "running", awaitsOwner: false });
});

async function loadSdkTestHost() {
  const sdkTesting = import.meta.resolve("@get-bb/plugin-sdk/testing");
  // SDK 0.6.132 eagerly imports an optional peer used only by the scheduler.
  // Keep the native loader override scoped to this import and fail if used.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier !== "cron-parser" || context.parentURL !== sdkTesting
          || (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        const unusedScheduler = 'export class CronExpressionParser { static parse() { throw new Error("Scheduler unavailable in this test"); } }';
        return { url: `data:text/javascript,${encodeURIComponent(unusedScheduler)}`, shortCircuit: true };
      }
    },
  });
  try {
    return await import("@get-bb/plugin-sdk/testing");
  } finally {
    hook.deregister();
  }
}

test("the SDK creates tables in a clean database and the second migrate preserves its journal", async () => {
  const { createFakePluginHost } = await loadSdkTestHost();
  const { bb } = createFakePluginHost({ pluginId: "commander-s6-migration" });
  const cleanDb = new Database(join(directory, "sdk.sqlite"));
  try {
    const tables = cleanDb.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck();
    expect(tables.all()).toStrictEqual([]);

    bb.storage.migrate(cleanDb, MIGRATIONS);
    expect(tables.all()).toStrictEqual(["_bb_migrations", "checkpoints", "jobs"]);
    await createSqliteJobStore(cleanDb).create(job);
    const journal = cleanDb.prepare("SELECT * FROM _bb_migrations ORDER BY id");
    const entries = journal.all();
    expect(entries).toEqual([
      { id: 0, applied_at: expect.any(Number), statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 1, applied_at: expect.any(Number), statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 2, applied_at: expect.any(Number), statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 3, applied_at: expect.any(Number), statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);

    bb.storage.migrate(cleanDb, MIGRATIONS);
    expect(journal.all()).toStrictEqual(entries);
    expect(await createSqliteJobStore(cleanDb).get(job.id)).toStrictEqual(job);
  } finally {
    cleanDb.close();
  }
});

test.each([1, 2, 3])("upgrades a v%i checkpoint without inventing recovery metadata", async (version) => {
  const { createFakePluginHost } = await loadSdkTestHost();
  const { bb } = createFakePluginHost({ pluginId: "commander-s6-checkpoint-upgrade" });
  const legacyDb = new Database(join(directory, "v1.sqlite"));
  try {
    bb.storage.migrate(legacyDb, MIGRATIONS.slice(0, version));
    const journal = legacyDb.prepare("SELECT * FROM _bb_migrations WHERE id < ? ORDER BY id");
    const originalEntries = journal.all(version);
    legacyDb.prepare(`
      INSERT INTO checkpoints (job_id, item_index, phase, bytes_done, temp_path_json, at)
      VALUES (?, 0, 'copying', '18446744073709551615', '{"segments":[{"t":".Копия.partial"}]}', ?),
             (?, 1, 'committed', '12', NULL, ?)
    `).run(job.id, date, job.id, date);

    bb.storage.migrate(legacyDb, MIGRATIONS);
    expect(legacyDb.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck().all()).toEqual([0, 1, 2, 3]);
    expect(journal.all(version)).toStrictEqual(originalEntries);

    const migrated = createSqliteJobStore(legacyDb);
    expect(await migrated.lastCheckpoint(job.id, 0)).toStrictEqual({
      jobId: job.id,
      itemIndex: 0,
      phase: "copying",
      bytesDone: "18446744073709551615",
      tempPath: { segments: [{ t: ".Копия.partial" }] },
      targetPath: null,
      expectTarget: null,
      verified: null,
    });
    expect(await migrated.lastCheckpoint(job.id, 1)).toStrictEqual({
      jobId: job.id,
      itemIndex: 1,
      phase: "committed",
      bytesDone: "12",
      tempPath: null,
      targetPath: null,
      expectTarget: null,
      verified: null,
    });
  } finally {
    legacyDb.close();
  }
});
