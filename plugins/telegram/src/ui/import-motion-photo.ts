import { maxTelegramUploadBytes } from "../core/contract.ts";
import { maxOriginalPhotoBytes } from "./prepare-photo.ts";
import { readIsobmffMotionPhoto } from "./isobmff-motion-photo.ts";

const xmpHeader = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
const camera = "http://ns.google.com/photos/1.0/camera/";
const container = "http://ns.google.com/photos/1.0/container/";
const item = "http://ns.google.com/photos/1.0/container/item/";
const rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

async function jpegXmp(source: File) {
  const limit = Math.min(source.size, maxOriginalPhotoBytes);
  let start = 0;
  let head = new Uint8Array(await source.slice(0, Math.min(limit, 65536)).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return;
  let position = 2;
  while (position + 4 <= limit) {
    if (position + 4 > start + head.length) {
      start = position;
      head = new Uint8Array(await source.slice(start, Math.min(limit, start + 65536)).arrayBuffer());
    }
    const offset = position - start;
    const marker = head[offset + 1];
    if (head[offset] !== 0xff || marker === 0xda || marker === 0xd9) return;
    if (marker === 0xff) {
      position++;
      continue;
    }
    const length = (head[offset + 2]! << 8) | head[offset + 3]!;
    const end = position + 2 + length;
    if (length < 2 || end > limit) return;
    if (marker === 0xe1 && length > 2 + xmpHeader.length) {
      const begin = position + 4;
      const segment = end <= start + head.length
        ? head.subarray(begin - start, end - start)
        : new Uint8Array(await source.slice(begin, end).arrayBuffer());
      if (xmpHeader.every((byte, index) => segment[index] === byte)) {
        return new TextDecoder("utf-8", { fatal: true }).decode(segment.subarray(xmpHeader.length));
      }
    }
    position = end;
  }
}

function integer(value: string | null) {
  if (!value || !/^\d{1,16}$/.test(value)) return;
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number;
}

function findLayout(xml: Document, size: number, imageMime: "image/jpeg" | "image/avif" | "image/heic") {
  const descriptions = Array.from(xml.getElementsByTagNameNS(rdf, "Description"));
  const property = (name: string) => {
    for (const description of descriptions) {
      const value = description.getAttributeNS(camera, name)
        ?? description.getElementsByTagNameNS(camera, name)[0]?.textContent;
      if (value !== undefined && value !== null) return value.trim();
    }
  };
  const directories = xml.getElementsByTagNameNS(container, "Directory");
  const enabled = property("MotionPhoto");
  if (imageMime === "image/jpeg" && !directories.length && enabled === undefined && property("MicroVideo") === "1") {
    const length = integer(property("MicroVideoOffset") ?? null);
    if (length) return { stillEnd: size - length, videoStart: size - length, mime: "video/mp4" };
  }
  if ((enabled !== undefined && enabled !== "1") || directories.length !== 1) return;
  const sequence = directories[0]?.getElementsByTagNameNS(rdf, "Seq")[0];
  if (!sequence) return;
  const entries = Array.from(sequence.children).map((entry) =>
    entry.getElementsByTagNameNS(container, "Item")[0] ?? entry);
  const first = entries[0];
  const last = entries.at(-1);
  if (entries.length < 2 || first?.getAttributeNS(item, "Semantic") !== "Primary"
    || first.getAttributeNS(item, "Mime") !== imageMime || integer(first.getAttributeNS(item, "Length") ?? "0") !== 0
    || last?.getAttributeNS(item, "Semantic") !== "MotionPhoto") return;
  const mime = last.getAttributeNS(item, "Mime");
  if (mime !== "video/mp4" && mime !== "video/quicktime") return;
  const padding = integer(first.getAttributeNS(item, "Padding") ?? "0");
  const videoLength = integer(last.getAttributeNS(item, "Length"));
  if (padding === undefined || !videoLength) return;
  let stillEnd = size - padding;
  for (const entry of entries.slice(1)) {
    const semantic = entry.getAttributeNS(item, "Semantic");
    const length = integer(entry.getAttributeNS(item, "Length"));
    if (length === undefined || semantic === "Primary" || semantic === "MotionPhoto" && entry !== last) return;
    stillEnd -= length;
    if (stillEnd < 4) return;
  }
  return { stillEnd, videoStart: size - videoLength, mime };
}

export async function importMotionPhoto(source: File): Promise<{ still: File; clip: File } | undefined> {
  if (source.size < 20 || source.size > maxOriginalPhotoBytes + maxTelegramUploadBytes) return;
  const signature = new DataView(await source.slice(0, 8).arrayBuffer());
  const jpeg = signature.getUint16(0) === 0xffd8;
  if (!jpeg && signature.getUint32(4) !== 0x66747970) return;
  const image = jpeg ? undefined : await readIsobmffMotionPhoto(source);
  const imageMime = jpeg ? "image/jpeg" : image?.mime;
  const xmp = jpeg ? await jpegXmp(source) : image?.xmp;
  if (!imageMime || !xmp || /<!DOCTYPE/i.test(xmp)) return;
  const xml = new DOMParser().parseFromString(xmp, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) return;
  const layout = findLayout(xml, source.size, imageMime);
  if (!layout) return;
  const { stillEnd, videoStart, mime } = layout;
  const videoLength = source.size - videoStart;
  if (stillEnd < 4 || stillEnd > maxOriginalPhotoBytes || videoStart < stillEnd
    || videoLength < 16 || videoLength > maxTelegramUploadBytes) return;
  if (jpeg) {
    const eoi = new Uint8Array(await source.slice(stillEnd - 2, stillEnd).arrayBuffer());
    if (eoi[0] !== 0xff || eoi[1] !== 0xd9) return;
  } else if (!image || stillEnd !== image.stillEnd || videoStart !== image.videoStart) return;
  const videoHeader = new DataView(await source.slice(videoStart, videoStart + 16).arrayBuffer());
  if (videoHeader.getUint32(4) !== 0x66747970 || videoHeader.getUint32(0) < 16 || videoHeader.getUint32(0) > videoLength) return;
  const name = source.name.replace(/\.[^.]+$/, "") || "motion-photo";
  return {
    still: new File([source.slice(0, stillEnd)], `${name}.${jpeg ? "jpg" : imageMime === "image/heic" ? "heic" : "avif"}`, { type: imageMime }),
    clip: new File([source.slice(videoStart)], `${name}.${mime === "video/mp4" ? "mp4" : "mov"}`, { type: mime }),
  };
}
