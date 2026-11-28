import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobRunner } from "../../core/job-runner.ts";
import type { JobState } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { buildPlan } from "../../core/planner.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { ArchiveHelperClient, type HelperProcess } from "./archive-helper.ts";
import { checkHelperIntegrity } from "./archive-helper-integrity.ts";
import { createArchiveDirs } from "./archive-dirs.ts";
import { createArchiveManager } from "./archive-manager.ts";
import { createArchiveRegistry } from "./archive-registry.ts";
import { MIGRATIONS } from "./migrations.ts";
import { ustar } from "./testing/tar-fixture.ts";
import { storedZip } from "./testing/zip-fixture.ts";

// The whole extraction path against the real helper: archive on a provider -> private copy -> helper ->
// ArchiveProvider -> plan (copy from archive:) -> JobRunner -> target provider.
const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/commander-archive-helper");
const runnable = process.platform === "darwin" && process.arch === "arm64" && existsSync(BIN);
const ID = "123e4567-e89b-42d3-a456-426614174000";
const ARCHIVE = ("archive:" + ID) as `archive:${string}`;
const signal = new AbortController().signal;
let tmp: string;
let db: Database.Database;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "commander-extract-")));
  db = new Database(join(tmp, "db.sqlite"));
  db.transaction(() => { for (const sql of MIGRATIONS) db.exec(sql); })();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function rig(entries: Parameters<typeof storedZip>[0], archive?: { bytes: Uint8Array; name: string }) {
  const source = new FakeProvider("host:src");
  source.put(parsePosix("/in/" + (archive?.name ?? "a.zip")), archive?.bytes ?? storedZip(entries), "5");
  const target = new FakeProvider("host:dst");
  await target.mkdir(parsePosix("/out"), signal);
  const dirs = createArchiveDirs({ tmpdir: tmp, installId: "i", pid: process.pid, uid: process.getuid!(), readStart: async () => "ME" });
  await dirs.init();
  const registry = createArchiveRegistry({ db, jobs: new MemoryJobStore(), uuid: () => ID });
  const manager = createArchiveManager({
    registry, dirs, sourceProvider: () => source,
    createHelper: () => new ArchiveHelperClient({
      binPath: BIN, helperVersion: "0.1.0", platform: process.platform, arch: process.arch,
      spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperProcess,
      integrity: checkHelperIntegrity, requestTimeoutMs: 20_000,
    }),
    freeBytes: async () => 2n ** 40n, uuid: () => ID,
  });
  await manager.open({ endpoint: "host:src", path: parsePosix("/in/" + (archive?.name ?? "a.zip")) }, signal, { owner: true });
  const provider = (endpoint: string) => (endpoint === ARCHIVE ? manager.provider(ID) : target);
  const store = new MemoryJobStore();
  const checkpoints = vi.spyOn(store, "checkpoint");
  let n = 0;
  const deps = {
    provider: provider as never, now: () => new Date("2026-11-27T00:00:00.000Z"),
    uuid: () => "323e4567-e89b-42d3-a456-" + String(++n).padStart(12, "0"),
  };
  const runner = new JobRunner({ ...deps, store, chunkBytes: 1024 * 1024, retryDelay: async () => {}, onEvent: () => {} });
  const at = (id: string, state: JobState) => vi.waitFor(async () => {
    const job = (await store.get(id))!;
    expect(job.state).toBe(state);
    return job;
  }, { timeout: 15_000 });
  return { manager, target, runner, deps, at, checkpoints, store };
}

describe.skipIf(!runnable)("extracting from an archive", () => {
  it("copies the files of a ZIP into the target, with commitIntent saved before every commit", async () => {
    const { manager, target, runner, deps, at, checkpoints } = await rig([
      { name: "a.txt", data: "hello" }, { name: "docs/", data: "" }, { name: "docs/b.txt", data: "second" }, { name: "empty.txt" },
    ]);
    const plan = await buildPlan({
      kind: "copy", initiator: { kind: "owner" }, sources: [
        { endpoint: ARCHIVE, path: parsePosix("/a.txt") }, { endpoint: ARCHIVE, path: parsePosix("/docs") }, { endpoint: ARCHIVE, path: parsePosix("/empty.txt") },
      ],
      targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: "ask", verify: "size",
    }, { ...deps, protectedPathsFor: () => [], limits: { maxItems: 1000, maxDepth: 16 } } as never, signal);
    const { id } = await runner.submit(plan);
    await at(id, "completed");
    expect(new TextDecoder().decode(target.contents(parsePosix("/out/a.txt"))!)).toBe("hello");
    expect(new TextDecoder().decode(target.contents(parsePosix("/out/docs/b.txt"))!)).toBe("second");
    expect(target.contents(parsePosix("/out/empty.txt"))).toEqual(new Uint8Array(0));
    // SHA-256 of "hello" (FIPS 180-2 style vector from the standard library of known digests).
    const intents = checkpoints.mock.calls.map(([c]) => c.commitIntent).filter(Boolean);
    expect(intents.map((i) => i!.size).sort()).toEqual(["0", "5", "6"]);
    expect(intents.find((i) => i!.size === "5")!.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(target.temporaryCount).toBe(0);
    await manager.close(ID);
  });

  it("a ZIP entry with a traversal name never reaches the target and never appears as a file", async () => {
    const { manager, target, runner, deps, store } = await rig([{ name: "../evil.txt", data: "x" }, { name: "ok.txt", data: "fine" }]);
    const listing = await manager.provider(ID).list(parsePosix("/"), { cursor: null, limit: 100 }, signal);
    expect(listing.entries.filter((e) => e.kind === "file").map((e) => e.name)).toEqual([{ t: "ok.txt" }]);
    const plan = await buildPlan({
      kind: "copy", initiator: { kind: "owner" }, sources: listing.entries.map((e) => ({ endpoint: ARCHIVE, path: { segments: [e.name] } })),
      targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: "ask", verify: "size",
    }, { ...deps, protectedPathsFor: () => [], limits: { maxItems: 1000, maxDepth: 16 } } as never, signal);
    const { id } = await runner.submit(plan);
    await vi.waitFor(async () => expect((await store.get(id))?.state).toBe("completed"), { timeout: 15_000 });
    expect(target.contents(parsePosix("/out/ok.txt"))).toEqual(new TextEncoder().encode("fine"));
    expect(target.contents(parsePosix("/evil.txt"))).toBeNull();
    expect(target.contents(parsePosix("/out/evil.txt"))).toBeNull();
    expect((await store.get(id))!.items.map((i) => i.outcome)).toEqual(["done"]);
    await manager.close(ID);
  });

  // Decision 5 of S14: a link is never extracted. Inside the root it is link_not_supported, outside it link_escapes;
  // the pair travels as literals in the item of the job.
  const SYMLINK = 0o120777;
  const formats = {
    zip: (link: string) => ({ name: "a.zip", bytes: storedZip([{ name: "ok.txt", data: "fine" }, { name: "ln", data: link, mode: SYMLINK }]) }),
    tar: (link: string) => ({ name: "a.tar", bytes: ustar([{ name: "ok.txt", data: "fine" }, { name: "ln", type: "2", link }]) }),
  };
  async function failsWith(archive: { name: string; bytes: Uint8Array }, entry: string, reason: string) {
    const { manager, target, runner, deps, store } = await rig([], archive);
    const plan = await buildPlan({
      kind: "copy", initiator: { kind: "owner" }, sources: [{ endpoint: ARCHIVE, path: parsePosix(entry) }],
      targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: "ask", verify: "size",
    }, { ...deps, protectedPathsFor: () => [], limits: { maxItems: 1000, maxDepth: 16 } } as never, signal);
    const { id } = await runner.submit(plan);
    await vi.waitFor(async () => expect(["failed", "completed"]).toContain((await store.get(id))?.state), { timeout: 15_000 });
    const job = (await store.get(id))!;
    expect(job.items[0]).toEqual({ outcome: "failed", error: "Links in archives are not extracted", code: "unsupported", reason });
    expect(job.error).toMatchObject({ code: "unsupported", reason });
    expect(target.contents(parsePosix("/out" + entry.slice(entry.lastIndexOf("/"))))).toBeNull();
    expect((await target.list(parsePosix("/out"), { cursor: null, limit: 100 }, signal)).entries).toEqual([]);
    expect(target.temporaryCount).toBe(0);
    await manager.close(ID);
  }
  for (const [format, build] of Object.entries(formats)) {
    for (const [where, link, reason] of [["inside the root", "ok.txt", "link_not_supported"], ["outside the root", "../../etc/passwd", "link_escapes"]] as const) {
      it("a " + format.toUpperCase() + " symlink " + where + " fails its item with unsupported/" + reason + " and writes nothing", () =>
        failsWith(build(link), "/ln", reason));
    }
  }
  const tar = (link: string) => ({ name: "a.tar", bytes: ustar([{ name: "d/", type: "5" }, { name: "d/l", type: "1", link }]) });
  it("a TAR hardlink d/l -> ../x counts from the archive root: link_escapes", () => failsWith(tar("../x"), "/d/l", "link_escapes"));
  it("a TAR hardlink d/l -> x stays inside the root: link_not_supported", () => failsWith(tar("x"), "/d/l", "link_not_supported"));
  const zip = (link: string) => ({ name: "a.zip", bytes: storedZip([{ name: "ln", data: link, mode: SYMLINK }]) });
  it("a ZIP symlink target of 4096 bytes inside the root is link_not_supported", () => failsWith(zip("a".repeat(4096)), "/ln", "link_not_supported"));
  it("a ZIP symlink target of 4097 bytes cannot be classified: link_escapes", () => failsWith(zip("a".repeat(4097)), "/ln", "link_escapes"));
  it("a ZIP symlink target over 4096 bytes starting with a slash is link_escapes", () => failsWith(zip("/" + "a".repeat(4096)), "/ln", "link_escapes"));
});
