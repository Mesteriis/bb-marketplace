import test from "node:test";
import assert from "node:assert/strict";
import { azurePipelines } from "../src/adapters/bb/forges/azure-pipelines.ts";
import type { Account, Repo } from "../src/core/providers.ts";

type Call = {method: string; path: string; query: URLSearchParams; body: unknown};
function devops(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    assert.equal(url.origin, "https://dev.azure.com");
    const route = routes[call.method + " " + url.pathname];
    return route ? route(call) : new Response("{}", {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const account: Account = {kind: "azure", id: "z", label: "Z", origin: "https://dev.azure.com", organization: "org", username: "u"};
const repo: Repo = {id: "repo-guid", accountId: "z", project: "Team Project", name: "app", path: "Team Project/app",
  clone: "https://dev.azure.com/org/Team%20Project/_git/app", branch: "main", canPush: null};
const base = "/org/Team%20Project/_apis/build";
const build = {id: 501, buildNumber: "20261127.3", status: "completed", result: "failed", definition: {id: 12, name: "app-ci", path: "\\"},
  sourceBranch: "refs/heads/main", sourceVersion: "b".repeat(40), reason: "manual", queueTime: "2026-11-27T10:00:00Z",
  finishTime: "2026-11-27T10:03:00Z", _links: {web: {href: "https://dev.azure.com/org/Team%20Project/_build/results?buildId=501"}},
  requestedFor: {displayName: "Octo"}};
const timeline = {records: [
  {id: "job-1", type: "Job", name: "Build", state: "completed", result: "failed", startTime: "2026-11-27T10:00:10Z", finishTime: "2026-11-27T10:02:00Z", log: {id: 7}, parentId: "phase"},
  {id: "task-2", type: "Task", name: "Test", state: "completed", result: "failed", order: 2, parentId: "job-1", log: {id: 9}},
  {id: "task-1", type: "Task", name: "Checkout", state: "completed", result: "succeeded", order: 1, parentId: "job-1"},
  {id: "stage", type: "Stage", name: "CI", state: "completed", result: "failed"},
]};

test("builds of the repository are listed with the filter in the query", async () => {
  const {send, calls} = devops({["GET " + base + "/builds"]: () => Response.json({value: [build]})});
  const page = await azurePipelines(account, repo, "fixture-token-value", send).runs("failed", 1);
  assert.equal(calls[0].query.get("repositoryId"), "repo-guid");
  assert.equal(calls[0].query.get("repositoryType"), "TfsGit");
  assert.equal(calls[0].query.get("resultFilter"), "failed");
  assert.equal(calls[0].query.get("api-version"), "7.1");
  assert.deepEqual(page.items[0], {id: "501", number: null, workflow: "app-ci", workflowId: "12", title: "20261127.3", branch: "main",
    sha: "b".repeat(40), event: "manual", state: "failure", attempt: 1, createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:03:00Z",
    url: "https://dev.azure.com/org/Team%20Project/_build/results?buildId=501", actor: "Octo"});
  const active = devops({["GET " + base + "/builds"]: () => Response.json({value: []})});
  await azurePipelines(account, repo, "fixture-token-value", active.send).runs("active", 1);
  assert.equal(active.calls[0].query.get("statusFilter"), "inProgress,notStarted,cancelling");
});

test("timeline jobs carry their tasks as steps, and a job log is found through its log id", async () => {
  const {send, calls} = devops({
    ["GET " + base + "/builds/501/timeline"]: () => Response.json(timeline),
    ["GET " + base + "/builds/501/logs/7"]: () => new Response("2026-11-27T10:00:00.0000000Z ##[error]Tests failed\n"),
  });
  const api = azurePipelines(account, repo, "fixture-token-value", send);
  assert.deepEqual(await api.jobs("501"), [{id: "job-1", name: "Build", state: "failure", startedAt: "2026-11-27T10:00:10Z",
    completedAt: "2026-11-27T10:02:00Z", url: null, steps: [{number: 1, name: "Checkout", state: "success"}, {number: 2, name: "Test", state: "failure"}]}]);
  assert.deepEqual(await api.log("501", "job-1"), {text: "##[error]Tests failed\n", truncated: false});
  assert.equal(calls.at(-1)?.path, base + "/builds/501/logs/7");
});

test("queueing, retrying, re-running and cancelling use the build API", async () => {
  const ok = () => Response.json({id: 502});
  const {send, calls} = devops({["POST " + base + "/builds"]: ok, ["PATCH " + base + "/builds/501"]: ok,
    ["GET " + base + "/builds/501"]: () => Response.json(build)});
  const api = azurePipelines(account, repo, "fixture-token-value", send);
  await api.dispatch({id: "12", name: "app-ci", path: null}, "feature/x", {});
  await api.rerun("501", true);
  await api.rerun("501", false);
  await api.cancel("501");
  const writes = calls.filter(call => call.method !== "GET");
  assert.deepEqual(writes.map(call => [call.method, call.path, call.query.get("retry"), call.body]), [
    ["POST", base + "/builds", null, {definition: {id: 12}, sourceBranch: "refs/heads/feature/x"}],
    ["PATCH", base + "/builds/501", "true", {}],
    ["POST", base + "/builds", null, {definition: {id: 12}, sourceBranch: "refs/heads/main", sourceVersion: "b".repeat(40)}],
    ["PATCH", base + "/builds/501", null, {status: "cancelling"}],
  ]);
});

test("Azure runtime parameters are not offered as a form", async () => {
  const api = azurePipelines(account, repo, "fixture-token-value", devops({}).send);
  assert.deepEqual(await api.dispatchSpec({id: "12", name: "app-ci", path: null}, "main"), {dispatchable: true, inputs: []});
  await assert.rejects(api.dispatch({id: "12", name: "app-ci", path: null}, "main", {x: "1"}), {message: "PROVIDER_UNSUPPORTED"});
});
