import test from "node:test";
import assert from "node:assert/strict";
import { overviewItems, type CopyState, type OverviewInput } from "../src/core/overview/items.ts";
import { overviewStages } from "../src/core/overview/stages.ts";
import type { InboxPr } from "../src/core/pulls/model.ts";
import type { Run } from "../src/core/ci/model.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
const pr = (number: number, more: Partial<InboxPr> = {}): InboxPr => ({
  id: "pr-" + number, number, title: "PR " + number, url: "https://git.example.org/team/web/pulls/" + number, repo: "team/web", author: "me",
  baseRefName: "main", headRefName: "feature-" + number, onDefaultBranch: true, stackedOn: null, isDraft: false,
  createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-28T10:00:00Z", mergedAt: null, closedAt: null, additions: 10, deletions: 2,
  ci: "passing", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: null, conflicts: false, blockers: [], myReview: null,
  forge: "gitea", accountId: "acc-1", ...more});
const run = (id: string, state: Run["state"], createdAt: string): Run => ({id, number: 1, workflow: "ci", workflowId: null, title: "build", branch: "main",
  sha: null, event: "push", state, attempt: 1, createdAt, updatedAt: null, url: null, actor: null});
const copy = (copyId: string, more: Partial<CopyState> = {}): CopyState => ({copyId, name: copyId, branch: "main", ahead: 0, behind: 0, at: null, ...more});
const empty: OverviewInput = {mine: [], requested: [], merged: [], runs: [], copies: [], now};

test("each of my open pull requests is one item, by its most pressing reason", () => {
  const items = overviewItems({...empty, mine: [
    pr(1, {ci: "failing", conflicts: true, blockers: ["Merge conflicts", "CI failing"]}),
    pr(2, {conflicts: true, blockers: ["Merge conflicts"]}),
    pr(3, {unresolvedThreads: 2, blockers: ["2 unresolved comments"]}),
    pr(4),
    pr(5, {isDraft: true, blockers: ["Draft"]}),
    pr(6, {ci: "pending", blockers: ["CI running"]}),
  ]});
  assert.deepEqual(items.map(item => [item.kind, item.pr?.number]), [
    ["ci-failed", 1], ["conflict", 2], ["threads", 3], ["ready", 4],
  ]);
  assert.deepEqual(items.map(item => item.group), ["action", "action", "action", "finish"]);
});

test("a review asked of me is an item unless the pull request is mine", () => {
  const items = overviewItems({...empty, mine: [pr(7)], requested: [pr(7), pr(8, {author: "colleague"})]});
  assert.deepEqual(items.map(item => [item.kind, item.pr?.number]), [["review", 8], ["ready", 7]]);
});

test("copies ahead are to push, copies behind are waiting; a copy can be both", () => {
  const items = overviewItems({...empty, copies: [copy("a", {ahead: 2}), copy("b", {behind: 5}), copy("c"), copy("d", {ahead: 1, behind: 1})]});
  assert.deepEqual(items.map(item => [item.kind, item.copyId]), [["unpushed", "a"], ["unpushed", "d"], ["behind", "b"], ["behind", "d"]]);
  assert.deepEqual(items.map(item => item.group), ["finish", "finish", "waiting", "waiting"]);
});

test("the newest running or queued run of each repository is waiting; finished runs are not items", () => {
  const items = overviewItems({...empty, runs: [
    {copyId: "a", repository: "team/web", runs: [run("1", "running", "2026-11-28T11:00:00Z"), run("2", "queued", "2026-11-28T11:30:00Z"), run("3", "failure", "2026-11-28T11:50:00Z")]},
    {copyId: "b", repository: "team/api", runs: [run("4", "success", "2026-11-28T11:00:00Z")]},
  ]});
  assert.deepEqual(items.map(item => [item.kind, item.copyId, item.run?.id]), [["ci-running", "a", "2"]]);
});

test("groups go action, finish, waiting; newest first inside a group", () => {
  const items = overviewItems({...empty,
    mine: [pr(1, {ci: "failing", blockers: ["CI failing"], updatedAt: "2026-11-28T09:00:00Z"}), pr(2, {conflicts: true, blockers: ["Merge conflicts"], updatedAt: "2026-11-28T11:00:00Z"})],
    copies: [copy("a", {ahead: 1})]});
  assert.deepEqual(items.map(item => item.key), ["pr:acc-1:team/web#2", "pr:acc-1:team/web#1", "copy:a:ahead"]);
});

test("the board puts the same objects in their stages; CI now lists the running runs", () => {
  const stages = overviewStages({...empty,
    mine: [pr(1, {headRefName: "feature-x"}), pr(2, {reviewDecision: "REVIEW_REQUIRED", ci: "pending", blockers: ["CI running"]}),
      pr(3, {reviewDecision: "CHANGES_REQUESTED", blockers: ["Changes requested"]}), pr(4, {isDraft: true, blockers: ["Draft"]})],
    merged: [pr(10, {mergedAt: "2026-11-25T12:00:00Z"}), pr(11, {mergedAt: "2026-11-10T12:00:00Z"})],
    copies: [copy("a", {ahead: 2, branch: "local-only"}), copy("b", {ahead: 1, branch: "feature-x"})],
    runs: [{copyId: "a", repository: "team/web", runs: [run("7", "running", "2026-11-28T11:00:00Z")]}]});
  assert.deepEqual(stages.local.map(item => item.copyId), ["a"]);
  assert.deepEqual(stages.open.map(item => item.pr?.number), [4]);
  assert.deepEqual(stages.review.map(item => item.pr?.number), [2, 3]);
  assert.deepEqual(stages.ready.map(item => item.pr?.number), [1]);
  assert.deepEqual(stages.merged.map(item => item.pr?.number), [10]);
  assert.deepEqual(stages.ciNow.map(item => item.run?.id), ["7"]);
});
