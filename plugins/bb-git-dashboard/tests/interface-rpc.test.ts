import test from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { interfaceHandlers } from "../src/adapters/bb/interface-rpc.ts";

test("the language switch writes the setting for the app only", async () => {
  const written: unknown[] = [];
  let declared: Record<string, {options?: string[]; default?: unknown}> = {};
  const bb = {settings: {define: (descriptors: typeof declared) => {
    declared = descriptors;
    return {experimental_set: async (values: unknown) => { written.push(values); return values; }};
  }}} as unknown as BbPluginApi;
  const handlers = interfaceHandlers(bb);
  assert.deepEqual(declared.uiLanguage?.options, ["auto", "ru", "en"]);
  assert.equal(declared.uiLanguage?.default, "auto");
  assert.deepEqual(await handlers.interfaceSet({uiLanguage: "ru"}, {experimental_caller: {kind: "agent"}}), {ok: false, code: "ACCESS_DENIED",
    next: "Grant access in Git Workspace for this thread and worktree."});
  assert.deepEqual(written, []);
  assert.deepEqual(await handlers.interfaceSet({uiLanguage: "ru"}, {experimental_caller: {kind: "client"}}), {ok: true});
  assert.deepEqual(written, [{uiLanguage: "ru"}]);
});
