// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCH_BEAT_MS, startWatchBeat } from "./watch-beat.ts";

afterEach(() => vi.useRealTimers());

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("startWatchBeat: the view tells the service it is being looked at", () => {
  it("reports at once, then every interval, with the page's visibility", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const sent: unknown[] = [];
    const stop = startWatchBeat((m) => sent.push(m));
    expect(sent).toEqual([{ type: "watch", visible: true }]);
    vi.advanceTimersByTime(WATCH_BEAT_MS * 2);
    expect(sent).toHaveLength(3);
    stop();
    vi.advanceTimersByTime(WATCH_BEAT_MS * 3);
    expect(sent).toHaveLength(3);
  });

  it("a page that becomes hidden says so immediately (and visible again too)", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const sent: Array<{ visible: boolean }> = [];
    const stop = startWatchBeat((m) => sent.push(m as { visible: boolean }));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sent.map((m) => m.visible)).toEqual([true, false, true]);
    stop();
  });

  it("a hidden page keeps reporting hidden on every beat", () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const sent: Array<{ visible: boolean }> = [];
    const stop = startWatchBeat((m) => sent.push(m as { visible: boolean }));
    vi.advanceTimersByTime(WATCH_BEAT_MS);
    expect(sent.every((m) => m.visible === false)).toBe(true);
    stop();
  });

  it("stopping removes the visibility listener", () => {
    setVisibility("visible");
    const sent: unknown[] = [];
    const stop = startWatchBeat((m) => sent.push(m));
    stop();
    sent.length = 0;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sent).toEqual([]);
  });
});
