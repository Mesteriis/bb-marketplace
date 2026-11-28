import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "../src/core/ci/model.ts";
import type { InboxPr } from "../src/core/pulls/model.ts";
import { branchPull, branchRun, errorLines, prState } from "../src/core/panel/summary.ts";

const pr = (number: number, head: string, repo: string, extra: Partial<InboxPr> = {}): InboxPr => ({id: "p" + number, number, title: "PR " + number, url: "https://example.org/" + number,
  repo, author: "me", baseRefName: "main", headRefName: head, onDefaultBranch: false, stackedOn: null, isDraft: false, createdAt: "2026-11-27T10:00:00Z",
  updatedAt: "2026-11-27T11:00:00Z", mergedAt: null, closedAt: null, additions: 10, deletions: 2, ci: "passing", failingChecks: [], unresolvedThreads: 0, notes: [],
  reviewDecision: null, conflicts: false, blockers: [], myReview: null, forge: "github", accountId: "a", ...extra});
const run = (id: string, branch: string | null, startedAt: string): Run => ({id, number: Number(id), workflow: "ci", workflowId: null, title: "t", branch, sha: null,
  event: "push", state: "success", attempt: 1, createdAt: startedAt, updatedAt: null, url: null, actor: null, startedAt});

test("the copy's pull request is the open one from its branch in its repository", () => {
  const mine = [pr(1, "feature", "acme/web"), pr(2, "feature", "acme/api"), pr(3, "main", "acme/web")];
  assert.equal(branchPull(mine, "feature", "github.com/acme/web")?.number, 1);
  assert.equal(branchPull(mine, "other", "github.com/acme/web"), null);
  assert.equal(branchPull(mine, null, "github.com/acme/web"), null);
  assert.equal(branchPull(mine, "feature", null), null);
});

test("the copy's CI is the newest run on its own branch", () => {
  const runs = [run("1", "feature", "2026-11-27T10:00:00Z"), run("2", "main", "2026-11-27T12:00:00Z"), run("3", "feature", "2026-11-27T11:00:00Z")];
  assert.equal(branchRun(runs, "feature")?.id, "3");
  assert.equal(branchRun(runs, "nowhere"), null);
  assert.equal(branchRun(runs, null), null);
});

test("the error lines shown under CI are the error line and the one after it, numbered from 1", () => {
  const lines = ["a", "b", "✗ checkout fails", "Timeout 30000ms", "c"];
  assert.deepEqual(errorLines(lines, 2), [{number: 3, text: "✗ checkout fails"}, {number: 4, text: "Timeout 30000ms"}]);
  assert.deepEqual(errorLines(lines, 4), [{number: 5, text: "c"}]);
  assert.deepEqual(errorLines(lines, null), []);
});

test("a pull request's chips say CI, review and conflicts in words, the worst first", () => {
  assert.deepEqual(prState(pr(1, "f", "r", {ci: "failing", reviewDecision: "REVIEW_REQUIRED", conflicts: false})),
    [{key: "ci-failed", tone: "bad"}, {key: "review-waiting", tone: "line"}, {key: "no-conflicts", tone: "line"}]);
  assert.deepEqual(prState(pr(1, "f", "r", {ci: "passing", reviewDecision: "APPROVED", conflicts: true, unresolvedThreads: 2})),
    [{key: "conflict", tone: "warn"}, {key: "ci-passed", tone: "good"}, {key: "approved", tone: "good"}, {key: "unanswered", tone: "line", n: 2}]);
  assert.deepEqual(prState(pr(1, "f", "r", {ci: "pending", isDraft: true, reviewDecision: "CHANGES_REQUESTED"})),
    [{key: "draft", tone: "line"}, {key: "ci-running", tone: "warn"}, {key: "changes", tone: "bad"}, {key: "no-conflicts", tone: "line"}]);
});
