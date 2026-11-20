import { maxTelegramUploadBytes } from "../core/contract.ts";

const tarBlockSize = 512;
const mediaPath = /^media\/[1-9]\d{0,15}-\d{1,3}-[A-Za-z0-9_.-]+$/;

function field(header: Uint8Array, offset: number, length: number) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
}

function octal(header: Uint8Array, offset: number, length: number) {
  const value = field(header, offset, length).trim();
  return /^[0-7]+$/.test(value) ? Number.parseInt(value, 8) : NaN;
}

export async function readRichHtmlArchive(archive: Blob, maxHtmlBytes: number, signal: AbortSignal) {
  const files = new Map<string, Blob>();
  let html: Blob | undefined;
  let offset = 0;
  while (offset + tarBlockSize * 2 <= archive.size) {
    signal.throwIfAborted();
    const header = new Uint8Array(await archive.slice(offset, offset + tarBlockSize).arrayBuffer());
    if (header.every((byte) => byte === 0)) {
      if (offset + tarBlockSize * 2 !== archive.size || !html) return;
      const last = new Uint8Array(await archive.slice(offset + tarBlockSize).arrayBuffer());
      if (last.some((byte) => byte !== 0)) return;
      signal.throwIfAborted();
      const source = await html.text();
      signal.throwIfAborted();
      return { html: source, files };
    }
    const name = field(header, 0, 100);
    const size = octal(header, 124, 12);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    const start = offset + tarBlockSize;
    const next = start + Math.ceil(size / tarBlockSize) * tarBlockSize;
    if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00" || (header[156] !== 48 && header[156] !== 0)
      || field(header, 157, 100) || field(header, 345, 155) || checksum !== octal(header, 148, 8)
      || !Number.isSafeInteger(size) || size < 0 || next + tarBlockSize * 2 > archive.size) return;
    if (name === "messages.html") {
      if (html || !size || size > maxHtmlBytes) return;
      html = archive.slice(start, start + size);
    } else {
      if (!mediaPath.test(name) || files.has(name) || files.size >= 128 || size > maxTelegramUploadBytes) return;
      files.set(name, archive.slice(start, start + size));
    }
    offset = next;
  }
}
