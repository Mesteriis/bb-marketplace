import { z } from "zod";

export const readRenderer = "telegram-read-review";
export const maxReadMessages = 5;
export const readMessageLimit = z.number().int().min(1).max(maxReadMessages);
export const readPayload = z.object({
  requestId: z.uuid(),
  source: z.string().optional(),
  maxMessages: readMessageLimit.optional(),
  notes: z.array(z.object({ id: z.string(), time: z.string() })).max(maxReadMessages),
});
export const readChoice = z.object({
  id: z.string(),
  authorConsent: z.literal(true),
}).strict();

export const readBatchChoice = z.object({
  entries: z.array(readChoice).min(1).max(maxReadMessages)
    .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length),
}).strict();
export type ReadDecision = z.infer<typeof readChoice> | z.infer<typeof readBatchChoice>;
