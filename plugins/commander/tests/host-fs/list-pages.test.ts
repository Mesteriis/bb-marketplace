import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHostFs } from "../../src/adapters/bb/host-fs/index.ts";
import { EDIT_DIRECTORY } from "../../src/adapters/bb/edit-files.ts";
import { fixturePath } from "./fixtures.ts";

// Counts directory-entry reads of the host worker, to tell one pass over a directory from a pass per page.
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    opendir: async (...args: Parameters<typeof real.opendir>) => {
      const dir = await real.opendir(...args);
      const read = dir.read.bind(dir) as () => Promise<unknown>;
      (dir as unknown as { read: () => Promise<unknown> }).read = async () => { reads.count++; return read(); };
      return dir;
    },
  };
});

let root: string;
let fs: ReturnType<typeof createHostFs>;
const ctx = { signal: new AbortController().signal };
const at = (name = "") => fixturePath(join(root, name));
const names = (page: { entries: { name: unknown }[] }) => page.entries.map((entry) => (entry.name as { t: string }).t);

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "commander-list-"));
  fs = createHostFs();
});

afterEach(async () => {
  await fs.dispose();
  await rm(root, { recursive: true, force: true });
});

async function fill(dir: string, count: number) {
  await mkdir(dir, { recursive: true });
  for (let first = 0; first < count; first += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - first) }, (_, offset) =>
      writeFile(join(dir, `f${String(first + offset).padStart(6, "0")}`), "x")));
  }
}

async function listAll(path: ReturnType<typeof at>, limit: number, context: object = ctx) {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { entries: { name: unknown }[]; cursor: string | null } =
      await fs.handlers.list({ path, cursor, limit }, context as typeof ctx);
    seen.push(...names(page));
    cursor = page.cursor;
  } while (cursor);
  return seen;
}

it("lists every entry exactly once across pages, with the entry read ahead of a full page kept", async () => {
  await fill(root, 25);
  for (const limit of [1, 7, 25, 100]) {
    const all = await listAll(at(), limit);
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(25);
  }
});

it("serves the same cursor again with the same page, after the first reply used it", async () => {
  await fill(root, 30);
  const first = await fs.handlers.list({ path: at(), cursor: null, limit: 10 }, ctx);
  const a = await fs.handlers.list({ path: at(), cursor: first.cursor, limit: 10 }, ctx);
  const b = await fs.handlers.list({ path: at(), cursor: first.cursor, limit: 10 }, ctx);
  expect(names(b)).toEqual(names(a));
  expect(names(a)).toHaveLength(10);
  const third = await fs.handlers.list({ path: at(), cursor: a.cursor, limit: 10 }, ctx);
  expect([...names(first), ...names(a), ...names(third)]).toHaveLength(30);
  expect(new Set([...names(first), ...names(a), ...names(third)]).size).toBe(30);
});

it("keeps the page and cursor count in step when the private editor directory is hidden in the middle", async () => {
  const data = join(root, "data");
  await fill(data, 12);
  await mkdir(join(data, EDIT_DIRECTORY, "s"), { recursive: true });
  const context = { signal: ctx.signal, experimental_paths: { dataDir: data } };
  for (const limit of [1, 5, 50]) {
    const all = await listAll(at("data"), limit, context);
    expect(all).toHaveLength(12);
    expect(all).not.toContain(EDIT_DIRECTORY);
  }
});

it("reads each directory entry about once across all pages, not once per page", async () => {
  await fill(root, 3000);
  reads.count = 0;
  const all = await listAll(at(), 100);
  expect(all).toHaveLength(3000);
  // One pass plus the entry read ahead of each page. Rescanning from the first entry read about 46 000.
  expect(reads.count).toBeGreaterThanOrEqual(3000);
  expect(reads.count).toBeLessThan(3 * 3000);
});
