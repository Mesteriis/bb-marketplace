import { expect, test } from "vitest";
import { checksum, compareDirs, compareFiles, estimateRead } from "./compare.ts";
import { parsePosix } from "./path.ts";
import { READ_CHUNK_MAX } from "./provider.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const signal = new AbortController().signal;

test.each([false, true])('checksum of "abc" is the SHA-256 reference digest (provider hash: %s)', async (native) => {
  const provider = new FakeProvider("host:test");
  if (native) provider.enableChecksum();
  const path = parsePosix("/a");
  provider.put(path, new TextEncoder().encode("abc"));
  await expect(checksum(provider, path, signal))
    .resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(provider.calls.filter(({ op }) => op === "read")).toHaveLength(native ? 0 : 1);
});

test("cancel during checksum stops within one chunk", async () => {
  const controller = new AbortController();
  const provider = new FakeProvider("host:test");
  const path = parsePosix("/a");
  provider.put(path, new Uint8Array(3 * READ_CHUNK_MAX));
  const read = provider.read.bind(provider);
  let reads = 0;
  provider.read = async (...args) => {
    reads++;
    const bytes = await read(...args);
    controller.abort();
    return bytes;
  };
  await expect(checksum(provider, path, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBe(1);
});

test("compareDirs accepts 1500 ms and rejects 2500 ms at tolerance 2000 ms", async () => {
  const left = new FakeProvider("host:left");
  const right = new FakeProvider("host:right");
  left.put(parsePosix("/near"), Uint8Array.of(1), "10000000000");
  left.put(parsePosix("/far"), Uint8Array.of(1), "10000000000");
  right.put(parsePosix("/near"), Uint8Array.of(1), "11500000000");
  right.put(parsePosix("/far"), Uint8Array.of(1), "12500000000");
  const path = parsePosix("/");
  const result = await compareDirs({ provider: left, path }, { provider: right, path },
    { by: "size+mtime", mtimeToleranceMs: 2000, limit: 10 }, signal);
  expect(result).toMatchObject({ same: 1, onlyLeft: [], onlyRight: [], partial: false,
    differ: [[{ name: { t: "far" } }, { name: { t: "far" } }]] });
  expect(estimateRead(result.differ[0])).toBe(2n);
});

test("a truncated listing does not claim that unseen names are absent", async () => {
  const left = new FakeProvider("host:left");
  const right = new FakeProvider("host:right");
  left.put(parsePosix("/a"), Uint8Array.of(1));
  right.put(parsePosix("/b"), Uint8Array.of(1));
  right.put(parsePosix("/a"), Uint8Array.of(1));
  const path = parsePosix("/");
  await expect(compareDirs({ provider: left, path }, { provider: right, path },
    { by: "sha256", mtimeToleranceMs: 2000, limit: 1 }, signal))
    .resolves.toMatchObject({ onlyLeft: [], onlyRight: [{ name: { t: "b" } }], differ: [], same: 0, partial: true });
});

test.each([["size", "same"], ["sha256", "different"], ["bytes", "different"]] as const)(
  "file mode %s compares equal sizes with different content", async (mode, expected) => {
    const left = new FakeProvider("host:left");
    const right = new FakeProvider("host:right");
    const path = parsePosix("/a");
    left.put(path, Uint8Array.of(1, 2, 3));
    right.put(path, Uint8Array.of(1, 2, 4));
    const read = right.read.bind(right);
    right.read = (path, offset, length, version, signal) => read(path, offset, Math.min(length, 1), version, signal);
    await expect(compareFiles({ provider: left, path }, { provider: right, path }, mode, signal)).resolves.toBe(expected);
  },
);
