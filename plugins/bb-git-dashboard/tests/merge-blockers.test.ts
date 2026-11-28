import test from "node:test";
import assert from "node:assert/strict";
import { mergeLines } from "../src/core/pulls/merge-blockers.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";

type Input = Parameters<typeof mergeLines>[0];
const check = (name: string, status: "failing" | "pending" | "passing" | "skipped") => ({name, workflow: "CI", status, conclusion: null, url: null, title: null, summary: null, annotations: []});
const thread = (resolved: boolean, awaitingReply: boolean) => ({isResolved: resolved, isPending: false, awaitingReply}) as PrDetail["threads"][number];
const base: Input = {checks: [], reviewers: [], reviewDecision: null, conflicts: false, threads: [], isDraft: false, stackedOn: null, baseRefName: "main"};

test("what keeps a pull request from merging: CI with its count, review with approvals and unanswered comments, conflicts", () => {
  assert.deepEqual(mergeLines({...base, checks: [check("lint", "passing"), check("e2e", "failing"), check("unit", "passing")],
    reviewers: [{name: "a", avatarUrl: null, team: false, state: "APPROVED"}, {name: "b", avatarUrl: null, team: false, state: "REQUESTED"}],
    reviewDecision: "REVIEW_REQUIRED", threads: [thread(false, true), thread(false, true), thread(true, false), thread(false, false)]}), [
    {key: "ci", sense: "failed", failing: "e2e", passed: 2, total: 3},
    {key: "review", sense: "waiting", approvals: 1, unanswered: 2},
    {key: "conflicts", sense: "ok", base: "main"},
  ]);
});

test("each line has its sense: running CI waits, requested changes are to do, a conflict fails, green and approved are in order", () => {
  assert.deepEqual(mergeLines({...base, checks: [check("unit", "pending"), check("lint", "passing")], reviewDecision: "CHANGES_REQUESTED", conflicts: true}), [
    {key: "ci", sense: "waiting", failing: null, passed: 1, total: 2},
    {key: "review", sense: "todo", approvals: 0, unanswered: 0},
    {key: "conflicts", sense: "failed", base: "main"},
  ]);
  assert.deepEqual(mergeLines({...base, checks: [check("unit", "passing"), check("docs", "skipped")], reviewDecision: "APPROVED",
    reviewers: [{name: "a", avatarUrl: null, team: false, state: "APPROVED"}]}).map(line => [line.key, line.sense]), [["ci", "ok"], ["review", "ok"], ["conflicts", "ok"]]);
});

test("no checks and no review asked say nothing of them; a draft and a stacked pull request wait", () => {
  assert.deepEqual(mergeLines({...base, isDraft: true, stackedOn: {number: 4, title: "x", url: "u"}}).map(line => [line.key, line.sense]),
    [["conflicts", "ok"], ["draft", "waiting"], ["stacked", "waiting"]]);
});

test("the description is the timeline's first entry when it is the pull request's body; the rest is the discussion", async () => {
  const {splitTimeline} = await import("../src/core/pulls/detail.ts");
  const entry = (id: string, body: string, reviewState: string | null = null) => ({id, canDelete: false, author: "a", avatarUrl: null, body, createdAt: "2026-11-28T10:00:00Z", url: "", reviewState});
  const withBody = splitTimeline({body: "Fixes the greeting.\n", timeline: [entry("", "Fixes the greeting."), entry("c1", "Looks fine"), entry("", "", "APPROVED")]});
  assert.deepEqual([withBody.description?.body, withBody.discussion.map(item => item.id || item.reviewState)], ["Fixes the greeting.", ["c1", "APPROVED"]]);
  const without = splitTimeline({body: "", timeline: [entry("", "Nice", "COMMENTED")]});
  assert.deepEqual([without.description, without.discussion.length], [null, 1]);
});
