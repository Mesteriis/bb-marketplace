// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open() {}
    loadAddon() {}
    write() {}
    onData() {}
    dispose() {}
    cols = 80;
    rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
}

import { SshPage } from "./ssh-page.tsx";
import type { SessionHandle } from "../core/rpc.ts";

beforeEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  FakeWebSocket.instances = [];
});

afterEach(() => {
  cleanup();
});

async function connectAndRun() {
  const handle: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
  const onSshOpen = vi.fn(async () => handle);
  const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
  const onClose = vi.fn(async () => {});
  render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText("host"), { target: { value: "example.com" } });
  fireEvent.click(screen.getByText("Connect"));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onSshOpen, onAttach, onClose };
}

describe("SshPage state transitions", () => {
  it("shows connecting then running", async () => {
    await connectAndRun();
    expect(screen.getByTestId("ssh-state").textContent).toContain("running");
  });

  it("shows the error state when ssh_open rejects", async () => {
    const onSshOpen = vi.fn(async () => {
      throw new Error("session_not_found");
    });
    const onAttach = vi.fn();
    const onClose = vi.fn();
    render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("host"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByText("Connect"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("error");
    expect(screen.getByText("session_not_found")).toBeTruthy();
  });

  it("shows exit 7 when the socket reports a closed control", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "closed", exitCode: 7, signal: null, reason: "exited" }) });
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("closed");
    expect(screen.getByTestId("ssh-exit").textContent).toContain("exit 7");
  });

  it("shows detached (not closed) on socket loss", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onclose?.({ code: 1006 });
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("detached");
  });

  it("sends an initial fitted resize after the socket opens", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    expect(socket.sent).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  });
});  it("a rejected reattach shows error, not a stuck connecting state", async () => {
    const { onAttach } = await connectAndRun();
    onAttach.mockRejectedValueOnce(new Error("session_not_found"));
    fireEvent.click(screen.getByText("Reattach"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("error");
    expect(screen.getByText("session_not_found")).toBeTruthy();
    expect(screen.getByText("Connect").getAttribute("disabled")).toBeNull();
  });

  it("a 4410 close is closed with helper_exited, not detached", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onclose?.({ code: 4410 });
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("closed");
  });
