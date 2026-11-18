// Remote Hub — BB frontend entry.
//
// Compiled by bb plugin build into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time, so this
// file must be loaded by BB, not imported directly.
import "./app.css";
import { useCallback, useMemo, useRef } from "react";
import { definePluginApp, experimental_useAppPanel, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { SessionHandle } from "./src/core/rpc.ts";
import { RemoteHubPage } from "./src/ui/remote-hub-page.tsx";
import { ConnectPage } from "./src/ui/connect-page.tsx";
import { createConnectBridge } from "./src/ui/rpc-bridge.ts";
import { AgentBanner, type AgentBannerApi } from "./src/ui/agent-banner.tsx";
import { LiveSession, parseSessionKey, type LiveSessionApi } from "./src/ui/live-session.tsx";
import { LIVE_TAB_ID, revealSession } from "./src/ui/reveal.ts";

/** The plugin's realtime channel: "an agent did something" (identifiers only). Same string as AGENT_SIGNAL_CHANNEL on the server. */
const AGENT_CHANNEL = "remote-hub.agents";
const attachUrl = (): string => (typeof window !== "undefined" ? (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host : "") + "/api/v1/plugins/makosh-remote-hub/http/attach";

/** What a live view needs from the server, as the owner's RPC calls. */
function useLiveApi(): LiveSessionApi {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo<LiveSessionApi>(
    () => ({
      find: async (h) => {
        const all = (await rpc.call("session_list")) as Array<{ generation: string; sessionId: number; kind: "echo" | "ssh" | "rdp"; state: "connecting" | "running" | "closed" }>;
        return all.find((x) => x.generation === h.generation && x.sessionId === h.sessionId) ?? null;
      },
      attach: async (h) => ({ token: ((await rpc.call("session_attach", { generation: h.generation, sessionId: h.sessionId })) as { token: string }).token, wsUrl: attachUrl() }),
      takeover: (h) => rpc.call("agent_control_takeover", { generation: h.generation, sessionId: h.sessionId }),
    }),
    [rpc],
  );
}

/** `::remote-session{id="…"}` in an agent's reply: the live session, inline. The id is untrusted text; LiveSession validates it. */
function RemoteSessionDirective({ attributes }: { attributes: Readonly<Record<string, string>> }) {
  const api = useLiveApi();
  return <LiveSession sessionKey={attributes.id ?? ""} api={api} />;
}

/** The side-panel tab the overlay opens when an agent starts acting. */
function LiveTab({ params }: { params: unknown }) {
  const api = useLiveApi();
  const id = typeof params === "object" && params !== null && typeof (params as { sessionId?: unknown }).sessionId === "string" ? (params as { sessionId: string }).sessionId : "";
  return <LiveSession sessionKey={id} api={api} />;
}

/** App-wide: a standing notice while an agent is active, and a best-effort opening of its live view. */
function AgentBannerOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const listeners = useRef(new Set<() => void>());
  const revealed = useRef(new Set<string>());
  useRealtime(AGENT_CHANNEL, (payload) => {
    // Only the session id is read, to try to show it; what the agent did is never in the signal.
    const id = typeof payload === "object" && payload !== null ? (payload as { sessionId?: unknown }).sessionId : undefined;
    if (typeof id === "string" && parseSessionKey(id) !== null) revealSession(panel, id, revealed.current);
    for (const l of listeners.current) l();
  });
  const api = useMemo<AgentBannerApi>(
    () => ({
      sessions: () => rpc.call("agent_sessions", {}) as ReturnType<AgentBannerApi["sessions"]>,
      takeover: (h) => rpc.call("agent_control_takeover", { generation: h.generation, sessionId: h.sessionId }),
      watch: (key) => {
        // The tab if BB can open it here, else the plugin's page on that session.
        if (!revealSession(panel, key, new Set())) navigate.toPluginPanel("ssh", { subPath: key });
      },
      subscribe: (cb) => {
        listeners.current.add(cb);
        return () => void listeners.current.delete(cb);
      },
    }),
    [rpc, navigate, panel],
  );
  return <AgentBanner api={api} />;
}


function RemoteHubTab() {
  const rpc = useRpc<typeof rpcContract>();

  const loadStatus = useCallback(() => rpc.call("helper_status"), [rpc]);

  const onOpen = useCallback(async () => {
    const handle = await rpc.call("echo_open", { cols: 80, rows: 24 });
    return handle as SessionHandle;
  }, [rpc]);

  const onInput = useCallback(
    async (handle: SessionHandle, data: string) => rpc.call("echo_input", { generation: handle.generation, sessionId: handle.sessionId, data }),
    [rpc],
  );

  const onClose = useCallback(
    async (handle: SessionHandle) => {
      await rpc.call("echo_close", { generation: handle.generation, sessionId: handle.sessionId });
    },
    [rpc],
  );

  return <RemoteHubPage loadStatus={loadStatus} onOpen={onOpen} onInput={onInput} onClose={onClose} />;
}

function ConnectTab({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const liveApi = useLiveApi();
  // A deep link to a session (the banner's Watch button): its live view above the page.
  const watched = (() => {
    try {
      return parseSessionKey(decodeURIComponent(subPath));
    } catch {
      return null;
    }
  })();
  const wsUrl = (typeof window !== "undefined" ? (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host : "") + "/api/v1/plugins/makosh-remote-hub/http/attach";
  // The bridge strips undefined-valued keys (BB's RPC carries JSON values only).
  const bridge = useMemo(
    () => createConnectBridge((method, input) => (rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...(input === undefined ? [] : [input])), wsUrl),
    [rpc, wsUrl],
  );
  return (
    <>
      {watched !== null && <LiveSession sessionKey={`${watched.generation}.${watched.sessionId}`} api={liveApi} />}
      <ConnectPage profiles={bridge.profiles} credentials={bridge.credentials} imports={bridge.imports} agents={bridge.agents} live={liveApi} ssh={bridge.ssh} rdp={bridge.rdp} />
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "remote-hub",
    title: "Remote Hub",
    icon: "Terminal",
    path: "remote-hub",
    component: RemoteHubTab,
  });
  app.slots.messageDirective({ id: "remote-session", component: RemoteSessionDirective });
  app.slots.experimental_appOverlay({ id: "remote-hub-agent-banner", component: AgentBannerOverlay });
  app.slots.experimental_tab({
    id: LIVE_TAB_ID,
    title: "Remote session",
    icon: "Terminal",
    context: { kind: "thread" },
    availability: "action",
    component: LiveTab,
  });
  app.slots.navPanel({
    id: "remote-hub-ssh",
    title: "SSH / RDP",
    icon: "Terminal",
    path: "ssh",
    component: ConnectTab,
  });
});
