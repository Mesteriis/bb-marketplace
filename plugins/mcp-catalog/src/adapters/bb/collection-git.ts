import { execFile } from "node:child_process";
import { CollectionIndex, type CollectionPort } from "../../core/collection";

const PREFIX = "mcp-collection/";

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error !== null) {
        const text = String(stderr).trim();
        reject(new Error(text.length > 0 ? text : error.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** The collection as it is on `origin/main`: never the working tree. */
export class CollectionGit implements CollectionPort {
  private fetched: { promise: Promise<string>; at: number } | null = null;

  constructor(
    private readonly repoPath: string,
    private readonly ttlMs: number = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** One fetch in flight per repo, reused for `ttlMs`; a failed fetch is never reused. */
  private fetchOnce(): Promise<string> {
    const current = this.fetched;
    if (current !== null && this.now() - current.at < this.ttlMs) return current.promise;
    const entry = { promise: git(this.repoPath, ["fetch", "origin", "main"]), at: this.now() };
    this.fetched = entry;
    entry.promise.catch(() => {
      if (this.fetched === entry) this.fetched = null;
    });
    return entry.promise;
  }

  invalidate(): void {
    this.fetched = null;
  }

  async readIndex(): Promise<CollectionIndex> {
    await this.fetchOnce();
    let text: string;
    try {
      text = await git(this.repoPath, ["show", `origin/main:${PREFIX}index.json`]);
    } catch (error) {
      // Not-yet-created index means an empty collection; any other failure is real.
      if (/exists on disk, but not in|does not exist in|path .* does not exist/.test((error as Error).message)) {
        return { servers: [] };
      }
      throw error;
    }
    return CollectionIndex.parse(JSON.parse(text));
  }

  /** True only when `commit` is a full SHA and an ancestor of `origin/main` after a fetch; any failure is false. */
  async isAccepted(commit: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return false;
    await this.fetchOnce();
    return git(this.repoPath, ["merge-base", "--is-ancestor", commit, "origin/main"]).then(
      () => true,
      () => false,
    );
  }

  async readFile(path: string): Promise<string> {
    if (!path.startsWith(PREFIX) || path.split("/").includes("..") || path.includes("\0")) {
      throw new Error("недопустимый путь коллекции");
    }
    return git(this.repoPath, ["show", `origin/main:${path}`]);
  }
}
