import test from "node:test";
import assert from "node:assert/strict";
import { actionsPipelines } from "../src/adapters/bb/forges/actions-pipelines.ts";
import type { Account, Repo } from "../src/core/providers.ts";

type Call = {method: string; url: string; auth: string | null; body: unknown};
function forge(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", url: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    const route = routes[call.method + " " + url.origin + url.pathname] ?? routes[call.method + " " + url.pathname];
    return route ? route(call) : new Response("{}", {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const github: Account = {kind: "github", id: "a", label: "A", origin: "https://github.com", organization: "", username: "octo"};
const gitea: Account = {kind: "gitea", id: "g", label: "G", origin: "https://git.example.org", organization: "", username: "octo"};
const repo = (account: Account): Repo => ({id: "1", accountId: account.id, project: "octo", name: "sandbox", path: "octo/sandbox",
  clone: account.kind === "github" ? "https://github.com/octo/sandbox.git" : "https://git.example.org/octo/sandbox.git", branch: "main", canPush: true});
const token = "fixture-token-value";
const runRow = {id: 45968318641, run_number: 7, name: "CI", path: ".github/workflows/ci.yml", display_title: "Dispatch", head_branch: "main",
  head_sha: "a".repeat(40), event: "workflow_dispatch", status: "completed", conclusion: "failure", run_attempt: 1,
  created_at: "2026-11-27T10:00:00Z", updated_at: "2026-11-27T10:02:00Z", html_url: "https://github.com/octo/sandbox/actions/runs/45968318641",
  actor: {login: "octo"}};

test("GitHub runs are normalized and the failed filter is asked from the API", async () => {
  const {send, calls} = forge({"GET /repos/octo/sandbox/actions/runs": () => Response.json({total_count: 31, workflow_runs: [runRow]})});
  const page = await actionsPipelines(github, repo(github), token, send).runs("failed", 1);
  assert.equal(calls[0].url, "/repos/octo/sandbox/actions/runs?per_page=30&page=1&status=failure");
  assert.deepEqual(page.items[0], {id: "45968318641", number: 7, workflow: "CI", workflowId: ".github/workflows/ci.yml", title: "Dispatch",
    branch: "main", sha: "a".repeat(40), event: "workflow_dispatch", state: "failure", attempt: 1, createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-27T10:02:00Z", url: "https://github.com/octo/sandbox/actions/runs/45968318641", actor: "octo"});
  assert.equal(page.more, true);
});

test("active runs combine running and queued, newest first", async () => {
  const row = (id: number, status: string, created: string) => ({...runRow, id, status, conclusion: null, created_at: created});
  const {send, calls} = forge({"GET /repos/octo/sandbox/actions/runs": call => Response.json({workflow_runs:
    call.url.includes("status=in_progress") ? [row(1, "in_progress", "2026-11-27T10:00:00Z")] : [row(2, "queued", "2026-11-27T10:05:00Z")]})});
  const page = await actionsPipelines(github, repo(github), token, send).runs("active", 1);
  assert.deepEqual(page.items.map(item => [item.id, item.state]), [["2", "queued"], ["1", "running"]]);
  assert.deepEqual(calls.map(call => new URLSearchParams(call.url.split("?")[1]).get("status") ?? "unfiltered").sort(), ["in_progress", "queued", "unfiltered", "waiting"]);
});

test("Gitea uses its API prefix and limit paging", async () => {
  const {send, calls} = forge({"GET /api/v1/repos/octo/sandbox/actions/runs": () => Response.json({workflow_runs: [runRow], total_count: 1})});
  const page = await actionsPipelines(gitea, repo(gitea), token, send).runs("all", 2);
  assert.equal(calls[0].url, "/api/v1/repos/octo/sandbox/actions/runs?limit=30&page=2");
  assert.equal(calls[0].auth, "token " + token);
  assert.equal(page.more, false);
});

test("jobs keep their steps", async () => {
  const {send} = forge({"GET /repos/octo/sandbox/actions/runs/9/jobs": () => Response.json({jobs: [{id: 77, name: "test (2)", status: "completed",
    conclusion: "failure", started_at: "2026-11-27T10:00:10Z", completed_at: "2026-11-27T10:01:00Z", html_url: "https://github.com/octo/sandbox/actions/runs/9/job/77",
    steps: [{number: 1, name: "Set up job", status: "completed", conclusion: "success"}, {number: 2, name: "Test", status: "completed", conclusion: "failure"}]}]})});
  const [job] = await actionsPipelines(github, repo(github), token, send).jobs("9");
  assert.deepEqual(job, {id: "77", name: "test (2)", state: "failure", startedAt: "2026-11-27T10:00:10Z", completedAt: "2026-11-27T10:01:00Z",
    url: "https://github.com/octo/sandbox/actions/runs/9/job/77", steps: [{number: 1, name: "Set up job", state: "success"}, {number: 2, name: "Test", state: "failure"}]});
});

test("a GitHub job log follows the storage redirect without the token and is cleaned", async () => {
  const {send, calls} = forge({
    "GET /repos/octo/sandbox/actions/jobs/77/logs": () => new Response(null, {status: 302, headers: {location: "https://logs.example.net/blob?sig=1"}}),
    "GET https://logs.example.net/blob": () => new Response("2026-11-27T10:00:00.1Z \u001b[31m##[error]boom\u001b[0m\n"),
  });
  assert.deepEqual(await actionsPipelines(github, repo(github), token, send).log("9", "77"), {text: "##[error]boom\n", truncated: false});
  assert.equal(calls[1].auth, null);
});

test("a log that is not published yet is null, a huge log keeps its tail", async () => {
  const missing = forge({});
  assert.equal(await actionsPipelines(github, repo(github), token, missing.send).log("9", "77"), null);
  const big = "x".repeat(3 * 1024 * 1024) + "\nlast line\n";
  const huge = forge({"GET /api/v1/repos/octo/sandbox/actions/jobs/77/logs": () => new Response(big)});
  const log = await actionsPipelines(gitea, repo(gitea), token, huge.send).log("9", "77");
  assert.equal(log?.truncated, true);
  assert.ok(log!.text.endsWith("last line\n"));
  assert.ok(log!.text.length <= 2 * 1024 * 1024);
});

test("the dispatch form comes from the workflow file at the chosen ref", async () => {
  const yaml = "on:\n  workflow_dispatch:\n    inputs:\n      outcome:\n        type: choice\n        options: [success, failure]\n";
  const {send, calls} = forge({"GET /repos/octo/sandbox/contents/.github/workflows/ci.yml": () =>
    Response.json({encoding: "base64", content: Buffer.from(yaml).toString("base64")})});
  const spec = await actionsPipelines(github, repo(github), token, send).dispatchSpec({id: "123", name: "CI", path: ".github/workflows/ci.yml"}, "feature/x");
  assert.equal(calls[0].url, "/repos/octo/sandbox/contents/.github/workflows/ci.yml?ref=feature%2Fx");
  assert.deepEqual(spec.inputs.map(input => [input.name, input.type, input.options]), [["outcome", "choice", ["success", "failure"]]]);
});

test("writes go to the documented endpoints", async () => {
  const ok = () => new Response(null, {status: 204});
  const {send, calls} = forge({
    "POST /repos/octo/sandbox/actions/workflows/123/dispatches": ok, "POST /repos/octo/sandbox/actions/runs/9/rerun-failed-jobs": ok,
    "POST /repos/octo/sandbox/actions/runs/9/rerun": ok, "POST /repos/octo/sandbox/actions/runs/9/cancel": ok,
  });
  const api = actionsPipelines(github, repo(github), token, send);
  await api.dispatch({id: "123", name: "CI", path: null}, "main", {outcome: "failure"});
  await api.rerun("9", true);
  await api.rerun("9", false);
  await api.cancel("9");
  assert.deepEqual(calls.map(call => call.method + " " + call.url), ["POST /repos/octo/sandbox/actions/workflows/123/dispatches",
    "POST /repos/octo/sandbox/actions/runs/9/rerun-failed-jobs", "POST /repos/octo/sandbox/actions/runs/9/rerun", "POST /repos/octo/sandbox/actions/runs/9/cancel"]);
  assert.deepEqual(calls[0].body, {ref: "main", inputs: {outcome: "failure"}});
});

test("an operation an older Gitea does not have is reported as unsupported", async () => {
  const {send} = forge({"POST /api/v1/repos/octo/sandbox/actions/runs/9/rerun": () => new Response("{}", {status: 405})});
  await assert.rejects(actionsPipelines(gitea, repo(gitea), token, send).rerun("9", false), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(actionsPipelines(gitea, repo(gitea), token, send).cancel("9"), {message: "PROVIDER_UNSUPPORTED"});
});

test("a GitHub job that never started explains itself through its check-run annotations", async () => {
  const {send} = forge({"GET /repos/octo/sandbox/check-runs/77/annotations": () => Response.json([
    {annotation_level: "failure", message: "The job was not started because recent account payments have failed."},
    {annotation_level: "notice", message: "unrelated"}])});
  assert.deepEqual(await actionsPipelines(github, repo(github), token, send).notes("9", "77"),
    ["The job was not started because recent account payments have failed."]);
  const located = forge({"GET /repos/octo/sandbox/check-runs/77/annotations": () => Response.json([
    {annotation_level: "failure", path: "src/greeting.txt", start_line: 2, message: "Sandbox failure requested"},
    {annotation_level: "failure", path: ".github", start_line: 1, message: "Process completed with exit code 1."}])});
  assert.deepEqual(await actionsPipelines(github, repo(github), token, located.send).notes("9", "77"),
    ["src/greeting.txt:2 — Sandbox failure requested"], "the runner's closing annotation adds nothing next to a specific one");
  assert.deepEqual(await actionsPipelines(gitea, repo(gitea), token, forge({}).send).notes("9", "77"), []);
});

test("a write the forge refuses in the run's current state has its own code", async () => {
  const {send} = forge({"POST /repos/octo/sandbox/actions/runs/9/cancel": () => Response.json({message: "Cannot cancel"}, {status: 409})});
  await assert.rejects(actionsPipelines(github, repo(github), token, send).cancel("9"), {message: "PROVIDER_CONFLICT"});
});

test("run and job links are kept only when they point at the forge over https", async () => {
  const foreign = {...runRow, html_url: "https://evil.example/phish"};
  const {send} = forge({"GET /api/v1/repos/octo/sandbox/actions/runs": () => Response.json({workflow_runs: [foreign, {...runRow, id: 3, html_url: "https://git.example.org/octo/sandbox/actions/runs/3"}]})});
  const items = (await actionsPipelines(gitea, repo(gitea), token, send).runs("all", 1)).items;
  assert.deepEqual(items.map(item => item.url), [null, "https://git.example.org/octo/sandbox/actions/runs/3"]);
  const gh = forge({"GET /repos/octo/sandbox/actions/runs": () => Response.json({workflow_runs: [runRow, {...runRow, html_url: "http://github.com/x"}]})});
  assert.deepEqual((await actionsPipelines(github, repo(github), token, gh.send).runs("all", 1)).items.map(item => item.url),
    ["https://github.com/octo/sandbox/actions/runs/45968318641", null]);
});

test("runs waiting for approval count as active", async () => {
  const {send, calls} = forge({"GET /repos/octo/sandbox/actions/runs": () => Response.json({workflow_runs: []})});
  await actionsPipelines(github, repo(github), token, send).runs("active", 1);
  assert.deepEqual(calls.map(call => new URLSearchParams(call.url.split("?")[1]).get("status") ?? "unfiltered").sort(), ["in_progress", "queued", "unfiltered", "waiting"]);
});

test("a log redirect to plain http or with credentials in the URL is refused", async () => {
  for (const location of ["http://logs.example.net/blob", "https://user:pw@logs.example.net/blob"]) {
    const {send, calls} = forge({"GET /repos/octo/sandbox/actions/jobs/77/logs": () => new Response(null, {status: 302, headers: {location}})});
    await assert.rejects(actionsPipelines(github, repo(github), token, send).log("9", "77"), {message: "PROVIDER_REJECTED"});
    assert.equal(calls.length, 1);
  }
});

test("Active also finds a running run that the forge's status filter has not indexed yet", async () => {
  const running = {...runRow, id: 77, status: "in_progress", conclusion: null, created_at: "2026-11-27T11:00:00Z"};
  const {send} = forge({"GET /repos/octo/sandbox/actions/runs": call =>
    Response.json({workflow_runs: new URLSearchParams(call.url.split("?")[1]).get("status") ? [] : [running, runRow]})});
  const items = (await actionsPipelines(github, repo(github), token, send).runs("active", 1)).items;
  assert.deepEqual(items.map(item => [item.id, item.state]), [["77", "running"]]);
});
