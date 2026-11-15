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
import { cleanSnippet, needsSnippetRepair, snippetOf } from "../../core/snippet.ts";
import type { MailStore } from "../../core/ports.ts";
import {
  capInlineParts,
  compareFolders,
  dedupKeyOf,
  effectiveSpecialUse,
  UNIFIED_ROLES,
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

type HeaderRow = MessageRow & { to_json: string; cc_json: string };

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
  };
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
       html_truncated, is_read, is_flagged, has_attachments, size, gm_thrid, gm_msgid, dedup_key)
     VALUES (@id, @accountId, @folder, @uid, @messageId, @inReplyTo, @refs, @threadId,
       @fromName, @fromAddress, @toJson, @ccJson, @subject, @date, @snippet, @bodyText, @bodyHtml,
       @htmlTruncated, @seen, @flagged, @hasAttachments, @size, @gmThreadId, @gmMsgId, @dedupKey)`,
  );
  const updateMessage = db.prepare(
    `UPDATE messages SET uid = @uid, message_id = @messageId, in_reply_to = @inReplyTo,
       refs = @refs, from_name = @fromName, from_address = @fromAddress, to_json = @toJson,
       cc_json = @ccJson, subject = @subject, date = @date, snippet = @snippet,
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
    for (const row of rows) {
      deleteAttachmentsOf.run(row.id);
      deleteInlinePartsOf.run(row.id);
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
           preset, created_at, last_sync_at, last_error, auth_failed)
         VALUES (@id, @email, @displayName, @host, @port, @username, @passwordSealed,
           @preset, @createdAt, @lastSyncAt, @lastError, @authFailed)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email,
           display_name = excluded.display_name, host = excluded.host, port = excluded.port,
           username = excluded.username, password_sealed = excluded.password_sealed,
           preset = excluded.preset, created_at = excluded.created_at,
           last_sync_at = excluded.last_sync_at, last_error = excluded.last_error,
           auth_failed = excluded.auth_failed`,
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
        db.prepare("DELETE FROM messages WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM threads WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM sync_state WHERE account_id = ?").run(id);
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

    // Slice-2 view over seen_desired, until sync switches to pendingFlagIntents.
    pendingSeenUids(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number }>(
          `SELECT uid FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND seen_desired = 1
           ORDER BY uid`,
        )
        .all(accountId, folder)
        .map((r) => r.uid);
    },

    clearSeenPending(accountId, folder, uids) {
      store.clearFlagIntents(
        accountId,
        folder,
        uids.map((uid) => ({ uid, seen: true, flagged: null })),
      );
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
             SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json,
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
          `SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json FROM messages m WHERE m.id = ?`,
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
  };
  return store;
}
