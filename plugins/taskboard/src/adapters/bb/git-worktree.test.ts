import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIssueWorktree } from "./git-worktree.ts";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tb-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "init"]);
  return repo;
}

function registryPath(repo: string): string { return join(dirname(repo), ".taskboard-worktrees", "repo", "registry.json"); }
function rootDir(repo: string): string { return join(dirname(repo), ".taskboard-worktrees", "repo"); }

describe("git worktree provisioning", () => {
  it("creates an issue branch under the owned root and reuses by run ownership", async () => {
    const repo = makeRepo();
    const first = await createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run1" });
    expect(first.branch).toBe("DEMO-1");
    expect(first.worktreePath.includes(".taskboard-worktrees")).toBe(true);
    const reuse = await createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run1" });
    expect(reuse.worktreePath).toBe(first.worktreePath);
  });

  it("refuses a branch owned by another run", async () => {
    const repo = makeRepo();
    await createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run1" });
    await expect(createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run2" })).rejects.toThrow(/owned by another run/);
  });

  it("rejects invalid branch names", async () => {
    const repo = makeRepo();
    await expect(createIssueWorktree({ repoPath: repo, branchName: "../evil", baseBranch: "HEAD", runId: "r" })).rejects.toThrow(/Invalid branch name/);
  });

  it("rejects a reused worktree whose HEAD moved to another branch", async () => {
    const repo = makeRepo();
    const first = await createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run1" });
    execFileSync("git", ["-C", first.worktreePath, "checkout", "-q", "-b", "other"]);
    await expect(createIssueWorktree({ repoPath: repo, branchName: "DEMO-1", baseBranch: "HEAD", runId: "run1" })).rejects.toThrow(/mismatch/);
  });

  it("refuses a worktree path collision", async () => {
    const repo = makeRepo();
    mkdirSync(join(rootDir(repo), "DEMO-2"), { recursive: true });
    await expect(createIssueWorktree({ repoPath: repo, branchName: "DEMO-2", baseBranch: "HEAD", runId: "r" })).rejects.toThrow(/already exists/);
  });

  it("does not confuse PROJ-1 with PROJ-10 (exact record match)", async () => {
    const repo = makeRepo();
    await createIssueWorktree({ repoPath: repo, branchName: "PROJ-10", baseBranch: "HEAD", runId: "r10" });
    const reg = JSON.parse(readFileSync(registryPath(repo), "utf8"));
    reg["PROJ-1"] = { runId: "r1", worktreePath: join(rootDir(repo), "PROJ-1"), branch: "PROJ-1", state: "ready" };
    writeFileSync(registryPath(repo), JSON.stringify(reg));
    await expect(createIssueWorktree({ repoPath: repo, branchName: "PROJ-1", baseBranch: "HEAD", runId: "r1" })).rejects.toThrow(/mismatch/);
  });

  it("does not adopt a pre-existing branch without a creating claim", async () => {
    const repo = makeRepo();
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "DEMO-5"]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
    await expect(createIssueWorktree({ repoPath: repo, branchName: "DEMO-5", baseBranch: "HEAD", runId: "r" })).rejects.toThrow(/already exists/);
  });

  it("fails closed on a corrupt registry", async () => {
    const repo = makeRepo();
    mkdirSync(rootDir(repo), { recursive: true });
    writeFileSync(registryPath(repo), "{ not json");
    await expect(createIssueWorktree({ repoPath: repo, branchName: "DEMO-6", baseBranch: "HEAD", runId: "r" })).rejects.toThrow(/corrupt/);
  });

  it("two concurrent creates for distinct branches retain both claims", async () => {
    const repo = makeRepo();
    const [a, b] = await Promise.all([
      createIssueWorktree({ repoPath: repo, branchName: "DEMO-A", baseBranch: "HEAD", runId: "ra" }),
      createIssueWorktree({ repoPath: repo, branchName: "DEMO-B", baseBranch: "HEAD", runId: "rb" }),
    ]);
    const reg = JSON.parse(readFileSync(registryPath(repo), "utf8"));
    expect(reg["DEMO-A"]).toBeDefined();
    expect(reg["DEMO-B"]).toBeDefined();
    expect(a.branch).toBe("DEMO-A");
    expect(b.branch).toBe("DEMO-B");
  });

  it("recovers a crash-after-claim by adopting the created worktree", async () => {
    const repo = makeRepo();
    const first = await createIssueWorktree({ repoPath: repo, branchName: "DEMO-3", baseBranch: "HEAD", runId: "run1" });
    const reg = JSON.parse(readFileSync(registryPath(repo), "utf8"));
    reg["DEMO-3"].state = "creating";
    writeFileSync(registryPath(repo), JSON.stringify(reg));
    const recovered = await createIssueWorktree({ repoPath: repo, branchName: "DEMO-3", baseBranch: "HEAD", runId: "run1" });
    expect(recovered.worktreePath).toBe(first.worktreePath);
    expect(JSON.parse(readFileSync(registryPath(repo), "utf8"))["DEMO-3"].state).toBe("ready");
  });
});
