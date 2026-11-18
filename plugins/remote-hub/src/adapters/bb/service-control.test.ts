// The owner of a session decides who may drive it (stage 4b-1): the REAL service and the REAL attach sockets over a
// scripted helper. While an agent holds the lease the human's input is not forwarded, the view is told, and the
// agent's own paths write straight through. Expected values are literals.
import { describe, expect, it } from "vitest";
import { ControlLeases } from "../../core/control-lease.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import type { HelperProcess, RdpHelperEvent } from "./helper-process.ts";
import { createRemoteHubService, type ControlGate, type ControlView } from "./service.ts";
import { registerStreamSocket } from "./stream-socket.ts";

const GEN = "d".repeat(32);
const FP = Array.from({ length: 32 }, () => "AA").join(":");
const KEY = (h: SessionHandle) => `${h.generation}.${h.sessionId}`;

class FakeHelper {
  currentGeneration = GEN;
  next = 1;
  typed: Array<{ sessionId: number; text: string }> = [];
  agentTyped: Array<{ sessionId: number; text: string; owner: string }> = [];
  rdpInputs: Array<{ sessionId: number; events: unknown[]; owner?: string }> = [];
  owners: string[] = [];
  /** When set, session.set_owner answers only when this is called (a handoff that takes a while). */
  holdOwner: (() => void)[] | null = null;
  private eventCb: Array<(sid: number, e: RdpHelperEvent) => void> = [];
  private askpassCb: Array<(sid: number, e: unknown) => void> = [];
  async openSsh(): Promise<SessionHandle> {
    return { generation: GEN, sessionId: this.next++ };
  }
  async openRdp(): Promise<SessionHandle> {
    return { generation: GEN, sessionId: this.next++ };
  }
  writeInput(sessionId: number, data: Uint8Array): void {
    this.typed.push({ sessionId, text: new TextDecoder().decode(data) });
  }
  async rdpInput(handle: SessionHandle, events: unknown[], owner?: string): Promise<void> {
    this.rdpInputs.push({ sessionId: handle.sessionId, events, ...(owner === undefined ? {} : { owner }) });
  }
  async sessionSetOwner(_handle: SessionHandle, owner: string): Promise<{ dropped: number; released: number }> {
    this.owners.push(owner);
    if (this.holdOwner !== null) await new Promise<void>((resolve) => this.holdOwner!.push(resolve));
    return { dropped: 0, released: 0 };
  }
  async sessionInputFrom(handle: SessionHandle, data: string, owner: string): Promise<void> {
    this.agentTyped.push({ sessionId: handle.sessionId, text: data, owner });
  }
  async credit(): Promise<void> {}
  async rdpRefresh(): Promise<void> {}
  async rdpUpdateAck(): Promise<void> {}
  async rdpCertDecision(): Promise<void> {}
  async close() {
    return { exitCode: null, signal: null, reason: "killed_by_close" };
  }
  async pingAlive(): Promise<boolean> {
    return true;
  }
  scrollbackSnapshot(): Uint8Array {
    return new Uint8Array(0);
  }
  stop(): void {}
  onExit(): void {}
  onSessionClosed(): void {}
  onSessionOutput(): void {}
  onSshAskpass(cb: (sid: number, e: unknown) => void): void {
    this.askpassCb.push(cb);
  }
  onRdpEvent(cb: (sid: number, e: RdpHelperEvent) => void): void {
    this.eventCb.push(cb);
  }
  onRdpUpdate(): void {}
  event(sid: number, e: RdpHelperEvent): void {
    for (const cb of this.eventCb) cb(sid, e);
  }
  askpass(sid: number, e: unknown): void {
    for (const cb of this.askpassCb) cb(sid, e);
  }
}

interface FakeSocket {
  readyState: number;
  sent: Array<string | Uint8Array>;
  closed: Array<{ code?: number }>;
  send(d: string | Uint8Array): void;
  close(code?: number): void;
}
const makeSocket = (): FakeSocket => ({
  readyState: 1,
  sent: [],
  closed: [],
  send(d) {
    this.sent.push(d);
  },
  close(code) {
    this.readyState = 3;
    this.closed.push({ code });
  },
});
const texts = (s: FakeSocket) => s.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
type Handlers = { onOpen(s: FakeSocket): void | Promise<void>; onMessage(s: FakeSocket, d: string | Uint8Array): void; onClose(): void; onError(): void };

function setup() {
  const helper = new FakeHelper();
  let now = 1_000_000;
  let n = 0;
  const leases = new ControlLeases({ now: () => now, newId: () => "lease-" + ++n });
  const view = (h: SessionHandle): ControlView => {
    const o = leases.owner(KEY(h));
    return o.kind === "human" ? { owner: "human", expiresAt: null } : { owner: "agent", expiresAt: o.expiresAt };
  };
  const control: ControlGate = {
    humanMayDrive: (h) => leases.owner(KEY(h)).kind === "human",
    ownerTag: (h) => {
      const o = leases.owner(KEY(h));
      return o.kind === "human" ? "human" : `agent:${o.leaseId}`;
    },
    onChange: (cb) => leases.onChange((key) => cb({ generation: key.split(".")[0] as string, sessionId: Number(key.split(".")[1]) })),
    state: view,
    subscribe: (h, cb) => {
      const listener = (key: string) => key === KEY(h) && cb(view(h));
      leases.onChange(listener);
      return () => undefined;
    },
  };
  const service = createRemoteHubService({ startHelper: async () => helper as unknown as HelperProcess, env: {}, control });
  let captured: ((ctx: { url: URL }) => Handlers) | null = null;
  registerStreamSocket({ http: { experimental_websocket(_p: string, h: typeof captured) { captured = h; } } } as never, { service });
  const attach = async (handle: SessionHandle) => {
    const socket = makeSocket();
    const handlers = captured!({ url: new URL("ws://x/attach?attach=" + service.sessionAttach(handle)) });
    await handlers.onOpen(socket);
    return { socket, handlers };
  };
  return { helper, service, leases, attach, advance: (ms: number) => void (now += ms) };
}

describe("a terminal session while an agent holds the lease", () => {
  it("forwards the human's keys when nobody holds it", async () => {
    const { helper, service, attach } = setup();
    const handle = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    const { socket, handlers } = await attach(handle);
    handlers.onMessage(socket, new TextEncoder().encode("ls"));
    await flush();
    expect(helper.typed).toEqual([{ sessionId: handle.sessionId, text: "ls" }]);
    expect(texts(socket).filter((m) => m.type === "input_blocked")).toEqual([]);
  });

  it("drops the human's keys, tells the view once, and still forwards the agent's own writes", async () => {
    const { helper, service, leases, attach } = setup();
    const handle = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    const { socket, handlers } = await attach(handle);
    leases.acquire(KEY(handle), "thr_a", 60);
    handlers.onMessage(socket, new TextEncoder().encode("rm -rf"));
    handlers.onMessage(socket, new TextEncoder().encode("x"));
    await flush();
    expect(helper.typed).toEqual([]);
    expect(texts(socket).filter((m) => m.type === "input_blocked")).toEqual([{ type: "input_blocked" }]);
    await service.agentTerminalInput(handle, new TextEncoder().encode("echo hi\r"), "agent:lease-1");
    expect(helper.typed).toEqual([]);
    expect(helper.agentTyped).toEqual([{ sessionId: handle.sessionId, text: "echo hi\r", owner: "agent:lease-1" }]);
  });

  it("a view that attaches while the human drives hears nothing; it is told when that changes, and at attach when an agent holds the session", async () => {
    const { service, leases, attach } = setup();
    const handle = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    const { socket } = await attach(handle);
    expect(texts(socket).filter((m) => m.type === "control")).toEqual([]);
    leases.acquire(KEY(handle), "thr_a", 60);
    leases.takeover(KEY(handle));
    expect(texts(socket).filter((m) => m.type === "control")).toEqual([
      { type: "control", owner: "agent", expiresAt: 1_060_000 },
      { type: "control", owner: "human", expiresAt: null },
    ]);
    leases.allowAgents(KEY(handle));
    leases.acquire(KEY(handle), "thr_b", 30);
    const late = await attach(handle);
    expect(texts(late.socket).filter((m) => m.type === "control")).toEqual([{ type: "control", owner: "agent", expiresAt: 1_030_000 }]);
  });

  it("after the human takes control the keys go through again", async () => {
    const { helper, service, leases, attach } = setup();
    const handle = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    const { socket, handlers } = await attach(handle);
    leases.acquire(KEY(handle), "thr_a", 60);
    handlers.onMessage(socket, new TextEncoder().encode("a"));
    leases.takeover(KEY(handle));
    handlers.onMessage(socket, new TextEncoder().encode("b"));
    await flush();
    expect(helper.typed).toEqual([{ sessionId: handle.sessionId, text: "b" }]);
  });
});

describe("a desktop session while an agent holds the lease", () => {
  async function ready() {
    const ctx = setup();
    const handle = await ctx.service.rdpOpen({ host: "rdp.test", port: 3389, username: "u", password: "pw" }, 8, 4);
    ctx.helper.event(handle.sessionId, { type: "rdp.state", state: "connecting" });
    ctx.helper.event(handle.sessionId, { type: "rdp.desktop", frameId: 1, width: 8, height: 4, timestamp: 1 });
    return { ...ctx, handle };
  }
  const MOVE = JSON.stringify({ type: "input", events: [{ kind: "mouse_move", x: 2, y: 1, fbWidth: 8, fbHeight: 4 }] });

  it("drops the human's input with the same notice, and the agent's own events pass", async () => {
    const { helper, service, leases, attach, handle } = await ready();
    const { socket, handlers } = await attach(handle);
    leases.acquire(KEY(handle), "thr_a", 60);
    handlers.onMessage(socket, MOVE);
    await flush();
    expect(helper.rdpInputs).toEqual([]);
    expect(texts(socket).filter((m) => m.type === "input_blocked")).toEqual([{ type: "input_blocked" }]);
    await service.agentRdpInput(handle, [{ kind: "ctrl_alt_del" }], "agent:lease-1");
    expect(helper.rdpInputs).toEqual([{ sessionId: handle.sessionId, events: [{ kind: "ctrl_alt_del" }], owner: "agent:lease-1" }]);
  });

  it("the view hears about every change of the owner", async () => {
    const { leases, attach, handle } = await ready();
    const { socket } = await attach(handle);
    leases.acquire(KEY(handle), "thr_a", 60);
    leases.takeover(KEY(handle));
    expect(texts(socket).filter((m) => m.type === "control").map((m) => m.owner)).toEqual(["agent", "human"]);
  });

  it("agent input is refused before the desktop is ready, like a human's", async () => {
    const { service } = setup();
    const handle = await service.rdpOpen({ host: "rdp.test", port: 3389, username: "u", password: "pw" }, 8, 4);
    await expect(service.agentRdpInput(handle, [{ kind: "ctrl_alt_del" }], "agent:lease-1")).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("what waits for the owner", () => {
  it("an SSH host-key question is a host_key; a secret prompt a login_prompt; an informational one nothing", async () => {
    const { helper, service } = setup();
    const handle = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    expect(service.ownerQuestions(handle)).toEqual([]);
    helper.askpass(handle.sessionId, { type: "prompt", promptId: 1, text: "Are you sure you want to continue connecting (yes/no)?", kind: "confirm" });
    helper.askpass(handle.sessionId, { type: "prompt", promptId: 2, text: "One-time code:", kind: "secret" });
    helper.askpass(handle.sessionId, { type: "prompt", promptId: 3, text: "Welcome", kind: "none" });
    expect(service.ownerQuestions(handle)).toEqual(["host_key", "login_prompt"]);
    expect(service.sshPendingPrompts(handle)).toEqual([
      { promptId: 1, text: "Are you sure you want to continue connecting (yes/no)?", kind: "confirm" },
      { promptId: 2, text: "One-time code:", kind: "secret" },
    ]);
  });

  it("an RDP certificate question is a certificate, and nothing once it is decided", async () => {
    const { helper, service } = setup();
    const handle = await service.rdpOpen({ host: "rdp.test", port: 3389, username: "u", password: "pw" }, 8, 4);
    helper.event(handle.sessionId, { type: "rdp.state", state: "cert_prompt" });
    helper.event(handle.sessionId, {
      type: "rdp.cert_prompt", host: "rdp.test", port: 3389, fingerprint: FP, subject: "CN=x", issuer: "CN=x", notBefore: "2026-01-01T00:00:00Z", notAfter: "2036-01-01T00:00:00Z", reason: "untrusted_root",
    });
    expect(service.ownerQuestions(handle)).toEqual(["certificate"]);
    await service.rdpCertDecision(handle, FP, "once");
    expect(service.ownerQuestions(handle)).toEqual([]);
  });
});

describe("Z1: which sessions an agent may drive", () => {
  const ASK = { credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a" };

  it("a plain ssh session (no saved secret) is never drivable: its questions appear in the terminal", async () => {
    const { service } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    expect(service.agentControl(h)).toBe("never");
  });

  it("a saved-secret session is pending until the helper says the credential was used, then ready; a question for the owner makes it pending again", async () => {
    const { helper, service } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24, undefined, ASK);
    expect(service.agentControl(h)).toBe("pending");
    helper.askpass(h.sessionId, { type: "credential_used" });
    expect(service.agentControl(h)).toBe("ready");
    helper.askpass(h.sessionId, { type: "prompt", promptId: 3, text: "One-time code:", kind: "secret" });
    expect(service.agentControl(h)).toBe("pending");
    await service.sshPromptAnswer(h, 3, "123456").catch(() => undefined);
    expect(service.agentControl(h)).toBe("ready");
  });

  it("the credential being used is not shown to the page as a notice", async () => {
    const { helper, service } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24, undefined, ASK);
    const seen: unknown[] = [];
    service.subscribeSshAskpass(h, (e) => seen.push(e));
    helper.askpass(h.sessionId, { type: "credential_used" });
    expect(seen).toEqual([]);
  });

  it("a refused or failed credential, and a closed session, are never drivable", async () => {
    const { helper, service } = setup();
    const a = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24, undefined, ASK);
    helper.askpass(a.sessionId, { type: "credential_used" });
    helper.askpass(a.sessionId, { type: "credential_rejected" });
    expect(service.agentControl(a)).toBe("never");
    const b = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24, undefined, ASK);
    helper.askpass(b.sessionId, { type: "credential_used" });
    await service.sessionClose(b);
    expect(service.agentControl(b)).toBe("never");
  });

  it("a desktop session is ready, an unknown session never", async () => {
    const { service } = setup();
    const r = await service.rdpOpen({ host: "rdp.test", port: 3389, username: "u", password: "pw" }, 8, 4);
    expect(service.agentControl(r)).toBe("ready");
    expect(service.agentControl({ generation: r.generation, sessionId: 999 })).toBe("never");
  });
});

describe("Z2: a change of driver is a barrier the helper acknowledges, and stale work is refused at dispatch", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("the helper is told every change of driver (acquire, takeover), and not a renewal", async () => {
    const { helper, service, leases } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    leases.acquire(KEY(h), "thr_a", 60);
    await settle();
    const a = leases.owner(KEY(h));
    if (a.kind === "agent") leases.renew(KEY(h), "thr_a", a.leaseId, 60);
    await settle();
    leases.takeover(KEY(h));
    await settle();
    expect(helper.owners).toEqual(["agent:lease-1", "human"]);
  });

  it("the human's keys wait for the handoff to be acknowledged, then are dropped if an agent is the driver", async () => {
    const { helper, service, leases, attach } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    const { socket, handlers } = await attach(h);
    helper.holdOwner = [];
    leases.acquire(KEY(h), "thr_a", 60);
    await settle();
    handlers.onMessage(socket, new TextEncoder().encode("late"));
    await settle();
    expect(helper.typed, "nothing may be dispatched before the barrier is acknowledged").toEqual([]);
    for (const release of helper.holdOwner) release();
    helper.holdOwner = null;
    await flush();
    expect(helper.typed, "an agent drives now: the human's keys are dropped at dispatch").toEqual([]);
  });

  it("the human's keys that were waiting for a takeover go through once the human is the driver", async () => {
    const { helper, service, leases, attach } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    leases.acquire(KEY(h), "thr_a", 60);
    await settle();
    const { socket, handlers } = await attach(h);
    helper.holdOwner = [];
    leases.takeover(KEY(h));
    await settle();
    handlers.onMessage(socket, new TextEncoder().encode("mine"));
    await settle();
    expect(helper.typed).toEqual([]);
    for (const release of helper.holdOwner) release();
    helper.holdOwner = null;
    await flush();
    expect(helper.typed).toEqual([{ sessionId: h.sessionId, text: "mine" }]);
  });

  it("an agent write for a lease that is no longer the driver is refused with lease_lost and never reaches the helper", async () => {
    const { helper, service, leases } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    leases.acquire(KEY(h), "thr_a", 60);
    leases.takeover(KEY(h));
    await expect(service.agentTerminalInput(h, new TextEncoder().encode("x"), "agent:lease-1")).rejects.toMatchObject({ code: "lease_lost" });
    expect(helper.agentTyped).toEqual([]);
  });

  it("the next driver's write waits for the barrier of its own acquisition", async () => {
    const { helper, service, leases } = setup();
    const h = await service.sshOpen({ host: "h", extraOptions: [] }, 80, 24);
    helper.holdOwner = [];
    leases.acquire(KEY(h), "thr_a", 60);
    const pending = service.agentTerminalInput(h, new TextEncoder().encode("go"), "agent:lease-1");
    await settle();
    expect(helper.agentTyped).toEqual([]);
    for (const release of helper.holdOwner) release();
    helper.holdOwner = null;
    await pending;
    expect(helper.agentTyped).toHaveLength(1);
  });
});
