// AI jobs (slice 3f): in memory only, like translation jobs. The owner's
// click starts one (ai_start); the page polls it. At most two run at once,
// each kind has its own hourly rate (AI_RATES), a job has a 5 min cap and is
// cancelled when nobody polled it for 60 s. The model's output is collected
// whole and parsed when the stream ends; the raw output is never kept,
// logged, stored or polled (resolution 13). The result travels only in poll
// answers. A draft job's restore map lives in the job until it ends (done,
// failed, cancelled or swept), then it is dropped (resolution 8).
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_RATES,
  AiError,
  parseAskAnswer,
  parseAskPlan,
  parseCategories,
  parseDigest,
  parseDraft,
  parseSummary,
  parseTasks,
  type AiBuild,
  type AiCategoryAnswer,
  type AiKind,
  type AiParse,
  type AskAnswer,
  type SummaryResult,
  type TaskSuggestion,
} from "../../core/ai-input.ts";
import { parseWrite, removeForeignLinks } from "../../core/ai-write.ts";
import { restoreSecrets } from "../../core/redact.ts";
import { TranslateError, type Translator } from "../../core/translate.ts";
import type { AiErrorKind, Clock } from "../../core/index.ts";

export const AI_JOB_MAX_RUNNING = 2;
export const AI_JOB_MAX_MS = 5 * 60 * 1000;
/** A running job nobody polled for this long is cancelled. */
export const AI_JOB_IDLE_MS = 60 * 1000;
/** A finished job is kept this long after its last poll (Keep tasks reads it). */
export const AI_JOB_KEEP_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type AiPhase = "planning" | "reading" | "writing";

/** The parsed, checked answer of one kind. */
export type AiOutput =
  | { kind: "summary"; value: SummaryResult }
  | { kind: "ask"; value: AskAnswer }
  | { kind: "tasks"; value: { tasks: TaskSuggestion[] } }
  | { kind: "categories"; value: { items: { n: number; category: AiCategoryAnswer }[] } }
  | { kind: "digest"; value: { items: { n: number; gist: string }[] } }
  | { kind: "draft"; value: { paragraphs: string[]; unknown: number; missing: number } }
  /** Write and auto drafts (AI writes mail); `reply` false only for an auto draft that needs no answer. */
  | { kind: "write"; value: { reply: boolean; paragraphs: string[]; linksRemoved: number; unknown: number } };

/** A finished job: the checked answer, the parts the plugin sent (for citations) and the notes. */
export type AiFinished = {
  output: AiOutput;
  parts: AiBuild["parts"];
  notes: { hidden: number; leftOut: number; truncated: number; unreadItems: number };
  provider: string;
  model: string;
  /** ISO 8601. */
  createdAt: string;
};

export type AiJobPoll = {
  state: "running" | "done" | "failed" | "cancelled";
  phase?: AiPhase;
  result?: AiFinished;
  error?: AiErrorKind;
  gatewayMessage?: string;
  provider?: string;
  model?: string;
};

export type AiJobsDeps = {
  translator: Translator;
  clock: Clock;
  newId: () => string;
  log?: (line: string) => void;
  /** Told what a job learned about the gateway: "ok", gateway_missing or pool_unavailable. */
  onGateway?: (state: "ok" | AiErrorKind) => void;
};

/** The second step of Ask: the server's local search over the planned queries, as the answer's input. */
export type AskSearch = (queries: string[], signal: AbortSignal) => Promise<AiBuild> | AiBuild;

export type AiJobContext = {
  /** The owner's settings: "" picks the first available provider or model. */
  provider: string;
  model: string;
  /** Ask only: the local search between the two calls. */
  search?: AskSearch;
  /** Draft only: the restore map's tag; the map itself is `built.restore`. */
  tag?: string;
  /** Draft only: most characters the answer may hold (2x the input). */
  maxChars?: number;
  /** Write and auto drafts: the links the answer may hold (the owner wrote them). */
  allowedLinks?: readonly string[];
  /** Auto drafts: nobody polls this job, so it is not cancelled for lack of polling. */
  unattended?: boolean;
  /** Called once with the finished result (cache a summary, store suggestions). */
  onDone?: (finished: AiFinished) => void;
};

/** A refusal of ai_start with fixed text. */
export class AiJobRefusal extends Error {
  readonly code: "busy" | "rate_limited";
  constructor(code: AiJobRefusal["code"]) {
    super(code === "busy" ? "Two AI requests are already running; try again in a moment" : "Too many AI requests of this kind in the last hour; try again later");
    this.name = "AiJobRefusal";
    this.code = code;
  }
}

type Job = {
  id: string;
  kind: AiKind;
  state: AiJobPoll["state"];
  phase: AiPhase;
  result?: AiFinished;
  error?: AiErrorKind;
  gatewayMessage?: string;
  provider?: string;
  model?: string;
  /** Draft, write and auto draft only, until the job ends. */
  restore: Map<string, string> | null;
  unattended: boolean;
  startedAt: number;
  polledAt: number;
  endedAt: number | null;
  controller: AbortController;
  done: Promise<void>;
};

export class AiJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly starts = new Map<AiKind, number[]>();

  constructor(private readonly deps: AiJobsDeps) {}

  /** Starts a job over input the caller built (redacted, scoped). Throws AiJobRefusal. */
  start(kind: AiKind, built: AiBuild, ctx: AiJobContext): { jobId: string } {
    this.sweep();
    const running = [...this.jobs.values()].filter((j) => j.state === "running");
    if (running.length >= AI_JOB_MAX_RUNNING) throw new AiJobRefusal("busy");
    const now = this.now();
    const starts = this.starts.get(kind) ?? [];
    while (starts.length > 0 && starts[0]! <= now - HOUR_MS) starts.shift();
    if (starts.length >= AI_RATES[kind]) throw new AiJobRefusal("rate_limited");
    starts.push(now);
    this.starts.set(kind, starts);

    const job: Job = {
      id: this.deps.newId(),
      kind,
      state: "running",
      phase: kind === "ask" ? "planning" : "writing",
      restore: kind === "draft" || kind === "write" || kind === "autodraft" ? built.restore ?? new Map() : null,
      unattended: ctx.unattended === true,
      startedAt: now,
      polledAt: now,
      endedAt: null,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    job.done = this.run(job, built, ctx);
    this.deps.log?.(`ai ${kind} ${job.id} started`);
    return { jobId: job.id };
  }

  /** The job's state and, once done, its result; null for an unknown (or forgotten) job. */
  poll(jobId: string): AiJobPoll | null {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (job === undefined) return null;
    job.polledAt = this.now();
    return {
      state: job.state,
      ...(job.state === "running" ? { phase: job.phase } : {}),
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.gatewayMessage === undefined ? {} : { gatewayMessage: job.gatewayMessage }),
      ...(job.provider === undefined ? {} : { provider: job.provider }),
      ...(job.model === undefined ? {} : { model: job.model }),
    };
  }

  /** A finished job of this kind (Keep tasks), else null. */
  finished(jobId: string, kind: AiKind): AiFinished | null {
    const job = this.jobs.get(jobId);
    return job !== undefined && job.kind === kind && job.state === "done" && job.result !== undefined ? job.result : null;
  }

  /** Stops a running job; false when it is not running. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.state !== "running") return false;
    this.stop(job, "cancelled");
    return true;
  }

  /** Cancels jobs over the cap or unpolled, and forgets finished ones nobody polls. */
  sweep(): void {
    const now = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.state === "running") {
        if (!job.unattended && now - job.polledAt >= AI_JOB_IDLE_MS) this.stop(job, "cancelled");
        else if (now - job.startedAt >= AI_JOB_MAX_MS) this.stop(job, "failed");
      } else if (now - Math.max(job.polledAt, job.endedAt ?? 0) >= AI_JOB_KEEP_MS) {
        this.jobs.delete(job.id);
      }
    }
  }

  async dispose(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.state === "running");
    for (const job of running) this.stop(job, "cancelled");
    await Promise.all(running.map((j) => j.done));
    this.jobs.clear();
  }

  /** Resolves when the job has ended (for tests). */
  settled(jobId: string): Promise<void> {
    return this.jobs.get(jobId)?.done ?? Promise.resolve();
  }

  /** Whether the job still holds a restore map (for tests: dropped at every end state). */
  holdsRestore(jobId: string): boolean {
    return (this.jobs.get(jobId)?.restore ?? null) !== null;
  }

  private now(): number {
    return this.deps.clock.now().getTime();
  }

  private end(job: Job): void {
    job.endedAt = this.now();
    job.restore = null;
  }

  private stop(job: Job, state: "cancelled" | "failed"): void {
    job.state = state;
    job.error = state === "failed" ? "failed" : "cancelled";
    this.end(job);
    job.controller.abort();
    this.deps.log?.(`ai ${job.kind} ${job.id} ${state === "failed" ? "timed out" : "cancelled"}`);
  }

  private async run(job: Job, built: AiBuild, ctx: AiJobContext): Promise<void> {
    const signal = job.controller.signal;
    try {
      const { providerId, model } = await this.resolve(ctx, signal);
      job.provider = providerId;
      job.model = model;
      let parts = built.parts;
      let notes = built.notes;
      let output: AiOutput;
      let dropped: number;
      if (job.kind === "ask") {
        const plan = readable(parseAskPlan(await this.call(job, built, AI_MAX_OUTPUT_TOKENS.askPlan, providerId, model)));
        if (job.state !== "running") return;
        job.phase = "reading";
        if (ctx.search === undefined) throw new AiError("failed");
        const answerBuild = await ctx.search(plan.value.queries, signal);
        if (job.state !== "running") return;
        job.phase = "writing";
        parts = answerBuild.parts;
        notes = { ...answerBuild.notes, hidden: answerBuild.notes.hidden + built.notes.hidden };
        const parsed = readable(parseAskAnswer(await this.call(job, answerBuild, AI_MAX_OUTPUT_TOKENS.askAnswer, providerId, model), parts.length));
        output = { kind: "ask", value: parsed.value };
        dropped = plan.dropped + parsed.dropped;
      } else {
        const raw = await this.call(job, built, AI_MAX_OUTPUT_TOKENS[job.kind], providerId, model);
        ({ output, dropped } = this.parse(job, raw, built.parts.length, ctx));
      }
      if (job.state !== "running") return;
      const finished: AiFinished = {
        output,
        parts,
        notes: { ...notes, unreadItems: dropped },
        provider: providerId,
        model,
        createdAt: this.deps.clock.now().toISOString(),
      };
      job.result = finished;
      job.state = "done";
      this.end(job);
      this.deps.onGateway?.("ok");
      this.deps.log?.(`ai ${job.kind} ${job.id} done`);
      try {
        ctx.onDone?.(finished);
      } catch (error) {
        this.deps.log?.(`ai ${job.kind} ${job.id} result not kept (${errorName(error)})`);
      }
    } catch (error) {
      if (job.state !== "running") return;
      const kind: AiErrorKind =
        error instanceof AiError ? error.kind : error instanceof TranslateError ? error.kind : "failed";
      job.state = kind === "cancelled" ? "cancelled" : "failed";
      job.error = kind;
      if (error instanceof TranslateError && error.gatewayMessage !== null) job.gatewayMessage = error.gatewayMessage;
      this.end(job);
      if (kind === "gateway_missing" || kind === "pool_unavailable") this.deps.onGateway?.(kind);
      this.deps.log?.(`ai ${job.kind} ${job.id} failed (${kind})`);
    }
  }

  /** One model call; the output is collected whole. `max_tokens` fails as too_long. */
  private async call(job: Job, built: AiBuild, maxOutputTokens: number, providerId: string, model: string): Promise<string> {
    let output = "";
    const { finish } = await this.deps.translator.translate(
      { providerId, model, instructions: built.instructions, input: built.input, maxOutputTokens },
      (delta) => {
        if (job.state === "running") output += delta;
      },
      job.controller.signal,
    );
    if (finish === "max_tokens") throw new AiError("too_long");
    return output;
  }

  /** The kind's parser over the whole output; a draft's placeholders are restored from the job's map. */
  private parse(job: Job, raw: string, n: number, ctx: AiJobContext): { output: AiOutput; dropped: number } {
    switch (job.kind) {
      case "summary": {
        const parsed = readable(parseSummary(raw, n));
        return { output: { kind: "summary", value: parsed.value }, dropped: parsed.dropped };
      }
      case "tasks": {
        const parsed = readable(parseTasks(raw, n));
        return { output: { kind: "tasks", value: parsed.value }, dropped: parsed.dropped };
      }
      case "categories": {
        const parsed = readable(parseCategories(raw, n));
        return { output: { kind: "categories", value: parsed.value }, dropped: parsed.dropped };
      }
      case "digest": {
        const parsed = readable(parseDigest(raw, n));
        return { output: { kind: "digest", value: parsed.value }, dropped: parsed.dropped };
      }
      case "draft": {
        const parsed = readable(parseDraft(raw, ctx.maxChars ?? Number.MAX_SAFE_INTEGER));
        // Paragraph strings never hold NUL (parseDraft removes controls): one restore over all of them.
        const restored = restoreSecrets(parsed.value.paragraphs.join("\u0000"), job.restore ?? new Map(), ctx.tag ?? "");
        return {
          output: {
            kind: "draft",
            value: {
              paragraphs: parsed.value.paragraphs.length === 0 ? [] : restored.text.split("\u0000"),
              unknown: restored.unknown,
              missing: restored.missing,
            },
          },
          dropped: parsed.dropped,
        };
      }
      case "write":
      case "autodraft": {
        const parsed = readable(parseWrite(raw));
        // A draft for someone else's message never gets the owner's hidden values back: the placeholders stay.
        const restore = job.kind === "write" ? job.restore ?? new Map<string, string>() : new Map<string, string>();
        const restored = restoreSecrets(parsed.value.paragraphs.join("\u0000"), restore, ctx.tag ?? "");
        // Links are judged on the final text, so the owner's own link that held a hidden value compares as written.
        const checked = removeForeignLinks(parsed.value.paragraphs.length === 0 ? [] : restored.text.split("\u0000"), ctx.allowedLinks ?? []);
        return {
          output: {
            kind: "write",
            value: {
              reply: parsed.value.reply,
              paragraphs: checked.paragraphs,
              linksRemoved: checked.removed,
              unknown: job.kind === "write" ? restored.unknown : 0,
            },
          },
          dropped: parsed.dropped,
        };
      }
      case "ask":
        throw new AiError("failed");
    }
  }

  /** "" provider: the first available one; "" model: that provider's first model. */
  private async resolve(ctx: AiJobContext, signal: AbortSignal): Promise<{ providerId: string; model: string }> {
    let providerId = ctx.provider;
    if (providerId === "") {
      const first = (await this.deps.translator.providers(signal)).find((p) => p.available);
      if (first === undefined) throw new TranslateError("provider_unknown");
      providerId = first.id;
    }
    let model = ctx.model;
    if (model === "") {
      const first = (await this.deps.translator.models(providerId, signal))[0];
      if (first === undefined) throw new TranslateError("model_unknown");
      model = first.model;
    }
    return { providerId, model };
  }
}

/** A parse that failed is `unreadable`; the raw output is dropped with it. */
function readable<T>(parsed: AiParse<T>): { value: T; dropped: number } {
  if (!parsed.ok) throw new AiError("unreadable");
  return parsed;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
