import { describe, expect, it } from "vitest";
import { AgentAccessBook, type AgentGrant } from "./agent-access.ts";
import { AgentAudit, type AuditRow, type AuditStore } from "./agent-audit.ts";
import { createControlTools } from "./agent-control-tools.ts";
import { ToolBudget } from "./agent-budget.ts";
import type { AgentSessionView, AgentToolDef, ToolResult } from "./agent-tools.ts";
import { ControlLeases } from "./control-lease.ts";
import type { Profile } from "./profile.ts";
import type { RdpInputEvent } from "./rdp-protocol.ts";

const P_SSH = "11111111-2222-4333-8444-555555555551";
const P_RDP = "11111111-2222-4333-8444-555555555552";
const P_NOSECRET = "11111111-2222-4333-8444-555555555553";
const GEN = "0123456789abcdef0123456789abcdef";
const SSH_KEY = `${GEN}.1`;
const RDP_KEY = `${GEN}.2`;
const CTX = { threadId: "thr_a", projectId: "prj_1" };
const OTHER = { threadId: "thr_b", projectId: "prj_1" };
const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

const profile = (id: string, over: Partial<Profile> = {}): Profile =>
  ({
    id, executionHostId: "local", origin: "manual", createdAt: "x", updatedAt: "x", lastOpenedAt: null, recentErrors: [],
    name: "box-" + id.slice(-1), protocol: "ssh", group: "g", tags: [], favorite: false, color: null, host: "box.example.test", port: 22,
    username: "ops", domain: null, authType: "password", identityFile: null, credentialRef: REF, rdpWidth: null, rdpHeight: null, ...over,
  }) as Profile;

interface Setup {
  sessions?: AgentSessionView[];
}

function setup(opts: Setup = {}) {
  const profiles = [profile(P_SSH), profile(P_RDP, { protocol: "rdp", username: "u", port: 3389, rdpWidth: 800, rdpHeight: 600 }), profile(P_NOSECRET, { credentialRef: null })];
  const grants = new Map<string, AgentGrant>();
  const access = new AgentAccessBook({
    store: { all: () => [...grants.values()], get: (id) => grants.get(id) ?? null, put: (g) => void grants.set(g.profileId, g), remove: (id) => grants.delete(id), clear: () => { const n = grants.size; grants.clear(); return n; } },
    profiles: { has: (id) => profiles.some((p) => p.id === id) },
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  });
  const rows: AuditRow[] = [];
  let rid = 0;
  const store: AuditStore = {
    begin: (r) => (rows.push({ ...r, id: ++rid, outcome: null }), rid),
    finish: (id, o) => void (rows.find((r) => r.id === id)!.outcome = o),
    collapse: () => false,
    list: (n) => [...rows].reverse().slice(0, n),
    prune: () => {},
  };
  const audit = new AgentAudit({ store, now: () => new Date("2026-11-18T12:00:00.000Z") });
  let now = 1_000_000;
  let lease = 0;
  const leases = new ControlLeases({ now: () => now, newId: () => "lease-" + ++lease });
  const sessions: AgentSessionView[] = opts.sessions ?? [
    { key: SSH_KEY, kind: "ssh", state: "running", profileId: P_SSH, exitCode: null, reason: null },
    { key: RDP_KEY, kind: "rdp", state: "running", profileId: P_RDP, exitCode: null, reason: null, rdp: { state: "desktop_ready", desktop: { frameId: 7, width: 800, height: 600 } } },
  ];
  const wrote: Array<{ key: string; data: string }> = [];
  const rdpSent: Array<{ key: string; events: RdpInputEvent[] }> = [];
  const gates: { terminal: Array<() => void>; rdp: Array<() => void> } = { terminal: [], rdp: [] };
  let hold = false;
  const opened: string[] = [];
  const disconnected: string[] = [];
  const waiting = new Map<string, Array<"host_key" | "certificate" | "login_prompt">>();
  const tools = createControlTools({
    access, audit, budget: new ToolBudget({ now: () => now, callsPerWindow: 1000, bytesPerWindow: 50 * 1024 * 1024, globalCallsPerWindow: 10000, globalBytesPerWindow: 500 * 1024 * 1024 }),
    leases,
    ports: {
      profiles: { list: () => profiles, get: (id) => profiles.find((p) => p.id === id) ?? null },
      sessions: { list: () => sessions, read: () => null, screenshot: async () => { throw new Error("n/a"); } },
      fitScreenshot: () => { throw new Error("n/a"); },
    },
    control: {
      terminalWrite: async (key, data) => {
        if (hold) await new Promise<void>((r) => gates.terminal.push(r));
        wrote.push({ key, data: new TextDecoder().decode(data) });
      },
      rdpWrite: async (key, events) => {
        if (hold) await new Promise<void>((r) => gates.rdp.push(r));
        rdpSent.push({ key, events });
      },
      connect: async (profileId) => {
        const p = profiles.find((x) => x.id === profileId)!;
        const key = `${GEN}.${10 + opened.length}`;
        opened.push(p.id);
        sessions.push({ key, kind: p.protocol === "rdp" ? "rdp" : "ssh", state: "connecting", profileId: p.id, exitCode: null, reason: null });
        return { sessionKey: key };
      },
      disconnect: async (key) => void disconnected.push(key),
      waitingForOwner: (key) => waiting.get(key) ?? [],
    },
  });
  const tool = (name: string): AgentToolDef => tools.find((t) => t.name === name)!;
  const call = (name: string, input: unknown, ctx: { threadId: string; projectId: string; signal?: AbortSignal } = CTX): Promise<ToolResult> => {
    const t = tool(name);
    return t.execute(t.parameters.parse(input), ctx);
  };
  const textOf = (r: ToolResult) => r.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
  const data = (r: ToolResult) => JSON.parse(textOf(r)) as Record<string, any>;
  return {
    access, rows, leases, sessions, wrote, rdpSent, tools, tool, call, textOf, data, opened, disconnected, waiting,
    advance: (ms: number) => void (now += ms),
    holdWrites: () => void (hold = true),
    releaseWrites: () => {
      hold = false;
      for (const r of [...gates.terminal.splice(0), ...gates.rdp.splice(0)]) r();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the control tool set", () => {
  it("has exactly six tools, each starting with what it cannot do, with strict schemas and no password anywhere", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual(["remote_control_acquire", "remote_control_release", "remote_connect", "remote_disconnect", "remote_terminal_input", "remote_rdp_input"]);
    for (const t of tools) expect(t.description.startsWith("Cannot get a saved password, passphrase or key"), t.name).toBe(true);
    const bad: Record<string, unknown> = {
      remote_control_acquire: { sessionId: SSH_KEY, password: "x" },
      remote_control_release: { sessionId: SSH_KEY, leaseId: "l", password: "x" },
      remote_connect: { connectionId: P_SSH, password: "x" },
      remote_disconnect: { sessionId: SSH_KEY, password: "x" },
      remote_terminal_input: { sessionId: SSH_KEY, leaseId: "l", actions: [{ type: "text", text: "a" }], password: "x" },
      remote_rdp_input: { sessionId: RDP_KEY, leaseId: "l", actions: [{ type: "key", code: "Enter" }], password: "x" },
    };
    for (const t of tools) expect(t.parameters.safeParse(bad[t.name]).success, t.name).toBe(false);
    expect(tools.find((t) => t.name === "remote_connect")!.parameters.safeParse({ connectionId: P_SSH, host: "evil.example", credentialRef: REF, approve: true }).success).toBe(false);
  });
});

describe("remote_control_acquire / release", () => {
  it("needs the input level: observe is refused, with the same answer as for a session that does not exist", async () => {
    const t = setup();
    t.access.set(P_SSH, "observe", false);
    const refused = t.textOf(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    const missing = t.textOf(await t.call("remote_control_acquire", { sessionId: `${GEN}.99` }));
    expect(refused).toBe(missing);
    expect(refused).toContain("session_not_found");
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });

  it("grants a lease at input, reports id, expiry and ttl; the human is no longer the owner", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const r = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY, seconds: 30 }));
    expect(r).toMatchObject({ leaseId: "lease-1", ttlSeconds: 30 });
    expect(r.expiresAt).toBe(new Date(1_000_000 + 30_000).toISOString());
    expect(t.leases.owner(SSH_KEY)).toMatchObject({ kind: "agent", threadId: "thr_a" });
  });

  it("another thread cannot take it; the same thread asking again extends it and gets the same lease id", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY, seconds: 30 });
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: SSH_KEY }, OTHER))).toContain("held_by_another_thread");
    t.advance(10_000);
    const again = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY, seconds: 60 }));
    expect(again.leaseId).toBe("lease-1");
    expect(again.expiresAt).toBe(new Date(1_010_000 + 60_000).toISOString());
  });

  it("release gives the session back; a wrong lease id is refused and changes nothing", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    expect(t.textOf(await t.call("remote_control_release", { sessionId: SSH_KEY, leaseId: "nope" }))).toContain("not_the_owner");
    expect(t.leases.owner(SSH_KEY).kind).toBe("agent");
    expect((await t.call("remote_control_release", { sessionId: SSH_KEY, leaseId: "lease-1" })).isError).toBeUndefined();
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });

  it("lowering the grant below input ends the lease at once", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    t.access.set(P_SSH, "observe", false);
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    t.access.revokeAll();
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });
});

describe("remote_terminal_input", () => {
  async function leased() {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    return t;
  }

  it("refuses without a lease, with a wrong lease id, and from another thread", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const input = { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "ls" }] };
    expect(t.textOf(await t.call("remote_terminal_input", input))).toContain("no_lease");
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    expect(t.textOf(await t.call("remote_terminal_input", { ...input, leaseId: "other" }))).toContain("not_the_owner");
    expect(t.textOf(await t.call("remote_terminal_input", input, OTHER))).toContain("not_the_owner");
    expect(t.wrote).toEqual([]);
  });

  it("sends text and named keys as the exact bytes, in order", async () => {
    const t = await leased();
    const r = await t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "echo é" }, { type: "key", key: "Enter" }, { type: "key", key: "Ctrl-C" }, { type: "key", key: "Up" }] });
    expect(r.isError).toBeUndefined();
    expect(t.wrote).toEqual([{ key: SSH_KEY, data: "echo é\r\u0003\u001b[A" }]);
  });

  it("text cannot carry control characters (no escape sequences, no hidden Enter); keys are a closed list", () => {
    const { tool } = setup();
    const ok = (actions: unknown) => tool("remote_terminal_input").parameters.safeParse({ sessionId: SSH_KEY, leaseId: "l", actions }).success;
    expect(ok([{ type: "text", text: "a\nb" }])).toBe(false);
    expect(ok([{ type: "text", text: "a\u001b[31m" }])).toBe(false);
    expect(ok([{ type: "text", text: "a\u009bb" }])).toBe(false);
    expect(ok([{ type: "text", text: "a\u007f" }])).toBe(false);
    expect(ok([{ type: "key", key: "F13" }])).toBe(false);
    expect(ok([{ type: "text", text: "x".repeat(2000) }])).toBe(true);
    expect(ok([{ type: "text", text: "x".repeat(5000) }])).toBe(false);
  });

  it("the audit row is written before the action and keeps only the length and a short hash of the input", async () => {
    const t = await leased();
    await t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "super-secret-command" }] });
    const row = t.rows.at(-1)!;
    expect(row.tool).toBe("remote_terminal_input");
    expect(row.detailMode).toBe("hash");
    expect(row.detail).toMatch(/^len 20 sha [0-9a-f]{8}$/);
    expect(row.outcome).toBe("ok");
    expect(JSON.stringify(t.rows)).not.toContain("super-secret-command");
    expect(row.profileId).toBe(P_SSH);
  });

  it("an RDP session is not a terminal", async () => {
    const t = setup();
    t.access.set(P_RDP, "input", false);
    await t.call("remote_control_acquire", { sessionId: RDP_KEY });
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: RDP_KEY, leaseId: "lease-1", actions: [{ type: "key", key: "Enter" }] }))).toContain("not_a_terminal");
  });

  it("an expired lease is refused and the human has the session again", async () => {
    const t = await leased();
    t.advance(121_000);
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "key", key: "Enter" }] }))).toContain("lease_expired");
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });

  it("a takeover while an earlier write is in flight drops the queued one and lets the in-flight one finish", async () => {
    const t = await leased();
    t.holdWrites();
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await tick();
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] });
    await tick();
    t.leases.takeover(SSH_KEY);
    t.releaseWrites();
    expect((await first).isError).toBeUndefined();
    expect(t.textOf(await second)).toContain("lease_lost");
    expect(t.wrote.map((w) => w.data)).toEqual(["one"]);
  });

  it("revoking the grant while a write waits drops it", async () => {
    const t = await leased();
    t.holdWrites();
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await tick();
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] });
    await tick();
    t.access.set(P_SSH, "none", false);
    t.releaseWrites();
    await first;
    expect(t.textOf(await second)).toMatch(/lease_lost|session_not_found/);
    expect(t.wrote.map((w) => w.data)).toEqual(["one"]);
  });

  it("an aborted call stops its queued input and ends the lease", async () => {
    const t = await leased();
    t.holdWrites();
    const abort = new AbortController();
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await tick();
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] }, { ...CTX, signal: abort.signal });
    await tick();
    abort.abort();
    t.releaseWrites();
    await first;
    expect(t.textOf(await second)).toContain("lease_lost");
    expect(t.wrote.map((w) => w.data)).toEqual(["one"]);
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });
});

describe("remote_rdp_input", () => {
  const OBSERVED = { frameId: 7, width: 800, height: 600 };
  async function leased() {
    const t = setup();
    t.access.set(P_RDP, "input", false);
    await t.call("remote_control_acquire", { sessionId: RDP_KEY });
    return t;
  }
  const send = (t: Awaited<ReturnType<typeof leased>>, actions: unknown[], observed: unknown = OBSERVED, ctx = CTX) =>
    t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", observed, actions }, ctx);

  it("sends typed actions as the helper's events", async () => {
    const t = await leased();
    const r = await send(t, [{ type: "click", button: "left", x: 10, y: 20 }, { type: "key", code: "Enter" }]);
    expect(r.isError).toBeUndefined();
    expect(t.rdpSent).toHaveLength(1);
    expect(t.rdpSent[0]!.events.map((e) => e.kind)).toEqual(["mouse_move", "mouse_button", "mouse_button", "key", "key"]);
  });

  it("mouse actions need the observed geometry, and a different desktop size or a newer frame is stale_geometry", async () => {
    const t = await leased();
    expect(t.textOf(await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", actions: [{ type: "mouse_move", x: 1, y: 1 }] }))).toContain("observed_required");
    expect(t.textOf(await send(t, [{ type: "mouse_move", x: 1, y: 1 }], { frameId: 7, width: 1024, height: 768 }))).toContain("stale_geometry");
    expect(t.textOf(await send(t, [{ type: "mouse_move", x: 1, y: 1 }], { frameId: 8, width: 800, height: 600 }))).toContain("stale_geometry");
    expect(t.rdpSent).toEqual([]);
    expect((await send(t, [{ type: "mouse_move", x: 1, y: 1 }], { frameId: 3, width: 800, height: 600 })).isError).toBeUndefined();
  });

  it("keyboard-only actions need no observed geometry; a position outside the desktop is refused, not clamped", async () => {
    const t = await leased();
    expect((await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "hi" }] })).isError).toBeUndefined();
    expect(t.textOf(await send(t, [{ type: "mouse_move", x: 800, y: 1 }]))).toContain("out_of_bounds");
  });

  it("a terminal is not a desktop", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    expect(t.textOf(await t.call("remote_rdp_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "key", code: "Enter" }] }))).toContain("not_a_desktop");
  });

  it("the audit keeps length and hash only", async () => {
    const t = await leased();
    await send(t, [{ type: "text", text: "p4ssw0rd-typed" }]);
    const row = t.rows.at(-1)!;
    expect(row.detailMode).toBe("hash");
    expect(row.detail).toMatch(/^len \d+ sha [0-9a-f]{8}$/);
    expect(JSON.stringify(t.rows)).not.toContain("p4ssw0rd-typed");
  });

  it("when the lease ends keys and buttons the agent left down are released; a takeover also drops what was queued", async () => {
    const t = await leased();
    await send(t, [{ type: "key", code: "ShiftLeft", down: true }, { type: "mouse_button", button: "left", down: true, x: 5, y: 5 }]);
    t.holdWrites();
    const inFlight = send(t, [{ type: "key", code: "KeyA" }]);
    await tick();
    const queued = send(t, [{ type: "key", code: "KeyB" }]);
    await tick();
    t.leases.takeover(RDP_KEY);
    t.releaseWrites();
    await inFlight;
    expect(t.textOf(await queued)).toContain("lease_lost");
    await tick();
    await tick();
    const all = t.rdpSent.flatMap((s) => s.events);
    const last = all.slice(-2);
    expect(last.map((e) => (e.kind === "key" ? ["key", e.down] : e.kind === "mouse_button" ? ["button", e.down] : [e.kind]))).toEqual(expect.arrayContaining([["key", false], ["button", false]]));
    expect(all.some((e) => e.kind === "key" && e.scancode === 0x30)).toBe(false); // KeyB never went out
  });

  it("an expired lease releases held input too (sweep)", async () => {
    const t = await leased();
    await send(t, [{ type: "key", code: "ControlLeft", down: true }]);
    t.advance(121_000);
    t.leases.sweep();
    await tick();
    await tick();
    const last = t.rdpSent.at(-1)!.events;
    expect(last).toEqual([expect.objectContaining({ kind: "key", down: false })]);
  });
});

describe("remote_connect / remote_disconnect", () => {
  it("opens only a connection the owner allowed at input or above, and only with a saved credential", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "observe", false);
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_SSH }))).toContain("agent_access_denied");
    t.access.set(P_SSH, "input", false);
    const r = t.data(await t.call("remote_connect", { connectionId: P_SSH }));
    expect(r.sessionId).toBe(`${GEN}.10`);
    expect(t.opened).toEqual([P_SSH]);
    t.access.set(P_NOSECRET, "input", false);
    const refused = t.textOf(await t.call("remote_connect", { connectionId: P_NOSECRET }));
    expect(refused).toContain("needs_saved_credential");
    expect(t.opened).toEqual([P_SSH]);
  });

  it("does not know a connection that does not exist, with the same answer as for one not granted", async () => {
    const t = setup({ sessions: [] });
    const a = t.textOf(await t.call("remote_connect", { connectionId: "99999999-2222-4333-8444-555555555559" }));
    const b = t.textOf(await t.call("remote_connect", { connectionId: P_SSH }));
    expect(a).toBe(b);
  });

  it("says when the owner has a question to answer, as a kind only, and the session stays connecting", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    t.waiting.set(`${GEN}.10`, ["host_key"]);
    const r = t.data(await t.call("remote_connect", { connectionId: P_SSH }));
    expect(r).toMatchObject({ sessionId: `${GEN}.10`, state: "connecting", waitingForOwner: ["host_key"] });
    expect(JSON.stringify(r)).not.toMatch(/fingerprint|SHA256/);
  });

  it("at most four sessions per thread are open at once", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    for (let i = 0; i < 4; i++) expect((await t.call("remote_connect", { connectionId: P_SSH })).isError).toBeUndefined();
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_SSH }))).toContain("too_many_sessions");
    expect((await t.call("remote_connect", { connectionId: P_SSH }, OTHER)).isError).toBeUndefined();
  });

  it("a thread can disconnect what it opened and nothing else", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const mine = t.data(await t.call("remote_connect", { connectionId: P_SSH })).sessionId as string;
    expect(t.textOf(await t.call("remote_disconnect", { sessionId: SSH_KEY }))).toContain("not_opened_by_you");
    expect(t.textOf(await t.call("remote_disconnect", { sessionId: mine }, OTHER))).toContain("not_opened_by_you");
    expect((await t.call("remote_disconnect", { sessionId: mine })).isError).toBeUndefined();
    expect(t.disconnected).toEqual([mine]);
  });

  it("disconnecting needs the grant still to be input or above", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    const mine = t.data(await t.call("remote_connect", { connectionId: P_SSH })).sessionId as string;
    t.access.set(P_SSH, "none", false);
    expect(t.textOf(await t.call("remote_disconnect", { sessionId: mine }))).toContain("session_not_found");
    expect(t.disconnected).toEqual([]);
  });
});
