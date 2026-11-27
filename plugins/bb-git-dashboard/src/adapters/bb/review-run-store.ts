/**
 * The AI runs of the line review, in the review's database (table `review_runs`, migration in review-store.ts).
 * Ported from diff-review server/store.ts (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. Changed: no `mention` kind
 * (@reviewer goes to the view's review run) and summary/explain are kinds of their own rather than a purpose column.
 */
import type { ReviewRun, RunKind, RunStatus } from "../../core/code-review/model.ts";
import { newId, type ReviewDb } from "./review-store.ts";

/** Where a run's sends point before BB has given it a thread; `bind` moves them. */
export const pendingRunThread = (runId: string) => "run:" + runId;

export type NewRun = {sessionId: string; kind: RunKind; focus: string | null; providerId: string; model: string | null;
  parentThreadId: string | null; baseline: string | null;
  /** Set when the run could not start: it is stored failed with this as its summary. */
  failed?: string};
type RunRow = {id: string; session_id: string; kind: RunKind; bb_thread_id: string | null; focus: string | null; provider_id: string;
  model: string | null; status: RunStatus; summary: string | null; changed_files: string | null; created_at: number; finished_at: number | null};

export class RunStore {
  private readonly db: ReviewDb;
  private readonly now: () => number;
  constructor(db: ReviewDb, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  create(input: NewRun): ReviewRun {
    const id = newId();
    const at = this.now();
    const failed = input.failed !== undefined;
    this.db.prepare(`INSERT INTO review_runs (id, session_id, kind, parent_thread_id, focus, provider_id, model, status, summary, baseline, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.sessionId, input.kind, input.parentThreadId, input.focus, input.providerId, input.model,
        failed ? "failed" : "running", input.failed ?? null, input.baseline, at, failed ? at : null);
    return this.run(id)!;
  }

  run(id: string): ReviewRun | null {
    const row = this.db.prepare("SELECT * FROM review_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The copy's fingerprint when the run started, to tell which files it changed. */
  baseline(id: string): string | null {
    return (this.db.prepare("SELECT baseline FROM review_runs WHERE id = ?").get(id) as {baseline: string | null} | undefined)?.baseline ?? null;
  }

  /** The runs of a session not yet closed, newest first. */
  open(sessionId: string): ReviewRun[] {
    return (this.db.prepare("SELECT * FROM review_runs WHERE session_id = ? AND status != 'closed' ORDER BY created_at DESC, rowid DESC")
      .all(sessionId) as RunRow[]).map(toRun);
  }

  /** The runs a BB thread carries that are not closed, newest first. */
  ofThread(bbThreadId: string): ReviewRun[] {
    return (this.db.prepare("SELECT * FROM review_runs WHERE bb_thread_id = ? AND status != 'closed' ORDER BY created_at DESC, rowid DESC")
      .all(bbThreadId) as RunRow[]).map(toRun);
  }

  /** A view's reviewer: its latest review run that has a thread and is not closed. */
  reviewer(sessionId: string): ReviewRun | null {
    const row = this.db.prepare(`SELECT * FROM review_runs WHERE session_id = ? AND kind = 'review' AND status != 'closed' AND bb_thread_id IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /**
   * Binds a running run to the thread BB started for it, once, with the sends recorded for it meanwhile. A run that
   * failed to start or was closed is never bound: a thread BB made after all gets no rights from it.
   */
  bind(id: string, bbThreadId: string): boolean {
    return this.db.transaction(() => {
      const bound = Number(this.db.prepare("UPDATE review_runs SET bb_thread_id = ? WHERE id = ? AND bb_thread_id IS NULL AND status = 'running'").run(bbThreadId, id).changes) > 0;
      if (bound) this.db.prepare("UPDATE review_sends SET bb_thread_id = ? WHERE bb_thread_id = ?").run(bbThreadId, pendingRunThread(id));
      return bound;
    })();
  }

  /** Whether some running run still waits for BB to give it a thread. */
  hasUnbound(): boolean {
    return this.db.prepare("SELECT 1 FROM review_runs WHERE bb_thread_id IS NULL AND status = 'running' LIMIT 1").get() !== undefined;
  }

  /** Whether `bbThreadId` carried runs and all of them are closed: it has lost every right, those from sends included. */
  isClosedRunThread(bbThreadId: string): boolean {
    const row = this.db.prepare("SELECT count(*) AS runs, sum(status != 'closed') AS open FROM review_runs WHERE bb_thread_id = ?")
      .get(bbThreadId) as {runs: number; open: number | null};
    return Number(row.runs) > 0 && Number(row.open ?? 0) === 0;
  }

  /** What a run's start learned after its row was written. */
  prepare(id: string, input: {baseline: string | null; providerId: string; model: string | null; parentThreadId: string | null}) {
    this.db.prepare("UPDATE review_runs SET baseline = ?, provider_id = ?, model = ?, parent_thread_id = ? WHERE id = ?")
      .run(input.baseline, input.providerId, input.model, input.parentThreadId, id);
  }

  /** Whether `bbThreadId` is any run's thread, closed ones included. */
  isRunThread(bbThreadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM review_runs WHERE bb_thread_id = ? LIMIT 1").get(bbThreadId) !== undefined;
  }

  /** Whether runs were started under `threadId`, closed ones included. */
  hasChildren(threadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM review_runs WHERE parent_thread_id = ? LIMIT 1").get(threadId) !== undefined;
  }

  /** Runs it again: a follow-up went to its thread. */
  restart(id: string) {
    this.db.prepare("UPDATE review_runs SET status = 'running', finished_at = NULL WHERE id = ? AND status != 'closed'").run(id);
  }

  finish(id: string, status: "done" | "failed", summary: string | null, changedFiles: readonly string[] | null) {
    this.db.prepare("UPDATE review_runs SET status = ?, summary = ?, changed_files = ?, finished_at = ? WHERE id = ? AND status != 'closed'")
      .run(status, summary, changedFiles === null ? null : JSON.stringify(changedFiles), this.now(), id);
  }

  close(id: string) {
    this.db.prepare("UPDATE review_runs SET status = 'closed' WHERE id = ?").run(id);
  }
}

function toRun(row: RunRow): ReviewRun {
  return {id: row.id, sessionId: row.session_id, kind: row.kind, threadId: row.bb_thread_id, focus: row.focus, providerId: row.provider_id,
    model: row.model, status: row.status, summary: row.summary,
    changedFiles: row.changed_files === null ? null : JSON.parse(row.changed_files) as string[],
    createdAt: row.created_at, finishedAt: row.finished_at};
}
