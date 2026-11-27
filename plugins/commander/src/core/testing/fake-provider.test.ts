import { expect, test } from "vitest";
import { parsePosix } from "../path.ts";
import { FakeProvider } from "./fake-provider.ts";

const signal = new AbortController().signal;

test("rejects optional provider methods without the matching capability", async () => {
  const provider = new FakeProvider("host:test");
  provider.sha256 = async () => "bad";
  await expect(provider.stat(parsePosix("/a"), signal)).rejects.toMatchObject({ code: "internal" });
});

test("rejects an advertised optional capability if its method disappears", async () => {
  const provider = new FakeProvider("host:test");
  provider.enableCopyWithin();
  provider.copyWithin = undefined;
  await expect(provider.stat(parsePosix("/a"), signal)).rejects.toMatchObject({ code: "internal" });
});

test("uses case sensitivity when checking target fingerprints", async () => {
  const provider = new FakeProvider("host:test", false);
  const real = parsePosix("/File");
  provider.put(real, Uint8Array.of(2), "7");
  const session = await provider.openWrite(parsePosix("/file"), { tempName: { t: ".file.part" } }, signal);
  await session.write(0n, Uint8Array.of(3), signal);
  await expect(session.commit({ replace: true, expectTarget: { mtimeNs: "6", size: "1" } }, signal))
    .rejects.toMatchObject({ code: "changed_since_plan" });
  await session.abort();
  expect(provider.contents(real)).toEqual(Uint8Array.of(2));
});

test("checks the removal fingerprint and preserves the changed file", async () => {
  const provider = new FakeProvider("host:test");
  const file = parsePosix("/file");
  provider.put(file, Uint8Array.of(2), "7");
  await expect(provider.remove(file, { kind: "file", expect: { size: "1", mtimeNs: "6" } }, signal))
    .rejects.toMatchObject({ code: "changed_since_plan" });
  expect(provider.contents(file)).toEqual(Uint8Array.of(2));
});

test("checks the rename target and moves the full directory tree", async () => {
  const provider = new FakeProvider("host:test");
  const from = parsePosix("/from");
  const to = parsePosix("/to");
  await provider.mkdir(from, signal);
  await provider.mkdir(to, signal);
  provider.put(parsePosix("/from/file"), Uint8Array.of(2), "7");
  await expect(provider.rename(from, to, { replace: true, expectTarget: "absent" }, signal))
    .rejects.toMatchObject({ code: "changed_since_plan" });
  const entry = (await provider.stat(to, signal))!;
  await provider.rename(from, to, { replace: true, expectTarget: { size: "0", mtimeNs: entry.mtimeNs } }, signal);
  expect(await provider.stat(from, signal)).toBeNull();
  expect(provider.contents(parsePosix("/from/file"))).toBeNull();
  expect(provider.contents(parsePosix("/to/file"))).toEqual(Uint8Array.of(2));
});

test("opens exactly the caller-selected temporary path exclusively", async () => {
  const provider = new FakeProvider("host:test");
  const target = parsePosix("/nested/file");
  const opts = { tempName: { t: ".selected.part" } };
  const session = await provider.openWrite(target, opts, signal);
  expect(session.tempPath).toEqual({ segments: [{ t: "nested" }, { t: ".selected.part" }] });
  await expect(provider.openWrite(target, opts, signal)).rejects.toMatchObject({ code: "already_exists" });
  await session.abort();
});

test("shows the root to every existence check and refuses to change it", async () => {
  const provider = new FakeProvider("host:test");
  const root = parsePosix("/");
  provider.put(parsePosix("/a"), Uint8Array.of(1), "5");
  expect((await provider.stat(root, signal))?.kind).toBe("dir");
  await expect(provider.mkdir(root, signal)).rejects.toMatchObject({ code: "invalid_path" });
  expect(() => provider.put(root, Uint8Array.of(1))).toThrowError(expect.objectContaining({ code: "invalid_path" }));
  await expect(provider.remove(root, { kind: "dir" }, signal)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(provider.rename(parsePosix("/a"), root, { replace: true }, signal)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(provider.rename(root, parsePosix("/b"), { replace: false }, signal)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(provider.openWrite(root, { tempName: { t: ".r.part" } }, signal)).rejects.toMatchObject({ code: "invalid_path" });
  expect((await provider.list(root, { cursor: null, limit: 10 }, signal)).entries.map(({ name }) => name)).toEqual([{ t: "a" }]);
  expect(provider.contents(parsePosix("/a"))).toEqual(Uint8Array.of(1));
});
