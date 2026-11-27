import test from "node:test";
import assert from "node:assert/strict";
import { ciCli, type CiCliDeps } from "../src/adapters/bb/ci-cli.ts";
import type { CiAction } from "../src/core/ci/actions.ts";
import type { Run } from "../src/core/ci/model.ts";

const run = (id: string, state: Run["state"], extra: Partial<Run> = {}): Run => ({
  id, number: Number(id), workflow: "CI", workflowId: "123", title: "Add retries", branch: "main", sha: null, event: "push",
  state, attempt: 1, createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:03:00Z", url: null, actor: null, ...extra,
});

function setup(permission: "none" | "read" | "write" = "write", approved = true, rerunAll = true, dynamic = false) {
  const prepared: CiAction[] = [];
  const confirmed: string[] = [];
  const asked: {threadId: string; title: string; lines: string[]}[] = [];
  const deps: CiCliDeps = {
    context: async threadId => { if (threadId !== "thr_1") throw new Error("NOT_FOUND"); return {copyId: "c1", permission}; },
    service: {
      runs: async (_copyId, filter) => ({operations: {dispatch: true, dispatchInputs: true, rerunFailed: true, rerunAll: rerunAll, cancel: true, liveLog: true},
        limitations: (rerunAll ? {} : {rerunAll: "GitLab retries failed jobs only."}) as Record<string, string>, items: [run("7", "failure"), run("8", "running", {workflow: "Deploy", workflowId: "124"})]
        .filter(item => filter === "all" || (filter === "failed" ? item.state === "failure" : item.state === "running")), more: false}),
      run: async () => ({run: run("7", "failure"), jobs: [{id: "77", name: "test", state: "failure", startedAt: null, completedAt: null, url: null, steps: []}]}),
      workflows: async () => ({workflows: [{id: "123", name: "CI", path: ".github/workflows/ci.yml"}, {id: "124", name: "Deploy", path: ".github/workflows/deploy.yml"},
        ...(dynamic ? [{id: "125", name: "CodeQL", path: "dynamic/github-code-scanning/codeql"}] : [])], defaultBranch: "main"}),
      form: async (_copyId, workflowId) => {
        if (workflowId === "125") throw new Error("PROVIDER_DENIED");
        return workflowId === "124"
          ? {dispatchable: true, inputs: [{name: "env", type: "choice", required: true, description: null, default: null, options: ["staging", "production"]},
            {name: "region", type: "string", required: true, description: null, default: "eu", options: []}]}
          : {dispatchable: false, inputs: []};
      },
      prepare: async (_copyId, action) => { prepared.push(action); return {id: "prev_1", lines: ["described " + action.kind], expires: "2026-11-27T10:05:00Z"}; },
      confirm: async previewId => { confirmed.push(previewId); return {done: true as const}; },
    },
    approve: async (threadId, _previewId, title, lines) => { asked.push({threadId, title, lines}); return approved; },
    now: () => Date.parse("2026-11-27T10:05:00Z"),
  };
  return {cli: ciCli(deps), prepared, confirmed, asked};
}

test("list prints one line per run and filters by state", async () => {
  const {cli} = setup("read");
  const all = await cli(["ci", "list"], {threadId: "thr_1"});
  assert.equal(all.exitCode, 0);
  assert.deepEqual(all.stdout!.split("\n"), ["failure  7  CI #7  [main]  3m 0s  Add retries", "running  8  Deploy #8  [main]  5m 0s  Add retries"]);
  const failed = await cli(["ci", "list", "--failed", "--json"], {threadId: "thr_1"});
  assert.deepEqual(JSON.parse(failed.stdout!).map((item: Run) => item.id), ["7"]);
});

test("show lists a run's jobs", async () => {
  const {cli} = setup("read");
  const shown = await cli(["ci", "show", "7"], {threadId: "thr_1"});
  assert.deepEqual(shown.stdout!.split("\n"), ["failure  CI #7  [main]  Add retries", "  failure  77  test"]);
});

test("workflows show which can run by hand and their inputs", async () => {
  const {cli} = setup("read");
  const listed = await cli(["ci", "workflows"], {threadId: "thr_1"});
  assert.deepEqual(listed.stdout!.split("\n"), ["default branch: main", "123  CI  .github/workflows/ci.yml  [no manual trigger]",
    "124  Deploy  .github/workflows/deploy.yml  [manual]", "    env: choice (required) [staging|production]", "    region: string (required) = eu"]);
});

test("a write asks the owner in the thread and happens only after approval", async () => {
  const {cli, prepared, confirmed, asked} = setup();
  const result = await cli(["ci", "run", "deploy.yml", "--ref", "release", "env=staging"], {threadId: "thr_1"});
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(prepared, [{kind: "dispatch", workflowId: "124", ref: "release", inputs: {env: "staging", region: "eu"}}]);
  assert.deepEqual(asked, [{threadId: "thr_1", title: "Approve CI: run workflow", lines: ["described dispatch"]}]);
  assert.deepEqual(confirmed, ["prev_1"]);
  await cli(["ci", "rerun", "7"], {threadId: "thr_1"});
  await cli(["ci", "rerun", "7", "--all"], {threadId: "thr_1"});
  await cli(["ci", "cancel", "8"], {threadId: "thr_1"});
  assert.deepEqual(prepared.slice(1), [{kind: "rerun", runId: "7", failedOnly: true}, {kind: "rerun", runId: "7", failedOnly: false}, {kind: "cancel", runId: "8"}]);
});

test("a declined approval writes nothing", async () => {
  const {cli, confirmed} = setup("write", false);
  const result = await cli(["ci", "cancel", "8"], {threadId: "thr_1"});
  assert.deepEqual([result.exitCode, result.stderr, confirmed], [1, "CANCELLED", []]);
});

test("writes need write access and reads need any access, from a BB thread", async () => {
  assert.equal((await setup("read").cli(["ci", "cancel", "8"], {threadId: "thr_1"})).stderr, "ACCESS_DENIED");
  assert.equal((await setup("none").cli(["ci", "list"], {threadId: "thr_1"})).stderr, "ACCESS_DENIED");
  const outside = await setup().cli(["ci", "list"], {});
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr!, /^THREAD_REQUIRED/);
});

test("a workflow run checks the workflow, its trigger and its inputs before asking anyone", async () => {
  const {cli, asked} = setup();
  assert.equal((await cli(["ci", "run", "nope"], {threadId: "thr_1"})).stderr, "NOT_FOUND · no workflow nope; see bb git-dashboard ci workflows");
  assert.equal((await cli(["ci", "run", "CI"], {threadId: "thr_1"})).stderr, "NOT_DISPATCHABLE · CI has no manual trigger");
  assert.equal((await cli(["ci", "run", "124"], {threadId: "thr_1"})).stderr, "INPUT_REQUIRED · env");
  assert.equal((await cli(["ci", "run", "124", "env=staging", "other=1"], {threadId: "thr_1"})).stderr, "UNKNOWN_INPUT · other");
  assert.equal((await cli(["ci", "run", "124", "env"], {threadId: "thr_1"})).stderr, "USAGE · expected name=value, got env");
  assert.equal(asked.length, 0);
});

test("help and unknown commands print the usage", async () => {
  const {cli} = setup();
  assert.match((await cli([], {})).stdout!, /bb git-dashboard ci list/);
  const wrong = await cli(["ci", "explode"], {threadId: "thr_1"});
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stderr!, /^Usage/);
});


test("a workflow whose file cannot be read is listed without its inputs, not failing the list", async () => {
  const {cli} = setup("read", true, true, true);
  const listed = await cli(["ci", "workflows"], {threadId: "thr_1"});
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal(listed.stdout!.split("\n").at(-1), "125  CodeQL  dynamic/github-code-scanning/codeql  [inputs not readable: PROVIDER_DENIED]");
});

test("a write the forge cannot do is refused before the owner is asked", async () => {
  const {cli, asked} = setup("write", true, false);
  const result = await cli(["ci", "rerun", "7", "--all"], {threadId: "thr_1"});
  assert.deepEqual([result.exitCode, result.stderr, asked.length], [1, "PROVIDER_UNSUPPORTED · GitLab retries failed jobs only.", 0]);
});
