import { z } from "zod";
import type { OutgoingAddress } from "./compose-address.ts";
import { composeDocInputSchema, type ComposeDoc } from "./compose-doc.ts";

/** Which server preset an account was set up with. */
export const accountPresetSchema = z.enum(["icloud", "gmail", "other"]);
export type AccountPreset = z.infer<typeof accountPresetSchema>;

export const mailAddressSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

/** How an SMTP connection is secured. There is no plaintext value. */
export const smtpSecuritySchema = z.enum(["tls", "starttls"]);
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;

/** Who keeps the copy in Sent: the server itself (Gmail), or the plugin by APPEND. */
export const sentCopyPolicySchema = z.enum(["server", "append"]);
export type SentCopyPolicy = z.infer<typeof sentCopyPolicySchema>;

/** An account's SMTP server. `username` null: the IMAP username. */
export type StoredSmtp = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
};

/** True when the text holds no CR, LF or NUL (header injection). */
export function noLineBreaks(text: string): boolean {
  return !/[\r\n\u0000]/.test(text);
}

/** A host name as typed: ASCII letters, digits, dots and hyphens. */
export const hostInputSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, { message: "Not a host name" });
const smtpUsernameInput = z.string().min(1).max(320).refine(noLineBreaks, {
  message: "Line breaks are not allowed",
});

/** A connected account as the UI sees it. Never carries a credential. */
export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  preset: accountPresetSchema,
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  authFailed: z.boolean(),
  /** The account has an SMTP server, so it can send. */
  smtpConfigured: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;

/** What the owner types to connect an account. */
export const newAccountInputSchema = z.object({
  preset: accountPresetSchema,
  email: z.string().email(),
  displayName: z.string().nullable().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  password: z.string().min(1),
  /** SMTP for "other"; iCloud and Gmail take it from the preset. */
  smtpHost: hostInputSchema.optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecurity: smtpSecuritySchema.optional(),
  smtpUsername: smtpUsernameInput.optional(),
}).refine(
  (input) =>
    input.preset !== "other" ||
    (input.smtpHost !== undefined && input.smtpPort !== undefined && input.smtpSecurity !== undefined),
  { message: "Another server needs its SMTP host, port and security", path: ["smtpHost"] },
);
export type NewAccountInput = z.infer<typeof newAccountInputSchema>;

export const attachmentMetaSchema = z.object({
  partId: z.string(),
  filename: z.string().nullable(),
  mimeType: z.string(),
  size: z.number().int(),
  isInline: z.boolean(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

/** The role a folder plays, from its special-use flag or a name fallback. */
export const specialUseSchema = z.enum([
  "inbox",
  "sent",
  "drafts",
  "junk",
  "trash",
  "archive",
  "all",
]);
export type SpecialUse = z.infer<typeof specialUseSchema>;

/** A synced folder as the UI sees it. Counts cover the local sync window. */
export const folderSchema = z.object({
  accountId: z.string(),
  path: z.string(),
  name: z.string(),
  specialUse: specialUseSchema.nullable(),
  selectable: z.boolean(),
  unreadCount: z.number().int(),
  totalCount: z.number().int(),
});
export type Folder = z.infer<typeof folderSchema>;

/**
 * What the owner asks to do with messages: a move by role (delete moves to
 * Trash; nothing is expunged), a move to a chosen folder, or a \Seen /
 * \Flagged change.
 */
export const messageActionSchema = z.enum([
  "spam",
  "not_spam",
  "archive",
  "delete",
  "mark_read",
  "mark_unread",
  "flag",
  "unflag",
  "move",
]);
export type MessageAction = z.infer<typeof messageActionSchema>;

/** The actions that move mail to a folder chosen by its role. */
export type RoleMoveAction = Extract<MessageAction, "spam" | "not_spam" | "archive" | "delete">;

/** A \Seen / \Flagged change; an absent field stays as it is. */
export type FlagChange = { seen?: boolean; flagged?: boolean };

/** A pending \Seen / \Flagged change of one message; null = no change. */
export type FlagIntent = { uid: number; seen: boolean | null; flagged: boolean | null };

/** Summed counts of one special-use role across every account. */
export const roleCountSchema = z.object({
  role: specialUseSchema,
  unreadCount: z.number().int(),
  totalCount: z.number().int(),
});
export type RoleCount = z.infer<typeof roleCountSchema>;

export const messageSummarySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** Path of the folder this copy lives in. */
  folder: z.string(),
  threadId: z.string(),
  date: z.string().nullable(),
  from: mailAddressSchema,
  subject: z.string(),
  snippet: z.string(),
  isRead: z.boolean(),
  isFlagged: z.boolean(),
  hasAttachments: z.boolean(),
});
export type MessageSummary = z.infer<typeof messageSummarySchema>;

export const messageHeaderSchema = messageSummarySchema.extend({
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  attachments: z.array(attachmentMetaSchema),
  /** The compose_drafts row whose server copy is this message, or null (drives Edit draft). */
  draftId: z.string().nullable(),
});
export type MessageHeader = z.infer<typeof messageHeaderSchema>;

export const threadSummarySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  lastDate: z.string().nullable(),
  messageCount: z.number().int(),
  unreadCount: z.number().int(),
  participants: z.array(mailAddressSchema),
  snippet: z.string(),
  /** Any message of the thread in the viewed folder (or role) is flagged. */
  flagged: z.boolean(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** A thread with its messages, oldest first. */
export const threadDetailSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(messageHeaderSchema),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const messageBodySchema = z.object({
  messageId: z.string(),
  text: z.string().nullable(),
  /** `cid:` references already replaced by `data:` URIs. */
  html: z.string().nullable(),
  htmlTruncated: z.boolean(),
  /** The owner allowed remote images from this sender. */
  remoteImagesAllowed: z.boolean(),
});
export type MessageBody = z.infer<typeof messageBodySchema>;

export const statusViewSchema = z.object({
  vaultReady: z.boolean(),
  agentTools: z.boolean(),
  accounts: z.array(accountSchema),
  unreadCount: z.number().int(),
});
export type StatusView = z.infer<typeof statusViewSchema>;

/** An account as the store keeps it. Never leaves the server. */
export type StoredAccount = Omit<Account, "smtpConfigured"> & {
  passwordSealed: string;
  smtp: StoredSmtp | null;
  sentCopy: SentCopyPolicy;
};

/** An inline (cid-referenced) image part of a message. */
export type InlinePart = { contentId: string; mimeType: string; data: Uint8Array };

/** One message of a folder as the IMAP gateway returns it. */
export type FetchedMessage = {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  gmThreadId: string | null;
  /** Gmail X-GM-MSGID, when the server has it. */
  gmMsgId: string | null;
  date: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  seen: boolean;
  flagged: boolean;
  size: number;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  inlineParts: InlinePart[];
};

/** A folder as the server lists it. */
export type RemoteFolder = {
  path: string;
  name: string;
  delimiter: string;
  specialUse: SpecialUse | null;
  selectable: boolean;
};

/** What threading needs to know about one stored message. */
export type ThreadingInput = {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  date: string | null;
  gmThreadId: string | null;
};

/** Sync progress for one folder of one account. */
export type SyncState = {
  uidValidity: number;
  lastUid: number;
  syncedSince: string;
};

/** Where a stored message lives on the server, for a raw fetch. */
export type RawRef = {
  accountId: string;
  folder: string;
  uid: number;
  size: number;
  /** The Message-ID header, when the message has one. */
  messageId: string | null;
  /** The folder's stored UIDVALIDITY, when it has been synced. */
  uidValidity: number | null;
};

/** A parsed search query: free text plus optional operators. */
export type ParsedQuery = {
  text: string;
  from?: string;
  subject?: string;
  unread?: boolean;
  after?: string;
  before?: string;
};

// ---- Compose and send (slice 3b) ----

export const composeKindSchema = z.enum(["new", "reply", "reply_all", "forward"]);
export type ComposeKind = z.infer<typeof composeKindSchema>;

/**
 * A queued send's state. `done` appears only in realtime events: a done row
 * is deleted. There is no cancelled state: Undo deletes the row.
 */
export const outboxStateSchema = z.enum([
  "queued",
  "held",
  "sending",
  "sent",
  "appending",
  "failed",
  "unknown",
  "sent_no_copy",
  "done",
]);
export type OutboxState = z.infer<typeof outboxStateSchema>;

/** Why a send failed, as a kind only: never the server's response text. */
export const sendErrorKindSchema = z.enum([
  "auth",
  "tls",
  "connect",
  "timeout_before_data",
  "temporary",
  "rejected_all",
  "rejected_message",
  "too_large",
  "unknown_after_data",
  "no_sent_folder",
  "append_failed",
]);
export type SendErrorKind = z.infer<typeof sendErrorKindSchema>;

export const composeAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
});
export type ComposeAttachment = z.infer<typeof composeAttachmentSchema>;

/** Where the draft's copy in the account's Drafts folder stands. */
export const draftServerCopySchema = z.enum(["none", "saved", "failed", "local_only"]);
export type DraftServerCopyState = z.infer<typeof draftServerCopySchema>;

/** A draft as the composer sees it. */
export const draftViewSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  kind: composeKindSchema,
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  bcc: z.array(mailAddressSchema),
  subject: z.string(),
  doc: composeDocInputSchema,
  attachments: z.array(composeAttachmentSchema),
  revision: z.number().int(),
  serverCopy: draftServerCopySchema,
  /** A send of this draft is queued: saving answers conflict until it settles. */
  queued: z.boolean(),
  /** Sanitized HTML the page loads into the editor once (quote of the original, or a foreign draft's body). */
  import: z
    .object({ html: z.string(), into: z.enum(["quote", "body"]) })
    .nullable(),
});
export type DraftView = z.infer<typeof draftViewSchema>;

/** One Outbox row as the UI sees it. `subject` is for local display only. */
export const outboxRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  state: outboxStateSchema,
  errorKind: sendErrorKindSchema.nullable(),
  /** Recipients the server refused. */
  rejected: z.array(z.string()),
  /** ISO 8601. */
  sendAfter: z.string(),
  attempts: z.number().int(),
});
export type OutboxRow = z.infer<typeof outboxRowSchema>;

/** A file attached to an outgoing message. Always bytes, never a path or URL. */
export type OutgoingAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  contentId: string | null;
};

/** Everything the message builder needs; plain data, no host objects. */
export type OutgoingMessage = {
  from: OutgoingAddress;
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  /** Never written into the built MIME; the Sent copy gets it spliced in. */
  bcc: OutgoingAddress[];
  subject: string;
  messageId: string;
  /** ISO 8601. */
  date: string;
  inReplyTo: string | null;
  references: string[];
  html: string;
  text: string;
  attachments: OutgoingAttachment[];
};

/** What a reply or forward reads from the original on the server. */
export type OriginalMessage = {
  replyTo: MailAddress[];
  html: string | null;
  attachments: OutgoingAttachment[];
};

/** The fields the composer saves on every autosave. */
export type DraftFields = {
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  doc: ComposeDoc;
};

/** Where the draft's latest copy lives in the account's Drafts folder. */
export type DraftServerCopy = {
  folder: string;
  uidValidity: number;
  uid: number;
  /** The draft revision that copy holds. */
  revision: number;
  /** Its RFC822.SIZE, for the expunge guard. */
  size: number;
};

export type NewDraft = DraftFields & {
  id: string;
  kind: ComposeKind;
  /** messages.id it replies to or forwards, or null. */
  sourceMessageId: string | null;
  /** The RFC 5322 Message-ID every version of this draft and its send carry. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** A foreign Drafts message the owner continued: our first copy replaces it. */
  serverCopy: DraftServerCopy | null;
  /**
   * HTML (unsanitized; the page sanitizes it) the composer loads into the
   * editor once: the original's body as a quote, or a continued foreign
   * draft's body. Cleared by the first save.
   */
  importHtml: { html: string; into: "quote" | "body" } | null;
  /** The 3c seam; always "owner" in 3b. */
  origin: "owner";
  /** ISO 8601. */
  createdAt: string;
};

/** A compose_drafts row. Starts at revision 1; every save bumps it. */
export type DraftRecord = NewDraft & {
  revision: number;
  /** Where the copy in Drafts stands: "saved" with a serverCopy, else none, failed or local_only. */
  serverState: DraftServerCopyState;
  /** ISO 8601. */
  updatedAt: string;
};

/** What queueing a send stores. `mime` is the exact bytes SMTP gets (no Bcc). */
export type NewOutboxRow = {
  /** The page's requestId: the idempotency key. */
  id: string;
  accountId: string;
  draftId: string | null;
  messageId: string;
  subject: string;
  envelopeFrom: string;
  /** To, Cc and Bcc addresses. */
  envelopeTo: string[];
  mime: Uint8Array;
  /** The folded Bcc line the Sent copy gets, or null. */
  bccHeader: string | null;
  /** ISO 8601. */
  sendAfter: string;
  origin: "owner";
  /** ISO 8601. */
  createdAt: string;
};

/** An outbox row without its blobs. */
export type OutboxRecord = Omit<NewOutboxRow, "mime" | "bccHeader"> & {
  state: OutboxState;
  attempts: number;
  errorKind: SendErrorKind | null;
  rejected: string[];
  /** ISO 8601. */
  updatedAt: string;
};
