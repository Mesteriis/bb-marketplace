import { CommanderError } from "./errors.ts";
import type { ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { toBig } from "./size.ts";

/** Largest window a single view or agent read returns, in bytes. */
export const MAX_VIEW_BYTES = 1024 * 1024;

const HEAD_BYTES = 512;
const HEX_WIDTH = 16;

export type ViewKind = "text" | "image" | "binary";

export interface ViewWindow {
  kind: ViewKind;
  /** MIME type for image windows; SVG is an image and is shown only through img. */
  mime?: string;
  bytes: Uint8Array;
  offset: bigint;
  size: bigint;
  truncated: boolean;
}

/** What the viewer renders. Text is shown as source, never as markup. */
export type ViewModel =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mime: string; bytes: Uint8Array; truncated: boolean }
  | { kind: "binary"; lines: string[]; truncated: boolean };

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return magic.length <= head.length && magic.every((byte, index) => head[index] === byte);
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, index) => head[offset + index] === char.charCodeAt(0));
}

function rasterMime(head: Uint8Array): string | null {
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
 * True for valid UTF-8 without NUL bytes. Streaming decode holds back an incomplete
 * multi-byte sequence at the window end instead of failing on it.
 */
function isText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function mimeFor(name: string, head: Uint8Array): string | undefined {
  const raster = rasterMime(head);
  if (raster) return raster;
  return isSvg(name, head) ? "image/svg+xml" : undefined;
}

/** Classifies a window by its name and first bytes. Names are data; only the bytes decide raster content. */
export function detectKind(name: string, head: Uint8Array): ViewKind {
  if (mimeFor(name, head)) return "image";
  return isText(head) ? "text" : "binary";
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

function nameOf(path: ResourcePath): string {
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
  const bytes = await provider.read(path, opts.offset, length, null, signal);
  const name = nameOf(path);
  const head = bytes.subarray(0, HEAD_BYTES);
  const mime = mimeFor(name, head);
  const kind = detectKind(name, head);

  return {
    kind,
    ...(kind === "image" && mime ? { mime } : {}),
    bytes,
    offset: opts.offset,
    size,
    truncated: opts.offset + BigInt(bytes.byteLength) < size,
  };
}

/** Turns a window into what the viewer shows: source text, an image, or hex lines. */
export function viewModel(name: string, view: ViewWindow): ViewModel {
  if (view.kind === "image") {
    return { kind: "image", mime: view.mime ?? mimeFor(name, view.bytes) ?? "application/octet-stream", bytes: view.bytes, truncated: view.truncated };
  }
  if (view.kind === "text") {
    return { kind: "text", text: new TextDecoder("utf-8").decode(view.bytes), truncated: view.truncated };
  }
  return { kind: "binary", lines: hexLines(view.bytes, view.offset), truncated: view.truncated };
}
