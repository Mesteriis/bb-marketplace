import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { remoteService } from "../src/adapters/bb/remote-service.ts";

const token = "fixture-token-value-0123456789";
// Precomputed from the token alone, as literals: none of them may be kept outside the secret settings.
const derived = [
  "d6cdd6c3acf28cde0a35bc17281f50b3e907e7c9d5a3d065eb1050821fc33e7d", // sha256 hex
  "3c96a0425245a49e66c08ca46675b9ea3a100cc0", // sha1 hex
  "38724c22acc0bdf0a5948a13e6f0d76391ef684d5751077285881f2a939fe8eaf2ab01a6e3f3eaa29925942a2f200378e3859f284e026b9d72e42595240d0fc5", // sha512 hex
  "0c55f393e9476dff5f19c8f552110ddf", // md5 hex
  "Zml4dHVyZS10b2tlbi12YWx1ZS0wMTIzNDU2Nzg5", // base64
  "OmZpeHR1cmUtdG9rZW4tdmFsdWUtMDEyMzQ1Njc4OQ==", // base64 of ":token", the Basic header
];
const account = {kind: "gitea" as const, id: "acc-1", label: "Home", origin: "https://git.example.org", organization: "", username: "me"};

/** The plugin's services over an in-memory BB: settings with change listeners, kv, no Vault, no hosts. */
function stand() {
  const values: Record<string, unknown> = {accounts: JSON.stringify([account]), tokens: JSON.stringify({"acc-1": token})};
  const listeners: ((next: unknown, prev: unknown) => void)[] = [];
  const kv = new Map<string, unknown>();
  const bb = {
    settings: {define: () => ({
      get: async () => ({...values}),
      experimental_set: async (change: Record<string, unknown>) => {
        const prev = {...values}; Object.assign(values, change);
        for (const listener of listeners) listener({...values}, prev);
        return {...values};
      },
      onChange: (listener: (next: unknown, prev: unknown) => void) => { listeners.push(listener); },
    })},
    storage: {kv: {get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, structuredClone(value)); },
      delete: async (key: string) => { kv.delete(key); }, list: async (prefix = "") => [...kv.keys()].filter(key => key.startsWith(prefix))}},
    sdk: {plugins: {list: async () => ({plugins: []}), callRpc: async () => { throw new Error("no vault"); }}},
    hosts: {experimental_client: () => ({call: async () => { throw new Error("no host"); }})},
    onDispose: () => {},
    realtime: {publish: () => {}},
    background: {service: () => {}},
  } as unknown as BbPluginApi;
  const service = remoteService(bb, async () => undefined, async () => { throw new Error("unused"); }, async () => false);
  return {service, kv, values, set: (change: Record<string, unknown>) => (bb.settings.define({}) as unknown as {experimental_set(v: unknown): Promise<unknown>}).experimental_set(change)};
}
const gitea: typeof fetch = async input => {
  const url = String(input);
  return url.endsWith("/api/v1/user") ? Response.json({login: "me"}) : url.endsWith("/api/v1/version") ? Response.json({version: "1.25.3"})
    : Response.json([{id: 1, name: "notes", full_name: "me/notes", clone_url: "https://git.example.org/me/notes.git", permissions: {push: true}}]);
};

test("a kept account check holds the result and the account, and nothing that the token alone gives", async t => {
  t.mock.method(globalThis, "fetch", gitea);
  const {service, kv} = stand();
  const checked = await service.accountCheck({accountId: "acc-1", refresh: true});
  assert.ok(checked.ok && checked.value?.ok);
  assert.ok(kv.has("account-check/acc-1"));
  const stored = JSON.stringify([...kv]);
  assert.ok(!stored.includes(token), "the token is not kept");
  for (const value of derived) assert.ok(!stored.toLowerCase().includes(value.toLowerCase()), "kept: " + value);
  // And it is shown again while nothing changed.
  const kept = await service.accountCheck({accountId: "acc-1", refresh: false});
  assert.ok(kept.ok);
  assert.equal(kept.ok && kept.value?.ok && kept.value.login, "me");
});

test("a kept check is not shown once the account's token changes in the plugin's settings, or the account itself does", async t => {
  t.mock.method(globalThis, "fetch", gitea);
  const {service, kv, set} = stand();
  await service.accountCheck({accountId: "acc-1", refresh: true});
  await set({tokens: JSON.stringify({"acc-1": "fixture-token-value-rotated-0001"})});
  assert.ok(!kv.has("account-check/acc-1"));
  const after = await service.accountCheck({accountId: "acc-1", refresh: false});
  assert.deepEqual(after, {ok: true, value: null});
  // Another account's token changing leaves this one's check.
  await service.accountCheck({accountId: "acc-1", refresh: true});
  await set({tokens: JSON.stringify({"acc-1": "fixture-token-value-rotated-0001", "acc-2": "fixture-other-token-0002"})});
  assert.ok(kv.has("account-check/acc-1"));
  // A changed declaration (here its label) is not the account that was checked.
  await set({accounts: JSON.stringify([{...account, label: "Renamed"}])});
  assert.deepEqual(await service.accountCheck({accountId: "acc-1", refresh: false}), {ok: true, value: null});
});
