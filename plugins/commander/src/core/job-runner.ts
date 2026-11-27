import { CommanderError, isCommanderError } from "./errors.ts";
import { transition, type JobEvent } from "./job-machine.ts";
import type { Checkpoint, JobStore } from "./job-store.ts";
import {
  ConflictDecision, OperationJob, OperationPlan, planDigest,
  type Conflict, type ConflictAction, type EndpointId, type Entry,
  type Fingerprint, type ItemOutcome, type PlanItem, type ResourceRef,
} from "./model.ts";
import { isAncestorOrSelf, join, parent, samePath, type ResourcePath } from "./path.ts";
import { READ_CHUNK_MAX, type FileProvider, type WriteSession } from "./provider.ts";
import {
  confirmVerified, fingerprint, matches, matchesTarget, observe, readChunks, reconcileItem, removeStagedTemp, tempNameFor, TransferHash, verifyCopy,
  type Location, type VerifyContext,
} from "./reconcile.ts";
import { fromBig, toBig } from "./size.ts";

export interface RunnerDeps {
  store: JobStore;
  provider(endpoint: EndpointId): FileProvider;
  now(): Date;
  uuid(): string;
  chunkBytes?: number;
  retryDelay?(milliseconds: number, signal: AbortSignal): Promise<void>;
  revalidate?(plan: OperationPlan, signal: AbortSignal): Promise<{ ok: true } | {
    ok: false; changed: { index: number; reason: "source_changed" | "target_changed" }[];
  }>;
  onEvent(e: { jobId: string; kind: "progress" | "state" | "conflict" }): void;
}

type Patch = Parameters<JobStore["update"]>[1];
type EventKind = Parameters<RunnerDeps["onEvent"]>[0]["kind"];
type Decision = { conflict: Conflict; action: ConflictAction };
type PreparedDirectory = { source: Location; target: Location };
type MoveFinish = "removed" | "source_retained" | "move_cancelled";
type ItemResult = "done" | "skipped" | Exclude<MoveFinish, "removed"> | PreparedDirectory;
const cancelledError = new CommanderError("cancelled", "Job cancelled");
const sourceRetained = "Source changed; source retained";
const moveCancelled = "Move cancelled; source retained";

function plannedTarget(item: PlanItem): Checkpoint["expectTarget"] {
  // S2 adds this field to the core schema when its branch is integrated.
  return (item as PlanItem & { expectTarget?: Checkpoint["expectTarget"] }).expectTarget ?? null;
}
type Run = {
  controller: AbortController;
  done: Promise<void>;
};
type ItemContext = VerifyContext & {
  progress(bytes: bigint): Promise<void>;
  mark(phase: Checkpoint["phase"], fields?: Partial<Omit<Checkpoint, "jobId" | "itemIndex" | "phase">>): Promise<void>;
  load(checkpoint: Checkpoint): void;
  saved(): Checkpoint;
  mutate<T>(action: () => Promise<T>, unchanged: (check: VerifyContext) => Promise<boolean>): Promise<T>;
};

class ItemConflict extends Error {
  constructor(readonly reason: Conflict["reason"], readonly source: Fingerprint | null, readonly target: Fingerprint | null) {
    super(reason);
  }
}

function safeError(error: unknown): CommanderError {
  return isCommanderError(error) ? error : new CommanderError("internal", "Job execution failed");
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class JobRunner {
  private readonly store: JobStore;
  private readonly chunkBytes: number;
  private readonly active = new Map<string, Run>();
  private readonly decisions = new Map<string, Map<number, Decision>>();
  private readonly rules = new Map<string, Map<Conflict["reason"], ConflictAction>>();
  private readonly restored = new Map<string, Checkpoint>();
  private readonly directories = new Map<string, Map<number, PreparedDirectory>>();

  constructor(private readonly deps: RunnerDeps) {
    this.store = deps.store;
    this.chunkBytes = deps.chunkBytes ?? READ_CHUNK_MAX;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > READ_CHUNK_MAX) {
      throw new CommanderError("limit_exceeded", "Invalid transfer chunk size");
    }
  }

  async submit(plan: OperationPlan, opts?: { awaitsOwner: boolean }): Promise<OperationJob> {
    plan = await this.validPlan(plan);
    const now = this.deps.now().toISOString();
    const job = OperationJob.parse({
      id: this.deps.uuid(), plan, state: "pending", awaitsOwner: opts?.awaitsOwner ?? false,
      currentItem: null, pendingConflict: null, error: null, createdAt: now, updatedAt: now,
      progress: { itemsDone: 0, itemsTotal: plan.items.length, bytesDone: "0", bytesTotal: plan.totalBytes },
      items: plan.items.map(() => ({ outcome: "pending", error: null })),
    });
    await this.store.create(job);
    this.deps.onEvent({ jobId: job.id, kind: "state" });
    if (!job.awaitsOwner) await this.start(job);
    return job;
  }

  async approve(id: string): Promise<void> {
    const job = await this.requireJob(id);
    if (job.state !== "pending" || !job.awaitsOwner) {
      throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
    }
    const plan = await this.validPlan(job.plan);
    const context = this.context(id, 0, new AbortController().signal);
    const checked = await this.deps.revalidate?.(plan, context.signal);
    if (checked && !checked.ok) throw new CommanderError("changed_since_plan", "Plan changed before approval");
    const targetDirectory = (plan as OperationPlan & { targetDir?: ResourceRef | ResourcePath | null }).targetDir;
    if (targetDirectory) {
      const ref = "endpoint" in targetDirectory ? targetDirectory
        : plan.targetEndpoint && { endpoint: plan.targetEndpoint, path: targetDirectory };
      if (!ref || (await observe(this.location(ref), context))?.kind !== "dir") {
        throw new CommanderError("changed_since_plan", "Plan target directory changed before approval");
      }
    }
    let targetConflict: { index: number; conflict: ItemConflict } | undefined;
    for (const [index, item] of plan.items.entries()) {
      const current = item.source && await observe(this.location(item.source), context, Boolean(item.fingerprint?.sha256));
      if (item.source && (!current || current.kind !== item.kind || !matches(current, item.fingerprint))) {
        throw new CommanderError("changed_since_plan", "Plan source changed before approval");
      }
      const expected = plannedTarget(item);
      if (!targetConflict && item.target && expected !== null) {
        const target = await observe(this.location(item.target), context, expected !== "absent" && Boolean(expected.sha256));
        if (!matchesTarget(target, expected)) {
          targetConflict = { index, conflict: new ItemConflict("target_changed", fingerprint(current), fingerprint(target)) };
        }
      }
    }
    if (!targetConflict) {
      if (!await this.start(job, plan)) throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
      return;
    }
    if (!await this.change(job, "start")) throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
    const running = await this.requireJob(id);
    if (running.state === "running") await this.requestConflict(running, targetConflict.index, targetConflict.conflict);
  }

  async reject(id: string): Promise<void> {
    const job = await this.requireJob(id);
    if (job.state !== "pending" || !job.awaitsOwner) {
      throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
    }
    if (!await this.change(job, "cancel")) throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
    await this.finishCancel(id);
  }

  async decide(id: string, input: ConflictDecision): Promise<void> {
    const decision = ConflictDecision.parse(input);
    const job = await this.requireJob(id);
    const conflict = job.pendingConflict;
    if (job.state !== "awaiting_decision" || conflict?.id !== decision.conflictId) {
      throw new CommanderError("changed_since_plan", "Conflict is no longer current");
    }
    if (conflict.allowedResolutions && !conflict.allowedResolutions.includes(decision.action)) {
      throw new CommanderError("unsupported", "Resolution is unavailable for this conflict");
    }
    if (decision.action === "cancel") {
      if (!await this.change(job, "cancel")) throw new CommanderError("changed_since_plan", "Conflict is no longer current");
      await this.finishCancel(id);
      return;
    }
    if (!await this.change(job, "decide")) throw new CommanderError("changed_since_plan", "Conflict is no longer current");
    const decisions = this.decisions.get(id) ?? new Map<number, Decision>();
    decisions.set(conflict.itemIndex, { conflict, action: decision.action });
    this.decisions.set(id, decisions);
    if (decision.applyTo === "remaining_same_reason" && conflict.reason !== "source_changed" && conflict.reason !== "target_changed") {
      const rules = this.rules.get(id) ?? new Map();
      rules.set(conflict.reason, decision.action);
      this.rules.set(id, rules);
    }
    await this.active.get(id)?.done;
    this.launch(id);
  }

  async cancel(id: string): Promise<void> {
    for (;;) {
      const job = await this.requireJob(id);
      if (job.state === "cancel_requested") break;
      if (job.state !== "pending" && job.state !== "running" && job.state !== "awaiting_decision") return;
      if (await this.change(job, "cancel")) break;
    }
    const run = this.active.get(id);
    run?.controller.abort(cancelledError);
    await run?.done;
    await this.finishCancel(id);
  }

  async recover(): Promise<{ resumed: string[]; unknown: string[] }> {
    const result: { resumed: string[]; unknown: string[] } = { resumed: [], unknown: [] };
    const jobs = await this.store.list({
      states: ["running", "cancel_requested", "awaiting_decision", "interrupted", "pending"],
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const job of jobs) {
      if (this.active.has(job.id)) continue;
      if (job.state === "pending") {
        if (!job.awaitsOwner && await this.start(job)) result.resumed.push(job.id);
        continue;
      }
      const cancelling = job.state === "cancel_requested" || (job.state === "interrupted"
        && job.error?.code === "cancelled" && job.error.message === cancelledError.message);
      if (job.state !== "interrupted" && !await this.change(job, "process_lost", {
        pendingConflict: job.pendingConflict,
        ...(cancelling ? { error: cancelledError.toShape() } : {}),
      })) continue;
      let interrupted = await this.requireJob(job.id);
      if (!cancelling && interrupted.pendingConflict) {
        if (await this.change(interrupted, "restore_conflict", { pendingConflict: interrupted.pendingConflict }, "conflict")) {
          result.resumed.push(job.id);
        }
        continue;
      }
      const completedBytes = interrupted.items.reduce((bytes, item, index) =>
        bytes + this.itemBytes(interrupted, index, item.outcome), 0n);
      const progress = this.progress(interrupted, completedBytes);
      await this.patch(interrupted, { progress }, "progress");
      interrupted = { ...interrupted, progress };
      const index = interrupted.currentItem;
      try {
        if (index !== null && interrupted.items[index].outcome === "pending") {
          await this.recoverStartedItem(interrupted, index, cancelling);
        }

      } catch {
        const latest = await this.requireJob(job.id);
        const error = new CommanderError("outcome_unknown", "Interrupted job outcome could not be confirmed");
        if (index !== null) await this.record(latest, index, "unknown", error);
        else await this.change(latest, "reconciled_unknown", { error: error.toShape(), currentItem: null });
        result.unknown.push(job.id);
        continue;
      }
      if (cancelling) {
        await this.change(await this.requireJob(job.id), "cancel_done", { currentItem: null, error: null });
        continue;
      }
      if (await this.change(await this.requireJob(job.id), "resume")) {
        this.launch(job.id);
        result.resumed.push(job.id);
      }
    }
    return result;
  }

  private async recoverStartedItem(
    job: OperationJob, index: number, cancelling: boolean, saved?: Checkpoint,
  ): Promise<void> {
    // The runner writes prepared before issuing any mutation. A missing
    // checkpoint is therefore safe to leave pending.
    const checkpoint = saved ?? await this.store.lastCheckpoint(job.id, index);
    if (!checkpoint) return;

    const item = job.plan.items[index];
    const source = item.source && this.location(item.source);
    const target = this.recoveredTarget(item, checkpoint);

    const context = this.context(job.id, index, new AbortController().signal);
    context.load(checkpoint);
    const outcome = await reconcileItem(checkpoint, source, target, item, job.plan, context,
      (point) => this.store.checkpoint(point));
    if (outcome === "pending") {
      if (!cancelling) this.restored.set(job.id, checkpoint);
      return;
    }

    if (outcome === "deferred_directory") {
      if (!cancelling && source && target) {
        const directories = this.directories.get(job.id) ?? new Map<number, PreparedDirectory>();
        directories.set(index, { source, target });
        this.directories.set(job.id, directories);
      }
      return;
    }

    let warning: string | undefined;
    if (typeof outcome === "object") {
      if (!source || !target || !item.fingerprint) throw new CommanderError("internal", "Move recovery lacks an endpoint");
      if (cancelling) {
        warning = moveCancelled;
      } else {
        await context.mark("verified", { verified: outcome.verified });
        const result = await this.finishMove(source, target, item.fingerprint, context);
        if (result !== "removed") warning = result === "move_cancelled" ? moveCancelled : sourceRetained;
      }
    }
    await this.record(job, index, "done", undefined, job.progress.bytesDone, warning);
  }

  private recoveredTarget(item: PlanItem, checkpoint: Checkpoint): Location | null {
    if (!item.target) return null;
    const path = checkpoint.targetPath ?? item.target.path;
    const target = this.location({ ...item.target, path });
    if (checkpoint.targetPath) {
      const original = parent(item.target.path);
      const actual = parent(path);
      if (!original || !actual || !samePath(original, actual, target.provider.endpoint.caseSensitive)) {
        throw new CommanderError("outcome_unknown", "Recovered destination is outside the planned directory");
      }
    }
    return target;
  }

  private async validPlan(input: OperationPlan): Promise<OperationPlan> {
    const plan = OperationPlan.parse(input);
    const { digest, ...unsigned } = plan;
    if (digest !== await planDigest(unsigned)) throw new CommanderError("changed_since_plan", "Plan digest changed");
    return plan;
  }

  private async start(job: OperationJob, snapshot?: OperationPlan): Promise<boolean> {
    if (!await this.change(job, "start")) return false;
    this.launch(job.id, snapshot);
    return true;
  }

  private launch(id: string, snapshot?: OperationPlan): void {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(id, controller.signal, snapshot))
      .catch(async (error: unknown) => {
        const job = await this.requireJob(id);
        if (job.state === "running") {
          await this.change(job, "fail", { error: safeError(error).toShape(), currentItem: null });
        }
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, { controller, done });
    // Public paths can await the run; observe detached failures if the store is unavailable.
    void done.catch(() => {});
  }

  private async execute(id: string, signal: AbortSignal, snapshot?: OperationPlan): Promise<void> {
    let next = 0;
    const prepared = this.directories.get(id) ?? new Map<number, PreparedDirectory>();
    this.directories.set(id, prepared);
    const deferred = [...prepared.keys()].sort((a, b) => a - b);
    try {
      for (;;) {
        let job = await this.requireJob(id);
        if (job.state !== "running") return;
        if (snapshot) job = { ...job, plan: snapshot };
        while (next < job.items.length && (job.items[next].outcome !== "pending" || prepared.has(next))) next++;
        const index = next < job.items.length ? next : deferred.pop() ?? -1;
        if (index === -1) {
          await this.change(job, job.items.some(({ outcome }) => outcome === "failed" || outcome === "unknown") ? "fail" : "all_done",
            { currentItem: null });
          return;
        }
        if (!await this.patch(job, { currentItem: index }, "progress")) return;
        const decisions = this.decisions.get(id);
        const decision = decisions?.get(index);
        decisions?.delete(index);
        try {
          const report = (bytes: bigint) => this.reportBytes(job, bytes);
          const context = this.context(id, index, signal, report);
          const directory = prepared.get(index);
          if (directory) {
            const checkpoint = await this.store.lastCheckpoint(id, index);
            if (checkpoint) context.load(checkpoint);
            const removed = await this.finishDirectory(job, directory, context);
            await this.record(await this.requireJob(id), index, "done", undefined, job.progress.bytesDone, removed ? undefined : sourceRetained);
          } else {
            const outcome = await this.perform(job, index, context, decision);
            if (typeof outcome === "string") {
              const warning = outcome === "source_retained" ? sourceRetained : outcome === "move_cancelled" ? moveCancelled : undefined;
              const result = outcome === "done" || outcome === "skipped" ? outcome : job.plan.kind === "delete" ? "skipped" : "done";
              await this.record(await this.requireJob(id), index, result, undefined, job.progress.bytesDone, warning);
            } else {
              prepared.set(index, outcome);
              deferred.push(index);
              await this.patch(job, { currentItem: null }, "progress");
            }
          }
        } catch (caught) {
          const current = await this.requireJob(id);
          if (caught instanceof ItemConflict && current.state === "running") {
            await this.requestConflict(current, index, caught, this.progress(current, toBig(job.progress.bytesDone)));
            return;
          }
          const error = safeError(caught);
          const cancelled = signal.aborted || current.state === "cancel_requested";
          if (error.code === "outcome_unknown") {
            await this.record(current, index, "unknown", error, job.progress.bytesDone);
            return;
          }
          if (!cancelled) {
            await this.record(current, index, "failed", error, job.progress.bytesDone);
          } else {
            await this.patch(current, { progress: this.progress(current, toBig(job.progress.bytesDone)) }, "progress");
          }
        }
        if (next < job.items.length) next = index + 1;
      }
    } finally {
      const job = await this.requireJob(id);
      if (job.state === "cancel_requested") await this.finishCancel(id);
      if (job.state !== "awaiting_decision" && job.state !== "running") {
        this.rules.delete(id);
        this.decisions.delete(id);
        this.directories.delete(id);
        this.restored.delete(id);
      }
    }
  }

  private expandedDirectory(job: OperationJob, index: number, source: Location | null): boolean {
    const item = job.plan.items[index];
    const following = job.plan.items[index + 1]?.source;
    return Boolean(item.kind === "dir" && source && following && item.source!.endpoint === following.endpoint
      && source.path.segments.length < following.path.segments.length
      && isAncestorOrSelf(source.path, following.path, source.provider.endpoint.caseSensitive));
  }

  private async requestConflict(job: OperationJob, index: number, conflict: ItemConflict, progress = job.progress): Promise<void> {
    const item = job.plan.items[index];
    const expanded = this.expandedDirectory(job, index, item.source && this.location(item.source));
    const allowedResolutions: ConflictAction[] = ["skip", "cancel"];
    if (item.target && (!item.source || conflict.source)) {
      if (!expanded) allowedResolutions.push("rename");
      if (conflict.reason !== "type_mismatch" && (job.plan.kind !== "rename" || conflict.target)) {
        allowedResolutions.push("overwrite");
      }
    }
    await this.change(job, "conflict", {
      currentItem: index, progress,
      pendingConflict: {
        id: this.deps.uuid(), jobId: job.id, itemIndex: index, reason: conflict.reason,
        source: conflict.source, target: conflict.target, allowedResolutions,
      },
    }, "conflict");
  }

  private async perform(job: OperationJob, index: number, context: ItemContext, decision?: Decision): Promise<ItemResult> {
    const item = job.plan.items[index];
    const source = item.source && this.location(item.source);
    if (job.plan.kind === "move" && item.kind === "dir" && source) {
      // A child may have paused for a decision across a restart. Restore the
      // parent on demand even if startup only restored the pending conflict.
      const checkpoint = await this.store.lastCheckpoint(job.id, index);
      if (checkpoint?.phase === "verified" || checkpoint?.phase === "source_removed") {
        const target = this.recoveredTarget(item, checkpoint);
        const outcome = await reconcileItem(checkpoint, source, target, item, job.plan, context,
          (point) => this.store.checkpoint(point));
        if (outcome === "done") return "done";
        if (outcome === "deferred_directory" && target) return { source, target };
        throw new CommanderError("outcome_unknown", "Staged move directory could not be confirmed");
      }
    }
    const restore = this.restored.get(job.id);
    const saved = restore?.itemIndex === index ? restore : undefined;
    if (saved) this.restored.delete(job.id);
    let target = item.target && this.location({ ...item.target, path: saved?.targetPath ?? item.target.path });
    const expectedTarget = saved?.expectTarget ?? plannedTarget(item);
    const expectedSource = decision?.conflict.source ?? item.fingerprint;
    const { signal, mutate } = context;
    const expandedDirectory = this.expandedDirectory(job, index, source);
    if (target && (job.plan.kind === "copy" || job.plan.kind === "move") && this.blockedParent(job, index, target)) return "skipped";
    const oldSource = source && await observe(source, context, Boolean(expectedSource?.sha256));
    const oldTarget = target && await observe(target, context, Boolean(
      decision?.conflict.target?.sha256 || (expectedTarget && expectedTarget !== "absent" && expectedTarget.sha256),
    ));
    const sourceFingerprint = fingerprint(oldSource);
    const targetFingerprint = fingerprint(oldTarget);
    const sameEndpoint = source && target && source.provider.endpoint.id === target.provider.endpoint.id;
    if (source && target && sameEndpoint && isAncestorOrSelf(source.path, target.path, source.provider.endpoint.caseSensitive)) {
      throw new CommanderError("invalid_path", "Destination overlaps source");
    }
    const sourceChanged = source && (!oldSource || oldSource.kind !== item.kind || !matches(sourceFingerprint, item.fingerprint));
    const targetChanged = target && expectedTarget !== null && !matchesTarget(oldTarget, expectedTarget);
    const reason = sourceChanged ? "source_changed" : targetChanged ? "target_changed"
      : oldTarget ? (oldTarget.kind === item.kind ? "exists" : "type_mismatch") : null;
    let replace = false;
    let expectTarget: Fingerprint | "absent" = targetFingerprint ?? "absent";

    if (decision) {
      if (decision.action === "skip") return "skipped";
      if (!matches(sourceFingerprint, decision.conflict.source)) {
        throw new ItemConflict("source_changed", sourceFingerprint, targetFingerprint);
      }
      if (!matches(targetFingerprint, decision.conflict.target)) {
        throw new ItemConflict("target_changed", sourceFingerprint, targetFingerprint);
      }
      replace = decision.action === "overwrite" && targetFingerprint !== null;
      if (decision.action === "rename" && target) {
        if (expandedDirectory) throw new CommanderError("unsupported", "Renaming an expanded destination requires a new plan");
        target = await this.freeTarget(target, context);
        expectTarget = "absent";
      }
    } else if (saved && !sourceChanged && !targetChanged) {
      replace = targetFingerprint !== null;
    } else if (reason) {
      const action = this.rules.get(job.id)?.get(reason) ?? this.policy(job.plan, reason, sourceFingerprint, targetFingerprint);
      if (action === "ask" || (action === "rename" && expandedDirectory)) {
        throw new ItemConflict(reason, sourceFingerprint, targetFingerprint);
      }
      if (action === "skip") return "skipped";
      if (action === "rename" && target) {
        target = await this.freeTarget(target, context);
        expectTarget = "absent";
      }
      replace = action === "overwrite" && targetFingerprint !== null;
    }

    if (source && !oldSource) throw new CommanderError("not_found", "Source is missing");
    if (oldSource && oldSource.kind !== item.kind) throw new CommanderError("changed_since_plan", "Source type changed");
    const destination = target;
    await context.mark("prepared", { targetPath: destination?.path ?? null, expectTarget: destination ? expectTarget : null });
    const unchanged = (proof: VerifyContext) => this.unchanged(source, sourceFingerprint, destination, expectTarget, proof);

    switch (job.plan.kind) {
      case "delete":
        if (!source || !sourceFingerprint) break;
        return await this.removeSource(source, item.kind, sourceFingerprint, context) ? "done" : "source_retained";
      case "mkdir":
        if (!destination) break;
        await this.makeDirectory(destination, oldTarget, replace, context, unchanged, sourceFingerprint);
        return "done";
      case "rename":
      case "move":
        if (!source || !destination || !sourceFingerprint) break;
        if (sameEndpoint && !expandedDirectory) {
          await context.mark("prepared", { via: "rename" });
          let renamed = false;
          try {
            await mutate(() => source.provider.rename(source.path, destination.path, { replace, expectTarget }, signal), unchanged);
            renamed = true;
          } catch (error) {
            const code = safeError(error).code;
            if (code === "changed_since_plan" || code === "already_exists") {
              throw new ItemConflict("target_changed", sourceFingerprint, fingerprint(await observe(destination, context)));
            }
            if (job.plan.kind !== "move" || code !== "unsupported") throw error;
          }
          if (renamed) {
            const probe = () => observe(destination, context, Boolean(sourceFingerprint.sha256));
            const entry = await probe().catch(async () => {
              if (!signal.aborted) return null;
              const { jobId, itemIndex } = context.saved();
              const check = this.context(jobId, itemIndex, new AbortController().signal);
              return observe(destination, check, Boolean(sourceFingerprint.sha256)).catch(() => null);
            });
            if (entry?.kind !== item.kind || !matches(entry, sourceFingerprint)) {
              throw new CommanderError("outcome_unknown", "Renamed destination could not be confirmed");
            }
            await context.mark("verified", {
              bytesDone: item.kind === "file" ? entry.size : "0", committed: fingerprint(entry)!,
              verified: entry.sha256 ? { size: entry.size, sha256: entry.sha256 } : { size: entry.size },
            });
            return "done";
          }
        }
        if (job.plan.kind === "rename") throw new CommanderError("unsupported", "Cannot rename across endpoints");
        if (item.kind === "dir") {
          await context.mark("prepared", { via: "copy" });
          await this.makeDirectory(destination, oldTarget, replace, context, unchanged, sourceFingerprint);
          const committed = fingerprint(await observe(destination, context));
          if (!committed) throw new CommanderError("outcome_unknown", "Destination directory could not be confirmed");
          await context.mark("verified", { committed, verified: { size: committed.size } });
          return { source, target: destination };
        }
        await this.copy(item, source, destination, sourceFingerprint, replace, expectTarget, job.plan, context, unchanged);
        const result = await this.finishMove(source, destination, sourceFingerprint, context);
        return result === "removed" ? "done" : result;
      case "copy":
        if (!source || !destination || !sourceFingerprint) break;
        await this.copy(item, source, destination, sourceFingerprint, replace, expectTarget, job.plan, context, unchanged);
        return "done";
    }
    throw new CommanderError("invalid_path", "Plan item is missing an endpoint");
  }

  private async unchanged(
    source: Location | null, sourceVersion: Fingerprint | null, target: Location | null,
    targetVersion: Fingerprint | "absent", context: VerifyContext,
  ): Promise<boolean> {
    const from = source && await observe(source, context, Boolean(sourceVersion?.sha256));
    const to = target && await observe(target, context, targetVersion !== "absent" && Boolean(targetVersion.sha256));
    return matches(from, sourceVersion) && matchesTarget(to, targetVersion);
  }

  private blockedParent(job: OperationJob, index: number, target: Location): boolean {
    const endpoint = target.provider.endpoint;
    return job.plan.items.slice(0, index).some((item, i) => {
      const outcome = job.items[i].outcome;
      return item.kind === "dir" && item.target?.endpoint === endpoint.id
        && outcome !== "done" && outcome !== "pending"
        && item.target.path.segments.length < target.path.segments.length
        && isAncestorOrSelf(item.target.path, target.path, endpoint.caseSensitive);
    });
  }

  private async finishDirectory(
    job: OperationJob, { source, target }: PreparedDirectory, context: ItemContext,
  ): Promise<boolean> {
    for (const [index, child] of job.plan.items.entries()) {
      if (job.items[index].outcome !== "done" || child.source?.endpoint !== source.provider.endpoint.id
          || child.source.path.segments.length <= source.path.segments.length
          || !isAncestorOrSelf(source.path, child.source.path, source.provider.endpoint.caseSensitive)) continue;
      const checkpoint = await this.store.lastCheckpoint(job.id, index);
      const destination = checkpoint && this.recoveredTarget(child, checkpoint);
      if (!checkpoint || !destination || !await confirmVerified(destination, checkpoint, child.kind, context)) {
        throw new CommanderError("outcome_unknown", "A completed child's destination could not be verified; source directory retained");
      }
    }
    const destination = await observe(target, context);
    if (destination?.kind !== "dir") throw new CommanderError("changed_since_plan", "Destination directory changed");
    const entry = await observe(source, context);
    if (entry?.kind !== "dir") return false;
    const committed = fingerprint(destination)!;
    await context.mark("verified", { committed, verified: { size: committed.size } });
    if (!await this.removeSource(source, "dir", fingerprint(entry)!, context, target)) return false;
    await context.mark("source_removed");
    return true;
  }

  private policy(
    plan: OperationPlan, reason: Conflict["reason"], source: Fingerprint | null, target: Fingerprint | null,
  ): ConflictAction | "ask" {
    if (reason !== "exists") return "ask";
    if (plan.conflictPolicy !== "overwriteIfNewer") return plan.conflictPolicy;
    if (source?.mtimeNs == null || target?.mtimeNs == null) return "ask";
    return BigInt(source.mtimeNs) > BigInt(target.mtimeNs) ? "overwrite" : "skip";
  }

  private async freeTarget(target: Location, { signal, call }: VerifyContext): Promise<Location> {
    const dir = parent(target.path);
    const name = target.path.segments.at(-1);
    if (!dir || !name) throw new CommanderError("invalid_path", "Cannot rename root");
    for (let number = 2; number <= 100_000; number++) {
      const suffix = " (" + number + ")";
      const value = "b" in name ? atob(name.b) : name.t;
      const dot = value.indexOf(".", 1);
      const suffixed = dot < 0 ? value + suffix : value.slice(0, dot) + suffix + value.slice(dot);
      const candidate = "b" in name ? { b: btoa(suffixed) } : { t: suffixed };
      const path = join(dir, candidate);
      if (!await call(() => target.provider.stat(path, signal))) return { ...target, path };
    }
    throw new CommanderError("limit_exceeded", "No available destination name");
  }

  private async makeDirectory(
    target: Location, old: Entry | null, replace: boolean, context: ItemContext,
    unchanged: (proof: VerifyContext) => Promise<boolean>, sourceVersion: Fingerprint | null = null,
  ): Promise<void> {
    if (replace && old?.kind === "dir") return;
    try {
      await context.mutate(() => target.provider.mkdir(target.path, context.signal), unchanged);
    } catch (error) {
      if (safeError(error).code === "already_exists") {
        throw new ItemConflict("target_changed", sourceVersion, fingerprint(await observe(target, context)));
      }
      throw error;
    }
  }

  private async copy(
    item: PlanItem, source: Location, target: Location, expected: Fingerprint,
    replace: boolean, expectTarget: Fingerprint | "absent", plan: OperationPlan, context: ItemContext,
    unchanged: (proof: VerifyContext) => Promise<boolean>,
  ): Promise<void> {
    const { signal, call, mark, mutate } = context;
    await mark("prepared", { via: "copy" });
    if (item.kind === "dir" && plan.kind === "copy") {
      const entry = await observe(target, context);
      await this.makeDirectory(target, entry, replace, context, unchanged, expected);
      return;
    }
    if (item.kind !== "file") throw new CommanderError("unsupported", "Provider cannot transfer this entry kind");
    const { provider, path } = target;
    const confirmSource = async () => {
      const actual = fingerprint(await observe(source, context, Boolean(expected.sha256)));
      if (!matches(actual, expected)) {
        throw new ItemConflict("source_changed", actual, expectTarget === "absent" ? null : expectTarget);
      }
    };
    await confirmSource();
    const commitTarget = async (action: () => Promise<Fingerprint>) => {
      try {
        return await mutate(action, unchanged);
      } catch (error) {
        const code = safeError(error).code;
        if (code === "changed_since_plan" || code === "already_exists") {
          throw new ItemConflict("target_changed", expected, fingerprint(await observe(target, context)));
        }
        throw error;
      }
    };
    let committed: Fingerprint;
    let sourceHash: string | undefined;
    const verify = expected.sha256 ? "sha256" : plan.verify;
    if (source.provider.endpoint.id === provider.endpoint.id && provider.copyWithin) {
      committed = await commitTarget(() => provider.copyWithin!(source.path, path, { replace, expectTarget }, signal));
    } else {
      const { jobId, itemIndex } = context.saved();
      const tempName = tempNameFor(jobId, itemIndex);
      const dir = parent(path);
      if (!dir) throw new CommanderError("invalid_path", "Cannot write root");
      const tempPath = join(dir, tempName);
      const sensitive = provider.endpoint.caseSensitive;
      if (samePath(tempPath, path, sensitive)
          || (source.provider.endpoint.id === provider.endpoint.id && samePath(tempPath, source.path, sensitive))) {
        throw new CommanderError("invalid_path", "Temporary path overlaps an operation endpoint");
      }
      const temp = { provider, path: tempPath };
      await mark("prepared", { tempPath });
      let session: WriteSession;
      signal.throwIfAborted();
      try {
        session = await provider.openWrite(path, { tempName }, signal);
      } catch (error) {
        const failure = safeError(error);
        if (failure.code === "already_exists") {
          await mark("prepared", { tempPath: null });
          throw new CommanderError("outcome_unknown", "Temporary path already belongs to another entry");
        }
        if (failure.retryable || signal.aborted || failure.code === "outcome_unknown") {
          const check = this.context(jobId, itemIndex, new AbortController().signal);
          await removeStagedTemp(temp, check);
          if (failure.code !== "outcome_unknown" && !await unchanged(check).catch(() => false)) {
            throw new CommanderError("outcome_unknown", "Mutation state after openWrite could not be confirmed");
          }
        }
        throw error;
      }
      if (!samePath(session.tempPath, tempPath, sensitive)) {
        throw new CommanderError("outcome_unknown", "Provider returned an unexpected temporary path");
      }
      const recordTemp = async (bytesDone: string) => {
        // Buffered providers may show less than was acknowledged, never more.
        const entry = await observe(temp, context);
        if (entry?.kind !== "file" || toBig(entry.size) > toBig(bytesDone)) {
          throw new CommanderError("outcome_unknown", "Temporary file did not match the acknowledged write");
        }
        await mark("copying", { bytesDone, tempFingerprint: fingerprint(entry)!, writing: undefined });
      };
      try {
        await recordTemp("0");
        const hash = verify === "sha256" ? new TransferHash() : null;
        try {
          await readChunks(source, expected, this.chunkBytes, signal, call, async (bytes, offset) => {
            await mark("copying", { writing: { offset: fromBig(offset), length: bytes.length } });
            await call(async () => {
              try {
                await session.write(offset, bytes, signal);
              } catch (error) {
                if (safeError(error).code === "already_exists") {
                  throw new CommanderError("outcome_unknown", "Write reported an unexpected temporary file collision");
                }
                throw error;
              }
            });
            hash?.update(bytes);
            const bytesDone = offset + BigInt(bytes.length);
            await recordTemp(fromBig(bytesDone));
            await context.progress(bytesDone);
          });
        } catch (error) {
          if (safeError(error).code === "changed_since_plan") await confirmSource();
          throw error;
        }
        sourceHash = hash?.finish();
        if (expected.sha256 && sourceHash !== expected.sha256) {
          throw new ItemConflict("source_changed", { ...expected, sha256: sourceHash }, expectTarget === "absent" ? null : expectTarget);
        }
        await confirmSource();
        committed = await commitTarget(() => session.commit({ replace, expectTarget: expectTarget === "absent" ? null : expectTarget }, signal));
      } catch (error) {
        if (safeError(error).code === "outcome_unknown") throw error;
        try {
          await session.abort();
        } catch {
          throw new CommanderError("outcome_unknown", "Temporary file cleanup could not be confirmed");
        }
        throw error;
      }
    }
    try {
      await mark("committed", { committed, bytesDone: expected.size, tempPath: null, tempFingerprint: undefined });
      const verified = await verifyCopy(source, target, expected, verify, context, sourceHash ?? expected.sha256, committed);
      await mark("verified", { verified });
    } catch (error) {
      if (signal.aborted) throw new CommanderError("outcome_unknown", "Cancellation interrupted a committed item");
      if (safeError(error).code === "changed_since_plan") {
        throw new CommanderError("internal", "Destination verification failed");
      }
      throw error;
    }
  }

  private async removeSource(
    source: Location, kind: PlanItem["kind"], expect: Fingerprint, context: ItemContext, target: Location | null = null,
  ): Promise<boolean> {
    const { mutate, signal } = context;
    try {
      await mutate(() => source.provider.remove(source.path, { kind, expect }, signal),
        (check) => this.unchanged(source, expect, target, context.saved().committed ?? "absent", check));
      return true;
    } catch (error) {
      const code = safeError(error).code;
      if (code === "changed_since_plan" || (target && signal.aborted && code === "cancelled")) return false;
      throw error;
    }
  }

  private async finishMove(source: Location, target: Location, expected: Fingerprint, context: ItemContext): Promise<MoveFinish> {
    const checkpoint = context.saved();
    const sha256 = checkpoint.verified?.sha256;
    const version = sha256 ? { ...expected, sha256 } : expected;
    const confirm = (check: VerifyContext) => confirmVerified(target, checkpoint, "file", check);
    const missing = () => new CommanderError("outcome_unknown", "Verified destination was lost or replaced; source retained");

    const confirmCancellation = async (): Promise<MoveFinish> => {
      const check = this.context(checkpoint.jobId, checkpoint.itemIndex, new AbortController().signal);
      if (!await confirm(check).catch(() => false)) throw missing();
      const sourceEntry = await observe(source, check, Boolean(version.sha256)).catch(() => null);
      if (!sourceEntry) throw new CommanderError("outcome_unknown", "Move source could not be confirmed after cancellation");
      return matches(sourceEntry, version) ? "move_cancelled" : "source_retained";
    };
    let verified: boolean;
    try {
      verified = await confirm(context);
    } catch (error) {
      if (context.signal.aborted) return confirmCancellation();
      throw error;
    }
    if (!verified) throw missing();
    if (!await this.removeSource(source, "file", version, context, target)) {
      return context.signal.aborted ? confirmCancellation() : "source_retained";
    }
    await context.mark("source_removed");
    return "removed";
  }

  private context(
    jobId: string, itemIndex: number, signal: AbortSignal,
    progress: ItemContext["progress"] = async () => {},
  ): ItemContext {
    let checkpoint: Checkpoint = {
      jobId, itemIndex, phase: "prepared", bytesDone: "0",
      tempPath: null, targetPath: null, expectTarget: null, verified: null,
    };
    return {
      signal, chunkBytes: this.chunkBytes, progress,
      call: async <T>(call: () => Promise<T>) => {
        for (let attempt = 1; ; attempt++) {
          signal.throwIfAborted();
          try {
            return await call();
          } catch (error) {
            if (!isCommanderError(error) || !error.retryable || error.code === "outcome_unknown" || attempt === 3) throw error;
            await (this.deps.retryDelay ?? wait)(100 * attempt, signal);
          }
        }
      },
      load: (saved) => { checkpoint = saved; },
      saved: () => checkpoint,
      mark: async (phase, fields) => {
        checkpoint = { ...checkpoint, ...fields, phase };
        await this.store.checkpoint(checkpoint);
      },
      mutate: async (action, unchanged) => {
        signal.throwIfAborted();
        try {
          return await action();
        } catch (error) {
          const failure = safeError(error);
          if (!signal.aborted && !failure.retryable && failure.code !== "outcome_unknown") throw error;
          const check = this.context(jobId, itemIndex, new AbortController().signal);
          const untouched = await unchanged(check).catch(() => false);
          if (untouched && failure.code !== "outcome_unknown") throw error;
          throw new CommanderError("outcome_unknown", "Mutation outcome could not be confirmed");
        }
      },
    };
  }

  private location(ref: ResourceRef): Location {
    const provider = this.deps.provider(ref.endpoint);
    if (provider.endpoint.id !== ref.endpoint) throw new CommanderError("internal", "Provider endpoint mismatch");
    return { provider, path: ref.path };
  }

  private itemBytes(job: OperationJob, index: number, outcome: ItemOutcome): bigint {
    const item = job.plan.items[index];
    return outcome === "done" && item.kind === "file" && item.fingerprint ? toBig(item.fingerprint.size) : 0n;
  }

  private progress(job: OperationJob, bytes: bigint): OperationJob["progress"] {
    const total = toBig(job.progress.bytesTotal);
    return { ...job.progress, bytesDone: fromBig(bytes < total ? bytes : total) };
  }

  private async reportBytes(job: OperationJob, bytes: bigint): Promise<void> {
    const updated = this.progress(job, toBig(job.progress.bytesDone) + bytes);
    await this.patch(job, { progress: updated }, "progress");
  }

  private async record(
    job: OperationJob, index: number, outcome: ItemOutcome, error?: CommanderError,
    baseline = job.progress.bytesDone, warning?: string,
  ): Promise<void> {
    if (job.state !== "running" && job.state !== "cancel_requested" && job.state !== "interrupted") return;
    const items = job.items.slice();
    items[index] = { outcome, error: warning ?? error?.toShape().message ?? null };
    const progress = {
      ...this.progress(job, toBig(baseline) + this.itemBytes(job, index, outcome)),
      itemsDone: job.progress.itemsDone + 1,
    };
    const patch = { items, progress, currentItem: null, error: error?.toShape() ?? job.error };
    const update = (current: OperationJob) => outcome !== "unknown" ? this.patch(current, patch, "progress")
      : this.change(current, current.state === "interrupted" ? "reconciled_unknown" : "outcome_unknown", patch);
    if (!await update(job) && job.state === "running") {
      const current = await this.requireJob(job.id);
      if (current.state === "cancel_requested") await update(current);
    }
  }

  private async finishCancel(id: string): Promise<void> {
    const job = await this.requireJob(id);
    if (job.state === "cancel_requested") await this.change(job, "cancel_done", { currentItem: null });
    this.decisions.delete(id);
    this.rules.delete(id);
  }

  private async requireJob(id: string): Promise<OperationJob> {
    const job = await this.store.get(id);
    if (!job) throw new CommanderError("not_found", "Job not found");
    return job;
  }

  private change(job: OperationJob, event: JobEvent, patch?: Patch, kind: EventKind = "state"): Promise<boolean> {
    const state = transition(job.state, event);
    return this.patch(job, { awaitsOwner: false, pendingConflict: null, ...patch, state }, kind);
  }

  private async patch(job: OperationJob, patch: Patch, kind: EventKind): Promise<boolean> {
    if (!await this.store.update(job.id, { ...patch, updatedAt: this.deps.now().toISOString() }, job.state)) return false;
    this.deps.onEvent({ jobId: job.id, kind });
    return true;
  }
}
