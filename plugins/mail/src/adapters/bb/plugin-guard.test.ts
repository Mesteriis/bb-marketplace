import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { PLUGIN_CALLER_MESSAGE } from "../../core/plugin-api.ts";
import { refuse } from "./bb-rpc.ts";
import { guardHandlers } from "./plugin-guard.ts";

type Context = ExperimentalPluginRpcHandlerContext;
/** A handler as the server registers it: the input, then the call's context. */
const handler = <I, O>(run: (input: I) => O) => vi.fn((input: I, _context: Context) => run(input));
const signal = new AbortController().signal;
const plugin = { experimental_caller: { kind: "plugin", pluginId: "calendar" }, experimental_signal: signal } as const;
const client = { experimental_caller: { kind: "client" }, experimental_signal: signal } as const;

describe("guardHandlers", () => {
  it("refuses a plugin caller on a method outside the API list, read or write", async () => {
    const read = handler(async () => "rows");
    const write = handler(async () => "done");
    const refused: string[] = [];
    const guarded = guardHandlers(
      { threads_list: read, message_action: write },
      { api: new Set(), check: () => {}, onRefused: (pluginId, method) => refused.push(`${pluginId}:${method}`) },
    );
    await expect(guarded.threads_list({} as never, plugin)).rejects.toMatchObject({ code: "forbidden", message: PLUGIN_CALLER_MESSAGE });
    await expect(guarded.message_action({} as never, plugin)).rejects.toMatchObject({ code: "forbidden" });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(refused).toEqual(["calendar:threads_list", "calendar:message_action"]);
  });

  it("reports a refused plugin once an hour per method, however often it retries", async () => {
    let now = 1_000_000;
    const refused: string[] = [];
    const guarded = guardHandlers(
      { threads_list: handler(async () => "rows"), message_action: handler(async () => "done") },
      { api: new Set(), check: () => {}, onRefused: (pluginId, method) => refused.push(`${pluginId}:${method}`), clockMs: () => now },
    );
    for (let i = 0; i < 50; i++) await expect(guarded.threads_list({} as never, plugin)).rejects.toMatchObject({ code: "forbidden" });
    await expect(guarded.message_action({} as never, plugin)).rejects.toMatchObject({ code: "forbidden" });
    expect(refused).toEqual(["calendar:threads_list", "calendar:message_action"]);
    now += 3_600_000;
    await expect(guarded.threads_list({} as never, plugin)).rejects.toMatchObject({ code: "forbidden" });
    expect(refused).toEqual(["calendar:threads_list", "calendar:message_action", "calendar:threads_list"]);
  });

  it("lets a client caller through unchanged", async () => {
    const guarded = guardHandlers(
      { threads_list: handler(async () => "rows"), sync_now: handler(() => "sync") },
      {
        api: new Set(),
        check: () => {
          throw new Error("not for clients");
        },
      },
    );
    expect(await guarded.threads_list({} as never, client)).toBe("rows");
    expect(await guarded.sync_now({} as never, client)).toBe("sync");
  });

  it("on an API method runs the check with the plugin id before the handler", async () => {
    const seen: string[] = [];
    const guarded = guardHandlers(
      {
        plugin_accounts_list: handler(async (input: { a: number }) => {
          seen.push(`handler:${input.a}`);
          return [];
        }),
      },
      {
        api: new Set(["plugin_accounts_list"]),
        check: (pluginId, method, input) => {
          seen.push(`${pluginId}:${method}:${JSON.stringify(input)}`);
        },
      },
    );
    await guarded.plugin_accounts_list({ a: 1 }, plugin);
    expect(seen).toEqual(['calendar:plugin_accounts_list:{"a":1}', "handler:1"]);
  });

  it("a check that throws keeps the handler from running", async () => {
    const run = handler(async () => []);
    const guarded = guardHandlers(
      { plugin_accounts_list: run },
      {
        api: new Set(["plugin_accounts_list"]),
        check: () => {
          throw refuse("forbidden", "no right");
        },
      },
    );
    await expect(guarded.plugin_accounts_list({} as never, plugin)).rejects.toMatchObject({ code: "forbidden", message: "no right" });
    expect(run).not.toHaveBeenCalled();
  });
});
