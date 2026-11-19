// Remote Hub — BB frontend entry.
//
// Compiled by bb plugin build into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time, so this
// file must be loaded by BB, not imported directly.
import "./app.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { ThreadTitle, definePluginApp, experimental_useAppPanel, useBbContext, useBbNavigate, useRealtime, useRpc, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { ConnectPage } from "./src/ui/connect-page.tsx";
import type { PveConsoleLaunch } from "./src/ui/pve-consoles.tsx";
import { createConnectBridge } from "./src/ui/rpc-bridge.ts";
import { AgentBanner, type AgentBannerApi } from "./src/ui/agent-banner.tsx";
import { LiveSession, parseSessionKey, type LiveSessionApi } from "./src/ui/live-session.tsx";
import { SessionCard, type SessionCardApi } from "./src/ui/session-card.tsx";
import { AgentContextProvider, type AgentContextValue } from "./src/ui/agent-context.tsx";
import type { AgentSessionView } from "./src/ui/agent-panel.tsx";
import { markSessionPage, sessionPageShowing } from "./src/ui/active-surface.ts";
import { SESSION_PAGE, autoSplitOnSignal, focusedThread, openWatchInSplit, splitShows, stillWhereWePutThem } from "./src/ui/split-watch.ts";
import { LIVE_TAB_ID, revealSession } from "./src/ui/reveal.ts";

/** The plugin's realtime channel: "an agent did something" (identifiers only). Same string as AGENT_SIGNAL_CHANNEL on the server. */
const AGENT_CHANNEL = "remote-hub.agents";
const attachUrl = (): string => (typeof window !== "undefined" ? (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host : "") + "/api/v1/plugins/makosh-remote-hub/http/attach";

/** What a live view needs from the server, as the owner's RPC calls. */
function useLiveApi(): LiveSessionApi {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  return useMemo<LiveSessionApi>(
    () => ({
      find: async (h) => {
        const all = (await rpc.call("session_list")) as Array<{ generation: string; sessionId: number; kind: "echo" | "ssh" | "rdp"; state: "connecting" | "running" | "closed" }>;
        return all.find((x) => x.generation === h.generation && x.sessionId === h.sessionId) ?? null;
      },
      attach: async (h) => ({ token: ((await rpc.call("session_attach", { generation: h.generation, sessionId: h.sessionId })) as { token: string }).token, wsUrl: attachUrl() }),
      takeover: (h) => rpc.call("agent_control_takeover", { generation: h.generation, sessionId: h.sessionId }),
      openRemoteHub: (h) => navigate.toPluginPanel(SESSION_PAGE, { subPath: `${h.generation}.${h.sessionId}` }),
    }),
    [rpc, navigate],
  );
}

/** Opening a session beside its agent's thread: the live view in the main pane, the thread in a split next to it. */
function useSplitActions() {
  const navigate = useBbNavigate();
  const layout = useSidebarSplitLayout();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const context = useBbContext();
  const contextRef = useRef(context);
  contextRef.current = context;
  return useMemo(
    () => ({
      watchInSplit: (sessionKey: string, agentThread: string | null) =>
        openWatchInSplit({
          nav: navigate,
          sessionKey,
          agentThread,
          isSplit: (t) => splitShows(layoutRef.current, t),
          // Positively where we put them (the agent's thread in focus, or this session's page on screen); anything
          // unidentified (Settings, another plugin's panel, no focused thread) means nobody is dragged back.
          stillHere: () =>
            stillWhereWePutThem({ focused: focusedThread(layoutRef.current, contextRef.current.threadId), agentThread, sessionPageShowing: sessionPageShowing(sessionKey) }),
        }),
      open: (sessionKey: string) => navigate.toPluginPanel(SESSION_PAGE, { subPath: sessionKey }),
      openThread: (threadId: string) => navigate.toThread(threadId),
      layout: () => layoutRef.current,
    }),
    [navigate],
  );
}

/** `::remote-session{id="…"}` in an agent's reply: a CARD with two buttons, never a live view. The id is untrusted text. */
function RemoteSessionDirective({ attributes }: { attributes: Readonly<Record<string, string>> }) {
  const rpc = useRpc<typeof rpcContract>();
  const split = useSplitActions();
  const api = useMemo<SessionCardApi>(
    () => ({
      describe: async (h) => {
        const all = (await rpc.call("agent_sessions", {})) as AgentSessionView[];
        return all.find((x) => x.generation === h.generation && x.sessionId === h.sessionId) ?? null;
      },
      watchInSplit: split.watchInSplit,
      open: split.open,
      openThread: split.openThread,
    }),
    [rpc, split],
  );
  return <SessionCard sessionKey={attributes.id ?? ""} api={api} />;
}

/**
 * What the live widgets need to name the agent that drives a session: the thread that holds the lease (from the service's
 * own record, never from message text) and BB's title for it.
 */
function WithAgentContext({ children }: { children: React.ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const value = useMemo<AgentContextValue>(
    () => ({
      leaseThread: async (h) => {
        const all = (await rpc.call("agent_sessions", {})) as AgentSessionView[];
        return all.find((x) => x.generation === h.generation && x.sessionId === h.sessionId)?.leaseThreadId ?? null;
      },
      renderThreadTitle: (threadId) => <ThreadTitle threadId={threadId} />,
    }),
    [rpc],
  );
  return <AgentContextProvider value={value}>{children}</AgentContextProvider>;
}

/** The side-panel tab the overlay opens when an agent starts acting. */
function LiveTab({ params }: { params: unknown }) {
  const api = useLiveApi();
  const id = typeof params === "object" && params !== null && typeof (params as { sessionId?: unknown }).sessionId === "string" ? (params as { sessionId: string }).sessionId : "";
  return (
    <WithAgentContext>
      <LiveSession sessionKey={id} api={api} />
    </WithAgentContext>
  );
}

/** App-wide: a standing notice while an agent is active, and a best-effort opening of its live view. */
function AgentBannerOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const split = useSplitActions();
  const context = useBbContext();
  const contextRef = useRef(context);
  contextRef.current = context;
  const listeners = useRef(new Set<() => void>());
  const autoDone = useRef(new Set<string>());
  useRealtime(AGENT_CHANNEL, (payload) => {
    // Only the session id is read. The owner's screen is moved ONLY when they are already looking at that agent's thread;
    // anywhere else the banner below is what tells them.
    const id = typeof payload === "object" && payload !== null ? (payload as { sessionId?: unknown }).sessionId : undefined;
    const handle = typeof id === "string" ? parseSessionKey(id) : null;
    if (typeof id === "string" && handle !== null) {
      autoSplitOnSignal({
        key: id,
        listSessions: () => rpc.call("agent_sessions", {}) as Promise<AgentSessionView[]>,
        layout: split.layout,
        contextThread: () => contextRef.current.threadId,
        done: autoDone.current,
        watchInSplit: split.watchInSplit,
      }).catch(() => undefined);
    }
    for (const l of listeners.current) l();
  });
  const api = useMemo<AgentBannerApi>(
    () => ({
      sessions: () => rpc.call("agent_sessions", {}) as ReturnType<AgentBannerApi["sessions"]>,
      takeover: (h) => rpc.call("agent_control_takeover", { generation: h.generation, sessionId: h.sessionId }),
      watch: (key) => {
        // The tab if BB can open it here, else the plugin's page on that session.
        if (!revealSession(panel, key, new Set())) navigate.toPluginPanel(SESSION_PAGE, { subPath: key });
      },
      watchInSplit: split.watchInSplit,
      openThread: split.openThread,
      subscribe: (cb) => {
        listeners.current.add(cb);
        return () => void listeners.current.delete(cb);
      },
    }),
    [rpc, navigate, panel, split],
  );
  return <AgentBanner api={api} />;
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
  // This page is on screen for that session while it is mounted (the split fallback relies on it).
  const watchedKey = watched === null ? null : `${watched.generation}.${watched.sessionId}`;
  useEffect(() => (watchedKey === null ? undefined : markSessionPage(watchedKey)), [watchedKey]);
  // A graphics console an agent opened is viewed here, on the Remote Hub page: its one view for its whole life.
  const [adopt, setAdopt] = useState<PveConsoleLaunch | undefined>(undefined);
  useEffect(() => {
    if (watchedKey === null || watched === null) return;
    let cancelled = false;
    void (async () => {
      const all = (await rpc.call("session_list")) as Array<{ generation: string; sessionId: number; kind: string; state: string; profileId?: string; pve?: { connectionName: string; console: "node" | "lxc" | "qemu"; node: string; vmid: number | null; guestName: string | null } }>;
      const s = all.find((x) => x.generation === watched.generation && x.sessionId === watched.sessionId);
      if (cancelled || s === undefined || s.kind !== "vnc" || s.state === "closed" || s.pve === undefined || s.profileId === undefined || s.pve.vmid === null) return;
      setAdopt({ nonce: watched.sessionId + 1, profileId: s.profileId, connectionName: s.pve.connectionName, request: { console: "qemu", vmid: s.pve.vmid }, title: s.pve.guestName ?? "", adopt: { handle: watched, kind: "vnc" } });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [watchedKey]);
  const wsUrl = (typeof window !== "undefined" ? (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host : "") + "/api/v1/plugins/makosh-remote-hub/http/attach";
  // The bridge strips undefined-valued keys (BB's RPC carries JSON values only).
  const bridge = useMemo(
    () => createConnectBridge((method, input) => (rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...(input === undefined ? [] : [input])), wsUrl),
    [rpc, wsUrl],
  );
  return (
    <WithAgentContext>
      {watched !== null && <LiveSession sessionKey={`${watched.generation}.${watched.sessionId}`} api={liveApi} />}
      <ConnectPage profiles={bridge.profiles} credentials={bridge.credentials} imports={bridge.imports} agents={bridge.agents} pve={bridge.pve} pveConsoles={bridge.pveConsoles} {...(adopt !== undefined ? { adoptConsole: adopt } : {})} live={liveApi} ssh={bridge.ssh} rdp={bridge.rdp} />
    </WithAgentContext>
  );
}

export default definePluginApp((app) => {
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
    title: "Remote Hub",
    icon: "Terminal",
    path: "ssh",
    component: ConnectTab,
  });
});
