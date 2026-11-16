// The RPC contract between the Mail page and the server, as plain zod
// schemas. server.ts wraps it with the SDK's defineRpcContract.
import { z } from "zod";
import { composeDocInputSchema } from "./compose-doc.ts";
import {
  accountSchema,
  composeAttachmentSchema,
  draftViewSchema,
  hostInputSchema,
  identityViewSchema,
  presendIssueSchema,
  mailAddressSchema,
  noLineBreaks,
  outboxRowSchema,
  proposalStateSchema,
  proposalViewSchema,
  smtpSecuritySchema,
  translateErrorKindSchema,
  translateGatewaySchema,
  translationViewSchema,
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
  blockKindSchema,
  blockRuleViewSchema,
  newMailItemSchema,
  threadFilterSchema,
  triageBatchStateSchema,
  triageViewSchema,
  unsubscribeInfoViewSchema,
} from "./model.ts";
import { languageTagSchema } from "./translate.ts";

/** An id, folder path or account id coming in from the page. */
const idInput = z.string().min(1).max(256);
/** An email address coming in from the page. */
const addressInput = z.string().min(3).max(320);

const NO_LINE_BREAKS = { message: "Line breaks are not allowed" };
/** An address for a header: also free of CR, LF and NUL (also the agent tool's recipients). */
export const headerAddressInput = addressInput.refine(noLineBreaks, NO_LINE_BREAKS);
/** Recipients per field (To, Cc or Bcc). */
const recipientList = z.array(headerAddressInput).max(100);
/** Largest attachment the composer takes, and the cap on one message's attachments. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest decoded attachment chunk, and its base64 length. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
const CHUNK_BASE64_MAX = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4;

const okOutput = z.object({ ok: z.boolean() });
const contentHashInput = z.string().regex(/^[0-9a-f]{64}$/);
/** A provider id or model id for the translation settings: bounded, one line, no NUL. */
const settingText = (max: number) => z.string().max(max).refine(noLineBreaks, NO_LINE_BREAKS);
const translateProviderSchema = z.object({ id: z.string(), displayName: z.string(), available: z.boolean() });
const translateModelSchema = z.object({ model: z.string(), displayName: z.string() });
const composeWarning = z.enum(["original_unavailable", "attachments_left_out", "original_kept"]).nullable();
const smtpSettingsInput = z.object({
  accountId: idInput,
  host: hostInputSchema,
  port: z.number().int().min(1).max(65535),
  security: smtpSecuritySchema,
  username: z.string().min(1).max(320).refine(noLineBreaks, NO_LINE_BREAKS).optional(),
  /**
   * The account password, typed for this call: required for a host outside
   * the account's domain and stored SMTP host (resolution 21). Never echoed.
   */
  password: z.string().min(1).max(1024).optional(),
});
const smtpTestOutput = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  /** This host needs the account password in the call. */
  signInRequired: z.literal(true).optional(),
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

/** A display name: one line, at most 200 characters. */
const displayNameInput = z.string().max(200).refine(noLineBreaks, NO_LINE_BREAKS);
/** A template name: one line, 1–80 characters (templates.ts TEMPLATE_NAME_MAX). */
const templateNameInput = z.string().min(1).max(80).refine(noLineBreaks, NO_LINE_BREAKS);
const identityKeyInput = z.object({ accountId: idInput, address: headerAddressInput });
/** Why an undo left messages where they are (core undo.ts). */
const undoSkipReasonSchema = z.enum(["moved_elsewhere", "gone", "folder_gone", "not_synced"]);

/** Messages of one owner batch (as message_action). */
const messageIdList = z.array(idInput).min(1).max(200);
/** A new-mail token: what the realtime signal carries. */
const newMailToken = z.string().min(1).max(64);

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
      /** Quick filters (slice 3e); absent: every thread. */
      filter: threadFilterSchema.optional(),
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
        /**
         * The page's id for one batch (its chunks share it): the server keeps
         * what the call queued as the one undoable action (slice 3d).
         */
        undoId: z.uuid().optional(),
      })
      .refine((input) => (input.folder === undefined) !== (input.role === undefined), {
        message: "Give exactly one of folder and role",
      })
      .refine((input) => (input.action === "move") === (input.destination !== undefined), {
        message: "A destination goes with move, and only with move",
      }),
    output: z.object({
      groups: z.array(actionGroupSchema),
      /** The call was recorded under its undoId (something was queued). */
      undoable: z.boolean(),
    }),
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
      /**
       * The identity to send from (slice 3d): null = the account's own
       * address; absent = unchanged (reset when the account changes).
       */
      fromAddress: headerAddressInput.nullable().optional(),
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
    output: smtpTestOutput,
  },
  /** Tests, then saves the account's SMTP settings. */
  accounts_smtp_set: {
    input: smtpSettingsInput,
    output: smtpTestOutput,
  },

  // ---- Agent proposals and translation (slice 3c). Owner only: every
  // handler refuses plugin callers, none is discoverable, none is a tool,
  // CLI or mention. ----

  /**
   * The card's content and a fresh view token (only the latest view's token
   * can submit). The hash is recomputed from the hidden draft first; a
   * mismatch answers `changed` with no content and no token.
   */
  proposal_view: {
    input: z.object({ proposalId: idInput, contentHash: contentHashInput }),
    output: z.union([
      z.object({ state: z.literal("ready"), view: proposalViewSchema, viewToken: z.string() }),
      z.object({ state: z.enum(["changed", "gone", "opened_elsewhere"]) }),
    ]),
  },
  /** Where a settled card stands, for its thread row. Ids and fixed reasons only. */
  proposal_status: {
    input: z.object({ proposalId: idInput }),
    output: z.object({
      state: proposalStateSchema,
      outboxId: z.string().nullable(),
      draftId: z.string().nullable(),
      reason: z.enum(["rate_limited", "too_large", "account", "changed"]).nullable(),
    }),
  },
  /** A cached translation, or a job to poll. Only the owner starts one. */
  translate_start: {
    input: z.object({ messageId: idInput, targetLanguage: languageTagSchema, force: z.boolean().optional() }),
    output: z.union([z.object({ cached: translationViewSchema }), z.object({ jobId: z.string() })]),
  },
  /** Text since `from` (characters already shown). The translation travels only here. */
  translate_poll: {
    input: z.object({ jobId: idInput, from: z.number().int().min(0) }),
    output: z.object({
      state: z.enum(["running", "done", "failed", "cancelled"]),
      text: z.string(),
      finish: z.enum(["complete", "max_tokens"]).optional(),
      truncatedInput: z.boolean().optional(),
      error: translateErrorKindSchema.optional(),
      /** makosh-ai's own refusal text, sanitized; only with pool_unavailable. */
      gatewayMessage: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
  },
  translate_cancel: {
    input: z.object({ jobId: idInput }),
    output: z.object({ cancelled: z.boolean() }),
  },
  translate_settings_get: {
    input: z.object({}),
    output: z.object({
      gateway: translateGatewaySchema,
      providers: z.array(translateProviderSchema),
      models: z.array(translateModelSchema).nullable(),
      current: z.object({ providerId: z.string(), model: z.string(), language: z.string() }),
    }),
  },
  /** Empty provider or model: the first available one. */
  translate_settings_set: {
    input: z.object({ providerId: settingText(64), model: settingText(200), language: languageTagSchema }),
    output: z.object({ ok: z.literal(true) }),
  },
  translate_clear: {
    input: z.object({}),
    output: z.object({ removed: z.number().int().min(0) }),
  },

  // ---- Sending polish (slice 3d). Owner only, like 3b and 3c: every
  // handler refuses plugin callers, none is discoverable, none is a tool,
  // CLI or mention. ----

  /** Every identity of the account, or of every account when null. */
  identities_list: {
    input: z.object({ accountId: idInput.nullable() }),
    output: z.object({ identities: z.array(identityViewSchema) }),
  },
  /** Adds an alias by hand (or from a suggestion); a dismissed one becomes active. */
  identity_add: {
    input: identityKeyInput.extend({ displayName: displayNameInput.optional() }),
    output: identityViewSchema,
  },
  /** An alias's name or signature; the own address takes `signature` only. */
  identity_update: {
    input: identityKeyInput.extend({
      displayName: displayNameInput.nullable().optional(),
      signature: composeDocInputSchema.nullable().optional(),
    }),
    output: identityViewSchema,
  },
  /** Aliases only; local configuration. */
  identity_remove: {
    input: identityKeyInput,
    output: okOutput,
  },
  /** Addresses that look like the owner's, from inbound mail; nothing is added. */
  identity_suggestions: {
    input: z.object({ accountId: idInput }),
    output: z.object({
      suggestions: z.array(z.object({ address: z.string(), count: z.number().int(), lastDate: z.string() })),
    }),
  },
  /** "Not mine": stores a dismissed suggestion. */
  identity_dismiss: {
    input: identityKeyInput,
    output: okOutput,
  },
  templates_list: {
    input: z.object({}),
    output: z.object({
      templates: z.array(
        z.object({ id: z.string(), name: z.string(), doc: composeDocInputSchema, updatedAt: z.string() }),
      ),
    }),
  },
  /** Insert (no id) or update; `conflict` on a duplicate name. */
  template_save: {
    input: z.object({ id: idInput.optional(), name: templateNameInput, doc: composeDocInputSchema }),
    output: z.object({ id: z.string() }),
  },
  template_delete: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** The advisory pre-send issues of the saved draft; `conflict` when the revision moved on. */
  compose_check: {
    input: z.object({ draftId: idInput, baseRevision: z.number().int().min(0) }),
    output: z.object({ issues: z.array(presendIssueSchema) }),
  },
  /** Undoes the action recorded under `undoId`, if it is still the slot (spec resolution 4). */
  action_undo: {
    input: z.object({ undoId: z.uuid() }),
    output: z.object({
      outcome: z.enum(["done", "pending", "nothing"]),
      restored: z.number().int().min(0),
      skipped: z.array(z.object({ reason: undoSkipReasonSchema, count: z.number().int().min(0) })),
      failed: z.number().int().min(0),
      groups: z.array(actionGroupSchema),
    }),
  },

  // ---- Inbox triage (slice 3e). Owner only, like 3b-3d: every write
  // refuses plugin callers, none is discoverable, none is a tool, CLI or
  // mention. ----

  /** The senders behind a mail-new token, newest first; `not_found` once it expired. */
  new_mail_get: {
    input: z.object({ token: newMailToken }),
    output: z.object({ items: z.array(newMailItemSchema).max(3), more: z.number().int().min(0) }),
  },
  /** What the reading pane may offer to unsubscribe from the message's list. */
  unsubscribe_info: {
    input: z.object({ messageId: idInput }),
    output: unsubscribeInfoViewSchema,
  },
  /** Idempotent per requestId; refuses a method unsubscribe_info would not offer now. */
  unsubscribe_run: {
    input: z.object({ messageId: idInput, method: z.enum(["one_click", "mailto"]), requestId: z.uuid() }),
    output: z.object({
      outcome: z.enum(["done", "redirected", "failed", "queued"]),
      reason: z.string().nullable(),
      outboxId: z.string().nullable(),
    }),
  },
  /**
   * "Archive all from this list": an ordinary archive of the stored Inbox
   * rows of the message's account that carry the same list (never automatic).
   */
  unsubscribe_archive: {
    input: z.object({ messageId: idInput, undoId: z.uuid().optional() }),
    output: z.object({ groups: z.array(actionGroupSchema), undoable: z.boolean() }),
  },
  /** Moves Inbox mail to the account's snooze folder until `until`; `needsFolder` when it has none. */
  message_snooze: {
    input: z
      .object({
        messageIds: messageIdList,
        folder: idInput.optional(),
        role: specialUseSchema.optional(),
        until: z.iso.datetime(),
        undoId: z.uuid().optional(),
      })
      .refine((input) => (input.folder === undefined) !== (input.role === undefined), {
        message: "Give exactly one of folder and role",
      }),
    output: z.object({
      groups: z.array(actionGroupSchema),
      undoable: z.boolean(),
      needsFolder: z.array(z.object({ accountId: z.string(), proposedName: z.string() })),
    }),
  },
  /** Returns snoozed messages now. */
  /** `pending`: the account's queue was busy past the wait; the return finishes in the background. */
  message_unsnooze: {
    input: z.object({ messageIds: messageIdList }),
    output: z.object({ ok: z.boolean(), pending: z.boolean() }),
  },
  /** Creates the account's snooze folder (the owner confirmed it). */
  snooze_folder_create: {
    input: z.object({ accountId: idInput }),
    output: z.object({ path: z.string() }),
  },
  /** Uses an existing folder for snoozed mail; never a system folder. */
  snooze_folder_use: {
    input: z.object({ accountId: idInput, path: idInput }),
    output: okOutput,
  },
  /** Adds a global rule; moves the message (and with moveExisting, stored Inbox mail) to Spam. */
  block_add: {
    input: z.object({
      messageId: idInput,
      kind: blockKindSchema,
      moveExisting: z.boolean(),
      undoId: z.uuid().optional(),
    }),
    output: z.object({ ruleId: z.string(), groups: z.array(actionGroupSchema), undoable: z.boolean() }),
  },
  block_list: {
    input: z.object({}),
    output: z.object({ rules: z.array(blockRuleViewSchema) }),
  },
  /** Deletes the rule only; mail already in Spam stays. */
  block_remove: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** What the block dialog offers for a message, with the counts it would move. */
  block_check: {
    input: z.object({ messageId: idInput }),
    output: z.object({
      address: z.string(),
      /** Null for a public mail domain. */
      domain: z.string().nullable(),
      sentToCount: z.number().int().min(0),
      storedCount: z.object({ address: z.number().int().min(0), domain: z.number().int().min(0).nullable() }),
    }),
  },
  /** The triage card's content and a fresh view token, or where the batch stands. */
  triage_view: {
    input: z.object({ batchId: idInput, contentHash: contentHashInput }),
    output: z.union([
      z.object({ state: z.literal("ready"), view: triageViewSchema, viewToken: z.string() }),
      z.object({ state: z.union([triageBatchStateSchema.exclude(["pending"]), z.literal("gone")]) }),
    ]),
  },
  /** Where a triage batch stands, for its thread row: counts and ids only. */
  triage_status: {
    input: z.object({ batchId: idInput }),
    output: z.object({
      state: triageBatchStateSchema,
      total: z.number().int().min(0),
      approved: z.number().int().min(0),
      done: z.number().int().min(0),
      skipped: z.number().int().min(0),
      failed: z.number().int().min(0),
      rateLimited: z.number().int().min(0),
      byAction: z.array(z.object({ action: z.string(), done: z.number().int().min(0) })),
      undoable: z.boolean(),
    }),
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

/** Realtime channel the server publishes on when new mail toasts (slice 3e). */
export const NEW_MAIL_CHANNEL = "mail-new";

/** Payload on NEW_MAIL_CHANNEL: a token for new_mail_get, nothing else. */
export const newMailPayloadSchema = z.strictObject({ token: newMailToken });
export type NewMailPayload = z.infer<typeof newMailPayloadSchema>;
