import { z } from "zod";
import { CommanderError } from "./errors.ts";

function isValidSegment(name: string): boolean {
  return !name.includes("/") && !name.includes("\0") && name !== "." && name !== "..";
}

function isRawName(base64: string): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes: string;
  try {
    bytes = atob(base64);
  } catch {
    return false;
  }

  if (!isValidSegment(bytes)) return false;

  try {
    decoder.decode(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)));
    return false;
  } catch {
    return true;
  }
}

export const NameSegment = z.union([
  z.object({ t: z.string().min(1).max(1024).refine(isValidSegment) }).strict(),
  z.object({
    b: z.string().max(1400).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(isRawName, { abort: true }),
  }).strict(),
]);
export type NameSegment = z.infer<typeof NameSegment>;

const SEGMENT_LIMIT = 4096;

export const ResourcePath = z.object({
  segments: z.array(NameSegment).max(SEGMENT_LIMIT),
}).strict();
export type ResourcePath = z.infer<typeof ResourcePath>;

function invalidPath(): CommanderError {
  return new CommanderError("invalid_path", "Invalid resource path");
}

export function parsePosix(text: string): ResourcePath {
  if (!text.startsWith("/")) throw invalidPath();
  const segments = text === "/" ? [] : text.slice(1).split("/").map((t) => ({ t }));
  const parsed = ResourcePath.safeParse({ segments });
  if (!parsed.success) throw invalidPath();
  return parsed.data;
}

export function displayPath(path: ResourcePath): string {
  const segments = path.segments.map((name) => {
    if ("t" in name) return name.t;
    return Array.from(atob(name.b), (byte) => {
      return "\\x" + byte.charCodeAt(0).toString(16).padStart(2, "0");
    }).join("");
  });
  return "/" + segments.join("/");
}

export function join(path: ResourcePath, name: NameSegment): ResourcePath {
  if (path.segments.length >= SEGMENT_LIMIT || !NameSegment.safeParse(name).success) {
    throw invalidPath();
  }
  return { segments: [...path.segments, name] };
}

export function parent(path: ResourcePath): ResourcePath | null {
  if (path.segments.length === 0) return null;
  return { segments: path.segments.slice(0, -1) };
}

function sameSegment(a: NameSegment, b: NameSegment, caseSensitive: boolean): boolean {
  if ("b" in a && "b" in b) return atob(a.b) === atob(b.b);
  if (!("t" in a && "t" in b)) return false;
  if (caseSensitive) return a.t === b.t;
  return a.t.normalize("NFC").toLowerCase() === b.t.normalize("NFC").toLowerCase();
}

export function isAncestorOrSelf(a: ResourcePath, b: ResourcePath, caseSensitive: boolean): boolean {
  return a.segments.length <= b.segments.length
    && a.segments.every((name, index) => sameSegment(name, b.segments[index], caseSensitive));
}

export function samePath(a: ResourcePath, b: ResourcePath, caseSensitive: boolean): boolean {
  return a.segments.length === b.segments.length && isAncestorOrSelf(a, b, caseSensitive);
}
