// Finds git repositories under the configured roots, the way
// `find <root> -maxdepth <depth> -name .git` does: a folder is a repository
// when its `.git` (a directory, or the file a worktree writes) sits at most
// `depth` levels below the root. Nested repositories count; node_modules and
// the inside of `.git` are never walked; symlinks are not followed.
import { parseGitConfigRemotes, parseGitdirPointer, remoteKey } from "./git-remotes.ts";

export interface ScanEntry {
  name: string;
  kind: "dir" | "file" | "other";
}

/** The file system the scan reads. `list` throws for a folder it cannot read. */
export interface ScanFs {
  list(dir: string): Promise<ScanEntry[]>;
  read(path: string): Promise<string | null>;
}

export interface LocalRepo {
  path: string;
  name: string;
  root: string;
  /** Remote URLs from the repository's config. */
  remotes: string[];
  /** Forge keys of those remotes (see remoteKey). */
  keys: string[];
}

export interface RootResult {
  root: string;
  ok: boolean;
}

export interface ScanResult {
  repos: LocalRepo[];
  roots: RootResult[];
  truncated: boolean;
}

const SKIP = new Set([".git", "node_modules"]);
export const DEFAULT_SCAN_LIMIT = 2000;

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Joins and normalizes POSIX paths; `rel` may be absolute. */
export function joinPath(base: string, rel: string): string {
  const parts = (rel.startsWith("/") ? rel : `${base}/${rel}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/** An absolute root from the settings (`~` is the home folder), or null. */
export function expandRoot(root: string, home: string): string | null {
  const r = root.trim();
  if (r === "~") return trimSlash(home);
  if (r.startsWith("~/")) return trimSlash(joinPath(home, r.slice(2)));
  if (r.startsWith("/")) return trimSlash(r);
  return null;
}

async function remotesOf(fs: ScanFs, repo: string, dotGit: "dir" | "file"): Promise<string[]> {
  let gitDir = `${repo}/.git`;
  if (dotGit === "file") {
    const target = parseGitdirPointer((await fs.read(gitDir)) ?? "");
    if (target === null) return [];
    gitDir = joinPath(repo, target);
    const common = (await fs.read(`${gitDir}/commondir`))?.trim();
    if (common) gitDir = joinPath(gitDir, common);
  }
  return parseGitConfigRemotes((await fs.read(`${gitDir}/config`)) ?? "");
}

export async function scanRepos(fs: ScanFs, roots: string[], depth: number, options: { limit?: number } = {}): Promise<ScanResult> {
  const limit = options.limit ?? DEFAULT_SCAN_LIMIT;
  const found = new Map<string, LocalRepo>();
  const rootResults: RootResult[] = [];
  let truncated = false;

  const walk = async (dir: string, level: number, root: string, entries: ScanEntry[]): Promise<void> => {
    const dotGit = entries.find((e) => e.name === ".git" && e.kind !== "other");
    if (dotGit !== undefined && level + 1 <= depth && !found.has(dir)) {
      if (found.size >= limit) {
        truncated = true;
        return;
      }
      const remotes = await remotesOf(fs, dir, dotGit.kind as "dir" | "file");
      const keys = [...new Set(remotes.map(remoteKey).filter((k): k is string => k !== null))];
      found.set(dir, { path: dir, name: dir.split("/").pop() || dir, root, remotes, keys });
    }
    if (level + 1 >= depth) return;
    const children = entries.filter((e) => e.kind === "dir" && !SKIP.has(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (truncated) return;
      const path = dir === "/" ? `/${child.name}` : `${dir}/${child.name}`;
      let list: ScanEntry[];
      try {
        list = await fs.list(path);
      } catch {
        continue;
      }
      await walk(path, level + 1, root, list);
    }
  };

  for (const raw of roots) {
    const root = trimSlash(raw);
    let entries: ScanEntry[];
    try {
      entries = await fs.list(root);
    } catch {
      rootResults.push({ root, ok: false });
      continue;
    }
    rootResults.push({ root, ok: true });
    await walk(root, 0, root, entries);
  }
  const repos = [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { repos, roots: rootResults, truncated };
}

export const DEFAULT_SCAN_DEPTH = 4;
export const MAX_SCAN_DEPTH = 8;

/** A list setting: items separated by commas or new lines. */
export function settingsList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((s) => s.trim()).filter((s) => s !== ""))];
}

/** The scan depth from the settings, kept between 1 and MAX_SCAN_DEPTH. */
export function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(1, Math.floor(value)));
}
