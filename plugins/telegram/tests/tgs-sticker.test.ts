import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { decodeTgsSticker, inspectTgsUpload } from "../src/adapters/bb/tgs-sticker.ts";

const base = { v: "5.7.4", w: 512, h: 512, fr: 60, ip: 0, op: 180, layers: [{ ty: 4, ind: 1, shapes: [] }] };
const tgs = (json: unknown) => gzipSync(JSON.stringify(json));

test("decodes a bounded Telegram vector sticker", () => {
  expect(JSON.parse(decodeTgsSticker(tgs(base)))).toEqual(base);
});

test("rejects external assets, recursive compositions and oversized decompression", () => {
  expect(() => decodeTgsSticker(tgs({ ...base, assets: [{ id: "img", u: "https://example.org/", p: "pixel.png" }] }))).toThrow();
  const layers = [{ ty: 0, ind: 1, refId: "loop" }];
  expect(() => decodeTgsSticker(tgs({ ...base, layers, assets: [{ id: "loop", layers }] }))).toThrow();
  expect(() => decodeTgsSticker(tgs({ ...base, data: "a".repeat(2 * 1024 * 1024) }))).toThrow();
});

test("requires Telegram's dimensions, frame rate and duration for local TGS imports", () => {
  const inspect = (value: unknown) => inspectTgsUpload(tgs(value).toString("base64"));
  expect(inspect(base)?.json).toBe(JSON.stringify(base));
  expect(inspect({ ...base, w: 511 })).toBeUndefined();
  expect(inspect({ ...base, fr: 30 })).toBeUndefined();
  expect(inspect({ ...base, op: 181 })).toBeUndefined();
  expect(inspect({ ...base, assets: [{ id: "a", u: "https://example.org/", p: "image.png" }] })).toBeUndefined();
});
