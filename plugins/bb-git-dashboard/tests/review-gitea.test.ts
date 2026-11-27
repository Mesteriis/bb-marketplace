import assert from "node:assert/strict";
import { test } from "node:test";
import { giteaReview } from "../src/adapters/bb/forges/review/gitea.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://git.example.org", organization: "", username: "me"};
const token = "fixture-token-value";
const head = "a".repeat(40);
const repo = "/api/v1/repos/o/r";
type Call = {method: string; path: string; body: any};
function gitea(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    return routes[call.method + " " + url.pathname]?.(call) ?? Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const pull = {id: 70, number: 7, title: "WIP: Add retries", body: "Why", state: "open", merged: false, draft: true, user: {login: "sam"},
  head: {ref: "retries", sha: head}, base: {ref: "main", repo: {default_branch: "main"}}, html_url: "https://git.example.org/o/r/pulls/7",
  mergeable: false, additions: 3, deletions: 1, changed_files: 2, labels: [{name: "bug", color: "ee0701"}], requested_reviewers: [{login: "ann"}],
  created_at: "2026-11-27T00:00:00Z"};
const comment = (id: number, login: string, body: string, extra = {}) => ({id, body, user: {login}, path: "a.ts", position: 5, original_position: 5,
  commit_id: head, created_at: "2026-11-27T0" + id + ":00:00Z", html_url: "https://git.example.org/o/r/pulls/7#issuecomment-" + id, resolver: null, ...extra});

test("a Gitea pull request becomes the detail view: threads by line, reviews, status and commits", async () => {
  const {send} = gitea({
    ["GET " + repo + "/pulls/7"]: () => Response.json(pull),
    ["GET " + repo + "/issues/7/comments"]: () => Response.json([{id: 1, body: "Nice", user: {login: "bob"}, created_at: "2026-11-27T00:30:00Z", html_url: "https://git.example.org/o/r/pulls/7#c1"}]),
    ["GET " + repo + "/pulls/7/reviews"]: () => Response.json([{id: 11, user: {login: "ann"}, state: "REQUEST_CHANGES", body: "Tests please", submitted_at: "2026-11-27T01:00:00Z"},
      {id: 12, user: {login: "sam"}, state: "COMMENT", body: "", submitted_at: "2026-11-27T02:00:00Z"}]),
    ["GET " + repo + "/pulls/7/reviews/11/comments"]: () => Response.json([comment(2, "ann", "Rename?"), comment(3, "ann", "Old one", {path: "b.ts", position: 9, commit_id: "b".repeat(40), resolver: {login: "sam"}})]),
    ["GET " + repo + "/pulls/7/reviews/12/comments"]: () => Response.json([comment(4, "sam", "Done")]),
    ["GET " + repo + "/commits/" + head + "/status"]: () => Response.json({state: "failure", statuses: [{context: "ci/test", status: "failure", target_url: "https://git.example.org/o/r/actions/runs/3"}]}),
    ["GET " + repo + "/pulls/7/commits"]: () => Response.json([{sha: head, commit: {message: "Retry\n\nbody", author: {name: "Sam", date: "2026-11-27T00:00:00Z"}}}]),
    ["GET /api/v1/user"]: () => Response.json({login: "me"}),
  });
  const detail = await giteaReview(account, token, "o/r", send).detail(7);
  assert.deepEqual([detail.forge, detail.viewer, detail.headSha, detail.isDraft, detail.conflicts, detail.reviewDecision], ["gitea", "me", head, true, true, "CHANGES_REQUESTED"]);
  assert.deepEqual(detail.threads.map(thread => [thread.id, thread.path, thread.line, thread.isResolved, thread.isOutdated, thread.comments.map(item => item.body)]),
    [["2", "a.ts", 5, false, false, ["Rename?", "Done"]], ["3", "b.ts", 9, true, true, ["Old one"]]]);
  assert.deepEqual(detail.timeline.map(entry => [entry.author, entry.body, entry.reviewState]), [["sam", "Why", null], ["bob", "Nice", null], ["ann", "Tests please", "CHANGES_REQUESTED"]]);
  assert.deepEqual(detail.reviewers.map(reviewer => [reviewer.name, reviewer.state]), [["ann", "CHANGES_REQUESTED"]]);
  assert.deepEqual(detail.checks.map(check => [check.name, check.status]), [["ci/test", "failing"]]);
  assert.deepEqual(detail.commits.map(commit => [commit.shortOid, commit.headline, commit.author]), [["aaaaaaa", "Retry", "Sam"]]);
});

test("files list their patch from the pull request's diff", async () => {
  const diff = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/c.png b/c.png\nBinary files differ\n";
  const {send} = gitea({["GET " + repo + "/pulls/7/files"]: () => Response.json([{filename: "a.ts", status: "changed", additions: 1, deletions: 1},
    {filename: "c.png", status: "added", additions: 0, deletions: 0}]), ["GET " + repo + "/pulls/7.diff"]: () => new Response(diff)});
  const files = await giteaReview(account, token, "o/r", send).files(7);
  assert.deepEqual(files.map(file => [file.path, file.status, file.patch]), [["a.ts", "modified", "@@ -1 +1 @@\n-a\n+b"], ["c.png", "added", null]]);
});

const current = {id: "70", headSha: head, title: "WIP: Add retries", isDraft: true} as PrDetail;
test("writes use reviews for line comments, the resolve endpoints, the title prefix and the head for merge", async () => {
  const ok = () => Response.json({id: 1});
  const {send, calls} = gitea({["POST " + repo + "/issues/7/comments"]: ok, ["POST " + repo + "/pulls/7/comments/2/replies"]: ok,
    ["POST " + repo + "/pulls/comments/2/resolve"]: () => new Response(null, {status: 204}), ["POST " + repo + "/pulls/7/reviews"]: ok,
    ["PATCH " + repo + "/pulls/7"]: ok, ["POST " + repo + "/pulls/7/merge"]: () => new Response(null, {status: 200}), ["POST " + repo + "/pulls/7/requested_reviewers"]: ok});
  const api = giteaReview(account, token, "o/r", send);
  await api.act(7, {kind: "comment", body: "Thanks"}, current);
  await api.act(7, {kind: "reply", threadId: "2", body: "Done"}, current);
  await api.act(7, {kind: "resolve", threadId: "2", resolved: true}, current);
  await api.act(7, {kind: "lineComment", path: "a.ts", line: 3, side: "LEFT", startLine: null, body: "Why removed?"}, current);
  await api.act(7, {kind: "review", event: "APPROVE", body: "Good", comments: []}, current);
  await api.act(7, {kind: "draft", draft: false}, current);
  await api.act(7, {kind: "requestReviewer", reviewer: "ann"}, current);
  await api.act(7, {kind: "merge", method: "rebase"}, current);
  assert.deepEqual(calls.map(call => [call.method, call.path.replace(repo, ""), call.body]), [
    ["POST", "/issues/7/comments", {body: "Thanks"}],
    ["POST", "/pulls/7/comments/2/replies", {body: "Done"}],
    ["POST", "/pulls/comments/2/resolve", undefined],
    ["POST", "/pulls/7/reviews", {event: "COMMENT", body: "", commit_id: head, comments: [{path: "a.ts", body: "Why removed?", old_position: 3, new_position: 0}]}],
    ["POST", "/pulls/7/reviews", {event: "APPROVED", body: "Good", commit_id: head, comments: []}],
    ["PATCH", "/pulls/7", {title: "Add retries"}],
    ["POST", "/pulls/7/requested_reviewers", {reviewers: ["ann"]}],
    ["POST", "/pulls/7/merge", {Do: "rebase", head_commit_id: head}],
  ]);
});
