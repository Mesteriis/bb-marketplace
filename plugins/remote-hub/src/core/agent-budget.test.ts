import { describe, expect, it } from "vitest";
import { ToolBudget } from "./agent-budget.ts";

function setup(over: Partial<ConstructorParameters<typeof ToolBudget>[0]> = {}) {
  let now = 1_000_000;
  const budget = new ToolBudget({ now: () => now, callsPerWindow: 3, bytesPerWindow: 100, windowMs: 60_000, ...over });
  return { budget, advance: (ms: number) => void (now += ms) };
}

describe("per-thread tool budget", () => {
  it("admits the configured number of calls per window and then refuses with a retry time", () => {
    const { budget } = setup();
    expect(budget.admit("t1")).toEqual({ ok: true });
    expect(budget.admit("t1")).toEqual({ ok: true });
    expect(budget.admit("t1")).toEqual({ ok: true });
    expect(budget.admit("t1")).toEqual({ ok: false, reason: "calls", retryAfterMs: 60_000 });
  });

  it("a new window starts after windowMs", () => {
    const { budget, advance } = setup();
    for (let i = 0; i < 3; i++) budget.admit("t1");
    advance(60_000);
    expect(budget.admit("t1")).toEqual({ ok: true });
  });

  it("threads do not share a budget", () => {
    const { budget } = setup();
    for (let i = 0; i < 3; i++) budget.admit("t1");
    expect(budget.admit("t2")).toEqual({ ok: true });
  });

  it("output bytes are charged, and a thread over its byte budget is refused until the window ends", () => {
    const { budget, advance } = setup();
    budget.admit("t1");
    budget.charge("t1", 100);
    expect(budget.admit("t1")).toEqual({ ok: false, reason: "bytes", retryAfterMs: 60_000 });
    advance(30_000);
    expect(budget.admit("t1")).toEqual({ ok: false, reason: "bytes", retryAfterMs: 30_000 });
    advance(30_000);
    expect(budget.admit("t1")).toEqual({ ok: true });
  });

  it("remembers a bounded number of threads", () => {
    const { budget } = setup({ maxThreads: 2 });
    budget.admit("a");
    budget.admit("b");
    budget.admit("c");
    expect(budget.trackedThreads()).toBe(2);
  });
});
