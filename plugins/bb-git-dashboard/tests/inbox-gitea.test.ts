import assert from "node:assert/strict";
import { test } from "node:test";
import { giteaInbox } from "../src/adapters/bb/forges/inbox/gitea.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://git.example.org", organization: "", username: "me"};
const token = "fixture-token-value";
type Call = {path: string; query: URLSearchParams};
function gitea(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL) => {
    const url = new URL(String(target));
    const call = {path: url.pathname, query: url.searchParams};
    calls.push(call);
    return routes[url.pathname]?.(call) ?? Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const issue = (over: Record<string, unknown> = {}) => ({id: 70, number: 7, title: "Add retries", state: "open", html_url: "https://git.example.org/o/r/pulls/7",
  user: {login: "me"}, repository: {full_name: "o/r"}, created_at: "2026-11-27T00:00:00Z", updated_at: "2026-11-27T01:00:00Z", closed_at: null,
  pull_request: {merged: false, merged_at: null, draft: false}, ...over});
const pull = (over: Record<string, unknown> = {}) => ({number: 7, mergeable: true, additions: 4, deletions: 2,
  base: {ref: "main", repo: {default_branch: "main"}}, head: {ref: "retries", sha: "a".repeat(40)}, ...over});
const search = "/api/v1/repos/issues/search";

test("tabs map to Gitea's search flags; the open tab reads branches, conflicts and CI", async () => {
  const {send, calls} = gitea({
    [search]: call => call.query.get("limit") === "1" ? Response.json([], {headers: {"x-total-count": "2"}}) : Response.json([issue()], {headers: {"x-total-count": "1"}}),
    "/api/v1/repos/o/r/pulls/7": () => Response.json(pull({mergeable: false})),
    ["/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/status"]: () => Response.json({state: "failure", statuses: [
      {context: "ci/build", status: "failure", target_url: "https://git.example.org/o/r/actions/runs/3"}, {context: "ci/lint", status: "success"}]}),
  });
  const page = await giteaInbox(account, token, send).list("open");
  const flags = calls.filter(call => call.path === search).map(call => [call.query.get("type"), call.query.get("state"),
    ["created", "review_requested", "reviewed", "assigned"].filter(flag => call.query.get(flag) === "true").join()]);
  assert.deepEqual(flags.sort(), [["pulls", "open", "assigned"], ["pulls", "open", "created"], ["pulls", "open", "review_requested"], ["pulls", "open", "reviewed"]].sort());
  // Merged and closed share one closed search, so neither gets a count of its own and none is asked for.
  assert.deepEqual(page.counts, {open: 1, review: 2, reviewed: 2, assigned: 2});
  assert.deepEqual(page.items[0], {id: "gitea:70", number: 7, title: "Add retries", url: "https://git.example.org/o/r/pulls/7", repo: "o/r", author: "me",
    baseRefName: "main", headRefName: "retries", onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "2026-11-27T00:00:00Z",
    updatedAt: "2026-11-27T01:00:00Z", mergedAt: null, closedAt: null, additions: 4, deletions: 2, ci: "failing",
    failingChecks: [{name: "ci/build", workflow: null, url: "https://git.example.org/o/r/actions/runs/3"}], unresolvedThreads: 0, notes: [],
    reviewDecision: null, conflicts: true, blockers: ["Merge conflicts", "CI failing (1 check)"], myReview: null});
});

test("merged and closed come from one closed search, split by merged", async () => {
  const {send, calls} = gitea({[search]: call => call.query.get("limit") === "1" ? Response.json([]) : Response.json([
    issue({number: 1, state: "closed", closed_at: "2026-11-27T02:00:00Z", pull_request: {merged: true, merged_at: "2026-11-27T02:00:00Z"}}),
    issue({number: 2, state: "closed", closed_at: "2026-11-27T03:00:00Z", pull_request: {merged: false}})])});
  const api = giteaInbox(account, token, send);
  assert.deepEqual((await api.list("merged")).items.map(item => [item.number, item.mergedAt, item.closedAt]), [[1, "2026-11-27T02:00:00Z", null]]);
  assert.deepEqual((await api.list("closed")).items.map(item => [item.number, item.mergedAt, item.closedAt]), [[2, null, "2026-11-27T03:00:00Z"]]);
  // Closed tabs read no pull details.
  assert.equal(calls.some(call => call.path.includes("/pulls/")), false);
});

test("a draft is a draft by flag or by a WIP title", async () => {
  const {send} = gitea({[search]: call => Response.json(call.query.get("limit") === "1" ? [] : [issue({title: "WIP: retries"}), issue({number: 8, pull_request: {draft: true}})]),
    "/api/v1/repos/o/r/pulls/7": () => Response.json(pull()), "/api/v1/repos/o/r/pulls/8": () => Response.json(pull({number: 8})),
    ["/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/status"]: () => Response.json({state: "", statuses: []})});
  assert.deepEqual((await giteaInbox(account, token, send).list("open")).items.map(item => item.blockers), [["Draft"], ["Draft"]]);
});

test("the watcher reports failing statuses of open PRs", async () => {
  const {send} = gitea({[search]: () => Response.json([issue()]), "/api/v1/repos/o/r/pulls/7": () => Response.json(pull()),
    "/api/v1/user": () => Response.json({login: "me"}),
    ["/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/status"]: () => Response.json({state: "error", statuses: [{context: "ci/build", status: "error"}]})});
  assert.deepEqual(await giteaInbox(account, token, send).watch(new Set()), {viewer: "me", prs: [{id: "gitea:70", repo: "o/r", number: 7,
    title: "Add retries", url: "https://git.example.org/o/r/pulls/7", failing: ["ci/build"], lastComment: null}]});
});

test("one pull request whose details fail keeps its row; the watcher reads who the token belongs to", async () => {
  const {send} = gitea({[search]: call => Response.json(call.query.get("limit") === "1" ? [] : [issue(), issue({id: 80, number: 8})]),
    "/api/v1/repos/o/r/pulls/7": () => Response.json(pull()), "/api/v1/user": () => Response.json({login: "token-owner"}),
    ["/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/status"]: () => Response.json({state: "success", statuses: []})});
  const page = await giteaInbox(account, token, send).list("open");
  assert.deepEqual(page.items.map(item => [item.number, item.ci, item.baseRefName]), [[7, "passing", "main"], [8, "none", ""]]);
  assert.equal((await giteaInbox(account, token, send).watch(new Set()))?.viewer, "token-owner");
});
