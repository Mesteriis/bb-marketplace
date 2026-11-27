/// <reference lib="es2024.promise" />

import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHostFs } from "../../src/adapters/bb/host-fs/index.ts";
import { join as joinResource } from "../../src/core/path.ts";
import { fixturePath, windows } from "./fixtures.ts";

let root: string;
let fs: ReturnType<typeof createHostFs>;
const at = (name = "") => fixturePath(join(root, name));
const ctx = { signal: new AbortController().signal };
const nextTempName = () => ({ t: ".target.commander-" + randomUUID() + ".part" });

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "commander-s4-"));
  fs = createHostFs();
});

afterEach(async () => {
  await fs.dispose();
  await rm(root, { recursive: true, force: true });
});

it("lists UTF-8 names with their original bytes", async () => {
  await writeFile(join(root, "Привет.txt"), "");
  await writeFile(join(root, "😀 emoji.bin"), "");
  const page = await fs.handlers.list({ path: at(), cursor: null, limit: 1000 }, ctx);
  expect(page.entries.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([{ t: "Привет.txt" }, { t: "😀 emoji.bin" }]),
  );
});

it.skipIf(process.platform !== "linux")("lists an undecodable byte without replacement", async () => {
  const raw = Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]);
  try {
    await writeFile(raw, "");
    const page = await fs.handlers.list({ path: at(), cursor: null, limit: 1 }, ctx);
    expect(page.entries.map((entry) => entry.name)).toEqual([{ b: "/w==" }]);
  } finally {
    await rm(raw, { force: true });
  }
});

it("pages a directory and rejects its cursor after replacement", async () => {
  await writeFile(join(root, "a"), "");
  await writeFile(join(root, "b"), "");
  const first = await fs.handlers.list({ path: at(), cursor: null, limit: 1 }, ctx);
  expect(first.cursor).not.toBeNull();
  const second = await fs.handlers.list({ path: at(), cursor: first.cursor, limit: 1 }, ctx);
  expect(second.cursor).toBeNull();
  expect([...first.entries, ...second.entries].map((entry) => entry.name))
    .toEqual(expect.arrayContaining([{ t: "a" }, { t: "b" }]));
  await mkdir(join(root, "another"));
  await expect(fs.handlers.list({ path: at("another"), cursor: first.cursor, limit: 1 }, ctx))
    .rejects.toMatchObject({ code: "changed_since_plan" });
});

it("reports a sparse 5 GiB file in decimal and reads at large offsets", async () => {
  await writeFile(join(root, "large"), "");
  await truncate(join(root, "large"), 5368709120);
  expect(await fs.handlers.stat({ path: at("large") }, ctx)).toMatchObject({ size: "5368709120" });
  expect(await fs.handlers.read({ path: at("large"), offset: "5368709119", length: 4, expect: null }, ctx))
    .toEqual({ b64: "AA==" });
});

it("rejects a stale read fingerprint", async () => {
  await writeFile(join(root, "source"), "new");
  await expect(fs.handlers.read({
    path: at("source"), offset: "0", length: 3, expect: { size: "1", mtimeNs: "0" },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
});

async function stage(target = at("target")) {
  const opened = await fs.handlers.writeOpen({ target, tempName: nextTempName() }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "2", b64: "AwQ=" }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "0", b64: "AQI=" }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "4", b64: "/w==" }, ctx);
  return opened;
}

it("commits three chunks at their offsets and publishes mode 0644", async () => {
  const mask = windows ? undefined : process.umask(0o022);
  try {
    const { session, tempName } = await stage();
    expect(tempName).toEqual({ t: expect.stringMatching(/^\.target\.commander-.*\.part$/) });
    expect((await readdir(root))).toHaveLength(1);
    await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
      .resolves.toMatchObject({ size: "5" });
    expect(await readFile(join(root, "target"))).toEqual(Buffer.from([1, 2, 3, 4, 255]));
    expect(await readdir(root)).toEqual(["target"]);
    if (!windows) expect((await lstat(join(root, "target"))).mode & 0o777).toBe(0o644);
  } finally {
    if (mask !== undefined) process.umask(mask);
  }
});

it("preserves an existing target and removes staging on abort", async () => {
  await writeFile(join(root, "target"), "original");
  const { session } = await stage();
  await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
    .rejects.toMatchObject({ code: "already_exists" });
  await fs.handlers.writeAbort({ session }, ctx);
  await fs.handlers.writeAbort({ session }, ctx);
  expect(await readdir(root)).toEqual(["target"]);
  expect(await readFile(join(root, "target"), "utf8")).toBe("original");
});

it("rejects replacement when the staged write's target changed", async () => {
  await writeFile(join(root, "target"), "old");
  const old = await fs.handlers.stat({ path: at("target") }, ctx);
  const { session } = await stage();
  await writeFile(join(root, "target"), "intervening update");
  await expect(fs.handlers.writeCommit({
    session, replace: true, expectTarget: { size: old!.size, mtimeNs: old!.mtimeNs },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(join(root, "target"), "utf8")).toBe("intervening update");
});

it("rejects copy when the planned target changed or appeared", async () => {
  await writeFile(join(root, "source"), "copy");
  await writeFile(join(root, "target"), "old");
  const old = await fs.handlers.stat({ path: at("target") }, ctx);
  await writeFile(join(root, "target"), "intervening update");
  for (const expectTarget of [{ size: old!.size, mtimeNs: old!.mtimeNs }, "absent" as const]) {
    await expect(fs.handlers.copyWithin({
      from: at("source"), to: at("target"), replace: true, expectTarget,
    }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
    expect(await readFile(join(root, "target"), "utf8")).toBe("intervening update");
  }
  expect((await readdir(root)).sort()).toEqual(["source", "target"]);
});

it("copies regular files and hashes their bytes on the host", async () => {
  await writeFile(join(root, "source"), "abc");
  await expect(fs.handlers.copyWithin({ from: at("source"), to: at("target"), replace: false }, ctx))
    .resolves.toMatchObject({ size: "3" });
  await expect(fs.handlers.sha256({ path: at("target") }, ctx)).resolves.toEqual({
    hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  await fs.handlers.rename({ from: at("target"), to: at("renamed"), replace: false }, ctx);
  await fs.handlers.remove({ path: at("renamed"), kind: "file" }, ctx);
  expect(await readdir(root)).toEqual(["source"]);
});

it("refuses a symlink introduced after writeOpen", async () => {
  const outside = await mkdtemp(join(await realpath(tmpdir()), "commander-s4-outside-"));
  try {
    const victim = join(outside, "victim");
    await writeFile(victim, "original");
    const { session } = await stage();
    await symlink(victim, join(root, "target"));
    await expect(fs.handlers.writeCommit({ session, replace: true, expectTarget: null }, ctx))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(fs.handlers.read({ path: at("target"), offset: "0", length: 8, expect: null }, ctx))
      .rejects.toMatchObject({ code: "unsupported" });
    expect(await readFile(victim, "utf8")).toBe("original");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("preserves a nonempty directory on remove", async () => {
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "directory", "child"), "keep");
  await expect(fs.handlers.remove({ path: at("directory"), kind: "dir" }, ctx)).rejects.toMatchObject({
    code: "already_exists",
  });
  expect(await readFile(join(root, "directory", "child"), "utf8")).toBe("keep");
});

it.skipIf(windows)("maps a directory with mode 000 to permission_denied", async () => {
  await chmod(root, 0);
  try {
    await expect(fs.handlers.list({ path: at(), cursor: null, limit: 1 }, ctx))
      .rejects.toMatchObject({ code: "permission_denied" });
  } finally {
    await chmod(root, 0o700);
  }
});

it("expires an idle session and deletes its staging file", async () => {
  let expire!: () => Promise<void>;
  const timed = createHostFs({ scheduleExpiry: (callback, delay) => {
    expect(delay).toBe(120_000);
    expire = callback;
    return () => {};
  } });
  try {
    const { session } = await timed.handlers.writeOpen({ target: at("target"), tempName: nextTempName() }, ctx);
    expect(await readdir(root)).toHaveLength(1);
    await expire();
    expect(await readdir(root)).toEqual([]);
    await expect(timed.handlers.writeChunk({ session, offset: "0", b64: "YQ==" }, ctx))
      .rejects.toMatchObject({ code: "not_found" });
  } finally {
    await timed.dispose();
  }
});

it("cleans open staging files on worker disposal", async () => {
  await stage();
  await fs.dispose();
  expect(await readdir(root)).toEqual([]);
});

it("rejects a Windows mkdir target before touching the filesystem", async () => {
  const windows = createHostFs({ platform: "win32" });
  try {
    await expect(windows.handlers.mkdir({ path: at("con.txt") }, ctx))
      .rejects.toMatchObject({ code: "invalid_name" });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await windows.dispose();
  }
});

it("publishes only one replacement for two writers with the same planned target", async () => {
  await writeFile(join(root, "target"), "old");
  const old = await fs.handlers.stat({ path: at("target") }, ctx);
  const staged = [await stage(), await stage()];
  const outcomes = await Promise.allSettled(staged.map(({ session }) => fs.handlers.writeCommit({
    session, replace: true, expectTarget: { size: old!.size, mtimeNs: old!.mtimeNs },
  }, ctx)));
  expect(outcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ size: "5" }) }),
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "changed_since_plan" }) }),
  ]));
});

it("keeps staging private throughout target verification and lets other mutations run", async () => {
  const target = join(root, "target");
  await writeFile(target, "old");
  let temp: string;
  await fs.dispose();
  fs = createHostFs({
    hashTarget: async () => {
      if (!windows) expect((await lstat(temp)).mode & 0o777).toBe(0o600);
      await fs.handlers.mkdir({ path: at("other") }, ctx);
      return "a".repeat(64);
    },
  });
  const { session, tempName } = await stage();
  if (!("t" in tempName)) throw new Error("Expected a text staging name");
  temp = join(root, tempName.t);
  const current = await lstat(target, { bigint: true });
  await expect(fs.handlers.writeCommit({
    session, replace: true, expectTarget: { size: "3", mtimeNs: current.mtimeNs.toString(), sha256: "b".repeat(64) },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  if (!windows) expect((await lstat(temp)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(root, "other"))).isDirectory()).toBe(true);
});

it.skipIf(windows)("preserves the mode of the replaced file", async () => {
  const target = join(root, "target");
  await writeFile(target, "old");
  await chmod(target, 0o750);
  const { session } = await stage();
  await fs.handlers.writeCommit({ session, replace: true, expectTarget: null }, ctx);
  expect((await lstat(target)).mode & 0o7777).toBe(0o750);
});

it("reports published bytes even when the staging unlink fails", async () => {
  const orphans: unknown[] = [];
  await fs.dispose();
  fs = createHostFs({
    unlink: async () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); },
    onOrphan: (orphan) => { orphans.push(orphan); },
  });
  const { session, tempName } = await stage();
  const tempPath = joinResource(at(), tempName);
  await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
    .resolves.toMatchObject({ size: "5", orphanedTempPath: tempPath });
  expect(orphans).toEqual([{ session, targetPath: at("target"), tempPath, reason: "cleanup_failed" }]);
  expect(await readFile(join(root, "target"))).toEqual(Buffer.from([1, 2, 3, 4, 255]));
  expect(await readdir(root)).toHaveLength(2);
});

it("keeps a replaced rename source after linking its original inode", async () => {
  const source = join(root, "source");
  await writeFile(source, "original");
  await fs.dispose();
  fs = createHostFs({
    link: async (from, to) => {
      await link(from, to);
      await unlink(source);
      await writeFile(source, "intervening");
    },
  });
  await expect(fs.handlers.rename({ from: at("source"), to: at("target"), replace: false }, ctx))
    .rejects.toMatchObject({ code: "outcome_unknown" });
  expect(await readFile(source, "utf8")).toBe("intervening");
  expect(await readFile(join(root, "target"), "utf8")).toBe("original");
});

it.each(["EPERM", "ENOTSUP"])("marks the fallback after link returns %s", async (code) => {
  await fs.dispose();
  fs = createHostFs({ link: async () => { throw Object.assign(new Error("injected"), { code }); } });
  const { session } = await stage();
  await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
    .resolves.toMatchObject({ size: "5", atomicNoReplace: false });
  expect(await readdir(root)).toEqual(["target"]);
  expect(await readFile(join(root, "target"))).toEqual(Buffer.from([1, 2, 3, 4, 255]));
});

it("preserves a target inserted before the fallback rename", async () => {
  await fs.dispose();
  fs = createHostFs({
    link: async () => {
      await writeFile(join(root, "target"), "external");
      throw Object.assign(new Error("injected"), { code: "ENOTSUP" });
    },
  });
  const { session } = await stage();
  await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
    .rejects.toMatchObject({ code: "already_exists" });
  expect(await readFile(join(root, "target"), "utf8")).toBe("external");
});

it.each(["abort", "ttl", "dispose"] as const)("reports the stage of a moved parent on %s", async (how) => {
  const orphans: unknown[] = [];
  let expire!: () => Promise<void>;
  await fs.dispose();
  fs = createHostFs({
    onOrphan: (orphan) => { orphans.push(orphan); },
    scheduleExpiry: (callback) => { expire = callback; return () => {}; },
  });
  await mkdir(join(root, "parent"));
  const valid = await fs.handlers.writeOpen({ target: at("target"), tempName: nextTempName() }, ctx);
  const { session, tempName } = await fs.handlers.writeOpen({ target: at("parent/target"), tempName: nextTempName() }, ctx);
  const tempPath = joinResource(at("parent"), tempName);
  await rename(join(root, "parent"), join(root, "moved"));
  await symlink(join(root, "moved"), join(root, "parent"), windows ? "junction" : "dir");
  if (how === "abort") {
    await expect(fs.handlers.writeAbort({ session }, ctx)).resolves.toEqual({ orphanedTempPath: tempPath });
  } else if (how === "ttl") {
    await expire();
  } else {
    await fs.dispose();
    expect((await readdir(root)).sort()).toEqual(["moved", "parent"]);
    await expect(fs.handlers.writeAbort({ session: valid.session }, ctx)).resolves.toEqual({});
  }
  expect(orphans).toEqual([{ session, targetPath: at("parent/target"), tempPath, reason: "parent_changed" }]);
  expect(await readdir(join(root, "moved"))).toHaveLength(1);
});

it("keeps a cursor valid after a directory timestamp change", async () => {
  await writeFile(join(root, "a"), "");
  await writeFile(join(root, "b"), "");
  const page = await fs.handlers.list({ path: at(), cursor: null, limit: 1 }, ctx);
  expect(page.cursor).toMatch(/^1:\d+:\d+$/);
  await utimes(root, 1000, 1000);
  await expect(fs.handlers.list({ path: at(), cursor: page.cursor, limit: 1 }, ctx))
    .resolves.toMatchObject({ cursor: null });
});

it("refuses a target symlink and every mutation through an intermediate symlink", async () => {
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "other", "victim"), "keep");
  await writeFile(join(root, "source"), "keep too");
  await symlink(join(root, "other", "victim"), join(root, "target"));
  await symlink(join(root, "other"), join(root, "nested", "link"), windows ? "junction" : "dir");
  for (const mutation of [
    () => fs.handlers.writeOpen({ target: at("target"), tempName: nextTempName() }, ctx),
    () => fs.handlers.writeOpen({ target: at("nested/link/victim"), tempName: nextTempName() }, ctx),
    () => fs.handlers.rename({ from: at("source"), to: at("nested/link/victim"), replace: true }, ctx),
    () => fs.handlers.mkdir({ path: at("nested/link/new") }, ctx),
    () => fs.handlers.remove({ path: at("nested/link/victim"), kind: "file" }, ctx),
  ]) {
    await expect(mutation()).rejects.toMatchObject({ code: "permission_denied" });
  }
  expect(await readdir(join(root, "other"))).toEqual(["victim"]);
  expect(await readFile(join(root, "other", "victim"), "utf8")).toBe("keep");
});

it("refuses a stale rename target without changing either path", async () => {
  await writeFile(join(root, "source"), "source");
  await writeFile(join(root, "target"), "replacement");
  await expect(fs.handlers.rename({
    from: at("source"), to: at("target"), replace: true, expectTarget: { size: "3", mtimeNs: "0" },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(join(root, "source"), "utf8")).toBe("source");
  expect(await readFile(join(root, "target"), "utf8")).toBe("replacement");
});

it("reports a newly occupied target as changed when link loses the race", async () => {
  const source = join(root, "source");
  const target = join(root, "target");
  await writeFile(source, "source");
  await fs.dispose();
  fs = createHostFs({
    link: async (from, to) => {
      await writeFile(target, "intervening");
      await link(from, to);
    },
  });
  await expect(fs.handlers.rename({
    from: at("source"), to: at("target"), replace: false, expectTarget: "absent",
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(source, "utf8")).toBe("source");
  expect(await readFile(target, "utf8")).toBe("intervening");
});

it("refuses to remove a file with a stale version", async () => {
  await writeFile(join(root, "target"), "replacement");
  await expect(fs.handlers.remove({
    path: at("target"), kind: "file", expect: { size: "3", mtimeNs: "0" },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(join(root, "target"), "utf8")).toBe("replacement");
});

it("rejects removal of a regular file with matching metadata and a stale SHA-256", async () => {
  const target = join(root, "target");
  await writeFile(target, "abc");
  const stats = await lstat(target, { bigint: true });
  await expect(fs.handlers.remove({
    path: at("target"), kind: "file",
    expect: { size: "3", mtimeNs: stats.mtimeNs.toString(), sha256: "0".repeat(64) },
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(target, "utf8")).toBe("abc");
});

it("removes an empty directory with the expected version", async () => {
  const target = join(root, "target");
  await mkdir(target);
  const stats = await lstat(target, { bigint: true });
  await fs.handlers.remove({
    path: at("target"), kind: "dir", expect: { size: stats.size.toString(), mtimeNs: stats.mtimeNs.toString() },
  }, ctx);
  expect(await readdir(root)).toEqual([]);
});

it("reports a symlink that occupied an expected-absent rename target", async () => {
  await writeFile(join(root, "source"), "source");
  await writeFile(join(root, "victim"), "keep");
  await symlink(join(root, "victim"), join(root, "target"));
  await expect(fs.handlers.rename({
    from: at("source"), to: at("target"), replace: false, expectTarget: "absent",
  }, ctx)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(await readFile(join(root, "source"), "utf8")).toBe("source");
  expect((await lstat(join(root, "target"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(root, "victim"), "utf8")).toBe("keep");
});

it("replaces a regular rename target whose expected fingerprint still matches", async () => {
  const target = join(root, "target");
  await writeFile(join(root, "source"), "source");
  await writeFile(target, "abc");
  const stats = await lstat(target, { bigint: true });
  await fs.handlers.rename({
    from: at("source"), to: at("target"), replace: true,
    expectTarget: {
      size: "3", mtimeNs: stats.mtimeNs.toString(),
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
  }, ctx);
  expect(await readFile(target, "utf8")).toBe("source");
  expect(await readdir(root)).toEqual(["target"]);
});

it.skipIf(windows)("drops special permission bits on replacement", async ({ skip }) => {
  const target = join(root, "target");
  await writeFile(target, "old");
  await chmod(target, 0o4755);
  const mode = (await lstat(target)).mode & 0o7777;
  if (process.platform === "darwin" && mode === 0o755) skip("This test filesystem strips setuid");
  expect(mode).toBe(0o4755);
  const { session } = await stage();
  await fs.handlers.writeCommit({ session, replace: true, expectTarget: null }, ctx);
  expect((await lstat(target)).mode & 0o7777).toBe(0o755);
});

it("keeps staging private and skips link when the target is already occupied", async () => {
  await fs.dispose();
  let links = 0;
  const modes: number[] = [];
  fs = createHostFs({
    link: async (from, to) => { links++; await link(from, to); },
    chmodStage: async (file, mode) => { modes.push(mode); await file.chmod(mode); },
  });
  await writeFile(join(root, "target"), "occupied");
  const { session, tempName } = await stage();
  await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
    .rejects.toMatchObject({ code: "already_exists" });
  expect(links).toBe(0);
  expect(modes).toEqual([]);
  if (!windows && "t" in tempName) {
    expect((await lstat(join(root, tempName.t))).mode & 0o777).toBe(0o600);
  }
  expect(await readFile(join(root, "target"), "utf8")).toBe("occupied");
  await fs.handlers.writeCommit({ session, replace: true, expectTarget: null }, ctx);
  expect(modes).toHaveLength(1);
});

it("awaits an asynchronous orphan record that started in the TTL callback", async () => {
  await fs.dispose();
  let expire!: () => Promise<void>;
  const recording = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const records: unknown[] = [];
  fs = createHostFs({
    scheduleExpiry: (callback) => { expire = callback; return () => {}; },
    unlink: async () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); },
    onOrphan: async (orphan) => {
      recording.resolve();
      await release.promise;
      records.push(orphan);
    },
  });
  const { session, tempName } = await stage();
  const expiry = expire();
  await recording.promise;
  const disposal = fs.dispose();
  const disposedEarly = await Promise.race([
    disposal.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  release.resolve();
  await Promise.all([expiry, disposal]);
  expect(disposedEarly).toBe(false);
  expect(records).toEqual([{
    session, targetPath: at("target"), tempPath: joinResource(at(), tempName), reason: "cleanup_failed",
  }]);
});

it("records the target and stage of an internal copy with failed cleanup", async () => {
  await fs.dispose();
  const report = Promise.withResolvers<unknown>();
  fs = createHostFs({
    unlink: async () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); },
    onOrphan: (orphan) => { report.resolve(orphan); },
  });
  await writeFile(join(root, "source"), "copy");
  const copied = await fs.handlers.copyWithin({ from: at("source"), to: at("target"), replace: false }, ctx);
  const stageName = (await readdir(root)).find((name) => name.endsWith(".part"))!;
  expect(stageName).toMatch(/^\.target\.commander-.*\.part$/);
  expect(copied).toMatchObject({ size: "4", orphanedTempPath: at(stageName) });
  await expect(report.promise).resolves.toMatchObject({
    targetPath: at("target"), tempPath: at(stageName), reason: "cleanup_failed",
  });
});

it("does not report an orphan when unlink succeeded and lease cleanup failed", async () => {
  await fs.dispose();
  const reports: unknown[] = [];
  fs = createHostFs({ onOrphan: (orphan) => { reports.push(orphan); } });
  const { session } = await fs.handlers.writeOpen({ target: at("target"), tempName: nextTempName() }, {
    ...ctx,
    experimental_retainWorker: () => ({ dispose: async () => { throw new Error("lease failed"); } }),
  });
  const fingerprint = await fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx);
  expect(fingerprint).toMatchObject({ size: "0" });
  expect(fingerprint).not.toHaveProperty("orphanedTempPath");
  expect(reports).toEqual([]);
  expect(await readdir(root)).toEqual(["target"]);
});

it("reports an orphan when unlink sees ENOENT after its parent is moved", async () => {
  await fs.dispose();
  const records: unknown[] = [];
  fs = createHostFs({
    unlink: async (temp) => {
      await rename(join(root, "parent"), join(root, "moved"));
      await unlink(temp);
    },
    onOrphan: (orphan) => { records.push(orphan); },
  });
  await mkdir(join(root, "parent"));
  const target = at("parent/target");
  const { session, tempName } = await stage(target);
  const tempPath = joinResource(at("parent"), tempName);
  await expect(fs.handlers.writeAbort({ session }, ctx)).resolves.toEqual({ orphanedTempPath: tempPath });
  expect(records).toEqual([{ session, targetPath: target, tempPath, reason: "parent_changed" }]);
  expect(await readdir(join(root, "moved"))).toHaveLength(1);
});

it("writes to the exact caller-chosen stage beside the target", async () => {
  await mkdir(join(root, "nested"));
  const tempName = { t: ".job-17-item-2.part" };
  const opened = await fs.handlers.writeOpen({ target: at("nested/target"), tempName }, ctx);
  expect(opened.tempName).toEqual(tempName);
  await fs.handlers.writeChunk({ session: opened.session, offset: "0", b64: "AQID" }, ctx);
  expect(await readdir(join(root, "nested"))).toEqual([".job-17-item-2.part"]);
  expect(await readFile(join(root, "nested", ".job-17-item-2.part"))).toEqual(Buffer.from([1, 2, 3]));
});

it("rejects an occupied stage name without truncating the existing file", async () => {
  await writeFile(join(root, ".job-17-item-2.part"), "previous stage");
  await expect(fs.handlers.writeOpen({
    target: at("target"), tempName: { t: ".job-17-item-2.part" },
  }, ctx)).rejects.toMatchObject({ code: "already_exists" });
  expect(await readFile(join(root, ".job-17-item-2.part"), "utf8")).toBe("previous stage");
  expect(await readdir(root)).toEqual([".job-17-item-2.part"]);
});

it.each(["../escaped.part", "target"])("rejects unsafe staging name %j before creating a file", async (t) => {
  await expect(fs.handlers.writeOpen({
    target: at("target"), tempName: { t },
  }, ctx)).rejects.toMatchObject({ code: "invalid_name" });
  expect(await readdir(root)).toEqual([]);
});

it.each([
  ["Caf\u00E9", "Cafe\u0301"],
  ["Report", "report"],
])("rejects equivalent staging names %j and %j before open", async (target, temp) => {
  await writeFile(join(root, "CasEProbe"), "");
  await fs.dispose();
  let opens = 0;
  fs = createHostFs({
    openStage: (path, flags, mode) => { opens++; return open(path, flags, mode); },
  });
  await expect(fs.handlers.writeOpen({
    target: at(target), tempName: { t: temp },
  }, ctx)).rejects.toMatchObject({ code: "invalid_name" });
  expect(opens).toBe(0);
  expect(await readdir(root)).toEqual(["CasEProbe"]);
});
