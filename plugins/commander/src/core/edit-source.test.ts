import { describe, expect, it } from "vitest";
import { readEditSource } from "./edit-source.ts";
import { parsePosix } from "./path.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const path = parsePosix("/edit.txt");
const signal = new AbortController().signal;
const encoder = new TextEncoder();

describe("F4 source", () => {
  it("preserves UTF-8 split across read chunks and fingerprints the actual bytes", async () => {
    const provider = new FakeProvider("host:local");
    provider.enableChecksum();
    provider.put(path, Uint8Array.from([0x61, 0xe2, 0x82, 0xac, 0x0a]), "100");
    const file = await readEditSource(provider, path, signal, { chunkBytes: 2 });
    expect(file.chunks.map((part) => Array.from(part))).toEqual([[97, 226], [130, 172], [10]]);
    expect(file.base).toEqual({
      size: "5", mtimeNs: "100", sha256: "31132ff64d70c27352f040e3d2cb187309f4e43eafbc3ace78f141d85772853e",
    });
  });

  it.each([
    ["malformed UTF-8", [0xc3, 0x28]],
    ["incomplete UTF-8 at EOF", [0x61, 0xe2, 0x82]],
    ["NUL", [0x61, 0x00, 0x62]],
    ["C1 control", [0x61, 0xc2, 0x85]],
  ])("refuses %s", async (_, bytes) => {
    const provider = new FakeProvider("host:local");
    provider.put(path, Uint8Array.from(bytes));
    await expect(readEditSource(provider, path, signal, { chunkBytes: 2 }))
      .rejects.toMatchObject({ code: "unsupported", message: "Файл не текстовый — правка недоступна" });
  });

  it("accepts an empty file and permits tab, CR and LF", async () => {
    const provider = new FakeProvider("host:local");
    provider.put(path, new Uint8Array(), "26");
    expect(await readEditSource(provider, path, signal)).toEqual({ base: { size: "0", mtimeNs: "26" }, chunks: [] });
    provider.put(path, Uint8Array.from([9, 13, 10]), "27");
    expect((await readEditSource(provider, path, signal)).chunks).toEqual([Uint8Array.from([9, 13, 10])]);
  });

  it("rejects 16 MiB plus one byte before reading", async () => {
    const provider = new FakeProvider("host:local");
    provider.put(path, new Uint8Array(16_777_217));
    await expect(readEditSource(provider, path, signal)).rejects.toMatchObject({
      code: "limit_exceeded", message: "Файл слишком большой для правки (до 16 МиБ)",
    });
    expect(provider.calls.map(({ op }) => op)).toEqual(["stat"]);
  });

  it("rejects an original replaced during the read", async () => {
    const provider = new FakeProvider("host:local");
    provider.put(path, encoder.encode("abc"), "100");
    const read = provider.read.bind(provider);
    provider.read = async (...args) => {
      const chunk = await read(...args);
      provider.put(path, encoder.encode("xyz"), "101");
      return chunk;
    };
    await expect(readEditSource(provider, path, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
  });
});
