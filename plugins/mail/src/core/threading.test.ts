import { describe, expect, it } from "vitest";
import { buildThreads, normalizeSubject } from "./threading.ts";
import type { ThreadingInput } from "./model.ts";

function msg(overrides: Partial<ThreadingInput> & { id: string }): ThreadingInput {
  return {
    messageId: null,
    inReplyTo: null,
    references: [],
    subject: "Invented topic",
    date: "2026-10-01T10:00:00.000Z",
    gmThreadId: null,
    ...overrides,
  };
}

function day(n: number): string {
  return new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
}

describe("normalizeSubject", () => {
  it("strips Re:, Fwd:, Fw:, Ответ: and RE: repeatedly, trims and lowercases", () => {
    expect(normalizeSubject("Re: Fwd: Fw: Ответ: RE:  Garden Plans ")).toBe("garden plans");
    expect(normalizeSubject("re:fwd:Garden")).toBe("garden");
    expect(normalizeSubject("ОТВЕТ: Сад")).toBe("сад");
    expect(normalizeSubject("Garden Re: plans")).toBe("garden re: plans");
    expect(normalizeSubject("Re:")).toBe("");
  });
});

describe("buildThreads", () => {
  it("groups by gmThreadId", () => {
    const threads = buildThreads([
      msg({ id: "a", gmThreadId: "g1", subject: "One", date: day(0) }),
      msg({ id: "b", gmThreadId: "g1", subject: "Two", date: day(100) }),
      msg({ id: "c", gmThreadId: "g2", subject: "One", date: day(1) }),
    ]);
    expect(threads.get("a")).toBe("t_a");
    expect(threads.get("b")).toBe("t_a");
    expect(threads.get("c")).toBe("t_c");
  });

  it("follows In-Reply-To and References chains", () => {
    const threads = buildThreads([
      msg({ id: "root", messageId: "<root@example.org>", subject: "Plan", date: day(0) }),
      msg({
        id: "reply",
        messageId: "<reply@example.org>",
        inReplyTo: "<root@example.org>",
        subject: "Different subject",
        date: day(1),
      }),
      msg({
        id: "deep",
        messageId: "<deep@example.org>",
        references: ["<root@example.org>", "<reply@example.org>"],
        subject: "Yet another",
        date: day(2),
      }),
      // A reply to a message we never saw still joins its siblings via the phantom parent.
      msg({ id: "orphan1", messageId: "<o1@example.org>", inReplyTo: "<gone@example.org>", subject: "X", date: day(3) }),
      msg({ id: "orphan2", messageId: "<o2@example.org>", references: ["<gone@example.org>"], subject: "Y", date: day(4) }),
      msg({ id: "other", messageId: "<other@example.org>", subject: "Unrelated", date: day(1) }),
    ]);
    expect(threads.get("root")).toBe("t_root");
    expect(threads.get("reply")).toBe("t_root");
    expect(threads.get("deep")).toBe("t_root");
    expect(threads.get("orphan1")).toBe("t_orphan1");
    expect(threads.get("orphan2")).toBe("t_orphan1");
    expect(threads.get("other")).toBe("t_other");
  });

  it("threads messages without Message-ID by subject", () => {
    const threads = buildThreads([
      msg({ id: "m1", subject: "Garden plans", date: day(0) }),
      msg({ id: "m2", subject: "Re: Garden plans", date: day(5) }),
      msg({ id: "m3", subject: "RE: Fwd: garden PLANS ", date: day(10) }),
      msg({ id: "m4", subject: "Something else", date: day(1) }),
    ]);
    expect(threads.get("m1")).toBe("t_m1");
    expect(threads.get("m2")).toBe("t_m1");
    expect(threads.get("m3")).toBe("t_m1");
    expect(threads.get("m4")).toBe("t_m4");
  });

  it("does not join same subject more than 30 days apart", () => {
    const threads = buildThreads([
      msg({ id: "early", subject: "Monthly report", date: day(0) }),
      msg({ id: "late", subject: "Re: Monthly report", date: day(31) }),
      msg({ id: "undated", subject: "Monthly report", date: null }),
    ]);
    expect(threads.get("early")).toBe("t_early");
    expect(threads.get("late")).toBe("t_late");
    expect(threads.get("undated")).toBe("t_undated");
  });

  it("does not merge distinct messages sharing a Message-ID", () => {
    const inputs = [
      msg({ id: "first", messageId: "<same@example.org>", subject: "Alpha", date: day(0) }),
      msg({ id: "second", messageId: "<same@example.org>", subject: "Beta", date: day(1) }),
    ];
    let threads = new Map<string, string>();
    expect(() => {
      threads = buildThreads(inputs);
    }).not.toThrow();
    expect(threads.get("first")).toBe("t_first");
    expect(threads.get("second")).toBe("t_second");

    // Each duplicate keeps the place its own references give it.
    const replies = buildThreads([
      msg({ id: "p", messageId: "<p@example.org>", subject: "Alpha", date: day(0) }),
      msg({ id: "q", messageId: "<q@example.org>", subject: "Beta", date: day(0) }),
      msg({ id: "dup1", messageId: "<dup@example.org>", inReplyTo: "<p@example.org>", subject: "Gamma", date: day(1) }),
      msg({ id: "dup2", messageId: "<dup@example.org>", inReplyTo: "<q@example.org>", subject: "Delta", date: day(2) }),
    ]);
    expect(replies.get("dup1")).toBe("t_p");
    expect(replies.get("dup2")).toBe("t_q");
  });

  it("thread id is t_ + earliest message id and stable when input order changes", () => {
    const inputs = [
      msg({ id: "z-late", messageId: "<r@example.org>", inReplyTo: "<q@example.org>", date: day(3) }),
      msg({ id: "y-undated", messageId: "<s@example.org>", inReplyTo: "<r@example.org>", date: null }),
      msg({ id: "x-mid", messageId: "<q@example.org>", inReplyTo: "<p@example.org>", date: day(2) }),
      msg({ id: "b-first", messageId: "<p@example.org>", date: day(1) }),
      msg({ id: "a-tie", messageId: "<t@example.org>", inReplyTo: "<p@example.org>", date: day(1) }),
      msg({ id: "solo", subject: "Unrelated", date: day(0) }),
    ];
    const forward = buildThreads(inputs);
    const backward = buildThreads([...inputs].reverse());
    const shuffled = buildThreads([inputs[3]!, inputs[0]!, inputs[5]!, inputs[2]!, inputs[4]!, inputs[1]!]);

    // Earliest date is day(1), shared by b-first and a-tie; the smaller id wins.
    for (const id of ["z-late", "y-undated", "x-mid", "b-first", "a-tie"]) {
      expect(forward.get(id)).toBe("t_a-tie");
    }
    expect(forward.get("solo")).toBe("t_solo");
    expect([...backward].sort()).toEqual([...forward].sort());
    expect([...shuffled].sort()).toEqual([...forward].sort());
  });

  it("every input id appears in the result", () => {
    const inputs: ThreadingInput[] = [
      msg({ id: "plain" }),
      msg({ id: "empty-subject", subject: "" }),
      msg({ id: "bad-date", date: "not a date" }),
      msg({ id: "self-ref", messageId: "<me@example.org>", inReplyTo: "<me@example.org>", references: ["<me@example.org>"] }),
      msg({ id: "cycle-a", messageId: "<ca@example.org>", references: ["<cb@example.org>"] }),
      msg({ id: "cycle-b", messageId: "<cb@example.org>", references: ["<ca@example.org>"] }),
      msg({ id: "junk-refs", references: ["", "   ", "<>", "<x@example.org>"] }),
      msg({ id: "gm", gmThreadId: "g9" }),
    ];
    const threads = buildThreads(inputs);
    expect(threads.size).toBe(inputs.length);
    for (const input of inputs) {
      expect(threads.get(input.id)).toMatch(/^t_/);
    }
    expect(threads.get("cycle-a")).toBe(threads.get("cycle-b"));
    expect(buildThreads([]).size).toBe(0);
  });

  it("20,000 references builds in well under 200 ms and still threads by In-Reply-To", () => {
    // A crafted References header: many ids, with repeats, ending at the parent.
    const crafted = Array.from({ length: 20_000 }, (_, i) => `<junk-${i % 15_000}@example.org>`);
    const inputs = [
      msg({ id: "parent", messageId: "<parent@example.org>", subject: "One", date: day(0) }),
      msg({
        id: "reply-1",
        messageId: "<reply-1@example.org>",
        inReplyTo: "<parent@example.org>",
        references: crafted,
        subject: "Two",
        date: day(1),
      }),
      msg({
        id: "reply-2",
        messageId: "<reply-2@example.org>",
        inReplyTo: "<parent@example.org>",
        references: [...crafted].reverse(),
        subject: "Three",
        date: day(2),
      }),
      msg({ id: "other", messageId: "<other@example.org>", subject: "Four", date: day(3) }),
    ];

    const started = performance.now();
    const threads = buildThreads(inputs);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(200);
    expect(threads.get("reply-1")).toBe("t_parent");
    expect(threads.get("reply-2")).toBe("t_parent");
    expect(threads.get("other")).toBe("t_other");
  });
});
