// Fits a desktop screenshot into what an agent tool may return (stage 4a): a dimension cap and a byte cap, with
// the scale stated. The helper's PNGs are 8-bit RGBA and not interlaced; anything else is refused rather than
// guessed at. node:zlib is why this is an adapter, not core.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function decodePngRgba(input: Uint8Array): DecodedPng {
  const buf = Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a png");
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let pos = 8; pos + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("unsupported png (needs 8-bit RGBA, not interlaced)");
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (width === 0 || height === 0 || width > 16384 || height > 16384) throw new Error("not a png (bad size)");
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (width * 4 + 1) * height + 16 });
  const stride = width * 4;
  if (raw.length < (stride + 1) * height) throw new Error("not a png (short data)");
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? (out[y * stride + i - 4] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= 4 ? (out[(y - 1) * stride + i - 4] as number) : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error("not a png (bad filter)");
      out[y * stride + i] = ((row[i] as number) + pred) & 255;
    }
  }
  return { width, height, rgba: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Area average over the source pixels each destination pixel covers. */
function boxDownscale(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      const sum = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) for (let ch = 0; ch < 4; ch++) sum[ch]! += src[(yy * sw + xx) * 4 + ch] as number;
      }
      const n = (y1 - y0) * (x1 - x0);
      for (let ch = 0; ch < 4; ch++) out[(y * dw + x) * 4 + ch] = Math.floor(sum[ch]! / n);
    }
  }
  return out;
}

export interface FittedScreenshot {
  /** Base64 of the PNG that is returned. */
  png: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** returned size / desktop size, for mapping a position in the image back to the desktop. */
  scale: number;
  downscaled: boolean;
}

/** Fits `pngBase64` into `maxDim` on the longest side and `maxBytes` encoded, shrinking by a quarter at a time. */
export function fitScreenshot(pngBase64: string, limits: { maxDim: number; maxBytes: number }): FittedScreenshot {
  const source = decodePngRgba(Buffer.from(pngBase64, "base64"));
  const { width: sw, height: sh } = source;
  const longest = Math.max(sw, sh);
  let factor = Math.min(1, limits.maxDim / longest);
  for (;;) {
    const dw = Math.max(1, Math.round(sw * factor));
    const dh = Math.max(1, Math.round(sh * factor));
    const unchanged = dw === sw && dh === sh;
    const encoded = unchanged && Buffer.from(pngBase64, "base64").length <= limits.maxBytes ? Buffer.from(pngBase64, "base64") : Buffer.from(encodePngRgba(unchanged ? source.rgba : boxDownscale(source.rgba, sw, sh, dw, dh), dw, dh));
    if (encoded.length <= limits.maxBytes || (dw <= 16 && dh <= 16)) {
      return { png: unchanged && encoded.length === Buffer.from(pngBase64, "base64").length ? pngBase64 : encoded.toString("base64"), width: dw, height: dh, sourceWidth: sw, sourceHeight: sh, scale: dw / sw, downscaled: !unchanged };
    }
    factor *= 0.75;
  }
}
