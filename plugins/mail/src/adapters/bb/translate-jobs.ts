// Translation jobs (slice 3c): in memory only. The owner's Translate starts
// one; the page polls it for the text since the characters it already shows.
// At most two run at once and one per (message, language); each has a 5 min
// cap, is cancelled when nobody polled it for 60 s, and counts against a
// sliding hourly rate. A finished translation is cached in the store. The
// text travels only in poll answers: never in logs (ids, states and error
// kinds only) or realtime.
import {
  SUPPORTED_LANGUAGES,
  TRANSLATE_MAX_TOKENS,
  TRANSLATE_RATE_PER_HOUR,
  TranslateError,
  buildTranslatePrompt,
  cacheHit,
  sourceHash,
  translationSource,
  type LanguageTag,
  type TranslateErrorKind,
  type TranslateFinish,
  type Translator,
} from "../../core/translate.ts";
import type { Clock, MailStore, TranslationView } from "../../core/index.ts";

export const JOB_MAX_RUNNING = 2;
export const JOB_MAX_MS = 5 * 60 * 1000;
/** A job nobody polled for this long is cancelled; a finished one is forgotten. */
export const JOB_IDLE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type TranslateSettings = { providerId: string; model: string; language: LanguageTag };

export type JobPoll = {
  state: "running" | "done" | "failed" | "cancelled";
  text: string;
  finish?: TranslateFinish;
  truncatedInput?: boolean;
  error?: TranslateErrorKind;
  gatewayMessage?: string;
  provider?: string;
  model?: string;
};

export type TranslateJobsDeps = {
  translator: Translator;
  store: MailStore;
  clock: Clock;
  newId: () => string;
  nonce: () => string;
  log?: (line: string) => void;
  /** Told what a job learned about the gateway: "ok", gateway_missing or pool_unavailable. */
  onGateway?: (state: "ok" | TranslateErrorKind) => void;
};

/** A refusal of translate_start with fixed text. */
export class TranslateJobRefusal extends Error {
  readonly code: "not_found" | "busy" | "rate_limited";
  constructor(code: TranslateJobRefusal["code"]) {
    super(
      code === "not_found"
        ? "Unknown message"
        : code === "busy"
          ? "Two translations are already running; try again in a moment"
          : "Too many translations in the last hour; try again later",
    );
    this.name = "TranslateJobRefusal";
    this.code = code;
  }
}

type Job = {
  id: string;
  key: string;
  state: JobPoll["state"];
  text: string;
  finish?: TranslateFinish;
  error?: TranslateErrorKind;
  gatewayMessage?: string;
  provider?: string;
  model?: string;
  truncatedInput: boolean;
  startedAt: number;
  polledAt: number;
  endedAt: number | null;
  controller: AbortController;
  done: Promise<void>;
};

export class TranslateJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly starts: number[] = [];

  constructor(private readonly deps: TranslateJobsDeps) {}

  /** A cached translation for the current source, or a new (or the running) job. */
  async start(
    messageId: string,
    language: LanguageTag,
    settings: Omit<TranslateSettings, "language">,
    options: { force?: boolean } = {},
  ): Promise<{ cached: TranslationView } | { jobId: string }> {
    this.sweep();
    const header = this.deps.store.getMessage(messageId);
    const body = this.deps.store.getBody(messageId);
    if (header === null || body === null) throw new TranslateJobRefusal("not_found");
    const source = translationSource(header.subject, body);
    const sha = await sourceHash(source.text, language);
    if (options.force !== true) {
      const row = this.deps.store.getTranslation(messageId, language);
      if (row !== null && cacheHit(row, sha)) {
        return {
          cached: {
            messageId,
            targetLanguage: row.targetLanguage,
            providerId: row.providerId,
            model: row.model,
            text: row.text,
            truncated: row.truncated,
            cached: true,
            createdAt: row.createdAt,
          },
        };
      }
    }
    const key = `${messageId}\u0000${language}`;
    const running = [...this.jobs.values()].filter((j) => j.state === "running");
    const same = running.find((j) => j.key === key);
    if (same !== undefined) return { jobId: same.id };
    if (running.length >= JOB_MAX_RUNNING) throw new TranslateJobRefusal("busy");
    const now = this.now();
    while (this.starts.length > 0 && this.starts[0]! <= now - HOUR_MS) this.starts.shift();
    if (this.starts.length >= TRANSLATE_RATE_PER_HOUR) throw new TranslateJobRefusal("rate_limited");
    this.starts.push(now);

    const job: Job = {
      id: this.deps.newId(),
      key,
      state: "running",
      text: "",
      truncatedInput: source.truncated,
      startedAt: now,
      polledAt: now,
      endedAt: null,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    job.done = this.run(job, messageId, language, settings, source, sha);
    this.deps.log?.(`translation ${job.id} started`);
    return { jobId: job.id };
  }

  /** The job's text from `from` on; null for an unknown (or forgotten) job. */
  poll(jobId: string, from: number): JobPoll | null {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (job === undefined) return null;
    job.polledAt = this.now();
    return {
      state: job.state,
      text: job.text.slice(Math.min(from, job.text.length)),
      ...(job.finish === undefined ? {} : { finish: job.finish }),
      ...(job.truncatedInput ? { truncatedInput: true } : {}),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.gatewayMessage === undefined ? {} : { gatewayMessage: job.gatewayMessage }),
      ...(job.provider === undefined ? {} : { provider: job.provider }),
      ...(job.model === undefined ? {} : { model: job.model }),
    };
  }

  /** Stops a running job (its stream is released); false when it is not running. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.state !== "running") return false;
    this.stop(job, "cancelled");
    return true;
  }

  /** Cancels jobs over the 5 min cap or unpolled for 60 s, and forgets finished ones nobody polls. */
  sweep(): void {
    const now = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.state === "running") {
        if (now - job.polledAt >= JOB_IDLE_MS) this.stop(job, "cancelled");
        else if (now - job.startedAt >= JOB_MAX_MS) this.stop(job, "failed");
      } else if (now - Math.max(job.polledAt, job.endedAt ?? 0) >= JOB_IDLE_MS) {
        this.jobs.delete(job.id);
      }
    }
  }

  /** Cancels every running job (plugin disposal). */
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

  private now(): number {
    return this.deps.clock.now().getTime();
  }

  private stop(job: Job, state: "cancelled" | "failed"): void {
    job.state = state;
    job.endedAt = this.now();
    if (state === "failed") job.error = "failed";
    else job.error = "cancelled";
    job.controller.abort();
    this.deps.log?.(`translation ${job.id} ${state === "failed" ? "timed out" : "cancelled"}`);
  }

  private async run(
    job: Job,
    messageId: string,
    language: LanguageTag,
    settings: Omit<TranslateSettings, "language">,
    source: { text: string; truncated: boolean },
    sha: string,
  ): Promise<void> {
    const signal = job.controller.signal;
    try {
      const { providerId, model } = await this.resolve(settings, signal);
      job.provider = providerId;
      job.model = model;
      const english = SUPPORTED_LANGUAGES.find((l) => l.tag === language)!.english;
      const prompt = this.prompt(source.text, english);
      const { finish } = await this.deps.translator.translate(
        { providerId, model, ...prompt, maxOutputTokens: TRANSLATE_MAX_TOKENS },
        (delta) => {
          if (job.state === "running") job.text += delta;
        },
        signal,
      );
      if (job.state !== "running") return;
      job.finish = finish;
      job.state = "done";
      job.endedAt = this.now();
      this.deps.onGateway?.("ok");
      // A message removed meanwhile gets no cache row.
      if (this.deps.store.getMessage(messageId) !== null) {
        this.deps.store.putTranslation({
          messageId,
          targetLanguage: language,
          providerId,
          model,
          text: job.text,
          truncated: source.truncated || finish === "max_tokens",
          sourceSha256: sha,
          createdAt: this.deps.clock.now().toISOString(),
        });
      }
      this.deps.log?.(`translation ${job.id} done (${finish})`);
    } catch (error) {
      if (job.state !== "running") return;
      const kind: TranslateErrorKind = error instanceof TranslateError ? error.kind : "failed";
      job.state = kind === "cancelled" ? "cancelled" : "failed";
      job.error = kind;
      if (error instanceof TranslateError && error.gatewayMessage !== null) job.gatewayMessage = error.gatewayMessage;
      job.endedAt = this.now();
      if (kind === "gateway_missing" || kind === "pool_unavailable") this.deps.onGateway?.(kind);
      this.deps.log?.(`translation ${job.id} failed (${error instanceof TranslateError ? kind : errorName(error)})`);
    }
  }

  /** "" provider: the first available one; "" model: that provider's first model. */
  private async resolve(
    settings: Omit<TranslateSettings, "language">,
    signal: AbortSignal,
  ): Promise<{ providerId: string; model: string }> {
    let providerId = settings.providerId;
    if (providerId === "") {
      const first = (await this.deps.translator.providers(signal)).find((p) => p.available);
      if (first === undefined) throw new TranslateError("provider_unknown");
      providerId = first.id;
    }
    let model = settings.model;
    if (model === "") {
      const first = (await this.deps.translator.models(providerId, signal))[0];
      if (first === undefined) throw new TranslateError("model_unknown");
      model = first.model;
    }
    return { providerId, model };
  }

  /** The framed prompt with a nonce the source does not hold. */
  private prompt(source: string, english: string): { instructions: string; input: string } {
    for (let attempt = 0; ; attempt++) {
      try {
        return buildTranslatePrompt(source, { english }, this.deps.nonce());
      } catch (error) {
        if (attempt >= 4) throw error;
      }
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
