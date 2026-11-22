import { z } from "zod";
import { actionSchema, placementSchema } from "./ownership.ts";

export const CHANNEL = "window-placement";
const credential = z.uuid();
export const threadIdSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);
export const snapshotSchema = z.strictObject({
  instanceId: z.string(),
  windows: z.array(z.string()),
  placements: z.array(z.strictObject({ threadId: threadIdSchema, placement: placementSchema })),
});
export type WindowSnapshot = z.infer<typeof snapshotSchema>;
export const windowSchemas = {
  window_sync: { input: z.strictObject({ credential, close: z.boolean().default(false), suspended: z.boolean().optional() }), output: snapshotSchema },
  window_change: {
    input: z.strictObject({
      credential,
      provider: z.literal("bb-thread"),
      threadId: threadIdSchema,
      generation: z.int().nonnegative(),
      command: actionSchema,
    }),
    output: snapshotSchema,
  },
};
