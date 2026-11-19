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
    if (this.emitOnCredit !== null) {
      this.emitOutput(handle.sessionId, this.emitOnCredit);
      this.emitOnCredit = null; // one-shot: do not re-emit on every grant
    }
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
  onRdpEvent(): void {}
  onSshAskpass(): void {}
  onPveEvent(): void {}
  onVncData(): void {}
  onExecFinished(): void {}
  onRdpUpdate(): void {}
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

function makeServiceAndSocket(opts: { headlessDrain?: boolean } = {}) {
  const helper = new FakeHelper();
  const service = createRemoteHubService({
    startHelper: async () => helper as unknown as HelperProcess,
    env: {} as Record<string, string | undefined>,
    ...opts,
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
    helper.scrollback = new Uint8Array(100_000).fill(65);
    const token = service.sessionAttach(handle);
    const socket = makeSocket();
    const handlers = wire("ws://x/attach?attach=" + token);
    await handlers.onOpen(socket);
    // Snapshot bytes are not live: outstanding for this view is still 0.
    expect(service.creditState(handle)!.outstanding(token)).toBe(0);
    // A buggy renderer acks the snapshot bytes (they are not live).
    handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: 100_000 }));
    await flush();
    await flush();
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
  });

  it("scenario 7: snapshot before buffered tail, each byte once", async () => {
    const { helper, service, wire } = makeServiceAndSocket({ headlessDrain: false });
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

  it("scenario 9: reattach after everyone left tops the window back up", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const a = makeSocket();
    const ha = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await ha.onOpen(a);
    helper.emitOutput(handle.sessionId, new Uint8Array(262_144).fill(65));
    await flush();
    await flush();
    ha.onClose(); // A detaches without acking
    const b = makeSocket();
    const hb = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await hb.onOpen(b);
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 262_144]);
    const granted = helper.creditFrames.reduce((s, f) => s + f.bytes, 0);
    expect(granted - 262_144).toBe(262_144); // helper unconsumed credit
    // B receives further output and its acks grant normally.
    helper.emitOutput(handle.sessionId, new Uint8Array(100_000).fill(66));
    ackLive(b, hb);
    await flush();
    await flush();
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 262_144, 100_000]);
  });

  it("scenario 10: reattach tops up only the never-acked remainder", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const a = makeSocket();
    const ha = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await ha.onOpen(a);
    helper.emitOutput(handle.sessionId, new Uint8Array(100_000).fill(65));
    ha.onMessage(a, JSON.stringify({ type: "ack", bytes: 40_000 })); // A acks 40000
    await flush();
    await flush();
    ha.onClose(); // A detaches
    const b = makeSocket();
    const hb = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await hb.onOpen(b);
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144, 40_000, 60_000]);
    const granted = helper.creditFrames.reduce((s, f) => s + f.bytes, 0);
    expect(granted - 100_000).toBe(262_144);
  });

  it("Y1: session end during the credit await delivers closed after the tail", async () => {
    const { helper, service, wire } = makeServiceAndSocket({ headlessDrain: false });
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    helper.credit = async (h: SessionHandle, b: number) => {
      helper.creditFrames.push({ sessionId: h.sessionId, bytes: b });
      helper.emitOutput(h.sessionId, new Uint8Array([66]));
      helper.emitClosed(h.sessionId, { exitCode: 7, signal: null, reason: "exited" });
    };
    const s = makeSocket();
    await wire("ws://x/attach?attach=" + service.sessionAttach(handle)).onOpen(s);
    const rendered = s.sent.map((d) => (typeof d === "string" ? d : Array.from(d as Uint8Array)));
    expect(rendered).toEqual([
      JSON.stringify({ type: "snapshot", bytes: 0 }),
      JSON.stringify({ type: "live" }),
      [66],
      JSON.stringify({ type: "closed", exitCode: 7, signal: null, reason: "exited" }),
    ]);
    expect(s.closed.map((c) => c.code)).toContain(4000);
  });

  it("Y1: helper exit during the credit await closes 4410 without rejecting", async () => {
    const { helper, service, wire } = makeServiceAndSocket({ headlessDrain: false });
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    helper.credit = async () => {
      helper.emitExit();
      throw new Error("helper_exited");
    };
    const s = makeSocket();
    let err: unknown = null;
    await wire("ws://x/attach?attach=" + service.sessionAttach(handle)).onOpen(s).catch((e) => {
      err = e;
    });
    expect(err).toBeNull();
    expect(s.closed.map((c) => c.code)).toContain(4410);
  });

  it("Z1: credit rejection after session end still delivers the stored closed status", async () => {
    const { helper, service, wire } = makeServiceAndSocket({ headlessDrain: false });
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    helper.credit = async (h: SessionHandle, b: number) => {
      helper.creditFrames.push({ sessionId: h.sessionId, bytes: b });
      helper.emitClosed(h.sessionId, { exitCode: 255, signal: null, reason: "ssh_error" });
      throw new Error("session_not_found");
    };
    const s = makeSocket();
    await wire("ws://x/attach?attach=" + service.sessionAttach(handle)).onOpen(s);
    const rendered = s.sent.map((d) => (typeof d === "string" ? d : Array.from(d as Uint8Array)));
    expect(rendered).toEqual([
      JSON.stringify({ type: "snapshot", bytes: 0 }),
      JSON.stringify({ type: "live" }),
      JSON.stringify({ type: "closed", exitCode: 255, signal: null, reason: "ssh_error" }),
    ]);
    expect(s.closed.map((c) => c.code)).toContain(4000);
    expect(s.closed.map((c) => c.code)).not.toContain(4410);
  });

  it("Z2: helper exit after attach closes the socket 4410", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const s = makeSocket();
    await wire("ws://x/attach?attach=" + service.sessionAttach(handle)).onOpen(s);
    helper.emitExit();
    expect(s.closed.map((c) => c.code)).toContain(4410);
  });

  it("Z2: a throwing close on one socket does not skip 4410 for another", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    const a = makeSocket();
    a.close = () => {
      throw new Error("close boom");
    };
    const ha = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await ha.onOpen(a);
    const b = makeSocket();
    const hb = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    await hb.onOpen(b);
    helper.emitExit();
    expect(b.closed.map((c) => c.code)).toContain(4410);
  });

  it("Y5: a throwing end listener does not skip the others", async () => {
    const { service } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    let secondFired = false;
    service.subscribeSessionEnd(handle, () => {
      throw new Error("boom");
    });
    service.subscribeSessionEnd(handle, () => {
      secondFired = true;
    });
    await service.sessionClose(handle);
    expect(secondFired).toBe(true);
  });

  it("Y5: helper-exit records are evicted after 5 minutes", async () => {
    vi.useFakeTimers();
    try {
      const { helper, service, wire } = makeServiceAndSocket();
      const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
      const token = service.sessionAttach(handle);
      const s = makeSocket();
      await wire("ws://x/attach?attach=" + token).onOpen(s);
      helper.emitExit();
      const before = service
        .sessionList()
        .find((r) => r.generation === handle.generation && r.sessionId === handle.sessionId);
      expect(before?.state).toBe("closed");
      expect(before?.reason).toBe("helper_exited");
      vi.advanceTimersByTime(300_001);
      const after = service
        .sessionList()
        .find((r) => r.generation === handle.generation && r.sessionId === handle.sessionId);
      expect(after).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("A1: credit throws while the record is running closes 4410 and sends no closed frame", async () => {
    const { helper, service, wire } = makeServiceAndSocket({ headlessDrain: false });
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);
    helper.credit = async () => {
      throw new Error("session_not_found");
    };
    const s = makeSocket();
    let err: unknown = null;
    await wire("ws://x/attach?attach=" + service.sessionAttach(handle)).onOpen(s).catch((e) => {
      err = e;
    });
    expect(err).toBeNull();
    expect(s.closed.map((c) => c.code)).toContain(4410);
    const closedFrames = s.sent.filter((d) => {
      if (typeof d !== "string") return false;
      try {
        return (JSON.parse(d) as { type?: string }).type === "closed";
      } catch {
        return false;
      }
    });
    expect(closedFrames).toEqual([]);
  });

  it("A3: a slow non-owner view is detached at 1 MiB outstanding (4409), owner and credit unaffected", async () => {
    const { helper, service, wire } = makeServiceAndSocket();
    const handle = await service.sshOpen({ host: "example.com", extraOptions: [] }, 80, 24);

    const tokenA = service.sessionAttach(handle);
    const a = makeSocket();
    const ha = wire("ws://x/attach?attach=" + tokenA);
    await ha.onOpen(a);

    const tokenB = service.sessionAttach(handle);
    const b = makeSocket();
    const hb = wire("ws://x/attach?attach=" + tokenB);
    await hb.onOpen(b);

    // 1_048_576 live bytes to a non-owner: exactly at the bound, still attached.
    helper.emitOutput(handle.sessionId, new Uint8Array(1_048_576).fill(65));
    await flush();
    await flush();
    expect(b.closed.map((c) => c.code)).not.toContain(4409);

    // One more byte pushes the non-owner past the bound: detached with 4409.
    helper.emitOutput(handle.sessionId, new Uint8Array(1).fill(66));
    await flush();
    await flush();
    expect(b.closed.map((c) => c.code)).toContain(4409);
    expect(b.closed.find((c) => c.code === 4409)?.reason).toBe("view too slow");

    // Owner outstanding is untouched and no further helper credit was granted.
    expect(service.creditState(handle)!.outstanding(tokenA)).toBe(1_048_577);
    expect(helper.creditFrames.map((f) => f.bytes)).toEqual([262_144]);
    // The slow view left the credit state; only the owner remains.
    expect(service.creditState(handle)!.size()).toBe(1);
    expect(service.creditState(handle)!.owner()).toBe(tokenA);
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
