import test from "node:test";
import assert from "node:assert/strict";
import { ciService } from "../src/adapters/bb/ci-service.ts";
import type { Account, Repo } from "../src/core/providers.ts";
import type { Copy } from "../src/core/workspace.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/w/sandbox", identity: "a".repeat(64)};
const account = (kind: Account["kind"]): Account => ({kind, id: "a", label: "A", origin: kind === "gitlab" ? "https://gitlab.com" : "https://github.com", organization: "", username: "octo"});
const repo: Repo = {id: "1", accountId: "a", project: "octo", name: "sandbox", path: "octo/sandbox", clone: "https://github.com/octo/sandbox.git", branch: "main", canPush: true};
const run = {id: 9, run_number: 7, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-11-27T10:00:00Z"};

function setup(kind: Account["kind"] = "github", linkedRepo: () => Repo = () => repo) {
  const writes: string[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    if (init?.method === "POST") { writes.push(url.pathname); return new Response(null, {status: 204}); }
    if (url.pathname.endsWith("/actions/workflows")) return Response.json({workflows: [{id: 123, name: "CI", path: ".github/workflows/ci.yml"}]});
    if (url.pathname.endsWith("/actions/runs/9")) return Response.json(run);
    if (url.pathname === "/api/v4/projects/1/pipelines") return Response.json([]);
    if (url.pathname.endsWith("/actions/runs")) return Response.json({workflow_runs: [run], total_count: 1});
    if (url.pathname.endsWith("/check-runs/77/annotations")) return Response.json([{annotation_level: "failure", message: "The job was not started because of billing."}]);
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  const service = ciService({copy: async id => id === "c1" ? copy : undefined, linked: async () => ({account: account(kind), token: "fixture-token-value", repo: linkedRepo()}), send});
  return {service, writes};
}

test("runs carry the forge, its operations and the stated limitations", async () => {
  const result = await setup().service.runs("c1", "all", 1);
  assert.equal(result.forge, "github");
  assert.equal(result.items[0].state, "failure");
  assert.equal(result.operations.liveLog, false);
  assert.deepEqual(result.limitations, {liveLog: "GitHub publishes a job log when the job ends."});
});

test("a write happens only once, after its preview is confirmed", async () => {
  const {service, writes} = setup();
  const preview = await service.prepare("c1", {kind: "rerun", runId: "9", failedOnly: true});
  assert.deepEqual(preview.lines, ["Re-run failed jobs of CI #7"]);
  assert.deepEqual(writes, []);
  await service.confirm(preview.id);
  assert.deepEqual(writes, ["/repos/octo/sandbox/actions/runs/9/rerun-failed-jobs"]);
  await assert.rejects(service.confirm(preview.id), {message: "PREVIEW_EXPIRED"});
  assert.equal(writes.length, 1);
});

test("dispatching an unknown workflow is refused before anything is written", async () => {
  const {service, writes} = setup();
  await assert.rejects(service.prepare("c1", {kind: "dispatch", workflowId: "999", ref: "main", inputs: {}}), {message: "NOT_FOUND"});
  const preview = await service.prepare("c1", {kind: "dispatch", workflowId: "123", ref: "main", inputs: {outcome: "failure"}});
  assert.deepEqual(preview.lines, ["Run workflow CI on main", "outcome = failure"]);
  await service.confirm(preview.id);
  assert.deepEqual(writes, ["/repos/octo/sandbox/actions/workflows/123/dispatches"]);
});

test("GitLab copies read pipelines; unknown copies are reported, not guessed", async () => {
  const gitlab = await setup("gitlab").service.runs("c1", "all", 1);
  assert.equal(gitlab.forge, "gitlab");
  assert.deepEqual(gitlab.limitations, {rerunAll: "GitLab retries failed jobs only; start a new pipeline with Run pipeline."});
  assert.equal(gitlab.operations.rerunAll, false);
  await assert.rejects(setup().service.runs("other", "all", 1), {message: "NOT_FOUND"});
});

test("a job without a log is explained by the forge's notes", async () => {
  assert.deepEqual(await setup().service.log("c1", "9", "77"), {log: null, errorLine: null, notes: ["The job was not started because of billing."]});
});

test("a confirmation is refused when the copy was linked to another repository meanwhile", async () => {
  let current = repo;
  const {service, writes} = setup("github", () => current);
  const preview = await service.prepare("c1", {kind: "cancel", runId: "9"});
  current = {...repo, id: "2", path: "octo/other", name: "other", clone: "https://github.com/octo/other.git"};
  await assert.rejects(service.confirm(preview.id), {message: "PREVIEW_EXPIRED"});
  assert.deepEqual(writes, []);
});

test("a failed job's annotations come with its log", async () => {
  const send = (async (target: string | URL) => {
    const path = new URL(String(target)).pathname;
    if (path.endsWith("/actions/jobs/77/logs")) return new Response("##[error]Sandbox failure requested\n##[error]Process completed with exit code 1.\n");
    if (path.endsWith("/check-runs/77/annotations")) return Response.json([{annotation_level: "failure", path: "src/greeting.txt", start_line: 2, message: "Sandbox failure requested"}]);
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  const service = ciService({copy: async () => copy, linked: async () => ({account: account("github"), token: "fixture-token-value", repo}), send});
  assert.deepEqual(await service.log("c1", "9", "77"), {log: {text: "##[error]Sandbox failure requested\n##[error]Process completed with exit code 1.\n", truncated: false},
    errorLine: 0, notes: ["src/greeting.txt:2 — Sandbox failure requested"]});
});

test("Run workflow is offered only when the token may push; an unknown permission keeps it", async () => {
  assert.equal((await setup("github", () => ({...repo, canPush: false})).service.runs("c1", "all", 1)).operations.dispatch, false);
  assert.equal((await setup("github", () => ({...repo, canPush: null})).service.runs("c1", "all", 1)).operations.dispatch, true);
  assert.equal((await setup().service.runs("c1", "all", 1)).operations.dispatch, true);
});

test("the workflow list is read once per five minutes for the same repository", async () => {
  let reads = 0;
  let now = Date.parse("2026-11-27T10:00:00Z");
  const send = (async (target: string | URL) => {
    if (new URL(String(target)).pathname.endsWith("/actions/workflows")) { reads++; return Response.json({workflows: [{id: 123, name: "CI", path: ".github/workflows/ci.yml"}]}); }
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  const service = ciService({copy: async () => copy, linked: async () => ({account: account("github"), token: "fixture-token-value", repo}), send, now: () => now});
  await service.workflows("c1");
  now += 4 * 60_000;
  assert.deepEqual((await service.workflows("c1")).workflows.map(item => item.name), ["CI"]);
  assert.equal(reads, 1);
  now += 2 * 60_000;
  await service.workflows("c1");
  assert.equal(reads, 2);
});

test("the overview reads each linked repository once and reports the unreachable one", async () => {
  const copies: Copy[] = [copy, {...copy, id: "c2", root: "/w/sandbox-2"}, {...copy, id: "c3", root: "/w/other"}, {...copy, id: "c4", root: "/w/loose"}];
  const other: Repo = {...repo, id: "2", name: "other", path: "octo/other"};
  const send = (async (target: string | URL) => {
    const path = new URL(String(target)).pathname;
    if (path === "/repos/octo/sandbox/actions/runs") return Response.json({workflow_runs: [run], total_count: 1});
    if (path === "/repos/octo/other/actions/runs") return Response.json({message: "Not Found"}, {status: 404});
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  const service = ciService({copy: async id => copies.find(item => item.id === id), send,
    linked: async item => {
      if (item.id === "c4") throw new Error("ACCOUNT_UNCONFIGURED");
      return {account: account("github"), token: "fixture-token-value", repo: item.id === "c3" ? other : repo};
    }});
  const overview = await service.overview(copies);
  assert.deepEqual(overview.repositories.map(row => [row.copyId, row.repository, row.forge, row.runs.length, row.error]),
    [["c1", "octo/sandbox", "github", 1, null], ["c3", "octo/other", "github", 0, "PROVIDER_DENIED"]]);
});
