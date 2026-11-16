import { z } from "zod";
import { forumTopicTarget } from "./contract.ts";

export const approvalRenderer = "telegram-send-review";
export const draftSchema = z.object({ text: z.string().trim().min(1).max(4096) });
const recipientSchema = z.object({ id: z.string(), name: z.string(), kind: z.string(), sender: z.string().optional(), archived: z.literal(true).optional() });
export const approvalSchema = draftSchema.extend({
  showRecipientId: z.boolean().optional(),
  replyPreview: z.string().max(8192).optional(),
  forumTopic: forumTopicTarget.optional(),
  recipients: z.array(recipientSchema).max(40),
});
export const decisionSchema = z.object({ id: z.string() }).strict();
