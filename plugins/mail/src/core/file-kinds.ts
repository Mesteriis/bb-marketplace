// Attachment kinds (slice 3h): what the Files view filters by, what the
// viewer may show, and what the first bytes of a file really are. Pure: the
// server's view route and the tests share the sniffer.
//
// `fileKindOf` matches migration element 13's backfill CASE arm for arm, in
// the same order. SVG is filed as an image but is never viewable (spec
// resolution 13): a same-origin blob of it could run scripts.
import type { FileKind } from "./model.ts";

/** What the viewer shows at most, in bytes (spec "Attachment viewer"). */
export const VIEW_CAPS = { image: 20 * 1024 * 1024, pdf: 25 * 1024 * 1024, textShown: 2 * 1024 * 1024 } as const;

/** The bytes the sniffer reads. */
export const SNIFF_BYTES = 8192;

const ARCHIVE_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-tar",
]);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
]);
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/x-patch",
  "application/x-diff",
]);

/** The media type without parameters, lower case. */
function baseType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** The kind of a stored attachment; the same arms as migration element 13. */
export function fileKindOf(mimeType: string, filename: string | null): FileKind {
  const mime = mimeType.toLowerCase();
  const name = filename?.toLowerCase() ?? null;
  if (mime === "application/pdf" || (name !== null && name.endsWith(".pdf"))) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/calendar" || (name !== null && name.endsWith(".ics"))) return "calendar";
  if (mime.startsWith("text/") || TEXT_TYPES.has(mime)) return "text";
  if (ARCHIVE_TYPES.has(mime)) return "archive";
  if (
    mime.startsWith("application/vnd.openxmlformats-officedocument.") ||
    mime.startsWith("application/vnd.oasis.opendocument.") ||
    DOCUMENT_TYPES.has(mime)
  ) {
    return "document";
  }
  return "other";
}

/** Whether the viewer opens it: images (not SVG), PDF, text and calendar (as text). */
export function isViewable(kind: FileKind, mimeType: string): boolean {
  if (kind === "image") return baseType(mimeType) !== "image/svg+xml";
  return kind === "pdf" || kind === "text" || kind === "calendar";
}

export type SniffedKind = FileKind | "svg" | "html";
export type Sniffed = { kind: SniffedKind; mimeType: string };

const startsWith = (data: Uint8Array, at: number, ascii: string): boolean => {
  if (data.length < at + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (data[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
};

/** BMP DIB header sizes; "BM" alone would match ordinary text. */
const BMP_HEADERS: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

function rasterType(data: Uint8Array): string | null {
  if (startsWith(data, 0, "\u0089PNG\r\n\u001a\n")) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (startsWith(data, 0, "GIF87a") || startsWith(data, 0, "GIF89a")) return "image/gif";
  if (startsWith(data, 0, "RIFF") && startsWith(data, 8, "WEBP")) return "image/webp";
  if (startsWith(data, 4, "ftypavif") || startsWith(data, 4, "ftypavis")) return "image/avif";
  if (startsWith(data, 0, "BM") && data.length >= 18) {
    const dib = data[14]! | (data[15]! << 8) | (data[16]! << 16) | (data[17]! << 24);
    if (BMP_HEADERS.has(dib)) return "image/bmp";
  }
  return null;
}

/** The start of the text after a BOM, whitespace, an XML declaration and comments, lower case. */
function markupStart(data: Uint8Array): string {
  const from = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  let text = "";
  for (let i = from; i < Math.min(data.length, from + 1024); i++) text += String.fromCharCode(data[i]!);
  let rest = text.trimStart();
  for (;;) {
    if (rest.startsWith("<?xml")) {
      const end = rest.indexOf("?>");
      if (end === -1) return "";
      rest = rest.slice(end + 2).trimStart();
    } else if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end === -1) return "";
      rest = rest.slice(end + 3).trimStart();
    } else {
      return rest.slice(0, 32).toLowerCase();
    }
  }
}

const HTML_STARTS = ["<!doctype html", "<html", "<head", "<body", "<script", "<iframe"];

function isUtf8(data: Uint8Array): boolean {
  let i = 0;
  while (i < data.length) {
    const byte = data[i]!;
    const need = byte < 0x80 ? 0 : byte >= 0xc2 && byte <= 0xdf ? 1 : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xf0 && byte <= 0xf4 ? 3 : -1;
    if (need === -1) return false;
    for (let k = 1; k <= need; k++) {
      // A character cut by the sniff window is fine.
      if (i + k >= data.length) return true;
      if ((data[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

function declaredCharset(mimeType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(mimeType);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * What the first bytes are, with the type a blob of them may carry: PDF,
 * PNG, JPEG, GIF, WebP, AVIF, BMP, SVG (after a BOM, an XML declaration
 * and comments), HTML, or text (no NUL; valid UTF-8, or any bytes when
 * `declared` names another charset). Null: none of these.
 */
export function sniffType(firstBytes: Uint8Array, declared: string): Sniffed | null {
  const data = firstBytes.subarray(0, SNIFF_BYTES);
  if (startsWith(data, 0, "%PDF-")) return { kind: "pdf", mimeType: "application/pdf" };
  const raster = rasterType(data);
  if (raster !== null) return { kind: "image", mimeType: raster };
  if (data.includes(0)) return null;
  const markup = markupStart(data);
  if (markup.startsWith("<svg")) return { kind: "svg", mimeType: "image/svg+xml" };
  if (HTML_STARTS.some((start) => markup.startsWith(start))) return { kind: "html", mimeType: "text/html" };
  const charset = declaredCharset(declared);
  if (isUtf8(data) || (charset !== null && charset !== "utf-8" && charset !== "utf8")) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return null;
}

/** The sniffed kind alone. */
export function sniffKind(firstBytes: Uint8Array, declared: string): SniffedKind | null {
  return sniffType(firstBytes, declared)?.kind ?? null;
}

/**
 * The kind the viewer may show a stored attachment as, or null (the view
 * route answers 409 not_viewable): the stored kind must be viewable and the
 * sniffed bytes must agree with it. SVG and HTML never agree.
 */
export function viewableAs(stored: FileKind, mimeType: string, sniffed: Sniffed | null): FileKind | null {
  if (sniffed === null || !isViewable(stored, mimeType)) return null;
  switch (stored) {
    case "image":
    case "pdf":
      return sniffed.kind === stored ? stored : null;
    case "text":
    case "calendar":
      return sniffed.kind === "text" ? stored : null;
    default:
      return null;
  }
}
