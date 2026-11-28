import { CommanderError } from "./errors.ts";
import type { EndpointId, PlanItem } from "./model.ts";
import type { NameSegment } from "./path.ts";

/** Plan-time archive guards (S14). The helper repeats these checks at open; this is the second line. */

export type RefusedReason =
  | "unsafe_name" | "backslash" | "name_encoding" | "link_not_supported" | "link_escapes"
  | "special_file" | "duplicate_name" | "name_collision" | "encrypted_no_password";

export interface ExtractLimits {
  maxTotalBytes: number;
  maxEntries: number;
  maxRatio: number;
}
export const EXTRACT_LIMITS: ExtractLimits = { maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 };

const SEGMENT_BYTES_MAX = 255;
const RATIO_FLOOR = 1024n * 1024n;

type NameInput = string | Uint8Array;

function decode(name: NameInput): string | null {
  if (typeof name === "string") return name.isWellFormed() ? name : null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(name);
  } catch {
    return null;
  }
}

/** Splits a validated name into segments, or reports why it cannot be used. */
function split(name: NameInput): { segments: string[] } | { reason: RefusedReason } {
  const text = decode(name);
  if (text === null) return { reason: "name_encoding" };
  if (text.includes("\\")) return { reason: "backslash" };
  if (text === "" || text.startsWith("/") || /^[A-Za-z]:/.test(text)) return { reason: "unsafe_name" };
  const trimmed = text.endsWith("/") ? text.slice(0, -1) : text;
  if (trimmed === "") return { reason: "unsafe_name" };
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return { reason: "unsafe_name" };
    if (/[\u0000-\u001f\u007f]/.test(segment)) return { reason: "unsafe_name" };
    if (new TextEncoder().encode(segment).length > SEGMENT_BYTES_MAX) return { reason: "unsafe_name" };
  }
  return { segments };
}

export function nameRefusal(name: NameInput): RefusedReason | null {
  const parsed = split(name);
  return "reason" in parsed ? parsed.reason : null;
}

export function checkEntryName(name: NameInput): NameSegment[] | "refused" {
  const parsed = split(name);
  if ("reason" in parsed) return "refused";
  return parsed.segments.map((t) => ({ t }));
}

export interface GuardedEntry {
  kind: "file" | "dir" | "symlink" | "hardlink" | "special";
  name: NameInput;
  link?: NameInput;
  encrypted: boolean;
}

/** Whether a link target leaves the extraction root. */
function linkEscapes(entryName: NameInput, link: NameInput, hard: boolean): boolean {
  const target = decode(link);
  // A target that cannot be read as text or is longer than the helper classifies (4096 bytes) counts as escaping.
  if (target === null || target === "" || new TextEncoder().encode(target).length > 4096 || target.startsWith("/") || target.includes("\\") || /^[A-Za-z]:/.test(target)) return true;
  const entry = split(entryName);
  // A symlink target counts from the directory of the entry, a hardlink target from the archive root.
  const base = hard || !("segments" in entry) ? [] : entry.segments.slice(0, -1);
  const stack = [...base];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return true;
      stack.pop();
    } else stack.push(part);
  }
  return false;
}

/** The reason an entry cannot be extracted, or null when it can. Links are never created in 2a. */
export function classifyEntry(entry: GuardedEntry, opts: { hasPassword: boolean }): RefusedReason | null {
  const name = nameRefusal(entry.name);
  if (name !== null) return name;
  if (entry.kind === "symlink" || entry.kind === "hardlink") {
    // Like the helper: a link without a target, with an empty or an encrypted one cannot be classified, so it escapes.
    return entry.link === undefined || entry.encrypted || linkEscapes(entry.name, entry.link, entry.kind === "hardlink") ? "link_escapes" : "link_not_supported";
  }
  if (entry.kind === "special") return "special_file";
  if (entry.encrypted && !opts.hasPassword) return "encrypted_no_password";
  return null;
}

/**
 * Indexes of entries whose normalized path repeats an earlier one (NFC, and case folding on a
 * case-insensitive target), or that sit below a file entry.
 */
export function findCollisions(
  entries: ReadonlyArray<{ name: NameInput; kind: GuardedEntry["kind"] }>, caseSensitive: boolean,
): Set<number> {
  const collided = new Set<number>();
  const seen = new Map<string, GuardedEntry["kind"]>();
  entries.forEach((entry, index) => {
    const parsed = split(entry.name);
    if (!("segments" in parsed)) return;
    const norm = parsed.segments.map((s) => (caseSensitive ? s.normalize("NFC") : s.normalize("NFC").toLowerCase()));
    for (let i = 1; i < norm.length; i++) {
      if (seen.get(norm.slice(0, i).join("/")) === "file") {
        collided.add(index);
        return;
      }
    }
    const key = norm.join("/");
    if (seen.has(key)) collided.add(index);
    else seen.set(key, entry.kind);
  });
  return collided;
}

export interface ArchiveTotals {
  entries: number;
  totalBytes: bigint;
  compressedBytes: bigint;
}

/** Plan-time check of the declared totals; the helper counts the real bytes while reading. */
export function checkExtractLimits(totals: ArchiveTotals, limits: ExtractLimits): CommanderError | null {
  if (totals.entries > limits.maxEntries) {
    return new CommanderError("limit_exceeded", "Archive has too many entries", false, "too_many_entries");
  }
  if (totals.totalBytes > BigInt(limits.maxTotalBytes)) {
    return new CommanderError("limit_exceeded", "Archive is larger than the extraction limit", false, "total_bytes");
  }
  if (totals.totalBytes >= RATIO_FLOOR && totals.totalBytes > BigInt(limits.maxRatio) * totals.compressedBytes) {
    return new CommanderError(
      "limit_exceeded", `Archive compression ratio exceeds ${limits.maxRatio}:1`, false, "ratio",
    );
  }
  return null;
}

/**
 * Two items of an archive plan that would land on one name in the destination: the names are compared after NFC
 * (and case folding on a case-insensitive endpoint), because an archive may hold both spellings. The refusal names
 * the problem in the archive's own terms instead of the generic overlap text.
 */
export function assertArchiveTargetNames(items: readonly PlanItem[], caseOf: (endpoint: EndpointId) => boolean): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.source?.endpoint.startsWith("archive:") || item.target === null) continue;
    const sensitive = caseOf(item.target.endpoint);
    const key = item.target.endpoint + "\u0001" + item.target.path.segments.map((name) => {
      if ("b" in name) return "b" + name.b;
      const nfc = name.t.normalize("NFC");
      return "t" + (sensitive ? nfc : nfc.toLowerCase());
    }).join("\u0000");
    if (seen.has(key)) {
      throw new CommanderError("invalid_archive", "Two archive entries would get the same name in the destination", false, "name_collision");
    }
    seen.add(key);
  }
}
