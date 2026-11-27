import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewDiff, ReviewDiffFile } from "../src/core/code-review/diff.ts";
import { changedFiles, fingerprint, ranges, readsOnly, reasoningLevel, runPermissionMode, spawnPermissionMode } from "../src/core/code-review/runs.ts";

const file = (path: string, patch: string | null, additions = 1): ReviewDiffFile => ({path, previousPath: null, changeKind: "modified", additions, deletions: 0,
  binary: false, untracked: false, patch, tooLarge: patch === null});
const diff = (...files: ReviewDiffFile[]): ReviewDiff => ({files, truncated: false, baseSha: null, headSha: null});

test("the permission mode falls back to auto, and to full where the provider lacks it", () => {
  assert.equal(runPermissionMode("accept-edits"), "accept-edits");
  assert.equal(runPermissionMode("full"), "auto");
  assert.equal(runPermissionMode(""), "auto");
  assert.equal(spawnPermissionMode("auto", null), "auto");
  assert.equal(spawnPermissionMode("auto", ["accept-edits", "full"]), "full");
  assert.equal(spawnPermissionMode("accept-edits", ["accept-edits", "full"]), "accept-edits");
});

test("an unknown reasoning effort runs at medium", () => {
  assert.equal(reasoningLevel("high"), "high");
  assert.equal(reasoningLevel("minimal"), "medium");
});

test("only a fix run may edit", () => {
  assert.deepEqual((["review", "fix", "summary", "explain"] as const).map(readsOnly), [true, false, true, true]);
});

test("the files a run changed are those whose change differs, added and gone ones included", () => {
  const before = fingerprint(diff(file("a.ts", "@@ -1 +1 @@\n-a\n+b"), file("b.ts", "@@ -1 +1 @@\n-x\n+y"), file("big.bin", null, 900)));
  const after = fingerprint(diff(file("a.ts", "@@ -1 +1 @@\n-a\n+b"), file("b.ts", "@@ -1 +1 @@\n-x\n+z"), file("big.bin", null, 901), file("c.ts", "+new")));
  assert.match(before["a.ts"], /^[0-9a-f]{16}$/);
  assert.deepEqual(changedFiles(before, after), ["b.ts", "big.bin", "c.ts"]);
  assert.deepEqual(changedFiles(after, fingerprint(diff())), ["a.ts", "b.ts", "big.bin", "c.ts"]);
  assert.deepEqual(changedFiles(before, before), []);
});

test("line numbers read as ranges", () => {
  assert.equal(ranges([12, 1, 2, 3, 4, 11, 20, 3]), "1-4, 11-12, 20");
  assert.equal(ranges([]), "");
  assert.equal(ranges([7]), "7");
});

test("a run's title says what it does", async () => {
  const {runTitle} = await import("../src/ui/code-review/run-labels.ts");
  const run = {id: "r", sessionId: "s", threadId: null, providerId: "codex", model: null, status: "done" as const, summary: null, changedFiles: null, createdAt: 1, finishedAt: 1};
  assert.deepEqual([runTitle({...run, kind: "review", focus: null}), runTitle({...run, kind: "review", focus: "Security, Tests"}),
    runTitle({...run, kind: "fix", focus: null}), runTitle({...run, kind: "summary", focus: null}), runTitle({...run, kind: "explain", focus: "src/a.ts:3-4"})],
  ["AI review", "AI review · Security, Tests", "Fixes in a new thread", "Summary", "Explain · src/a.ts:3-4"]);
});
