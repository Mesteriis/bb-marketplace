import assert from "node:assert/strict";
import { test } from "node:test";
import { azureReview } from "../src/adapters/bb/forges/review/azure.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "azure", id: "az", label: "AZ", origin: "https://dev.azure.com", organization: "contoso", username: "me"};
const token = "fixture-token-value";
const head = "a".repeat(40);
const me = "11111111-1111-1111-1111-111111111111";
const pr = "/contoso/Web/_apis/git/repositories/app/pullrequests/7";
type Call = {method: string; path: string; body: any};
function azure(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    assert.equal(url.searchParams.get("api-version"), "7.1");
    const call = {method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    return routes[call.method + " " + url.pathname]?.(call) ?? Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const raw = {pullRequestId: 7, title: "Add retries", description: "Why", status: "active", isDraft: true, createdBy: {id: "s", displayName: "Sam"},
  creationDate: "2026-11-27T00:00:00Z", sourceRefName: "refs/heads/retries", targetRefName: "refs/heads/main", lastMergeSourceCommit: {commitId: head},
  mergeStatus: "conflicts", reviewers: [{id: "r1", displayName: "Ann", vote: -10, isRequired: true}, {id: "r2", displayName: "Bob", vote: 0}],
  labels: [{name: "bug"}], repository: {name: "app", project: {name: "Web"}}};

test("an Azure pull request becomes the detail view: threads with status, votes, statuses and changed files", async () => {
  const {send} = azure({
    ["GET " + pr]: () => Response.json(raw),
    ["GET " + pr + "/threads"]: () => Response.json({value: [
      {id: 1, status: "active", threadContext: {filePath: "/src/a.ts", rightFileStart: {line: 3}, rightFileEnd: {line: 5}},
        comments: [{id: 1, author: {displayName: "Ann"}, content: "Rename?", publishedDate: "2026-11-27T01:00:00Z", commentType: "text"}]},
      {id: 2, status: "fixed", threadContext: {filePath: "/src/b.ts", leftFileStart: {line: 9}, leftFileEnd: {line: 9}},
        comments: [{id: 1, author: {displayName: "Ann"}, content: "Old", publishedDate: "2026-11-27T00:10:00Z", commentType: "text"}]},
      {id: 3, status: "active", comments: [{id: 1, author: {displayName: "Bob"}, content: "Nice", publishedDate: "2026-11-27T00:30:00Z", commentType: "text"}]},
      {id: 4, comments: [{id: 1, author: {displayName: "Azure"}, content: "Sam updated the pull request", publishedDate: "2026-11-27T00:20:00Z", commentType: "system"}]},
      {id: 5, isDeleted: true, comments: [{id: 1, author: {displayName: "Bob"}, content: "gone", commentType: "text"}]}]}),
    ["GET " + pr + "/statuses"]: () => Response.json({value: [{state: "failed", context: {genre: "ci", name: "build"}, targetUrl: "https://dev.azure.com/contoso/Web/_build/results?buildId=3", description: "Build failed"}]}),
    ["GET " + pr + "/commits"]: () => Response.json({value: [{commitId: head, comment: "Retry", author: {name: "Sam", date: "2026-11-27T00:00:00Z"}}]}),
    ["GET /contoso/_apis/connectionData"]: () => Response.json({authenticatedUser: {id: me, providerDisplayName: "Me"}}),
  });
  const detail = await azureReview(account, token, "Web/app", send).detail(7);
  assert.deepEqual([detail.forge, detail.viewer, detail.headSha, detail.isDraft, detail.conflicts, detail.reviewDecision, detail.url],
    ["azure", "Me", head, true, true, "CHANGES_REQUESTED", "https://dev.azure.com/contoso/Web/_git/app/pullrequest/7"]);
  assert.deepEqual(detail.threads.map(thread => [thread.id, thread.path, thread.side, thread.startLine, thread.line, thread.isResolved]),
    [["1", "src/a.ts", "RIGHT", 3, 5, false], ["2", "src/b.ts", "LEFT", null, 9, true]]);
  assert.deepEqual(detail.timeline.map(entry => [entry.author, entry.body]), [["Sam", "Why"], ["Bob", "Nice"]]);
  assert.deepEqual(detail.reviewers.map(reviewer => [reviewer.name, reviewer.state]), [["Ann", "REJECTED"], ["Bob", "REQUESTED"]]);
  assert.deepEqual(detail.checks.map(check => [check.name, check.workflow, check.status]), [["build", "ci", "failing"]]);
});

test("files come from the latest iteration's changes, without a line diff", async () => {
  const {send} = azure({["GET " + pr + "/iterations"]: () => Response.json({value: [{id: 1}, {id: 2}]}),
    ["GET " + pr + "/iterations/2/changes"]: () => Response.json({changeEntries: [{item: {path: "/src/a.ts"}, changeType: "edit"},
      {item: {path: "/src/new.ts"}, changeType: "rename", originalPath: "/src/old.ts"}, {item: {path: "/img.png"}, changeType: "add"}]})});
  const files = await azureReview(account, token, "Web/app", send).files(7);
  assert.deepEqual(files.map(file => [file.path, file.previousPath, file.status, file.patch]),
    [["src/a.ts", null, "modified", null], ["src/new.ts", "src/old.ts", "renamed", null], ["img.png", null, "added", null]]);
});

const current = {id: "7", headSha: head, title: "Add retries"} as PrDetail;
test("writes are threads, votes and pull request updates; completing is accepted, not finished", async () => {
  const ok = () => Response.json({id: 1});
  const {send, calls} = azure({["POST " + pr + "/threads"]: ok, ["POST " + pr + "/threads/1/comments"]: ok, ["PATCH " + pr + "/threads/1"]: ok,
    ["PUT " + pr + "/reviewers/" + me]: ok, ["PUT " + pr + "/reviewers/r9"]: ok, ["PATCH " + pr]: ok,
    ["GET /contoso/_apis/connectionData"]: () => Response.json({authenticatedUser: {id: me}})});
  const api = azureReview(account, token, "Web/app", send);
  await api.act(7, {kind: "comment", body: "Thanks"}, current);
  await api.act(7, {kind: "reply", threadId: "1", body: "Done"}, current);
  await api.act(7, {kind: "resolve", threadId: "1", resolved: true}, current);
  await api.act(7, {kind: "review", event: "APPROVE", body: "", comments: []}, current);
  await api.act(7, {kind: "requestReviewer", reviewer: "r9"}, current);
  await api.act(7, {kind: "state", open: false}, current);
  assert.deepEqual(await api.act(7, {kind: "merge", method: "squash"}, current), {outcome: "accepted"});
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => [call.method, call.path.replace(pr, "PR"), call.body]), [
    ["POST", "PR/threads", {comments: [{parentCommentId: 0, content: "Thanks", commentType: 1}], status: "active"}],
    ["POST", "PR/threads/1/comments", {parentCommentId: 1, content: "Done", commentType: 1}],
    ["PATCH", "PR/threads/1", {status: "fixed"}],
    ["PUT", "PR/reviewers/" + me, {vote: 10}],
    ["PUT", "PR/reviewers/r9", {vote: 0}],
    ["PATCH", "PR", {status: "abandoned"}],
    ["PATCH", "PR", {status: "completed", lastMergeSourceCommit: {commitId: head}, completionOptions: {mergeStrategy: "squash"}}],
  ]);
});

test("line comments and the draft state are refused before anything is sent", async () => {
  const {send, calls} = azure({});
  const api = azureReview(account, token, "Web/app", send);
  await assert.rejects(api.act(7, {kind: "lineComment", path: "a.ts", line: 1, side: "RIGHT", startLine: null, body: "x"}, current), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(api.act(7, {kind: "draft", draft: false}, current), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(api.act(7, {kind: "editBody", body: "x".repeat(4001)}, current), {message: "INVALID_INPUT"});
  assert.equal(calls.length, 0);
});
