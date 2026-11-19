// One gate for calls from other plugins' servers (bb.sdk.plugins.callRpc;
// the host verifies that caller). A plugin reaches a handler only when the
// method is in the plugin API, and then only past the grant check. A client
// caller passes untouched: BB does not tell the owner's page from another
// plugin's page, so this governs server-side calls and nothing more.
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";

import { PLUGIN_CALLER_MESSAGE } from "../../core/plugin-api.ts";
import { refuse } from "./bb-rpc.ts";

/** Throws a refusal when the plugin may not make this call. */
export type PluginCheck = (pluginId: string, method: string, input: unknown) => void;

export type GuardOptions = {
  api: ReadonlySet<string>;
  check: PluginCheck;
  /** A plugin refused on a method outside the API: its id and the method, nothing else. */
  onRefused?: (pluginId: string, method: string) => void;
};

type Handler = (input: never, context: ExperimentalPluginRpcHandlerContext) => unknown;

export function guardHandlers<H extends Record<string, Handler>>(handlers: H, opts: GuardOptions): H {
  const guarded: Record<string, Handler> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    guarded[method] = async (input, context) => {
      const caller = context.experimental_caller;
      if (caller.kind === "plugin") {
        if (!opts.api.has(method)) {
          opts.onRefused?.(caller.pluginId, method);
          throw refuse("forbidden", PLUGIN_CALLER_MESSAGE);
        }
        opts.check(caller.pluginId, method, input);
      }
      return handler(input, context);
    };
  }
  return guarded as H;
}
