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
  if (path.endsWith("/actions/runs/9/jobs")) return Response.json({jobs: [{id: 77, name: "test (2)", status: "completed", conclusion: "failure", steps: []}]});
  if (path.endsWith("/actions/jobs/77/logs")) return new Response("setup\nassert failed: src/greeting.txt:2\n##[error]Process completed with exit code 1.\npost\n");
  return new Response("{}", {status: 404});
}) as typeof fetch;

function fakeBb() {
  const store = new Map<string, unknown>();
  const spawned: {prompt: string; title: string; environment: unknown}[] = [];
  const messages: {threadId: string; text: string}[] = [];
  const bb = {
    storage: {kv: {get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); }, list: async (prefix: string) => [...store.keys()].filter(key => key.startsWith(prefix))}},
    background: {service: () => {}},
    sdk: {threads: {
      spawn: async (args: {prompt: string; title: string; environment: unknown}) => { spawned.push(args); return {id: "thr_new"}; },
      send: async (args: {threadId: string; input: {text: string}[]}) => {
        if (args.threadId === "thr_gone") throw new Error("NOT_FOUND");
        messages.push({threadId: args.threadId, text: args.input[0].text});
        return {};
      },
      list: async () => [{id: "thr_a", title: "Fix CI"}],
    }},
  } as unknown as BbPluginApi;
  const service = ciService({copy: async () => copy, send,
    linked: async () => ({account: {kind: "github", id: "a", label: "A", origin: "https://github.com", organization: "", username: "octo"}, token: "fixture-token-value",
      repo: {id: "1", accountId: "a", project: "octo", name: "sandbox", path: "octo/sandbox", clone: "https://github.com/octo/sandbox.git", branch: "main", canPush: true}})});
  return {agent: ciAgent(bb, service, () => {}), spawned, messages};
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
  assert.deepEqual(await agent.threads("c1"), {threads: [{id: "thr_a", title: "Fix CI"}], subscribed: ["thr_a"]});
  await agent.subscribe("c1", []);
  assert.deepEqual((await agent.threads("c1")).subscribed, []);
});
