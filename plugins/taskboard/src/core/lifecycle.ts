// Take-into-work lifecycle: create a run (worktree + thread + task context),
// complete it explicitly, and submit editable time. Idle or failed turns are
// never treated as completion. Time is never auto-submitted; the pending entry
// persists until the owner confirms it. Completion and submission use durable
// store claims so concurrent calls cannot double-create entries or double-POST.
import { z } from "zod";
import { DomainError } from "./errors.ts";
import type { FetchLike } from "./jira.ts";
import { idSchema, type Task } from "./model.ts";
import type { Clock, CredentialStore, IdGenerator, LifecycleStore, ProjectProvider, RunSpawner, TaskStore, WorklogSink } from "./ports.ts";
import { moveTask } from "./sync.ts";

export const RUN_STATES = ["provisioning", "spawning", "active", "completed", "failed", "unknown"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const TIME_ENTRY_STATES = ["pending", "submitting", "submitted", "failed", "unknown"] as const;
export type TimeEntryState = (typeof TIME_ENTRY_STATES)[number];

export const taskRunSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    projectId: z.string().min(1).max(200),
    environmentId: z.string().min(1).max(200).nullable(),
    threadId: z.string().min(1).max(200).nullable(),
    branchName: z.string().min(1).max(200).nullable(),
    startStatusId: idSchema,
    nextStatusId: idSchema,
    state: z.enum(RUN_STATES),
    startedAtIso: z.string().min(1),
    completedAtIso: z.string().min(1).nullable(),
    durationSeconds: z.number().int().min(0).nullable(),
    deliveredSummary: z.string().max(4000).nullable(),
  })
  .strict();
export type TaskRun = z.infer<typeof taskRunSchema>;

export const timeEntrySchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    taskId: idSchema,
    state: z.enum(TIME_ENTRY_STATES),
    durationSeconds: z.number().int().min(1).max(31_536_000),
    comment: z.string().max(4000),
    createdAtIso: z.string().min(1),
    submittedAtIso: z.string().min(1).nullable(),
  })
  .strict();
export type TimeEntry = z.infer<typeof timeEntrySchema>;

export const worklogSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    runId: idSchema,
    remote: z.boolean(),
    remoteId: z.string().max(200).nullable(),
    durationSeconds: z.number().int().min(1).max(31_536_000),
    comment: z.string().max(4000),
    startedAtIso: z.string().min(1),
    createdAtIso: z.string().min(1),
  })
  .strict();
export type WorklogRecord = z.infer<typeof worklogSchema>;

export interface LifecycleDeps {
  store: TaskStore;
  lifecycle: LifecycleStore;
  projects: ProjectProvider;
  runSpawner: RunSpawner;
  worklogs: WorklogSink;
  credentials: CredentialStore;
  fetchFn?: FetchLike;
  clock: Clock;
  idgen: IdGenerator;
}

function syncDeps(deps: LifecycleDeps) {
  return { store: deps.store, credentials: deps.credentials, idgen: deps.idgen, clock: deps.clock, fetchFn: deps.fetchFn };
}

// Per-task serialization so concurrent take/complete on the same task cannot
// interleave. Durable store claims still guard across restarts.
const taskChains = new Map<string, Promise<unknown>>();
function serializeTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const previous = taskChains.get(taskId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  taskChains.set(taskId, run);
  void run.finally(() => { if (taskChains.get(taskId) === run) taskChains.delete(taskId); }).catch(() => {});
  return run;
}

function taskPrompt(task: Task): string {
  const parts = ["Work on this task:", "Title: " + task.title];
  if (task.description !== "") parts.push("Description: " + task.description);
  parts.push("Origin: " + (task.originKey ?? "local task"));
  parts.push("When the work is delivered and verified, call the finish_work tool with a summary of what was delivered. An idle or failed turn is never completion.");
  return parts.join("\n\n");
}

/** Only explicit provider rejection or a pre-POST refusal is safe to retry;
 * network / lost-response / HTTP 5xx are ambiguous and must not auto-retry. */
function worklogFailureState(error: unknown): "failed" | "unknown" {
  if (error instanceof DomainError) {
    if (error.kind === "auth" || error.kind === "not_found") return "failed";
    if (error.kind === "invalid" || error.kind === "conflict") return "failed";
    return "unknown"; // network, http
  }
  return "unknown";
}

function elapsedSeconds(startIso: string, nowIso: string): number {
  const elapsed = Date.parse(nowIso) - Date.parse(startIso);
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed / 1000)) : 0;
}

export interface TakeIntoWorkInput {
  taskId: string;
  projectId: string;
  startStatusId: string;
  nextStatusId: string;
}

export function takeIntoWork(input: TakeIntoWorkInput, deps: LifecycleDeps): Promise<TaskRun> {
  return serializeTask(input.taskId, async () => {
    const task = deps.store.getTask(input.taskId);
    if (task === null) throw new DomainError("not_found", "Task not found");
    const columns = deps.store.listColumns(task.boardId);
    if (!columns.some((column) => column.id === input.startStatusId)) throw new DomainError("invalid", "Unknown start status");
    if (!columns.some((column) => column.id === input.nextStatusId)) throw new DomainError("invalid", "Unknown completion status");

    const runs = deps.lifecycle.listRunsForTask(task.id);
    const existing = runs[runs.length - 1];
    if (existing !== undefined && existing.state === "active") {
      throw new DomainError("conflict", "This task is already being worked");
    }
    if (existing !== undefined && existing.state !== "completed") {
      // Resume the same run (provisioning or failed) instead of spawning again.
      return resumeRun(existing, task, deps);
    }

    const runId = deps.idgen.newId();
    const provisional: TaskRun = {
      id: runId, taskId: task.id, projectId: input.projectId, environmentId: null, branchName: null,
      startStatusId: input.startStatusId, nextStatusId: input.nextStatusId, state: "provisioning",
      threadId: null,
      startedAtIso: deps.clock.now().toISOString(), completedAtIso: null, durationSeconds: null, deliveredSummary: null,
    };
    // Persist ids immediately: a crash here is recoverable, never a lost id.
    deps.lifecycle.saveRun(provisional);
    return resumeRun(provisional, task, deps);
  });
}

async function resumeRun(run: TaskRun, task: Task, deps: LifecycleDeps): Promise<TaskRun> {
  let current = run;

  if (current.threadId === null) {
    // Only ambiguous states need reconciliation before any spawn.
    if (current.state === "spawning" || current.state === "unknown") {
      const found = await deps.runSpawner.reconcile(current.id, current.projectId);
      if (found === undefined) {
        deps.lifecycle.saveRun({ ...current, state: "unknown" });
        throw new DomainError("conflict", "Run is in an uncertain state; check your threads and retry");
      }
      if (found !== null) {
        current = { ...current, threadId: found.threadId, environmentId: found.environmentId, branchName: found.branchName };
        deps.lifecycle.saveRun(current);
      }
    }
    if (current.threadId === null) {
      // Definitely no resource yet (fresh, failed, or reconciled-none): spawn.
      const branchName = task.originKey ?? "local-" + task.id;
      deps.lifecycle.saveRun({ ...current, state: "spawning" });
      try {
        const spawned = await deps.runSpawner.spawn({
          projectId: current.projectId,
          branchName,
          title: (task.originKey ?? task.id) + ": " + task.title,
          prompt: taskPrompt(task),
          metadata: { taskId: task.id, runId: current.id },
        });
        current = { ...current, threadId: spawned.threadId, environmentId: spawned.environmentId, branchName: spawned.branchName };
        deps.lifecycle.saveRun(current);
      } catch (error) {
        // A DomainError is a definite pre-spawn refusal (no resource); anything
        // else is ambiguous (the spawn may have created a thread and lost the reply).
        deps.lifecycle.saveRun({ ...current, state: error instanceof DomainError ? "failed" : "spawning" });
        throw error;
      }
    }
  }

  if (task.status !== current.startStatusId) {
    await moveTask(task.id, current.startStatusId, syncDeps(deps));
  }
  const active: TaskRun = { ...current, state: "active" };
  deps.lifecycle.saveRun(active);
  return active;
}

export interface CompleteRunInput {
  runId: string;
  deliveredSummary?: string;
}

export function completeRun(input: CompleteRunInput, deps: LifecycleDeps): Promise<TimeEntry> {
  return serializeTask(input.runId, async () => {
    const run = deps.lifecycle.getRun(input.runId);
    if (run === null) throw new DomainError("not_found", "Run not found");
    if (run.state === "completed") {
      const existing = deps.lifecycle.getTimeEntryByRun(run.id);
      if (existing !== null && existing.state !== "submitted") return existing;
      throw new DomainError("conflict", "This run is already completed");
    }
    const task = deps.store.getTask(run.taskId);
    if (task === null) throw new DomainError("not_found", "Task not found");

    if (task.status !== run.nextStatusId) {
      try {
        await moveTask(task.id, run.nextStatusId, syncDeps(deps));
      } catch (error) {
        const current = deps.store.getTask(run.taskId);
        if (current === null || current.status !== run.nextStatusId) throw error;
      }
    }

    const nowIso = deps.clock.now().toISOString();
    const durationSeconds = elapsedSeconds(run.startedAtIso, nowIso);
    const completed: TaskRun = { ...run, state: "completed", completedAtIso: nowIso, durationSeconds, deliveredSummary: input.deliveredSummary ?? run.deliveredSummary };
    const entry: TimeEntry = { id: deps.idgen.newId(), runId: run.id, taskId: run.taskId, state: "pending", durationSeconds: Math.max(1, durationSeconds), comment: "", createdAtIso: nowIso, submittedAtIso: null };
    // Durable claim: run -> completed and the entry are persisted atomically; a
    // concurrent completion returns the other call's entry.
    const claim = deps.lifecycle.claimCompletion(run.id, completed, entry);
    if (claim.claimed) return entry;
    if (claim.existingEntry !== null) return claim.existingEntry;
    throw new DomainError("conflict", "Completion could not be recorded");
  });
}

export async function finishWork(input: { threadId: string; summary: string }, deps: LifecycleDeps): Promise<TimeEntry> {
  const run = deps.lifecycle.getRunByThread(input.threadId);
  if (run === null) throw new DomainError("not_found", "No active work for this thread");
  if (run.state !== "active") throw new DomainError("conflict", "This work is already completed");
  return completeRun({ runId: run.id, deliveredSummary: input.summary }, deps);
}

export interface UpdateTimeEntryInput {
  entryId: string;
  durationSeconds: number;
  comment: string;
}

export function updateTimeEntry(input: UpdateTimeEntryInput, deps: LifecycleDeps): TimeEntry {
  const entry = deps.lifecycle.getTimeEntry(input.entryId);
  if (entry === null) throw new DomainError("not_found", "Time entry not found");
  if (entry.state !== "pending") throw new DomainError("conflict", "This time entry was already " + entry.state);
  const next: TimeEntry = { ...entry, durationSeconds: Math.max(1, Math.round(input.durationSeconds)), comment: input.comment };
  deps.lifecycle.saveTimeEntry(next);
  return next;
}

export async function submitTimeEntry(input: UpdateTimeEntryInput, deps: LifecycleDeps): Promise<WorklogRecord> {
  const entry = deps.lifecycle.getTimeEntry(input.entryId);
  if (entry === null) throw new DomainError("not_found", "Time entry not found");
  if (entry.state !== "pending") throw new DomainError("conflict", "This time entry was already " + entry.state);
  // Durable claim before any remote POST: a concurrent submit is refused.
  if (!deps.lifecycle.claimSubmission(entry.id, Math.max(1, Math.round(input.durationSeconds)), input.comment)) {
    throw new DomainError("conflict", "This time entry is already being submitted");
  }
  const task = deps.store.getTask(entry.taskId);
  if (task === null) throw new DomainError("not_found", "Task not found");
  const run = deps.lifecycle.getRun(entry.runId);
  const durationSeconds = Math.max(1, Math.round(input.durationSeconds));
  const startedAtIso = run?.startedAtIso ?? entry.createdAtIso;

  let remote = false;
  let remoteId: string | null = null;
  if (task.origin === "jira" && task.originKey !== null) {
    const board = deps.store.getBoard(task.boardId);
    const connectionId = board?.connectionId ?? null;
    if (connectionId === null) { deps.lifecycle.failSubmission(entry.id, "failed"); throw new DomainError("conflict", "This Jira task has no connection"); }
    try {
      const result = await deps.worklogs.submitRemoteWorklog({ connectionId, issueKey: task.originKey, durationSeconds, comment: input.comment, startedAtIso });
      remote = true;
      remoteId = result.id;
    } catch (error) {
      deps.lifecycle.failSubmission(entry.id, worklogFailureState(error));
      throw error;
    }
  }

  const worklog: WorklogRecord = { id: deps.idgen.newId(), taskId: entry.taskId, runId: entry.runId, remote, remoteId, durationSeconds, comment: input.comment, startedAtIso, createdAtIso: deps.clock.now().toISOString() };
  const submitted: TimeEntry = { ...entry, state: "submitted", durationSeconds, comment: input.comment, submittedAtIso: deps.clock.now().toISOString() };
  deps.lifecycle.completeSubmission(entry.id, submitted, worklog);
  return worklog;
}

export function cancelRun(runId: string, deps: LifecycleDeps): void {
  const run = deps.lifecycle.getRun(runId);
  if (run === null) throw new DomainError("not_found", "Run not found");
  if (run.state === "completed") throw new DomainError("conflict", "Completed runs cannot be cancelled");
  if (run.state === "spawning" || run.state === "unknown") {
    throw new DomainError("conflict", "Cannot cancel an uncertain run; reconcile it first");
  }
  if (run.threadId !== null) throw new DomainError("conflict", "This run already has a thread; complete it instead");
  deps.lifecycle.deleteRun(runId);
}

export function retryTimeEntry(entryId: string, deps: LifecycleDeps): TimeEntry {
  const entry = deps.lifecycle.getTimeEntry(entryId);
  if (entry === null) throw new DomainError("not_found", "Time entry not found");
  if (entry.state !== "failed") throw new DomainError("conflict", "Only a known-failed entry can be retried");
  const next: TimeEntry = { ...entry, state: "pending" };
  deps.lifecycle.saveTimeEntry(next);
  return next;
}

/** Owner reconciliation: marks a failed/unknown entry submitted without a POST
 * (the owner confirmed the worklog is already recorded, optionally with its id). */
export function resolveTimeEntry(input: { entryId: string; remoteId?: string }, deps: LifecycleDeps): WorklogRecord {
  const entry = deps.lifecycle.getTimeEntry(input.entryId);
  if (entry === null) throw new DomainError("not_found", "Time entry not found");
  if (entry.state !== "failed" && entry.state !== "unknown") {
    throw new DomainError("conflict", "This entry does not need resolution");
  }
  const task = deps.store.getTask(entry.taskId);
  const run = deps.lifecycle.getRun(entry.runId);
  const startedAtIso = run?.startedAtIso ?? entry.createdAtIso;
  const worklog: WorklogRecord = { id: deps.idgen.newId(), taskId: entry.taskId, runId: entry.runId, remote: task?.origin === "jira", remoteId: input.remoteId ?? null, durationSeconds: entry.durationSeconds, comment: entry.comment, startedAtIso, createdAtIso: deps.clock.now().toISOString() };
  const submitted: TimeEntry = { ...entry, state: "submitted", submittedAtIso: deps.clock.now().toISOString() };
  deps.lifecycle.completeSubmission(entry.id, submitted, worklog);
  return worklog;
}

export function listRunsForTask(taskId: string, deps: LifecycleDeps): TaskRun[] {
  return deps.lifecycle.listRunsForTask(taskId);
}

export function listPendingTimeEntries(deps: LifecycleDeps): TimeEntry[] {
  return deps.lifecycle.listPendingTimeEntries();
}

export function listWorklogsForTask(taskId: string, deps: LifecycleDeps): WorklogRecord[] {
  return deps.lifecycle.listWorklogsForTask(taskId);
}

/** Crash recovery, run once at server load. */
export function recoverLifecycle(deps: LifecycleDeps): { unknownEntries: number; recoveredRuns: number } {
  return {
    unknownEntries: deps.lifecycle.recoverSubmittingEntries(),
    recoveredRuns: deps.lifecycle.recoverProvisioningRuns(),
  };
}
