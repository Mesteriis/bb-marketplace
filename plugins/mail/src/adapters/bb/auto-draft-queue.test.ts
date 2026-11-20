import { beforeEach, describe, expect, it } from "vitest";
import { summaryInput } from "../../core/ai-input.ts";
import { writeInput, type WriteBuild } from "../../core/ai-write.ts";
import { AUTO_DRAFT_RETRY_MS, DraftBudget, type ReplyDraftRecord } from "../../core/auto-drafts.ts";
import { FixedClock } from "../../core/testing/fakes.ts";
import { TranslateError, type TranslateProvider, type Translator } from "../../core/translate.ts";
import { AiJobs } from "./ai-jobs.ts";
import { AutoDraftQueue } from "./auto-draft-queue.ts";

type Pending = {
  request: Parameters<Translator["translate"]>[0];
  onText: Parameters<Translator["translate"]>[1];
  resolve: (finish: "complete" | "max_tokens") => void;
  reject: (error: unknown) => void;
};

class DrivenTranslator implements Translator {
  readonly calls: Pending[] = [];
  async providers(): Promise<TranslateProvider[]> {
    return [{ id: "provider-b", displayName: "B", available: true }];
  }
  async models() {
    return [{ model: "model-1", displayName: "One" }];
  }
  translate(request: Pending["request"], onText: Pending["onText"], signal: AbortSignal) {
    return new Promise<{ finish: "complete" | "max_tokens" }>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new TranslateError("cancelled")));
      this.calls.push({ request, onText, resolve: (finish) => resolve({ finish }), reject });
    });
  }
}

const NONCE = "0123456789abcdef";
const source = (id: string) => ({
  id,
  date: "2026-11-15T09:00:00.000Z",
  from: { name: "Ada Example", address: "ada@example.org" },
  subject: "Invented plan",
  body: { text: `Invented question in ${id}?`, html: null },
});
const buildFor = (messageId: string): { built: WriteBuild; tag: string; accountId: string } => ({
  built: writeInput({ mode: "autodraft", own: [], personal: "", facts: "", voice: [], conversation: [source(messageId)] }, { nonce: NONCE, tag: "k3f9" }),
  tag: "k3f9",
  accountId: "acc_1",
});

let clock: FixedClock;
let translator: DrivenTranslator;
let jobs: AiJobs;
let kept: ReplyDraftRecord[];
let logged: string[][];
let lines: string[];
let timers: { run: () => void; ms: number; cancelled: boolean }[];
let enabled: boolean;
let gone: Set<string>;
let queue: AutoDraftQueue;

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const answer = async (text: string) => {
  const call = translator.calls.at(-1)!;
  call.onText(text);
  call.resolve("complete");
  await tick();
};

beforeEach(() => {
  clock = new FixedClock(new Date("2026-11-20T10:00:00.000Z"));
  translator = new DrivenTranslator();
  let ids = 0;
  jobs = new AiJobs({ translator, clock, newId: () => `ai-${++ids}` });
  kept = [];
  logged = [];
  lines = [];
  timers = [];
  enabled = true;
  gone = new Set();
  queue = new AutoDraftQueue({
    enabled: () => enabled,
    build: (messageId) => (gone.has(messageId) ? null : buildFor(messageId)),
    jobs,
    context: () => ({ provider: "", model: "" }),
    keep: (draft) => kept.push(draft),
    logCall: (built) => logged.push(built.parts.map((part) => part.messageId)),
    budget: new DraftBudget(clock),
    clock,
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: (line) => lines.push(line),
  });
});

describe("AutoDraftQueue", () => {
  it("drafts one message at a time and keeps what the model wrote", async () => {
    queue.offer(["m1", "m2"]);
    await tick();
    expect(translator.calls).toHaveLength(1);
    expect(translator.calls[0]!.request.input).toContain("Invented question in m1?");
    await answer('{"reply":true,"paragraphs":["Invented answer one."]}');
    expect(translator.calls).toHaveLength(2);
    await answer('{"reply":true,"paragraphs":["See https://evil.example/pay","Bye"]}');
    await queue.idle();
    expect(kept).toEqual([
      { messageId: "m1", accountId: "acc_1", paragraphs: ["Invented answer one."], linksRemoved: 0, provider: "provider-b", model: "model-1", createdAt: "2026-11-20T10:00:00.000Z" },
      { messageId: "m2", accountId: "acc_1", paragraphs: ["See [link removed]", "Bye"], linksRemoved: 1, provider: "provider-b", model: "model-1", createdAt: "2026-11-20T10:00:00.000Z" },
    ]);
    expect(logged).toEqual([["m1"], ["m2"]]);
    expect(lines.join("\n")).not.toContain("Invented");
  });

  it("keeps nothing when no reply is needed, when the answer is unreadable, or when the message no longer qualifies", async () => {
    gone.add("m2");
    queue.offer(["m1", "m2", "m3"]);
    await tick();
    await answer('{"reply":false}');
    await answer("not json");
    await queue.idle();
    expect(translator.calls).toHaveLength(2);
    expect(kept).toEqual([]);
    expect(lines).toEqual(["auto draft: not written (unreadable)"]);
  });

  it("does nothing while the setting is off, and stops when it is turned off", async () => {
    enabled = false;
    queue.offer(["m1"]);
    await tick();
    expect(translator.calls).toHaveLength(0);
    expect(queue.size()).toBe(0);
    enabled = true;
    queue.offer(["m1", "m2"]);
    await tick();
    enabled = false;
    await answer('{"reply":true,"paragraphs":["Invented."]}');
    await queue.idle();
    expect(translator.calls).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it("waits 30 s while two of the owner's requests run, then goes on", async () => {
    const owner = summaryInput([source("x1")], { nonce: NONCE });
    jobs.start("summary", owner, { provider: "", model: "" });
    jobs.start("summary", owner, { provider: "", model: "" });
    await tick();
    queue.offer(["m1"]);
    await queue.idle();
    expect(translator.calls).toHaveLength(2);
    expect(timers.map((t) => t.ms)).toEqual([AUTO_DRAFT_RETRY_MS]);
    expect(queue.size()).toBe(1);
    translator.calls[0]!.onText('{"decisions":[],"questions":[],"deadlines":[]}');
    translator.calls[0]!.resolve("complete");
    await tick();
    timers[0]!.run();
    await tick();
    expect(translator.calls).toHaveLength(3);
    await answer('{"reply":true,"paragraphs":["Invented."]}');
    await queue.idle();
    expect(kept.map((draft) => draft.messageId)).toEqual(["m1"]);
  });

  it("empties itself at the hourly rate and on a provider failure the next message would meet too", async () => {
    queue.offer(Array.from({ length: 12 }, (_, i) => `m${i}`));
    for (let i = 0; i < 10; i++) {
      await tick();
      await answer('{"reply":false}');
    }
    await queue.idle();
    expect(translator.calls).toHaveLength(10);
    expect(queue.size()).toBe(0);
    expect(lines).toEqual(["auto draft: stopped (rate_limited)"]);

    clock.set(new Date("2026-11-20T12:00:00.000Z"));
    queue.offer(["n1", "n2"]);
    await tick();
    translator.calls.at(-1)!.reject(new TranslateError("quota"));
    await queue.idle();
    expect(translator.calls).toHaveLength(11);
    expect(queue.size()).toBe(0);
    expect(lines.at(-1)).toBe("auto draft: not written (quota)");
  });

  it("gives up on a call that never answers after five minutes and goes on", async () => {
    queue.offer(["m1", "m2"]);
    await tick();
    const giveUp = timers.find((timer) => timer.ms === 5 * 60 * 1000)!;
    expect(giveUp.cancelled).toBe(false);
    giveUp.run();
    await tick();
    expect(translator.calls).toHaveLength(2);
    await answer('{"reply":true,"paragraphs":["Invented."]}');
    await queue.idle();
    expect(kept.map((draft) => draft.messageId)).toEqual(["m2"]);
    expect(lines).toEqual(["auto draft: not written (cancelled)"]);
    // A call that ended leaves no timer behind.
    expect(timers.filter((timer) => timer.ms === 5 * 60 * 1000).map((timer) => timer.cancelled)).toEqual([true, true]);
  });

  it("holds at most twenty waiting, dropping the oldest", async () => {
    queue.offer(Array.from({ length: 25 }, (_, i) => `m${i}`));
    await tick();
    // m5 is being written; m6..m24 wait.
    expect(translator.calls[0]!.request.input).toContain("Invented question in m5?");
    expect(queue.size()).toBe(19);
    queue.dispose();
    expect(queue.size()).toBe(0);
    await jobs.dispose();
    await queue.idle();
    expect(kept).toEqual([]);
    queue.offer(["late"]);
    expect(queue.size()).toBe(0);
  });
});
