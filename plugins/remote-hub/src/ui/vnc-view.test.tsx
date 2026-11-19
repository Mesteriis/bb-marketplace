// @vitest-environment jsdom
// The graphical console end to end in the page: the real noVNC 1.6.0 (the vendored copy under vendor/novnc) against a small fake RFB
// server behind a fake attach socket. The server speaks first, as PVE's QEMU console does: version, security type 2 (VNC
// authentication), challenge, result, ServerInit, then a raw framebuffer update.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type RfbType from "@novnc/novnc/core/rfb.js";
import { VncView, type VncViewState } from "./vnc-view.tsx";

const PASSWORD = "vnc-pw-sentinel-5";
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** The bytes the client wrote, split into RFB messages as the protocol defines them. */
class FakeRfbServer {
  private buf: number[] = [];
  stage: "version" | "security" | "response" | "init" | "running" = "version";
  clientMessages: Array<{ type: number; bytes: number[] }> = [];
  authResponse: number[] | null = null;
  textFromClient: string[] = [];
  constructor(private readonly sendBinary: (bytes: number[]) => void) {}

  greeting(): void {
    this.sendBinary([...text("RFB 003.008\n")]);
  }

  receive(bytes: Uint8Array): void {
    this.buf.push(...bytes);
    for (;;) {
      if (this.stage === "version") {
        if (this.buf.length < 12) return;
        this.buf.splice(0, 12);
        this.sendBinary([1, 2]); // one security type: VNC authentication
        this.stage = "security";
      } else if (this.stage === "security") {
        if (this.buf.length < 1) return;
        this.buf.splice(0, 1);
        this.sendBinary(Array.from({ length: 16 }, (_, i) => i + 1)); // the challenge
        this.stage = "response";
      } else if (this.stage === "response") {
        if (this.buf.length < 16) return;
        this.authResponse = this.buf.splice(0, 16);
        this.sendBinary(u32(0)); // SecurityResult: ok
        this.stage = "init";
      } else if (this.stage === "init") {
        if (this.buf.length < 1) return;
        this.buf.splice(0, 1); // ClientInit (shared flag)
        const name = [...text("fake-guest")];
        // ServerInit: 2x1, 32 bpp / depth 24, little endian, true colour, 255/255/255, shifts 16/8/0
        this.sendBinary([...u16(2), ...u16(1), 32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0, ...u32(name.length), ...name]);
        this.stage = "running";
      } else {
        const size = this.messageSize();
        if (size === null || this.buf.length < size) return;
        const bytes = this.buf.splice(0, size);
        this.clientMessages.push({ type: bytes[0] as number, bytes });
        if (bytes[0] === 3) this.frame(); // FramebufferUpdateRequest -> one raw rectangle
      }
    }
  }

  private messageSize(): number | null {
    const type = this.buf[0];
    if (type === undefined) return null;
    if (type === 0) return 20; // SetPixelFormat
    if (type === 2) return this.buf.length < 4 ? null : 4 + 4 * (((this.buf[2] as number) << 8) | (this.buf[3] as number)); // SetEncodings
    if (type === 3) return 10;
    if (type === 4) return 8; // KeyEvent
    if (type === 5) return 6; // PointerEvent
    if (type === 6) return this.buf.length < 8 ? null : 8 + (((this.buf[4] as number) << 24) | ((this.buf[5] as number) << 16) | ((this.buf[6] as number) << 8) | (this.buf[7] as number));
    throw new Error("unexpected client message " + type);
  }

  framesSent = 0;
  private frame(): void {
    if (this.framesSent > 0) return;
    this.framesSent += 1;
    // FramebufferUpdate: 1 rectangle at 0,0 of 2x1, Raw encoding, two BGRX pixels
    this.sendBinary([0, 0, ...u16(1), ...u16(0), ...u16(0), ...u16(2), ...u16(1), ...u32(0), 255, 0, 0, 0, 0, 255, 0, 0]);
  }

  keyEvents(): Array<{ down: boolean; keysym: number }> {
    return this.clientMessages.filter((m) => m.type === 4).map((m) => ({ down: m.bytes[1] === 1, keysym: ((m.bytes[4] as number) << 24) | ((m.bytes[5] as number) << 16) | ((m.bytes[6] as number) << 8) | (m.bytes[7] as number) }));
  }
  pointerEvents(): Array<{ buttons: number; x: number; y: number }> {
    return this.clientMessages.filter((m) => m.type === 5).map((m) => ({ buttons: m.bytes[1] as number, x: ((m.bytes[2] as number) << 8) | (m.bytes[3] as number), y: ((m.bytes[4] as number) << 8) | (m.bytes[5] as number) }));
  }
}

let socket: FakeSocket | null = null;
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  server: FakeRfbServer;
  closed: { code?: number } | null = null;
  constructor(public url: string) {
    socket = this;
    // Like a network: the server's answer never arrives inside the call that sent the question.
    this.server = new FakeRfbServer((bytes) => void setTimeout(() => this.fromServer(Uint8Array.from(bytes)), 0));
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data === "string") this.server.textFromClient.push(data);
    else this.server.receive(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closed = { ...(code === undefined ? {} : { code }) };
    this.onclose?.({ code: code ?? 1005, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  fromServer(data: Uint8Array): void {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.onmessage?.({ data: copy.buffer });
  }
  fromServerText(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** A canvas 2D context that records what is drawn: jsdom has none. */
const draws: string[] = [];
function stubCanvas(): void {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (prop === "canvas") return document.createElement("canvas");
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        draws.push(prop);
        if (prop === "createImageData") return { data: new Uint8ClampedArray((args[0] as number) * (args[1] as number) * 4), width: args[0], height: args[1] };
        if (prop === "getImageData") return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        return undefined;
      };
    },
    set: (target, prop: string, value) => ((target[prop] = value), true),
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
}

// noVNC is about fifty modules; load them once, before the first test needs the viewer.
beforeAll(async () => {
  await import("@novnc/novnc/core/rfb.js");
});

beforeEach(() => {
  draws.length = 0;
  socket = null;
  stubCanvas();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => document.body;
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount() {
  const states: VncViewState[] = [];
  const ended: Array<{ code: string; text: string }> = [];
  const consoles: string[] = [];
  let instance: RfbType | null = null;
  const loadRfb = async () => {
    const RFB = (await import("@novnc/novnc/core/rfb.js")).default;
    return class extends RFB {
      constructor(...args: ConstructorParameters<typeof RFB>) {
        super(...args);
        instance = this;
      }
    } as typeof RFB;
  };
  const view = render(<VncView wsUrl="ws://x/attach" token="tok-1" loadRfb={loadRfb} onViewState={(s) => states.push(s)} onEnded={(e) => ended.push(e)} onConsole={(c) => consoles.push(c.state)} />);
  return { view, states, ended, consoles, rfb: () => instance as RfbType | null };
}

/** What the attach socket sends first for a graphical console: the header, the one-time password, then the RFB greeting. */
async function startSession(m: ReturnType<typeof mount>): Promise<FakeSocket> {
  await flush();
  const s = socket as FakeSocket;
  expect(s.url).toBe("ws://x/attach?attach=tok-1");
  await act(async () => {
    s.open();
    s.fromServerText({ type: "attached", console: { console: "qemu", state: "connecting" } });
    s.fromServerText({ type: "password", value: PASSWORD });
    s.server.greeting();
  });
  await flush();
  return s;
}

describe("the graphical console view", () => {
  it("runs the handshake with VNC authentication using the delivered password, then reaches the first frame", async () => {
    const m = mount();
    const s = await startSession(m);
    expect(s.server.authResponse).toHaveLength(16);
    expect(s.server.stage).toBe("running");
    expect(m.states).toContain("authenticating");
    expect(m.states).toContain("ready");
    // the client asked for the framebuffer and the raw update was drawn
    expect(s.server.clientMessages.some((c) => c.type === 3)).toBe(true);
    await flush();
    expect(draws.some((d) => d === "putImageData" || d === "drawImage")).toBe(true);
  });

  it("never sends the password back on the socket, in any form", async () => {
    const m = mount();
    const s = await startSession(m);
    const all = s.sent.map((x) => (typeof x === "string" ? x : new TextDecoder("latin1").decode(x))).join("");
    expect(all).not.toContain(PASSWORD);
    // a view message list holds only control and RFB bytes
    expect(s.server.textFromClient.every((t) => JSON.parse(t).type === "watch")).toBe(true);
  });

  it("scales the remote screen into the pane and never resizes the guest", async () => {
    const m = mount();
    await startSession(m);
    expect(m.rfb()?.scaleViewport).toBe(true);
    expect(m.rfb()?.resizeSession).toBe(false);
  });

  it("releases a modifier still held when the window loses focus, and when the tab hides", async () => {
    const m = mount();
    const s = await startSession(m);
    const canvasHost = m.view.getByTestId("vnc-view");
    await act(async () => {
      canvasHost.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", key: "Control", bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(s.server.keyEvents().filter((k) => !k.down && k.keysym === 0xffe3)).toHaveLength(1);
    // pressed again, then the tab hides
    await act(async () => {
      canvasHost.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", bubbles: true }));
    });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(s.server.keyEvents().filter((k) => !k.down && k.keysym === 0xffe1)).toHaveLength(1);
    // nothing is released twice
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(s.server.keyEvents().filter((k) => !k.down)).toHaveLength(2);
  });

  it("takes focus when the first frame is ready, and the owner's typing reaches the console as key events", async () => {
    const m = mount();
    const s = await startSession(m);
    const canvas = m.view.getByTestId("vnc-view").querySelector("canvas") as HTMLCanvasElement;
    expect(document.activeElement).toBe(canvas);
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", key: "a", bubbles: true }));
    });
    expect(s.server.keyEvents()).toEqual([
      { down: true, keysym: 0x61 },
      { down: false, keysym: 0x61 },
    ]);
  });

  it("sends the owner's mouse clicks to the console as pointer events", async () => {
    const m = mount();
    const s = await startSession(m);
    const canvas = m.view.getByTestId("vnc-view").querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: 1, clientY: 0, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent("mouseup", { button: 0, buttons: 0, clientX: 1, clientY: 0, bubbles: true }));
    });
    const pointer = s.server.pointerEvents();
    expect(pointer.some((p) => (p.buttons & 1) === 1)).toBe(true);
    expect(pointer.at(-1)?.buttons).toBe(0);
  });

  it("tells the owner when the console ends or is refused, and keeps no password", async () => {
    const m = mount();
    const s = await startSession(m);
    await act(async () => {
      s.fromServerText({ type: "closed", reason: "remote_closed", text: "Proxmox closed the console." });
    });
    expect(m.ended).toEqual([{ code: "remote_closed", text: "Proxmox closed the console." }]);
    const m2 = mount();
    await flush();
    const s2 = socket as FakeSocket;
    await act(async () => {
      s2.open();
      s2.fromServerText({ type: "error", code: "vnc_not_resumable", text: "This graphical console cannot be reattached; disconnect and open it again." });
    });
    expect(m2.ended[0]?.code).toBe("vnc_not_resumable");
  });

  it("a socket that closes without any message of its own is reported as the console lost (never left looking active)", async () => {
    const m = mount();
    const s = await startSession(m);
    await act(async () => {
      s.close(1006);
    });
    expect(m.ended).toEqual([{ code: "websocket_error", text: "The console connection broke (websocket error)." }]);
    expect(m.states.at(-1)).toBe("ended");
  });

  it("a console's own end message is the reason; the socket close that follows adds nothing", async () => {
    const m = mount();
    const s = await startSession(m);
    await act(async () => {
      s.fromServerText({ type: "closed", reason: "remote_closed", text: "Proxmox closed the console." });
      s.close(4000);
    });
    expect(m.ended).toEqual([{ code: "remote_closed", text: "Proxmox closed the console." }]);
  });

  it("unmounting ends the view: it says detach, closes the socket and disconnects noVNC", async () => {
    const m = mount();
    const s = await startSession(m);
    m.view.unmount();
    expect(s.sent.filter((x) => typeof x === "string").map((x) => JSON.parse(x as string).type)).toContain("detach");
    expect(s.closed).not.toBeNull();
  });

  it("an unavailable viewer is reported, not thrown", async () => {
    const ended: Array<{ code: string }> = [];
    render(<VncView wsUrl="ws://x/attach" token="t" loadRfb={async () => { throw new Error("no"); }} onEnded={(e) => ended.push(e)} />);
    await flush();
    expect(ended).toEqual([{ code: "viewer_unavailable", text: "The graphical viewer could not be started." }]);
  });
});
