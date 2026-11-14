// Test doubles for the core ports. Imports only the core, so tests of any layer
// can drive core use cases without a database or an IMAP server. The in-memory
// MailStore follows the semantics the SQLite store implements:
//   - a pending local read (seen_pending) wins over server flags;
//   - beginFolderReset detaches uids but keeps message ids, upsertMessages
//     reattaches a detached row with the same non-null Message-ID, and
//     finishFolderReset deletes the rows still detached;
//   - markOpened sets read + pending only when the message is unread;
//   - localFolderIndex treats a message without a date as inside the window.
import type {
  FetchedMessage,
  MailAddress,
  MessageBody,
  MessageHeader,
  MessageSummary,
  ParsedQuery,
  StoredAccount,
  SyncState,
  ThreadDetail,
  ThreadingInput,
  ThreadSummary,
} from "../model.ts";
import { ImapAuthError } from "../ports.ts";
import type {
  ChangeNotifier,
  Clock,
  ImapConfig,
  ImapGateway,
  ImapTestResult,
  InboxSession,
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
};

type StoreState = {
  accounts: Map<string, StoredAccount>;
  syncStates: Map<string, SyncState>;
  rows: Row[];
  nextId: number;
};

const SNIPPET_LENGTH = 200;

function stateKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

function timeOf(date: string | null): number | null {
  if (date === null) return null;
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : null;
}

function snippetOf(message: FetchedMessage): string {
  return (message.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
}

export class InMemoryMailStore implements MailStore {
  private state: StoreState = {
    accounts: new Map(),
    syncStates: new Map(),
    rows: [],
    nextId: 1,
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
        (message.messageId === null
          ? undefined
          : rows.find((r) => r.uid === null && r.message.messageId === message.messageId));
      if (row) {
        row.uid = message.uid;
        row.message = structuredClone(message);
        row.isRead = row.seenPending || message.seen;
        row.isFlagged = message.flagged;
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
    flags: { uid: number; seen: boolean; flagged: boolean }[],
  ): number {
    let changed = 0;
    for (const flag of flags) {
      const row = this.attachedRows(accountId, folder).find((r) => r.uid === flag.uid);
      if (!row) continue;
      const isRead = row.seenPending || flag.seen;
      if (row.isRead !== isRead || row.isFlagged !== flag.flagged) {
        row.isRead = isRead;
        row.isFlagged = flag.flagged;
        changed++;
      }
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
    cursor: string | null,
    limit: number,
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    const all = this.threadSummaries(accountId);
    const offset = cursor === null ? 0 : Number(cursor);
    const threads = all.slice(offset, offset + limit);
    const next = offset + threads.length;
    return { threads, nextCursor: next < all.length ? String(next) : null };
  }

  getThread(threadId: string): ThreadDetail | null {
    const rows = this.state.rows.filter((r) => r.threadId === threadId);
    if (rows.length === 0) return null;
    const thread = this.summarize(threadId, rows);
    const messages = [...rows].sort(oldestFirst).map((r) => this.header(r));
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
    };
  }

  search(query: ParsedQuery, accountId: string | null, limit: number): MessageSummary[] {
    const contains = (haystack: string | null | undefined, needle: string) =>
      (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
    const after = query.after === undefined ? null : Date.parse(query.after);
    const before = query.before === undefined ? null : Date.parse(query.before);
    return this.state.rows
      .filter((r) => accountId === null || r.accountId === accountId)
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
      })
      .sort((a, b) => oldestFirst(b, a))
      .slice(0, limit)
      .map((r) => this.summary(r));
  }

  unreadCount(accountId: string | null): number {
    return this.state.rows.filter(
      (r) => !r.isRead && (accountId === null || r.accountId === accountId),
    ).length;
  }

  // Helpers ----------------------------------------------------------------

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
      messageCount: rows.length,
      unreadCount: rows.filter((r) => !r.isRead).length,
      participants,
      snippet: snippetOf(latest.message),
    };
  }

  private threadSummaries(accountId: string): ThreadSummary[] {
    const groups = new Map<string, Row[]>();
    for (const row of this.state.rows) {
      if (row.accountId !== accountId) continue;
      const group = groups.get(row.threadId);
      if (group) group.push(row);
      else groups.set(row.threadId, [row]);
    }
    return [...groups.entries()]
      .map(([id, rows]) => this.summarize(id, rows))
      .sort((a, b) => (timeOf(b.lastDate) ?? -Infinity) - (timeOf(a.lastDate) ?? -Infinity));
  }
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

/** A server-side INBOX the scripted gateway serves. */
export type FakeMailbox = {
  uidValidity: number;
  uidNext: number;
  messages: FetchedMessage[];
};

type SessionMethod = Exclude<keyof InboxSession, "close">;

export type SessionCall = { method: SessionMethod; uids?: number[]; date?: Date; uid?: number };

export type OpenedSession = {
  readOnly: boolean;
  config: ImapConfig;
  calls: SessionCall[];
  closed: boolean;
};

/**
 * Serves a FakeMailbox. Failures are scripted per method with `failNext`
 * (one call) or `failAlways`; `failOpen` makes openInbox throw.
 */
export class ScriptedImapGateway implements ImapGateway {
  readonly sessions: OpenedSession[] = [];
  private openFailure: Error | null = null;
  private readonly onceFailures = new Map<SessionMethod, Error>();
  private readonly alwaysFailures = new Map<SessionMethod, Error>();

  constructor(public mailbox: FakeMailbox) {}

  /** Adds a message to the mailbox with the next uid. */
  deliver(overrides: Partial<FetchedMessage> = {}): FetchedMessage {
    const message = makeFetchedMessage(this.mailbox.uidNext, overrides);
    message.uid = this.mailbox.uidNext++;
    this.mailbox.messages.push(message);
    return message;
  }

  failOpen(error: Error | null): void {
    this.openFailure = error;
  }

  failNext(method: SessionMethod, error: Error): void {
    this.onceFailures.set(method, error);
  }

  failAlways(method: SessionMethod, error: Error): void {
    this.alwaysFailures.set(method, error);
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

  async openInbox(config: ImapConfig, options: { readOnly: boolean }): Promise<InboxSession> {
    if (this.openFailure) throw this.openFailure;
    const opened: OpenedSession = {
      readOnly: options.readOnly,
      config: { ...config },
      calls: [],
      closed: false,
    };
    this.sessions.push(opened);
    const record = (call: SessionCall) => {
      opened.calls.push(call);
      const once = this.onceFailures.get(call.method);
      if (once) {
        this.onceFailures.delete(call.method);
        throw once;
      }
      const always = this.alwaysFailures.get(call.method);
      if (always) throw always;
    };
    const box = () => this.mailbox;
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
          // SINCE uses the server's internal date, which every message has; an
          // undated fixture stands for a recent one.
          .messages.filter((m) => (timeOf(m.date) ?? Infinity) >= date.getTime())
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
          return message ? [{ uid, seen: message.seen, flagged: message.flagged }] : [];
        });
      },
      markSeen: async (uids) => {
        record({ method: "markSeen", uids: [...uids] });
        if (options.readOnly) throw new Error("Mailbox is read-only");
        for (const message of box().messages) {
          if (uids.includes(message.uid)) message.seen = true;
        }
      },
      close: async () => {
        opened.closed = true;
      },
    };
  }
}
