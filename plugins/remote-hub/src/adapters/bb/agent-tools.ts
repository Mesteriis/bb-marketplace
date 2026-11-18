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

export function agentPorts(service: RemoteHubService, profiles: ProfileBook): AgentToolPorts {
  return {
    profiles: { list: () => profiles.list(), get: (id) => profiles.get(id) },
    sessions: {
      list: () =>
        service.sessionList().map(
          (s): AgentSessionView => ({
            key: `${s.generation}.${s.sessionId}`,
            kind: s.kind,
            state: s.state,
            ...(s.profileId === undefined ? {} : { profileId: s.profileId }),
            exitCode: s.exitCode,
            reason: s.reason,
            ...(s.rdp === undefined ? {} : { rdp: { state: s.rdp.state, desktop: s.rdp.desktop } }),
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
