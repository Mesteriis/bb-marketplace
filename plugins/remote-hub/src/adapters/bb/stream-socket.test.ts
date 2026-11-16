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
    http: {
      experimental_websocket(_path: string, h: typeof handler) {
        handler = h;
      },
    },
  } as unknown as Parameters<typeof registerStreamSocket>[0];

  const service = {
    consumeAttachToken: vi.fn().mockReturnValue({ sessionId: 1, generation: "a".repeat(32) }),
    sessionCredit: vi.fn().mockResolvedValue(undefined),
    sessionResize: vi.fn().mockResolvedValue(undefined),
    sessionTerminalInput: vi.fn().mockResolvedValue(undefined),
    sessionList: vi.fn().mockReturnValue([]),
    attachStream: vi.fn().mockReturnValue({
      snapshot: new Uint8Array(0),
      subscribe: vi.fn().mockReturnValue(() => {}),
    }),
    creditAttach: vi.fn().mockReturnValue({ grant: 262144, isOwner: true }),
    creditDetach: vi.fn(),
    creditAck: vi.fn().mockReturnValue(0),
    subscribeSessionEnd: vi.fn().mockReturnValue(() => {}),
    onHelperExit: vi.fn().mockReturnValue(() => {}),
    sessionAttach: vi.fn().mockReturnValue(""),
    helperStatus: vi.fn(),
    echoOpen: vi.fn(),
    echoInput: vi.fn(),
    echoClose: vi.fn(),
    sshOpen: vi.fn(),
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

describe("snapshot before live, no duplication (W3)", () => {
  it("sends the snapshot first, then the buffered tail, each byte once", async () => {
    const sink: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    const subscribe = vi.fn((cb: (data: Uint8Array) => void) => {
      sink.cb = cb;
      return () => {};
    });
    const { handlers } = makeHarness({
      attachStream: vi.fn().mockReturnValue({
        snapshot: new Uint8Array([65]),
        subscribe,
      }),
    });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    // One byte [66] arrived after the snapshot; it must follow, exactly once.
    sink.cb?.(new Uint8Array([66]));
    const bytes = socket.sent.map((d) => (typeof d === "string" ? d : Array.from(d as Uint8Array)));
    expect(bytes).toEqual([[65], [66]]);
  });
});

describe("credit is acknowledged, not sent (W2)", () => {
  it("does not grant for snapshot bytes and only replenishes on ack", async () => {
    const creditAck = vi.fn().mockReturnValue(100_000);
    const { service, handlers } = makeHarness({ creditAck });
    const socket = makeSocket();
    await handlers.onOpen(socket);
    // Initial grant only: 262144, nothing for the snapshot.
    expect(service.sessionCredit).toHaveBeenCalledTimes(1);
    expect(service.sessionCredit).toHaveBeenCalledWith({ generation: "a".repeat(32), sessionId: 1 }, 262144);
    handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: 100_000 }));
    expect(creditAck).toHaveBeenCalledWith({ generation: "a".repeat(32), sessionId: 1 }, "abc", 100_000);
    expect(service.sessionCredit).toHaveBeenLastCalledWith({ generation: "a".repeat(32), sessionId: 1 }, 100_000);
  });
});

describe("stream-socket subscription leak (V7)", () => {
  it("unsubscribes when the socket closes before subscribe flushes", async () => {
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
