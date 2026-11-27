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
  const session = await provider.openWrite(parsePosix("/file"), signal);
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
