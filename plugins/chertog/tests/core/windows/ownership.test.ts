import { describe, expect, it } from "vitest";
import { transition, type Placement } from "../../../src/core/windows/ownership.ts";

const initial: Placement = { owner: "source", generation: 1, transfer: null };
const present = new Set(["source", "first", "second"]);
const prepare = { action: "prepare", target: "first" } as const;
const pending = () => transition(initial, "source", 1, prepare, present, 100);

describe("one owner of a thread placement", () => {
  it("reserves one destination when requests name the same generation", () => {
    const p = pending();
    expect(p.owner).toBe("source");
    expect(() => transition(p, "source", 1, { ...prepare, target: "second" }, present, 101)).toThrow();
  });
  it("requires acknowledgement from the exact target and a fenced switch by the source", () => {
    const p = pending();
    expect(() => transition(p, "second", 2, { action: "ready" }, present, 101)).toThrow();
    expect(() => transition(p, "source", 2, { action: "switch" }, present, 101)).toThrow();
    const ready = transition(p, "first", 2, { action: "ready" }, present, 101);
    expect(ready.owner).toBe("source");
    expect(() => transition(ready, "source", 2, { action: "switch" }, present, 102)).toThrow();
    expect(transition(ready, "source", 3, { action: "switch" }, present, 102).owner).toBe("first");
  });
  it("retains the source after refusal, destination loss or expiry", () => {
    const p = pending();
    expect(transition(p, "first", 2, { action: "cancel" }, present, 101)).toEqual({ ...initial, generation: 3 });
    const ready = transition(p, "first", 2, { action: "ready" }, present, 101);
    for (const [windows, now] of [
      [new Set(["source"]), 102],
      [present, 100000],
    ] as const) {
      expect(() => transition(ready, "source", 3, { action: "switch" }, windows, now)).toThrow();
      expect(ready.owner).toBe("source");
    }
  });
});

it("releases a prepared destination that never confirms its mounted chat after switching", () => {
  const ready = transition(pending(), "first", 2, { action: "ready" }, present, 101);
  const switched = transition(ready, "source", 3, { action: "switch" }, present, 102);
  expect(() => transition(switched, "first", 4, { action: "received" }, present, 40000)).toThrow();
});

it("a closed source panel frees its claim while that window stays connected", () => {
  const closed = transition(initial, "source", 1, { action: "release" }, present, 100);
  expect(closed).toEqual({ owner: null, generation: 2, transfer: null });
  expect(transition(closed, "second", 2, { action: "claim" }, present, 101).owner).toBe("second");
  expect(() => transition(closed, "source", 1, { action: "claim" }, present, 101)).toThrow();
});
