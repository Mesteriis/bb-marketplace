import { describe, expect, it } from "vitest";
import { AgentAccessBook, type AgentGrant } from "./agent-access.ts";
import { AgentAudit, type AuditRow, type AuditStore } from "./agent-audit.ts";
import { ToolBudget } from "./agent-budget.ts";
import { createPveTools } from "./agent-pve-tools.ts";
import type { ToolResult } from "./agent-tools.ts";
import type { Profile } from "./profile.ts";
import type { PveConnectionView } from "./pve-targets.ts";

const A = "11111111-2222-4333-8444-5555555555a1";
const B = "11111111-2222-4333-8444-5555555555b2";
const SSH = "11111111-2222-4333-8444-5555555555c3";
const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const CTX = { threadId: "thr", projectId: "prj" };

const profile = (id: string, protocol: "pve" | "ssh", name: string): Profile =>
  ({
    id, executionHostId: "local", origin: "manual", createdAt: "x", updatedAt: "x", lastOpenedAt: null, recentErrors: [],
    name, protocol, group: null, tags: [], favorite: false, color: null, host: "pve.test", port: null, username: "remotehub@pve", domain: null,
    authType: "password", identityFile: null, credentialRef: REF, rdpWidth: null, rdpHeight: null,
  }) as Profile;

const view = (profileId: string, name: string, over: Partial<PveConnectionView> = {}): PveConnectionView => ({
  profileId, profileName: name, outcome: "ok", message: null, fingerprint: null, version: "9.0.3", nodes: [{ node: "pve1", status: "online" }],
  guests: [
    { key: `${profileId}/100`, profileId, vmid: 100, name: "db", kind: "qemu", node: "pve1", status: "running", template: false, console: { available: true, reason: null }, linkedProfileId: SSH },
    { key: `${profileId}/101`, profileId, vmid: 101, name: "web", kind: "lxc", node: "pve1", status: "stopped", template: false, console: { available: false, reason: "the guest is stopped" }, linkedProfileId: null },
  ],
  fetchedAt: "2026-11-18T12:00:00.000Z", stale: null, ...over,
});

function setup(views: (ids: string[]) => PveConnectionView[]) {
  const profiles = [profile(A, "pve", "env-a"), profile(B, "pve", "env-b"), profile(SSH, "ssh", "guest")];
  const grants = new Map<string, AgentGrant>();
  const access = new AgentAccessBook({
    store: { all: () => [...grants.values()], get: (id) => grants.get(id) ?? null, put: (g) => void grants.set(g.profileId, g), remove: (id) => grants.delete(id), clear: () => { const n = grants.size; grants.clear(); return n; } },
    profiles: { has: (id) => profiles.some((p) => p.id === id) },
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  });
  const rows: AuditRow[] = [];
  let rid = 0;
  const store: AuditStore = { begin: (r) => (rows.push({ ...r, id: ++rid, outcome: null }), rid), finish: (id, o) => void (rows.find((r) => r.id === id)!.outcome = o), collapse: () => false, list: (n) => [...rows].reverse().slice(0, n), prune: () => {} };
  const asked: Array<{ profileIds: string[]; refresh: boolean }> = [];
  const tools = createPveTools({
    access,
    audit: new AgentAudit({ store, now: () => new Date("2026-11-18T12:00:00.000Z") }),
    budget: new ToolBudget({ now: () => 1_000_000 }),
    ports: { profiles: { list: () => profiles, get: (id) => profiles.find((p) => p.id === id) ?? null }, sessions: { list: () => [], read: () => null, screenshot: async () => { throw new Error("no"); } }, fitScreenshot: () => { throw new Error("no"); } },
    pve: { targets: async (o) => (asked.push(o), views(o.profileIds)) },
  });
  const tool = tools[0]!;
  const call = (input: unknown): Promise<ToolResult> => tool.execute(tool.parameters.parse(input), CTX);
  return { access, rows, call, asked, tool };
}
const textOf = (r: ToolResult) => r.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

describe("remote_pve_targets", () => {
  it("is one observe-level tool whose description starts with what it cannot do", () => {
    const { tool } = setup(() => []);
    expect(tool.name).toBe("remote_pve_targets");
    expect(tool.description.startsWith("Cannot get a saved password")).toBe(true);
    expect(() => tool.parameters.parse({ host: "x" })).toThrow();
    expect(() => tool.parameters.parse({ credentialRef: "x" })).toThrow();
  });

  it("asks only the Proxmox connections the owner allowed, never SSH ones, and lists their guests with identity and console state", async () => {
    const w = setup((ids) => ids.map((id) => view(id, id === A ? "env-a" : "env-b")));
    w.access.set(A, "observe", false);
    w.access.set(SSH, "observe", false);
    const r = JSON.parse(textOf(await w.call({})));
    expect(w.asked).toEqual([{ profileIds: [A], refresh: false }]);
    expect(r.connections).toEqual([{ connectionId: A, name: "env-a", outcome: "ok", message: null, certificateFingerprint: null, version: "9.0.3", stale: null, nodes: [{ node: "pve1", status: "online" }], guestCount: 2 }]);
    expect(r.guests[0]).toEqual({ connectionId: A, vmid: 100, name: "db", type: "qemu", node: "pve1", status: "running", template: false, console: { available: true, reason: null }, linkedConnectionId: SSH });
    expect(r.guests[1].console).toEqual({ available: false, reason: "the guest is stopped" });
  });

  it("with nothing allowed it asks nothing and returns empty lists", async () => {
    const w = setup(() => []);
    expect(JSON.parse(textOf(await w.call({})))).toEqual({ connections: [], guests: [] });
    expect(w.asked).toEqual([]);
  });

  it("reports a failing connection beside a working one, with the stale age, and never a credential", async () => {
    const w = setup((ids) => ids.map((id) => (id === A ? view(id, "env-a") : view(id, "env-b", { outcome: "unreachable", message: "The Proxmox endpoint did not answer.", stale: { ageSeconds: 90 } }))));
    w.access.set(A, "observe", false);
    w.access.set(B, "observe", false);
    const text = textOf(await w.call({}));
    const r = JSON.parse(text);
    expect(r.connections.map((c: { outcome: string }) => c.outcome)).toEqual(["ok", "unreachable"]);
    expect(r.connections[1].stale).toEqual({ ageSeconds: 90 });
    expect(text).not.toContain(REF);
  });

  it("a named connection the owner did not allow, or one that is not Proxmox, is the same denial", async () => {
    const w = setup((ids) => ids.map((id) => view(id, "x")));
    w.access.set(SSH, "observe", false);
    expect(textOf(await w.call({ connectionId: A }))).toContain("agent_access_denied");
    expect(textOf(await w.call({ connectionId: SSH }))).toContain("agent_access_denied");
    expect(w.asked).toEqual([]);
  });

  it("filters guests by the query, passes refresh through and audits the call without any secret", async () => {
    const w = setup((ids) => ids.map((id) => view(id, "env-a")));
    w.access.set(A, "observe", false);
    const r = JSON.parse(textOf(await w.call({ query: "web", refresh: true })));
    expect(r.guests.map((g: { vmid: number }) => g.vmid)).toEqual([101]);
    expect(r.connections[0].guestCount).toBe(2);
    expect(w.asked).toEqual([{ profileIds: [A], refresh: true }]);
    expect(w.rows.at(-1)).toMatchObject({ tool: "remote_pve_targets", outcome: "ok" });
  });

  it("a connection revoked while Proxmox was being read returns nothing of it", async () => {
    const w = setup((ids) => {
      w.access.set(A, "none", false);
      return ids.map((id) => view(id, "env-a"));
    });
    w.access.set(A, "observe", false);
    expect(JSON.parse(textOf(await w.call({})))).toEqual({ connections: [], guests: [] });
    expect(textOf(await (async () => { w.access.set(A, "observe", false); return w.call({ connectionId: A }); })())).toContain("agent_access_denied");
  });
});
