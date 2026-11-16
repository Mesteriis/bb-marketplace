import { z } from "zod";
import type { OutgoingAddress } from "./compose-address.ts";
import { composeDocInputSchema, type ComposeDoc } from "./compose-doc.ts";
import type { SignatureDoc } from "./compose-signature.ts";
import type { HeaderLine, UnsubscribeInfo } from "./unsubscribe.ts";
import { LOG_ACTORS, LOG_OUTCOMES, LOG_TOOLS } from "./agent-log.ts";
import { DEV_KINDS, DEV_SOURCES, DEV_STATES, type DevClass } from "./dev-notify.ts";
import { DEV_LINK_KINDS } from "./dev-links.ts";

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
  /** The folder snoozed mail waits in (slice 3e), for Mail settings; null until there is one. */
  snoozeFolder: z.string().nullable().optional(),
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

/** A notification's local dev class (slice 3g, dev-notify.ts); `repo` "host/owner/repo" or a service. */
export const devClassSchema = z.object({
  source: z.enum(DEV_SOURCES),
  repo: z.string().nullable(),
  kind: z.enum(DEV_KINDS),
  state: z.enum(DEV_STATES).nullable(),
  ref: z.string().nullable(),
});

/** A repository by host and path (projects.ts RepoRef). */
export const repoRefSchema = z.object({ host: z.string(), path: z.string() });

/** One repository, PR, issue or CI link of a message (slice 3g, dev-links.ts); the text shown is the URL. */
export const devLinkViewSchema = z.object({
  url: z.string(),
  kind: z.enum(DEV_LINK_KINDS),
  repo: repoRefSchema.nullable(),
  number: z.string().nullable(),
  projectId: z.string().nullable(),
});
export type DevLinkView = z.infer<typeof devLinkViewSchema>;

/**
 * What a message was handed to in BB (slice 3g, `bb_links`): a thread, a
 * Taskboard task, a file saved into a project, a patch hand-off or an
 * incident thread. `targetId` is the BB thread id, the task id or the
 * project-relative path; `title` the BB thread title when known.
 */
export const bbLinkKindSchema = z.enum(["thread", "taskboard_task", "project_file", "patch", "incident"]);
export type BbLinkRowKind = z.infer<typeof bbLinkKindSchema>;
export const bbLinkViewSchema = z.object({
  kind: bbLinkKindSchema,
  targetId: z.string(),
  projectId: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.string(),
});
export type BbLinkView = z.infer<typeof bbLinkViewSchema>;

/** A patch in a message: file count and line totals (slice 3g). */
export const patchSummarySchema = z.object({
  files: z.number().int().min(0),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});

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
  /** The subject with its secrets hidden (slice 3f): the Hand-to-agent chip label. */
  agentSubject: z.string(),
  /** Inside the AI access scope: AI buttons and Hand to agent are enabled. */
  inAiScope: z.boolean(),
  /** Slice 3g: repository, PR, issue and CI links of the body (computed when read, not stored). */
  devLinks: z.array(devLinkViewSchema),
  /** Slice 3g: the local dev class, or null. */
  dev: devClassSchema.nullable(),
  /** Slice 3g: the patch the message carries, or null. */
  patch: patchSummarySchema.nullable(),
  /** Slice 3g: a monitoring alert (the card asks alert_view). */
  alert: z.boolean(),
  /** Slice 3g: what this message was handed to in BB. */
  bbLinks: z.array(bbLinkViewSchema),
});
export type MessageHeader = z.infer<typeof messageHeaderSchema>;

/** The four local categories (slice 3f). */
export const categorySchema = z.enum(["bills", "notifications", "personal", "newsletters"]);

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
  /** The earliest snooze due time of the thread's rows in the viewed folder (slice 3e); null when none. */
  snoozedUntil: z.string().nullable(),
  /** The latest member row's label in the view (slice 3f); null when none. */
  category: categorySchema.nullable(),
  /** The latest member row's suggestion (model, else local); null when none or categories are off. */
  categorySuggestion: categorySchema.nullable(),
  /** Slice 3g: the conversation's project (the owner's binding, else the first matching binding rule); null when none. */
  projectId: z.string().nullable(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** A thread with its messages, oldest first. */
export const threadDetailSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(messageHeaderSchema),
  /** Slice 3g: the bound project; `source` owner (the chip) or rule (a binding rule). */
  project: z.object({ id: z.string(), name: z.string(), source: z.enum(["owner", "rule"]) }).nullable(),
  /** Slice 3g: a project the conversation's dev links or repo map to, when none is bound; never bound by itself. */
  projectSuggestion: z.object({ id: z.string(), name: z.string(), repo: z.string().nullable() }).nullable(),
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
  /** Slice 3g: the texts of the HTML body's <pre> blocks (empty for plain mail). */
  codeBlocks: z.array(z.string()),
});
export type MessageBody = z.infer<typeof messageBodySchema>;

/** Why a translation failed or the gateway is not usable, as a kind only. */
export const translateErrorKindSchema = z.enum([
  "gateway_missing",
  "pool_unavailable",
  "provider_unknown",
  "model_unknown",
  "auth",
  "quota",
  "refused",
  "too_large",
  "busy",
  "failed",
  "cancelled",
]);

/**
 * Why an owner-click AI call failed (slice 3f): the translation kinds, plus
 * unreadable (the answer did not parse), out_of_scope (outside AI access)
 * and too_long (the answer was cut off at max_tokens, or a draft over the cap).
 */
export const aiErrorKindSchema = z.enum([...translateErrorKindSchema.options, "unreadable", "out_of_scope", "too_long"]);
export type AiErrorKind = z.infer<typeof aiErrorKindSchema>;

/** The translation gateway's state: "ok", why it cannot be used, or "unknown" while a check is still running. */
export const translateGatewaySchema = z.union([z.literal("ok"), z.literal("unknown"), translateErrorKindSchema]);

export const statusViewSchema = z.object({
  vaultReady: z.boolean(),
  agentTools: z.boolean(),
  /** The mail_propose tool is offered to agents (off by default). */
  agentPropose: z.boolean(),
  translate: z.object({ gateway: translateGatewaySchema }),
  accounts: z.array(accountSchema),
  unreadCount: z.number().int(),
});
export type StatusView = z.infer<typeof statusViewSchema>;

/** An account as the store keeps it. Never leaves the server. */
export type StoredAccount = Omit<Account, "smtpConfigured"> & {
  passwordSealed: string;
  smtp: StoredSmtp | null;
  sentCopy: SentCopyPolicy;
  /** The own address's signature (slice 3d); null = none. */
  signature: SignatureDoc | null;
  /** The folder snoozed mail waits in (slice 3e); null until the owner created or chose one. */
  snoozeFolder: string | null;
};

/** An inline (cid-referenced) image part of a message. */
export type InlinePart = { contentId: string; mimeType: string; data: Uint8Array };

/** The headers that mark a message as bulk (mailing lists, newsletters, automated mail); null when absent. */
export type BulkHeaders = {
  listId: string | null;
  listUnsubscribe: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
};

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
  /** Absent when the fetch did not read headers: the store keeps the bulk mark unknown. */
  bulkHeaders?: BulkHeaders;
  /**
   * Delivered-To and X-Original-To addresses, lower case, at most 10 (slice
   * 3d). Absent when the fetch did not read headers.
   */
  deliveredTo?: string[];
  /**
   * The header lines unsubscribe parsing reads (UNSUBSCRIBE_HEADER_FIELDS and
   * the provider's trace names), in message order (slice 3e). Absent when the
   * fetch did not read headers: the stored unsubscribe info is left alone.
   */
  unsubscribeHeaders?: HeaderLine[];
  /**
   * The unsubscribe info sync judged from `unsubscribeHeaders` (null: no
   * List-Unsubscribe). Absent: the store leaves the stored info alone.
   */
  unsubscribe?: UnsubscribeInfo | null;
  /**
   * Slice 3g: the DEV_HEADER_FIELDS lines (lower-case keys), in message
   * order. Absent when the fetch did not read headers.
   */
  devHeaders?: HeaderLine[];
  /**
   * Slice 3g: the dev class sync judged (null = not a dev notification).
   * Absent: not classified (classification off, or Spam and Trash).
   */
  dev?: DevClass | null;
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

/** What an attachment is, for the viewer and the Files view (slice 3h; stored in attachments.kind). */
export const fileKindSchema = z.enum(["image", "pdf", "text", "document", "archive", "calendar", "other"]);
export type FileKind = z.infer<typeof fileKindSchema>;

/**
 * Why a row outside the sync window is kept (slice 3h, `messages.kept`):
 * loaded history, a server search hit (expires), or opened by the owner
 * (never expires). NULL in the column: a window row.
 */
export const keptStateSchema = z.enum(["history", "search", "opened"]);
export type KeptState = z.infer<typeof keptStateSchema>;

/** Why a message is listed as related (slice 3h, #83). */
export const relatedReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terms"), terms: z.array(z.string()) }),
  z.object({ kind: z.literal("participants"), count: z.number().int().min(1) }),
  z.object({ kind: z.literal("reference") }),
]);
export type RelatedReason = z.infer<typeof relatedReasonSchema>;

/** The operators a search condition may carry (slice 3h). */
export const searchFieldSchema = z.enum([
  "from",
  "to",
  "cc",
  "subject",
  "has",
  "filename",
  "in",
  "account",
  "is",
  "larger",
  "smaller",
  "after",
  "before",
  "list",
  "category",
  "label",
]);
export type SearchField = z.infer<typeof searchFieldSchema>;

/**
 * One operator of a query, its value normalized (slice 3h): `has` is
 * `attachment`; `is` is `unread` or `flagged` (read and unflagged are their
 * negations); sizes are whole bytes; dates are ISO dates (relative dates are
 * already turned into `after` / `before`); `in` roles are lower case
 * (`spam` is `junk`).
 */
export type SearchCondition = { field: SearchField; value: string; negated: boolean };

/** Why a token stayed free text. */
export const searchNoteSchema = z.object({
  kind: z.enum(["unknown_operator", "bad_value"]),
  token: z.string(),
});
export type SearchNote = z.infer<typeof searchNoteSchema>;

/**
 * A parsed search query: free text plus operators. `conditions` is the full
 * query (slice 3h); `from`, `subject`, `unread`, `after` and `before` are
 * derived from its positive conditions for older callers.
 */
export type ParsedQuery = {
  text: string;
  from?: string;
  subject?: string;
  unread?: boolean;
  after?: string;
  before?: string;
  conditions: SearchCondition[];
  notes: SearchNote[];
};

// ---- Compose and send (slice 3b) ----

export const composeKindSchema = z.enum(["new", "reply", "reply_all", "forward"]);
export type ComposeKind = z.infer<typeof composeKindSchema>;

/** Who started a draft or a send: the owner, or an agent through a confirmed proposal (slice 3c). */
export const draftOriginSchema = z.enum(["owner", "agent"]);
export type DraftOrigin = z.infer<typeof draftOriginSchema>;

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
  /** A 5xx reply to MAIL FROM (other than 552) for an alias From; the core decides it (slice 3d). */
  "sender_refused",
]);
export type SendErrorKind = z.infer<typeof sendErrorKindSchema>;

export const composeAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  /** Slice 3g: `bb:project:<id>` or `bb:thread:<id>` for a file picked from BB; null for uploads. Never sent. */
  origin: z.string().nullable(),
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
  /** It continues a foreign Drafts message: closed untouched without a server copy, it is dropped. */
  continues: z.boolean(),
  /**
   * Sanitized HTML the page loads into the editor once (quote of the original,
   * or a foreign draft's body). `stripSignature`: a reply to the owner's own
   * mail, so the page drops `div.makosh-signature`; otherwise it drops only
   * that class (slice 3d resolution 3).
   */
  import: z
    .object({ html: z.string(), into: z.enum(["quote", "body"]), stripSignature: z.boolean() })
    .nullable(),
  /** "agent": started by an agent proposal the owner opened in Mail (the composer's badge). */
  origin: draftOriginSchema,
  /** The identity the draft sends from; null = the account's own address. */
  fromAddress: z.string().nullable(),
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
  /** "agent": a send the owner confirmed in an agent's card (the toast and the "Agent message" label). */
  origin: draftOriginSchema,
  /**
   * The Outbox text for a send from an alias (slice 3d: `sender_refused`, or
   * the hint on `rejected_message`); it names the alias, for the page only.
   * Absent or null when the kind's own text is enough.
   */
  errorText: z.string().nullable().optional(),
  /**
   * "unsubscribe": a send the plugin made for the owner's Unsubscribe click
   * (slice 3e): the Outbox labels it "Unsubscribe request" and offers no Edit.
   */
  purpose: z.enum(["unsubscribe"]).nullable().optional(),
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
  /** A Drafts message's Bcc (only a draft keeps one). */
  bcc: MailAddress[];
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
  /** The sending identity's address (slice 3d); null = the account's own address. */
  fromAddress: string | null;
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
  /**
   * messages.id it replies to or forwards; for a "new" draft, the foreign
   * Drafts message it continues (so opening that message again returns this
   * draft); else null.
   */
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
  importHtml: { html: string; into: "quote" | "body"; stripSignature?: boolean } | null;
  /** "agent" for a draft an agent proposal created; it stays as the composer's badge. */
  origin: DraftOrigin;
  /**
   * The agent proposal this hidden draft belongs to, or null. A draft with a
   * proposal id is reachable only through the proposal's card: no compose
   * RPC, Drafts list or server copy sees it.
   */
  proposalId: string | null;
  /**
   * Why the plugin made a draft the owner did not write (slice 3e): an
   * unsubscribe email. A purpose draft is hidden like a proposal draft
   * (isHiddenDraft). Absent: null.
   */
  purpose?: DraftPurpose | null;
  /** ISO 8601. */
  createdAt: string;
};

export type DraftPurpose = "unsubscribe";

/** A compose_drafts row. Starts at revision 1; every save bumps it. */
export type DraftRecord = NewDraft & {
  purpose: DraftPurpose | null;
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
  origin: DraftOrigin;
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

// ---- Agent proposals and translation (slice 3c) ----

export const proposalStateSchema = z.enum([
  "pending",
  "confirming",
  "queued",
  "opened",
  "cancelled",
  "expired",
  "refused",
]);

/** The card's warnings on one recipient. */
export const recipientFlagSchema = z.enum(["new", "added", "outside", "hidden_chars"]);

const proposalRecipientSchema = z.object({
  /** ASCII form: an IDN domain shows as punycode. */
  address: z.string(),
  /** Only names the Reply rules computed from the store; agent-supplied names are dropped. */
  name: z.string().nullable(),
  flags: z.array(recipientFlagSchema),
});

// ---- Sending polish (slice 3d) ----

export const sendCheckSchema = z.enum(["unknown", "accepted", "pending", "confirmed", "rewritten", "refused"]);

/** One address the owner can send from, as the page sees it. */
export const identityViewSchema = z.object({
  accountId: z.string(),
  /** Lower case. */
  address: z.string(),
  /** Effective: the alias's name, else the account's. */
  displayName: z.string().nullable(),
  primary: z.boolean(),
  /** A signature document (paragraphs only), or null. */
  signature: composeDocInputSchema.nullable(),
  sendCheck: sendCheckSchema,
});
export type IdentityView = z.infer<typeof identityViewSchema>;

/** One advisory pre-send issue (core presend.ts PresendIssue). */
export const presendIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attachment_mentioned"), phrase: z.string() }),
  z.object({ kind: z.literal("empty_subject") }),
  z.object({ kind: z.literal("outside_conversation"), addresses: z.array(z.string()) }),
  z.object({ kind: z.literal("new_recipients"), addresses: z.array(z.string()) }),
  z.object({ kind: z.literal("bb_files"), count: z.number().int(), origins: z.array(z.string()) }),
  z.object({ kind: z.literal("looks_secret"), count: z.number().int() }),
]);

/** What the confirmation card shows: the whole message, server-built. */
export const proposalViewSchema = z.object({
  proposalId: z.string(),
  draftId: z.string(),
  kind: composeKindSchema,
  account: z.object({ id: z.string(), name: z.string(), address: z.string() }),
  fromName: z.string().nullable(),
  /** The message replied to or forwarded; null for a new message. */
  source: z.object({ fromAddress: z.string(), subject: z.string() }).nullable(),
  to: z.array(proposalRecipientSchema),
  cc: z.array(proposalRecipientSchema),
  bcc: z.array(proposalRecipientSchema),
  subject: z.string(),
  /** Invisible characters removed from what is shown (revealHidden). */
  hiddenChars: z.number().int(),
  bodyText: z.string(),
  quoteText: z.string().nullable(),
  /** Links in the agent's own text, by host. */
  links: z.array(z.object({ url: z.string(), host: z.string() })),
  attachments: z.array(z.object({ fileName: z.string(), mimeType: z.string(), size: z.number().int() })),
  /** Forwarded attachments left out over the size cap. */
  leftOut: z.number().int(),
  /** ISO 8601. */
  expiresAt: z.string(),
  /** It is sent from an alias, not the account's own address. */
  fromAlias: z.boolean(),
  /** The identity's signature as text, or null. */
  signatureText: z.string().nullable(),
  /** The template the agent named, for the card's label. */
  templateName: z.string().nullable(),
  /** Pre-send issues without new_recipients (the recipient flags cover it). */
  checks: z.array(presendIssueSchema),
});
export type ProposalView = z.infer<typeof proposalViewSchema>;

/** A stored (or just finished) translation as the reading pane shows it. Text only, never HTML. */
export const translationViewSchema = z.object({
  messageId: z.string(),
  targetLanguage: z.string(),
  providerId: z.string(),
  model: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  cached: z.boolean(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type TranslationView = z.infer<typeof translationViewSchema>;

// ---- Inbox triage (slice 3e) ----

/**
 * Quick filters of a thread list: a thread qualifies when one member row in
 * the viewed folder (or role), not moving, matches every flag given. `keep`
 * is the open conversation, listed whatever the flags say.
 */
export const threadFilterSchema = z.object({
  unread: z.literal(true).optional(),
  flagged: z.literal(true).optional(),
  attachments: z.literal(true).optional(),
  keep: z.string().min(1).max(256).optional(),
  /** Slice 3f: a member row carries this label. */
  category: categorySchema.optional(),
  /** Slice 3g: the latest member row is not a dev notification ("Hide dev notifications"). */
  notDev: z.literal(true).optional(),
  /** Slice 3g: the conversation's project is this one. */
  projectId: z.string().min(1).max(256).optional(),
});
export type ThreadFilter = z.infer<typeof threadFilterSchema>;

/** One sender of a new-mail toast; the address always shows beside the name. */
export const newMailItemSchema = z.object({
  accountId: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  /** From display name revealed, one line, at most 60 characters; the address when empty. */
  name: z.string(),
  address: z.string(),
});
export type NewMailItem = z.infer<typeof newMailItemSchema>;

export const unsubscribeTrustSchema = z.enum(["covered", "not_covered", "no_dkim", "untrusted_provider"]);
export const unsubscribeStateSchema = z.enum(["done", "redirected", "failed", "queued", "sent", "cancelled"]);
export type UnsubscribeState = z.infer<typeof unsubscribeStateSchema>;

/** What the reading pane may offer to unsubscribe (never the list's own key). */
export const unsubscribeInfoViewSchema = z.object({
  methods: z.object({
    oneClick: z.object({ host: z.string() }).nullable(),
    /** `subject` and `body` are exactly what the email carries: plain text, hidden characters taken out (review item 5). */
    mailto: z
      .object({ address: z.string(), subject: z.string(), body: z.string(), hiddenChars: z.number().int(), foreignDomain: z.boolean() })
      .nullable(),
  }),
  trust: unsubscribeTrustSchema,
  listName: z.string().nullable(),
  /** An earlier request for this list in this account. */
  already: z.object({ state: unsubscribeStateSchema, at: z.string() }).nullable(),
  /** The message sits in Spam or Trash: nothing is offered. */
  hidden: z.boolean(),
});
export type UnsubscribeInfoView = z.infer<typeof unsubscribeInfoViewSchema>;

export const blockKindSchema = z.enum(["address", "domain"]);

export const blockRuleViewSchema = z.object({
  id: z.string(),
  kind: blockKindSchema,
  value: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type BlockRuleView = z.infer<typeof blockRuleViewSchema>;

export const triageActionSchema = z.enum(["archive", "reply", "snooze", "mark_read", "spam", "unsubscribe"]);
export const triageBatchStateSchema = z.enum([
  "pending",
  "confirming",
  "applying",
  "applied",
  "cancelled",
  "changed",
  "expired",
  "interrupted",
]);
export const triageOutcomeSchema = z.enum([
  "done",
  "reply_approved",
  "not_approved",
  "skipped",
  "rate_limited",
  "failed",
]);

/** One item of the triage card, with what the store says about its message now. */
export const triageItemViewSchema = z.object({
  position: z.number().int(),
  messageId: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  action: triageActionSchema,
  /** ISO 8601; snooze items only. */
  snoozeUntil: z.string().nullable(),
  /** The agent's note, revealed; shown as agent text under its own label. */
  note: z.string().nullable(),
  fromName: z.string().nullable(),
  fromAddress: z.string(),
  subject: z.string(),
  date: z.string().nullable(),
  folder: z.string(),
  /** False when the message moved or went away since the agent proposed it. */
  available: z.boolean(),
  reason: z.string().nullable(),
  /**
   * Unsubscribe items: the method offered now and where it goes; for the
   * email, exactly what it carries (review item 5).
   */
  unsubscribe: z
    .object({
      method: z.enum(["one_click", "mailto"]),
      host: z.string().nullable(),
      address: z.string().nullable(),
      mailto: z
        .object({ subject: z.string(), body: z.string(), hiddenChars: z.number().int(), foreignDomain: z.boolean() })
        .nullable(),
    })
    .nullable(),
});
export type TriageItemView = z.infer<typeof triageItemViewSchema>;

export const triageViewSchema = z.object({
  batchId: z.string(),
  /** The agent's one-line summary, revealed; agent text. */
  summary: z.string().nullable(),
  items: z.array(triageItemViewSchema),
  /** Accounts of snooze items that have no snooze folder yet. */
  needsFolder: z.array(z.object({ accountId: z.string(), accountEmail: z.string(), proposedName: z.string() })),
  /** ISO 8601. */
  expiresAt: z.string(),
});
export type TriageView = z.infer<typeof triageViewSchema>;

// ---- Agent and mail (slice 3f). Output keys avoid the credential walker
// ("hidden", not "secret"; no "key" or "token" key). ----

/** A model's citation as the page links it: the frame number and the message it maps to. */
export const aiCitationSchema = z.object({
  n: z.number().int().min(1),
  messageId: z.string(),
  accountId: z.string(),
  threadId: z.string(),
});

/** Notes on what reached the model: values hidden, messages outside AI access, messages dropped or cut, answer items not read. */
export const aiNotesSchema = z.object({
  hidden: z.number().int().min(0),
  leftOut: z.number().int().min(0),
  truncated: z.number().int().min(0),
  unreadItems: z.number().int().min(0),
});

const aiItemSchema = z.object({ text: z.string(), messages: z.array(z.number().int()) });

const aiResultBase = {
  provider: z.string(),
  model: z.string(),
  cached: z.boolean(),
  /** A cached summary whose conversation has new messages since. */
  stale: z.boolean(),
  notes: aiNotesSchema,
  citations: z.array(aiCitationSchema),
  /** ISO 8601. */
  createdAt: z.string(),
};

/** One finished AI result, text only (rendered as plain text, never HTML). */
export const aiResultViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("summary"),
    ...aiResultBase,
    decisions: z.array(aiItemSchema),
    questions: z.array(aiItemSchema),
    deadlines: z.array(aiItemSchema.extend({ date: z.string().nullable() })),
  }),
  z.object({
    kind: z.literal("ask"),
    ...aiResultBase,
    answer: z.string(),
    sources: z.array(z.number().int()),
    found: z.boolean(),
  }),
  z.object({
    kind: z.literal("tasks"),
    ...aiResultBase,
    tasks: z.array(
      z.object({
        index: z.number().int().min(0),
        title: z.string(),
        due: z.string().nullable(),
        message: z.number().int(),
        evidence: z.string(),
        /** The evidence occurs in the message sent; a miss leaves the task unticked. */
        evidenceFound: z.boolean(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("categories"),
    ...aiResultBase,
    items: z.array(z.object({ messageId: z.string(), category: categorySchema.nullable() })),
  }),
  z.object({
    kind: z.literal("digest"),
    ...aiResultBase,
    items: z.array(z.object({ threadId: z.string(), gist: z.string() })),
  }),
  z.object({
    kind: z.literal("draft"),
    ...aiResultBase,
    paragraphs: z.array(z.string()),
    /** Placeholder-like text in the answer that was not this job's: kept as written. */
    unknown: z.number().int().min(0),
    /** Hidden values the answer dropped. */
    missing: z.number().int().min(0),
  }),
]);
export type AiResultView = z.infer<typeof aiResultViewSchema>;

/** A kept task (slice 3f). `messageId` null: the message is no longer in Makosh Mail. */
export const taskViewSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  messageId: z.string().nullable(),
  threadId: z.string().nullable(),
  title: z.string(),
  /** YYYY-MM-DD. */
  due: z.string().nullable(),
  /** ISO 8601. */
  doneAt: z.string().nullable(),
  createdAt: z.string(),
  /** Slice 3g: a task from mail kept locally holds its note (plain text, never sent). */
  note: z.string().nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;

export const reminderStateSchema = z.enum(["queued", "waiting", "due", "answered", "dismissed"]);

/** A reply reminder as the Waiting-for-a-reply strip shows it. */
export const reminderViewSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  threadId: z.string().nullable(),
  state: reminderStateSchema,
  days: z.number().int(),
  /** ISO 8601. */
  sentAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  /** The first To recipient of the sent copy, when it is stored. */
  recipient: mailAddressSchema.nullable(),
  subject: z.string(),
});
export type ReminderView = z.infer<typeof reminderViewSchema>;

/** One agent-log row as the Agent activity view shows it: ids resolved to what the store holds now. */
export const logEntryViewSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  actor: z.enum(LOG_ACTORS),
  tool: z.enum(LOG_TOOLS),
  outcome: z.enum(LOG_OUTCOMES),
  threadId: z.string().nullable(),
  count: z.number().int().min(0),
  hiddenCount: z.number().int().min(0),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  messages: z.array(
    z.object({
      id: z.string(),
      /** Null: no longer in Makosh Mail. */
      subject: z.string().nullable(),
      from: z.string().nullable(),
      date: z.string().nullable(),
      accountId: z.string().nullable(),
      threadId: z.string().nullable(),
    }),
  ),
});
export type LogEntryView = z.infer<typeof logEntryViewSchema>;

export const aiScopeModeSchema = z.enum(["all", "folders", "none"]);

/** What Improve asks for (slice 3f). */
export const draftModeSchema = z.enum(["fix", "shorter", "formal", "friendly", "custom"]);

/** The AI access scope with stale folder paths marked. */
export const aiScopeViewSchema = z.object({
  accounts: z.array(
    z.object({
      accountId: z.string(),
      mode: aiScopeModeSchema,
      folders: z.array(z.object({ path: z.string(), found: z.boolean() })),
    }),
  ),
  senders: z.array(z.object({ kind: blockKindSchema, value: z.string() })),
});
export type AiScopeView = z.infer<typeof aiScopeViewSchema>;

export const categoryRuleViewSchema = z.object({
  id: z.string(),
  kind: blockKindSchema,
  value: z.string(),
  category: categorySchema,
  createdAt: z.string(),
});
export type CategoryRuleView = z.infer<typeof categoryRuleViewSchema>;
