// Tells the owner's open pages that an agent is active on a session (stage 4c: agents are never hidden), with the
// SDK's ephemeral realtime broadcast. The signal carries identifiers only (the session key and what kind of change):
// no thread, lease, command or text; the page asks the owner-only RPC for details. Nothing is stored.
import type { AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import type { ControlLeases } from "../../core/control-lease.ts";
import type { WatcherBook } from "../../core/watchers.ts";

export const AGENT_SIGNAL_CHANNEL = "remote-hub.agents";
export type AgentSignalChange = "opened" | "lease" | "watch";

export function publishAgentSignals(
  bb: { realtime: { publish(channel: string, payload: unknown): void } },
  deps: { leases: ControlLeases; watchers: WatcherBook; registry: AgentSessionRegistry },
): void {
  const send = (sessionId: string, change: AgentSignalChange): void => {
    try {
      bb.realtime.publish(AGENT_SIGNAL_CHANNEL, { sessionId, change });
    } catch {
      // a page that cannot be told is not a reason to fail the agent's call
    }
  };
  deps.leases.onChange((key) => send(key, "lease"));
  deps.watchers.onChange((key) => send(key, "watch"));
  deps.registry.onMark((key) => send(key, "opened"));
}
