import { CommanderError } from "./errors.ts";
import type { Entry } from "./model.ts";
import type { ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { toBig } from "./size.ts";

/** Content asked for in one window, in bytes. */
export const MAX_VIEW_BYTES = 1024 * 1024;
/** Largest serialized response of a view: the owner RPC JSON, or the agent tool's full result. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Largest image the owner view assembles from chunks. The agent never gets image bytes. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const HEAD_BYTES = 512;
const HEX_WIDTH = 16;
const encoder = new TextEncoder();
/** C0 controls except tab, newline and carriage return; DEL; C1 controls. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** An <svg> element at the XML root, after an optional declaration, comments and doctype. */
const SVG_ROOT = /^﻿?\s*(?:<\?xml\b[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg(?=[\s/>])/i;

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export const VIEW_KINDS = ["text", "image", "binary"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** Who reads: the owner gets images, the agent gets text and hex only. */
export type Audience = "owner" | "agent";

/** Version of the file a window came from. Every window of one view must carry the same version. */
export type Version = Pick<Entry, "size" | "mtimeNs">;

export function sameVersion(a: Version, b: Version): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export interface ViewWindow {
  /** Image when the head has an image signature or an SVG root; otherwise text or binary. */
  kind: ViewKind;
  /** The window is valid text, so the text mode is offered whatever the kind (SVG source, for one). */
  text: boolean;
  mime?: ImageMime;
  bytes: Uint8Array;
  offset: bigint;
  size: bigint;
  truncated: boolean;
  version: Version;
}

/** What the viewer renders. Text is shown as source, never as markup. */
export type ViewModel =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mime: ImageMime; bytes: Uint8Array; truncated: boolean }
  | { kind: "binary"; lines: string[]; truncated: boolean; shown: number; total: string };

/** One representation of a window, the representations the file offers, and the file version. */
export interface ViewResult {
  model: ViewModel;
  modes: ViewKind[];
  version: Version;
}

/** JSON of a reply. A chunk carries raw image bytes for the owner's assembly and is never rendered. */
export type WireBody =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mime: ImageMime; base64: string; truncated: boolean }
  | { kind: "binary"; lines: string[]; truncated: boolean; shown: number; total: string }
  | { kind: "chunk"; offset: string; base64: string; truncated: boolean };

export interface WireView {
  version: Version;
  modes: ViewKind[];
  view: WireBody;
}

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return magic.length <= head.length && magic.every((byte, index) => head[index] === byte);
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, index) => head[offset + index] === char.charCodeAt(0));
}

function rasterMime(head: Uint8Array): ImageMime | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && asciiAt(head, 8, "WEBP")) return "image/webp";
  return null;
}

/** SVG is an image only when its root element is <svg>; the name alone decides nothing. */
function isSvg(head: Uint8Array): boolean {
  return SVG_ROOT.test(new TextDecoder("utf-8").decode(head));
}

export function mimeFor(head: Uint8Array): ImageMime | undefined {
  const raster = rasterMime(head);
  if (raster) return raster;
  return isSvg(head) ? "image/svg+xml" : undefined;
}

/**
 * Strict UTF-8 without control characters (tab, newline and carriage return excepted).
 * At the end of the whole file (`final`) an incomplete sequence is an error; in the
 * middle of a file it is held back, so a window ends on a character boundary.
 */
function isText(bytes: Uint8Array, final: boolean): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !final });
  } catch {
    return false;
  }
  return !CONTROL.test(text);
}

/** Classifies a window by its name and bytes. Names are data; the bytes decide the content. */
export function detectKind(bytes: Uint8Array, final: boolean): ViewKind {
  if (mimeFor(bytes.subarray(0, HEAD_BYTES))) return "image";
  return isText(bytes, final) ? "text" : "binary";
}

/**
 * Hex dump: `offset  xx xx … xx  |ascii|`, 16 bytes per line, 8 bytes per half. A short
 * last line keeps its columns, so the ASCII column stays aligned.
 */
export function hexLines(bytes: Uint8Array, offset: bigint): string[] {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += HEX_WIDTH) {
    const chunk = bytes.subarray(start, start + HEX_WIDTH);
    const slots = Array.from({ length: HEX_WIDTH }, (_, index) =>
      index < chunk.length ? chunk[index]!.toString(16).padStart(2, "0").toUpperCase() : "  ");
    const address = (offset + BigInt(start)).toString(16).padStart(8, "0").toUpperCase();
    const ascii = Array.from(chunk, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${address}  ${slots.slice(0, 8).join(" ")}  ${slots.slice(8).join(" ")}  |${ascii}|`);
  }
  return lines;
}

/** Last path segment as text; binary-only names give an empty string. */
export function entryName(path: ResourcePath): string {
  const last = path.segments.at(-1);
  return last && "t" in last ? last.t : "";
}

/**
 * Reads one window of a file. The version is taken from stat before the read, the read
 * is checked against it (or against `expect`, a version from an earlier window of the
 * same view), and a final stat must show the same version. Any change is changed_since_plan.
 */
export async function readForView(
  provider: FileProvider,
  path: ResourcePath,
  opts: { offset: bigint; length: number; expect?: Version },
  signal: AbortSignal,
): Promise<ViewWindow> {
  if (opts.offset < 0n || !Number.isSafeInteger(opts.length) || opts.length <= 0) {
    throw new RangeError("Invalid view window");
  }
  const entry = await provider.stat(path, signal);
  if (!entry) throw new CommanderError("not_found", "Entry not found");
  if (entry.kind === "dir") throw new CommanderError("is_a_directory", "Expected a file");
  if (entry.kind !== "file") throw new CommanderError("unsupported", "Only regular files can be viewed");

  const version: Version = { size: entry.size, mtimeNs: entry.mtimeNs };
  if (opts.expect && !sameVersion(opts.expect, version)) throw changed();
  const size = toBig(entry.size);
  const length = Math.min(opts.length, MAX_VIEW_BYTES);
  const bytes = await provider.read(path, opts.offset, length, version, signal);

  const after = await provider.stat(path, signal);
  if (!after || after.kind !== "file" || !sameVersion(version, { size: after.size, mtimeNs: after.mtimeNs })) throw changed();

  const truncated = opts.offset + BigInt(bytes.byteLength) < size;
  const mime = mimeFor(bytes.subarray(0, HEAD_BYTES));
  return {
    kind: detectKind(bytes, !truncated),
    text: isText(bytes, !truncated),
    ...(mime ? { mime } : {}),
    bytes,
    offset: opts.offset,
    size,
    truncated,
    version,
  };
}

function changed(): CommanderError {
  return new CommanderError("changed_since_plan", "File changed while it was viewed");
}

function decodeText(bytes: Uint8Array, final: boolean): string {
  return new TextDecoder("utf-8").decode(bytes, { stream: !final });
}

export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** Bytes of the response as the owner RPC or the agent tool sends it. */
export function responseBytes(wire: WireView, audience: Audience): number {
  const json = JSON.stringify(wire);
  // The tool result is {content:[{type:"text", text}]}: the JSON text is escaped once more.
  const sent = audience === "agent" ? JSON.stringify({ content: [{ type: "text", text: json }] }) : json;
  return encoder.encode(sent).byteLength;
}

function prefixOf(window: ViewWindow, length: number): ViewWindow {
  return { ...window, bytes: window.bytes.subarray(0, length), truncated: window.truncated || length < window.bytes.length };
}

function textBody(window: ViewWindow): WireBody {
  return { kind: "text", text: decodeText(window.bytes, !window.truncated), truncated: window.truncated };
}

function binaryBody(window: ViewWindow): WireBody {
  return {
    kind: "binary", lines: hexLines(window.bytes, window.offset), truncated: window.truncated,
    shown: window.bytes.length, total: window.size.toString(),
  };
}

function imageBody(window: ViewWindow): WireBody {
  const mime = window.mime ?? mimeFor(window.bytes.subarray(0, HEAD_BYTES));
  if (!mime) throw new CommanderError("unsupported", "Not an image");
  return { kind: "image", mime, base64: base64Of(window.bytes), truncated: window.truncated };
}

function chunkBody(window: ViewWindow): WireBody {
  return { kind: "chunk", offset: window.offset.toString(), base64: base64Of(window.bytes), truncated: window.truncated };
}

/** Largest prefix of the window whose reply fits MAX_RESPONSE_BYTES, found by binary search. */
function fitPrefix(window: ViewWindow, make: (window: ViewWindow) => WireBody, measure: (body: WireBody) => number): WireBody {
  let low = 0;
  let high = window.bytes.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(make(prefixOf(window, middle))) <= MAX_RESPONSE_BYTES) low = middle;
    else high = middle - 1;
  }
  return make(prefixOf(window, low));
}

/**
 * Largest chunk whose reply fits. Base64 takes 4 characters per 3 bytes and needs no JSON escaping,
 * so the size follows from the reply without a search. The room is measured with an empty chunk
 * flagged `truncated: false`: a chunk that reaches the end of the file is one character longer
 * than one that does not, so the larger reply sets the budget.
 */
function fitChunk(window: ViewWindow, measure: (body: WireBody) => number): WireBody {
  const room = MAX_RESPONSE_BYTES - measure({ kind: "chunk", offset: window.offset.toString(), base64: "", truncated: false });
  const length = Math.min(window.bytes.length, Math.floor(Math.floor(room / 4) * 3));
  return chunkBody(prefixOf(window, length));
}

/**
 * The reply for one window. Modes offered: text when the window is valid text (any kind),
 * image for the owner at offset 0 when the file is an image of at most 32 MiB, and binary
 * always. An image whose whole content does not fit the reply comes as chunks, which the
 * owner joins into one blob with the same version on every chunk (see assembleImage).
 */
export function replyFor(window: ViewWindow, requested: ViewKind | "auto", audience: Audience): WireView {
  const modes: ViewKind[] = [];
  if (window.text) modes.push("text");
  if (audience === "owner" && window.kind === "image" && window.offset === 0n && window.size <= BigInt(MAX_IMAGE_BYTES)) modes.push("image");
  modes.push("binary");

  const measure = (body: WireBody) => responseBytes({ version: window.version, modes, view: body }, audience);
  const reply = (body: WireBody): WireView => ({ version: window.version, modes, view: body });

  // Owner chunks after the first one: the window is raw bytes of the image.
  if (audience === "owner" && requested === "image" && window.offset > 0n) {
    return reply(fitChunk(window, measure));
  }
  const chosen: ViewKind = requested !== "auto" && modes.includes(requested) ? requested
    : modes.includes("image") ? "image" : modes.includes("text") ? "text" : "binary";

  if (chosen === "image") {
    // Only a window of the whole file is an image; a part of a larger file comes as chunks.
    const whole = imageBody(window);
    if (!window.truncated && measure(whole) <= MAX_RESPONSE_BYTES) return reply(whole);
    return reply(fitChunk(window, measure));
  }
  if (chosen === "text") return reply(fitPrefix(window, textBody, (body) => measure(body)));
  return reply(fitPrefix(window, binaryBody, (body) => measure(body)));
}

function modelOf(body: WireBody): ViewModel {
  if (body.kind === "chunk") throw new CommanderError("internal", "A chunk is joined into an image first");
  if (body.kind === "image") return { kind: "image", mime: body.mime, bytes: bytesOf(body.base64), truncated: body.truncated };
  if (body.kind === "text") return { kind: "text", text: body.text, truncated: body.truncated };
  return { kind: "binary", lines: body.lines, truncated: body.truncated, shown: body.shown, total: body.total };
}

export function fromWire(wire: WireView): ViewResult {
  return { model: modelOf(wire.view), modes: wire.modes, version: wire.version };
}

/**
 * Joins an owner image from chunks. The first reply decides: a whole image is returned as
 * is. Otherwise every further chunk is requested with the version of the first reply, so
 * a change of the file between chunks fails with changed_since_plan instead of mixing versions.
 */
export async function assembleImage(
  first: WireView,
  fetchChunk: (offset: bigint, expect: Version) => Promise<WireView>,
): Promise<ViewResult> {
  if (first.view.kind !== "chunk") return fromWire(first);
  const size = BigInt(first.version.size);
  if (size > BigInt(MAX_IMAGE_BYTES)) throw new CommanderError("limit_exceeded", "Image is larger than 32 MiB");

  const parts: Uint8Array[] = [];
  let reply = first;
  let offset = 0n;
  for (;;) {
    if (reply.view.kind !== "chunk") throw new CommanderError("internal", "Image chunk expected");
    if (!sameVersion(reply.version, first.version)) throw changed();
    if (reply.view.offset !== offset.toString()) throw new CommanderError("internal", "Image chunk is not at the requested offset");
    const part = bytesOf(reply.view.base64);
    if (part.byteLength === 0) throw new CommanderError("internal", "Empty image chunk");
    parts.push(part);
    offset += BigInt(part.byteLength);
    if (offset >= size) break;
    reply = await fetchChunk(offset, first.version);
  }
  if (offset !== size) throw new CommanderError("internal", "Image chunks do not add up to the file size");
  const bytes = new Uint8Array(Number(offset));
  let position = 0;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.byteLength;
  }
  const mime = mimeFor(bytes.subarray(0, HEAD_BYTES));
  if (!mime) throw new CommanderError("unsupported", "Not an image");
  return { model: { kind: "image", mime, bytes, truncated: false }, modes: first.modes, version: first.version };
}
