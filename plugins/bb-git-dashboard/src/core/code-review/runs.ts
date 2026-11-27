/**
 * Rules of the review's AI runs that need no host. Ported from diff-review server/runs.ts (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md. Changed: the copy's fingerprint is taken from the uncommitted view's diff the host reads.
 */
import type { ReviewDiff } from "./diff.ts";
import type { RunKind } from "./model.ts";

/** The permission modes a run may start in: BB's "Approve for me" (`auto`) and "Accept edits". */
export const RUN_PERMISSION_MODES = ["auto", "accept-edits"] as const;
export type RunPermissionMode = (typeof RUN_PERMISSION_MODES)[number];
/** The longest run summary kept, in characters. */
export const SUMMARY_MAX_CHARS = 4_000;
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The setting's mode, or `auto` when it holds anything else. */
export function runPermissionMode(value: string): RunPermissionMode {
  return (RUN_PERMISSION_MODES as readonly string[]).includes(value) ? value as RunPermissionMode : "auto";
}

/**
 * The mode a run's thread starts in: the setting's when its provider supports it (or BB does not say), otherwise
 * full. BB refuses a mode the provider lacks, and the owner chose a run in full mode over one that fails.
 */
export function spawnPermissionMode(configured: RunPermissionMode, supported: readonly string[] | null): RunPermissionMode | "full" {
  return supported === null || supported.includes(configured) ? configured : "full";
}

/** A model's default reasoning as a level BB's spawn takes; one it does not know runs at medium. */
export function reasoningLevel(effort: string): ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(effort) ? effort as ReasoningLevel : "medium";
}

/** Runs that only read and comment: they are watched for edits, and may open comment threads. */
export const readsOnly = (kind: RunKind) => kind !== "fix";

/** One short hash per changed file of the uncommitted view: what the file's change is, not the change itself. */
export function fingerprint(diff: ReviewDiff): Record<string, string> {
  return Object.fromEntries(diff.files.map(file => [file.path,
    hash([file.changeKind, file.previousPath ?? "", file.additions, file.deletions, file.binary, file.patch ?? ""].join("\u0000"))]));
}

/** Files whose uncommitted change differs between two fingerprints, sorted. */
export function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}

/** "1-4, 11-12" for a set of line numbers. */
export function ranges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(sorted[index] === sorted[end] ? String(sorted[index]) : sorted[index] + "-" + sorted[end]);
    index = end + 1;
  }
  return parts.join(", ");
}

/** FNV-1a, 64 bits as hex: enough to tell two versions of a file's change apart. */
function hash(text: string): string {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, "0");
}
