// Ports: what the core needs from its host. Each host supplies adapters.
import type { ReplySource } from "./compose-reply.ts";
import type {
  ComposeAttachment,
  ComposeKind,
  DraftFields,
  DraftServerCopyState,
  DraftRecord,
  DraftServerCopy,
  FetchedMessage,
  FlagChange,
  FlagIntent,
  Folder,
  InlinePart,
  MessageBody,
  MessageHeader,
  MessageSummary,
  NewDraft,
  NewOutboxRow,
  OriginalMessage,
  OutboxRecord,
  OutboxState,
  OutgoingMessage,
  ParsedQuery,
  RawRef,
  RemoteFolder,
  RoleCount,
  SendErrorKind,
  SmtpSecurity,
  SpecialUse,
  StoredAccount,
  SyncState,
  ThreadDetail,
  ThreadingInput,
  ThreadSummary,
  ThreadFilter,
  MailAddress,
  UnsubscribeState,
  AttachmentMatch,
  FileKind,
  FileRow,
  KeptState,
  SearchCursor,
  AuthKind,
} from "./model.ts";
import type { ServerCriteria } from "./server-search.ts";
import type { AttachmentCandidate } from "./attachment-text.ts";
import type { RelatedCandidate } from "./related.ts";
import type { BlockRule } from "./blocking.ts";
import type { WatchEnd } from "./idle-policy.ts";
import type { NotifyRow } from "./notify.ts";
import type { SnoozeRow, SnoozeState, SnoozeView } from "./snooze.ts";
import type { TriageAction, TriageBatchState, TriageHistoryRow, TriageItemOutcome } from "./triage.ts";
import type { UnsubscribeInfo } from "./unsubscribe.ts";
import type { OutboxChangedPayload } from "./contract.ts";
import type { ProposalCapRow, ProposalState } from "./agent-propose.ts";
import type { AccountCorrespondence, Contact } from "./contacts.ts";
import type { ComposeDoc } from "./compose-doc.ts";
import type { SignatureDoc } from "./compose-signature.ts";
import type { AliasRow, InboundRow, SendCheck } from "./identities.ts";
import type { UndoRow } from "./undo.ts";
import type { AccountScope, AiScope } from "./ai-scope.ts";
import type { LogEntry, LogOutcome } from "./agent-log.ts";
import type { Category, CategoryRule, CategorySource, PreviousLabel } from "./categories.ts";
import type { AiCategoryAnswer } from "./ai-input.ts";
import type { ReplyCandidate } from "./digest.ts";
import type { ReminderState } from "./reminders.ts";
import type { DevClass, DevKind, DevSource } from "./dev-notify.ts";
import type { ProjectInfo } from "./projects.ts";
import type { Rule, RuleMode } from "./mail-rules.ts";
import type { MailFilter } from "./mail-filters.ts";
import type { SubscriptionRow } from "./subscriptions.ts";
import type { ArchiveCursor, ArchiveMessage, ArchivePlace, ArchiveRecord, ArchiveSummary, NewArchiveMessage } from "./archive.ts";
import type { BbLinkRowKind } from "./model.ts";
import type { MailCrypto } from "./mail-crypto.ts";
import type { SenderCheck } from "./sender-check.ts";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  /** The app password; for a Google account, its refresh token. */
  password: string;
  /** Absent means "password". */
  authKind?: AuthKind;
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
  /**
   * Watches one folder with IDLE on its own read-only connection (EXAMINE)
   * until `signal` aborts or the connection ends (slice 3e). Issues no write
   * and exposes no session. `onChange` is called for new mail ("exists",
   * only when the count grew), an expunge, or a flag change.
   */
  watchFolder(
    config: ImapConfig,
    path: string,
    onChange: (change: "exists" | "expunge" | "flags") => void,
    signal: AbortSignal,
  ): Promise<WatchEnd>;
  /**
   * CREATE of one folder (slice 3e: the snooze folder, after the owner's
   * confirmation). `created: false` when it already existed. Throws
   * SafeImapError "CreateFailed" when the server refuses.
   */
  createFolder(config: ImapConfig, name: string): Promise<{ path: string; created: boolean }>;
  /**
   * Slice 3h folder writes. Each runs on a fresh connection with no mailbox
   * selected (so imapflow never sends CLOSE, which would expunge) and logs
   * out after. Errors are SafeImapError codes, never server text.
   * RENAME of `from` to `to`; "RenameFailed" on a refusal.
   */
  renameFolder(config: ImapConfig, from: string, to: string): Promise<{ path: string }>;
  /** STATUS of one folder; "StatusFailed" on a refusal. */
  folderStatus(config: ImapConfig, path: string): Promise<{ messages: number; uidValidity: number }>;
  /**
   * DELETE of one folder. `expectEmpty`: STATUS messages first on the same
   * connection, "NotEmpty" (nothing deleted) when it is above 0. Without it
   * (a \Noselect folder) DELETE only. `gmailLabel` (spec resolution 5):
   * DELETE only when that connection advertises X-GM-EXT-1, else the STATUS
   * check. "DeleteFailed" on a refusal.
   */
  deleteFolder(config: ImapConfig, path: string, options: { expectEmpty: boolean; gmailLabel?: boolean }): Promise<void>;
  /** SUBSCRIBE / UNSUBSCRIBE; "SubscribeFailed" on a refusal. */
  setSubscribed(config: ImapConfig, path: string, subscribed: boolean): Promise<void>;
  /** Whether imapflow would read a folder of this name as special use (spec resolution 18). */
  namedLikeSpecialUse(name: string): boolean;
}

/** An open folder. Every fetch uses BODY.PEEK, so reading never marks mail read. */
export interface FolderSession {
  status(): Promise<{ uidValidity: number; uidNext: number; exists: number }>;
  searchSince(date: Date): Promise<number[]>;
  uidsAfter(uid: number): Promise<number[]>;
  fetchMessages(uids: number[]): Promise<FetchedMessage[]>;
  /**
   * The raw HEADER.FIELDS block of LIST_HEADER_FIELDS for each uid the server
   * answers for (BODY.PEEK, by UID: never \Seen, no body); a uid gone from
   * the folder is simply missing.
   */
  fetchListHeaders(uids: number[]): Promise<{ uid: number; block: Uint8Array }[]>;
  /**
   * The raw HEADER.FIELDS block of exactly `fields` for each uid the server
   * answers for (BODY.PEEK, by UID; slice 3e). fetchListHeaders is this with
   * LIST_HEADER_FIELDS.
   */
  fetchHeaderFields(uids: number[], fields: readonly string[]): Promise<{ uid: number; block: Uint8Array }[]>;
  /** `labels` (slice 3h): X-GM-LABELS, present only on Gmail sessions. */
  fetchFlags(
    uids: number[],
  ): Promise<{ uid: number; seen: boolean; flagged: boolean; gmMsgId: string | null; labels?: string[] }[]>;
  /**
   * Throws on a read-only session.
   * @deprecated Sync pushes \Seen with setFlags; kept until the gateway drops it.
   */
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
  /**
   * UID COPY of the uids to `destination` (slice 3d: only undo of an
   * archive on Gmail uses it; it adds and removes nothing). `copied` maps
   * source uid to destination uid (COPYUID), or is null when the server
   * returned none. Throws like moveMessages: "CopyFailed" when the server
   * refuses, "ConnectionLost" when the connection dropped, "ReadOnly" on a
   * read-only session.
   */
  copyMessages(
    uids: number[],
    destination: string,
  ): Promise<{ copied: Map<number, number> | null }>;
  /** What the server advertised: UIDPLUS, and X-GM-EXT-1 (Gmail). */
  capabilities(): { uidplus: boolean; gmail: boolean };
  /**
   * APPENDs the message to this session's own folder. `uid` and
   * `uidValidity` come from APPENDUID, null when the server gave none.
   * Throws on a read-only session and when the server refuses.
   */
  appendMessage(
    raw: Uint8Array,
    flags: string[],
  ): Promise<{ uidValidity: number | null; uid: number | null }>;
  /** UIDs whose Message-ID header is exactly `messageId` (UID SEARCH HEADER, then an exact match). */
  findByMessageId(messageId: string): Promise<number[]>;
  /**
   * Removes exactly one message this plugin wrote (or the one foreign draft
   * the owner continued): \Deleted then UID EXPUNGE of that uid alone,
   * never a plain EXPUNGE. Throws code "ExpungeUnsupported" without UIDPLUS
   * (checked before any command), "GuardMismatch" when the uid's Message-ID
   * or RFC822.SIZE differ from `guard`, "ExpungeFailed" when the server
   * refuses; and on a read-only session.
   */
  expungeOwn(uid: number, guard: { messageId: string; size: number }): Promise<void>;
  /**
   * UID SEARCH by Mail's criteria (slice 3h): X-GM-RAW when the session is
   * Gmail and `gmailRaw` is set, else the IMAP criteria. At most
   * SERVER_SEARCH_CAPS.uidsPerFolder uids, the newest, newest first; none
   * when there is no criterion to send. Throws SafeImapError "SearchFailed"
   * when the server refuses.
   */
  searchServer(criteria: ServerCriteria): Promise<number[]>;
  /** X-GM-LABELS of the uids (Gmail only; BODY.PEEK not involved: a FETCH of labels sets no flag). */
  fetchLabels(uids: number[]): Promise<{ uid: number; labels: string[] }[]>;
  /**
   * STORE X-GM-LABELS: adds then removes labels on the uids (Gmail, read-write
   * session). Throws SafeImapError "LabelsRefused" when the server refuses;
   * after a success returns the labels the server now reports (spec
   * resolution 10).
   */
  setLabels(uids: number[], change: { add: string[]; remove: string[] }): Promise<{ uid: number; labels: string[] }[]>;
  close(): Promise<void>;
}

/** Gateways throw this when the server rejects the credentials. */
export class ImapAuthError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "ImapAuthError";
  }
}

/**
 * Google no longer accepts an account's grant (revoked, expired, or the
 * password changed): signing in again is the only way back, so the account
 * stops at once and the saved credential is not tried again.
 */
export class GrantRevokedError extends ImapAuthError {
  constructor() {
    super();
    this.name = "GrantRevokedError";
  }
}

/** An SMTP server and its login, for one session. The password is dropped after it. */
export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  /** The app password; for a Google account, its refresh token. */
  password: string;
  /** Absent means "password". */
  authKind?: AuthKind;
}

/** What the server accepted. No response text: it is never kept or logged. */
export interface SendResult {
  accepted: string[];
  rejected: string[];
}

/** The SMTP command a refusal answered (fixed strings only, never the reply text). */
export type SmtpCommand = "MAIL FROM" | "RCPT TO" | "DATA";

/**
 * Transports throw this; `afterData` says whether DATA may have been
 * accepted; `command` is the SMTP command the server refused, when known
 * (slice 3d: the core decides `sender_refused` from it).
 */
export class SendError extends Error {
  readonly kind: SendErrorKind;
  readonly afterData: boolean;
  readonly command: SmtpCommand | null;
  constructor(kind: SendErrorKind, afterData: boolean, command: SmtpCommand | null = null) {
    super(`Send failed: ${kind}`);
    this.name = "SendError";
    this.kind = kind;
    this.afterData = afterData;
    this.command = command;
  }
}

export interface MailTransport {
  /** Connect, TLS and AUTH; sends nothing. Throws SendError. */
  verify(config: SmtpConfig): Promise<void>;
  /** Sends the prepared bytes with an explicit envelope. Throws SendError. */
  send(
    config: SmtpConfig,
    message: { envelopeFrom: string; envelopeTo: string[]; raw: Uint8Array },
    signal: AbortSignal,
  ): Promise<SendResult>;
}

/** How many OpenPGP keys Mail keeps. */
export const PGP_KEYS_MAX = 500;

/** A stored OpenPGP key without its private half. */
export type PgpKeyRow = {
  id: string;
  /** `own`: the owner's key, with a private half; `contact`: someone else's public key. */
  kind: "own" | "contact";
  fingerprint: string;
  addresses: string[];
  userIds: string[];
  publicArmor: string;
  /** ISO 8601: when the key itself was made. */
  createdAt: string;
  expiresAt: string | null;
  /** ISO 8601: when Mail stored it. */
  addedAt: string;
  source: "generated" | "imported" | "message";
};

export interface MessageBuilder {
  /** RFC 5322 bytes, built once and never with a Bcc header. */
  build(input: OutgoingMessage): Promise<Uint8Array>;
}

export interface OriginalReader {
  /** Reply-To, HTML and attachments of a stored message, read from the server. */
  read(messageId: string): Promise<OriginalMessage>;
}

/** Runs one account's server writes (APPEND, expunge, SMTP, sync rounds) one at a time. */
export interface AccountWriteQueue {
  run<T>(accountId: string, task: () => Promise<T>): Promise<T>;
}

export interface OutboxNotifier {
  /** Ids and states only: never recipients, subjects or content. */
  outboxChanged(payload: OutboxChangedPayload): void;
}

export interface SecretVault {
  seal(plain: string): string;
  open(sealed: string): string;
}

/** How a one-click unsubscribe POST ended: the status class or a fixed reason, never the response. */
export type PostOutcome =
  | { kind: "done" | "redirected" }
  | { kind: "failed"; reason: "client" | "server" | "network" | "tls" | "address" | "timeout" };

/** The RFC 8058 one-click POST (slice 3e); only the server's unsubscribe path calls it. */
export interface UnsubscribePoster {
  post(url: string, signal: AbortSignal): Promise<PostOutcome>;
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
  /**
   * The folder's detached rows (uid NULL: a reset or a move without UIDPLUS)
   * with what can reattach them: the Message-ID and the Gmail message id.
   */
  detachedRows(accountId: string, folder: string): { id: string; messageId: string | null; gmMsgId: string | null }[];
  /**
   * `inserted`: ids of rows created (not reattached by Message-ID, not
   * re-homed by a move). `returning`: the inserted ids whose (account, dedup
   * key) already had another row before the insert (slice 3e). Writes
   * `unsubscribe_json` when a message carries headers, and `spam_seen` for
   * rows landing in a junk-role folder.
   */
  upsertMessages(
    accountId: string,
    folder: string,
    messages: FetchedMessage[],
    /**
     * Slice 3h jobs only (spec resolution 7): new rows take `kept` and
     * `kept_at = now`; an existing row is never downgraded (window rows and
     * `opened` rows stay; `search` becomes `history` under a history load).
     * Sync passes nothing.
     */
    opts?: { kept?: "history" | "search" },
  ): { inserted: string[]; returning: string[] };
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
   * Attached rows of the folder whose bulk mark is unknown (NULL), highest
   * uid first, only uids below `belowUid` when given, at most `limit`.
   */
  bulkUnknown(
    accountId: string,
    folder: string,
    belowUid: number | null,
    limit: number,
  ): { uid: number; fromAddress: string }[];
  /**
   * Writes bulk marks by uid, only where the mark is still NULL and only while
   * the folder's stored UIDVALIDITY equals `uidValidity`; returns how many
   * rows changed. A mark sync set is never overwritten.
   */
  fillBulk(accountId: string, folder: string, uidValidity: number, marks: { uid: number; bulk: boolean }[]): number;
  /**
   * Records an owner-asked \Seen / \Flagged change; a field absent from
   * `change` is left alone. Unknown ids are skipped. The change reaches every
   * copy with the same dedup key within the id's account (as markOpened).
   * Local is_read / is_flagged change at once on every copy, attached or not.
   * Each attached copy (with a uid) gets the desired value to push, rows
   * waiting to move included. A new request overwrites an opposite pending
   * desired value. The desired value is set even when nothing is pending and
   * the local value already equals the request (an idempotent push). A row
   * named in `messageIds` keeps its intent even when detached (uid NULL); it
   * is pushed after reattach, since push queries select attached rows only.
   * Another detached copy gets the local value only, and drops a pending
   * value of the changed field that differs from the request, so a stale
   * intent cannot win when it is reattached.
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
   * The opened row, when unread, keeps its intent even when detached (pushed
   * after reattach); another detached copy is read locally only.
   */
  markOpened(messageId: string): { accountId: string } | null;
  threadingInputs(accountId: string): ThreadingInput[];
  /**
   * Assigns messages to threads, then recomputes the rows of the threads a
   * message left or joined (every thread row on the first call after a load).
   */
  assignThreads(accountId: string, threadOf: Map<string, string>): void;
  /** True when rows were inserted or deleted since the last assignThreads (slice 3j). */
  threadsStale(accountId: string): boolean;
  /** Rebuilds every thread row of the account from its messages; returns the thread count (slice 3j, doctor). */
  repairThreads(accountId: string): number;
  /** Threads with at least one message in `folder` (matching `filter` on one row, slice 3e). */
  listThreads(
    accountId: string,
    folder: string,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
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
    filter?: ThreadFilter,
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
  /** `scoped` (slice 3f, agent paths): only rows inside the AI scope, before the dedup picks one per message. */
  search(query: ParsedQuery, accountId: string | null, limit: number, opts?: SearchOptions): MessageSummary[];
  /**
   * search with paging and attachment matches (slice 3h). Keyset by the
   * search order (spec resolution 17). `attachment_text` is joined only
   * when `opts.attachments === true`, whatever `scoped` says (spec
   * resolution 4).
   */
  searchPage(
    query: ParsedQuery,
    accountId: string | null,
    limit: number,
    opts?: SearchOptions,
  ): { hits: MessageSummary[]; nextCursor: SearchCursor | null; attachmentMatches: AttachmentMatch[] };
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

  // ---- Compose and send (slice 3b) ----

  createDraft(input: NewDraft): DraftRecord;
  getDraft(id: string): DraftRecord | null;
  /**
   * Compare-and-swap on the revision: a stale `baseRevision`, or a draft a
   * live outbox row holds, answers `conflict` with the current revision.
   */
  /** Also clears `importHtml` and sets `updatedAt` (ISO 8601). */
  saveDraft(
    id: string,
    baseRevision: number,
    fields: DraftFields,
    updatedAt: string,
  ): { revision: number } | { conflict: true; revision: number };
  /**
   * The editor's first load of `importHtml`: writes the document and clears
   * the import, keeping the revision and `updatedAt` (loading is not an
   * edit, so no server copy becomes due). `conflict` when the revision is
   * stale, the import was already taken, or a live outbox row holds it.
   */
  saveImport(id: string, baseRevision: number, doc: DraftFields["doc"]): { revision: number } | { conflict: true; revision: number };
  /** Cascades to its attachments. */
  deleteDraft(id: string): void;
  listDrafts(accountId: string): DraftRecord[];
  /** The draft whose server copy is (folder, uid) of the account, or null. */
  draftForServerCopy(accountId: string, folder: string, uid: number): string | null;
  /** The "new" draft continuing that foreign Drafts message (messages.id), or null. */
  draftContinuing(sourceMessageId: string): string | null;
  /** Gives the draft another Message-ID; nothing else changes. */
  renewMessageId(id: string, messageId: string): void;
  /**
   * Records (or with null clears) where the draft's latest server copy
   * lives; serverState becomes "saved" (or "none"). Only uids from our own
   * APPENDUID reach it; createDraft alone takes a foreign draft's uid (and
   * only one read in full).
   */
  recordServerCopy(id: string, copy: DraftServerCopy | null): void;
  /** Marks a failed or local-only server copy without touching the recorded copy. */
  setServerCopyState(id: string, state: DraftServerCopyState): void;
  /** Appends after the draft's last attachment. `contentId`: a forwarded inline part's Content-ID. */
  addAttachment(
    draftId: string,
    input: {
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
      data: Uint8Array;
      contentId?: string | null;
      /** Slice 3g: `bb:project:<id>` or `bb:thread:<id>`. */
      origin?: string | null;
    },
  ): ComposeAttachment;
  /** In the order added. */
  listAttachments(draftId: string): ComposeAttachment[];
  attachmentData(
    draftId: string,
  ): (ComposeAttachment & { data: Uint8Array; sha256: string; contentId: string | null })[];
  removeAttachment(draftId: string, attachmentId: string): boolean;
  /**
   * One transaction: an existing row with this id (the requestId) is
   * returned with `created: false`; otherwise the draft's revision must equal
   * `draftBaseRevision` and the draft must have no live row, or `conflict`.
   */
  queueOutbox(
    input: NewOutboxRow,
    draftBaseRevision: number,
  ): { row: OutboxRecord; created: boolean } | { conflict: true };
  getOutbox(id: string): OutboxRecord | null;
  /** Rows without their blobs; every account when null. */
  listOutbox(accountId: string | null): OutboxRecord[];
  outboxPayload(id: string): { mime: Uint8Array; bccHeader: string | null } | null;
  /** The compare-and-swap every transition uses: false when the row is not in a `from` state. */
  transitionOutbox(
    id: string,
    from: OutboxState[],
    to: OutboxState,
    patch?: {
      errorKind?: SendErrorKind | null;
      rejected?: string[];
      sendAfter?: string;
      countAttempt?: boolean;
      /** Slice 3l: false ends a "Send later" (the row sends with the usual Undo window). */
      scheduled?: boolean;
      /** ISO 8601; the row's updatedAt stays when absent. */
      updatedAt?: string;
    },
  ): boolean;
  deleteOutbox(id: string, from: OutboxState[]): boolean;
  /** The oldest due `queued` row of an account not in `busyAccounts`, unchanged (a peek). */
  nextDueOutbox(nowIso: string, busyAccounts: string[]): OutboxRecord | null;
  /**
   * The oldest due `queued` row of an account not in `busyAccounts` (with
   * `onlyId`, that row only, if it is still queued and due), moved to
   * `sending` (attempts + 1).
   */
  claimDueOutbox(nowIso: string, busyAccounts: string[], onlyId?: string): OutboxRecord | null;
  /**
   * On start: `sending` becomes `unknown`, overdue `queued` becomes `held`,
   * and `appending` goes back to `sent` (the copy step is idempotent).
   */
  recoverOutboxOnStart(nowIso: string): { unknown: number; held: number };
  /** Deletes the row and its draft. */
  completeOutbox(id: string): void;
  /** A row of the account is `sending` or `appending` (talking to a server). */
  hasSendingOutbox(accountId: string): boolean;
  /** `replyToKnown` is false for rows synced before Reply-To was stored. */
  replySource(
    messageId: string,
  ): (ReplySource & { accountId: string; folder: string; replyToKnown: boolean }) | null;
  /** Distinct From/To/Cc addresses of stored mail matching the prefix; the owner's Sent first. Local only. */
  recipientSuggestions(prefix: string, limit: number): MailAddress[];

  // ---- Agent proposals and translation (slice 3c) ----

  /**
   * Stores a `pending` proposal. `admit`, when given, runs in the same
   * transaction as the insert over `proposalCapRows(input.createdAt)`; a throw
   * from it refuses the proposal and nothing is stored (the caps are atomic).
   */
  createProposal(input: NewProposal, admit?: (rows: ProposalCapRow[]) => void): ProposalRecord;
  getProposal(id: string): ProposalRecord | null;
  /** Proposals created in the 24 hours before `nowIso`, plus every unsettled one (pending, confirming). */
  proposalCapRows(nowIso: string): ProposalCapRow[];
  /**
   * The compare-and-swap every proposal transition uses: false when the
   * proposal is not in a `from` state. `updatedAt` (ISO 8601) is recorded,
   * since the cool-down counts from it.
   */
  transitionProposal(
    id: string,
    from: ProposalState[],
    to: ProposalState,
    updatedAt: string,
    patch?: { outboxId?: string | null; viewTokenSha256?: string | null; viewedAt?: string | null },
  ): boolean;
  /** Replaces the view token's hash and its time; only while the proposal is `pending`. */
  setViewToken(id: string, sha256: string, viewedAtIso: string): boolean;
  /**
   * One transaction: the draft becomes an owner draft (proposal_id cleared)
   * and the proposal moves to `opened` from pending or confirming. False when
   * the proposal is in another state or does not own that draft.
   */
  releaseProposalDraft(id: string, draftId: string, updatedAt: string): boolean;
  /**
   * Undo or Edit of an agent send, one transaction: deletes the outbox row
   * (only from a `from` state), releases its draft and moves the proposal
   * (id = the outbox id) from `queued` to `opened`.
   */
  undoAgentSend(outboxId: string, from: OutboxState[], updatedAt: string): { cancelled: boolean; draftId: string | null };
  /** Deletes the proposal's hidden draft and its attachments, and clears its draft id. */
  dropProposalDraft(id: string): void;
  /**
   * On start (a restart never confirms): `pending` becomes `expired` with
   * its hidden draft deleted; `confirming` becomes `queued` when its outbox
   * row (id = proposal id) exists, else `expired`.
   */
  recoverProposalsOnStart(nowIso: string): { expired: number; queued: number };
  /** Deletes settled proposals last updated before `beforeIso`; returns how many. */
  purgeProposals(beforeIso: string): number;
  /**
   * Of these addresses, the ones (lowercased) the owner sent to: in To or Cc
   * of a stored message in a Sent-role folder, or in `sent_recipients`
   * (every accepted envelope recipient, slice 3d).
   */
  addressesSentTo(addresses: string[]): Set<string>;
  /** Stored messages in a Sent-role folder with the address (any case) in To or Cc, one per dedup key (slice 3e, the block dialog). */
  sentToCount(address: string): number;
  /**
   * People the owner corresponds with whose name, address or exchanged mail
   * match the query, best first (rankContacts). Header addresses only; junk,
   * trash and bulk mail are left out. Local only. `scoped` (slice 3f): mail
   * outside the AI scope is neither returned nor counted, excluded addresses
   * never return, and the topic match runs over redacted text.
   */
  contacts(query: string, limit: number, opts?: { scoped: boolean }): Contact[];
  /** Per account, the latest personal mail received from and sent to any of the addresses (correspondenceOf); junk and trash left out. */
  correspondence(addresses: string[]): AccountCorrespondence[];
  getTranslation(messageId: string, targetLanguage: string): TranslationRecord | null;
  /** Upsert by (messageId, targetLanguage), then evict the oldest beyond TRANSLATION_CACHE_ROWS by createdAt. */
  putTranslation(row: TranslationRecord): void;
  /** Deletes every cached translation; returns how many. */
  clearTranslations(): number;

  // ---- Sending polish (slice 3d) ----

  /** Alias rows (active and dismissed) of the account, or of every account when null, in creation order. */
  listIdentities(accountId: string | null): AliasRow[];
  /**
   * Adds or updates an alias by (account, address), one transaction: a
   * dismissed row becomes active, an active one takes the display name.
   * Throws ComposeError "conflict" when the address is another account's
   * own address, username or active alias, the account's own address or
   * username, or when the account already has IDENTITIES_MAX_PER_ACCOUNT
   * active aliases.
   */
  upsertIdentity(input: { accountId: string; address: string; displayName: string | null }, nowIso: string): AliasRow;
  /** An active alias's name or signature (an absent field is left alone); null when there is no such alias. */
  updateIdentity(
    accountId: string,
    address: string,
    patch: { displayName?: string | null; signature?: SignatureDoc | null },
    nowIso: string,
  ): AliasRow | null;
  /** The own address's signature; false when the account is unknown. */
  setAccountSignature(accountId: string, signature: SignatureDoc | null): boolean;
  /** Deletes an active alias row; false when there is none. */
  removeIdentity(accountId: string, address: string): boolean;
  /** Stores a dismissed suggestion (an existing active row is left alone). */
  dismissIdentity(accountId: string, address: string, nowIso: string): void;
  /** Sets an alias's send check; `checkMessageId` is the send whose Sent copy decides `pending`. */
  setSendCheck(accountId: string, address: string, check: SendCheck, checkMessageId: string | null, nowIso: string): void;
  /** Resolves `pending` checks of the account from synced Sent-role rows (resolveSendCheck); returns how many changed. */
  resolveSendChecks(accountId: string, nowIso: string): number;
  /** Recipients of the account's inbound rows outside Sent, Drafts, Spam and Trash, `bulk IS NOT 1`. */
  inboundAddressRows(accountId: string): InboundRow[];
  /**
   * From, To, Cc and Reply-To (lower case) of every stored message of the
   * message's thread; null when the message is not stored.
   */
  conversationAddresses(messageId: string): Set<string> | null;
  /** The message's Delivered-To / X-Original-To addresses; empty when unknown. */
  deliveredToOf(messageId: string): string[];
  /** Where each stored id is now; unknown ids are left out. */
  undoRows(ids: string[]): UndoRow[];
  /**
   * Compare-and-swap: clears `move_pending` only on rows still in `folder`
   * whose pending destination is still `destination`; returns the ids cleared.
   */
  cancelMove(ids: string[], folder: string, destination: string): string[];
  /** Every template, by name key. */
  listTemplates(): TemplateRecord[];
  /** Insert (id null) or update by id; `conflict` when another template has the name key. */
  saveTemplate(
    input: { id: string | null; name: string; nameKey: string; doc: ComposeDoc },
    newId: string,
    nowIso: string,
  ): { id: string } | { conflict: true };
  deleteTemplate(id: string): boolean;
  getTemplateByKey(nameKey: string): TemplateRecord | null;

  // ---- Inbox triage (slice 3e) ----

  /** Sets (or with null clears) the account's snooze folder. */
  setSnoozeFolder(accountId: string, path: string | null): void;
  /**
   * Inserts snoozes (replacing one for the same message). `full` when the
   * account would hold more than SNOOZES_MAX_PER_ACCOUNT live snoozes;
   * nothing is stored then.
   */
  createSnoozes(rows: SnoozeRow[], nowIso: string): { created: number } | { full: true };
  /** The account's snoozes by due time; `dueBefore` keeps those due at or before it. */
  listSnoozes(accountId: string, opts: { dueBefore?: string; limit: number }): SnoozeRow[];
  updateSnooze(
    messageId: string,
    patch: { state?: SnoozeState; dueAt?: string; returnTo?: string },
    nowIso: string,
  ): boolean;
  deleteSnoozes(messageIds: string[]): number;
  /**
   * The account's snoozes with their message rows as stored now, for the
   * snooze clock: in-flight rows (moving, returning) first, then snoozed ones
   * by due time, at most `limit`.
   */
  snoozeViews(accountId: string, limit: number): SnoozeView[];
  /** Every block rule (global), oldest first. */
  listBlockRules(): BlockRule[];
  /** Inserts the rule, or returns the existing one for (kind, value) with `created: false`. */
  addBlockRule(kind: BlockRule["kind"], value: string, id: string, nowIso: string): { rule: BlockRule; created: boolean };
  removeBlockRule(id: string): boolean;
  /**
   * Stored rows of every account matching the rule's From that sit in an
   * Inbox-role folder, attached and not moving; rows from the owner's own
   * addresses and rows whose dedup key is in `spam_seen` or in a current
   * junk-role row are left out (spec resolutions 13, 17).
   */
  blockMatches(rule: BlockRule): { id: string; accountId: string; folder: string }[];
  /** Of these dedup keys, those in the account's `spam_seen` or held by a junk-role row now. */
  spamSeen(accountId: string, dedupKeys: string[]): Set<string>;
  /** Deletes `spam_seen` rows seen before `olderThanIso`; returns how many. */
  pruneSpamSeen(olderThanIso: string): number;
  /**
   * Stored rows as notify and block judge them; unknown ids are left out.
   * The store keeps no fetch time, so `fetchedAt` is `nowIso` (the rows were
   * just fetched by the round that asks).
   */
  notifyRows(ids: string[], nowIso: string): (NotifyRow & { dedupKey: string })[];
  /**
   * Writes unsubscribe info by uid, only where it is still NULL and only
   * while the folder's stored UIDVALIDITY equals `uidValidity`; a null info
   * writes nothing. Returns how many rows changed.
   */
  fillUnsubscribe(
    accountId: string,
    folder: string,
    uidValidity: number,
    values: { uid: number; info: UnsubscribeInfo | null }[],
  ): number;
  /**
   * Attached bulk rows of the folder whose unsubscribe info is unknown (NULL),
   * highest uid first, only uids below `belowUid` when given, at most `limit`.
   */
  unsubscribeUnknown(
    accountId: string,
    folder: string,
    belowUid: number | null,
    limit: number,
  ): { uid: number; from: MailAddress }[];
  getUnsubscribeInfo(messageId: string): UnsubscribeInfo | null;
  /**
   * Slice 3n: stored messages that carry unsubscribe headers, outside Spam,
   * Trash, Drafts and Sent, newest first, at most `limit`; `accountId` null:
   * every account. One row per stored copy (the caller counts distinct keys).
   */
  subscriptionRows(accountId: string | null, limit: number): SubscriptionRow[];
  getUnsubscribe(accountId: string, listKey: string): UnsubscribeRecord | null;
  /**
   * mail_inbox (slice 3e): attached Inbox-role messages not moving, one per
   * (account, dedup key), newest first; `accountId` null: every account.
   */
  inboxMessages(accountId: string | null, opts: { unreadOnly: boolean; limit: number; scoped?: boolean }): InboxMessage[];
  /** Upsert by (account, list key). */
  putUnsubscribe(row: UnsubscribeRecord): void;
  /** A mailto request follows its outbox row: sets the state of the row with this outbox id; false when none. */
  setUnsubscribeStateByOutbox(outboxId: string, state: UnsubscribeState): boolean;
  /** Stores a `pending` batch with its items in one transaction. */
  createTriageBatch(batch: NewTriageBatch, items: TriageItemRecord[]): void;
  getTriageBatch(id: string): { batch: TriageBatchRecord; items: TriageItemRecord[] } | null;
  /** Compare-and-swap on the state; false when the batch is not in a `from` state. */
  transitionTriageBatch(
    id: string,
    from: TriageBatchState[],
    to: TriageBatchState,
    patch: { viewTokenHash?: string | null; approved?: number[]; createSnoozeFolder?: string[] },
    nowIso: string,
  ): boolean;
  setTriageOutcomes(id: string, outcomes: { position: number; outcome: TriageItemOutcome }[]): void;
  /** Batches created at or after `sinceIso`, plus every unsettled one (pending, confirming), for checkTriageCaps. */
  triageHistory(sinceIso: string): TriageHistoryRow[];
  /** On start: `applying` becomes `interrupted`; `pending` and `confirming` become `expired`. */
  settleTriageAtStart(nowIso: string): { interrupted: number; expired: number };
  /**
   * Undo of a purpose draft's send (an unsubscribe email), one transaction:
   * deletes the outbox row (only from a `states` state) and its draft.
   */
  cancelSendPurpose(outboxId: string, states: OutboxState[]): { cancelled: boolean };

  // ---- Agent and mail (slice 3f) ----

  /**
   * Installs the scope agent paths read (the SQL function mail_ai_in_scope)
   * and rebuilds the excluded conversations from its sender rules.
   */
  setAiScope(scope: AiScope): void;
  /** The installed scope (absent accounts are mode "all"). */
  getAiScope(): AiScope;
  /** The stored scope rows, as setAiScope wants them (read at start). */
  loadAiScope(): AiScope;
  /** Replaces the stored scope rows in one transaction; the caller installs it with setAiScope. */
  putAiScope(
    accounts: { accountId: string; scope: AccountScope }[],
    senders: { kind: "address" | "domain"; value: string }[],
    nowIso: string,
  ): void;
  /** Rebuilds the excluded conversations after a sync round (new rows may add one). */
  refreshExcludedThreads(): void;
  /** The message when one of its copies is inside the scope (that copy), else null: an out-of-scope id is unknown. */
  scopedMessage(messageId: string): MessageHeader | null;

  /** Appends one content-free row; returns its seq. */
  appendAgentLog(entry: LogEntry): number;
  /** Moves every row of a proposal or triage batch to its final outcome and count; returns how many changed. */
  updateAgentLog(refId: string, outcome: LogOutcome, count: number): number;
  /** Records what a row's later step sent (Ask's excerpts): ids (capped), their count and the hidden values; returns how many changed. */
  setAgentLogSources(seq: number, messageIds: readonly string[], count: number, hiddenCount: number): number;
  /** Newest first; `cursor` is the last seq of the previous page. */
  listAgentLog(opts: { threadId?: string; cursor?: string | null; limit: number }): {
    entries: (LogEntry & { seq: number })[];
    next: string | null;
  };
  /** Deletes every row; returns how many. */
  clearAgentLog(): number;
  /** Deletes rows before `beforeIso` and beyond the newest `maxRows`; returns how many. */
  purgeAgentLog(beforeIso: string, maxRows: number): number;

  getAiResult(kind: "summary", subjectId: string): AiResultRecord | null;
  /** Upsert by (kind, subject id). Throws when the result is over AI_RESULT_MAX_BYTES. */
  putAiResult(row: AiResultRecord): void;

  /** Stores kept tasks; `full` when the open tasks would pass TASKS_OPEN_MAX (nothing stored then). */
  keepTasks(rows: NewTask[]): { kept: number } | { full: true };
  /** Open tasks (overdue, dated, then undated) or done ones (latest first); `cursor` from the previous page. */
  listTasks(opts: { done: boolean; cursor?: string | null; limit: number }): { tasks: TaskRecord[]; next: string | null };
  getTask(id: string): TaskRecord | null;
  updateTask(id: string, patch: { title?: string; due?: string | null; done?: boolean }, nowIso: string): boolean;
  deleteTask(id: string): boolean;
  /** Open tasks due before `today` (overdue) and on it. */
  taskCounts(today: string): { overdue: number; today: number };

  /**
   * Labels the messages' (account, dedup key) with `category` (null clears),
   * one transaction; unknown ids are skipped. `previous` holds what each key
   * had before, for the undo.
   */
  setCategories(messageIds: string[], category: Category | null, source: CategorySource, nowIso: string): { previous: PreviousLabel[] };
  /** Puts the labels back as they were (null: none), one transaction. */
  restoreCategories(previous: PreviousLabel[], nowIso: string): void;
  /** Each known id's label and model suggestion. */
  categoriesOf(messageIds: string[]): Map<string, { category: Category | null; source: CategorySource | null; suggestion: AiCategoryAnswer | null }>;
  /** Replaces the model suggestion of each message's (account, dedup key). */
  putCategorySuggestions(rows: { messageId: string; category: AiCategoryAnswer }[], nowIso: string): void;
  listCategoryRules(): CategoryRule[];
  /** Inserts, or returns the existing rule for (kind, value) with `created: false`; `full` at CATEGORY_RULES_MAX. */
  addCategoryRule(
    kind: CategoryRule["kind"],
    value: string,
    category: Category,
    id: string,
    nowIso: string,
  ): { rule: CategoryRule; created: boolean } | { full: true };
  removeCategoryRule(id: string): boolean;

  /** The latest message of each conversation with one dated at or after `sinceIso`, newest first, at most `limit`. */
  replyCandidates(sinceIso: string, limit: number): ReplyCandidate[];
  /** dismissalKey(accountId, dedupKey) of every dismissal. */
  replyDismissals(): Set<string>;
  dismissReply(accountId: string, dedupKey: string, nowIso: string): void;
  getDigest(day: string): DigestRecord | null;
  /** Insert; false when the day already has a row. */
  putDigest(row: DigestRecord): boolean;
  markDigestNotified(day: string, nowIso: string): boolean;

  /** `full` at REMINDERS_LIVE_MAX live reminders (queued, waiting, due); nothing stored then. */
  createReminder(row: NewReminder): { created: true } | { full: true };
  /** The queued reminder of the outbox row turns waiting, sent now, due after its days; returns it, or null. */
  bindReminder(outboxId: string, sentAtIso: string): ReminderRecord | null;
  deleteReminderForOutbox(outboxId: string): number;
  getReminder(id: string): ReminderRecord | null;
  /** By due time (null last); `dueBefore` keeps those due at or before it. */
  listReminders(opts: { states: ReminderState[]; dueBefore?: string; limit: number }): ReminderRecord[];
  updateReminder(
    id: string,
    patch: { state?: ReminderState; days?: number; dueAt?: string | null; threadId?: string | null; notifiedAt?: string | null },
    nowIso: string,
  ): boolean;
  /** Stored rows dated after `afterIso` whose In-Reply-To or References hold one of the ids (any spelling with or without <>). */
  answeringRows(rfcMessageIds: string[], afterIso: string): AnsweringRow[];
  /** The thread of the account's stored copy with this Message-ID, or null. */
  sentCopyThread(accountId: string, rfcMessageId: string): string | null;

  // ---- Slice 3g: dev classes, List-Id, BB links, project binding, incidents and mail rules ----

  /** Writes each row's dev class; a null class marks the row checked (not a dev notification). */
  setDevClass(rows: { id: string; dev: DevClass | null }[]): number;
  /** Rows never classified, outside junk and trash folders, newest first. */
  devUnclassified(limit: number): DevUnclassifiedRow[];
  /**
   * Attached rows of the folder whose List-Id is unknown (NULL), highest uid
   * first, only uids below `belowUid` when given, at most `limit`.
   */
  listUnknown(accountId: string, folder: string, belowUid: number | null, limit: number): { uid: number }[];
  /**
   * Writes List-Ids by uid ('' = checked, none), only where still NULL and
   * only while the folder's stored UIDVALIDITY equals `uidValidity`.
   */
  fillListIds(accountId: string, folder: string, uidValidity: number, ids: { uid: number; listId: string }[]): number;
  /** Each row's normalized List-Id ('' none, null unknown), for rule matching; ids not stored are left out. */
  listIds(ids: string[]): Map<string, string | null>;
  /** Dev notifications dated at or after `sinceIso`, grouped by (source, repo), latest group first. */
  devGroups(opts: { sinceIso: string; accountId?: string | null; cursor?: string | null; limit: number }): {
    groups: DevGroupRow[];
    next: string | null;
  };
  addBbLink(row: BbLinkRow): void;
  listBbLinks(query: { messageIds: string[] } | { accountId: string; threadId: string } | { targetId: string }): BbLinkRow[];
  /** Deletes the links of `kind` to these targets (a deleted BB thread). */
  pruneBbLinks(kind: BbLinkRowKind, targetIds: string[]): number;
  /** The owner's binding of a conversation; null removes it. */
  setConversationProject(accountId: string, threadId: string, projectId: string | null, nowIso: string): void;
  conversationProject(accountId: string, threadId: string): string | null;
  /** Inserts or moves (kind, value) to `projectId`; `full` at BINDINGS_MAX. */
  addBinding(row: BindingRow): { created: boolean } | { full: true };
  removeBinding(kind: BindingKind, value: string): boolean;
  listBindings(): BindingRow[];
  /** Conversations whose project (owner binding, else the first matching rule) is `projectId`, newest first. */
  projectThreads(projectId: string, opts: { cursor: string | null; limit: number }): {
    threads: ThreadSummary[];
    nextCursor: string | null;
  };
  putIncident(row: IncidentRow): void;
  /** The incident thread of a fingerprint; a pending reservation is none. */
  incidentFor(fingerprint: string): IncidentRow | null;
  /**
   * Check and reserve in one transaction (review): when the fingerprint's
   * thread is still `expectedBbThreadId` (null: none) and no other start
   * holds it (a reservation younger than INCIDENT_RESERVE_MS), the row
   * becomes a pending reservation under `token`; false otherwise.
   * putIncident replaces it with the started thread.
   */
  reserveIncident(fingerprint: string, expectedBbThreadId: string | null, row: { token: string; projectId: string; at: string }): boolean;
  /** Drops the reservation `token` holds (the start failed); other rows stay. */
  releaseIncident(fingerprint: string, token: string): void;
  /** Sets `last_at`; false when there is no incident. */
  touchIncident(fingerprint: string, nowIso: string): boolean;
  // Local archives (slice 3p): mail read from files, apart from every mailbox.
  listArchives(): ArchiveRecord[];
  getArchive(id: string): ArchiveRecord | null;
  /** The archive made from this source path, if any (an import of the same file continues it). */
  findArchiveBySource(sourcePath: string): ArchiveRecord | null;
  /** `full` when ARCHIVES_MAX archives exist already. */
  createArchive(archive: ArchiveRecord): { archive: ArchiveRecord } | { full: true };
  /**
   * Adds a batch and records the import's progress, in one transaction. A
   * message already stored at the same place is left as it is. Rows beyond
   * ARCHIVE_MESSAGES_MAX are not added. Returns how many were added.
   */
  appendArchiveMessages(
    archiveId: string,
    rows: NewArchiveMessage[],
    progress: { resumeAt: number; skipped: number; complete: boolean; nowIso: string },
  ): number;
  /** Deletes the archive and its messages; false when there is none. */
  removeArchive(id: string): boolean;
  /** One page, newest first; `archiveId` null: every archive. `query`: words in the subject, the sender or the text. */
  archiveMessages(
    archiveId: string | null,
    opts: { query: string; limit: number; cursor: ArchiveCursor | null },
  ): { rows: ArchiveSummary[]; nextCursor: ArchiveCursor | null };
  archiveMessage(id: string): { message: ArchiveMessage; place: ArchivePlace } | null;
  /** Filters (slice 3m) in the order they apply: the order they were made in; an edit keeps its place. */
  listMailFilters(): MailFilter[];
  /** Inserts or replaces a filter; `full` when a new one would exceed FILTERS_MAX. */
  saveMailFilter(filter: MailFilter, nowIso: string): { filter: MailFilter } | { full: true };
  deleteMailFilter(id: string): boolean;
  listRules(): RuleRecord[];
  /** Inserts or updates by id (an edit keeps the id and its run counts); `full` at RULES_MAX. */
  saveRule(rule: Rule, nowIso: string): { rule: RuleRecord } | { full: true };
  /** Deletes the rule; its runs stay until the 30-day purge (they keep counting). */
  deleteRule(id: string): boolean;
  /** Disables every enabled rule; returns their ids. */
  pauseRules(nowIso: string): string[];
  /** Enables these rules again. */
  resumeRules(ids: string[], nowIso: string): number;
  /**
   * One transaction: `duplicate` when (rule, message) already has a run; for
   * a `starting` row the caps are counted (starting and started runs: the
   * rule in the last hour and day, every rule in the day, deleted rules'
   * runs included, the rule in this conversation in 24 hours) and the row is
   * stored `capped` when one is reached; otherwise inserted as given.
   */
  insertRuleRun(row: NewRuleRun, caps: RuleCaps): "inserted" | "capped" | "duplicate";
  updateRuleRun(id: string, patch: { state?: RuleRunState; bbThreadId?: string | null; notifiedAt?: string | null }, nowIso: string): boolean;
  /** The run (starting or started) whose BB thread this is: a rule thread. */
  ruleRunByBbThread(bbThreadId: string): RuleRunRecord | null;
  getRuleRun(id: string): RuleRunRecord | null;
  /** Newest first, runs whose message is gone left out; `state` keeps those in it. */
  listRuleRuns(opts: { state?: RuleRunState; cursor?: string | null; limit: number }): { runs: RuleRunRecord[]; next: string | null };
  /** `starting` runs created before `beforeIso` become `failed`; returns how many. */
  failStaleStarts(beforeIso: string, nowIso: string): number;
  /** `starting` runs created before `beforeIso`, oldest first (reconciled against BB). */
  staleStartingRuns(beforeIso: string): RuleRunRecord[];
  /**
   * Marks a BB thread a rule thread (review C1): kept apart from messages,
   * folders and accounts, so deleting the mail never lifts the gate; purged
   * after RULE_THREADS_KEEP_DAYS. A second write for the thread is ignored.
   */
  addRuleThread(row: { bbThreadId: string; ruleId: string; runId: string | null; createdAt: string }): void;
  /** A rule thread: a rule_threads row, or a starting or started run with this BB thread. */
  isRuleThread(bbThreadId: string): boolean;

  /**
   * The daily purge (slice 3f): labels and suggestions without a row of their
   * dedup key, ai_results of gone threads, digests and reply dismissals older
   * than 60 days, answered reminders older than ANSWERED_KEEP_DAYS, and the
   * agent log by age and count. Slice 3g: conversation bindings of gone
   * conversations, rule runs older than 30 days, incidents older than 90,
   * ready runs older than 7 days become `expired`; with `knownProjectIds`,
   * conversation bindings older than 30 days to a project not in it.
   */
  purgeDaily(nowIso: string, knownProjectIds?: readonly string[] | null): number;

  // ---- Slice 3h ----

  /** One row per deduplicated message in the scope's folder (grouping off), keyset by (date DESC, id DESC). */
  listMessages(
    accountId: string,
    folder: string,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { messages: MessageSummary[]; nextCursor: string | null };
  /** As listMessages over a role's folders in every account. */
  listMessagesAll(
    role: SpecialUse,
    cursor: string | null,
    limit: number,
    filter?: ThreadFilter,
  ): { messages: MessageSummary[]; nextCursor: string | null };

  /** Rows the owner touched leave expiry: `history` and `search` become `opened`. Returns ids changed. */
  promoteKept(messageIds: readonly string[]): string[];
  /**
   * Deletes, locally, `search` rows kept before `nowIso - days`, with their
   * attachments, inline parts and attachment text. Returns the accounts touched.
   */
  expireSearchRows(nowIso: string, days: number): { removed: number; accounts: string[] };

  /** Loaded history of a folder: where it starts (NULL: window only) and when reconcile last checked it. */
  historyState(accountId: string, folder: string): { historySince: string | null; historyCheckedAt: string | null } | null;
  setHistorySince(accountId: string, folder: string, since: string | null): void;
  /** Reconcile checked the loaded history (spec resolution 9). */
  historyChecked(accountId: string, folder: string, atIso: string): void;
  /**
   * Rows of the folder dated at or after `sinceIso` (or undated: the window
   * as localFolderIndex reads it) are window rows: their `kept` and
   * `kept_at` are cleared. Returns how many rows changed.
   */
  clearWindowKept(accountId: string, folder: string, sinceIso: string): number;
  /** One stored row id per dedup key of the account that has one (server search dedups fetched hits by it). */
  idsByDedupKey(accountId: string, keys: readonly string[]): Map<string, string>;
  /** Ids of the folder's rows with this `kept` state, attached or not (a reset looks for `opened` ones, spec resolution 16). */
  keptIds(accountId: string, folder: string, kept: KeptState): string[];
  /** Rows dated before the window whose `kept` is history or search. */
  historyForgetCount(accountId: string, folder: string): number;
  /** Deletes those rows (with their attachment text) and clears history_since; returns how many. */
  historyForget(accountId: string, folder: string): number;

  /**
   * After a server RENAME: every stored path equal to `from` or under
   * `from + delimiter` is rewritten in one transaction (spec "Folder
   * management", resolution 3, folders_json included).
   */
  rehomeFolder(accountId: string, from: string, to: string, delimiter: string): void;
  /** After a server DELETE: the folder's rows, sync state, prefs and AI scope entry go. */
  dropFolder(accountId: string, path: string): void;
  /** Rows of the folder waiting to move out, or moves queued into it. */
  movePendingCount(accountId: string, path: string): number;

  /** grouping per folder; `accountId` '*' with a role name as `path` for All accounts views. */
  folderGrouping(accountId: string, path: string): boolean;
  setFolderGrouping(accountId: string, path: string, grouping: boolean): void;

  // OpenPGP keys (slice 3k). The private half is stored sealed by the vault
  // and is read only through pgpPrivateSealed; no list or row carries it.
  listPgpKeys(): PgpKeyRow[];
  getPgpKey(id: string): PgpKeyRow | null;
  /** "exists": this kind already has the fingerprint; "full": the cap is reached. */
  savePgpKey(row: PgpKeyRow, privateSealed: string | null): "saved" | "exists" | "full";
  deletePgpKey(id: string): boolean;
  /** The vault-sealed private key of an own key; null for a contact key or an unknown id. */
  pgpPrivateSealed(id: string): string | null;

  listSavedSearches(): SavedSearchRow[];
  /**
   * `id` null: inserts under `newId` at the end ("full" at
   * SAVED_SEARCHES_MAX); else updates that row ("not_found" when unknown).
   */
  saveSavedSearch(
    row: { id: string | null; name: string; query: string; accountId: string | null; nowIso: string },
    newId: string,
  ): { id: string } | "full" | "not_found";
  deleteSavedSearch(id: string): boolean;
  moveSavedSearch(id: string, position: number): boolean;

  /** Non-inline attachments of rows not waiting to move, one per (dedup key, part). */
  filesList(filter: FilesFilter, cursor: string | null, limit: number): { files: FileRow[]; nextCursor: string | null };
  /** The stored counts and lists of the sender card (the server adds images, block and project). */
  senderStats(address: string, accountId: string | null): SenderStats;
  /** At most RELATED_CANDIDATES_MAX local candidates for the message and its terms. */
  relatedCandidates(messageId: string, terms: readonly string[]): RelatedCandidate[];
  /** Summaries of the ids (any order; missing ids left out). */
  summaries(messageIds: readonly string[]): MessageSummary[];

  /** X-GM-LABELS as stored, per message id (empty when not fetched). */
  gmLabels(messageIds: readonly string[]): Map<string, string[]>;
  /** Stores the labels the server reported for these uids of one folder, on every copy of each message. */
  setGmLabels(accountId: string, folder: string, entries: readonly { uid: number; labels: string[] }[]): void;
  /**
   * Per message id: its copy in `folder` (same account and dedup key) with
   * that copy's uid (null while detached). Messages with no copy there are
   * left out (labels_change resolves All Mail uids by it).
   */
  copiesIn(folder: string, messageIds: readonly string[]): Map<string, { id: string; accountId: string; uid: number | null }>;
  /** Every label any stored message of the account carries, system labels included. */
  accountLabels(accountId: string): string[];

  /** Attachments the indexer may still extract (no attachment_text row yet, not in Spam or Trash), with what the caps need. */
  attachmentTextCandidates(limit: number): AttachmentCandidate[];
  insertAttachmentText(row: AttachmentTextRow): void;
  attachmentTextStatus(): { indexed: number; skipped: number; failed: number; pending: number; totalChars: number };
  /** Deletes failed rows so the next round tries them again; returns how many. */
  retryAttachmentText(): number;
  /** Deletes every row; returns how many. */
  clearAttachmentText(): number;

  // Slice 3i --------------------------------------------------------------

  /**
   * The organizational domains of the owner's identities (accounts and
   * active aliases), of `sent_recipients` and of To/Cc in Sent-role rows:
   * own first, then the most recently written to; deduplicated, at most
   * `limit` (the known set of the lookalike check).
   */
  knownDomainList(limit: number): string[];
  /** What the sender check and the header view read of these stored messages; unknown ids are left out. */
  senderCheckRows(ids: string[]): SenderCheckRow[];
  /**
   * Stores a sender check (cut to fit SENDER_CHECK_MAX_BYTES serialized by
   * `fitSenderCheck`, never dropped) where the row has none, or over it with
   * `force`; fills `receipt` (null: not known) and `crypto` where NULL, or
   * over them with `force` (but never takes back an encrypted kind whose body
   * is already gone). In the same write a failed check clears the dev class to
   * checked-none and an encrypted kind nulls the body (the FTS trigger
   * forgets it). With `guard`, writes only while the folder's stored
   * UIDVALIDITY equals it and the row is attached. True when it wrote.
   */
  writeSenderCheck(
    id: string,
    input: { check: SenderCheck; receipt: boolean | null; crypto: MailCrypto | null; force: boolean; guard?: { uidValidity: number } },
  ): boolean;
}

/** Largest serialized sender check stored (part A "Data model"). */
export const SENDER_CHECK_MAX_BYTES = 2 * 1024;

/** Slice 3i: a stored message as the sender check and the header view read it. */
export type SenderCheckRow = {
  id: string;
  accountId: string;
  folder: string;
  /** null while detached. */
  uid: number | null;
  /** The effective role of the folder the row sits in. */
  folderRole: SpecialUse | null;
  /** `messages.sender_check_json`: null when not judged (read through readStoredCheck). */
  senderCheckJson: string | null;
  /** null: not known. */
  receiptRequested: boolean | null;
  crypto: MailCrypto | null;
  from: MailAddress;
  /** null: not known (a row from before Reply-To was kept). */
  replyTo: MailAddress[] | null;
  /** The List-Id; null when none or not known. */
  listId: string | null;
  /** null: not known. */
  bulk: boolean | null;
  /** The first non-blank line of the stored text body (inline PGP armor); null without one. */
  firstLine: string | null;
};

/** Store options of search (slice 3h adds cursor and attachments). */
export type SearchOptions = {
  /** Agent paths (slice 3f): only rows inside the AI scope. */
  scoped?: boolean;
  /** Owner page only: also match attachment text (spec resolution 4). */
  attachments?: boolean;
  cursor?: SearchCursor | null;
};

export type SavedSearchRow = {
  id: string;
  name: string;
  query: string;
  accountId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type FilesFilter = {
  kind?: FileKind;
  /** From address, case-insensitive equality. */
  sender?: string;
  accountId?: string;
  /** A file name fragment. */
  name?: string;
  /** Spam and Trash are left out unless true. */
  includeJunk?: boolean;
};

export type SenderStats = {
  name: string | null;
  fromCount: number;
  toCount: number;
  toCapped: boolean;
  firstDate: string | null;
  lastDate: string | null;
  conversations: ThreadSummary[];
  files: FileRow[];
};

export type AttachmentTextRow = {
  messageId: string;
  partId: string;
  state: "indexed" | "skipped" | "failed";
  reason: "too_large" | "unsupported" | "encrypted" | "timeout" | "unreadable" | null;
  body: string | null;
  extractedAt: string;
};

// ---- Slice 3g store rows ----

export type DevUnclassifiedRow = { id: string; accountId: string; from: string; subject: string };

/** One dev group of the Dev view. */
export type DevGroupRow = {
  source: DevSource;
  repo: string | null;
  counts: Partial<Record<DevKind, number>>;
  ciFailed: number;
  /** Alert mails in the firing state (Today's line). */
  firing: number;
  latestFailure: { messageId: string; subject: string; date: string | null } | null;
  unread: number;
  total: number;
  latestDate: string | null;
  /** The group's message ids, newest first, at most 200 (for Mark read and Archive). */
  messageIds: string[];
};

/** A `bb_links` row. `extra` holds a board id, a sha256 or a patchRef; no text. */
export type BbLinkRow = {
  id: string;
  accountId: string;
  messageId: string;
  threadId: string | null;
  kind: BbLinkRowKind;
  targetId: string;
  projectId: string | null;
  extra: string | null;
  createdAt: string;
};

export const BINDING_KINDS = ["address", "domain", "list", "repo"] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];
/** Most binding rules. */
export const BINDINGS_MAX = 500;
/** A binding rule; `value` lower case, a domain in ASCII. */
export type BindingRow = { kind: BindingKind; value: string; projectId: string; createdAt: string };

/** How long an incident start's reservation holds the fingerprint. */
export const INCIDENT_RESERVE_MS = 10 * 60 * 1000;
/** The bb_thread_id of a reserved incident (no thread yet). */
export const INCIDENT_PENDING_PREFIX = "pending:";

/** An incident thread; `fingerprint` is the alert's internal fingerprint (alertRef in outputs). */
export type IncidentRow = { fingerprint: string; bbThreadId: string; projectId: string; createdAt: string; lastAt: string };

export type RuleRecord = Rule & { createdAt: string; updatedAt: string };

export const RULE_RUN_STATES = ["starting", "ready", "started", "dismissed", "capped", "failed", "expired"] as const;
export type RuleRunState = (typeof RULE_RUN_STATES)[number];

export type NewRuleRun = {
  id: string;
  ruleId: string;
  accountId: string;
  messageId: string;
  threadId: string | null;
  /** The rule's project, for reconciling a start against BB's threads. */
  projectId?: string | null;
  /** `starting` (Start mode: caps checked) or `ready` (Prepare mode, or a Start run that cannot start). */
  state: "starting" | "ready";
  createdAt: string;
};

export type RuleRunRecord = {
  id: string;
  ruleId: string;
  accountId: string;
  /** Null once the message is gone: the run stays for the caps (review C1). */
  messageId: string | null;
  threadId: string | null;
  projectId: string | null;
  state: RuleRunState;
  bbThreadId: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RuleCaps = { perRuleHour: number; perRuleDay: number; allDay: number };

// ---- Slice 3g host ports: BB projects, files, threads and Taskboard ----

/** A project's local checkout. */
export type WorkingTree = { hostId: string; path: string };

export type BbFileEntry = { name: string; path: string };

/** A file read from BB: bytes, the host's type (untrusted) and size. */
export type BbFileBytes = { bytes: Uint8Array; mimeType: string | null; sizeBytes: number };

export type ProjectWriteResult =
  | { outcome: "written"; sha256: string; sizeBytes: number }
  | { outcome: "exists"; currentSha: string };

/** Thrown by ProjectDirectory and BbThreads for a refused or failed call; `code` only, never a path. */
export class BbPortError extends Error {
  readonly code: "not_found" | "refused" | "failed" | "disabled";
  constructor(code: "not_found" | "refused" | "failed" | "disabled", message = "BB refused the request") {
    super(message);
    this.name = "BbPortError";
    this.code = code;
  }
}

/** BB projects and the project working tree (adapter: bb.sdk.projects and bb.sdk.files). */
export interface ProjectDirectory {
  /** Every project with its remote and working tree; cached briefly by the adapter. */
  list(): Promise<ProjectInfo[]>;
  files(projectId: string, query: string, limit: number): Promise<{ files: BbFileEntry[]; truncated: boolean }>;
  folders(projectId: string, query: string, limit: number): Promise<{ folders: BbFileEntry[]; truncated: boolean }>;
  fileContent(projectId: string, path: string): Promise<BbFileBytes>;
  /** The file's sha256 when it exists, null when not found; other errors throw. */
  exists(tree: WorkingTree, relativePath: string): Promise<{ sha256: string } | null>;
  /** Create-only unless `replaceSha` names the file's current sha256. */
  write(tree: WorkingTree, relativePath: string, bytes: Uint8Array, opts: { replaceSha: string | null }): Promise<ProjectWriteResult>;
}

export type BbPermissionMode = "accept-edits" | "auto" | "full";

export type BbEnvironment =
  | { type: "project-default" }
  | { type: "host"; hostId: string; workspace: { type: "managed-worktree"; baseBranch: { kind: "default" } } };

/** An extra input item of a spawn: an uploaded attachment. */
export type BbInputItem = { type: "localFile"; path: string; hostId?: string; name?: string; mimeType?: string };

export type BbThreadInfo = {
  id: string;
  title: string | null;
  projectId: string | null;
  archived: boolean;
  updatedAt: string | null;
};

export type BbSpawnArgs = {
  projectId: string;
  environment: BbEnvironment;
  title: string;
  prompt: string;
  extraInput?: BbInputItem[];
  pluginMetadata: Record<string, unknown>;
  permissionMode?: BbPermissionMode;
};

/** BB agent threads (adapter: bb.sdk.threads and project attachments). */
export interface BbThreads {
  spawn(args: BbSpawnArgs): Promise<{ threadId: string }>;
  /** Queued when the thread is running (never interrupts a turn). */
  send(threadId: string, text: string): Promise<void>;
  output(threadId: string): Promise<string | null>;
  /** Existing, not deleted threads (archived ones marked). */
  list(query: { threadIds: string[] } | { projectId: string; limit: number }): Promise<BbThreadInfo[]>;
  storageFiles(threadId: string, query: string, limit: number): Promise<{ files: BbFileEntry[]; truncated: boolean }>;
  /** A file inside the thread's storage root only. */
  readStorageFile(threadId: string, path: string): Promise<BbFileBytes>;
  uploadAttachment(projectId: string, bytes: Uint8Array, filename: string, mimeType: string): Promise<BbInputItem>;
  /** The project's default permission mode, null when none is set. */
  defaultPermissionMode(projectId: string): Promise<BbPermissionMode | null>;
  /** This plugin's metadata of the given threads (reconciling rule starts); threads without any are left out. */
  pluginMetadata(threadIds: string[]): Promise<Map<string, unknown>>;
}

/** Taskboard as a task target (adapter: bb.sdk.plugins.callRpc). Never throws. */
export interface TaskTarget {
  boards(): Promise<{ boards: { id: string; name: string }[] } | { unavailable: string }>;
  /** `unavailable`: nothing was sent; `uncertain`: sent, no answer read (the task may exist). */
  create(
    boardId: string,
    title: string,
    description: string,
  ): Promise<{ taskId: string } | { refused: string } | { unavailable: string } | { uncertain: string }>;
}

/** Re-exported for the adapters. */
export type { RuleMode };

/** A cached AI result (slice 3f): summaries only. */
export type AiResultRecord = {
  kind: "summary";
  /** The thread id. */
  subjectId: string;
  accountId: string;
  sourceSha256: string;
  provider: string;
  model: string;
  /** The parsed output as JSON, at most AI_RESULT_MAX_BYTES. */
  resultJson: string;
  notesJson: string;
  /** ISO 8601. */
  createdAt: string;
};

/** Largest stored AI result. */
export const AI_RESULT_MAX_BYTES = 64 * 1024;
/** Most open tasks kept. */
export const TASKS_OPEN_MAX = 2_000;

export type NewTask = {
  id: string;
  accountId: string;
  messageId: string;
  dedupKey: string;
  title: string;
  /** YYYY-MM-DD. */
  due: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** Slice 3g: a task from mail kept locally holds its note; absent or null for 3f tasks. */
  note?: string | null;
};

export type TaskRecord = Omit<NewTask, "messageId" | "note"> & {
  note: string | null;
  /** Null once the message went away. */
  messageId: string | null;
  /** The message's thread, when it is stored. */
  threadId: string | null;
  doneAt: string | null;
  updatedAt: string;
};

export type DigestRecord = {
  /** Server-local YYYY-MM-DD. */
  day: string;
  builtAt: string;
  since: string;
  replyCount: number;
  noticeCount: number;
  notifiedAt: string | null;
};

export type NewReminder = {
  id: string;
  accountId: string;
  /** While queued. */
  outboxId: string | null;
  /** The sent Message-ID. */
  rfcMessageId: string;
  threadId: string | null;
  days: number;
  sentAt: string | null;
  dueAt: string | null;
  state: ReminderState;
  createdAt: string;
};

export type ReminderRecord = NewReminder & { updatedAt: string; notifiedAt: string | null };

/** A stored row as reminders judge it (core `answers`). */
export type AnsweringRow = {
  id: string;
  accountId: string;
  threadId: string | null;
  /** The row's own Message-ID. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: string | null;
  bulk: boolean | null;
  fromAddress: string;
};

/** One Inbox message as mail_inbox lists it (slice 3e). */
export type InboxMessage = MessageSummary & {
  bulk: boolean | null;
  /** `messages.unsubscribe_json`; null when not known. */
  unsubscribe: UnsubscribeInfo | null;
  /** A snooze's due time when the message has one; ISO 8601. */
  snoozedUntil: string | null;
};

/** An unsubscribes row (slice 3e): the latest request per list and account. */
export type UnsubscribeRecord = {
  accountId: string;
  /** Never shown or returned to the page. */
  listKey: string;
  method: "one_click" | "mailto";
  state: UnsubscribeState;
  /** mailto: the outbox row. */
  outboxId: string | null;
  /** ISO 8601. */
  requestedAt: string;
};

/** What creating a triage batch stores. */
export type NewTriageBatch = {
  /** The card's request id and the undo id. */
  id: string;
  threadId: string;
  contentHash: string;
  /** The agent's summary (agent text), or null. */
  summary: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  expiresAt: string;
};

export type TriageBatchRecord = NewTriageBatch & {
  state: TriageBatchState;
  viewTokenHash: string | null;
  /** Positions the owner approved; null until submitted. */
  approved: number[] | null;
  /** Account ids the owner ticked "create Snoozed folder" for; null until submitted. */
  createSnoozeFolder: string[] | null;
  /** ISO 8601. */
  updatedAt: string;
};

export type TriageItemRecord = {
  batchId: string;
  position: number;
  messageId: string;
  accountId: string;
  action: TriageAction;
  snoozeUntil: string | null;
  note: string | null;
  outcome: TriageItemOutcome | null;
};

/** A stored template (slice 3d). Global, not per account. */
export type TemplateRecord = {
  id: string;
  name: string;
  nameKey: string;
  doc: ComposeDoc;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
};

/** What creating an agent proposal stores. Never the content itself: that is the hidden draft. */
export type NewProposal = {
  id: string;
  /** The BB thread the agent proposed in (for the caps). */
  threadId: string;
  draftId: string;
  accountId: string;
  kind: ComposeKind;
  sourceMessageId: string | null;
  /** Recipients the agent added to a reply beyond the Reply rules. */
  added: string[];
  contentSha256: string;
  /** Forwarded attachments left out over the size cap (the card lists them). */
  leftOut: number;
  /** The template the agent named (slice 3d), for the card's label only. */
  templateName: string | null;
  /** ISO 8601. */
  expiresAt: string;
  /** ISO 8601. */
  createdAt: string;
};

/** An agent_proposals row. `draftId` is null once its hidden draft was dropped. */
export type ProposalRecord = Omit<NewProposal, "draftId"> & {
  draftId: string | null;
  state: ProposalState;
  viewTokenSha256: string | null;
  /** ISO 8601. */
  viewedAt: string | null;
  outboxId: string | null;
  /** ISO 8601. */
  updatedAt: string;
};

/** A cached translation. Text only. */
export type TranslationRecord = {
  messageId: string;
  targetLanguage: string;
  providerId: string;
  model: string;
  text: string;
  truncated: boolean;
  /** sourceHash of the translated source text, language and prompt version. */
  sourceSha256: string;
  /** ISO 8601. */
  createdAt: string;
};
