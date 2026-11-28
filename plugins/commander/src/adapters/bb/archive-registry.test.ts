import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { OperationJob, OperationPlan } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createArchiveRegistry, type ArchiveRegistry } from "./archive-registry.ts";
import { MIGRATIONS } from "./migrations.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 27);
const ARCHIVE = "archive:123e4567-e89b-42d3-a456-426614174000";
let directory: string;
let db: Database.Database;
let clock = T0;
let store: MemoryJobStore;
let registry: ArchiveRegistry;

const open = () => createArchiveRegistry({ db, jobs: store, now: () => new Date(clock), uuid: () => "123e4567-e89b-42d3-a456-426614174000" });

beforeEach(() => {
  clock = T0;
  directory = mkdtempSync(join(tmpdir(), "commander-archives-"));
  db = new Database(join(directory, "a.sqlite"));
  db.transaction(() => { for (const sql of MIGRATIONS) db.exec(sql); })();
  store = new MemoryJobStore();
  registry = open();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function job(state: OperationJob["state"], endpoint = ARCHIVE, id = "323e4567-e89b-42d3-a456-426614174000"): OperationJob {
  const plan = {
    id: "123e4567-e89b-42d3-a456-426614174001", kind: "copy", createdAt: "2026-11-27T00:00:00.000Z", initiator: { kind: "owner" },
    sourceEndpoint: endpoint, targetEndpoint: "host:to", targetDir: { endpoint: "host:to", path: { segments: [] } },
    items: [{
      source: { endpoint, path: parsePosix("/a") }, target: { endpoint: "host:to", path: parsePosix("/a") },
      kind: "file", fingerprint: { size: "1", mtimeNs: "1" }, expectTarget: "absent",
    }],
    conflictPolicy: "ask", route: "relay-server", verify: "size", totalBytes: "1", digest: "0".repeat(64),
  } as unknown as OperationPlan;
  return {
    id, plan, state, progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "1" }, currentItem: null,
    pendingConflict: null, awaitsOwner: false, error: null, items: [{ outcome: "pending", error: null }],
    createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z",
  } as OperationJob;
}

const source = { endpoint: "host:abc" as const, path: parsePosix("/data/a.zip") };
const fingerprint = { size: "10", mtimeNs: "5" };
const rowCount = () => db.prepare("SELECT count(*) FROM archives").pluck().get() as number;

test("registers a source and restores it by UUID after the database is reopened", () => {
  expect(registry.register(source, fingerprint)).toBe("123e4567-e89b-42d3-a456-426614174000");
  db.close();
  db = new Database(join(directory, "a.sqlite"));
  registry = open();
  expect(registry.get("123e4567-e89b-42d3-a456-426614174000")).toEqual({ source, fingerprint });
  expect(registry.get("223e4567-e89b-42d3-a456-426614174000")).toBeNull();
});

test("stores nothing but the agreed columns: no limits, passwords or copy paths", () => {
  registry.register(source, fingerprint);
  const row = db.prepare("SELECT * FROM archives").get() as Record<string, string>;
  expect(Object.keys(row)).toEqual(["id", "source_json", "fingerprint_json", "created_at", "last_referenced_at"]);
  expect(JSON.parse(row.source_json!)).toEqual({ endpoint: "host:abc", path: { segments: [{ t: "data" }, { t: "a.zip" }] } });
  expect(JSON.parse(row.fingerprint_json!)).toEqual(fingerprint);
  expect(row.created_at).toBe("2026-11-27T00:00:00.000Z");
  expect(row.last_referenced_at).toBe("2026-11-27T00:00:00.000Z");
});

test("rejects a damaged source or fingerprint row instead of guessing", () => {
  registry.register(source, fingerprint);
  db.prepare("UPDATE archives SET fingerprint_json = ?").run('{"size":"1"}');
  expect(() => registry.get("123e4567-e89b-42d3-a456-426614174000")).toThrow();
});

test("a closed panel keeps the row while an unfinished job references it, and the cleanup deletes it only after the last reference is gone", async () => {
  registry.register(source, fingerprint);
  const pending = job("pending");
  await store.create(pending);
  registry.release("123e4567-e89b-42d3-a456-426614174000");
  clock = T0 + 30 * DAY;
  expect(await registry.purge()).toBe(0);
  expect(rowCount()).toBe(1);
  // The job completes: its reference is released now, the 7 days count from this moment.
  await store.update(pending.id, { state: "completed" }, "pending");
  await registry.releaseForJob({ ...pending, state: "completed" });
  clock = T0 + 30 * DAY + 6 * DAY;
  expect(await registry.purge()).toBe(0);
  clock = T0 + 30 * DAY + 7 * DAY + 1000;
  expect(await registry.purge()).toBe(1);
  expect(rowCount()).toBe(0);
});

test("counts pending, running, awaiting_decision, interrupted, cancel_requested and unknown jobs as references", async () => {
  registry.register(source, fingerprint);
  const states = ["pending", "running", "awaiting_decision", "interrupted", "cancel_requested", "unknown"] as const;
  for (const [index, state] of states.entries()) {
    const id = `323e4567-e89b-42d3-a456-42661417400${index}`;
    await store.create(job(state, ARCHIVE, id));
    clock = T0 + 100 * DAY;
    expect(await registry.purge(), state).toBe(0);
    await store.update(id, { state: "completed" }, state);
  }
  expect(rowCount()).toBe(1);
});

test("completed, failed and cancelled jobs are not references", async () => {
  registry.register(source, fingerprint);
  await store.create(job("completed", ARCHIVE, "323e4567-e89b-42d3-a456-426614174001"));
  await store.create(job("failed", ARCHIVE, "323e4567-e89b-42d3-a456-426614174002"));
  await store.create(job("cancelled", ARCHIVE, "323e4567-e89b-42d3-a456-426614174003"));
  clock = T0 + 7 * DAY + 1000;
  expect(await registry.purge()).toBe(1);
});

test("a job on another archive does not hold this one", async () => {
  registry.register(source, fingerprint);
  await store.create(job("pending", "archive:223e4567-e89b-42d3-a456-426614174000"));
  clock = T0 + 7 * DAY + 1000;
  expect(await registry.purge()).toBe(1);
});

test("a panel closed with no jobs keeps the row until seven days after closing", async () => {
  registry.register(source, fingerprint);
  clock = T0 + 3 * DAY;
  registry.release("123e4567-e89b-42d3-a456-426614174000");
  clock = T0 + 3 * DAY + 6 * DAY;
  expect(await registry.purge()).toBe(0);
  clock = T0 + 3 * DAY + 7 * DAY + 1000;
  expect(await registry.purge()).toBe(1);
});
