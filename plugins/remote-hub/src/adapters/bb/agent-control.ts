// Connects the control tools (core/agent-control-tools.ts) and the owner's view of them to the service (stage 4b-1).
// Thin on purpose: the rules (lease, access, queue, typed input) live in the core; this file turns a session key into a
// handle, opens a saved connection the way the page does, and keeps leases from outliving their sessions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ToolError } from "../../core/agent-tools.ts";
import type { AgentControlPorts, AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import { profileToSshTarget } from "../../core/catalogue.ts";
import type { ControlLeases } from "../../core/control-lease.ts";
import type { Profile } from "../../core/profile.ts";
import type { RpcHandlers } from "./rpc-handlers.ts";
import type { ControlGate, ControlView, RemoteHubService } from "./service.ts";

const DEFAULT_RDP_PORT = 3389;

function handleOf(key: string): { generation: string; sessionId: number } {
  const m = /^([0-9a-f]{32})\.(\d{1,10})$/.exec(key);
  if (m === null) throw new Error("bad session id");
  return { generation: m[1] as string, sessionId: Number(m[2]) };
}
const keyOf = (h: { generation: string; sessionId: number }): string => `${h.generation}.${h.sessionId}`;

/** The service's view of the leases: whether the human may type, who drives, and a push when that changes. */
export function createControlGate(leases: ControlLeases): ControlGate {
  const views = (h: { generation: string; sessionId: number }): ControlView => {
    const owner = leases.owner(keyOf(h));
    return owner.kind === "human" ? { owner: "human", expiresAt: null } : { owner: "agent", expiresAt: owner.expiresAt };
  };
  const subscribers = new Map<string, Set<(view: ControlView) => void>>();
  leases.onChange((key) => {
    const set = subscribers.get(key);
    if (set === undefined) return;
    const view = views(handleOf(key));
    for (const cb of [...set]) cb(view);
  });
  return {
    humanMayDrive: (h) => leases.owner(keyOf(h)).kind === "human",
    state: views,
    subscribe: (h, cb) => {
      const key = keyOf(h);
      let set = subscribers.get(key);
      if (set === undefined) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0 && subscribers.get(key) === set) subscribers.delete(key);
      };
    },
  };
}

export interface AgentControlPortDeps {
  service: RemoteHubService;
  profiles: { get(id: string): Profile | null };
  /** The same handlers the page uses: they check that the saved credential belongs to this endpoint. */
  handlers: Pick<RpcHandlers, "ssh_open" | "rdp_open">;
}

export function agentControlPorts({ service, profiles, handlers }: AgentControlPortDeps): AgentControlPorts {
  return {
    terminalWrite: async (key, data) => service.agentTerminalInput(handleOf(key), data),
    rdpWrite: async (key, events) => service.agentRdpInput(handleOf(key), events),
    async connect(profileId) {
      const p = profiles.get(profileId);
      if (p === null || p.credentialRef === null) throw new ToolError("connection_incomplete", "this connection cannot be opened by an agent");
      try {
        if (p.protocol === "ssh") {
          const h = await handlers.ssh_open({ target: profileToSshTarget(p), cols: 120, rows: 32, profileId: p.id, credentialRef: p.credentialRef });
          return { sessionKey: keyOf(h) };
        }
        if (p.username === null || p.username === "") throw new ToolError("connection_incomplete", "this connection has no user name saved");
        const h = await handlers.rdp_open({
          target: { host: p.host, port: p.port ?? DEFAULT_RDP_PORT, username: p.username, domain: p.domain ?? undefined, credentialRef: p.credentialRef },
          width: p.rdpWidth ?? 1280,
          height: p.rdpHeight ?? 800,
          profileId: p.id,
        });
        return { sessionKey: keyOf(h) };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("connect_failed", error instanceof Error ? error.message : "the connection could not be opened");
      }
    },
    disconnect: async (key) => void (await service.sessionClose(handleOf(key))),
    waitingForOwner: (key) => service.ownerQuestions(handleOf(key)),
  };
}

/** Ends leases whose time is up and those of sessions that are closed or gone. Run on a timer. */
export function sweepControl(leases: ControlLeases, service: Pick<RemoteHubService, "sessionList">): void {
  leases.sweep();
  const live = new Set(service.sessionList().filter((s) => s.state !== "closed").map((s) => keyOf(s)));
  leases.endWhere((key) => !live.has(key), "session_closed");
}

export interface ControlLifecycleDeps {
  leases: ControlLeases;
  registry: AgentSessionRegistry;
  service: Pick<RemoteHubService, "sessionList">;
  /** Closes a session by key (the owner's close path). */
  closeSession: (sessionKey: string) => Promise<void>;
  everyMs?: number;
}

/**
 * A thread that is deleted stops driving anything and the sessions it opened are CLOSED (a session nobody owns must not
 * stay connected). An archived thread loses its leases but its sessions stay open, remembered as an archived thread's, so
 * the owner can see and disconnect them. A timer ends leases whose time is up or whose session is gone; it stops on dispose.
 */
export function registerControlLifecycle(bb: BbPluginApi, deps: ControlLifecycleDeps): void {
  const { leases, registry, service, closeSession } = deps;
  bb.events.on("thread.deleted", ({ thread }) => {
    leases.endForThread(thread.id, "thread_gone");
    for (const key of registry.keysOf(thread.id)) {
      registry.forget(key);
      void closeSession(key).catch(() => undefined);
    }
  });
  bb.events.on("thread.archived", ({ thread }) => {
    leases.endForThread(thread.id, "thread_gone");
    registry.markArchived(thread.id);
  });
  const timer = setInterval(() => sweepControl(leases, service), deps.everyMs ?? 5000);
  timer.unref?.();
  bb.onDispose(() => clearInterval(timer));
}
