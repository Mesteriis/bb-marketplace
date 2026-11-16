// LifecycleStore on the plugin's SQLite database (runs, time entries, worklogs).
import type Database from "better-sqlite3";
import type { TaskRun, TimeEntry, WorklogRecord } from "../../core/lifecycle.ts";
import type { LifecycleStore } from "../../core/ports.ts";

type RunRow = { id: string; task_id: string; project_id: string; environment_id: string | null; thread_id: string | null; branch_name: string | null; start_status_id: string; next_status_id: string; state: string; started_at: string; completed_at: string | null; duration_seconds: number | null; delivered_summary: string | null; };
type TimeEntryRow = { id: string; run_id: string; task_id: string; state: string; duration_seconds: number; comment: string; created_at: string; submitted_at: string | null; };
type WorklogRow = { id: string; task_id: string; run_id: string; remote: number; remote_id: string | null; duration_seconds: number; comment: string; started_at: string; created_at: string; };

const RUN_STATE_SET = ["provisioning", "spawning", "active", "completed", "failed", "unknown"] as const;
const ENTRY_STATE_SET = ["pending", "submitting", "submitted", "failed", "unknown"] as const;

function toRun(row: RunRow): TaskRun {
  return { id: row.id, taskId: row.task_id, projectId: row.project_id, environmentId: row.environment_id, threadId: row.thread_id, branchName: row.branch_name, startStatusId: row.start_status_id, nextStatusId: row.next_status_id, state: RUN_STATE_SET.includes(row.state as never) ? (row.state as TaskRun["state"]) : "active", startedAtIso: row.started_at, completedAtIso: row.completed_at, durationSeconds: row.duration_seconds, deliveredSummary: row.delivered_summary };
}

function toTimeEntry(row: TimeEntryRow): TimeEntry {
  return { id: row.id, runId: row.run_id, taskId: row.task_id, state: ENTRY_STATE_SET.includes(row.state as never) ? (row.state as TimeEntry["state"]) : "pending", durationSeconds: row.duration_seconds, comment: row.comment, createdAtIso: row.created_at, submittedAtIso: row.submitted_at };
}

function toWorklog(row: WorklogRow): WorklogRecord {
  return { id: row.id, taskId: row.task_id, runId: row.run_id, remote: row.remote === 1, remoteId: row.remote_id, durationSeconds: row.duration_seconds, comment: row.comment, startedAtIso: row.started_at, createdAtIso: row.created_at };
}

export function createLifecycleStore(db: Database.Database): LifecycleStore {
  const upsertRun = db.prepare("INSERT INTO runs (id, task_id, project_id, environment_id, thread_id, branch_name, start_status_id, next_status_id, state, started_at, completed_at, duration_seconds, delivered_summary) VALUES (@id, @taskId, @projectId, @environmentId, @threadId, @branchName, @startStatusId, @nextStatusId, @state, @startedAtIso, @completedAtIso, @durationSeconds, @deliveredSummary) ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, thread_id = excluded.thread_id, branch_name = excluded.branch_name, state = excluded.state, completed_at = excluded.completed_at, duration_seconds = excluded.duration_seconds, delivered_summary = excluded.delivered_summary");
  const upsertTimeEntry = db.prepare("INSERT INTO time_entries (id, run_id, task_id, state, duration_seconds, comment, created_at, submitted_at) VALUES (@id, @runId, @taskId, @state, @durationSeconds, @comment, @createdAtIso, @submittedAtIso) ON CONFLICT(id) DO UPDATE SET state = excluded.state, duration_seconds = excluded.duration_seconds, comment = excluded.comment, submitted_at = excluded.submitted_at");
  const insertTimeEntry = db.prepare("INSERT INTO time_entries (id, run_id, task_id, state, duration_seconds, comment, created_at, submitted_at) VALUES (@id, @runId, @taskId, @state, @durationSeconds, @comment, @createdAtIso, @submittedAtIso)");
  const upsertWorklog = db.prepare("INSERT INTO worklogs (id, task_id, run_id, remote, remote_id, duration_seconds, comment, started_at, created_at) VALUES (@id, @taskId, @runId, @remote, @remoteId, @durationSeconds, @comment, @startedAtIso, @createdAtIso) ON CONFLICT(id) DO NOTHING");
  const completeRunStmt = db.prepare("UPDATE runs SET state='completed', completed_at=@completedAtIso, duration_seconds=@durationSeconds, delivered_summary=@deliveredSummary WHERE id=@id AND state='active'");
  const claimSubmissionStmt = db.prepare("UPDATE time_entries SET state='submitting', duration_seconds=@durationSeconds, comment=@comment WHERE id=@id AND state='pending'");
  const failSubmissionStmt = db.prepare("UPDATE time_entries SET state=@state WHERE id=@id AND state='submitting'");
  const completeSubmissionStmt = db.prepare("UPDATE time_entries SET state='submitted', duration_seconds=@durationSeconds, comment=@comment, submitted_at=@submittedAtIso WHERE id=@id");
  const recoverSubmittingStmt = db.prepare("UPDATE time_entries SET state='unknown' WHERE state='submitting'");
  const recoverProvisioningStmt = db.prepare("UPDATE runs SET state='unknown' WHERE (state='provisioning' OR state='spawning') AND (thread_id IS NULL OR thread_id='')");

  const getEntryByRun = (runId: string): TimeEntry | null => { const row = db.prepare("SELECT * FROM time_entries WHERE run_id = ? ORDER BY created_at LIMIT 1").get(runId) as TimeEntryRow | undefined; return row === undefined ? null : toTimeEntry(row); };

  return {
    saveRun(run) { upsertRun.run({ id: run.id, taskId: run.taskId, projectId: run.projectId, environmentId: run.environmentId, threadId: run.threadId, branchName: run.branchName, startStatusId: run.startStatusId, nextStatusId: run.nextStatusId, state: run.state, startedAtIso: run.startedAtIso, completedAtIso: run.completedAtIso, durationSeconds: run.durationSeconds, deliveredSummary: run.deliveredSummary }); },
    deleteRun(id) { db.prepare("DELETE FROM runs WHERE id = ?").run(id); },
    getRun(id) { const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined; return row === undefined ? null : toRun(row); },
    listRunsForTask(taskId) { return (db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as RunRow[]).map(toRun); },
    getRunByThread(threadId) { const row = db.prepare("SELECT * FROM runs WHERE thread_id = ?").get(threadId) as RunRow | undefined; return row === undefined ? null : toRun(row); },
    saveTimeEntry(entry) { upsertTimeEntry.run({ id: entry.id, runId: entry.runId, taskId: entry.taskId, state: entry.state, durationSeconds: entry.durationSeconds, comment: entry.comment, createdAtIso: entry.createdAtIso, submittedAtIso: entry.submittedAtIso }); },
    getTimeEntry(id) { const row = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id) as TimeEntryRow | undefined; return row === undefined ? null : toTimeEntry(row); },
    getTimeEntryByRun(runId) { return getEntryByRun(runId); },
    listPendingTimeEntries() { return (db.prepare("SELECT * FROM time_entries WHERE state = 'pending' ORDER BY created_at").all() as TimeEntryRow[]).map(toTimeEntry); },
    listTimeEntriesByTask(taskId) { return (db.prepare("SELECT * FROM time_entries WHERE task_id = ? ORDER BY created_at").all(taskId) as TimeEntryRow[]).map(toTimeEntry); },
    saveWorklog(worklog) { upsertWorklog.run({ id: worklog.id, taskId: worklog.taskId, runId: worklog.runId, remote: worklog.remote ? 1 : 0, remoteId: worklog.remoteId, durationSeconds: worklog.durationSeconds, comment: worklog.comment, startedAtIso: worklog.startedAtIso, createdAtIso: worklog.createdAtIso }); },
    listWorklogsForTask(taskId) { return (db.prepare("SELECT * FROM worklogs WHERE task_id = ? ORDER BY created_at").all(taskId) as WorklogRow[]).map(toWorklog); },
    claimCompletion(runId, completed, entry) {
      const run = db.transaction(() => {
        const updated = completeRunStmt.run({ id: runId, completedAtIso: completed.completedAtIso, durationSeconds: completed.durationSeconds, deliveredSummary: completed.deliveredSummary });
        if (updated.changes === 0) return { claimed: false, existingEntry: getEntryByRun(runId) };
        try {
          insertTimeEntry.run({ id: entry.id, runId: entry.runId, taskId: entry.taskId, state: entry.state, durationSeconds: entry.durationSeconds, comment: entry.comment, createdAtIso: entry.createdAtIso, submittedAtIso: entry.submittedAtIso });
          return { claimed: true, existingEntry: null };
        } catch (error) {
          if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
            return { claimed: false, existingEntry: getEntryByRun(runId) };
          }
          throw error;
        }
      });
      return run();
    },
    claimSubmission(entryId, durationSeconds, comment) { return claimSubmissionStmt.run({ id: entryId, durationSeconds, comment }).changes > 0; },
    failSubmission(entryId, state) { failSubmissionStmt.run({ id: entryId, state }); },
    completeSubmission(entryId, submitted, worklog) {
      db.transaction(() => {
        upsertWorklog.run({ id: worklog.id, taskId: worklog.taskId, runId: worklog.runId, remote: worklog.remote ? 1 : 0, remoteId: worklog.remoteId, durationSeconds: worklog.durationSeconds, comment: worklog.comment, startedAtIso: worklog.startedAtIso, createdAtIso: worklog.createdAtIso });
        completeSubmissionStmt.run({ id: entryId, durationSeconds: submitted.durationSeconds, comment: submitted.comment, submittedAtIso: submitted.submittedAtIso });
      })();
    },
    recoverSubmittingEntries() { return recoverSubmittingStmt.run().changes; },
    recoverProvisioningRuns() { return recoverProvisioningStmt.run().changes; },
  };
}
