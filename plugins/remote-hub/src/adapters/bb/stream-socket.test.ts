import { describe, expect, it, vi } from "vitest";
import { registerStreamSocket } from "./stream-socket.ts";
import type { RemoteHubService } from "./service.ts";

interface FakeSocket {
  readyState: number;
  sent: Array<string | Uint8Array>;
  closed: Array<{ code?: number; reason?: string }>;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function makeSocket(): FakeSocket {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closed.push({ code, reason });
      this.readyState = 3;
    },
  };
}

function makeHarness(overrides: Partial<RemoteHubService> = {}) {
  let handler: ((ctx: { url: URL }) => Record<string, unknown>) | null = null;
  const bb = {
    http: { experimental_websocket(_path: string, h: typeof handler) { handler = h; } },
  } as unknown as Parameters<typeof registerStreamSocket>[0];

  const service = {
    consumeAttachToken: vi.fn().mockReturnValue({ sessionId: 1, generation: "a".repeat(32) }),
    sessionCredit: vi.fn().mockResolvedValue(undefined),
    sessionResize: vi.fn().mockResolvedValue(undefined),
    sessionTerminalInput: vi.fn().mockResolvedValue(true),
    controlState: vi.fn().mockReturnValue({ owner: "human", expiresAt: null }),
    subscribeControl: vi.fn().mockReturnValue(() => {}),
    sessionList: vi.fn().mockReturnValue([]),
    attachStream: vi.fn().mockReturnValue({
      snapshot: new Uint8Array(0),
      subscribe: vi.fn().mockReturnValue(() => {}),
    }),
    creditAttach: vi.fn().mockReturnValue(262_144),
    creditDetach: vi.fn().mockReturnValue(0),
    creditLiveSent: vi.fn(),
    creditAck: vi.fn().mockReturnValue(0),
    creditState: vi.fn(),
    subscribeSessionEnd: vi.fn().mockReturnValue(() => {}),
    onHelperExit: vi.fn().mockReturnValue(() => {}),
    subscribeSshAskpass: vi.fn().mockReturnValue(() => {}),
    sshPromptAnswer: vi.fn().mockResolvedValue(undefined),
    sessionAttach: vi.fn().mockReturnValue(""),
    helperStatus: vi.fn(),
    echoOpen: vi.fn(),
    echoInput: vi.fn(),
    echoClose: vi.fn(),
    sshOpen: vi.fn(),
    sshOpenTest: vi.fn(),
    sessionClose: vi.fn(),
    sessionScrollback: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  } as unknown as RemoteHubService;

  registerStreamSocket(bb, { service });
  const ctx = { url: new URL("http://bb/api/attach?attach=abc") };
  const handlers = handler!(ctx) as {
    onOpen(socket: FakeSocket): Promise<void>;
    onMessage(socket: FakeSocket, data: string | Uint8Array): void;
    onClose(): void;
    onError(): void;
  };
  return { service, handlers };
}

describe("stream-socket control validation (V6)", () => {
  it.each(["null", JSON.stringify({ type: "ack", bytes: 1.5 }), JSON.stringify({ type: "ack", bytes: 1e30 }), JSON.stringify({ type: "resize", cols: 0, rows: 24 })])(
    "replies bad_control for %s",
    async (payload) => {
      const { service, handlers } = makeHarness();
      const socket = makeSocket();
      await handlers.onOpen(socket);
      socket.sent.length = 0;
      (service.creditAck as unknown as { mockClear(): void }).mockClear();
      (service.sessionCredit as unknown as { mockClear(): void }).mockClear();
      (service.sessionResize as unknown as { mockClear(): void }).mockClear();
      handlers.onMessage(socket, payload);
      expect(service.sessionCredit).not.toHaveBeenCalled();
      expect(service.sessionResize).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([JSON.stringify({ type: "error", code: "bad_control" })]);
    },
  );
});

describe("stream-socket snapshot/live ordering (W3)", () => {
  it("sends snapshot marker, snapshot, live marker, then the buffered tail", async () => {
    const { handlers } = makeHarness({
      attachStream: vi.fn().mockReturnValue({
        snapshot: new Uint8Array([65]),
        // A buffered tail is flushed synchronously when subscribe is called.
        subscribe: vi.fn((cb: (data: Uint8Array) => void) => {
          cb(new Uint8Array([66]));
          return () => {};
        }),
      }),
    });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "snapshot", bytes: 1 }));
    expect(socket.sent[1]).toEqual(new Uint8Array([65]));
    expect(socket.sent[2]).toBe(JSON.stringify({ type: "live" }));
    expect(socket.sent[3]).toEqual(new Uint8Array([66]));
  });
});

describe("stream-socket stored closed replay (W5)", () => {
  it("replays the stored closed status and closes 4000", async () => {
    const { handlers } = makeHarness({
      sessionList: vi.fn().mockReturnValue([
        { generation: "a".repeat(32), sessionId: 1, kind: "ssh", state: "closed", exitCode: 7, signal: null, reason: "exited" },
      ]),
    });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    expect(socket.sent).toContain(JSON.stringify({ type: "closed", exitCode: 7, signal: null, reason: "exited" }));
    expect(socket.closed[0]?.code).toBe(4000);
  });
});

describe("stream-socket subscription leak (V7)", () => {
  it("unsubscribes when the socket closes after open", async () => {
    const unsubscribe = vi.fn();
    const { handlers } = makeHarness({
      attachStream: vi.fn().mockReturnValue({
        snapshot: new Uint8Array(0),
        subscribe: vi.fn().mockReturnValue(unsubscribe),
      }),
    });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    handlers.onClose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("stream-socket askpass events and answers", () => {
  it("forwards prompts and credential notices to the view as text, and drops them after close", async () => {
    let push: (e: unknown) => void = () => {};
    const off = vi.fn();
    const { handlers } = makeHarness({
      subscribeSshAskpass: vi.fn((_h: unknown, cb: (e: unknown) => void) => {
        push = cb;
        return off;
      }) as never,
    });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    socket.sent.length = 0;
    push({ type: "prompt", promptId: 3, text: "Continue connecting (yes/no)?", kind: "confirm" });
    push({ type: "credential_rejected" });
    expect(socket.sent.map((s) => JSON.parse(String(s)))).toEqual([
      { type: "prompt", promptId: 3, text: "Continue connecting (yes/no)?", kind: "confirm" },
      { type: "credential_rejected" },
    ]);
    handlers.onClose();
    expect(off).toHaveBeenCalledTimes(1);
    socket.sent.length = 0;
    push({ type: "credential_failed", code: "keychain_locked" });
    expect(socket.sent).toEqual([]);
  });

  it("passes a prompt answer (and a cancel) to the service once, and refuses a malformed one", async () => {
    const sshPromptAnswer = vi.fn().mockResolvedValue(undefined);
    const { handlers } = makeHarness({ sshPromptAnswer: sshPromptAnswer as never });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    socket.sent.length = 0;
    handlers.onMessage(socket, JSON.stringify({ type: "prompt_answer", promptId: 3, answer: "yes" }));
    handlers.onMessage(socket, JSON.stringify({ type: "prompt_answer", promptId: 4, answer: null }));
    expect(sshPromptAnswer.mock.calls.map((c) => [c[1], c[2]])).toEqual([[3, "yes"], [4, null]]);
    handlers.onMessage(socket, JSON.stringify({ type: "prompt_answer", promptId: -1, answer: "x" }));
    handlers.onMessage(socket, JSON.stringify({ type: "prompt_answer", promptId: 1, answer: 5 }));
    expect(sshPromptAnswer).toHaveBeenCalledTimes(2);
    expect(socket.sent.map((s) => JSON.parse(String(s)))).toEqual([{ type: "error", code: "bad_control" }, { type: "error", code: "bad_control" }]);
  });

  it("an answer for a prompt that is gone reports prompt_gone", async () => {
    const { handlers } = makeHarness({ sshPromptAnswer: vi.fn().mockRejectedValue(new Error("no_pending_prompt")) as never });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    socket.sent.length = 0;
    handlers.onMessage(socket, JSON.stringify({ type: "prompt_answer", promptId: 9, answer: "yes" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.sent.map((s) => JSON.parse(String(s)))).toEqual([{ type: "error", code: "prompt_gone" }]);
  });
});
