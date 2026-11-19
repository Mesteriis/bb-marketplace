// The RPC contract between the Mail page and the server, as plain zod
// schemas. server.ts wraps it with the SDK's defineRpcContract.
import { TAB_NAME_MAX, TAB_QUERY_MAX } from "./inbox-tabs.ts";
import { PHRASES_MAX } from "./phrases.ts";
import { TEMPLATE_FILES_MAX_BYTES, TEMPLATE_RECIPIENTS_MAX } from "./snippets.ts";
import { GOOGLE_EXTRA_SCOPES } from "./plugin-access.ts";
import { pluginApiSchemas } from "./plugin-api.ts";
import { z } from "zod";
import { pageSettingsPatchSchema, pageSettingsSchema } from "./page-settings.ts";
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
  unsubscribeStateSchema,
  aiErrorKindSchema,
  aiResultViewSchema,
  aiScopeModeSchema,
  aiScopeViewSchema,
  categoryRuleViewSchema,
  categorySchema,
  logEntryViewSchema,
  reminderViewSchema,
  taskViewSchema,
  draftModeSchema,
  devClassSchema,
  attachmentMatchSchema,
  fileKindSchema,
  fileRowSchema,
  relatedHitSchema,
  savedSearchViewSchema,
  searchFieldSchema,
  searchNoteSchema,
  senderCardSchema,
} from "./model.ts";
import { languageTagSchema } from "./translate.ts";
import { DEV_KINDS, DEV_SOURCES, DEV_STATES } from "./dev-notify.ts";
import { BINDING_KINDS, RULE_RUN_STATES } from "./ports.ts";

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
/** `reason`: makosh-ai's code for an unavailable provider (slice 3f). */
const translateProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  reason: z.string().max(200).nullable(),
});
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

// ---- Agent and mail (slice 3f) ----

/** A calendar date "YYYY-MM-DD". */
const dayInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A one-line task title, 1-120 characters. */
const taskTitleInput = z.string().min(1).max(120).refine(noLineBreaks, NO_LINE_BREAKS);
/** Reminder days. */
const reminderDaysInput = z.number().int().min(1).max(30);
/** A paging cursor handed back by the server. */
const cursorInput = z.string().min(1).max(256);

/** What ai_start takes: one strict variant per request (two for tasks: one message or a conversation). */
const aiStartInput = z.union([
  z.strictObject({ kind: z.literal("summary"), threadId: idInput, folder: idInput.optional(), force: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("tasks"), messageId: idInput }),
  z.strictObject({ kind: z.literal("tasks"), threadId: idInput, folder: idInput.optional() }),
  z.strictObject({ kind: z.literal("ask"), question: z.string().min(1).max(500), accountId: idInput.optional() }),
  z.strictObject({ kind: z.literal("categories"), messageIds: z.array(idInput).min(1).max(50) }),
  z.strictObject({ kind: z.literal("digest") }),
  z.strictObject({
    kind: z.literal("draft"),
    draftId: idInput,
    revision: z.number().int().min(0),
    mode: draftModeSchema,
    instruction: z.string().min(1).max(200).refine(noLineBreaks, NO_LINE_BREAKS).optional(),
    paragraphs: z.array(z.string().max(8_000)).max(500),
  }),
]);

/** The kinds ai_start offers, read from its input union (the canary test runs each). */
export const AI_START_KINDS: readonly string[] = [
  ...new Set(aiStartInput.options.map((option) => option.shape.kind.value)),
];

const dayNoticeToken = z.string().min(1).max(64);

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


// ---- Slice 3g: BB threads, tasks, project files, dev mail, patches, alerts, binding and rules ----

/** Fixed texts of the 3g refusals (the SDK code is conflict or invalid; the text names the kind). */
export const BB_REFUSAL_TEXT = {
  out_of_scope: "Outside AI access (Mail settings)",
  no_tree: "This project has no single local checkout",
  confirm_needed: "This file name looks like it holds a secret; confirm to attach it",
  in_flight: "Already starting a thread for this message",
  not_available: "Not available yet",
  save_disabled: "Saving attachments into a project is turned off in this version: BB could not confirm the file stays inside the project",
  no_result: "This thread has no result yet",
  prompt_changed: "The prompt changed; review it again",
  busy: "Already working on this message; try again in a moment",
} as const;

/** The owner's instruction for a BB thread. */
const instructionInput = z.string().max(4_000);
/** A project-relative path or a thread storage path coming in from the page. */
const bbPathInput = z.string().min(1).max(1_024).refine(noLineBreaks, NO_LINE_BREAKS);
/** A project-relative folder (projectFolder checks it again). */
const folderInput = z.string().max(240).refine(noLineBreaks, NO_LINE_BREAKS);
const shaInput = z.string().regex(/^[0-9a-f]{64}$/);
const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
/** What a Start would send, shown before it (incident and patch dialogs). */
const preparedThreadSchema = z.object({
  prompt: z.string(),
  title: z.string(),
  hidden: z.number().int().min(0),
  /** The project's default; null: none set ("project default"). */
  permissionMode: permissionModeSchema.nullable(),
  /** SHA-256 of the title and prompt; Start passes it back. */
  promptRef: z.string(),
});
const patchHandoffInput = z.object({
  messageId: idInput,
  partId: idInput.optional(),
  projectId: idInput,
  patchRef: shaInput,
  environment: z.enum(["worktree", "checkout"]).optional(),
});
const bbFileEntrySchema = z.object({ name: z.string(), path: z.string() });
const includeSchema = z.enum(["message", "conversation"]);
const bbThreadInput = z.object({
  messageId: idInput,
  include: includeSchema,
  projectId: idInput,
  instruction: instructionInput.optional(),
});

/** One attachment saved into a project. */
export const saveResultSchema = z.discriminatedUnion("outcome", [
  z.object({ partId: z.string(), outcome: z.literal("saved"), path: z.string(), sizeBytes: z.number().int().min(0) }),
  z.object({ partId: z.string(), outcome: z.literal("exists"), path: z.string(), currentSha: z.string() }),
  z.object({ partId: z.string(), outcome: z.literal("failed"), reason: z.string().max(300) }),
]);

const devCountsSchema = z.object(Object.fromEntries(DEV_KINDS.map((kind) => [kind, z.number().int().min(0)])) as Record<(typeof DEV_KINDS)[number], z.ZodNumber>);

/** One repository (or monitoring service) of the Dev view. */
export const devGroupSchema = z.object({
  source: z.enum(DEV_SOURCES),
  repo: z.string().max(300).nullable(),
  counts: devCountsSchema,
  ciFailed: z.number().int().min(0),
  latestFailure: z.object({ messageId: z.string(), subject: z.string().max(1_000), date: z.string().nullable() }).nullable(),
  unread: z.number().int().min(0),
  total: z.number().int().min(0),
  latestDate: z.string().nullable(),
  messageIds: z.array(z.string()).max(200),
  projectId: z.string().nullable(),
  projectName: z.string().max(300).nullable(),
});

export const patchFileSchema = z.object({
  oldPath: z.string().max(4_096).nullable(),
  newPath: z.string().max(4_096).nullable(),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  status: z.enum(["added", "deleted", "renamed", "copied", "modified"]),
  binary: z.boolean(),
  symlink: z.boolean(),
  executable: z.boolean(),
  patch: z.string(),
});

export const alertViewSchema = z.object({
  source: z.string().max(200),
  name: z.string().max(200),
  state: z.enum(["firing", "resolved"]),
  severity: z.string().max(200).nullable(),
  service: z.string().max(200).nullable(),
  environment: z.string().max(200).nullable(),
  links: z.array(z.string().max(2_000)).max(5),
  alertRef: z.string().max(64),
});

const bindingKindSchema = z.enum(BINDING_KINDS);
export const bindingViewSchema = z.object({
  kind: bindingKindSchema,
  value: z.string().max(320),
  projectId: z.string(),
  projectName: z.string().max(300).nullable(),
  /** The project is no longer in BB. */
  removed: z.boolean(),
  createdAt: z.string(),
});

const ruleDevMatchSchema = z.object({
  source: z.enum(DEV_SOURCES).optional(),
  repo: z.string().min(1).max(300).optional(),
  kind: z.enum(DEV_KINDS).optional(),
  state: z.enum(DEV_STATES).optional(),
});
const ruleMatchSchema = z.object({
  from: z.array(addressInput.refine(noLineBreaks, NO_LINE_BREAKS)).max(20).optional(),
  domains: z.array(z.string().min(1).max(253).refine(noLineBreaks, NO_LINE_BREAKS)).max(20).optional(),
  list: z.string().max(200).refine(noLineBreaks, NO_LINE_BREAKS).nullable().optional(),
  subjectWords: z.array(z.string().min(1).max(60).refine(noLineBreaks, NO_LINE_BREAKS)).max(10).optional(),
  dev: ruleDevMatchSchema.nullable().optional(),
  accounts: z.array(idInput).max(50).optional(),
});
const ruleModeSchema = z.enum(["prepare", "start"]);

const filterMatchSchema = ruleMatchSchema.omit({ dev: true });
const filterActionsSchema = z.object({
  move: z.enum(["none", "archive", "trash", "folder"]),
  /** The folder's path for `move: "folder"`; null otherwise. */
  folder: z.string().min(1).max(1_000).refine(noLineBreaks, NO_LINE_BREAKS).nullable(),
  markRead: z.boolean(),
  flag: z.boolean(),
});

/** A filter from the settings form (slice 3m, core mail-filters.ts). */
export const filterInputSchema = z.object({
  id: idInput.optional(),
  name: z.string().min(1).max(80).refine(noLineBreaks, NO_LINE_BREAKS),
  enabled: z.boolean(),
  match: filterMatchSchema,
  actions: filterActionsSchema,
});

export const filterViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  match: filterMatchSchema,
  actions: filterActionsSchema,
});

/** A rule from the settings form; `mode: "start"` only with the form's confirmation. */
export const ruleInputSchema = z
  .object({
    id: idInput.optional(),
    name: z.string().min(1).max(80).refine(noLineBreaks, NO_LINE_BREAKS),
    enabled: z.boolean(),
    match: ruleMatchSchema,
    projectId: idInput,
    template: z.string().max(4_000),
    mode: ruleModeSchema,
    confirmedStart: z.boolean().optional(),
  })
  .refine((rule) => rule.mode !== "start" || rule.confirmedStart === true, {
    message: "Start mode needs the owner's confirmation",
    path: ["confirmedStart"],
  });

export const ruleViewSchema = z.object({
  id: z.string(),
  name: z.string().max(80),
  enabled: z.boolean(),
  match: ruleMatchSchema,
  projectId: z.string(),
  projectName: z.string().max(300).nullable(),
  template: z.string().max(4_000),
  mode: ruleModeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ruleRunViewSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  /** Null once the rule was deleted. */
  ruleName: z.string().max(80).nullable(),
  accountId: z.string(),
  messageId: z.string(),
  threadId: z.string().nullable(),
  state: z.enum(RULE_RUN_STATES),
  bbThreadId: z.string().nullable(),
  /** The message's subject (owner UI), empty when the message is gone. */
  subject: z.string().max(1_000),
  createdAt: z.string(),
});

// ---- Slice 3h inputs ----

/** A search query, as `search` takes it. */
const queryInput = z.string().min(1).max(500);
/** A saved search's name (saved-searches.ts SAVED_SEARCH_NAME_MAX). */
const savedSearchNameInput = z.string().min(1).max(60);
/** A folder's new name (folder-ops.ts FOLDER_NAME_MAX); folder-ops checks the rest. */
const folderNameInput = z.string().min(1).max(100);
/** A Gmail label name (labels.ts LABEL_NAME_MAX). */
const labelNameInput = z.string().min(1).max(100);
const labelListInput = z.array(labelNameInput).max(20);
/** Why a job skipped a folder or stopped early (spec resolution 6). */
const jobReasonSchema = z.enum([
  "not_synced",
  "changed",
  "search_failed",
  "time_budget",
  "cancelled",
  "connection_failed",
  "password_needed",
  "nothing_to_search",
]);
/** Why a folder cannot be renamed or deleted (folder-ops.ts FolderOpRefusal). */
const folderRefusalSchema = z.enum([
  "inbox",
  "special_use",
  "gmail_system",
  "snooze_folder",
  "has_children",
  "move_pending",
  "parent_not_selectable",
]);

/** An OpenPGP key as the page sees it (slice 3k): never the private half. */
export const pgpCertSchema = z.object({
  id: z.string(),
  kind: z.enum(["own", "contact"]),
  fingerprint: z.string(),
  addresses: z.array(z.string()),
  userIds: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  addedAt: z.string(),
  source: z.enum(["generated", "imported", "message"]),
  expired: z.boolean(),
});
export type PgpCert = z.infer<typeof pgpCertSchema>;

export const pgpImportResultSchema = z.enum(["added", "exists", "full", "unreadable", "locked", "wrong_phrase", "revoked"]);

const inviteMomentSchema = z.object({
  /** The instant, when the zone could be resolved. */
  utc: z.string().nullable(),
  /** The time as written: "2026-11-20T09:00", or "2026-11-20" for a whole day. */
  wall: z.string(),
  zone: z.string().nullable(),
  allDay: z.boolean(),
});
const invitePersonSchema = z.object({ name: z.string().nullable(), address: z.string() });
const inviteStatusSchema = z.enum(["accepted", "tentative", "declined", "needs_action", "delegated", "unknown"]);

/** A calendar invitation as the reading pane shows it (slice 3l, core calendar-invite.ts). */
export const inviteViewSchema = z.object({
  method: z.enum(["request", "cancel", "reply", "publish", "other"]),
  uid: z.string().nullable(),
  sequence: z.number().int(),
  summary: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  start: inviteMomentSchema.nullable(),
  end: inviteMomentSchema.nullable(),
  organizer: invitePersonSchema.nullable(),
  attendees: z.array(invitePersonSchema.extend({ status: inviteStatusSchema, optional: z.boolean() })),
  attendeesTotal: z.number().int(),
  recurring: z.boolean(),
  cancelled: z.boolean(),
  self: z.object({ address: z.string(), status: inviteStatusSchema }).nullable(),
});

/** One mailing list of the overview (slice 3n, core subscriptions.ts). */
export const subscriptionViewSchema = z.object({
  messageId: z.string(),
  accountId: z.string(),
  name: z.string(),
  address: z.string(),
  total: z.number().int(),
  unread: z.number().int(),
  lastDate: z.string().nullable(),
  method: z.enum(["one_click", "mailto"]).nullable(),
  /** Where the request goes: the one-click host, or the mailto address. */
  target: z.string().nullable(),
  /** May be unsubscribed together with others (false: decided in the message). */
  batch: z.boolean(),
  /** For the mailto: the exact subject and text the email carries. */
  mail: z.object({ subject: z.string(), body: z.string(), hiddenChars: z.number().int() }).nullable(),
  /** The latest request for this list, if any. */
  already: z.object({ state: unsubscribeStateSchema, at: z.string() }).nullable(),
});
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

const archiveAddressSchema = z.object({ name: z.string().nullable(), address: z.string() });
const archiveAttachmentSchema = z.object({
  partId: z.string(),
  filename: z.string().nullable(),
  mimeType: z.string(),
  size: z.number().int(),
  isInline: z.boolean(),
});

/** A local archive as its page lists it (slice 3p, core archive.ts). */
export const archiveViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The file or folder it was read from, for the owner. */
  sourcePath: z.string(),
  kind: z.enum(["mbox", "eml", "eml_dir"]),
  messages: z.number().int(),
  skipped: z.number().int(),
  /** False: the import stopped before the end of the source. */
  complete: z.boolean(),
  createdAt: z.string(),
});
export type ArchiveView = z.infer<typeof archiveViewSchema>;

export const archiveSummarySchema = z.object({
  id: z.string(),
  archiveId: z.string(),
  date: z.string().nullable(),
  from: archiveAddressSchema,
  subject: z.string(),
  snippet: z.string(),
  hasAttachments: z.boolean(),
});
export type ArchiveSummaryView = z.infer<typeof archiveSummarySchema>;

const archiveCursorSchema = z.object({ date: z.string().max(40).nullable(), id: idInput });

export const archiveMessageSchema = archiveSummarySchema.extend({
  to: z.array(archiveAddressSchema),
  cc: z.array(archiveAddressSchema),
  text: z.string().nullable(),
  html: z.string().nullable(),
  htmlTruncated: z.boolean(),
  attachments: z.array(archiveAttachmentSchema),
});
export type ArchiveMessageView = z.infer<typeof archiveMessageSchema>;

/** The plugin API (plugin-api.ts), with the one method whose answer is this file's invitation view. */
const pluginSchemas = {
  ...pluginApiSchemas,
  /** One invitation of a message plugin_invites_list returned, parsed; null when the part holds none. */
  plugin_invite_read: {
    input: z.object({ messageId: z.string() }),
    output: z.object({ invite: inviteViewSchema.nullable() }),
  },
};

const templateFileSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int() });
const templateRecipients = z.array(z.string().min(1).max(400).refine(noLineBreaks, NO_LINE_BREAKS)).max(TEMPLATE_RECIPIENTS_MAX);

export const rpcSchemas = {
  ...pluginSchemas,
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
  /** One sign-in with the saved password for an account the server stopped (retry-sign-in.ts). */
  accounts_retry_sign_in: {
    input: z.object({ accountId: z.string() }),
    output: z.object({ result: z.enum(["resumed", "refused", "unreachable", "unreadable", "sign_in_needed"]) }),
  },
  /** The plugin's settings as the settings page shows them (page-settings.ts); never the credential key. */
  settings_get: {
    input: z.object({}),
    output: pageSettingsSchema,
  },
  /** A change from the settings page: writable keys only, each within its bounds. Answers with the settings after it. */
  settings_set: {
    input: pageSettingsPatchSchema,
    output: pageSettingsSchema,
  },
  /** Starts a Google sign-in: opens the loopback listener and gives the consent page to open (google-sign-in.ts). */
  google_sign_in_start: {
    input: z.object({
      email: z.string().min(3).max(320).nullable(),
      /** More Google services for this sign-in (plugin keys); never anything but these. */
      extraScopes: z.array(z.enum(GOOGLE_EXTRA_SCOPES)).max(GOOGLE_EXTRA_SCOPES.length).optional(),
    }),
    output: z.object({ flowId: z.string(), url: z.string() }),
  },
  /** How a Google sign-in stands; an unknown flow reads as failed with "timeout". */
  google_sign_in_status: {
    input: z.object({ flowId: z.string().min(1).max(64) }),
    output: z.discriminatedUnion("state", [
      z.object({ state: z.literal("pending") }),
      z.object({ state: z.literal("done"), accountId: z.string() }),
      z.object({
        state: z.literal("failed"),
        reason: z.enum(["denied", "timeout", "mismatch", "no_refresh_token", "refused", "unreachable", "alias", "error"]),
      }),
    ]),
  },
  threads_list: {
    input: z.object({
      scope: threadScope,
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(100),
      /** Quick filters (slice 3e); absent: every thread. */
      filter: threadFilterSchema.optional(),
      /** An Inbox tab (Split Inbox); an unknown id lists the whole folder. */
      tabId: z.string().min(1).max(64).optional(),
    }),
    output: z.object({
      threads: z.array(threadSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  },
  /**
   * Typing speed: the phrases the owner writes often (their own sent mail and
   * templates), most frequent first, for the composer's grey text. The
   * owner's page only; never part of a log, an agent's read or a plugin's.
   */
  phrases_list: {
    input: z.object({}),
    output: z.object({ phrases: z.array(z.string().max(400)).max(PHRASES_MAX) }),
  },
  /** The owner's Inbox tabs in order, each with its unread conversations in the scope; `broken`: its condition no longer parses. */
  inbox_tabs_list: {
    input: z.object({ scope: threadScope, /** false: names and conditions only (Mail settings); every number is 0. */ counts: z.boolean().optional() }),
    output: z.object({
      /** Unread conversations of the whole Inbox in the scope, for the Inbox tab. */
      inboxUnread: z.number().int(),
      tabs: z.array(z.object({ id: z.string(), name: z.string(), query: z.string(), unread: z.number().int(), broken: z.boolean() })),
    }),
  },
  /** A new tab at the end (no id) or a tab's new name and condition. */
  inbox_tab_save: {
    input: z.object({
      id: z.string().min(1).max(64).optional(),
      name: z.string().min(1).max(TAB_NAME_MAX).refine(noLineBreaks, NO_LINE_BREAKS),
      query: z.string().min(1).max(TAB_QUERY_MAX).refine(noLineBreaks, NO_LINE_BREAKS),
    }),
    output: z.object({ tab: z.object({ id: z.string(), name: z.string(), query: z.string() }) }),
  },
  inbox_tab_delete: {
    input: z.object({ id: z.string().min(1).max(64) }),
    output: z.object({ ok: z.literal(true) }),
  },
  inbox_tab_move: {
    input: z.object({ id: z.string().min(1).max(64), direction: z.enum(["left", "right"]) }),
    output: z.object({ ok: z.literal(true) }),
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
      /** Slice 3h: the keyset cursor of the previous page. */
      cursor: cursorInput.nullable().optional(),
      /** Slice 3h: the owner's page also searches attachment text (spec resolution 4). */
      attachments: z.boolean().optional(),
    }),
    output: z.object({
      hits: z.array(messageSummarySchema),
      nextCursor: z.string().nullable(),
      notes: z.array(searchNoteSchema),
      attachmentMatches: z.array(attachmentMatchSchema),
    }),
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
      /** Slice 3i: the provider's results for Details, fixed-format lines (sender-check.ts authenticityLines). */
      authenticity: z
        .object({ authserv: z.string().nullable(), lines: z.array(z.string()) })
        .default({ authserv: null, lines: [] }),
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
      /** Slice 3f: remind the owner when no reply came within these days. */
      remindAfterDays: reminderDaysInput.optional(),
      /** Slice 3k: sign or encrypt this message with OpenPGP. */
      protect: z.object({ sign: z.boolean(), encrypt: z.boolean() }).optional(),
      /** Slice 3l, "Send later": the time to send, one minute to a year ahead. */
      sendAt: z.iso.datetime().optional(),
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
        z.object({
          id: z.string(),
          name: z.string(),
          doc: composeDocInputSchema,
          updatedAt: z.string(),
          /** Typing speed: what the template fills beside the body. */
          subject: z.string().nullable(),
          to: z.array(z.string()),
          cc: z.array(z.string()),
          bcc: z.array(z.string()),
          files: z.array(templateFileSchema),
        }),
      ),
    }),
  },
  /** Insert (no id) or update; `conflict` on a duplicate name. */
  template_save: {
    input: z.object({
      id: idInput.optional(),
      name: templateNameInput,
      doc: composeDocInputSchema,
      /** Typing speed. None of the four named: an existing template keeps what it has. */
      subject: z.string().max(400).refine(noLineBreaks, NO_LINE_BREAKS).optional(),
      to: templateRecipients.optional(),
      cc: templateRecipients.optional(),
      bcc: templateRecipients.optional(),
    }),
    output: z.object({ id: z.string() }),
  },
  /** A file to keep with a template; its bytes go through compose_attachment_chunk. */
  template_file_begin: {
    input: z.object({
      templateId: idInput,
      fileName: z.string().min(1).max(255).refine(noLineBreaks, NO_LINE_BREAKS),
      mimeType: z.string().min(1).max(127).refine(noLineBreaks, NO_LINE_BREAKS),
      size: z.number().int().min(1).max(TEMPLATE_FILES_MAX_BYTES),
    }),
    output: z.object({ uploadId: z.string() }),
  },
  template_file_finish: {
    input: z.object({ uploadId: idInput, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    output: z.object({ file: templateFileSchema }),
  },
  template_file_remove: {
    input: z.object({ templateId: idInput, fileId: idInput }),
    output: z.object({ removed: z.boolean() }),
  },
  /** Attaches a template's files to a draft; `leftOut` names the ones the message has no room for. */
  template_apply: {
    input: z.object({ draftId: idInput, templateId: idInput }),
    output: z.object({ attached: z.array(composeAttachmentSchema), leftOut: z.array(z.string()) }),
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
  /**
   * Slice 3n: the mailing lists the stored mail comes from, largest first
   * (never a list's own key). `messageId` is the list's newest stored message:
   * unsubscribe_run is asked with it. `truncated`: more mail than one
   * overview reads.
   */
  subscriptions_list: {
    input: z.object({ accountId: idInput.nullable() }),
    output: z.object({
      subscriptions: z.array(subscriptionViewSchema),
      truncated: z.boolean(),
    }),
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

  // ---- Agent and mail (slice 3f). Owner only, like 3b-3e: every write
  // refuses plugin callers, none is discoverable, none is a tool, CLI or
  // mention. Model calls start only here, on the owner's click. ----

  /** A cached summary, or a job to poll. Refusals: out_of_scope, rate_limited, conflict, not_found, AI error kinds. */
  ai_start: {
    input: aiStartInput,
    output: z.union([z.object({ cached: aiResultViewSchema }), z.object({ jobId: z.string() })]),
  },
  /** The result travels only here (never realtime or logs). */
  ai_poll: {
    input: z.object({ jobId: idInput }),
    output: z.object({
      state: z.enum(["running", "done", "failed", "cancelled"]),
      phase: z.enum(["planning", "reading", "writing"]).optional(),
      result: aiResultViewSchema.optional(),
      error: aiErrorKindSchema.optional(),
      /** makosh-ai's own refusal text, sanitized; only with pool_unavailable. */
      gatewayMessage: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
  },
  ai_cancel: {
    input: z.object({ jobId: idInput }),
    output: z.object({ cancelled: z.boolean() }),
  },
  /** Keeps picked tasks of a finished tasks job of this server process. */
  tasks_keep: {
    input: z.object({
      jobId: idInput,
      picks: z
        .array(z.object({ index: z.number().int().min(0).max(19), title: taskTitleInput, due: dayInput.nullable() }))
        .min(1)
        .max(20),
    }),
    output: z.object({ kept: z.number().int().min(0) }),
  },
  tasks_list: {
    input: z.object({ done: z.boolean(), cursor: cursorInput.nullable().optional() }),
    output: z.object({ tasks: z.array(taskViewSchema), next: z.string().nullable() }),
  },
  task_update: {
    input: z.object({ id: idInput, title: taskTitleInput.optional(), due: dayInput.nullable().optional(), done: z.boolean().optional() }),
    output: okOutput,
  },
  task_delete: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** Local labels only (no IMAP); `undoId` for the toast's Undo. */
  category_set: {
    input: z.object({ messageIds: messageIdList, category: categorySchema.nullable() }),
    output: z.object({ changed: z.number().int().min(0), undoId: z.string().nullable() }),
  },
  /** Accepts the suggestion shown: the model's, else the local one. */
  category_accept: {
    input: z.object({ messageIds: messageIdList }),
    output: z.object({ changed: z.number().int().min(0), undoId: z.string().nullable() }),
  },
  category_undo: {
    input: z.object({ undoId: idInput }),
    output: okOutput,
  },
  /** "Always for this sender": the message's From address or domain (never a public mail domain). */
  category_rule_add: {
    input: z.object({ messageId: idInput, kind: blockKindSchema, category: categorySchema }),
    output: z.object({ rule: categoryRuleViewSchema }),
  },
  category_rule_remove: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  category_rules_list: {
    input: z.object({}),
    output: z.object({ rules: z.array(categoryRuleViewSchema) }),
  },
  /** The Today view: local lists only. */
  today_get: {
    input: z.object({}),
    output: z.object({
      needsReply: z.array(threadSummarySchema),
      waiting: z.array(reminderViewSchema),
      tasksDue: z.array(taskViewSchema),
      since: z.object({
        notifications: z.number().int().min(0),
        newsletters: z.number().int().min(0),
        bills: z.number().int().min(0),
        bulk: z.number().int().min(0),
        personal: z.number().int().min(0),
        /** ISO 8601: the previous digest, or 24 hours ago. */
        from: z.string(),
      }),
      digestDay: z.string().nullable(),
      /** Slice 3g: the last 24 hours of dev mail. */
      dev: z.object({
        ciFailed: z.number().int().min(0),
        repos: z.number().int().min(0),
        alertsFiring: z.number().int().min(0),
      }),
      /** Slice 3g: rule runs ready to start. */
      rulesReady: z.number().int().min(0),
    }),
  },
  /** "No reply needed": by the conversation's latest message. */
  reply_dismiss: {
    input: z.object({ threadId: idInput }),
    output: okOutput,
  },
  /** On a stored Sent-role message. */
  reminder_set: {
    input: z.object({ messageId: idInput, days: reminderDaysInput }),
    output: z.object({ id: z.string() }),
  },
  reminder_snooze: {
    input: z.object({ id: idInput, days: reminderDaysInput }),
    output: okOutput,
  },
  reminder_dismiss: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  reminders_due: {
    input: z.object({}),
    output: z.object({ reminders: z.array(reminderViewSchema) }),
  },
  /** The oldest unshown notice of today, marked shown; `not_found` when none. */
  day_notice_get: {
    input: z.object({ token: dayNoticeToken.optional() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("digest"), replyCount: z.number().int().min(0) }),
      z.object({
        kind: z.literal("reminder"),
        name: z.string(),
        address: z.string(),
        accountId: z.string(),
        threadId: z.string().nullable(),
      }),
      /** Slice 3g: prepared and started rule runs since the last notice. */
      z.strictObject({ kind: z.literal("rule"), ruleName: z.string().max(80), count: z.number().int().min(1) }),
    ]),
  },
  ai_scope_get: {
    input: z.object({}),
    output: aiScopeViewSchema,
  },
  ai_scope_set: {
    input: z.object({
      accounts: z
        .array(z.object({ accountId: idInput, mode: aiScopeModeSchema, folders: z.array(idInput).max(1_000).optional() }))
        .max(100),
      senders: z.array(z.object({ kind: blockKindSchema, value: addressInput.refine(noLineBreaks, NO_LINE_BREAKS) })).max(1_000),
    }),
    output: aiScopeViewSchema,
  },
  agent_log_list: {
    input: z.object({
      threadId: idInput.optional(),
      cursor: cursorInput.nullable().optional(),
      limit: z.number().int().min(1).max(100),
    }),
    output: z.object({ entries: z.array(logEntryViewSchema), next: z.string().nullable() }),
  },
  agent_log_clear: {
    input: z.object({}),
    output: z.object({ removed: z.number().int().min(0) }),
  },
  // ---- Slice 3g ----
  projects_list: {
    input: z.object({}),
    output: z.object({
      projects: z.array(
        z.object({ id: z.string(), name: z.string(), kind: z.string(), hasTree: z.boolean(), repo: z.string().nullable() }),
      ),
    }),
  },
  /** The exact prompt the thread would start with; refusals out_of_scope, not_found. */
  bb_thread_prepare: {
    /** saveAttachments: the preview lists the files Start would save (nothing is written). */
    input: bbThreadInput.extend({ saveAttachments: z.boolean().optional() }),
    output: z.object({
      prompt: z.string(),
      title: z.string(),
      hidden: z.number().int().min(0),
      leftOut: z.number().int().min(0),
      /** The project's default; null: none set ("project default"). */
      permissionMode: permissionModeSchema.nullable(),
    }),
  },
  /** Refusals out_of_scope, not_found, no_tree (saving), conflict (in flight), failed. */
  bb_thread_start: {
    input: bbThreadInput.extend({ saveAttachments: z.boolean().optional(), ruleRunId: idInput.optional() }),
    output: z.object({ bbThreadId: z.string(), saved: z.array(saveResultSchema).optional() }),
  },
  task_targets: {
    input: z.object({}),
    output: z.object({
      taskboard: z.object({ boards: z.array(z.object({ id: z.string(), name: z.string() })) }).nullable(),
      /** Why Taskboard is not offered ("Taskboard did not answer"), null when it is. */
      reason: z.string().max(300).nullable(),
      lastBoardId: z.string().nullable(),
      target: z.enum(["auto", "taskboard", "local"]),
    }),
  },
  /** `unavailable`: Taskboard did not answer; the page offers the local task. */
  task_from_mail: {
    input: z.object({
      messageId: idInput,
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("taskboard"), boardId: idInput }),
        z.object({ kind: z.literal("local"), due: dayInput.nullable().optional() }),
      ]),
      title: z.string().min(1).max(500),
      note: z.string().max(4_000).optional(),
      excerpt: z.boolean(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("taskboard"), taskId: z.string() }),
      z.object({ kind: z.literal("local"), taskId: z.string() }),
      z.object({ kind: z.literal("unavailable"), reason: z.string().max(300) }),
    ]),
  },
  attachment_save: {
    input: z.object({
      messageId: idInput,
      partIds: z.array(idInput).min(1).max(20),
      projectId: idInput,
      folder: folderInput.optional(),
      onConflict: z.enum(["ask", "keep_both", "replace"]),
      replaceSha: shaInput.optional(),
    }),
    output: z.object({ results: z.array(saveResultSchema) }),
  },
  project_files: {
    input: z.object({ projectId: idInput, query: z.string().max(200), limit: z.number().int().min(1).max(50) }),
    output: z.object({ files: z.array(bbFileEntrySchema), truncated: z.boolean() }),
  },
  project_folders: {
    input: z.object({ projectId: idInput, query: z.string().max(200), limit: z.number().int().min(1).max(50) }),
    output: z.object({ folders: z.array(bbFileEntrySchema), truncated: z.boolean() }),
  },
  thread_files: {
    input: z.object({ bbThreadId: idInput, query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50) }),
    output: z.object({ files: z.array(bbFileEntrySchema), truncated: z.boolean() }),
  },
  bb_threads_recent: {
    input: z.object({ projectId: idInput, limit: z.number().int().min(1).max(30) }),
    output: z.object({ threads: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string().nullable() })) }),
  },
  /** Refusal confirm_needed for a secret-like name without `confirmed`. */
  compose_attach_bb: {
    input: z.object({
      draftId: idInput,
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("project"), projectId: idInput, path: bbPathInput }),
        z.object({ kind: z.literal("thread"), bbThreadId: idInput, path: bbPathInput }),
      ]),
      confirmed: z.boolean().optional(),
    }),
    output: composeAttachmentSchema,
  },
  /** A reply when Mail's own links tie the thread to a stored message, else a new draft. */
  draft_from_bb: {
    input: z.object({
      bbThreadId: idInput,
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("output") }),
        z.object({ kind: z.literal("message"), text: z.string().min(1).max(100_000) }),
      ]),
    }),
    output: z.object({ draftId: z.string(), accountId: z.string(), reply: z.boolean() }),
  },
  dev_digest_get: {
    input: z.object({
      days: z.number().int().min(1).max(30).optional(),
      accountId: idInput.optional(),
      cursor: cursorInput.nullable().optional(),
    }),
    output: z.object({ groups: z.array(devGroupSchema), next: z.string().nullable() }),
  },
  patch_view: {
    input: z.object({ messageId: idInput, partId: idInput.optional() }),
    output: z.object({
      files: z.array(patchFileSchema).max(200),
      warnings: z.array(z.string().max(500)),
      refused: z.string().max(500).nullable(),
      commitMessage: z.string().nullable(),
      patchRef: shaInput,
    }),
  },
  patch_save: {
    input: z.object({ messageId: idInput, partId: idInput.optional(), projectId: idInput, patchRef: shaInput }),
    output: z.object({ path: z.string() }),
  },
  /** `environment: "checkout"` only when the owner chose it after a worktree refusal. */
  /** The exact prompt, title, environment and permission mode patch_handoff would use; nothing is uploaded. */
  patch_handoff_prepare: {
    input: patchHandoffInput,
    output: preparedThreadSchema.extend({ environment: z.enum(["worktree", "checkout"]) }),
  },
  /** promptRef: the prepared prompt's reference; a different prompt now refuses prompt_changed. */
  patch_handoff: {
    input: patchHandoffInput.extend({ promptRef: shaInput.optional() }),
    output: z.object({ bbThreadId: z.string(), environment: z.enum(["worktree", "checkout"]) }),
  },
  alert_view: {
    input: z.object({ messageId: idInput }),
    output: z.object({
      alert: alertViewSchema.nullable(),
      incident: z.object({ bbThreadId: z.string(), title: z.string().nullable(), canAppend: z.boolean() }).nullable(),
    }),
  },
  /** The exact prompt, title and permission mode incident_start would use; nothing starts. */
  incident_prepare: {
    input: z.object({ messageId: idInput, projectId: idInput, instruction: instructionInput.optional() }),
    output: preparedThreadSchema,
  },
  /** promptRef: the prepared prompt's reference; a different prompt now refuses prompt_changed. */
  incident_start: {
    input: z.object({ messageId: idInput, projectId: idInput, instruction: instructionInput.optional(), promptRef: shaInput.optional() }),
    output: z.object({ bbThreadId: z.string() }),
  },
  incident_append: {
    input: z.object({ messageId: idInput }),
    output: z.object({ bbThreadId: z.string() }),
  },
  conversation_project_set: {
    input: z.object({ accountId: idInput, threadId: idInput, projectId: idInput.nullable() }),
    output: okOutput,
  },
  binding_add: {
    input: z.object({
      kind: bindingKindSchema,
      value: z.string().min(1).max(320).refine(noLineBreaks, NO_LINE_BREAKS),
      projectId: idInput,
    }),
    output: okOutput,
  },
  binding_remove: {
    input: z.object({ kind: bindingKindSchema, value: z.string().min(1).max(320).refine(noLineBreaks, NO_LINE_BREAKS) }),
    output: okOutput,
  },
  bindings_list: {
    input: z.object({}),
    output: z.object({ bindings: z.array(bindingViewSchema) }),
  },
  project_mail: {
    input: z.object({ projectId: idInput, cursor: cursorInput.nullable().optional() }),
    output: z.object({ threads: z.array(threadSummarySchema), next: z.string().nullable() }),
  },
  /** The thread Info section: the project's latest bound conversations and those the thread came from. */
  bb_thread_mail: {
    input: z.object({ projectId: idInput, bbThreadId: idInput }),
    output: z.object({
      bound: z.array(threadSummarySchema).max(5),
      origin: z.array(threadSummarySchema).max(5),
      total: z.number().int().min(0),
    }),
  },
  /**
   * Slice 3p: local archives, mail read from files on this machine and kept
   * apart from every mailbox. Owner only; no agent surface reads them.
   */
  archives_list: {
    input: z.object({}),
    output: z.object({ archives: z.array(archiveViewSchema) }),
  },
  /** One page, newest first; `archiveId` null: every archive. */
  archive_messages: {
    input: z.object({
      archiveId: idInput.nullable(),
      query: z.string().max(200),
      cursor: archiveCursorSchema.nullable(),
    }),
    output: z.object({ rows: z.array(archiveSummarySchema), nextCursor: archiveCursorSchema.nullable() }),
  },
  archive_message: {
    input: z.object({ id: idInput }),
    output: archiveMessageSchema,
  },
  /** A one-time URL for one attachment, read from the archive's source file. */
  archive_download_ticket: {
    input: z.object({ id: idInput, partId: z.string().min(1).max(20) }),
    output: z.object({ url: z.string(), fileName: z.string() }),
  },
  /** Removes the archive from Mail; the source file stays. */
  archive_remove: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** Slice 3m: the filters that sort new Inbox mail, in the order they apply. */
  filters_list: {
    input: z.object({}),
    output: z.object({ filters: z.array(filterViewSchema) }),
  },
  filter_save: {
    input: filterInputSchema,
    output: filterViewSchema,
  },
  filter_delete: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  rules_list: {
    input: z.object({}),
    output: z.object({ rules: z.array(ruleViewSchema) }),
  },
  rule_save: {
    input: ruleInputSchema,
    output: ruleViewSchema,
  },
  rule_delete: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** Disables every rule; `undo` enables the last paused set again. */
  rules_pause: {
    input: z.object({ undo: z.boolean().optional() }),
    output: z.object({ paused: z.number().int().min(0) }),
  },
  rule_runs_list: {
    input: z.object({ state: z.enum(RULE_RUN_STATES).optional(), cursor: cursorInput.nullable().optional() }),
    output: z.object({ runs: z.array(ruleRunViewSchema), next: z.string().nullable() }),
  },
  rule_run_dismiss: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },

  // ---- Slice 3h: server search, older mail, saved searches, folders, labels, files ----

  /** Searches the owner's own mail servers (read-only); `localOnly`: operators the server did not use. */
  server_search_start: {
    input: z.object({ query: queryInput, accountId: idInput.nullable() }),
    output: z.object({ jobId: z.string(), localOnly: z.array(searchFieldSchema) }),
  },
  /** Fetches the next 50 hits of a finished server search. */
  server_search_more: {
    input: z.object({ jobId: idInput }),
    output: okOutput,
  },
  /** Loads the next historyStepDays of one folder. */
  history_load: {
    input: z.object({ accountId: idInput, folder: idInput }),
    output: z.object({ jobId: z.string() }),
  },
  /** Loads the rest of one conversation from the server. */
  conversation_load: {
    input: z.object({ threadId: idInput }),
    output: z.object({ jobId: z.string() }),
  },
  server_job_poll: {
    input: z.object({ jobId: idInput }),
    output: z.object({
      state: z.enum(["running", "done", "failed", "cancelled"]),
      accounts: z.array(
        z.object({
          accountId: z.string(),
          searched: z.number().int().min(0),
          total: z.number().int().min(0),
          fetched: z.number().int().min(0),
          found: z.number().int().min(0),
          /** Uids left out: above last_uid, or a folder skipped (spec resolution 6). */
          skipped: z.number().int().min(0),
          partial: z.boolean(),
          reason: jobReasonSchema.nullable(),
        }),
      ),
      messageIds: z.array(z.string()),
      moreAvailable: z.boolean(),
      /** history_load: where loaded history starts now. */
      historySince: z.string().nullable().optional(),
      /** history_load: empty steps in a row (the list speaks at three). */
      emptySteps: z.number().int().min(0).optional(),
    }),
  },
  server_job_cancel: {
    input: z.object({ jobId: idInput }),
    output: okOutput,
  },
  history_forget_check: {
    input: z.object({ accountId: idInput, folder: idInput }),
    output: z.object({ count: z.number().int().min(0) }),
  },
  history_forget: {
    input: z.object({ accountId: idInput, folder: idInput }),
    output: z.object({ removed: z.number().int().min(0) }),
  },
  saved_searches_list: {
    input: z.object({}),
    output: z.object({ searches: z.array(savedSearchViewSchema).max(50) }),
  },
  saved_search_save: {
    input: z.object({
      id: idInput.optional(),
      name: savedSearchNameInput,
      query: queryInput,
      accountId: idInput.nullable(),
    }),
    output: z.object({ id: z.string() }),
  },
  saved_search_delete: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  saved_search_move: {
    input: z.object({ id: idInput, position: z.number().int().min(0).max(49) }),
    output: okOutput,
  },
  folder_create: {
    input: z.object({ accountId: idInput, parent: idInput.nullable(), name: folderNameInput }),
    output: z.object({ path: z.string() }),
  },
  folder_rename: {
    input: z.object({ accountId: idInput, path: idInput, name: folderNameInput }),
    output: z.object({ path: z.string() }),
  },
  /** The server's message count, the children and why the folder cannot go; `gmailLabel`: a plain DELETE (spec resolution 5). */
  folder_delete_check: {
    input: z.object({ accountId: idInput, path: idInput }),
    output: z.object({
      messages: z.number().int().min(0),
      children: z.number().int().min(0),
      gmailLabel: z.boolean(),
      refusal: folderRefusalSchema.nullable(),
    }),
  },
  /** Never expunges: DELETE only at 0 messages, emptying only by MOVE to Trash (Gmail labels: a plain DELETE). */
  folder_delete: {
    input: z.object({
      accountId: idInput,
      path: idInput,
      moveToTrash: z.boolean(),
      expectedMessages: z.number().int().min(0),
    }),
    output: z.object({ ok: z.boolean(), moved: z.number().int().min(0) }),
  },
  folder_subscribe: {
    input: z.object({ accountId: idInput, path: idInput, subscribed: z.boolean() }),
    output: okOutput,
  },
  /** `accountId` '*' with a role name as `path`: an All accounts view. */
  folder_prefs_set: {
    input: z.object({ accountId: idInput, path: idInput, grouping: z.boolean() }),
    output: okOutput,
  },
  /** A folder one message per row (grouping off), as threads_list. */
  messages_list: {
    input: z.object({
      scope: threadScope,
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(100),
      filter: threadFilterSchema.optional(),
    }),
    output: z.object({ messages: z.array(messageSummarySchema), nextCursor: z.string().nullable() }),
  },
  labels_list: {
    input: z.object({ accountId: idInput }),
    output: z.object({ labels: z.array(z.object({ name: z.string(), path: z.string().nullable() })) }),
  },
  labels_change: {
    input: z
      .object({
        messageIds: messageIdList,
        add: labelListInput,
        remove: labelListInput,
        undoId: z.uuid().optional(),
      })
      .refine((input) => input.add.length + input.remove.length > 0, { message: "Add or remove a label" }),
    output: z.object({ changed: z.number().int().min(0) }),
  },
  /** A one-time URL for the viewer; the server sniffs the bytes (409 not_viewable on a mismatch). */
  attachment_view_ticket: {
    input: z.object({ messageId: idInput, partId: idInput }),
    output: z.object({ url: z.string(), kind: fileKindSchema, mimeType: z.string(), size: z.number().int().min(0) }),
  },
  files_list: {
    input: z.object({
      kind: fileKindSchema.optional(),
      sender: addressInput.optional(),
      accountId: idInput.optional(),
      name: z.string().min(1).max(200).optional(),
      includeJunk: z.boolean().optional(),
      cursor: cursorInput.nullable(),
      limit: z.number().int().min(1).max(100),
    }),
    output: z.object({ files: z.array(fileRowSchema), nextCursor: z.string().nullable() }),
  },
  attachment_text_status: {
    input: z.object({}),
    output: z.object({
      indexed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      failed: z.number().int().min(0),
      pending: z.number().int().min(0),
      running: z.boolean(),
      /** The index reached ATTACHMENT_TEXT_TOTAL_MAX (spec resolution 15). */
      full: z.boolean(),
    }),
  },
  attachment_text_retry: {
    input: z.object({}),
    output: okOutput,
  },
  attachment_text_clear: {
    input: z.object({}),
    output: okOutput,
  },
  related_messages: {
    input: z.object({ messageId: idInput }),
    output: z.object({ hits: z.array(relatedHitSchema).max(10) }),
  },
  sender_card: {
    input: z.object({ address: addressInput, accountId: idInput.nullable() }),
    output: senderCardSchema,
  },
  /**
   * Slice 3i: judge the sender check of these messages from a read-only
   * header fetch (BODY.PEEK), one session per folder. Without `force` only
   * rows still `unknown` are written; `force` is Details' Check again.
   */
  sender_check_refresh: {
    input: z.object({ messageIds: z.array(idInput).min(1).max(50), force: z.boolean().optional() }),
    output: z.object({ refreshed: z.number().int().min(0), failed: z.number().int().min(0) }),
  },

  // Slice 3k: OpenPGP. Owner only. "cert" is an OpenPGP key: the outputs never
  // carry a private key except `pgp_cert_export` with a passphrase, whose
  // armor is locked by that passphrase (a backup the owner saves).
  pgp_certs_list: {
    input: z.object({}),
    output: z.object({ certs: z.array(pgpCertSchema), vaultReady: z.boolean() }),
  },
  /** Makes a key pair for one of the account's sending addresses. */
  pgp_cert_generate: {
    input: z.object({ accountId: idInput, address: addressInput.refine(noLineBreaks, NO_LINE_BREAKS) }),
    output: z.object({ cert: pgpCertSchema }),
  },
  /** Pasted armor: a public key (a contact), or a private-key backup with its passphrase (the owner's). */
  pgp_cert_import: {
    input: z.object({ armor: z.string().min(1).max(200_000), phrase: z.string().max(1024).optional() }),
    output: z.object({ result: pgpImportResultSchema, added: z.array(pgpCertSchema) }),
  },
  /** The public keys attached to or pasted into a message, saved as contact keys. */
  pgp_cert_import_message: {
    input: z.object({ messageId: idInput }),
    output: z.object({ result: pgpImportResultSchema, added: z.array(pgpCertSchema) }),
  },
  pgp_cert_remove: {
    input: z.object({ id: idInput }),
    output: okOutput,
  },
  /** The public armor; with `phrase`, an own key's private half locked by it. */
  pgp_cert_export: {
    input: z.object({ id: idInput, phrase: z.string().min(8).max(1024).optional() }),
    output: z.object({ armor: z.string(), fileName: z.string() }),
  },
  /** Whether From can sign, and the recipients Mail has no usable key for. */
  pgp_check: {
    input: z.object({
      from: addressInput.refine(noLineBreaks, NO_LINE_BREAKS),
      recipients: z.array(addressInput.refine(noLineBreaks, NO_LINE_BREAKS)).max(100),
    }),
    output: z.object({ canSign: z.boolean(), missing: z.array(z.string()) }),
  },
  /** Checks a signed message against the saved keys; fetches the message from the server. */
  pgp_verify: {
    input: z.object({ messageId: idInput }),
    output: z.object({
      state: z.enum(["valid", "invalid", "no_cert", "not_pgp", "failed"]),
      fingerprint: z.string().nullable(),
      signer: z.string().nullable(),
      fromSender: z.boolean(),
    }),
  },
  /**
   * Slice 3l: the calendar invitation a message carries, read from the server
   * for the owner's page; null when it carries none. Nothing is stored.
   */
  invite_view: {
    input: z.object({ messageId: idInput }),
    /** `answerable`: an open invitation to one of the account's addresses, outside Spam and Trash. */
    output: z.object({ invite: inviteViewSchema.nullable(), answerable: z.boolean() }),
  },
  /**
   * Slice 3l: the owner's answer to an invitation, queued as a message to the
   * organizer with the usual Undo window. Only the owner's click asks.
   */
  invite_reply: {
    input: z.object({ messageId: idInput, answer: z.enum(["accepted", "tentative", "declined"]), requestId: z.uuid() }),
    output: z.object({ outboxId: z.string(), sendAfter: z.string() }),
  },
  /** Opens an encrypted message for the owner's page; the text is never stored. */
  pgp_open: {
    input: z.object({ messageId: idInput }),
    output: z.object({
      state: z.enum(["opened", "no_cert", "not_pgp", "failed"]),
      text: z.string().nullable(),
      html: z.string().nullable(),
      attachments: z.array(z.object({ fileName: z.string(), size: z.number().int() })),
      signature: z
        .object({
          state: z.enum(["valid", "invalid", "no_cert"]),
          fingerprint: z.string().nullable(),
          signer: z.string().nullable(),
          fromSender: z.boolean(),
        })
        .nullable(),
    }),
  },
} as const;

/** The 28 owner-only methods slice 3h adds. */
export const SLICE_3H_METHODS = [
  "server_search_start",
  "server_search_more",
  "history_load",
  "conversation_load",
  "server_job_poll",
  "server_job_cancel",
  "history_forget_check",
  "history_forget",
  "saved_searches_list",
  "saved_search_save",
  "saved_search_delete",
  "saved_search_move",
  "folder_create",
  "folder_rename",
  "folder_delete_check",
  "folder_delete",
  "folder_subscribe",
  "folder_prefs_set",
  "messages_list",
  "labels_list",
  "labels_change",
  "attachment_view_ticket",
  "files_list",
  "attachment_text_status",
  "attachment_text_retry",
  "attachment_text_clear",
  "related_messages",
  "sender_card",
] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner-only method that tries a stopped account's saved password again. */
export const SIGN_IN_METHODS = ["accounts_retry_sign_in"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner-only methods of the settings page. */
/** The plugin API and the owner's methods for it (plugin-api.ts). */
export const PLUGIN_METHODS = Object.keys(pluginSchemas) as readonly (keyof typeof pluginSchemas)[];

/** The owner's methods for Inbox tabs (Split Inbox). */
export const INBOX_TAB_METHODS = ["inbox_tabs_list", "inbox_tab_save", "inbox_tab_delete", "inbox_tab_move"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner's methods of the typing-speed project. */
export const TYPING_METHODS = ["phrases_list", "template_file_begin", "template_file_finish", "template_file_remove", "template_apply"] as const satisfies readonly (keyof typeof rpcSchemas)[];

export const SETTINGS_METHODS = ["settings_get", "settings_set"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner-only methods of Google sign-in. */
export const GOOGLE_METHODS = ["google_sign_in_start", "google_sign_in_status"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The five owner-only methods slice 3p adds. */
export const SLICE_3P_METHODS = [
  "archives_list",
  "archive_messages",
  "archive_message",
  "archive_download_ticket",
  "archive_remove",
] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner-only method slice 3n adds. */
export const SLICE_3N_METHODS = ["subscriptions_list"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The three owner-only methods slice 3m adds. */
export const SLICE_3M_METHODS = ["filters_list", "filter_save", "filter_delete"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The two owner-only methods slice 3l adds. */
export const SLICE_3L_METHODS = ["invite_view", "invite_reply"] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The 9 owner-only methods slice 3k adds. */
export const SLICE_3K_METHODS = [
  "pgp_certs_list",
  "pgp_cert_generate",
  "pgp_cert_import",
  "pgp_cert_import_message",
  "pgp_cert_remove",
  "pgp_cert_export",
  "pgp_check",
  "pgp_verify",
  "pgp_open",
] as const satisfies readonly (keyof typeof rpcSchemas)[];

/** The owner-only method slice 3i adds. */
export const SLICE_3I_METHODS = ["sender_check_refresh"] as const satisfies readonly (keyof typeof rpcSchemas)[];

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

/** Realtime channel the server publishes on when a Today or reminder notice waits (slice 3f). */
export const DAY_NOTICE_CHANNEL = "mail-day";

/** Payload on DAY_NOTICE_CHANNEL: a token, nothing else. */
export const dayNoticePayloadSchema = z.strictObject({ token: dayNoticeToken });
export type DayNoticePayload = z.infer<typeof dayNoticePayloadSchema>;

// ---- Page-side types of the 3f methods (type-only for src/ui: no zod reaches the bundle) ----

/** What ai_start takes. */
export type AiStartInput = z.input<typeof aiStartInput>;
/** What ai_start answers. */
export type AiStartOutput = z.output<(typeof rpcSchemas)["ai_start"]["output"]>;
/** What ai_poll answers. */
export type AiPollOutput = z.output<(typeof rpcSchemas)["ai_poll"]["output"]>;
/** What today_get answers. */
export type TodayView = z.output<(typeof rpcSchemas)["today_get"]["output"]>;
/** What day_notice_get answers. */
export type DayNotice = z.output<(typeof rpcSchemas)["day_notice_get"]["output"]>;
/** What ai_scope_set takes. */
export type AiScopeInput = z.input<(typeof rpcSchemas)["ai_scope_set"]["input"]>;

// ---- Page-side types of the 3g methods ----

type Out<M extends keyof typeof rpcSchemas> = z.output<(typeof rpcSchemas)[M]["output"]>;
export type SaveResult = z.output<typeof saveResultSchema>;
export type DevGroup = z.output<typeof devGroupSchema>;
export type PatchFileView = z.output<typeof patchFileSchema>;
export type AlertViewOutput = z.output<typeof alertViewSchema>;
export type BindingView = z.output<typeof bindingViewSchema>;
export type RuleView = z.output<typeof ruleViewSchema>;
export type FilterView = z.output<typeof filterViewSchema>;
export type FilterInput = z.input<typeof filterInputSchema>;
export type RuleRunView = z.output<typeof ruleRunViewSchema>;
export type RuleInput = z.input<typeof ruleInputSchema>;
export type BbThreadPrepareOutput = Out<"bb_thread_prepare">;
export type TaskTargetsOutput = Out<"task_targets">;
export type PatchViewOutput = Out<"patch_view">;
export type IncidentPrepareOutput = Out<"incident_prepare">;
export type PatchHandoffPrepareOutput = Out<"patch_handoff_prepare">;
export type AlertViewResult = Out<"alert_view">;
export type ProjectListItem = Out<"projects_list">["projects"][number];

/** Any RPC method, its input as the page sends it and its output as the page reads it. */
export type RpcMethod = keyof typeof rpcSchemas;
export type RpcIn<M extends RpcMethod> = z.input<(typeof rpcSchemas)[M]["input"]>;
export type RpcOut<M extends RpcMethod> = z.output<(typeof rpcSchemas)[M]["output"]>;
