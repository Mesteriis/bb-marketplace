import assert from "node:assert/strict";
import { test } from "node:test";
import { branchRows, previewLines } from "../src/core/merge/branches.ts";

const a = "a".repeat(40), b = "b".repeat(40);
test("branches are read with their full refs, local first; a remote's HEAD alias is left out", () => {
  const text = ["refs/heads/main " + a + " /work/repo", "refs/heads/origin/odd " + b + " ", "refs/remotes/origin/HEAD " + a + " ", "refs/remotes/origin/main " + a + " ", ""].join("\n");
  assert.deepEqual(branchRows(text).map(({ref, name, remote, target, worktree}) => ({ref, name, remote, target, worktree})), [
    {ref: "refs/heads/main", name: "main", remote: false, target: a, worktree: "/work/repo"},
    {ref: "refs/heads/origin/odd", name: "origin/odd", remote: false, target: b, worktree: null},
    {ref: "refs/remotes/origin/main", name: "origin/main", remote: true, target: a, worktree: null},
  ]);
});

test("the preview says what a merge or rebase will do, and which files will conflict", () => {
  const preview = {incoming: 3, outgoing: 2, conflicts: ["a.txt", "b.txt"], fastForward: false, upToDate: false};
  assert.deepEqual(previewLines("merge", "feature", "main", preview, true), [
    "Merge feature (3 commits) into main",
    "Expected conflicts in 2 files: a.txt, b.txt. The merge stops for you to resolve them.",
  ]);
  assert.deepEqual(previewLines("rebase", "main", "feature", preview, true), [
    "Rebase feature (2 commits) onto main (3 new commits)",
    "Likely conflicts in 2 files: a.txt, b.txt. The rebase stops at each conflicting commit for you to resolve it.",
  ]);
  assert.deepEqual(previewLines("rebase", "main", "feature", {...preview, conflicts: []}, true), [
    "Rebase feature (2 commits) onto main (3 new commits)",
    "The branches merge without conflicts; a commit on the way may still stop the rebase.",
  ]);
  assert.deepEqual(previewLines("merge", "feature", "main", {...preview, conflicts: [], fastForward: true}, true), ["Fast-forward main to feature (3 commits)"]);
  assert.deepEqual(previewLines("merge", "feature", "main", {...preview, conflicts: [], fastForward: true}, false),
    ["Merge feature (3 commits) into main with a merge commit", "No conflicts expected."]);
  assert.deepEqual(previewLines("merge", "feature", "main", {...preview, incoming: 0, upToDate: true}, true), ["main already contains feature: nothing to merge."]);
  assert.deepEqual(previewLines("merge", "feature", "main", {...preview, incoming: 1, conflicts: []}, true), ["Merge feature (1 commit) into main", "No conflicts expected."]);
});

test("a branch's upstream, its distance and its last commit come from the same listing, fields split by the unit separator", () => {
  const u = "\u001f";
  const text = [
    ["refs/heads/feature", a, "", "origin/feature", "ahead 1, behind 2", "2026-11-28T10:00:00+00:00", "Dev One", "wire up saved cards"].join(u),
    ["refs/heads/old", b, "/work/old tree", "origin/old", "gone", "2026-11-20T10:00:00+00:00", "Dev Two", "fix: a, b and c"].join(u),
    ["refs/heads/local", b, "", "", "", "2026-11-21T10:00:00+00:00", "Dev One", "local only"].join(u),
    ["refs/remotes/origin/HEAD", a, "", "", "", "", "", ""].join(u),
  ].join("\n");
  assert.deepEqual(branchRows(text).map(row => [row.name, row.worktree, row.upstream, row.ahead, row.behind, row.gone, row.author, row.date, row.subject]), [
    ["feature", null, "origin/feature", 1, 2, false, "Dev One", "2026-11-28T10:00:00+00:00", "wire up saved cards"],
    ["old", "/work/old tree", "origin/old", 0, 0, true, "Dev Two", "2026-11-20T10:00:00+00:00", "fix: a, b and c"],
    ["local", null, null, 0, 0, false, "Dev One", "2026-11-21T10:00:00+00:00", "local only"],
  ]);
});
