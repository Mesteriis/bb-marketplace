import { describe, expect, it } from "vitest";
import { AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import { ControlLeases } from "../../core/control-lease.ts";
import { WatcherBook } from "../../core/watchers.ts";
import { AGENT_SIGNAL_CHANNEL, publishAgentSignals } from "./agent-signals.ts";

const GEN = "a".repeat(32);

function setup() {
  let now = 1_000_000;
  const leases = new ControlLeases({ now: () => now, newId: () => "lease-secret-1" });
  const watchers = new WatcherBook({ now: () => now });
  const registry = new AgentSessionRegistry();
  const published: Array<{ channel: string; payload: unknown }> = [];
  publishAgentSignals({ realtime: { publish: (channel, payload) => void published.push({ channel, payload }) } }, { leases, watchers, registry });
  return { leases, watchers, registry, published, advance: (ms: number) => void (now += ms) };
}

describe("realtime signals: the owner's pages learn that an agent is active, without being told what it does", () => {
  it("announces an agent opening a session, taking and ending control, and a view starting or stopping to watch", () => {
    const t = setup();
    const key = `${GEN}.1`;
    t.registry.mark(key, "thr_agent_private_name");
    t.leases.acquire(key, "thr_agent_private_name", 60);
    t.watchers.beat(key, "v", true);
    t.watchers.remove("v");
    t.leases.takeover(key);
    expect(t.published.map((p) => (p.payload as { change: string }).change)).toEqual(["opened", "lease", "watch", "watch", "lease"]);
    for (const p of t.published) {
      expect(p.channel).toBe(AGENT_SIGNAL_CHANNEL);
      expect((p.payload as { sessionId: string }).sessionId).toBe(key);
    }
  });

  it("carries identifiers only: no thread id, lease id, command or text", () => {
    const t = setup();
    const key = `${GEN}.2`;
    t.registry.mark(key, "thr_agent_private_name");
    t.leases.acquire(key, "thr_agent_private_name", 60);
    const wire = JSON.stringify(t.published);
    expect(wire).not.toContain("thr_agent_private_name");
    expect(wire).not.toContain("lease-secret-1");
    for (const p of t.published) expect(Object.keys(p.payload as object).sort()).toEqual(["change", "sessionId"]);
  });
});
