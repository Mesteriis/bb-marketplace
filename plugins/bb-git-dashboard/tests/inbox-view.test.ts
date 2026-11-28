import test from "node:test";
import assert from "node:assert/strict";
import { blockersOf, type InboxPr } from "../src/core/pulls/model.ts";
import { filterCounts, matchesFilter, rowStates } from "../src/core/pulls/inbox-view.ts";

const pr = (number: number, more: Partial<InboxPr> = {}): InboxPr => {
  const row: InboxPr = {id: "p" + number, number, title: "PR " + number, url: "https://git.example.org/team/web/pulls/" + number, repo: "team/web",
    author: "me", baseRefName: "main", headRefName: "feature", onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-28T10:00:00Z", mergedAt: null, closedAt: null, additions: 1, deletions: 1, ci: "passing", failingChecks: [], unresolvedThreads: 0,
    notes: [], reviewDecision: "APPROVED", conflicts: false, blockers: [], myReview: null, forge: "github", accountId: "acc", ...more};
  return {...row, blockers: blockersOf(row)};
};

test("the filter chips count CI failed, conflicts, changes requested, unanswered threads and ready to merge", () => {
  const items = [pr(1, {ci: "failing"}), pr(2, {conflicts: true, unresolvedThreads: 1}), pr(3, {reviewDecision: "CHANGES_REQUESTED"}),
    pr(4, {unresolvedThreads: 3}), pr(5), pr(6, {isDraft: true}), pr(7, {ci: "pending", reviewDecision: "REVIEW_REQUIRED"})];
  assert.deepEqual(filterCounts(items), {"ci-failed": 1, conflict: 1, changes: 1, unanswered: 2, ready: 1});
  assert.deepEqual(items.filter(item => matchesFilter(item, "unanswered")).map(item => item.number), [2, 4]);
  assert.deepEqual(items.filter(item => matchesFilter(item, "ready")).map(item => item.number), [5]);
  assert.deepEqual(items.filter(item => matchesFilter(item, null)).length, 7);
});

test("a row says its states in words, the worst first, each with its tone", () => {
  assert.deepEqual(rowStates(pr(1, {ci: "failing", unresolvedThreads: 2})), [{key: "ci-failed", tone: "bad"}, {key: "unanswered", n: 2, tone: "line"}]);
  assert.deepEqual(rowStates(pr(2, {conflicts: true})), [{key: "conflict", tone: "warn"}]);
  assert.deepEqual(rowStates(pr(3, {isDraft: true, stackedOn: {number: 9, title: "base", url: "u"}})), [{key: "draft", tone: "line"}, {key: "stacked", n: 9, tone: "line"}]);
  assert.deepEqual(rowStates(pr(4)), [{key: "ready", tone: "good"}]);
  assert.deepEqual(rowStates(pr(5, {ci: "pending", reviewDecision: "REVIEW_REQUIRED"})), [{key: "ci-running", tone: "line"}, {key: "review", tone: "line"}]);
  assert.deepEqual(rowStates(pr(6, {mergedAt: "2026-11-28T09:00:00Z"})), []);
  // A forge's own reason is shown as it wrote it, and a row with one is not ready.
  assert.deepEqual(rowStates(pr(7, {notes: ["Needs rebase"]})), [{key: "note", text: "Needs rebase", tone: "warn"}]);
});
