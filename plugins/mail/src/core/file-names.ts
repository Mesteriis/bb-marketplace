// Safe file names and content types (moved from src/adapters/bb/downloads.ts
// in slice 3g, behaviour unchanged): pure, so the core's project paths and the
// adapters share one copy.
import { removeControls, removeInvisible } from "./html-entities.ts";

/** Longest file name offered, in characters. */
export const FILE_NAME_MAX = 120;
/** Longest extension kept when a name is shortened. */
const EXTENSION_MAX = 16;
/** Most characters of a sender-controlled name or subject looked at. */
export const NAME_INPUT_MAX = 1024;

/** Splits "name.ext" where the extension is short and not the whole name. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  const extension = name.slice(dot);
  return Array.from(extension).length <= EXTENSION_MAX ? [name.slice(0, dot), extension] : [name, ""];
}

/** The first `max` UTF-16 units, without a half surrogate pair at the end. */
export function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Drops leading and trailing dots and spaces with index scans (no backtracking regex). */
export function trimDots(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "." || text[start] === " ")) start++;
  while (end > start && (text[end - 1] === "." || text[end - 1] === " ")) end--;
  return text.slice(start, end);
}

/** Characters Windows does not allow in a file name (path separators are handled apart). */
const WINDOWS_RESERVED = /[:*?<>|"]/g;

/**
 * A file name safe to offer: only the part after the last path separator,
 * without control, bidi, zero-width or Windows-reserved characters,
 * whitespace collapsed, leading and trailing dots dropped, at most 120
 * characters with the extension kept; `fallback` when nothing is left. Only
 * the first 1024 characters of `name` are looked at.
 */
export function sanitizeFileName(name: string | null, fallback: string): string {
  let clean = headOf(name ?? "", NAME_INPUT_MAX).normalize("NFC").replace(/[\t\r\n]/g, " ");
  clean = removeInvisible(removeControls(clean)).replace(WINDOWS_RESERVED, "");
  clean = clean.split(/[/\\]/).pop() ?? "";
  clean = trimDots(clean.replace(/\s+/g, " "));
  if (clean === "") return fallback;
  const chars = Array.from(clean);
  if (chars.length <= FILE_NAME_MAX) return clean;
  const [stem, extension] = splitExtension(clean);
  const keep = FILE_NAME_MAX - Array.from(extension).length;
  return `${Array.from(stem).slice(0, keep).join("").trimEnd()}${extension}`;
}

/** Inert types passed through as stored; anything else is application/octet-stream. */
const INERT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/calendar",
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
/** Office Open XML and OpenDocument files; the `xml` in their names is a zip container. */
const OFFICE_TYPE =
  /^application\/vnd\.(openxmlformats-officedocument\.[a-z.]{1,60}|oasis\.opendocument\.[a-z.]{1,60})$/;
/** audio/* and video/* with a plain subtype (no +xml or similar suffix). */
const MEDIA_TYPE = /^(audio|video)\/[a-z0-9][a-z0-9.-]{0,60}$/;

/** The stored MIME type when it is on the inert allow-list; else application/octet-stream. */
export function safeContentType(mimeType: string): string {
  const type = mimeType.trim().toLowerCase();
  if (INERT_TYPES.has(type) || OFFICE_TYPE.test(type)) return type;
  if (MEDIA_TYPE.test(type) && !/xml|html|script/.test(type)) return type;
  return "application/octet-stream";
}
