import assert from "node:assert/strict";
import { test } from "node:test";
import { githubReview } from "../src/adapters/bb/forges/review/github.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "github", id: "gh", label: "GH", origin: "https://api.github.com", organization: "", username: "me"};
const token = "fixture-token-value";
const head = "a".repeat(40);
type Call = {method: string; path: string; body: any};
function github(answer: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    return answer(call) ?? Response.json({message: "Not Found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const rawPr = {id: "PR_1", number: 7, title: "Add retries", url: "https://github.com/o/r/pull/7", isDraft: false, state: "OPEN",
  createdAt: "2026-11-27T00:00:00Z", body: "Why", author: {login: "sam"}, headRefName: "retries", headRefOid: head, baseRefName: "main",
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", repository: {nameWithOwner: "o/r", defaultBranchRef: {name: "main"}},
  reviewThreads: {nodes: [{id: "T1", isResolved: false, isOutdated: false, path: "a.ts", line: 3, originalLine: 3, resolvedBy: null, viewerCanResolve: true,
    comments: {nodes: [{author: {login: "me"}, body: "Rename?", createdAt: "2026-11-27T01:00:00Z", url: "https://evil.example/c"}]}}]},
  comments: {nodes: []}, reviews: {nodes: []}, commits: {nodes: []}};

test("the detail is one GraphQL read with the viewer, the head it was read at, and only own links", async () => {
  const {send, calls} = github(call => call.path === "/graphql" ? Response.json({data: {viewer: {login: "me"}, repository: {pullRequest: rawPr}}}) : undefined);
  const detail = await githubReview(account, token, "o/r", send).detail(7);
  assert.deepEqual(calls[0].body.variables, {owner: "o", name: "r", number: 7});
  assert.deepEqual([detail.forge, detail.viewer, detail.headSha, detail.threads[0].id], ["github", "me", head, "T1"]);
  assert.equal(detail.threads[0].comments[0].url, "");
  assert.equal(detail.timeline[0].body, "Why");
});

test("files are read page by page", async () => {
  const file = (name: string) => ({filename: name, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b"});
  const {send} = github(call => call.path.startsWith("/repos/o/r/pulls/7/files")
    ? Response.json(call.path.endsWith("&page=1") ? Array.from({length: 100}, (_, i) => file("f" + i)) : [file("last")]) : undefined);
  const files = await githubReview(account, token, "o/r", send).files(7);
  assert.deepEqual([files.length, files.at(-1)?.path], [101, "last"]);
});

const current = {id: "PR_1", headSha: head} as PrDetail;
test("each write goes to the endpoint GitHub offers for it, pinned to the reviewed head", async () => {
  const {send, calls} = github(call => call.method === "GET" ? undefined :
    call.path === "/graphql" ? Response.json({data: {ok: {}}}) : call.path.endsWith("/merge") ? Response.json({merged: true, sha: "b".repeat(40)}) : Response.json({id: 1}));
  const api = githubReview(account, token, "o/r", send);
  await api.act(7, {kind: "comment", body: "Thanks"}, current);
  await api.act(7, {kind: "reply", threadId: "T1", body: "Done"}, current);
  await api.act(7, {kind: "resolve", threadId: "T1", resolved: true}, current);
  await api.act(7, {kind: "lineComment", path: "a.ts", line: 5, side: "RIGHT", startLine: 3, body: "Here"}, current);
  await api.act(7, {kind: "review", event: "REQUEST_CHANGES", body: "Tests", comments: [{path: "a.ts", line: 2, side: "LEFT", startLine: null, body: "Why?"}]}, current);
  await api.act(7, {kind: "requestReviewer", reviewer: "ann"}, current);
  await api.act(7, {kind: "editTitle", title: "New"}, current);
  await api.act(7, {kind: "draft", draft: true}, current);
  await api.act(7, {kind: "state", open: false}, current);
  await api.act(7, {kind: "merge", method: "squash"}, current);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.path === "/graphql" ? call.body.variables : call.body]), [
    ["POST", "/repos/o/r/issues/7/comments", {body: "Thanks"}],
    ["POST", "/graphql", {threadId: "T1", body: "Done"}],
    ["POST", "/graphql", {threadId: "T1"}],
    ["POST", "/repos/o/r/pulls/7/comments", {body: "Here", commit_id: head, path: "a.ts", line: 5, side: "RIGHT", start_line: 3, start_side: "RIGHT"}],
    ["POST", "/repos/o/r/pulls/7/reviews", {commit_id: head, event: "REQUEST_CHANGES", body: "Tests", comments: [{path: "a.ts", body: "Why?", line: 2, side: "LEFT"}]}],
    ["POST", "/repos/o/r/pulls/7/requested_reviewers", {reviewers: ["ann"]}],
    ["PATCH", "/repos/o/r/pulls/7", {title: "New"}],
    ["POST", "/graphql", {prId: "PR_1"}],
    ["PATCH", "/repos/o/r/pulls/7", {state: "closed"}],
    ["PUT", "/repos/o/r/pulls/7/merge", {sha: head, merge_method: "squash"}],
  ]);
  assert.match(calls[2].body.query, /resolveReviewThread/);
  assert.match(calls[7].body.query, /convertPullRequestToDraft/);
});

test("a merge GitHub did not perform is reported", async () => {
  const {send} = github(call => call.path.endsWith("/merge") ? Response.json({merged: false, message: "Base branch was modified"}) : undefined);
  await assert.rejects(githubReview(account, token, "o/r", send).act(7, {kind: "merge", method: "merge"}, current), {message: "OUTCOME_UNKNOWN"});
});

test("a deleted comment goes to the GraphQL mutation for its kind", async () => {
  const {send, calls} = github(call => call.path === "/graphql" ? Response.json({data: {ok: {}}}) : undefined);
  const api = githubReview(account, token, "o/r", send);
  await api.act(7, {kind: "deleteComment", commentId: "IC_1", threadId: null, body: "x"}, current);
  await api.act(7, {kind: "deleteComment", commentId: "PRRC_2", threadId: "T1", body: "x"}, current);
  assert.deepEqual(calls.map(call => call.body.variables), [{id: "IC_1"}, {id: "PRRC_2"}]);
  assert.match(calls[0].body.query, /deleteIssueComment/);
  assert.match(calls[1].body.query, /deletePullRequestReviewComment/);
});
