// Ported from diff-review host/git.test.ts (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. The pull request
// fetch, the index fingerprint and the host-entry harness tests are not ported with them; the views diff-review
// read from bb's Git plugin (uncommitted, branch, all, commit) are tested at the end.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "./vitest-expect.ts";

import { parseRange } from "../src/core/code-review/git-spec.ts";
import { createRunGit, diff, newFilePatch, parseNameStatus, parseNumstat, rangeCommits, splitPatch, unquote } from "../src/adapters/bb/review-git.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).trim();
}

/** A repository with `a.txt` committed on main. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "code-review-host-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

const run = createRunGit();

describe("the host's git diffs", () => {
  it("tells staged from unstaged changes, with untracked files on the unstaged side", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    git(root, "add", "a.txt");
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");

    const staged = await diff(run, root, { kind: "staged" }, false);
    expect(staged.files.map((file) => [file.path, file.changeKind, file.additions, file.deletions, file.untracked])).toEqual([["a.txt", "modified", 1, 1, false]]);
    expect(staged.files[0]!.patch).toContain("+TWO");
    expect(staged.files[0]!.patch).not.toContain("three");

    const unstaged = await diff(run, root, { kind: "unstaged" }, false);
    expect(unstaged.files.map((file) => [file.path, file.changeKind, file.additions, file.untracked])).toEqual([
      ["a.txt", "modified", 1, false],
      ["new.txt", "added", 1, true],
    ]);
    expect(unstaged.files[0]!.patch).toContain("+three");
    expect(unstaged.files[1]!.patch).toBe(newFilePatch("new.txt", "fresh\n"));
  });

  it("diffs a range from the merge base, and a merged branch from where it forked", async () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "b.txt"), "bee\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "feature");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "a.txt"), "one\ntwo\nmain\n");
    git(root, "commit", "-q", "-am", "main moves on");

    const range = await diff(run, root, { kind: "range", from: "main", to: "feature", symmetric: true }, false);
    expect(range.files.map((file) => file.path)).toEqual(["b.txt"]);
    expect(range.headSha).toBe(git(root, "rev-parse", "feature"));

    git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    // Merged: `main...feature` still shows what the branch changed.
    const merged = await diff(run, root, { kind: "range", from: "main", to: "feature", symmetric: true }, false);
    expect(merged.files.map((file) => file.path)).toEqual(["b.txt"]);
    // `..` takes the merge base as it is: nothing left.
    expect((await diff(run, root, { kind: "range", from: "main", to: "feature", symmetric: false }, false)).files).toEqual([]);
  });

  it("names the commits a range's diff compares, for AI runs: where it forked, not what `git diff a...b` takes", async () => {
    const root = repo();
    const fork = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "b.txt"), "bee\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "feature");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "a.txt"), "one\ntwo\nmain\n");
    git(root, "commit", "-q", "-am", "main moves on");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    const spec = { kind: "range" as const, from: "main", to: "feature", symmetric: true };
    const merged = await diff(run, root, spec, false);
    expect(await rangeCommits(run, root, spec)).toEqual({ baseSha: merged.baseSha, headSha: merged.headSha });
    expect(merged.baseSha).toBe(fork);
    // What the prompt used to say shows nothing once the branch is merged.
    expect(git(root, "diff", "main...feature")).toBe("");
    expect(git(root, "diff", merged.baseSha!, merged.headSha!)).toContain("+bee");
  });

  it("keeps the patch of a file whose name has a space or is not ASCII, and shows an untracked symlink as a link", async () => {
    const root = repo();
    writeFileSync(join(root, "a b.txt"), "x\n");
    writeFileSync(join(root, "é.txt"), "y\n");
    git(root, "add", ".");
    const staged = await diff(run, root, { kind: "staged" }, false);
    expect(staged.files.map((file) => [file.path, file.patch !== null])).toEqual([
      ["a b.txt", true],
      ["é.txt", true],
    ]);
    symlinkSync("/etc/hosts", join(root, "link"));
    const link = (await diff(run, root, { kind: "unstaged" }, false)).files.find((file) => file.path === "link")!;
    expect(link.patch).toContain("new file mode 120000");
    expect(link.patch).toContain("+/etc/hosts");
  });

  it("leaves out a file whose only changes are whitespace when whitespace is hidden", async () => {
    const root = repo();
    writeFileSync(join(root, "b.txt"), "bee\n");
    git(root, "add", "b.txt");
    git(root, "commit", "-q", "-m", "second");
    writeFileSync(join(root, "a.txt"), "one \ntwo\n");
    writeFileSync(join(root, "b.txt"), "BEE\n");
    const shown = await diff(run, root, { kind: "unstaged" }, false);
    expect(shown.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    const hidden = await diff(run, root, { kind: "unstaged" }, true);
    expect(hidden.files.map((file) => [file.path, file.patch !== null])).toEqual([["b.txt", true]]);
  });

  it("refuses unknown revisions", async () => {
    const root = repo();
    await expect(diff(run, root, { kind: "range", from: "nope", to: "HEAD", symmetric: false }, false)).rejects.toThrow("Unknown revision 'nope'");
  });
});

describe("reading git's output", () => {
  it("reads name-status and numstat with renames, and splits a patch by file", () => {
    expect(parseNameStatus("M\0a.txt\0R100\0old.txt\0new.txt\0")).toEqual([
      { kind: "modified", previousPath: null, path: "a.txt" },
      { kind: "renamed", previousPath: "old.txt", path: "new.txt" },
    ]);
    expect(parseNumstat("1\t2\ta.txt\0-\t-\tbin.png\0" + "0\t0\t\0old.txt\0new.txt\0")).toEqual(
      new Map([
        ["a.txt", { additions: 1, deletions: 2, binary: false }],
        ["bin.png", { additions: 0, deletions: 0, binary: true }],
        ["new.txt", { additions: 0, deletions: 0, binary: false }],
      ]),
    );
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    expect([...splitPatch(patch).keys()]).toEqual(["a.txt", "gone.txt"]);
  });

  it("unquotes git's C-quoted paths, octal bytes included", () => {
    expect(unquote('"b/\\303\\251.txt"')).toBe("b/é.txt");
    expect(unquote('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquote("plain")).toBe("plain");
  });

  it("reads a range the way git does", () => {
    expect(parseRange("main...feature")).toEqual({ kind: "range", from: "main", to: "feature", symmetric: true });
    expect(parseRange("v1..")).toEqual({ kind: "range", from: "v1", to: "HEAD", symmetric: false });
    expect(parseRange("main")).toBeNull();
    expect(parseRange("-x..y")).toBeNull();
  });
});

describe("the views diff-review read from bb's Git plugin", () => {
  it("shows uncommitted changes, staged and not, with untracked files, against HEAD", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    git(root, "add", "a.txt");
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");
    const result = await diff(run, root, { kind: "uncommitted" }, false);
    expect(result.files.map((file) => [file.path, file.additions, file.deletions, file.untracked])).toEqual([["a.txt", 2, 1, false], ["new.txt", 1, 0, true]]);
    expect(result.baseSha).toBe(git(root, "rev-parse", "HEAD"));
  });

  it("shows a commit against its first parent, and a root commit as all added", async () => {
    const root = repo();
    const first = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    git(root, "commit", "-q", "-am", "second");
    const second = git(root, "rev-parse", "HEAD");
    const result = await diff(run, root, { kind: "commit", sha: second }, false);
    expect(result.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([["a.txt", 1, 1]]);
    expect([result.baseSha, result.headSha]).toEqual([first, second]);
    const root_ = await diff(run, root, { kind: "commit", sha: first.slice(0, 12) }, false);
    expect(root_.files.map((file) => [file.path, file.changeKind, file.additions])).toEqual([["a.txt", "added", 2]]);
    expect(root_.baseSha).toBeNull();
  });

  it("shows a branch's commits since its base, and all changes since the base with the working tree", async () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "b.txt"), "bee\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "feature");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "a.txt"), "one\ntwo\nmain\n");
    git(root, "commit", "-q", "-am", "main moves on");
    git(root, "checkout", "-q", "feature");
    writeFileSync(join(root, "c.txt"), "sea\n");
    const branch = await diff(run, root, { kind: "branch", base: "main" }, false);
    expect(branch.files.map((file) => file.path)).toEqual(["b.txt"]);
    const all = await diff(run, root, { kind: "all", base: "main" }, false);
    expect(all.files.map((file) => [file.path, file.untracked])).toEqual([["b.txt", false], ["c.txt", true]]);
    await expect(diff(run, root, { kind: "all", base: "nope" }, false)).rejects.toThrow("Unknown revision 'nope'");
  });
});

describe("the default base of the branch views", () => {
  it("is origin's HEAD when the clone knows it, else main, else master, else none", async () => {
    const { defaultBase } = await import("../src/adapters/bb/review-git.ts");
    const root = repo();
    expect(await defaultBase(run, root)).toBe("main");
    git(root, "branch", "-m", "main", "trunk");
    expect(await defaultBase(run, root)).toBeNull();
    git(root, "branch", "master");
    expect(await defaultBase(run, root)).toBe("master");
    git(root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await defaultBase(run, root)).toBe("origin/trunk");
  });
});

describe("git for the review reads what was committed", () => {
  it("ignores replace refs, so a commit shows its real content", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nREAL\n");
    git(root, "commit", "-q", "-am", "real");
    const real = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "a.txt"), "one\nFAKE\n");
    git(root, "commit", "-q", "-am", "fake");
    const fake = git(root, "rev-parse", "HEAD");
    git(root, "replace", real, fake);
    const shown = await diff(run, root, { kind: "commit", sha: real }, false);
    expect(shown.files[0]!.patch).toContain("+REAL");
    expect(shown.files[0]!.patch).not.toContain("FAKE");
  });
});
