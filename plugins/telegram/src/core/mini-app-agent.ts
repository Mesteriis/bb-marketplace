import { z } from "zod";

export const miniAppAgentMode = z.enum(["view", "navigate"]);
export const miniAppAgentEvent = z.enum(["granted", "revoked", "viewed", "back", "backUnavailable"]);
export const miniAppAgentSnapshot = z.object({
  label: z.string().trim().min(1).max(256),
  ready: z.boolean(),
  back: z.boolean(),
  settings: z.boolean(),
});
export const miniAppAgentState = z.object({
  grant: z.object({ threadId: z.string(), mode: miniAppAgentMode }).nullable(),
  events: z.array(z.object({ id: z.number(), at: z.number(), action: miniAppAgentEvent })),
  command: z.number().optional(),
});

export type MiniAppAgentMode = z.infer<typeof miniAppAgentMode>;
export type MiniAppAgentState = z.infer<typeof miniAppAgentState>;
export type MiniAppAgentSnapshot = z.infer<typeof miniAppAgentSnapshot>;
