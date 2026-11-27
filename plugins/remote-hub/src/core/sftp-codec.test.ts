import { expect, test } from "vitest";
import { attrsOut, fromBase64, pathBytes, pathOut, toBase64 } from "./sftp-codec.ts";
import { base64Bytes, sftpPathSchema } from "./sftp-contract.ts";

test("base64 matches the RFC 4648 vectors both ways", () => {
  const vectors: Array<[string, string]> = [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foob", "Zm9vYg=="], ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"]];
  for (const [plain, encoded] of vectors) {
    expect(toBase64(new TextEncoder().encode(plain))).toBe(encoded);
    expect(new TextDecoder().decode(fromBase64(encoded))).toBe(plain);
  }
  expect(toBase64(new Uint8Array([0xff, 0xfe, 0x00]))).toBe("//4A");
  expect(Array.from(fromBase64("//4A"))).toEqual([0xff, 0xfe, 0x00]);
});

test("a 4 MiB chunk survives the round trip and the piece boundaries", () => {
  for (const size of [24575, 24576, 24577, 4 * 1024 * 1024]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
    const text = toBase64(bytes);
    expect(base64Bytes(text)).toBe(size);
    const back = fromBase64(text);
    expect(back.length).toBe(size);
    let same = true;
    for (let i = 0; i < size; i++) if (back[i] !== bytes[i]) same = false;
    expect(same).toBe(true);
  }
});

test("a path goes in as text or bytes and is refused when empty, too long or holding a NUL", () => {
  expect(Array.from(pathBytes({ text: "/tmp/ё" })!)).toEqual([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0xd1, 0x91]);
  expect(Array.from(pathBytes({ bytes: "L/8=" })!)).toEqual([0x2f, 0xff]);
  expect(pathBytes({ bytes: "LwA=" })).toBeNull();
  expect(pathBytes({ text: "я".repeat(2049) })).toBeNull();
  expect(pathBytes({ text: "я".repeat(2048) })!.length).toBe(4096);
});

test("a name comes out as text only when its bytes are exactly that text", () => {
  expect(pathOut(new Uint8Array([0x61, 0xd1, 0x91]))).toEqual({ text: "aё" });
  expect(pathOut(new Uint8Array([0x61, 0xff]))).toEqual({ bytes: "Yf8=" });
  // a byte-order mark would be lost in text
  expect(pathOut(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ bytes: "77u/YQ==" });
  for (const out of [pathOut(new Uint8Array([0x61, 0xff])), pathOut(new Uint8Array([0x61]))]) expect(sftpPathSchema.safeParse(out).success).toBe(true);
});

test("attributes keep a size past 2^53 exact and a link target as stored", () => {
  expect(attrsOut({ type: "file", size: 18446744073709551615n, mtime: 1700000000, mode: 0o100644, linkTarget: null })).toEqual({ type: "file", size: "18446744073709551615", mtime: 1700000000, mode: 33188, linkTarget: null });
  expect(attrsOut({ type: "symlink", size: 3n, mtime: null, mode: null, linkTarget: new Uint8Array([0x2e, 0x2e]) }).linkTarget).toEqual({ text: ".." });
});
