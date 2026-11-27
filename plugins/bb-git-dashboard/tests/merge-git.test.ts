import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localGit } from "../src/adapters/bb/local-git.ts";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8"});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const rev = (name: string) => git("rev-parse", name).trim();
// main and feature both change the second line of a.txt; feature also adds b.txt; side only adds c.txt.
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "merge-git-test-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  git("add", "."); git("commit", "-qm", "base");
  git("switch", "-q", "-c", "feature");
  writeFileSync(join(root, "a.txt"), "one\nfeature\nthree\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git("add", "."); git("-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-qm", "feature work");
  git("switch", "-q", "main");
  git("switch", "-q", "-c", "side");
  writeFileSync(join(root, "c.txt"), "c\n");
  git("add", "."); git("commit", "-qm", "side work");
  git("switch", "-q", "main");
  writeFileSync(join(root, "a.txt"), "one\nmain\nthree\n");
  git("commit", "-qam", "main work");
});
afterEach(() => rmSync(root, {recursive: true, force: true}));

test("the preview says what a merge brings and which files it would leave in conflict, without touching the tree", async () => {
  const head = rev("HEAD");
  const conflicted = await localGit(root, {kind: "mergePreview", ref: "refs/heads/feature", target: rev("feature")});
  assert.deepEqual(conflicted.preview, {incoming: 1, outgoing: 1, conflicts: ["a.txt"], fastForward: false, upToDate: false});
  const clean = await localGit(root, {kind: "mergePreview", ref: "refs/heads/side", target: rev("side")});
  assert.deepEqual(clean.preview, {incoming: 1, outgoing: 1, conflicts: [], fastForward: false, upToDate: false});
  assert.equal(rev("HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
  await assert.rejects(localGit(root, {kind: "mergePreview", ref: "refs/heads/feature", target: rev("side")}), {message: "STALE_HEAD"});
});

test("a merge that conflicts is resolved in the editor's terms and continued into a merge commit", async () => {
  const head = rev("HEAD");
  const started = await localGit(root, {kind: "merge", ref: "refs/heads/feature", target: rev("feature"), expected: head, fastForward: true});
  assert.deepEqual(started.sequence, {kind: "merge", head, onto: null, step: null, conflicts: [{path: "a.txt", state: "both modified"}]});
  const read = await localGit(root, {kind: "conflict", path: "a.txt"});
  assert.deepEqual({...read.conflict, merged: undefined}, {path: "a.txt", ours: "one\nmain\nthree\n", base: "one\ntwo\nthree\n", theirs: "one\nfeature\nthree\n",
    binary: false, current: readFileSync(join(root, "a.txt"), "utf8"), sha256: sha(readFileSync(join(root, "a.txt"), "utf8")), merged: undefined});
  assert.equal(read.conflict?.merged, "one\n<<<<<<< ours\nmain\n||||||| base\ntwo\n=======\nfeature\n>>>>>>> theirs\nthree\n");
  await assert.rejects(localGit(root, {kind: "resolve", path: "a.txt", expected: read.conflict!.sha256!, text: read.conflict!.merged!}), {message: "CONFLICT_MARKERS"});
  await assert.rejects(localGit(root, {kind: "resolve", path: "a.txt", expected: sha("other"), text: "x\n"}), {message: "CHANGED"});
  const resolved = await localGit(root, {kind: "resolve", path: "a.txt", expected: read.conflict!.sha256!, text: "one\nmain and feature\nthree\n"});
  assert.deepEqual(resolved.sequence?.conflicts, []);
  const done = await localGit(root, {kind: "continue"});
  assert.equal(done.sequence, null);
  assert.equal(git("log", "-1", "--format=%P").trim().split(" ").length, 2);
  assert.equal(git("log", "-1", "--format=%s").trim(), "Merge branch 'feature'");
  assert.equal(git("show", "HEAD:a.txt"), "one\nmain and feature\nthree\n");
});

test("a merge starts only on a clean tree at the head that was shown; Abort puts everything back", async () => {
  const head = rev("HEAD");
  await assert.rejects(localGit(root, {kind: "merge", ref: "refs/heads/feature", target: rev("feature"), expected: rev("side"), fastForward: true}), {message: "STALE_HEAD"});
  writeFileSync(join(root, "a.txt"), "dirty\n");
  await assert.rejects(localGit(root, {kind: "merge", ref: "refs/heads/feature", target: rev("feature"), expected: head, fastForward: true}), {message: "DIRTY_WORKTREE"});
  git("checkout", "--", "a.txt");
  await localGit(root, {kind: "merge", ref: "refs/heads/feature", target: rev("feature"), expected: head, fastForward: true});
  await assert.rejects(localGit(root, {kind: "merge", ref: "refs/heads/side", target: rev("side"), expected: head, fastForward: true}), {message: "GIT_SEQUENCE_ACTIVE"});
  const aborted = await localGit(root, {kind: "abort"});
  assert.equal(aborted.sequence, null);
  assert.equal(rev("HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
});

test("a clean merge without fast-forward makes a merge commit at once; with it, a fast-forward moves the branch", async () => {
  const head = rev("HEAD");
  const merged = await localGit(root, {kind: "merge", ref: "refs/heads/side", target: rev("side"), expected: head, fastForward: false});
  assert.equal(merged.sequence, null);
  assert.equal(git("log", "-1", "--format=%s").trim(), "Merge branch 'side'");
  git("switch", "-q", "side");
  const forward = await localGit(root, {kind: "merge", ref: "refs/heads/main", target: rev("main"), expected: rev("side"), fastForward: true});
  assert.equal(forward.head, rev("main"));
});

test("a rebase stops at the conflicting commit, keeps its author, and continues after the resolution", async () => {
  git("switch", "-q", "feature");
  const head = rev("HEAD");
  const started = await localGit(root, {kind: "rebase", ref: "refs/heads/main", target: rev("main"), expected: head});
  assert.equal(started.sequence?.kind, "rebase");
  assert.deepEqual([started.sequence?.head, started.sequence?.onto, started.sequence?.step, started.sequence?.conflicts],
    [head, rev("main"), {done: 1, total: 1}, [{path: "a.txt", state: "both modified"}]]);
  const read = await localGit(root, {kind: "conflict", path: "a.txt"});
  // In a rebase, ours is the branch being rebased onto and theirs the commit being replayed.
  assert.deepEqual([read.conflict?.ours, read.conflict?.theirs], ["one\nmain\nthree\n", "one\nfeature\nthree\n"]);
  await localGit(root, {kind: "take", path: "a.txt", side: "theirs", expected: sha(readFileSync(join(root, "a.txt"), "utf8"))});
  const done = await localGit(root, {kind: "continue"});
  assert.equal(done.sequence, null);
  assert.equal(done.branch, "feature");
  assert.equal(git("log", "-1", "--format=%P").trim(), rev("main"));
  assert.equal(git("log", "-1", "--format=%an <%ae> | %cn").trim(), "Other <other@example.invalid> | Fixture");
  assert.equal(git("show", "HEAD:a.txt"), "one\nfeature\nthree\n");
});

test("Skip drops the conflicting commit of a rebase; a delete against a change is taken whole", async () => {
  git("switch", "-q", "feature");
  await localGit(root, {kind: "rebase", ref: "refs/heads/main", target: rev("main"), expected: rev("HEAD")});
  const skipped = await localGit(root, {kind: "skip"});
  assert.equal(skipped.sequence, null);
  assert.equal(rev("HEAD"), rev("main"));
  git("switch", "-q", "-c", "gone", "main");
  git("rm", "-q", "a.txt"); git("commit", "-qm", "remove a");
  git("switch", "-q", "feature");
  git("reset", "-q", "--hard", "ORIG_HEAD");
  const started = await localGit(root, {kind: "merge", ref: "refs/heads/gone", target: rev("gone"), expected: rev("HEAD"), fastForward: true});
  assert.deepEqual(started.sequence?.conflicts, [{path: "a.txt", state: "deleted by them"}]);
  const taken = await localGit(root, {kind: "take", path: "a.txt", side: "theirs", expected: sha(readFileSync(join(root, "a.txt"), "utf8"))});
  assert.deepEqual(taken.sequence?.conflicts, []);
  assert.equal(existsSync(join(root, "a.txt")), false);
});

test("Take checks the file is as it was read, and takes only a conflicted file, never a folder", async () => {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/x.txt"), "x\n"); git("add", "."); git("commit", "-qm", "src on main");
  git("switch", "-q", "feature"); mkdirSync(join(root, "src"), {recursive: true}); writeFileSync(join(root, "src/x.txt"), "feature x\n"); git("add", "."); git("commit", "-qm", "src on feature");
  git("switch", "-q", "main"); writeFileSync(join(root, "src/x.txt"), "main x\n"); git("commit", "-qam", "src again");
  await localGit(root, {kind: "merge", ref: "refs/heads/feature", target: rev("feature"), expected: rev("HEAD"), fastForward: true});
  await assert.rejects(localGit(root, {kind: "take", path: "src", side: "ours", expected: null}), {message: "NOT_FOUND"});
  const current = readFileSync(join(root, "a.txt"), "utf8");
  await assert.rejects(localGit(root, {kind: "take", path: "a.txt", side: "theirs", expected: sha("edited by hand\n")}), {message: "CHANGED"});
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), current);
  const taken = await localGit(root, {kind: "take", path: "a.txt", side: "theirs", expected: sha(current)});
  assert.deepEqual(taken.sequence?.conflicts.map(conflict => conflict.path), ["src/x.txt"]);
});

test("an ignored file the merge would overwrite stops it before anything changes", async () => {
  writeFileSync(join(root, ".gitignore"), "local.cfg\n"); git("add", ".gitignore"); git("commit", "-qm", "ignore local.cfg");
  git("switch", "-q", "side"); writeFileSync(join(root, "local.cfg"), "tracked\n"); git("add", "-f", "local.cfg"); git("commit", "-qm", "track local.cfg");
  git("switch", "-q", "main"); writeFileSync(join(root, "local.cfg"), "my secret\n");
  await assert.rejects(localGit(root, {kind: "merge", ref: "refs/heads/side", target: rev("side"), expected: rev("HEAD"), fastForward: true}), {message: "IGNORED_IN_THE_WAY"});
  assert.equal(readFileSync(join(root, "local.cfg"), "utf8"), "my secret\n");
});

test("Continue that Git refuses with nothing left in conflict says so", async () => {
  git("switch", "-q", "feature");
  try { git("cherry-pick", rev("main")); } catch { /* stops on its conflict */ }
  writeFileSync(join(root, "a.txt"), "one\nfeature\nthree\n");
  git("add", "a.txt");
  await assert.rejects(localGit(root, {kind: "continue"}), {message: "SEQUENCE_STOPPED"});
  assert.equal((await localGit(root, {kind: "sequence"})).sequence?.kind, "cherry-pick");
});
