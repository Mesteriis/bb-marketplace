import test from "node:test";
import assert from "node:assert/strict";
import { ciService } from "../src/adapters/bb/ci-service.ts";
import type { Account, Repo } from "../src/core/providers.ts";
import type { Copy } from "../src/core/workspace.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/w/sandbox", identity: "a".repeat(64)};
const account = (kind: Account["kind"]): Account => ({kind, id: "a", label: "A", origin: kind === "gitlab" ? "https://gitlab.com" : "https://github.com", organization: "", username: "octo"});
const repo: Repo = {id: "1", accountId: "a", project: "octo", name: "sandbox", path: "octo/sandbox", clone: "https://github.com/octo/sandbox.git", branch: "main", canPush: true};
const run = {id: 9, run_number: 7, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-11-27T10:00:00Z"};

function setup(kind: Account["kind"] = "github") {
  const writes: string[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    if (init?.method === "POST") { writes.push(url.pathname); return new Response(null, {status: 204}); }
    if (url.pathname.endsWith("/actions/workflows")) return Response.json({workflows: [{id: 123, name: "CI", path: ".github/workflows/ci.yml"}]});
    if (url.pathname.endsWith("/actions/runs/9")) return Response.json(run);
    if (url.pathname.endsWith("/actions/runs")) return Response.json({workflow_runs: [run], total_count: 1});
    if (url.pathname.endsWith("/check-runs/77/annotations")) return Response.json([{annotation_level: "failure", message: "The job was not started because of billing."}]);
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  const service = ciService({copy: async id => id === "c1" ? copy : undefined, linked: async () => ({account: account(kind), token: "fixture-token-value", repo}), send});
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

test("GitLab and unknown copies are reported, not guessed", async () => {
  await assert.rejects(setup("gitlab").service.runs("c1", "all", 1), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(setup().service.runs("other", "all", 1), {message: "NOT_FOUND"});
});

test("a job without a log is explained by the forge's notes", async () => {
  assert.deepEqual(await setup().service.log("c1", "9", "77"), {log: null, errorLine: null, notes: ["The job was not started because of billing."]});
});
