import { CommanderError } from "./errors.ts";
import type { ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { toBig } from "./size.ts";

/** Largest content window a single view or agent read asks for, in bytes. */
export const MAX_VIEW_BYTES = 1024 * 1024;
/** Largest serialized response (JSON, UTF-8) of a view, for both the RPC and the agent tool. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const HEAD_BYTES = 512;
const HEX_WIDTH = 16;
const encoder = new TextEncoder();
/** C0 controls except tab, newline and carriage return; DEL; C1 controls. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export const VIEW_KINDS = ["text", "image", "binary"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export interface ViewWindow {
  kind: ViewKind;
  /** MIME type for image windows; SVG is an image and is shown only through img. */
  mime?: ImageMime;
  bytes: Uint8Array;
  offset: bigint;
  size: bigint;
  truncated: boolean;
}

/** What the viewer renders. Text is shown as source, never as markup. */
export type ViewModel =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mime: ImageMime; bytes: Uint8Array; truncated: boolean }
  | { kind: "binary"; lines: string[]; truncated: boolean };

/** One representation of a window plus every representation the file offers. */
export interface ViewResult {
  model: ViewModel;
  modes: ViewKind[];
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

function isSvg(name: string, head: Uint8Array): boolean {
  if (/\.svg$/i.test(name)) return true;
  return /<svg[\s>]/i.test(new TextDecoder("utf-8").decode(head));
}

/**
 * True for valid UTF-8 without control characters (tab, newline and carriage return
 * excepted). Streaming decode holds back an incomplete multi-byte sequence at the end.
 */
function isText(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return false;
  }
  return !CONTROL.test(text);
}

export function mimeFor(name: string, head: Uint8Array): ImageMime | undefined {
  const raster = rasterMime(head);
  if (raster) return raster;
  return isSvg(name, head) ? "image/svg+xml" : undefined;
}

/** Classifies a window by its name and bytes. Names are data; the bytes decide the content. */
export function detectKind(name: string, bytes: Uint8Array): ViewKind {
  if (mimeFor(name, bytes.subarray(0, HEAD_BYTES))) return "image";
  return isText(bytes) ? "text" : "binary";
}

/** Formats bytes as `offset  xx xx …`, 16 bytes per line, without padding the last line. */
export function hexLines(bytes: Uint8Array, offset: bigint): string[] {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += HEX_WIDTH) {
    const chunk = bytes.subarray(start, start + HEX_WIDTH);
    const address = (offset + BigInt(start)).toString(16).padStart(8, "0");
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${address}  ${hex}`);
  }
  return lines;
}

/** Last path segment as text; binary-only names give an empty string. */
export function entryName(path: ResourcePath): string {
  const last = path.segments.at(-1);
  return last && "t" in last ? last.t : "";
}

/**
 * Reads one window of a file for viewing. The length is capped at MAX_VIEW_BYTES;
 * `truncated` tells the caller that more bytes exist past the returned window.
 */
export async function readForView(
  provider: FileProvider,
  path: ResourcePath,
  opts: { offset: bigint; length: number },
  signal: AbortSignal,
): Promise<ViewWindow> {
  if (opts.offset < 0n || !Number.isSafeInteger(opts.length) || opts.length <= 0) {
    throw new RangeError("Invalid view window");
  }
  const entry = await provider.stat(path, signal);
  if (!entry) throw new CommanderError("not_found", "Entry not found");
  if (entry.kind === "dir") throw new CommanderError("is_a_directory", "Expected a file");
  if (entry.kind !== "file") throw new CommanderError("unsupported", "Only regular files can be viewed");

  const size = toBig(entry.size);
  const length = Math.min(opts.length, MAX_VIEW_BYTES);
  // The fingerprint from stat makes every window come from the same version of the file.
  const expect = { size: entry.size, mtimeNs: entry.mtimeNs };
  const bytes = await provider.read(path, opts.offset, length, expect, signal);
  const name = entryName(path);
  const kind = detectKind(name, bytes);
  const mime = kind === "image" ? mimeFor(name, bytes.subarray(0, HEAD_BYTES)) : undefined;

  return {
    kind,
    ...(mime ? { mime } : {}),
    bytes,
    offset: opts.offset,
    size,
    truncated: opts.offset + BigInt(bytes.byteLength) < size,
  };
}

/** Turns a window into one representation of it. */
export function viewModel(name: string, view: ViewWindow): ViewModel {
  if (view.kind === "image") {
    const mime = view.mime ?? mimeFor(name, view.bytes.subarray(0, HEAD_BYTES));
    if (!mime) throw new RangeError("Image window without a known image type");
    return { kind: "image", mime, bytes: view.bytes, truncated: view.truncated };
  }
  if (view.kind === "text") {
    return { kind: "text", text: new TextDecoder("utf-8").decode(view.bytes), truncated: view.truncated };
  }
  return { kind: "binary", lines: hexLines(view.bytes, view.offset), truncated: view.truncated };
}

/** JSON form of a view. Image bytes travel as base64. */
export type WireBody =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mime: ImageMime; base64: string; truncated: boolean }
  | { kind: "binary"; lines: string[]; truncated: boolean };

export interface WireView {
  modes: ViewKind[];
  view: WireBody;
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

function bodyOf(model: ViewModel): WireBody {
  if (model.kind === "image") return { kind: "image", mime: model.mime, base64: base64Of(model.bytes), truncated: model.truncated };
  if (model.kind === "text") return { kind: "text", text: model.text, truncated: model.truncated };
  return { kind: "binary", lines: model.lines, truncated: model.truncated };
}

function modelOf(body: WireBody): ViewModel {
  if (body.kind === "image") return { kind: "image", mime: body.mime, bytes: bytesOf(body.base64), truncated: body.truncated };
  if (body.kind === "text") return { kind: "text", text: body.text, truncated: body.truncated };
  return { kind: "binary", lines: body.lines, truncated: body.truncated };
}

export function toWire(result: ViewResult): WireView {
  return { modes: result.modes, view: bodyOf(result.model) };
}

export function fromWire(wire: WireView): ViewResult {
  return { modes: wire.modes, model: modelOf(wire.view) };
}

/** Bytes of the JSON response, as the tool and RPC send it. */
export function responseBytes(wire: WireView): number {
  return encoder.encode(JSON.stringify(wire)).byteLength;
}

function prefixOf(window: ViewWindow, length: number): ViewWindow {
  return { ...window, bytes: window.bytes.subarray(0, length), truncated: window.truncated || length < window.bytes.length };
}

/** Largest prefix of the window whose response fits MAX_RESPONSE_BYTES, found by binary search. */
function fitPrefix(name: string, window: ViewWindow, kind: ViewKind, modes: ViewKind[]): ViewModel {
  const fits = (length: number) =>
    responseBytes({ modes, view: bodyOf(viewModel(name, { ...prefixOf(window, length), kind })) }) <= MAX_RESPONSE_BYTES;
  let low = 0;
  let high = window.bytes.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return viewModel(name, { ...prefixOf(window, low), kind });
}

/**
 * Chooses what to show for a window. Text and image windows also offer hex, so the
 * owner can switch. An image is offered only when it fits the response whole; otherwise
 * the window is shown as hex. A requested mode that the file does not offer falls back
 * to the file's own kind.
 */
export function viewFor(name: string, window: ViewWindow, requested: ViewKind | "auto" = "auto"): ViewResult {
  const imageFits = window.kind === "image" && window.mime !== undefined
    && responseBytes({ modes: ["image", "binary"], view: bodyOf(viewModel(name, window)) }) <= MAX_RESPONSE_BYTES;
  const modes: ViewKind[] = [];
  if (window.kind === "text") modes.push("text");
  if (imageFits) modes.push("image");
  modes.push("binary");

  const chosen = requested !== "auto" && modes.includes(requested) ? requested : modes[0]!;
  if (chosen === "image") return { modes, model: viewModel(name, window) };
  return { modes, model: fitPrefix(name, window, chosen, modes) };
}
