// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCH_BEAT_MS, startWatchBeat, type WatchEnv } from "./watch-beat.ts";

afterEach(() => vi.useRealTimers());

/** An observer the test drives by hand. */
class FakeObserver {
  static last: FakeObserver | null = null;
  disconnected = false;
  constructor(readonly cb: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {
    FakeObserver.last = this;
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  see(ratio: number): void {
    this.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
}

function setup(over: { visible?: boolean; focused?: boolean; observer?: boolean } = {}) {
  let visible = over.visible ?? true;
  let focused = over.focused ?? true;
  const doc = document;
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
  doc.hasFocus = () => focused;
  const env: WatchEnv = { document: doc, window, ...(over.observer === false ? {} : { IntersectionObserver: FakeObserver as unknown as typeof IntersectionObserver }) };
  const sent: boolean[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const stop = startWatchBeat((m) => sent.push(m.visible), target, env);
  return {
    sent,
    target,
    stop,
    see: (r: number) => FakeObserver.last!.see(r),
    setVisible: (v: boolean) => {
      visible = v;
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    setFocused: (f: boolean) => {
      focused = f;
      window.dispatchEvent(new Event(f ? "focus" : "blur"));
    },
  };
}

describe("startWatchBeat: the view tells the service it is on screen in the focused window", () => {
  it("is not visible until the element is at least half inside the viewport", () => {
    vi.useFakeTimers();
    const t = setup();
    expect(t.sent).toEqual([false]); // visible document, focused window, but nothing seen yet
    t.see(0.49);
    expect(t.sent.at(-1)).toBe(false);
    t.see(0.5);
    expect(t.sent.at(-1)).toBe(true);
    t.see(0);
    expect(t.sent.at(-1)).toBe(false);
    t.stop();
  });

  it("an off-screen element keeps reporting false on every beat (a mounted view that is scrolled away or hidden by a tab)", () => {
    vi.useFakeTimers();
    const t = setup();
    t.see(0);
    vi.advanceTimersByTime(WATCH_BEAT_MS * 3);
    expect(t.sent.every((v) => v === false)).toBe(true);
    t.stop();
  });

  it("needs a visible document AND a focused window, and says so at once when either changes", () => {
    vi.useFakeTimers();
    const t = setup();
    t.see(1);
    t.sent.length = 0;
    t.setVisible(false);
    t.setVisible(true);
    t.setFocused(false);
    t.setFocused(true);
    expect(t.sent).toEqual([false, true, false, true]);
    t.stop();
  });

  it("stops counting an inert ancestor even while the observer still reports full intersection", () => {
    vi.useFakeTimers();
    const t = setup();
    const panel = document.createElement("div");
    document.body.append(panel);
    panel.append(t.target);
    t.see(1);
    panel.setAttribute("inert", "");
    vi.advanceTimersByTime(WATCH_BEAT_MS);
    expect(t.sent.at(-1)).toBe(false);
    t.stop();
    panel.remove();
  });

  it("reports every interval and stops when the view goes away", () => {
    vi.useFakeTimers();
    const t = setup();
    t.see(1);
    const n = t.sent.length;
    vi.advanceTimersByTime(WATCH_BEAT_MS * 2);
    expect(t.sent.length).toBe(n + 2);
    t.stop();
    expect(FakeObserver.last!.disconnected).toBe(true);
    vi.advanceTimersByTime(WATCH_BEAT_MS * 3);
    window.dispatchEvent(new Event("focus"));
    expect(t.sent.length).toBe(n + 2);
  });

  it("without an IntersectionObserver, without an element or without a document the view is never visible", () => {
    vi.useFakeTimers();
    const noObserver = setup({ observer: false });
    vi.advanceTimersByTime(WATCH_BEAT_MS);
    expect(noObserver.sent.every((v) => v === false)).toBe(true);
    noObserver.stop();

    const sent: boolean[] = [];
    const stopNoTarget = startWatchBeat((m) => sent.push(m.visible), null, { document, window, IntersectionObserver: FakeObserver as unknown as typeof IntersectionObserver });
    stopNoTarget();
    const sentNoDoc: boolean[] = [];
    const stopNoDoc = startWatchBeat((m) => sentNoDoc.push(m.visible), document.createElement("div"), { IntersectionObserver: FakeObserver as unknown as typeof IntersectionObserver });
    FakeObserver.last!.see(1);
    stopNoDoc();
    expect(sent).toEqual([false]);
    expect(sentNoDoc.every((v) => v === false)).toBe(true);
  });
});
