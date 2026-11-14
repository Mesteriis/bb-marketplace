// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/db/migrations.ts, src/services/db/search.ts, src/services/search/searchQueryBuilder.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// MailStore on the plugin's own SQLite database (better-sqlite3). Semantics
// match the in-memory store in src/core/testing/fakes.ts:
//   - a pending local read (seen_pending) wins over server flags;
//   - a folder reset detaches uids (uid = NULL) and keeps message ids; a
//     detached row with the same Message-ID is reattached on upsert;
//   - an undated message counts as inside the sync window and sorts as the
//     newest message of its thread, but a thread's last_date is its latest
//     non-null date (null only when every message is undated);
//   - the threads table is derived from messages and rebuilt whenever the
//     rows it summarizes change, so nothing durable is keyed on a thread id.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AttachmentMeta,
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
} from "../../core/model.ts";
import { collapseForSnippet, decodeHtmlEntities } from "../../core/html-entities.ts";
import type { MailStore } from "../../core/ports.ts";

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
];

const HTML_CAP = 1_000_000;
const SNIPPET_LENGTH = 200;
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

type AttachmentRow = {
  message_id: string;
  part_id: string;
  filename: string | null;
  mime_type: string;
  size: number;
  is_inline: number;
};

const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.date, m.from_name, m.from_address,
  m.subject, m.snippet, m.is_read, m.is_flagged, m.has_attachments`;

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

/** Only the start of an HTML body feeds the snippet; this bounds the work. */
const SNIPPET_HTML_SCAN = 20_000;
const SKIPPED_ELEMENTS = new Set(["script", "style", "head"]);

/**
 * Strips tags in one forward pass (untrusted input: no backtracking regex).
 * script/style/head contents are dropped; an unclosed tag or element drops the
 * rest of the input.
 */
function stripTags(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open < 0) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, open) + " ";
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    const name = /^[a-z]+/.exec(lower.slice(open + 1, Math.min(close, open + 9)))?.[0] ?? "";
    pos = close + 1;
    if (SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      if (end < 0) break;
      const endClose = html.indexOf(">", end);
      if (endClose < 0) break;
      pos = endClose + 1;
    }
  }
  return out;
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(stripTags(html.slice(0, SNIPPET_HTML_SCAN)));
}

function snippetOf(message: FetchedMessage): string {
  const source =
    message.bodyText !== null
      ? message.bodyText
      : message.bodyHtml !== null
        ? htmlToText(message.bodyHtml)
        : "";
  return collapseForSnippet(source).slice(0, SNIPPET_LENGTH);
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

function toThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    lastDate: row.last_date,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    participants: JSON.parse(row.participants_json) as MailAddress[],
    snippet: row.snippet,
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
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, account_id, folder, uid, message_id, in_reply_to, refs, thread_id,
       from_name, from_address, to_json, cc_json, subject, date, snippet, body_text, body_html,
       html_truncated, is_read, is_flagged, has_attachments, size, gm_thrid)
     VALUES (@id, @accountId, @folder, @uid, @messageId, @inReplyTo, @refs, @threadId,
       @fromName, @fromAddress, @toJson, @ccJson, @subject, @date, @snippet, @bodyText, @bodyHtml,
       @htmlTruncated, @seen, @flagged, @hasAttachments, @size, @gmThreadId)`,
  );
  const updateMessage = db.prepare(
    `UPDATE messages SET uid = @uid, message_id = @messageId, in_reply_to = @inReplyTo,
       refs = @refs, from_name = @fromName, from_address = @fromAddress, to_json = @toJson,
       cc_json = @ccJson, subject = @subject, date = @date, snippet = @snippet,
       body_text = @bodyText, body_html = @bodyHtml, html_truncated = @htmlTruncated,
       is_read = CASE WHEN seen_pending = 1 THEN 1 ELSE @seen END, is_flagged = @flagged,
       has_attachments = @hasAttachments, size = @size, gm_thrid = @gmThreadId
     WHERE id = @id`,
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
    };
    const members =
      ids === null
        ? db
            .prepare<[string], Member>(
              `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read
               FROM messages WHERE account_id = ? ORDER BY thread_id, ${OLDEST_FIRST}`,
            )
            .all(accountId)
        : ids.flatMap((id) =>
            db
              .prepare<[string, string], Member>(
                `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read
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
        group.length,
        group.filter((m) => m.is_read === 0).length,
        JSON.stringify(participants),
        latest.snippet,
      );
    }
  }

  /** Deletes the given rows with their attachment metadata; returns their thread ids. */
  function deleteRows(rows: { id: string; thread_id: string }[]): Set<string> {
    const remove = db.prepare("DELETE FROM messages WHERE id = ?");
    for (const row of rows) {
      deleteAttachmentsOf.run(row.id);
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
            snippet: snippetOf(message),
            bodyText: message.bodyText,
            bodyHtml: html !== null && html.length > HTML_CAP ? null : html,
            htmlTruncated: html !== null && html.length > HTML_CAP ? 1 : 0,
            seen: message.seen ? 1 : 0,
            flagged: message.flagged ? 1 : 0,
            hasAttachments: message.attachments.some((a) => !a.isInline) ? 1 : 0,
            size: message.size,
            gmThreadId: message.gmThreadId,
          };
          const existing =
            findAttached.get(accountId, folder, message.uid) ??
            (message.messageId === null
              ? undefined
              : findDetached.get(accountId, folder, message.messageId));
          let id: string;
          if (existing) {
            id = existing.id;
            updateMessage.run({ ...params, id });
          } else {
            id = newMessageId();
            insertMessage.run({ ...params, id, threadId: `t_${id}` });
          }
          deleteAttachmentsOf.run(id);
          for (const a of message.attachments) {
            insertAttachment.run(id, a.partId, a.filename, a.mimeType, a.size, a.isInline ? 1 : 0);
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
           SET is_read = CASE WHEN seen_pending = 1 THEN 1 ELSE @seen END, is_flagged = @flagged
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid
             AND (is_read != CASE WHEN seen_pending = 1 THEN 1 ELSE @seen END OR is_flagged != @flagged)
           RETURNING thread_id`,
        );
        const touched = new Set<string>();
        let changed = 0;
        for (const flag of flags) {
          // Uids are unique per folder, so a row comes back only when that one message changed.
          const row = update.get({
            seen: flag.seen ? 1 : 0,
            flagged: flag.flagged ? 1 : 0,
            accountId,
            folder,
            uid: flag.uid,
          });
          if (row) {
            changed++;
            touched.add(row.thread_id);
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

    pendingSeenUids(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number }>(
          `SELECT uid FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND seen_pending = 1
           ORDER BY uid`,
        )
        .all(accountId, folder)
        .map((r) => r.uid);
    },

    clearSeenPending(accountId, folder, uids) {
      return atomic(() => {
        const clear = db.prepare(
          "UPDATE messages SET seen_pending = 0 WHERE account_id = ? AND folder = ? AND uid = ?",
        );
        for (const uid of uids) clear.run(accountId, folder, uid);
      });
    },

    markOpened(messageId) {
      return atomic(() => {
        const row = db
          .prepare<[string], { account_id: string; thread_id: string; is_read: number }>(
            "SELECT account_id, thread_id, is_read FROM messages WHERE id = ?",
          )
          .get(messageId);
        if (!row) return null;
        if (row.is_read === 0) {
          db.prepare("UPDATE messages SET is_read = 1, seen_pending = 1 WHERE id = ?").run(messageId);
          refreshThreads(row.account_id, [row.thread_id]);
        }
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

    listThreads(accountId, cursor, limit) {
      const after = cursor === null ? null : decodeCursor(cursor);
      let rows: ThreadRow[];
      if (after === null) {
        rows = db
          .prepare<[string, number], ThreadRow>(
            "SELECT * FROM threads WHERE account_id = ? ORDER BY last_date DESC, id DESC LIMIT ?",
          )
          .all(accountId, limit + 1);
      } else if (after.lastDate === null) {
        rows = db
          .prepare<[string, string, number], ThreadRow>(
            `SELECT * FROM threads WHERE account_id = ? AND last_date IS NULL AND id < ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(accountId, after.id, limit + 1);
      } else {
        rows = db
          .prepare<
            [{ accountId: string; lastDate: string; id: string; limit: number }],
            ThreadRow
          >(
            `SELECT * FROM threads WHERE account_id = @accountId
               AND (last_date < @lastDate OR (last_date = @lastDate AND id < @id) OR last_date IS NULL)
             ORDER BY last_date DESC, id DESC LIMIT @limit`,
          )
          .all({ accountId, lastDate: after.lastDate, id: after.id, limit: limit + 1 });
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        threads: page.map(toThread),
        nextCursor: rows.length > limit && last ? encodeCursor(last.last_date, last.id) : null,
      };
    },

    getThread(threadId): ThreadDetail | null {
      const thread = threadById.get(threadId);
      if (!thread) return null;
      const messages = db
        .prepare<[string], HeaderRow>(
          `SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json FROM messages m
           WHERE m.thread_id = ? ORDER BY m.date IS NULL, m.date, m.id`,
        )
        .all(threadId)
        .map(header);
      return { thread: toThread(thread), messages };
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
          { id: string; body_text: string | null; body_html: string | null; html_truncated: number }
        >("SELECT id, body_text, body_html, html_truncated FROM messages WHERE id = ?")
        .get(messageId);
      return row
        ? {
            messageId: row.id,
            text: row.body_text,
            html: row.body_html,
            htmlTruncated: row.html_truncated === 1,
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
      params.push(limit);

      const sql = `SELECT ${SUMMARY_COLUMNS} ${from}
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY m.date IS NULL DESC, m.date DESC, m.id DESC
        LIMIT ?`;
      return (db.prepare(sql).all(...params) as MessageRow[]).map(toSummary);
    },

    unreadCount(accountId) {
      const row =
        accountId === null
          ? db.prepare<[], { n: number }>("SELECT count(*) AS n FROM messages WHERE is_read = 0").get()
          : db
              .prepare<[string], { n: number }>(
                "SELECT count(*) AS n FROM messages WHERE is_read = 0 AND account_id = ?",
              )
              .get(accountId);
      return row?.n ?? 0;
    },
  };
  return store;
}
