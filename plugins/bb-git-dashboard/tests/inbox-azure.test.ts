import assert from "node:assert/strict";
import { test } from "node:test";
import { azureInbox } from "../src/adapters/bb/forges/inbox/azure.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "azure", id: "az", label: "AZ", origin: "https://dev.azure.com", organization: "contoso", username: "me"};
const token = "fixture-token-value";
const me = "11111111-1111-1111-1111-111111111111";
type Call = {path: string; query: URLSearchParams};
function azure(pulls: (project: string, call: Call) => unknown[], projects = ["Web", "Ops"]) {
  const calls: Call[] = [];
  const send = (async (target: string | URL) => {
    const url = new URL(String(target));
    const call = {path: url.pathname, query: url.searchParams};
    calls.push(call);
    if (url.pathname === "/contoso/_apis/connectionData") return Response.json({authenticatedUser: {id: me}});
    if (url.pathname === "/contoso/_apis/projects") return Response.json({value: projects.map(name => ({name})), count: projects.length});
    const match = /^\/contoso\/([^/]+)\/_apis\/git\/pullrequests$/.exec(url.pathname);
    if (match) return Response.json({value: pulls(decodeURIComponent(match[1]), call)});
    return Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const pr = (over: Record<string, unknown> = {}) => ({pullRequestId: 7, title: "Add retries", status: "active", isDraft: false,
  createdBy: {id: me, displayName: "Me", uniqueName: "me@example.invalid"}, creationDate: "2026-11-27T00:00:00Z",
  sourceRefName: "refs/heads/retries", targetRefName: "refs/heads/main", mergeStatus: "succeeded",
  repository: {name: "app", project: {name: "Web"}}, reviewers: [], ...over});

test("Open reads every project of the organization with the user as creator", async () => {
  const {send, calls} = azure(project => project === "Web" ? [pr()] : []);
  const page = await azureInbox(account, token, send).list("open");
  const asked = calls.filter(call => call.path.endsWith("/pullrequests"));
  assert.deepEqual(asked.map(call => [call.path, call.query.get("searchCriteria.creatorId"), call.query.get("searchCriteria.status")]),
    [["/contoso/Web/_apis/git/pullrequests", me, "active"], ["/contoso/Ops/_apis/git/pullrequests", me, "active"]]);
  assert.deepEqual(page.items[0], {id: "azure:Web/7", number: 7, title: "Add retries", url: "https://dev.azure.com/contoso/Web/_git/app/pullrequest/7",
    repo: "Web/app", author: "Me", baseRefName: "main", headRefName: "retries", onDefaultBranch: false, stackedOn: null, isDraft: false,
    createdAt: "2026-11-27T00:00:00Z", updatedAt: "2026-11-27T00:00:00Z", mergedAt: null, closedAt: null, additions: null, deletions: null,
    ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: null, conflicts: false, blockers: [], myReview: null});
  assert.deepEqual(page.counts, {open: 1});
});

test("Review requested and Reviewed split the user's reviews by their vote", async () => {
  const reviews = [pr({pullRequestId: 1, reviewers: [{id: me, vote: 0}]}), pr({pullRequestId: 2, reviewers: [{id: me, vote: 10}]}),
    pr({pullRequestId: 3, reviewers: [{id: me, vote: -5}]})];
  const {send, calls} = azure(project => project === "Web" ? reviews : []);
  const api = azureInbox(account, token, send);
  assert.deepEqual((await api.list("review")).items.map(item => item.number), [1]);
  const reviewed = await api.list("reviewed");
  assert.deepEqual(reviewed.items.map(item => [item.number, item.myReview]), [[2, {state: "APPROVED", stale: false}], [3, {state: "WAITING_FOR_AUTHOR", stale: false}]]);
  assert.equal(calls.filter(call => call.path.endsWith("/pullrequests")).every(call => call.query.get("searchCriteria.reviewerId") === me), true);
});

test("votes, drafts and conflicts become blockers", async () => {
  const {send} = azure(project => project === "Web" ? [
    pr({pullRequestId: 1, isDraft: true}), pr({pullRequestId: 2, mergeStatus: "conflicts"}),
    pr({pullRequestId: 3, reviewers: [{id: "x", vote: -10}]}), pr({pullRequestId: 4, reviewers: [{id: "x", vote: -5}]}),
    pr({pullRequestId: 5, reviewers: [{id: "x", vote: 0, isRequired: true}, {id: "y", vote: 10}]}),
    pr({pullRequestId: 6, reviewers: [{id: "x", vote: 5, isRequired: true}]})] : []);
  const page = await azureInbox(account, token, send).list("open");
  assert.deepEqual(page.items.map(item => [item.number, item.blockers]), [[1, ["Draft"]], [2, ["Merge conflicts"]], [3, ["Changes requested"]],
    [4, ["Waiting for author"]], [5, ["Awaiting review"]], [6, []]]);
});

test("merged and abandoned PRs, and no Assigned tab on Azure", async () => {
  const {send, calls} = azure((project, call) => project === "Web" ? [pr({status: call.query.get("searchCriteria.status"), closedDate: "2026-11-27T02:00:00Z"})] : []);
  const api = azureInbox(account, token, send);
  const merged = await api.list("merged");
  assert.deepEqual([merged.items[0].mergedAt, merged.items[0].closedAt, merged.items[0].blockers], ["2026-11-27T02:00:00Z", null, []]);
  const closed = await api.list("closed");
  assert.deepEqual([closed.items[0].mergedAt, closed.items[0].closedAt], [null, "2026-11-27T02:00:00Z"]);
  assert.deepEqual(calls.filter(call => call.path.endsWith("/pullrequests")).map(call => call.query.get("searchCriteria.status")), ["completed", "completed", "abandoned", "abandoned"]);
  const before = calls.length;
  assert.deepEqual(await api.list("assigned"), {items: [], counts: {}, notice: "Azure DevOps pull requests have reviewers, not assignees."});
  assert.equal(calls.length, before);
  assert.equal(await api.watch(new Set()), null);
});

test("an organization with more projects than are read says so", async () => {
  const many = Array.from({length: 31}, (_, index) => "P" + index);
  const {send, calls} = azure(() => [], many);
  const page = await azureInbox(account, token, send).list("open");
  assert.equal(calls.filter(call => call.path.endsWith("/pullrequests")).length, 30);
  assert.equal(page.notice, "Only the first 30 projects of contoso are read.");
});
