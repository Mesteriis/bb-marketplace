import test from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ciAgent } from "../src/adapters/bb/ci-agent.ts";
import { ciService } from "../src/adapters/bb/ci-service.ts";
import type { Copy } from "../src/core/workspace.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/w/sandbox", identity: "a".repeat(64), projectId: "proj_1"};
const run = {id: 9, run_number: 7, name: "CI", status: "completed", conclusion: "failure", run_attempt: 1, head_branch: "main", created_at: "2026-11-27T10:00:00Z"};
const send = (async (target: string | URL) => {
  const path = new URL(String(target)).pathname;
  if (path.endsWith("/actions/runs/9")) return Response.json(run);
  if (path.endsWith("/actions/runs")) return Response.json({total_count: 1, workflow_runs: [run]});
  if (path.endsWith("/actions/runs/9/jobs")) return Response.json({jobs: [{id: 77, name: "test (2)", status: "completed", conclusion: "failure", steps: []}]});
  if (path.endsWith("/actions/jobs/77/logs")) return new Response("setup\nassert failed: src/greeting.txt:2\n##[error]Process completed with exit code 1.\npost\n");
  return new Response("{}", {status: 404});
}) as typeof fetch;

function fakeBb(options: {copy?: Copy; config?: {fallbackProject?: string; model: string}} = {}) {
  const store = new Map<string, unknown>();
  const spawned: {prompt: string; title: string; environment: unknown; projectId: string; model?: string}[] = [];
  const listed: unknown[] = [];
  const messages: {threadId: string; text: string}[] = [];
  const bb = {
    storage: {kv: {get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); }, list: async (prefix: string) => [...store.keys()].filter(key => key.startsWith(prefix))}},
    background: {service: () => {}},
    sdk: {threads: {
      spawn: async (args: {prompt: string; title: string; environment: unknown; projectId: string; model?: string}) => { spawned.push(args); await new Promise(resolve => setTimeout(resolve, 20)); return {id: "thr_new"}; },
      send: async (args: {threadId: string; input: {text: string}[]}) => {
        if (args.threadId === "thr_gone") throw new Error("NOT_FOUND");
        messages.push({threadId: args.threadId, text: args.input[0].text});
        return {};
      },
      list: async (args: unknown) => { listed.push(args); return [{id: "thr_a", title: "Fix CI"}, {id: "thr_gone", title: "Old"}]; },
    }},
  } as unknown as BbPluginApi;
  const service = ciService({copy: async () => options.copy ?? copy, send,
    linked: async () => ({account: {kind: "github", id: "a", label: "A", origin: "https://github.com", organization: "", username: "octo"}, token: "fixture-token-value",
      repo: {id: "1", accountId: "a", project: "octo", name: "sandbox", path: "octo/sandbox", clone: "https://github.com/octo/sandbox.git", branch: "main", canPush: true}})});
  const config = options.config ?? {model: ""};
  return {agent: ciAgent(bb, service, () => {}, async () => config), spawned, messages, store, listed};
}

test("asking an agent opens one investigation thread on the copy, with the fenced error excerpt", async () => {
  const {agent, spawned} = fakeBb();
  assert.deepEqual(await agent.ask("c1", "9", null), {threadId: "thr_new", created: true});
  assert.deepEqual(await agent.ask("c1", "9", null), {threadId: "thr_new", created: false});
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].title, "CI failed: CI #7 (main)");
  assert.deepEqual(spawned[0].environment, {type: "host", hostId: "mac", workspace: {type: "unmanaged", path: "/w/sandbox"}});
  assert.match(spawned[0].prompt, /Failed job: test \(2\)/);
  assert.match(spawned[0].prompt, /assert failed: src\/greeting\.txt:2\n##\[error\]Process completed with exit code 1\.\n````/);
  assert.doesNotMatch(spawned[0].prompt, /\npost\n/);
});

test("sending to threads reports each thread that could not take the message", async () => {
  const {agent, messages} = fakeBb();
  assert.deepEqual(await agent.send("c1", "9", "77", ["thr_a", "thr_gone", "thr_a"]), {sent: ["thr_a"], failed: [{threadId: "thr_gone", code: "NOT_FOUND"}]});
  assert.equal(messages.length, 1);
});

test("subscriptions are listed with the project's threads and can be cleared", async () => {
  const {agent} = fakeBb();
  await agent.subscribe("c1", ["thr_a", "thr_a"]);
  assert.deepEqual(await agent.threads("c1"), {threads: [{id: "thr_a", title: "Fix CI"}, {id: "thr_gone", title: "Old"}], subscribed: ["thr_a"]});
  await agent.subscribe("c1", []);
  assert.deepEqual((await agent.threads("c1")).subscribed, []);
});

test("runs go only to threads of the copy's project", async () => {
  const {agent, messages} = fakeBb();
  await assert.rejects(agent.send("c1", "9", null, ["thr_a", "thr_other_project"]), {message: "ACCESS_DENIED"});
  await assert.rejects(agent.subscribe("c1", ["thr_other_project"]), {message: "ACCESS_DENIED"});
  assert.equal(messages.length, 0);
});

test("asking twice at once opens one thread", async () => {
  const {agent, spawned} = fakeBb();
  const [first, second] = await Promise.all([agent.ask("c1", "9", null), agent.ask("c1", "9", null)]);
  assert.equal(spawned.length, 1);
  assert.deepEqual([first.threadId, second.threadId], ["thr_new", "thr_new"]);
});

test("the watcher remembers a failure only after delivering it", async () => {
  const {agent, messages, store} = fakeBb();
  await agent.subscribe("c1", ["thr_gone"]);
  store.set("ci-seen/c1", []);
  await agent.watchOnce("c1");
  assert.deepEqual(store.get("ci-seen/c1"), [], "nothing was delivered, so the failure is retried next round");
  await agent.subscribe("c1", ["thr_a"]);
  store.set("ci-seen/c1", []);
  await agent.watchOnce("c1");
  assert.equal(messages.length, 1);
  assert.equal((store.get("ci-seen/c1") as string[]).length, 1);
  await agent.watchOnce("c1");
  assert.equal(messages.length, 1);
});

const loose: Copy = {id: "c2", hostId: "mac", root: "/w/loose", identity: "b".repeat(64)};

test("a copy without a BB project needs the fallback project, and its thread starts there in the project's default environment", async () => {
  await assert.rejects(fakeBb({copy: loose}).agent.ask("c2", "9", null), {message: "PROJECT_REQUIRED"});
  const {agent, spawned, listed} = fakeBb({copy: loose, config: {fallbackProject: "proj_fallback", model: ""}});
  assert.deepEqual(await agent.ask("c2", "9", null), {threadId: "thr_new", created: true});
  assert.deepEqual([spawned[0].projectId, spawned[0].environment], ["proj_fallback", {type: "project-default"}]);
  await agent.threads("c2");
  assert.equal((listed[0] as {projectId: string}).projectId, "proj_fallback");
});

test("the investigation model setting goes to the new thread; empty leaves the project default", async () => {
  const named = fakeBb({config: {model: " claude-sonnet-5-5 "}});
  await named.agent.ask("c1", "9", null);
  assert.equal(named.spawned[0].model, "claude-sonnet-5-5");
  const plain = fakeBb();
  await plain.agent.ask("c1", "9", null);
  assert.equal("model" in plain.spawned[0], false);
});

test("a sent run can lead with the owner's message and leave the log excerpt out", async () => {
  const {agent, messages} = fakeBb();
  await agent.send("c1", "9", "77", ["thr_a"], {note: "Please look at this one.", includeLogs: false});
  assert.match(messages[0].text, /^Please look at this one\.\n\n/);
  assert.match(messages[0].text, /Failed job: test \(2\)/);
  assert.doesNotMatch(messages[0].text, /assert failed/);
  await agent.send("c1", "9", "77", ["thr_a"], {note: "  ", includeLogs: true});
  assert.match(messages[1].text, /assert failed: src\/greeting\.txt:2/);
  assert.doesNotMatch(messages[1].text, /^\s/);
});

test("the prompt for the composer comes with the project to start in, or none", async () => {
  const own = await fakeBb().agent.compose("c1", "9", null);
  assert.equal(own.projectId, "proj_1");
  assert.match(own.prompt, /assert failed/);
  assert.equal((await fakeBb({copy: loose}).agent.compose("c2", "9", null)).projectId, null);
  assert.equal((await fakeBb({copy: loose, config: {fallbackProject: "proj_fallback", model: ""}}).agent.compose("c2", "9", null)).projectId, "proj_fallback");
});
