import * as path from "node:path";
import type { Source } from "./contract";
import { changedFiles, listDirs, readFileOrNull } from "./sync-files";
import type { Bucket, SkillStatus, UpstreamSkill } from "./sync-types";

/** Backend bucket order and human titles, kept beside the bucket policy. */
export const BUCKET_METADATA = [
  { bucket: "new", title: "New upstream (never installed)" },
  { bucket: "clean", title: "Clean updates (local matches the pin — safe to overwrite)" },
  {
    bucket: "dirty-conflict",
    title: "Conflicts (you edited it and upstream moved — needs a hand merge)",
  },
  { bucket: "dirty-only", title: "Your edits only (upstream untouched — nothing to decide)" },
  { bucket: "deprecated", title: "Retired upstream" },
] as const satisfies ReadonlyArray<{ bucket: Bucket; title: string }>;

// ---------------------------------------------------------------------------
// The cosmetic normaliser
// ---------------------------------------------------------------------------

const UNICODE_DASHES = /[\u2010-\u2015\u2212\u2043\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g;
const ODD_SPACES = /[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g;
const ELLIPSIS = /\u2026/g;

/**
 * Collapse punctuation the way a repo-wide style pass changes it. Two files
 * that normalise to the same string differ only in dashes, quoting or
 * whitespace/punctuation runs — that is COSMETIC, not a rewrite.
 */
export function normalise(text: string): string {
  return text
    .replace(UNICODE_DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(ELLIPSIS, "...")
    .replace(ODD_SPACES, " ")
    .replace(/[\'"`]/g, "")
    // Runs of dashes, whitespace and separating punctuation all become one
    // space: `a—b`, `a - b`, `a, b` and `a b` are the same sentence.
    .replace(/[-\s,;:]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Trees on disk
// ---------------------------------------------------------------------------

/**
 * Every skill in a materialised tree, keyed by folder name. `nested` sources
 * put skills at `<skillsDir>/<bucket>/<name>`, flat ones at `<skillsDir>/<name>`.
 * Buckets in `skipBuckets` are still listed — the caller needs to see them to
 * recognise a `deprecated` move — and filtered when bucketing.
 */
export function listUpstreamSkills(
  treeRoot: string,
  source: Source,
): Map<string, UpstreamSkill> {
  const root = path.join(treeRoot, source.skillsDir);
  const found = new Map<string, UpstreamSkill>();
  if (!source.nested) {
    for (const name of listDirs(root)) {
      found.set(name, { name, bucket: "", dir: path.join(root, name) });
    }
    return found;
  }
  for (const bucket of listDirs(root)) {
    for (const name of listDirs(path.join(root, bucket))) {
      // First bucket wins, except that `deprecated` always wins: a skill that
      // exists in two buckets has been retired.
      const existing = found.get(name);
      if (existing !== undefined && existing.bucket === "deprecated") continue;
      found.set(name, {
        name,
        bucket,
        dir: path.join(root, bucket, name),
      });
    }
  }
  return found;
}

/** Local install folders, flat, dotfiles (including the marker) excluded. */
export function listLocalSkills(installRoot: string): string[] {
  return listDirs(installRoot);
}

/**
 * The cosmetic pass. Diff every changed file twice — raw, then normalised.
 * A file that differs raw but matches normalised is punctuation churn.
 */
export function splitCosmetic(
  from: string | null,
  to: string | null,
): { substantiveFiles: string[]; cosmeticFiles: string[] } {
  const substantiveFiles: string[] = [];
  const cosmeticFiles: string[] = [];
  for (const file of changedFiles(from, to)) {
    const left = from === null ? null : readFileOrNull(path.join(from, file));
    const right = to === null ? null : readFileOrNull(path.join(to, file));
    if (left === null || right === null) {
      // An added or removed file is never punctuation churn.
      substantiveFiles.push(file);
      continue;
    }
    if (normalise(left) === normalise(right)) cosmeticFiles.push(file);
    else substantiveFiles.push(file);
  }
  return { substantiveFiles, cosmeticFiles };
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Put every skill in exactly one bucket from the three trees.
 *
 * `pinRoot` is null when the marker file is missing; then nothing can be
 * "clean" (there is no pin to compare against) and every installed skill that
 * upstream still ships is reported as `dirty-conflict` so the user decides.
 */
export function bucketSkills(
  source: Source,
  headRoot: string,
  pinRoot: string | null,
  installRoot: string,
): { skills: SkillStatus[]; foreign: string[] } {
  const head = listUpstreamSkills(headRoot, source);
  const pin = pinRoot === null ? new Map<string, UpstreamSkill>() : listUpstreamSkills(pinRoot, source);
  const local = new Set(listLocalSkills(installRoot));

  const skills: SkillStatus[] = [];
  const foreign: string[] = [];

  const names = new Set<string>([...head.keys(), ...pin.keys(), ...local]);
  for (const name of [...names].sort()) {
    const inHead = head.get(name);
    const inPin = pin.get(name);
    const hasLocal = local.has(name);
    const localDir = path.join(installRoot, name);

    // Not upstream at all: another origin. Never touched, never offered.
    if (inHead === undefined && inPin === undefined) {
      if (hasLocal) foreign.push(name);
      continue;
    }

    const upstreamBucket = inHead?.bucket ?? inPin?.bucket ?? "";
    const skipped = source.skipBuckets.includes(upstreamBucket);

    // Retired upstream: gone from HEAD, or moved under a `deprecated` bucket.
    const retired =
      inPin !== undefined &&
      hasLocal &&
      (inHead === undefined || inHead.bucket === "deprecated");
    if (retired) {
      skills.push({
        name,
        bucket: "deprecated",
        upstreamBucket: inHead?.bucket ?? inPin?.bucket ?? "",
        substantiveFiles: [],
        cosmeticFiles: [],
        localEditedFiles: [],
      });
      continue;
    }

    if (inHead === undefined) {
      // In the pin, gone from HEAD, and not installed: nothing to say.
      continue;
    }

    if (!hasLocal) {
      // Not installed. "new" means "not something you already declined", and
      // declining requires the skill to have been OFFERABLE at pin time. A
      // skill sitting in `in-progress` or `deprecated/` at the pin was never
      // offered, so upstream moving it into a normal bucket is news — the same
      // bucket move that produces `deprecated`, read in the other direction.
      const offerableAtPin =
        inPin !== undefined &&
        !source.skipBuckets.includes(inPin.bucket) &&
        inPin.bucket !== "deprecated";
      if (!offerableAtPin && !skipped && inHead.bucket !== "deprecated") {
        skills.push({
          name,
          bucket: "new",
          upstreamBucket: inHead.bucket,
          substantiveFiles: [],
          cosmeticFiles: [],
          localEditedFiles: [],
        });
      }
      continue;
    }

    // A stale pin must not manufacture conflicts. Any path that updates a
    // skill without moving the marker — a manual copy, an interrupted apply,
    // a second install route — leaves L == H while P sits behind, and the
    // L != P / H != P test would call this a conflict. If the install is
    // byte-identical to HEAD across the whole folder there is no work to do
    // for this skill whatever the pin says, so it lands in no bucket. Note
    // this only changes the report: the marker is never written here.
    if (changedFiles(inHead.dir, localDir).length === 0) continue;

    // Installed and still upstream: compare the three trees file by file.
    const pinDir = inPin === undefined ? null : inPin.dir;
    const localEditedFiles = changedFiles(pinDir, localDir);
    const upstreamChange = splitCosmetic(pinDir, inHead.dir);
    const headMoved =
      upstreamChange.substantiveFiles.length > 0 ||
      upstreamChange.cosmeticFiles.length > 0;
    const localDirty = localEditedFiles.length > 0;

    if (!headMoved && !localDirty) continue; // up to date

    const bucket: SkillStatus["bucket"] = !localDirty
      ? "clean"
      : headMoved
        ? "dirty-conflict"
        : "dirty-only";

    skills.push({
      name,
      bucket,
      upstreamBucket: inHead.bucket,
      substantiveFiles: upstreamChange.substantiveFiles,
      cosmeticFiles: upstreamChange.cosmeticFiles,
      localEditedFiles,
    });
  }

  return { skills, foreign };
}
