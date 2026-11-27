/**
 * The line review's storage: sessions per working copy and view, comment threads, comments and sends to agents.
 * Ported from diff-review server/store.ts (MIT, gpambrozio; its tables follow diffity's store.rs, MIT); see
 * THIRD_PARTY_NOTICES.md. Changed: a session belongs to a Makosh Git copy (`copy_id`) instead of a BB environment;
 * the AI runs, view states, GitHub mirrors and thread aliases are not ported yet. Migrations are only ever appended.
 */
import { randomBytes } from "node:crypto";
import type { DeliveryState, ReviewComment, ReviewThread, Severity, Side, ThreadStatus } from "../../core/code-review/model.ts";

/** The part of better-sqlite3 the store uses; `bb.storage.database()` gives it, tests give node:sqlite behind it. */
export interface ReviewDb {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): {changes: number | bigint};
  };
  exec(sql: string): void;
  transaction<T>(work: () => T): () => T;
}

export const REVIEW_MIGRATIONS: string[] = [
  `CREATE TABLE review_sessions (
     id TEXT PRIMARY KEY,
     copy_id TEXT NOT NULL,
     target_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (copy_id, target_key)
   )`,
  `CREATE TABLE review_sends (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     bb_thread_id TEXT NOT NULL,
     note TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX review_sends_bb_thread ON review_sends(bb_thread_id)`,
  `CREATE TABLE review_threads (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     file_path TEXT NOT NULL,
     side TEXT CHECK (side IN ('old', 'new')),
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
     severity TEXT CHECK (severity IN ('must-fix', 'suggestion', 'nit', 'question')),
     anchor_content TEXT,
     send_id TEXT REFERENCES review_sends(id),
     delivery TEXT CHECK (delivery IN ('sent', 'answered', 'no_reply')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX review_threads_session ON review_threads(session_id)`,
  `CREATE TABLE review_comments (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
     author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
     author_name TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     edited_at INTEGER
   )`,
  `CREATE INDEX review_comments_thread ON review_comments(thread_id)`,
  // What each send replaced, per comment thread, so a failed send rolls back whatever order overlapping sends settle in.
  `CREATE TABLE review_send_previous (
     send_id TEXT NOT NULL REFERENCES review_sends(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
     previous_send_id TEXT,
     previous_delivery TEXT,
     PRIMARY KEY (send_id, thread_id)
   )`,
  // 0.9.1: AI runs (review-run-store.ts).
  `CREATE TABLE review_runs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('review', 'fix', 'summary', 'explain')),
     bb_thread_id TEXT,
     parent_thread_id TEXT,
     focus TEXT,
     provider_id TEXT NOT NULL,
     model TEXT,
     status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'closed')),
     summary TEXT,
     baseline TEXT,
     changed_files TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE INDEX review_runs_session ON review_runs(session_id)`,
  `CREATE INDEX review_runs_bb_thread ON review_runs(bb_thread_id)`,
  // 0.9.2: Viewed marks, each at the change (`changeRevision`) it was made at.
  `CREATE TABLE review_viewed (
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     revision TEXT NOT NULL,
     marked_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, path)
   )`,
  // What each tab (a thread's, or a copy's in Git) keeps of a view: drafts, folds, scroll (core/code-review/view-state.ts).
  `CREATE TABLE review_view_states (
     scope TEXT NOT NULL,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     saved_at INTEGER NOT NULL,
     state TEXT NOT NULL,
     PRIMARY KEY (scope, session_id)
   )`,
];

export type Session = {id: string; copyId: string; targetKey: string};
export type NewThread = {sessionId: string; filePath: string; side: Side | null; startLine: number; endLine: number;
  severity: Severity | null; anchorContent: string | null; body: string};
type Author = {type: "user" | "agent"; name: string};
type ThreadRow = {id: string; session_id: string; file_path: string; side: Side | null; start_line: number; end_line: number;
  status: ThreadStatus; severity: Severity | null; anchor_content: string | null; send_id: string | null; delivery: DeliveryState | null;
  created_at: number; updated_at: number; bb_thread_id: string | null; sent_at: number | null};
type CommentRow = {id: string; thread_id: string; author_type: "user" | "agent"; author_name: string; body: string; created_at: number; edited_at: number | null};

/** Twelve hex characters: short enough for an agent to type, and found by any unique prefix of four or more. */
export const newId = () => randomBytes(6).toString("hex");

/**
 * Whether the agent in a BB thread may read and answer thread `t` (its last send `s`): the send went to the caller,
 * or the caller carries an open review run of `t`'s session. A caller whose runs are all closed has lost every
 * right, those from sends included. Bind with `callerParams`.
 */
const agentMay = `
  NOT (EXISTS (SELECT 1 FROM review_runs r WHERE r.bb_thread_id = ?)
       AND NOT EXISTS (SELECT 1 FROM review_runs r WHERE r.bb_thread_id = ? AND r.status != 'closed'))
  AND (s.bb_thread_id = ? OR EXISTS (SELECT 1 FROM review_runs r WHERE r.bb_thread_id = ? AND r.kind = 'review'
       AND r.status != 'closed' AND r.session_id = t.session_id))`;
const callerParams = (caller: string) => [caller, caller, caller, caller];

const threadSelect = `
  SELECT t.*, s.bb_thread_id AS bb_thread_id, s.created_at AS sent_at
  FROM review_threads t LEFT JOIN review_sends s ON s.id = t.send_id`;

export class ReviewStore {
  private readonly db: ReviewDb;
  private readonly now: () => number;
  constructor(db: ReviewDb, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec("PRAGMA foreign_keys = ON");
  }

  /** The session for a copy and view, made the first time it is asked for. */
  session(copyId: string, targetKey: string): Session {
    const found = this.db.prepare("SELECT id FROM review_sessions WHERE copy_id = ? AND target_key = ?").get(copyId, targetKey) as {id: string} | undefined;
    if (found) return {id: found.id, copyId, targetKey};
    const id = newId();
    this.db.prepare("INSERT INTO review_sessions (id, copy_id, target_key, created_at) VALUES (?, ?, ?, ?)").run(id, copyId, targetKey, this.now());
    return {id, copyId, targetKey};
  }

  sessionById(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as {id: string; copy_id: string; target_key: string} | undefined;
    return row ? {id: row.id, copyId: row.copy_id, targetKey: row.target_key} : null;
  }

  /** Every thread of a session with its comments, oldest first. */
  threads(sessionId: string): ReviewThread[] {
    return this.withComments(this.db.prepare(threadSelect + " WHERE t.session_id = ? ORDER BY t.created_at, t.rowid").all(sessionId) as ThreadRow[]);
  }

  thread(id: string): ReviewThread | null {
    const row = this.db.prepare(threadSelect + " WHERE t.id = ?").get(id) as ThreadRow | undefined;
    return row ? this.withComments([row])[0] : null;
  }

  /** The threads whose last send went to `bbThreadId`, oldest first. */
  threadsSentTo(bbThreadId: string): ReviewThread[] {
    return this.withComments(this.db.prepare(threadSelect + " WHERE s.bb_thread_id = ? ORDER BY t.created_at, t.rowid").all(bbThreadId) as ThreadRow[]);
  }

  /** The threads the agent in `bbThreadId` may read and answer (`agentMay`), oldest first. */
  agentThreads(bbThreadId: string): ReviewThread[] {
    return this.withComments(this.db.prepare(threadSelect + " WHERE " + agentMay + " ORDER BY t.created_at, t.rowid")
      .all(...callerParams(bbThreadId)) as ThreadRow[]);
  }

  /** Makes a thread with its first comment, the owner's unless `author` says otherwise. */
  createThread(input: NewThread, author: Author = {type: "user", name: "You"}): ReviewThread {
    const id = newId();
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO review_threads (id, session_id, file_path, side, start_line, end_line, severity, anchor_content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.sessionId, input.filePath, input.side, input.startLine, input.endLine, input.severity, input.anchorContent, at, at);
      this.insertComment(id, author, input.body, at);
    })();
    return this.thread(id)!;
  }

  /** Adds the owner's comment to a thread. */
  addComment(threadId: string, body: string): ReviewComment {
    const at = this.now();
    const id = this.db.transaction(() => {
      const commentId = this.insertComment(threadId, {type: "user", name: "You"}, body, at);
      this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(at, threadId);
      return commentId;
    })();
    return this.comment(id)!;
  }

  comment(id: string): (ReviewComment & {threadId: string}) | null {
    const row = this.db.prepare("SELECT * FROM review_comments WHERE id = ?").get(id) as CommentRow | undefined;
    return row ? {...toComment(row), threadId: row.thread_id} : null;
  }

  editComment(id: string, body: string) {
    const row = this.comment(id);
    if (!row) return;
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE review_comments SET body = ?, edited_at = ? WHERE id = ?").run(body, at, id);
      this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(at, row.threadId);
    })();
  }

  /** Deletes a comment, and its thread when it was the thread's last one. */
  deleteComment(id: string) {
    const row = this.comment(id);
    if (!row) return;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM review_comments WHERE id = ?").run(id);
      const left = (this.db.prepare("SELECT count(*) AS n FROM review_comments WHERE thread_id = ?").get(row.threadId) as {n: number}).n;
      if (left === 0) this.db.prepare("DELETE FROM review_threads WHERE id = ?").run(row.threadId);
      else this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(this.now(), row.threadId);
    })();
  }

  setStatus(id: string, status: ThreadStatus) {
    this.db.prepare("UPDATE review_threads SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), id);
  }

  /**
   * Records a send and points each thread at it, keeping what each thread pointed at before so `dropSend` can put it
   * back when the message cannot be delivered.
   */
  recordSend(sessionId: string, bbThreadId: string, threadIds: readonly string[], note: string) {
    const id = newId();
    const createdAt = this.now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO review_sends (id, session_id, bb_thread_id, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, bbThreadId, note, createdAt);
      const read = this.db.prepare("SELECT send_id, delivery FROM review_threads WHERE id = ? AND session_id = ?");
      const keep = this.db.prepare("INSERT INTO review_send_previous (send_id, thread_id, previous_send_id, previous_delivery) VALUES (?, ?, ?, ?)");
      const point = this.db.prepare("UPDATE review_threads SET send_id = ?, delivery = 'sent', updated_at = ? WHERE id = ? AND session_id = ?");
      for (const threadId of new Set(threadIds)) {
        const row = read.get(threadId, sessionId) as {send_id: string | null; delivery: DeliveryState | null} | undefined;
        if (!row) continue;
        keep.run(id, threadId, row.send_id, row.delivery);
        point.run(id, createdAt, threadId, sessionId);
      }
    })();
    return {id, createdAt};
  }

  /**
   * Undoes `recordSend` when the message could not be delivered. A thread still pointing at it goes back to what it
   * pointed at before; when a later send owns the thread, that send's own "before" skips over this one.
   */
  dropSend(sendId: string) {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT thread_id, previous_send_id, previous_delivery FROM review_send_previous WHERE send_id = ?").all(sendId) as
        {thread_id: string; previous_send_id: string | null; previous_delivery: DeliveryState | null}[];
      const restore = this.db.prepare("UPDATE review_threads SET send_id = ?, delivery = ? WHERE id = ? AND send_id = ?");
      const skip = this.db.prepare("UPDATE review_send_previous SET previous_send_id = ?, previous_delivery = ? WHERE thread_id = ? AND previous_send_id = ?");
      for (const row of rows) {
        if (Number(restore.run(row.previous_send_id, row.previous_delivery, row.thread_id, sendId).changes) === 0) {
          skip.run(row.previous_send_id, row.previous_delivery, row.thread_id, sendId);
        }
      }
      this.db.prepare("UPDATE review_threads SET send_id = NULL, delivery = NULL WHERE send_id = ?").run(sendId);
      this.db.prepare("UPDATE review_send_previous SET previous_send_id = NULL, previous_delivery = NULL WHERE previous_send_id = ?").run(sendId);
      this.db.prepare("DELETE FROM review_sends WHERE id = ?").run(sendId);
    })();
  }

  /**
   * An agent's answer in a thread, in one transaction with the check that the thread's last send went to the
   * answering thread: its comment, the new status if any, and the send marked answered when it was there before the
   * agent's turn started (`ackBefore`, or any time when unknown). Null when the thread was not sent there.
   */
  answerAsAgent(input: {threadId: string; callerThreadId: string; ackBefore: number | null; authorName: string; body: string; status: ThreadStatus | null}) {
    const at = this.now();
    return this.db.transaction(() => {
      const may = this.db.prepare("SELECT 1 FROM review_threads t LEFT JOIN review_sends s ON s.id = t.send_id WHERE t.id = ? AND " + agentMay)
        .get(input.threadId, ...callerParams(input.callerThreadId));
      if (may === undefined) return null;
      const commentId = this.insertComment(input.threadId, {type: "agent", name: input.authorName}, input.body, at);
      if (input.status !== null) this.db.prepare("UPDATE review_threads SET status = ? WHERE id = ?").run(input.status, input.threadId);
      this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(at, input.threadId);
      this.db.prepare(`UPDATE review_threads SET delivery = 'answered' WHERE id = ? AND send_id IN
        (SELECT id FROM review_sends WHERE bb_thread_id = ? AND (? IS NULL OR created_at <= ?))`)
        .run(input.threadId, input.callerThreadId, input.ackBefore, input.ackBefore);
      return commentId;
    })();
  }

  /** What `scope`'s tab kept of a session's view, as saved; null when nothing was kept. */
  viewState(scope: string, sessionId: string): string | null {
    return (this.db.prepare("SELECT state FROM review_view_states WHERE scope = ? AND session_id = ?").get(scope, sessionId) as {state: string} | undefined)?.state ?? null;
  }

  /** Keeps a tab's state unless one saved later (by `savedAt`) is there: two windows can flush out of order. */
  saveViewState(scope: string, sessionId: string, savedAt: number, state: string): boolean {
    return Number(this.db.prepare(`INSERT INTO review_view_states (scope, session_id, saved_at, state) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, session_id) DO UPDATE SET saved_at = excluded.saved_at, state = excluded.state WHERE excluded.saved_at >= review_view_states.saved_at`)
      .run(scope, sessionId, savedAt, state).changes) > 0;
  }

  /** Every session that has threads, with its open and total counts, the latest change first (the Reviews page). */
  summaries(limit = 500) {
    return (this.db.prepare(`SELECT s.id, s.copy_id, s.target_key, sum(t.status = 'open') AS open, count(t.id) AS total, max(t.updated_at) AS updated_at
      FROM review_sessions s JOIN review_threads t ON t.session_id = s.id GROUP BY s.id ORDER BY updated_at DESC LIMIT ?`).all(limit) as
      {id: string; copy_id: string; target_key: string; open: number | null; total: number; updated_at: number}[])
      .map(row => ({sessionId: row.id, copyId: row.copy_id, targetKey: row.target_key, open: Number(row.open ?? 0), total: Number(row.total), updatedAt: Number(row.updated_at)}));
  }

  /** Deletes a session with everything of it: threads, comments, sends, runs, marks and kept states. */
  deleteSession(sessionId: string) {
    this.db.transaction(() => {
      // Threads first: they point at sends, which the session's delete takes with it.
      this.db.prepare("DELETE FROM review_threads WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM review_sessions WHERE id = ?").run(sessionId);
    })();
  }

  /** The session's Viewed marks: path to the change revision each was made at. */
  viewed(sessionId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT path, revision FROM review_viewed WHERE session_id = ?").all(sessionId) as {path: string; revision: string}[];
    return new Map(rows.map(row => [row.path, row.revision]));
  }

  /** Marks a file Viewed at `revision`, or clears its mark with null. */
  setViewed(sessionId: string, path: string, revision: string | null) {
    if (revision === null) this.db.prepare("DELETE FROM review_viewed WHERE session_id = ? AND path = ?").run(sessionId, path);
    else this.db.prepare(`INSERT INTO review_viewed (session_id, path, revision, marked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, path) DO UPDATE SET revision = excluded.revision, marked_at = excluded.marked_at`).run(sessionId, path, revision, this.now());
  }

  /** Deletes a session's threads (their comments go with them) and sends; returns how many threads there were. */
  clearSession(sessionId: string): number {
    return this.db.transaction(() => {
      const {count} = this.db.prepare("SELECT count(*) AS count FROM review_threads WHERE session_id = ?").get(sessionId) as {count: number};
      // Threads first: they point at sends.
      this.db.prepare("DELETE FROM review_threads WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM review_sends WHERE session_id = ?").run(sessionId);
      return Number(count);
    })();
  }

  /** The threads sent to `bbThreadId` still waiting for an answer, with when they were sent. */
  waitingOn(bbThreadId: string) {
    return (this.db.prepare(`SELECT t.id, t.session_id, t.send_id, s.created_at AS sent_at FROM review_threads t JOIN review_sends s ON s.id = t.send_id
      WHERE s.bb_thread_id = ? AND t.delivery = 'sent'`).all(bbThreadId) as {id: string; session_id: string; send_id: string; sent_at: number}[])
      .map(row => ({threadId: row.id, sessionId: row.session_id, sendId: row.send_id, sentAt: row.sent_at}));
  }

  /** Marks sends "no reply", each only while its thread still points at that very send and waits. */
  markNoReply<Row extends {threadId: string; sendId: string}>(rows: readonly Row[]): Row[] {
    const mark = this.db.prepare("UPDATE review_threads SET delivery = 'no_reply' WHERE id = ? AND send_id = ? AND delivery = 'sent'");
    return this.db.transaction(() => rows.filter(row => Number(mark.run(row.threadId, row.sendId).changes) > 0))();
  }

  /** Open and total threads of each session of a copy, for its badge. */
  counts(copyId: string) {
    const row = this.db.prepare(`SELECT count(*) AS total, sum(t.status = 'open') AS open FROM review_threads t
      JOIN review_sessions s ON s.id = t.session_id WHERE s.copy_id = ?`).get(copyId) as {total: number; open: number | null};
    return {total: Number(row.total), open: Number(row.open ?? 0)};
  }

  private insertComment(threadId: string, author: Author, body: string, at: number) {
    const id = newId();
    this.db.prepare("INSERT INTO review_comments (id, thread_id, author_type, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, threadId, author.type, author.name, body, at);
    return id;
  }

  private withComments(rows: ThreadRow[]): ReviewThread[] {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const comments = this.db.prepare("SELECT * FROM review_comments WHERE thread_id IN (" + ids.map(() => "?").join(",") + ") ORDER BY created_at, rowid")
      .all(...ids) as CommentRow[];
    const byThread = new Map<string, ReviewComment[]>();
    for (const row of comments) byThread.set(row.thread_id, [...byThread.get(row.thread_id) ?? [], toComment(row)]);
    return rows.map(row => ({
      id: row.id, sessionId: row.session_id, filePath: row.file_path, side: row.side, startLine: row.start_line, endLine: row.end_line,
      status: row.status, severity: row.severity, anchorContent: row.anchor_content, createdAt: row.created_at, updatedAt: row.updated_at,
      comments: byThread.get(row.id) ?? [],
      delivery: row.send_id === null || row.delivery === null || row.bb_thread_id === null || row.sent_at === null ? null
        : {state: row.delivery, sendId: row.send_id, threadId: row.bb_thread_id, sentAt: row.sent_at},
    }));
  }
}

function toComment(row: CommentRow): ReviewComment {
  return {id: row.id, authorType: row.author_type, authorName: row.author_name, body: row.body, createdAt: row.created_at, editedAt: row.edited_at};
}
