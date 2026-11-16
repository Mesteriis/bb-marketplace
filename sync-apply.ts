import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { listUpstreamSkills, bucketSkills } from "./sync-buckets";
import { changedFiles } from "./sync-files";
import { resolveInstallEntry, resolveInstallRoot, writeMarker } from "./sync-marker";
import { SyncError } from "./sync-error";
import type { Prepared, SkillStatus, UpstreamSkill } from "./sync-types";

export interface ApplyResult {
  applied: string[];
  /** Per-skill failures only. */
  failed: Array<{ name: string; error: string }>;
  /** Recoverable copies made before local edits were overwritten. */
  backups: Array<{ name: string; path: string }>;
  /** Why the marker was not bumped, or null when no refusal happened. */
  markerRefusal: string | null;
  marker: string | null;
}

/** A skill name is a single folder name, never a path. */
export function assertPlainName(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".")
  ) {
    throw new SyncError(`"${name}" is not a valid skill folder name.`);
  }
}

function markerBumpRefusal(
  unresolved: Array<Pick<SkillStatus, "name" | "bucket">>,
): string {
  const details = unresolved
    .map((skill) => `${skill.name} (${skill.bucket})`)
    .join(", ");
  return (
    `Refusing to bump the marker: unresolved upstream work remains — ${details}. ` +
    "Apply every new or clean skill and resolve every dirty-conflict before bumping."
  );
}

function localEditOverwriteRefusal(name: string): string {
  return (
    `"${name}" has local edits that would be discarded; it needs a hand merge or ` +
    "an explicit override, so refusing to overwrite it."
  );
}

/** Apply must enforce the source policy at the write boundary. */
function isUpstreamSkillInSkippedBucket(
  source: Prepared["source"],
  upstream: UpstreamSkill,
): boolean {
  return source.skipBuckets.includes(upstream.bucket);
}

function skippedBucketRefusal(name: string, bucket: string): string {
  return (
    `upstream "${name}" is in the "${bucket}" bucket configured in skipBuckets; ` +
    "refusing to install it."
  );
}

/** Save one local skill before a destructive replacement. */
export function saveLocalBackup(
  prepared: Prepared,
  name: string,
  localDir: string,
): string {
  const cacheRoot = path.resolve(prepared.cacheRoot);
  const installRoot = resolveInstallRoot(prepared.source);
  const relativeToInstall = path.relative(installRoot, cacheRoot);
  if (
    relativeToInstall === "" ||
    (!relativeToInstall.startsWith(`..${path.sep}`) && relativeToInstall !== "..")
  ) {
    throw new SyncError(
      `backup for "${name}" would be inside installRoot; refusing to discard local edits.`,
    );
  }
  const backupDir = path.join(
    cacheRoot,
    "backups",
    name,
    `${Date.now()}-${randomUUID()}`,
  );
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  fs.cpSync(localDir, backupDir, { recursive: true, errorOnExist: true, force: false });
  return backupDir;
}

/** Detect data loss from local content, independently of the bucket label. */
function wouldDiscardLocalEdits(
  name: string,
  initialByName: ReadonlyMap<string, SkillStatus>,
  head: ReadonlyMap<string, UpstreamSkill>,
  installRoot: string,
): boolean {
  const status = initialByName.get(name);
  const upstream = head.get(name);
  return (
    status !== undefined &&
    status.localEditedFiles.length > 0 &&
    upstream !== undefined &&
    changedFiles(upstream.dir, path.join(installRoot, name)).length > 0
  );
}

/**
 * Install or overwrite an EXPLICIT list of names. It reads `installRoot` to
 * detect local edits, but never removes a folder that has no upstream match.
 * The marker is written last and only when every name landed and the
 * recomputed buckets have no upstream work left behind.
 */
export function applySkills(
  prepared: Prepared,
  names: string[],
  bumpMarker: boolean,
  allowConflictOverwrite = false,
): ApplyResult {
  const head = listUpstreamSkills(prepared.headDir, prepared.source);
  const installRoot = resolveInstallRoot(prepared.source);
  // This read-only snapshot protects local edits before any requested
  // folder can be removed. The later recomputation remains the marker gate.
  const initial = bucketSkills(
    prepared.source,
    prepared.headDir,
    prepared.pinDir,
    installRoot,
  );
  const initialByName = new Map(initial.skills.map((skill) => [skill.name, skill]));
  const applied: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const backups: Array<{ name: string; path: string }> = [];

  for (const name of names) {
    try {
      assertPlainName(name);
      const upstream = head.get(name);
      if (upstream === undefined) {
        throw new SyncError(
          `"${name}" has no folder in ${prepared.source.id} at ${prepared.head.slice(0, 12)}.` +
            ` Refusing: it is either foreign or retired upstream, and apply never touches those.`,
        );
      }
      if (isUpstreamSkillInSkippedBucket(prepared.source, upstream)) {
        throw new SyncError(skippedBucketRefusal(name, upstream.bucket));
      }
      const discardsLocalEdits = wouldDiscardLocalEdits(
        name,
        initialByName,
        head,
        installRoot,
      );
      if (discardsLocalEdits && !allowConflictOverwrite) {
        throw new SyncError(localEditOverwriteRefusal(name));
      }
      if (!fs.existsSync(path.join(upstream.dir, "SKILL.md"))) {
        // A skill folder without SKILL.md is not a skill; refuse rather than
        // overwrite an install with something unusable.
        throw new SyncError(`upstream "${name}" has no SKILL.md; refusing to install it.`);
      }
      const localDir = path.join(installRoot, name);
      if (discardsLocalEdits) {
        const backupPath = saveLocalBackup(prepared, name, localDir);
        backups.push({ name, path: backupPath });
      }
      const dest = resolveInstallEntry(prepared.source, name, "Skill name");
      fs.mkdirSync(installRoot, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(upstream.dir, dest, { recursive: true });
      applied.push(name);
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let marker: string | null = prepared.pinned;
  let markerRefusal: string | null = null;
  if (bumpMarker && failed.length === 0 && names.length > 0) {
    // Recompute after applying. The pin must not advance over a skill that the
    // caller omitted, and no dirty conflict may remain at the instant of the
    // marker write. Use a set because the CLI accepts repeated --skill flags.
    const appliedNames = new Set(applied);
    const current = bucketSkills(
      prepared.source,
      prepared.headDir,
      prepared.pinDir,
      installRoot,
    );
    const unresolved = current.skills.filter(
      (skill) =>
        skill.bucket === "dirty-conflict" ||
        ((skill.bucket === "new" || skill.bucket === "clean") &&
          !appliedNames.has(skill.name)),
    );
    if (unresolved.length > 0) {
      markerRefusal = markerBumpRefusal(unresolved);
    } else {
      writeMarker(prepared.source, prepared.head);
      marker = prepared.head;
    }
  }
  return { applied, failed, backups, markerRefusal, marker };
}
