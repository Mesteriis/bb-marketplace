import { describe, expect, it, vi } from "vitest";
import { HelperProcess } from "./helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "./service.ts";
import { registerStreamSocket } from "./stream-socket.ts";
import type { SessionHandle } from "../../core/rpc.ts";

const GEN = "a".repeat(32);

class FakeHelper {
  currentGeneration = GEN;
  nextSessionId = 1;
  creditFrames: Array<{ sessionId: number; bytes: number }> = [];
  scrollback = new Uint8Array(0);
  emitOnCredit: Uint8Array | null = null;
  private outputCb: ((sessionId: number, data: Uint8Array) => void) | null = null;
  private closedCbs: Array<(sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void> = [];
  private exitCbs: Array<() => void> = [];
  status = { version: "0.1.0", pid: 1, platform: "test", sessionCount: 0 };

  private handle(): SessionHandle {
    return { generation: GEN, sessionId: this.nextSessionId++ };
  }
  async openEcho(): Promise<SessionHandle> {
    return this.handle();
  }
  async openSsh(): Promise<SessionHandle> {
    return this.handle();
  }
  async credit(handle: SessionHandle, bytes: number): Promise<void> {
    this.creditFrames.push({ sessionId: handle.sessionId, bytes });
    if (this.emitOnCredit !== null) this.emitOutput(handle.sessionId, this.emitOnCredit);
  }
  async resize(): Promise<void> {}
  async input(): Promise<{ output: string; truncated: boolean }> {
    return { output: "", truncated: false };
  }
  writeInput(): void {}
  scrollbackSnapshot(): Uint8Array {
    return this.scrollback;
  }
  async close(): Promise<{ exitCode: number | null; signal: number | null; reason: string }> {
    return { exitCode: null, signal: null, reason: "killed_by_close" };
  }
  async pingAlive(): Promise<boolean> {
    return true;
  }
  stop(): void {}
  onSessionOutput(cb: (sessionId: number, data: Uint8Array) => void): void {
    this.outputCb = cb;
  }
  onSessionClosed(cb: (sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void): void {
    this.closedCbs.push(cb);
  }
  onExit(cb: () => void): void {
    this.exitCbs.push(cb);
  }
  emitOutput(sessionId: number, data: Uint8Array): void {
    this.outputCb?.(sessionId, data);
  }
  emitClosed(sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }): void {
    for (const cb of this.closedCbs) cb(sessionId, info);
  }
  emitExit(): void {
    for (const cb of this.exitCbs) cb();
  }
}

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
      this.readyState = 3;
      this.closed.push({ code, reason });
    },
  };
}

type Handlers = {
  onOpen(socket: FakeSocket): Promise<void>;
  onMessage(socket: FakeSocket, data: string | Uint8Array): void;
  onClose(): void;
  onError(): void;
};

function makeServiceAndSocket() {
  const helper = new FakeHelper();
  const service = createRemoteHubService({
    startHelper: async () => helper as unknown as HelperProcess,
    env: {} as Record<string, string | undefined>,
  });
  let captured: ((ctx: { url: URL }) => Handlers) | null = null;
  registerStreamSocket(
    { http: { experimental_websocket(_p: string, h: typeof captured) { captured = h; } } } as never,
    { service },
  );
  const wire = (url: string) => captured!({ url: new URL(url) });
  return { helper, service, wire };
}

/** A renderer that follows X1: acks only binary frames after {type:"live"}. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function ackLive(socket: FakeSocket, handlers: Handlers): void {
  let live = false;
  const seen = new Set<number>();
  for (let i = 0; i < socket.sent.length; i++) {
    if (seen.has(i)) continue;
    const d = socket.sent[i];
    if (typeof d === "string") {
      seen.add(i);
      let m: { type?: string };
      try {
        m = JSON.parse(d);
      } catch {
        continue;
      }
      if (m.type === "live") live = true;
      else if (m.type === "snapshot") live = false;
    } else if (d instanceof Uint8Array && live) {
      seen.add(i);
      handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: d.byteLength }));
    }
  }
}

describe("credit window X1 (real service + real socket)", () => {
  it("scenario 1: attach grants [262144]", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    await wire("ws://x/attach?attach=" + token).onOpen(socket);
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
  });

  it("live bytes sent but not acked grant nothing", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    await wire("ws://x/attach?attach=" + token).onOpen(socket);
    helper.emitOutput(handle.sessionId, new Uint8Array(100_000).fill(65));
    await flush();
    await flush();
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
  });

  it("scenario 2: reattach with snapshot grants no new window; unconsumed stays 262144", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    const handlers = wire("ws://x/attach?attach=" + token);
    await handlers.onOpen(socket);

    // 100000 live bytes, acked.
    helper.emitOutput(handle.sessionId, new Uint8Array(100_000).fill(65));
    ackLive(socket, handlers);
    await flush();
    await flush();
    handlers.onClose();

    // Reattach with a 100000-byte snapshot.
    helper.scrollback = new Uint8Array(100_000).fill(65);
    const token2 = service.sessionAttach(handle);
    const socket2 = makeSocket();
    await wire("ws://x/attach?attach=" + token2).onOpen(socket2);

    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 100_000]);
    const granted = helper.creditFrames.reduce((a, b) => a + b.bytes, 0);
    expect(granted - 100_000).toBe(262_144);
  });

  it("scenario 3: repeated reattaches grant nothing further", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    const handlers = wire("ws://x/attach?attach=" + token);
    await handlers.onOpen(socket);
    helper.emitOutput(handle.sessionId, new Uint8Array(100_000).fill(65));
    ackLive(socket, handlers);
    await flush();
    await flush();
    handlers.onClose();

    for (let i = 0; i < 5; i++) {
      const t = service.sessionAttach(handle);
      const s = makeSocket();
      await wire("ws://x/attach?attach=" + t).onOpen(s);
    }
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 100_000]);
  });

  it("scenario 4: oversized acks with no data produce no grant", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    const handlers = wire("ws://x/attach?attach=" + token);
    await handlers.onOpen(socket);
    handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: 2_147_483_647 }));
    handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: 2_147_483_647 }));
    await flush();
    await flush();
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
  });

  it("scenario 5: owner promotion on detach lets the second view continue", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);

    const a = makeSocket();
    const ha = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await ha.onOpen(a);
    const b = makeSocket();
    const hb = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await hb.onOpen(b);

    ha.onClose(); // A detaches; B is promoted.
    helper.emitOutput(handle.sessionId, new Uint8Array(262_144).fill(66));
    ackLive(b, hb); // B acks all live bytes.
    await flush();
    await flush();

    // A's initial window, then B's promoted ack grant.
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 262_144]);
  });

  it("scenario 6: acking snapshot bytes grants nothing", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    const handlers = wire("ws://x/attach?attach=" + token);
    await handlers.onOpen(socket);
    // A buggy renderer acks the (empty) snapshot length.
    handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: 0 }));
    await flush();
    await flush();
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
  });

  it("scenario 7: snapshot before buffered tail, each byte once", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    helper.scrollback = new Uint8Array([65]);
    helper.emitOnCredit = new Uint8Array([66]); // arrives during the credit await
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    await wire("ws://x/attach?attach=" + token).onOpen(socket);
    const bytes = socket.sent.map((d) => (typeof d === "string" ? d : Array.from(d as Uint8Array)));
    expect(bytes).toEqual([
      JSON.stringify({ type: "snapshot", bytes: 1 }),
      [65],
      JSON.stringify({ type: "live" }),
      [66],
    ]);
  });

  it("scenario 8: eviction deletes credit state (fake clock)", async () => {
    vi.useFakeTimers();
    try {
      const { service, wire } = makeServiceAndSocket();
      const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
      const token = service.sessionAttach(handle);
      const socket = makeSocket();
      const handlers = wire("ws://x/attach?attach=" + token);
      await handlers.onOpen(socket); // creates credit state
      expect(service.creditState(handle)).toBeDefined();
      handlers.onClose();
      await service.sessionClose(handle);
      vi.advanceTimersByTime(300_001);
      expect(service.creditState(handle)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
