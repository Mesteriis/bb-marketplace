import { describe, expect, it, vi } from "vitest";
import { AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import { ToolError } from "../../core/agent-tools.ts";
import { ControlLeases } from "../../core/control-lease.ts";
import type { Profile } from "../../core/profile.ts";
import { agentControlPorts, createControlGate, sweepControl } from "./agent-control.ts";
import type { RemoteHubService, SessionInfo } from "./service.ts";

const GEN = "f".repeat(32);
const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const profile = (over: Partial<Profile>): Profile =>
  ({ id: "11111111-2222-4333-8444-555555555551", name: "n", protocol: "ssh", host: "box.example.test", port: 22, username: "ops", domain: null, authType: "password", identityFile: null, credentialRef: REF, rdpWidth: null, rdpHeight: null, ...over }) as Profile;

function leasesWithClock() {
  let now = 1_000_000;
  let n = 0;
  return { leases: new ControlLeases({ now: () => now, newId: () => "lease-" + ++n }), advance: (ms: number) => void (now += ms) };
}

describe("the control gate", () => {
  it("the human may drive until an agent holds the lease, and the views are told about every change", () => {
    const { leases } = leasesWithClock();
    const gate = createControlGate(leases);
    const h = { generation: GEN, sessionId: 1 };
    const seen: unknown[] = [];
    const off = gate.subscribe(h, (v) => seen.push(v));
    expect(gate.humanMayDrive(h)).toBe(true);
    leases.acquire(`${GEN}.1`, "thr_a", 60);
    expect(gate.humanMayDrive(h)).toBe(false);
    expect(gate.state(h)).toEqual({ owner: "agent", expiresAt: 1_060_000 });
    leases.acquire(`${GEN}.2`, "thr_a", 60); // another session: not ours
    leases.takeover(`${GEN}.1`);
    expect(seen).toEqual([{ owner: "agent", expiresAt: 1_060_000 }, { owner: "human", expiresAt: null }]);
    off();
    leases.acquire(`${GEN}.1`, "thr_a", 60);
    expect(seen).toHaveLength(2);
  });
});

describe("the control ports", () => {
  function ports(extra: Partial<Record<string, unknown>> = {}) {
    const handlers = {
      ssh_open: vi.fn(async () => ({ generation: GEN, sessionId: 5 })),
      rdp_open: vi.fn(async () => ({ generation: GEN, sessionId: 6 })),
    };
    const service = {
      agentTerminalInput: vi.fn(async () => undefined),
      agentRdpInput: vi.fn(async () => undefined),
      sessionClose: vi.fn(async () => ({ exitCode: null, signal: null, reason: "killed_by_close" })),
      ownerQuestions: vi.fn(() => ["host_key"]),
      ...extra,
    };
    const profiles = new Map<string, Profile>();
    const p = agentControlPorts({ service: service as unknown as RemoteHubService, profiles: { get: (id) => profiles.get(id) ?? null }, handlers: handlers as never });
    return { p, handlers, service, profiles };
  }

  it("opens an SSH profile with its SAVED credential, as the page would, and returns the session key", async () => {
    const { p, handlers, profiles } = ports();
    const prof = profile({});
    profiles.set(prof.id, prof);
    expect(await p.connect(prof.id)).toEqual({ sessionKey: `${GEN}.5` });
    expect(handlers.ssh_open).toHaveBeenCalledWith({ target: { host: "box.example.test", port: 22, user: "ops", extraOptions: [] }, cols: 120, rows: 32, profileId: prof.id, credentialRef: REF });
    expect(JSON.stringify(handlers.ssh_open.mock.calls)).not.toMatch(/password"\s*:/);
  });

  it("opens an RDP profile with the saved credential and the profile's size", async () => {
    const { p, handlers, profiles } = ports();
    const prof = profile({ id: "11111111-2222-4333-8444-555555555552", protocol: "rdp", port: null, username: "u", domain: "CORP", rdpWidth: 800, rdpHeight: 600 });
    profiles.set(prof.id, prof);
    expect(await p.connect(prof.id)).toEqual({ sessionKey: `${GEN}.6` });
    expect(handlers.rdp_open).toHaveBeenCalledWith({ target: { host: "box.example.test", port: 3389, username: "u", domain: "CORP", credentialRef: REF }, width: 800, height: 600, profileId: prof.id });
  });

  it("an RDP profile without a user name is refused before anything is opened", async () => {
    const { p, handlers, profiles } = ports();
    const prof = profile({ protocol: "rdp", username: null });
    profiles.set(prof.id, prof);
    await expect(p.connect(prof.id)).rejects.toMatchObject({ code: "connection_incomplete" });
    expect(handlers.rdp_open).not.toHaveBeenCalled();
  });

  it("a refusal from the open is passed on as a tool error that names the reason, not as a crash", async () => {
    const { p, handlers, profiles } = ports();
    handlers.ssh_open.mockRejectedValueOnce(Object.assign(new Error("host_key_confirmation_pending: another session is waiting"), { code: "conflict" }));
    const prof = profile({});
    profiles.set(prof.id, prof);
    await expect(p.connect(prof.id)).rejects.toBeInstanceOf(ToolError);
    await expect(p.connect("99999999-2222-4333-8444-555555555559")).rejects.toMatchObject({ code: "connection_incomplete" });
  });

  it("writes go to the service as the agent's own paths, by handle", async () => {
    const { p, service } = ports();
    await p.terminalWrite(`${GEN}.3`, new TextEncoder().encode("ls"), "agent:L");
    await p.rdpWrite(`${GEN}.4`, [{ kind: "ctrl_alt_del" }], "agent:L");
    expect(service.agentTerminalInput).toHaveBeenCalledWith({ generation: GEN, sessionId: 3 }, new TextEncoder().encode("ls"), "agent:L");
    expect(service.agentRdpInput).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, [{ kind: "ctrl_alt_del" }], "agent:L");
    await expect(p.terminalWrite("garbage", new Uint8Array(), "agent:L")).rejects.toBeDefined();
  });

  it("disconnect closes the session and waitingForOwner reports kinds only", async () => {
    const { p, service } = ports();
    await p.disconnect(`${GEN}.3`);
    expect(service.sessionClose).toHaveBeenCalledWith({ generation: GEN, sessionId: 3 });
    expect(p.waitingForOwner(`${GEN}.3`)).toEqual(["host_key"]);
  });
});

describe("sweepControl", () => {
  const sessions = (list: Array<Partial<SessionInfo> & { sessionId: number }>) =>
    ({ sessionList: () => list.map((s) => ({ generation: GEN, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null, ...s })) }) as unknown as RemoteHubService;

  it("ends leases that ran out, and those of sessions that are closed or gone", () => {
    const { leases, advance } = leasesWithClock();
    const ended: string[] = [];
    leases.onEnd((e) => ended.push(`${e.sessionKey}:${e.reason}`));
    leases.acquire(`${GEN}.1`, "thr_a", 5);
    leases.acquire(`${GEN}.2`, "thr_a", 300);
    leases.acquire(`${GEN}.3`, "thr_a", 300);
    leases.acquire(`${GEN}.4`, "thr_a", 300);
    advance(6_000);
    sweepControl(leases, sessions([{ sessionId: 2 }, { sessionId: 3, state: "closed" }]));
    expect(ended.sort()).toEqual([`${GEN}.1:expired`, `${GEN}.3:session_closed`, `${GEN}.4:session_closed`]);
    expect(leases.owner(`${GEN}.2`).kind).toBe("agent");
  });
});

describe("registerControlLifecycle", () => {
  function harness() {
    const handlers = new Map<string, (payload: { thread: { id: string } }) => void>();
    const hooks: Array<() => void> = [];
    const bb = { events: { on: (event: string, h: (payload: { thread: { id: string } }) => void) => void handlers.set(event, h) }, onDispose: (h: () => void) => void hooks.push(h) } as never;
    const { leases } = leasesWithClock();
    const ended: string[] = [];
    leases.onEnd((e) => ended.push(`${e.threadId}:${e.reason}`));
    const registry = new AgentSessionRegistry();
    const closed: string[] = [];
    return { handlers, hooks, bb, leases, ended, registry, closed, close: async (key: string) => void closed.push(key) };
  }

  it("a deleted thread loses its leases, its opened sessions are CLOSED and forgotten; other threads are untouched; the timer stops on dispose", async () => {
    const { registerControlLifecycle } = await import("./agent-control.ts");
    const h = harness();
    h.leases.acquire(`${GEN}.1`, "thr_gone", 300);
    h.leases.acquire(`${GEN}.2`, "thr_kept", 300);
    h.registry.mark(`${GEN}.1`, "thr_gone");
    h.registry.mark(`${GEN}.3`, "thr_gone");
    h.registry.mark(`${GEN}.2`, "thr_kept");
    const spy = vi.spyOn(globalThis, "clearInterval");
    registerControlLifecycle(h.bb, { leases: h.leases, registry: h.registry, service: { sessionList: () => [] as SessionInfo[] }, closeSession: h.close, everyMs: 3_600_000 });
    expect([...h.handlers.keys()].sort()).toEqual(["thread.archived", "thread.deleted", "thread.unarchived"]);
    expect(h.registry.isRetired("thr_gone")).toBe(false);
    h.handlers.get("thread.deleted")!({ thread: { id: "thr_gone" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.registry.isRetired("thr_gone")).toBe(true);
    expect(h.ended).toEqual(["thr_gone:thread_gone"]);
    expect(h.closed.sort()).toEqual([`${GEN}.1`, `${GEN}.3`]);
    expect(h.registry.keys()).toEqual([`${GEN}.2`]);
    expect(h.leases.owner(`${GEN}.2`).kind).toBe("agent");
    for (const hook of h.hooks) hook();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("an archived thread loses its leases but its sessions stay open, remembered as opened by an archived thread", async () => {
    const { registerControlLifecycle } = await import("./agent-control.ts");
    const h = harness();
    h.leases.acquire(`${GEN}.1`, "thr_old", 300);
    h.registry.mark(`${GEN}.1`, "thr_old");
    registerControlLifecycle(h.bb, { leases: h.leases, registry: h.registry, service: { sessionList: () => [] as SessionInfo[] }, closeSession: h.close, everyMs: 3_600_000 });
    h.handlers.get("thread.archived")!({ thread: { id: "thr_old" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.ended).toEqual(["thr_old:thread_gone"]);
    expect(h.closed).toEqual([]);
    expect(h.registry.threadOf(`${GEN}.1`)).toBe("thr_old");
    expect(h.registry.isArchived("thr_old")).toBe(true);
    expect(h.registry.isArchived("thr_other")).toBe(false);
    expect(h.registry.isRetired("thr_old")).toBe(true);
    h.handlers.get("thread.unarchived")!({ thread: { id: "thr_old" } });
    expect(h.registry.isRetired("thr_old")).toBe(false);
  });

  it("a session that fails to close is still forgotten for that thread and the failure does not stop the others", async () => {
    const { registerControlLifecycle } = await import("./agent-control.ts");
    const h = harness();
    h.registry.mark(`${GEN}.1`, "thr_gone");
    h.registry.mark(`${GEN}.2`, "thr_gone");
    const attempted: string[] = [];
    registerControlLifecycle(h.bb, { leases: h.leases, registry: h.registry, service: { sessionList: () => [] as SessionInfo[] }, closeSession: async (k) => { attempted.push(k); if (k.endsWith(".1")) throw new Error("gone"); }, everyMs: 3_600_000 });
    h.handlers.get("thread.deleted")!({ thread: { id: "thr_gone" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(attempted.sort()).toEqual([`${GEN}.1`, `${GEN}.2`]);
  });
});
