import { beforeEach, describe, expect, it } from "vitest";
import {
  PROMPT_VERSION,
  TRANSLATE_RATE_PER_HOUR,
  TranslateError,
  sourceHash,
  translationSource,
  type TranslateProvider,
  type Translator,
} from "../../core/translate.ts";
import { FixedClock, InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { JOB_IDLE_MS, JOB_MAX_MS, TranslateJobRefusal, TranslateJobs } from "./translate-jobs.ts";

const BODY = "Invented note about the quince harvest.";

type Pending = {
  request: Parameters<Translator["translate"]>[0];
  onText: (delta: string) => void;
  signal: AbortSignal;
  resolve: (finish: "complete" | "max_tokens") => void;
  reject: (error: unknown) => void;
};

/** A translator the test drives: each translate call waits until the test finishes it. */
class DrivenTranslator implements Translator {
  readonly calls: Pending[] = [];
  readonly cancelled: Pending[] = [];
  providerList: TranslateProvider[] = [
    { id: "provider-a", displayName: "A", available: false },
    { id: "provider-b", displayName: "B", available: true },
  ];
  modelList = [{ model: "model-1", displayName: "One" }, { model: "model-2", displayName: "Two" }];
  failWith: TranslateError | null = null;

  async providers() {
    if (this.failWith !== null) throw this.failWith;
    return this.providerList;
  }

  async models() {
    return this.modelList;
  }

  translate(request: Pending["request"], onText: Pending["onText"], signal: AbortSignal) {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return new Promise<{ finish: "complete" | "max_tokens" }>((resolve, reject) => {
      const pending: Pending = { request, onText, signal, resolve: (finish) => resolve({ finish }), reject };
      signal.addEventListener("abort", () => {
        this.cancelled.push(pending);
        reject(new TranslateError("cancelled"));
      });
      this.calls.push(pending);
    });
  }
}

let store: InMemoryMailStore;
let clock: FixedClock;
let translator: DrivenTranslator;
let jobs: TranslateJobs;
let lines: string[];
let gateway: string[];
let messageId: string;
let ids: number;

beforeEach(() => {
  store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount());
  store.upsertMessages("acc_1", "INBOX", [
    makeFetchedMessage(1, { subject: "Invented quince", bodyText: BODY }),
    makeFetchedMessage(2, { subject: "Invented pear", bodyText: "Invented second note" }),
    makeFetchedMessage(3, { subject: "Invented plum", bodyText: "Invented third note" }),
  ]);
  messageId = idOf(1);
  clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  translator = new DrivenTranslator();
  lines = [];
  gateway = [];
  ids = 0;
  jobs = new TranslateJobs({
    translator,
    store,
    clock,
    newId: () => `job-${++ids}`,
    nonce: () => "0123456789abcdef",
    log: (line) => lines.push(line),
    onGateway: (state) => gateway.push(state),
  });
});

function idOf(uid: number): string {
  return store.localFolderIndex("acc_1", "INBOX", "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
}

const SETTINGS = { providerId: "provider-b", model: "model-2" };

async function startJob(id = messageId, settings = SETTINGS, force = false): Promise<string> {
  const started = await jobs.start(id, "ru", settings, { force });
  if (!("jobId" in started)) throw new Error("cached");
  await vi_waitForCall();
  return started.jobId;
}

/** Lets the job reach translator.translate (provider and model resolution are async). */
async function vi_waitForCall(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));

describe("TranslateJobs", () => {
  it("streams text by poll offsets, caches the result and then answers from the cache", async () => {
    const jobId = await startJob();
    const call = translator.calls[0]!;
    expect(call.request).toMatchObject({ providerId: "provider-b", model: "model-2", maxOutputTokens: 8192 });
    expect(call.request.input).toContain(BODY);
    expect(call.request.input).toContain("Invented quince");
    call.onText("Привет, ");
    expect(jobs.poll(jobId, 0)).toMatchObject({ state: "running", text: "Привет, " });
    call.onText("айва");
    expect(jobs.poll(jobId, 8)).toMatchObject({ state: "running", text: "айва" });
    call.resolve("complete");
    await jobs.settled(jobId);
    expect(jobs.poll(jobId, 12)).toEqual({ state: "done", text: "", finish: "complete", provider: "provider-b", model: "model-2" });
    expect(gateway).toEqual(["ok"]);

    const row = store.getTranslation(messageId, "ru")!;
    expect(row).toMatchObject({ text: "Привет, айва", providerId: "provider-b", model: "model-2", truncated: false });
    const cached = await jobs.start(messageId, "ru", { providerId: "other", model: "other" });
    expect(cached).toEqual({
      cached: {
        messageId,
        targetLanguage: "ru",
        providerId: "provider-b",
        model: "model-2",
        text: "Привет, айва",
        truncated: false,
        cached: true,
        createdAt: row.createdAt,
      },
    });
    expect(translator.calls).toHaveLength(1);
  });

  it("a changed body or prompt version misses the cache; force bypasses it", async () => {
    const source = translationSource("Invented quince", { text: BODY, html: null }).text;
    const put = (sha: string) =>
      store.putTranslation({
        messageId,
        targetLanguage: "ru",
        providerId: "p",
        model: "m",
        text: "старый",
        truncated: false,
        sourceSha256: sha,
        createdAt: clock.now().toISOString(),
      });
    put(await sourceHash(source, "ru"));
    expect(await jobs.start(messageId, "ru", SETTINGS)).toHaveProperty("cached");
    expect(await jobs.start(messageId, "ru", SETTINGS, { force: true })).toHaveProperty("jobId");
    await jobs.dispose();

    put(await sourceHash(source, "ru", PROMPT_VERSION + 1));
    expect(await jobs.start(messageId, "ru", SETTINGS)).toHaveProperty("jobId");
    await jobs.dispose();

    put(await sourceHash(source.replace("quince", "medlar"), "ru"));
    expect(await jobs.start(messageId, "ru", SETTINGS)).toHaveProperty("jobId");
  });

  it("one job per message and language, at most two running", async () => {
    const first = await startJob(idOf(1));
    expect(await jobs.start(idOf(1), "ru", SETTINGS)).toEqual({ jobId: first });
    const second = await jobs.start(idOf(1), "en", SETTINGS);
    expect(second).toHaveProperty("jobId");
    await expect(jobs.start(idOf(2), "ru", SETTINGS)).rejects.toBeInstanceOf(TranslateJobRefusal);
    expect(jobs.cancel(first)).toBe(true);
    expect(await jobs.start(idOf(2), "ru", SETTINGS)).toHaveProperty("jobId");
  });

  it("refuses beyond the hourly rate, and the window slides", async () => {
    for (let i = 0; i < TRANSLATE_RATE_PER_HOUR; i++) {
      const started = await jobs.start(idOf(1), "ru", SETTINGS, { force: true });
      if ("jobId" in started) jobs.cancel(started.jobId);
      advance(1000);
    }
    await expect(jobs.start(idOf(1), "ru", SETTINGS)).rejects.toMatchObject({ code: "rate_limited" });
    advance(60 * 60 * 1000 - TRANSLATE_RATE_PER_HOUR * 1000 + 1000);
    expect(await jobs.start(idOf(1), "ru", SETTINGS)).toHaveProperty("jobId");
  });

  it("an unknown message is refused", async () => {
    await expect(jobs.start("missing", "ru", SETTINGS)).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancels a job nobody polled for 60 s, releasing its stream, and forgets finished jobs", async () => {
    const jobId = await startJob();
    advance(JOB_IDLE_MS - 1);
    jobs.sweep();
    expect(translator.cancelled).toHaveLength(0);
    advance(1);
    jobs.sweep();
    expect(translator.cancelled).toHaveLength(1);
    expect(translator.cancelled[0]!.signal.aborted).toBe(true);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId, 0)).toMatchObject({ state: "cancelled", error: "cancelled" });
    advance(JOB_IDLE_MS);
    jobs.sweep();
    expect(jobs.poll(jobId, 0)).toBeNull();
  });

  it("stops a job at the 5 min cap even while it is polled", async () => {
    const jobId = await startJob();
    for (let t = 0; t < JOB_MAX_MS; t += 30_000) {
      advance(30_000);
      jobs.poll(jobId, 0);
    }
    jobs.sweep();
    expect(translator.cancelled).toHaveLength(1);
    expect(jobs.poll(jobId, 0)).toMatchObject({ state: "failed", error: "failed" });
  });

  it("Stop cancels a running job; a finished one cannot be cancelled", async () => {
    const jobId = await startJob();
    expect(jobs.cancel(jobId)).toBe(true);
    expect(translator.cancelled).toHaveLength(1);
    expect(jobs.cancel(jobId)).toBe(false);
    expect(jobs.cancel("nope")).toBe(false);
  });

  it("empty settings resolve to the first available provider and its first model", async () => {
    await startJob(messageId, { providerId: "", model: "" });
    expect(translator.calls[0]!.request).toMatchObject({ providerId: "provider-b", model: "model-1" });
    translator.providerList = [{ id: "provider-a", displayName: "A", available: false }];
    const started = await jobs.start(idOf(2), "ru", { providerId: "", model: "" });
    const jobId = (started as { jobId: string }).jobId;
    await jobs.settled(jobId);
    expect(jobs.poll(jobId, 0)).toMatchObject({ state: "failed", error: "provider_unknown" });
    translator.providerList = [{ id: "provider-b", displayName: "B", available: true }];
    translator.modelList = [];
    const noModel = (await jobs.start(idOf(3), "ru", { providerId: "", model: "" })) as { jobId: string };
    await jobs.settled(noModel.jobId);
    expect(jobs.poll(noModel.jobId, 0)).toMatchObject({ state: "failed", error: "model_unknown" });
  });

  it("gateway_missing and pool_unavailable surface in the poll and to the gateway state", async () => {
    translator.failWith = new TranslateError("pool_unavailable", "Account Pooler model RPC is unavailable.");
    const pool = (await jobs.start(messageId, "ru", SETTINGS)) as { jobId: string };
    await jobs.settled(pool.jobId);
    expect(jobs.poll(pool.jobId, 0)).toEqual({
      state: "failed",
      text: "",
      error: "pool_unavailable",
      gatewayMessage: "Account Pooler model RPC is unavailable.",
      provider: "provider-b",
      model: "model-2",
    });
    translator.failWith = new TranslateError("gateway_missing");
    const missing = (await jobs.start(idOf(2), "ru", SETTINGS)) as { jobId: string };
    await jobs.settled(missing.jobId);
    expect(jobs.poll(missing.jobId, 0)).toMatchObject({ state: "failed", error: "gateway_missing" });
    expect(gateway).toEqual(["pool_unavailable", "gateway_missing"]);
    expect(store.getTranslation(messageId, "ru")).toBeNull();
  });

  it("a long message is marked truncated, and an output cut marks the cached row truncated", async () => {
    store.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(4, { bodyText: "w ".repeat(20_000) })]);
    const jobId = await startJob(idOf(4));
    translator.calls[0]!.onText("часть");
    translator.calls[0]!.resolve("max_tokens");
    await jobs.settled(jobId);
    expect(jobs.poll(jobId, 0)).toMatchObject({ state: "done", finish: "max_tokens", truncatedInput: true });
    expect(store.getTranslation(idOf(4), "ru")!.truncated).toBe(true);
  });

  it("a message removed while translating gets no cache row", async () => {
    const jobId = await startJob();
    store.deleteAccount("acc_1");
    translator.calls[0]!.resolve("complete");
    await jobs.settled(jobId);
    expect(store.getTranslation(messageId, "ru")).toBeNull();
  });

  it("logs ids, states and kinds only", async () => {
    const jobId = await startJob();
    translator.calls[0]!.onText("Секретный перевод");
    translator.calls[0]!.resolve("complete");
    await jobs.settled(jobId);
    translator.failWith = new TranslateError("auth");
    const failed = (await jobs.start(idOf(2), "ru", SETTINGS)) as { jobId: string };
    await jobs.settled(failed.jobId);
    expect(lines).toEqual([
      "translation job-1 started",
      "translation job-1 done (complete)",
      "translation job-2 started",
      "translation job-2 failed (auth)",
    ]);
  });

  it("the model sees placeholders only; the polled and stored translation is restored; the map is dropped at every end", async () => {
    const CODE = "482913";
    const secretId = idOf(3);
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(4, { subject: "Invented sign-in", bodyText: `Your verification code is ${CODE}.` }),
    ]);
    const withCode = idOf(4);
    const jobId = await startJob(withCode);
    const call = translator.calls[0]!;
    expect(call.request.input).not.toContain(CODE);
    const placeholder = /\[hidden one-time code 1 [a-z0-9]{4}\]/.exec(call.request.input)![0];
    expect(jobs.holdsRestore(jobId)).toBe(true);
    // A placeholder split across deltas is held back until it closes.
    call.onText("Ваш код ");
    call.onText(placeholder.slice(0, 10));
    expect(jobs.poll(jobId, 0)!.text).toBe("Ваш код ");
    call.onText(`${placeholder.slice(10)}. [hidden token 9 zzzz] стоит как есть`);
    expect(jobs.poll(jobId, 0)!.text).toBe(`Ваш код ${CODE}. [hidden token 9 zzzz] стоит как есть`);
    call.resolve("complete");
    await jobs.settled(jobId);
    expect(jobs.holdsRestore(jobId)).toBe(false);
    expect(store.getTranslation(withCode, "ru")!.text).toBe(`Ваш код ${CODE}. [hidden token 9 zzzz] стоит как есть`);
    expect(lines.join("\n")).not.toContain(CODE);

    // Cancelled, failed and swept jobs drop it too.
    const cancelled = await startJob(secretId);
    expect(jobs.holdsRestore(cancelled)).toBe(true);
    jobs.cancel(cancelled);
    expect(jobs.holdsRestore(cancelled)).toBe(false);
    const failed = await startJob(idOf(2));
    translator.calls.at(-1)!.reject(new TranslateError("auth"));
    await jobs.settled(failed);
    expect(jobs.holdsRestore(failed)).toBe(false);
    const swept = await startJob(idOf(1));
    advance(JOB_IDLE_MS);
    jobs.sweep();
    expect(jobs.holdsRestore(swept)).toBe(false);
  });

  it("a translation cached under prompt version 1 is refreshed on the next click", async () => {
    const source = translationSource("Invented quince", { text: BODY, html: null }).text;
    store.putTranslation({
      messageId,
      targetLanguage: "ru",
      providerId: "p",
      model: "m",
      text: "старый",
      truncated: false,
      sourceSha256: await sourceHash(source, "ru", 1),
      createdAt: clock.now().toISOString(),
    });
    expect(PROMPT_VERSION).toBe(2);
    expect(await jobs.start(messageId, "ru", SETTINGS)).toHaveProperty("jobId");
  });
});
