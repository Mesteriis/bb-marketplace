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
    sessionTerminalInput: vi.fn().mockResolvedValue(undefined),
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
