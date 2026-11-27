import assert from "node:assert/strict";
import { test } from "node:test";
import { gitlabInbox } from "../src/adapters/bb/forges/inbox/gitlab.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org:8443", organization: "", username: "me"};
const token = "fixture-token-value";
type Call = {path: string; query: URLSearchParams};
function gitlab(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL) => {
    const url = new URL(String(target));
    assert.equal(url.origin, "https://gitlab.example.org:8443");
    const call = {path: url.pathname, query: url.searchParams};
    calls.push(call);
    return routes[url.pathname]?.(call) ?? Response.json({message: "404 Not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const mr = (over: Record<string, unknown> = {}) => ({id: 900, iid: 7, project_id: 42, title: "Add retries", state: "opened", draft: false,
  web_url: "https://gitlab.example.org:8443/group/sub/app/-/merge_requests/7", references: {full: "group/sub/app!7"}, author: {username: "me"},
  source_branch: "retries", target_branch: "main", created_at: "2026-11-27T00:00:00Z", updated_at: "2026-11-27T01:00:00Z",
  merged_at: null, closed_at: null, has_conflicts: false, detailed_merge_status: "mergeable", ...over});

test("tabs map to GitLab's own scopes, and the other tabs are only counted", async () => {
  const {send, calls} = gitlab({"/api/v4/merge_requests": call => Number(call.query.get("per_page")) === 1
    ? Response.json([], {headers: {"x-total": call.query.get("scope") === "reviews_for_me" && !call.query.has("approved_by_usernames[]") ? "3" : "1"}})
    : Response.json([mr()], {headers: {"x-total": "1"}})});
  const page = await gitlabInbox(account, token, send).list("open");
  const asked = Object.fromEntries(calls.map(call => [call.query.get("per_page") === "1" ? "count" : "list", call]));
  assert.equal(asked.list.query.get("scope"), "created_by_me");
  assert.equal(asked.list.query.get("state"), "opened");
  const scopes = calls.map(call => [call.query.get("scope"), call.query.get("state"), call.query.get("approved_by_usernames[]")]);
  assert.deepEqual(scopes.sort(), [["assigned_to_me", "opened", null], ["created_by_me", "closed", null],
    ["created_by_me", "merged", null], ["created_by_me", "opened", null], ["reviews_for_me", "opened", "me"], ["reviews_for_me", "opened", null]].sort());
  assert.deepEqual(page.counts, {open: 1, review: 3, reviewed: 1, assigned: 1, merged: 1, closed: 1});
  assert.deepEqual(page.items[0], {id: "gitlab:900", number: 7, title: "Add retries", url: "https://gitlab.example.org:8443/group/sub/app/-/merge_requests/7",
    repo: "group/sub/app", author: "me", baseRefName: "main", headRefName: "retries", onDefaultBranch: false, stackedOn: null, isDraft: false,
    createdAt: "2026-11-27T00:00:00Z", updatedAt: "2026-11-27T01:00:00Z", mergedAt: null, closedAt: null, additions: null, deletions: null,
    ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: null, conflicts: false, blockers: [], myReview: null});
});

test("GitLab's merge status becomes blockers", async () => {
  const items = [mr({iid: 1, draft: true, detailed_merge_status: "draft_status"}), mr({iid: 2, has_conflicts: true, detailed_merge_status: "conflict"}),
    mr({iid: 3, detailed_merge_status: "ci_still_running"}), mr({iid: 4, detailed_merge_status: "requested_changes"}),
    mr({iid: 5, detailed_merge_status: "discussions_not_resolved"}), mr({iid: 6, detailed_merge_status: "not_approved"}),
    mr({iid: 8, detailed_merge_status: "need_rebase"}), mr({iid: 9, detailed_merge_status: "ci_must_pass"})];
  const {send} = gitlab({"/api/v4/merge_requests": call => Response.json(call.query.get("per_page") === "1" ? [] : items)});
  const page = await gitlabInbox(account, token, send).list("open");
  assert.deepEqual(page.items.map(item => [item.number, item.blockers]), [[1, ["Draft"]], [2, ["Merge conflicts"]], [3, ["CI running"]],
    [4, ["Changes requested"]], [5, ["Unresolved discussions"]], [6, ["Awaiting review"]], [8, ["Needs rebase"]], [9, ["CI must pass"]]]);
  // No x-total: GitLab leaves it out above 10 000 results; the count is unknown rather than wrong.
  assert.deepEqual(page.counts, {});
});

test("an MR on top of another open MR's branch is stacked on it", async () => {
  const {send} = gitlab({"/api/v4/merge_requests": call => Response.json(call.query.get("per_page") === "1" ? [] :
    [mr(), mr({id: 901, iid: 8, source_branch: "retries-2", target_branch: "retries"})])});
  const page = await gitlabInbox(account, token, send).list("open");
  assert.deepEqual(page.items[1].blockers, ["Stacked on #7"]);
});

test("links off the account's server are dropped", async () => {
  const {send} = gitlab({"/api/v4/merge_requests": call => Response.json(call.query.get("per_page") === "1" ? [] : [mr({web_url: "https://evil.example/x"})])});
  assert.equal((await gitlabInbox(account, token, send).list("open")).items.length, 0);
});

test("the watcher reads each open MR's head pipeline", async () => {
  const {send, calls} = gitlab({
    "/api/v4/user": () => Response.json({username: "token-owner"}),
    "/api/v4/merge_requests": () => Response.json([mr(), mr({id: 901, iid: 8, project_id: 43, references: {full: "group/other!8"}})]),
    "/api/v4/projects/42/merge_requests/7": () => Response.json({...mr(), head_pipeline: {id: 501, status: "failed"}}),
    "/api/v4/projects/43/merge_requests/8": () => Response.json({...mr(), head_pipeline: {id: 502, status: "success"}}),
  });
  const result = await gitlabInbox(account, token, send).watch(new Set());
  assert.equal(calls.find(call => call.path === "/api/v4/merge_requests")?.query.get("scope"), "created_by_me");
  // The baseline follows whoever the token belongs to, not the configured name.
  assert.deepEqual(result, {viewer: "token-owner", prs: [
    {id: "gitlab:900", repo: "group/sub/app", number: 7, title: "Add retries", url: "https://gitlab.example.org:8443/group/sub/app/-/merge_requests/7", failing: ["Pipeline #501"], lastComment: null},
    {id: "gitlab:901", repo: "group/other", number: 8, title: "Add retries", url: "https://gitlab.example.org:8443/group/sub/app/-/merge_requests/7", failing: [], lastComment: null},
  ]});
});
