// The RPC contract between the Mail page and the server, as plain zod
// schemas. server.ts wraps it with the SDK's defineRpcContract.
import { z } from "zod";
import {
  accountSchema,
  folderSchema,
  messageActionSchema,
  messageBodySchema,
  messageSummarySchema,
  newAccountInputSchema,
  roleCountSchema,
  specialUseSchema,
  statusViewSchema,
  threadDetailSchema,
  threadSummarySchema,
} from "./model.ts";

/** An id, folder path or account id coming in from the page. */
const idInput = z.string().min(1).max(256);
/** An email address coming in from the page. */
const addressInput = z.string().min(3).max(320);

/** One account's folder, or a role merged across every account. */
const threadScope = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("account"),
    accountId: idInput,
    /** Folder path; the UI passes the account's inbox path by default. */
    folder: idInput,
  }),
  z.object({ kind: z.literal("all"), role: specialUseSchema }),
]);

/** The result of one (account, source folder) group of a message_action batch. */
const actionGroupSchema = z.object({
  accountId: z.string(),
  folder: z.string(),
  queued: z.number().int().min(0),
  /** The destination folder's name for a move; null for a flag change or a refusal. */
  destination: z.string().nullable(),
  /** Why nothing was done for this group, or null. */
  error: z.string().nullable(),
});

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
      scope: threadScope,
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(100),
    }),
    output: z.object({
      threads: z.array(threadSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  },
  thread_get: {
    input: z.object({
      threadId: z.string(),
      /** The folder being viewed: each message shows its copy there when it has one. */
      folder: idInput,
    }),
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
  /** One account's folders, or (null) every account's with the merged roles. */
  folders_list: {
    input: z.object({ accountId: idInput.nullable() }),
    output: z.object({
      folders: z.array(folderSchema),
      /** Filled only when `accountId` is null. */
      roles: z.array(roleCountSchema),
    }),
  },
  /**
   * Owner-clicked or hotkeyed actions only; never exposed to agents, mentions
   * or CLI. The source is `folder` (the folder being viewed) or, in All
   * accounts, each message's copy in a folder of `role`; the server groups
   * the ids by account and source folder and reports each group.
   * `destination` (a folder path of the same account) goes with `move` only.
   */
  message_action: {
    input: z
      .object({
        messageIds: z.array(idInput).min(1).max(200),
        action: messageActionSchema,
        folder: idInput.optional(),
        role: specialUseSchema.optional(),
        destination: idInput.optional(),
      })
      .refine((input) => (input.folder === undefined) !== (input.role === undefined), {
        message: "Give exactly one of folder and role",
      })
      .refine((input) => (input.action === "move") === (input.destination !== undefined), {
        message: "A destination goes with move, and only with move",
      }),
    output: z.object({ groups: z.array(actionGroupSchema) }),
  },
  /** Raw headers and MIME structure of one message; never marks it read. */
  message_source: {
    input: z.object({ messageId: idInput }),
    output: z.object({
      headers: z.array(z.tuple([z.string(), z.string()])),
      structure: z.array(z.string()),
      size: z.number().int(),
      uid: z.number().int(),
      folder: z.string(),
      accountEmail: z.string(),
    }),
  },
  /**
   * A one-time, short-lived URL for downloading an attachment or the whole
   * message as .eml; never marks it read. Owner only, like the other writes.
   */
  download_ticket: {
    input: z
      .object({
        kind: z.enum(["attachment", "eml"]),
        messageId: idInput,
        partId: idInput.optional(),
      })
      .refine((input) => (input.kind === "attachment") === (input.partId !== undefined), {
        message: "A partId goes with an attachment, and only with one",
      }),
    output: z.object({ url: z.string(), fileName: z.string() }),
  },
  /** Allows remote images from the message's sender. */
  images_allow_sender: {
    input: z.object({ messageId: idInput }),
    output: z.object({ address: z.string() }),
  },
  images_disallow_sender: {
    input: z.object({ accountId: idInput, address: addressInput }),
    output: z.object({ removed: z.boolean() }),
  },
} as const;

/** Realtime channel the server publishes on when stored mail changes. */
export const MAIL_CHANGED_CHANNEL = "mail-changed";

/** Payload on MAIL_CHANGED_CHANNEL: the account whose mail changed, if known. */
export type MailChangedPayload = { accountId: string | null };
