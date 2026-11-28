import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

/**
 * The whole server over a BB that records every call: settings, storage, hosts and the SDK answer nothing useful, and
 * the registered handlers are kept to be called as an agent would.
 */
function server() {
  const touched: string[] = [];
  let handlers: Record<string, (input: unknown, context: unknown) => unknown> = {};
  const record = (path: string): unknown => new Proxy(function () {}, {
    get(_target, key) {
      if (key === "then") return undefined;
      if (typeof key === "symbol") return undefined;
      return record(path + "." + key);
    },
    apply(_target, _self, args) {
      touched.push(path);
      if (path === "bb.rpc.register") { handlers = args[1] as typeof handlers; return undefined; }
      if (path.endsWith(".get") || path.endsWith(".list") || path.endsWith(".call")) return Promise.resolve(undefined);
      if (path.endsWith(".set") || path.endsWith(".delete") || path.endsWith(".experimental_set")) return Promise.resolve(undefined);
      return record(path + "()");
    },
  });
  const bb = record("bb") as BbPluginApi;
  plugin(bb);
  return {handlers, touched};
}

test("an agent's call to check an account or to write settings is refused and reads or writes nothing", async () => {
  const {handlers, touched} = server();
  assert.equal(typeof handlers.accountCheck, "function");
  assert.equal(typeof handlers.settingsSet, "function");
  for (const kind of ["agent", "plugin", "cli"]) {
    touched.length = 0;
    const check = await handlers.accountCheck!({accountId: "acc-1", refresh: true}, {experimental_caller: {kind}}) as {ok: boolean; code?: string};
    const write = await handlers.settingsSet!({uiLanguage: "ru"}, {experimental_caller: {kind}}) as {ok: boolean; code?: string};
    assert.deepEqual([check.ok, check.code, write.ok, write.code], [false, "ACCESS_DENIED", false, "ACCESS_DENIED"], kind);
    assert.deepEqual(touched.filter(path => /storage|settings|hosts|sdk|fetch/.test(path)), [], kind);
  }
});
