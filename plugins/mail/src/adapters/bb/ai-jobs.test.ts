import { beforeEach, describe, expect, it } from "vitest";
import { AI_MAX_OUTPUT_TOKENS, AI_RATES, draftInput, summaryInput, type AiBuild } from "../../core/ai-input.ts";
import { TranslateError, type TranslateProvider, type Translator } from "../../core/translate.ts";
import { FixedClock } from "../../core/testing/fakes.ts";
import { AI_JOB_IDLE_MS, AI_JOB_KEEP_MS, AI_JOB_MAX_MS, AiJobRefusal, AiJobs } from "./ai-jobs.ts";

type Pending = {
  request: Parameters<Translator["translate"]>[0];
  onText: (delta: string) => void;
  signal: AbortSignal;
  resolve: (finish: "complete" | "max_tokens") => void;
  reject: (error: unknown) => void;
};

/** A translator the test drives: each call waits until the test finishes it. */
class DrivenTranslator implements Translator {
  readonly calls: Pending[] = [];
  providerList: TranslateProvider[] = [{ id: "provider-b", displayName: "B", available: true }];

  async providers() {
    return this.providerList;
  }

  async models() {
    return [{ model: "model-1", displayName: "One" }];
  }

  translate(request: Pending["request"], onText: Pending["onText"], signal: AbortSignal) {
    return new Promise<{ finish: "complete" | "max_tokens" }>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new TranslateError("cancelled")));
      this.calls.push({ request, onText, signal, resolve: (finish) => resolve({ finish }), reject });
    });
  }
}

const NONCE = "0123456789abcdef";
const message = (id: string, body: string) => ({
  id,
  date: "2026-11-15T09:00:00.000Z",
  from: { name: "Ada Example", address: "ada@example.org" },
  subject: "Invented plan",
  body: { text: body, html: null },
});
const SUMMARY = summaryInput([message("m1", "Invented first"), message("m2", "Invented second")], { nonce: NONCE });

let clock: FixedClock;
let translator: DrivenTranslator;
let jobs: AiJobs;
let lines: string[];
let ids: number;

beforeEach(() => {
  clock = new FixedClock(new Date("2026-11-16T10:00:00.000Z"));
  translator = new DrivenTranslator();
  lines = [];
  ids = 0;
  jobs = new AiJobs({ translator, clock, newId: () => `ai-${++ids}`, log: (line) => lines.push(line) });
});

const ctx = { provider: "", model: "" };
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));

async function started(kind: Parameters<AiJobs["start"]>[0] = "summary", built: AiBuild = SUMMARY, extra = {}) {
  const { jobId } = jobs.start(kind, built, { ...ctx, ...extra });
  await tick();
  return jobId;
}

async function answer(jobId: string, text: string, finish: "complete" | "max_tokens" = "complete") {
  const call = translator.calls.at(-1)!;
  call.onText(text);
  call.resolve(finish);
  await tick();
  await jobs.settled(jobId);
}

describe("AiJobs", () => {
  it("collects the output whole, parses it when the stream ends and gives the result in the poll only", async () => {
    const jobId = await started();
    const call = translator.calls[0]!;
    expect(call.request).toMatchObject({ providerId: "provider-b", model: "model-1", maxOutputTokens: AI_MAX_OUTPUT_TOKENS.summary });
    expect(call.request.input).toBe(SUMMARY.input);
    call.onText('{"decisions":[{"text":"Invented decision","messages":[2,9]}],');
    expect(jobs.poll(jobId)).toEqual({ state: "running", phase: "writing", provider: "provider-b", model: "model-1" });
    call.onText('"questions":[],"deadlines":[]}');
    call.resolve("complete");
    await jobs.settled(jobId);
    const poll = jobs.poll(jobId)!;
    expect(poll.state).toBe("done");
    expect(poll.result!.output).toEqual({
      kind: "summary",
      value: { decisions: [{ text: "Invented decision", messages: [2] }], questions: [], deadlines: [] },
    });
    expect(poll.result!.parts.map((p) => p.messageId)).toEqual(["m1", "m2"]);
    expect(lines).toEqual(["ai summary ai-1 started", "ai summary ai-1 done"]);
  });

  it("runs at most two at once and refuses a third as busy", async () => {
    await started();
    await started("tasks");
    expect(() => jobs.start("digest", SUMMARY, ctx)).toThrow(AiJobRefusal);
    try {
      jobs.start("digest", SUMMARY, ctx);
    } catch (error) {
      expect((error as AiJobRefusal).code).toBe("busy");
    }
  });

  it("caps each kind per hour, the window sliding", async () => {
    for (let i = 0; i < AI_RATES.categories; i++) {
      const jobId = await started("categories");
      jobs.cancel(jobId);
    }
    expect(() => jobs.start("categories", SUMMARY, ctx)).toThrow("Too many AI requests");
    // Another kind has its own rate.
    jobs.cancel(await started("summary"));
    advance(60 * 60 * 1000);
    expect(() => jobs.start("categories", SUMMARY, ctx)).not.toThrow();
  });

  it("cancels a job nobody polled for 60 s and stops one at the 5 min cap", async () => {
    const idle = await started();
    advance(AI_JOB_IDLE_MS);
    jobs.sweep();
    expect(jobs.poll(idle)).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(translator.calls[0]!.signal.aborted).toBe(true);

    const long = await started();
    for (let t = 0; t < AI_JOB_MAX_MS; t += AI_JOB_IDLE_MS / 2) {
      advance(AI_JOB_IDLE_MS / 2);
      jobs.poll(long);
    }
    expect(jobs.poll(long)).toMatchObject({ state: "failed", error: "failed" });
    // A finished job is forgotten once nobody polled it for a while.
    advance(AI_JOB_KEEP_MS);
    jobs.sweep();
    expect(jobs.poll(long)).toBeNull();
  });

  it("Ask: plans, searches locally, then answers, with phases; citations index the parts searched", async () => {
    const searched: string[][] = [];
    const answerBuild = summaryInput([message("x1", "Invented excerpt")], { nonce: NONCE });
    const plan: AiBuild = { instructions: "plan", input: "Question: Invented?", parts: [], notes: { hidden: 1, leftOut: 0, truncated: 0 } };
    const jobId = await started("ask", plan, {
      search: (queries: string[]) => {
        searched.push(queries);
        return answerBuild;
      },
    });
    expect(jobs.poll(jobId)!.phase).toBe("planning");
    expect(translator.calls[0]!.request.maxOutputTokens).toBe(AI_MAX_OUTPUT_TOKENS.askPlan);
    translator.calls[0]!.onText('```json\n{"queries":["from:ada invented","plan"]}\n```');
    translator.calls[0]!.resolve("complete");
    await tick();
    expect(searched).toEqual([["from:ada invented", "plan"]]);
    expect(jobs.poll(jobId)!.phase).toBe("writing");
    expect(translator.calls[1]!.request.input).toBe(answerBuild.input);
    expect(translator.calls[1]!.request.maxOutputTokens).toBe(AI_MAX_OUTPUT_TOKENS.askAnswer);
    await answer(jobId, '{"answer":"Invented answer","sources":[1,4],"found":true}');
    const result = jobs.poll(jobId)!.result!;
    expect(result.output).toEqual({ kind: "ask", value: { answer: "Invented answer", sources: [1], found: true } });
    expect(result.parts.map((p) => p.messageId)).toEqual(["x1"]);
    expect(result.notes.hidden).toBe(answerBuild.notes.hidden + 1);
  });

  it("max_tokens fails as too_long; unreadable output never reaches the poll or the log", async () => {
    const cut = await started();
    await answer(cut, '{"decisions":[', "max_tokens");
    expect(jobs.poll(cut)).toMatchObject({ state: "failed", error: "too_long" });

    const bad = await started("tasks");
    await answer(bad, "Invented model chatter without JSON");
    const poll = jobs.poll(bad)!;
    expect(poll).toMatchObject({ state: "failed", error: "unreadable" });
    expect(JSON.stringify(poll)).not.toContain("chatter");
    expect(lines.join("\n")).not.toContain("chatter");
    expect(lines).toContain("ai tasks ai-2 failed (unreadable)");
  });

  it("drops items that fail their schema and counts them", async () => {
    const jobId = await started("digest");
    await answer(jobId, '{"items":[{"n":1,"gist":"Invented gist"},{"n":7,"gist":"x"},"junk"]}');
    const result = jobs.poll(jobId)!.result!;
    expect(result.output).toEqual({ kind: "digest", value: { items: [{ n: 1, gist: "Invented gist" }] } });
    expect(result.notes.unreadItems).toBe(2);
  });

  it("restores a draft's own placeholders, counts unknown and missing ones, and drops the map at every end", async () => {
    const built = draftInput(["Code 482913 and token ghp_Zx81Kq7Lm2Np4Rt6Vw9Yb3Cd5Ef7Gh1Jk0Mn"], { mode: "fix" }, { nonce: NONCE, tag: "k3f9" });
    expect(built.input).not.toContain("482913");
    const codePlaceholder = [...built.restore!.keys()].find((key) => key.includes("code"))!;
    const jobId = await started("draft", built, { tag: "k3f9", maxChars: 1_000 });
    expect(jobs.holdsRestore(jobId)).toBe(true);
    await answer(jobId, JSON.stringify({ paragraphs: [`Fixed: ${codePlaceholder}`, "Typed [hidden token 1 zzzz] stays"] }));
    expect(jobs.holdsRestore(jobId)).toBe(false);
    expect(jobs.poll(jobId)!.result!.output).toEqual({
      kind: "draft",
      value: { paragraphs: ["Fixed: 482913", "Typed [hidden token 1 zzzz] stays"], unknown: 1, missing: 1 },
    });
    expect(lines.join("\n")).not.toContain("482913");

    const cancelled = await started("draft", built, { tag: "k3f9" });
    jobs.cancel(cancelled);
    expect(jobs.holdsRestore(cancelled)).toBe(false);
    const failed = await started("draft", built, { tag: "k3f9" });
    translator.calls.at(-1)!.reject(new TranslateError("quota"));
    await jobs.settled(failed);
    expect(jobs.poll(failed)).toMatchObject({ state: "failed", error: "quota" });
    expect(jobs.holdsRestore(failed)).toBe(false);
    const swept = await started("draft", built, { tag: "k3f9" });
    advance(AI_JOB_IDLE_MS);
    jobs.sweep();
    expect(jobs.holdsRestore(swept)).toBe(false);
  });

  it("finished() hands a done job of the asked kind only; onDone gets the result once", async () => {
    const done: string[] = [];
    const jobId = await started("tasks", SUMMARY, { onDone: (f: { output: { kind: string } }) => done.push(f.output.kind) });
    expect(jobs.finished(jobId, "tasks")).toBeNull();
    await answer(jobId, '{"tasks":[{"title":"Invented task","due":"2026-11-20","message":1,"evidence":"Invented first"}]}');
    expect(jobs.finished(jobId, "summary")).toBeNull();
    expect(jobs.finished(jobId, "tasks")!.output).toEqual({
      kind: "tasks",
      value: { tasks: [{ title: "Invented task", due: "2026-11-20", message: 1, evidence: "Invented first" }] },
    });
    expect(done).toEqual(["tasks"]);
  });
});
