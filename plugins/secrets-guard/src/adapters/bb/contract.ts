// The plugin's RPC surface: three methods, input checked at the boundary.
// Shared by the server entry and the app bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
