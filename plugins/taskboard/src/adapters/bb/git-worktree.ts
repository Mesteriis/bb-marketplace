import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd }) as Promise<{ stdout: string; stderr: string }>;
}

type RegistryEntry = { runId: string; worktreePath: string; branch: string; state: "creating" | "ready" };
type Registry = Record<string, RegistryEntry>;

function readRegistry(path: string): Registry {
  if (!existsSync(path)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Taskboard worktree registry is corrupt: " + path); }
  if (typeof value !== "object" || value === null) throw new Error("Taskboard worktree registry is invalid: " + path);
  return value as Registry;
}
function writeRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, path);
}

// Serialize registry reads/writes per canonical repository.
const repoLocks = new Map<string, Promise<unknown>>();
async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  repoLocks.set(repoPath, run);
  void run.finally(() => { if (repoLocks.get(repoPath) === run) repoLocks.delete(repoPath); }).catch(() => {});
  return run;
}

async function defaultBranch(repoPath: string): Promise<string> {
  const remote = await git(["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath).then((r) => r.stdout.trim().replace(/^origin\//, ""), () => "");
  if (remote !== "") return remote;
  return (await git(["-C", repoPath, "symbolic-ref", "--short", "HEAD"], repoPath)).stdout.trim();
}

function parsePorcelain(out: string): Array<{ worktree?: string; branch?: string }> {
  return out.split("\n\n").map((block) => {
    const record: { worktree?: string; branch?: string } = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) record.worktree = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) record.branch = line.slice("branch ".length);
    }
    return record;
  });
}

async function verifyWorktree(worktreePath: string, branchName: string, repoPath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  const head = await git(["-C", worktreePath, "symbolic-ref", "--short", "HEAD"], worktreePath).then((r) => r.stdout.trim(), () => "");
  if (head !== branchName) return false;
  const list = await git(["-C", repoPath, "worktree", "list", "--porcelain"], repoPath).then((r) => r.stdout, () => "");
  const canonical = realpathSync(worktreePath);
  const record = parsePorcelain(list).find((rec) => rec.worktree === canonical && rec.branch === "refs/heads/" + branchName);
  if (record === undefined) return false;
  const common = await git(["-C", worktreePath, "rev-parse", "--git-common-dir"], worktreePath).then((r) => realpathSync(resolve(worktreePath, r.stdout.trim())), () => null);
  const repoCommon = await git(["-C", repoPath, "rev-parse", "--git-common-dir"], repoPath).then((r) => realpathSync(resolve(repoPath, r.stdout.trim())), () => null);
  return common !== null && repoCommon !== null && common === repoCommon;
}

export interface IssueWorktreeInput { repoPath: string; branchName: string; baseBranch: string; runId: string; }

export async function createIssueWorktree(input: IssueWorktreeInput): Promise<{ worktreePath: string; branch: string }> {
  const { repoPath, branchName, runId } = input;
  if (!BRANCH_RE.test(branchName)) throw new Error("Invalid branch name");
  await git(["-C", repoPath, "rev-parse", "--is-inside-work-tree"], repoPath);
  const canonicalRepo = realpathSync(repoPath);
  const repoKey = (canonicalRepo.split("/").filter(Boolean).pop() ?? "repo").replace(/[^A-Za-z0-9._-]/g, "-");
  const root = join(dirname(canonicalRepo), ".taskboard-worktrees", repoKey);
  const worktreePath = join(root, branchName);
  const registryPath = join(root, "registry.json");

  return withRepoLock(canonicalRepo, async () => {
    const registry = readRegistry(registryPath);
    const existing = registry[branchName];
    if (existing !== undefined && existing.runId !== runId) {
      throw new Error("Branch " + branchName + " is owned by another run");
    }
    if (existing !== undefined && existing.state === "ready") {
      if (!(await verifyWorktree(existing.worktreePath, branchName, canonicalRepo))) {
        throw new Error("Worktree mismatch for branch " + branchName);
      }
      return { worktreePath: existing.worktreePath, branch: branchName };
    }

    const branchExists = await git(["-C", canonicalRepo, "show-ref", "--verify", "--quiet", "refs/heads/" + branchName], canonicalRepo).then(() => true, () => false);

    // Never adopt a pre-existing branch without our own prior "creating" claim.
    if (branchExists && existing === undefined) {
      throw new Error("Branch " + branchName + " already exists");
    }
    if (branchExists && existing !== undefined) {
      if (await verifyWorktree(worktreePath, branchName, canonicalRepo)) {
        writeRegistry(registryPath, { ...registry, [branchName]: { runId, worktreePath, branch: branchName, state: "ready" } });
        return { worktreePath, branch: branchName };
      }
      throw new Error("Branch " + branchName + " already exists");
    }

    if (existsSync(worktreePath)) throw new Error("Worktree path already exists: " + worktreePath);

    // Ownership claim BEFORE any mutation (recoverable on crash).
    writeRegistry(registryPath, { ...registry, [branchName]: { runId, worktreePath, branch: branchName, state: "creating" } });

    const base = input.baseBranch !== "" && input.baseBranch !== "HEAD" ? input.baseBranch : await defaultBranch(canonicalRepo);
    await git(["-C", canonicalRepo, "worktree", "add", "-b", branchName, worktreePath, base], canonicalRepo);
    const symbolic = (await git(["-C", worktreePath, "symbolic-ref", "--short", "HEAD"], worktreePath)).stdout.trim();
    if (symbolic !== branchName) throw new Error("Worktree branch verification failed");
    writeRegistry(registryPath, { ...registry, [branchName]: { runId, worktreePath, branch: branchName, state: "ready" } });
    return { worktreePath, branch: branchName };
  });
}
