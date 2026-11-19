// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xtermArgs: Array<{ theme?: { background: string; foreground: string }; fontFamily?: string }> = [];
const writeCallbacks: Array<() => void> = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(opts: { theme?: { background: string; foreground: string }; fontFamily?: string }) {
      xtermArgs.push(opts);
    }
    open() {}
    loadAddon() {}
    write(_data: Uint8Array, cb?: () => void) {
      if (cb) writeCallbacks.push(cb);
    }
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
import { nonJsonPath } from "../core/json-wire.ts";
import type { SessionHandle } from "../core/rpc.ts";

beforeEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  FakeWebSocket.instances = [];
  xtermArgs.length = 0;
  writeCallbacks.length = 0;
});

afterEach(() => {
  cleanup();
});

async function connectAndRun() {
  const handle: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
  const onSshOpen = vi.fn(async (_target: unknown, _profileId?: string) => handle);
  const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
  const onClose = vi.fn(async () => {});
  render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText("адрес"), { target: { value: "example.com" } });
  fireEvent.click(screen.getByText("Подключить"));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onSshOpen, onAttach, onClose };
}

describe("SshPage terminal says it is being looked at", () => {
  it("says visible only while the terminal is on screen in the focused window, not just mounted", async () => {
    lookAtScreen();
    await connectAndRun();
    const socket = FakeWebSocket.instances[0]!;
    const watches = () => socket.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d as string)).filter((m) => m.type === "watch");
    expect(watches()).toContainEqual({ type: "watch", visible: false });
    expect(watches()).not.toContainEqual({ type: "watch", visible: true });
    act(() => FakeIntersectionObserver.showing(1));
    expect(watches().at(-1)).toEqual({ type: "watch", visible: true });
    act(() => FakeIntersectionObserver.showing(0));
    expect(watches().at(-1)).toEqual({ type: "watch", visible: false });
  });
});

describe("SshPage opened from a saved profile", () => {
  const PID = "11111111-2222-4333-8444-555555555555";
  const launch = (nonce: number) => ({
    nonce,
    profileId: PID,
    target: { host: "build.example.test", user: "ci", port: 2222, identityFile: "/k/id", extraOptions: [] },
  });

  it("fills the endpoint, connects with the profile id and the profile's key, and does not repeat on a re-render", async () => {
    const handle: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
    const onSshOpen = vi.fn(async () => handle);
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    const onClose = vi.fn(async () => {});
    const view = render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(1)} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSshOpen.mock.calls).toEqual([[launch(1).target, PID, undefined]]);
    expect((screen.getByPlaceholderText("адрес") as HTMLInputElement).value).toBe("build.example.test");
    expect((screen.getByPlaceholderText("пользователь") as HTMLInputElement).value).toBe("ci");
    expect((screen.getByPlaceholderText("порт") as HTMLInputElement).value).toBe("2222");
    view.rerender(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(1)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSshOpen).toHaveBeenCalledTimes(1);
    view.rerender(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(2)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSshOpen).toHaveBeenCalledTimes(2);
  });

  it("the quick-connect form opens without a profile id", async () => {
    const { onSshOpen } = await connectAndRun();
    expect(onSshOpen.mock.calls).toEqual([[{ host: "example.com", extraOptions: [] }, undefined, undefined]]);
    // No undefined-valued key: BB's RPC refuses it before the handler.
    expect(nonJsonPath(onSshOpen.mock.calls[0]?.[0])).toBeNull();
  });
});

describe("SshPage overlapping opens (P1)", () => {
  const HA: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
  const HB: SessionHandle = { generation: "a".repeat(32), sessionId: 2 };
  const TA = { host: "a.example.test", extraOptions: [] };
  const TB = { host: "b.example.test", extraOptions: [] };
  const launch = (nonce: number, target: typeof TA) => ({ nonce, profileId: "11111111-2222-4333-8444-555555555555", target });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  const tokens = () => FakeWebSocket.instances.map((w) => decodeURIComponent(w.url.split("attach=")[1] ?? ""));

  it("a slow open that loses to a newer launch is closed, never shown, and Disconnect closes the session on screen", async () => {
    const openA = deferred<SessionHandle>();
    const onSshOpen = vi.fn((t: { host: string }) => (t.host === TA.host ? openA.promise : Promise.resolve(HB)));
    const onAttach = vi.fn(async (h: SessionHandle) => ({ token: "tok" + h.sessionId, wsUrl: "ws://x" }));
    const onClose = vi.fn(async () => {});
    const view = render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(1, TA)} />);
    view.rerender(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(2, TB)} />);
    await settle();
    expect(tokens()).toEqual(["tok2"]);
    await act(async () => {
      openA.resolve(HA); // the older open finishes last
    });
    await settle();
    expect(onClose.mock.calls).toEqual([[HA]]); // opened but lost: closed explicitly
    expect(onAttach.mock.calls.map((c) => c[0])).toEqual([HB]); // never attached
    expect(tokens()).toEqual(["tok2"]); // only B's terminal
    expect(screen.getByText(/b\.example\.test/, { selector: "strong" })).toBeTruthy();
    fireEvent.click(screen.getByText("Отключить"));
    await settle();
    expect(onClose.mock.calls).toEqual([[HA], [HB]]); // Disconnect closed B
  });

  it("a session replaced by a newer launch is closed, and its late attach cannot replace the new terminal", async () => {
    const attachA = deferred<{ token: string; wsUrl: string }>();
    const onSshOpen = vi.fn(async (t: { host: string }) => (t.host === TA.host ? HA : HB));
    const onAttach = vi.fn((h: SessionHandle) => (h.sessionId === 1 ? attachA.promise : Promise.resolve({ token: "tok2", wsUrl: "ws://x" })));
    const onClose = vi.fn(async () => {});
    const view = render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(1, TA)} />);
    await settle(); // A is open, its attach is still pending
    view.rerender(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={onClose} launch={launch(2, TB)} />);
    await settle();
    expect(onClose.mock.calls).toEqual([[HA]]); // the replaced session is closed
    await act(async () => {
      attachA.resolve({ token: "tok1", wsUrl: "ws://x" }); // A's attach arrives late
    });
    await settle();
    expect(tokens()).toEqual(["tok2"]);
  });

  it("the open that lost the race and then fails shows no error", async () => {
    const openA = deferred<SessionHandle>();
    const onSshOpen = vi.fn((t: { host: string }) => (t.host === TA.host ? openA.promise : Promise.resolve(HB)));
    const onAttach = vi.fn(async (h: SessionHandle) => ({ token: "tok" + h.sessionId, wsUrl: "ws://x" }));
    const view = render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={vi.fn(async () => {})} launch={launch(1, TA)} />);
    view.rerender(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={vi.fn(async () => {})} launch={launch(2, TB)} />);
    await settle();
    await act(async () => {
      openA.reject(new Error("boom from the stale open"));
    });
    await settle();
    expect(screen.queryByText("boom from the stale open")).toBeNull();
    expect(screen.getByTestId("ssh-state").textContent).toContain("running");
  });
});

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
    fireEvent.change(screen.getByPlaceholderText("адрес"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByText("Подключить"));
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

  it("a rejected reattach shows error, not a stuck connecting state", async () => {
    const { onAttach } = await connectAndRun();
    onAttach.mockRejectedValueOnce(new Error("session_not_found"));
    fireEvent.click(screen.getByText("Показать снова"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("error");
    expect(screen.getByText("session_not_found")).toBeTruthy();
    expect(screen.getByText("Подключить").getAttribute("disabled")).toBeNull();
  });

  it("a 4410 close is closed with helper_exited, not detached", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onclose?.({ code: 4410 });
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("closed");
  });

  it("keeps error sticky across the following close", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onerror?.();
    });
    await act(async () => {
      socket.onclose?.({ code: 1006 });
    });
    expect(screen.getByTestId("ssh-state").textContent).toContain("error");
  });

  it("acks only live frames even when write callbacks run later", async () => {
    await connectAndRun();
    const socket = FakeWebSocket.instances[0];
    socket.onmessage?.({ data: new Uint8Array(100) }); // snapshot bytes
    socket.onmessage?.({ data: JSON.stringify({ type: "live" }) });
    socket.onmessage?.({ data: new Uint8Array(200) }); // live bytes
    for (const cb of writeCallbacks) cb();
    const acks = socket.sent.filter((d) => typeof d === "string" && d.includes('"ack"'));
    expect(acks).toEqual([JSON.stringify({ type: "ack", bytes: 200 })]);
  });

  it("resolves theme colours via getComputedStyle", async () => {
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (k: string) =>
        ({ "--canvas": "#111111", "--ink": "#eeeeee", "--font-terminal": "mono" })[k] ?? "",
    }));
    await connectAndRun();
    expect(xtermArgs[0]?.theme).toEqual({ background: "#111111", foreground: "#eeeeee" });
    expect(xtermArgs[0]?.fontFamily).toBe("mono");
  });
});

describe("SshPage and OpenSSH's questions / a saved secret", () => {
  const PID = "11111111-2222-4333-8444-555555555555";
  const REF = "rh-cred:v1:local:00000000-0000-4000-8000-000000000001";
  const HANDLE: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  async function launched() {
    const onSshOpen = vi.fn(async () => HANDLE);
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    const onClose = vi.fn(async () => {});
    render(
      <SshPage
        onSshOpen={onSshOpen}
        onAttach={onAttach}
        onClose={onClose}
        launch={{ nonce: 1, profileId: PID, target: { host: "box.test", user: "root", port: 2222, extraOptions: [] }, credentialRef: REF }}
      />,
    );
    await settle();
    return { onSshOpen, socket: FakeWebSocket.instances[0] };
  }

  it("passes the saved credential reference to the open, and nothing secret", async () => {
    const { onSshOpen } = await launched();
    expect(onSshOpen.mock.calls[0]).toEqual([{ host: "box.test", user: "root", port: 2222, extraOptions: [] }, PID, REF]);
  });

  it("shows a host-key question, answers it once over the socket, and clears it", async () => {
    const { socket } = await launched();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "prompt", promptId: 7, text: "Are you sure you want to continue connecting (yes/no)?", kind: "confirm" }) });
    });
    expect(screen.getByTestId("ssh-prompt-text").textContent).toContain("continue connecting");
    fireEvent.click(screen.getByText("Yes"), { detail: 1 });
    expect(socket.sent.filter((d) => typeof d === "string" && d.includes("prompt_answer"))).toEqual([
      JSON.stringify({ type: "prompt_answer", promptId: 7, answer: "yes" }),
    ]);
    expect(screen.queryByTestId("ssh-prompt-text")).toBeNull();
  });

  it("Escape cancels (answer null) and nothing is preselected: Enter on the dialog answers nothing", async () => {
    const { socket } = await launched();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "prompt", promptId: 8, text: "continue?", kind: "confirm" }) });
    });
    const dialog = screen.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(socket.sent.some((d) => typeof d === "string" && d.includes("prompt_answer"))).toBe(false);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(socket.sent.filter((d) => typeof d === "string" && d.includes("prompt_answer"))).toEqual([
      JSON.stringify({ type: "prompt_answer", promptId: 8, answer: null }),
    ]);
  });

  it("says plainly that the server refused the saved secret, and what the Keychain said when it could not be read", async () => {
    const { socket } = await launched();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "credential_rejected" }) });
    });
    expect(screen.getByTestId("ssh-credential-notice").textContent).toContain("refused the saved password");
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "credential_failed", code: "keychain_locked" }) });
    });
    expect(screen.getByTestId("ssh-credential-notice").textContent).toContain("Keychain is locked");
  });

  it("a stale answer (prompt_gone) does not turn the session into an error", async () => {
    const { socket } = await launched();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "prompt_gone" }) });
    });
    expect(screen.getByTestId("ssh-state").textContent).not.toContain("error");
  });
});

describe("SshPage and a typed answer to an ambiguous prompt", () => {
  it("masks the answer, sends it once with Enter, and clears the field", async () => {
    const onSshOpen = vi.fn(async () => ({ generation: "a".repeat(32), sessionId: 1 }));
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={async () => {}} launch={{ nonce: 1, profileId: "11111111-2222-4333-8444-555555555555", target: { host: "box.test", extraOptions: [] } }} />);
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "prompt", promptId: 2, text: "Verification code: ", kind: "secret" }) });
    });
    const input = screen.getByLabelText("Answer") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "654321" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(socket.sent.filter((d) => typeof d === "string" && d.includes("prompt_answer"))).toEqual([
      JSON.stringify({ type: "prompt_answer", promptId: 2, answer: "654321" }),
    ]);
    expect(screen.queryByLabelText("Answer")).toBeNull();
  });
});

describe("SshPage host-key confirmation needs a deliberate yes (S9)", () => {
  async function withPrompt() {
    const onSshOpen = vi.fn(async () => ({ generation: "a".repeat(32), sessionId: 1 }));
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={async () => {}} launch={{ nonce: 1, profileId: "11111111-2222-4333-8444-555555555555", target: { host: "box.test", extraOptions: [] } }} />);
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "prompt", promptId: 4, text: "Are you sure (yes/no)?", kind: "confirm" }) });
    });
    const answers = () => socket.sent.filter((d) => typeof d === "string" && d.includes("prompt_answer"));
    return { socket, answers };
  }

  it("a keyboard activation of Yes (click with no pointer) answers nothing; a pointer click does", async () => {
    const { answers } = await withPrompt();
    fireEvent.click(screen.getByText("Yes")); // detail 0: Enter or Space on the focused button
    expect(answers()).toEqual([]);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes"), { detail: 1 });
    expect(answers()).toEqual([JSON.stringify({ type: "prompt_answer", promptId: 4, answer: "yes" })]);
  });

  it("typing yes and pressing Enter answers; anything else typed does not", async () => {
    const { answers } = await withPrompt();
    const input = screen.getByLabelText("Type yes to continue");
    fireEvent.change(input, { target: { value: "ye" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(answers()).toEqual([]);
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(answers()).toEqual([JSON.stringify({ type: "prompt_answer", promptId: 4, answer: "yes" })]);
  });

  it("an expired question closes the dialog and says so", async () => {
    const { socket } = await withPrompt();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "prompt_expired", promptId: 4 }) });
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("ssh-credential-notice").textContent).toContain("not answered in time");
  });
});

describe("SshPage: who drives the session (stage 4b-1)", () => {
  async function running(onTakeover?: (h: SessionHandle) => Promise<void>) {
    const handle: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
    const onSshOpen = vi.fn(async () => handle);
    const onAttach = vi.fn(async () => ({ token: "b".repeat(32), wsUrl: "ws://x" }));
    render(<SshPage onSshOpen={onSshOpen} onAttach={onAttach} onClose={vi.fn(async () => {})} {...(onTakeover === undefined ? {} : { onTakeover })} />);
    fireEvent.change(screen.getByPlaceholderText("адрес"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByText("Подключить"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    const say = (msg: unknown) => act(() => void socket.onmessage?.({ data: JSON.stringify(msg) }));
    return { handle, say };
  }

  it("shows 'управляете вы' with no notice until an agent takes the session", async () => {
    const { say } = await running();
    expect(screen.getByTestId("control-owner").textContent).toBe("управляете вы");
    expect(screen.queryByRole("button", { name: "Взять управление" })).toBeNull();
    expect(screen.queryByTestId("agent-overlay")).toBeNull();
    await say({ type: "control", owner: "agent", expiresAt: Date.now() + 60_000 });
    expect(screen.getByTestId("control-owner").textContent).toContain("управляет агент");
    expect(screen.getByText(/Агент управляет этой сессией/)).toBeTruthy();
  });

  it("a blocked key becomes an alert, and Take control calls the owner RPC with this session's handle", async () => {
    const onTakeover = vi.fn(async () => {});
    const { say, handle } = await running(onTakeover);
    await say({ type: "control", owner: "agent", expiresAt: Date.now() + 60_000 });
    await say({ type: "input_blocked" });
    expect(screen.getByRole("alert").textContent).toContain("Ввод не отправлен");
    fireEvent.click(screen.getByRole("button", { name: "Взять управление" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onTakeover).toHaveBeenCalledWith(handle);
    await say({ type: "control", owner: "human", expiresAt: null });
    expect(screen.getByTestId("control-owner").textContent).toBe("управляете вы");
    expect(screen.queryByRole("button", { name: "Взять управление" })).toBeNull();
  });
});
