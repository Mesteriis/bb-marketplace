// The queue between new mail and the AI job runner for work nobody
// clicked: auto drafts (one message a call) and sorting (ten a call). One
// model call at a time per queue, through the same runner as the owner's
// clicks (the kind's hourly rate there, the daily cap here). A busy runner
// makes the queue wait; a refusal that will repeat (the rate, a missing
// gateway, a refused sign-in, a used-up quota) empties it until new mail
// arrives. A failed call is dropped: one log line, no mail data.
import type { AiBuild } from "../../core/ai-input.ts";
import type { AiErrorKind } from "../../core/index.ts";
import { AI_JOB_MAX_MS, AiJobRefusal, type AiFinished, type AiJobContext, type AiJobs } from "./ai-jobs.ts";

/** How long the queue waits when the job runner is busy. */
export const UNATTENDED_RETRY_MS = 30_000;

/**
 * One unattended call at a time across every queue: the owner's own
 * requests always find a free slot of the job runner's two.
 */
export class UnattendedGate {
  private tail: Promise<void> = Promise.resolve();

  /** Waits its turn; the answer gives the turn back. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => mine);
    await before;
    return release;
  }
}

/** Failures that the next call would meet too. */
const STOPS: ReadonlySet<AiErrorKind> = new Set(["gateway_missing", "pool_unavailable", "provider_unknown", "model_unknown", "auth", "quota"]);

export type UnattendedQueueDeps<Made> = {
  kind: "autodraft" | "sort";
  /** The words of this queue's log lines ("auto draft", "sort"). */
  label: string;
  /** Messages per call. */
  batch: number;
  /** Most messages waiting; past it the oldest waiting ones are dropped. */
  limit: number;
  /** The feature's setting, read before every call. */
  enabled: () => boolean;
  /**
   * The request for the next messages; null when none of them qualifies any
   * more (gone, moved, outside AI access). `ids` are those the request covers.
   */
  build: (ids: readonly string[]) => { built: AiBuild; context: Partial<AiJobContext>; ids: string[]; made: Made } | null;
  jobs: Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  /** The owner's provider and model settings. */
  context: () => { provider: string; model: string };
  /** The finished call's result, to keep. */
  done: (made: Made, finished: AiFinished) => void;
  /** The agent log's row for one call: what was sent, never its text. */
  logCall: (built: AiBuild) => void;
  /** The daily cap. */
  budget: { left(): boolean; take(): boolean };
  /** Shared by the queues of one server: at most one unattended call runs. Absent: this queue alone. */
  gate?: UnattendedGate;
  /** Runs `run` after `ms`; the answer cancels it. */
  schedule: (run: () => void, ms: number) => () => void;
  log: (line: string) => void;
};

export class UnattendedAiQueue<Made> {
  private waiting: string[] = [];
  private running: Promise<void> | null = null;
  private cancelRetry: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: UnattendedQueueDeps<Made>) {}

  /** New messages that qualify, oldest first. */
  offer(ids: readonly string[]): void {
    if (this.disposed || !this.deps.enabled()) return;
    for (const id of ids) if (!this.waiting.includes(id)) this.waiting.push(id);
    if (this.waiting.length > this.deps.limit) this.waiting.splice(0, this.waiting.length - this.deps.limit);
    this.wake();
  }

  /** How many wait (for tests). */
  size(): number {
    return this.waiting.length;
  }

  /** Resolves when nothing runs (for tests). */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  /** Stops taking and starting work. A call already running ends with the job runner (dispose that next). */
  dispose(): void {
    this.disposed = true;
    this.waiting = [];
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  private wake(): void {
    if (this.running !== null || this.disposed) return;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.running = this.pump().finally(() => {
      this.running = null;
      // Offered after the pump saw an empty list and before it ended: not left behind.
      if (this.waiting.length > 0 && this.cancelRetry === null) this.wake();
    });
  }

  private async pump(): Promise<void> {
    const { deps } = this;
    while (this.waiting.length > 0 && !this.disposed) {
      const release = deps.gate === undefined ? () => {} : await deps.gate.acquire();
      try {
        if (!(await this.step())) return;
      } finally {
        release();
      }
    }
  }

  /** One call, start to end; false stops the pump (emptied, or waiting for a free slot). */
  private async step(): Promise<boolean> {
    const { deps } = this;
    if (this.waiting.length === 0 || this.disposed) return false;
    {
      if (!deps.enabled() || !deps.budget.left()) {
        this.waiting = [];
        return false;
      }
      const next = this.waiting.slice(0, deps.batch);
      let made: ReturnType<UnattendedQueueDeps<Made>["build"]>;
      try {
        made = deps.build(next);
      } catch {
        made = null;
      }
      if (made === null) {
        this.waiting.splice(0, next.length);
        return true;
      }
      let jobId: string;
      try {
        ({ jobId } = deps.jobs.start(deps.kind, made.built, { ...deps.context(), ...made.context, unattended: true }));
      } catch (error) {
        if (error instanceof AiJobRefusal && error.code === "busy") {
          // The owner's own requests go first: try again later.
          this.cancelRetry = deps.schedule(() => {
            this.cancelRetry = null;
            this.wake();
          }, UNATTENDED_RETRY_MS);
          return false;
        }
        this.waiting = [];
        deps.log(`${deps.label}: stopped (${error instanceof AiJobRefusal ? error.code : "failed"})`);
        return false;
      }
      this.waiting.splice(0, next.length);
      deps.budget.take();
      deps.logCall(made.built);
      // Nobody polls this job, so nothing else would end a call that never answers.
      const giveUp = deps.schedule(() => deps.jobs.cancel(jobId), AI_JOB_MAX_MS);
      await deps.jobs.settled(jobId);
      giveUp();
      const finished = deps.jobs.finished(jobId, deps.kind);
      if (finished === null) {
        const error = deps.jobs.poll(jobId)?.error ?? "failed";
        deps.log(`${deps.label}: not done (${error})`);
        if (STOPS.has(error)) this.waiting = [];
        return true;
      }
      try {
        deps.done(made.made, finished);
      } catch {
        deps.log(`${deps.label}: not kept`);
      }
      return true;
    }
  }
}
