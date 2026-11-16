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

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {}
}

import { SshPage } from "./ssh-page.tsx";
import type { SessionHandle } from "../core/rpc.ts";

beforeEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  cleanup();
});

describe("SshPage state transitions", () => {
  it("shows connecting then running", async () => {
    const handle: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
    const onSshOpen = vi.fn(async () => handle);
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    const onClose = vi.fn(async () => {});

    render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("host"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByText("Connect"));
    expect(screen.getByTestId("ssh-state").textContent).toContain("connecting");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
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
});
