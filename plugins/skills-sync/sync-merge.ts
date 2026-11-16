import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Source } from "./contract";
import { bucketSkills, listUpstreamSkills } from "./sync-buckets";
import { diffTrees } from "./sync-diff";
import { resolveInstallEntry, resolveInstallRoot } from "./sync-marker";
import { SyncError } from "./sync-error";
import type { Prepared } from "./sync-types";
import { assertPlainName, saveLocalBackup } from "./sync-apply";

const MERGE_TOKEN = /^[0-9a-f-]{36}$/;

/**
 * How often a stage is re-read when no filesystem watcher can be attached.
 *
 * This is the unhappy path only. It is slow on purpose: a merge takes minutes,
 * so noticing it a few seconds late costs nothing, and a fast loop over a cache
 * directory would burn CPU for the whole length of the merge.
 */
const MERGE_FALLBACK_POLL_MS = 5_000;

export interface MergeStage {
  token: string;
  dir: string;
  modifiedAt: number;
  ready: boolean;
}

/** A cache directory that is safe for a merge agent to write into. */
export function mergeStageRoot(cacheRoot: string, source: Source, name: string): string {
  assertPlainName(name);
  const sourceKey = Buffer.from(source.id, "utf8").toString("base64url");
  return path.join(path.resolve(cacheRoot), "merges", sourceKey, name);
}

export function mergeStageDir(
  cacheRoot: string,
  source: Source,
  name: string,
  token: string,
): string {
  if (!MERGE_TOKEN.test(token)) throw new SyncError("Invalid merge staging token.");
  return path.join(mergeStageRoot(cacheRoot, source, name), token);
}

/** The title carries the cache-stage identity, so no separate state database is needed. */
export function mergeThreadTitle(source: Source, name: string, token: string): string {
  return `Skills Sync merge [${token}] ${source.id}/${name}`;
}

/** Recover the stage key from a title belonging to this source and skill. */
export function mergeTokenFromThreadTitle(
  source: Source,
  name: string,
  title: string | null,
): string | null {
  const prefix = "Skills Sync merge [";
  const suffix = `] ${source.id}/${name}`;
  if (title === null || !title.startsWith(prefix) || !title.endsWith(suffix)) return null;
  const token = title.slice(prefix.length, -suffix.length);
  return MERGE_TOKEN.test(token) ? token : null;
}

export function newMergeToken(): string {
  return randomUUID();
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || isInside(root, candidate);
}

/** Keep all merge bytes in plugin cache and outside the installed skill tree. */
export function assertMergeStagingLocation(
  cacheRoot: string,
  installRoot: string,
  stagingDir: string,
): void {
  if (!isInside(cacheRoot, stagingDir)) {
    throw new SyncError("Merge staging must be inside the plugin cache.");
  }
  if (isSameOrInside(installRoot, stagingDir)) {
    throw new SyncError("Merge staging must be outside the skills install root.");
  }
}

function isReady(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/** Read only stage directories; an absent stage is not a ready merge. */
export function listMergeStages(
  cacheRoot: string,
  source: Source,
  name: string,
): MergeStage[] {
  const root = mergeStageRoot(cacheRoot, source, name);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && MERGE_TOKEN.test(entry.name))
      .map((entry) => {
        const dir = path.join(root, entry.name);
        let modifiedAt = 0;
        try {
          modifiedAt = fs.statSync(dir).mtimeMs;
        } catch {
          // A concurrent removal simply makes this stage less preferable.
        }
        return { token: entry.name, dir, modifiedAt, ready: isReady(dir) };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

/**
 * A running watch over one merge attempt's stage. `close` is idempotent.
 *
 * `closed` lets a caller see that the watch is already over before it stores
 * the handle: a stage that was ready before the watch began finishes inside
 * this function, and a caller that filed that handle away would be holding a
 * dead watcher that blocks the next real one.
 */
export interface MergeWatcher {
  close: () => void;
  readonly closed: boolean;
}

/**
 * Call `onReady` once the merged SKILL.md appears in THIS attempt's stage,
 * then stop watching.
 *
 * The merge agent announces nothing: writing that file is its only signal. So
 * this side has to be the one that notices, otherwise the only way the panel
 * could learn about a finished merge would be to ask again and again.
 *
 * The watch is tied to one token, not to the skill. An abandoned attempt that
 * is already ready would otherwise close the watch belonging to the merge that
 * is actually running, and that running merge would never be announced.
 */
export function watchMergeStage(
  cacheRoot: string,
  source: Source,
  name: string,
  token: string,
  onReady: () => void,
): MergeWatcher {
  const root = mergeStageRoot(cacheRoot, source, name);
  const stageDir = mergeStageDir(cacheRoot, source, name, token);
  // The agent creates its own token directory inside the root, so the root
  // itself must exist before there is anything a watcher can attach to.
  fs.mkdirSync(root, { recursive: true });

  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const close = (): void => {
    closed = true;
    watcher?.close();
    watcher = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const check = (): void => {
    if (closed) return;
    if (!isReady(stageDir)) return;
    close();
    onReady();
  };

  const pollInstead = (): void => {
    if (closed || timer !== null) return;
    timer = setInterval(check, MERGE_FALLBACK_POLL_MS);
    timer.unref?.();
  };

  try {
    watcher = fs.watch(root, { recursive: true }, check);
    // A watcher that dies mid-merge would strand the panel on "running"
    // forever, so give up on events and go back to asking.
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
      pollInstead();
    });
  } catch {
    pollInstead();
  }

  // The agent may have written the file between the mkdir and the watch.
  check();
  return {
    close,
    get closed() {
      return closed;
    },
  };
}

export function findReadyMergeStageFor(
  prepared: Prepared,
  name: string,
): MergeStage {
  const stage = listMergeStages(prepared.cacheRoot, prepared.source, name).find((candidate) => candidate.ready);
  if (stage === undefined) {
    throw new SyncError(`No ready merge is staged for "${name}".`);
  }
  assertMergeStagingLocation(
    prepared.cacheRoot,
    resolveInstallRoot(prepared.source),
    stage.dir,
  );
  return stage;
}

/** A merge target must still be the same kind of conflict when it is acted on. */
export function assertMergeableConflict(prepared: Prepared, name: string): void {
  const installRoot = resolveInstallRoot(prepared.source);
  const { skills } = bucketSkills(
    prepared.source,
    prepared.headDir,
    prepared.pinDir,
    installRoot,
  );
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill?.bucket !== "dirty-conflict") {
    throw new SyncError(`"${name}" is not an active dirty-conflict merge target.`);
  }
  const head = listUpstreamSkills(prepared.headDir, prepared.source).get(name);
  const pin = prepared.pinDir === null ? undefined : listUpstreamSkills(prepared.pinDir, prepared.source).get(name);
  if (head === undefined || pin === undefined || sourceSkipped(prepared.source, head.bucket)) {
    throw new SyncError(`"${name}" is not an installable upstream merge target.`);
  }
  if (!fs.existsSync(path.join(head.dir, "SKILL.md"))) {
    throw new SyncError(`upstream "${name}" has no SKILL.md; refusing to merge it.`);
  }
  if (!fs.existsSync(path.join(installRoot, name))) {
    throw new SyncError(`"${name}" is not installed in ${installRoot}.`);
  }
}

function sourceSkipped(source: Source, bucket: string): boolean {
  return source.skipBuckets.includes(bucket);
}

export function mergeDiff(prepared: Prepared, name: string): string {
  const localDir = resolveInstallEntry(prepared.source, name, "Skill name");
  if (!fs.existsSync(localDir)) {
    throw new SyncError(`"${name}" is not installed in ${prepared.source.installRoot}.`);
  }
  const stage = findReadyMergeStageFor(prepared, name);
  return diffTrees(localDir, stage.dir, `installed/${name}`, `merged/${name}`);
}

/** Copy only after the existing local folder has been safely backed up. */
export function acceptMerge(prepared: Prepared, name: string): string {
  const installRoot = resolveInstallRoot(prepared.source);
  const localDir = resolveInstallEntry(prepared.source, name, "Skill name");
  const stage = findReadyMergeStageFor(prepared, name);
  const backup = saveLocalBackup(prepared, name, localDir);
  fs.mkdirSync(installRoot, { recursive: true });
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.cpSync(stage.dir, localDir, { recursive: true });
  fs.rmSync(mergeStageRoot(prepared.cacheRoot, prepared.source, name), {
    recursive: true,
    force: true,
  });
  return backup;
}

/** Remove every attempt for this skill, never resolving a path under installRoot. */
export function discardMerge(cacheRoot: string, source: Source, name: string): void {
  const root = mergeStageRoot(cacheRoot, source, name);
  assertMergeStagingLocation(cacheRoot, resolveInstallRoot(source), path.join(root, "stage"));
  fs.rmSync(root, { recursive: true, force: true });
}
