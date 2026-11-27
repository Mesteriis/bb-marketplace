import test from "node:test";
import assert from "node:assert/strict";
import { gitlabPipelines } from "../src/adapters/bb/forges/gitlab-pipelines.ts";
import type { Account, Repo } from "../src/core/providers.ts";

type Call = {method: string; path: string; query: URLSearchParams; body: unknown};
function gitlab(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    const route = routes[call.method + " " + url.pathname];
    return route ? route(call) : Response.json({message: "404 Not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
const repo: Repo = {id: "42", accountId: "gl", project: "group/sub", name: "app", path: "group/sub/app", clone: "https://gitlab.example.org/group/sub/app.git", branch: "main", canPush: null};
const token = "fixture-token-value";
const base = "/api/v4/projects/42";
const pipeline = {id: 501, iid: 12, status: "failed", ref: "main", sha: "a".repeat(40), source: "web", name: null,
  created_at: "2026-11-27T10:00:00Z", updated_at: "2026-11-27T10:05:00Z", web_url: "https://gitlab.example.org/group/sub/app/-/pipelines/501", user: {username: "octo"}};

test("pipelines are listed with the forge's own filters", async () => {
  const {send, calls} = gitlab({["GET " + base + "/pipelines"]: () => Response.json([pipeline], {headers: {"x-next-page": ""}})});
  const api = gitlabPipelines(account, repo, token, send);
  const page = await api.runs("failed", 1);
  assert.equal(calls[0].query.get("status"), "failed");
  assert.deepEqual(page.items[0], {id: "501", number: 12, workflow: "Pipeline", workflowId: "pipeline", title: "main", branch: "main",
    sha: "a".repeat(40), event: "web", state: "failure", attempt: 1, createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:05:00Z",
    url: "https://gitlab.example.org/group/sub/app/-/pipelines/501", actor: "octo"});
  await api.runs("active", 1);
  assert.deepEqual(calls.slice(1).map(call => call.query.get("scope")).sort(), ["pending", "running"]);
});

test("jobs come with their stage, and a job's trace is read while it runs", async () => {
  const {send} = gitlab({
    ["GET " + base + "/pipelines/501/jobs"]: () => Response.json([{id: 9, name: "test", stage: "test", status: "running", started_at: "2026-11-27T10:01:00Z",
      finished_at: null, web_url: "https://gitlab.example.org/group/sub/app/-/jobs/9"},
      {id: 10, name: "deploy", stage: "deploy", status: "created", started_at: null, finished_at: null, web_url: null}]),
    ["GET " + base + "/jobs/9/trace"]: () => new Response("section_start:1:step_script\r\u001b[0K$ make\nERROR: build broke\n"),
  });
  const api = gitlabPipelines(account, repo, token, send);
  assert.deepEqual(await api.jobs("501"), [{id: "9", name: "test · test", state: "running", startedAt: "2026-11-27T10:01:00Z", completedAt: null,
    url: "https://gitlab.example.org/group/sub/app/-/jobs/9", steps: []},
    {id: "10", name: "deploy · deploy", state: "waiting", startedAt: null, completedAt: null, url: null, steps: []}]);
  assert.deepEqual(await api.log("501", "9"), {text: "$ make\nERROR: build broke\n", truncated: false});
});

test("the Run pipeline form reads the CI file at the chosen ref", async () => {
  const yaml = "variables:\n  DEPLOY_ENV:\n    value: staging\n    options: [staging, production]\n    description: Where\n";
  let config = "";
  const {send, calls} = gitlab({["GET " + base]: () => Response.json({id: 42, ci_config_path: config}),
    ["GET " + base + "/repository/files/.gitlab-ci.yml/raw"]: () => new Response("spec:\n  inputs: {}\n---\n" + yaml)});
  const api = gitlabPipelines(account, repo, token, send);
  const [workflow] = await api.workflows();
  assert.deepEqual(workflow, {id: "pipeline", name: ".gitlab-ci.yml", path: ".gitlab-ci.yml"});
  const spec = await api.dispatchSpec(workflow, "feature/x");
  assert.equal(calls.at(-1)!.query.get("ref"), "feature/x");
  assert.deepEqual(spec.inputs.map(input => [input.name, input.options]), [["DEPLOY_ENV", ["staging", "production"]]]);
  // A configuration kept in another project gives no form; the pipeline still runs.
  config = "ci/main.yml@group/ci-templates";
  const [external] = await api.workflows();
  assert.deepEqual(external, {id: "pipeline", name: "ci/main.yml@group/ci-templates", path: null});
  assert.deepEqual(await api.dispatchSpec(external, "main"), {dispatchable: true, inputs: []});
});

test("running, retrying and cancelling use the pipeline API; re-running all is not offered", async () => {
  const ok = () => Response.json({id: 502});
  const {send, calls} = gitlab({["POST " + base + "/pipeline"]: ok, ["POST " + base + "/pipelines/501/retry"]: ok,
    ["POST " + base + "/pipelines/501/cancel"]: ok, ["GET " + base + "/pipelines/501"]: () => Response.json(pipeline)});
  const api = gitlabPipelines(account, repo, token, send);
  await api.dispatch({id: "pipeline", name: ".gitlab-ci.yml", path: ".gitlab-ci.yml"}, "main", {DEPLOY_ENV: "production"});
  await api.rerun("501", true);
  await assert.rejects(api.rerun("501", false), {message: "PROVIDER_UNSUPPORTED"});
  await api.cancel("501");
  assert.deepEqual(calls.filter(call => call.method === "POST").map(call => [call.path, call.body]), [
    [base + "/pipeline", {ref: "main", variables: [{key: "DEPLOY_ENV", value: "production"}]}],
    [base + "/pipelines/501/retry", undefined],
    [base + "/pipelines/501/cancel", undefined],
  ]);
});

test("a failed job explains itself through its failure reason", async () => {
  const {send} = gitlab({["GET " + base + "/jobs/9"]: () => Response.json({id: 9, status: "failed", failure_reason: "script_failure"})});
  assert.deepEqual(await gitlabPipelines(account, repo, token, send).notes("501", "9"), ["Failure reason: script failure"]);
});

test("Active lists a pipeline once even when it moves from pending to running between the two reads", async () => {
  const {send} = gitlab({["GET " + base + "/pipelines"]: () => Response.json([pipeline, {...pipeline, id: 500}], {headers: {"x-next-page": ""}})});
  const page = await gitlabPipelines(account, repo, token, send).runs("active", 1);
  assert.deepEqual(page.items.map(item => item.id), ["501", "500"]);
});

test("every page of a large pipeline's jobs is read", async () => {
  const job = (id: number) => ({id, name: "j" + id, stage: "test", status: "success", started_at: null, finished_at: null, web_url: null});
  const {send, calls} = gitlab({["GET " + base + "/pipelines/501/jobs"]: call => call.query.get("page") === "2"
    ? Response.json([job(1)], {headers: {"x-next-page": ""}}) : Response.json([job(3), job(2)], {headers: {"x-next-page": "2"}})});
  const jobs = await gitlabPipelines(account, repo, token, send).jobs("501");
  assert.deepEqual(jobs.map(item => item.id), ["1", "2", "3"]);
  assert.equal(calls.length, 2);
});

test("a ref without the CI file gives an empty Run pipeline form, not an error", async () => {
  const {send} = gitlab({["GET " + base]: () => Response.json({id: 42, ci_config_path: null})});
  const api = gitlabPipelines(account, repo, token, send);
  const [workflow] = await api.workflows();
  assert.deepEqual(await api.dispatchSpec(workflow, "no-ci"), {dispatchable: true, inputs: []});
});
