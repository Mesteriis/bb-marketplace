import assert from "node:assert/strict";
import { test } from "node:test";
import { client } from "../src/adapters/bb/provider-http.ts";
import { failureFor } from "../src/core/workspace.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "me"};
// Each call gets a fresh response: a cloned one cannot be cancelled while its twin is unread.
function forge(answers: (() => Response)[]) {
  let calls = 0;
  const send = (async () => answers[Math.min(calls++, answers.length - 1)]()) as typeof fetch;
  const waits: number[] = [];
  return {send, waits, sleep: async (ms: number) => { waits.push(ms); }, calls: () => calls};
}
const now = Date.parse("2026-11-27T12:00:00Z");

test("a read retried after 429 and 5xx, waiting as the forge asks, within a few seconds", async () => {
  const limited = forge([() => new Response("", {status: 429, headers: {"retry-after": "1"}}), () => new Response("", {status: 503}), () => Response.json({ok: true})]);
  const http = client(account, "fixture-token-value", limited.send, {sleep: limited.sleep, now: () => now});
  assert.deepEqual((await http("/api/v4/user")).payload, {ok: true});
  assert.deepEqual([limited.calls(), limited.waits], [3, [1000, 1000]]);
  // GitLab's RateLimit-Reset is a Unix time.
  const reset = forge([() => new Response("", {status: 429, headers: {"ratelimit-reset": String(now / 1000 + 2)}}), () => Response.json({ok: true})]);
  await client(account, "fixture-token-value", reset.send, {sleep: reset.sleep, now: () => now})("/api/v4/user");
  assert.deepEqual(reset.waits, [2000]);
});

test("a limit that lasts longer is reported as rate limited at once; lasting 5xx as unavailable", async () => {
  const long = forge([() => new Response("", {status: 429, headers: {"retry-after": "60"}})]);
  await assert.rejects(client(account, "fixture-token-value", long.send, {sleep: long.sleep, now: () => now})("/api/v4/user"), {message: "PROVIDER_RATE_LIMITED"});
  assert.deepEqual([long.calls(), long.waits], [1, []]);
  const down = forge([() => new Response("", {status: 502})]);
  await assert.rejects(client(account, "fixture-token-value", down.send, {sleep: down.sleep, now: () => now})("/api/v4/user"), {message: "PROVIDER_UNAVAILABLE"});
  assert.equal(down.calls(), 3);
});

test("writes are never repeated", async () => {
  const busy = forge([() => new Response("", {status: 429, headers: {"retry-after": "1"}})]);
  await assert.rejects(client(account, "fixture-token-value", busy.send, {sleep: busy.sleep, now: () => now})("/api/v4/x", {method: "POST", body: {}}), {message: "PROVIDER_RATE_LIMITED"});
  const failing = forge([() => new Response("", {status: 503})]);
  await assert.rejects(client(account, "fixture-token-value", failing.send, {sleep: failing.sleep, now: () => now})("/api/v4/x", {method: "POST", body: {}}), {message: "OUTCOME_UNKNOWN"});
  assert.deepEqual([busy.calls(), failing.calls()], [1, 1]);
});

test("stale heads and rate limits keep their own codes and advice", () => {
  assert.deepEqual([failureFor(new Error("STALE_HEAD"), "X").code, failureFor(new Error("PROVIDER_RATE_LIMITED"), "X").code], ["STALE_HEAD", "PROVIDER_RATE_LIMITED"]);
  assert.match(failureFor(new Error("STALE_HEAD"), "X").next, /changed since/);
  assert.match(failureFor(new Error("PROVIDER_RATE_LIMITED"), "X").next, /limit/);
});
