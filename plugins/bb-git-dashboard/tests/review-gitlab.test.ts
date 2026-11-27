import assert from "node:assert/strict";
import { test } from "node:test";
import { gitlabReview } from "../src/adapters/bb/forges/review/gitlab.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "me"};
const token = "fixture-token-value";
const head = "a".repeat(40), base = "b".repeat(40), start = "c".repeat(40);
const mr = "/api/v4/projects/group%2Fsub%2Fapp/merge_requests/7";
type Call = {method: string; path: string; query: URLSearchParams; body: any};
function gitlab(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    return routes[call.method + " " + url.pathname]?.(call) ?? Response.json({message: "404 Not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const web = "https://gitlab.example.org/group/sub/app/-/merge_requests/7";
const raw = {id: 900, iid: 7, title: "Draft: Add retries", description: "Why", state: "opened", draft: true, author: {username: "sam"},
  source_branch: "retries", target_branch: "main", sha: head, diff_refs: {base_sha: base, head_sha: head, start_sha: start}, web_url: web,
  has_conflicts: false, detailed_merge_status: "not_approved", created_at: "2026-11-27T00:00:00Z", labels: ["bug"],
  reviewers: [{username: "ann"}], head_pipeline: {id: 501, status: "failed", web_url: "https://gitlab.example.org/group/sub/app/-/pipelines/501"}};
const discussions = [
  {id: "d1", individual_note: false, notes: [
    {id: 1, type: "DiffNote", body: "Rename?", author: {username: "ann"}, created_at: "2026-11-27T01:00:00Z", system: false, resolvable: true, resolved: false,
      position: {new_path: "a.ts", old_path: "a.ts", new_line: 5, old_line: null, head_sha: head, line_range: {start: {new_line: 3}, end: {new_line: 5}}}},
    {id: 2, type: "DiffNote", body: "Done", author: {username: "sam"}, created_at: "2026-11-27T02:00:00Z", system: false, resolvable: true, resolved: false}]},
  {id: "d2", individual_note: true, notes: [{id: 3, type: null, body: "Nice", author: {username: "bob"}, created_at: "2026-11-27T00:30:00Z", system: false}]},
  {id: "d3", individual_note: true, notes: [{id: 4, type: null, body: "added 1 commit", author: {username: "sam"}, created_at: "2026-11-27T00:40:00Z", system: true}]},
  {id: "d4", individual_note: false, notes: [{id: 5, type: "DiffNote", body: "Old", author: {username: "ann"}, created_at: "2026-11-27T00:10:00Z", system: false,
    resolvable: true, resolved: true, position: {new_path: "b.ts", old_path: "b.ts", new_line: null, old_line: 9, head_sha: "d".repeat(40)}}]},
];
const routes = {
  ["GET " + mr]: () => Response.json(raw),
  ["GET " + mr + "/discussions"]: () => Response.json(discussions, {headers: {"x-next-page": ""}}),
  ["GET " + mr + "/approvals"]: () => Response.json({approved_by: [{user: {username: "bob"}}]}),
  ["GET " + mr + "/commits"]: () => Response.json([{id: head, short_id: "aaaaaaaa", title: "Retry", author_name: "Sam", committed_date: "2026-11-27T00:00:00Z"}]),
  ["GET /api/v4/user"]: () => Response.json({username: "me"}),
};

test("a merge request becomes the detail view: threads, timeline, reviewers, pipeline and draft", async () => {
  const {send} = gitlab(routes);
  const detail = await gitlabReview(account, token, "group/sub/app", send).detail(7);
  assert.deepEqual([detail.forge, detail.viewer, detail.headSha, detail.isDraft, detail.title, detail.reviewDecision], ["gitlab", "me", head, true, "Draft: Add retries", "REVIEW_REQUIRED"]);
  assert.deepEqual(detail.threads.map(thread => [thread.id, thread.path, thread.side, thread.startLine, thread.line, thread.isResolved, thread.isOutdated, thread.comments.length]),
    [["d1", "a.ts", "RIGHT", 3, 5, false, false, 2], ["d4", "b.ts", "LEFT", null, 9, true, true, 1]]);
  assert.deepEqual(detail.timeline.map(entry => [entry.author, entry.body]), [["sam", "Why"], ["bob", "Nice"]]);
  assert.deepEqual(detail.reviewers.map(reviewer => [reviewer.name, reviewer.state]), [["ann", "REQUESTED"], ["bob", "APPROVED"]]);
  assert.deepEqual(detail.checks.map(check => [check.name, check.status, check.url]), [["Pipeline #501", "failing", "https://gitlab.example.org/group/sub/app/-/pipelines/501"]]);
  assert.deepEqual(detail.commits.map(commit => [commit.shortOid, commit.headline]), [["aaaaaaaa", "Retry"]]);
});

test("files come from /diffs; a too large diff has no patch", async () => {
  const {send} = gitlab({["GET " + mr + "/diffs"]: () => Response.json([
    {old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n", new_file: false, renamed_file: false, deleted_file: false},
    {old_path: "old.ts", new_path: "new.ts", diff: "", renamed_file: true, new_file: false, deleted_file: false},
    {old_path: "big.bin", new_path: "big.bin", diff: "", too_large: true, new_file: true, renamed_file: false, deleted_file: false}], {headers: {"x-next-page": ""}})});
  const files = await gitlabReview(account, token, "group/sub/app", send).files(7);
  assert.deepEqual(files.map(file => [file.path, file.previousPath, file.status, file.additions, file.deletions, file.patch]), [
    ["a.ts", null, "modified", 1, 1, "@@ -1 +1 @@\n-a\n+b\n"], ["new.ts", "old.ts", "renamed", 0, 0, null], ["big.bin", null, "added", 0, 0, null]]);
});

const current = {id: "900", headSha: head, title: "Draft: Add retries", diffRefs: {base, head, start}} as unknown as PrDetail;
test("writes use discussions with positions, approvals and the title prefix for drafts", async () => {
  const ok = () => Response.json({id: 1, state: "merged"});
  const {send, calls} = gitlab({["POST " + mr + "/notes"]: ok, ["POST " + mr + "/discussions"]: ok, ["POST " + mr + "/discussions/d1/notes"]: ok,
    ["PUT " + mr + "/discussions/d1"]: ok, ["POST " + mr + "/approve"]: ok, ["PUT " + mr]: ok, ["PUT " + mr + "/merge"]: ok,
    ["GET /api/v4/users"]: () => Response.json([{id: 5, username: "ann"}]), ["GET " + mr]: () => Response.json({...raw, reviewers: [{id: 3}]})});
  const api = gitlabReview(account, token, "group/sub/app", send);
  await api.act(7, {kind: "comment", body: "Thanks"}, current);
  await api.act(7, {kind: "reply", threadId: "d1", body: "Done"}, current);
  await api.act(7, {kind: "resolve", threadId: "d1", resolved: true}, current);
  await api.act(7, {kind: "lineComment", path: "a.ts", line: 5, side: "RIGHT", startLine: null, body: "Here"}, current);
  await api.act(7, {kind: "review", event: "APPROVE", body: "", comments: []}, current);
  await api.act(7, {kind: "draft", draft: false}, current);
  await api.act(7, {kind: "state", open: false}, current);
  await api.act(7, {kind: "requestReviewer", reviewer: "ann"}, current);
  await api.act(7, {kind: "merge", method: "squash"}, current);
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => [call.method, call.path.replace(mr, "MR"), call.body]), [
    ["POST", "MR/notes", {body: "Thanks"}],
    ["POST", "MR/discussions/d1/notes", {body: "Done"}],
    ["PUT", "MR/discussions/d1", {resolved: true}],
    ["POST", "MR/discussions", {body: "Here", position: {position_type: "text", base_sha: base, start_sha: start, head_sha: head, new_path: "a.ts", old_path: "a.ts", new_line: 5}}],
    ["POST", "MR/approve", {sha: head}],
    ["PUT", "MR", {title: "Add retries"}],
    ["PUT", "MR", {state_event: "close"}],
    ["PUT", "MR", {reviewer_ids: [3, 5]}],
    ["PUT", "MR/merge", {sha: head, squash: true}],
  ]);
});

test("request changes is refused before anything is sent", async () => {
  const {send, calls} = gitlab({});
  await assert.rejects(gitlabReview(account, token, "group/sub/app", send).act(7, {kind: "review", event: "REQUEST_CHANGES", body: "No", comments: []}, current),
    {message: "PROVIDER_UNSUPPORTED"});
  assert.equal(calls.length, 0);
});

test("a comment on a renamed file names its old path; a review that stops halfway says so", async () => {
  let failAt = 0, posted = 0;
  const {send, calls} = gitlab({["POST " + mr + "/discussions"]: () => ++posted === failAt ? new Response("", {status: 500}) : Response.json({id: 1})});
  const api = gitlabReview(account, token, "group/sub/app", send);
  await api.act(7, {kind: "lineComment", path: "new.ts", oldPath: "old.ts", line: 4, side: "LEFT", startLine: null, body: "Why removed?"}, current);
  assert.deepEqual(calls[0].body.position, {position_type: "text", base_sha: base, start_sha: start, head_sha: head, new_path: "new.ts", old_path: "old.ts", old_line: 4});
  failAt = 3;
  await assert.rejects(api.act(7, {kind: "review", event: "APPROVE", body: "", comments: [1, 2, 3].map(line =>
    ({path: "a.ts", line, side: "RIGHT" as const, startLine: null, body: "c" + line}))}, current), (error: Error & {done?: number; total?: number}) =>
    error.message === "OUTCOME_PARTIAL" && error.done === 1 && error.total === 4);
});

test("a failed optional part leaves the merge request readable and says what is missing", async () => {
  const denied = () => Response.json({message: "403 Forbidden"}, {status: 403});
  const {send} = gitlab({...routes, ["GET " + mr + "/discussions"]: denied, ["GET " + mr + "/commits"]: denied,
    ["GET " + mr + "/approvals"]: denied, ["GET /api/v4/user"]: () => Response.json({message: "401 Unauthorized"}, {status: 401})});
  const detail = await gitlabReview(account, token, "group/sub/app", send).detail(7);
  assert.deepEqual([detail.title, detail.threads, detail.commits, detail.viewer], ["Draft: Add retries", [], [], ""]);
  assert.deepEqual(detail.timeline.map(entry => entry.body), ["Why"]);
  assert.deepEqual(detail.notices, [
    "Discussions could not be read (PROVIDER_DENIED).",
    "Approvals could not be read (PROVIDER_DENIED).",
    "Commits could not be read (PROVIDER_DENIED).",
    "Your GitLab user could not be read (PROVIDER_DENIED); the forge may refuse some review choices.",
  ]);
});

test("the merge request itself failing still fails the page", async () => {
  const {send} = gitlab({...routes, ["GET " + mr]: () => Response.json({message: "404 Not found"}, {status: 404})});
  await assert.rejects(gitlabReview(account, token, "group/sub/app", send).detail(7), /PROVIDER_DENIED/);
});

test("a complete read has no notices", async () => {
  const {send} = gitlab(routes);
  assert.deepEqual((await gitlabReview(account, token, "group/sub/app", send).detail(7)).notices, []);
});

test("a deleted comment is a DELETE of its note", async () => {
  const gone = () => new Response(null, {status: 204});
  const {send, calls} = gitlab({["DELETE " + mr + "/notes/41"]: gone, ["DELETE " + mr + "/notes/42"]: gone});
  const api = gitlabReview(account, token, "group/sub/app", send);
  await api.act(7, {kind: "deleteComment", commentId: "41", threadId: null, body: "x"}, current);
  await api.act(7, {kind: "deleteComment", commentId: "42", threadId: "d1", body: "x"}, current);
  assert.deepEqual(calls.map(call => [call.method, call.path.replace(mr, "MR")]), [["DELETE", "MR/notes/41"], ["DELETE", "MR/notes/42"]]);
});
