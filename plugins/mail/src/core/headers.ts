// Header and MIME-structure rendering for the Details panel, from a raw
// message. Pure: the bytes come from the gateway's fetchRaw. Everything here
// is attacker-controlled text, so the output is plain text only: unfolded,
// RFC 2047 words decoded, control and bidi characters removed, and capped.
import { removeControls, removeInvisible } from "./html-entities.ts";

/** Most characters of header names and values returned for one message. */
export const HEADERS_MAX_CHARS = 256 * 1024;
/** The pair that ends a header list cut at HEADERS_MAX_CHARS. */
export const HEADERS_TRUNCATED: [string, string] = ["…", "truncated"];
/** Most lines of a MIME structure; one more line says the rest was left out. */
export const STRUCTURE_MAX_LINES = 200;
/** Deepest MIME nesting walked; deeper parts are not listed. */
const STRUCTURE_MAX_DEPTH = 16;
/** Longest filename shown in a structure line. */
const STRUCTURE_NAME_MAX = 200;

const utf8 = new TextDecoder("utf-8");

/**
 * The raw bytes as a string with one char per byte (each byte keeps its
 * position), for finding header ends and boundaries without decoding.
 */
function binaryString(raw: Uint8Array, start = 0, end = raw.byteLength): string {
  let text = "";
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    text += String.fromCharCode(...raw.subarray(i, Math.min(i + CHUNK, end)));
  }
  return text;
}

/** Index where the header block of `bin` from `start` ends, and where the body starts. */
function headerEnd(bin: string, start: number, end: number): { headerEnd: number; bodyStart: number } {
  // An empty header block: the body starts right away.
  if (bin.startsWith("\r\n", start)) return { headerEnd: start, bodyStart: start + 2 };
  if (bin.startsWith("\n", start)) return { headerEnd: start, bodyStart: start + 1 };
  const crlf = bin.indexOf("\r\n\r\n", start);
  const lf = bin.indexOf("\n\n", start);
  const candidates: { headerEnd: number; bodyStart: number }[] = [];
  if (crlf >= 0 && crlf < end) candidates.push({ headerEnd: crlf, bodyStart: crlf + 4 });
  if (lf >= 0 && lf < end) candidates.push({ headerEnd: lf, bodyStart: lf + 2 });
  if (candidates.length === 0) return { headerEnd: end, bodyStart: end };
  return candidates.reduce((a, b) => (a.headerEnd <= b.headerEnd ? a : b));
}

/** Header fields as [name, raw unfolded value], in order. */
function parseFields(block: string): [string, string][] {
  const fields: [string, string][] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = fields[fields.length - 1];
      // Unfolding removes the line break only; the leading space stays.
      if (last) last[1] += line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return fields;
}

/** Bytes of a base64 text, or null when it is not base64. */
function base64Bytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes of an RFC 2047 Q text. */
function qBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "_") bytes.push(0x20);
    else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** Text of bytes in a named charset, or null for a charset this runtime does not know. */
function decodeCharset(bytes: Uint8Array, charset: string): string | null {
  try {
    return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    return null;
  }
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded words. Whitespace between two adjacent encoded
 * words is dropped, and adjacent words in one charset are decoded together,
 * so a character split across words survives. A word in an unknown charset
 * or with bad base64 stays as it was.
 */
export function decodeEncodedWords(text: string): string {
  let out = "";
  let last = 0;
  let pending: { charset: string; bytes: number[]; source: string } | null = null;
  const flush = () => {
    if (pending === null) return;
    out += decodeCharset(Uint8Array.from(pending.bytes), pending.charset) ?? pending.source;
    pending = null;
  };
  for (const match of text.matchAll(ENCODED_WORD)) {
    const index = match.index;
    const gap = text.slice(last, index);
    // RFC 2231 language suffix: charset*lang.
    const charset = match[1]!.split("*")[0]!;
    const bytes = /[Bb]/.test(match[2]!) ? base64Bytes(match[3]!) : qBytes(match[3]!);
    const adjacent = pending !== null && /^[ \t\r\n]*$/.test(gap);
    if (!adjacent) {
      flush();
      out += gap;
    }
    if (bytes === null) {
      flush();
      out += match[0];
    } else if (pending !== null && pending.charset.toLowerCase() === charset.toLowerCase()) {
      pending.bytes.push(...bytes);
      pending.source += match[0];
    } else {
      flush();
      pending = { charset, bytes: [...bytes], source: match[0] };
    }
    last = index + match[0].length;
  }
  flush();
  return out + text.slice(last);
}

/** One line of plain text: no control, bidi or zero-width characters, whitespace collapsed. */
function plain(text: string): string {
  return removeInvisible(removeControls(text.replace(/[\t\r\n]/g, " ")))
    .replace(/\s+/g, " ")
    .trim();
}

/** The top-level header block of a raw message, decoded as UTF-8 (invalid bytes replaced). */
function topHeaderBlock(raw: Uint8Array): string {
  // Headers are short; look for their end in the first megabyte only.
  const scan = binaryString(raw, 0, Math.min(raw.byteLength, 1024 * 1024));
  const { headerEnd: end } = headerEnd(scan, 0, scan.length);
  return utf8.decode(raw.subarray(0, end));
}

/**
 * The message's header fields in order as [name, value] plain text: unfolded,
 * RFC 2047 words decoded. Names and values together are capped at
 * `maxChars`; a cut list ends with HEADERS_TRUNCATED.
 */
export function readHeaders(raw: Uint8Array, maxChars = HEADERS_MAX_CHARS): [string, string][] {
  const pairs: [string, string][] = [];
  let used = 0;
  for (const [rawName, rawValue] of parseFields(topHeaderBlock(raw))) {
    const name = plain(rawName);
    const value = plain(decodeEncodedWords(rawValue));
    const room = maxChars - used;
    if (name.length + value.length > room) {
      if (room > name.length) pairs.push([name, value.slice(0, room - name.length)]);
      pairs.push(HEADERS_TRUNCATED);
      return pairs;
    }
    pairs.push([name, value]);
    used += name.length + value.length;
  }
  return pairs;
}

/**
 * The first top-level header field with this name (case-insensitive),
 * unfolded and trimmed but not decoded; null when there is none.
 */
export function headerValue(raw: Uint8Array, name: string): string | null {
  const wanted = name.toLowerCase();
  const field = parseFields(topHeaderBlock(raw)).find(([n]) => n.toLowerCase() === wanted);
  return field ? field[1].replace(/\s+/g, " ").trim() : null;
}

/** A Message-ID as compared: trimmed, without its angle brackets. */
export function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<\s*/, "").replace(/\s*>$/, "");
}

/** Splits a header value at `;` outside quoted strings. */
function splitParams(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted && char === "\\" && i + 1 < value.length) {
      current += char + value[++i];
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** Bytes of an RFC 2231 percent-encoded value. */
function percentBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return bytes;
}

/**
 * A structured header value (Content-Type, Content-Disposition): its
 * lowercased token and its parameters, RFC 2231 continuations and charsets
 * and RFC 2047 words in quoted values decoded.
 */
export function parseStructuredHeader(value: string): { token: string; params: Map<string, string> } {
  const [first = "", ...rest] = splitParams(value);
  const segments = new Map<string, { index: number; encoded: boolean; value: string }[]>();
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!match) continue;
    const list = segments.get(match[1]!) ?? [];
    list.push({
      index: match[2] === undefined ? 0 : Number(match[2]),
      encoded: match[3] === "*",
      value: unquote(part.slice(eq + 1)),
    });
    segments.set(match[1]!, list);
  }
  const params = new Map<string, string>();
  for (const [name, list] of segments) {
    list.sort((a, b) => a.index - b.index);
    if (!list.some((s) => s.encoded)) {
      params.set(name, decodeEncodedWords(list.map((s) => s.value).join("")));
      continue;
    }
    let charset = "utf-8";
    const bytes: number[] = [];
    list.forEach((segment, i) => {
      let text = segment.value;
      if (i === 0 && segment.encoded) {
        const quote = /^([^']*)'[^']*'/.exec(text);
        if (quote) {
          if (quote[1] !== "") charset = quote[1]!;
          text = text.slice(quote[0].length);
        }
      }
      if (segment.encoded) bytes.push(...percentBytes(text));
      else for (let c = 0; c < text.length; c++) bytes.push(text.charCodeAt(c) & 0xff);
    });
    const decoded = decodeCharset(Uint8Array.from(bytes), charset) ?? utf8.decode(Uint8Array.from(bytes));
    params.set(name, decoded);
  }
  return { token: first.trim().toLowerCase(), params };
}

/** "512 B", "12.3 KB", "4.0 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortName(name: string): string {
  const clean = plain(name);
  const chars = Array.from(clean);
  return chars.length > STRUCTURE_NAME_MAX ? `${chars.slice(0, STRUCTURE_NAME_MAX).join("")}…` : clean;
}

type Walk = { raw: Uint8Array; bin: string; lines: string[]; cut: boolean };

function walkPart(walk: Walk, start: number, end: number, depth: number): void {
  if (walk.lines.length >= STRUCTURE_MAX_LINES) {
    walk.cut = true;
    return;
  }
  const { headerEnd: hEnd, bodyStart } = headerEnd(walk.bin, start, end);
  const fields = parseFields(utf8.decode(walk.raw.subarray(start, hEnd)));
  const field = (name: string) => fields.find(([n]) => n.toLowerCase() === name)?.[1] ?? null;
  const contentType = parseStructuredHeader(field("content-type") ?? "text/plain");
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType.token)
    ? contentType.token
    : "text/plain";
  const disposition = field("content-disposition");
  const parsedDisposition = disposition === null ? null : parseStructuredHeader(disposition);
  const filename = parsedDisposition?.params.get("filename") ?? contentType.params.get("name") ?? null;
  const size = Math.max(0, end - bodyStart);

  const parts = [type];
  if (parsedDisposition && /^[a-z-]+$/.test(parsedDisposition.token)) parts.push(parsedDisposition.token);
  if (filename !== null && plain(filename) !== "") parts.push(`"${shortName(filename)}"`);
  parts.push(formatSize(size));
  walk.lines.push(`${"  ".repeat(depth)}${parts.join(" · ")}`);

  if (depth + 1 >= STRUCTURE_MAX_DEPTH) return;
  const boundary = contentType.params.get("boundary");
  if (type.startsWith("multipart/") && boundary) {
    for (const [partStart, partEnd] of multipartRanges(walk.bin, bodyStart, end, boundary)) {
      walkPart(walk, partStart, partEnd, depth + 1);
    }
  } else if (type === "message/rfc822" && bodyStart < end) {
    walkPart(walk, bodyStart, end, depth + 1);
  }
}

/** Byte ranges of a multipart body's parts, without the line break before each delimiter. */
function multipartRanges(bin: string, start: number, end: number, boundary: string): [number, number][] {
  const delimiter = `--${boundary}`;
  const ranges: [number, number][] = [];
  let partStart: number | null = null;
  let from = start;
  while (from < end) {
    const at = bin.indexOf(delimiter, from);
    if (at < 0 || at >= end) break;
    from = at + delimiter.length;
    const atLineStart = at === start || bin[at - 1] === "\n";
    if (!atLineStart) continue;
    if (partStart !== null) {
      let partEnd = at;
      if (bin[partEnd - 1] === "\n") partEnd--;
      if (bin[partEnd - 1] === "\r") partEnd--;
      ranges.push([partStart, Math.max(partStart, partEnd)]);
      partStart = null;
    }
    if (bin.startsWith("--", from)) break;
    const lineEnd = bin.indexOf("\n", from);
    if (lineEnd < 0 || lineEnd >= end) break;
    partStart = lineEnd + 1;
    from = partStart;
  }
  // A body without its closing delimiter: the last part runs to the end.
  if (partStart !== null && partStart < end) ranges.push([partStart, end]);
  return ranges;
}

/**
 * The MIME tree as indented plain-text lines, one per part: type,
 * disposition, filename and body size (encoded bytes). At most
 * STRUCTURE_MAX_LINES lines, then "…".
 */
export function describeStructure(raw: Uint8Array): string[] {
  const walk: Walk = { raw, bin: binaryString(raw), lines: [], cut: false };
  walkPart(walk, 0, raw.byteLength, 0);
  if (walk.cut) walk.lines.push("…");
  return walk.lines;
}
