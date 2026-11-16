// Pure helpers shared by the Skills Sync panel. No React, no rpc: everything
// here is a plain function over the `status` payload so the view stays thin
// and the rules (which bucket acts, what counts as cosmetic) are testable.
import type { rpcContract } from "@/contract";
import type { StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk";

export type Status = StandardSchemaV1InferOutput<
  (typeof rpcContract)["status"]["output"]
>;
export type SkillStatus = Status["skills"][number];
export type Bucket = SkillStatus["bucket"];
export type Source = StandardSchemaV1InferOutput<
  (typeof rpcContract)["listSources"]["output"]
>["sources"][number];

/** Section order and framing, top to bottom. */
export const SECTIONS: ReadonlyArray<{
  bucket: Bucket;
  title: string;
  /** One line under the title explaining what the user is looking at. */
  blurb: string;
  /** Rows offer a checkbox only where applying is a safe, meaningful action. */
  selectable: boolean;
  /** Starts folded away: nothing in it needs a decision. */
  collapsedByDefault: boolean;
}> = [
  {
    bucket: "new",
    title: "New",
    blurb: "Upstream has these; you have never installed them.",
    selectable: true,
    collapsedByDefault: false,
  },
  {
    bucket: "deprecated",
    title: "Deprecated",
    blurb: "Upstream retired these. Remove them yourself if you agree.",
    selectable: false,
    collapsedByDefault: false,
  },
  {
    bucket: "clean",
    title: "Clean updates",
    blurb: "Your copy still matches the pin, so overwriting loses nothing.",
    selectable: true,
    collapsedByDefault: false,
  },
  {
    bucket: "dirty-conflict",
    title: "Needs a merge",
    blurb: "You edited these and upstream moved them too.",
    selectable: false,
    collapsedByDefault: false,
  },
  {
    bucket: "dirty-only",
    title: "Your edits, untouched upstream",
    blurb: "Upstream did not move these, so there is nothing to decide.",
    selectable: false,
    collapsedByDefault: true,
  },
];

/** A change upstream made to the skill that is not only punctuation. */
export function isEntirelyCosmetic(skill: SkillStatus): boolean {
  return skill.cosmeticFiles.length > 0 && skill.substantiveFiles.length === 0;
}

/** The compact right-hand line on a row: what actually changed, in words. */
export function changeSummary(skill: SkillStatus): string {
  if (skill.bucket === "new") return "not installed yet";
  if (skill.bucket === "deprecated") return "gone from upstream";
  if (isEntirelyCosmetic(skill)) return "punctuation only";
  const parts: string[] = [];
  if (skill.substantiveFiles.length > 0) {
    parts.push(`${fileCount(skill.substantiveFiles.length)} changed`);
  }
  if (skill.cosmeticFiles.length > 0) {
    parts.push(`${skill.cosmeticFiles.length} cosmetic`);
  }
  if (skill.bucket !== "clean" && skill.localEditedFiles.length > 0) {
    parts.push(`${fileCount(skill.localEditedFiles.length)} edited by you`);
  }
  return parts.length === 0 ? "no file changes" : parts.join(", ");
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

export function skillsIn(status: Status, bucket: Bucket): SkillStatus[] {
  return status.skills.filter((skill) => skill.bucket === bucket);
}

/** Names that start out ticked: the clean updates, which are safe to take. */
export function defaultSelection(status: Status): string[] {
  return skillsIn(status, "clean").map((skill) => skill.name);
}

/**
 * The marker may only move to HEAD once nothing upstream changed is left
 * behind. New and clean skills the user chose to skip still count as pending,
 * and every conflict does — moving the pin past them would lose the fact that
 * they still need a merge. Deprecated and dirty-only skills never block: there
 * is no upstream change left to apply for them.
 */
export function hasNothingLeftBehind(
  status: Status,
  selected: ReadonlySet<string>,
): boolean {
  return status.skills.every((skill) => {
    if (skill.bucket === "dirty-conflict") return false;
    if (skill.bucket === "new" || skill.bucket === "clean") {
      return selected.has(skill.name);
    }
    return true;
  });
}

export function shortSha(sha: string | null): string {
  return sha === null ? "unpinned" : sha.slice(0, 7);
}

/** One file's slice of a possibly multi-file unified patch. */
export interface PatchFile {
  path: string;
  patch: string;
}

/**
 * The host diff viewer takes exactly one file, so a `git diff` covering a whole
 * skill folder is cut on its `diff --git` headers. Text before the first header
 * (or a patch with no header at all) is kept as a single unnamed chunk rather
 * than dropped.
 */
export function splitPatch(patch: string, fallbackPath: string): PatchFile[] {
  const trimmed = patch.trim();
  if (trimmed === "") return [];
  const lines = patch.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (starts.length === 0) return [{ path: fallbackPath, patch }];
  const files: PatchFile[] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    files.push({ path: pathFromHeader(lines[start], fallbackPath), patch: body });
  });
  return files;
}

/** `diff --git a/x/y b/x/y` -> `x/y`, preferring the b-side (post-image). */
function pathFromHeader(header: string, fallbackPath: string): string {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (match === null) return fallbackPath;
  return match[2];
}

/**
 * Where an agent-assisted merge has got to. `ready` means a merged copy is
 * staged outside the skills folder; only accepting it writes anything.
 */
export type Merge = StandardSchemaV1InferOutput<
  (typeof rpcContract)["mergeState"]["output"]
>;

export type CatalogueEntry = Status["catalogue"][number];

/** One recoverable copy `apply` made before overwriting a local edit. */
export type Backup = NonNullable<
  StandardSchemaV1InferOutput<(typeof rpcContract)["apply"]["output"]>["backups"]
>[number];

/** With no schedule running, nothing keeps the cache current, so it ages fast. */
export const MANUAL_STALE_AFTER_MS = 60 * 60 * 1000;

/** Slack on top of the schedule before a late fetch counts as stale. */
const SCHEDULE_GRACE_MS = 15 * 60 * 1000;

/**
 * How old a cache may be before its SHA stops being trustworthy.
 *
 * Under a schedule this tracks the schedule: six hours is unremarkable on a
 * six-hourly fetch and alarming on an hourly one. A fixed threshold would mark
 * every healthy state stale under a slow schedule, and a warning that is always
 * on tells the user nothing.
 */
export function staleAfterMs(autoFetchHours: number): number {
  if (autoFetchHours <= 0) return MANUAL_STALE_AFTER_MS;
  return autoFetchHours * 60 * 60 * 1000 + SCHEDULE_GRACE_MS;
}

/** How old the cached clone's last `git fetch` is, in words. */
export interface FetchAge {
  /** "checked 4 minutes ago", "never checked". */
  label: string;
  /** True when the SHA next to it must not be read as a live answer. */
  stale: boolean;
}

export function fetchAge(
  fetchedAt: number | null,
  now: number,
  autoFetchHours = 0,
): FetchAge {
  if (fetchedAt === null) return { label: "never checked", stale: true };
  // A clock skew that puts the fetch in the future still reads as recent.
  const age = Math.max(0, now - fetchedAt);
  return {
    label: `checked ${inWords(age)}`,
    stale: age >= staleAfterMs(autoFetchHours),
  };
}

function inWords(age: number): string {
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

function plural(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

/** Buckets that mean "upstream moved and someone still has to decide". */
const OUTSTANDING: ReadonlySet<Bucket> = new Set<Bucket>([
  "new",
  "clean",
  "dirty-conflict",
]);

/**
 * Skills waiting on a decision. A conflict counts: upstream really did move,
 * and of all the outstanding work it is the case that most needs a human, so
 * showing nothing for it hid exactly the wrong thing. Dirty-only skills have
 * nothing to decide, a deprecated skill has no upstream change left to take,
 * and a catalogue entry the user already declined is not news.
 */
export function outstandingCount(status: Status): number {
  return status.skills.filter((skill) => OUTSTANDING.has(skill.bucket)).length;
}

/**
 * The names to apply, in a stable order: the status buckets first, then any
 * catalogue-only pick. Catalogue rows share this one selection, so an entry
 * with no matching skill row would otherwise be silently dropped.
 */
export function selectionOrder(
  status: Status,
  selected: ReadonlySet<string>,
): string[] {
  const names = status.skills
    .filter((skill) => selected.has(skill.name))
    .map((skill) => skill.name);
  const seen = new Set(names);
  for (const entry of status.catalogue) {
    if (selected.has(entry.name) && !seen.has(entry.name)) {
      seen.add(entry.name);
      names.push(entry.name);
    }
  }
  return names;
}
