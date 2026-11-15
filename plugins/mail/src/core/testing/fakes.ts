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
} from "../model.ts";
import { headerValue, normalizeMessageId } from "../headers.ts";
import { ImapAuthError, type AccountWriteQueue, type MailTransport, type MessageBuilder, type OriginalReader, type OutboxNotifier, type SendResult, type SmtpConfig } from "../ports.ts";
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
  SecretVault,
} from "../ports.ts";

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
    ...overrides,
  };
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
};

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
};

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

const MOVE_MAX_FAILURES = 3;

function stateKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

function timeOf(date: string | null): number | null {
  if (date === null) return null;
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : null;
}

function snippetOf(message: FetchedMessage): string {
  return snippetFromBody(message.bodyText, message.bodyHtml);
}

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
  };

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
    return before - this.state.rows.length;
  }

  // Messages ---------------------------------------------------------------

  upsertMessages(accountId: string, folder: string, messages: FetchedMessage[]): void {
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
        row.uid = message.uid;
        row.message = structuredClone(message);
        row.isRead = row.seenDesired ?? message.seen;
        row.isFlagged = row.flagDesired ?? message.flagged;
        row.gmMsgId = message.gmMsgId ?? row.gmMsgId;
        row.dedupKey = dedupKeyOf(row.gmMsgId, message.messageId, message.size, row.id);
        row.inlineParts = inlineParts;
        continue;
      }
      const id = `m_${this.state.nextId++}`;
      this.state.rows.push({
        id,
        accountId,
        folder,
        uid: message.uid,
        message: structuredClone(message),
        isRead: message.seen,
        isFlagged: message.flagged,
        seenDesired: null,
        flagDesired: null,
        threadId: `t_${id}`,
        gmMsgId: message.gmMsgId,
        dedupKey: dedupKeyOf(message.gmMsgId, message.messageId, message.size, id),
        movePending: null,
        moveFailures: 0,
        inlineParts,
      });
    }
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
    return before - this.state.rows.length;
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
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    const all = this.threadSummaries(accountId, folder);
    const offset = cursor === null ? 0 : Number(cursor);
    const threads = all.slice(offset, offset + limit);
    const next = offset + threads.length;
    return { threads, nextCursor: next < all.length ? String(next) : null };
  }

  listThreadsAll(
    role: SpecialUse,
    cursor: string | null,
    limit: number,
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    if (role === "all") return { threads: [], nextCursor: null };
    const inRole = (r: Row) => r.movePending === null && this.roleOf(r.accountId, r.folder) === role;
    const listed = new Set(this.state.rows.filter(inRole).map((r) => r.threadId));
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
    return { thread, messages };
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
      remoteImagesAllowed: this.isImageSenderAllowed(row.accountId, row.message.from.address),
    };
  }

  search(query: ParsedQuery, accountId: string | null, limit: number): MessageSummary[] {
    const contains = (haystack: string | null | undefined, needle: string) =>
      (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
    const after = query.after === undefined ? null : Date.parse(query.after);
    const before = query.before === undefined ? null : Date.parse(query.before);
    const matches = this.state.rows
      .filter((r) => accountId === null || r.accountId === accountId)
      .filter((r) => r.movePending === null)
      .filter((r) => {
        const m = r.message;
        const time = timeOf(m.date);
        if (query.text && !(
          contains(m.subject, query.text) ||
          contains(m.from.name, query.text) ||
          contains(m.from.address, query.text) ||
          contains(m.bodyText, query.text)
        )) return false;
        if (query.from && !(contains(m.from.name, query.from) || contains(m.from.address, query.from))) return false;
        if (query.subject && !contains(m.subject, query.subject)) return false;
        if (query.unread !== undefined && r.isRead === query.unread) return false;
        if (after !== null && (time === null || time < after)) return false;
        if (before !== null && (time === null || time >= before)) return false;
        return true;
      });
    return this.onePerKey(matches, (r) => `${r.accountId}\u0000${r.dedupKey}`)
      .sort((a, b) => oldestFirst(b, a))
      .slice(0, limit)
      .map((r) => this.summary(r));
  }

  /** Snippets here are computed on read, so nothing stored can be stale. */
  repairSnippets(): number {
    return 0;
  }

  // Compose and send (slice 3b) ----------------------------------------------

  createDraft(input: NewDraft): DraftRecord {
    const record: DraftRecord = {
      ...structuredClone(input),
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
      position: own.reduce((max, a) => Math.max(max, a.position), -1) + 1,
    };
    this.state.composeAttachments.push(stored);
    return { id: stored.id, fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size };
  }

  listAttachments(draftId: string): ComposeAttachment[] {
    return this.draftAttachments(draftId).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
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

  claimDueOutbox(nowIso: string, busyAccounts: string[]): OutboxRecord | null {
    const now = Date.parse(nowIso);
    const due = [...this.state.outbox.values()]
      .map((e) => e.record)
      .filter(
        (r) => r.state === "queued" && Date.parse(r.sendAfter) <= now && !busyAccounts.includes(r.accountId),
      )
      .sort(dueOrder)[0];
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
    }
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
    return { accountId: first.accountId, folder: first.folder };
  }

  completeMove(
    accountId: string,
    folder: string,
    destination: string,
    moved: Map<number, number> | null,
    uids: number[],
  ): void {
    const takeOver = (row: Row, occupant: Row | undefined, uid: number | null) => {
      row.movePending = null;
      row.moveFailures = 0;
      row.folder = destination;
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
    };
  }

  private header(row: Row): MessageHeader {
    return {
      ...this.summary(row),
      to: row.message.to.map((a) => ({ ...a })),
      cc: row.message.cc.map((a) => ({ ...a })),
      attachments: row.message.attachments.map((a) => ({ ...a })),
      draftId: row.uid === null ? null : this.draftForServerCopy(row.accountId, row.folder, row.uid),
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
    };
  }

  /** Whole threads (all folders) that have at least one message in `folder`. */
  private threadSummaries(accountId: string, folder: string): ThreadSummary[] {
    const inFolder = new Set(
      this.state.rows
        .filter((r) => r.accountId === accountId && r.folder === folder && r.movePending === null)
        .map((r) => r.threadId),
    );
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
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
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
  };
  /** Moves the clock forward. */
  const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  return { ...deps, deps, drafts, sent, advance };
}
