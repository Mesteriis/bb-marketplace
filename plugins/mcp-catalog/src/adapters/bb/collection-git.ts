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

type GitRunner = (repo: string, args: string[]) => Promise<string>;

/** The collection as it is on `origin/main`: never the working tree. */
export class CollectionGit implements CollectionPort {
  private fetched: { promise: Promise<string>; at: number } | null = null;
  private inflight: Promise<string> | null = null;
  /** An invalidate arrived while a fetch was in flight: that fetch's result is not fresh enough for later readers. */
  private stale = false;
  private followUp: Promise<string> | null = null;

  constructor(
    private readonly repoPath: string,
    private readonly ttlMs: number = 10_000,
    private readonly now: () => number = Date.now,
    private readonly runGit: GitRunner = git,
  ) {}

  private start(): Promise<string> {
    const entry = { promise: this.runGit(this.repoPath, ["fetch", "origin", "main"]), at: this.now() };
    this.fetched = entry;
    this.inflight = entry.promise;
    this.stale = false;
    this.followUp = null;
    const finish = () => {
      if (this.inflight === entry.promise) this.inflight = null;
      // An invalidate arrived during this fetch and nobody asked for a follow-up: the result is already stale.
      if (this.stale && this.followUp === null && this.fetched === entry) {
        this.fetched = null;
        this.stale = false;
      }
    };
    entry.promise.then(finish, () => {
      finish();
      if (this.fetched === entry) this.fetched = null;
    });
    return entry.promise;
  }

  /**
   * At most one fetch in flight, reused for `ttlMs`; a failed fetch is never reused. An invalidate during a
   * fetch makes later readers wait for exactly one follow-up fetch, however many invalidates there were.
   */
  private fetchOnce(): Promise<string> {
    if (this.inflight !== null) {
      if (!this.stale) return this.inflight;
      this.followUp ??= this.inflight.then(
        () => undefined,
        () => undefined,
      ).then(() => this.start());
      return this.followUp;
    }
    const current = this.fetched;
    if (current !== null && this.now() - current.at < this.ttlMs) return current.promise;
    return this.start();
  }

  invalidate(): void {
    if (this.inflight !== null) this.stale = true;
    else this.fetched = null;
  }

  async readIndex(): Promise<CollectionIndex> {
    await this.fetchOnce();
    let text: string;
    try {
      text = await this.runGit(this.repoPath, ["show", `origin/main:${PREFIX}index.json`]);
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
    return this.runGit(this.repoPath, ["merge-base", "--is-ancestor", commit, "origin/main"]).then(
      () => true,
      () => false,
    );
  }

  /** True only when `path` (an entry folder) has the same git tree id at `commit` and at `origin/main` after a fetch. */
  async sameEntryAt(commit: string, path: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return false;
    if (!path.startsWith(PREFIX) || path.split("/").includes("..") || path.includes("\0") || path.endsWith("/")) return false;
    await this.fetchOnce();
    try {
      const [accepted, current] = await Promise.all([
        this.runGit(this.repoPath, ["rev-parse", `${commit}:${path}`]),
        this.runGit(this.repoPath, ["rev-parse", `origin/main:${path}`]),
      ]);
      return accepted.trim() !== "" && accepted.trim() === current.trim();
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    if (!path.startsWith(PREFIX) || path.split("/").includes("..") || path.includes("\0")) {
      throw new Error("недопустимый путь коллекции");
    }
    return this.runGit(this.repoPath, ["show", `origin/main:${path}`]);
  }
}
