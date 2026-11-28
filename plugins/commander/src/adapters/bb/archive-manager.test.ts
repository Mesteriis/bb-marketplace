import Database from "better-sqlite3";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import type { ResourceRef } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createArchiveDirs } from "./archive-dirs.ts";
import { createArchiveManager, type HelperLike } from "./archive-manager.ts";
import { createArchiveRegistry } from "./archive-registry.ts";
import { MIGRATIONS } from "./migrations.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const signal = new AbortController().signal;
const ref: ResourceRef = { endpoint: "host:abc", path: parsePosix("/data/a.zip") };
const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const b64 = (s: string) => Buffer.from(s).toString("base64");

let tmp: string;
let db: Database.Database;
let source: FakeProvider;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "commander-manager-")));
  db = new Database(join(tmp, "db.sqlite"));
  db.transaction(() => { for (const sql of MIGRATIONS) db.exec(sql); })();
  source = new FakeProvider("host:abc");
  source.put(ref.path, bytes, "5");
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

class FakeHelper implements HelperLike {
  requests: Array<Record<string, unknown>> = [];
  closed = false;
  failNext: CommanderError | null = null;
  async start() { return { rlimitAs: "not_enforced" as const }; }
  async request(body: Record<string, unknown> & { t: string }) {
    this.requests.push(body);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (body.t === "open") return { json: { t: "ok", req: 1, entries: 2, encrypted: false }, data: [] };
    return { json: { t: "ok", req: 1, entries: [], cursor: null }, data: [] };
  }
  async close() { this.closed = true; }
}

async function make(over: { maxArchiveFileBytes?: number; freeBytes?: bigint; now?: () => Date } = {}) {
  const dirs = createArchiveDirs({ tmpdir: tmp, installId: "i", pid: process.pid, uid: process.getuid!(), readStart: async () => "ME" });
  await dirs.init();
  const registry = createArchiveRegistry({ db, jobs: new MemoryJobStore(), uuid: () => ID });
  const helpers: FakeHelper[] = [];
  const manager = createArchiveManager({
    registry, dirs, sourceProvider: () => source,
    createHelper: () => { const h = new FakeHelper(); helpers.push(h); return h; },
    maxArchiveFileBytes: over.maxArchiveFileBytes ?? 10 * 2 ** 30,
    freeBytes: async () => over.freeBytes ?? 10n * 2n ** 40n,
    now: over.now ?? (() => new Date()),
    uuid: () => ID,
  });
  return { manager, dirs, registry, helpers };
}

test("copies even a local archive into a private directory and opens it by root and segments with the copy's own fingerprint", async () => {
  const { manager, dirs, registry, helpers } = await make();
  const opened = await manager.open(ref, signal);
  expect(opened).toMatchObject({ archiveId: ID, endpoint: "archive:" + ID });
  const copyDir = join(dirs.runDir, ID);
  expect(lstatSync(copyDir).mode & 0o777).toBe(0o700);
  const copy = join(copyDir, "archive.bin");
  expect(lstatSync(copy).mode & 0o777).toBe(0o600);
  expect(new Uint8Array(readFileSync(copy))).toEqual(bytes);
  const stat = lstatSync(copy, { bigint: true });
  const open = helpers[0]!.requests.find((r) => r.t === "open")!;
  expect(open).toMatchObject({
    rootB64: b64(copyDir), segmentsB64: [b64("archive.bin")], format: "auto",
    limits: { maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 },
    expect: { size: "1000", mtimeNs: String(stat.mtimeNs), dev: String(stat.dev), ino: String(stat.ino) },
  });
  expect(registry.get(ID)).toEqual({ source: ref, fingerprint: { size: "1000", mtimeNs: "5" } });
});

test("a changed source file is changed_since_plan on the next read of the archive and the helper is not asked", async () => {
  const { manager, helpers } = await make();
  await manager.open(ref, signal);
  const provider = manager.provider(ID);
  source.put(ref.path, bytes, "6");
  const before = helpers[0]!.requests.length;
  await expect(provider.list(parsePosix("/"), { cursor: null, limit: 10 }, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(helpers[0]!.requests.length).toBe(before);
});

test("refuses a source larger than the archive file limit and leaves no copy", async () => {
  const { manager, dirs } = await make({ maxArchiveFileBytes: 999 });
  await expect(manager.open(ref, signal)).rejects.toMatchObject({ code: "limit_exceeded", reason: "total_bytes" });
  expect(existsSync(join(dirs.runDir, ID))).toBe(false);
});

test("refuses when the disk cannot hold the copy with the reserve", async () => {
  const { manager, dirs } = await make({ freeBytes: 1000n + 64n * 1024n * 1024n - 1n });
  await expect(manager.open(ref, signal)).rejects.toMatchObject({ code: "no_space" });
  expect(existsSync(join(dirs.runDir, ID))).toBe(false);
});

test("a source that changes while it is copied fails and removes the copy", async () => {
  const { manager, dirs } = await make();
  vi.spyOn(source, "read").mockImplementationOnce(async () => {
    source.put(ref.path, bytes, "9");
    return bytes.slice(0, 500);
  });
  await expect(manager.open(ref, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(existsSync(join(dirs.runDir, ID))).toBe(false);
});

test("a helper that cannot open the archive leaves no copy and no registry row", async () => {
  const { manager, dirs, registry } = await make();
  const helper = new FakeHelper();
  helper.failNext = new CommanderError("invalid_archive", "dup", false, "duplicate_name");
  const dirsRun = dirs.runDir;
  const again = createArchiveManager({
    registry, dirs, sourceProvider: () => source, createHelper: () => helper,
    maxArchiveFileBytes: 2 ** 30, freeBytes: async () => 2n ** 40n, now: () => new Date(), uuid: () => ID,
  });
  void manager;
  await expect(again.open(ref, signal)).rejects.toMatchObject({ code: "invalid_archive", reason: "duplicate_name" });
  expect(readdirSync(dirsRun).filter((n) => n !== "lock")).toEqual([]);
  expect(registry.get(ID)).toBeNull();
  expect(helper.closed).toBe(true);
});

test("close removes the copy, stops the helper and starts the retention clock", async () => {
  const { manager, dirs, helpers, registry } = await make();
  await manager.open(ref, signal);
  const release = vi.spyOn(registry, "release");
  await manager.close(ID);
  expect(helpers[0]!.closed).toBe(true);
  expect(existsSync(join(dirs.runDir, ID))).toBe(false);
  expect(release).toHaveBeenCalledWith(ID);
  expect(() => manager.provider(ID)).toThrow();
});

test("after a helper crash the next request restarts it, and a fourth restart within five minutes is refused", async () => {
  let clock = Date.UTC(2026, 10, 27);
  const { manager, helpers } = await make({ now: () => new Date(clock) });
  await manager.open(ref, signal);
  const provider = manager.provider(ID);
  const crash = () => new CommanderError("internal", "stopped", true, "helper_crashed");
  const list = () => provider.list(parsePosix("/"), { cursor: null, limit: 10 }, signal);
  for (let restart = 1; restart <= 3; restart++) {
    helpers.at(-1)!.failNext = crash();
    await expect(list()).rejects.toMatchObject({ reason: "helper_crashed" });
    await expect(list()).resolves.toBeDefined();
    expect(helpers).toHaveLength(1 + restart);
    clock += 60_000;
  }
  helpers.at(-1)!.failNext = crash();
  await expect(list()).rejects.toMatchObject({ reason: "helper_crashed" });
  await expect(list()).rejects.toMatchObject({ code: "unsupported", reason: "archives_unavailable" });
  expect(helpers).toHaveLength(4);
  clock += 5 * 60_000;
  await manager.close(ID);
});

test("an archive known to the registry is opened again after a plugin restart", async () => {
  const first = await make();
  await first.manager.open(ref, signal);
  // The plugin restarts: the old process's work directory is gone, the registry row stays.
  await first.manager.close(ID);
  const second = createArchiveManager({
    registry: first.registry, dirs: first.dirs, sourceProvider: () => source,
    createHelper: () => new FakeHelper(), maxArchiveFileBytes: 2 ** 30, freeBytes: async () => 2n ** 40n,
    now: () => new Date(), uuid: () => "223e4567-e89b-42d3-a456-426614174000",
  });
  expect(() => second.provider(ID)).toThrow();
  await second.ensure(ID, signal);
  expect(second.provider(ID).endpoint.id).toBe("archive:" + ID);
  await expect(second.ensure("323e4567-e89b-42d3-a456-426614174000", signal)).rejects.toMatchObject({ code: "not_found" });
});
