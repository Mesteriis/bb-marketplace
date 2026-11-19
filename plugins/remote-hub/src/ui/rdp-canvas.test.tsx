// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RdpCanvas } from "./rdp-canvas.tsx";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.WebSocket = FakeWebSocket;
  g.ImageData = class {};
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  HTMLCanvasElement.prototype.getContext = (() => ({ putImageData() {} })) as never;
  HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() {} })) as never;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});


/** An IntersectionObserver the test drives: `showing(ratio)` tells every view how much of it is on screen. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  constructor(readonly cb: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {
    FakeIntersectionObserver.all.push(this);
  }
  observe() {}
  disconnect() {}
  static showing(ratio: number) {
    for (const o of FakeIntersectionObserver.all) o.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
}
function lookAtScreen() {
  FakeIntersectionObserver.all = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
  document.hasFocus = () => true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
}

const msg = (socket: FakeWebSocket, value: unknown) => act(() => socket.onmessage?.({ data: JSON.stringify(value) }));

describe("RdpCanvas shows what an agent does and says it is being looked at", () => {
  it("reports visible only while the canvas is on screen in the focused window, not just mounted", async () => {
    lookAtScreen();
    render(<RdpCanvas wsUrl="ws://x/attach" token="t" fit="fit" label="desktop" onEvent={() => {}} />);
    await act(async () => {});
    const sentNow = () => FakeWebSocket.instances[0]!.messages;
    expect(sentNow()).toContainEqual({ type: "watch", visible: false });
    expect(sentNow()).not.toContainEqual({ type: "watch", visible: true });
    act(() => FakeIntersectionObserver.showing(0.8));
    expect(sentNow().at(-1)).toEqual({ type: "watch", visible: true });
    act(() => FakeIntersectionObserver.showing(0.1));
    expect(sentNow().at(-1)).toEqual({ type: "watch", visible: false });
  });

  it("draws the agent's pointer at its place on the desktop (fit: the picture is centred) and removes it after a few seconds", async () => {
    vi.useFakeTimers();
    render(<RdpCanvas wsUrl="ws://x/attach" token="t" fit="fit" label="desktop" onEvent={() => {}} />);
    await act(async () => {});
    const socket = FakeWebSocket.instances[0]!;
    msg(socket, { type: "desktop", frameId: 1, width: 800, height: 400 });
    // The box is 400x200 and the desktop 800x400: scale 0.5, no bars. (400,200) is the middle of the box.
    msg(socket, { type: "agent", event: { kind: "pointer", x: 400, y: 200, width: 800, height: 400, click: "left" } });
    const ring = screen.getByTestId("agent-pointer");
    expect(ring.style.left).toBe("200px");
    expect(ring.style.top).toBe("100px");
    expect(ring.className).toContain("rh-agent-pointer-click");
    expect(ring.textContent).toBe("агент");
    act(() => void vi.advanceTimersByTime(4100));
    expect(screen.queryByTestId("agent-pointer")).toBeNull();
  });

  it("ignores a pointer for a desktop of another size (stale) and anything malformed", async () => {
    render(<RdpCanvas wsUrl="ws://x/attach" token="t" fit="fit" label="desktop" onEvent={() => {}} />);
    await act(async () => {});
    const socket = FakeWebSocket.instances[0]!;
    msg(socket, { type: "desktop", frameId: 1, width: 800, height: 400 });
    msg(socket, { type: "agent", event: { kind: "pointer", x: 5, y: 5, width: 640, height: 480 } });
    msg(socket, { type: "agent", event: { kind: "pointer", x: "5", y: 5, width: 800, height: 400 } });
    msg(socket, { type: "agent", event: { kind: "typed", length: 3 } });
    expect(screen.queryByTestId("agent-pointer")).toBeNull();
  });
});

describe("RdpCanvas: pasting types the clipboard text", () => {
  const inputs = (socket: FakeWebSocket) => socket.messages.filter((m) => m.type === "input").flatMap((m) => m.events as unknown[]);

  it("Cmd+V does not send V, taps Control so Windows does not open Start, and types the text after Command is released", async () => {
    vi.useFakeTimers();
    render(<RdpCanvas wsUrl="ws://x/attach" token="t" fit="fit" label="desktop" onEvent={() => {}} />);
    await act(async () => {});
    const socket = FakeWebSocket.instances[0]!;
    msg(socket, { type: "attached", state: "desktop_ready", prompt: null, desktop: { frameId: 1, width: 800, height: 400 } });
    const canvas = screen.getByLabelText("desktop");
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { getData: () => "dir\n" };
    const v = new KeyboardEvent("keydown", { code: "KeyV", key: "v", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "MetaLeft", key: "Meta", metaKey: true, bubbles: true }));
      canvas.dispatchEvent(v);
      canvas.dispatchEvent(paste);
      canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV", key: "v", metaKey: true, bubbles: true }));
      vi.advanceTimersByTime(50);
    });
    expect(v.defaultPrevented).toBe(false); // the browser must still fire its paste event
    expect(inputs(socket)).toEqual([
      { kind: "key", scancode: 0x5b, extended: true, down: true },
      { kind: "key", scancode: 0x1d, extended: false, down: true },
      { kind: "key", scancode: 0x1d, extended: false, down: false },
    ]);
    act(() => {
      canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "MetaLeft", key: "Meta", bubbles: true }));
      vi.advanceTimersByTime(50);
    });
    expect(inputs(socket).slice(3)).toEqual([
      { kind: "key", scancode: 0x5b, extended: true, down: false },
      { kind: "unicode", text: "dir" },
      { kind: "key", scancode: 0x1c, extended: false, down: true },
      { kind: "key", scancode: 0x1c, extended: false, down: false },
    ]);
  });
});
