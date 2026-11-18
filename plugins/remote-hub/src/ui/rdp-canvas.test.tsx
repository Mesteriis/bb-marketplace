// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RdpCanvas, type RdpCanvasEvent, type RdpCanvasHandle } from "./rdp-canvas.tsx";

interface Put {
  w: number;
  h: number;
  x: number;
  y: number;
  first: number[];
}
let puts: Put[] = [];
let rafQueue: Array<() => void> = [];

class FakeImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}

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
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  get inputs(): Array<Array<Record<string, unknown>>> {
    return this.messages.filter((m) => m.type === "input").map((m) => m.events as Array<Record<string, unknown>>);
  }
  get acks(): number[] {
    return this.messages.filter((m) => m.type === "ack").map((m) => m.frameId as number);
  }
}

beforeEach(() => {
  puts = [];
  rafQueue = [];
  FakeWebSocket.instances = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.WebSocket = FakeWebSocket;
  g.ImageData = FakeImageData;
  g.requestAnimationFrame = (cb: () => void) => rafQueue.push(cb);
  g.cancelAnimationFrame = () => {
    rafQueue = [];
  };
  HTMLCanvasElement.prototype.getContext = (() => ({
    putImageData(image: FakeImageData, x: number, y: number) {
      puts.push({ w: image.width, h: image.height, x, y, first: Array.from(image.data.subarray(0, 4)) });
    },
  })) as never;
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterEach(cleanup);

/** One update chunk: header {frameId, fbW, fbH, x, y, w, h} + RGBA rows (first pixel = `rgba`). */
function chunk(frameId: number, fb: [number, number], rect: [number, number, number, number], rgba: [number, number, number, number]): ArrayBuffer {
  const [x, y, w, h] = rect;
  const buffer = new ArrayBuffer(32 + w * h * 4);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(frameId), true);
  view.setUint32(8, fb[0], true);
  view.setUint32(12, fb[1], true);
  view.setUint32(16, x, true);
  view.setUint32(20, y, true);
  view.setUint32(24, w, true);
  view.setUint32(28, h, true);
  new Uint8Array(buffer).set(rgba, 32);
  return buffer;
}

async function mount(opts: { fit?: "fit" | "actual" } = {}) {
  const events: RdpCanvasEvent[] = [];
  const handleRef = createRef<RdpCanvasHandle>();
  const view = render(
    <RdpCanvas wsUrl="ws://x/attach" token={"t".repeat(32)} fit={opts.fit ?? "actual"} label="remote desktop" onEvent={(e) => events.push(e)} handleRef={handleRef} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const socket = FakeWebSocket.instances[0];
  const canvas = view.getByRole("application") as HTMLCanvasElement;
  const send = (msg: unknown) => act(() => void socket.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) }));
  const binary = (buffer: ArrayBuffer) => act(() => void socket.onmessage?.({ data: buffer }));
  const frames = () => act(() => {
    const queued = rafQueue;
    rafQueue = [];
    queued.forEach((cb) => cb());
  });
  const ready = () => send({ type: "desktop", frameId: 1, width: 800, height: 600 });
  return { events, socket, canvas, send, binary, frames, ready, handleRef, view };
}

describe("RdpCanvas: painting and acks", () => {
  it("connects with the token and the arraybuffer type", async () => {
    const { socket } = await mount();
    expect(socket.url).toBe("ws://x/attach?attach=" + "t".repeat(32));
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("draws a full frame, sizes the canvas to the framebuffer, then a partial band at its place", async () => {
    const { canvas, binary } = await mount();
    await binary(chunk(5, [8, 4], [0, 0, 8, 4], [10, 20, 30, 255]));
    expect([canvas.width, canvas.height]).toEqual([8, 4]);
    await binary(chunk(6, [8, 4], [3, 1, 2, 2], [200, 100, 50, 255]));
    expect(puts).toEqual([
      { w: 8, h: 4, x: 0, y: 0, first: [10, 20, 30, 255] },
      { w: 2, h: 2, x: 3, y: 1, first: [200, 100, 50, 255] },
    ]);
  });

  it("a full refresh at a new desktop size resizes the canvas and repaints the whole thing", async () => {
    const { canvas, binary } = await mount();
    await binary(chunk(1, [8, 4], [0, 0, 8, 4], [1, 1, 1, 255]));
    await binary(chunk(2, [16, 8], [0, 0, 16, 8], [9, 9, 9, 255]));
    expect([canvas.width, canvas.height]).toEqual([16, 8]);
    expect(puts.at(-1)).toEqual({ w: 16, h: 8, x: 0, y: 0, first: [9, 9, 9, 255] });
  });

  it("acks ONCE per frame, after drawing: three chunks of frame 7, then frame 8 -> acks [7, 8]", async () => {
    const { socket, binary } = await mount();
    await binary(chunk(7, [8, 4], [0, 0, 8, 1], [1, 0, 0, 255]));
    expect(puts.length).toBe(1);
    expect(socket.acks).toEqual([7]);
    await binary(chunk(7, [8, 4], [0, 1, 8, 1], [2, 0, 0, 255]));
    await binary(chunk(7, [8, 4], [0, 2, 8, 2], [3, 0, 0, 255]));
    expect(socket.acks).toEqual([7]);
    await binary(chunk(8, [8, 4], [3, 1, 2, 2], [4, 0, 0, 255]));
    expect(socket.acks).toEqual([7, 8]);
    expect(puts.length).toBe(4);
  });

  it("1:1 sizes the canvas in CSS pixels from the framebuffer and the device pixel ratio; fit leaves it to the CSS", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      const actual = await mount({ fit: "actual" });
      await actual.binary(chunk(1, [8, 4], [0, 0, 8, 4], [1, 1, 1, 255]));
      expect([actual.canvas.style.width, actual.canvas.style.height]).toEqual(["4px", "2px"]);
      cleanup();
      FakeWebSocket.instances = [];
      const fitted = await mount({ fit: "fit" });
      await fitted.binary(chunk(1, [8, 4], [0, 0, 8, 4], [1, 1, 1, 255]));
      expect([fitted.canvas.style.width, fitted.canvas.style.height]).toEqual(["", ""]);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    }
  });

  it("ignores a malformed binary frame without drawing or acking", async () => {
    const { socket, binary } = await mount();
    await binary(new ArrayBuffer(10));
    expect(puts).toEqual([]);
    expect(socket.acks).toEqual([]);
  });
});

describe("RdpCanvas: events from the service", () => {
  it("reports attached, state, prompt, desktop, closed and error", async () => {
    const { events, send } = await mount();
    const prompt = { host: "h", port: 3389, fingerprint: "AA", subject: "s", issuer: "i", notBefore: "1", notAfter: "2", reason: "untrusted_root" };
    await send({ type: "attached", state: "cert_prompt", prompt, desktop: null, target: {} });
    await send({ type: "state", state: "authenticating" });
    await send({ type: "cert_prompt", prompt });
    await send({ type: "desktop", frameId: 1, width: 800, height: 600 });
    await send({ type: "error", code: "not_ready" });
    await send({ type: "closed", exitCode: null, signal: null, reason: "auth_failed" });
    expect(events.map((e) => e.type)).toEqual(["socket", "socket", "attached", "state", "cert_prompt", "desktop", "error", "closed"]);
    expect(events.at(-1)).toEqual({ type: "closed", exitCode: null, signal: null, reason: "auth_failed" });
    expect(events.find((e) => e.type === "attached")).toMatchObject({ state: "cert_prompt", prompt });
  });

  it("socket close 4410 is a helper_exited close, 4000 reports nothing (the closed message did), others detach", async () => {
    const a = await mount();
    await act(async () => void a.socket.onclose?.({ code: 4410 }));
    expect(a.events.at(-1)).toEqual({ type: "closed", exitCode: null, signal: null, reason: "helper_exited" });
    cleanup();
    FakeWebSocket.instances = [];
    const b = await mount();
    const before = b.events.length;
    await act(async () => void b.socket.onclose?.({ code: 4000 }));
    expect(b.events.length).toBe(before);
    cleanup();
    FakeWebSocket.instances = [];
    const c = await mount();
    await act(async () => void c.socket.onclose?.({ code: 1006 }));
    expect(c.events.at(-1)).toEqual({ type: "socket", state: "detached" });
    cleanup();
    FakeWebSocket.instances = [];
    const d = await mount();
    await act(async () => void d.socket.onclose?.({ code: 4401 }));
    expect(d.events.at(-1)).toEqual({ type: "error", code: "attach_token_expired" });
  });
});

describe("RdpCanvas: input", () => {
  it("sends NOTHING before desktop_ready, whatever the user does", async () => {
    const { socket, canvas, send, frames } = await mount();
    await send({ type: "attached", state: "authenticating", prompt: null, desktop: null, target: {} });
    fireEvent.mouseMove(canvas, { clientX: 10, clientY: 20 });
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 });
    fireEvent.keyDown(canvas, { code: "KeyA", key: "a" });
    fireEvent.wheel(canvas, { clientX: 10, clientY: 20, deltaY: 100 });
    await frames();
    expect(socket.inputs).toEqual([]);
  });

  it("starts after the desktop is ready: a move carries the framebuffer geometry", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 150 });
    await frames();
    expect(socket.inputs).toEqual([[{ kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 }]]);
  });

  it("an attach onto an already ready session (state desktop_ready) can send input too", async () => {
    const { socket, canvas, send, frames } = await mount();
    await send({ type: "attached", state: "desktop_ready", prompt: null, desktop: { frameId: 4, width: 800, height: 600 }, target: {} });
    fireEvent.mouseMove(canvas, { clientX: 5, clientY: 6 });
    await frames();
    expect(socket.inputs).toEqual([[{ kind: "mouse_move", x: 5, y: 6, fbWidth: 800, fbHeight: 600 }]]);
  });

  it("coalesces mouse moves to the latest position within one animation frame", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    for (const x of [10, 20, 30]) fireEvent.mouseMove(canvas, { clientX: x, clientY: 40 });
    await frames();
    expect(socket.inputs).toEqual([[{ kind: "mouse_move", x: 30, y: 40, fbWidth: 800, fbHeight: 600 }]]);
  });

  it("maps a point through the fit letterbox and drops a point inside the bar", async () => {
    const { socket, canvas, ready, frames } = await mount({ fit: "fit" });
    // Element 800x600 with an 8x4 framebuffer: scale 100, drawn 800x400, bars of 100 px top and bottom.
    await ready();
    await act(async () => void socket.onmessage?.({ data: JSON.stringify({ type: "desktop", frameId: 2, width: 8, height: 4 }) }));
    fireEvent.mouseMove(canvas, { clientX: 250, clientY: 150 }); // inside: fb (2, 0)
    fireEvent.mouseMove(canvas, { clientX: 250, clientY: 50 }); // inside the top bar: dropped
    await frames();
    expect(socket.inputs).toEqual([[{ kind: "mouse_move", x: 2, y: 0, fbWidth: 8, fbHeight: 4 }]]);
  });

  it("a click focuses the canvas and sends the move, then the button, both ways", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 150, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 150, button: 0 });
    expect(document.activeElement).toBe(canvas);
    await frames();
    expect(socket.inputs).toEqual([
      [
        { kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 },
        { kind: "mouse_button", button: "left", down: true, x: 200, y: 150, fbWidth: 800, fbHeight: 600 },
        { kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 },
        { kind: "mouse_button", button: "left", down: false, x: 200, y: 150, fbWidth: 800, fbHeight: 600 },
      ],
    ]);
  });

  it("sends the wheel with the flipped, clamped rotation and keeps the context menu off", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    fireEvent.wheel(canvas, { clientX: 10, clientY: 20, deltaY: 100, deltaX: 0, deltaMode: 0 });
    const prevented = !fireEvent.contextMenu(canvas);
    await frames();
    expect(socket.inputs).toEqual([
      [
        { kind: "mouse_move", x: 10, y: 20, fbWidth: 800, fbHeight: 600 },
        { kind: "mouse_wheel", vertical: -100, horizontal: 0, x: 10, y: 20, fbWidth: 800, fbHeight: 600 },
      ],
    ]);
    expect(prevented).toBe(true);
  });

  it("forwards keys by scancode, prevents their default, and sends unicode for a printable key without one", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    const down = fireEvent.keyDown(canvas, { code: "KeyA", key: "a" });
    fireEvent.keyUp(canvas, { code: "KeyA", key: "a" });
    fireEvent.keyDown(canvas, { code: "IntlBackslash9", key: "é" });
    fireEvent.keyDown(canvas, { code: "Escape", key: "Escape" });
    await frames();
    expect(down).toBe(false); // preventDefault was called
    expect(socket.inputs).toEqual([
      [
        { kind: "key", scancode: 0x1e, extended: false, down: true },
        { kind: "key", scancode: 0x1e, extended: false, down: false },
        { kind: "unicode", text: "é" },
        { kind: "key", scancode: 0x01, extended: false, down: true },
      ],
    ]);
  });

  it("releases the keys still held when focus is lost, once", async () => {
    const { socket, canvas, ready, frames } = await mount();
    await ready();
    fireEvent.keyDown(canvas, { code: "ControlLeft", key: "Control" });
    fireEvent.keyDown(canvas, { code: "KeyC", key: "c" });
    fireEvent.keyUp(canvas, { code: "KeyC", key: "c" });
    await frames();
    const before = socket.inputs.length;
    fireEvent.blur(canvas);
    fireEvent.blur(canvas);
    expect(socket.inputs.slice(before)).toEqual([[{ kind: "key", scancode: 0x1d, extended: false, down: false }]]);
  });

  it("ctrl_alt_del from the handle goes out at once, and only when the desktop is ready", async () => {
    const { socket, ready, handleRef } = await mount();
    handleRef.current!.sendCtrlAltDel();
    expect(socket.inputs).toEqual([]);
    await ready();
    handleRef.current!.sendCtrlAltDel();
    expect(socket.inputs).toEqual([[{ kind: "ctrl_alt_del" }]]);
  });

  it("an input the engine drops as stale_geometry shows a notice and asks for a fresh frame", async () => {
    const { events, socket, send } = await mount();
    await send({ type: "input_rejected", applied: 0, rejected: [{ index: 0, code: "stale_geometry" }] });
    expect(events.at(-1)).toEqual({ type: "notice", text: "the desktop size changed; input was dropped and the picture is being refreshed" });
    expect(socket.messages.filter((m) => m.type === "refresh").length).toBe(1);
    await send({ type: "input_rejected", applied: 0, rejected: [{ index: 0, code: "out_of_bounds" }] });
    expect(socket.messages.filter((m) => m.type === "refresh").length).toBe(1);
  });

  it("stops sending input once the session is closed", async () => {
    const { socket, canvas, ready, send, frames } = await mount();
    await ready();
    await send({ type: "closed", exitCode: null, signal: null, reason: "server_disconnected" });
    fireEvent.mouseMove(canvas, { clientX: 1, clientY: 1 });
    fireEvent.keyDown(canvas, { code: "KeyA", key: "a" });
    await frames();
    expect(socket.inputs).toEqual([]);
  });

  it("detaches and releases held keys on unmount", async () => {
    const { socket, canvas, ready, view } = await mount();
    await ready();
    fireEvent.keyDown(canvas, { code: "ShiftLeft", key: "Shift" });
    view.unmount();
    const last = socket.messages.slice(-2);
    expect(last).toEqual([{ type: "input", events: [{ kind: "key", scancode: 0x2a, extended: false, down: false }] }, { type: "detach" }]);
  });

  it("is a labelled, keyboard-reachable application region", async () => {
    const { canvas } = await mount();
    expect(canvas.getAttribute("aria-label")).toBe("remote desktop");
    expect(canvas.tabIndex).toBe(0);
  });
});
