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
