// Ports: what the core needs from its host. Each host supplies adapters.
import type {
  FetchedMessage,
  FlagChange,
  FlagIntent,
  Folder,
  InlinePart,
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
   * Adds (true) or removes (false) \Seen / \Flagged on the uids; an absent
   * field is left alone. Throws SafeImapError "StoreFailed" when the server
   * refuses, and on a read-only session.
   */
  setFlags(uids: number[], change: FlagChange): Promise<void>;
  /**
   * The whole message (BODY.PEEK[], never sets \Seen). Throws before
   * returning more than `maxBytes`.
   */
  fetchRaw(uid: number, maxBytes: number): Promise<Uint8Array>;
  /**
   * Moves the uids to `destination`. `moved` maps source uid to destination
   * uid (COPYUID), or is null when the server returned none. Throws when the
   * server refuses the move (error `code` "MoveFailed"), when the server
   * cannot move without a plain EXPUNGE ("MoveUnsupported", nothing sent),
   * on a read-only session, and with another code (not a refusal) when the
   * connection dropped.
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
  /**
   * Slice-2 view over the desired state until sync uses pendingFlagIntents:
   * attached uids of the folder whose desired \Seen is set (true).
   */
  pendingSeenUids(accountId: string, folder: string): number[];
  /** Slice-2 view: clearFlagIntents with `{ uid, seen: true, flagged: null }` per uid. */
  clearSeenPending(accountId: string, folder: string, uids: number[]): void;
  /**
   * Records an owner-asked \Seen / \Flagged change; a field absent from
   * `change` is left alone. Unknown ids are skipped. The change reaches every
   * copy with the same dedup key within the id's account (as markOpened).
   * Local is_read / is_flagged change at once on every copy, attached or not.
   * Each attached copy (with a uid) gets the desired value to push, rows
   * waiting to move included. A new request overwrites an opposite pending
   * desired value. The desired value is set even when nothing is pending and
   * the local value already equals the request (an idempotent push). A
   * detached copy gets no desired value and drops a pending one for the
   * changed field, so a stale intent cannot win when it is reattached.
   * Returns each touched account once, in order of first appearance.
   * upsertMessages and applyFlags never overwrite a field whose desired value
   * is pending, and a move re-home carries both desired values (non-null wins).
   */
  setDesired(messageIds: string[], change: FlagChange): { accountId: string }[];
  /**
   * Attached rows (uid not null) of the folder with a pending desired value,
   * rows waiting to move included, by uid. `seen` / `flagged` is null when
   * that field has no intent.
   */
  pendingFlagIntents(accountId: string, folder: string): FlagIntent[];
  /**
   * Compare-and-clear per field: a desired value is cleared only where it
   * still equals what was pushed, so a later click stays pending. A null in
   * `pushed` means that field was not pushed and is left alone.
   */
  clearFlagIntents(accountId: string, folder: string, pushed: FlagIntent[]): void;
  /**
   * Sets is_read on every copy with the same (account, dedup key). Each
   * attached unread copy gets a desired \Seen to push (slice-2 semantics).
   * A detached copy is read locally only and gets no desired value.
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
   * Threads of every account having a member not waiting to move in a folder
   * of `role` (its effective special use, as listFolders). Archive merges
   * `archive` folders only, never Gmail All Mail. Keyset paging by
   * (last date DESC, id DESC) across accounts, served by the thread-date
   * index. A thread's `flagged` covers its rows in that role's folders not
   * waiting to move. Role "all" returns no threads (the server refuses it).
   */
  listThreadsAll(
    role: SpecialUse,
    cursor: string | null,
    limit: number,
  ): { threads: ThreadSummary[]; nextCursor: string | null };
  /**
   * Exactly inbox, sent, drafts, junk, archive, trash in that order, zeros
   * included. Counts are distinct unread / total dedup keys (per account)
   * across accounts in folders of that special use, leaving out rows waiting
   * to move. Archive counts `archive` folders only, never `all`.
   */
  listRoles(): RoleCount[];
  /**
   * Null when the message is unknown, detached (uid NULL) or waiting to
   * move. `uidValidity` comes from the folder's sync state, null when there
   * is none.
   */
  rawRef(messageId: string): RawRef | null;
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
