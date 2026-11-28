// The plugin's RPC surface: three methods, input checked at the boundary.
import { defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NotLocal, StoreUnavailable, type StoreUnavailableReason } from "../../core/ports.ts";

const threadId = z.string().min(1).max(200);
const scope = z.enum(["thread", "tree", "global"]);
/** The only terms there are; nothing opens the guard without one. */
const minutes = z.union([z.literal(10), z.literal(30), z.literal(60)]);

export const stateInput = z.strictObject({ threadId });
export const openInput = z.strictObject({ threadId, scope, minutes });
export const closeInput = z.strictObject({ threadId });

export const viewOutput = z.object({
  configured: z.boolean(),
  local: z.boolean(),
  effective: z
    .object({ scope, until: z.number(), rootThreadId: z.string().nullable() })
    .nullable(),
});

/** Every read of the guard carries this tag; every write through the plugin refreshes it. */
export const GUARD_TAG = "guard";

export const rpcContract = defineRpcContract({
  state: { input: stateInput, output: viewOutput, tags: () => [GUARD_TAG] },
  open: { input: openInput, output: viewOutput },
  close: { input: closeInput, output: viewOutput },
});

export const NOT_LOCAL_MESSAGE = "Охрана настраивается только на этом Mac";

const UNAVAILABLE_MESSAGES: Record<StoreUnavailableReason, string> = {
  not_configured: "Укажите файл отметки в настройках плагина",
  not_writable: "Файл отметки недоступен для записи",
  locked: "Файл отметки занят другой записью, повторите",
};

/** Expected refusals become RPC refusals; anything else stays an error. */
export function toRefusal(error: unknown): unknown {
  if (error instanceof StoreUnavailable) {
    return new experimental_PluginRpcRefusal({ code: "conflict", message: UNAVAILABLE_MESSAGES[error.reason] });
  }
  if (error instanceof NotLocal) {
    return new experimental_PluginRpcRefusal({ code: "forbidden", message: NOT_LOCAL_MESSAGE });
  }
  return error;
}
