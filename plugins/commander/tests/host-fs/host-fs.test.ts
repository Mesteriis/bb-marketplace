import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHostFs } from "../../src/adapters/bb/host-fs/index.ts";
import { parsePosix } from "../../src/core/path.ts";

let root: string;
let fs: ReturnType<typeof createHostFs>;
const at = (name = "") => parsePosix(join(root, name));
const ctx = { signal: new AbortController().signal };

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

async function stage() {
  const opened = await fs.handlers.writeOpen({ target: at("target") }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "2", b64: "AwQ=" }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "0", b64: "AQI=" }, ctx);
  await fs.handlers.writeChunk({ session: opened.session, offset: "4", b64: "/w==" }, ctx);
  return opened;
}

it("commits three chunks at their offsets and publishes mode 0644", async () => {
  const mask = process.umask(0o022);
  try {
    const { session, tempName } = await stage();
    expect(tempName).toEqual({ t: expect.stringMatching(/^\.target\.commander-.*\.part$/) });
    expect((await readdir(root))).toHaveLength(1);
    await expect(fs.handlers.writeCommit({ session, replace: false, expectTarget: null }, ctx))
      .resolves.toMatchObject({ size: "5" });
    expect(await readFile(join(root, "target"))).toEqual(Buffer.from([1, 2, 3, 4, 255]));
    expect(await readdir(root)).toEqual(["target"]);
    expect((await lstat(join(root, "target"))).mode & 0o777).toBe(0o644);
  } finally {
    process.umask(mask);
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
  expect(await readdir(root)).toEqual(["source", "target"]);
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

it("maps a directory with mode 000 to permission_denied", async () => {
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
    const { session } = await timed.handlers.writeOpen({ target: at("target") }, ctx);
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
