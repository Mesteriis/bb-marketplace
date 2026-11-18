// Fake-engine tests for the RDP service layer (stage 2b-2): the real service and
// the real attach-socket handlers over a scripted helper, same style as
// credit-x1.test.ts. Every expected value is a literal.
import { describe, expect, it, vi } from "vitest";
import { HelperRequestError, type HelperProcess, type RdpHelperEvent } from "./helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "./service.ts";
import { registerStreamSocket } from "./stream-socket.ts";
import { createRdpTrustStore } from "../../core/rdp-trust.ts";
import { UPDATE_HEADER_BYTES } from "../../core/rdp-protocol.ts";
import type { SessionHandle } from "../../core/rpc.ts";

const GEN = "c".repeat(32);
const SECRET = "S3cr3t-MARK-91";
const FP_A = Array.from({ length: 32 }, () => "AA").join(":");
const FP_B = Array.from({ length: 32 }, () => "BB").join(":");

class FakeRdpHelper {
  currentGeneration = GEN;
  status = { version: "0.1.0", pid: 1, platform: "test", sessionCount: 0 };
  nextSessionId = 1;
  opens: Array<Record<string, unknown>> = [];
  decisions: Array<{ sessionId: number; fingerprint: string; accept: string }> = [];
  inputs: Array<{ sessionId: number; events: unknown[] }> = [];
  acks: number[] = [];
  refreshes = 0;
  rejectInput: HelperRequestError | null = null;
  private eventCb: Array<(sid: number, e: RdpHelperEvent) => void> = [];
  private updateCb: Array<(sid: number, seq: number, payload: Uint8Array) => void> = [];
  private closedCb: Array<(sid: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void> = [];
  private exitCb: Array<() => void> = [];

  async openRdp(params: Record<string, unknown>): Promise<SessionHandle> {
    this.opens.push(params);
    return { generation: GEN, sessionId: this.nextSessionId++ };
  }
  async rdpCertDecision(handle: SessionHandle, fingerprint: string, accept: string): Promise<void> {
    this.decisions.push({ sessionId: handle.sessionId, fingerprint, accept });
  }
  async rdpInput(handle: SessionHandle, events: unknown[]): Promise<void> {
    if (this.rejectInput !== null) throw this.rejectInput;
    this.inputs.push({ sessionId: handle.sessionId, events });
  }
  async rdpUpdateAck(_h: SessionHandle, frameId: number): Promise<void> {
    this.acks.push(frameId);
  }
  async rdpRefresh(): Promise<void> {
    this.refreshes += 1;
  }
  async rdpScreenshot() {
    return { frameId: 4, width: 800, height: 600, timestamp: 1, png: "QUJD" };
  }
  async close(): Promise<{ exitCode: number | null; signal: number | null; reason: string }> {
    return { exitCode: null, signal: null, reason: "killed_by_close" };
  }
  async pingAlive(): Promise<boolean> {
    return true;
  }
  scrollbackSnapshot(): Uint8Array {
    return new Uint8Array(0);
  }
  stop(): void {}
  onExit(cb: () => void): void {
    this.exitCb.push(cb);
  }
  onSessionClosed(cb: (sid: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void): void {
    this.closedCb.push(cb);
  }
  onSessionOutput(): void {}
  onRdpEvent(cb: (sid: number, e: RdpHelperEvent) => void): void {
    this.eventCb.push(cb);
  }
  onRdpUpdate(cb: (sid: number, seq: number, payload: Uint8Array) => void): void {
    this.updateCb.push(cb);
  }
  event(sid: number, e: RdpHelperEvent): void {
    for (const cb of this.eventCb) cb(sid, e);
  }
  state(sid: number, state: string): void {
    this.event(sid, { type: "rdp.state", state });
  }
  prompt(sid: number, fingerprint: string, reason = "untrusted_root"): void {
    this.state(sid, "cert_prompt");
    this.event(sid, {
      type: "rdp.cert_prompt",
      host: "rdp.test",
      port: 3389,
      fingerprint,
      subject: "CN=rdp-test",
      issuer: "CN=rdp-test",
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2036-01-01T00:00:00Z",
      reason,
    });
  }
  desktop(sid: number, frameId = 1, width = 8, height = 4): void {
    this.event(sid, { type: "rdp.desktop", frameId, width, height, timestamp: 1 });
  }
  /** One update chunk: full 8x4 framebuffer (x=0,y=0,w=8,h=4) or a 2x2 part. */
  update(sid: number, frameId: number, seq = 0, full = true): void {
    const [x, y, w, h] = full ? [0, 0, 8, 4] : [3, 1, 2, 2];
    const payload = new Uint8Array(UPDATE_HEADER_BYTES + w * h * 4);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(frameId), true);
    view.setUint32(8, 8, true);
    view.setUint32(12, 4, true);
    view.setUint32(16, x, true);
    view.setUint32(20, y, true);
    view.setUint32(24, w, true);
    view.setUint32(28, h, true);
    for (const cb of this.updateCb) cb(sid, seq, payload);
  }
  closed(sid: number, reason: string, exitCode: number | null = null): void {
    for (const cb of this.closedCb) cb(sid, { exitCode, signal: null, reason });
  }
  exit(): void {
    for (const cb of this.exitCb) cb();
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
  onOpen(socket: FakeSocket): void | Promise<void>;
  onMessage(socket: FakeSocket, data: string | Uint8Array): void;
  onClose(): void;
  onError(): void;
};

function setup() {
  const helper = new FakeRdpHelper();
  const service = createRemoteHubService({
    startHelper: async () => helper as unknown as HelperProcess,
    env: {},
    trust: createRdpTrustStore(),
  });
  let captured: ((ctx: { url: URL }) => Handlers) | null = null;
  registerStreamSocket(
    { http: { experimental_websocket(_p: string, h: typeof captured) { captured = h; } } } as never,
    { service },
  );
  const wire = (url: string) => captured!({ url: new URL(url) });
  return { helper, service, wire };
}

const TARGET = { host: "rdp.test", port: 3389, username: "alice", password: SECRET };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const texts = (s: FakeSocket) => s.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
const binaries = (s: FakeSocket) => s.sent.filter((d): d is Uint8Array => typeof d !== "string");

async function attach(service: RemoteHubService, wire: ReturnType<typeof setup>["wire"], handle: SessionHandle) {
  const socket = makeSocket();
  const handlers = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
  await handlers.onOpen(socket);
  return { socket, handlers };
}

async function readySession() {
  const ctx = setup();
  const handle = await ctx.service.rdpOpen({ ...TARGET }, 8, 4);
  const sid = handle.sessionId;
  for (const s of ["connecting", "tls", "authenticating"]) ctx.helper.state(sid, s);
  ctx.helper.desktop(sid);
  return { ...ctx, handle, sid };
}

describe("RDP service: states and the desktop", () => {
  it("records the state trace in order and reports desktop_ready only after the desktop event", async () => {
    const { helper, service } = setup();
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    const sid = handle.sessionId;
    helper.state(sid, "connecting");
    helper.state(sid, "tls");
    helper.prompt(sid, FP_A);
    expect(service.rdpInfo(handle)?.state).toBe("cert_prompt");
    await service.rdpCertDecision(handle, FP_A, "once");
    helper.state(sid, "authenticating");
    expect(service.rdpInfo(handle)?.state).toBe("authenticating");
    expect(service.rdpInfo(handle)?.desktop).toBeNull();
    helper.desktop(sid, 1, 8, 4);
    expect(service.rdpInfo(handle)).toMatchObject({
      state: "desktop_ready",
      desktop: { frameId: 1, width: 8, height: 4 },
      trace: ["connecting", "tls", "cert_prompt", "authenticating", "desktop_ready"],
    });
  });

  it("ignores state names that are not part of the contract (a test engine's paint counter)", async () => {
    const { helper, service } = setup();
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.state(handle.sessionId, "paint=25");
    expect(service.rdpInfo(handle)?.trace).toEqual([]);
  });

  it("keeps events the helper sent before rdpOpen returned", async () => {
    const helper = new FakeRdpHelper();
    // The helper writes session.opened and the first state in one stdout chunk.
    const original = helper.openRdp.bind(helper);
    helper.openRdp = async (params) => {
      const handle = await original(params);
      helper.state(handle.sessionId, "connecting");
      return handle;
    };
    const service = createRemoteHubService({ startHelper: async () => helper as unknown as HelperProcess, env: {} });
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    expect(service.rdpInfo(handle)?.trace).toEqual(["connecting"]);
  });

  it("session_list shows kind rdp with the endpoint and no password", async () => {
    const { service } = setup();
    const handle = await service.rdpOpen({ ...TARGET, domain: "CORP" }, 8, 4);
    const listed = service.sessionList().find((s) => s.sessionId === handle.sessionId)!;
    expect(listed.kind).toBe("rdp");
    expect(listed.rdp?.target).toEqual({ host: "rdp.test", port: 3389, username: "alice", domain: "CORP" });
  });
});

describe("RDP service: certificate decisions and trust", () => {
  it("refuses a decision that names another certificate and sends nothing to the helper", async () => {
    const { helper, service } = setup();
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(handle.sessionId, FP_A);
    await expect(service.rdpCertDecision(handle, FP_B, "once")).rejects.toMatchObject({ code: "fingerprint_mismatch" });
    expect(helper.decisions).toEqual([]);
    expect(service.rdpInfo(handle)?.prompt?.fingerprint).toBe(FP_A); // still waiting
    await service.rdpCertDecision(handle, FP_A.toLowerCase(), "once");
    expect(helper.decisions).toEqual([{ sessionId: handle.sessionId, fingerprint: FP_A, accept: "once" }]);
    expect(service.rdpInfo(handle)?.prompt).toBeNull();
  });

  it("refuses a decision when no prompt is pending", async () => {
    const { service } = setup();
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    await expect(service.rdpCertDecision(handle, FP_A, "once")).rejects.toMatchObject({ code: "no_pending_prompt" });
  });

  it("a session-trusted fingerprint connects without a prompt next time (accept once, nothing persisted)", async () => {
    const { helper, service } = setup();
    const first = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(first.sessionId, FP_A);
    await service.rdpCertDecision(first, FP_A, "session_trust");
    const second = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(second.sessionId, FP_A);
    expect(service.rdpInfo(second)?.prompt).toBeNull(); // no prompt shown
    expect(helper.decisions.filter((d) => d.sessionId === second.sessionId)).toEqual([
      { sessionId: second.sessionId, fingerprint: FP_A, accept: "once" },
    ]);
  });

  it("a DIFFERENT certificate on a trusted host:port is cert_changed and is never auto-accepted (case 6b)", async () => {
    const { helper, service } = setup();
    const first = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(first.sessionId, FP_A);
    await service.rdpCertDecision(first, FP_A, "session_trust");
    const second = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(second.sessionId, FP_B);
    expect(service.rdpInfo(second)?.prompt).toMatchObject({ fingerprint: FP_B, reason: "cert_changed" });
    expect(helper.decisions.filter((d) => d.sessionId === second.sessionId)).toEqual([]);
  });

  it("'once' and 'reject' do not create trust", async () => {
    const { helper, service } = setup();
    const first = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(first.sessionId, FP_A);
    await service.rdpCertDecision(first, FP_A, "once");
    const second = await service.rdpOpen({ ...TARGET }, 8, 4);
    helper.prompt(second.sessionId, FP_A);
    expect(service.rdpInfo(second)?.prompt).toMatchObject({ fingerprint: FP_A, reason: "untrusted_root" });
  });
});

describe("RDP service: views, updates and input", () => {
  it("sends the attached state, then exactly one update to a view that has not acked (one in flight)", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const { socket } = await attach(service, wire, handle);
    expect(texts(socket)[0]).toMatchObject({
      type: "attached",
      state: "desktop_ready",
      desktop: { frameId: 1, width: 8, height: 4 },
      target: { host: "rdp.test", port: 3389, username: "alice", domain: null },
    });
    helper.update(sid, 2, 0, true);
    for (let frame = 3; frame <= 12; frame++) helper.update(sid, frame, 0, false);
    expect(binaries(socket).length).toBe(1);
    expect(new DataView(binaries(socket)[0].buffer).getBigUint64(0, true)).toBe(2n);
    // Frames 3..12 found the view busy: the helper was released for each at once.
    expect(helper.acks).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("an ack frees the view; it then needs a full frame and the service asks for one refresh", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const { socket, handlers } = await attach(service, wire, handle);
    expect(helper.refreshes).toBe(1); // the attach itself
    helper.update(sid, 2, 0, true);
    helper.update(sid, 3, 0, false); // skipped: the view is busy
    handlers.onMessage(socket, JSON.stringify({ type: "ack", frameId: 2 }));
    await flush();
    helper.update(sid, 4, 0, false); // free but needsFull: a partial band is withheld
    expect(binaries(socket).length).toBe(1);
    helper.update(sid, 5, 0, true); // a full frame resyncs it
    expect(binaries(socket).length).toBe(2);
    expect(helper.refreshes).toBeGreaterThanOrEqual(2);
  });

  it("two views: both get the same frame; a silent view receives exactly one update while the other keeps going (case 8)", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const a = await attach(service, wire, handle);
    const silent = await attach(service, wire, handle);
    helper.update(sid, 2, 0, true);
    expect(binaries(a.socket).length).toBe(1);
    expect(binaries(silent.socket).length).toBe(1);
    a.handlers.onMessage(a.socket, JSON.stringify({ type: "ack", frameId: 2 }));
    for (let frame = 3; frame <= 8; frame++) {
      helper.update(sid, frame, 0, true);
      a.handlers.onMessage(a.socket, JSON.stringify({ type: "ack", frameId: frame }));
    }
    expect(binaries(a.socket).length).toBe(7);
    expect(binaries(silent.socket).length).toBe(1);
    const frameIds = binaries(a.socket).map((b) => Number(new DataView(b.buffer).getBigUint64(0, true)));
    expect(frameIds).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("an attach after the desktop is ready asks the helper for a full frame (refresh on reattach)", async () => {
    const { helper, service, wire, handle } = await readySession();
    const first = await attach(service, wire, handle);
    expect(helper.refreshes).toBe(1);
    helper.update(handle.sessionId, 2, 0, true); // the refreshed full frame arrives
    first.handlers.onClose();
    await attach(service, wire, handle);
    expect(helper.refreshes).toBe(2);
  });

  it("refuses input before desktop_ready with not_ready, and forwards it afterwards with the helper's geom_* names", async () => {
    const { helper, service, wire } = setup();
    const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
    const { socket, handlers } = await attach(service, wire, handle);
    const move = { type: "input", events: [{ kind: "mouse_move", x: 2, y: 1, fbWidth: 8, fbHeight: 4 }] };
    handlers.onMessage(socket, JSON.stringify(move));
    await flush();
    expect(texts(socket).filter((m) => m.type === "error")).toEqual([{ type: "error", code: "not_ready" }]);
    expect(helper.inputs).toEqual([]);
    helper.desktop(handle.sessionId);
    handlers.onMessage(socket, JSON.stringify(move));
    await flush();
    expect(helper.inputs).toEqual([
      { sessionId: handle.sessionId, events: [{ kind: "mouse_move", x: 2, y: 1, geom_width: 8, geom_height: 4 }] },
    ]);
  });

  it("relays stale_geometry rejections to the views", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const { socket } = await attach(service, wire, handle);
    helper.event(sid, { type: "rdp.input_rejected", applied: 0, rejected: [{ index: 0, code: "stale_geometry" }] });
    expect(texts(socket).at(-1)).toEqual({ type: "input_rejected", applied: 0, rejected: [{ index: 0, code: "stale_geometry" }] });
  });

  it("passes a helper refusal of input to the view by its code (rdp_input_overflow)", async () => {
    const { helper, service, wire, handle } = await readySession();
    const { socket, handlers } = await attach(service, wire, handle);
    helper.rejectInput = new HelperRequestError("rdp_input_overflow", "full");
    handlers.onMessage(socket, JSON.stringify({ type: "input", events: [{ kind: "ctrl_alt_del" }] }));
    await flush();
    expect(texts(socket).at(-1)).toEqual({ type: "error", code: "rdp_input_overflow" });
  });

  it("refuses malformed view messages and binary frames with bad_control", async () => {
    const { service, wire, handle } = await readySession();
    const { socket, handlers } = await attach(service, wire, handle);
    handlers.onMessage(socket, "{not json");
    handlers.onMessage(socket, JSON.stringify({ type: "ack", frameId: -1 }));
    handlers.onMessage(socket, new Uint8Array([1, 2, 3]));
    expect(texts(socket).filter((m) => m.type === "error")).toEqual([
      { type: "error", code: "bad_control" },
      { type: "error", code: "bad_control" },
      { type: "error", code: "bad_control" },
    ]);
  });

  it("detaching the only receiver of an un-acked frame releases the helper", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const { handlers } = await attach(service, wire, handle);
    helper.update(sid, 2, 0, true);
    expect(helper.acks).toEqual([]);
    handlers.onClose();
    expect(helper.acks).toEqual([2]);
  });
});

describe("RDP service: ending", () => {
  it("engine exit: the record is closed with the stored reason and the socket ends with 4000", async () => {
    const { helper, service, wire, handle, sid } = await readySession();
    const { socket } = await attach(service, wire, handle);
    helper.closed(sid, "engine_exited", 137);
    expect(texts(socket).at(-1)).toEqual({ type: "closed", exitCode: 137, signal: null, reason: "engine_exited" });
    expect(socket.closed).toEqual([{ code: 4000, reason: "session ended" }]);
    const record = service.sessionList().find((s) => s.sessionId === sid)!;
    expect(record).toMatchObject({ state: "closed", reason: "engine_exited", exitCode: 137 });
    expect(record.rdp?.state).toBe("closed");
    // A later attach with a fresh token learns the stored reason and closes with 4000.
    const late = await attach(service, wire, handle);
    expect(texts(late.socket)).toEqual([{ type: "closed", exitCode: 137, signal: null, reason: "engine_exited" }]);
    expect(late.socket.closed[0].code).toBe(4000);
  });

  it("an explicit close of a session that already ended does not announce the end again", async () => {
    const { helper, service, handle, sid } = await readySession();
    const ends: string[] = [];
    service.subscribeSessionEnd(handle, (info) => ends.push(info.reason));
    helper.closed(sid, "network_error");
    await service.sessionClose(handle);
    expect(ends).toEqual(["network_error"]);
    expect(service.sessionList().find((s) => s.sessionId === sid)?.reason).toBe("network_error");
  });

  it("helper exit closes the socket with 4410", async () => {
    const { helper, service, wire, handle } = await readySession();
    const { socket } = await attach(service, wire, handle);
    helper.exit();
    expect(socket.closed).toEqual([{ code: 4410, reason: "helper exited" }]);
  });

  it("an unknown or expired token closes with 4401", async () => {
    const { wire } = setup();
    const socket = makeSocket();
    await wire("ws://x/attach?attach=" + "0".repeat(32)).onOpen(socket);
    expect(socket.closed[0].code).toBe(4401);
  });

  it("a screenshot is passed through", async () => {
    const { service, handle } = await readySession();
    await expect(service.rdpScreenshot(handle)).resolves.toEqual({ frameId: 4, width: 800, height: 600, timestamp: 1, png: "QUJD" });
  });
});

describe("RDP service: the password never leaks (B4)", () => {
  it("appears in no log line, record, event, socket message or error — only in the helper open request", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
    );
    try {
      const { helper, service, wire } = setup();
      const handle = await service.rdpOpen({ ...TARGET }, 8, 4);
      const sid = handle.sessionId;
      const { socket, handlers } = await attach(service, wire, handle);
      helper.state(sid, "connecting");
      helper.prompt(sid, FP_A);
      const failures: string[] = [];
      await service.rdpCertDecision(handle, FP_B, "once").catch((e: Error) => failures.push(e.message));
      await service.rdpCertDecision(handle, FP_A, "session_trust");
      helper.state(sid, "authenticating");
      helper.desktop(sid);
      helper.update(sid, 2, 0, true);
      handlers.onMessage(socket, JSON.stringify({ type: "input", events: [{ kind: "unicode", text: "x" }] }));
      handlers.onMessage(socket, "garbage");
      await flush();
      helper.event(sid, { type: "rdp.input_rejected", applied: 0, rejected: [{ index: 0, code: "stale_geometry" }] });
      helper.closed(sid, "auth_failed");
      const everything = JSON.stringify({
        list: service.sessionList(),
        info: service.rdpInfo(handle),
        socket: socket.sent.map((d) => (typeof d === "string" ? d : "<binary " + d.byteLength + ">")),
        failures,
        logs,
        decisions: helper.decisions,
        inputs: helper.inputs,
      });
      expect(everything).not.toContain(SECRET);
      // Positive control: the helper's open request did carry it (and only that).
      expect(JSON.stringify(helper.opens)).toContain(SECRET);
      expect(helper.opens.length).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
