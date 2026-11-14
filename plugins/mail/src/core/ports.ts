// Ports: what the core needs from its host. Each host supplies adapters.
import type {
  FetchedMessage,
  Folder,
  InlinePart,
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
} from "./model.ts";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export type ImapTestResult =
  | { ok: true }
  | { ok: false; reason: string; authFailed: boolean };

export interface ImapGateway {
  test(config: ImapConfig): Promise<ImapTestResult>;
  listFolders(config: ImapConfig): Promise<RemoteFolder[]>;
  openFolder(
    config: ImapConfig,
    path: string,
    options: { readOnly: boolean },
  ): Promise<FolderSession>;
}

/** An open folder. Every fetch uses BODY.PEEK, so reading never marks mail read. */
export interface FolderSession {
  status(): Promise<{ uidValidity: number; uidNext: number; exists: number }>;
  searchSince(date: Date): Promise<number[]>;
  uidsAfter(uid: number): Promise<number[]>;
  fetchMessages(uids: number[]): Promise<FetchedMessage[]>;
  fetchFlags(
    uids: number[],
  ): Promise<{ uid: number; seen: boolean; flagged: boolean; gmMsgId: string | null }[]>;
  /** Throws on a read-only session. */
  markSeen(uids: number[]): Promise<void>;
  /**
   * Moves the uids to `destination`. `moved` maps source uid to destination
   * uid (COPYUID), or is null when the server returned none. Throws when the
   * server refuses the move (error `code` "MoveFailed"), when the server
   * cannot move without a plain EXPUNGE ("MoveUnsupported", nothing sent),
   * and on a read-only session.
   */
  moveMessages(
    uids: number[],
    destination: string,
  ): Promise<{ moved: Map<number, number> | null }>;
  close(): Promise<void>;
}

/** Gateways throw this when the server rejects the credentials. */
export class ImapAuthError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "ImapAuthError";
  }
}

export interface SecretVault {
  seal(plain: string): string;
  open(sealed: string): string;
}

export interface ChangeNotifier {
  mailChanged(accountId: string): void;
}

export interface Clock {
  now(): Date;
}

export interface MailStore {
  transaction<T>(fn: () => T): T;
  listAccounts(): StoredAccount[];
  getAccount(id: string): StoredAccount | null;
  findAccountByEmail(email: string): StoredAccount | null;
  /** Insert or replace by id. */
  saveAccount(account: StoredAccount): void;
  recordSyncResult(
    id: string,
    result: { lastSyncAt: string | null; lastError: string | null; authFailed: boolean },
  ): void;
  /** Cascades to all of the account's rows. */
  deleteAccount(id: string): void;
  getSyncState(accountId: string, folder: string): SyncState | null;
  saveSyncState(accountId: string, folder: string, state: SyncState): void;
  /** UIDVALIDITY changed: detach uids, keep message ids. */
  beginFolderReset(accountId: string, folder: string): void;
  /** Deletes rows still detached; returns how many. */
  finishFolderReset(accountId: string, folder: string): number;
  upsertMessages(accountId: string, folder: string, messages: FetchedMessage[]): void;
  localFolderIndex(
    accountId: string,
    folder: string,
    sinceIso: string,
  ): { uid: number; id: string }[];
  applyFlags(
    accountId: string,
    folder: string,
    /** `gmMsgId` (when given) backfills the row's Gmail id and dedup key. */
    flags: { uid: number; seen: boolean; flagged: boolean; gmMsgId?: string | null }[],
  ): number;
  deleteByUids(accountId: string, folder: string, uids: number[]): number;
  pendingSeenUids(accountId: string, folder: string): number[];
  clearSeenPending(accountId: string, folder: string, uids: number[]): void;
  /**
   * Marks every row with the same dedup key read locally, and `seen_pending`
   * on each such row that has a uid (attached), so every copy is pushed.
   */
  markOpened(messageId: string): { accountId: string } | null;
  threadingInputs(accountId: string): ThreadingInput[];
  /** Assigns messages to threads, then recomputes the thread rows. */
  assignThreads(accountId: string, threadOf: Map<string, string>): void;
  /** Threads with at least one message in `folder`. */
  listThreads(
    accountId: string,
    folder: string,
    cursor: string | null,
    limit: number,
  ): { threads: ThreadSummary[]; nextCursor: string | null };
  /**
   * Each message once. Of the copies sharing a dedup key, prefer the one in
   * `folder` (the folder being viewed) unless it is waiting to move, then a
   * copy not waiting to move, the Inbox copy, a copy outside All Mail, and
   * the most recently stored row.
   */
  getThread(threadId: string, folder: string): ThreadDetail | null;
  getMessage(messageId: string): MessageHeader | null;
  getBody(messageId: string): MessageBody | null;
  search(query: ParsedQuery, accountId: string | null, limit: number): MessageSummary[];
  /** Distinct unread messages (by dedup key) in Inbox folders. */
  unreadCount(accountId: string | null): number;
  /** Upserts the folders; drops folders not listed, with their rows; returns removed paths. */
  saveFolders(accountId: string, folders: RemoteFolder[]): { removed: string[] };
  /**
   * System order inbox, sent, drafts, junk, archive, all, trash, then others
   * by name; counts by distinct dedup key in the local window.
   */
  listFolders(accountId: string): Folder[];
  pendingMoves(
    accountId: string,
    folder: string,
  ): { uid: number; id: string; destination: string }[];
  /**
   * Marks the messages move-pending. All ids must share one account and one
   * source folder; returns null when any id is unknown or they span accounts
   * or folders (nothing is queued then).
   */
  queueMove(
    messageIds: string[],
    destination: string,
  ): { accountId: string; folder: string } | null;
  /**
   * Re-homes moved rows to the destination with their new uids; detaches them
   * (uid NULL in the destination) when `moved` is null. A map that lacks some
   * of `uids` means those messages vanished from the source: the move counts
   * as done for them and reconcile removes their rows.
   */
  completeMove(
    accountId: string,
    folder: string,
    destination: string,
    moved: Map<number, number> | null,
    uids: number[],
  ): void;
  /** Counts a refusal; cancels at 3 (clears move_pending) and returns cancelled ids. */
  failMove(accountId: string, folder: string, uids: number[]): { cancelled: string[] };
  inlineParts(messageId: string): InlinePart[];
  isImageSenderAllowed(accountId: string, address: string): boolean;
  allowImageSender(accountId: string, address: string): void;
  /** Returns whether the sender was allowed before. */
  disallowImageSender(accountId: string, address: string): boolean;
  /**
   * Recomputes stored snippets written before entities were fully decoded,
   * with their thread rows; returns how many changed. Idempotent.
   */
  repairSnippets(): number;
}
