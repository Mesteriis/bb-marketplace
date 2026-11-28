import test from "node:test";
import assert from "node:assert/strict";
import { blockersOf, type InboxPr } from "../src/core/pulls/model.ts";
import { blockerList, overviewItems, type CopyState, type OverviewInput } from "../src/core/overview/items.ts";
import { overviewStages } from "../src/core/overview/stages.ts";
import type { Run } from "../src/core/ci/model.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
// A row as the forges' adapters give it: blockers computed by blockersOf from the fields, as in the inbox.
const pr = (number: number, more: Partial<InboxPr> = {}): InboxPr => {
  const row: InboxPr = {
    id: "pr-" + number, number, title: "PR " + number, url: "https://git.example.org/team/web/pulls/" + number, repo: "team/web", author: "me",
    baseRefName: "main", headRefName: "feature-" + number, onDefaultBranch: true, stackedOn: null, isDraft: false,
    createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-28T10:00:00Z", mergedAt: null, closedAt: null, additions: 10, deletions: 2,
    ci: "passing", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: "APPROVED", conflicts: false, blockers: [], myReview: null,
    forge: "github", accountId: "acc-1", ...more};
  return {...row, blockers: blockersOf(row)};
};
const run = (id: string, state: Run["state"], createdAt: string, startedAt: string | null = null): Run => ({id, number: 1, workflow: "ci", workflowId: null,
  title: "build", branch: "main", sha: null, event: "push", state, attempt: 1, createdAt, updatedAt: null, url: null, actor: null, startedAt});
const copy = (copyId: string, more: Partial<CopyState> = {}): CopyState =>
  ({copyId, name: "web", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: 0, at: null, ...more});
const empty: OverviewInput = {mine: [], requested: [], merged: [], runs: [], copies: [], now};
const kinds = (input: OverviewInput) => overviewItems(input).map(item => [item.kind, item.pr?.number ?? item.copyId]);

test("each of my open pull requests is one item, by its most pressing reason", () => {
  assert.deepEqual(kinds({...empty, mine: [
    pr(1, {ci: "failing", conflicts: true}),
    pr(2, {conflicts: true}),
    pr(3, {reviewDecision: "CHANGES_REQUESTED"}),
    pr(4, {unresolvedThreads: 2}),
    pr(5),
    pr(6, {isDraft: true}),
    pr(7, {ci: "pending"}),
  ]}), [["ci-failed", 1], ["conflict", 2], ["changes", 3], ["threads", 4], ["ready", 5], ["ci-running", 7]]);
});

test("ready means CI green and no review still required: a forge that does not say is not taken as a yes", () => {
  // Gitea gives no review decision; Azure no CI state: neither is ready on its own word.
  assert.deepEqual(kinds({...empty, mine: [pr(1, {forge: "gitea", reviewDecision: null}), pr(2, {forge: "azure", ci: "none"}),
    pr(3, {reviewDecision: "REVIEW_REQUIRED"}), pr(4, {stackedOn: {number: 1, title: "base", url: "u"}})]}), []);
});

test("a review asked of me is an item unless the pull request is mine; one pull request read by two accounts is one item", () => {
  assert.deepEqual(kinds({...empty, mine: [pr(7)], requested: [pr(7), pr(8, {author: "colleague"}), pr(8, {author: "colleague", accountId: "acc-2"})]}),
    [["review", 8], ["ready", 7]]);
  assert.deepEqual(kinds({...empty, mine: [pr(9, {ci: "failing"}), pr(9, {ci: "failing", accountId: "acc-2"})]}), [["ci-failed", 9]]);
});

test("copies ahead or never published are to push, copies behind are waiting; a detached copy is neither", () => {
  assert.deepEqual(kinds({...empty, copies: [copy("a", {ahead: 2}), copy("b", {behind: 5}), copy("c"), copy("d", {ahead: 1, behind: 1}),
    copy("e", {branch: "spike", upstream: null}), copy("f", {branch: null, upstream: null})]}),
    [["unpushed", "a"], ["unpushed", "d"], ["unpushed", "e"], ["behind", "b"], ["behind", "d"]]);
});

test("the newest running or queued run of each repository is waiting, timed by when it started", () => {
  const items = overviewItems({...empty, runs: [
    {copyId: "a", repository: "team/web", runs: [run("1", "running", "2026-11-28T11:00:00Z"), run("2", "queued", "2026-11-28T11:30:00Z", "2026-11-28T11:40:00Z"),
      run("3", "failure", "2026-11-28T11:50:00Z")]},
    {copyId: "b", repository: "team/api", runs: [run("4", "success", "2026-11-28T11:00:00Z")]},
  ]});
  assert.deepEqual(items.map(item => [item.kind, item.copyId, item.run?.id, item.at]), [["ci-running", "a", "2", "2026-11-28T11:40:00Z"]]);
});

test("groups go action, finish, waiting; newest first inside a group", () => {
  const items = overviewItems({...empty,
    mine: [pr(1, {ci: "failing", updatedAt: "2026-11-28T09:00:00Z"}), pr(2, {conflicts: true, updatedAt: "2026-11-28T11:00:00Z"})],
    copies: [copy("a", {ahead: 1})]});
  assert.deepEqual(items.map(item => item.pr?.number ?? item.copyId), [2, 1, "a"]);
});

test("what keeps a pull request from merging, as words of the interface rather than the forge's English", () => {
  assert.deepEqual(blockerList(pr(1, {isDraft: true, stackedOn: {number: 4, title: "b", url: "u"}, conflicts: true, ci: "failing",
    failingChecks: [{name: "lint", workflow: null, url: null}], reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, notes: ["Needs rebase"]})), [
    {key: "draft"}, {key: "stacked", n: 4}, {key: "conflicts"}, {key: "ci-failing", n: 1}, {key: "changes"}, {key: "threads", n: 2}, {key: "note", text: "Needs rebase"},
  ]);
  assert.deepEqual(blockerList(pr(2, {ci: "pending", reviewDecision: "REVIEW_REQUIRED"})), [{key: "ci-running"}, {key: "review-required"}]);
  assert.deepEqual(blockerList(pr(3)), []);
});

test("the board puts the same objects in their stages; a copy's branch counts as having a pull request only in its own repository", () => {
  const stages = overviewStages({...empty,
    mine: [pr(1, {headRefName: "feature-x"}), pr(2, {reviewDecision: "REVIEW_REQUIRED", ci: "pending"}),
      pr(3, {reviewDecision: "CHANGES_REQUESTED"}), pr(4, {isDraft: true}), pr(5, {repo: "team/api", headRefName: "spike"})],
    merged: [pr(10, {mergedAt: "2026-11-25T12:00:00Z"}), pr(11, {mergedAt: "2026-11-10T12:00:00Z"})],
    copies: [copy("a", {ahead: 2, branch: "local-only"}), copy("b", {ahead: 1, branch: "feature-x"}), copy("c", {branch: "spike", upstream: null})]});
  assert.deepEqual(stages.local.map(card => [card.copyId, card.kind]), [["a", "unpushed"], ["c", "unpushed"]]);
  assert.deepEqual(stages.open.map(card => [card.pr?.number, card.kind]), [[4, null]]);
  assert.deepEqual(stages.review.map(card => [card.pr?.number, card.kind]), [[2, "ci-running"], [3, "changes"]]);
  assert.deepEqual(stages.ready.map(card => [card.pr?.number, card.kind]), [[1, "ready"], [5, "ready"]]);
  assert.deepEqual(stages.merged.map(card => [card.pr?.number, card.kind]), [[10, null]]);
});

test("a review asked of me stands in In review, marked as waiting for me; my own pull request is not doubled there", () => {
  const stages = overviewStages({...empty, mine: [pr(7)], requested: [pr(7), pr(8, {author: "colleague", reviewDecision: null}),
    pr(8, {author: "colleague", reviewDecision: null, accountId: "acc-2"})]});
  assert.deepEqual(stages.review.map(card => [card.pr?.number, card.kind]), [[8, "review"]]);
  assert.deepEqual(stages.ready.map(card => card.pr?.number), [7]);
});

test("a copy behind its upstream stands in Local too, once, with both distances", () => {
  const stages = overviewStages({...empty, copies: [copy("a", {behind: 5}), copy("b", {ahead: 1, behind: 2}), copy("c")]});
  assert.deepEqual(stages.local.map(card => [card.copyId, card.kind, card.copy?.ahead, card.copy?.behind]), [["a", "behind", 0, 5], ["b", "unpushed", 1, 2]]);
});

test("CI now shows what the list shows running — copies' runs and my pull requests' CI — and what failed lately, newest first", () => {
  const stages = overviewStages({...empty,
    mine: [pr(5, {ci: "pending", updatedAt: "2026-11-28T11:58:00Z"}), pr(3, {ci: "failing", updatedAt: "2026-11-28T11:00:00Z"}), pr(6, {isDraft: true, ci: "pending"})],
    runs: [
      {copyId: "a", repository: "team/web", runs: [run("7", "running", "2026-11-28T11:30:00Z", "2026-11-28T11:31:00Z")]},
      {copyId: "b", repository: "team/api", runs: [run("8", "failure", "2026-11-28T11:45:00Z"), run("9", "success", "2026-11-28T10:00:00Z")]},
      {copyId: "c", repository: "team/old", runs: [run("10", "failure", "2026-11-25T10:00:00Z")]},
    ]});
  assert.deepEqual(stages.ciNow.map(card => [card.kind, card.pr?.number ?? card.run?.id]), [
    ["ci-running", 5], ["ci-failed", "8"], ["ci-running", "7"], ["ci-failed", 3],
  ]);
});

test("everything the list shows is on the board; the board adds only drafts and pull requests waiting on others, and merged ones", () => {
  const input: OverviewInput = {...empty,
    mine: [pr(1, {ci: "failing"}), pr(2, {conflicts: true}), pr(3, {reviewDecision: "CHANGES_REQUESTED"}), pr(4, {unresolvedThreads: 1}), pr(5),
      pr(6, {ci: "pending"}), pr(7, {isDraft: true})],
    requested: [pr(20, {author: "colleague"})],
    merged: [pr(30, {mergedAt: "2026-11-27T12:00:00Z"})],
    copies: [copy("a", {ahead: 1}), copy("b", {behind: 2})],
    runs: [{copyId: "a", repository: "team/web", runs: [run("1", "running", "2026-11-28T11:00:00Z")]}]};
  const listed = new Set(overviewItems(input).map(item => item.key));
  const stages = overviewStages(input);
  const boarded = new Set([...stages.local, ...stages.open, ...stages.review, ...stages.ready, ...stages.merged, ...stages.ciNow].map(card => card.key));
  assert.deepEqual([...listed].filter(key => !boarded.has(key)), []);
  assert.deepEqual([...boarded].filter(key => !listed.has(key)).sort(), ["pr:" + pr(30).url, "pr:" + pr(7).url].sort());
});

test("what keeps a pull request from merging says what kind of thing it is: failed, waiting or for someone to do", async () => {
  const {blockerSense} = await import("../src/core/overview/items.ts");
  assert.deepEqual(["ci-failing", "conflicts", "ci-running", "review-required", "draft", "stacked", "changes", "threads"]
    .map(key => blockerSense({key} as never)), ["failed", "failed", "waiting", "waiting", "waiting", "waiting", "todo", "todo"]);
  assert.equal(blockerSense({key: "note", text: "Needs rebase"}), "todo");
});
