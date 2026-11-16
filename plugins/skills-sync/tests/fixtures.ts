// Fixture builders: plain directories that stand in for the three trees, plus
// a real throwaway git repo for the parts of the engine that shell out to git.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Source } from "../contract";
import type { Prepared } from "../sync";

export function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skills-sync-${label}-`));
}

/** `{ "bucket/name/file": "contents" }` written under `root`. */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "test",
    url: "https://example.invalid/skills.git",
    ref: "HEAD",
    skillsDir: "skills",
    nested: true,
    skipBuckets: ["in-progress", "deprecated"],
    installRoot: "/nonexistent",
    marker: ".test-skills-version",
    ...overrides,
  };
}

export function makePrepared(overrides: Partial<Prepared> & { source: Source }): Prepared {
  return {
    repoDir: "/nonexistent-repo",
    cacheRoot: tmpDir("cache"),
    head: "0".repeat(40),
    pinned: null,
    pinDir: null,
    headDir: "/nonexistent-head",
    commits: [],
    fetchedAt: null,
    ...overrides,
  };
}

/** A real git repo with two commits, so prepare()/materialiseTree() run for real. */
export function makeGitRepo(files: Array<Record<string, string>>): {
  dir: string;
  shas: string[];
} {
  const dir = tmpDir("repo");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "--quiet", "--initial-branch=main");
  const shas: string[] = [];
  files.forEach((snapshot, index) => {
    writeTree(dir, snapshot);
    git("add", "-A");
    git("commit", "--quiet", "-m", `commit ${index}`);
    shas.push(git("rev-parse", "HEAD").trim());
  });
  return { dir, shas };
}
