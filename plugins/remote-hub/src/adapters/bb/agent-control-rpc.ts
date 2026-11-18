// The owner's side of agent control (stage 4b-1), as RPC handlers for the Remote Hub page: take a session back at once,
// see which sessions agents opened or hold and what waits for the owner's answer, and answer a host-key or login
// question. These are the owner's acts, so each is written to the audit as "owner RPC"; an answer's text is never
// recorded (it may be a one-time code).
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import type { AgentAudit } from "../../core/agent-audit.ts";
import type { AgentSessionRegistry } from "../../core/agent-control-tools.ts";
import type { ControlLeases } from "../../core/control-lease.ts";
import type { RpcSchemas } from "../../core/rpc.ts";
import type { z } from "zod";
import { OWNER_RPC } from "./rpc-handlers.ts";
import type { RemoteHubService } from "./service.ts";

type Handler<K extends keyof RpcSchemas> = (input: z.output<RpcSchemas[K]["input"]>) => Promise<z.input<RpcSchemas[K]["output"]>>;
export interface AgentControlRpc {
  agent_control_takeover: Handler<"agent_control_takeover">;
  agent_sessions: Handler<"agent_sessions">;
  agent_prompt_answer: Handler<"agent_prompt_answer">;
}

export interface AgentControlRpcDeps {
  service: RemoteHubService;
  leases: ControlLeases;
  registry: AgentSessionRegistry;
  audit: AgentAudit;
}

const keyOf = (h: { generation: string; sessionId: number }): string => `${h.generation}.${h.sessionId}`;

export function createAgentControlRpc({ service, leases, registry, audit }: AgentControlRpcDeps): AgentControlRpc {
  return {
    agent_control_takeover: async (handle) => {
      const key = keyOf(handle);
      const owner = leases.owner(key);
      if (owner.kind === "human") return { tookOver: false };
      const ticket = audit.begin({ threadId: OWNER_RPC, projectId: "", tool: "control.takeover", sessionKey: key, detail: `from ${owner.threadId}` });
      leases.takeover(key);
      ticket.finish("ok");
      return { tookOver: true };
    },
    agent_sessions: async () => {
      const all = service.sessionList();
      const present = new Set(all.map((s) => `${s.generation}.${s.sessionId}`));
      for (const key of registry.keys()) if (!present.has(key)) registry.forget(key);
      const out: Awaited<ReturnType<AgentControlRpc["agent_sessions"]>> = [];
      for (const s of all) {
        const key = keyOf(s);
        const owner = leases.owner(key);
        const openedByThread = registry.threadOf(key) ?? null;
        if (openedByThread === null && owner.kind === "human") continue;
        out.push({
          generation: s.generation,
          sessionId: s.sessionId,
          kind: s.kind,
          connectionId: s.profileId ?? null,
          state: s.state,
          openedByThread,
          openedByArchivedThread: openedByThread !== null && registry.isArchived(openedByThread),
          controlledBy: owner.kind,
          leaseThreadId: owner.kind === "agent" ? owner.threadId : null,
          leaseExpiresAt: owner.kind === "agent" ? owner.expiresAt : null,
          questions: service
            .sshPendingPrompts(s)
            .map((p) => ({ kind: p.kind === "confirm" ? ("host_key" as const) : ("login_prompt" as const), promptId: p.promptId, text: p.text })),
          certificate: s.rdp?.prompt ?? null,
        });
      }
      return out;
    },
    agent_prompt_answer: async (input) => {
      const key = keyOf(input);
      const ticket = audit.begin({ threadId: OWNER_RPC, projectId: "", tool: "prompt.answer", sessionKey: key, detail: input.answer === null ? "cancelled" : "answered" });
      try {
        await service.sshPromptAnswer({ generation: input.generation, sessionId: input.sessionId }, input.promptId, input.answer);
        ticket.finish("ok");
        return { answered: true as const };
      } catch {
        ticket.finish("prompt_gone");
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: "prompt_gone: that question is no longer open" });
      }
    },
  };
}
