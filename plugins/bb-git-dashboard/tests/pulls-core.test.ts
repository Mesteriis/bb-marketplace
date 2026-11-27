import assert from "node:assert/strict";
import { test } from "node:test";
import { blockersOf, linkStacks, type Pr } from "../src/core/pulls/model.ts";

const pr = (over: Partial<Pr>): Pr => ({
  id: "1", number: 1, title: "T", url: "https://forge.example/o/r/pulls/1", repo: "o/r", author: "me", baseRefName: "main", headRefName: "feat",
  onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "2026-11-27T00:00:00Z", updatedAt: "2026-11-27T00:00:00Z",
  mergedAt: null, closedAt: null, additions: null, deletions: null, ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [],
  reviewDecision: null, conflicts: false, blockers: [], myReview: null, ...over,
});

test("a forge's own reasons follow the common ones and precede Awaiting review", () => {
  assert.deepEqual(blockersOf(pr({conflicts: true, notes: ["Needs rebase"], reviewDecision: "REVIEW_REQUIRED"})),
    ["Merge conflicts", "Needs rebase", "Awaiting review"]);
  assert.deepEqual(blockersOf(pr({notes: ["Needs rebase"], mergedAt: "2026-11-27T01:00:00Z"})), []);
});

test("without stack data, a PR based on another open PR's branch in the same repo is stacked on it", () => {
  const parent = pr({id: "a", number: 10, title: "Base work", url: "https://forge.example/o/r/pulls/10", headRefName: "feat/base"});
  const child = pr({id: "b", number: 11, baseRefName: "feat/base", onDefaultBranch: false, headRefName: "feat/top"});
  const elsewhere = pr({id: "c", number: 12, repo: "o/other", baseRefName: "feat/base", onDefaultBranch: false});
  const merged = pr({id: "d", number: 13, headRefName: "feat/gone", mergedAt: "2026-11-27T01:00:00Z"});
  const orphan = pr({id: "e", number: 14, baseRefName: "feat/gone", onDefaultBranch: false});
  const linked = linkStacks([parent, child, elsewhere, merged, orphan]);
  assert.deepEqual(linked[1].stackedOn, {number: 10, title: "Base work", url: "https://forge.example/o/r/pulls/10"});
  assert.deepEqual(linked[1].blockers, ["Stacked on #10"]);
  assert.equal(linked[2].stackedOn, null);
  assert.equal(linked[4].stackedOn, null);
  // The default branch is never a parent, even when some PR's source branch is named like it.
  const fromMain = pr({id: "f", number: 15, headRefName: "main"});
  assert.equal(linkStacks([fromMain, pr({id: "g", number: 16})])[1].stackedOn, null);
});

test("a pull request's projects are found by their remote on any forge, and its thread by branch", async () => {
  const {branchThread, projectsOfRepo} = await import("../src/core/pulls/agent-target.ts");
  const projects = [{id: "p1", gitRemoteUrl: "git@gitlab.example.org:group/sub/app.git"}, {id: "p2", gitRemoteUrl: "https://gitlab.example.org/Group/Sub/App"},
    {id: "p3", gitRemoteUrl: "https://gitlab.example.org/group/other.git"}, {id: "p4", gitRemoteUrl: null}];
  assert.deepEqual(projectsOfRepo("gitlab", "group/sub/app", projects), ["p1", "p2"]);
  const thread = (id: string, projectId: string, branch: string | null, updatedAt: number, archivedAt: number | null = null) =>
    ({id, projectId, environmentId: "e", environmentBranchName: branch, archivedAt, updatedAt, title: null, titleFallback: null});
  assert.equal(branchThread([thread("t1", "p1", "retries", 1), thread("t2", "p2", "retries", 5), thread("t3", "p3", "retries", 9),
    thread("t4", "p1", "retries", 7, 1), thread("t5", "p1", "main", 8)], ["p1", "p2"], "retries"), "t2");
  assert.equal(branchThread([], ["p1"], "retries"), null);
});

test("a selection of diff rows becomes a line comment anchor", async () => {
  const {lineAnchor, parsePatch} = await import("../src/core/pulls/diff.ts");
  const rows = parsePatch("@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+more\n@@ -40 +41 @@\n tail");
  assert.deepEqual(lineAnchor(rows, 3, 4), {side: "RIGHT", line: 12, startLine: 11, contextLine: null});
  assert.deepEqual(lineAnchor(rows, 2, 2), {side: "LEFT", line: 11, startLine: null, contextLine: null});
  assert.deepEqual(lineAnchor(rows, 1, 1), {side: "RIGHT", line: 10, startLine: null, contextLine: 10});
  // From a removed row to an added one: the sides differ, so the anchor is the last row alone.
  assert.deepEqual(lineAnchor(rows, 2, 3), {side: "RIGHT", line: 11, startLine: null, contextLine: null});
  assert.equal(lineAnchor(rows, 4, 6), null);
  assert.equal(lineAnchor(rows, 0, 0), null);
});
