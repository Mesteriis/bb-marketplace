import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createArchiveDirs, type ProcessStart } from "./archive-dirs.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "commander-dirs-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (path: string) => lstatSync(path).mode & 0o777;
const starts = (table: Record<number, ProcessStart>): ((pid: number) => Promise<ProcessStart>) => async (pid) => table[pid] ?? "gone";
const make = (readStart: (pid: number) => Promise<ProcessStart>, pid = 100, installId = "inst1") =>
  createArchiveDirs({ tmpdir: tmp, installId, pid, readStart, uid: process.getuid!() });

test("creates a private install directory and a private run directory with a lock holding pid and start time", async () => {
  const dirs = make(starts({ 100: "Fri Nov 27 12:00:00 2026" }));
  await dirs.init();
  const base = join(tmp, "commander-archives-inst1");
  expect(mode(base)).toBe(0o700);
  expect(mode(dirs.runDir)).toBe(0o700);
  expect(dirs.runDir.startsWith(base + "/")).toBe(true);
  const lock = join(dirs.runDir, "lock");
  expect(mode(lock)).toBe(0o600);
  expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({ pid: 100, startedAt: "Fri Nov 27 12:00:00 2026" });
});

test("a copy directory is private and lives inside the run directory", async () => {
  const dirs = make(starts({ 100: "t" }));
  await dirs.init();
  const copy = await dirs.newCopyDir("123e4567-e89b-42d3-a456-426614174000");
  expect(copy.startsWith(dirs.runDir + "/")).toBe(true);
  expect(mode(copy)).toBe(0o700);
});

function sibling(name: string, lock: unknown | null) {
  const dir = join(tmp, "commander-archives-inst1", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "payload"), "x");
  if (lock !== null) writeFileSync(join(dir, "lock"), typeof lock === "string" ? lock : JSON.stringify(lock));
  return dir;
}

test("sweeps only run directories whose lock owner is gone and keeps an active neighbour of the same user", async () => {
  const dead = sibling("run-dead", { pid: 200, startedAt: "A" });
  const alive = sibling("run-alive", { pid: 300, startedAt: "B" });
  const reused = sibling("run-reused", { pid: 400, startedAt: "OLD" });
  const dirs = make(starts({ 100: "ME", 300: "B", 400: "NEW" }));
  await dirs.init();
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(alive)).toBe(true);
  expect(existsSync(reused)).toBe(false);
  expect(existsSync(dirs.runDir)).toBe(true);
});

test("leaves a run directory without a readable lock alone", async () => {
  const none = sibling("run-nolock", null);
  const broken = sibling("run-broken", "{not json");
  await make(starts({ 100: "ME" })).init();
  expect(existsSync(none)).toBe(true);
  expect(existsSync(broken)).toBe(true);
});

test("deletes nothing when the process list cannot be read", async () => {
  const one = sibling("run-one", { pid: 200, startedAt: "A" });
  const two = sibling("run-two", { pid: 201, startedAt: "B" });
  await make(async () => null).init();
  expect(existsSync(one)).toBe(true);
  expect(existsSync(two)).toBe(true);
});

test("never touches other install directories, other temp entries or symlinked run directories", async () => {
  const other = join(tmp, "commander-archives-other", "run-x");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "lock"), JSON.stringify({ pid: 200, startedAt: "A" }));
  const stranger = join(tmp, "unrelated");
  mkdirSync(stranger);
  const outside = join(tmp, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "lock"), JSON.stringify({ pid: 200, startedAt: "A" }));
  mkdirSync(join(tmp, "commander-archives-inst1"), { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(tmp, "commander-archives-inst1", "run-link"));
  await make(starts({ 100: "ME" })).init();
  expect(existsSync(other)).toBe(true);
  expect(existsSync(stranger)).toBe(true);
  expect(readdirSync(outside)).toEqual(["lock"]);
});

test("refuses to use an install directory owned by someone else or open to the group", async () => {
  const base = join(tmp, "commander-archives-inst1");
  mkdirSync(base, { mode: 0o755 });
  await expect(make(starts({ 100: "ME" })).init()).rejects.toMatchObject({ code: "internal" });
});

test("dispose removes this run's directory", async () => {
  const dirs = make(starts({ 100: "ME" }));
  await dirs.init();
  await dirs.dispose();
  expect(existsSync(dirs.runDir)).toBe(false);
});

test("a lock written while the process list was unreadable is dead only when its process is gone", async () => {
  const live = sibling("run-live", { pid: 300, startedAt: "unknown" });
  const gone = sibling("run-gone", { pid: 301, startedAt: "unknown" });
  await make(starts({ 100: "ME", 300: "ANY" })).init();
  expect(existsSync(live)).toBe(true);
  expect(existsSync(gone)).toBe(false);
});
