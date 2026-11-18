import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePngRgba, encodePngRgba, fitScreenshot } from "./png-downscale.ts";

const rgba = (w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(pixel(x, y), (y * w + x) * 4);
  return out;
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("png round trip", () => {
  it("what is encoded decodes to the same pixels", () => {
    const img = rgba(3, 2, (x, y) => [x * 40, y * 100, 7, 255]);
    const back = decodePngRgba(encodePngRgba(img, 3, 2));
    expect(back).toMatchObject({ width: 3, height: 2 });
    expect([...back.rgba]).toEqual([...img]);
  });

  it("decodes every PNG row filter (a hand-made image using Sub, Up, Average and Paeth)", () => {
    // 2x4 RGBA, filtered rows: 1 Sub, 2 Up, 3 Average, 4 Paeth. Raw pixels are 10,20,30,40 repeated per row base.
    const raw = [
      [10, 20, 30, 255, 11, 21, 31, 255],
      [12, 22, 32, 255, 13, 23, 33, 255],
      [14, 24, 34, 255, 15, 25, 35, 255],
      [16, 26, 36, 255, 17, 27, 37, 255],
    ];
    const filtered: number[] = [];
    const bpp = 4;
    const prev = (r: number, i: number) => (r === 0 ? 0 : raw[r - 1]![i]!);
    const left = (r: number, i: number) => (i < bpp ? 0 : raw[r]![i - bpp]!);
    const upleft = (r: number, i: number) => (r === 0 || i < bpp ? 0 : raw[r - 1]![i - bpp]!);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let r = 0; r < 4; r++) {
      filtered.push(r + 1);
      for (let i = 0; i < 8; i++) {
        const x = raw[r]![i]!;
        const pred = r === 0 ? left(r, i) : r === 1 ? prev(r, i) : r === 2 ? Math.floor((left(r, i) + prev(r, i)) / 2) : paeth(left(r, i), prev(r, i), upleft(r, i));
        filtered.push((x - pred + 256) & 255);
      }
    }
    const crcless = encodePngRgba(new Uint8Array(2 * 4 * 4), 2, 4); // only for the signature, header and trailer shape
    // Rebuild the file with our filtered data in the IDAT chunk.
    const parts = splitChunks(crcless);
    const idat = Buffer.from(deflateSync(Buffer.from(filtered)));
    const file = Buffer.concat([parts.signature, parts.ihdr, chunk("IDAT", idat), parts.iend]);
    expect([...decodePngRgba(file).rgba]).toEqual(raw.flat());
  });

  it("refuses what the helper never produces: interlaced, 16-bit, palette", () => {
    const base = Buffer.from(encodePngRgba(new Uint8Array(4), 1, 1));
    const mutate = (offset: number, value: number) => {
      const copy = Buffer.from(base);
      copy[16 + offset] = value; // IHDR data starts at byte 16: width(4) height(4) depth color compression filter interlace
      return copy;
    };
    expect(() => decodePngRgba(mutate(8, 16))).toThrow(/unsupported/);
    expect(() => decodePngRgba(mutate(9, 3))).toThrow(/unsupported/);
    expect(() => decodePngRgba(mutate(12, 1))).toThrow(/unsupported/);
    expect(() => decodePngRgba(new Uint8Array([1, 2, 3]))).toThrow(/not a png/);
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function splitChunks(png: Uint8Array): { signature: Buffer; ihdr: Buffer; iend: Buffer } {
  const b = Buffer.from(png);
  const ihdrLen = 8 + 13 + 4;
  return { signature: b.subarray(0, 8), ihdr: b.subarray(8, 8 + ihdrLen), iend: b.subarray(b.length - 12) };
}

describe("fitScreenshot", () => {
  it("leaves a small screenshot alone and says it was not downscaled", () => {
    const img = rgba(4, 2, () => [1, 2, 3, 255]);
    const r = fitScreenshot(b64(encodePngRgba(img, 4, 2)), { maxDim: 100, maxBytes: 100_000 });
    expect(r).toMatchObject({ width: 4, height: 2, sourceWidth: 4, sourceHeight: 2, scale: 1, downscaled: false });
  });

  it("averages boxes when it must shrink: a 4x4 image to 2x2 has the mean of each 2x2 block", () => {
    // Left half black, right half white, with one different pixel in the top-left block.
    const img = rgba(4, 4, (x, y) => (x < 2 ? (x === 0 && y === 0 ? [100, 100, 100, 255] : [0, 0, 0, 255]) : [200, 200, 200, 255]));
    const r = fitScreenshot(b64(encodePngRgba(img, 4, 4)), { maxDim: 2, maxBytes: 100_000 });
    expect(r).toMatchObject({ width: 2, height: 2, sourceWidth: 4, sourceHeight: 4, scale: 0.5, downscaled: true });
    const out = decodePngRgba(Buffer.from(r.png, "base64"));
    expect([...out.rgba]).toEqual([25, 25, 25, 255, 200, 200, 200, 255, 0, 0, 0, 255, 200, 200, 200, 255]);
  });

  it("keeps the aspect ratio: the longest side is the one that is limited", () => {
    const img = rgba(8, 2, () => [9, 9, 9, 255]);
    const r = fitScreenshot(b64(encodePngRgba(img, 8, 2)), { maxDim: 4, maxBytes: 100_000 });
    expect([r.width, r.height]).toEqual([4, 1]);
  });

  it("shrinks further when the encoded image is still over the byte budget", () => {
    // Noise does not compress: 64x64 of it is far over 2 KiB, so the size cap decides.
    let s = 12345;
    const img = rgba(64, 64, () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return [s & 255, (s >> 8) & 255, (s >> 16) & 255, 255];
    });
    const r = fitScreenshot(b64(encodePngRgba(img, 64, 64)), { maxDim: 64, maxBytes: 2048 });
    expect(r.downscaled).toBe(true);
    expect(Buffer.from(r.png, "base64").length).toBeLessThanOrEqual(2048);
    expect(r.width).toBeLessThan(64);
  });
});
