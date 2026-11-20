import { maxStaticStickerBytes, maxStickerCoverBytes } from "../../core/contract.ts";

export function inspectStaticSticker(input: string, kind: "sticker" | "cover" = "sticker"): Buffer | undefined {
  const maxBytes = kind === "cover" ? maxStickerCoverBytes : maxStaticStickerBytes;
  if (input.length > Math.ceil(maxBytes / 3) * 4) return;
  const bytes = Buffer.from(input, "base64");
  if (bytes.length < 25 || bytes.length > maxBytes || bytes.toString("base64") !== input
    || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return;
  let canvas: { width: number; height: number } | undefined;
  let image: typeof canvas;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    offset = data + length + (length % 2);
    if (offset > bytes.length || chunk === "ANIM" || chunk === "ANMF") return;
    if (chunk === "VP8X") {
      if (data !== 20 || length !== 10 || bytes[data]! & 0x02) return;
      canvas = { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
    } else if (chunk === "VP8 ") {
      if (image || length <= 10 || bytes[data]! & 1 || bytes.readUIntBE(data + 3, 3) !== 0x9d012a) return;
      image = { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
    } else if (chunk === "VP8L") {
      if (image || length <= 5 || bytes[data] !== 0x2f) return;
      const dimensions = bytes.readUInt32LE(data + 1);
      if (dimensions >>> 29) return;
      image = { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
    }
  }
  if (offset !== bytes.length || !image || image.width < 1 || image.height < 1
    || (kind === "cover" ? image.width !== 100 || image.height !== 100 : Math.max(image.width, image.height) !== 512)
    || canvas && (canvas.width !== image.width || canvas.height !== image.height)) return;
  return bytes;
}
