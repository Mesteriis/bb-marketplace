// Remote Hub — BB frontend entry.
//
// Compiled by bb plugin build into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time, so this
// file must be loaded by BB, not imported directly.
import "./app.css";
import { RemoteEmbedOverlay } from "./src/adapters/bb/embed-overlay.tsx";
import { DocumentRefs, type RemoteEmbedApi } from "./src/adapters/bb/embed-owner.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ThreadTitle, definePluginApp, experimental_useAppPanel, useBbContext, useBbNavigate, useRealtime, useRpc, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { HubPage } from "./src/ui/hub-page.tsx";
import { HubSidebarConnected } from "./src/ui/sidebar/hub-sidebar-connected.tsx";
import type { PveConsoleLaunch } from "./src/ui/pve-consoles.tsx";
import { createConnectBridge } from "./src/ui/rpc-bridge.ts";
import { AgentBanner, type AgentBannerApi } from "./src/ui/agent-banner.tsx";
import { LiveSession, parseSessionKey, type LiveSessionApi } from "./src/ui/live-session.tsx";
import { SessionCard, type SessionCardApi } from "./src/ui/session-card.tsx";
import { AgentContextProvider, type AgentContextValue } from "./src/ui/agent-context.tsx";
import type { AgentSessionView } from "./src/ui/agent-panel.tsx";
import { markSessionPage, sessionPageShowing } from "./src/ui/active-surface.ts";
import { SESSION_PAGE, sessionKeysOfThread, autoSplitOnSignal, focusedThread, openWatchInSplit, splitShows, stillWhereWePutThem } from "./src/ui/split-watch.ts";
import { LIVE_TAB_ID, revealSession } from "./src/ui/reveal.ts";
import { ThreadStrip } from "./src/ui/thread-strip.tsx";
import { WatchedView } from "./src/ui/watched-view.tsx";
import { tx } from "./src/ui/i18n.ts";

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
        const all = await rpc.call("session_list");
        return all.find((x) => x.generation === h.generation && x.sessionId === h.sessionId) ?? null;
      },
      attach: async (h, liveKind) => {
        const { token } = await rpc.call("session_attach", { generation: h.generation, sessionId: h.sessionId, ...(liveKind && { liveKind }) });
        return { token, wsUrl: attachUrl() };
      },
      takeover: (h) => rpc.call("agent_control_takeover", { generation: h.generation, sessionId: h.sessionId }),
      openRemoteHub: (h) => navigate.toPluginPanel(SESSION_PAGE, { subPath: `${h.generation}.${h.sessionId}` }),
    }),
    [rpc, navigate],
  );
}

// A reload deliberately loses the private mapping from layout UUIDs to live handles.
const embedRefs = new DocumentRefs();
function RemoteEmbedSlot() {
  const live = useLiveApi();
  const rpc = useRpc<typeof rpcContract>();
  const current = useRef({ live, rpc });
  current.current = { live, rpc };
  const api = useMemo<RemoteEmbedApi>(() => ({
    list: () => current.current.rpc.call("session_list"),
    resourceRef: async (handle, liveKind) => (await current.current.rpc.call("session_resource_ref", { ...handle, liveKind })).resourceRef,
    attach: (handle, kind) => current.current.live.attach(handle, kind),
    close: h => current.current.rpc.call("session_close", h),
    takeover: h => current.current.live.takeover(h),
  }), []);
  return <WithAgentContext><RemoteEmbedOverlay api={api} refs={embedRefs} /></WithAgentContext>;
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


/** The page's and the sidebar's RPC calls. The bridge strips undefined-valued keys (BB's RPC carries JSON values only). */
function useBridge() {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(() => createConnectBridge((method, input) => (rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...(input === undefined ? [] : [input])), attachUrl()), [rpc]);
}

/** BB's sidebar while the Remote Hub page is open: the connections and the open sessions instead of the thread list. */
function HubSidebarSlot() {
  const bridge = useBridge();
  return <HubSidebarConnected profiles={bridge.profiles} pve={bridge.pve} allow={bridge.credentials.allow} />;
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
  // A graphics console an agent opened is viewed here, on the Remote Hub page: its single active view.
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
  const bridge = useBridge();
  const navigate = useBbNavigate();
  // A session an agent works on fills the page (its thread sits in the split beside it); a graphics console goes to the desk.
  const focused = watchedKey !== null && adopt === undefined;
  return (
    <WithAgentContext>
      {focused && <WatchedView sessionKey={watchedKey} api={liveApi} onBack={() => navigate.toPluginPanel(SESSION_PAGE)} />}
      <div className={focused ? "hidden" : "h-full"}>
      <HubPage profiles={bridge.profiles} credentials={bridge.credentials} imports={bridge.imports} agents={bridge.agents} pve={bridge.pve} pveConsoles={bridge.pveConsoles} {...(adopt !== undefined ? { adoptConsole: adopt } : {})} ssh={bridge.ssh} rdp={bridge.rdp} />
      </div>
    </WithAgentContext>
  );
}

/** The open sessions the thread's agent works on; refreshed when an agent does something. */
function useThreadSessionKeys(threadId: string): string[] {
  const rpc = useRpc<typeof rpcContract>();
  const [keys, setKeys] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  useRealtime(AGENT_CHANNEL, () => setTick((n) => n + 1));
  useEffect(() => {
    let cancelled = false;
    (rpc.call("agent_sessions", {}) as Promise<AgentSessionView[]>).then(
      (all) => !cancelled && setKeys(sessionKeysOfThread(all, threadId)),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, tick]);
  return keys;
}

/** Above the thread's composer: "Remote Hub: N" while the thread's agent has sessions open; a click shows the first. */
function ThreadStripSlot({ threadId }: { threadId: string }) {
  const keys = useThreadSessionKeys(threadId);
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  return (
    <ThreadStrip
      count={keys.length}
      onOpen={() => {
        const key = keys[0];
        if (key !== undefined && !revealSession(panel, key, new Set())) navigate.toPluginPanel(SESSION_PAGE, { subPath: key });
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "remote-hub-sessions",
    title: tx("strip.title"),
    group: "5_remote_hub",
    summary: ThreadStripSlot,
    useVisible: ({ threadId }) => useThreadSessionKeys(threadId).length > 0,
  });
  app.slots.messageDirective({ id: "remote-session", component: RemoteSessionDirective });
  app.slots.experimental_appOverlay({ id: "remote-hub-agent-banner", component: AgentBannerOverlay });
  app.slots.experimental_appOverlay({ id: "remote-hub-embed", component: RemoteEmbedSlot });
  app.slots.experimental_tab({
    id: LIVE_TAB_ID,
    title: "Remote Hub",
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
    experimental_sidebar: HubSidebarSlot,
  });
});
