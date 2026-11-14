// Test doubles for the core ports. Imports only the core, so tests of any layer
// can drive core use cases without a database or an IMAP server. The in-memory
// MailStore follows the semantics the SQLite store implements:
//   - a pending local read (seen_pending) wins over server flags;
//   - beginFolderReset detaches uids but keeps message ids, upsertMessages
//     reattaches a detached row with the same non-null Message-ID, and
//     finishFolderReset deletes the rows still detached;
//   - markOpened marks every unread copy (same dedup key) read and pending;
//     a detached copy (no uid to push) is only marked read;
//   - localFolderIndex treats a message without a date as inside the window;
//   - thread, folder, badge and search counts count distinct dedup keys, and
//     rows waiting to move out are hidden from their folder, the badge and
//     search; moves re-home rows (same id), detaching them without a uid map.
import type {
  FetchedMessage,
  Folder,
  InlinePart,
  MailAddress,
  MessageBody,
  MessageHeader,
  MessageSummary,
  ParsedQuery,
  RemoteFolder,
  StoredAccount,
  SyncState,
  ThreadDetail,
  ThreadingInput,
  ThreadSummary,
} from "../model.ts";
import { ImapAuthError } from "../ports.ts";
import { snippetOf as snippetFromBody } from "../snippet.ts";
import {
  capInlineParts,
  compareFolders,
  dedupKeyOf,
  effectiveSpecialUse,
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
  seenPending: boolean;
  isFlagged: boolean;
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
};

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
        row.isRead = row.seenPending || message.seen;
        row.isFlagged = message.flagged;
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
        seenPending: false,
        isFlagged: message.flagged,
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
      const isRead = row.seenPending || flag.seen;
      let rowChanged = false;
      if (row.isRead !== isRead || row.isFlagged !== flag.flagged) {
        row.isRead = isRead;
        row.isFlagged = flag.flagged;
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

  pendingSeenUids(accountId: string, folder: string): number[] {
    return this.attachedRows(accountId, folder)
      .filter((r) => r.seenPending)
      .map((r) => r.uid);
  }

  clearSeenPending(accountId: string, folder: string, uids: number[]): void {
    const cleared = new Set(uids);
    for (const row of this.attachedRows(accountId, folder)) {
      if (cleared.has(row.uid)) row.seenPending = false;
    }
  }

  markOpened(messageId: string): { accountId: string } | null {
    const row = this.state.rows.find((r) => r.id === messageId);
    if (!row) return null;
    if (!row.isRead) {
      row.isRead = true;
      row.seenPending = true;
    }
    for (const copy of this.state.rows) {
      if (copy.accountId !== row.accountId || copy.dedupKey !== row.dedupKey || copy.isRead) continue;
      copy.isRead = true;
      if (copy.uid !== null) copy.seenPending = true;
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

  getThread(threadId: string, folder: string): ThreadDetail | null {
    const rows = this.state.rows.filter((r) => r.threadId === threadId);
    if (rows.length === 0) return null;
    const thread = this.summarize(threadId, rows);
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
        if (occupant.seenPending) {
          row.seenPending = true;
          row.isRead = true;
        }
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
    };
  }

  private summarize(threadId: string, rows: Row[]): ThreadSummary {
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
      .map(([id, rows]) => this.summarize(id, rows))
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
 * when `moveUidMap` is false (a server without UIDPLUS).
 */
export class ScriptedImapGateway implements ImapGateway {
  readonly sessions: OpenedSession[] = [];
  readonly mailboxes = new Map<string, FakeMailbox>();
  folders: RemoteFolder[] = [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
  ];
  listFoldersCalls = 0;
  moveUidMap = true;
  private openFailure: Error | null = null;
  private readonly openFolderFailures = new Map<string, Error>();
  private readonly onceFailures = new Map<string, Error>();
  private readonly alwaysFailures = new Map<string, Error>();

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
      close: async () => {
        opened.closed = true;
      },
    };
  }
}
