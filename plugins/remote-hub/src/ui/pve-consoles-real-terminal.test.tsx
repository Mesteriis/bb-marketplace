// @vitest-environment jsdom
// The console tabs with the REAL terminal component (only xterm itself is replaced by a recording screen) and fake attach sockets:
// what the owner would see after a loss and a reconnect. The tab tests that mock the terminal cannot see a screen being cleared.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PveConsolesApi } from "./pve-consoles.tsx";
import { PveConsoles } from "./pve-consoles.tsx";

const screens: Array<{ text: string; disposed: boolean }> = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    private readonly me = { text: "", disposed: false };
    cols = 80;
    rows = 24;
    constructor() {
      screens.push(this.me);
    }
    open() {}
    loadAddon() {}
    onData() {}
    write(data: string | Uint8Array, cb?: () => void) {
      this.me.text += typeof data === "string" ? data : new TextDecoder().decode(data);
      cb?.();
    }
    get buffer() {
      const lines = () => this.me.text.split(/\r?\n/);
      return { active: { get length() { return lines().length; }, getLine: (i: number) => ({ translateToString: () => lines()[i] ?? "" }) } };
    }
    dispose() {
      this.me.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  bytes(s: string) {
    const b = new TextEncoder().encode(s);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });
  }
}

beforeEach(() => {
  screens.length = 0;
  FakeSocket.all.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function api(): PveConsolesApi {
  let n = 0;
  return {
    open: vi.fn(async () => ({ ok: true as const, generation: "a".repeat(32), sessionId: ++n, kind: "pve" as const, node: "pve1" })),
    attach: vi.fn(async (h) => ({ token: "t" + h.sessionId, wsUrl: "ws://x/attach" })),
    close: vi.fn(async () => undefined),
  };
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

describe("a lost terminal console, with the real terminal component", () => {
  it("the earlier screen stays above a 'connection lost' line and the new console's terminal starts with it and 'reconnected'", async () => {
    render(<PveConsoles api={api()} launch={{ nonce: 1, profileId: "p1", connectionName: "lab", request: { console: "lxc", vmid: 165 }, title: "ct", }} />);
    await settle();
    const first = last();
    await act(async () => {
      first.open();
      first.text({ type: "console", state: "active", reason: null });
      first.bytes("root@ct:~# ls\r\nfile-a\r\n");
    });
    expect(screens[0]!.text).toContain("file-a");
    // the other side ends the console: the service says lost, then closed, then closes the socket
    await act(async () => {
      first.text({ type: "console", state: "lost", reason: { code: "remote_closed", text: "Proxmox closed the console.", fingerprint: null } });
      first.text({ type: "closed", exitCode: null, signal: null, reason: "remote_closed" });
      first.onclose?.({ code: 4000 });
    });
    expect(screen.getByTestId("pve-console-state").textContent).toContain("reconnecting");
    expect(screens[0]!.text).toContain("connection lost");
    // the automatic attempt (1 s) opens a new console; its terminal must carry the old screen
    await act(async () => void (await new Promise((r) => setTimeout(r, 1500))));
    await settle();
    expect(FakeSocket.all.length).toBe(2);
    const second = screens[screens.length - 1]!;
    expect(second.text).toContain("file-a");
    expect(second.text).toContain("connection lost");
    expect(second.text).toContain("reconnected: a new console");
    // scrolled out of the viewport (one screen of blank lines follows), so a clear-screen from the guest cannot erase it
    expect(second.text.endsWith("\r\n".repeat(24))).toBe(true);
  }, 10_000);

  it("a manual Reconnect keeps the screen too", async () => {
    render(<PveConsoles api={api()} launch={{ nonce: 1, profileId: "p1", connectionName: "lab", request: { console: "lxc", vmid: 165 }, title: "ct" }} />);
    await settle();
    await act(async () => {
      last().open();
      last().text({ type: "console", state: "active", reason: null });
      last().bytes("hello-screen\r\n");
    });
    await act(async () => {
      last().text({ type: "console", state: "error", reason: { code: "no_permission", text: "x", fingerprint: null } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Переподключить" }));
    await settle();
    await settle();
    expect(FakeSocket.all.length).toBe(2);
    expect(screens[screens.length - 1]!.text).toContain("hello-screen");
  });

  it("Disconnect then Reconnect keeps the screen with both separators, and a second loss stacks a new pair", async () => {
    render(<PveConsoles api={api()} launch={{ nonce: 1, profileId: "p1", connectionName: "lab", request: { console: "lxc", vmid: 165 }, title: "ct" }} />);
    await settle();
    await act(async () => {
      last().open();
      last().text({ type: "console", state: "active", reason: null });
      last().bytes("first-screen\r\n");
    });
    fireEvent.click(screen.getByRole("button", { name: "Отключить" }));
    fireEvent.click(screen.getByRole("button", { name: "Переподключить" }));
    await settle();
    await settle();
    const second = screens[screens.length - 1]!.text;
    expect(second).toContain("first-screen");
    expect(second).toContain("connection lost");
    expect(second).toContain("reconnected: a new console");
    await act(async () => {
      last().open();
      last().text({ type: "console", state: "active", reason: null });
      last().bytes("second-screen\r\n");
    });
    fireEvent.click(screen.getByRole("button", { name: "Отключить" }));
    fireEvent.click(screen.getByRole("button", { name: "Переподключить" }));
    await settle();
    await settle();
    const third = screens[screens.length - 1]!.text;
    expect(third).toContain("first-screen");
    expect(third).toContain("second-screen");
    expect((third.match(/reconnected: a new console/g) ?? []).length).toBe(2);
  });
});
