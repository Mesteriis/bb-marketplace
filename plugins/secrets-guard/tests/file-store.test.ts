import { unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStore, StoreUnavailable, type LogEvent } from "../src/adapters/bb/file-store.ts";
import type { GuardState } from "../src/core/state.ts";

const OPEN_A: LogEvent = { event: "open", scope: "thread", root: "a", until: 1600 };
const openA = (state: GuardState): GuardState => ({
  ...state,
  threads: { ...state.threads, a: { until: 1600, root: "a", tree: false } },
});

let dir: string;
let file: string;
let lock: string;
let journal: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "guard-store-"));
  file = join(dir, "marker.json");
  lock = join(dir, "marker.json.lock");
  journal = join(dir, "marker.log");
});

afterEach(async () => {
  await chmod(dir, 0o755);
  await rm(dir, { recursive: true, force: true });
});

function store(stateFile: string | null = file) {
  return createFileStore({ stateFile, now: () => 1000, lockWaitMs: 150 });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StoreUnavailable) return error.reason;
    throw error;
  }
  return "resolved";
}

describe("without a marker location", () => {
  it("reads as closed and is not configured", async () => {
    expect(store(null).configured).toBe(false);
    expect(await store(null).read()).toEqual({ threads: {} });
  });
  it("refuses to write", async () => {
    expect(await reasonOf(store(null).update(openA, OPEN_A))).toBe("not_configured");
  });
  it("treats a blank or relative path as not configured", async () => {
    expect(store("   ").configured).toBe(false);
    expect(store("marker.json").configured).toBe(false);
    expect(await reasonOf(store("marker.json").update(openA, OPEN_A))).toBe("not_configured");
  });
});

describe("reading", () => {
  it("reads a missing file as closed", async () => {
    expect(store().configured).toBe(true);
    expect(await store().read()).toEqual({ threads: {} });
  });
  it("reads a file that is not JSON as closed", async () => {
    await writeFile(file, "not json");
    expect(await store().read()).toEqual({ threads: {} });
  });
  it("reads format 2", async () => {
    await writeFile(file, '{"until":5000,"threads":{"b":{"until":4000,"root":"b","tree":false}}}');
    expect(await store().read()).toEqual({
      until: 5000,
      threads: { b: { until: 4000, root: "b", tree: false } },
    });
  });
});

describe("writing", () => {
  it("creates the file and returns the new state", async () => {
    expect(await store().update(openA, OPEN_A)).toEqual({
      threads: { a: { until: 1600, root: "a", tree: false } },
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      threads: { a: { until: 1600, root: "a", tree: false } },
    });
  });
  it("keeps top-level fields the plugin does not know", async () => {
    await writeFile(
      file,
      '{"until":5000,"note":"keep","version":2,"threads":{"b":{"until":4000,"root":"b","tree":false}}}',
    );
    await store().update(openA, OPEN_A);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      until: 5000,
      note: "keep",
      version: 2,
      threads: {
        a: { until: 1600, root: "a", tree: false },
        b: { until: 4000, root: "b", tree: false },
      },
    });
  });
  it("does not carry a removed global deadline back from the old file", async () => {
    await writeFile(file, '{"until":5000,"note":"keep","threads":{}}');
    await store().update(() => ({ threads: {} }), { event: "close", scope: "global", root: null, until: null });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ note: "keep", threads: {} });
  });
  it("drops expired entries on write", async () => {
    await writeFile(file, '{"until":999,"threads":{"old":{"until":1000,"root":"old","tree":false}}}');
    await store().update(openA, OPEN_A);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      threads: { a: { until: 1600, root: "a", tree: false } },
    });
  });
  it("overwrites a file that is not JSON", async () => {
    await writeFile(file, "not json");
    await store().update(openA, OPEN_A);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      threads: { a: { until: 1600, root: "a", tree: false } },
    });
  });
  it("appends exactly one journal line marked as the plugin's", async () => {
    await writeFile(journal, '{"at":1,"event":"open","by":"owner"}\n');
    await store().update(openA, OPEN_A);
    const lines = (await readFile(journal, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"at":1,"event":"open","by":"owner"}');
    expect(JSON.parse(lines[1]!)).toEqual({
      at: 1000,
      event: "open",
      scope: "thread",
      root: "a",
      until: 1600,
      by: "plugin",
    });
  });
  it("builds the journal line from the state it read under the lock", async () => {
    await writeFile(file, '{"until":5000,"threads":{}}');
    await store().update(
      () => ({ threads: {} }),
      (before) => ({ event: "close", scope: "global", root: null, until: before.until ?? null }),
    );
    expect(JSON.parse((await readFile(journal, "utf8")).trimEnd())).toEqual({
      at: 1000,
      event: "close",
      scope: "global",
      root: null,
      until: 5000,
      by: "plugin",
    });
  });
  it("leaves no temporary files or lock behind", async () => {
    await store().update(openA, OPEN_A);
    expect((await readdir(dir)).sort()).toEqual(["marker.json", "marker.log"]);
  });
  it("writes and logs nothing when the change returns its argument", async () => {
    await writeFile(file, '{"threads":{}}');
    expect(await store().update((state) => state, { event: "resync", scope: "tree", root: "a", until: 1600 })).toEqual({
      threads: {},
    });
    expect(await readFile(file, "utf8")).toBe('{"threads":{}}');
    expect((await readdir(dir)).sort()).toEqual(["marker.json"]);
  });
  it("releases the lock when the change throws", async () => {
    await expect(
      store().update(() => {
        throw new Error("boom");
      }, OPEN_A),
    ).rejects.toThrow("boom");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("the lock", () => {
  it("gives up on a fresh lock and leaves the file alone", async () => {
    await writeFile(file, '{"threads":{}}');
    await writeFile(lock, "");
    expect(await reasonOf(store().update(openA, OPEN_A))).toBe("locked");
    expect(await readFile(file, "utf8")).toBe('{"threads":{}}');
    expect((await readdir(dir)).sort()).toEqual(["marker.json", "marker.json.lock"]);
  });
  it("removes a lock older than 30 seconds and writes", async () => {
    await writeFile(lock, "");
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
    await store().update(openA, OPEN_A);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      threads: { a: { until: 1600, root: "a", tree: false } },
    });
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps a lock that is 29 seconds old", async () => {
    await writeFile(lock, "");
    const recent = new Date(Date.now() - 29_000);
    await utimes(lock, recent, recent);
    expect(await reasonOf(store().update(openA, OPEN_A))).toBe("locked");
  });
});

describe("a lock taken over by another writer", () => {
  it("does not write and leaves the other writer's lock in place", async () => {
    await writeFile(file, '{"threads":{}}');
    const stolen = store().update((state) => {
      unlinkSync(lock);
      writeFileSync(lock, "another writer");
      return openA(state);
    }, OPEN_A);
    expect(await reasonOf(stolen)).toBe("locked");
    expect(await readFile(file, "utf8")).toBe('{"threads":{}}');
    expect(await readFile(lock, "utf8")).toBe("another writer");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a marker that cannot be read", () => {
  it("refuses to write instead of treating it as empty", async () => {
    await mkdir(file);
    expect(await reasonOf(store().update((state) => state, OPEN_A))).toBe("not_writable");
    expect(await store().read()).toEqual({ threads: {} });
  });
});

describe("a journal that cannot be written", () => {
  const CLOSE: LogEvent = { event: "close", scope: "global", root: null, until: null };
  it("refuses to open", async () => {
    await mkdir(journal);
    expect(await reasonOf(store().update(openA, OPEN_A))).toBe("not_writable");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("still closes: revoking does not depend on the journal", async () => {
    await writeFile(file, '{"until":5000,"threads":{}}');
    await mkdir(journal);
    expect(await store().update(() => ({ threads: {} }), CLOSE)).toEqual({ threads: {} });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ threads: {} });
  });
});

describe("writable", () => {
  it("is true for a directory that exists and can be written", async () => {
    expect(await store().writable()).toBe(true);
  });
  it("is false without a location, for a missing directory and for a read-only one", async () => {
    expect(await store(null).writable()).toBe(false);
    expect(await store(join(dir, "missing", "marker.json")).writable()).toBe(false);
    await chmod(dir, 0o555);
    expect(await store().writable()).toBe(false);
  });
});

describe("a directory that cannot be written", () => {
  it("reports not_writable and leaves the guard closed", async () => {
    await chmod(dir, 0o555);
    expect(await reasonOf(store().update(openA, OPEN_A))).toBe("not_writable");
    expect(await store().read()).toEqual({ threads: {} });
  });
  it("reports not_writable for a directory that does not exist", async () => {
    expect(await reasonOf(store(join(dir, "missing", "marker.json")).update(openA, OPEN_A))).toBe("not_writable");
  });
});
