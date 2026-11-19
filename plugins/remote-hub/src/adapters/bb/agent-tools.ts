// Connects the agent tools (core/agent-tools.ts) to the service, the profile book and BB's tool registry. Thin: the
// rules live in the core. A session id for an agent is `<generation>.<sessionId>`.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AgentSessionView, AgentToolDef, AgentToolPorts } from "../../core/agent-tools.ts";
import type { ProfileBook } from "../../core/profile-book.ts";
import { fitScreenshot } from "./png-downscale.ts";
import type { RemoteHubService } from "./service.ts";

function parseKey(key: string): { generation: string; sessionId: number } | null {
  const m = /^([0-9a-f]{32})\.(\d{1,10})$/.exec(key);
  return m === null ? null : { generation: m[1] as string, sessionId: Number(m[2]) };
}

/**
 * What an agent may see of a Proxmox console. A node shell never (a shell on the hypervisor: PVE logs the user in without a
 * prompt, or the owner types a password at its prompt). A container console only if an agent opened it itself: one the owner
 * opened by hand may have a password typed into it. Such sessions are not in the list at all, so every tool answers for them
 * exactly as for a session that does not exist.
 */
export function agentMayUse(s: { kind: string; pve?: { console: string } | undefined }, openedBy: (key: string) => string | undefined, key: string, threadId: string | null): boolean {
  if (threadId === null) return true;
  // A session another agent thread opened is not this thread's to see, read, drive or close: it answers as a missing one.
  const owner = openedBy(key);
  if (owner !== undefined && owner !== threadId) return false;
  if (s.kind !== "pve") return true;
  if (s.pve?.console !== "lxc") return false;
  return openedBy(key) === threadId;
}

export function agentPorts(service: RemoteHubService, profiles: ProfileBook, openedBy: (key: string) => string | undefined = () => undefined): AgentToolPorts {
  return {
    profiles: { list: () => profiles.list(), get: (id) => profiles.get(id) },
    sessions: {
      list: (threadId) =>
        service.sessionList().filter((s) => agentMayUse(s, openedBy, `${s.generation}.${s.sessionId}`, threadId)).map(
          (s): AgentSessionView => ({
            key: `${s.generation}.${s.sessionId}`,
            kind: s.kind,
            state: s.state,
            ...(s.profileId === undefined ? {} : { profileId: s.profileId }),
            exitCode: s.exitCode,
            reason: s.reason,
            control: service.agentControl(s),
            ...(s.rdp === undefined ? {} : { rdp: { state: s.rdp.state, desktop: s.rdp.desktop } }),
            ...(s.pve === undefined ? {} : { pve: { console: s.pve.console, node: s.pve.node, vmid: s.pve.vmid, state: s.pve.state, reason: s.pve.reason?.text ?? null, reasonCode: s.pve.reason?.code ?? null, activeMs: s.pve.activeAt != null && s.pve.endedAt != null ? Math.max(0, s.pve.endedAt - s.pve.activeAt) : s.pve.activeAt != null ? null : 0 } }),
          }),
        ),
      read: (key, from, max) => {
        const handle = parseKey(key);
        return handle === null ? null : service.sessionRead(handle, from, max);
      },
      screenshot: async (key) => {
        const handle = parseKey(key);
        if (handle === null) throw new Error("bad session id");
        const shot = await service.rdpScreenshot(handle);
        return { png: shot.png, frameId: shot.frameId, width: shot.width, height: shot.height, timestamp: shot.timestamp };
      },
    },
    fitScreenshot,
  };
}

/** Registers the tools and offers them to every thread; each call is checked against the owner's grants. */
export function registerAgentTools(bb: BbPluginApi, tools: AgentToolDef[]): void {
  for (const tool of tools) {
    bb.agents.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // The thread and project come from the host's trusted call context, never from the arguments.
      execute: (params, ctx) => tool.execute(params, { threadId: ctx.threadId, projectId: ctx.projectId, signal: ctx.signal }),
    });
  }
  // The agent skill text is written in stage 4c; until then no skill is offered.
  bb.agents.configure(() => ({ tools: tools.map((t) => t.name), skills: [] }));
}
