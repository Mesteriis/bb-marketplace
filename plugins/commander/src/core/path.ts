/// <reference lib="es2024.string" />

import { z } from "zod";
import { CommanderError } from "./errors.ts";

function isValidSegment(name: string): boolean {
  return !name.includes("/") && !name.includes("\0") && name !== "." && name !== "..";
}

export function canonicalBase64(maxLength: number) {
  return z.string().min(1).max(maxLength, { abort: true }).refine((value) => {
    try {
      return btoa(atob(value)) === value;
    } catch {
      return false;
    }
  }, { abort: true });
}

function isRawName(base64: string): boolean {
  const bytes = atob(base64);
  if (!isValidSegment(bytes)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)));
    return false;
  } catch {
    return true;
  }
}

export const NameSegment = z.union([
  z.object({
    t: z.string().min(1).max(1024).refine((name) => name.isWellFormed()).refine(isValidSegment),
  }).strict(),
  z.object({
    b: canonicalBase64(1400).refine(isRawName),
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

const DISPLAY_ESCAPE = /[\\\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function displayPath(path: ResourcePath): string {
  const segments = path.segments.map((name) => {
    if ("t" in name) {
      return name.t.replace(DISPLAY_ESCAPE, (char) => {
        if (char === "\\") return "\\\\";
        const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        return "\\u{" + hex + "}";
      });
    }
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
