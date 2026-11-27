import { CommanderError, isCommanderError } from "./errors.ts";
import { transition, type JobEvent } from "./job-machine.ts";
import type { Checkpoint, JobStore } from "./job-store.ts";
import {
  ConflictDecision, OperationJob, OperationPlan, planDigest,
  type Conflict, type ConflictAction, type EndpointId, type Entry,
  type Fingerprint, type ItemOutcome, type PlanItem, type ResourceRef,
} from "./model.ts";
import { isAncestorOrSelf, join, parent, samePath } from "./path.ts";
import { READ_CHUNK_MAX, type FileProvider } from "./provider.ts";
import {
  fingerprint, matches, readChunks, reconcileCopy, TransferHash, verifyCopy,
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
  onEvent(e: { jobId: string; kind: "progress" | "state" | "conflict" }): void;
}

type Patch = Parameters<JobStore["update"]>[1];
type EventKind = Parameters<RunnerDeps["onEvent"]>[0]["kind"];
type Decision = { conflict: Conflict; action: ConflictAction };
type PreparedDirectory = { source: Location; target: Location };
type Run = {
  controller: AbortController;
  done: Promise<void>;
};
type ItemContext = VerifyContext & {
  progress(bytes: bigint): Promise<void>;
  mark(phase: Checkpoint["phase"], bytesDone: string, tempPath?: Checkpoint["tempPath"]): Promise<void>;
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
  private readonly decisions = new Map<string, Decision>();
  private readonly rules = new Map<string, Map<Conflict["reason"], ConflictAction>>();
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
    await this.validPlan(job.plan);
    const { call, signal } = this.context(id, 0, new AbortController().signal);
    for (const item of job.plan.items) {
      if (!item.source) continue;
      const { provider, path } = this.location(item.source);
      const current = await call(() => provider.stat(path, signal));
      if (!current || current.kind !== item.kind || !matches(current, item.fingerprint)) {
        throw new CommanderError("changed_since_plan", "Plan source changed before approval");
      }
    }
    if (!await this.start(job)) throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
  }

  async reject(id: string): Promise<void> {
    const job = await this.requireJob(id);
    if (job.state !== "pending" || !job.awaitsOwner) {
      throw new CommanderError("changed_since_plan", "Job is no longer awaiting approval");
    }
    if (await this.change(job, "cancel")) await this.finishCancel(id);
  }

  async decide(id: string, input: ConflictDecision): Promise<void> {
    const decision = ConflictDecision.parse(input);
    const job = await this.requireJob(id);
    const conflict = job.pendingConflict;
    if (job.state !== "awaiting_decision" || conflict?.id !== decision.conflictId) {
      throw new CommanderError("changed_since_plan", "Conflict is no longer current");
    }
    if (decision.action === "cancel") {
      if (await this.change(job, "cancel")) await this.finishCancel(id);
      return;
    }
    if (!await this.change(job, "decide")) throw new CommanderError("changed_since_plan", "Conflict is no longer current");
    this.decisions.set(id, { conflict, action: decision.action });
    if (decision.applyTo === "remaining_same_reason") {
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
    run?.controller.abort(new CommanderError("cancelled", "Job cancelled"));
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
      if (job.state !== "interrupted" && !await this.change(job, "process_lost")) continue;
      let interrupted = await this.requireJob(job.id);
      const completedBytes = interrupted.items.reduce((bytes, item, index) =>
        bytes + this.itemBytes(interrupted, index, item.outcome), 0n);
      const progress = this.progress(interrupted, completedBytes);
      await this.patch(interrupted, { progress }, "progress");
      interrupted = { ...interrupted, progress };
      const index = interrupted.currentItem;
      try {
        if (index !== null && interrupted.items[index].outcome === "pending" && job.state !== "awaiting_decision") {
          const item = interrupted.plan.items[index];
          const checkpoint = await this.store.lastCheckpoint(job.id, index);
          if (!checkpoint || !item.source || !item.target || !item.fingerprint) {
            throw new CommanderError("outcome_unknown", "Job has no recoverable checkpoint");
          }
          const source = this.location(item.source);
          const target = this.location(item.target);
          const context = this.context(job.id, index, new AbortController().signal);
          const outcome = await reconcileCopy(checkpoint, source, target, item.fingerprint, job.plan, context);
          if (outcome === "done") {
            if (job.plan.kind === "move" && checkpoint.phase !== "source_removed") {
              await this.finishMove(source, item.fingerprint, context);
            }
            await this.record(interrupted, index, "done");
          }
        }
      } catch {
        const latest = await this.requireJob(job.id);
        const error = new CommanderError("outcome_unknown", "Interrupted job outcome could not be confirmed");
        if (index !== null) await this.record(latest, index, "unknown", error);
        await this.change(await this.requireJob(job.id), "reconciled_unknown", { error: error.toShape(), currentItem: null });
        result.unknown.push(job.id);
        continue;
      }
      if (await this.change(await this.requireJob(job.id), "resume")) {
        if (job.state === "awaiting_decision" && job.pendingConflict) {
          await this.change(await this.requireJob(job.id), "conflict", {
            pendingConflict: job.pendingConflict,
          }, "conflict");
        } else {
          this.launch(job.id);
        }
        result.resumed.push(job.id);
      }
    }
    return result;
  }

  private async validPlan(input: OperationPlan): Promise<OperationPlan> {
    const plan = OperationPlan.parse(input);
    const { digest, ...unsigned } = plan;
    if (digest !== await planDigest(unsigned)) throw new CommanderError("changed_since_plan", "Plan digest changed");
    return plan;
  }

  private async start(job: OperationJob): Promise<boolean> {
    if (!await this.change(job, "start")) return false;
    this.launch(job.id);
    return true;
  }

  private launch(id: string): void {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(id, controller.signal))
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

  private async execute(id: string, signal: AbortSignal): Promise<void> {
    let next = 0;
    const prepared = this.directories.get(id) ?? new Map<number, PreparedDirectory>();
    this.directories.set(id, prepared);
    const deferred: number[] = [...prepared.keys()];
    try {
      for (;;) {
        const job = await this.requireJob(id);
        if (job.state !== "running") return;
        while (next < job.items.length && (job.items[next].outcome !== "pending" || prepared.has(next))) next++;
        const index = next < job.items.length ? next : deferred.pop() ?? -1;
        if (index === -1) {
          await this.change(job, job.items.some(({ outcome }) => outcome === "failed" || outcome === "unknown") ? "fail" : "all_done",
            { currentItem: null });
          return;
        }
        if (!await this.patch(job, { currentItem: index }, "progress")) return;
        const decision = this.decisions.get(id);
        this.decisions.delete(id);
        try {
          const report = (bytes: bigint) => this.reportBytes(job, bytes);
          const context = this.context(id, index, signal, report);
          const directory = prepared.get(index);
          if (directory) {
            await this.finishDirectory(directory, context);
            await this.record(await this.requireJob(id), index, "done");
          } else {
            const outcome = await this.perform(job, index, context, decision);
            if (typeof outcome === "string") {
              await this.record(await this.requireJob(id), index, outcome, undefined, job.progress.bytesDone);
            } else {
              prepared.set(index, outcome);
              deferred.push(index);
              await this.patch(job, { currentItem: null }, "progress");
            }
          }
        } catch (caught) {
          const current = await this.requireJob(id);
          if (caught instanceof ItemConflict && current.state === "running") {
            await this.change(current, "conflict", {
              progress: this.progress(current, toBig(job.progress.bytesDone)),
              pendingConflict: {
                id: this.deps.uuid(), jobId: id, itemIndex: index,
                reason: caught.reason, source: caught.source, target: caught.target,
              },
            }, "conflict");
            return;
          }
          let error = safeError(caught);
          const cancelled = signal.aborted || current.state === "cancel_requested";
          if (cancelled && error.code !== "outcome_unknown") {
            const checkpoint = await this.store.lastCheckpoint(id, index);
            if (checkpoint && checkpoint.phase !== "copying") {
              error = new CommanderError("outcome_unknown", "Cancellation interrupted a committed item");
            }
          }
          if (error.code === "outcome_unknown") {
            await this.record(current, index, "unknown", error, job.progress.bytesDone);
          } else if (!cancelled) {
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
        this.directories.delete(id);
      }
    }
  }

  private async perform(job: OperationJob, index: number, context: ItemContext, decision?: Decision): Promise<"done" | "skipped" | PreparedDirectory> {
    const item = job.plan.items[index];
    const source = item.source && this.location(item.source);
    let target = item.target && this.location(item.target);
    const { signal, call } = context;
    const following = job.plan.items[index + 1]?.source;
    const expandedDirectory = item.kind === "dir" && item.source && following
      && item.source.endpoint === following.endpoint && item.source.path.segments.length < following.path.segments.length
      && isAncestorOrSelf(item.source.path, following.path, source!.provider.endpoint.caseSensitive);
    if (target && (job.plan.kind === "copy" || job.plan.kind === "move") && this.blockedParent(job, index, target)) {
      return "skipped";
    }
    const oldSource = source && await call(() => source.provider.stat(source.path, signal));
    const destination = target;
    const oldTarget = destination && await call(() => destination.provider.stat(destination.path, signal));
    const sourceFingerprint = fingerprint(oldSource);
    const targetFingerprint = fingerprint(oldTarget);
    const sameEndpoint = source && target && source.provider.endpoint.id === target.provider.endpoint.id;
    if (source && target && sameEndpoint && isAncestorOrSelf(source.path, target.path, source.provider.endpoint.caseSensitive)) {
      throw new CommanderError("invalid_path", "Destination overlaps source");
    }
    const changed = source && (!oldSource || oldSource.kind !== item.kind || !matches(sourceFingerprint, item.fingerprint));
    const reason = changed ? "source_changed" : oldTarget
      ? (oldTarget.kind === item.kind ? "exists" : "type_mismatch") : null;
    let replace = false;
    let expectTarget = targetFingerprint;
    if (decision && decision.conflict.itemIndex === index) {
      if (decision.action === "skip") return "skipped";
      if (!matches(decision.conflict.source, sourceFingerprint)) {
        throw new ItemConflict("source_changed", sourceFingerprint, targetFingerprint);
      }
      if (!matches(decision.conflict.target, targetFingerprint)) {
        throw new ItemConflict("target_changed", sourceFingerprint, targetFingerprint);
      }
      replace = decision.action === "overwrite" && targetFingerprint !== null;
      expectTarget = decision.conflict.target;
      if (decision.action === "rename" && target) {
        if (expandedDirectory) throw new CommanderError("unsupported", "Renaming an expanded destination requires a new plan");
        target = await this.freeTarget(target, context);
      }
    } else if (reason) {
      const saved = this.rules.get(job.id)?.get(reason);
      const action = saved ?? this.policy(job.plan, reason, sourceFingerprint, targetFingerprint);
      if (action === "ask") throw new ItemConflict(reason, sourceFingerprint, targetFingerprint);
      if (action === "skip") return "skipped";
      if (action === "rename" && target) {
        if (expandedDirectory) throw new CommanderError("unsupported", "Renaming an expanded destination requires a new plan");
        target = await this.freeTarget(target, context);
      }
      replace = action === "overwrite" && targetFingerprint !== null;
    }

    if (target && destination && !samePath(target.path, destination.path, target.provider.endpoint.caseSensitive)) {
      // The checkpoint schema identifies the planned target only. A new name
      // chosen during conflict resolution must never be recovered as that target.
      const mark = context.mark;
      context = {
        ...context,
        mark: (phase, bytes) => phase === "copying" ? mark(phase, bytes) : Promise.resolve(),
      };
    }
    if (source && !oldSource) throw new CommanderError("not_found", "Source is missing");
    if (oldSource && oldSource.kind !== item.kind) throw new CommanderError("changed_since_plan", "Source type changed");

    try {
      switch (job.plan.kind) {
        case "delete":
          if (!source) break;
          await call(() => source.provider.remove(source.path, { kind: item.kind }, signal));
          return "done";
        case "mkdir":
          if (!target) break;
          await this.makeDirectory(target, oldTarget, replace, context);
          return "done";
        case "rename":
        case "move":
          if (!source || !target || !sourceFingerprint) break;
          if (sameEndpoint && !replace && !expandedDirectory) {
            const to = target;
            try {
              await call(() => source.provider.rename(source.path, to.path, { replace: false }, signal));
              return "done";
            } catch (error) {
              if (job.plan.kind !== "move" || safeError(error).code !== "unsupported") throw error;
            }
          }
          if (job.plan.kind === "rename") {
            throw new CommanderError("unsupported", "Provider rename cannot check a replacement fingerprint");
          }
          if (item.kind === "dir") {
            await this.makeDirectory(target, oldTarget, replace, context);
            await context.mark("verified", "0");
            return { source, target };
          }
          await this.copy(item, source, target, sourceFingerprint, replace, expectTarget, job.plan, context);
          await this.finishMove(source, sourceFingerprint, context);
          return "done";
        case "copy":
          if (!source || !target || !sourceFingerprint) break;
          await this.copy(item, source, target, sourceFingerprint, replace, expectTarget, job.plan, context);
          return "done";
      }
    } catch (error) {
      if (error instanceof ItemConflict) throw error;
      if (safeError(error).code === "already_exists" && target) {
        const to = target;
        throw new ItemConflict("target_changed", sourceFingerprint, fingerprint(await call(() => to.provider.stat(to.path, signal))));
      }
      throw error;
    }
    throw new CommanderError("invalid_path", "Plan item is missing an endpoint");
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

  private async finishDirectory({ source, target }: PreparedDirectory, context: ItemContext): Promise<void> {
    const { signal, call, mark } = context;
    const destination = await call(() => target.provider.stat(target.path, signal));
    if (destination?.kind !== "dir") throw new CommanderError("changed_since_plan", "Destination directory changed");
    await call(() => source.provider.remove(source.path, { kind: "dir" }, signal));
    await mark("source_removed", "0");
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

  private async makeDirectory(target: Location, old: Entry | null, replace: boolean, { call, signal }: ItemContext): Promise<void> {
    if (replace && old?.kind === "dir") return;
    await call(() => target.provider.mkdir(target.path, signal));
  }

  private async copy(
    item: PlanItem, source: Location, target: Location, expected: Fingerprint,
    replace: boolean, expectTarget: Fingerprint | null, plan: OperationPlan, context: ItemContext,
  ): Promise<void> {
    const { signal, call, mark } = context;
    if (item.kind === "dir" && plan.kind === "copy") {
      const entry = await call(() => target.provider.stat(target.path, signal));
      await this.makeDirectory(target, entry, replace, context);
      return;
    }
    if (item.kind !== "file") throw new CommanderError("unsupported", "Provider cannot transfer this entry kind");
    const { provider, path } = target;
    const sourceStat = await call(() => source.provider.stat(source.path, signal));
    if (!sourceStat || !matches(sourceStat, expected)) throw new ItemConflict("source_changed", fingerprint(sourceStat), expectTarget);
    let committed: Fingerprint;
    let sourceHash: string | undefined;
    try {
      if (source.provider.endpoint.id === provider.endpoint.id && provider.copyWithin) {
        await mark("copying", "0");
        committed = await call(() => provider.copyWithin!(source.path, path, {
          replace, expectTarget: replace ? expectTarget ?? "absent" : "absent",
        }, signal));
      } else {
        const session = await call(() => provider.openWrite(path, signal));
        try {
          const tempPath = session.tempPath;
          await mark("copying", "0", tempPath);
          const hash = plan.verify === "sha256" ? new TransferHash() : null;
          let bytesDone = 0n;
          try {
            await readChunks(source, expected, this.chunkBytes, signal, call, async (bytes, offset) => {
              await call(() => session.write(offset, bytes, signal));
              hash?.update(bytes);
              bytesDone = offset + BigInt(bytes.length);
              await context.progress(bytesDone);
            });
          } catch (error) {
            if (safeError(error).code === "changed_since_plan") {
              const actual = fingerprint(await call(() => source.provider.stat(source.path, signal)));
              if (!matches(actual, expected)) throw new ItemConflict("source_changed", actual, expectTarget);
            }
            throw error;
          }
          sourceHash = hash?.finish();
          const actual = fingerprint(await call(() => source.provider.stat(source.path, signal)));
          if (!matches(actual, expected)) throw new ItemConflict("source_changed", actual, expectTarget);
          await mark("copying", fromBig(bytesDone), tempPath);
          committed = await call(() => session.commit({ replace, expectTarget: replace ? expectTarget : null }, signal));
        } catch (error) {
          try {
            await session.abort();
          } catch {
            throw new CommanderError("outcome_unknown", "Temporary file cleanup could not be confirmed");
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ItemConflict) throw error;
      const { code } = safeError(error);
      if (code === "changed_since_plan" || code === "already_exists") {
        throw new ItemConflict("target_changed", expected, fingerprint(await call(() => provider.stat(path, signal))));
      }
      throw error;
    }
    try {
      await mark("committed", expected.size);
      await verifyCopy(source, target, expected, plan.verify, context, sourceHash, committed);
      await mark("verified", expected.size);
    } catch (error) {
      if (signal.aborted) throw new CommanderError("outcome_unknown", "Cancellation interrupted a committed item");
      throw error;
    }
  }

  private async finishMove(source: Location, expected: Fingerprint, { call, signal, mark }: ItemContext): Promise<void> {
    const entry = await call(() => source.provider.stat(source.path, signal));
    if (entry?.kind !== "file" || !matches(entry, expected)) {
      throw new CommanderError("changed_since_plan", "Move source changed after verification");
    }
    await call(() => source.provider.remove(source.path, { kind: "file" }, signal));
    await mark("source_removed", expected.size);
  }

  private context(
    jobId: string, itemIndex: number, signal: AbortSignal,
    progress: ItemContext["progress"] = async () => {},
  ): ItemContext {
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
      mark: (phase, bytesDone, tempPath = null) => this.store.checkpoint({
        jobId, itemIndex, phase, bytesDone, tempPath, targetPath: null, expectTarget: null, verified: null,
      }),
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
    baseline = job.progress.bytesDone,
  ): Promise<void> {
    if (job.state !== "running" && job.state !== "cancel_requested" && job.state !== "interrupted") return;
    const items = job.items.slice();
    items[index] = { outcome, error: error?.toShape().message ?? null };
    const progress = {
      ...this.progress(job, toBig(baseline) + this.itemBytes(job, index, outcome)),
      itemsDone: job.progress.itemsDone + 1,
    };
    const patch = { items, progress, currentItem: null, error: error?.toShape() ?? job.error };
    if (!await this.patch(job, patch, "progress") && job.state === "running") {
      const current = await this.requireJob(job.id);
      if (current.state === "cancel_requested") await this.patch(current, patch, "progress");
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
