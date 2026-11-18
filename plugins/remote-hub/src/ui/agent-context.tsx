// What the live widgets may ask the host about the agent that holds a session: which thread it is and how to show that
// thread's title. Host-free: the app provides the two functions (the title comes from BB's own ThreadTitle component, the
// thread id from the service's record of the lease). Without a provider the overlay simply shows no title.
import { createContext, useContext, type ReactNode } from "react";
import type { SessionHandle } from "../core/rpc.ts";

export interface AgentContextValue {
  /** The thread that holds the session's lease, from the service record; null when unknown. */
  leaseThread: (handle: SessionHandle) => Promise<string | null>;
  /** BB's title of that thread. */
  renderThreadTitle: (threadId: string) => ReactNode;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export const AgentContextProvider = AgentContext.Provider;
export const useAgentContext = (): AgentContextValue | null => useContext(AgentContext);
