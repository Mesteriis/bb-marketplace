import { beforeEach, describe, expect, it } from "vitest";
import { summaryInput } from "../../core/ai-input.ts";
import { writeInput, type WriteBuild } from "../../core/ai-write.ts";
import { DraftBudget } from "../../core/auto-drafts.ts";
import { FixedClock } from "../../core/testing/fakes.ts";
import { TranslateError, type TranslateProvider, type Translator } from "../../core/translate.ts";
import { AiJobs } from "./ai-jobs.ts";
import { UNATTENDED_RETRY_MS, UnattendedAiQueue, UnattendedGate } from "./unattended-ai-queue.ts";

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
type Kept = { messageId: string; accountId: string; paragraphs: string[]; linksRemoved: number; provider: string; model: string };
let kept: Kept[];
let logged: string[][];
let lines: string[];
let timers: { run: () => void; ms: number; cancelled: boolean }[];
let enabled: boolean;
let gone: Set<string>;
let queue: UnattendedAiQueue<{ messageId: string }>;

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
  queue = new UnattendedAiQueue<{ messageId: string }>({
    kind: "autodraft",
    label: "auto draft",
    batch: 1,
    limit: 20,
    enabled: () => enabled,
    build: (ids) => {
      const messageId = ids[0]!;
      if (gone.has(messageId)) return null;
      const made = buildFor(messageId);
      return { built: made.built, context: { tag: made.tag, allowedLinks: made.built.allowedLinks }, ids: [messageId], made: { messageId } };
    },
    jobs,
    context: () => ({ provider: "", model: "" }),
    done: (made, finished) => {
      const output = finished.output;
      if (output.kind !== "write" || !output.value.reply) return;
      kept.push({ messageId: made.messageId, accountId: "acc_1", paragraphs: output.value.paragraphs, linksRemoved: output.value.linksRemoved, provider: finished.provider, model: finished.model });
    },
    logCall: (built) => logged.push(built.parts.map((part) => part.messageId)),
    budget: new DraftBudget(clock),
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

describe("UnattendedAiQueue", () => {
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
      { messageId: "m1", accountId: "acc_1", paragraphs: ["Invented answer one."], linksRemoved: 0, provider: "provider-b", model: "model-1" },
      { messageId: "m2", accountId: "acc_1", paragraphs: ["See [link removed]", "Bye"], linksRemoved: 1, provider: "provider-b", model: "model-1" },
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
    expect(lines).toEqual(["auto draft: not done (unreadable)"]);
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
    expect(timers.map((t) => t.ms)).toEqual([UNATTENDED_RETRY_MS]);
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
    expect(lines.at(-1)).toBe("auto draft: not done (quota)");
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
    expect(lines).toEqual(["auto draft: not done (cancelled)"]);
    // A call that ended leaves no timer behind.
    expect(timers.filter((timer) => timer.ms === 5 * 60 * 1000).map((timer) => timer.cancelled)).toEqual([true, true]);
  });

  it("takes a batch per call when asked to, and skips a batch that no longer qualifies", async () => {
    const calls: string[][] = [];
    const done: string[][] = [];
    const batches = new UnattendedAiQueue<string[]>({
      kind: "sort",
      label: "sort",
      batch: 3,
      limit: 200,
      enabled: () => true,
      build: (ids) => {
        const live = ids.filter((id) => !gone.has(id));
        if (live.length === 0) return null;
        calls.push(live);
        return { built: summaryInput(live.map(source), { nonce: NONCE }), context: { labels: [] }, ids: live, made: live };
      },
      jobs,
      context: () => ({ provider: "", model: "" }),
      done: (made) => done.push(made),
      logCall: () => {},
      budget: new DraftBudget(clock, 100),
      schedule: () => () => {},
      log: (line) => lines.push(line),
    });
    for (const id of ["a4", "a5", "a6"]) gone.add(id);
    batches.offer(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
    await tick();
    await answer('{"items":[{"n":1,"summary":"Invented line.","labels":[]}]}');
    await answer('{"items":[]}');
    await batches.idle();
    expect(calls).toEqual([["a1", "a2", "a3"], ["a7"]]);
    expect(done).toEqual([["a1", "a2", "a3"], ["a7"]]);
    expect(lines).toEqual([]);
  });

  it("queues that share a gate run one call at a time, so the owner always finds a free slot", async () => {
    const gate = new UnattendedGate();
    const make = (label: string) =>
      new UnattendedAiQueue<string>({
        kind: "sort",
        label,
        batch: 1,
        limit: 20,
        enabled: () => true,
        build: (ids) => ({ built: summaryInput([source(ids[0]!)], { nonce: NONCE }), context: { labels: [] }, ids: [ids[0]!], made: ids[0]! }),
        jobs,
        context: () => ({ provider: "", model: "" }),
        done: () => {},
        logCall: () => {},
        budget: new DraftBudget(clock, 100),
        schedule: () => () => {},
        log: (line) => lines.push(line),
        gate,
      });
    const [first, second] = [make("one"), make("two")];
    first.offer(["a1"]);
    second.offer(["b1"]);
    await tick();
    expect(translator.calls).toHaveLength(1);
    // The owner's own request still starts.
    expect(() => jobs.start("summary", summaryInput([source("x1")], { nonce: NONCE }), { provider: "", model: "" })).not.toThrow();
    await tick();
    expect(translator.calls).toHaveLength(2);
    translator.calls[0]!.onText('{"items":[]}');
    translator.calls[0]!.resolve("complete");
    await tick();
    expect(translator.calls).toHaveLength(3);
    expect(translator.calls[2]!.request.input).toContain("Invented question in b1?");
    translator.calls[2]!.onText('{"items":[]}');
    translator.calls[2]!.resolve("complete");
    await first.idle();
    await second.idle();
    expect(lines).toEqual([]);
  });

  it("a message offered just as the queue runs dry is not left behind", async () => {
    queue.offer(["m1"]);
    await tick();
    const call = translator.calls.at(-1)!;
    call.onText('{"reply":false}');
    call.resolve("complete");
    // Offered at every step of the queue's winding down.
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      queue.offer([`late-${i}`]);
      if (translator.calls.length > 1) break;
    }
    await tick();
    expect(translator.calls.length).toBeGreaterThan(1);
    expect(queue.size()).toBeLessThan(40);
    queue.dispose();
    await jobs.dispose();
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
