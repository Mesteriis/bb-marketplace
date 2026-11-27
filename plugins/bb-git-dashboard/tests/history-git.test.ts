import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDetails, commitPatch, historyPage, historyRevision, workingPatch } from "../src/adapters/bb/history-git.ts";
import { layoutCommitGraph } from "../src/core/history/graph.ts";

function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "history-")));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8", env: {...process.env, GIT_AUTHOR_DATE: "2026-11-27T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-27T10:00:00Z"}}).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  return {root, git, done: () => rmSync(root, {recursive: true, force: true})};
}

test("an empty repository has an empty history, not an error", async () => {
  const {root, done} = repository();
  try {
    writeFileSync(join(root, "draft.txt"), "x\n");
    const page = await historyPage(root, 0, 50);
    assert.deepEqual({commits: page.commits, total: page.total, branch: page.currentBranch}, {commits: [], total: 0, branch: "main"});
    assert.deepEqual(page.uncommitted.map(file => [file.path, file.status]), [["draft.txt", "added"]]);
  } finally { done(); }
});

test("the history covers all refs with branches, tags, merges and uncommitted files", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
    git("switch", "-q", "-c", "feature"); writeFileSync(join(root, "b.txt"), "2\n"); git("add", "."); git("commit", "-qm", "feature work");
    git("switch", "-q", "main"); writeFileSync(join(root, "a.txt"), "1\n3\n"); git("commit", "-qam", "main work");
    git("merge", "-q", "--no-ff", "feature", "-m", "merge feature");
    git("tag", "-a", "v1.0", "-m", "release");
    git("switch", "-q", "-c", "side", "HEAD~1"); writeFileSync(join(root, "c.txt"), "4\n"); git("add", "."); git("commit", "-qm", "side tip");
    git("switch", "-q", "main");
    writeFileSync(join(root, "a.txt"), "changed\n");
    const page = await historyPage(root, 0, 50);
    assert.deepEqual(page.commits.map(commit => commit.subject).sort(), ["base", "feature work", "main work", "merge feature", "side tip"]);
    assert.equal(page.total, 5);
    assert.equal(page.currentBranch, "main");
    const merge = page.commits.find(commit => commit.subject === "merge feature")!;
    assert.equal(merge.parents.length, 2);
    assert.deepEqual(merge.refs.map(ref => [ref.name, ref.kind, ref.isHead]), [["main", "local", true], ["v1.0", "tag", false]]);
    assert.deepEqual(page.uncommitted, [{path: "a.txt", status: "modified", additions: 1, deletions: 2}]);
    assert.ok(Math.max(...layoutCommitGraph(page.commits).map(row => row.laneCount)) >= 2);

    const details = await commitDetails(root, merge.hash);
    assert.equal(details.subject, "merge feature");
    const first = page.commits.find(commit => commit.subject === "feature work")!;
    assert.deepEqual((await commitDetails(root, first.hash)).files, [{path: "b.txt", status: "added", additions: 1, deletions: 0}]);
    assert.match((await commitPatch(root, first.hash, "b.txt")).text, /^\+2$/m);
    assert.match((await workingPatch(root, "a.txt")).text, /^\+changed$/m);
    const paged = await historyPage(root, 2, 2);
    assert.deepEqual({count: paged.commits.length, more: paged.more, offset: paged.offset}, {count: 2, more: true, offset: 2});
  } finally { done(); }
});

test("the revision changes with commits, refs and working files, and not otherwise", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
    const first = await historyRevision(root);
    assert.equal(await historyRevision(root), first);
    writeFileSync(join(root, "a.txt"), "2\n");
    const edited = await historyRevision(root);
    assert.notEqual(edited, first);
    git("branch", "other");
    assert.notEqual(await historyRevision(root), edited);
  } finally { done(); }
});

test("hashes and paths are checked before Git runs", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
    await assert.rejects(commitDetails(root, "--output=/tmp/x"), {message: "INVALID_INPUT"});
    await assert.rejects(commitPatch(root, "a".repeat(40), "../outside"), {message: "INVALID_PATH"});
    await assert.rejects(workingPatch(root, "/etc/passwd"), {message: "INVALID_PATH"});
  } finally { done(); }
});

test("a merge lists only what it changes against its first parent", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
    git("switch", "-q", "-c", "feature"); writeFileSync(join(root, "b.txt"), "2\n"); git("add", "."); git("commit", "-qm", "feature");
    git("switch", "-q", "main"); writeFileSync(join(root, "c.txt"), "3\n"); git("add", "."); git("commit", "-qm", "main work");
    git("merge", "-q", "--no-ff", "feature", "-m", "merge");
    const merge = git("rev-parse", "HEAD");
    assert.deepEqual((await commitDetails(root, merge)).files, [{path: "b.txt", status: "added", additions: 1, deletions: 0}]);
    const patch = (await commitPatch(root, merge, "b.txt")).text;
    assert.equal(patch.match(/^diff --git/gm)?.length, 1);
  } finally { done(); }
});

test("working patches cover staged deletions and stay inside the working tree's listed changes", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "gone.txt"), "bye\n"); writeFileSync(join(root, ".gitignore"), ".env\n"); git("add", "."); git("commit", "-qm", "base");
    git("rm", "-q", "gone.txt");
    assert.match((await workingPatch(root, "gone.txt")).text, /^-bye$/m);
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    await assert.rejects(workingPatch(root, ".env"), {message: "INVALID_PATH"}, "ignored files are not read");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
    writeFileSync(join(outside, "s"), "outside\n");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(root, "lnk"));
    await assert.rejects(workingPatch(root, "lnk/s"), {message: "INVALID_PATH"}, "nothing behind a link out of the tree");
    rmSync(outside, {recursive: true, force: true});
  } finally { done(); }
});

test("a patch over the size cap comes back cut at a whole line and marked, not as an error", async () => {
  const {root, git, done} = repository();
  try {
    writeFileSync(join(root, "big.txt"), "seed\n"); git("add", "."); git("commit", "-qm", "base");
    // 40 000 lines of 50 characters: about 2 MB of added lines, over the 1.5 MB cap.
    writeFileSync(join(root, "big.txt"), Array.from({length: 40_000}, (_, index) => String(index).padStart(49, "x")).join("\n") + "\n");
    git("add", "."); git("commit", "-qm", "big");
    const patch = await commitPatch(root, git("rev-parse", "HEAD"), "big.txt");
    assert.equal(patch.truncated, true);
    assert.ok(patch.text.length <= 1.5 * 1024 * 1024);
    assert.ok(patch.text.endsWith("\n"));
    assert.match(patch.text, /^\+x+0$/m);
    writeFileSync(join(root, "new.txt"), "small\n");
    const working = await workingPatch(root, "new.txt");
    assert.equal(working.truncated, false);
    const small = await commitPatch(root, git("rev-parse", "HEAD~1"), "big.txt");
    assert.equal(small.truncated, false);
  } finally { done(); }
});
