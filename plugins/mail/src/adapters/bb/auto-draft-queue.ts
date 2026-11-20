// Auto drafts (AI writes mail): the queue between new mail and the AI job
// runner. One model call at a time, through the same runner as the owner's
// clicks (kind `autodraft`, its hourly rate there, the daily cap here).
// A busy runner makes the queue wait; a refusal that will repeat (the rate,
// a missing gateway, a refused sign-in, a used-up quota) empties it until
// new mail arrives. A failed draft is dropped: one log line, no mail data.
import { AUTO_DRAFT_QUEUE, AUTO_DRAFT_RETRY_MS, type DraftBudget, type ReplyDraftRecord } from "../../core/auto-drafts.ts";
import type { WriteBuild } from "../../core/ai-write.ts";
import type { AiErrorKind, Clock } from "../../core/index.ts";
import { AI_JOB_MAX_MS, AiJobRefusal, type AiJobs } from "./ai-jobs.ts";

/** Failures that the next message would meet too. */
const STOPS: ReadonlySet<AiErrorKind> = new Set(["gateway_missing", "pool_unavailable", "provider_unknown", "model_unknown", "auth", "quota"]);

export type AutoDraftQueueDeps = {
  /** The aiAutoDrafts setting, read before every call. */
  enabled: () => boolean;
  /** The request for a message; null when it no longer qualifies (gone, moved, outside AI access). */
  build: (messageId: string) => { built: WriteBuild; tag: string; accountId: string } | null;
  jobs: Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  /** The owner's provider and model settings. */
  context: () => { provider: string; model: string };
  keep: (draft: ReplyDraftRecord) => void;
  /** The agent log's row for one call: what was sent, never its text. */
  logCall: (built: WriteBuild) => void;
  budget: DraftBudget;
  clock: Clock;
  /** Runs `run` after `ms`; the answer cancels it. */
  schedule: (run: () => void, ms: number) => () => void;
  log: (line: string) => void;
};

export class AutoDraftQueue {
  private waiting: string[] = [];
  private running: Promise<void> | null = null;
  private cancelRetry: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: AutoDraftQueueDeps) {}

  /** New messages that qualify, oldest first. Past the limit the oldest waiting ones are dropped. */
  offer(ids: readonly string[]): void {
    if (this.disposed || !this.deps.enabled()) return;
    for (const id of ids) if (!this.waiting.includes(id)) this.waiting.push(id);
    if (this.waiting.length > AUTO_DRAFT_QUEUE) this.waiting.splice(0, this.waiting.length - AUTO_DRAFT_QUEUE);
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
    });
  }

  private async pump(): Promise<void> {
    const { deps } = this;
    while (this.waiting.length > 0 && !this.disposed) {
      if (!deps.enabled() || !deps.budget.left()) {
        this.waiting = [];
        return;
      }
      const messageId = this.waiting[0]!;
      let made: ReturnType<AutoDraftQueueDeps["build"]>;
      try {
        made = deps.build(messageId);
      } catch {
        made = null;
      }
      if (made === null) {
        this.waiting.shift();
        continue;
      }
      let jobId: string;
      try {
        ({ jobId } = deps.jobs.start("autodraft", made.built, {
          ...deps.context(),
          tag: made.tag,
          allowedLinks: made.built.allowedLinks,
          unattended: true,
        }));
      } catch (error) {
        if (error instanceof AiJobRefusal && error.code === "busy") {
          // The owner's own requests go first: try again later.
          this.cancelRetry = deps.schedule(() => {
            this.cancelRetry = null;
            this.wake();
          }, AUTO_DRAFT_RETRY_MS);
          return;
        }
        this.waiting = [];
        deps.log(`auto draft: stopped (${error instanceof AiJobRefusal ? error.code : "failed"})`);
        return;
      }
      this.waiting.shift();
      deps.budget.take();
      deps.logCall(made.built);
      // Nobody polls this job, so nothing else would end a call that never answers.
      const giveUp = deps.schedule(() => deps.jobs.cancel(jobId), AI_JOB_MAX_MS);
      await deps.jobs.settled(jobId);
      giveUp();
      const finished = deps.jobs.finished(jobId, "autodraft");
      if (finished === null) {
        const error = deps.jobs.poll(jobId)?.error ?? "failed";
        deps.log(`auto draft: not written (${error})`);
        if (STOPS.has(error)) this.waiting = [];
        continue;
      }
      const output = finished.output;
      if (output.kind !== "write" || !output.value.reply || output.value.paragraphs.length === 0) continue;
      try {
        deps.keep({
          messageId,
          accountId: made.accountId,
          paragraphs: output.value.paragraphs,
          linksRemoved: output.value.linksRemoved,
          provider: finished.provider,
          model: finished.model,
          createdAt: deps.clock.now().toISOString(),
        });
      } catch {
        deps.log("auto draft: not kept");
      }
    }
  }
}
