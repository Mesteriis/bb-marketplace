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
  /** `opened`: session key -> the thread that opened it; `thread`: who is asking. */
  const keys = (opened: Record<string, string>, thread = "thr_a") => agentPorts(service, { list: () => [], get: () => null } as never, (k) => opened[k]).sessions.list(thread).map((s) => s.key.split(".")[1]);

  it("never a node shell, whoever opened it; a container console only when an agent opened it; graphics are listed (no input anyway)", () => {
    expect(keys({})).toEqual(["1", "5"]);
    expect(keys({ [`${GEN}.3`]: "thr_a" })).toEqual(["1", "3", "5"]);
    // an agent "opening" a node shell is not a thing that exists, but if a registry ever said so it would still be hidden
    expect(keys({ [`${GEN}.2`]: "thr_a" })).toEqual(["1", "5"]);
  });

  it("a console another thread opened answers as a missing session, for every kind; the opener and the owner's bookkeeping still see it", () => {
    const opened: Record<string, string> = { [`${GEN}.3`]: "thr_a", [`${GEN}.4`]: "thr_b", [`${GEN}.5`]: "thr_b", [`${GEN}.1`]: "thr_b" };
    expect(keys(opened, "thr_a")).toEqual(["3"]);
    expect(keys(opened, "thr_b")).toEqual(["1", "4", "5"]);
    expect(keys(opened, "thr_c")).toEqual([]);
    const all = agentPorts(service, { list: () => [], get: () => null } as never, (k) => opened[k]).sessions.list(null).map((s) => s.key.split(".")[1]);
    expect(all).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("the view says how long an ended console was active: 0 when it never was, null while it still is", () => {
    const withTimes = (activeAt: number | null, endedAt: number | null) => {
      const row = session(3, "pve", { console: "lxc" }) as { pve: Record<string, unknown> };
      row.pve.activeAt = activeAt;
      row.pve.endedAt = endedAt;
      return agentPorts({ sessionList: () => [row], agentControl: () => "ready" } as never, { list: () => [], get: () => null } as never, () => "thr_a").sessions.list("thr_a")[0]!.pve!.activeMs;
    };
    expect(withTimes(1000, 13_000)).toBe(12_000);
    expect(withTimes(null, 5000)).toBe(0);
    expect(withTimes(1000, null)).toBeNull();
  });

  it("the rule alone", () => {
    const by = (t: string | undefined) => () => t;
    expect(agentMayUse({ kind: "pve", pve: { console: "node" } }, by("thr_a"), "k", "thr_a")).toBe(false);
    expect(agentMayUse({ kind: "pve", pve: { console: "lxc" } }, by(undefined), "k", "thr_a")).toBe(false);
    expect(agentMayUse({ kind: "pve", pve: { console: "lxc" } }, by("thr_a"), "k", "thr_a")).toBe(true);
    expect(agentMayUse({ kind: "pve", pve: { console: "lxc" } }, by("thr_b"), "k", "thr_a")).toBe(false);
    expect(agentMayUse({ kind: "ssh" }, by(undefined), "k", "thr_a")).toBe(true);
    expect(agentMayUse({ kind: "ssh" }, by("thr_b"), "k", "thr_a")).toBe(false);
    expect(agentMayUse({ kind: "pve", pve: { console: "node" } }, by(undefined), "k", null)).toBe(true);
  });
});
