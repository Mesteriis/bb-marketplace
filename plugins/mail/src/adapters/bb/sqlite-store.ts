// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/db/migrations.ts, src/services/db/search.ts, src/services/search/searchQueryBuilder.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// MailStore on the plugin's own SQLite database (better-sqlite3). Semantics
// match the in-memory store in src/core/testing/fakes.ts:
//   - an owner-asked \Seen / \Flagged change waits in `seen_desired` /
//     `flag_desired` (NULL = nothing pending) and wins over server flags
//     until the push clears it; `seen_pending` (slice 1–2) is frozen since
//     migration 3 and no longer read or written;
//   - a folder reset detaches uids (uid = NULL) and keeps message ids; a
//     detached row with the same Message-ID is reattached on upsert;
//   - an undated message counts as inside the sync window and sorts as the
//     newest message of its thread, but a thread's last_date is its latest
//     non-null date (null only when every message is undated);
//   - the threads table is derived from messages and rebuilt whenever the
//     rows it summarizes change, so nothing durable is keyed on a thread id;
//   - one message can have a row in several folders (Gmail labels); rows of
//     one message share `dedup_key`, and thread, folder, badge and search
//     counts count distinct keys (store-rules.ts holds the shared rules);
//   - threads are account-wide; a thread is listed in a folder when it has a
//     row there that is not waiting to move out (`move_pending`);
//   - a move re-homes the row (same id) to the destination; without a uid map
//     the row waits detached there until that folder's sync reattaches it by
//     Gmail id or Message-ID, or deletes it at the end of the round.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AttachmentMeta,
  ComposeAttachment,
  ComposeKind,
  DraftOrigin,
  DraftRecord,
  DraftServerCopyState,
  OutboxRecord,
  OutboxState,
  SendErrorKind,
  SentCopyPolicy,
  SmtpSecurity,
  FetchedMessage,
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
} from "../../core/model.ts";
import type { ComposeDoc } from "../../core/compose-doc.ts";
import { cleanSnippet, needsSnippetRepair, snippetOf } from "../../core/snippet.ts";
import type { MailStore, ProposalRecord, TranslationRecord } from "../../core/ports.ts";
import type { ProposalState } from "../../core/agent-propose.ts";
import { TRANSLATION_CACHE_ROWS } from "../../core/translate.ts";
import {
  capInlineParts,
  compareFolders,
  dedupKeyOf,
  effectiveSpecialUse,
  rankRecipientSuggestions,
  UNIFIED_ROLES,
  type SuggestionEntry,
} from "../../core/store-rules.ts";

/**
 * Append-only migrations for bb.storage.migrate (index = migration id). Each
 * element is one step and may hold several statements; all unapplied steps run
 * in one transaction. BB hashes each statement and rejects a changed one:
 * never edit or reformat a shipped element (whitespace included), only append.
 */
export const MIGRATIONS: string[] = [
  // 0: schema. `seq` is the stable rowid the external-content FTS index uses.
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_sealed TEXT NOT NULL,
    preset TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_sync_at TEXT,
    last_error TEXT,
    auth_failed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sync_state (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    uid_validity INTEGER NOT NULL,
    last_uid INTEGER NOT NULL,
    synced_since TEXT NOT NULL,
    PRIMARY KEY (account_id, folder)
  );

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    uid INTEGER,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    from_name TEXT,
    from_address TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    date TEXT,
    snippet TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    html_truncated INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    seen_pending INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    gm_thrid TEXT
  );
  CREATE UNIQUE INDEX messages_folder_uid ON messages(account_id, folder, uid) WHERE uid IS NOT NULL;
  CREATE INDEX messages_message_id ON messages(account_id, message_id);
  CREATE INDEX messages_thread ON messages(thread_id);
  CREATE INDEX messages_date ON messages(account_id, date);

  CREATE TABLE attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    part_id TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_id TEXT,
    is_inline INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, part_id)
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    last_date TEXT,
    message_count INTEGER NOT NULL,
    unread_count INTEGER NOT NULL,
    participants_json TEXT NOT NULL,
    snippet TEXT NOT NULL
  );
  CREATE INDEX threads_list ON threads(account_id, last_date, id);
  `,
  // 1: full-text search (Velo migration v2, without the snippet column). The
  // update trigger fires only for indexed columns, so flag and thread updates
  // do not re-tokenize bodies.
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject,
    from_name,
    from_address,
    body_text,
    content='messages',
    content_rowid='seq',
    tokenize='trigram'
  );

  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text)
    VALUES (new.seq, new.subject, new.from_name, new.from_address, new.body_text);
  END;

  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text)
    VALUES ('delete', old.seq, old.subject, old.from_name, old.from_address, old.body_text);
  END;

  CREATE TRIGGER messages_au AFTER UPDATE OF subject, from_name, from_address, body_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text)
    VALUES ('delete', old.seq, old.subject, old.from_name, old.from_address, old.body_text);
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text)
    VALUES (new.seq, new.subject, new.from_name, new.from_address, new.body_text);
  END;
  `,
  // 2: slice 2 — folders, cross-folder identity, moves, inline images, image
  // senders. Slice-1 rows get their dedup key here; their INBOX sync_state
  // rows stay valid.
  `
  ALTER TABLE messages ADD COLUMN gm_msgid TEXT;
  ALTER TABLE messages ADD COLUMN dedup_key TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages ADD COLUMN move_pending TEXT;
  ALTER TABLE messages ADD COLUMN move_failures INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET dedup_key = CASE WHEN message_id IS NOT NULL THEN 'mid:' || message_id || ':' || size ELSE 'id:' || id END;
  CREATE INDEX messages_dedup ON messages(account_id, dedup_key);
  CREATE INDEX messages_folder_pending ON messages(account_id, folder, move_pending);

  CREATE TABLE folders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    delimiter TEXT NOT NULL,
    special_use TEXT,
    selectable INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, path)
  );

  CREATE TABLE image_senders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, address)
  );

  CREATE TABLE inline_parts (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (message_id, content_id)
  );
  `,
  // 3: slice 3a — desired flag state (NULL = no pending change, 0/1 = the
  // value to push) replaces seen_pending, which stays in place, frozen; the
  // thread-date index serves All accounts paging across accounts.
  `
  ALTER TABLE messages ADD COLUMN seen_desired INTEGER;
  ALTER TABLE messages ADD COLUMN flag_desired INTEGER;
  UPDATE messages SET seen_desired = 1 WHERE seen_pending = 1;
  CREATE INDEX threads_last_date ON threads(last_date, id);
  `,
  // 4: slice 3b — SMTP and the Sent-copy policy per account (iCloud and
  // Gmail backfilled from their presets), Reply-To on synced mail (NULL =
  // synced before it was kept), the composer's drafts and attachments, and
  // the outbox (one row per Send, id = the page's requestId; a done row is
  // deleted, so every row is live and a draft has at most one).
  `
  ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
  ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
  ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
  ALTER TABLE accounts ADD COLUMN smtp_username TEXT;
  ALTER TABLE accounts ADD COLUMN sent_copy TEXT;
  UPDATE accounts SET smtp_host = 'smtp.mail.me.com', smtp_port = 587,
    smtp_security = 'starttls', sent_copy = 'append' WHERE preset = 'icloud';
  UPDATE accounts SET smtp_host = 'smtp.gmail.com', smtp_port = 465,
    smtp_security = 'tls', sent_copy = 'server' WHERE preset = 'gmail';
  UPDATE accounts SET sent_copy = 'append' WHERE sent_copy IS NULL;

  ALTER TABLE messages ADD COLUMN reply_to_json TEXT;

  CREATE TABLE compose_drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_message_id TEXT,
    message_id TEXT NOT NULL,
    in_reply_to TEXT,
    refs_json TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    bcc_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    doc_json TEXT NOT NULL,
    import_json TEXT,
    revision INTEGER NOT NULL,
    server_state TEXT NOT NULL DEFAULT 'none',
    server_folder TEXT,
    server_uidvalidity INTEGER,
    server_uid INTEGER,
    server_revision INTEGER,
    server_size INTEGER,
    origin TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX compose_drafts_account ON compose_drafts(account_id);
  CREATE INDEX compose_drafts_server ON compose_drafts(account_id, server_folder, server_uid);

  CREATE TABLE compose_attachments (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES compose_drafts(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_id TEXT,
    data BLOB NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX compose_attachments_draft ON compose_attachments(draft_id, position);

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    draft_id TEXT,
    message_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    envelope_from TEXT NOT NULL,
    envelope_to_json TEXT NOT NULL,
    mime BLOB NOT NULL,
    bcc_header TEXT,
    state TEXT NOT NULL,
    send_after TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_kind TEXT,
    rejected_json TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX outbox_state ON outbox(state, send_after);
  CREATE UNIQUE INDEX outbox_draft_live ON outbox(draft_id) WHERE draft_id IS NOT NULL;
  `,
  // 5: slice 3c. A hidden draft behind an agent's confirmation card carries
  // its proposal id; proposals keep ids, states and the content hash only (the
  // content is the hidden draft); translations are plain text, one per
  // message and language. No REFERENCES: deletes are explicit.
  `
  ALTER TABLE compose_drafts ADD COLUMN proposal_id TEXT;

  CREATE TABLE agent_proposals (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    draft_id TEXT,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_message_id TEXT,
    added_json TEXT NOT NULL DEFAULT '[]',
    content_sha256 TEXT NOT NULL,
    left_out INTEGER NOT NULL DEFAULT 0,
    view_token_sha256 TEXT,
    viewed_at TEXT,
    state TEXT NOT NULL,
    outbox_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_proposals_thread ON agent_proposals(thread_id, state, created_at);

  CREATE TABLE translations (
    message_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    text TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, target_language)
  );
  CREATE INDEX translations_created ON translations(created_at);
  `,
];

const HTML_CAP = 1_000_000;
/** Rows per transaction when stale snippets are repaired on load. */
const SNIPPET_REPAIR_BATCH = 500;
/** Trigram FTS needs at least three characters; shorter text uses LIKE. */
const FTS_MIN_CHARS = 3;

type AccountRow = {
  id: string;
  email: string;
  display_name: string | null;
  host: string;
  port: number;
  username: string;
  password_sealed: string;
  preset: StoredAccount["preset"];
  created_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  auth_failed: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: SmtpSecurity | null;
  smtp_username: string | null;
  sent_copy: SentCopyPolicy | null;
};

type MessageRow = {
  id: string;
  account_id: string;
  folder: string;
  thread_id: string;
  date: string | null;
  from_name: string | null;
  from_address: string;
  subject: string;
  snippet: string;
  is_read: number;
  is_flagged: number;
  has_attachments: number;
};

type HeaderRow = MessageRow & { to_json: string; cc_json: string; uid: number | null };

type DraftRow = {
  id: string;
  account_id: string;
  kind: ComposeKind;
  source_message_id: string | null;
  message_id: string;
  in_reply_to: string | null;
  refs_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  doc_json: string;
  import_json: string | null;
  revision: number;
  server_state: DraftServerCopyState;
  server_folder: string | null;
  server_uidvalidity: number | null;
  server_uid: number | null;
  server_revision: number | null;
  server_size: number | null;
  origin: DraftOrigin;
  proposal_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProposalRow = {
  id: string;
  thread_id: string;
  draft_id: string | null;
  account_id: string;
  kind: ComposeKind;
  source_message_id: string | null;
  added_json: string;
  content_sha256: string;
  left_out: number;
  view_token_sha256: string | null;
  viewed_at: string | null;
  state: ProposalState;
  outbox_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type TranslationRow = {
  message_id: string;
  target_language: string;
  source_sha256: string;
  provider_id: string;
  model: string;
  text: string;
  truncated: number;
  created_at: string;
};

type OutboxRow = {
  id: string;
  account_id: string;
  draft_id: string | null;
  message_id: string;
  subject: string;
  envelope_from: string;
  envelope_to_json: string;
  state: OutboxState;
  send_after: string;
  attempts: number;
  error_kind: SendErrorKind | null;
  rejected_json: string;
  origin: DraftOrigin;
  created_at: string;
  updated_at: string;
};

type ComposeAttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  content_id: string | null;
  data: Buffer;
};

/** Outbox columns without the blobs. */
const OUTBOX_COLUMNS = `id, account_id, draft_id, message_id, subject, envelope_from, envelope_to_json,
  state, send_after, attempts, error_kind, rejected_json, origin, created_at, updated_at`;

/** Distinct rows read for recipient suggestions, newest first. */
const SUGGESTION_SCAN = 5000;

type ThreadRow = {
  id: string;
  account_id: string;
  subject: string;
  last_date: string | null;
  message_count: number;
  unread_count: number;
  participants_json: string;
  snippet: string;
};

/** A thread row with whether a message of it in the listed folder is flagged. */
type ListedThreadRow = ThreadRow & { flagged: number };

type AttachmentRow = {
  message_id: string;
  part_id: string;
  filename: string | null;
  mime_type: string;
  size: number;
  is_inline: number;
};

const SUMMARY_COLUMNS = `m.id, m.account_id, m.folder, m.thread_id, m.date, m.from_name, m.from_address,
  m.subject, m.snippet, m.is_read, m.is_flagged, m.has_attachments`;

/** Refusals after which a queued move is cancelled. */
const MOVE_MAX_FAILURES = 3;

/** True for a row (alias m) in an Inbox folder of its account. */
const IN_INBOX = `(upper(m.folder) = 'INBOX' OR m.folder IN (
  SELECT f.path FROM folders f WHERE f.account_id = m.account_id AND f.special_use = 'inbox'))`;

/** True for a row (alias m) in the account's All Mail folder. */
const IN_ALL_MAIL = `(m.folder IN (
  SELECT f.path FROM folders f WHERE f.account_id = m.account_id AND f.special_use = 'all'))`;

/**
 * The effective special use of a row (alias m) joined with its folder
 * (alias f, LEFT JOIN): the saved special use, else Inbox for INBOX
 * (store-rules effectiveSpecialUse).
 */
const ROW_ROLE = `CASE WHEN f.special_use IS NOT NULL THEN f.special_use
  WHEN upper(m.folder) = 'INBOX' THEN 'inbox' END`;

/** Messages (alias m) with their folder row (alias f). */
const MESSAGES_WITH_FOLDER = `messages m LEFT JOIN folders f
  ON f.account_id = m.account_id AND f.path = m.folder`;

/** Oldest first; an undated message sorts after every dated one. */
const OLDEST_FIRST = "date IS NULL, date, id";

function newMessageId(): string {
  return `m_${randomBytes(8).toString("hex")}`;
}

/** ISO 8601 in UTC, so text order is time order; null when unparseable. */
function normalizeDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** An ISO time as stored: normalized to UTC so text order is time order. */
function isoOf(raw: string): string {
  return normalizeDate(raw) ?? raw;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The whole text as one FTS5 phrase, so operators and quotes are literal. */
function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function encodeCursor(lastDate: string | null, id: string): string {
  return Buffer.from(`${lastDate ?? ""}|${id}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): { lastDate: string | null; id: string } | null {
  const raw = Buffer.from(cursor, "base64").toString("utf8");
  const bar = raw.indexOf("|");
  if (bar < 0) return null;
  const lastDate = raw.slice(0, bar);
  return { lastDate: lastDate === "" ? null : lastDate, id: raw.slice(bar + 1) };
}

function toAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    preset: row.preset,
    host: row.host,
    port: row.port,
    username: row.username,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    authFailed: row.auth_failed === 1,
    passwordSealed: row.password_sealed,
    smtp:
      row.smtp_host !== null && row.smtp_port !== null && row.smtp_security !== null
        ? {
            host: row.smtp_host,
            port: row.smtp_port,
            security: row.smtp_security,
            username: row.smtp_username,
          }
        : null,
    sentCopy: row.sent_copy ?? "append",
  };
}

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    sourceMessageId: row.source_message_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.refs_json) as string[],
    to: JSON.parse(row.to_json) as MailAddress[],
    cc: JSON.parse(row.cc_json) as MailAddress[],
    bcc: JSON.parse(row.bcc_json) as MailAddress[],
    subject: row.subject,
    doc: JSON.parse(row.doc_json) as ComposeDoc,
    importHtml:
      row.import_json === null ? null : (JSON.parse(row.import_json) as DraftRecord["importHtml"]),
    serverCopy:
      row.server_folder !== null &&
      row.server_uidvalidity !== null &&
      row.server_uid !== null &&
      row.server_revision !== null &&
      row.server_size !== null
        ? {
            folder: row.server_folder,
            uidValidity: row.server_uidvalidity,
            uid: row.server_uid,
            revision: row.server_revision,
            size: row.server_size,
          }
        : null,
    origin: row.origin,
    proposalId: row.proposal_id,
    createdAt: row.created_at,
    revision: row.revision,
    serverState: row.server_state,
    updatedAt: row.updated_at,
  };
}

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    accountId: row.account_id,
    kind: row.kind,
    sourceMessageId: row.source_message_id,
    added: JSON.parse(row.added_json) as string[],
    contentSha256: row.content_sha256,
    leftOut: row.left_out,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    state: row.state,
    viewTokenSha256: row.view_token_sha256,
    viewedAt: row.viewed_at,
    outboxId: row.outbox_id,
    updatedAt: row.updated_at,
  };
}

function toTranslation(row: TranslationRow): TranslationRecord {
  return {
    messageId: row.message_id,
    targetLanguage: row.target_language,
    providerId: row.provider_id,
    model: row.model,
    text: row.text,
    truncated: row.truncated === 1,
    sourceSha256: row.source_sha256,
    createdAt: row.created_at,
  };
}

function toOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    draftId: row.draft_id,
    messageId: row.message_id,
    subject: row.subject,
    envelopeFrom: row.envelope_from,
    envelopeTo: JSON.parse(row.envelope_to_json) as string[],
    sendAfter: row.send_after,
    origin: row.origin,
    createdAt: row.created_at,
    state: row.state,
    attempts: row.attempts,
    errorKind: row.error_kind,
    rejected: JSON.parse(row.rejected_json) as string[],
    updatedAt: row.updated_at,
  };
}

function newAttachmentId(): string {
  return `att_${randomBytes(8).toString("hex")}`;
}

function bytesOf(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    folder: row.folder,
    threadId: row.thread_id,
    date: row.date,
    from: { name: row.from_name, address: row.from_address },
    subject: row.subject,
    snippet: row.snippet,
    isRead: row.is_read === 1,
    isFlagged: row.is_flagged === 1,
    hasAttachments: row.has_attachments === 1,
  };
}

/** `flagged` covers the thread's messages in the viewed folder. */
function toThread(row: ThreadRow, flagged: boolean): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    lastDate: row.last_date,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    participants: JSON.parse(row.participants_json) as MailAddress[],
    snippet: row.snippet,
    flagged,
  };
}

function toAttachment(row: AttachmentRow): AttachmentMeta {
  return {
    partId: row.part_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    isInline: row.is_inline === 1,
  };
}

export function createSqliteStore(db: Database.Database): MailStore {
  /** Runs fn atomically; nests as a savepoint inside a caller's transaction. */
  const atomic = <T>(fn: () => T): T => db.transaction(fn)();
  // SQLite's LIKE folds ASCII case only; this folds Cyrillic and the rest.
  db.function("mail_lower", { deterministic: true }, (value: unknown) =>
    value === null || value === undefined ? null : String(value).toLowerCase(),
  );
  const accountById = db.prepare<[string], AccountRow>("SELECT * FROM accounts WHERE id = ?");

  const findAttached = db.prepare<[string, string, number], { id: string }>(
    "SELECT id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?",
  );
  const findDetached = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM messages
     WHERE account_id = ? AND folder = ? AND uid IS NULL AND message_id = ?
     ORDER BY seq LIMIT 1`,
  );
  const findDetachedByGmail = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM messages
     WHERE account_id = ? AND folder = ? AND uid IS NULL AND gm_msgid = ?
     ORDER BY seq LIMIT 1`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, account_id, folder, uid, message_id, in_reply_to, refs, thread_id,
       from_name, from_address, to_json, cc_json, subject, date, snippet, body_text, body_html,
       html_truncated, is_read, is_flagged, has_attachments, size, gm_thrid, gm_msgid, dedup_key,
       reply_to_json)
     VALUES (@id, @accountId, @folder, @uid, @messageId, @inReplyTo, @refs, @threadId,
       @fromName, @fromAddress, @toJson, @ccJson, @subject, @date, @snippet, @bodyText, @bodyHtml,
       @htmlTruncated, @seen, @flagged, @hasAttachments, @size, @gmThreadId, @gmMsgId, @dedupKey,
       @replyToJson)`,
  );
  const updateMessage = db.prepare(
    `UPDATE messages SET uid = @uid, message_id = @messageId, in_reply_to = @inReplyTo,
       refs = @refs, from_name = @fromName, from_address = @fromAddress, to_json = @toJson,
       cc_json = @ccJson, reply_to_json = @replyToJson, subject = @subject, date = @date, snippet = @snippet,
       body_text = @bodyText, body_html = @bodyHtml, html_truncated = @htmlTruncated,
       is_read = COALESCE(seen_desired, @seen), is_flagged = COALESCE(flag_desired, @flagged),
       has_attachments = @hasAttachments, size = @size, gm_thrid = @gmThreadId,
       gm_msgid = COALESCE(@gmMsgId, gm_msgid),
       dedup_key = CASE
         WHEN COALESCE(@gmMsgId, gm_msgid) IS NOT NULL THEN 'gm:' || COALESCE(@gmMsgId, gm_msgid)
         WHEN @messageId IS NOT NULL THEN 'mid:' || @messageId || ':' || @size
         ELSE 'id:' || id END
     WHERE id = @id`,
  );
  const deleteInlinePartsOf = db.prepare("DELETE FROM inline_parts WHERE message_id = ?");
  const insertInlinePart = db.prepare(
    "INSERT OR IGNORE INTO inline_parts (message_id, content_id, mime_type, data) VALUES (?, ?, ?, ?)",
  );
  const deleteAttachmentsOf = db.prepare("DELETE FROM attachments WHERE message_id = ?");
  const insertAttachment = db.prepare(
    `INSERT OR REPLACE INTO attachments (message_id, part_id, filename, mime_type, size, content_id, is_inline)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  const attachmentsOf = db.prepare<[string], AttachmentRow>(
    "SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid",
  );
  const threadById = db.prepare<[string], ThreadRow>("SELECT * FROM threads WHERE id = ?");
  const draftByServerCopy = db.prepare<[string, string, number], { id: string }>(
    `SELECT id FROM compose_drafts WHERE account_id = ? AND server_folder = ? AND server_uid = ?
     ORDER BY created_at, id LIMIT 1`,
  );
  const draftContinuing = db.prepare<[string], { id: string }>(
    `SELECT id FROM compose_drafts WHERE kind = 'new' AND source_message_id = ?
     ORDER BY created_at, id LIMIT 1`,
  );
  const draftById = db.prepare<[string], DraftRow>("SELECT * FROM compose_drafts WHERE id = ?");
  const outboxById = db.prepare<[string], OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`);
  /** The oldest due queued row of an account not busy (with onlyId, that row only), or null. */
  const dueOutboxId = (now: string, busyAccounts: string[], onlyId?: string): string | null => {
    const due = db
      .prepare<[{ now: string; busy: string; only: string | null }], { id: string }>(
        `SELECT id FROM outbox
         WHERE state = 'queued' AND send_after <= @now
           AND account_id NOT IN (SELECT value FROM json_each(@busy))
           AND (@only IS NULL OR id = @only)
         ORDER BY send_after, created_at, id LIMIT 1`,
      )
      .get({ now, busy: JSON.stringify(busyAccounts), only: onlyId ?? null });
    return due ? due.id : null;
  };
  const draftHeld = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM outbox WHERE draft_id = ? LIMIT 1",
  );
  const deleteDraftRows = (id: string) => {
    db.prepare("DELETE FROM compose_attachments WHERE draft_id = ?").run(id);
    db.prepare("DELETE FROM compose_drafts WHERE id = ?").run(id);
  };
  const proposalById = db.prepare<[string], ProposalRow>("SELECT * FROM agent_proposals WHERE id = ?");
  /** Deletes the proposal's draft only while it is still hidden (an opened one is the owner's), then clears draft_id. */
  const dropHiddenDraft = (id: string) => {
    const row = proposalById.get(id);
    if (!row || row.draft_id === null) return;
    const draft = db
      .prepare<[string], { proposal_id: string | null }>("SELECT proposal_id FROM compose_drafts WHERE id = ?")
      .get(row.draft_id);
    if (draft !== undefined && draft.proposal_id !== id) return;
    if (draft !== undefined) deleteDraftRows(row.draft_id);
    db.prepare("UPDATE agent_proposals SET draft_id = NULL WHERE id = ?").run(id);
  };
  const threadIdOf = db.prepare<[string], { thread_id: string }>(
    "SELECT thread_id FROM messages WHERE id = ?",
  );

  /**
   * Recomputes thread rows from messages: every thread of the account when
   * threadIds is null, else only the given threads.
   */
  function refreshThreads(accountId: string, threadIds: Iterable<string> | null): void {
    const ids = threadIds === null ? null : [...new Set(threadIds)];
    if (ids !== null && ids.length === 0) return;
    if (ids === null) {
      db.prepare("DELETE FROM threads WHERE account_id = ?").run(accountId);
    } else {
      const remove = db.prepare("DELETE FROM threads WHERE id = ?");
      for (const id of ids) remove.run(id);
    }
    type Member = {
      thread_id: string;
      subject: string;
      date: string | null;
      from_name: string | null;
      from_address: string;
      snippet: string;
      is_read: number;
      dedup_key: string;
    };
    const members =
      ids === null
        ? db
            .prepare<[string], Member>(
              `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read, dedup_key
               FROM messages WHERE account_id = ? ORDER BY thread_id, ${OLDEST_FIRST}`,
            )
            .all(accountId)
        : ids.flatMap((id) =>
            db
              .prepare<[string, string], Member>(
                `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read, dedup_key
                 FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ${OLDEST_FIRST}`,
              )
              .all(accountId, id),
          );
    const groups = new Map<string, Member[]>();
    for (const member of members) {
      const group = groups.get(member.thread_id);
      if (group) group.push(member);
      else groups.set(member.thread_id, [member]);
    }
    const insert = db.prepare(
      `INSERT INTO threads (id, account_id, subject, last_date, message_count, unread_count,
         participants_json, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [threadId, group] of groups) {
      const latest = group[group.length - 1]!;
      const dated = group.filter((m) => m.date !== null);
      const lastDate = dated.length > 0 ? dated[dated.length - 1]!.date : null;
      const participants: MailAddress[] = [];
      for (const m of group) {
        if (!participants.some((p) => p.address === m.from_address)) {
          participants.push({ name: m.from_name, address: m.from_address });
        }
      }
      insert.run(
        threadId,
        accountId,
        group[0]!.subject,
        lastDate,
        new Set(group.map((m) => m.dedup_key)).size,
        new Set(group.filter((m) => m.is_read === 0).map((m) => m.dedup_key)).size,
        JSON.stringify(participants),
        latest.snippet,
      );
    }
  }

  /** Deletes the given rows with their attachment metadata and inline parts; returns their thread ids. */
  function deleteRows(rows: { id: string; thread_id: string }[]): Set<string> {
    const remove = db.prepare("DELETE FROM messages WHERE id = ?");
    const removeTranslations = db.prepare("DELETE FROM translations WHERE message_id = ?");
    for (const row of rows) {
      deleteAttachmentsOf.run(row.id);
      deleteInlinePartsOf.run(row.id);
      removeTranslations.run(row.id);
      remove.run(row.id);
    }
    return new Set(rows.map((r) => r.thread_id));
  }

  function header(row: HeaderRow): MessageHeader {
    return {
      ...toSummary(row),
      to: JSON.parse(row.to_json) as MailAddress[],
      cc: JSON.parse(row.cc_json) as MailAddress[],
      attachments: attachmentsOf.all(row.id).map(toAttachment),
      draftId: row.uid === null ? null : (draftByServerCopy.get(row.account_id, row.folder, row.uid)?.id ?? null),
    };
  }

  /**
   * One page of thread rows matching `where`, newest first by
   * (last_date DESC, id DESC) with undated threads last; `flagged` is an SQL
   * boolean over `threads`. The cursor is the last row's (last_date, id).
   */
  function pageThreads(query: {
    where: string;
    flagged: string;
    params: Record<string, string>;
    cursor: string | null;
    limit: number;
  }): { threads: ThreadSummary[]; nextCursor: string | null } {
    const after = query.cursor === null ? null : decodeCursor(query.cursor);
    const columns = `threads.*, ${query.flagged} AS flagged`;
    const params = { ...query.params, limit: query.limit + 1 };
    let rows: ListedThreadRow[];
    if (after === null) {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads WHERE ${query.where}
           ORDER BY last_date DESC, id DESC LIMIT @limit`,
        )
        .all(params);
    } else if (after.lastDate === null) {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads WHERE last_date IS NULL AND id < @afterId AND ${query.where}
           ORDER BY id DESC LIMIT @limit`,
        )
        .all({ ...params, afterId: after.id });
    } else {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads
           WHERE (last_date < @afterDate OR (last_date = @afterDate AND id < @afterId) OR last_date IS NULL)
             AND ${query.where}
           ORDER BY last_date DESC, id DESC LIMIT @limit`,
        )
        .all({ ...params, afterDate: after.lastDate, afterId: after.id });
    }
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      threads: page.map((row) => toThread(row, row.flagged === 1)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.last_date, last.id) : null,
    };
  }

  const store: MailStore = {
    transaction<T>(fn: () => T): T {
      return atomic(fn);
    },

    // Accounts -------------------------------------------------------------

    listAccounts() {
      return db
        .prepare<[], AccountRow>("SELECT * FROM accounts ORDER BY created_at, id")
        .all()
        .map(toAccount);
    },

    getAccount(id) {
      const row = accountById.get(id);
      return row ? toAccount(row) : null;
    },

    findAccountByEmail(email) {
      const row = db
        .prepare<[string], AccountRow>(
          "SELECT * FROM accounts WHERE lower(email) = lower(?) ORDER BY created_at, id LIMIT 1",
        )
        .get(email);
      return row ? toAccount(row) : null;
    },

    saveAccount(account) {
      // An upsert, never INSERT OR REPLACE: replacing would delete the row
      // and cascade to every message of the account.
      db.prepare(
        `INSERT INTO accounts (id, email, display_name, host, port, username, password_sealed,
           preset, created_at, last_sync_at, last_error, auth_failed,
           smtp_host, smtp_port, smtp_security, smtp_username, sent_copy)
         VALUES (@id, @email, @displayName, @host, @port, @username, @passwordSealed,
           @preset, @createdAt, @lastSyncAt, @lastError, @authFailed,
           @smtpHost, @smtpPort, @smtpSecurity, @smtpUsername, @sentCopy)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email,
           display_name = excluded.display_name, host = excluded.host, port = excluded.port,
           username = excluded.username, password_sealed = excluded.password_sealed,
           preset = excluded.preset, created_at = excluded.created_at,
           last_sync_at = excluded.last_sync_at, last_error = excluded.last_error,
           auth_failed = excluded.auth_failed, smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security,
           smtp_username = excluded.smtp_username, sent_copy = excluded.sent_copy`,
      ).run({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        host: account.host,
        port: account.port,
        username: account.username,
        passwordSealed: account.passwordSealed,
        preset: account.preset,
        createdAt: account.createdAt,
        lastSyncAt: account.lastSyncAt,
        lastError: account.lastError,
        authFailed: account.authFailed ? 1 : 0,
        smtpHost: account.smtp?.host ?? null,
        smtpPort: account.smtp?.port ?? null,
        smtpSecurity: account.smtp?.security ?? null,
        smtpUsername: account.smtp?.username ?? null,
        sentCopy: account.sentCopy,
      });
    },

    recordSyncResult(id, result) {
      db.prepare(
        "UPDATE accounts SET last_sync_at = ?, last_error = ?, auth_failed = ? WHERE id = ?",
      ).run(result.lastSyncAt, result.lastError, result.authFailed ? 1 : 0, id);
    },

    deleteAccount(id) {
      // Explicit deletes, so the cascade holds even with foreign keys off.
      atomic(() => {
        db.prepare(
          "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare(
          "DELETE FROM inline_parts WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM folders WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM image_senders WHERE account_id = ?").run(id);
        db.prepare(
          "DELETE FROM translations WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM messages WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM threads WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM sync_state WHERE account_id = ?").run(id);
        db.prepare(
          "DELETE FROM compose_attachments WHERE draft_id IN (SELECT id FROM compose_drafts WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM compose_drafts WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM outbox WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM agent_proposals WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      });
    },

    // Sync state -----------------------------------------------------------

    getSyncState(accountId, folder) {
      const row = db
        .prepare<
          [string, string],
          { uid_validity: number; last_uid: number; synced_since: string }
        >("SELECT uid_validity, last_uid, synced_since FROM sync_state WHERE account_id = ? AND folder = ?")
        .get(accountId, folder);
      return row
        ? { uidValidity: row.uid_validity, lastUid: row.last_uid, syncedSince: row.synced_since }
        : null;
    },

    saveSyncState(accountId, folder, state: SyncState) {
      db.prepare(
        `INSERT INTO sync_state (account_id, folder, uid_validity, last_uid, synced_since)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, folder) DO UPDATE SET uid_validity = excluded.uid_validity,
           last_uid = excluded.last_uid, synced_since = excluded.synced_since`,
      ).run(accountId, folder, state.uidValidity, state.lastUid, state.syncedSince);
    },

    beginFolderReset(accountId, folder) {
      db.prepare("UPDATE messages SET uid = NULL WHERE account_id = ? AND folder = ?").run(
        accountId,
        folder,
      );
    },

    finishFolderReset(accountId, folder) {
      return atomic(() => {
        const rows = db
          .prepare<[string, string], { id: string; thread_id: string }>(
            "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ? AND uid IS NULL",
          )
          .all(accountId, folder);
        if (rows.length === 0) return 0;
        refreshThreads(accountId, deleteRows(rows));
        return rows.length;
      });
    },

    // Messages -------------------------------------------------------------

    upsertMessages(accountId, folder, messages: FetchedMessage[]) {
      return atomic(() => {
        const touched = new Set<string>();
        for (const message of messages) {
          const html = message.bodyHtml;
          const params = {
            accountId,
            folder,
            uid: message.uid,
            messageId: message.messageId,
            inReplyTo: message.inReplyTo,
            refs: JSON.stringify(message.references),
            fromName: message.from.name,
            fromAddress: message.from.address,
            toJson: JSON.stringify(message.to),
            ccJson: JSON.stringify(message.cc),
            // NULL: not known (a row from before Reply-To was kept, or a fetch without it).
            replyToJson: message.replyTo === undefined ? null : JSON.stringify(message.replyTo),
            subject: message.subject,
            date: normalizeDate(message.date),
            snippet: snippetOf(message.bodyText, message.bodyHtml),
            bodyText: message.bodyText,
            bodyHtml: html !== null && html.length > HTML_CAP ? null : html,
            htmlTruncated: html !== null && html.length > HTML_CAP ? 1 : 0,
            seen: message.seen ? 1 : 0,
            flagged: message.flagged ? 1 : 0,
            hasAttachments: message.attachments.some((a) => !a.isInline) ? 1 : 0,
            size: message.size,
            gmThreadId: message.gmThreadId,
            gmMsgId: message.gmMsgId,
          };
          // A detached row (folder reset, or a move without a uid map) is
          // reattached by Gmail id first, then by Message-ID.
          const existing =
            findAttached.get(accountId, folder, message.uid) ??
            (message.gmMsgId === null
              ? undefined
              : findDetachedByGmail.get(accountId, folder, message.gmMsgId)) ??
            (message.messageId === null
              ? undefined
              : findDetached.get(accountId, folder, message.messageId));
          let id: string;
          if (existing) {
            id = existing.id;
            updateMessage.run({ ...params, id });
          } else {
            id = newMessageId();
            insertMessage.run({
              ...params,
              id,
              threadId: `t_${id}`,
              dedupKey: dedupKeyOf(message.gmMsgId, message.messageId, message.size, id),
            });
          }
          deleteAttachmentsOf.run(id);
          for (const a of message.attachments) {
            insertAttachment.run(id, a.partId, a.filename, a.mimeType, a.size, a.isInline ? 1 : 0);
          }
          deleteInlinePartsOf.run(id);
          for (const part of capInlineParts(message.inlineParts)) {
            insertInlinePart.run(id, part.contentId, part.mimeType, Buffer.from(part.data));
          }
          touched.add(threadIdOf.get(id)!.thread_id);
        }
        refreshThreads(accountId, touched);
      });
    },

    localFolderIndex(accountId, folder, sinceIso) {
      const since = normalizeDate(sinceIso) ?? sinceIso;
      return db
        .prepare<[string, string, string], { uid: number; id: string }>(
          `SELECT uid, id FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND (date IS NULL OR date >= ?)
           ORDER BY uid`,
        )
        .all(accountId, folder, since);
    },

    applyFlags(accountId, folder, flags) {
      return atomic(() => {
        const update = db.prepare<
          [{ seen: number; flagged: number; accountId: string; folder: string; uid: number }],
          { thread_id: string }
        >(
          `UPDATE messages
           SET is_read = COALESCE(seen_desired, @seen), is_flagged = COALESCE(flag_desired, @flagged)
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid
             AND (is_read != COALESCE(seen_desired, @seen) OR is_flagged != COALESCE(flag_desired, @flagged))
           RETURNING thread_id`,
        );
        const backfill = db.prepare<
          [{ gmMsgId: string; accountId: string; folder: string; uid: number }],
          { thread_id: string }
        >(
          `UPDATE messages SET gm_msgid = @gmMsgId, dedup_key = 'gm:' || @gmMsgId
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid
             AND (gm_msgid IS NULL OR gm_msgid != @gmMsgId OR dedup_key != 'gm:' || @gmMsgId)
           RETURNING thread_id`,
        );
        const touched = new Set<string>();
        let changed = 0;
        for (const flag of flags) {
          // Uids are unique per folder, so a row comes back only when that one message changed.
          const key = { accountId, folder, uid: flag.uid };
          const row = update.get({ ...key, seen: flag.seen ? 1 : 0, flagged: flag.flagged ? 1 : 0 });
          // A new Gmail id can merge copies, so it counts as a change too.
          const merged =
            flag.gmMsgId === undefined || flag.gmMsgId === null
              ? undefined
              : backfill.get({ ...key, gmMsgId: flag.gmMsgId });
          if (row || merged) {
            changed++;
            touched.add((row ?? merged)!.thread_id);
          }
        }
        refreshThreads(accountId, touched);
        return changed;
      });
    },

    deleteByUids(accountId, folder, uids) {
      return atomic(() => {
        const find = db.prepare<[string, string, number], { id: string; thread_id: string }>(
          "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?",
        );
        const rows = uids.flatMap((uid) => {
          const row = find.get(accountId, folder, uid);
          return row ? [row] : [];
        });
        if (rows.length === 0) return 0;
        refreshThreads(accountId, deleteRows(rows));
        return rows.length;
      });
    },

    setDesired(messageIds, change) {
      return atomic(() => {
        const find = db.prepare<[string], { account_id: string; dedup_key: string }>(
          "SELECT account_id, dedup_key FROM messages WHERE id = ?",
        );
        const seen = change.seen === undefined ? null : change.seen ? 1 : 0;
        const flagged = change.flagged === undefined ? null : change.flagged ? 1 : 0;
        // Attached copies get the value to push (overwriting an opposite
        // one); other detached copies drop a pending value of a changed field
        // that differs from the request, so a stale intent cannot win when
        // they are reattached (NULL != x is not true, so NULL stays NULL).
        const update = db.prepare<
          [{ accountId: string; dedupKey: string; seen: number | null; flagged: number | null }],
          { thread_id: string }
        >(
          `UPDATE messages SET
             is_read = COALESCE(@seen, is_read),
             is_flagged = COALESCE(@flagged, is_flagged),
             seen_desired = CASE WHEN @seen IS NULL THEN seen_desired
               WHEN uid IS NOT NULL THEN @seen
               WHEN seen_desired != @seen THEN NULL ELSE seen_desired END,
             flag_desired = CASE WHEN @flagged IS NULL THEN flag_desired
               WHEN uid IS NOT NULL THEN @flagged
               WHEN flag_desired != @flagged THEN NULL ELSE flag_desired END
           WHERE account_id = @accountId AND dedup_key = @dedupKey
           RETURNING thread_id`,
        );
        // A named row keeps its intent even when detached: pushed after reattach.
        const named = db.prepare(
          `UPDATE messages SET seen_desired = COALESCE(@seen, seen_desired),
             flag_desired = COALESCE(@flagged, flag_desired)
           WHERE id = @id`,
        );
        const accounts: string[] = [];
        const done = new Set<string>();
        const touched = new Map<string, Set<string>>();
        for (const id of messageIds) {
          const row = find.get(id);
          if (!row) continue;
          if (!accounts.includes(row.account_id)) accounts.push(row.account_id);
          const key = `${row.account_id}\u0000${row.dedup_key}`;
          if (!done.has(key)) {
            done.add(key);
            const threads = touched.get(row.account_id) ?? new Set<string>();
            for (const copy of update.all({ accountId: row.account_id, dedupKey: row.dedup_key, seen, flagged })) {
              threads.add(copy.thread_id);
            }
            touched.set(row.account_id, threads);
          }
          named.run({ id, seen, flagged });
        }
        for (const [accountId, threadIds] of touched) refreshThreads(accountId, threadIds);
        return accounts.map((accountId) => ({ accountId }));
      });
    },

    pendingFlagIntents(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number; seen_desired: number | null; flag_desired: number | null }>(
          `SELECT uid, seen_desired, flag_desired FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL
             AND (seen_desired IS NOT NULL OR flag_desired IS NOT NULL)
           ORDER BY uid`,
        )
        .all(accountId, folder)
        .map((r) => ({
          uid: r.uid,
          seen: r.seen_desired === null ? null : r.seen_desired === 1,
          flagged: r.flag_desired === null ? null : r.flag_desired === 1,
        }));
    },

    clearFlagIntents(accountId, folder, pushed) {
      return atomic(() => {
        const clear = db.prepare(
          `UPDATE messages SET
             seen_desired = CASE WHEN seen_desired = @seen THEN NULL ELSE seen_desired END,
             flag_desired = CASE WHEN flag_desired = @flagged THEN NULL ELSE flag_desired END
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid`,
        );
        const bit = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
        // A null in `pushed` compares false in SQL, so that field is left alone.
        for (const intent of pushed) {
          clear.run({ accountId, folder, uid: intent.uid, seen: bit(intent.seen), flagged: bit(intent.flagged) });
        }
      });
    },

    markOpened(messageId) {
      return atomic(() => {
        const row = db
          .prepare<[string], { account_id: string; dedup_key: string }>(
            "SELECT account_id, dedup_key FROM messages WHERE id = ?",
          )
          .get(messageId);
        if (!row) return null;
        // Every unread copy is read: attached ones and the opened row itself
        // (even detached: pushed after reattach) get a read to push; other
        // detached copies are read locally only and drop a stale pending unread.
        const copies = db
          .prepare<[{ accountId: string; dedupKey: string; id: string }], { thread_id: string }>(
            `UPDATE messages SET is_read = 1,
               seen_desired = CASE WHEN uid IS NOT NULL OR id = @id THEN 1 ELSE NULL END
             WHERE account_id = @accountId AND dedup_key = @dedupKey AND is_read = 0
             RETURNING thread_id`,
          )
          .all({ accountId: row.account_id, dedupKey: row.dedup_key, id: messageId });
        refreshThreads(row.account_id, copies.map((c) => c.thread_id));
        return { accountId: row.account_id };
      });
    },

    // Threads --------------------------------------------------------------

    threadingInputs(accountId): ThreadingInput[] {
      return db
        .prepare<
          [string],
          {
            id: string;
            message_id: string | null;
            in_reply_to: string | null;
            refs: string;
            subject: string;
            date: string | null;
            gm_thrid: string | null;
          }
        >(
          `SELECT id, message_id, in_reply_to, refs, subject, date, gm_thrid
           FROM messages WHERE account_id = ? ORDER BY seq`,
        )
        .all(accountId)
        .map((r) => ({
          id: r.id,
          messageId: r.message_id,
          inReplyTo: r.in_reply_to,
          references: JSON.parse(r.refs) as string[],
          subject: r.subject,
          date: r.date,
          gmThreadId: r.gm_thrid,
        }));
    },

    assignThreads(accountId, threadOf) {
      return atomic(() => {
        const ids = db
          .prepare<[string], { id: string }>("SELECT id FROM messages WHERE account_id = ?")
          .all(accountId);
        const update = db.prepare("UPDATE messages SET thread_id = ? WHERE id = ? AND thread_id != ?");
        for (const { id } of ids) {
          const threadId = threadOf.get(id) ?? `t_${id}`;
          update.run(threadId, id, threadId);
        }
        refreshThreads(accountId, null);
      });
    },

    listThreads(accountId, folder, cursor, limit) {
      // Whole (account-wide) threads with a row in the folder that is not
      // waiting to move out. An uncorrelated IN list is built once from the
      // (account_id, folder, move_pending) index, so the cost stays linear.
      return pageThreads({
        where: `account_id = @accountId AND threads.id IN (SELECT m.thread_id FROM messages m
          WHERE m.account_id = @accountId AND m.folder = @folder AND m.move_pending IS NULL)`,
        flagged: `EXISTS (SELECT 1 FROM messages f
          WHERE f.thread_id = threads.id AND f.account_id = @accountId AND f.folder = @folder
            AND f.move_pending IS NULL AND f.is_flagged = 1)`,
        params: { accountId, folder },
        cursor,
        limit,
      });
    },

    listThreadsAll(role, cursor, limit) {
      // Gmail's All Mail is never merged (server refuses the role too).
      if (role === "all") return { threads: [], nextCursor: null };
      // Thread ids are globally unique (threads.id is the primary key), so the
      // membership list needs no account match. The unary + keeps SQLite from
      // driving the query by the id autoindex: it scans threads_last_date in
      // (last_date DESC, id DESC) order without a temp B-tree.
      return pageThreads({
        where: `+threads.id IN (SELECT m.thread_id FROM ${MESSAGES_WITH_FOLDER}
          WHERE m.move_pending IS NULL AND ${ROW_ROLE} = @role)`,
        flagged: `EXISTS (SELECT 1 FROM ${MESSAGES_WITH_FOLDER}
          WHERE m.thread_id = threads.id AND m.move_pending IS NULL AND m.is_flagged = 1
            AND ${ROW_ROLE} = @role)`,
        params: { role },
        cursor,
        limit,
      });
    },

    listRoles() {
      const rows = db
        .prepare<[], { role: SpecialUse; total: number; unread: number }>(
          `SELECT role, count(DISTINCT account_id || char(31) || dedup_key) AS total,
             count(DISTINCT CASE WHEN is_read = 0 THEN account_id || char(31) || dedup_key END) AS unread
           FROM (SELECT m.account_id, m.dedup_key, m.is_read, ${ROW_ROLE} AS role
                 FROM ${MESSAGES_WITH_FOLDER} WHERE m.move_pending IS NULL)
           WHERE role IS NOT NULL GROUP BY role`,
        )
        .all();
      const byRole = new Map(rows.map((r) => [r.role, r]));
      return UNIFIED_ROLES.map(
        (role): RoleCount => ({
          role,
          unreadCount: byRole.get(role)?.unread ?? 0,
          totalCount: byRole.get(role)?.total ?? 0,
        }),
      );
    },

    rawRef(messageId): RawRef | null {
      const row = db
        .prepare<
          [string],
          {
            account_id: string;
            folder: string;
            uid: number | null;
            size: number;
            message_id: string | null;
            move_pending: string | null;
            uid_validity: number | null;
          }
        >(
          `SELECT m.account_id, m.folder, m.uid, m.size, m.message_id, m.move_pending, s.uid_validity
           FROM messages m LEFT JOIN sync_state s ON s.account_id = m.account_id AND s.folder = m.folder
           WHERE m.id = ?`,
        )
        .get(messageId);
      if (!row || row.uid === null || row.move_pending !== null) return null;
      return {
        accountId: row.account_id,
        folder: row.folder,
        uid: row.uid,
        size: row.size,
        messageId: row.message_id,
        uidValidity: row.uid_validity,
      };
    },

    /**
     * Each message once: of the rows sharing a dedup key, prefer the copy in
     * the viewed folder unless it is waiting to move, then a copy not waiting
     * to move, the Inbox copy, a copy outside All Mail, the most recently
     * stored row.
     */
    getThread(threadId, folder): ThreadDetail | null {
      const thread = threadById.get(threadId);
      if (!thread) return null;
      const messages = db
        .prepare<[{ threadId: string; folder: string }], HeaderRow>(
          `SELECT * FROM (
             SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json, m.uid,
               row_number() OVER (PARTITION BY m.dedup_key
                 ORDER BY (m.folder = @folder AND m.move_pending IS NULL) DESC,
                   m.move_pending IS NULL DESC, ${IN_INBOX} DESC, ${IN_ALL_MAIL} ASC,
                   m.seq DESC) AS rn
             FROM messages m WHERE m.thread_id = @threadId)
           WHERE rn = 1 ORDER BY date IS NULL, date, id`,
        )
        .all({ threadId, folder })
        .map(header);
      const flagged =
        db
          .prepare<[{ threadId: string; folder: string }], { one: number }>(
            `SELECT 1 AS one FROM messages WHERE thread_id = @threadId AND folder = @folder
               AND move_pending IS NULL AND is_flagged = 1 LIMIT 1`,
          )
          .get({ threadId, folder }) !== undefined;
      return { thread: toThread(thread, flagged), messages };
    },

    getMessage(messageId) {
      const row = db
        .prepare<[string], HeaderRow>(
          `SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json, m.uid FROM messages m WHERE m.id = ?`,
        )
        .get(messageId);
      return row ? header(row) : null;
    },

    getBody(messageId): MessageBody | null {
      const row = db
        .prepare<
          [string],
          {
            id: string;
            body_text: string | null;
            body_html: string | null;
            html_truncated: number;
            images_allowed: number;
          }
        >(
          `SELECT m.id, m.body_text, m.body_html, m.html_truncated,
             EXISTS (SELECT 1 FROM image_senders i
               WHERE i.account_id = m.account_id AND i.address = mail_lower(m.from_address)) AS images_allowed
           FROM messages m WHERE m.id = ?`,
        )
        .get(messageId);
      return row
        ? {
            messageId: row.id,
            text: row.body_text,
            html: row.body_html,
            htmlTruncated: row.html_truncated === 1,
            remoteImagesAllowed: row.images_allowed === 1,
          }
        : null;
    },

    search(query: ParsedQuery, accountId, limit) {
      const where: string[] = [];
      const params: unknown[] = [];
      let from = "FROM messages m";

      // Control characters make MATCH throw and never occur in indexed text.
      const text = query.text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (Array.from(text).length >= FTS_MIN_CHARS) {
        from = "FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid";
        where.push("messages_fts MATCH ?");
        params.push(ftsPhrase(text));
      } else if (text !== "") {
        const pattern = likePattern(text);
        where.push(
          "(mail_lower(m.subject) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_name) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_address) LIKE mail_lower(?) ESCAPE '\\')",
        );
        params.push(pattern, pattern, pattern);
      }
      if (accountId !== null) {
        where.push("m.account_id = ?");
        params.push(accountId);
      }
      if (query.from) {
        const pattern = likePattern(query.from);
        where.push(
          "(mail_lower(m.from_address) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_name) LIKE mail_lower(?) ESCAPE '\\')",
        );
        params.push(pattern, pattern);
      }
      if (query.subject) {
        where.push("mail_lower(m.subject) LIKE mail_lower(?) ESCAPE '\\'");
        params.push(likePattern(query.subject));
      }
      if (query.unread !== undefined) {
        where.push(query.unread ? "m.is_read = 0" : "m.is_read = 1");
      }
      const after = normalizeDate(query.after);
      if (after !== null) {
        where.push("m.date >= ?");
        params.push(after);
      }
      const before = normalizeDate(query.before);
      if (before !== null) {
        where.push("m.date < ?");
        params.push(before);
      }
      // A row waiting to move out is hidden until the move completes.
      where.push("m.move_pending IS NULL");
      params.push(limit);

      // One hit per message (dedup key): the Inbox copy, else the newest row.
      const sql = `SELECT * FROM (
          SELECT ${SUMMARY_COLUMNS},
            row_number() OVER (PARTITION BY m.account_id, m.dedup_key
              ORDER BY ${IN_INBOX} DESC, m.seq DESC) AS rn
          ${from}
          WHERE ${where.join(" AND ")})
        WHERE rn = 1
        ORDER BY date IS NULL DESC, date DESC, id DESC
        LIMIT ?`;
      return (db.prepare(sql).all(...params) as MessageRow[]).map(toSummary);
    },

    repairSnippets() {
      const scan = db.prepare<[number, number], { seq: number; snippet: string }>(
        "SELECT seq, snippet FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
      );
      const load = db.prepare<
        [number],
        {
          account_id: string;
          thread_id: string;
          snippet: string;
          body_text: string | null;
          body_html: string | null;
        }
      >("SELECT account_id, thread_id, snippet, body_text, body_html FROM messages WHERE seq = ?");
      const update = db.prepare("UPDATE messages SET snippet = ? WHERE seq = ?");
      let after = 0;
      let repaired = 0;
      for (;;) {
        const page = scan.all(after, SNIPPET_REPAIR_BATCH);
        if (page.length === 0) break;
        after = page[page.length - 1]!.seq;
        const stale = page.filter((row) => needsSnippetRepair(row.snippet));
        if (stale.length === 0) continue;
        repaired += atomic(() => {
          const touched = new Map<string, Set<string>>();
          let changed = 0;
          for (const { seq } of stale) {
            const row = load.get(seq);
            if (!row) continue;
            const next =
              row.body_text === null && row.body_html === null
                ? cleanSnippet(row.snippet)
                : snippetOf(row.body_text, row.body_html);
            if (next === row.snippet) continue;
            update.run(next, seq);
            changed++;
            const threads = touched.get(row.account_id) ?? new Set<string>();
            threads.add(row.thread_id);
            touched.set(row.account_id, threads);
          }
          for (const [accountId, threadIds] of touched) refreshThreads(accountId, threadIds);
          return changed;
        });
      }
      return repaired;
    },

    unreadCount(accountId) {
      const unread = `SELECT DISTINCT m.account_id, m.dedup_key FROM messages m
        WHERE m.is_read = 0 AND m.move_pending IS NULL AND ${IN_INBOX}`;
      const row =
        accountId === null
          ? db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM (${unread})`).get()
          : db
              .prepare<[string], { n: number }>(
                `SELECT count(*) AS n FROM (${unread} AND m.account_id = ?)`,
              )
              .get(accountId);
      return row?.n ?? 0;
    },

    // Folders ----------------------------------------------------------------

    saveFolders(accountId, folders: RemoteFolder[]) {
      return atomic(() => {
        const listed = new Set(folders.map((f) => f.path));
        const upsert = db.prepare(
          `INSERT INTO folders (account_id, path, name, delimiter, special_use, selectable)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name,
             delimiter = excluded.delimiter, special_use = excluded.special_use,
             selectable = excluded.selectable`,
        );
        for (const f of folders) {
          upsert.run(accountId, f.path, f.name, f.delimiter, f.specialUse, f.selectable ? 1 : 0);
        }
        const removed = db
          .prepare<[string], { path: string }>(
            "SELECT path FROM folders WHERE account_id = ? ORDER BY path",
          )
          .all(accountId)
          .map((r) => r.path)
          .filter((path) => !listed.has(path));
        const touched = new Set<string>();
        for (const path of removed) {
          const rows = db
            .prepare<[string, string], { id: string; thread_id: string }>(
              "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ?",
            )
            .all(accountId, path);
          for (const threadId of deleteRows(rows)) touched.add(threadId);
          db.prepare("DELETE FROM sync_state WHERE account_id = ? AND folder = ?").run(accountId, path);
          db.prepare("DELETE FROM folders WHERE account_id = ? AND path = ?").run(accountId, path);
        }
        refreshThreads(accountId, touched);
        return { removed };
      });
    },

    listFolders(accountId): Folder[] {
      const rows = db
        .prepare<
          [string, string],
          {
            path: string;
            name: string;
            special_use: SpecialUse | null;
            selectable: number;
            total: number | null;
            unread: number | null;
          }
        >(
          `SELECT f.path, f.name, f.special_use, f.selectable, c.total, c.unread
           FROM folders f LEFT JOIN (
             SELECT folder, count(DISTINCT dedup_key) AS total,
               count(DISTINCT CASE WHEN is_read = 0 THEN dedup_key END) AS unread
             FROM messages WHERE account_id = ? AND move_pending IS NULL GROUP BY folder
           ) c ON c.folder = f.path
           WHERE f.account_id = ?`,
        )
        .all(accountId, accountId);
      return rows
        .map((r) => ({
          accountId,
          path: r.path,
          name: r.name,
          specialUse: effectiveSpecialUse(r.path, r.special_use),
          selectable: r.selectable === 1,
          unreadCount: r.unread ?? 0,
          totalCount: r.total ?? 0,
        }))
        .sort(compareFolders);
    },

    // Moves ------------------------------------------------------------------

    pendingMoves(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number; id: string; destination: string }>(
          `SELECT uid, id, move_pending AS destination FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND move_pending IS NOT NULL
           ORDER BY uid`,
        )
        .all(accountId, folder);
    },

    queueMove(messageIds, destination) {
      return atomic(() => {
        const ids = [...new Set(messageIds)];
        if (ids.length === 0) return null;
        const find = db.prepare<
          [string],
          { id: string; account_id: string; folder: string; move_pending: string | null }
        >("SELECT id, account_id, folder, move_pending FROM messages WHERE id = ?");
        const rows = ids.map((id) => find.get(id));
        const first = rows[0];
        if (!first) return null;
        const valid = rows.every(
          (r) =>
            r !== undefined &&
            r.account_id === first.account_id &&
            r.folder === first.folder &&
            r.move_pending === null,
        );
        if (!valid || first.folder === destination) return null;
        const queue = db.prepare(
          "UPDATE messages SET move_pending = ?, move_failures = 0 WHERE id = ?",
        );
        for (const id of ids) queue.run(destination, id);
        return { accountId: first.account_id, folder: first.folder };
      });
    },

    completeMove(accountId, folder, destination, moved, uids) {
      return atomic(() => {
        const find = db.prepare<
          [string, string, number, string],
          { id: string; thread_id: string; dedup_key: string }
        >(
          `SELECT id, thread_id, dedup_key FROM messages
           WHERE account_id = ? AND folder = ? AND uid = ? AND move_pending = ?`,
        );
        type Occupant = {
          id: string;
          thread_id: string;
          uid: number;
          seen_desired: number | null;
          flag_desired: number | null;
          move_pending: string | null;
        };
        const atUid = db.prepare<[string, string, number], Occupant>(
          `SELECT id, thread_id, uid, seen_desired, flag_desired, move_pending FROM messages
           WHERE account_id = ? AND folder = ? AND uid = ?`,
        );
        const sameMessage = db.prepare<[string, string, string, string], Occupant>(
          `SELECT id, thread_id, uid, seen_desired, flag_desired, move_pending FROM messages
           WHERE account_id = ? AND folder = ? AND dedup_key = ? AND uid IS NOT NULL
             AND move_pending IS NULL AND id != ?
           ORDER BY seq LIMIT 1`,
        );
        // Desired values: the moved row's own wins, else the occupant's
        // (non-NULL wins); local flags follow the resulting desired values.
        const rehome = db.prepare<
          [{ destination: string; uid: number | null; carriedSeen: number | null; carriedFlag: number | null; id: string }]
        >(
          `UPDATE messages SET folder = @destination, uid = @uid, move_pending = NULL,
             move_failures = 0,
             seen_desired = COALESCE(seen_desired, @carriedSeen),
             flag_desired = COALESCE(flag_desired, @carriedFlag),
             is_read = COALESCE(seen_desired, @carriedSeen, is_read),
             is_flagged = COALESCE(flag_desired, @carriedFlag, is_flagged)
           WHERE id = @id`,
        );
        const nothing = { carriedSeen: null, carriedFlag: null };
        const settle = db.prepare(
          "UPDATE messages SET move_pending = NULL, move_failures = 0 WHERE id = ?",
        );
        const touched = new Set<string>();
        /**
         * The destination already holds this message (synced before the move
         * completed): the moved row keeps its id and takes that copy's uid,
         * carrying its pending desired values. An occupant that is itself waiting to move
         * is left alone and the moved row is detached instead.
         */
        const takeOver = (row: { id: string }, occupant: Occupant | undefined, uid: number | null) => {
          if (occupant === undefined || occupant.id === row.id) {
            rehome.run({ destination, uid, ...nothing, id: row.id });
          } else if (occupant.move_pending !== null) {
            rehome.run({ destination, uid: null, ...nothing, id: row.id });
          } else {
            for (const threadId of deleteRows([occupant])) touched.add(threadId);
            rehome.run({
              destination,
              uid: occupant.uid,
              carriedSeen: occupant.seen_desired,
              carriedFlag: occupant.flag_desired,
              id: row.id,
            });
          }
        };
        for (const uid of uids) {
          const row = find.get(accountId, folder, uid, destination);
          if (!row) continue;
          touched.add(row.thread_id);
          if (moved === null) {
            // No uid map: merge into a destination copy of the same message
            // when there is one, else wait detached for the folder's sync.
            const copy = row.dedup_key.startsWith("id:")
              ? undefined
              : sameMessage.get(accountId, destination, row.dedup_key, row.id);
            takeOver(row, copy, null);
            continue;
          }
          const newUid = moved.get(uid);
          if (newUid === undefined) {
            // Gone from the source already: done; reconcile removes the row.
            settle.run(row.id);
            continue;
          }
          takeOver(row, atUid.get(accountId, destination, newUid), newUid);
        }
        refreshThreads(accountId, touched);
      });
    },

    failMove(accountId, folder, uids) {
      return atomic(() => {
        const bump = db.prepare<[string, string, number], { id: string; move_failures: number }>(
          `UPDATE messages SET move_failures = move_failures + 1
           WHERE account_id = ? AND folder = ? AND uid = ? AND move_pending IS NOT NULL
           RETURNING id, move_failures`,
        );
        const cancel = db.prepare(
          "UPDATE messages SET move_pending = NULL, move_failures = 0 WHERE id = ?",
        );
        const cancelled: string[] = [];
        for (const uid of uids) {
          const row = bump.get(accountId, folder, uid);
          if (row && row.move_failures >= MOVE_MAX_FAILURES) {
            cancel.run(row.id);
            cancelled.push(row.id);
          }
        }
        return { cancelled };
      });
    },

    // Images -----------------------------------------------------------------

    inlineParts(messageId): InlinePart[] {
      return db
        .prepare<[string], { content_id: string; mime_type: string; data: Buffer }>(
          "SELECT content_id, mime_type, data FROM inline_parts WHERE message_id = ? ORDER BY rowid",
        )
        .all(messageId)
        .map((r) => ({
          contentId: r.content_id,
          mimeType: r.mime_type,
          data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength),
        }));
    },

    isImageSenderAllowed(accountId, address) {
      return (
        db
          .prepare("SELECT 1 FROM image_senders WHERE account_id = ? AND address = ?")
          .get(accountId, address.toLowerCase()) !== undefined
      );
    },

    allowImageSender(accountId, address) {
      db.prepare(
        "INSERT OR IGNORE INTO image_senders (account_id, address, created_at) VALUES (?, ?, ?)",
      ).run(accountId, address.toLowerCase(), new Date().toISOString());
    },

    disallowImageSender(accountId, address) {
      return (
        db
          .prepare("DELETE FROM image_senders WHERE account_id = ? AND address = ?")
          .run(accountId, address.toLowerCase()).changes > 0
      );
    },

    // Compose and send (slice 3b) --------------------------------------------

    createDraft(input) {
      // One INSERT with origin and proposal_id: a hidden draft is never visible as an ordinary one.
      const copy = input.serverCopy;
      db.prepare(
        `INSERT INTO compose_drafts (id, account_id, kind, source_message_id, message_id, in_reply_to,
           refs_json, to_json, cc_json, bcc_json, subject, doc_json, import_json, revision, server_state,
           server_folder, server_uidvalidity, server_uid, server_revision, server_size, origin,
           proposal_id, created_at, updated_at)
         VALUES (@id, @accountId, @kind, @sourceMessageId, @messageId, @inReplyTo, @refs, @to, @cc, @bcc,
           @subject, @doc, @importHtml, 1, @serverState, @folder, @uidValidity, @uid, @serverRevision,
           @size, @origin, @proposalId, @createdAt, @createdAt)`,
      ).run({
        id: input.id,
        accountId: input.accountId,
        kind: input.kind,
        sourceMessageId: input.sourceMessageId,
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        refs: JSON.stringify(input.references),
        to: JSON.stringify(input.to),
        cc: JSON.stringify(input.cc),
        bcc: JSON.stringify(input.bcc),
        subject: input.subject,
        doc: JSON.stringify(input.doc),
        importHtml: input.importHtml === null ? null : JSON.stringify(input.importHtml),
        serverState: copy === null ? "none" : "saved",
        folder: copy?.folder ?? null,
        uidValidity: copy?.uidValidity ?? null,
        uid: copy?.uid ?? null,
        serverRevision: copy?.revision ?? null,
        size: copy?.size ?? null,
        origin: input.origin,
        proposalId: input.proposalId,
        createdAt: input.createdAt,
      });
      return toDraft(draftById.get(input.id)!);
    },

    getDraft(id) {
      const row = draftById.get(id);
      return row ? toDraft(row) : null;
    },

    saveDraft(id, baseRevision, fields, updatedAt) {
      return atomic(() => {
        const current = draftById.get(id);
        if (!current) throw new Error("Draft not found");
        const changed = db
          .prepare(
            `UPDATE compose_drafts SET account_id = @accountId, to_json = @to, cc_json = @cc,
               bcc_json = @bcc, subject = @subject, doc_json = @doc, import_json = NULL,
               revision = revision + 1, updated_at = @updatedAt
             WHERE id = @id AND revision = @baseRevision
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = @id)`,
          )
          .run({
            id,
            baseRevision,
            accountId: fields.accountId,
            to: JSON.stringify(fields.to),
            cc: JSON.stringify(fields.cc),
            bcc: JSON.stringify(fields.bcc),
            subject: fields.subject,
            doc: JSON.stringify(fields.doc),
            updatedAt,
          }).changes;
        const revision = draftById.get(id)!.revision;
        return changed === 1 ? { revision } : { conflict: true as const, revision };
      });
    },

    saveImport(id, baseRevision, doc) {
      return atomic(() => {
        const current = draftById.get(id);
        if (!current) throw new Error("Draft not found");
        const changed = db
          .prepare(
            `UPDATE compose_drafts SET doc_json = @doc, import_json = NULL
             WHERE id = @id AND revision = @baseRevision AND import_json IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = @id)`,
          )
          .run({ id, baseRevision, doc: JSON.stringify(doc) }).changes;
        const revision = draftById.get(id)!.revision;
        return changed === 1 ? { revision } : { conflict: true as const, revision };
      });
    },

    deleteDraft(id) {
      atomic(() => deleteDraftRows(id));
    },

    listDrafts(accountId) {
      return db
        .prepare<[string], DraftRow>(
          "SELECT * FROM compose_drafts WHERE account_id = ? ORDER BY created_at, id",
        )
        .all(accountId)
        .map(toDraft);
    },

    draftForServerCopy(accountId, folder, uid) {
      return draftByServerCopy.get(accountId, folder, uid)?.id ?? null;
    },

    draftContinuing(sourceMessageId) {
      return draftContinuing.get(sourceMessageId)?.id ?? null;
    },

    renewMessageId(id, messageId) {
      db.prepare("UPDATE compose_drafts SET message_id = ? WHERE id = ?").run(messageId, id);
    },

    recordServerCopy(id, copy) {
      db.prepare(
        `UPDATE compose_drafts SET server_state = @state, server_folder = @folder,
           server_uidvalidity = @uidValidity, server_uid = @uid, server_revision = @revision,
           server_size = @size
         WHERE id = @id`,
      ).run({
        id,
        state: copy === null ? "none" : "saved",
        folder: copy?.folder ?? null,
        uidValidity: copy?.uidValidity ?? null,
        uid: copy?.uid ?? null,
        revision: copy?.revision ?? null,
        size: copy?.size ?? null,
      });
    },

    setServerCopyState(id, state) {
      db.prepare("UPDATE compose_drafts SET server_state = ? WHERE id = ?").run(state, id);
    },

    addAttachment(draftId, input): ComposeAttachment {
      return atomic(() => {
        if (!draftById.get(draftId)) throw new Error("Draft not found");
        const id = newAttachmentId();
        db.prepare(
          `INSERT INTO compose_attachments (id, draft_id, file_name, mime_type, size, sha256, content_id,
             data, position)
           VALUES (@id, @draftId, @fileName, @mimeType, @size, @sha256, @contentId, @data,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM compose_attachments WHERE draft_id = @draftId))`,
        ).run({
          id,
          draftId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: input.size,
          sha256: input.sha256,
          contentId: input.contentId ?? null,
          data: Buffer.from(input.data),
        });
        return { id, fileName: input.fileName, mimeType: input.mimeType, size: input.size };
      });
    },

    listAttachments(draftId) {
      return db
        .prepare<[string], { id: string; file_name: string; mime_type: string; size: number }>(
          `SELECT id, file_name, mime_type, size FROM compose_attachments WHERE draft_id = ?
           ORDER BY position`,
        )
        .all(draftId)
        .map((row) => ({ id: row.id, fileName: row.file_name, mimeType: row.mime_type, size: row.size }));
    },

    attachmentData(draftId) {
      return db
        .prepare<[string], ComposeAttachmentRow>(
          `SELECT id, file_name, mime_type, size, sha256, content_id, data FROM compose_attachments
           WHERE draft_id = ? ORDER BY position`,
        )
        .all(draftId)
        .map((row) => ({
          id: row.id,
          fileName: row.file_name,
          mimeType: row.mime_type,
          size: row.size,
          sha256: row.sha256,
          contentId: row.content_id,
          data: bytesOf(row.data),
        }));
    },

    removeAttachment(draftId, attachmentId) {
      return (
        db
          .prepare("DELETE FROM compose_attachments WHERE draft_id = ? AND id = ?")
          .run(draftId, attachmentId).changes > 0
      );
    },

    queueOutbox(input, draftBaseRevision) {
      return atomic(() => {
        const existing = outboxById.get(input.id);
        if (existing) return { row: toOutbox(existing), created: false };
        if (input.draftId !== null) {
          const draft = draftById.get(input.draftId);
          if (!draft || draft.revision !== draftBaseRevision || draftHeld.get(input.draftId)) {
            return { conflict: true as const };
          }
        }
        db.prepare(
          `INSERT INTO outbox (id, account_id, draft_id, message_id, subject, envelope_from,
             envelope_to_json, mime, bcc_header, state, send_after, attempts, error_kind, rejected_json,
             origin, created_at, updated_at)
           VALUES (@id, @accountId, @draftId, @messageId, @subject, @envelopeFrom, @envelopeTo, @mime,
             @bccHeader, 'queued', @sendAfter, 0, NULL, '[]', @origin, @createdAt, @createdAt)`,
        ).run({
          id: input.id,
          accountId: input.accountId,
          draftId: input.draftId,
          messageId: input.messageId,
          subject: input.subject,
          envelopeFrom: input.envelopeFrom,
          envelopeTo: JSON.stringify(input.envelopeTo),
          mime: Buffer.from(input.mime),
          bccHeader: input.bccHeader,
          sendAfter: isoOf(input.sendAfter),
          origin: input.origin,
          createdAt: isoOf(input.createdAt),
        });
        return { row: toOutbox(outboxById.get(input.id)!), created: true };
      });
    },

    getOutbox(id) {
      const row = outboxById.get(id);
      return row ? toOutbox(row) : null;
    },

    listOutbox(accountId) {
      const rows =
        accountId === null
          ? db.prepare<[], OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM outbox ORDER BY created_at, id`).all()
          : db
              .prepare<[string], OutboxRow>(
                `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE account_id = ? ORDER BY created_at, id`,
              )
              .all(accountId);
      return rows.map(toOutbox);
    },

    outboxPayload(id) {
      const row = db
        .prepare<[string], { mime: Buffer; bcc_header: string | null }>(
          "SELECT mime, bcc_header FROM outbox WHERE id = ?",
        )
        .get(id);
      return row ? { mime: bytesOf(row.mime), bccHeader: row.bcc_header } : null;
    },

    transitionOutbox(id, from, to, patch = {}) {
      const sets = ["state = @to"];
      const params: Record<string, unknown> = { id, to, from: JSON.stringify(from) };
      if (patch.errorKind !== undefined) {
        sets.push("error_kind = @errorKind");
        params.errorKind = patch.errorKind;
      }
      if (patch.rejected !== undefined) {
        sets.push("rejected_json = @rejected");
        params.rejected = JSON.stringify(patch.rejected);
      }
      if (patch.sendAfter !== undefined) {
        sets.push("send_after = @sendAfter");
        params.sendAfter = isoOf(patch.sendAfter);
      }
      if (patch.countAttempt) sets.push("attempts = attempts + 1");
      if (patch.updatedAt !== undefined) {
        sets.push("updated_at = @updatedAt");
        params.updatedAt = isoOf(patch.updatedAt);
      }
      return (
        db
          .prepare(
            `UPDATE outbox SET ${sets.join(", ")}
             WHERE id = @id AND state IN (SELECT value FROM json_each(@from))`,
          )
          .run(params).changes === 1
      );
    },

    deleteOutbox(id, from) {
      return (
        db
          .prepare("DELETE FROM outbox WHERE id = ? AND state IN (SELECT value FROM json_each(?))")
          .run(id, JSON.stringify(from)).changes === 1
      );
    },

    nextDueOutbox(nowIso, busyAccounts) {
      const due = dueOutboxId(isoOf(nowIso), busyAccounts);
      return due === null ? null : toOutbox(outboxById.get(due)!);
    },

    claimDueOutbox(nowIso, busyAccounts, onlyId) {
      return atomic(() => {
        const now = isoOf(nowIso);
        const id = dueOutboxId(now, busyAccounts, onlyId);
        if (id === null) return null;
        const due = { id };
        const changed = db
          .prepare(
            `UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(now, due.id).changes;
        return changed === 1 ? toOutbox(outboxById.get(due.id)!) : null;
      });
    },

    recoverOutboxOnStart(nowIso) {
      return atomic(() => {
        const now = isoOf(nowIso);
        const unknown = db
          .prepare(
            `UPDATE outbox SET state = 'unknown', error_kind = 'unknown_after_data', updated_at = ?
             WHERE state = 'sending'`,
          )
          .run(now).changes;
        const held = db
          .prepare(
            "UPDATE outbox SET state = 'held', updated_at = ? WHERE state = 'queued' AND send_after <= ?",
          )
          .run(now, now).changes;
        db.prepare("UPDATE outbox SET state = 'sent', updated_at = ? WHERE state = 'appending'").run(now);
        return { unknown, held };
      });
    },

    completeOutbox(id) {
      atomic(() => {
        const row = outboxById.get(id);
        if (!row) return;
        db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
        if (row.draft_id !== null) deleteDraftRows(row.draft_id);
      });
      // The host creates the database with incremental auto_vacuum; give the
      // MIME and attachment pages back (a no-op otherwise, and skipped inside
      // a caller's transaction).
      if (!db.inTransaction) db.exec("PRAGMA incremental_vacuum");
    },

    hasSendingOutbox(accountId) {
      return (
        db
          .prepare<[string], { one: number }>(
            `SELECT 1 AS one FROM outbox WHERE account_id = ? AND state IN ('sending', 'appending') LIMIT 1`,
          )
          .get(accountId) !== undefined
      );
    },

    replySource(messageId) {
      const row = db
        .prepare<
          [string],
          {
            account_id: string;
            folder: string;
            from_name: string | null;
            from_address: string;
            to_json: string;
            cc_json: string;
            reply_to_json: string | null;
            subject: string;
            date: string | null;
            message_id: string | null;
            in_reply_to: string | null;
            refs: string | null;
          }
        >(
          `SELECT account_id, folder, from_name, from_address, to_json, cc_json, reply_to_json, subject,
             date, message_id, in_reply_to, refs FROM messages WHERE id = ?`,
        )
        .get(messageId);
      if (!row) return null;
      return {
        accountId: row.account_id,
        folder: row.folder,
        from: { name: row.from_name, address: row.from_address },
        to: JSON.parse(row.to_json) as MailAddress[],
        cc: JSON.parse(row.cc_json) as MailAddress[],
        replyTo: row.reply_to_json === null ? [] : (JSON.parse(row.reply_to_json) as MailAddress[]),
        replyToKnown: row.reply_to_json !== null,
        subject: row.subject,
        date: row.date,
        messageId: row.message_id,
        inReplyTo: row.in_reply_to,
        references: row.refs === null ? [] : (JSON.parse(row.refs) as string[]),
      };
    },

    recipientSuggestions(prefix, limit) {
      const pattern = likePattern(prefix.trim().toLowerCase());
      const rows = db
        .prepare<
          [{ pattern: string; scan: number }],
          {
            from_name: string | null;
            from_address: string;
            to_json: string;
            cc_json: string;
            date: string | null;
            role: string | null;
          }
        >(
          `SELECT m.from_name, m.from_address, m.to_json, m.cc_json, m.date, ${ROW_ROLE} AS role
           FROM ${MESSAGES_WITH_FOLDER}
           WHERE mail_lower(m.from_address) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.from_name) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.to_json) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.cc_json) LIKE @pattern ESCAPE '\\'
           ORDER BY m.date IS NULL, m.date DESC, m.seq DESC LIMIT @scan`,
        )
        .all({ pattern, scan: SUGGESTION_SCAN });
      const entries: SuggestionEntry[] = [];
      for (const row of rows) {
        entries.push({ address: row.from_address, name: row.from_name, date: row.date, ownerSent: false });
        const sent = row.role === "sent";
        for (const a of [
          ...(JSON.parse(row.to_json) as MailAddress[]),
          ...(JSON.parse(row.cc_json) as MailAddress[]),
        ]) {
          entries.push({ address: a.address, name: a.name, date: row.date, ownerSent: sent });
        }
      }
      return rankRecipientSuggestions(entries, prefix, limit);
    },

    // Agent proposals and translation (slice 3c) ------------------------------

    createProposal(input) {
      db.prepare(
        `INSERT INTO agent_proposals (id, thread_id, draft_id, account_id, kind, source_message_id,
           added_json, content_sha256, left_out, view_token_sha256, viewed_at, state, outbox_id,
           expires_at, created_at, updated_at)
         VALUES (@id, @threadId, @draftId, @accountId, @kind, @sourceMessageId, @added, @contentSha256,
           @leftOut, NULL, NULL, 'pending', NULL, @expiresAt, @createdAt, @createdAt)`,
      ).run({
        id: input.id,
        threadId: input.threadId,
        draftId: input.draftId,
        accountId: input.accountId,
        kind: input.kind,
        sourceMessageId: input.sourceMessageId,
        added: JSON.stringify(input.added),
        contentSha256: input.contentSha256,
        leftOut: input.leftOut,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      });
      return toProposal(proposalById.get(input.id)!);
    },

    getProposal(id) {
      const row = proposalById.get(id);
      return row ? toProposal(row) : null;
    },

    proposalCapRows(nowIso) {
      const since = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
      return db
        .prepare<[string], { thread_id: string; state: ProposalState; created_at: string; updated_at: string }>(
          `SELECT thread_id, state, created_at, updated_at FROM agent_proposals
           WHERE state IN ('pending', 'confirming') OR created_at > ?
           ORDER BY created_at, id`,
        )
        .all(since)
        .map((row) => ({ threadId: row.thread_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }));
    },

    transitionProposal(id, from, to, updatedAt, patch = {}) {
      const sets = ["state = @to", "updated_at = @updatedAt"];
      if (patch.outboxId !== undefined) sets.push("outbox_id = @outboxId");
      if (patch.viewTokenSha256 !== undefined) sets.push("view_token_sha256 = @viewTokenSha256");
      if (patch.viewedAt !== undefined) sets.push("viewed_at = @viewedAt");
      return (
        db
          .prepare(
            `UPDATE agent_proposals SET ${sets.join(", ")}
             WHERE id = @id AND state IN (SELECT value FROM json_each(@from))`,
          )
          .run({
            id,
            to,
            updatedAt,
            from: JSON.stringify(from),
            outboxId: patch.outboxId ?? null,
            viewTokenSha256: patch.viewTokenSha256 ?? null,
            viewedAt: patch.viewedAt ?? null,
          }).changes === 1
      );
    },

    setViewToken(id, sha256, viewedAtIso) {
      return (
        db
          .prepare(
            `UPDATE agent_proposals SET view_token_sha256 = ?, viewed_at = ?
             WHERE id = ? AND state = 'pending'`,
          )
          .run(sha256, viewedAtIso, id).changes === 1
      );
    },

    releaseProposalDraft(id, draftId, updatedAt) {
      return atomic(() => {
        const moved = db
          .prepare(
            `UPDATE agent_proposals SET state = 'opened', updated_at = ?
             WHERE id = ? AND draft_id = ? AND state IN ('pending', 'confirming')
               AND EXISTS (SELECT 1 FROM compose_drafts WHERE id = ? AND proposal_id = ?)`,
          )
          .run(updatedAt, id, draftId, draftId, id).changes;
        if (moved !== 1) return false;
        db.prepare("UPDATE compose_drafts SET proposal_id = NULL WHERE id = ? AND proposal_id = ?").run(draftId, id);
        return true;
      });
    },

    undoAgentSend(outboxId, from, updatedAt) {
      return atomic(() => {
        const row = outboxById.get(outboxId);
        if (!row) return { cancelled: false, draftId: null };
        const deleted = db
          .prepare("DELETE FROM outbox WHERE id = ? AND state IN (SELECT value FROM json_each(?))")
          .run(outboxId, JSON.stringify(from)).changes;
        if (deleted !== 1) return { cancelled: false, draftId: row.draft_id };
        if (row.draft_id !== null) {
          db.prepare("UPDATE compose_drafts SET proposal_id = NULL WHERE id = ? AND proposal_id = ?").run(
            row.draft_id,
            outboxId,
          );
        }
        db.prepare(
          "UPDATE agent_proposals SET state = 'opened', updated_at = ? WHERE id = ? AND state = 'queued'",
        ).run(updatedAt, outboxId);
        return { cancelled: true, draftId: row.draft_id };
      });
    },

    dropProposalDraft(id) {
      atomic(() => dropHiddenDraft(id));
    },

    recoverProposalsOnStart(nowIso) {
      return atomic(() => {
        const queued = db
          .prepare(
            `UPDATE agent_proposals SET state = 'queued', outbox_id = id, updated_at = ?
             WHERE state = 'confirming' AND EXISTS (SELECT 1 FROM outbox WHERE outbox.id = agent_proposals.id)`,
          )
          .run(nowIso).changes;
        const doomed = db
          .prepare<[], { id: string }>("SELECT id FROM agent_proposals WHERE state IN ('pending', 'confirming')")
          .all();
        for (const { id } of doomed) {
          db.prepare("UPDATE agent_proposals SET state = 'expired', updated_at = ? WHERE id = ?").run(nowIso, id);
          dropHiddenDraft(id);
        }
        return { expired: doomed.length, queued };
      });
    },

    purgeProposals(beforeIso) {
      return db
        .prepare(
          "DELETE FROM agent_proposals WHERE state NOT IN ('pending', 'confirming') AND updated_at < ?",
        )
        .run(beforeIso).changes;
    },

    addressesSentTo(addresses) {
      const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()));
      const found = new Set<string>();
      if (wanted.size === 0) return found;
      const rows = db
        .prepare<[], { to_json: string; cc_json: string }>(
          `SELECT m.to_json, m.cc_json FROM ${MESSAGES_WITH_FOLDER} WHERE ${ROW_ROLE} = 'sent'`,
        )
        .iterate();
      for (const row of rows) {
        for (const a of [
          ...(JSON.parse(row.to_json) as MailAddress[]),
          ...(JSON.parse(row.cc_json) as MailAddress[]),
        ]) {
          const key = a.address.trim().toLowerCase();
          if (wanted.has(key)) found.add(key);
        }
      }
      return found;
    },

    getTranslation(messageId, targetLanguage) {
      const row = db
        .prepare<[string, string], TranslationRow>(
          "SELECT * FROM translations WHERE message_id = ? AND target_language = ?",
        )
        .get(messageId, targetLanguage);
      return row ? toTranslation(row) : null;
    },

    putTranslation(row) {
      atomic(() => {
        db.prepare(
          `INSERT INTO translations (message_id, target_language, source_sha256, provider_id, model, text,
             truncated, created_at)
           VALUES (@messageId, @targetLanguage, @sourceSha256, @providerId, @model, @text, @truncated, @createdAt)
           ON CONFLICT(message_id, target_language) DO UPDATE SET source_sha256 = excluded.source_sha256,
             provider_id = excluded.provider_id, model = excluded.model, text = excluded.text,
             truncated = excluded.truncated, created_at = excluded.created_at`,
        ).run({ ...row, truncated: row.truncated ? 1 : 0 });
        db.prepare(
          `DELETE FROM translations WHERE rowid IN (
             SELECT rowid FROM translations
             ORDER BY created_at, message_id, target_language
             LIMIT max(0, (SELECT count(*) FROM translations) - ?))`,
        ).run(TRANSLATION_CACHE_ROWS);
      });
    },

    clearTranslations() {
      return db.prepare("DELETE FROM translations").run().changes;
    },
  };
  return store;
}

