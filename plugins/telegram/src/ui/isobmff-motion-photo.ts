import { maxOriginalPhotoBytes } from "./prepare-photo.ts";

type Box = { type: string; start: number; data: number; end: number };
const decoder = new TextDecoder("utf-8", { fatal: true });

function text(view: DataView, start: number, end: number) {
  return decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, end - start));
}

function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  while (start < end) {
    if (start + 8 > end || start + 8 > view.byteLength) throw new Error("Incomplete image container box.");
    const size32 = view.getUint32(start);
    const type = String.fromCharCode(view.getUint8(start + 4), view.getUint8(start + 5),
      view.getUint8(start + 6), view.getUint8(start + 7));
    const header = size32 === 1 ? 16 : 8;
    const size = size32 === 1 ? Number(view.getBigUint64(start + 8)) : size32 || end - start;
    if (!Number.isSafeInteger(size) || size < header || size > end - start || (type === "mpvd" && size32 === 0)) {
      throw new Error("Invalid image container box size.");
    }
    const next = start + size;
    yield { type, start, data: start + header, end: next };
    start = next;
  }
}

function xmpItemId(view: DataView, iinf: Box) {
  const version = view.getUint8(iinf.data);
  if (version > 1) return;
  let found: number | undefined;
  for (const entry of boxes(view, iinf.data + (version ? 8 : 6), iinf.end)) {
    if (entry.type !== "infe") continue;
    const version = view.getUint8(entry.data);
    if (version !== 2 && version !== 3) continue;
    const idWidth = version === 2 ? 2 : 4;
    const type = entry.data + 4 + idWidth + 2;
    if (type + 4 >= entry.end || text(view, type, type + 4) !== "mime") continue;
    let start = type + 4;
    while (start < entry.end && view.getUint8(start) !== 0) start++;
    let end = ++start;
    while (end < entry.end && view.getUint8(end) !== 0) end++;
    if (end >= entry.end || text(view, start, end) !== "application/rdf+xml") continue;
    const id = idWidth === 2 ? view.getUint16(entry.data + 4) : view.getUint32(entry.data + 4);
    if (!id || found !== undefined) return;
    found = id;
  }
  return found;
}

function containerXmp(view: DataView, meta: Box, stillEnd: number) {
  const entries = Array.from(boxes(view, meta.data + 4, meta.end));
  const info = entries.find(({ type }) => type === "iinf");
  const location = entries.find(({ type }) => type === "iloc");
  const idat = entries.find(({ type }) => type === "idat");
  if (!info || !location) return;
  const expected = xmpItemId(view, info);
  if (expected === undefined) return;

  const loc = new DataView(view.buffer, view.byteOffset + location.data, location.end - location.data);
  const version = loc.getUint8(0);
  if (version > 2) return;
  const idWidth = version < 2 ? 2 : 4;
  const offsets = loc.getUint8(4), bases = loc.getUint8(5);
  const offsetWidth = offsets >> 4, lengthWidth = offsets & 15;
  const baseWidth = bases >> 4, indexWidth = version ? bases & 15 : 0;
  if ([offsetWidth, lengthWidth, baseWidth, indexWidth].some((width) => width !== 0 && width !== 4 && width !== 8)) return;
  let position = 6;
  function read(width: number) {
    const value = width === 0 ? 0 : width === 2 ? loc.getUint16(position)
      : width === 4 ? loc.getUint32(position) : Number(loc.getBigUint64(position));
    position += width;
    if (!Number.isSafeInteger(value)) throw new Error("Invalid image container item offset.");
    return value;
  }

  const count = read(idWidth);
  for (let i = 0; i < count; i++) {
    const id = read(idWidth);
    const method = version ? read(2) : 0;
    const reference = read(2);
    const base = read(baseWidth);
    const extentCount = read(2);
    if (id !== expected) {
      position += extentCount * (indexWidth + offsetWidth + lengthWidth);
      continue;
    }
    if (reference || (method !== 0 && (method !== 1 || !idat))) return;
    const origin = method === 1 ? idat!.data : 0;
    const end = method === 1 ? idat!.end : stillEnd;
    const segments: Uint8Array[] = [];
    let length = 0;
    for (let n = 0; n < extentCount; n++) {
      read(indexWidth);
      const start = origin + base + read(offsetWidth);
      const size = read(lengthWidth);
      length += size;
      if (start > end || size > end - start || length > 65536) return;
      segments.push(new Uint8Array(view.buffer, view.byteOffset + start, size));
    }
    const xmp = new Uint8Array(length);
    let offset = 0;
    for (const bytes of segments) {
      xmp.set(bytes, offset);
      offset += bytes.length;
    }
    return decoder.decode(xmp);
  }
}

export async function readIsobmffMotionPhoto(source: File) {
  const view = new DataView(await source.slice(0, maxOriginalPhotoBytes + 16).arrayBuffer());
  try {
    let meta: Box | undefined;
    let mime: "image/avif" | "image/heic" | undefined;
    for (const box of boxes(view, 0, source.size)) {
      if (box.start === 0) {
        if (box.type !== "ftyp" || box.end > view.byteLength || box.end - box.data < 8) return;
        function imageBrand(brand: number) {
          if (brand === 0x61766966) return "image/avif" as const;
          if (brand === 0x68656963 || brand === 0x68656978) return "image/heic" as const;
        }
        mime = imageBrand(view.getUint32(box.data));
        for (let i = box.data + 8; i + 4 <= box.end && !mime; i += 4) mime = imageBrand(view.getUint32(i));
        if (!mime) return;
      } else if (box.type === "meta") {
        if (meta) return;
        meta = box;
      } else if (box.type === "mpvd") {
        if (!meta || !mime || box.end !== source.size || box.start > maxOriginalPhotoBytes) return;
        const xmp = containerXmp(view, meta, box.start);
        if (xmp) return { xmp, mime, stillEnd: box.start, videoStart: box.data };
        return;
      }
    }
  } catch {
    // Invalid box lengths or item offsets identify an unsupported file.
  }
}
