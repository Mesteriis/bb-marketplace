import assert from "node:assert/strict";
import { test } from "node:test";
import { githubInbox } from "../src/adapters/bb/forges/inbox/github.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "github", id: "gh", label: "GH", origin: "https://api.github.com", organization: "", username: "me"};
const token = "fixture-token-value";
type Call = {url: URL; method: string; body: {query: string; variables?: unknown}};
function graphql(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const call = {url: new URL(String(target)), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}"))};
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return {send, calls};
}
const node = {id: "PR_1", number: 7, title: "Fix it", url: "https://github.com/o/r/pull/7", isDraft: false, createdAt: "2026-11-27T00:00:00Z",
  updatedAt: "2026-11-27T01:00:00Z", mergedAt: null, closedAt: null, additions: 3, deletions: 1, author: {login: "me"}, baseRefName: "main",
  headRefName: "fix", repository: {nameWithOwner: "o/r", defaultBranchRef: {name: "main"}}, mergeable: "CONFLICTING", reviewDecision: "REVIEW_REQUIRED"};
const counts = {review: {issueCount: 2}, reviewed: {issueCount: 0}, assigned: {issueCount: 1}, merged: {issueCount: 9}, closed: {issueCount: 4}};

test("a tab is one GraphQL search with the other tabs' counts", async () => {
  const {send, calls} = graphql(() => Response.json({data: {open: {issueCount: 1, nodes: [node, {}]}, ...counts}}));
  const page = await githubInbox(account, token, send).list("open");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.href, "https://api.github.com/graphql");
  assert.match(calls[0].body.query, /open: search\(query: "is:pr author:@me archived:false sort:updated-desc is:open", type: ISSUE, first: 50\)/);
  assert.match(calls[0].body.query, /review: search\(query: "[^"]*review-requested:@me", type: ISSUE, first: 1\) \{ issueCount \}/);
  assert.deepEqual(page.counts, {open: 1, review: 2, reviewed: 0, assigned: 1, merged: 9, closed: 4});
  assert.equal(page.items.length, 1);
  assert.deepEqual([page.items[0].headRefName, page.items[0].blockers], ["fix", ["Merge conflicts", "Awaiting review"]]);
});

test("GitHub Enterprise answers GraphQL under /api/graphql", async () => {
  const enterprise = {...account, origin: "https://github.example.org"};
  const {send, calls} = graphql(() => Response.json({data: {open: {issueCount: 0, nodes: []}, ...counts}}));
  await githubInbox(enterprise, token, send).list("open");
  assert.equal(calls[0].url.href, "https://github.example.org/api/graphql");
});

test("GraphQL errors are reported, a 5xx on this read is not an unknown write outcome", async () => {
  const errors = graphql(() => Response.json({errors: [{type: "FORBIDDEN", message: "Resource not accessible by integration"}]}));
  await assert.rejects(githubInbox(account, token, errors.send).list("open"), {message: "PROVIDER_DENIED"});
  const down = graphql(() => new Response("bad gateway", {status: 502}));
  await assert.rejects(githubInbox(account, token, down.send).list("open"), {message: "PROVIDER_UNAVAILABLE"});
});

test("the watcher reads the viewer and their open PRs", async () => {
  const watched = {id: "PR_1", number: 7, title: "Fix it", url: "https://github.com/o/r/pull/7", author: {login: "me"}, repository: {nameWithOwner: "o/r"},
    comments: {nodes: [{author: {__typename: "User", login: "sam"}, createdAt: "2026-11-27T02:00:00Z", url: "https://github.com/o/r/pull/7#c1"}]},
    reviews: {nodes: []}, reviewThreads: {nodes: []}, commits: {nodes: []}};
  const {send, calls} = graphql(() => Response.json({data: {viewer: {login: "me"}, open: {nodes: [watched, {}]}}}));
  const result = await githubInbox(account, token, send).watch(new Set());
  assert.match(calls[0].body.query, /viewer \{ login \}/);
  assert.deepEqual(result, {viewer: "me", prs: [{id: "PR_1", repo: "o/r", number: 7, title: "Fix it", url: "https://github.com/o/r/pull/7",
    failing: [], lastComment: {author: "sam", at: "2026-11-27T02:00:00Z", url: "https://github.com/o/r/pull/7#c1"}}]});
});

test("GitHub rows and alert links off the account's server are dropped; a null search is not a zero count", async () => {
  const off = {...node, id: "PR_2", url: "javascript:alert(1)"};
  const {send} = graphql(() => Response.json({data: {open: {issueCount: 2, nodes: [node, off]}, ...counts, merged: null}}));
  const page = await githubInbox(account, token, send).list("open");
  assert.deepEqual(page.items.map(item => item.id), ["PR_1"]);
  assert.equal("merged" in page.counts, false);
  const missing = graphql(() => Response.json({data: {open: null, ...counts}, errors: [{message: "timeout"}]}));
  await assert.rejects(githubInbox(account, token, missing.send).list("open"), {message: "PROVIDER_UNAVAILABLE"});
  const watched = {id: "PR_1", number: 7, title: "T", url: "https://github.com/o/r/pull/7", author: {login: "me"}, repository: {nameWithOwner: "o/r"},
    comments: {nodes: [{author: {__typename: "User", login: "sam"}, createdAt: "2026-11-27T02:00:00Z", url: "https://evil.example/c"}]},
    reviews: {nodes: []}, reviewThreads: {nodes: []}, commits: {nodes: []}};
  const watch = graphql(() => Response.json({data: {viewer: {login: "me"}, open: {nodes: [watched, {...watched, id: "PR_3", url: "https://evil.example/p"}]}}}));
  const result = await githubInbox(account, token, watch.send).watch(new Set());
  assert.deepEqual(result?.prs.map(pr => [pr.id, pr.url, pr.lastComment?.url]), [["PR_1", "https://github.com/o/r/pull/7", "https://github.com/o/r/pull/7"]]);
});
