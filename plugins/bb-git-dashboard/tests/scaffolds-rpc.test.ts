import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { scaffoldHandlers } from "../src/adapters/bb/scaffold-rpc.ts";

const client = {experimental_caller: {kind: "client"}};
const request = {hostId: "host-1", key: "builtin:python-service-uv", values: {name: "notes"}, category: "", ciForge: "github" as const,
  author: {name: "Stand Author", email: "author@example.invalid"}, repository: null};

/** A server with one machine; `answer` is what the host's scaffoldCreate returns, or throws for a lost answer. */
function server(answer: () => Promise<unknown>, more: {publish?: () => Promise<unknown>; create?: () => Promise<unknown>} = {}) {
  const calls: {name: string; input: unknown}[] = [];
  const created: unknown[] = [];
  const linked: unknown[] = [];
  const saved: unknown[] = [];
  let root = "~/projects";
  const bb = {
    settings: {define: () => ({get: async () => ({scaffolds: "", scaffoldsFolder: ""})})},
    hosts: {experimental_client: () => ({call: async (name: string, input: unknown) => {
      calls.push({name, input});
      return name === "scaffoldPublish" ? (more.publish ?? (async () => ({ok: true})))() : answer();
    }})},
    onDispose: () => {},
    realtime: {publish: () => {}},
  } as unknown as BbPluginApi;
  const handlers = scaffoldHandlers(bb, {rules: async () => ({root}), saveCopy: async (...args) => { saved.push(args); return {id: "copy-1"} as never; },
    accounts: async () => [account],
    api: async () => ({account, api: {createRepository: async (spec: unknown) => { created.push(spec); return (more.create ?? (async () => repo))(); }} as never}),
    link: async (_copy, accountId, path) => { linked.push([accountId, path]); }});
  return {handlers, calls, saved, created, linked, setRoot: (value: string) => { root = value; }};
}
const account = {kind: "gitea" as const, id: "acc-1", label: "Stand", origin: "https://git.example.org", organization: "", username: "octo"};
const repo = {id: "9", accountId: "acc-1", project: "octo", name: "notes", path: "octo/notes", clone: "https://git.example.org/octo/notes.git", branch: "main", canPush: true};
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
  assert.deepEqual(created, {ok: true, copyId: "copy-1", root: "/home/owner/projects/notes", repository: null, notes: []});
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

test("a repository asked for is private unless public is chosen and spelled out, then made, linked and pushed after the project", async () => {
  const {handlers, calls, created, linked} = server(made);
  const pub = await handlers.scaffoldPrepare({...request, repository: {accountId: "acc-1", owner: null, visibility: "public"}}, client);
  assert.ok(pub.ok);
  if (!pub.ok) return;
  assert.equal(pub.preview.lines.at(-1), "New repository · Stand (gitea) · octo/notes · PUBLIC: anyone can read it · main pushed with the account's credential from the Keychain");
  const priv = await handlers.scaffoldPrepare({...request, values: {name: "notes", description: "Notes"}, repository: {accountId: "acc-1", owner: "team", visibility: "private"}}, client);
  assert.ok(priv.ok);
  if (!priv.ok) return;
  const done = await handlers.scaffoldCreate({previewId: priv.preview.id}, client);
  assert.deepEqual(done, {ok: true, copyId: "copy-1", root: "/home/owner/projects/notes", repository: {path: "octo/notes", pushed: true}, notes: []});
  assert.deepEqual(created, [{owner: "team", name: "notes", description: "Notes", visibility: "private"}]);
  assert.deepEqual(linked, [["acc-1", "octo/notes"]]);
  assert.deepEqual(calls.map(call => call.name), ["scaffoldCreate", "scaffoldPublish"]);
  assert.deepEqual(calls[1]!.input, {root: "/home/owner/projects/notes", identity: "a".repeat(64), clone: "https://git.example.org/octo/notes.git", username: "octo"});
  const bad = await handlers.scaffoldPrepare({...request, repository: {accountId: "acc-1", owner: "a/b", visibility: "private"}}, client);
  assert.equal(bad.ok ? "ok" : bad.code, "INVALID_INPUT");
});

test("a push that does not go through, or a repository that is not created, leaves the project and says what is left", async () => {
  const pushFails = server(made, {publish: async () => ({ok: false, code: "GIT_REJECTED", next: ""})});
  const one = await pushFails.handlers.scaffoldPrepare({...request, repository: {accountId: "acc-1", owner: null, visibility: "private"}}, client);
  assert.ok(one.ok);
  if (!one.ok) return;
  const pushed = await pushFails.handlers.scaffoldCreate({previewId: one.preview.id}, client);
  assert.ok(pushed.ok);
  if (!pushed.ok) return;
  assert.deepEqual(pushed.repository, {path: "octo/notes", pushed: false});
  assert.match(pushed.notes[0] ?? "", /created empty: main was not pushed \(GIT_REJECTED\)/);
  const createFails = server(made, {create: async () => { throw new Error("PROVIDER_DENIED"); }});
  const two = await createFails.handlers.scaffoldPrepare({...request, repository: {accountId: "acc-1", owner: null, visibility: "private"}}, client);
  assert.ok(two.ok);
  if (!two.ok) return;
  const notMade = await createFails.handlers.scaffoldCreate({previewId: two.preview.id}, client);
  assert.ok(notMade.ok);
  if (!notMade.ok) return;
  assert.equal(notMade.repository, null);
  assert.match(notMade.notes[0] ?? "", /repository was not created \(PROVIDER_DENIED\)/);
  assert.deepEqual(createFails.calls.map(call => call.name), ["scaffoldCreate"]);
});
