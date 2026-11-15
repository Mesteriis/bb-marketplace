import { describe, expect, it } from "vitest";
import {
  IDLE_BACKOFF_MS,
  IDLE_DEBOUNCE_MS,
  IDLE_REFUSED_CODE,
  IDLE_STABLE_MS,
  nextIdleStep,
  type WatchEnd,
} from "./idle-policy.ts";

const dropped: WatchEnd = { kind: "dropped", code: "ConnectionClosed" };

describe("nextIdleStep", () => {
  it("backs off 5 s, 30 s, 2 min, 5 min, then 15 min", () => {
    let state = { attempt: 0, lastStartedAt: 0 as number | null };
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const step = nextIdleStep(state, dropped, 1_000);
      if (step.kind !== "retry") throw new Error("expected retry");
      delays.push(step.delayMs);
      state = { attempt: step.attempt, lastStartedAt: 1_000 };
    }
    expect(delays).toEqual([5_000, 30_000, 120_000, 300_000, 900_000, 900_000, 900_000]);
    expect(IDLE_BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 300_000, 900_000]);
  });

  it("resets after a watch that lasted ten minutes", () => {
    const now = 5_000_000;
    expect(nextIdleStep({ attempt: 4, lastStartedAt: now - IDLE_STABLE_MS }, dropped, now)).toEqual({
      kind: "retry",
      delayMs: 5_000,
      attempt: 1,
    });
    expect(nextIdleStep({ attempt: 4, lastStartedAt: now - IDLE_STABLE_MS + 1 }, dropped, now)).toEqual({
      kind: "retry",
      delayMs: 900_000,
      attempt: 5,
    });
    expect(nextIdleStep({ attempt: 2, lastStartedAt: null }, dropped, now)).toMatchObject({ delayMs: 120_000 });
  });

  it("waits 15 min after a throttled login", () => {
    expect(nextIdleStep({ attempt: 0, lastStartedAt: null }, { kind: "throttled" }, 0)).toMatchObject({
      kind: "retry",
      delayMs: 900_000,
    });
  });

  it("stops on auth with a full round, and on unsupported and abort without", () => {
    expect(nextIdleStep({ attempt: 0, lastStartedAt: null }, { kind: "auth" }, 0)).toEqual({ kind: "stop", wakeFull: true });
    expect(nextIdleStep({ attempt: 0, lastStartedAt: null }, { kind: "unsupported" }, 0)).toEqual({ kind: "stop", wakeFull: false });
    expect(nextIdleStep({ attempt: 0, lastStartedAt: null }, { kind: "aborted" }, 0)).toEqual({ kind: "stop", wakeFull: false });
  });

  it("backs off a refused IDLE like any drop", () => {
    expect(IDLE_REFUSED_CODE).toBe("IdleRefused");
    const step = nextIdleStep({ attempt: 0, lastStartedAt: 0 }, { kind: "dropped", code: IDLE_REFUSED_CODE }, 10);
    expect(step).toEqual({ kind: "retry", delayMs: 5_000, attempt: 1 });
  });

  it("debounces by change kind", () => {
    expect(IDLE_DEBOUNCE_MS).toEqual({ exists: 1_000, expunge: 30_000, flags: 30_000 });
  });
});
