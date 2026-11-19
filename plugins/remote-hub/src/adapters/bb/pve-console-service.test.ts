// The service layer of Proxmox consoles over a scripted helper: the real service, no network. Every expected value is a literal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperProcess, PveSessionEvent } from "./helper-process.ts";
import { createRemoteHubService, type ControlGate, type RemoteHubService } from "./service.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import type { PveOpenArgs } from "./service.ts";

const GEN = "d".repeat(32);
const SECRET_PW = "VNC-PW-sentinel-71";

class FakeHelper {
  currentGeneration = GEN;
  status = { version: "0.1.0", pid: 1, platform: "test", sessionCount: 0 };
  nextSessionId = 1;
  opens: Array<{ target: unknown; cols: number; rows: number }> = [];
  vncInputs: Array<{ sessionId: number; bytes: number[] }> = [];
  closes: number[] = [];
  /** Delivered synchronously inside openPve, like the helper writing session.opened and the first events into one read. */
  duringOpen: Array<(sid: number) => void> = [];
  private pveCb: Array<(sid: number, e: PveSessionEvent) => void> = [];
  private vncCb: Array<(sid: number, d: Uint8Array) => void> = [];
  private closedCb: Array<(sid: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void> = [];
  private exitCb: Array<() => void> = [];

  async openPve(_connect: unknown, target: { kind: string }, cols: number, rows: number): Promise<{ handle: SessionHandle; kind: "pve" | "vnc" }> {
    this.opens.push({ target, cols, rows });
    const sessionId = this.nextSessionId++;
    for (const f of this.duringOpen) f(sessionId);
    return { handle: { generation: GEN, sessionId }, kind: target.kind === "qemu" ? "vnc" : "pve" };
  }
  async pveVncInput(handle: SessionHandle, data: Uint8Array): Promise<void> {
    this.vncInputs.push({ sessionId: handle.sessionId, bytes: [...data] });
  }
  async close(handle: SessionHandle) {
    this.closes.push(handle.sessionId);
    return { exitCode: null, signal: null, reason: "killed_by_close" };
  }
  async credit(): Promise<void> {}
  async pingAlive() {
    return true;
  }
  scrollbackSnapshot() {
    return new Uint8Array(0);
  }
  stop() {}
  onExit(cb: () => void) {
    this.exitCb.push(cb);
  }
  onSessionClosed(cb: (sid: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void) {
    this.closedCb.push(cb);
  }
  onSessionOutput() {}
  onSshAskpass() {}
  onExecFinished() {}
  onRdpEvent() {}
  onRdpUpdate() {}
  onPveEvent(cb: (sid: number, e: PveSessionEvent) => void) {
    this.pveCb.push(cb);
  }
  onVncData(cb: (sid: number, d: Uint8Array) => void) {
    this.vncCb.push(cb);
  }
  event(sid: number, e: PveSessionEvent) {
    for (const cb of this.pveCb) cb(sid, e);
  }
  data(sid: number, ...bytes: number[]) {
    for (const cb of this.vncCb) cb(sid, Uint8Array.from(bytes));
  }
  ended(sid: number, reason: string) {
    for (const cb of this.closedCb) cb(sid, { exitCode: null, signal: null, reason });
  }
  exit() {
    for (const cb of this.exitCb) cb();
  }
}

const connect = { host: "pve.test", port: 8006, authMode: "ticket" as const, user: "remotehub@pve", credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01", trust: { mode: "system" as const } };
const args = (kind: "node" | "lxc" | "qemu"): PveOpenArgs => ({
  connect,
  target: kind === "node" ? { kind, node: "pve1" } : { kind, node: "pve1", vmid: 101 },
  cols: 80,
  rows: 24,
  profileId: "11111111-1111-4111-8111-111111111111",
  connectionName: "lab",
  guestName: kind === "node" ? null : "web",
});

function setup(over: { control?: ControlGate; idle?: number; vncBuffer?: number } = {}) {
  const helper = new FakeHelper();
  const service: RemoteHubService = createRemoteHubService({
    startHelper: async () => helper as unknown as HelperProcess,
    headlessDrain: false,
    consoleIdleMs: over.idle ?? 60_000,
    ...(over.vncBuffer === undefined ? {} : { vncBufferBytes: over.vncBuffer }),
    ...(over.control === undefined ? {} : { control: over.control }),
  });
  const record = (h: SessionHandle) => service.sessionList().find((s) => s.sessionId === h.sessionId)!;
  return { helper, service, record };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a terminal console (node, LXC)", () => {
  it("is a session of kind pve with what it is for, and no secret", async () => {
    const { service, record } = setup();
    const { handle, kind } = await service.pveOpen(args("lxc"));
    expect(kind).toBe("pve");
    const r = record(handle);
    expect(r.kind).toBe("pve");
    expect(r.pve).toEqual({ profileId: "11111111-1111-4111-8111-111111111111", connectionName: "lab", console: "lxc", node: "pve1", vmid: 101, guestName: "web", state: "connecting", reason: null });
    expect(JSON.stringify(service.sessionList())).not.toContain("rh-cred");
  });

  it("goes connecting, then active when the helper says open", async () => {
    const { helper, service, record } = setup();
    const { handle } = await service.pveOpen(args("node"));
    const seen: string[] = [];
    service.subscribePveConsole(handle, (e) => seen.push(e.state));
    helper.event(handle.sessionId, { type: "state", state: "open" });
    expect(seen).toEqual(["connecting", "active"]);
    expect(record(handle).state).toBe("running");
  });

  it("events that arrive before the open call registered the record are not lost", async () => {
    const { helper, service, record } = setup();
    helper.duringOpen.push((sid) => helper.event(sid, { type: "state", state: "open" }));
    const { handle } = await service.pveOpen(args("lxc"));
    expect(record(handle).pve?.state).toBe("active");
  });

  it("a refused console shows the concrete reason as fixed text and keeps it through the end of the session", async () => {
    const { helper, service, record } = setup();
    const { handle } = await service.pveOpen(args("lxc"));
    helper.event(handle.sessionId, { type: "error", code: "no_permission", message: "SERVER WORDS", fingerprint: null });
    helper.ended(handle.sessionId, "error");
    const p = record(handle).pve!;
    expect(p.state).toBe("error");
    expect(p.reason?.code).toBe("no_permission");
    expect(p.reason?.text).toContain("VM.Console");
    expect(JSON.stringify(p)).not.toContain("SERVER WORDS");
  });

  it("a certificate refusal carries the presented fingerprint", async () => {
    const { helper, service, record } = setup();
    const { handle } = await service.pveOpen(args("node"));
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    helper.event(handle.sessionId, { type: "error", code: "tls_untrusted", message: "", fingerprint: fp });
    expect(record(handle).pve?.reason?.fingerprint).toBe(fp);
  });

  it("the other side closing is lost; the owner's own disconnect is disconnected", async () => {
    const a = setup();
    const lost = (await a.service.pveOpen(args("lxc"))).handle;
    a.helper.event(lost.sessionId, { type: "state", state: "open" });
    a.helper.ended(lost.sessionId, "remote_closed");
    expect(a.record(lost).pve).toMatchObject({ state: "lost", reason: { code: "remote_closed" } });
    const b = setup();
    const own = (await b.service.pveOpen(args("lxc"))).handle;
    await b.service.sessionClose(own);
    expect(b.record(own).pve).toMatchObject({ state: "disconnected", reason: null });
  });

  it("the helper going away is lost with its own reason", async () => {
    const { helper, service, record } = setup();
    const { handle } = await service.pveOpen(args("node"));
    helper.exit();
    expect(record(handle).pve).toMatchObject({ state: "lost", reason: { code: "helper_exited" } });
  });

  it("an agent may drive an active terminal console, not a connecting or failed one", async () => {
    const { helper, service } = setup();
    const { handle } = await service.pveOpen(args("lxc"));
    expect(service.agentControl(handle)).toBe("pending");
    helper.event(handle.sessionId, { type: "state", state: "open" });
    expect(service.agentControl(handle)).toBe("ready");
    helper.event(handle.sessionId, { type: "error", code: "websocket_error", message: "", fingerprint: null });
    expect(service.agentControl(handle)).toBe("never");
  });
});

describe("a graphical console (QEMU)", () => {
  const sink = () => {
    const got = { data: [] as number[][], passwords: [] as string[] };
    return { got, view: { sendData: (b: Uint8Array) => void got.data.push([...b]), sendPassword: (p: string) => void got.passwords.push(p) } };
  };

  it("is a session of kind vnc; the password and the greeting wait for the one view and are then delivered once", async () => {
    const { helper, service, record } = setup();
    const { handle, kind } = await service.pveOpen(args("qemu"));
    expect(kind).toBe("vnc");
    helper.event(handle.sessionId, { type: "vnc_password", password: SECRET_PW });
    helper.event(handle.sessionId, { type: "state", state: "open" });
    helper.data(handle.sessionId, 82, 70, 66);
    // never in the session record, the list or its JSON
    expect(JSON.stringify(service.sessionList())).not.toContain(SECRET_PW);
    const a = sink();
    const attached = service.vncAttach(handle, a.view);
    expect(attached.ok).toBe(true);
    expect(a.got).toEqual({ data: [[82, 70, 66]], passwords: [SECRET_PW] });
    helper.data(handle.sessionId, 1, 2);
    expect(a.got.data).toEqual([[82, 70, 66], [1, 2]]);
    expect(record(handle).pve?.state).toBe("active");
  });

  it("bytes and the password that came during the open call itself are kept for the view", async () => {
    const { helper, service } = setup();
    helper.duringOpen.push((sid) => {
      helper.event(sid, { type: "vnc_password", password: SECRET_PW });
      helper.data(sid, 9, 9);
    });
    const { handle } = await service.pveOpen(args("qemu"));
    const a = sink();
    service.vncAttach(handle, a.view);
    expect(a.got).toEqual({ data: [[9, 9]], passwords: [SECRET_PW] });
  });

  it("the view's bytes go to the console raw", async () => {
    const { helper, service } = setup();
    const { handle } = await service.pveOpen(args("qemu"));
    const r = service.vncAttach(handle, sink().view);
    if (!r.ok) throw new Error("refused");
    expect(await r.attachment.input(Uint8Array.of(3, 8, 0xff))).toBe(true);
    expect(helper.vncInputs).toEqual([{ sessionId: 1, bytes: [3, 8, 255] }]);
  });

  it("a second view is refused, and so is any view after the first one left", async () => {
    const { service } = setup();
    const { handle } = await service.pveOpen(args("qemu"));
    const first = service.vncAttach(handle, sink().view);
    expect(service.vncAttach(handle, sink().view)).toEqual({ ok: false, code: "vnc_view_taken" });
    if (first.ok) first.attachment.detach();
    expect(service.vncAttach(handle, sink().view)).toEqual({ ok: false, code: "vnc_not_resumable" });
  });

  it("the human's input is dropped while an agent holds the session", async () => {
    const control: ControlGate = { humanMayDrive: () => false, ownerTag: () => "agent:1", onChange: () => {}, state: () => ({ owner: "agent", expiresAt: 1 }), subscribe: () => () => {} };
    const { service, helper } = setup({ control });
    const { handle } = await service.pveOpen(args("qemu"));
    const r = service.vncAttach(handle, sink().view);
    if (!r.ok) throw new Error("refused");
    expect(await r.attachment.input(Uint8Array.of(1))).toBe(false);
    expect(helper.vncInputs).toEqual([]);
  });

  it("an agent has no control over graphics", async () => {
    const { helper, service } = setup();
    const { handle } = await service.pveOpen(args("qemu"));
    helper.event(handle.sessionId, { type: "state", state: "open" });
    expect(service.agentControl(handle)).toBe("never");
  });

  it("a console that sends more than the cap before any view attaches is closed", async () => {
    const { helper, service, record } = setup({ vncBuffer: 4 });
    const { handle } = await service.pveOpen(args("qemu"));
    helper.data(handle.sessionId, 1, 2, 3);
    helper.data(handle.sessionId, 4, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(helper.closes).toEqual([1]);
    expect(record(handle).reason).toBe("vnc_buffer_overflow");
  });

  it("the password is forgotten when the session ends before any view came", async () => {
    const { helper, service } = setup();
    const { handle } = await service.pveOpen(args("qemu"));
    helper.event(handle.sessionId, { type: "vnc_password", password: SECRET_PW });
    helper.ended(handle.sessionId, "remote_closed");
    // the record is closed, so no view can attach to it any more
    expect(() => service.vncAttach(handle, sink().view)).toThrow();
  });
});

describe("the idle policy", () => {
  it("closes a console nobody is looking at after the stated time, with its own reason", async () => {
    const { helper, service, record } = setup({ idle: 1000 });
    const { handle } = await service.pveOpen(args("lxc"));
    await vi.advanceTimersByTimeAsync(999);
    expect(helper.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(helper.closes).toEqual([1]);
    expect(record(handle).pve).toMatchObject({ state: "disconnected", reason: { code: "idle_timeout" } });
  });

  it("an attached view keeps it open; when the last view leaves the clock starts again", async () => {
    const { helper, service } = setup({ idle: 1000 });
    const { handle } = await service.pveOpen(args("lxc"));
    const stream = service.attachStream(handle);
    await vi.advanceTimersByTimeAsync(5000);
    expect(helper.closes).toEqual([]);
    stream.cancel();
    stream.cancel(); // a second cancel must not count twice
    await vi.advanceTimersByTimeAsync(1001);
    expect(helper.closes).toEqual([1]);
  });

  it("two views: it stays open until both are gone", async () => {
    const { helper, service } = setup({ idle: 1000 });
    const { handle } = await service.pveOpen(args("lxc"));
    const a = service.attachStream(handle);
    const b = service.attachStream(handle);
    a.cancel();
    await vi.advanceTimersByTimeAsync(3000);
    expect(helper.closes).toEqual([]);
    b.cancel();
    await vi.advanceTimersByTimeAsync(1001);
    expect(helper.closes).toEqual([1]);
  });

  it("an agent's lease keeps it open", async () => {
    let owner: "human" | "agent" = "agent";
    let change: (h: SessionHandle) => void = () => {};
    const control: ControlGate = { humanMayDrive: () => owner === "human", ownerTag: () => owner, onChange: (cb) => (change = cb), state: () => ({ owner, expiresAt: null }), subscribe: () => () => {} };
    const { helper, service } = setup({ idle: 1000, control });
    const { handle } = await service.pveOpen(args("lxc"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(helper.closes).toEqual([]);
    owner = "human";
    change(handle);
    await vi.advanceTimersByTimeAsync(1001);
    expect(helper.closes).toEqual([1]);
  });

  it("an explicit disconnect closes at once, and a console that already ended is not closed again by the timer", async () => {
    const { helper, service } = setup({ idle: 1000 });
    const { handle } = await service.pveOpen(args("lxc"));
    await service.sessionClose(handle);
    expect(helper.closes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(helper.closes).toEqual([1]);
  });
});
