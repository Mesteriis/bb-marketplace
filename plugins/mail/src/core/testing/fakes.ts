// Test doubles for the core ports. Imports only the core, so tests of any layer
// can drive core use cases without a database or an IMAP server. The in-memory
// MailStore follows the semantics the SQLite store implements:
//   - a pending desired \Seen / \Flagged value (seenDesired / flagDesired,
//     null = nothing pending) wins over server flags until cleared;
//   - beginFolderReset detaches uids but keeps message ids, upsertMessages
//     reattaches a detached row with the same non-null Message-ID, and
//     finishFolderReset deletes the rows still detached;
//   - markOpened marks every unread copy (same dedup key) read with a read
//     to push; a detached copy other than the opened row is only marked read;
//   - localFolderIndex treats a message without a date as inside the window;
//   - thread, folder, badge and search counts count distinct dedup keys, and
//     rows waiting to move out are hidden from their folder, the badge and
//     search; moves re-home rows (same id), detaching them without a uid map.
import type { ReplySource } from "../compose-reply.ts";
import type {
  ComposeAttachment,
  DraftFields,
  DraftRecord,
  DraftServerCopy,
  DraftServerCopyState,
  NewDraft,
  NewOutboxRow,
  OriginalMessage,
  OutboxRecord,
  OutboxState,
  OutgoingMessage,
  SendErrorKind,
  FetchedMessage,
  FlagChange,
  FlagIntent,
  Folder,
  InlinePart,
  MailAddress,
  MessageBody,
  MessageHeader,
  MessageSummary,
  ParsedQuery,
  RawRef,
  RemoteFolder,
  RoleCount,
  SpecialUse,
  StoredAccount,
  SyncState,
  ThreadDetail,
  ThreadingInput,
  ThreadSummary,
  ThreadFilter,
} from "../model.ts";
import { headerValue, normalizeMessageId } from "../headers.ts";
import { fileKindOf } from "../file-kinds.ts";
import type { ProposalCapRow, ProposalState } from "../agent-propose.ts";
import type { ProposalDeps } from "../agent-proposals.ts";
import { SendRateLimit, UndoneSends } from "../compose-outbox.ts";
import { TRANSLATION_CACHE_ROWS } from "../translate.ts";
import {
  CONTACT_SCAN,
  classifyBulk,
  correspondenceOf,
  messageTextMask,
  queryWords,
  rankContacts,
  type AccountCorrespondence,
  type Contact,
  type ContactMessage,
} from "../contacts.ts";
import type { ComposeDoc } from "../compose-doc.ts";
import type { SignatureDoc } from "../compose-signature.ts";
import { IDENTITIES_MAX_PER_ACCOUNT, ownerAddressSets, resolveSendCheck, type AliasRow, type InboundRow, type SendCheck } from "../identities.ts";
import { ComposeError } from "../compose.ts";
import { TEMPLATES_MAX } from "../templates.ts";
import type { UndoRow } from "../undo.ts";
import { matchesBlock, type BlockRule } from "../blocking.ts";
import type { NotifyRow } from "../notify.ts";
import { SNOOZES_MAX_PER_ACCOUNT, type SnoozeRow, type SnoozeState, type SnoozeView } from "../snooze.ts";
import type { TriageBatchState, TriageHistoryRow, TriageItemOutcome } from "../triage.ts";
import { UNSUBSCRIBE_INFO_MAX_BYTES, type UnsubscribeInfo } from "../unsubscribe.ts";
import type { WatchEnd } from "../idle-policy.ts";
import { ImapAuthError, type NewProposal, type ProposalRecord, type TemplateRecord, type TranslationRecord, type AccountWriteQueue, type MailTransport, type MessageBuilder, type OriginalReader, type OutboxNotifier, type SendResult, type SmtpConfig } from "../ports.ts";
import type { OutboxChangedPayload } from "../contract.ts";
import { snippetOf as snippetFromBody } from "../snippet.ts";
import {
  capInlineParts,
  compareFolders,
  dedupKeyOf,
  effectiveSpecialUse,
  rankRecipientSuggestions,
  UNIFIED_ROLES,
  type SuggestionEntry,
} from "../store-rules.ts";
import type {
  ChangeNotifier,
  Clock,
  ImapConfig,
  ImapGateway,
  FolderSession,
  ImapTestResult,
  MailStore,
  InboxMessage,
  NewTriageBatch,
  SecretVault,
  TriageBatchRecord,
  TriageItemRecord,
  UnsubscribeRecord,
  AiResultRecord,
  AnsweringRow,
  DigestRecord,
  NewReminder,
  NewTask,
  ReminderRecord,
  TaskRecord,
} from "../ports.ts";
import { AI_RESULT_MAX_BYTES, TASKS_OPEN_MAX } from "../ports.ts";
import { BINDINGS_MAX, INCIDENT_PENDING_PREFIX, INCIDENT_RESERVE_MS } from "../ports.ts";
import type {
  BbLinkRow,
  BindingKind,
  BindingRow,
  DevGroupRow,
  DevUnclassifiedRow,
  IncidentRow,
  NewRuleRun,
  RuleCaps,
  RuleRecord,
  RuleRunRecord,
  RuleRunState,
} from "../ports.ts";
import type { BbLinkRowKind } from "../model.ts";
import type { AttachmentTextRow, FilesFilter, SavedSearchRow, SearchOptions, SenderStats } from "../ports.ts";
import type { AttachmentMatch, FileRow, KeptState, SearchCondition, SearchCursor } from "../model.ts";
import { excerptAround, type AttachmentCandidate } from "../attachment-text.ts";
import { RELATED_CANDIDATES_MAX, type RelatedCandidate } from "../related.ts";
import { ownerLabels } from "../labels.ts";
import { renamedPath } from "../folder-ops.ts";
import { SAVED_SEARCHES_MAX } from "../saved-searches.ts";
import { filenameMatches } from "../server-search.ts";
import { normalizeListId, type DevClass } from "../dev-notify.ts";
import { RULES_MAX, RULE_READY_DAYS, RULE_RUNS_KEEP_DAYS, RULE_THREADS_KEEP_DAYS, capVerdict, type Rule } from "../mail-rules.ts";
import { INCIDENT_KEEP_DAYS } from "../alerts.ts";
import { UNKNOWN_PROJECT_DAYS } from "../projects.ts";
import { groupDevRows, pageDevGroups } from "../dev-groups.ts";
import { OPEN_AI_SCOPE, inAiScope, senderExcluded, type AccountScope, type AiScope } from "../ai-scope.ts";
import { AGENT_LOG_IDS_MAX, AGENT_LOG_KEEP_DAYS, AGENT_LOG_ROWS_MAX, type LogEntry, type LogOutcome } from "../agent-log.ts";
import type { AiCategoryAnswer } from "../ai-input.ts";
import { CATEGORY_RULES_MAX, type Category, type CategoryRule, type CategorySource, type PreviousLabel } from "../categories.ts";
import { dismissalKey, type ReplyCandidate } from "../digest.ts";
import { ANSWERED_KEEP_DAYS, REMINDERS_LIVE_MAX, dueAt, type ReminderState } from "../reminders.ts";
import { redactSecrets } from "../redact.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makeStoredAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "acc_1",
    email: "owner@example.org",
    displayName: null,
    preset: "other",
    host: "imap.example.org",
    port: 993,
    username: "owner@example.org",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSyncAt: null,
    lastError: null,
    authFailed: false,
    passwordSealed: "sealed-password",
    smtp: null,
    sentCopy: "append",
    signature: null,
    snoozeFolder: null,
    ...overrides,
  };
}

/** A fetched message as stored: Delivered-To lower case, distinct, at most 10 (as the SQLite upsert). */
function storedMessage(message: FetchedMessage): FetchedMessage {
  const copy = structuredClone(message);
  if (copy.deliveredTo !== undefined) {
    copy.deliveredTo = [...new Set(copy.deliveredTo.map((a) => a.trim().toLowerCase()).filter((a) => a !== ""))].slice(0, 10);
  }
  return copy;
}

/** The mark the store keeps for a fetched message (as the SQLite upsert). */
function bulkMarkOf(message: FetchedMessage): boolean | null {
  return message.bulkHeaders === undefined ? null : classifyBulk(message.bulkHeaders, message.from.address);
}

/** The HEADER.FIELDS block a server returns for LIST_HEADER_FIELDS: only the fields present, then a blank line. */
function listHeaderBlock(message: FetchedMessage): Uint8Array {
  const headers = message.bulkHeaders;
  const fields: [string, string | null][] = headers
    ? [
        ["List-Id", headers.listId],
        ["List-Unsubscribe", headers.listUnsubscribe],
        ["Precedence", headers.precedence],
        ["Auto-Submitted", headers.autoSubmitted],
      ]
    : [];
  const lines = fields.flatMap(([name, value]) => (value === null ? [] : [`${name}: ${value}\r\n`]));
  return new TextEncoder().encode(`${lines.join("")}\r\n`);
}

/**
 * The HEADER.FIELDS block a server returns for `fields`: the message's
 * unsubscribe header lines (in order) whose names were asked, then a blank line.
 */
function headerFieldsBlock(message: FetchedMessage, fields: readonly string[]): Uint8Array {
  const asked = new Set(fields.map((field) => field.toLowerCase()));
  const lines = (message.unsubscribeHeaders ?? [])
    .filter((line) => asked.has(line.key.toLowerCase()))
    .map((line) => `${line.key}: ${line.value}\r\n`);
  return new TextEncoder().encode(`${lines.join("")}\r\n`);
}

export function makeFetchedMessage(
  uid: number,
  overrides: Partial<FetchedMessage> = {},
): FetchedMessage {
  return {
    uid,
    messageId: `msg-${uid}@example.org`,
    inReplyTo: null,
    references: [],
    gmThreadId: null,
    gmMsgId: null,
    date: "2026-11-10T09:00:00.000Z",
    from: { name: "Sender", address: "sender@example.org" },
    to: [{ name: null, address: "owner@example.org" }],
    cc: [],
    replyTo: [],
    subject: `Invented subject ${uid}`,
    seen: false,
    flagged: false,
    size: 100,
    bodyText: `Invented body ${uid}`,
    bodyHtml: null,
    attachments: [],
    inlineParts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Small ports
// ---------------------------------------------------------------------------

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(date: Date): void {
    this.current = date;
  }
}

export class RecordingNotifier implements ChangeNotifier {
  readonly changes: string[] = [];
  mailChanged(accountId: string): void {
    this.changes.push(accountId);
  }
}

/** Seals by returning the input unchanged. */
export class IdentityVault implements SecretVault {
  seal(plain: string): string {
    return plain;
  }
  open(sealed: string): string {
    return sealed;
  }
}

// ---------------------------------------------------------------------------
// In-memory MailStore
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  accountId: string;
  folder: string;
  /** null while detached by a folder reset. */
  uid: number | null;
  message: FetchedMessage;
  isRead: boolean;
  isFlagged: boolean;
  /** Pending \Seen value to push; null when nothing is pending. */
  seenDesired: boolean | null;
  /** Pending \Flagged value to push; null when nothing is pending. */
  flagDesired: boolean | null;
  threadId: string;
  gmMsgId: string | null;
  dedupKey: string;
  movePending: string | null;
  moveFailures: number;
  inlineParts: InlinePart[];
  /** The stored bulk mark: null when not known (the fetch read no headers). */
  bulk: boolean | null;
  /** `unsubscribe_json` (slice 3e): null when not known. */
  unsubscribe: UnsubscribeInfo | null;
  /** Slice 3g: List-Id; undefined or null = unknown, '' = checked, none. */
  listId?: string | null;
  /** Slice 3g: the dev class; undefined = not classified, null = checked, none. */
  dev?: DevClass | null;
  /** Slice 3h: why a row outside the window is kept; null for a window row. */
  kept: KeptState | null;
  keptAt: string | null;
  /** Slice 3h: X-GM-LABELS as the server sent them; null when not fetched. */
  gmLabels: string[] | null;
};

type StoredSnooze = SnoozeRow & { createdAt: string; updatedAt: string };

function snoozeRowOf(row: StoredSnooze): SnoozeRow {
  return { messageId: row.messageId, accountId: row.accountId, returnTo: row.returnTo, dueAt: row.dueAt, state: row.state };
}

/** The patch without its undefined fields, so a spread leaves those alone. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

type StoreState = {
  accounts: Map<string, StoredAccount>;
  syncStates: Map<string, SyncState>;
  rows: Row[];
  nextId: number;
  /** Folders by account, in the order saved. */
  folders: Map<string, RemoteFolder[]>;
  /** `${accountId}\u0000${lowercased address}`. */
  imageSenders: Set<string>;
  drafts: Map<string, DraftRecord>;
  composeAttachments: StoredComposeAttachment[];
  outbox: Map<string, { record: OutboxRecord; mime: Uint8Array; bccHeader: string | null }>;
  proposals: Map<string, ProposalRecord>;
  /** By `${messageId}\u0000${targetLanguage}`. */
  translations: Map<string, TranslationRecord>;
  /** Alias rows (slice 3d), in insertion order. */
  identities: AliasRow[];
  /** `${accountId}\u0000${lowercased address}` → last sent (slice 3d `sent_recipients`). */
  sentRecipients: Map<string, string>;
  /** Templates by id (slice 3d). */
  templates: Map<string, TemplateRecord>;
  /** Snoozes by message id (slice 3e). */
  snoozes: Map<string, StoredSnooze>;
  /** Global block rules, oldest first. */
  blockRules: BlockRule[];
  /** By stateKey(accountId, listKey). */
  unsubscribes: Map<string, UnsubscribeRecord>;
  /** stateKey(accountId, dedupKey) → seen at. */
  spamSeen: Map<string, string>;
  triageBatches: Map<string, TriageBatchRecord>;
  triageItems: TriageItemRecord[];
  // Slice 3f.
  scopeAccounts: Map<string, AccountScope>;
  scopeSenders: { kind: "address" | "domain"; value: string }[];
  agentLog: (LogEntry & { seq: number })[];
  nextLogSeq: number;
  /** By kind and subject id. */
  aiResults: Map<string, AiResultRecord>;
  tasks: Map<string, StoredTask>;
  /** stateKey(accountId, dedupKey). */
  categories: Map<string, { category: Category; source: CategorySource; setAt: string }>;
  /** stateKey(accountId, dedupKey). */
  categorySuggestions: Map<string, AiCategoryAnswer>;
  categoryRules: CategoryRule[];
  digests: Map<string, DigestRecord>;
  /** stateKey(accountId, dedupKey) to dismissed at. */
  replyDismissals: Map<string, string>;
  reminders: Map<string, ReminderRecord>;
  // Slice 3g.
  bbLinks: BbLinkRow[];
  /** stateKey(accountId, threadId) to project id and set at. */
  conversationProjects: Map<string, { projectId: string; createdAt: string }>;
  /** `${kind}\u0000${value}`. */
  bindings: Map<string, BindingRow>;
  incidents: Map<string, IncidentRow>;
  rules: Map<string, RuleRecord>;
  ruleRuns: (RuleRunRecord & { messageKey: string })[];
  /** bb thread id to its rule thread row (review C1): never dropped with mail. */
  ruleThreads: Map<string, { ruleId: string; runId: string | null; createdAt: string }>;
  // Slice 3h.
  /** stateKey(accountId, folder): loaded history and the last daily check. */
  history: Map<string, { since: string | null; checkedAt: string | null }>;
  /** stateKey(accountId, path): grouping. */
  folderPrefs: Map<string, boolean>;
  /** In rail order. */
  savedSearches: SavedSearchRow[];
  /** `${messageId}\u0000${partId}`. */
  attachmentText: Map<string, AttachmentTextRow>;
};

type StoredTask = Omit<TaskRecord, "threadId">;

/** Digests and reply dismissals kept by the daily purge (as SQLite). */
const DAY_ROWS_KEEP_DAYS = 60;

type StoredComposeAttachment = ComposeAttachment & {
  draftId: string;
  sha256: string;
  data: Uint8Array;
  contentId: string | null;
  position: number;
};

function outboxOrder(a: OutboxRecord, b: OutboxRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function dueOrder(a: OutboxRecord, b: OutboxRecord): number {
  const byDue = Date.parse(a.sendAfter) - Date.parse(b.sendAfter);
  return byDue !== 0 ? byDue : outboxOrder(a, b);
}

function normalizeIso(date: string): string | null {
  const time = Date.parse(date);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isoOrNull(date: string | null): string | null {
  return date === null ? null : normalizeIso(date);
}

const MOVE_MAX_FAILURES = 3;

function stateKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

function timeOf(date: string | null): number | null {
  if (date === null) return null;
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : null;
}

/** The stored info: null over the size cap (as the SQLite upsert). */
function storedUnsubscribe(info: UnsubscribeInfo | null): UnsubscribeInfo | null {
  if (info === null) return null;
  return new TextEncoder().encode(JSON.stringify(info)).length > UNSUBSCRIBE_INFO_MAX_BYTES ? null : structuredClone(info);
}

function snippetOf(message: FetchedMessage): string {
  return snippetFromBody(message.bodyText, message.bodyHtml);
}

function translationKey(messageId: string, targetLanguage: string): string {
  return `${messageId}\u0000${targetLanguage}`;
}

/** What a slice 3h gateway command answers until Task 5 implements it. */
const NOT_YET = "Not available yet";

export class InMemoryMailStore implements MailStore {
  private state: StoreState = {
    accounts: new Map(),
    syncStates: new Map(),
    rows: [],
    nextId: 1,
    folders: new Map(),
    imageSenders: new Set(),
    drafts: new Map(),
    composeAttachments: [],
    outbox: new Map(),
    proposals: new Map(),
    translations: new Map(),
    identities: [],
    sentRecipients: new Map(),
    templates: new Map(),
    snoozes: new Map(),
    blockRules: [],
    unsubscribes: new Map(),
    spamSeen: new Map(),
    triageBatches: new Map(),
    triageItems: [],
    scopeAccounts: new Map(),
    scopeSenders: [],
    agentLog: [],
    nextLogSeq: 1,
    aiResults: new Map(),
    tasks: new Map(),
    categories: new Map(),
    categorySuggestions: new Map(),
    categoryRules: [],
    digests: new Map(),
    replyDismissals: new Map(),
    reminders: new Map(),
    bbLinks: [],
    conversationProjects: new Map(),
    bindings: new Map(),
    incidents: new Map(),
    rules: new Map(),
    ruleRuns: [],
    ruleThreads: new Map(),
    history: new Map(),
    folderPrefs: new Map(),
    savedSearches: [],
    attachmentText: new Map(),
  };
  /** The installed AI scope and its excluded conversations: memory only, as SQLite's. */
  private aiScope: AiScope = OPEN_AI_SCOPE;
  private excludedThreads: ReadonlySet<string> = new Set();
  /** New rows or threads since the excluded conversations were built (rebuilt on the next scope read). */
  private excludedStale = false;

  /** Runs fn; on a throw restores the state from before the call, like a rollback. */
  transaction<T>(fn: () => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return fn();
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  // Accounts ---------------------------------------------------------------

  listAccounts(): StoredAccount[] {
    return [...this.state.accounts.values()].map((a) => ({ ...a }));
  }

  getAccount(id: string): StoredAccount | null {
    const account = this.state.accounts.get(id);
    return account ? { ...account } : null;
  }

  findAccountByEmail(email: string): StoredAccount | null {
    const wanted = email.toLowerCase();
    const account = [...this.state.accounts.values()].find(
      (a) => a.email.toLowerCase() === wanted,
    );
    return account ? { ...account } : null;
  }

  saveAccount(account: StoredAccount): void {
    this.state.accounts.set(account.id, { ...account });
  }

  recordSyncResult(
    id: string,
    result: { lastSyncAt: string | null; lastError: string | null; authFailed: boolean },
  ): void {
    const account = this.state.accounts.get(id);
    if (account) this.state.accounts.set(id, { ...account, ...result });
  }

  deleteAccount(id: string): void {
    this.state.accounts.delete(id);
    for (const key of [...this.state.syncStates.keys()]) {
      if (key.startsWith(`${id}\u0000`)) this.state.syncStates.delete(key);
    }
    this.state.rows = this.state.rows.filter((r) => r.accountId !== id);
    this.state.folders.delete(id);
    for (const key of [...this.state.imageSenders]) {
      if (key.startsWith(`${id}\u0000`)) this.state.imageSenders.delete(key);
    }
    for (const draft of [...this.state.drafts.values()]) {
      if (draft.accountId === id) this.deleteDraft(draft.id);
    }
    for (const [key, entry] of [...this.state.outbox]) {
      if (entry.record.accountId === id) this.state.outbox.delete(key);
    }
    for (const [key, proposal] of [...this.state.proposals]) {
      if (proposal.accountId === id) this.state.proposals.delete(key);
    }
    this.state.identities = this.state.identities.filter((row) => row.accountId !== id);
    for (const key of [...this.state.sentRecipients.keys()]) {
      if (key.startsWith(`${id}\u0000`)) this.state.sentRecipients.delete(key);
    }
    for (const map of [this.state.unsubscribes, this.state.spamSeen]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${id}\u0000`)) map.delete(key);
    }
    for (const [key, snooze] of [...this.state.snoozes]) if (snooze.accountId === id) this.state.snoozes.delete(key);
    // Block rules are global: they stay (spec resolution 5).
    this.state.triageItems = this.state.triageItems.filter((item) => item.accountId !== id);
    const withItems = new Set(this.state.triageItems.map((item) => item.batchId));
    for (const batchId of [...this.state.triageBatches.keys()]) {
      if (!withItems.has(batchId)) this.state.triageBatches.delete(batchId);
    }
    // Slice 3f: the per-account rows; the log, sender rules, category rules and digests stay.
    this.state.scopeAccounts.delete(id);
    for (const [key, row] of [...this.state.aiResults]) if (row.accountId === id) this.state.aiResults.delete(key);
    for (const [key, task] of [...this.state.tasks]) if (task.accountId === id) this.state.tasks.delete(key);
    for (const map of [this.state.categories, this.state.categorySuggestions, this.state.replyDismissals] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${id}\u0000`)) map.delete(key);
    }
    for (const [key, row] of [...this.state.reminders]) if (row.accountId === id) this.state.reminders.delete(key);
    // Slice 3g: bindings, incidents and rules are not per account and stay.
    this.state.bbLinks = this.state.bbLinks.filter((link) => link.accountId !== id);
    for (const key of [...this.state.conversationProjects.keys()]) {
      if (key.startsWith(`${id}\u0000`)) this.state.conversationProjects.delete(key);
    }
    // Rule runs stay for the caps, without their messages (review C1).
    for (const run of this.state.ruleRuns) if (run.accountId === id) run.messageId = null;
    // Slice 3h: saved searches and prefs of the account; attachment text goes with its messages.
    this.state.savedSearches = this.state.savedSearches.filter((row) => row.accountId !== id);
    for (const map of [this.state.history, this.state.folderPrefs] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${id}\u0000`)) map.delete(key);
    }
    this.dropOrphanTranslations();
  }

  // Sync state -------------------------------------------------------------

  getSyncState(accountId: string, folder: string): SyncState | null {
    const state = this.state.syncStates.get(stateKey(accountId, folder));
    return state ? { ...state } : null;
  }

  saveSyncState(accountId: string, folder: string, state: SyncState): void {
    this.state.syncStates.set(stateKey(accountId, folder), { ...state });
  }

  beginFolderReset(accountId: string, folder: string): void {
    for (const row of this.folderRows(accountId, folder)) row.uid = null;
  }

  finishFolderReset(accountId: string, folder: string): number {
    const before = this.state.rows.length;
    this.state.rows = this.state.rows.filter(
      (r) => !(r.accountId === accountId && r.folder === folder && r.uid === null),
    );
    this.dropOrphanTranslations();
    return before - this.state.rows.length;
  }

  detachedRows(accountId: string, folder: string): { id: string; messageId: string | null; gmMsgId: string | null }[] {
    return this.folderRows(accountId, folder)
      .filter((r) => r.uid === null)
      .map((r) => ({ id: r.id, messageId: r.message.messageId, gmMsgId: r.gmMsgId }));
  }

  // Messages ---------------------------------------------------------------

  upsertMessages(
    accountId: string,
    folder: string,
    messages: FetchedMessage[],
    opts?: { kept?: "history" | "search" },
  ): { inserted: string[]; returning: string[] } {
    this.excludedStale = true;
    const inserted: string[] = [];
    const returning: string[] = [];
    const junk = this.roleOf(accountId, folder) === "junk";
    for (const message of messages) {
      const rows = this.folderRows(accountId, folder);
      const row =
        rows.find((r) => r.uid === message.uid) ??
        (message.gmMsgId === null
          ? undefined
          : rows.find((r) => r.uid === null && r.gmMsgId === message.gmMsgId)) ??
        (message.messageId === null
          ? undefined
          : rows.find((r) => r.uid === null && r.message.messageId === message.messageId));
      const inlineParts = capInlineParts(message.inlineParts).map((p) => structuredClone(p));
      if (row) {
        const known = row.message.deliveredTo;
        row.uid = message.uid;
        row.message = storedMessage(message);
        // A fetch without headers leaves a known Delivered-To alone (as SQLite's COALESCE).
        if (row.message.deliveredTo === undefined && known !== undefined) row.message.deliveredTo = known;
        row.isRead = row.seenDesired ?? message.seen;
        row.isFlagged = row.flagDesired ?? message.flagged;
        row.gmMsgId = message.gmMsgId ?? row.gmMsgId;
        row.dedupKey = dedupKeyOf(row.gmMsgId, message.messageId, message.size, row.id);
        row.inlineParts = inlineParts;
        row.bulk = bulkMarkOf(message);
        if (message.unsubscribe !== undefined) row.unsubscribe = storedUnsubscribe(message.unsubscribe);
        // Slice 3g: List-Id and dev class only where still unknown (as SQLite).
        const listId = listIdOf(message);
        if (listId !== undefined && (row.listId === undefined || row.listId === null)) row.listId = listId;
        if (message.dev !== undefined && row.dev === undefined) row.dev = message.dev === null ? null : { ...message.dev };
        if (junk) this.markSpamSeen(row);
        // Slice 3h: never downgraded; a server hit covered by a history load becomes history.
        if (opts?.kept === "history" && row.kept === "search") {
          row.kept = "history";
          row.keptAt = new Date().toISOString();
        }
        continue;
      }
      const id = `m_${this.state.nextId++}`;
      const dedupKey = dedupKeyOf(message.gmMsgId, message.messageId, message.size, id);
      inserted.push(id);
      if (this.state.rows.some((r) => r.accountId === accountId && r.dedupKey === dedupKey)) returning.push(id);
      this.state.rows.push({
        id,
        accountId,
        folder,
        uid: message.uid,
        message: storedMessage(message),
        isRead: message.seen,
        isFlagged: message.flagged,
        seenDesired: null,
        flagDesired: null,
        threadId: `t_${id}`,
        gmMsgId: message.gmMsgId,
        dedupKey,
        movePending: null,
        moveFailures: 0,
        inlineParts,
        bulk: bulkMarkOf(message),
        unsubscribe: message.unsubscribe === undefined ? null : storedUnsubscribe(message.unsubscribe),
        ...(listIdOf(message) === undefined ? {} : { listId: listIdOf(message) }),
        ...(message.dev === undefined ? {} : { dev: message.dev === null ? null : { ...message.dev } }),
        kept: opts?.kept ?? null,
        keptAt: opts?.kept === undefined ? null : new Date().toISOString(),
        gmLabels: null,
      });
      if (junk) this.markSpamSeen(this.state.rows[this.state.rows.length - 1]!);
    }
    return { inserted, returning };
  }

  localFolderIndex(
    accountId: string,
    folder: string,
    sinceIso: string,
  ): { uid: number; id: string }[] {
    const since = Date.parse(sinceIso);
    return this.attachedRows(accountId, folder)
      .filter((r) => {
        const time = timeOf(r.message.date);
        return time === null || time >= since;
      })
      .map((r) => ({ uid: r.uid, id: r.id }));
  }

  applyFlags(
    accountId: string,
    folder: string,
    flags: { uid: number; seen: boolean; flagged: boolean; gmMsgId?: string | null }[],
  ): number {
    let changed = 0;
    for (const flag of flags) {
      const row = this.attachedRows(accountId, folder).find((r) => r.uid === flag.uid);
      if (!row) continue;
      const isRead = row.seenDesired ?? flag.seen;
      const isFlagged = row.flagDesired ?? flag.flagged;
      let rowChanged = false;
      if (row.isRead !== isRead || row.isFlagged !== isFlagged) {
        row.isRead = isRead;
        row.isFlagged = isFlagged;
        rowChanged = true;
      }
      if (flag.gmMsgId !== undefined && flag.gmMsgId !== null) {
        const key = dedupKeyOf(flag.gmMsgId, null, row.message.size, row.id);
        if (row.gmMsgId !== flag.gmMsgId || row.dedupKey !== key) {
          row.gmMsgId = flag.gmMsgId;
          row.dedupKey = key;
          rowChanged = true;
        }
      }
      if (rowChanged) changed++;
    }
    return changed;
  }

  deleteByUids(accountId: string, folder: string, uids: number[]): number {
    const doomed = new Set(uids);
    const before = this.state.rows.length;
    this.state.rows = this.state.rows.filter(
      (r) =>
        !(r.accountId === accountId && r.folder === folder && r.uid !== null && doomed.has(r.uid)),
    );
    this.dropOrphanTranslations();
    return before - this.state.rows.length;
  }

  bulkUnknown(
    accountId: string,
    folder: string,
    belowUid: number | null,
    limit: number,
  ): { uid: number; fromAddress: string }[] {
    if (limit <= 0) return [];
    return this.attachedRows(accountId, folder)
      .filter((r) => r.bulk === null && (belowUid === null || r.uid < belowUid))
      .sort((a, b) => b.uid - a.uid)
      .slice(0, limit)
      .map((r) => ({ uid: r.uid, fromAddress: r.message.from.address }));
  }

  fillBulk(accountId: string, folder: string, uidValidity: number, marks: { uid: number; bulk: boolean }[]): number {
    if (this.getSyncState(accountId, folder)?.uidValidity !== uidValidity) return 0;
    let changed = 0;
    for (const mark of marks) {
      const row = this.attachedRows(accountId, folder).find((r) => r.uid === mark.uid);
      if (row === undefined || row.bulk !== null) continue;
      row.bulk = mark.bulk;
      changed++;
    }
    return changed;
  }

  /** Test inspection: the bulk mark of every attached row of the folder, by uid. */
  bulkMarks(accountId: string, folder: string): Map<number, boolean | null> {
    return new Map(
      this.attachedRows(accountId, folder)
        .sort((a, b) => a.uid - b.uid)
        .map((r) => [r.uid, r.bulk]),
    );
  }

  setDesired(messageIds: string[], change: FlagChange): { accountId: string }[] {
    const accounts: string[] = [];
    for (const id of messageIds) {
      const row = this.state.rows.find((r) => r.id === id);
      if (!row) continue;
      if (!accounts.includes(row.accountId)) accounts.push(row.accountId);
      for (const copy of this.state.rows) {
        if (copy.accountId !== row.accountId || copy.dedupKey !== row.dedupKey) continue;
        // The named row keeps its intent even when detached (pushed after
        // reattach); another detached copy drops a differing stale intent.
        const pushes = copy.uid !== null || copy === row;
        if (change.seen !== undefined) {
          copy.isRead = change.seen;
          if (pushes) copy.seenDesired = change.seen;
          else if (copy.seenDesired !== null && copy.seenDesired !== change.seen) copy.seenDesired = null;
        }
        if (change.flagged !== undefined) {
          copy.isFlagged = change.flagged;
          if (pushes) copy.flagDesired = change.flagged;
          else if (copy.flagDesired !== null && copy.flagDesired !== change.flagged) copy.flagDesired = null;
        }
      }
    }
    this.promoteKept(messageIds);
    return accounts.map((accountId) => ({ accountId }));
  }

  pendingFlagIntents(accountId: string, folder: string): FlagIntent[] {
    return this.attachedRows(accountId, folder)
      .filter((r) => r.seenDesired !== null || r.flagDesired !== null)
      .sort((a, b) => a.uid - b.uid)
      .map((r) => ({ uid: r.uid, seen: r.seenDesired, flagged: r.flagDesired }));
  }

  clearFlagIntents(accountId: string, folder: string, pushed: FlagIntent[]): void {
    for (const intent of pushed) {
      const row = this.attachedRows(accountId, folder).find((r) => r.uid === intent.uid);
      if (!row) continue;
      if (intent.seen !== null && row.seenDesired === intent.seen) row.seenDesired = null;
      if (intent.flagged !== null && row.flagDesired === intent.flagged) row.flagDesired = null;
    }
  }

  markOpened(messageId: string): { accountId: string } | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row) return null;
    for (const copy of this.state.rows) {
      if (copy.accountId !== row.accountId || copy.dedupKey !== row.dedupKey || copy.isRead) continue;
      copy.isRead = true;
      copy.seenDesired = copy.uid !== null || copy === row ? true : null;
    }
    this.promoteKept([messageId]);
    return { accountId: row.accountId };
  }

  // Threads ----------------------------------------------------------------

  threadingInputs(accountId: string): ThreadingInput[] {
    return this.state.rows
      .filter((r) => r.accountId === accountId)
      .map((r) => ({
        id: r.id,
        messageId: r.message.messageId,
        inReplyTo: r.message.inReplyTo,
        references: [...r.message.references],
        subject: r.message.subject,
        date: r.message.date,
        gmThreadId: r.message.gmThreadId,
      }));
  }

  assignThreads(accountId: string, threadOf: Map<string, string>): void {
    this.excludedStale = true;
    for (const row of this.state.rows) {
      if (row.accountId !== accountId) continue;
      row.threadId = threadOf.get(row.id) ?? `t_${row.id}`;
    }
  }

  listThreads(
    accountId: string,
    folder: string,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    const all = this.threadSummaries(accountId, folder, filter);
    const offset = cursor === null ? 0 : Number(cursor);
    const threads = all.slice(offset, offset + limit);
    const next = offset + threads.length;
    return { threads, nextCursor: next < all.length ? String(next) : null };
  }

  listThreadsAll(
    role: SpecialUse,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    if (role === "all") return { threads: [], nextCursor: null };
    const inRole = (r: Row) => r.movePending === null && this.roleOf(r.accountId, r.folder) === role;
    const listed = new Set(this.state.rows.filter(this.member(inRole, filter)).map((r) => r.threadId));
    const groups = new Map<string, Row[]>();
    for (const row of this.state.rows) {
      if (!listed.has(row.threadId)) continue;
      const group = groups.get(row.threadId);
      if (group) group.push(row);
      else groups.set(row.threadId, [row]);
    }
    // Newest first, undated last, then id descending (the SQLite keyset order).
    const all = [...groups.entries()]
      .map(([id, rows]) => this.summarize(id, rows, inRole))
      .sort((a, b) => {
        const byDate = (timeOf(b.lastDate) ?? -Infinity) - (timeOf(a.lastDate) ?? -Infinity);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    const offset = cursor === null ? 0 : Number(cursor);
    const threads = all.slice(offset, offset + limit);
    const next = offset + threads.length;
    return { threads, nextCursor: next < all.length ? String(next) : null };
  }

  listRoles(): RoleCount[] {
    return UNIFIED_ROLES.map((role) => {
      const rows = this.state.rows.filter(
        (r) => r.movePending === null && this.roleOf(r.accountId, r.folder) === role,
      );
      const key = (r: Row) => `${r.accountId}\u0000${r.dedupKey}`;
      return {
        role,
        unreadCount: new Set(rows.filter((r) => !r.isRead).map(key)).size,
        totalCount: new Set(rows.map(key)).size,
      };
    });
  }

  rawRef(messageId: string): RawRef | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row || row.uid === null || row.movePending !== null) return null;
    return {
      accountId: row.accountId,
      folder: row.folder,
      uid: row.uid,
      size: row.message.size,
      messageId: row.message.messageId,
      uidValidity: this.getSyncState(row.accountId, row.folder)?.uidValidity ?? null,
    };
  }

  getThread(threadId: string, folder: string): ThreadDetail | null {
    const rows = this.state.rows.filter((r) => r.threadId === threadId);
    if (rows.length === 0) return null;
    const thread = this.summarize(threadId, rows, this.inFolder(folder));
    const messages = this.onePerKey(rows, (r) => r.dedupKey, folder)
      .sort(oldestFirst)
      .map((r) => this.header(r));
    return { thread, messages, project: null, projectSuggestion: null };
  }

  getMessage(messageId: string): MessageHeader | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    return row ? this.header(row) : null;
  }

  getBody(messageId: string): MessageBody | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row) return null;
    return {
      messageId: row.id,
      text: row.message.bodyText,
      html: row.message.bodyHtml,
      htmlTruncated: false,
      codeBlocks: [],
      remoteImagesAllowed: this.isImageSenderAllowed(row.accountId, row.message.from.address),
    };
  }

  search(query: ParsedQuery, accountId: string | null, limit: number, opts?: SearchOptions): MessageSummary[] {
    return this.searchPage(query, accountId, limit, opts).hits;
  }

  /** Snippets here are computed on read, so nothing stored can be stale. */
  repairSnippets(): number {
    return 0;
  }

  // Compose and send (slice 3b) ----------------------------------------------

  createDraft(input: NewDraft): DraftRecord {
    const record: DraftRecord = {
      ...structuredClone(input),
      purpose: input.purpose ?? null,
      revision: 1,
      serverState: input.serverCopy === null ? "none" : "saved",
      updatedAt: input.createdAt,
    };
    this.state.drafts.set(record.id, record);
    return structuredClone(record);
  }

  getDraft(id: string): DraftRecord | null {
    const draft = this.state.drafts.get(id);
    return draft ? structuredClone(draft) : null;
  }

  saveDraft(
    id: string,
    baseRevision: number,
    fields: DraftFields,
    updatedAt: string,
  ): { revision: number } | { conflict: true; revision: number } {
    const draft = this.state.drafts.get(id);
    if (!draft) throw new Error("Draft not found");
    if (draft.revision !== baseRevision || this.draftHeld(id)) {
      return { conflict: true, revision: draft.revision };
    }
    Object.assign(draft, structuredClone(fields), {
      revision: draft.revision + 1,
      importHtml: null,
      updatedAt,
    });
    return { revision: draft.revision };
  }

  saveImport(id: string, baseRevision: number, doc: DraftFields["doc"]): { revision: number } | { conflict: true; revision: number } {
    const draft = this.state.drafts.get(id);
    if (!draft) throw new Error("Draft not found");
    if (draft.revision !== baseRevision || draft.importHtml === null || this.draftHeld(id)) {
      return { conflict: true, revision: draft.revision };
    }
    Object.assign(draft, { doc: structuredClone(doc), importHtml: null });
    return { revision: draft.revision };
  }

  deleteDraft(id: string): void {
    this.state.drafts.delete(id);
    this.state.composeAttachments = this.state.composeAttachments.filter((a) => a.draftId !== id);
  }

  listDrafts(accountId: string): DraftRecord[] {
    return [...this.state.drafts.values()]
      .filter((d) => d.accountId === accountId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((d) => structuredClone(d));
  }

  draftForServerCopy(accountId: string, folder: string, uid: number): string | null {
    for (const draft of this.state.drafts.values()) {
      const copy = draft.serverCopy;
      if (draft.accountId === accountId && copy?.folder === folder && copy.uid === uid) return draft.id;
    }
    return null;
  }

  draftContinuing(sourceMessageId: string): string | null {
    const found = [...this.state.drafts.values()]
      .filter((d) => d.kind === "new" && d.sourceMessageId === sourceMessageId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return found[0]?.id ?? null;
  }

  renewMessageId(id: string, messageId: string): void {
    const draft = this.state.drafts.get(id);
    if (draft) draft.messageId = messageId;
  }

  recordServerCopy(id: string, copy: DraftServerCopy | null): void {
    const draft = this.state.drafts.get(id);
    if (!draft) return;
    draft.serverCopy = copy === null ? null : { ...copy };
    draft.serverState = copy === null ? "none" : "saved";
  }

  setServerCopyState(id: string, state: DraftServerCopyState): void {
    const draft = this.state.drafts.get(id);
    if (draft) draft.serverState = state;
  }

  addAttachment(
    draftId: string,
    input: {
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
      data: Uint8Array;
      contentId?: string | null;
      origin?: string | null;
    },
  ): ComposeAttachment {
    if (!this.state.drafts.has(draftId)) throw new Error("Draft not found");
    const own = this.state.composeAttachments.filter((a) => a.draftId === draftId);
    const stored: StoredComposeAttachment = {
      id: `att_${this.state.nextId++}`,
      draftId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      sha256: input.sha256,
      data: input.data.slice(),
      contentId: input.contentId ?? null,
      origin: input.origin ?? null,
      position: own.reduce((max, a) => Math.max(max, a.position), -1) + 1,
    };
    this.state.composeAttachments.push(stored);
    return { id: stored.id, fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, origin: stored.origin };
  }

  listAttachments(draftId: string): ComposeAttachment[] {
    return this.draftAttachments(draftId).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      origin: a.origin,
    }));
  }

  attachmentData(
    draftId: string,
  ): (ComposeAttachment & { data: Uint8Array; sha256: string; contentId: string | null })[] {
    return this.draftAttachments(draftId).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      sha256: a.sha256,
      contentId: a.contentId,
      origin: a.origin,
      data: a.data.slice(),
    }));
  }

  removeAttachment(draftId: string, attachmentId: string): boolean {
    const before = this.state.composeAttachments.length;
    this.state.composeAttachments = this.state.composeAttachments.filter(
      (a) => !(a.draftId === draftId && a.id === attachmentId),
    );
    return this.state.composeAttachments.length < before;
  }

  queueOutbox(
    input: NewOutboxRow,
    draftBaseRevision: number,
  ): { row: OutboxRecord; created: boolean } | { conflict: true } {
    const existing = this.state.outbox.get(input.id);
    if (existing) return { row: structuredClone(existing.record), created: false };
    if (input.draftId !== null) {
      const draft = this.state.drafts.get(input.draftId);
      if (!draft || draft.revision !== draftBaseRevision || this.draftHeld(input.draftId)) {
        return { conflict: true };
      }
    }
    const { mime, bccHeader, ...rest } = input;
    const record: OutboxRecord = {
      ...structuredClone(rest),
      state: "queued",
      attempts: 0,
      errorKind: null,
      rejected: [],
      updatedAt: input.createdAt,
    };
    this.state.outbox.set(input.id, { record, mime: mime.slice(), bccHeader });
    return { row: structuredClone(record), created: true };
  }

  getOutbox(id: string): OutboxRecord | null {
    const entry = this.state.outbox.get(id);
    return entry ? structuredClone(entry.record) : null;
  }

  listOutbox(accountId: string | null): OutboxRecord[] {
    return [...this.state.outbox.values()]
      .map((e) => e.record)
      .filter((r) => accountId === null || r.accountId === accountId)
      .sort(outboxOrder)
      .map((r) => structuredClone(r));
  }

  outboxPayload(id: string): { mime: Uint8Array; bccHeader: string | null } | null {
    const entry = this.state.outbox.get(id);
    return entry ? { mime: entry.mime.slice(), bccHeader: entry.bccHeader } : null;
  }

  transitionOutbox(
    id: string,
    from: OutboxState[],
    to: OutboxState,
    patch: {
      errorKind?: SendErrorKind | null;
      rejected?: string[];
      sendAfter?: string;
      countAttempt?: boolean;
      updatedAt?: string;
    } = {},
  ): boolean {
    const entry = this.state.outbox.get(id);
    if (!entry || !from.includes(entry.record.state)) return false;
    const record = entry.record;
    if (to === "sent") {
      // sent_recipients: every accepted envelope recipient (slice 3d).
      const refused = new Set((patch.rejected ?? record.rejected).map((a) => a.trim().toLowerCase()));
      for (const address of record.envelopeTo) {
        const key = address.trim().toLowerCase();
        if (!refused.has(key)) this.state.sentRecipients.set(`${record.accountId}\u0000${key}`, patch.updatedAt ?? record.updatedAt);
      }
    }
    record.state = to;
    if (patch.errorKind !== undefined) record.errorKind = patch.errorKind;
    if (patch.rejected !== undefined) record.rejected = [...patch.rejected];
    if (patch.sendAfter !== undefined) record.sendAfter = patch.sendAfter;
    if (patch.countAttempt) record.attempts++;
    if (patch.updatedAt !== undefined) record.updatedAt = patch.updatedAt;
    return true;
  }

  deleteOutbox(id: string, from: OutboxState[]): boolean {
    const entry = this.state.outbox.get(id);
    if (!entry || !from.includes(entry.record.state)) return false;
    this.state.outbox.delete(id);
    return true;
  }

  private dueOutbox(nowIso: string, busyAccounts: string[], onlyId?: string): OutboxRecord | undefined {
    const now = Date.parse(nowIso);
    return [...this.state.outbox.values()]
      .map((e) => e.record)
      .filter(
        (r) =>
          r.state === "queued" &&
          Date.parse(r.sendAfter) <= now &&
          !busyAccounts.includes(r.accountId) &&
          (onlyId === undefined || r.id === onlyId),
      )
      .sort(dueOrder)[0];
  }

  nextDueOutbox(nowIso: string, busyAccounts: string[]): OutboxRecord | null {
    const due = this.dueOutbox(nowIso, busyAccounts);
    return due ? structuredClone(due) : null;
  }

  claimDueOutbox(nowIso: string, busyAccounts: string[], onlyId?: string): OutboxRecord | null {
    const due = this.dueOutbox(nowIso, busyAccounts, onlyId);
    if (!due) return null;
    due.state = "sending";
    due.attempts++;
    due.updatedAt = nowIso;
    return structuredClone(due);
  }

  recoverOutboxOnStart(nowIso: string): { unknown: number; held: number } {
    const now = Date.parse(nowIso);
    let unknown = 0;
    let held = 0;
    for (const { record } of this.state.outbox.values()) {
      if (record.state === "sending") {
        record.state = "unknown";
        record.errorKind = "unknown_after_data";
        record.updatedAt = nowIso;
        unknown++;
      } else if (record.state === "queued" && Date.parse(record.sendAfter) <= now) {
        record.state = "held";
        record.updatedAt = nowIso;
        held++;
      } else if (record.state === "appending") {
        record.state = "sent";
        record.updatedAt = nowIso;
      }
    }
    return { unknown, held };
  }

  completeOutbox(id: string): void {
    const entry = this.state.outbox.get(id);
    if (!entry) return;
    this.state.outbox.delete(id);
    if (entry.record.draftId !== null) this.deleteDraft(entry.record.draftId);
  }

  hasSendingOutbox(accountId: string): boolean {
    return [...this.state.outbox.values()].some(
      (e) => e.record.accountId === accountId && (e.record.state === "sending" || e.record.state === "appending"),
    );
  }

  replySource(
    messageId: string,
  ): (ReplySource & { accountId: string; folder: string; replyToKnown: boolean }) | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row) return null;
    const m = row.message;
    return {
      accountId: row.accountId,
      folder: row.folder,
      from: { ...m.from },
      to: m.to.map((a) => ({ ...a })),
      cc: m.cc.map((a) => ({ ...a })),
      replyTo: (m.replyTo ?? []).map((a) => ({ ...a })),
      replyToKnown: m.replyTo !== undefined,
      subject: m.subject,
      date: m.date === null ? null : (normalizeIso(m.date) ?? null),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: [...m.references],
    };
  }

  recipientSuggestions(prefix: string, limit: number): MailAddress[] {
    const entries: SuggestionEntry[] = [];
    for (const row of this.state.rows) {
      const m = row.message;
      const sent = this.roleOf(row.accountId, row.folder) === "sent";
      entries.push({ address: m.from.address, name: m.from.name, date: m.date, ownerSent: false });
      for (const a of [...m.to, ...m.cc]) {
        entries.push({ address: a.address, name: a.name, date: m.date, ownerSent: sent });
      }
    }
    return rankRecipientSuggestions(entries, prefix, limit);
  }

  // ---- Agent proposals and translation (slice 3c) ----

  createProposal(input: NewProposal, admit?: (rows: ProposalCapRow[]) => void): ProposalRecord {
    return this.transaction(() => {
      admit?.(this.proposalCapRows(input.createdAt));
      if (this.state.proposals.has(input.id)) throw new Error("Proposal exists");
      const record: ProposalRecord = {
        ...structuredClone(input),
        state: "pending",
        viewTokenSha256: null,
        viewedAt: null,
        outboxId: null,
        updatedAt: input.createdAt,
      };
      this.state.proposals.set(record.id, record);
      return structuredClone(record);
    });
  }

  getProposal(id: string): ProposalRecord | null {
    const proposal = this.state.proposals.get(id);
    return proposal ? structuredClone(proposal) : null;
  }

  proposalCapRows(nowIso: string): ProposalCapRow[] {
    const since = Date.parse(nowIso) - 24 * 60 * 60 * 1000;
    return [...this.state.proposals.values()]
      .filter((p) => p.state === "pending" || p.state === "confirming" || Date.parse(p.createdAt) > since)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((p) => ({ threadId: p.threadId, state: p.state, createdAt: p.createdAt, updatedAt: p.updatedAt }));
  }

  transitionProposal(
    id: string,
    from: ProposalState[],
    to: ProposalState,
    updatedAt: string,
    patch: { outboxId?: string | null; viewTokenSha256?: string | null; viewedAt?: string | null } = {},
  ): boolean {
    const proposal = this.state.proposals.get(id);
    if (!proposal || !from.includes(proposal.state)) return false;
    proposal.state = to;
    proposal.updatedAt = updatedAt;
    if (patch.outboxId !== undefined) proposal.outboxId = patch.outboxId;
    if (patch.viewTokenSha256 !== undefined) proposal.viewTokenSha256 = patch.viewTokenSha256;
    if (patch.viewedAt !== undefined) proposal.viewedAt = patch.viewedAt;
    return true;
  }

  setViewToken(id: string, sha256: string, viewedAtIso: string): boolean {
    const proposal = this.state.proposals.get(id);
    if (!proposal || proposal.state !== "pending") return false;
    proposal.viewTokenSha256 = sha256;
    proposal.viewedAt = viewedAtIso;
    return true;
  }

  releaseProposalDraft(id: string, draftId: string, updatedAt: string): boolean {
    return this.transaction(() => {
      const proposal = this.state.proposals.get(id);
      const draft = this.state.drafts.get(draftId);
      if (!proposal || (proposal.state !== "pending" && proposal.state !== "confirming")) return false;
      if (proposal.draftId !== draftId || !draft || draft.proposalId !== id) return false;
      draft.proposalId = null;
      proposal.state = "opened";
      proposal.updatedAt = updatedAt;
      return true;
    });
  }

  undoAgentSend(outboxId: string, from: OutboxState[], updatedAt: string): { cancelled: boolean; draftId: string | null } {
    return this.transaction(() => {
      const entry = this.state.outbox.get(outboxId);
      if (!entry) return { cancelled: false, draftId: null };
      const draftId = entry.record.draftId;
      if (!from.includes(entry.record.state)) return { cancelled: false, draftId };
      this.state.outbox.delete(outboxId);
      const draft = draftId === null ? undefined : this.state.drafts.get(draftId);
      if (draft && draft.proposalId === outboxId) draft.proposalId = null;
      const proposal = this.state.proposals.get(outboxId);
      if (proposal && proposal.state === "queued") {
        proposal.state = "opened";
        proposal.updatedAt = updatedAt;
      }
      return { cancelled: true, draftId };
    });
  }

  dropProposalDraft(id: string): void {
    const proposal = this.state.proposals.get(id);
    if (!proposal || proposal.draftId === null) return;
    const draft = this.state.drafts.get(proposal.draftId);
    // Only the hidden draft: one the owner opened in Mail is theirs now.
    if (draft && draft.proposalId !== id) return;
    if (draft) this.deleteDraft(draft.id);
    proposal.draftId = null;
  }

  recoverProposalsOnStart(nowIso: string): { expired: number; queued: number } {
    let expired = 0;
    let queued = 0;
    for (const proposal of this.state.proposals.values()) {
      if (proposal.state === "confirming" && this.state.outbox.has(proposal.id)) {
        proposal.state = "queued";
        proposal.outboxId = proposal.id;
        proposal.updatedAt = nowIso;
        queued++;
      } else if (proposal.state === "pending" || proposal.state === "confirming") {
        proposal.state = "expired";
        proposal.updatedAt = nowIso;
        this.dropProposalDraft(proposal.id);
        expired++;
      }
    }
    return { expired, queued };
  }

  purgeProposals(beforeIso: string): number {
    const before = Date.parse(beforeIso);
    let removed = 0;
    for (const [id, proposal] of [...this.state.proposals]) {
      if (proposal.state === "pending" || proposal.state === "confirming") continue;
      if (Date.parse(proposal.updatedAt) < before) {
        this.state.proposals.delete(id);
        removed++;
      }
    }
    return removed;
  }

  contacts(query: string, limit: number, opts?: { scoped: boolean }): Contact[] {
    const scoped = opts?.scoped === true;
    const words = queryWords(query);
    if (words.length === 0 || limit <= 0) return [];
    const newestFirst = (a: Row, b: Row) => {
      const ta = timeOf(a.message.date);
      const tb = timeOf(b.message.date);
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    };
    const messages = this.contactRows()
      .filter((row) => !scoped || this.inAiScope(row))
      .sort(newestFirst)
      .slice(0, CONTACT_SCAN)
      .map((row) =>
        this.contactMessage(row, messageTextMask(row.message.subject, snippetOf(row.message), row.message.bodyText, words)),
      );
    const bulkSenders = new Set(
      this.state.rows.filter((r) => this.bulkOf(r) === true).map((r) => r.message.from.address.trim().toLowerCase()),
    );
    const ranked = rankContacts(
      messages,
      words,
      ownerAddressSets(this.listAccounts(), this.state.identities),
      bulkSenders,
      scoped ? Infinity : limit,
    );
    return scoped ? ranked.filter((c) => !senderExcluded([c.address], this.aiScope)).slice(0, limit) : ranked;
  }

  correspondence(addresses: string[]): AccountCorrespondence[] {
    const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a !== "");
    if (wanted.length === 0) return [];
    const involves = (row: Row) =>
      [row.message.from, ...row.message.to, ...row.message.cc].some((a) => wanted.includes(a.address.trim().toLowerCase()));
    const messages = this.contactRows()
      .filter(involves)
      .map((row) => this.contactMessage(row, 0));
    return correspondenceOf(messages, wanted, ownerAddressSets(this.listAccounts(), this.state.identities));
  }

  /** The stored bulk mark: null when the fetch read no headers and no backfill filled it. */
  private bulkOf(row: Row): boolean | null {
    return row.bulk;
  }

  /** Rows a contact lookup counts: not moving, not marked bulk, not in junk or trash. */
  private contactRows(): Row[] {
    return this.state.rows.filter((row) => {
      const role = this.roleOf(row.accountId, row.folder);
      return row.movePending === null && this.bulkOf(row) !== true && role !== "junk" && role !== "trash";
    });
  }

  private contactMessage(row: Row, mask: number): ContactMessage {
    return {
      accountId: row.accountId,
      dedupKey: row.dedupKey,
      date: row.message.date === null ? null : (normalizeIso(row.message.date) ?? null),
      from: { ...row.message.from },
      to: row.message.to.map((a) => ({ ...a })),
      cc: row.message.cc.map((a) => ({ ...a })),
      inSent: this.roleOf(row.accountId, row.folder) === "sent",
      bulk: this.bulkOf(row),
      textMask: mask,
    };
  }

  addressesSentTo(addresses: string[]): Set<string> {
    const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()));
    const found = new Set<string>();
    for (const key of this.state.sentRecipients.keys()) {
      const address = key.slice(key.indexOf("\u0000") + 1);
      if (wanted.has(address)) found.add(address);
    }
    for (const row of this.state.rows) {
      if (this.roleOf(row.accountId, row.folder) !== "sent") continue;
      for (const a of [...row.message.to, ...row.message.cc]) {
        const key = a.address.trim().toLowerCase();
        if (wanted.has(key)) found.add(key);
      }
    }
    return found;
  }

  sentToCount(address: string): number {
    const wanted = address.trim().toLowerCase();
    const keys = new Set<string>();
    for (const row of this.state.rows) {
      if (this.roleOf(row.accountId, row.folder) !== "sent") continue;
      if ([...row.message.to, ...row.message.cc].some((a) => a.address.trim().toLowerCase() === wanted)) {
        keys.add(`${row.accountId}\u0000${row.dedupKey}`);
      }
    }
    return keys.size;
  }

  getTranslation(messageId: string, targetLanguage: string): TranslationRecord | null {
    const row = this.state.translations.get(translationKey(messageId, targetLanguage));
    return row ? { ...row } : null;
  }

  putTranslation(row: TranslationRecord): void {
    this.state.translations.set(translationKey(row.messageId, row.targetLanguage), { ...row });
    const extra = this.state.translations.size - TRANSLATION_CACHE_ROWS;
    if (extra <= 0) return;
    // Oldest by createdAt, then (messageId, targetLanguage), as the SQLite eviction orders them.
    const oldest = [...this.state.translations.entries()]
      .sort(([ka, a], [kb, b]) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : ka < kb ? -1 : 1))
      .slice(0, extra);
    for (const [key] of oldest) this.state.translations.delete(key);
  }

  clearTranslations(): number {
    const removed = this.state.translations.size;
    this.state.translations.clear();
    return removed;
  }

  // ---- Sending polish (slice 3d) ----

  listIdentities(accountId: string | null): AliasRow[] {
    return this.state.identities
      .filter((row) => accountId === null || row.accountId === accountId)
      .map((row) => structuredClone(row));
  }

  upsertIdentity(input: { accountId: string; address: string; displayName: string | null }, nowIso: string): AliasRow {
    return this.transaction(() => {
      const address = input.address.trim().toLowerCase();
      if (!this.state.accounts.has(input.accountId)) throw new ComposeError("not_found");
      for (const account of this.state.accounts.values()) {
        const own = [account.email, account.username].map((a) => a.trim().toLowerCase());
        if (own.includes(address)) throw new ComposeError("conflict");
      }
      const taken = this.state.identities.some(
        (row) => row.accountId !== input.accountId && row.address === address && row.state === "active",
      );
      if (taken) throw new ComposeError("conflict");
      const existing = this.state.identities.find((row) => row.accountId === input.accountId && row.address === address);
      const active = this.state.identities.filter((row) => row.accountId === input.accountId && row.state === "active");
      if (existing?.state !== "active" && active.length >= IDENTITIES_MAX_PER_ACCOUNT) throw new ComposeError("conflict");
      if (existing !== undefined) {
        existing.state = "active";
        existing.displayName = input.displayName;
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const row: AliasRow = {
        id: `ident_${this.state.nextId++}`,
        accountId: input.accountId,
        address,
        displayName: input.displayName,
        signature: null,
        state: "active",
        sendCheck: "unknown",
        checkMessageId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.state.identities.push(row);
      return structuredClone(row);
    });
  }

  private activeAlias(accountId: string, address: string): AliasRow | undefined {
    const wanted = address.trim().toLowerCase();
    return this.state.identities.find((row) => row.accountId === accountId && row.address === wanted && row.state === "active");
  }

  updateIdentity(
    accountId: string,
    address: string,
    patch: { displayName?: string | null; signature?: SignatureDoc | null },
    nowIso: string,
  ): AliasRow | null {
    const row = this.activeAlias(accountId, address);
    if (row === undefined) return null;
    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.signature !== undefined) row.signature = structuredClone(patch.signature);
    row.updatedAt = nowIso;
    return structuredClone(row);
  }

  setAccountSignature(accountId: string, signature: SignatureDoc | null): boolean {
    const account = this.state.accounts.get(accountId);
    if (account === undefined) return false;
    account.signature = structuredClone(signature);
    return true;
  }

  removeIdentity(accountId: string, address: string): boolean {
    const row = this.activeAlias(accountId, address);
    if (row === undefined) return false;
    this.state.identities = this.state.identities.filter((r) => r !== row);
    return true;
  }

  dismissIdentity(accountId: string, address: string, nowIso: string): void {
    const wanted = address.trim().toLowerCase();
    if (this.state.identities.some((row) => row.accountId === accountId && row.address === wanted)) return;
    this.state.identities.push({
      id: `ident_${this.state.nextId++}`,
      accountId,
      address: wanted,
      displayName: null,
      signature: null,
      state: "dismissed",
      sendCheck: "unknown",
      checkMessageId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  setSendCheck(accountId: string, address: string, check: SendCheck, checkMessageId: string | null, nowIso: string): void {
    const row = this.activeAlias(accountId, address);
    if (row === undefined) return;
    row.sendCheck = check;
    row.checkMessageId = checkMessageId;
    row.updatedAt = nowIso;
  }

  resolveSendChecks(accountId: string, nowIso: string): number {
    let changed = 0;
    for (const alias of this.state.identities) {
      if (alias.accountId !== accountId || alias.state !== "active" || alias.sendCheck !== "pending") continue;
      if (alias.checkMessageId === null) continue;
      const wanted = normalizeMessageId(alias.checkMessageId);
      const sent = this.state.rows.find(
        (row) =>
          row.accountId === accountId &&
          this.roleOf(row.accountId, row.folder) === "sent" &&
          row.message.messageId !== null &&
          normalizeMessageId(row.message.messageId) === wanted,
      );
      const resolved = resolveSendCheck(alias.address, sent?.message.from.address ?? null);
      if (resolved === null) continue;
      alias.sendCheck = resolved;
      alias.updatedAt = nowIso;
      changed++;
    }
    return changed;
  }

  inboundAddressRows(accountId: string): InboundRow[] {
    const skipped = new Set<SpecialUse | null>(["sent", "drafts", "junk", "trash"]);
    return this.state.rows
      .filter((row) => row.accountId === accountId && !skipped.has(this.roleOf(row.accountId, row.folder)) && row.bulk !== true)
      .map((row) => ({
        to: row.message.to.map((a) => a.address),
        cc: row.message.cc.map((a) => a.address),
        deliveredTo: row.message.deliveredTo === undefined ? null : [...row.message.deliveredTo],
        date: row.message.date ?? "",
      }));
  }

  conversationAddresses(messageId: string): Set<string> | null {
    const source = this.state.rows.find((row) => row.id === messageId);
    if (source === undefined) return null;
    const out = new Set<string>();
    for (const row of this.state.rows) {
      if (row.accountId !== source.accountId || row.threadId !== source.threadId) continue;
      const m = row.message;
      for (const a of [m.from, ...m.to, ...m.cc, ...(m.replyTo ?? [])]) out.add(a.address.trim().toLowerCase());
    }
    return out;
  }

  deliveredToOf(messageId: string): string[] {
    const row = this.state.rows.find((r) => r.id === messageId);
    return row?.message.deliveredTo === undefined ? [] : [...row.message.deliveredTo];
  }

  undoRows(ids: string[]): UndoRow[] {
    const wanted = new Set(ids);
    return this.state.rows
      .filter((row) => wanted.has(row.id))
      .map((row) => ({
        id: row.id,
        accountId: row.accountId,
        folder: row.folder,
        uid: row.uid,
        movePending: row.movePending,
        isRead: row.isRead,
        isFlagged: row.isFlagged,
      }));
  }

  cancelMove(ids: string[], folder: string, destination: string): string[] {
    const cleared: string[] = [];
    for (const id of new Set(ids)) {
      const row = this.state.rows.find((r) => r.id === id);
      if (row === undefined || row.folder !== folder || row.movePending !== destination) continue;
      row.movePending = null;
      row.moveFailures = 0;
      cleared.push(id);
    }
    return cleared;
  }

  listTemplates(): TemplateRecord[] {
    return [...this.state.templates.values()]
      .sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0))
      .map((row) => structuredClone(row));
  }

  saveTemplate(
    input: { id: string | null; name: string; nameKey: string; doc: ComposeDoc },
    newId: string,
    nowIso: string,
  ): { id: string } | { conflict: true } {
    const clash = [...this.state.templates.values()].some((row) => row.nameKey === input.nameKey && row.id !== input.id);
    if (clash) return { conflict: true };
    const existing = input.id === null ? undefined : this.state.templates.get(input.id);
    if (existing === undefined && this.state.templates.size >= TEMPLATES_MAX) {
      throw new ComposeError("conflict", "There are too many templates");
    }
    const id = existing?.id ?? input.id ?? newId;
    this.state.templates.set(id, {
      id,
      name: input.name,
      nameKey: input.nameKey,
      doc: structuredClone(input.doc),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    return { id };
  }

  deleteTemplate(id: string): boolean {
    return this.state.templates.delete(id);
  }

  getTemplateByKey(nameKey: string): TemplateRecord | null {
    const row = [...this.state.templates.values()].find((t) => t.nameKey === nameKey);
    return row === undefined ? null : structuredClone(row);
  }

  // Inbox triage (slice 3e) ---------------------------------------------------

  setSnoozeFolder(accountId: string, path: string | null): void {
    const account = this.state.accounts.get(accountId);
    if (account) this.state.accounts.set(accountId, { ...account, snoozeFolder: path });
  }

  createSnoozes(rows: SnoozeRow[], nowIso: string): { created: number } | { full: true } {
    const replaced = new Set(rows.map((row) => row.messageId));
    const perAccount = new Map<string, number>();
    for (const snooze of this.state.snoozes.values()) {
      if (replaced.has(snooze.messageId)) continue;
      perAccount.set(snooze.accountId, (perAccount.get(snooze.accountId) ?? 0) + 1);
    }
    for (const row of rows) perAccount.set(row.accountId, (perAccount.get(row.accountId) ?? 0) + 1);
    if ([...perAccount.values()].some((count) => count > SNOOZES_MAX_PER_ACCOUNT)) return { full: true };
    for (const row of rows) {
      this.state.snoozes.set(row.messageId, { ...row, createdAt: nowIso, updatedAt: nowIso });
    }
    this.promoteKept(rows.map((row) => row.messageId));
    return { created: rows.length };
  }

  listSnoozes(accountId: string, opts: { dueBefore?: string; limit: number }): SnoozeRow[] {
    return [...this.state.snoozes.values()]
      .filter((row) => row.accountId === accountId && (opts.dueBefore === undefined || row.dueAt <= opts.dueBefore))
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.messageId < b.messageId ? -1 : 1))
      .slice(0, opts.limit)
      .map(snoozeRowOf);
  }

  updateSnooze(
    messageId: string,
    patch: { state?: SnoozeState; dueAt?: string; returnTo?: string },
    nowIso: string,
  ): boolean {
    const row = this.state.snoozes.get(messageId);
    if (!row) return false;
    this.state.snoozes.set(messageId, { ...row, ...definedOnly(patch), updatedAt: nowIso });
    return true;
  }

  deleteSnoozes(messageIds: string[]): number {
    let deleted = 0;
    for (const id of messageIds) if (this.state.snoozes.delete(id)) deleted++;
    return deleted;
  }

  snoozeViews(accountId: string, limit: number): SnoozeView[] {
    return [...this.state.snoozes.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => {
        const flight = Number(a.state === "snoozed") - Number(b.state === "snoozed");
        if (flight !== 0) return flight;
        return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.messageId < b.messageId ? -1 : 1;
      })
      .slice(0, limit)
      .map((snooze) => {
        const row = this.state.rows.find((r) => r.id === snooze.messageId);
        return {
          snooze: snoozeRowOf(snooze),
          row: row ? { folder: row.folder, uid: row.uid, movePending: row.movePending } : null,
        };
      });
  }

  listBlockRules(): BlockRule[] {
    return this.state.blockRules.map((rule) => ({ ...rule }));
  }

  addBlockRule(kind: BlockRule["kind"], value: string, id: string, nowIso: string): { rule: BlockRule; created: boolean } {
    const existing = this.state.blockRules.find((rule) => rule.kind === kind && rule.value === value);
    if (existing) return { rule: { ...existing }, created: false };
    const rule: BlockRule = { id, kind, value, createdAt: nowIso };
    this.state.blockRules.push(rule);
    return { rule: { ...rule }, created: true };
  }

  removeBlockRule(id: string): boolean {
    const before = this.state.blockRules.length;
    this.state.blockRules = this.state.blockRules.filter((rule) => rule.id !== id);
    return this.state.blockRules.length !== before;
  }

  blockMatches(rule: BlockRule): { id: string; accountId: string; folder: string }[] {
    const own = new Set(
      ownerAddressSets(this.listAccounts(), this.state.identities).flatMap((set) => set.addresses.map((a) => a.toLowerCase())),
    );
    return this.state.rows
      .filter(
        (row) =>
          row.uid !== null &&
          row.movePending === null &&
          this.roleOf(row.accountId, row.folder) === "inbox" &&
          !own.has(row.message.from.address.trim().toLowerCase()) &&
          matchesBlock(row.message.from.address, [rule]) !== null &&
          this.spamSeen(row.accountId, [row.dedupKey]).size === 0,
      )
      .map((row) => ({ id: row.id, accountId: row.accountId, folder: row.folder }));
  }

  spamSeen(accountId: string, dedupKeys: string[]): Set<string> {
    const found = new Set<string>();
    for (const key of dedupKeys) {
      if (this.state.spamSeen.has(stateKey(accountId, key))) found.add(key);
      else if (
        this.state.rows.some(
          (row) => row.accountId === accountId && row.dedupKey === key && this.roleOf(row.accountId, row.folder) === "junk",
        )
      ) {
        found.add(key);
      }
    }
    return found;
  }

  pruneSpamSeen(olderThanIso: string): number {
    let pruned = 0;
    for (const [key, seenAt] of [...this.state.spamSeen]) {
      if (seenAt < olderThanIso) {
        this.state.spamSeen.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  notifyRows(ids: string[], nowIso: string): (NotifyRow & { dedupKey: string })[] {
    return ids.flatMap((id) => {
      const row = this.state.rows.find((r) => r.id === id);
      if (!row) return [];
      return [
        {
          id: row.id,
          accountId: row.accountId,
          threadId: row.threadId,
          folderRole: this.roleOf(row.accountId, row.folder),
          isRead: row.isRead,
          movePending: row.movePending,
          uid: row.uid,
          bulk: row.bulk,
          fromName: row.message.from.name,
          fromAddress: row.message.from.address,
          date: row.message.date,
          fetchedAt: nowIso,
          dedupKey: row.dedupKey,
        },
      ];
    });
  }

  fillUnsubscribe(
    accountId: string,
    folder: string,
    uidValidity: number,
    values: { uid: number; info: UnsubscribeInfo | null }[],
  ): number {
    if (this.getSyncState(accountId, folder)?.uidValidity !== uidValidity) return 0;
    let changed = 0;
    for (const value of values) {
      if (value.info === null) continue;
      const row = this.attachedRows(accountId, folder).find((r) => r.uid === value.uid);
      if (!row || row.unsubscribe !== null) continue;
      row.unsubscribe = structuredClone(value.info);
      changed++;
    }
    return changed;
  }

  unsubscribeUnknown(
    accountId: string,
    folder: string,
    belowUid: number | null,
    limit: number,
  ): { uid: number; from: MailAddress }[] {
    return this.attachedRows(accountId, folder)
      .filter((row) => row.bulk === true && row.unsubscribe === null && (belowUid === null || row.uid < belowUid))
      .sort((a, b) => b.uid - a.uid)
      .slice(0, limit)
      .map((row) => ({ uid: row.uid, from: { ...row.message.from } }));
  }

  /** Gmail: whether the message's All Mail copy is inside the scope (spec resolution 17). */
  private allMailCopyInScope(row: { accountId: string; dedupKey: string; id: string }): boolean {
    return this.state.rows.some(
      (c) =>
        c.id !== row.id &&
        c.accountId === row.accountId &&
        c.dedupKey === row.dedupKey &&
        this.roleOf(c.accountId, c.folder) === "all" &&
        this.inAiScope(c),
    );
  }

  inboxMessages(accountId: string | null, opts: { unreadOnly: boolean; limit: number; scoped?: boolean }): InboxMessage[] {
    const rows = this.state.rows.filter(
      (r) =>
        (accountId === null || r.accountId === accountId) &&
        r.uid !== null &&
        r.movePending === null &&
        this.roleOf(r.accountId, r.folder) === "inbox" &&
        (!opts.unreadOnly || !r.isRead) &&
        (opts.scoped !== true || this.inAiScope(r) || this.allMailCopyInScope(r)),
    );
    return this.onePerKey(rows, (r) => `${r.accountId}\u0000${r.dedupKey}`)
      .sort((a, b) => oldestFirst(b, a))
      .slice(0, opts.limit)
      .map((r) => ({
        ...this.summary(r),
        bulk: r.bulk,
        unsubscribe: r.unsubscribe === null ? null : structuredClone(r.unsubscribe),
        snoozedUntil: this.state.snoozes.get(r.id)?.dueAt ?? null,
      }));
  }

  getUnsubscribeInfo(messageId: string): UnsubscribeInfo | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    return row?.unsubscribe ? structuredClone(row.unsubscribe) : null;
  }

  getUnsubscribe(accountId: string, listKey: string): UnsubscribeRecord | null {
    const row = this.state.unsubscribes.get(stateKey(accountId, listKey));
    return row ? { ...row } : null;
  }

  putUnsubscribe(row: UnsubscribeRecord): void {
    this.state.unsubscribes.set(stateKey(row.accountId, row.listKey), { ...row });
  }

  setUnsubscribeStateByOutbox(outboxId: string, state: UnsubscribeRecord["state"]): boolean {
    let changed = false;
    for (const row of this.state.unsubscribes.values()) {
      if (row.outboxId === outboxId) {
        row.state = state;
        changed = true;
      }
    }
    return changed;
  }

  createTriageBatch(batch: NewTriageBatch, items: TriageItemRecord[]): void {
    if (this.state.triageBatches.has(batch.id)) throw new Error("Duplicate triage batch");
    this.state.triageBatches.set(batch.id, {
      ...batch,
      state: "pending",
      viewTokenHash: null,
      approved: null,
      createSnoozeFolder: null,
      updatedAt: batch.createdAt,
    });
    this.state.triageItems.push(...items.map((item) => ({ ...item, batchId: batch.id })));
  }

  getTriageBatch(id: string): { batch: TriageBatchRecord; items: TriageItemRecord[] } | null {
    const batch = this.state.triageBatches.get(id);
    if (!batch) return null;
    const items = this.state.triageItems
      .filter((item) => item.batchId === id)
      .sort((a, b) => a.position - b.position)
      .map((item) => ({ ...item }));
    return { batch: structuredClone(batch), items };
  }

  transitionTriageBatch(
    id: string,
    from: TriageBatchState[],
    to: TriageBatchState,
    patch: { viewTokenHash?: string | null; approved?: number[]; createSnoozeFolder?: string[] },
    nowIso: string,
  ): boolean {
    const batch = this.state.triageBatches.get(id);
    if (!batch || !from.includes(batch.state)) return false;
    this.state.triageBatches.set(id, {
      ...batch,
      ...structuredClone(definedOnly(patch)),
      state: to,
      updatedAt: nowIso,
    });
    return true;
  }

  setTriageOutcomes(id: string, outcomes: { position: number; outcome: TriageItemOutcome }[]): void {
    for (const { position, outcome } of outcomes) {
      const item = this.state.triageItems.find((i) => i.batchId === id && i.position === position);
      if (item) item.outcome = outcome;
    }
  }

  triageHistory(sinceIso: string): TriageHistoryRow[] {
    return [...this.state.triageBatches.values()]
      .filter((batch) => batch.createdAt >= sinceIso || batch.state === "pending" || batch.state === "confirming")
      .map((batch) => ({ threadId: batch.threadId, state: batch.state, createdAt: batch.createdAt, updatedAt: batch.updatedAt }));
  }

  settleTriageAtStart(nowIso: string): { interrupted: number; expired: number } {
    let interrupted = 0;
    let expired = 0;
    for (const batch of this.state.triageBatches.values()) {
      if (batch.state === "applying") {
        batch.state = "interrupted";
        batch.updatedAt = nowIso;
        interrupted++;
      } else if (batch.state === "pending" || batch.state === "confirming") {
        batch.state = "expired";
        batch.updatedAt = nowIso;
        expired++;
      }
    }
    return { interrupted, expired };
  }

  cancelSendPurpose(outboxId: string, states: OutboxState[]): { cancelled: boolean } {
    const entry = this.state.outbox.get(outboxId);
    if (!entry || !states.includes(entry.record.state)) return { cancelled: false };
    const draft = entry.record.draftId === null ? undefined : this.state.drafts.get(entry.record.draftId);
    if (!draft || draft.purpose === null) return { cancelled: false };
    this.state.outbox.delete(outboxId);
    this.deleteDraft(draft.id);
    return { cancelled: true };
  }

  // ---- Agent and mail (slice 3f) ----------------------------------------

  setAiScope(scope: AiScope): void {
    this.aiScope = scope;
    this.refreshExcludedThreads();
  }

  getAiScope(): AiScope {
    return this.aiScope;
  }

  loadAiScope(): AiScope {
    const accounts = new Map<string, AccountScope>();
    for (const [accountId, scope] of [...this.state.scopeAccounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      accounts.set(accountId, structuredClone(scope));
    }
    const addresses = new Set<string>();
    const domains = new Set<string>();
    for (const sender of this.state.scopeSenders) (sender.kind === "domain" ? domains : addresses).add(sender.value);
    return { accounts, senders: { addresses, domains } };
  }

  putAiScope(
    accounts: { accountId: string; scope: AccountScope }[],
    senders: { kind: "address" | "domain"; value: string }[],
    _nowIso: string,
  ): void {
    this.state.scopeAccounts = new Map(accounts.map(({ accountId, scope }) => [accountId, structuredClone(scope)]));
    const seen = new Set<string>();
    this.state.scopeSenders = senders.filter((s) => {
      const key = `${s.kind}\u0000${s.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  refreshExcludedThreads(): void {
    const { addresses, domains } = this.aiScope.senders;
    if (addresses.size === 0 && domains.size === 0) {
      this.excludedThreads = new Set();
      return;
    }
    this.excludedThreads = new Set(
      this.state.rows
        .filter((r) => senderExcluded([r.message.from.address, ...r.message.to.map((a) => a.address), ...r.message.cc.map((a) => a.address)], this.aiScope))
        .map((r) => r.threadId),
    );
  }

  /** The row is inside the installed AI scope (the SQLite mail_ai_in_scope). */
  private inAiScope(row: Row): boolean {
    if (this.excludedStale) {
      this.excludedStale = false;
      this.refreshExcludedThreads();
    }
    return inAiScope(
      {
        accountId: row.accountId,
        folder: row.folder,
        folderRole: this.roleOf(row.accountId, row.folder),
        fromAddress: row.message.from.address,
        to: row.message.to.map((a) => a.address),
        cc: row.message.cc.map((a) => a.address),
        threadId: row.threadId,
      },
      this.aiScope,
      this.excludedThreads,
    );
  }

  /** Some copy of the row's message is inside the AI scope. */
  private anyCopyInScope(row: Row): boolean {
    return this.state.rows.some((r) => r.accountId === row.accountId && r.dedupKey === row.dedupKey && this.inAiScope(r));
  }

  scopedMessage(messageId: string): MessageHeader | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row) return null;
    const order = new Map(this.state.rows.map((r, index) => [r, index]));
    const copies = this.state.rows
      .filter((r) => r.accountId === row.accountId && r.dedupKey === row.dedupKey && this.inAiScope(r))
      .sort(
        (a, b) =>
          Number(b.id === messageId) - Number(a.id === messageId) ||
          Number(this.isInbox(b.accountId, b.folder)) - Number(this.isInbox(a.accountId, a.folder)) ||
          order.get(b)! - order.get(a)!,
      );
    return copies[0] ? this.header(copies[0]) : null;
  }

  appendAgentLog(entry: LogEntry): number {
    const seq = this.state.nextLogSeq++;
    this.state.agentLog.push({ ...entry, messageIds: entry.messageIds.slice(0, AGENT_LOG_IDS_MAX), seq });
    return seq;
  }

  setAgentLogSources(seq: number, messageIds: readonly string[], count: number, hiddenCount: number): number {
    const entry = this.state.agentLog.find((row) => row.seq === seq);
    if (entry === undefined) return 0;
    entry.messageIds = [...new Set(messageIds)].slice(0, AGENT_LOG_IDS_MAX);
    entry.count = count;
    entry.hiddenCount = hiddenCount;
    return 1;
  }

  updateAgentLog(refId: string, outcome: LogOutcome, count: number): number {
    let changed = 0;
    for (const entry of this.state.agentLog) {
      if (entry.refId !== refId) continue;
      entry.outcome = outcome;
      entry.count = count;
      changed++;
    }
    return changed;
  }

  listAgentLog(opts: { threadId?: string; cursor?: string | null; limit: number }): {
    entries: (LogEntry & { seq: number })[];
    next: string | null;
  } {
    const after = opts.cursor == null ? null : Number(opts.cursor);
    const rows = this.state.agentLog
      .filter((e) => opts.threadId === undefined || e.threadId === opts.threadId)
      .filter((e) => after === null || !Number.isInteger(after) || e.seq < after)
      .sort((a, b) => b.seq - a.seq);
    const page = rows.slice(0, opts.limit).map((e) => structuredClone(e));
    const last = page[page.length - 1];
    return { entries: page, next: rows.length > opts.limit && last ? String(last.seq) : null };
  }

  clearAgentLog(): number {
    const removed = this.state.agentLog.length;
    this.state.agentLog = [];
    return removed;
  }

  purgeAgentLog(beforeIso: string, maxRows: number): number {
    const before = this.state.agentLog.length;
    const kept = this.state.agentLog.filter((e) => e.at >= beforeIso).sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, maxRows));
    this.state.agentLog = kept.sort((a, b) => a.seq - b.seq);
    return before - kept.length;
  }

  getAiResult(kind: "summary", subjectId: string): AiResultRecord | null {
    const row = this.state.aiResults.get(`${kind}\u0000${subjectId}`);
    return row ? { ...row } : null;
  }

  putAiResult(row: AiResultRecord): void {
    if (new TextEncoder().encode(row.resultJson).length > AI_RESULT_MAX_BYTES) throw new Error("AI result too large");
    this.state.aiResults.set(`${row.kind}\u0000${row.subjectId}`, { ...row });
  }

  keepTasks(rows: NewTask[]): { kept: number } | { full: true } {
    const open = [...this.state.tasks.values()].filter((t) => t.doneAt === null).length;
    if (open + rows.length > TASKS_OPEN_MAX) return { full: true };
    for (const row of rows) {
      this.state.tasks.set(row.id, { ...row, note: row.note ?? null, doneAt: null, updatedAt: row.createdAt });
    }
    return { kept: rows.length };
  }

  private taskRecord(task: StoredTask): TaskRecord {
    const row = task.messageId === null ? undefined : this.state.rows.find((r) => r.id === task.messageId);
    return { ...task, threadId: row?.threadId ?? null };
  }

  listTasks(opts: { done: boolean; cursor?: string | null; limit: number }): { tasks: TaskRecord[]; next: string | null } {
    const offset = opts.cursor == null ? 0 : Math.max(0, Number(opts.cursor) || 0);
    const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
    const rows = [...this.state.tasks.values()]
      .filter((t) => (t.doneAt !== null) === opts.done)
      .sort((a, b) =>
        opts.done
          ? cmp(b.doneAt, a.doneAt) || cmp(b.id, a.id)
          : cmp(a.due, b.due) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
      );
    const page = rows.slice(offset, offset + opts.limit).map((t) => this.taskRecord(t));
    return { tasks: page, next: rows.length > offset + opts.limit ? String(offset + opts.limit) : null };
  }

  getTask(id: string): TaskRecord | null {
    const task = this.state.tasks.get(id);
    return task ? this.taskRecord(task) : null;
  }

  updateTask(id: string, patch: { title?: string; due?: string | null; done?: boolean }, nowIso: string): boolean {
    const task = this.state.tasks.get(id);
    if (!task) return false;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.due !== undefined) task.due = patch.due;
    if (patch.done !== undefined) task.doneAt = patch.done ? (task.doneAt ?? nowIso) : null;
    task.updatedAt = nowIso;
    return true;
  }

  deleteTask(id: string): boolean {
    return this.state.tasks.delete(id);
  }

  taskCounts(today: string): { overdue: number; today: number } {
    const open = [...this.state.tasks.values()].filter((t) => t.doneAt === null && t.due !== null);
    return { overdue: open.filter((t) => t.due! < today).length, today: open.filter((t) => t.due === today).length };
  }

  setCategories(messageIds: string[], category: Category | null, source: CategorySource, nowIso: string): { previous: PreviousLabel[] } {
    const previous: PreviousLabel[] = [];
    const seen = new Set<string>();
    for (const id of messageIds) {
      const row = this.state.rows.find((r) => r.id === id);
      if (!row) continue;
      const key = stateKey(row.accountId, row.dedupKey);
      if (seen.has(key)) continue;
      seen.add(key);
      const before = this.state.categories.get(key);
      if (source === "rule" && before?.source === "owner") continue;
      previous.push({
        accountId: row.accountId,
        dedupKey: row.dedupKey,
        category: before?.category ?? null,
        source: before?.source ?? null,
      });
      if (category === null) this.state.categories.delete(key);
      else this.state.categories.set(key, { category, source, setAt: nowIso });
    }
    return { previous };
  }

  restoreCategories(previous: PreviousLabel[], nowIso: string): void {
    for (const label of previous) {
      const key = stateKey(label.accountId, label.dedupKey);
      if (label.category === null) this.state.categories.delete(key);
      else this.state.categories.set(key, { category: label.category, source: label.source ?? "owner", setAt: nowIso });
    }
  }

  categoriesOf(
    messageIds: string[],
  ): Map<string, { category: Category | null; source: CategorySource | null; suggestion: AiCategoryAnswer | null }> {
    const out = new Map<string, { category: Category | null; source: CategorySource | null; suggestion: AiCategoryAnswer | null }>();
    for (const id of messageIds) {
      const row = this.state.rows.find((r) => r.id === id);
      if (!row) continue;
      const key = stateKey(row.accountId, row.dedupKey);
      const label = this.state.categories.get(key);
      out.set(id, {
        category: label?.category ?? null,
        source: label?.source ?? null,
        suggestion: this.state.categorySuggestions.get(key) ?? null,
      });
    }
    return out;
  }

  putCategorySuggestions(rows: { messageId: string; category: AiCategoryAnswer }[], _nowIso: string): void {
    for (const { messageId, category } of rows) {
      const row = this.state.rows.find((r) => r.id === messageId);
      if (row) this.state.categorySuggestions.set(stateKey(row.accountId, row.dedupKey), category);
    }
  }

  listCategoryRules(): CategoryRule[] {
    return [...this.state.categoryRules]
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((rule) => ({ ...rule }));
  }

  addCategoryRule(
    kind: CategoryRule["kind"],
    value: string,
    category: Category,
    id: string,
    nowIso: string,
  ): { rule: CategoryRule; created: boolean } | { full: true } {
    const existing = this.state.categoryRules.find((r) => r.kind === kind && r.value === value);
    if (existing) return { rule: { ...existing }, created: false };
    if (this.state.categoryRules.length >= CATEGORY_RULES_MAX) return { full: true };
    const rule: CategoryRule = { id, kind, value, category, createdAt: nowIso };
    this.state.categoryRules.push(rule);
    return { rule: { ...rule }, created: true };
  }

  removeCategoryRule(id: string): boolean {
    const before = this.state.categoryRules.length;
    this.state.categoryRules = this.state.categoryRules.filter((r) => r.id !== id);
    return this.state.categoryRules.length < before;
  }

  replyCandidates(sinceIso: string, limit: number): ReplyCandidate[] {
    const since = Date.parse(sinceIso);
    const order = new Map(this.state.rows.map((r, index) => [r, index]));
    const dated = this.state.rows.filter((r) => r.movePending === null && timeOf(r.message.date) !== null);
    const threads = new Set(this.state.rows.filter((r) => (timeOf(r.message.date) ?? -Infinity) >= since).map((r) => r.threadId));
    const latest = new Map<string, Row>();
    for (const row of dated) {
      if (!threads.has(row.threadId)) continue;
      const current = latest.get(row.threadId);
      if (current === undefined) {
        latest.set(row.threadId, row);
        continue;
      }
      const newer =
        timeOf(row.message.date)! - timeOf(current.message.date)! ||
        Number(this.isInbox(row.accountId, row.folder)) - Number(this.isInbox(current.accountId, current.folder)) ||
        order.get(row)! - order.get(current)!;
      if (newer > 0) latest.set(row.threadId, row);
    }
    return [...latest.values()]
      .sort((a, b) => timeOf(b.message.date)! - timeOf(a.message.date)! || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit)
      .map((row) => {
        const sent = this.state.rows
          .filter((r) => r.threadId === row.threadId && this.roleOf(r.accountId, r.folder) === "sent")
          .map((r) => timeOf(r.message.date))
          .filter((time): time is number => time !== null);
        return {
          threadId: row.threadId,
          accountId: row.accountId,
          messageId: row.id,
          dedupKey: row.dedupKey,
          date: normalizeIso(row.message.date!)!,
          folderRole: this.roleOf(row.accountId, row.folder),
          fromAddress: row.message.from.address,
          to: row.message.to.map((a) => a.address),
          cc: row.message.cc.map((a) => a.address),
          bulk: row.bulk,
          lastSentAt: sent.length === 0 ? null : new Date(Math.max(...sent)).toISOString(),
        };
      });
  }

  replyDismissals(): Set<string> {
    return new Set([...this.state.replyDismissals.keys()].map((key) => {
      const [accountId, dedupKey] = key.split("\u0000") as [string, string];
      return dismissalKey(accountId, dedupKey);
    }));
  }

  dismissReply(accountId: string, dedupKey: string, nowIso: string): void {
    this.state.replyDismissals.set(stateKey(accountId, dedupKey), nowIso);
  }

  getDigest(day: string): DigestRecord | null {
    const row = this.state.digests.get(day);
    return row ? { ...row } : null;
  }

  putDigest(row: DigestRecord): boolean {
    if (this.state.digests.has(row.day)) return false;
    this.state.digests.set(row.day, { ...row });
    return true;
  }

  markDigestNotified(day: string, nowIso: string): boolean {
    const row = this.state.digests.get(day);
    if (!row || row.notifiedAt !== null) return false;
    row.notifiedAt = nowIso;
    return true;
  }

  createReminder(row: NewReminder): { created: true } | { full: true } {
    // A queued reminder whose send failed is not live until a retry queues it again.
    const failed = (r: ReminderRecord) => r.outboxId !== null && this.state.outbox.get(r.outboxId)?.record.state === "failed";
    const live = [...this.state.reminders.values()].filter(
      (r) => (r.state === "queued" && !failed(r)) || r.state === "waiting" || r.state === "due",
    );
    if (live.length >= REMINDERS_LIVE_MAX) return { full: true };
    this.state.reminders.set(row.id, { ...row, updatedAt: row.createdAt, notifiedAt: null });
    return { created: true };
  }

  bindReminder(outboxId: string, sentAtIso: string): ReminderRecord | null {
    const row = [...this.state.reminders.values()].find((r) => r.outboxId === outboxId && r.state === "queued");
    if (!row) return null;
    Object.assign(row, { state: "waiting", outboxId: null, sentAt: sentAtIso, dueAt: dueAt(sentAtIso, row.days), updatedAt: sentAtIso });
    return { ...row };
  }

  deleteReminderForOutbox(outboxId: string): number {
    let removed = 0;
    for (const [id, row] of [...this.state.reminders]) {
      if (row.outboxId !== outboxId) continue;
      this.state.reminders.delete(id);
      removed++;
    }
    return removed;
  }

  getReminder(id: string): ReminderRecord | null {
    const row = this.state.reminders.get(id);
    return row ? { ...row } : null;
  }

  listReminders(opts: { states: ReminderState[]; dueBefore?: string; limit: number }): ReminderRecord[] {
    const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
    return [...this.state.reminders.values()]
      .filter((r) => opts.states.includes(r.state))
      .filter((r) => opts.dueBefore === undefined || (r.dueAt !== null && r.dueAt <= opts.dueBefore))
      .sort((a, b) => cmp(a.dueAt, b.dueAt) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
      .slice(0, opts.limit)
      .map((r) => ({ ...r }));
  }

  updateReminder(
    id: string,
    patch: { state?: ReminderState; days?: number; dueAt?: string | null; threadId?: string | null; notifiedAt?: string | null },
    nowIso: string,
  ): boolean {
    const row = this.state.reminders.get(id);
    if (!row) return false;
    for (const key of ["state", "days", "dueAt", "threadId", "notifiedAt"] as const) {
      if (patch[key] !== undefined) Object.assign(row, { [key]: patch[key] });
    }
    row.updatedAt = nowIso;
    return true;
  }

  answeringRows(rfcMessageIds: string[], afterIso: string): AnsweringRow[] {
    const wanted = new Set(rfcMessageIds.map(normalizeMessageId).filter((id) => id !== ""));
    if (wanted.size === 0) return [];
    const after = Date.parse(afterIso);
    const order = new Map(this.state.rows.map((r, index) => [r, index]));
    return this.state.rows
      .filter((r) => (timeOf(r.message.date) ?? -Infinity) > after)
      .filter(
        (r) =>
          (r.message.inReplyTo !== null && wanted.has(normalizeMessageId(r.message.inReplyTo))) ||
          r.message.references.some((ref) => wanted.has(normalizeMessageId(ref))),
      )
      .sort((a, b) => timeOf(a.message.date)! - timeOf(b.message.date)! || order.get(a)! - order.get(b)!)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        threadId: r.threadId,
        messageId: r.message.messageId,
        inReplyTo: r.message.inReplyTo,
        references: [...r.message.references],
        date: normalizeIso(r.message.date!),
        bulk: r.bulk,
        fromAddress: r.message.from.address,
      }));
  }

  sentCopyThread(accountId: string, rfcMessageId: string): string | null {
    const wanted = normalizeMessageId(rfcMessageId);
    if (wanted === "") return null;
    const rows = this.state.rows.filter(
      (r) => r.accountId === accountId && r.message.messageId !== null && normalizeMessageId(r.message.messageId) === wanted,
    );
    return rows[rows.length - 1]?.threadId ?? null;
  }

  // ---- Slice 3g ----

  setDevClass(rows: { id: string; dev: DevClass | null }[]): number {
    let changed = 0;
    for (const { id, dev } of rows) {
      const row = this.state.rows.find((r) => r.id === id);
      if (row === undefined) continue;
      row.dev = dev === null ? null : { ...dev };
      changed++;
    }
    return changed;
  }

  devUnclassified(limit: number): DevUnclassifiedRow[] {
    if (limit <= 0) return [];
    return this.state.rows
      .filter((r) => r.dev === undefined && !["junk", "trash"].includes(this.roleOf(r.accountId, r.folder) ?? ""))
      .sort((a, b) => -oldestFirst(a, b))
      .slice(0, limit)
      .map((r) => ({ id: r.id, accountId: r.accountId, from: r.message.from.address, subject: r.message.subject }));
  }

  listUnknown(accountId: string, folder: string, belowUid: number | null, limit: number): { uid: number }[] {
    if (limit <= 0) return [];
    return this.state.rows
      .filter(
        (r) =>
          r.accountId === accountId &&
          r.folder === folder &&
          r.uid !== null &&
          (r.listId === undefined || r.listId === null) &&
          (belowUid === null || r.uid < belowUid),
      )
      .map((r) => r.uid!)
      .sort((a, b) => b - a)
      .slice(0, limit)
      .map((uid) => ({ uid }));
  }

  listIds(ids: string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const id of ids) {
      const row = this.state.rows.find((r) => r.id === id);
      if (row !== undefined) out.set(id, row.listId ?? null);
    }
    return out;
  }

  fillListIds(accountId: string, folder: string, uidValidity: number, ids: { uid: number; listId: string }[]): number {
    if (this.state.syncStates.get(stateKey(accountId, folder))?.uidValidity !== uidValidity) return 0;
    let changed = 0;
    for (const { uid, listId } of ids) {
      const row = this.state.rows.find((r) => r.accountId === accountId && r.folder === folder && r.uid === uid);
      if (row === undefined || (row.listId !== undefined && row.listId !== null)) continue;
      row.listId = listId;
      changed++;
    }
    return changed;
  }

  devGroups(opts: { sinceIso: string; accountId?: string | null; cursor?: string | null; limit: number }): {
    groups: DevGroupRow[];
    next: string | null;
  } {
    const rows = this.state.rows
      .filter(
        (r) =>
          r.dev !== undefined &&
          r.dev !== null &&
          r.message.date !== null &&
          r.message.date >= opts.sinceIso &&
          (opts.accountId == null || r.accountId === opts.accountId) &&
          r.movePending === null &&
          !["junk", "trash"].includes(this.roleOf(r.accountId, r.folder) ?? ""),
      )
      .sort((a, b) => -oldestFirst(a, b))
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        dedupKey: r.dedupKey,
        source: r.dev!.source,
        repo: r.dev!.repo,
        kind: r.dev!.kind,
        state: r.dev!.state,
        subject: r.message.subject,
        date: r.message.date,
        isRead: r.isRead,
      }));
    return pageDevGroups(groupDevRows(rows), opts.cursor ?? null, opts.limit);
  }

  addBbLink(row: BbLinkRow): void {
    if (this.state.bbLinks.some((link) => link.id === row.id)) throw new Error("UNIQUE constraint failed: bb_links.id");
    this.state.bbLinks.push({ ...row });
  }

  listBbLinks(query: { messageIds: string[] } | { accountId: string; threadId: string } | { targetId: string }): BbLinkRow[] {
    const match =
      "messageIds" in query
        ? (link: BbLinkRow) => query.messageIds.includes(link.messageId)
        : "targetId" in query
          ? (link: BbLinkRow) => link.targetId === query.targetId
          : (link: BbLinkRow) => link.accountId === query.accountId && link.threadId === query.threadId;
    return this.state.bbLinks
      .filter(match)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((link) => ({ ...link }));
  }

  pruneBbLinks(kind: BbLinkRowKind, targetIds: string[]): number {
    const before = this.state.bbLinks.length;
    this.state.bbLinks = this.state.bbLinks.filter((link) => link.kind !== kind || !targetIds.includes(link.targetId));
    return before - this.state.bbLinks.length;
  }

  setConversationProject(accountId: string, threadId: string, projectId: string | null, nowIso: string): void {
    const key = stateKey(accountId, threadId);
    if (projectId === null) this.state.conversationProjects.delete(key);
    else this.state.conversationProjects.set(key, { projectId, createdAt: nowIso });
  }

  conversationProject(accountId: string, threadId: string): string | null {
    return this.state.conversationProjects.get(stateKey(accountId, threadId))?.projectId ?? null;
  }

  addBinding(row: BindingRow): { created: boolean } | { full: true } {
    const key = `${row.kind}\u0000${row.value}`;
    const existing = this.state.bindings.get(key);
    if (existing !== undefined) {
      existing.projectId = row.projectId;
      return { created: false };
    }
    if (this.state.bindings.size >= BINDINGS_MAX) return { full: true };
    this.state.bindings.set(key, { ...row });
    return { created: true };
  }

  removeBinding(kind: BindingKind, value: string): boolean {
    return this.state.bindings.delete(`${kind}\u0000${value}`);
  }

  listBindings(): BindingRow[] {
    return [...this.state.bindings.values()]
      .sort((a, b) => (a.kind === b.kind ? (a.value < b.value ? -1 : a.value > b.value ? 1 : 0) : a.kind < b.kind ? -1 : 1))
      .map((row) => ({ ...row }));
  }

  projectThreads(projectId: string, opts: { cursor: string | null; limit: number }): {
    threads: ThreadSummary[];
    nextCursor: string | null;
  } {
    const groups = new Map<string, Row[]>();
    for (const row of this.state.rows) {
      const group = groups.get(row.threadId);
      if (group) group.push(row);
      else groups.set(row.threadId, [row]);
    }
    const all = [...groups.entries()]
      .filter(([id, rows]) => this.projectOf(rows[0]!.accountId, id) === projectId)
      .map(([id, rows]) => this.summarize(id, rows, (r) => r.movePending === null))
      .sort((a, b) => {
        const byDate = (timeOf(b.lastDate) ?? -Infinity) - (timeOf(a.lastDate) ?? -Infinity);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    const offset = opts.cursor === null ? 0 : Number(opts.cursor);
    const threads = all.slice(offset, offset + opts.limit);
    const next = offset + threads.length;
    return { threads, nextCursor: next < all.length ? String(next) : null };
  }

  putIncident(row: IncidentRow): void {
    this.state.incidents.set(row.fingerprint, { ...row });
  }

  incidentFor(fingerprint: string): IncidentRow | null {
    const row = this.state.incidents.get(fingerprint);
    return row === undefined || row.bbThreadId.startsWith(INCIDENT_PENDING_PREFIX) ? null : { ...row };
  }

  reserveIncident(fingerprint: string, expectedBbThreadId: string | null, row: { token: string; projectId: string; at: string }): boolean {
    const current = this.state.incidents.get(fingerprint);
    const pending = current !== undefined && current.bbThreadId.startsWith(INCIDENT_PENDING_PREFIX);
    if (pending && Date.parse(row.at) - Date.parse(current.createdAt) < INCIDENT_RESERVE_MS) return false;
    const currentId = current === undefined || pending ? null : current.bbThreadId;
    if (currentId !== expectedBbThreadId) return false;
    this.putIncident({ fingerprint, bbThreadId: `${INCIDENT_PENDING_PREFIX}${row.token}`, projectId: row.projectId, createdAt: row.at, lastAt: row.at });
    return true;
  }

  releaseIncident(fingerprint: string, token: string): void {
    if (this.state.incidents.get(fingerprint)?.bbThreadId === `${INCIDENT_PENDING_PREFIX}${token}`) this.state.incidents.delete(fingerprint);
  }

  touchIncident(fingerprint: string, nowIso: string): boolean {
    const row = this.state.incidents.get(fingerprint);
    if (row === undefined) return false;
    row.lastAt = nowIso;
    return true;
  }

  listRules(): RuleRecord[] {
    return [...this.state.rules.values()]
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((rule) => structuredClone(rule));
  }

  saveRule(rule: Rule, nowIso: string): { rule: RuleRecord } | { full: true } {
    const existing = this.state.rules.get(rule.id);
    if (existing === undefined && this.state.rules.size >= RULES_MAX) return { full: true };
    const record: RuleRecord = {
      ...structuredClone(rule),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    this.state.rules.set(rule.id, record);
    return { rule: structuredClone(record) };
  }

  deleteRule(id: string): boolean {
    return this.state.rules.delete(id);
  }

  pauseRules(nowIso: string): string[] {
    const paused: string[] = [];
    for (const rule of this.state.rules.values()) {
      if (!rule.enabled) continue;
      rule.enabled = false;
      rule.updatedAt = nowIso;
      paused.push(rule.id);
    }
    return paused.sort();
  }

  resumeRules(ids: string[], nowIso: string): number {
    let changed = 0;
    for (const id of ids) {
      const rule = this.state.rules.get(id);
      if (rule === undefined) continue;
      rule.enabled = true;
      rule.updatedAt = nowIso;
      changed++;
    }
    return changed;
  }

  insertRuleRun(row: NewRuleRun, caps: RuleCaps): "inserted" | "capped" | "duplicate" {
    const stored = this.state.rows.find((r) => r.id === row.messageId);
    const messageKey = stored === undefined ? `id:${row.messageId}` : `${stored.accountId}:${stored.dedupKey}`;
    if (this.state.ruleRuns.some((run) => run.ruleId === row.ruleId && run.messageKey === messageKey)) return "duplicate";
    let state: RuleRunState = row.state;
    if (row.state === "starting") {
      const at = Date.parse(row.createdAt);
      const hour = new Date(at - 3_600_000).toISOString();
      const day = new Date(at - 86_400_000).toISOString();
      const live = this.state.ruleRuns.filter((run) => (run.state === "starting" || run.state === "started") && run.createdAt >= day);
      const own = live.filter((run) => run.ruleId === row.ruleId);
      const counts = {
        ruleHour: own.filter((run) => run.createdAt >= hour).length,
        ruleDay: own.length,
        allDay: live.length,
        conversationDay:
          row.threadId === null ? 0 : own.filter((run) => run.accountId === row.accountId && run.threadId === row.threadId).length,
      };
      if (capVerdict(counts, caps) === "capped") state = "capped";
    }
    this.state.ruleRuns.push({
      id: row.id,
      ruleId: row.ruleId,
      accountId: row.accountId,
      messageId: row.messageId,
      threadId: row.threadId,
      projectId: row.projectId ?? null,
      messageKey,
      state,
      bbThreadId: null,
      notifiedAt: null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
    return state === "capped" ? "capped" : "inserted";
  }

  updateRuleRun(
    id: string,
    patch: { state?: RuleRunState; bbThreadId?: string | null; notifiedAt?: string | null },
    nowIso: string,
  ): boolean {
    const run = this.state.ruleRuns.find((r) => r.id === id);
    if (run === undefined) return false;
    Object.assign(run, definedOnly(patch), { updatedAt: nowIso });
    return true;
  }

  ruleRunByBbThread(bbThreadId: string): RuleRunRecord | null {
    const run = this.state.ruleRuns
      .filter((r) => r.bbThreadId === bbThreadId && (r.state === "starting" || r.state === "started"))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    return run === undefined ? null : publicRun(run);
  }

  getRuleRun(id: string): RuleRunRecord | null {
    const run = this.state.ruleRuns.find((r) => r.id === id);
    return run === undefined ? null : publicRun(run);
  }

  listRuleRuns(opts: { state?: RuleRunState; cursor?: string | null; limit: number }): { runs: RuleRunRecord[]; next: string | null } {
    const all = this.state.ruleRuns
      .filter((run) => run.messageId !== null && (opts.state === undefined || run.state === opts.state))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const offset = opts.cursor == null ? 0 : Number(opts.cursor);
    const runs = all.slice(offset, offset + opts.limit).map(publicRun);
    const next = offset + runs.length;
    return { runs, next: next < all.length ? String(next) : null };
  }

  staleStartingRuns(beforeIso: string): RuleRunRecord[] {
    return this.state.ruleRuns
      .filter((run) => run.state === "starting" && run.createdAt < beforeIso)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map(publicRun);
  }

  addRuleThread(row: { bbThreadId: string; ruleId: string; runId: string | null; createdAt: string }): void {
    if (this.state.ruleThreads.has(row.bbThreadId)) return;
    this.state.ruleThreads.set(row.bbThreadId, { ruleId: row.ruleId, runId: row.runId, createdAt: row.createdAt });
  }

  isRuleThread(bbThreadId: string): boolean {
    return this.state.ruleThreads.has(bbThreadId) || this.ruleRunByBbThread(bbThreadId) !== null;
  }

  failStaleStarts(beforeIso: string, nowIso: string): number {
    let changed = 0;
    for (const run of this.state.ruleRuns) {
      if (run.state !== "starting" || run.createdAt >= beforeIso) continue;
      run.state = "failed";
      run.updatedAt = nowIso;
      changed++;
    }
    return changed;
  }

  /** The conversation's project: the owner's binding, else the first matching rule (address, list, repo, domain). */
  private projectOf(accountId: string, threadId: string): string | null {
    const owner = this.state.conversationProjects.get(stateKey(accountId, threadId));
    if (owner !== undefined) return owner.projectId;
    if (this.state.bindings.size === 0) return null;
    // The most recently stored row first (SQLite orders by seq).
    const rows = this.state.rows.filter((r) => r.threadId === threadId).reverse();
    const lookups: [BindingKind, (r: Row) => string | null | undefined][] = [
      ["address", (r) => r.message.from.address.toLowerCase()],
      ["list", (r) => r.listId],
      ["repo", (r) => r.dev?.repo],
      ["domain", (r) => r.message.from.address.slice(r.message.from.address.indexOf("@") + 1).toLowerCase()],
    ];
    for (const [kind, valueOf] of lookups) {
      for (const row of rows) {
        const value = valueOf(row);
        if (value === undefined || value === null || value === "") continue;
        const binding = this.state.bindings.get(`${kind}\u0000${value}`);
        if (binding !== undefined) return binding.projectId;
      }
    }
    return null;
  }

  purgeDaily(nowIso: string, knownProjectIds?: readonly string[] | null): number {
    const now = Date.parse(nowIso);
    const before = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const keys = new Set(this.state.rows.map((r) => stateKey(r.accountId, r.dedupKey)));
    let removed = 0;
    for (const map of [this.state.categories, this.state.categorySuggestions] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        if (keys.has(key)) continue;
        map.delete(key);
        removed++;
      }
    }
    const threads = new Set(this.state.rows.map((r) => r.threadId));
    for (const [key, row] of [...this.state.aiResults]) {
      if (threads.has(row.subjectId)) continue;
      this.state.aiResults.delete(key);
      removed++;
    }
    const dayRows = before(DAY_ROWS_KEEP_DAYS);
    for (const [day, row] of [...this.state.digests]) {
      if (row.builtAt >= dayRows) continue;
      this.state.digests.delete(day);
      removed++;
    }
    for (const [key, at] of [...this.state.replyDismissals]) {
      if (at >= dayRows) continue;
      this.state.replyDismissals.delete(key);
      removed++;
    }
    const answered = before(ANSWERED_KEEP_DAYS);
    for (const [id, row] of [...this.state.reminders]) {
      if ((row.state !== "answered" && row.state !== "dismissed") || row.updatedAt >= answered) continue;
      this.state.reminders.delete(id);
      removed++;
    }
    removed += this.purgeAgentLog(before(AGENT_LOG_KEEP_DAYS), AGENT_LOG_ROWS_MAX);
    // Slice 3g.
    const conversations = new Set(this.state.rows.map((r) => stateKey(r.accountId, r.threadId)));
    const unknownBefore = before(UNKNOWN_PROJECT_DAYS);
    for (const [key, row] of [...this.state.conversationProjects]) {
      const unknown = knownProjectIds != null && !knownProjectIds.includes(row.projectId) && row.createdAt < unknownBefore;
      if (conversations.has(key) && !unknown) continue;
      this.state.conversationProjects.delete(key);
      removed++;
    }
    const ready = before(RULE_READY_DAYS);
    for (const run of this.state.ruleRuns) {
      if (run.state === "ready" && run.createdAt < ready) {
        run.state = "expired";
        run.updatedAt = nowIso;
      }
    }
    const runs = before(RULE_RUNS_KEEP_DAYS);
    const keptRuns = this.state.ruleRuns.filter((run) => run.createdAt >= runs);
    removed += this.state.ruleRuns.length - keptRuns.length;
    this.state.ruleRuns = keptRuns;
    const ruleThreads = before(RULE_THREADS_KEEP_DAYS);
    for (const [key, row] of [...this.state.ruleThreads]) {
      if (row.createdAt >= ruleThreads) continue;
      this.state.ruleThreads.delete(key);
      removed++;
    }
    const incidents = before(INCIDENT_KEEP_DAYS);
    for (const [key, row] of [...this.state.incidents]) {
      if (row.createdAt >= incidents) continue;
      this.state.incidents.delete(key);
      removed++;
    }
    return removed;
  }

  // ---- Slice 3h ---------------------------------------------------------------

  searchPage(
    query: ParsedQuery,
    accountId: string | null,
    limit: number,
    opts?: SearchOptions,
  ): { hits: MessageSummary[]; nextCursor: SearchCursor | null; attachmentMatches: AttachmentMatch[] } {
    const text = query.text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    const withAttachments = opts?.attachments === true && Array.from(text).length >= 3;
    const textHit = (r: Row) => {
      const contains = (haystack: string | null | undefined) => (haystack ?? "").toLowerCase().includes(text.toLowerCase());
      const m = r.message;
      return contains(m.subject) || contains(m.from.name) || contains(m.from.address) || contains(m.bodyText);
    };
    const attachmentHit = (r: Row) => this.attachmentTextOfCopies(r).some((entry) => entry.body.toLowerCase().includes(text.toLowerCase()));
    const matches = this.state.rows
      .filter((r) => accountId === null || r.accountId === accountId)
      .filter((r) => r.movePending === null)
      .filter((r) => opts?.scoped !== true || this.inAiScope(r))
      .filter((r) => text === "" || textHit(r) || (withAttachments && attachmentHit(r)))
      .filter((r) => this.matchesConditions(r, query.conditions));
    // Newest first, undated first, then id descending (the SQLite order).
    const ordered = this.onePerKey(matches, (r) => `${r.accountId}\u0000${r.dedupKey}`).sort((a, b) => {
      const ta = timeOf(a.message.date);
      const tb = timeOf(b.message.date);
      if (ta !== tb) return ta === null ? -1 : tb === null ? 1 : tb - ta;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const cursor = opts?.cursor ?? null;
    const start = cursor === null ? 0 : ordered.findIndex((r) => r.id === cursor.id) + 1;
    const page = ordered.slice(start, start + limit);
    const last = page[page.length - 1];
    const more = start + limit < ordered.length;
    return {
      hits: page.map((r) => this.summary(r)),
      nextCursor: more && last !== undefined ? { date: isoOrNull(last.message.date), id: last.id } : null,
      attachmentMatches: withAttachments
        ? page.flatMap((r) => {
            const entry = this.attachmentTextOfCopies(r).find((e) => e.body.toLowerCase().includes(text.toLowerCase()));
            if (entry === undefined) return [];
            const filename = this.state.rows
              .find((row) => row.id === entry.messageId)
              ?.message.attachments.find((a) => a.partId === entry.partId)?.filename ?? null;
            return [{ messageId: r.id, filename, excerpt: excerptAround(entry.body, text) }];
          })
        : [],
    };
  }

  listMessages(
    accountId: string,
    folder: string,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { messages: MessageSummary[]; nextCursor: string | null } {
    const inScope = (r: Row) => r.accountId === accountId && r.folder === folder && r.movePending === null;
    return this.pageRows(this.state.rows.filter(this.member(inScope, filter)), cursor, limit);
  }

  listMessagesAll(
    role: SpecialUse,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { messages: MessageSummary[]; nextCursor: string | null } {
    if (role === "all") return { messages: [], nextCursor: null };
    const inScope = (r: Row) => r.movePending === null && this.roleOf(r.accountId, r.folder) === role;
    return this.pageRows(this.state.rows.filter(this.member(inScope, filter)), cursor, limit);
  }

  promoteKept(messageIds: readonly string[]): string[] {
    const changed: string[] = [];
    for (const id of messageIds) {
      const row = this.state.rows.find((r) => r.id === id);
      if (row === undefined) continue;
      for (const copy of this.state.rows) {
        if (copy.accountId !== row.accountId || copy.dedupKey !== row.dedupKey) continue;
        if (copy.kept !== "history" && copy.kept !== "search") continue;
        copy.kept = "opened";
        changed.push(copy.id);
      }
    }
    return changed;
  }

  expireSearchRows(nowIso: string, days: number): { removed: number; accounts: string[] } {
    const cutoff = Date.parse(nowIso) - days * 86_400_000;
    const expired = this.state.rows.filter((r) => r.kept === "search" && r.keptAt !== null && Date.parse(r.keptAt) < cutoff);
    const gone = new Set(expired.map((r) => r.id));
    this.state.rows = this.state.rows.filter((r) => !gone.has(r.id));
    this.dropOrphanTranslations();
    return { removed: expired.length, accounts: [...new Set(expired.map((r) => r.accountId))] };
  }

  historyState(accountId: string, folder: string): { historySince: string | null; historyCheckedAt: string | null } | null {
    if (!this.state.syncStates.has(stateKey(accountId, folder))) return null;
    const history = this.state.history.get(stateKey(accountId, folder));
    return { historySince: history?.since ?? null, historyCheckedAt: history?.checkedAt ?? null };
  }

  setHistorySince(accountId: string, folder: string, since: string | null): void {
    if (!this.state.syncStates.has(stateKey(accountId, folder))) return;
    const key = stateKey(accountId, folder);
    this.state.history.set(key, { since: since === null ? null : isoOrNull(since), checkedAt: this.state.history.get(key)?.checkedAt ?? null });
  }

  historyChecked(accountId: string, folder: string, atIso: string): void {
    if (!this.state.syncStates.has(stateKey(accountId, folder))) return;
    const key = stateKey(accountId, folder);
    this.state.history.set(key, { since: this.state.history.get(key)?.since ?? null, checkedAt: isoOrNull(atIso) });
  }

  historyForgetCount(accountId: string, folder: string): number {
    return this.forgettable(accountId, folder).length;
  }

  historyForget(accountId: string, folder: string): number {
    const rows = this.forgettable(accountId, folder);
    const gone = new Set(rows.map((r) => r.id));
    this.state.rows = this.state.rows.filter((r) => !gone.has(r.id));
    this.dropOrphanTranslations();
    this.setHistorySince(accountId, folder, null);
    return rows.length;
  }

  rehomeFolder(accountId: string, from: string, to: string, delimiter: string): void {
    const move = (path: string) => renamedPath(path, from, to, delimiter);
    const rekey = <V>(map: Map<string, V>) => {
      for (const [key, value] of [...map]) {
        const [account, path] = key.split("\u0000") as [string, string];
        const next = account === accountId ? move(path) : null;
        if (next === null) continue;
        map.delete(key);
        map.set(stateKey(account, next), value);
      }
    };
    for (const row of this.state.rows) {
      const next = row.accountId === accountId ? move(row.folder) : null;
      if (next !== null) row.folder = next;
    }
    rekey(this.state.syncStates);
    rekey(this.state.history);
    rekey(this.state.folderPrefs);
    this.state.folders.set(
      accountId,
      (this.state.folders.get(accountId) ?? []).map((f) => {
        const next = move(f.path);
        if (next === null) return f;
        // The renamed folder's own name is its last segment; children keep theirs.
        const name = delimiter !== "" && to.includes(delimiter) ? to.slice(to.lastIndexOf(delimiter) + 1) : to;
        return { ...f, path: next, name: next === to ? name : f.name };
      }),
    );
    for (const draft of this.state.drafts.values()) {
      if (draft.accountId !== accountId || draft.serverCopy === null) continue;
      const next = move(draft.serverCopy.folder);
      if (next !== null) draft.serverCopy = { ...draft.serverCopy, folder: next };
    }
    const account = this.state.accounts.get(accountId);
    if (account?.snoozeFolder) {
      const next = move(account.snoozeFolder);
      if (next !== null) this.state.accounts.set(accountId, { ...account, snoozeFolder: next });
    }
    for (const snooze of this.state.snoozes.values()) {
      const next = snooze.accountId === accountId ? move(snooze.returnTo) : null;
      if (next !== null) snooze.returnTo = next;
    }
    this.rewriteScopeFolders(accountId, (path) => move(path) ?? path);
  }

  dropFolder(accountId: string, path: string): void {
    const delimiter = (this.state.folders.get(accountId) ?? []).find((f) => f.path === path)?.delimiter ?? "";
    this.state.rows = this.state.rows.filter((r) => !(r.accountId === accountId && r.folder === path));
    this.state.syncStates.delete(stateKey(accountId, path));
    this.state.history.delete(stateKey(accountId, path));
    this.state.folderPrefs.delete(stateKey(accountId, path));
    this.state.folders.set(accountId, (this.state.folders.get(accountId) ?? []).filter((f) => f.path !== path));
    this.dropOrphanTranslations();
    this.rewriteScopeFolders(accountId, (entry) => (renamedPath(entry, path, path, delimiter) === null ? entry : null));
  }

  movePendingCount(accountId: string, path: string): number {
    return this.state.rows.filter(
      (r) => r.accountId === accountId && ((r.folder === path && r.movePending !== null) || r.movePending === path),
    ).length;
  }

  folderGrouping(accountId: string, path: string): boolean {
    return this.state.folderPrefs.get(stateKey(accountId, path)) ?? true;
  }

  setFolderGrouping(accountId: string, path: string, grouping: boolean): void {
    this.state.folderPrefs.set(stateKey(accountId, path), grouping);
  }

  listSavedSearches(): SavedSearchRow[] {
    return this.state.savedSearches.map((row, position) => ({ ...row, position }));
  }

  saveSavedSearch(
    row: { id: string | null; name: string; query: string; accountId: string | null; nowIso: string },
    newId: string,
  ): { id: string } | "full" | "not_found" {
    if (row.id !== null) {
      const found = this.state.savedSearches.find((entry) => entry.id === row.id);
      if (found === undefined) return "not_found";
      Object.assign(found, { name: row.name, query: row.query, accountId: row.accountId, updatedAt: row.nowIso });
      return { id: row.id };
    }
    if (this.state.savedSearches.length >= SAVED_SEARCHES_MAX) return "full";
    this.state.savedSearches.push({
      id: newId,
      name: row.name,
      query: row.query,
      accountId: row.accountId,
      position: this.state.savedSearches.length,
      createdAt: row.nowIso,
      updatedAt: row.nowIso,
    });
    return { id: newId };
  }

  deleteSavedSearch(id: string): boolean {
    const before = this.state.savedSearches.length;
    this.state.savedSearches = this.state.savedSearches.filter((row) => row.id !== id);
    return this.state.savedSearches.length < before;
  }

  moveSavedSearch(id: string, position: number): boolean {
    const at = this.state.savedSearches.findIndex((row) => row.id === id);
    if (at === -1) return false;
    const [row] = this.state.savedSearches.splice(at, 1);
    this.state.savedSearches.splice(Math.max(0, Math.min(position, this.state.savedSearches.length)), 0, row!);
    return true;
  }

  filesList(filter: FilesFilter, cursor: string | null, limit: number): { files: FileRow[]; nextCursor: string | null } {
    const rows = this.state.rows.filter(
      (r) =>
        r.movePending === null &&
        (filter.includeJunk === true || !["junk", "trash"].includes(this.roleOf(r.accountId, r.folder) ?? "")) &&
        (filter.accountId === undefined || r.accountId === filter.accountId) &&
        (filter.sender === undefined || r.message.from.address.toLowerCase() === filter.sender.toLowerCase()),
    );
    const files: (FileRow & { order: Row })[] = [];
    for (const row of this.onePerKey(rows, (r) => `${r.accountId}\u0000${r.dedupKey}`)) {
      for (const a of row.message.attachments) {
        if (a.isInline) continue;
        const kind = fileKindOf(a.mimeType, a.filename);
        if (filter.kind !== undefined && kind !== filter.kind) continue;
        if (filter.name !== undefined && !(a.filename ?? "").toLowerCase().includes(filter.name.toLowerCase())) continue;
        files.push({
          messageId: row.id,
          partId: a.partId,
          filename: a.filename,
          kind,
          mimeType: a.mimeType,
          size: a.size,
          date: isoOrNull(row.message.date),
          from: { ...row.message.from },
          accountId: row.accountId,
          threadId: row.threadId,
          order: row,
        });
      }
    }
    files.sort((a, b) => {
      const ta = timeOf(a.date);
      const tb = timeOf(b.date);
      if (ta !== tb) return ta === null ? -1 : tb === null ? 1 : tb - ta;
      const seqA = this.state.rows.indexOf(a.order);
      const seqB = this.state.rows.indexOf(b.order);
      if (seqA !== seqB) return seqB - seqA;
      return a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0;
    });
    const offset = cursor === null ? 0 : Number(cursor);
    const page = files.slice(offset, offset + limit).map(({ order: _order, ...file }) => file);
    const next = offset + page.length;
    return { files: page, nextCursor: next < files.length ? String(next) : null };
  }

  senderStats(address: string, accountId: string | null): SenderStats {
    const outside = (r: Row) =>
      r.movePending === null &&
      (accountId === null || r.accountId === accountId) &&
      !["junk", "trash"].includes(this.roleOf(r.accountId, r.folder) ?? "");
    const lower = address.toLowerCase();
    const fromRows = this.state.rows.filter((r) => outside(r) && r.message.from.address.toLowerCase() === lower);
    const toRows = this.state.rows.filter(
      (r) => outside(r) && [...r.message.to, ...r.message.cc].some((a) => a.address.toLowerCase() === lower),
    );
    const keys = (rows: Row[]) => new Set(rows.map((r) => `${r.accountId}\u0000${r.dedupKey}`)).size;
    const dates = fromRows.map((r) => isoOrNull(r.message.date)).filter((d): d is string => d !== null).sort();
    const named = [...fromRows].sort((a, b) => oldestFirst(b, a)).find((r) => r.message.from.name);
    const threadIds = [...new Set([...fromRows].sort((a, b) => oldestFirst(b, a)).map((r) => r.threadId))].slice(0, 10);
    return {
      name: named?.message.from.name ?? null,
      fromCount: keys(fromRows),
      toCount: keys(toRows),
      toCapped: false,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      conversations: threadIds.map((id) =>
        this.summarize(
          id,
          this.state.rows.filter((r) => r.threadId === id),
          () => true,
        ),
      ),
      files: this.filesList({ sender: address, ...(accountId === null ? {} : { accountId }) }, null, 5).files,
    };
  }

  relatedCandidates(messageId: string, terms: readonly string[]): RelatedCandidate[] {
    const open = this.state.rows.find((r) => r.id === messageId);
    if (open === undefined) return [];
    const own = this.state.accounts.get(open.accountId)?.email.toLowerCase() ?? "";
    const addresses = (r: Row) => [r.message.from, ...r.message.to, ...r.message.cc].map((a) => a.address.toLowerCase());
    const participants = new Set(addresses(open).filter((a) => a !== "" && a !== own));
    const refs = new Set([...open.message.references, ...(open.message.messageId === null ? [] : [open.message.messageId])]);
    const pool = this.onePerKey(
      this.state.rows.filter(
        (r) =>
          r.accountId === open.accountId &&
          r.threadId !== open.threadId &&
          r.movePending === null &&
          !["junk", "trash"].includes(this.roleOf(r.accountId, r.folder) ?? ""),
      ),
      (r) => r.dedupKey,
    );
    const candidates: RelatedCandidate[] = [];
    for (const row of pool) {
      const haystack = `${row.message.subject}\n${row.message.from.name ?? ""} ${row.message.from.address}\n${row.message.bodyText ?? ""}`.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term.toLowerCase()));
      const shared = [...participants].filter((a) => addresses(row).includes(a)).length;
      const reference = row.message.messageId !== null && refs.has(row.message.messageId);
      if (matched.length === 0 && shared === 0 && !reference) continue;
      candidates.push({
        messageId: row.id,
        threadId: row.threadId,
        date: row.message.date,
        terms: matched,
        participants: shared,
        reference,
        rank: matched.length === 0 ? null : -matched.length,
      });
      if (candidates.length >= RELATED_CANDIDATES_MAX) break;
    }
    return candidates;
  }

  summaries(messageIds: readonly string[]): MessageSummary[] {
    return messageIds.flatMap((id) => {
      const row = this.state.rows.find((r) => r.id === id);
      return row === undefined ? [] : [this.summary(row)];
    });
  }

  gmLabels(messageIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of messageIds) {
      const row = this.state.rows.find((r) => r.id === id);
      if (row !== undefined) out.set(id, [...this.labelsOfCopies(row)]);
    }
    return out;
  }

  setGmLabels(accountId: string, folder: string, entries: readonly { uid: number; labels: string[] }[]): void {
    for (const entry of entries) {
      const row = this.state.rows.find((r) => r.accountId === accountId && r.folder === folder && r.uid === entry.uid);
      if (row !== undefined) row.gmLabels = [...entry.labels];
    }
  }

  accountLabels(accountId: string): string[] {
    const labels = new Set<string>();
    for (const row of this.state.rows) if (row.accountId === accountId) for (const label of row.gmLabels ?? []) labels.add(label);
    return [...labels].sort((a, b) => a.localeCompare(b));
  }

  attachmentTextCandidates(limit: number): AttachmentCandidate[] {
    const out: AttachmentCandidate[] = [];
    for (const row of [...this.state.rows].sort((a, b) => oldestFirst(b, a))) {
      if (row.movePending !== null || row.kept === "search") continue;
      for (const a of row.message.attachments) {
        const kind = fileKindOf(a.mimeType, a.filename);
        if (a.isInline || (kind !== "text" && kind !== "pdf")) continue;
        if (this.state.attachmentText.has(`${row.id}\u0000${a.partId}`)) continue;
        out.push({
          messageId: row.id,
          partId: a.partId,
          kind,
          size: a.size,
          messageSize: row.message.size,
          date: isoOrNull(row.message.date),
          folderUse: this.roleOf(row.accountId, row.folder),
          kept: row.kept,
          inline: false,
        });
      }
    }
    return out.slice(0, limit);
  }

  insertAttachmentText(row: AttachmentTextRow): void {
    this.state.attachmentText.set(`${row.messageId}\u0000${row.partId}`, {
      ...row,
      body: row.state === "indexed" ? row.body : null,
    });
  }

  attachmentTextStatus(): { indexed: number; skipped: number; failed: number; pending: number; totalChars: number } {
    // Rows of messages gone are left out, as SQLite deletes them with their message.
    const live = this.liveAttachmentText();
    const of = (state: AttachmentTextRow["state"]) => live.filter((row) => row.state === state).length;
    return {
      indexed: of("indexed"),
      skipped: of("skipped"),
      failed: of("failed"),
      pending: this.attachmentTextCandidates(Number.MAX_SAFE_INTEGER).filter(
        (c) => c.folderUse !== "junk" && c.folderUse !== "trash",
      ).length,
      totalChars: live.reduce((sum, row) => sum + (row.body?.length ?? 0), 0),
    };
  }

  retryAttachmentText(): number {
    const failed = this.liveAttachmentText().filter((row) => row.state === "failed");
    for (const row of failed) this.state.attachmentText.delete(`${row.messageId}\u0000${row.partId}`);
    return failed.length;
  }

  clearAttachmentText(): number {
    const count = this.liveAttachmentText().length;
    this.state.attachmentText.clear();
    return count;
  }

  private liveAttachmentText(): AttachmentTextRow[] {
    const ids = new Set(this.state.rows.map((r) => r.id));
    return [...this.state.attachmentText.values()].filter((row) => ids.has(row.messageId));
  }

  /** Indexed attachment text of any copy of the row's message. */
  private attachmentTextOfCopies(row: Row): { messageId: string; partId: string; body: string }[] {
    const copies = new Set(
      this.state.rows.filter((r) => r.accountId === row.accountId && r.dedupKey === row.dedupKey).map((r) => r.id),
    );
    return [...this.state.attachmentText.values()].flatMap((entry) =>
      entry.state === "indexed" && entry.body !== null && copies.has(entry.messageId)
        ? [{ messageId: entry.messageId, partId: entry.partId, body: entry.body }]
        : [],
    );
  }

  /** X-GM-LABELS of the row, else of another copy of its message (as SQLite). */
  private labelsOfCopies(row: Row): string[] {
    if (row.gmLabels !== null) return row.gmLabels;
    return (
      this.state.rows.find((r) => r.accountId === row.accountId && r.dedupKey === row.dedupKey && r.gmLabels !== null)?.gmLabels ?? []
    );
  }

  private forgettable(accountId: string, folder: string): Row[] {
    const since = this.state.syncStates.get(stateKey(accountId, folder))?.syncedSince;
    return this.folderRows(accountId, folder).filter((r) => {
      if (r.kept !== "history" && r.kept !== "search") return false;
      const time = timeOf(r.message.date);
      return time === null || (since !== undefined && time < Date.parse(since));
    });
  }

  private rewriteScopeFolders(accountId: string, map: (path: string) => string | null): void {
    const scope = this.state.scopeAccounts.get(accountId);
    if (scope?.mode !== "folders") return;
    const folders: string[] = [];
    for (const path of scope.folders) {
      const next = map(path);
      if (next !== null && !folders.includes(next)) folders.push(next);
    }
    this.state.scopeAccounts.set(accountId, { mode: "folders", folders });
  }

  /** One row per message, newest first, undated first; offset cursors like the fake's thread lists. */
  private pageRows(rows: Row[], cursor: string | null, limit: number): { messages: MessageSummary[]; nextCursor: string | null } {
    const ordered = this.onePerKey(rows, (r) => `${r.accountId}\u0000${r.dedupKey}`).sort((a, b) => {
      const ta = timeOf(a.message.date);
      const tb = timeOf(b.message.date);
      if (ta !== tb) return ta === null ? -1 : tb === null ? 1 : tb - ta;
      return this.state.rows.indexOf(b) - this.state.rows.indexOf(a);
    });
    const offset = cursor === null ? 0 : Number(cursor);
    const page = ordered.slice(offset, offset + limit);
    const next = offset + page.length;
    return { messages: page.map((r) => this.summary(r)), nextCursor: next < ordered.length ? String(next) : null };
  }

  /** The search conditions on one row (spec "Search operators"; SQLite builds the same as SQL). */
  private matchesConditions(row: Row, conditions: readonly SearchCondition[]): boolean {
    const test = (condition: SearchCondition): boolean => {
      const m = row.message;
      const has = (value: string | null | undefined, needle: string) => (value ?? "").toLowerCase().includes(needle.toLowerCase());
      const addresses = (list: MailAddress[]) => list.some((a) => has(a.address, condition.value) || has(a.name, condition.value));
      const folderNamed = (value: string) => {
        const lower = value.toLowerCase();
        return (
          row.folder.toLowerCase() === lower ||
          (this.state.folders.get(row.accountId) ?? []).some((f) => f.path === row.folder && f.name.toLowerCase() === lower)
        );
      };
      switch (condition.field) {
        case "from":
          return has(m.from.address, condition.value) || has(m.from.name, condition.value);
        case "to":
          return addresses(m.to);
        case "cc":
          return addresses(m.cc);
        case "subject":
          return has(m.subject, condition.value);
        case "list":
          return has(row.listId, condition.value);
        case "has":
          return m.attachments.some((a) => !a.isInline);
        case "filename":
          return m.attachments.some((a) => !a.isInline && filenameMatches(a.filename ?? "", condition.value));
        case "is":
          return condition.value === "unread" ? !row.isRead : row.isFlagged;
        case "larger":
          return m.size > Number(condition.value);
        case "smaller":
          return m.size < Number(condition.value);
        case "after":
        case "before": {
          const time = timeOf(m.date);
          if (time === null) return false;
          const at = Date.parse(condition.value);
          return condition.field === "after" ? time >= at : time < at;
        }
        case "category":
          return this.state.categories.get(stateKey(row.accountId, row.dedupKey))?.category === condition.value.toLowerCase();
        case "label":
          return (
            this.labelsOfCopies(row).some((label) => label.toLowerCase() === condition.value.toLowerCase()) ||
            folderNamed(condition.value)
          );
        case "in":
          if (condition.value === "snoozed") return row.folder === this.state.accounts.get(row.accountId)?.snoozeFolder;
          if (["inbox", "sent", "drafts", "junk", "trash", "archive", "all"].includes(condition.value)) {
            return this.roleOf(row.accountId, row.folder) === condition.value;
          }
          return folderNamed(condition.value);
        case "account": {
          const account = this.state.accounts.get(row.accountId);
          const lower = condition.value.toLowerCase();
          return (
            row.accountId === condition.value ||
            account?.email.toLowerCase() === lower ||
            (account?.displayName ?? "").toLowerCase() === lower
          );
        }
      }
    };
    for (const field of ["in", "account"] as const) {
      const ors = conditions.filter((c) => c.field === field && !c.negated);
      if (ors.length > 0 && !ors.some(test)) return false;
    }
    return conditions.every((c) => ((c.field === "in" || c.field === "account") && !c.negated) || test(c) !== c.negated);
  }

  /** Translations and snoozes follow their message: dropped with every removed row (as SQLite deleteRows). */
  private dropOrphanTranslations(): void {
    const ids = new Set(this.state.rows.map((r) => r.id));
    for (const [key, row] of [...this.state.translations]) {
      if (!ids.has(row.messageId)) this.state.translations.delete(key);
    }
    for (const id of [...this.state.snoozes.keys()]) {
      if (!ids.has(id)) this.state.snoozes.delete(id);
    }
    // A kept task outlives its message (slice 3f).
    for (const task of this.state.tasks.values()) {
      if (task.messageId !== null && !ids.has(task.messageId)) task.messageId = null;
    }
    // Slice 3g: links go with their message; rule runs stay without it (review C1).
    this.state.bbLinks = this.state.bbLinks.filter((link) => ids.has(link.messageId));
    for (const run of this.state.ruleRuns) if (run.messageId !== null && !ids.has(run.messageId)) run.messageId = null;
  }

  /** The row landed in a junk-role folder: block never moves its dedup key again (spec resolution 17). */
  private markSpamSeen(row: Row): void {
    this.state.spamSeen.set(stateKey(row.accountId, row.dedupKey), new Date().toISOString());
  }

  /** A live outbox row holds the draft (done rows are deleted). */
  private draftHeld(draftId: string): boolean {
    return [...this.state.outbox.values()].some((e) => e.record.draftId === draftId);
  }

  private draftAttachments(draftId: string): StoredComposeAttachment[] {
    return this.state.composeAttachments
      .filter((a) => a.draftId === draftId)
      .sort((a, b) => a.position - b.position);
  }

  unreadCount(accountId: string | null): number {
    const keys = new Set(
      this.state.rows
        .filter(
          (r) =>
            !r.isRead &&
            r.movePending === null &&
            (accountId === null || r.accountId === accountId) &&
            this.isInbox(r.accountId, r.folder),
        )
        .map((r) => `${r.accountId}\u0000${r.dedupKey}`),
    );
    return keys.size;
  }

  // Folders ------------------------------------------------------------------

  saveFolders(accountId: string, folders: RemoteFolder[]): { removed: string[] } {
    // Like the SQLite upsert: one entry per path, the last listing wins.
    const byPath = new Map(folders.map((f) => [f.path, { ...f }]));
    const removed = (this.state.folders.get(accountId) ?? [])
      .map((f) => f.path)
      .filter((path) => !byPath.has(path))
      .sort();
    this.state.folders.set(accountId, [...byPath.values()]);
    for (const path of removed) {
      this.state.rows = this.state.rows.filter((r) => !(r.accountId === accountId && r.folder === path));
      this.state.syncStates.delete(stateKey(accountId, path));
      this.state.history.delete(stateKey(accountId, path));
      this.state.folderPrefs.delete(stateKey(accountId, path));
    }
    if (removed.length > 0) this.rewriteScopeFolders(accountId, (path) => (removed.includes(path) ? null : path));
    this.dropOrphanTranslations();
    return { removed };
  }

  listFolders(accountId: string): Folder[] {
    return (this.state.folders.get(accountId) ?? [])
      .map((f) => {
        const rows = this.folderRows(accountId, f.path).filter((r) => r.movePending === null);
        return {
          accountId,
          path: f.path,
          name: f.name,
          specialUse: effectiveSpecialUse(f.path, f.specialUse),
          selectable: f.selectable,
          subscribed: f.subscribed ?? true,
          unreadCount: new Set(rows.filter((r) => !r.isRead).map((r) => r.dedupKey)).size,
          totalCount: new Set(rows.map((r) => r.dedupKey)).size,
        };
      })
      .sort(compareFolders);
  }

  // Moves --------------------------------------------------------------------

  pendingMoves(
    accountId: string,
    folder: string,
  ): { uid: number; id: string; destination: string }[] {
    return this.attachedRows(accountId, folder)
      .filter((r): r is Row & { uid: number; movePending: string } => r.movePending !== null)
      .sort((a, b) => a.uid - b.uid)
      .map((r) => ({ uid: r.uid, id: r.id, destination: r.movePending }));
  }

  queueMove(
    messageIds: string[],
    destination: string,
  ): { accountId: string; folder: string } | null {
    const ids = [...new Set(messageIds)];
    const rows = ids.map((id) => this.state.rows.find((r) => r.id === id));
    const first = rows[0];
    if (!first) return null;
    const valid = rows.every(
      (r) =>
        r !== undefined &&
        r.accountId === first.accountId &&
        r.folder === first.folder &&
        r.movePending === null,
    );
    if (!valid || first.folder === destination) return null;
    for (const row of rows as Row[]) {
      row.movePending = destination;
      row.moveFailures = 0;
    }
    this.promoteKept(ids);
    return { accountId: first.accountId, folder: first.folder };
  }

  completeMove(
    accountId: string,
    folder: string,
    destination: string,
    moved: Map<number, number> | null,
    uids: number[],
  ): void {
    const junk = this.roleOf(accountId, destination) === "junk";
    const takeOver = (row: Row, occupant: Row | undefined, uid: number | null) => {
      row.movePending = null;
      row.moveFailures = 0;
      row.folder = destination;
      if (junk) this.markSpamSeen(row);
      if (occupant === undefined || occupant === row) {
        row.uid = uid;
      } else if (occupant.movePending !== null) {
        row.uid = null;
      } else {
        // The moved row's own desired values win, else the occupant's.
        row.seenDesired = row.seenDesired ?? occupant.seenDesired;
        row.flagDesired = row.flagDesired ?? occupant.flagDesired;
        row.isRead = row.seenDesired ?? row.isRead;
        row.isFlagged = row.flagDesired ?? row.isFlagged;
        row.uid = occupant.uid;
        this.state.rows = this.state.rows.filter((r) => r !== occupant);
        this.dropOrphanTranslations();
      }
    };
    for (const uid of uids) {
      const row: Row | undefined = this.attachedRows(accountId, folder).find(
        (r) => r.uid === uid && r.movePending === destination,
      );
      if (!row) continue;
      if (moved === null) {
        const copy = row.dedupKey.startsWith("id:")
          ? undefined
          : this.attachedRows(accountId, destination).find(
              (r) => r.dedupKey === row.dedupKey && r.movePending === null && r !== row,
            );
        takeOver(row, copy, null);
        continue;
      }
      const newUid = moved.get(uid);
      if (newUid === undefined) {
        row.movePending = null;
        row.moveFailures = 0;
        continue;
      }
      takeOver(row, this.attachedRows(accountId, destination).find((r) => r.uid === newUid), newUid);
    }
  }

  failMove(accountId: string, folder: string, uids: number[]): { cancelled: string[] } {
    const cancelled: string[] = [];
    for (const uid of uids) {
      const row = this.attachedRows(accountId, folder).find(
        (r) => r.uid === uid && r.movePending !== null,
      );
      if (!row) continue;
      row.moveFailures++;
      if (row.moveFailures >= MOVE_MAX_FAILURES) {
        row.movePending = null;
        row.moveFailures = 0;
        cancelled.push(row.id);
      }
    }
    return { cancelled };
  }

  // Images -------------------------------------------------------------------

  inlineParts(messageId: string): InlinePart[] {
    const row = this.state.rows.find((r) => r.id === messageId);
    return row ? row.inlineParts.map((p) => structuredClone(p)) : [];
  }

  isImageSenderAllowed(accountId: string, address: string): boolean {
    return this.state.imageSenders.has(senderKey(accountId, address));
  }

  allowImageSender(accountId: string, address: string): void {
    this.state.imageSenders.add(senderKey(accountId, address));
  }

  disallowImageSender(accountId: string, address: string): boolean {
    return this.state.imageSenders.delete(senderKey(accountId, address));
  }

  // Helpers ----------------------------------------------------------------

  /** INBOX, or a folder saved with the inbox special use. */
  private isAllMail(accountId: string, path: string): boolean {
    const saved = (this.state.folders.get(accountId) ?? []).find((f) => f.path === path);
    return saved?.specialUse === "all";
  }

  private isInbox(accountId: string, path: string): boolean {
    if (path.toUpperCase() === "INBOX") return true;
    const saved = (this.state.folders.get(accountId) ?? []).find((f) => f.path === path);
    return saved?.specialUse === "inbox";
  }

  /**
   * One row per key: a copy not waiting to move, then the Inbox copy, then
   * the most recently stored row. For a thread view (`viewed` set, as the
   * SQLite getThread), the copy in `viewed` not waiting to move comes first
   * and a copy outside All Mail beats one in it.
   */
  private onePerKey(rows: Row[], keyOf: (row: Row) => string, viewed: string | null = null): Row[] {
    const order = new Map(this.state.rows.map((r, index) => [r, index]));
    const best = new Map<string, Row>();
    for (const row of rows) {
      const key = keyOf(row);
      const current = best.get(key);
      if (!current) {
        best.set(key, row);
        continue;
      }
      const rank = (r: Row) =>
        (r.folder === viewed && r.movePending === null ? 8 : 0) +
        (r.movePending === null ? 4 : 0) +
        (this.isInbox(r.accountId, r.folder) ? 2 : 0) +
        (viewed !== null && !this.isAllMail(r.accountId, r.folder) ? 1 : 0);
      if (
        rank(row) > rank(current) ||
        (rank(row) === rank(current) && order.get(row)! > order.get(current)!)
      ) {
        best.set(key, row);
      }
    }
    return [...best.values()];
  }

  private folderRows(accountId: string, folder: string): Row[] {
    return this.state.rows.filter((r) => r.accountId === accountId && r.folder === folder);
  }

  private attachedRows(accountId: string, folder: string): (Row & { uid: number })[] {
    return this.folderRows(accountId, folder).filter(
      (r): r is Row & { uid: number } => r.uid !== null,
    );
  }

  private summary(row: Row): MessageSummary {
    return {
      id: row.id,
      accountId: row.accountId,
      folder: row.folder,
      threadId: row.threadId,
      date: row.message.date,
      from: { ...row.message.from },
      subject: row.message.subject,
      snippet: snippetOf(row.message),
      isRead: row.isRead,
      isFlagged: row.isFlagged,
      hasAttachments: row.message.attachments.some((a) => !a.isInline),
      kept: row.kept,
      labels: ownerLabels(this.labelsOfCopies(row)),
    };
  }

  private header(row: Row): MessageHeader {
    return {
      ...this.summary(row),
      to: row.message.to.map((a) => ({ ...a })),
      cc: row.message.cc.map((a) => ({ ...a })),
      attachments: row.message.attachments.map((a) => ({ ...a, kind: fileKindOf(a.mimeType, a.filename) })),
      draftId: row.uid === null ? null : this.draftForServerCopy(row.accountId, row.folder, row.uid),
      agentSubject: redactSecrets(row.message.subject).text,
      inAiScope: this.anyCopyInScope(row),
      devLinks: [],
      dev: row.dev ?? null,
      patch: null,
      alert: false,
      bbLinks: this.state.bbLinks
        .filter((link) => link.messageId === row.id)
        .map((link) => ({ kind: link.kind, targetId: link.targetId, projectId: link.projectId, title: null, createdAt: link.createdAt })),
    };
  }

  /** Rows of `folder` not waiting to move: the scope of a folder view's star. */
  private inFolder(folder: string): (row: Row) => boolean {
    return (r) => r.folder === folder && r.movePending === null;
  }

  /** The effective special use of a folder (store-rules effectiveSpecialUse). */
  private roleOf(accountId: string, path: string): SpecialUse | null {
    const saved = (this.state.folders.get(accountId) ?? []).find((f) => f.path === path);
    return effectiveSpecialUse(path, saved?.specialUse ?? null);
  }

  /** `flagged` covers the thread's rows in the viewed scope (`inScope`). */
  private summarize(threadId: string, rows: Row[], inScope: (row: Row) => boolean): ThreadSummary {
    const sorted = [...rows].sort(oldestFirst);
    const latest = sorted[sorted.length - 1]!;
    const participants: MailAddress[] = [];
    for (const row of sorted) {
      if (!participants.some((p) => p.address === row.message.from.address)) {
        participants.push({ ...row.message.from });
      }
    }
    return {
      id: threadId,
      accountId: latest.accountId,
      subject: sorted[0]!.message.subject,
      lastDate: latest.message.date,
      messageCount: new Set(rows.map((r) => r.dedupKey)).size,
      unreadCount: new Set(rows.filter((r) => !r.isRead).map((r) => r.dedupKey)).size,
      participants,
      snippet: snippetOf(latest.message),
      flagged: rows.some((r) => inScope(r) && r.isFlagged),
      snoozedUntil: this.snoozedUntil(rows.filter(inScope)),
      ...this.labelsOf(rows.filter((r) => inScope(r) && r.movePending === null)),
      projectId: this.projectOf(latest.accountId, threadId),
    };
  }

  /** The label and model suggestion of the latest of these rows (undated as newest, then date, then id). */
  private labelsOf(rows: Row[]): { category: Category | null; categorySuggestion: Category | null } {
    const latest = [...rows].sort(oldestFirst).pop();
    if (latest === undefined) return { category: null, categorySuggestion: null };
    const key = stateKey(latest.accountId, latest.dedupKey);
    const suggestion = this.state.categorySuggestions.get(key) ?? null;
    return {
      category: this.state.categories.get(key)?.category ?? null,
      categorySuggestion: suggestion === null || suggestion === "none" ? null : suggestion,
    };
  }

  /** The earliest snooze due time of these rows, or null. */
  private snoozedUntil(rows: Row[]): string | null {
    const due = rows.flatMap((r) => {
      const snooze = this.state.snoozes.get(r.id);
      return snooze ? [snooze.dueAt] : [];
    });
    return due.length === 0 ? null : due.sort()[0]!;
  }

  /**
   * A row that lists its thread: in scope and matching every filter flag on
   * itself, or (with `keep`) any in-scope row of the kept thread.
   */
  private member(inScope: (row: Row) => boolean, filter: ThreadFilter | undefined): (row: Row) => boolean {
    return (r) => {
      if (!inScope(r)) return false;
      if (filter?.keep !== undefined && r.threadId === filter.keep) return true;
      if (filter?.unread === true && r.isRead) return false;
      if (filter?.flagged === true && !r.isFlagged) return false;
      if (filter?.attachments === true && !r.message.attachments.some((a) => !a.isInline)) return false;
      if (filter?.category !== undefined && this.state.categories.get(stateKey(r.accountId, r.dedupKey))?.category !== filter.category) {
        return false;
      }
      if (filter?.notDev === true && r.dev !== undefined && r.dev !== null) return false;
      if (filter?.projectId !== undefined && this.projectOf(r.accountId, r.threadId) !== filter.projectId) return false;
      return true;
    };
  }

  /** Whole threads (all folders) that have at least one message in `folder`. */
  private threadSummaries(accountId: string, folder: string, filter?: ThreadFilter): ThreadSummary[] {
    const inScope = (r: Row) => r.accountId === accountId && r.folder === folder && r.movePending === null;
    const inFolder = new Set(this.state.rows.filter(this.member(inScope, filter)).map((r) => r.threadId));
    const groups = new Map<string, Row[]>();
    for (const row of this.state.rows) {
      if (row.accountId !== accountId || !inFolder.has(row.threadId)) continue;
      const group = groups.get(row.threadId);
      if (group) group.push(row);
      else groups.set(row.threadId, [row]);
    }
    return [...groups.entries()]
      .map(([id, rows]) => this.summarize(id, rows, this.inFolder(folder)))
      .sort((a, b) => (timeOf(b.lastDate) ?? -Infinity) - (timeOf(a.lastDate) ?? -Infinity));
  }
}

/** Slice 3g: the List-Id kept from the fetched bulk headers ('' = none); undefined without headers (as SQLite). */
function listIdOf(message: FetchedMessage): string | undefined {
  return message.bulkHeaders === undefined ? undefined : (normalizeListId(message.bulkHeaders.listId) ?? "");
}

function senderKey(accountId: string, address: string): string {
  return `${accountId}\u0000${address.toLowerCase()}`;
}

function oldestFirst(a: Row, b: Row): number {
  const ta = timeOf(a.message.date) ?? Infinity;
  const tb = timeOf(b.message.date) ?? Infinity;
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Scripted IMAP gateway
// ---------------------------------------------------------------------------

/** A server-side folder the scripted gateway serves. */
export type FakeMailbox = {
  uidValidity: number;
  uidNext: number;
  messages: FetchedMessage[];
  /** INTERNALDATE by uid where it differs from the header date (SEARCH SINCE uses it). */
  internalDates?: Map<number, string>;
};

type SessionMethod = Exclude<keyof FolderSession, "close">;

export type SessionCall = {
  method: SessionMethod;
  uids?: number[];
  date?: Date;
  uid?: number;
  destination?: string;
  change?: FlagChange;
  flags?: string[];
  raw?: Uint8Array;
  messageId?: string;
  guard?: { messageId: string; size: number };
  fields?: string[];
};

export type OpenedSession = {
  path: string;
  readOnly: boolean;
  config: ImapConfig;
  calls: SessionCall[];
  closed: boolean;
};

/**
 * An error shaped like the BB gateway's SafeImapError: a safe `code`, no
 * server text. Codes the sync reads: "MoveFailed" (the server refused a move)
 * and "MoveUnsupported" (the server cannot move without a plain EXPUNGE).
 */
export function imapError(code: string): Error {
  return Object.assign(new Error(`IMAP error (${code})`), { name: "SafeImapError", code });
}

const ANY_PATH = "\u0000any";

function failureKey(method: SessionMethod, path: string | undefined): string {
  return `${path ?? ANY_PATH}\u0000${method}`;
}

/**
 * Serves one FakeMailbox per folder path; a new gateway lists only INBOX,
 * which reproduces the slice-1 single-folder server. Folders are listed in
 * `folders` order (the store sorts them). Failures are scripted per method
 * with `failNext` (one call) or `failAlways`, optionally for one path only;
 * `failOpen` makes every login (listFolders and openFolder) throw and
 * `failOpenFolder` only the opening of one path. Moves move messages between
 * the mailboxes with new destination uids and return the uid map, or null
 * when `moveUidMap` is false (a server without UIDPLUS). `setFlags` applies
 * \Seen / \Flagged to the mailbox; `gateStore` holds the next STORE open
 * until released, so a test can act while a push is in flight.
 */
export class ScriptedImapGateway implements ImapGateway {
  readonly sessions: OpenedSession[] = [];
  readonly mailboxes = new Map<string, FakeMailbox>();
  folders: RemoteFolder[] = [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
  ];
  listFoldersCalls = 0;
  moveUidMap = true;
  /** The server advertises UIDPLUS (APPENDUID, UID EXPUNGE). */
  uidplus = true;
  /** The server is Gmail (X-GM-EXT-1). */
  gmail = false;
  /** APPEND answers with APPENDUID. */
  appendUid = true;
  /** Every APPEND, in order. */
  readonly appended: { path: string; uid: number; flags: string[]; raw: Uint8Array }[] = [];
  /** Every message expungeOwn removed. */
  readonly expunged: { path: string; uid: number }[] = [];
  private openFailure: Error | null = null;
  private readonly openFolderFailures = new Map<string, Error>();
  private readonly onceFailures = new Map<string, Error>();
  private readonly alwaysFailures = new Map<string, Error>();
  private storeGate: { enter: () => void; released: Promise<void> } | null = null;

  constructor(mailbox: FakeMailbox) {
    this.mailboxes.set("INBOX", mailbox);
  }

  /** The INBOX mailbox (slice-1 tests replace it whole). */
  get mailbox(): FakeMailbox {
    return this.mailboxes.get("INBOX")!;
  }

  set mailbox(mailbox: FakeMailbox) {
    this.mailboxes.set("INBOX", mailbox);
  }

  /**
   * Lists a folder; a selectable one gets a mailbox (empty unless given).
   * Returns the folder's mailbox, or undefined for a \Noselect folder.
   */
  addFolder(
    folder: Partial<RemoteFolder> & { path: string },
    mailbox?: FakeMailbox,
  ): FakeMailbox | undefined {
    const listed: RemoteFolder = {
      name: folder.path.split("/").pop() ?? folder.path,
      delimiter: "/",
      specialUse: null,
      selectable: true,
      subscribed: true,
      ...folder,
    };
    this.folders = [...this.folders.filter((f) => f.path !== listed.path), listed];
    if (listed.selectable) {
      this.mailboxes.set(listed.path, mailbox ?? { uidValidity: 1, uidNext: 1, messages: [] });
    }
    return this.mailboxes.get(listed.path);
  }

  /** The folder is deleted on the server. */
  removeFolder(path: string): void {
    this.folders = this.folders.filter((f) => f.path !== path);
    this.mailboxes.delete(path);
  }

  /** Adds a message to the folder's mailbox with the next uid. */
  deliver(overrides: Partial<FetchedMessage> = {}, path = "INBOX"): FetchedMessage {
    const box = this.mailboxes.get(path)!;
    const message = makeFetchedMessage(box.uidNext, overrides);
    message.uid = box.uidNext++;
    box.messages.push(message);
    return message;
  }

  failOpen(error: Error | null): void {
    this.openFailure = error;
  }

  failOpenFolder(path: string, error: Error | null): void {
    if (error) this.openFolderFailures.set(path, error);
    else this.openFolderFailures.delete(path);
  }

  failNext(method: SessionMethod, error: Error, path?: string): void {
    this.onceFailures.set(failureKey(method, path), error);
  }

  failAlways(method: SessionMethod, error: Error, path?: string): void {
    this.alwaysFailures.set(failureKey(method, path), error);
  }

  /** Undoes failAlways (and a pending failNext) for the method. */
  clearFailure(method: SessionMethod, path?: string): void {
    this.alwaysFailures.delete(failureKey(method, path));
    this.onceFailures.delete(failureKey(method, path));
  }

  /**
   * Holds the next setFlags call after it is recorded and before it changes
   * the mailbox. `entered` resolves when that call arrives; `release` lets it
   * finish.
   */
  gateStore(): { entered: Promise<void>; release: () => void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.storeGate = { enter, released };
    return { entered, release };
  }

  async test(): Promise<ImapTestResult> {
    return this.openFailure
      ? {
          ok: false,
          reason: this.openFailure.name,
          authFailed: this.openFailure instanceof ImapAuthError,
        }
      : { ok: true };
  }

  /** Every watchFolder call (slice 3e); the watch ends at once with `watchEnd`. */
  readonly watched: string[] = [];
  watchEnd: WatchEnd = { kind: "unsupported" };
  /** Every createFolder call, in order; a name in `refuseCreate` throws CreateFailed. */
  readonly created: string[] = [];
  readonly refuseCreate = new Set<string>();

  async watchFolder(
    _config: ImapConfig,
    path: string,
    _onChange: (change: "exists" | "expunge" | "flags") => void,
    _signal: AbortSignal,
  ): Promise<WatchEnd> {
    this.watched.push(path);
    return this.watchEnd;
  }

  async createFolder(_config: ImapConfig, name: string): Promise<{ path: string; created: boolean }> {
    this.created.push(name);
    if (this.openFailure) throw this.openFailure;
    if (this.refuseCreate.has(name)) throw imapError("CreateFailed");
    if (this.folders.some((folder) => folder.path === name)) return { path: name, created: false };
    this.addFolder({ path: name });
    return { path: name, created: true };
  }

  // Slice 3h folder writes: Task 3 stubs; Task 5 gives them behaviour.
  async renameFolder(_config: ImapConfig, _from: string, _to: string): Promise<{ path: string }> {
    throw new Error(NOT_YET);
  }

  async folderStatus(_config: ImapConfig, _path: string): Promise<{ messages: number; uidValidity: number }> {
    throw new Error(NOT_YET);
  }

  async deleteFolder(_config: ImapConfig, _path: string, _options: { expectEmpty: boolean }): Promise<void> {
    throw new Error(NOT_YET);
  }

  async setSubscribed(_config: ImapConfig, _path: string, _subscribed: boolean): Promise<void> {
    throw new Error(NOT_YET);
  }

  namedLikeSpecialUse(_name: string): boolean {
    return false;
  }

  async listFolders(_config: ImapConfig): Promise<RemoteFolder[]> {
    this.listFoldersCalls++;
    if (this.openFailure) throw this.openFailure;
    return this.folders.map((f) => ({ ...f }));
  }

  async openFolder(
    config: ImapConfig,
    path: string,
    options: { readOnly: boolean },
  ): Promise<FolderSession> {
    if (this.openFailure) throw this.openFailure;
    const pathFailure = this.openFolderFailures.get(path);
    if (pathFailure) throw pathFailure;
    if (!this.mailboxes.has(path)) throw imapError("NoSuchMailbox");
    const opened: OpenedSession = {
      path,
      readOnly: options.readOnly,
      config: { ...config },
      calls: [],
      closed: false,
    };
    this.sessions.push(opened);
    const take = (method: SessionMethod): Error | undefined => {
      for (const key of [failureKey(method, path), failureKey(method, undefined)]) {
        const once = this.onceFailures.get(key);
        if (once) {
          this.onceFailures.delete(key);
          return once;
        }
        const always = this.alwaysFailures.get(key);
        if (always) return always;
      }
      return undefined;
    };
    const record = (call: SessionCall) => {
      opened.calls.push(call);
      const failure = take(call.method);
      if (failure) throw failure;
    };
    // Looked up on every call, so a test may replace a mailbox mid-session.
    const box = () => {
      const mailbox = this.mailboxes.get(path);
      if (!mailbox) throw imapError("NoSuchMailbox");
      return mailbox;
    };
    return {
      status: async () => {
        record({ method: "status" });
        return {
          uidValidity: box().uidValidity,
          uidNext: box().uidNext,
          exists: box().messages.length,
        };
      },
      searchSince: async (date) => {
        record({ method: "searchSince", date });
        return box()
          // SINCE uses the server's internal date, which every message has; it
          // is the header date unless internalDates says otherwise, and an
          // undated fixture stands for a recent one.
          .messages.filter(
            (m) =>
              (timeOf(box().internalDates?.get(m.uid) ?? m.date) ?? Infinity) >= date.getTime(),
          )
          .map((m) => m.uid);
      },
      uidsAfter: async (uid) => {
        record({ method: "uidsAfter", uid });
        return box().messages.filter((m) => m.uid > uid).map((m) => m.uid);
      },
      fetchMessages: async (uids) => {
        record({ method: "fetchMessages", uids: [...uids] });
        return uids.flatMap((uid) => {
          const message = box().messages.find((m) => m.uid === uid);
          return message ? [structuredClone(message)] : [];
        });
      },
      fetchListHeaders: async (uids) => {
        record({ method: "fetchListHeaders", uids: [...uids] });
        return uids.flatMap((uid) => {
          const message = box().messages.find((m) => m.uid === uid);
          return message ? [{ uid, block: listHeaderBlock(message) }] : [];
        });
      },
      fetchHeaderFields: async (uids, fields) => {
        record({ method: "fetchHeaderFields", uids: [...uids], fields: [...fields] });
        return uids.flatMap((uid) => {
          const message = box().messages.find((m) => m.uid === uid);
          return message ? [{ uid, block: headerFieldsBlock(message, fields) }] : [];
        });
      },
      fetchFlags: async (uids) => {
        record({ method: "fetchFlags", uids: [...uids] });
        return uids.flatMap((uid) => {
          const message = box().messages.find((m) => m.uid === uid);
          return message
            ? [{ uid, seen: message.seen, flagged: message.flagged, gmMsgId: message.gmMsgId }]
            : [];
        });
      },
      markSeen: async (uids) => {
        record({ method: "markSeen", uids: [...uids] });
        if (options.readOnly) throw new Error("Mailbox is read-only");
        for (const message of box().messages) {
          if (uids.includes(message.uid)) message.seen = true;
        }
      },
      setFlags: async (uids, change) => {
        record({ method: "setFlags", uids: [...uids], change: { ...change } });
        if (options.readOnly) throw imapError("ReadOnly");
        const gate = this.storeGate;
        if (gate) {
          this.storeGate = null;
          gate.enter();
          await gate.released;
        }
        for (const message of box().messages) {
          if (!uids.includes(message.uid)) continue;
          if (change.seen !== undefined) message.seen = change.seen;
          if (change.flagged !== undefined) message.flagged = change.flagged;
        }
      },
      fetchRaw: async () => {
        throw new Error("not implemented: fetchRaw");
      },
      moveMessages: async (uids, destination) => {
        record({ method: "moveMessages", uids: [...uids], destination });
        if (options.readOnly) throw new Error("Mailbox is read-only");
        const target = this.mailboxes.get(destination);
        if (!target) throw imapError("MoveFailed");
        const source = box();
        const moved = new Map<number, number>();
        for (const uid of uids) {
          const index = source.messages.findIndex((m) => m.uid === uid);
          // A uid no longer in the folder is skipped, as servers do.
          if (index < 0) continue;
          const [message] = source.messages.splice(index, 1);
          const newUid = target.uidNext++;
          target.messages.push({ ...message!, uid: newUid });
          moved.set(uid, newUid);
        }
        return { moved: this.moveUidMap ? moved : null };
      },
      copyMessages: async (uids, destination) => {
        record({ method: "copyMessages", uids: [...uids], destination });
        if (options.readOnly) throw imapError("ReadOnly");
        const target = this.mailboxes.get(destination);
        if (!target) throw imapError("CopyFailed");
        const copied = new Map<number, number>();
        for (const uid of uids) {
          const message = box().messages.find((m) => m.uid === uid);
          if (message === undefined) continue;
          const newUid = target.uidNext++;
          target.messages.push({ ...message, uid: newUid });
          copied.set(uid, newUid);
        }
        return { copied: this.moveUidMap ? copied : null };
      },
      capabilities: () => {
        record({ method: "capabilities" });
        return { uidplus: this.uidplus, gmail: this.gmail };
      },
      appendMessage: async (raw, flags) => {
        record({ method: "appendMessage", flags: [...flags], raw: raw.slice() });
        if (options.readOnly) throw imapError("ReadOnly");
        const target = box();
        const uid = target.uidNext++;
        const messageId = headerValue(raw, "message-id");
        target.messages.push(
          makeFetchedMessage(uid, {
            messageId: messageId === null ? null : normalizeMessageId(messageId),
            subject: headerValue(raw, "subject") ?? "",
            size: raw.length,
            seen: flags.includes("\\Seen"),
          }),
        );
        this.appended.push({ path, uid, flags: [...flags], raw: raw.slice() });
        return this.appendUid ? { uidValidity: target.uidValidity, uid } : { uidValidity: null, uid: null };
      },
      findByMessageId: async (messageId) => {
        record({ method: "findByMessageId", messageId });
        const wanted = normalizeMessageId(messageId);
        return box()
          .messages.filter((m) => m.messageId !== null && normalizeMessageId(m.messageId) === wanted)
          .map((m) => m.uid);
      },
      expungeOwn: async (uid, guard) => {
        record({ method: "expungeOwn", uid, guard: { ...guard } });
        if (!this.uidplus) throw imapError("ExpungeUnsupported");
        if (options.readOnly) throw imapError("ReadOnly");
        const messages = box().messages;
        const index = messages.findIndex((m) => m.uid === uid);
        const message = messages[index];
        if (
          message === undefined ||
          message.messageId === null ||
          normalizeMessageId(message.messageId) !== normalizeMessageId(guard.messageId) ||
          message.size !== guard.size
        ) {
          throw imapError("GuardMismatch");
        }
        messages.splice(index, 1);
        this.expunged.push({ path, uid });
      },
      // Slice 3h: Task 3 stubs; Task 5 gives them behaviour.
      searchServer: async () => {
        throw new Error(NOT_YET);
      },
      fetchLabels: async () => [],
      setLabels: async () => {
        throw new Error(NOT_YET);
      },
      close: async () => {
        opened.closed = true;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Compose and send (slice 3b) doubles
// ---------------------------------------------------------------------------

/**
 * Records every send and verify. A send answers the next scripted result or
 * error, else accepts every envelope recipient; `gateSend` holds the next
 * send after it is recorded, so a test can act while SMTP is in flight.
 */
export class FakeTransport implements MailTransport {
  readonly sent: { config: SmtpConfig; envelopeFrom: string; envelopeTo: string[]; raw: Uint8Array }[] = [];
  readonly verified: SmtpConfig[] = [];
  verifyError: Error | null = null;
  private readonly script: (SendResult | Error)[] = [];
  private gate: { enter: () => void; released: Promise<void> } | null = null;

  /** The next sends answer these, in order. */
  answer(...results: (SendResult | Error)[]): void {
    this.script.push(...results);
  }

  gateSend(): { entered: Promise<void>; release: () => void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.gate = { enter, released };
    return { entered, release };
  }

  async verify(config: SmtpConfig): Promise<void> {
    this.verified.push({ ...config });
    if (this.verifyError) throw this.verifyError;
  }

  async send(
    config: SmtpConfig,
    message: { envelopeFrom: string; envelopeTo: string[]; raw: Uint8Array },
    _signal: AbortSignal,
  ): Promise<SendResult> {
    this.sent.push({
      config: { ...config },
      envelopeFrom: message.envelopeFrom,
      envelopeTo: [...message.envelopeTo],
      raw: message.raw.slice(),
    });
    const gate = this.gate;
    if (gate) {
      this.gate = null;
      gate.enter();
      await gate.released;
    }
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? { accepted: [...message.envelopeTo], rejected: [] };
  }
}

/**
 * Builds plain, readable bytes: the headers a real builder writes (never a
 * Bcc), an empty line, the text, then one line per attachment. Records
 * every input.
 */
export class FakeBuilder implements MessageBuilder {
  readonly built: OutgoingMessage[] = [];
  failNext: Error | null = null;

  async build(input: OutgoingMessage): Promise<Uint8Array> {
    this.built.push(structuredClone(input));
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const list = (addresses: { address: string }[]) => addresses.map((a) => a.address).join(", ");
    const lines = [
      `Message-ID: ${input.messageId}`,
      `Date: ${input.date}`,
      `From: ${input.from.address}`,
      `To: ${list(input.to)}`,
      ...(input.cc.length > 0 ? [`Cc: ${list(input.cc)}`] : []),
      `Subject: ${input.subject}`,
      ...(input.inReplyTo === null ? [] : [`In-Reply-To: ${input.inReplyTo}`]),
      ...(input.references.length === 0 ? [] : [`References: ${input.references.join(" ")}`]),
      "",
      input.text,
      ...input.attachments.map((a) => `[attachment ${a.fileName} ${a.bytes.length}]`),
    ];
    return new TextEncoder().encode(lines.join("\r\n"));
  }
}

/** Serves originals by message id; an unknown id (or a scripted error) throws. */
export class FakeOriginalReader implements OriginalReader {
  readonly reads: string[] = [];
  readonly originals = new Map<string, OriginalMessage | Error>();

  async read(messageId: string): Promise<OriginalMessage> {
    this.reads.push(messageId);
    const original = this.originals.get(messageId);
    if (original === undefined) throw imapError("NotFound");
    if (original instanceof Error) throw original;
    return structuredClone(original);
  }
}

/** One promise chain per account (a rejection does not poison it); records each run's account. */
export class SerialQueue implements AccountWriteQueue {
  readonly runs: string[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    this.runs.push(accountId);
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    const result = previous.then(task);
    this.tails.set(
      accountId,
      result.catch(() => undefined),
    );
    return result;
  }
}

export class RecordingOutboxNotifier implements OutboxNotifier {
  readonly events: OutboxChangedPayload[] = [];
  outboxChanged(payload: OutboxChangedPayload): void {
    this.events.push({ ...payload });
  }
}

/**
 * A compose and outbox setup over the fakes: one account (acc_1,
 * owner@example.org, sealed password "invented-password", SMTP set, Sent
 * copy by APPEND) whose server and store both list INBOX, Drafts and Sent.
 */
export function composeHarness(options: { now?: string } = {}) {
  const store = new InMemoryMailStore();
  const gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
  const drafts = gateway.addFolder({ path: "Drafts", specialUse: "drafts" }, { uidValidity: 7, uidNext: 1, messages: [] })!;
  const sent = gateway.addFolder({ path: "Sent", specialUse: "sent" }, { uidValidity: 9, uidNext: 1, messages: [] })!;
  store.saveAccount(
    makeStoredAccount({
      passwordSealed: "invented-password",
      smtp: { host: "smtp.example.org", port: 465, security: "tls", username: null },
      sentCopy: "append",
    }),
  );
  store.saveFolders("acc_1", gateway.folders);
  let ids = 0;
  const clock = new FixedClock(new Date(options.now ?? "2026-11-15T10:00:00.000Z"));
  /** Every backoff the outbox asked for, in ms; each one moves the clock instead of waiting. */
  const sleeps: number[] = [];
  const harness = { onSleep: null as (() => void) | null };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.set(new Date(clock.now().getTime() + ms));
    harness.onSleep?.();
  };
  const deps = {
    store,
    gateway,
    vault: new IdentityVault(),
    clock,
    newId: () => `id${++ids}`,
    builder: new FakeBuilder(),
    reader: new FakeOriginalReader(),
    queue: new SerialQueue(),
    notifier: new RecordingOutboxNotifier(),
    transport: new FakeTransport(),
    sleep,
  };
  /** Moves the clock forward. */
  const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  /** Agent proposal deps (slice 3c): the send cap, undone ids, numbered view tokens and a vault switch. */
  const proposal = { vaultOpen: true, tokens: 0 };
  const proposalDeps: ProposalDeps = {
    ...deps,
    rate: new SendRateLimit(clock),
    undone: new UndoneSends(clock),
    randomToken: () => `tok${String(++proposal.tokens).padStart(40, "0")}`,
    vaultReady: () => proposal.vaultOpen,
  };
  return Object.assign(harness, { ...deps, deps, drafts, sent, advance, sleeps, proposal, proposalDeps });
}

/** A stored rule run without the fake's dedup key. */
function publicRun(run: RuleRunRecord & { messageKey: string }): RuleRunRecord {
  const { messageKey: _key, ...rest } = run;
  return rest;
}
