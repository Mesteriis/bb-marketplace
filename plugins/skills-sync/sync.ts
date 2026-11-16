// The skills-sync engine facade.
//
// The implementation is split by responsibility so git transport, tree
// comparison, diff generation, marker IO, and applying skills can evolve
// independently. This module keeps the original public engine surface for
// callers and owns only the prepare/status/diff orchestration.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Source } from "./contract";
import { SyncError } from "./sync-error";
import {
  ensureRepo,
  materialiseTree,
  readFetchedAt,
  readCommits,
  resolveRef,
} from "./sync-git";
import { bucketSkills, listUpstreamSkills } from "./sync-buckets";
import { catalogueSkills } from "./sync-catalogue";
import { diffTrees } from "./sync-diff";
import { readMarker } from "./sync-marker";

export type {
  Bucket,
  CatalogueEntry,
  Commit,
  Prepared,
  SkillStatus,
  SourceStatus,
  UpstreamSkill,
} from "./sync-types";
export type { ApplyResult } from "./sync-apply";
export { SyncError } from "./sync-error";
export {
  ensureRepo,
  git,
  materialiseTree,
  readFetchedAt,
  readCommits,
  resolveRef,
} from "./sync-git";
export {
  bucketSkills,
  listLocalSkills,
  listUpstreamSkills,
  normalise,
  splitCosmetic,
} from "./sync-buckets";
export { catalogueSkills, readFrontmatterDescription } from "./sync-catalogue";
export { changedFiles, listFiles } from "./sync-files";
export { diffTrees, unifiedDiff } from "./sync-diff";
export { readMarker, writeMarker } from "./sync-marker";
export type { MarkerFileOps } from "./sync-marker";
export { applySkills, assertPlainName } from "./sync-apply";

import type { Prepared, SourceStatus, UpstreamSkill } from "./sync-types";
import { assertPlainName } from "./sync-apply";

export async function prepare(
  source: Source,
  cacheRoot: string,
  refresh: boolean,
): Promise<Prepared> {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const repoDir = await ensureRepo(cacheRoot, source, refresh);
  const head = await resolveRef(repoDir, source.ref);
  const pinnedRaw = readMarker(source);
  const treesRoot = path.join(cacheRoot, source.id, "trees");

  let pinned: string | null = null;
  let pinDir: string | null = null;
  if (pinnedRaw !== null) {
    try {
      pinned = await resolveRef(repoDir, pinnedRaw);
    } catch {
      throw new SyncError(
        `${source.marker} pins "${pinnedRaw}", which is not a commit in ${source.url}.` +
          ` Fetch with --refresh, or correct the marker file.`,
      );
    }
    pinDir = await materialiseTree(repoDir, pinned, source.skillsDir, treesRoot);
  }
  const headDir = await materialiseTree(repoDir, head, source.skillsDir, treesRoot);
  const commits = await readCommits(repoDir, pinned, head);

  return {
    source,
    cacheRoot,
    repoDir,
    head,
    pinned,
    pinDir,
    headDir,
    commits,
    fetchedAt: readFetchedAt(repoDir),
  };
}

/**
 * @param autoFetchHours the configured schedule, 0 when off. Passed in rather
 * than read here: this module knows nothing about settings, and the UI cannot
 * judge whether a cache age is normal without knowing the policy that governs it.
 */
export function statusFrom(prepared: Prepared, autoFetchHours = 0): SourceStatus {
  const { skills, foreign } = bucketSkills(
    prepared.source,
    prepared.headDir,
    prepared.pinDir,
    prepared.source.installRoot,
  );
  return {
    sourceId: prepared.source.id,
    pinned: prepared.pinned,
    head: prepared.head,
    commits: prepared.commits,
    skills,
    foreign,
    catalogue: catalogueSkills(
      prepared.source,
      prepared.headDir,
      prepared.source.installRoot,
      skills,
    ),
    fetchedAt: prepared.fetchedAt,
    autoFetchHours,
  };
}

export function diffSkill(
  prepared: Prepared,
  name: string,
  kind: "upstream" | "local",
): string {
  assertPlainName(name);
  const head = listUpstreamSkills(prepared.headDir, prepared.source);
  const pin =
    prepared.pinDir === null
      ? new Map<string, UpstreamSkill>()
      : listUpstreamSkills(prepared.pinDir, prepared.source);
  const pinDir = pin.get(name)?.dir ?? null;

  if (kind === "upstream") {
    const headDir = head.get(name)?.dir ?? null;
    if (pinDir === null && headDir === null) {
      throw new SyncError(`"${name}" is not an upstream skill of ${prepared.source.id}.`);
    }
    return diffTrees(pinDir, headDir, `a/${name}`, `b/${name}`);
  }

  const localDir = path.join(prepared.source.installRoot, name);
  if (!fs.existsSync(localDir)) {
    throw new SyncError(`"${name}" is not installed in ${prepared.source.installRoot}.`);
  }
  if (pinDir === null && !head.has(name)) {
    throw new SyncError(
      `"${name}" has no upstream match in ${prepared.source.id}: it belongs to another origin.`,
    );
  }
  return diffTrees(pinDir, localDir, `pinned/${name}`, `local/${name}`);
}
