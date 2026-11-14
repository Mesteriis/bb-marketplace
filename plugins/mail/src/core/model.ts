import { z } from "zod";

/** Which server preset an account was set up with. */
export const accountPresetSchema = z.enum(["icloud", "gmail", "other"]);
export type AccountPreset = z.infer<typeof accountPresetSchema>;

export const mailAddressSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

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
});
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

/** A move the owner asks for. Delete moves to Trash; nothing is expunged. */
export const messageActionSchema = z.enum(["spam", "not_spam", "archive", "delete"]);
export type MessageAction = z.infer<typeof messageActionSchema>;

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
export type StoredAccount = Account & { passwordSealed: string };

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

/** A parsed search query: free text plus optional operators. */
export type ParsedQuery = {
  text: string;
  from?: string;
  subject?: string;
  unread?: boolean;
  after?: string;
  before?: string;
};
