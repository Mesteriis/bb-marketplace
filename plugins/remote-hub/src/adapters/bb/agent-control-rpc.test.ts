// The owner's side of agent control (stage 4b-1): take a session back at once, see what agents opened and what waits
// for an answer, and answer a host-key or login question. Everything here is the owner's page talking.
import { describe, expect, it, vi } from "vitest";
import { AgentAudit, type AuditRow, type AuditStore } from "../../core/agent-audit.ts";
import { AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import { WatcherBook } from "../../core/watchers.ts";
import { ControlLeases } from "../../core/control-lease.ts";
import type { RemoteHubService, SessionInfo } from "./service.ts";
import { createAgentControlRpc } from "./agent-control-rpc.ts";

const GEN = "e".repeat(32);
const H1 = { generation: GEN, sessionId: 1 };
const H2 = { generation: GEN, sessionId: 2 };
const K1 = `${GEN}.1`;
const K2 = `${GEN}.2`;
const FP = Array.from({ length: 32 }, () => "AA").join(":");

function setup() {
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
  let n = 0;
  const leases = new ControlLeases({ now: () => 1_000_000, newId: () => "lease-" + ++n });
  const registry = new AgentSessionRegistry();
  const sessions: SessionInfo[] = [
    { generation: GEN, sessionId: 1, kind: "ssh", profileId: "11111111-2222-4333-8444-555555555551", state: "running", exitCode: null, signal: null, reason: null },
    { generation: GEN, sessionId: 2, kind: "rdp", profileId: "11111111-2222-4333-8444-555555555552", state: "connecting", exitCode: null, signal: null, reason: null,
      rdp: { target: { host: "rdp.test", port: 3389, username: "u", domain: null }, state: "cert_prompt", desktop: null, trace: [], prompt: { host: "rdp.test", port: 3389, fingerprint: FP, subject: "CN=x", issuer: "CN=x", notBefore: "a", notAfter: "b", reason: "untrusted_root", firstUse: true } } },
    { generation: GEN, sessionId: 3, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null },
  ];
  const service = {
    sessionList: () => sessions,
    ownerQuestions: (h: { sessionId: number }) => (h.sessionId === 1 ? ["host_key"] : h.sessionId === 2 ? ["certificate"] : []),
    sshPendingPrompts: (h: { sessionId: number }) => (h.sessionId === 1 ? [{ promptId: 7, text: "Are you sure you want to continue connecting (yes/no/[fingerprint])?", kind: "confirm" }] : []),
    sshPromptAnswer: vi.fn(async () => undefined),
  };
  const watchers = new WatcherBook({ now: () => 1_000_000 });
  const rpc = createAgentControlRpc({ service: service as unknown as RemoteHubService, leases, registry, audit, watchers });
  return { rpc, rows, leases, registry, service, sessions, watchers };
}

describe("agent_control_takeover", () => {
  it("ends the lease at once, says who held it, and is audited as the owner's act", async () => {
    const { rpc, rows, leases } = setup();
    leases.acquire(K1, "thr_a", 60);
    expect(await rpc.agent_control_takeover(H1)).toEqual({ tookOver: true });
    expect(leases.owner(K1).kind).toBe("human");
    expect(rows.map((r) => [r.tool, r.threadId, r.sessionKey, r.detail, r.outcome])).toEqual([["control.takeover", "owner RPC", K1, "from thr_a", "ok"]]);
  });

  it("with nothing to take it answers false and changes nothing (the page may click twice)", async () => {
    const { rpc, rows } = setup();
    expect(await rpc.agent_control_takeover(H1)).toEqual({ tookOver: false });
    expect(rows).toEqual([]);
  });
});

describe("agent_control_allow (Z5)", () => {
  it("lifts the hold a takeover set, audited, and says false when there is none", async () => {
    const { rpc, rows, leases } = setup();
    leases.acquire(K1, "thr_a", 60);
    await rpc.agent_control_takeover(H1);
    const listed = await rpc.agent_sessions({});
    expect(listed.find((s) => s.sessionId === 1)).toMatchObject({ controlledBy: "human", holdUntil: 1_300_000 });
    expect(await rpc.agent_control_allow(H1)).toEqual({ allowed: true });
    expect(leases.acquire(K1, "thr_a", 60)).toMatchObject({ ok: true });
    expect(await rpc.agent_control_allow(H2)).toEqual({ allowed: false });
    expect(rows.map((r) => [r.tool, r.threadId])).toContainEqual(["control.allow", "owner RPC"]);
  });
});

describe("agent_sessions and the live view", () => {
  it("says for each session whether a person is looking at its live view right now", async () => {
    const { rpc, leases, watchers } = setup();
    leases.acquire(K1, "thr_a", 60);
    expect((await rpc.agent_sessions({})).find((s) => s.sessionId === 1)).toMatchObject({ watching: false });
    watchers.beat(K1, "view", true);
    expect((await rpc.agent_sessions({})).find((s) => s.sessionId === 1)).toMatchObject({ watching: true });
    watchers.beat(K1, "view", false);
    expect((await rpc.agent_sessions({})).find((s) => s.sessionId === 1)).toMatchObject({ watching: false });
  });
});

describe("agent_sessions", () => {
  it("lists only sessions an agent opened or holds, with the owner, lease time and what waits", async () => {
    const { rpc, leases, registry } = setup();
    registry.mark(K2, "thr_b");
    leases.acquire(K1, "thr_a", 60);
    const list = await rpc.agent_sessions({});
    expect(list.map((s) => s.sessionId)).toEqual([1, 2]);
    expect(list[0]).toMatchObject({ generation: GEN, sessionId: 1, controlledBy: "agent", leaseThreadId: "thr_a", leaseExpiresAt: 1_060_000, openedByThread: null, questions: [{ kind: "host_key", promptId: 7 }] });
    expect(list[1]).toMatchObject({ sessionId: 2, controlledBy: "human", leaseThreadId: null, openedByThread: "thr_b", certificate: { fingerprint: FP, firstUse: true } });
    expect(list[1]!.questions).toEqual([]);
  });

  it("marks a session whose opener thread was archived", async () => {
    const { rpc, registry } = setup();
    registry.mark(K1, "thr_old");
    registry.mark(K2, "thr_live");
    registry.markArchived("thr_old");
    const list = await rpc.agent_sessions({});
    expect(list.map((s) => [s.sessionId, s.openedByArchivedThread])).toEqual([[1, true], [2, false]]);
  });

  it("is empty when no agent has opened or holds anything", async () => {
    const { rpc } = setup();
    expect(await rpc.agent_sessions({})).toEqual([]);
  });

  it("forgets sessions that have gone from the registry", async () => {
    const { rpc, registry, sessions } = setup();
    registry.mark(K1, "thr_a");
    sessions.splice(0, 1);
    expect(await rpc.agent_sessions({})).toEqual([]);
    expect(registry.keys()).toEqual([]);
  });
});

describe("agent_prompt_answer", () => {
  it("passes the owner's answer to the helper once and audits that it was answered, never what", async () => {
    const { rpc, rows, service } = setup();
    expect(await rpc.agent_prompt_answer({ ...H1, promptId: 7, answer: "yes" })).toEqual({ answered: true });
    expect(service.sshPromptAnswer).toHaveBeenCalledWith(H1, 7, "yes");
    expect(rows.map((r) => [r.tool, r.threadId, r.sessionKey, r.detail])).toEqual([["prompt.answer", "owner RPC", K1, "answered"]]);
    expect(JSON.stringify(rows)).not.toContain("yes");
  });

  it("a cancel is recorded as cancelled", async () => {
    const { rpc, rows } = setup();
    await rpc.agent_prompt_answer({ ...H1, promptId: 7, answer: null });
    expect(rows[0]!.detail).toBe("cancelled");
  });

  it("a question that is already gone is a refusal, not a crash", async () => {
    const { rpc, service } = setup();
    service.sshPromptAnswer.mockRejectedValueOnce(new Error("gone"));
    await expect(rpc.agent_prompt_answer({ ...H2, promptId: 1, answer: "yes" })).rejects.toBeDefined();
  });
});
