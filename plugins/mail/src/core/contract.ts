// The RPC contract between the Mail page and the server, as plain zod
// schemas. server.ts wraps it with the SDK's defineRpcContract.
import { z } from "zod";
import { composeDocInputSchema } from "./compose-doc.ts";
import {
  accountSchema,
  composeAttachmentSchema,
  draftViewSchema,
  hostInputSchema,
  mailAddressSchema,
  noLineBreaks,
  outboxRowSchema,
  smtpSecuritySchema,
  type OutboxState,
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

const NO_LINE_BREAKS = { message: "Line breaks are not allowed" };
/** An address for a header: also free of CR, LF and NUL. */
const headerAddressInput = addressInput.refine(noLineBreaks, NO_LINE_BREAKS);
/** Recipients per field (To, Cc or Bcc). */
const recipientList = z.array(headerAddressInput).max(100);
/** Largest attachment the composer takes, and the cap on one message's attachments. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest decoded attachment chunk, and its base64 length. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
const CHUNK_BASE64_MAX = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4;

const okOutput = z.object({ ok: z.boolean() });
const composeWarning = z.enum(["original_unavailable", "attachments_left_out", "original_kept"]).nullable();
const smtpSettingsInput = z.object({
  accountId: idInput,
  host: hostInputSchema,
  port: z.number().int().min(1).max(65535),
  security: smtpSecuritySchema,
  username: z.string().min(1).max(320).refine(noLineBreaks, NO_LINE_BREAKS).optional(),
});

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

  // ---- Compose and send (slice 3b). Owner only: every handler refuses
  // plugin callers, none is discoverable, none is a tool, CLI or mention. ----

  /** A new, empty draft from the account. */
  compose_new: {
    input: z.object({ accountId: idInput }),
    output: z.object({ draftId: z.string() }),
  },
  /** A reply, reply-all or forward draft of a stored message. */
  compose_prepare: {
    input: z.object({ kind: z.enum(["reply", "reply_all", "forward"]), messageId: idInput }),
    output: z.object({
      draftId: z.string(),
      warning: composeWarning,
      /** Stored addresses of the original that cannot be sent to, left out of the recipients. */
      dropped: z.array(z.string()).max(200),
    }),
  },
  /** One of our drafts, or a synced Drafts message to continue. */
  compose_open: {
    input: z.union([
      z.strictObject({ draftId: idInput }),
      z.strictObject({ draftMessageId: idInput }),
    ]),
    output: z.object({ draft: draftViewSchema, warning: composeWarning }),
  },
  /** Autosave. The page sends the document only, never HTML. */
  compose_save: {
    input: z.object({
      draftId: idInput,
      baseRevision: z.number().int().min(0),
      accountId: idInput,
      to: recipientList,
      cc: recipientList,
      bcc: recipientList,
      subject: z.string().max(998).refine(noLineBreaks, NO_LINE_BREAKS),
      doc: composeDocInputSchema,
      saveToServer: z.boolean().optional(),
      /** The editor's one-time load of `import`: not an edit (no revision bump, no server copy due). */
      imported: z.boolean().optional(),
    }),
    output: z.union([
      /** originalKept: the import lost content, so the continued foreign draft stays on the server. */
      z.object({ revision: z.number().int(), originalKept: z.literal(true).optional() }),
      z.object({ conflict: z.literal(true), revision: z.number().int() }),
    ]),
  },
  compose_discard: {
    input: z.object({ draftId: idInput }),
    output: okOutput,
  },
  compose_attachment_begin: {
    input: z.object({
      draftId: idInput,
      fileName: z.string().min(1).max(255).refine(noLineBreaks, NO_LINE_BREAKS),
      mimeType: z.string().min(1).max(127).refine(noLineBreaks, NO_LINE_BREAKS),
      size: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
    }),
    output: z.object({ uploadId: z.string() }),
  },
  compose_attachment_chunk: {
    input: z.object({
      uploadId: idInput,
      offset: z.number().int().min(0),
      dataBase64: z
        .string()
        .max(CHUNK_BASE64_MAX)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, { message: "Not base64" })
        .refine((data) => data.length % 4 === 0, { message: "Not base64" }),
    }),
    output: z.object({ received: z.number().int() }),
  },
  compose_attachment_finish: {
    input: z.object({ uploadId: idInput, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    output: composeAttachmentSchema,
  },
  compose_attachment_remove: {
    input: z.object({ draftId: idInput, attachmentId: idInput }),
    output: z.object({ removed: z.boolean() }),
  },
  /** Queues the saved draft; it leaves after the Undo window. */
  compose_send: {
    input: z.object({
      draftId: idInput,
      baseRevision: z.number().int().min(0),
      requestId: z.uuid(),
    }),
    output: z.object({ outboxId: z.string(), sendAfter: z.string() }),
  },
  outbox_list: {
    input: z.object({ accountId: idInput.nullable() }),
    output: z.object({ rows: z.array(outboxRowSchema) }),
  },
  /** Undo from queued, Edit from held or failed; deletes the row and hands back the draft. */
  outbox_cancel: {
    input: z.object({ id: idInput }),
    output: z.object({ cancelled: z.boolean(), draftId: z.string().nullable() }),
  },
  /** Held → queued with a fresh Undo window. */
  outbox_send_now: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** From failed or sent_no_copy only. */
  outbox_retry: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** From unknown only: the owner accepts a possible second copy. */
  outbox_resend: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** From failed, unknown or sent_no_copy; deletes the row and its draft. */
  outbox_dismiss: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** Addresses from stored mail; no network. */
  recipients_suggest: {
    input: z.object({ prefix: z.string().min(1).max(64).refine(noLineBreaks, NO_LINE_BREAKS) }),
    output: z.object({ suggestions: z.array(mailAddressSchema).max(10) }),
  },
  /** Tests SMTP with the account's stored password; the password is never sent back. */
  accounts_smtp_test: {
    input: smtpSettingsInput,
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
  /** Tests, then saves the account's SMTP settings. */
  accounts_smtp_set: {
    input: smtpSettingsInput,
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
} as const;

/** Realtime channel the server publishes on when stored mail changes. */
export const MAIL_CHANGED_CHANNEL = "mail-changed";

/** Payload on MAIL_CHANGED_CHANNEL: the account whose mail changed, if known. */
export type MailChangedPayload = { accountId: string | null };

/** Realtime channel the server publishes on when an outbox row changes. */
export const OUTBOX_CHANGED_CHANNEL = "outbox-changed";

/**
 * Payload on OUTBOX_CHANGED_CHANNEL: ids and the state only. `done` and
 * `cancelled` appear only here: a done row is deleted (sent), a cancelled
 * one was removed without sending (Undo, or Discard of an unknown send).
 */
export type OutboxChangedPayload = {
  accountId: string;
  id: string;
  state: OutboxState | "cancelled";
};
