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
  MailAddress,
} from "./model.ts";
import type { OutboxChangedPayload } from "./contract.ts";
import type { ProposalCapRow, ProposalState } from "./agent-propose.ts";

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
  close(): Promise<void>;
}

/** Gateways throw this when the server rejects the credentials. */
export class ImapAuthError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "ImapAuthError";
  }
}

/** An SMTP server and its login, for one session. The password is dropped after it. */
export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
}

/** What the server accepted. No response text: it is never kept or logged. */
export interface SendResult {
  accepted: string[];
  rejected: string[];
}

/** Transports throw this; `afterData` says whether DATA may have been accepted. */
export class SendError extends Error {
  readonly kind: SendErrorKind;
  readonly afterData: boolean;
  constructor(kind: SendErrorKind, afterData: boolean) {
    super(`Send failed: ${kind}`);
    this.name = "SendError";
    this.kind = kind;
    this.afterData = afterData;
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
  /** Of these addresses, the ones (lowercased) in To or Cc of a stored message in a Sent-role folder. */
  addressesSentTo(addresses: string[]): Set<string>;
  getTranslation(messageId: string, targetLanguage: string): TranslationRecord | null;
  /** Upsert by (messageId, targetLanguage), then evict the oldest beyond TRANSLATION_CACHE_ROWS by createdAt. */
  putTranslation(row: TranslationRecord): void;
  /** Deletes every cached translation; returns how many. */
  clearTranslations(): number;
}

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
