import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { scaffoldHandlers } from "../src/adapters/bb/scaffold-rpc.ts";

const client = {experimental_caller: {kind: "client"}};
const request = {hostId: "host-1", key: "builtin:python-service-uv", values: {name: "notes"}, category: "", ciForge: "github" as const,
  author: {name: "Stand Author", email: "author@example.invalid"}};

/** A server with one machine; `answer` is what the host's scaffoldCreate returns, or throws for a lost answer. */
function server(answer: () => Promise<unknown>) {
  const calls: {name: string; input: unknown}[] = [];
  const saved: unknown[] = [];
  let root = "~/projects";
  const bb = {
    settings: {define: () => ({get: async () => ({scaffolds: "", scaffoldsFolder: ""})})},
    hosts: {experimental_client: () => ({call: async (name: string, input: unknown) => { calls.push({name, input}); return answer(); }})},
    onDispose: () => {},
    realtime: {publish: () => {}},
  } as unknown as BbPluginApi;
  const handlers = scaffoldHandlers(bb, {rules: async () => ({root}), saveCopy: async (...args) => { saved.push(args); return {id: "copy-1"} as never; }});
  return {handlers, calls, saved, setRoot: (value: string) => { root = value; }};
}
const made = async () => ({ok: true, root: "/home/owner/projects/notes", identity: "a".repeat(64), repositoryName: "notes"});

test("only the app may ask; a preview names the place and files, and the project is made once and attached", async () => {
  const {handlers, calls, saved} = server(made);
  assert.equal((await handlers.scaffoldPrepare(request, {experimental_caller: {kind: "agent"}})).ok, false);
  const prepared = await handlers.scaffoldPrepare(request, client);
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  assert.deepEqual(prepared.preview.lines.slice(1, 3), ["host-1 · ~/projects/notes", "CI · .github/workflows/ci.yml (python-github)"]);
  assert.ok(prepared.preview.files.some(file => file.path === "pyproject.toml"));
  assert.equal(calls.length, 0);
  const created = await handlers.scaffoldCreate({previewId: prepared.preview.id}, client);
  assert.deepEqual(created, {ok: true, copyId: "copy-1", root: "/home/owner/projects/notes"});
  assert.equal(calls.length, 1);
  const call: {name: string; input: unknown} | undefined = calls[0];
  assert.equal((call?.input as {name: string} | undefined)?.name, "notes");
  assert.deepEqual(saved, [["host-1", "/home/owner/projects/notes", "a".repeat(64), {repositoryName: "notes"}]]);
  // A preview is used once.
  const again = await handlers.scaffoldCreate({previewId: prepared.preview.id}, client);
  assert.equal(again.ok ? "ok" : again.code, "PREVIEW_EXPIRED");
});

test("a projects folder changed since the preview expires it; a new preview of the same place replaces the old", async () => {
  const {handlers, calls, setRoot} = server(made);
  const first = await handlers.scaffoldPrepare(request, client);
  const second = await handlers.scaffoldPrepare(request, client);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  const replaced = await handlers.scaffoldCreate({previewId: first.preview.id}, client);
  assert.equal(replaced.ok ? "ok" : replaced.code, "PREVIEW_EXPIRED");
  setRoot("~/elsewhere");
  const moved = await handlers.scaffoldCreate({previewId: second.preview.id}, client);
  assert.equal(moved.ok ? "ok" : moved.code, "PREVIEW_EXPIRED");
  assert.equal(calls.length, 0);
});

test("a lost answer from the machine says where the project may be", async () => {
  const {handlers} = server(async () => { throw new Error("timeout"); });
  const prepared = await handlers.scaffoldPrepare(request, client);
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  const lost = await handlers.scaffoldCreate({previewId: prepared.preview.id}, client);
  assert.ok(!lost.ok);
  if (lost.ok) return;
  assert.equal(lost.code, "OUTCOME_UNKNOWN");
  assert.match(lost.detail ?? "", /may have been made at ~\/projects\/notes/);
});
