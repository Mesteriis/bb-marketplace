import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Source } from "./contract";
import { SyncError } from "./sync-error";
import type { Commit } from "./sync-types";

const execFileAsync = promisify(execFile);

/** The timestamp sidecar sits beside the bare repository, not inside it. */
export function fetchedAtPath(repoDir: string): string {
  return repoDir + ".fetched-at";
}

export function readFetchedAt(repoDir: string): number | null {
  try {
    const value = Number(fs.readFileSync(fetchedAtPath(repoDir), "utf8").trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function recordFetchedAt(repoDir: string): void {
  fs.writeFileSync(fetchedAtPath(repoDir), String(Date.now()) + "\n", "utf8");
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new SyncError(
      `git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`,
    );
  }
}

/**
 * Clone the source into the cache on first use, fetch only when `refresh` is
 * set. Status calls are cheap because the clone is reused.
 */
export async function ensureRepo(
  cacheRoot: string,
  source: Source,
  refresh: boolean,
): Promise<string> {
  const repoDir = path.join(cacheRoot, source.id, "repo");
  if (!fs.existsSync(path.join(repoDir, "HEAD"))) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    await git(cacheRoot, ["clone", "--bare", "--quiet", source.url, repoDir]);
    recordFetchedAt(repoDir);
    return repoDir;
  }
  if (refresh) {
    await git(repoDir, [
      "fetch",
      "--quiet",
      "--prune",
      "--tags",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ]);
    recordFetchedAt(repoDir);
  }
  return repoDir;
}

/** Resolve a ref to a full SHA. "HEAD" in a bare clone is the default branch. */
export async function resolveRef(repoDir: string, ref: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return out.trim();
}

/**
 * Materialise one commit's `skillsDir` into a directory, cached by SHA so a
 * repeated status is a no-op.
 */
export async function materialiseTree(
  repoDir: string,
  sha: string,
  skillsDir: string,
  destRoot: string,
): Promise<string> {
  const dest = path.join(destRoot, sha);
  const done = path.join(dest, ".materialised");
  if (fs.existsSync(done)) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command =
    `git -C ${quote(repoDir)} archive ${quote(sha)} -- ${quote(skillsDir)}` +
    ` | tar -x -C ${quote(dest)}`;
  try {
    await execFileAsync("sh", ["-c", command], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new SyncError(
      `could not materialise ${sha}:${skillsDir} — ${stderr.trim() || String(error)}`,
    );
  }
  fs.writeFileSync(done, "");
  return dest;
}

export async function readCommits(
  repoDir: string,
  from: string | null,
  to: string,
): Promise<Commit[]> {
  if (from === null) return [];
  const range = `${from}..${to}`;
  const out = await git(repoDir, [
    "log",
    "--no-merges",
    "--format=%H%x09%s",
    range,
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}
