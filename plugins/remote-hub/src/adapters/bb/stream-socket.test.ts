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
    sessionScrollback: vi.fn().mockResolvedValue(new Uint8Array(0)),
    subscribeSession: vi.fn().mockReturnValue(() => {}),
    subscribeSessionEnd: vi.fn().mockReturnValue(() => {}),
    onHelperExit: vi.fn().mockReturnValue(() => {}),
    sessionAttach: vi.fn().mockReturnValue(""),
    sessionList: vi.fn().mockReturnValue([]),
    helperStatus: vi.fn(),
    echoOpen: vi.fn(),
    echoInput: vi.fn(),
    echoClose: vi.fn(),
    sshOpen: vi.fn(),
    sessionClose: vi.fn(),
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
  it.each(["null", JSON.stringify({ type: "credit", bytes: 1.5 }), JSON.stringify({ type: "credit", bytes: 1e30 }), JSON.stringify({ type: "resize", cols: 0, rows: 24 })])(
    "replies bad_control for %s",
    async (payload) => {
      const { service, handlers } = makeHarness();
      const socket = makeSocket();
      await handlers.onOpen(socket);
      service.sessionCredit.mockClear();
      service.sessionResize.mockClear();
      handlers.onMessage(socket, payload);
      expect(service.sessionCredit).not.toHaveBeenCalled();
      expect(service.sessionResize).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([JSON.stringify({ type: "error", code: "bad_control" })]);
    },
  );

  it("forwards a valid resize to the service", async () => {
    const { service, handlers } = makeHarness();
    const socket = makeSocket();
    await handlers.onOpen(socket);
    handlers.onMessage(socket, JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(service.sessionResize).toHaveBeenCalledWith(
      { generation: "a".repeat(32), sessionId: 1 },
      100,
      30,
    );
  });
});

describe("stream-socket subscription leak (V7)", () => {
  it("unsubscribes when the socket closes during the scrollback await", async () => {
    let resolveScrollback!: (v: Uint8Array) => void;
    const unsubscribe = vi.fn();
    const { handlers } = makeHarness({
      sessionScrollback: () =>
        new Promise((resolve) => {
          resolveScrollback = resolve;
        }),
      subscribeSession: () => unsubscribe,
    });
    const socket = makeSocket();
    const open = handlers.onOpen(socket);
    // Wait a microtask so onOpen has subscribed before the close.
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers.onClose();
    resolveScrollback(new Uint8Array(0));
    await open;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
