// The RPC contract between the Mail page and the server, as plain zod
// schemas. server.ts wraps it with the SDK's defineRpcContract.
import { z } from "zod";
import {
  accountSchema,
  messageBodySchema,
  messageSummarySchema,
  newAccountInputSchema,
  statusViewSchema,
  threadDetailSchema,
  threadSummarySchema,
} from "./model.ts";

export const rpcSchemas = {
  status_get: {
    input: z.null(),
    output: statusViewSchema,
  },
  accounts_test: {
    input: newAccountInputSchema,
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
  accounts_add: {
    input: newAccountInputSchema,
    output: accountSchema,
  },
  accounts_remove: {
    input: z.object({ accountId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  sync_now: {
    input: z.object({ accountId: z.string().nullable() }),
    output: z.object({ started: z.boolean() }),
  },
  threads_list: {
    input: z.object({
      accountId: z.string(),
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(100),
    }),
    output: z.object({
      threads: z.array(threadSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  },
  thread_get: {
    input: z.object({ threadId: z.string() }),
    output: threadDetailSchema,
  },
  message_body: {
    input: z.object({ messageId: z.string() }),
    output: messageBodySchema,
  },
  /** One message as agent text (untrusted notice first); never marks it read. */
  message_agent_text: {
    input: z.object({ messageId: z.string() }),
    output: z.object({ text: z.string() }),
  },
  message_open: {
    input: z.object({ messageId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  search: {
    input: z.object({
      query: z.string().min(1).max(500),
      accountId: z.string().nullable(),
      limit: z.number().int().min(1).max(50),
    }),
    output: z.object({ hits: z.array(messageSummarySchema) }),
  },
} as const;

/** Realtime channel the server publishes on when stored mail changes. */
export const MAIL_CHANGED_CHANNEL = "mail-changed";

/** Payload on MAIL_CHANGED_CHANNEL: the account whose mail changed, if known. */
export type MailChangedPayload = { accountId: string | null };
