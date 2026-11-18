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

describe("Y5: reservations, a global ceiling, slots and no eviction of an active thread", () => {
  it("parallel calls cannot all pass: each reserves its worst-case output before it runs", () => {
    const { budget } = setup({ callsPerWindow: 10 });
    expect(budget.admit("t1", 60)).toEqual({ ok: true });
    expect(budget.admit("t1", 60)).toEqual({ ok: false, reason: "bytes", retryAfterMs: 60_000 });
    budget.charge("t1", 10, 60);
    expect(budget.admit("t1", 60)).toEqual({ ok: true });
  });

  it("a settled reservation is replaced by what was really returned, also when the window rolled over meanwhile", () => {
    const { budget, advance } = setup({ callsPerWindow: 10 });
    budget.admit("t1", 90);
    advance(60_000);
    budget.charge("t1", 20, 90);
    // the new window holds 20 bytes, not 20 - 90 or 20 + 90
    expect(budget.admit("t1", 80)).toEqual({ ok: true });
    expect(budget.admit("t1", 80)).toEqual({ ok: false, reason: "bytes", retryAfterMs: 60_000 });
  });

  it("an aggregate ceiling across threads holds even when no single thread is over its own", () => {
    const { budget } = setup({ callsPerWindow: 10, bytesPerWindow: 100, globalBytesPerWindow: 150 });
    expect(budget.admit("a", 80)).toEqual({ ok: true });
    expect(budget.admit("b", 80)).toEqual({ ok: false, reason: "global", retryAfterMs: 60_000 });
    budget.charge("a", 80, 80);
    expect(budget.admit("b", 60)).toEqual({ ok: true });
    expect(budget.admit("c", 20)).toEqual({ ok: false, reason: "global", retryAfterMs: 60_000 });
  });

  it("an aggregate call ceiling across threads", () => {
    const { budget } = setup({ callsPerWindow: 10, globalCallsPerWindow: 3 });
    for (const t of ["a", "b", "c"]) expect(budget.admit(t)).toEqual({ ok: true });
    expect(budget.admit("d")).toEqual({ ok: false, reason: "global", retryAfterMs: 60_000 });
  });

  it("many new threads cannot push out an active thread's window and so reset its count", () => {
    const { budget } = setup({ maxThreads: 2, globalCallsPerWindow: 100 });
    for (let i = 0; i < 3; i++) budget.admit("active");
    for (const t of ["b", "c", "d", "e", "f", "g", "h"]) budget.admit(t);
    expect(budget.admit("active")).toEqual({ ok: false, reason: "calls", retryAfterMs: 60_000 });
    expect(budget.trackedThreads()).toBeLessThanOrEqual(2);
  });

  it("threads past the memory bound share one overflow window instead of getting a fresh one each", () => {
    const { budget } = setup({ maxThreads: 1, globalCallsPerWindow: 100 });
    budget.admit("kept");
    for (const t of ["x1", "x2", "x3"]) expect(budget.admit(t)).toEqual({ ok: true });
    expect(budget.admit("x4")).toEqual({ ok: false, reason: "calls", retryAfterMs: 60_000 });
  });

  it("expired windows are dropped to make room, so quiet threads do not fill the table", () => {
    const { budget, advance } = setup({ maxThreads: 2 });
    budget.admit("a");
    budget.admit("b");
    advance(60_000);
    budget.admit("c");
    expect(budget.trackedThreads()).toBe(1);
  });

  it("slots limit what may run at once, and a released slot can be taken again", () => {
    const { budget } = setup();
    const a = budget.acquire("screenshot", 2);
    const b = budget.acquire("screenshot", 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(budget.acquire("screenshot", 2)).toBeNull();
    expect(budget.acquire("other", 2)).not.toBeNull();
    a!();
    a!(); // releasing twice does not free a second slot
    expect(budget.acquire("screenshot", 2)).not.toBeNull();
    expect(budget.acquire("screenshot", 2)).toBeNull();
  });
});
