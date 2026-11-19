import { describe, expect, it, vi } from "vitest";
import { LIVE_TAB_ID, revealSession } from "./reveal.ts";

const KEY = `${"a".repeat(32)}.4`;

describe("revealSession: open the live view without a click, if BB lets us", () => {
  it("opens the registered tab on the thread's side panel with the session as its parameter", () => {
    const openTab = vi.fn(() => true);
    const seen = new Set<string>();
    expect(revealSession({ openTab }, KEY, seen)).toBe(true);
    expect(openTab).toHaveBeenCalledWith({ tab: { id: LIVE_TAB_ID, context: { kind: "thread" }, availability: "action" }, params: { sessionId: KEY }, title: "Remote Hub" });
    expect(seen.has(KEY)).toBe(true);
  });

  it("does not open the same session twice", () => {
    const openTab = vi.fn(() => true);
    const seen = new Set<string>();
    revealSession({ openTab }, KEY, seen);
    expect(revealSession({ openTab }, KEY, seen)).toBe(false);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("when BB declines (no side panel here) nothing is remembered, so a later signal may try again; the banner is the fallback", () => {
    const openTab = vi.fn(() => false);
    const seen = new Set<string>();
    expect(revealSession({ openTab }, KEY, seen)).toBe(false);
    expect(seen.size).toBe(0);
    openTab.mockReturnValue(true);
    expect(revealSession({ openTab }, KEY, seen)).toBe(true);
  });

  it("a panel that throws is a decline too", () => {
    expect(
      revealSession({ openTab: () => { throw new Error("no panel"); } }, KEY, new Set()),
    ).toBe(false);
  });
});
