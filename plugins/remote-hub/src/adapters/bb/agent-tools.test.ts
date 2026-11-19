import { describe, expect, it } from "vitest";
import { agentMayUse, agentPorts } from "./agent-tools.ts";

const GEN = "0123456789abcdef0123456789abcdef";
const session = (sessionId: number, kind: string, pve?: { console: "node" | "lxc" | "qemu" }) => ({
  generation: GEN, sessionId, kind, state: "running", exitCode: null, signal: null, reason: null, profileId: "p1",
  ...(pve === undefined ? {} : { pve: { profileId: "p1", connectionName: "lab", console: pve.console, node: "pve1", vmid: 101, guestName: null, state: "active", reason: null } }),
});

describe("what an agent may see of a Proxmox console", () => {
  const sessions = [session(1, "ssh"), session(2, "pve", { console: "node" }), session(3, "pve", { console: "lxc" }), session(4, "pve", { console: "lxc" }), session(5, "vnc", { console: "qemu" })];
  const service = { sessionList: () => sessions, agentControl: () => "ready" } as never;
  const keys = (opened: string[]) => agentPorts(service, { list: () => [], get: () => null } as never, (k) => opened.includes(k)).sessions.list().map((s) => s.key.split(".")[1]);

  it("never a node shell, whoever opened it; a container console only when an agent opened it; graphics are listed (no input anyway)", () => {
    expect(keys([])).toEqual(["1", "5"]);
    expect(keys([`${GEN}.3`])).toEqual(["1", "3", "5"]);
    // an agent "opening" a node shell is not a thing that exists, but if a registry ever said so it would still be hidden
    expect(keys([`${GEN}.2`])).toEqual(["1", "5"]);
  });

  it("the rule alone", () => {
    expect(agentMayUse({ kind: "pve", pve: { console: "node" } }, () => true, "k")).toBe(false);
    expect(agentMayUse({ kind: "pve", pve: { console: "lxc" } }, () => false, "k")).toBe(false);
    expect(agentMayUse({ kind: "pve", pve: { console: "lxc" } }, () => true, "k")).toBe(true);
    expect(agentMayUse({ kind: "ssh" }, () => false, "k")).toBe(true);
  });
});
