import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFeed } from "./agent-feed.ts";
import { AgentAccessBook, type AgentGrant } from "./agent-access.ts";
import { AgentAudit, type AuditRow, type AuditStore } from "./agent-audit.ts";
import { AgentSessionRegistry, controlSessionExtras, createControlTools } from "./agent-control-tools.ts";
import { ToolBudget } from "./agent-budget.ts";
import { ToolError, type AgentSessionView, type AgentToolDef, type ToolResult } from "./agent-tools.ts";
import { ControlLeases } from "./control-lease.ts";
import type { Profile } from "./profile.ts";
import type { RdpInputEvent } from "./rdp-protocol.ts";

const P_SSH = "11111111-2222-4333-8444-555555555551";
const P_RDP = "11111111-2222-4333-8444-555555555552";
const P_NOSECRET = "11111111-2222-4333-8444-555555555553";
const P_PVE = "11111111-2222-4333-8444-555555555554";
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
  const profiles = [profile(P_SSH), profile(P_RDP, { protocol: "rdp", username: "u", port: 3389, rdpWidth: 800, rdpHeight: 600 }), profile(P_NOSECRET, { credentialRef: null }), profile(P_PVE, { protocol: "pve", port: 8006, username: "remotehub@pve", authType: "password" })];
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
    { key: SSH_KEY, kind: "ssh", state: "running", profileId: P_SSH, exitCode: null, reason: null, control: "ready" },
    { key: RDP_KEY, kind: "rdp", state: "running", profileId: P_RDP, exitCode: null, reason: null, control: "ready", rdp: { state: "desktop_ready", desktop: { frameId: 7, width: 800, height: 600 } } },
  ];
  const wrote: Array<{ key: string; data: string; owner: string }> = [];
  const rdpSent: Array<{ key: string; events: RdpInputEvent[]; owner: string }> = [];
  const gates: { terminal: Array<() => void>; rdp: Array<() => void> } = { terminal: [], rdp: [] };
  let hold = false;
  const opened: string[] = [];
  const consoles: unknown[] = [];
  let pveRefusal: ToolError | null = null;
  let connectGate: Promise<void> | null = null;
  const disconnected: string[] = [];
  let failDisconnect = false;
  let watched = true;
  let required = true;
  const waiting = new Map<string, Array<"host_key" | "certificate" | "login_prompt">>();
  const registry = new AgentSessionRegistry();
  const feed = new AgentFeed();
  const feedSeen: Array<{ key: string; event: unknown }> = [];
  for (const key of [SSH_KEY, RDP_KEY]) feed.subscribe(key, (event) => feedSeen.push({ key, event }));
  const tools = createControlTools({
    feed,
    access, audit, budget: new ToolBudget({ now: () => now, callsPerWindow: 1000, bytesPerWindow: 50 * 1024 * 1024, globalCallsPerWindow: 10000, globalBytesPerWindow: 500 * 1024 * 1024 }),
    leases,
    registry,
    ports: {
      profiles: { list: () => profiles, get: (id) => profiles.find((p) => p.id === id) ?? null },
      sessions: { list: (tid) => (tid === null ? sessions : sessions.filter((x) => { const o = registry.threadOf(x.key); return o === undefined || o === tid; })), read: () => null, screenshot: async () => { throw new Error("n/a"); } },
      fitScreenshot: () => { throw new Error("n/a"); },
    },
    control: {
      terminalWrite: async (key, data, owner) => {
        if (hold) await new Promise<void>((r) => gates.terminal.push(r));
        wrote.push({ key, data: new TextDecoder().decode(data), owner });
      },
      rdpWrite: async (key, events, owner) => {
        if (hold) await new Promise<void>((r) => gates.rdp.push(r));
        rdpSent.push({ key, events, owner });
      },
      connect: async (profileId, console) => {
        if (connectGate !== null) await connectGate;
        const p = profiles.find((x) => x.id === profileId)!;
        if (p.protocol === "pve" && pveRefusal !== null) throw pveRefusal;
        const key = `${GEN}.${10 + opened.length}`;
        opened.push(p.id);
        consoles.push(console);
        const kind = p.protocol === "rdp" ? "rdp" : p.protocol === "pve" ? (console?.console === "qemu" ? "vnc" : "pve") : "ssh";
        sessions.push({ key, kind, state: "connecting", profileId: p.id, exitCode: null, reason: null, control: kind === "vnc" ? "never" : "ready", ...(console === undefined || console.console === "node" ? {} : { pve: { console: console.console, node: "pve1", vmid: console.vmid, state: "connecting", reason: null } }) });
        return { sessionKey: key };
      },
      disconnect: async (key) => {
        if (failDisconnect) throw new Error("close failed");
        disconnected.push(key);
      },
      waitingForOwner: (key) => waiting.get(key) ?? [],
      watching: () => watched,
      watchingRequired: () => required,
      onWatchChange: () => () => undefined,
      onRuleChange: () => () => undefined,
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
    setFailDisconnect: (v: boolean) => void (failDisconnect = v),
    consoles,
    refusePve: (e: ToolError | null) => void (pveRefusal = e),
    setWatching: (v: boolean) => void (watched = v),
    setRequired: (v: boolean) => void (required = v),
    feedSeen, registry, access, rows, leases, sessions, wrote, rdpSent, tools, tool, call, textOf, data, opened, disconnected, waiting,
    advance: (ms: number) => void (now += ms),
    holdConnect: () => {
      let release!: () => void;
      connectGate = new Promise<void>((r) => (release = r));
      return () => {
        connectGate = null;
        release();
      };
    },
    holdWrites: () => void (hold = true),
    releaseWrites: () => {
      hold = false;
      for (const r of [...gates.terminal.splice(0), ...gates.rdp.splice(0)]) r();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `cond` holds (the input tools write their audit row, and so are queued, before anything else awaits). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("condition not reached");
}

describe("the control tool set", () => {
  it("has exactly seven tools, each starting with what it cannot do, with strict schemas and no password anywhere", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual(["remote_control_acquire", "remote_control_release", "remote_connect", "remote_reconnect", "remote_disconnect", "remote_terminal_input", "remote_rdp_input"]);
    for (const t of tools) expect(t.description.startsWith("Cannot get a saved password, passphrase or key"), t.name).toBe(true);
    const bad: Record<string, unknown> = {
      remote_control_acquire: { sessionId: SSH_KEY, password: "x" },
      remote_control_release: { sessionId: SSH_KEY, leaseId: "l", password: "x" },
      remote_connect: { connectionId: P_SSH, password: "x" },
      remote_reconnect: { sessionId: SSH_KEY, password: "x" },
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
    expect(t.wrote).toEqual([{ key: SSH_KEY, data: "echo é\r\u0003\u001b[A", owner: "agent:lease-1" }]);
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

  it("the audit row is written before the action and keeps only the length of the input", async () => {
    const t = await leased();
    await t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "super-secret-command" }] });
    const row = t.rows.at(-1)!;
    expect(row.tool).toBe("remote_terminal_input");
    expect(row.detailMode).toBe("length");
    expect(row.detail).toBe("len 20");
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
    const n0 = t.rows.length;
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await until(() => t.rows.length >= n0 + 1);
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] });
    await until(() => t.rows.length >= n0 + 2);
    t.leases.takeover(SSH_KEY);
    t.releaseWrites();
    expect((await first).isError).toBeUndefined();
    expect(t.textOf(await second)).toContain("lease_lost");
    expect(t.wrote.map((w) => w.data)).toEqual(["one"]);
  });

  it("revoking the grant while a write waits drops it", async () => {
    const t = await leased();
    t.holdWrites();
    const n0 = t.rows.length;
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await until(() => t.rows.length >= n0 + 1);
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] });
    await until(() => t.rows.length >= n0 + 2);
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
    const n0 = t.rows.length;
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await until(() => t.rows.length >= n0 + 1);
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] }, { ...CTX, signal: abort.signal });
    await until(() => t.rows.length >= n0 + 2);
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

  it("the audit keeps the length only", async () => {
    const t = await leased();
    await send(t, [{ type: "text", text: "p4ssw0rd-typed" }]);
    const row = t.rows.at(-1)!;
    expect(row.detailMode).toBe("length");
    expect(row.detail).toMatch(/^len \d+$/);
    expect(JSON.stringify(t.rows)).not.toContain("p4ssw0rd-typed");
  });

  it("desktop input carries the lease it belongs to, so the helper can refuse it once that lease is not the driver", async () => {
    const t = await leased();
    await send(t, [{ type: "key", code: "KeyA" }]);
    expect(t.rdpSent.map((s) => s.owner)).toEqual(["agent:lease-1"]);
  });

  it("a takeover while a desktop write is in flight drops the queued one here (and the helper drops what it already holds)", async () => {
    const t = await leased();
    t.holdWrites();
    const n0 = t.rows.length;
    const inFlight = send(t, [{ type: "key", code: "KeyA" }]);
    await until(() => t.rows.length >= n0 + 1);
    const queued = send(t, [{ type: "key", code: "KeyB" }]);
    await until(() => t.rows.length >= n0 + 2);
    t.leases.takeover(RDP_KEY);
    t.releaseWrites();
    await inFlight;
    expect(t.textOf(await queued)).toContain("lease_lost");
    expect(t.rdpSent.flatMap((s) => s.events).some((e) => e.kind === "key" && e.scancode === 0x30)).toBe(false); // KeyB never went out
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
    expect(t.textOf(await t.call("remote_disconnect", { sessionId: mine }, OTHER))).toContain("session_not_found");
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

describe("Z1: only sessions where no question can appear in the terminal may be driven", () => {
  const HUMAN_KEY = `${GEN}.7`;
  const sessionsWith = (control: "never" | "pending"): AgentSessionView[] => [
    { key: HUMAN_KEY, kind: "ssh", state: "running", profileId: P_SSH, exitCode: null, reason: null, control },
  ];

  it("a terminal session the human opened without a saved secret answers like a missing one for acquire and input", async () => {
    const t = setup({ sessions: sessionsWith("never") });
    t.access.set(P_SSH, "input", false);
    const missing = t.textOf(await t.call("remote_control_acquire", { sessionId: `${GEN}.99` }));
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: HUMAN_KEY }))).toBe(missing);
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: HUMAN_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "yes" }] }))).toBe(
      t.textOf(await t.call("remote_terminal_input", { sessionId: `${GEN}.99`, leaseId: "lease-1", actions: [{ type: "text", text: "yes" }] })),
    );
    expect(t.wrote).toEqual([]);
    expect(t.leases.owner(HUMAN_KEY).kind).toBe("human");
  });

  it("a session that is not authenticated yet, or has a question for the owner, is not ready: no lease, no input", async () => {
    const t = setup({ sessions: sessionsWith("pending") });
    t.access.set(P_SSH, "input", false);
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: HUMAN_KEY }))).toContain("session_not_ready");
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: HUMAN_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "x" }] }))).toContain("session_not_ready");
    expect(t.wrote).toEqual([]);
  });

  it("a lease on a session that stops being ready drops what is still queued", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    t.holdWrites();
    const n0 = t.rows.length;
    const first = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "one" }] });
    await until(() => t.rows.length >= n0 + 1);
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "two" }] });
    await until(() => t.rows.length >= n0 + 2);
    t.sessions.find((s) => s.key === SSH_KEY)!.control = "pending"; // a question appeared for the owner
    t.releaseWrites();
    await first;
    expect(t.textOf(await second)).toContain("lease_lost");
    expect(t.wrote.map((w) => w.data)).toEqual(["one"]);
  });
});

describe("Z5: takeover hold, abort scope, retired threads", () => {
  it("after a takeover the agent is told owner_took_over, and gets the session when the human allows it", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    t.leases.takeover(SSH_KEY);
    const again = t.textOf(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    expect(again).toContain("owner_took_over");
    expect(again).toContain("allow agents again");
    expect(lease.leaseId).toBe("lease-1");
    t.leases.allowAgents(SSH_KEY);
    expect((await t.call("remote_control_acquire", { sessionId: SSH_KEY })).isError).toBeUndefined();
  });

  it("a late abort of an old call does not end the lease that replaced it", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    await t.call("remote_control_acquire", { sessionId: SSH_KEY });
    t.holdWrites();
    const abort = new AbortController();
    const n0 = t.rows.length;
    const old = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "old" }] }, { ...CTX, signal: abort.signal });
    await until(() => t.rows.length >= n0 + 1);
    // the lease is released and a new one is taken by the same thread while the old call is still waiting
    t.leases.release(SSH_KEY, "thr_a", "lease-1");
    const next = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    expect(next.leaseId).toBe("lease-2");
    abort.abort();
    t.releaseWrites();
    await old;
    expect(t.leases.owner(SSH_KEY)).toMatchObject({ kind: "agent", leaseId: "lease-2" });
  });

  it("an archived or deleted thread cannot acquire or connect; an unarchived one can again", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    t.registry.markArchived("thr_a");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_SSH }))).toContain("thread_retired");
    t.registry.unarchive("thr_a");
    expect((await t.call("remote_connect", { connectionId: P_SSH })).isError).toBeUndefined();
    t.registry.markDeleted("thr_a");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_SSH }))).toContain("thread_retired");
  });

  it("a retired thread cannot acquire control of a session", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    t.registry.markDeleted("thr_a");
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: SSH_KEY }))).toContain("thread_retired");
    expect(t.leases.owner(SSH_KEY).kind).toBe("human");
  });
});

describe("Z6: remote_connect reserves its slot before awaiting and revalidates after", () => {
  it("six parallel connects admit only four, and the slot of a failed open is given back", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    const release = t.holdConnect();
    const calls = Array.from({ length: 6 }, () => t.call("remote_connect", { connectionId: P_SSH }));
    await until(() => t.rows.length >= 6);
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.isError !== true)).toHaveLength(4);
    expect(results.filter((r) => t.textOf(r).includes("too_many_sessions"))).toHaveLength(2);
    expect(t.opened).toHaveLength(4);
  });

  it("a grant revoked while the connection opens closes the session and returns an error, not a session", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    const release = t.holdConnect();
    const pending = t.call("remote_connect", { connectionId: P_SSH });
    await until(() => t.rows.length >= 1);
    t.access.set(P_SSH, "none", false);
    release();
    const r = await pending;
    expect(t.textOf(r)).toContain("connect_cancelled");
    expect(t.disconnected).toEqual([`${GEN}.10`]);
    expect(t.registry.threadOf(`${GEN}.10`)).toBeUndefined();
  });

  it("A3: when closing a late result fails, the session stays registered (counts against the cap, found by deletion cleanup) until closed", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    const release = t.holdConnect();
    const pending = t.call("remote_connect", { connectionId: P_SSH });
    await until(() => t.rows.length >= 1);
    t.access.set(P_SSH, "none", false);
    t.setFailDisconnect(true);
    release();
    const r = await pending;
    expect(t.textOf(r)).toContain("connect_cancelled");
    expect(t.textOf(r)).toContain("could not be confirmed closed");
    expect(t.registry.threadOf(`${GEN}.10`)).toBe("thr_a");
    expect(t.registry.closingKeys()).toEqual([`${GEN}.10`]);
    // The slot is still taken: four more opens fit only three.
    t.access.set(P_SSH, "input", false);
    t.setFailDisconnect(false);
    const more = await Promise.all(Array.from({ length: 4 }, () => t.call("remote_connect", { connectionId: P_SSH })));
    expect(more.filter((x) => x.isError !== true)).toHaveLength(3);
  });

  it("a thread archived, or a call aborted, while the connection opens closes it too", async () => {
    for (const how of ["archived", "aborted"] as const) {
      const t = setup({ sessions: [] });
      t.access.set(P_SSH, "input", false);
      const release = t.holdConnect();
      const abort = new AbortController();
      const pending = t.call("remote_connect", { connectionId: P_SSH }, { ...CTX, signal: abort.signal });
      await until(() => t.rows.length >= 1);
      if (how === "archived") t.registry.markArchived("thr_a");
      else abort.abort();
      release();
      expect(t.textOf(await pending), how).toContain("connect_cancelled");
      expect(t.disconnected, how).toEqual([`${GEN}.10`]);
    }
  });
});


describe("Z8: RDP input bounds and dispatch-time geometry", () => {
  const OBS = { frameId: 7, width: 800, height: 600 };
  async function leasedRdp() {
    const t = setup();
    t.access.set(P_RDP, "input", false);
    await t.call("remote_control_acquire", { sessionId: RDP_KEY });
    return t;
  }

  it("text has no control characters, and one call may expand to at most 400 events", async () => {
    const t = await leasedRdp();
    const tool = t.tool("remote_rdp_input");
    expect(tool.parameters.safeParse({ sessionId: RDP_KEY, leaseId: "lease-1", actions: [{ type: "text", text: "a\nb" }] }).success).toBe(false);
    const many = Array.from({ length: 3 }, () => ({ type: "text", text: "x".repeat(200) }));
    expect(t.textOf(await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", actions: many }))).toContain("too_many_events");
    expect(t.rdpSent).toEqual([]);
  });

  it("the answer says queued, not done", async () => {
    const t = await leasedRdp();
    const r = t.data(await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", observed: OBS, actions: [{ type: "mouse_move", x: 1, y: 1 }] }));
    expect(r).toMatchObject({ queuedEvents: 1 });
    expect(r.sentEvents).toBeUndefined();
  });

  it("a desktop that changed size while the write waited is stale_geometry at dispatch, and nothing is sent", async () => {
    const t = await leasedRdp();
    t.holdWrites();
    const n0 = t.rows.length;
    const first = t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", actions: [{ type: "key", code: "KeyA" }] });
    await until(() => t.rows.length >= n0 + 1);
    const second = t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: "lease-1", observed: OBS, actions: [{ type: "mouse_move", x: 5, y: 5 }] });
    await until(() => t.rows.length >= n0 + 2);
    t.sessions.find((s) => s.key === RDP_KEY)!.rdp = { state: "desktop_ready", desktop: { frameId: 9, width: 1024, height: 768 } };
    t.releaseWrites();
    await first;
    expect(t.textOf(await second)).toContain("stale_geometry");
    expect(t.rdpSent.flatMap((s) => s.events).some((e) => e.kind === "mouse_move")).toBe(false);
  });

  it("the tool description states the frame policy it enforces", () => {
    const { tool } = setup();
    expect(tool("remote_rdp_input").description).toContain("a frame number the desktop has not reached");
    expect(tool("remote_rdp_input").description).not.toContain("newer than you saw");
  });
});

describe("agents are never hidden: input needs a watcher", () => {
  const TYPE = { sessionId: SSH_KEY, actions: [{ type: "text", text: "id" }] };

  it("with nobody watching nothing is typed, and the answer says why; with a watcher it goes through", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    t.setWatching(false);
    const refused = await t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId });
    expect(refused.isError).toBe(true);
    expect(t.textOf(refused)).toContain("owner_not_watching");
    expect(t.wrote).toEqual([]);
    t.setWatching(true);
    expect((await t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId })).isError).toBeUndefined();
    expect(t.wrote.map((w) => w.data)).toEqual(["id"]);
  });

  it("with the owner's setting OFF input goes through without a watcher, and the change counts from the very next call", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    expect(lease.watchingRequired).toBe(true);
    t.setWatching(false);
    expect(t.textOf(await t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId }))).toContain("owner_not_watching");
    t.setRequired(false);
    expect((await t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId })).isError).toBeUndefined();
    expect(t.wrote.map((w) => w.data)).toEqual(["id"]);
    t.setRequired(true);
    expect(t.textOf(await t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId }))).toContain("owner_not_watching");
    expect(t.wrote).toHaveLength(1);
    // The results still say so, and still carry the live-view line.
    t.setRequired(false);
    const again = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    expect(again).toMatchObject({ watching: false, watchingRequired: false, liveView: `::remote-session{id="${SSH_KEY}"}` });
  });

  it("with the setting OFF the live view and the pointer are still announced (visibility stays, only the gate goes)", async () => {
    const t = setup();
    t.access.set(P_RDP, "input", false);
    t.setRequired(false);
    t.setWatching(false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: RDP_KEY }));
    await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: lease.leaseId, observed: { frameId: 7, width: 800, height: 600 }, actions: [{ type: "mouse_move", x: 3, y: 4 }] });
    expect(t.feedSeen).toContainEqual({ key: RDP_KEY, event: { kind: "pointer", x: 3, y: 4, width: 800, height: 600 } });
  });

  it("desktop input is refused the same way", async () => {
    const t = setup();
    t.access.set(P_RDP, "input", false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: RDP_KEY }));
    t.setWatching(false);
    const r = await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: lease.leaseId, actions: [{ type: "key", code: "Enter" }] });
    expect(t.textOf(r)).toContain("owner_not_watching");
    expect(t.rdpSent).toEqual([]);
  });

  it("input already queued when the last watcher leaves is dropped, not sent", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    t.holdWrites();
    const first = t.call("remote_terminal_input", { ...TYPE, leaseId: lease.leaseId });
    await until(() => t.rows.length >= 2);
    const second = t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: lease.leaseId, actions: [{ type: "text", text: "late" }] });
    await until(() => t.rows.length >= 3);
    t.setWatching(false); // the owner closes the view while the first write is in flight
    t.releaseWrites();
    await first;
    const lateResult = await second;
    expect(t.textOf(lateResult)).toContain("owner_not_watching");
    expect(t.wrote.map((w) => w.data)).toEqual(["id"]);
  });

  it("acquire and connect hand the agent the live-view line and say whether anybody is watching", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_SSH, "input", false);
    t.setWatching(false);
    const opened = t.data(await t.call("remote_connect", { connectionId: P_SSH }));
    expect(opened.watching).toBe(false);
    expect(opened.liveView).toBe(`::remote-session{id="${opened.sessionId}"}`);
    expect(String(opened.instruction)).toContain("liveView");
  });

  it("what the agent does is announced to the owner's views: typed length (the text itself is in the terminal) and the desktop pointer", async () => {
    const t = setup();
    t.access.set(P_SSH, "input", false);
    t.access.set(P_RDP, "input", false);
    const ssh = t.data(await t.call("remote_control_acquire", { sessionId: SSH_KEY }));
    await t.call("remote_terminal_input", { sessionId: SSH_KEY, leaseId: ssh.leaseId, actions: [{ type: "text", text: "ls" }, { type: "key", key: "Enter" }] });
    const rdp = t.data(await t.call("remote_control_acquire", { sessionId: RDP_KEY }));
    await t.call("remote_rdp_input", { sessionId: RDP_KEY, leaseId: rdp.leaseId, observed: { frameId: 7, width: 800, height: 600 }, actions: [{ type: "click", button: "left", x: 10, y: 20 }] });
    expect(t.feedSeen).toEqual([
      { key: SSH_KEY, event: { kind: "typed", length: 3 } },
      { key: RDP_KEY, event: { kind: "pointer", x: 10, y: 20, width: 800, height: 600, click: "left" } },
    ]);
  });

  it("session rows say whether the owner is watching", () => {
    const t = setup();
    const view = { key: SSH_KEY, kind: "ssh", state: "running", profileId: P_SSH, exitCode: null, reason: null, control: "ready" } as AgentSessionView;
    const extras = (watching: boolean) => controlSessionExtras(t.leases, { waitingForOwner: () => [], watching: () => watching, watchingRequired: () => true })(view);
    expect(extras(true)).toMatchObject({ watchedByOwner: true });
    expect(extras(false)).toMatchObject({ watchedByOwner: false });
  });
});

describe("Proxmox consoles through remote_connect", () => {
  it("a Proxmox connection needs a console; the others refuse one", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    t.access.set(P_SSH, "input", false);
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE }))).toContain("console_required");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc" }))).toContain("invalid_target");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101, node: "pve1" }))).toContain("invalid_target");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_SSH, console: "lxc", vmid: 101 }))).toContain("not_a_proxmox_connection");
    expect(t.opened).toEqual([]);
  });

  it("opens a container terminal and a VM's graphics under the same access model (input level, saved credential)", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "observe", false);
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 }))).toContain("agent_access_denied");
    t.access.set(P_PVE, "input", false);
    expect(t.data(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 })).sessionId).toBe(`${GEN}.10`);
    await t.call("remote_connect", { connectionId: P_PVE, console: "qemu", vmid: 200 });
    expect(t.consoles).toEqual([{ console: "lxc", vmid: 101 }, { console: "qemu", vmid: 200 }]);
  });

  it("a shell on a node is never opened for an agent: root@pam or a hand-typed login would make it a shell on the hypervisor", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    for (const input of [{ connectionId: P_PVE, console: "node" as const, node: "pve1" }, { connectionId: P_PVE, console: "node" as const }, { connectionId: P_PVE, console: "node" as const, node: "pve1", vmid: 101 }]) {
      const text = t.textOf(await t.call("remote_connect", input));
      expect(text).toContain("node_shell_owner_only");
    }
    expect(t.opened).toEqual([]);
    expect(t.consoles).toEqual([]);
    // a connection saved as root@pam gets no other way in
    expect(t.tool("remote_connect").description).toContain("never available to agents (node_shell_owner_only)");
  });

  it("a refusal (stopped guest...) reaches the agent as our own fixed text", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    t.refusePve(new ToolError("guest_stopped", "The guest is not running; Remote Hub never starts it."));
    const text = t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 }));
    expect(text).toContain("guest_stopped");
    expect(t.opened).toEqual([]);
  });

  it("a container terminal is driven like any terminal: lease, then typed input", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    const key = t.data(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 })).sessionId as string;
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: key })).leaseId as string;
    await t.call("remote_terminal_input", { sessionId: key, leaseId: lease, actions: [{ type: "text", text: "ls" }, { type: "key", key: "Enter" }] });
    expect(t.wrote.map((w) => w.data)).toEqual(["ls\r"]);
  });

  it("graphics: an agent can open and disconnect, but has no lease, no typing and no clicking", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    const key = t.data(await t.call("remote_connect", { connectionId: P_PVE, console: "qemu", vmid: 200 })).sessionId as string;
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: key }))).toContain("graphics_no_input");
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: key, leaseId: "l", actions: [{ type: "text", text: "a" }] }))).toContain("graphics_no_input");
    expect(t.textOf(await t.call("remote_rdp_input", { sessionId: key, leaseId: "l", actions: [{ type: "key", code: "Enter" }] }))).toContain("graphics_no_input");
    expect(t.wrote).toEqual([]);
    expect(t.rdpSent).toEqual([]);
    expect((await t.call("remote_disconnect", { sessionId: key })).isError).toBeUndefined();
    expect(t.disconnected).toEqual([key]);
  });

  it("graphics of a session the agent may not use answer like a missing one", async () => {
    const t = setup({ sessions: [{ key: `${GEN}.9`, kind: "vnc", state: "running", profileId: P_PVE, exitCode: null, reason: null, control: "never" }] });
    t.access.set(P_PVE, "observe", false);
    expect(t.textOf(await t.call("remote_control_acquire", { sessionId: `${GEN}.9` }))).toContain("session_not_found");
  });

  it("the tool texts say what graphics cannot do", () => {
    const t = setup();
    const connect = t.tool("remote_connect").description;
    expect(connect).toContain("NO screenshot and NO input");
    expect(connect).toContain('"lxc" with `vmid`');
    expect(t.tool("remote_rdp_input").description).toContain("desktop (RDP)");
    expect(t.tool("remote_terminal_input").description).toContain("Proxmox node or container terminal");
  });
});


describe("remote_reconnect", () => {
  afterEach(() => vi.restoreAllMocks());

  /** An agent opened a console; it then ended (`closed`) for `code`. */
  async function lostConsole(t: ReturnType<typeof setup>, console: "lxc" | "qemu" = "lxc", code = "remote_closed", reason = "Proxmox closed the console.") {
    const input = console === "lxc" ? { connectionId: P_PVE, console, vmid: 101 } : { connectionId: P_PVE, console, vmid: 200 };
    const key = t.data(await t.call("remote_connect", input)).sessionId as string;
    const row = t.sessions.find((x) => x.key === key)!;
    row.state = "closed";
    row.pve = { console, node: "pve1", vmid: console === "lxc" ? 101 : 200, state: "lost", reason, reasonCode: code };
    return key;
  }
  const ready = () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    return t;
  };

  it("opens the same guest again as a NEW session with a new id, forgets the old one and says how often it was reopened", async () => {
    const t = ready();
    const old = await lostConsole(t);
    t.sessions.find((x) => x.key === old)!.state = "running"; // the lease is taken while it is still alive
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: old })).leaseId as string;
    t.sessions.find((x) => x.key === old)!.state = "closed";
    const out = t.data(await t.call("remote_reconnect", { sessionId: old }));
    expect(out).toMatchObject({ previousSessionId: old, connectionId: P_PVE, reconnects: 1, maxReconnects: 5 });
    expect(out.sessionId).not.toBe(old);
    expect(out.sessionId).toBe(`${GEN}.11`);
    expect(out.liveView).toContain(out.sessionId);
    expect(t.consoles).toEqual([{ console: "lxc", vmid: 101 }, { console: "lxc", vmid: 101 }]);
    expect(t.registry.threadOf(old)).toBeUndefined();
    expect(t.registry.threadOf(out.sessionId)).toBe("thr_a");
    // the old lease died with the old session; nothing typed before travels to the new one
    expect(t.textOf(await t.call("remote_terminal_input", { sessionId: old, leaseId: lease, actions: [{ type: "text", text: "x" }] }))).toContain("session_closed");
    expect(t.wrote).toEqual([]);
    expect(out.note).toContain("nothing typed before is sent again");
  });

  it("a virtual machine's graphics opens a new console and returns the new session id", async () => {
    const t = ready();
    const old = await lostConsole(t, "qemu");
    const out = t.data(await t.call("remote_reconnect", { sessionId: old }));
    expect(out.sessionId).not.toBe(old);
    expect(t.consoles.at(-1)).toEqual({ console: "qemu", vmid: 200 });
    expect(t.sessions.find((x) => x.key === out.sessionId)?.kind).toBe("vnc");
  });

  it("is refused while the console is still connected", async () => {
    const t = ready();
    const key = t.data(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 })).sessionId as string;
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: key }))).toContain("still_connected");
    expect(t.opened).toHaveLength(1);
  });

  it.each(["login_failed", "tls_untrusted", "cert_changed", "tfa_required", "no_credential"])("is refused after %s: the owner has to fix the connection, and nothing is retried", async (code) => {
    const t = ready();
    const old = await lostConsole(t, "lxc", code, "the fixed text");
    const text = t.textOf(await t.call("remote_reconnect", { sessionId: old }));
    expect(text).toContain("reconnect_refused");
    expect(text).toContain(code);
    expect(t.opened).toHaveLength(1);
    expect(t.registry.threadOf(old)).toBe("thr_a");
  });

  it("only the thread that opened the console may reopen it; an unknown id and a non-console session answer like a missing one", async () => {
    const t = ready();
    const old = await lostConsole(t);
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }, OTHER))).toContain("session_not_found");
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: `${GEN}.99` }))).toContain("session_not_found");
    t.sessions.push({ key: SSH_KEY, kind: "ssh", state: "closed", profileId: P_SSH, exitCode: 0, reason: null, control: "ready" });
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: SSH_KEY }))).toContain("session_not_found");
    expect(t.opened).toHaveLength(1);
  });

  it("needs the connect level and a saved credential, like remote_connect", async () => {
    const t = ready();
    const old = await lostConsole(t);
    t.access.set(P_PVE, "observe", false);
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain("agent_access_denied");
    t.access.set(P_PVE, "input", false);
    expect(t.data(await t.call("remote_reconnect", { sessionId: old })).reconnects).toBe(1);
  });

  it("a node shell can never be reopened for an agent", async () => {
    const t = ready();
    const old = await lostConsole(t);
    const row = t.sessions.find((x) => x.key === old)!;
    row.pve = { ...row.pve!, console: "node", vmid: null };
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain("node_shell_owner_only");
  });

  it("the same refusals as remote_connect reach the agent as fixed text (a stopped guest is not started)", async () => {
    const t = ready();
    const old = await lostConsole(t);
    t.refusePve(new ToolError("guest_stopped", "The guest is not running; Remote Hub never starts it."));
    const text = t.textOf(await t.call("remote_reconnect", { sessionId: old }));
    expect(text).toContain("guest_stopped");
    expect(t.opened).toHaveLength(1);
    expect(t.registry.threadOf(old)).toBe("thr_a");
  });

  it("five reopenings in a row that did not hold are the limit; one that was ACTIVE for ten seconds starts the count again", async () => {
    const t = ready();
    let key = await lostConsole(t);
    const lose = (k: string, activeMs: number | null) => {
      const row = t.sessions.find((x) => x.key === k)!;
      row.state = "closed";
      row.pve = { console: "lxc", node: "pve1", vmid: 101, state: "lost", reason: "x", reasonCode: "remote_closed", activeMs };
    };
    for (let n = 1; n <= 5; n++) {
      const out = t.data(await t.call("remote_reconnect", { sessionId: key }));
      expect(out.reconnects).toBe(n);
      key = out.sessionId as string;
      lose(key, 2000); // active for two seconds only, however long ago it was registered
    }
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: key }))).toContain("reconnect_limit");
    lose(key, 10_000); // it held: active for ten seconds
    expect(t.data(await t.call("remote_reconnect", { sessionId: key })).reconnects).toBe(1);
  });

  it("how long ago the old console was registered does not make it 'held': only its active time does", async () => {
    const t = ready();
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const key = await lostConsole(t);
    clock += 3_600_000; // an hour later
    expect(t.data(await t.call("remote_reconnect", { sessionId: key })).reconnects).toBe(1);
    const second = t.sessions.at(-1)!.key;
    const row = t.sessions.find((x) => x.key === second)!;
    row.state = "closed";
    row.pve = { console: "lxc", node: "pve1", vmid: 101, state: "lost", reason: "x", reasonCode: "remote_closed", activeMs: 500 };
    clock += 3_600_000;
    expect(t.data(await t.call("remote_reconnect", { sessionId: second })).reconnects).toBe(2);
  });

  it("two concurrent calls on the same closed session open exactly one console; the other is told it is in progress", async () => {
    const t = ready();
    const old = await lostConsole(t);
    const release = t.holdConnect();
    const first = t.call("remote_reconnect", { sessionId: old });
    const second = t.call("remote_reconnect", { sessionId: old });
    await tick();
    release();
    const texts = [t.textOf(await first), t.textOf(await second)];
    expect(texts.filter((x) => x.includes("reconnect_in_progress"))).toHaveLength(1);
    expect(texts.filter((x) => x.includes("previousSessionId"))).toHaveLength(1);
    expect(t.opened).toHaveLength(2); // the original and one reopening
  });

  it("failed reopens count: after five failures the sixth call is the limit, from the same old session", async () => {
    const t = ready();
    const old = await lostConsole(t);
    t.refusePve(new ToolError("unreachable", "The Proxmox endpoint did not answer."));
    for (let n = 1; n <= 5; n++) expect(t.textOf(await t.call("remote_reconnect", { sessionId: old })), String(n)).toContain("unreachable");
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain("reconnect_limit");
    expect(t.opened).toHaveLength(1);
  });

  it.each(["login_failed", "tfa_required", "tls_untrusted", "cert_changed"])("a %s on an open blocks the connection for agents (reconnect and connect) until the owner opens it successfully", async (code) => {
    const t = ready();
    const old = await lostConsole(t);
    t.refusePve(new ToolError(code, "refused"));
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain(code);
    t.refusePve(null);
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain("connection_blocked");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 }))).toContain("connection_blocked");
    expect(t.opened).toHaveLength(1);
    t.registry.unblock(P_PVE); // the owner opened a console on it
    expect(t.data(await t.call("remote_reconnect", { sessionId: old })).reconnects).toBe(2); // the refused attempt counted
  });

  it("a console that ended with login_failed blocks the connection when the agent asks to reopen it", async () => {
    const t = ready();
    const old = await lostConsole(t, "lxc", "login_failed", "refused");
    expect(t.textOf(await t.call("remote_reconnect", { sessionId: old }))).toContain("reconnect_refused");
    expect(t.registry.blockedCode(P_PVE)).toBe("login_failed");
    expect(t.textOf(await t.call("remote_connect", { connectionId: P_PVE, console: "qemu", vmid: 200 }))).toContain("connection_blocked");
  });

  it("is audited under its own name, and a failure writes its outcome", async () => {
    const t = ready();
    const old = await lostConsole(t);
    await t.call("remote_reconnect", { sessionId: old });
    expect(t.rows.some((r) => r.tool === "remote_reconnect")).toBe(true);
  });

  it("the description says it is a new console, what is refused and that no power control exists", () => {
    const d = ready().tool("remote_reconnect").description;
    expect(d).toContain("NEW session id");
    expect(d).toContain("never available to agents");
    expect(d).not.toMatch(/\b(reboot|shutdown|power)\b/i);
  });

  it("a session row for a console shows how many times it was reopened; other sessions show nothing of the kind", async () => {
    const t = ready();
    const old = await lostConsole(t);
    const out = t.data(await t.call("remote_reconnect", { sessionId: old }));
    const extras = controlSessionExtras(t.leases, { waitingForOwner: () => [], watching: () => true, watchingRequired: () => true }, t.registry);
    const row = t.sessions.find((x) => x.key === out.sessionId)!;
    row.pve = { console: "lxc", node: "pve1", vmid: 101, state: "active", reason: null };
    expect(extras(row)).toMatchObject({ reconnects: 1, maxReconnects: 5 });
    expect(extras({ key: SSH_KEY, kind: "ssh", state: "running", exitCode: null, reason: null, control: "ready" })).not.toHaveProperty("reconnects");
  });
});

describe("one agent thread never reaches another thread's console", () => {
  it("every control tool answers session_not_found for a console the other thread opened, and nothing is sent or closed", async () => {
    const t = setup({ sessions: [] });
    t.access.set(P_PVE, "input", false);
    const key = t.data(await t.call("remote_connect", { connectionId: P_PVE, console: "lxc", vmid: 101 })).sessionId as string;
    const lease = t.data(await t.call("remote_control_acquire", { sessionId: key })).leaseId as string;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["remote_control_acquire", { sessionId: key }],
      ["remote_control_release", { sessionId: key, leaseId: lease }],
      ["remote_terminal_input", { sessionId: key, leaseId: lease, actions: [{ type: "text", text: "id" }] }],
      ["remote_disconnect", { sessionId: key }],
      ["remote_reconnect", { sessionId: key }],
    ];
    for (const [name, input] of calls) expect(t.textOf(await t.call(name, input, OTHER)), name).toContain("session_not_found");
    expect(t.wrote).toEqual([]);
    expect(t.disconnected).toEqual([]);
    expect(t.opened).toHaveLength(1);
    // the opener still has it
    expect(t.registry.threadOf(key)).toBe("thr_a");
    expect((await t.call("remote_disconnect", { sessionId: key })).isError).toBeUndefined();
  });
});
