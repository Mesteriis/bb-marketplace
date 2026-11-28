import test from "node:test";
import assert from "node:assert/strict";
import { fileChanges, parseCommits, parseRefs, workingChanges } from "../src/core/history/parse.ts";

const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), t = "d".repeat(40);

test("refs are grouped by commit, annotated tags dereferenced, the current branch marked first", () => {
  const raw = [a, "", "refs/heads/feature", b, "", "refs/heads/main", t, b, "refs/tags/v1.0", b, "", "refs/remotes/origin/main",
    c, "", "refs/t3/checkpoints/x", ""].join("\0");
  const refs = parseRefs(raw, "refs/heads/main", b);
  assert.deepEqual(refs.byHash[b].map(ref => [ref.name, ref.kind, ref.isHead]),
    [["main", "local", true], ["v1.0", "tag", false], ["origin/main", "remote", false]]);
  assert.deepEqual(refs.byHash[a].map(ref => ref.name), ["feature"]);
  assert.equal(refs.byHash[c], undefined, "tool checkpoints are hidden");
});

test("a detached HEAD gets its own HEAD label", () => {
  const refs = parseRefs([b, "", "refs/heads/main", ""].join("\0"), null, a);
  assert.deepEqual(refs.byHash[a], [{fullName: "HEAD", name: "HEAD", kind: "other", isHead: true}]);
});

test("log records keep octopus parents, an empty root parent list and subjects with separators", () => {
  const raw = [a, [b, c, t].join(" "), "Ann", "ann@example.invalid", "2026-11-27T10:00:00+03:00", "2026-11-27T10:01:00+03:00", "Merge three | ok",
    b, "", "Bob", "bob@example.invalid", "2026-11-26T10:00:00Z", "2026-11-26T10:00:00Z", "Root", ""].join("\0");
  const commits = parseCommits(raw, {[a]: [{fullName: "refs/heads/main", name: "main", kind: "local", isHead: true}]});
  assert.deepEqual(commits.map(item => [item.hash.slice(0, 1), item.parents.length, item.subject, item.refs.length]),
    [["a", 3, "Merge three | ok", 1], ["b", 0, "Root", 0]]);
});

test("file changes join statuses with line counts, including paths with tabs and binary files", () => {
  const nameStatus = ["M", "src/a.ts", "A", "dir/with\ttab.txt", "D", "old.txt", "R100", "from.txt", "to.txt", ""].join("\0");
  const numstat = ["3\t1\tsrc/a.ts", "-\t-\tdir/with\ttab.txt", "0\t7\told.txt", "0\t0\t", "from.txt", "to.txt", ""].join("\0");
  assert.deepEqual(fileChanges(nameStatus, numstat), [
    {path: "src/a.ts", status: "modified", additions: 3, deletions: 1},
    {path: "dir/with\ttab.txt", status: "added", additions: null, deletions: null, binary: true},
    {path: "old.txt", status: "deleted", additions: 0, deletions: 7},
    {path: "to.txt", status: "renamed", additions: 0, deletions: 0},
  ]);
});

test("uncommitted files come from porcelain status, with counts where Git has them", () => {
  const status = [" M src/a.ts", "?? new file.txt", "UU conflict.txt", "D  gone.txt", ""].join("\0");
  const numstat = ["2\t0\tsrc/a.ts", "1\t1\tconflict.txt", ""].join("\0");
  assert.deepEqual(workingChanges(status, numstat), [
    {path: "src/a.ts", status: "modified", additions: 2, deletions: 0},
    {path: "new file.txt", status: "added", additions: null, deletions: null},
    {path: "conflict.txt", status: "conflicted", additions: 1, deletions: 1},
    {path: "gone.txt", status: "deleted", additions: null, deletions: null},
  ]);
});
