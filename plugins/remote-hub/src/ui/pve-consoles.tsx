// The Proxmox console tabs: a node shell or a container terminal (the same xterm view as SSH) and a virtual machine's graphics
// (noVNC), several at once. Every tab stays mounted (the inactive ones hidden), so switching tabs or re-rendering never opens a
// second upstream connection and never closes the backend session. Each tab's header shows the connection, the node (as read when
// the console was opened) or guest, its state (connecting, active, lost, reconnecting n of N, disconnected, error, not connected)
// and the concrete reason. Disconnect closes the console at once and stops any automatic attempt.
//
// Losing a terminal console without anyone's decision starts automatic reconnecting (core/pve-reconnect.ts: 5 attempts, 1-2-4-8-16 s
// with jitter); each attempt opens a NEW console. The lost console's scrollback stays on screen with a separator line, and what is
// typed while the console is not active is refused with a visible notice, never queued. A graphical console is never reattached:
// Reconnect opens a new one and says so. Tabs are remembered as targets only (no output, no secrets) and come back after a restart
// as "not connected" with a Reconnect button.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { endStateOf, reasonText, type PveConsoleState } from "../core/pve-console.ts";
import { decideReconnect, LOST_SEPARATOR, RECONNECT_ATTEMPTS, RECONNECTED_SEPARATOR, STABLE_AFTER_MS } from "../core/pve-reconnect.ts";
import type { PveConsoleTabRow, SessionHandle } from "../core/rpc.ts";
import { ControlBadge, HUMAN_CONTROL, nextControl, type ControlMessage, type ControlView } from "./control-banner.tsx";
import { AgentStage } from "./agent-overlay.tsx";
import type { PveConsoleOpened, PveConsoleRequest } from "./pve-api.ts";
import { SshTerminal, type SshExitInfo, type SshTerminalState, type TerminalApi } from "./ssh-terminal.tsx";
import { VncView } from "./vnc-view.tsx";

export interface PveConsolesApi {
  open(input: PveConsoleRequest & { profileId: string; cols: number; rows: number }): Promise<PveConsoleOpened>;
  attach(handle: SessionHandle): Promise<{ token: string; wsUrl: string }>;
  close(handle: SessionHandle): Promise<void>;
  takeover?(handle: SessionHandle): Promise<void>;
  /** Starts loading the graphical viewer now (called when a graphical console is asked for). */
  preload?(): void;
  /** Where the tab list is kept (targets only), so tabs come back after a restart as "not connected". */
  tabs?: {
    list(): Promise<PveConsoleTabRow[]>;
    put(row: PveConsoleTabRow): Promise<void>;
    remove(id: string): Promise<void>;
  };
}

/** A request to open a console; a new `nonce` is a new request. */
export interface PveConsoleLaunch {
  nonce: number;
  profileId: string;
  connectionName: string;
  request: PveConsoleRequest;
  /** The guest's name, for the tab. */
  title: string;
  /** A console that is already open (an agent opened it): the tab attaches to it instead of opening a new one. Used once. */
  adopt?: { handle: SessionHandle; kind: "pve" | "vnc" };
}

export interface PveConsolesProps {
  api: PveConsolesApi;
  launch?: PveConsoleLaunch;
  /** The connection's current name, for tabs restored without it; null when it is not known. */
  connectionName?: (profileId: string) => string | null;
}

type TabState = PveConsoleState | "opening" | "reconnecting" | "restored";

interface Tab {
  id: number;
  /** The id the tab is remembered under. */
  uid: string;
  launch: PveConsoleLaunch;
  /** The node the console was opened on (the guest may have moved since the list was read). */
  node: string | null;
  handle: SessionHandle | null;
  kind: "pve" | "vnc" | null;
  attach: { token: string; wsUrl: string } | null;
  state: TabState;
  reason: { code: string; text: string; fingerprint: string | null } | null;
  owner: ControlView;
  /** Which automatic attempt is under way or waiting (1-based); 0 outside an episode. */
  attempt: number;
  /** A lost console's scrollback, written first into the next terminal. */
  history: string;
  /** What the owner was told about input that was not sent. */
  notice: string | null;
}

const STATE_LABEL: Record<TabState, string> = {
  opening: "connecting",
  connecting: "connecting",
  active: "active",
  lost: "lost",
  reconnecting: "reconnecting",
  disconnected: "disconnected",
  error: "error",
  restored: "not connected",
};

const labelOf = (t: Tab): string => (t.state === "reconnecting" ? `reconnecting (${t.attempt} of ${RECONNECT_ATTEMPTS})` : STATE_LABEL[t.state]);

const NOT_SENT = "Not connected: what you type is not sent, and is not kept to be sent later.";
const GRAPHICS_TEXT = "A graphical console cannot be resumed. Reconnect opens a NEW console; the screen you had is not restored.";
const TERMINAL_TEXT = "Reconnect opens a NEW console. What was typed before the loss is not sent again.";
const RESTORED_TEXT = "This tab was restored after a restart. It is not connected. Reconnect opens a new console.";

const where = (t: Tab): string => {
  const r = t.launch.request;
  if (r.console === "node") return `node ${r.node}`;
  const guest = `${r.console === "qemu" ? "VM" : "container"} ${t.launch.title === "" ? "" : t.launch.title + " "}#${r.vmid}`.replace("  ", " ");
  return t.node === null ? guest : `${guest} on ${t.node}`;
};

const isGraphics = (t: Tab): boolean => (t.kind ?? (t.launch.request.console === "qemu" ? "vnc" : "pve")) === "vnc";

const uuid = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12));

const rowOf = (t: Tab): PveConsoleTabRow => {
  const r = t.launch.request;
  // A guest is remembered by its VMID alone: its node is read again at every open, so none is kept.
  return { id: t.uid, profileId: t.launch.profileId, console: r.console, node: r.console === "node" ? r.node : null, vmid: r.console === "node" ? null : r.vmid, title: t.launch.title.slice(0, 120) };
};

interface Episode {
  /** Attempts made since the loss. */
  made: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Fires when the connection held: the next loss is a fresh episode. */
  stable: ReturnType<typeof setTimeout> | null;
}

export function PveConsoles(props: PveConsolesProps) {
  const { api } = props;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const nextId = useRef(1);
  const lastNonce = useRef(0);
  // Tabs the owner closed: a console that finishes opening for one of them is closed again, never orphaned.
  const closedTabs = useRef(new Set<number>());
  const apiRef = useRef(api);
  apiRef.current = api;
  const nameRef = useRef(props.connectionName);
  nameRef.current = props.connectionName;
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const episodes = useRef(new Map<number, Episode>());
  // One counter per tab, bumped by Disconnect, Reconnect and Close tab: work that began before is stale. A console a stale open
  // produces is closed, never adopted, and a stale failure schedules nothing.
  const tokens = useRef(new Map<number, number>());
  const bump = (id: number): void => void tokens.current.set(id, (tokens.current.get(id) ?? 0) + 1);
  // What each tab's terminal showed when it was torn down (text only): the next console of that tab starts with it.
  const screens = useRef(new Map<number, string>());
  // Graphics: whether a tab's current console ever showed a screen, and which tabs already had their one automatic second try.
  const shown = useRef(new Set<number>());
  const retriedOnce = useRef(new Set<number>());
  const terminalApis = useRef(new Map<number, MutableRefObject<TerminalApi | null>>());

  const patch = useCallback((id: number, change: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t)));
  }, []);

  const episodeOf = (id: number): Episode => {
    let e = episodes.current.get(id);
    if (e === undefined) {
      e = { made: 0, timer: null, stable: null };
      episodes.current.set(id, e);
    }
    return e;
  };
  const stopEpisode = (id: number): void => {
    const e = episodes.current.get(id);
    if (e === undefined) return;
    if (e.timer !== null) clearTimeout(e.timer);
    if (e.stable !== null) clearTimeout(e.stable);
    episodes.current.delete(id);
  };
  const remember = (t: Tab): void =>
    void apiRef.current.tabs?.put(rowOf(t)).catch((e: unknown) => {
      // Never hidden: the tab works, but it will not come back after a restart, and the owner is told.
      patch(t.id, { notice: `This tab could not be remembered for after a restart: ${e instanceof Error ? e.message : String(e)}` });
    });

  /**
   * Opens (or re-opens) the console of tab `id`. `attemptNo` > 0 is an automatic attempt: a retryable failure schedules the next
   * one, anything else stops with the concrete reason. A tab closed meanwhile has its new session closed again: never orphaned.
   */
  const start = useCallback(
    async (id: number, launch: PveConsoleLaunch, attemptNo: number) => {
      const automatic = attemptNo > 0;
      if (launch.request.console === "qemu") apiRef.current.preload?.();
      const mine = tokens.current.get(id) ?? 0;
      const stale = (): boolean => (tokens.current.get(id) ?? 0) !== mine || closedTabs.current.has(id);
      const earlier = tabsRef.current.find((t) => t.id === id)?.node ?? null;
      if (automatic) patch(id, { state: "reconnecting", attempt: attemptNo, reason: null });
      else patch(id, { state: "opening", reason: null, handle: null, attach: null, kind: null, owner: HUMAN_CONTROL, attempt: 0, notice: null });
      const failed = (code: string, text: string, fingerprint: string | null): void => {
        if (stale()) return;
        const decision = automatic ? decideReconnect(attemptNo, code, Math.random()) : null;
        if (decision !== null && decision.action === "wait") {
          scheduleRef.current(id, launch, decision.attempt, decision.delayMs);
          return;
        }
        stopEpisode(id);
        const gaveUp = decision !== null && decision.why === "gave_up";
        patch(id, { state: "error", attempt: 0, reason: { code, text: gaveUp ? `Gave up after ${RECONNECT_ATTEMPTS} attempts. ${text}` : text, fingerprint } });
      };
      let opened: PveConsoleOpened;
      try {
        opened = launch.adopt !== undefined
          ? { ok: true, generation: launch.adopt.handle.generation, sessionId: launch.adopt.handle.sessionId, kind: launch.adopt.kind, node: launch.request.console === "node" ? launch.request.node : "" }
          : await apiRef.current.open({ ...launch.request, profileId: launch.profileId, cols: 80, rows: 24 });
      } catch (e) {
        failed("open_failed", e instanceof Error ? e.message : String(e), null);
        return;
      }
      if (stale()) {
        // Disconnect, Reconnect or Close tab came while this was opening: what opened is closed, not adopted.
        if (opened.ok && launch.adopt === undefined) void apiRef.current.close({ generation: opened.generation, sessionId: opened.sessionId }).catch(() => undefined);
        return;
      }
      if (!opened.ok) {
        failed(opened.code, reasonText(opened.code) === `The console ended (${opened.code}).` ? opened.message : reasonText(opened.code), opened.fingerprint);
        return;
      }
      const handle: SessionHandle = { generation: opened.generation, sessionId: opened.sessionId };
      const node = opened.node === "" ? earlier : opened.node;
      const current = tabsRef.current.find((t) => t.id === id);
      // A NEW console of a tab that showed something starts with that screen, a "lost" line and a "reconnected" line above its own
      // output (the new terminal is a new component: without this it would be blank).
      // The terminal still mounted (a Reconnect or an attempt starts before it is replaced) is read now; one already gone left its text.
      const onScreen = terminalApis.current.get(id)?.current?.text() ?? "";
      const carried = onScreen !== "" ? onScreen : (screens.current.get(id) ?? "");
      const history = carried === "" ? "" : carried + (carried.split("\r\n").at(-1)?.includes("connection lost") ? "" : LOST_SEPARATOR) + RECONNECTED_SEPARATOR;
      patch(id, { handle, kind: opened.kind, node, state: "connecting", attach: null, history });
      try {
        const attach = await apiRef.current.attach(handle);
        if (stale()) {
          if (launch.adopt === undefined) void apiRef.current.close(handle).catch(() => undefined);
          return;
        }
        patch(id, (t) => (t.handle === handle ? { attach } : {}));
      } catch (e) {
        // A console whose view could not be attached is closed: nobody would ever see it.
        if (launch.adopt === undefined) void apiRef.current.close(handle).catch(() => undefined);
        failed("attach_failed", e instanceof Error ? e.message : String(e), null);
      }
    },
    [patch],
  );

  /** Waits `delayMs`, then makes attempt `attempt` (if the tab is still waiting for it). */
  const schedule = useCallback(
    (id: number, launch: PveConsoleLaunch, attempt: number, delayMs: number) => {
      const e = episodeOf(id);
      if (e.timer !== null) clearTimeout(e.timer);
      e.made = attempt - 1;
      patch(id, { state: "reconnecting", attempt });
      const scheduled = tokens.current.get(id) ?? 0;
      e.timer = setTimeout(() => {
        e.timer = null;
        const t = tabsRef.current.find((x) => x.id === id);
        if (t === undefined || t.state !== "reconnecting" || closedTabs.current.has(id) || (tokens.current.get(id) ?? 0) !== scheduled) return;
        e.made = attempt;
        // The lost console is closed first and the close is awaited (it may still hold an engine), then a new one is opened: a
        // fresh login, the guest's node read again, a new console ticket and websocket.
        void (async () => {
          if (t.handle !== null) await apiRef.current.close(t.handle).catch(() => undefined);
          if ((tokens.current.get(id) ?? 0) !== scheduled || closedTabs.current.has(id)) return;
          await start(id, launch, attempt);
        })();
      }, delayMs);
    },
    [patch, start],
  );
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  useEffect(
    () => () => {
      for (const e of episodes.current.values()) {
        if (e.timer !== null) clearTimeout(e.timer);
        if (e.stable !== null) clearTimeout(e.stable);
      }
      episodes.current.clear();
    },
    [],
  );

  // Tabs remembered from before a restart or a reload: shown as targets that are not connected, never as live consoles.
  useEffect(() => {
    const store = apiRef.current.tabs;
    if (store === undefined) return;
    let gone = false;
    void store
      .list()
      .then((rows) => {
        if (gone || rows.length === 0) return;
        const restored: Tab[] = rows.map((row) => ({
          id: nextId.current++,
          uid: row.id,
          launch: {
            nonce: 0,
            profileId: row.profileId,
            connectionName: nameRef.current?.(row.profileId) ?? "",
            request: row.console === "node" ? { console: "node", node: row.node ?? "" } : { console: row.console, vmid: row.vmid ?? 0 },
            title: row.title,
          },
          node: row.node,
          handle: null,
          kind: null,
          attach: null,
          state: "restored",
          reason: null,
          owner: HUMAN_CONTROL,
          attempt: 0,
          history: "",
          notice: null,
        }));
        setTabs((cur) => [...restored.filter((r) => !cur.some((t) => t.uid === r.uid)), ...cur]);
        setActive((cur) => cur ?? restored[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    const launch = props.launch;
    if (launch === undefined || launch.nonce === lastNonce.current) return;
    lastNonce.current = launch.nonce;
    const id = nextId.current++;
    // Adopting is for the first attach only: Reconnect always opens a new console.
    const { adopt: _once, ...reopenable } = launch;
    const tab: Tab = { id, uid: uuid(), launch: reopenable, node: launch.request.console === "node" ? launch.request.node : null, handle: null, kind: null, attach: null, state: "opening", reason: null, owner: HUMAN_CONTROL, attempt: 0, history: "", notice: null };
    setTabs((cur) => [...cur, tab]);
    setActive(id);
    remember(tab);
    void start(id, launch, 0);
  }, [props.launch, start]);

  const closeQuietly = (handle: SessionHandle | null): void => {
    if (handle !== null) void apiRef.current.close(handle).catch(() => undefined);
  };

  const disconnect = (tab: Tab): void => {
    bump(tab.id);
    stopEpisode(tab.id);
    closeQuietly(tab.handle);
    patch(tab.id, { state: "disconnected", reason: null, attempt: 0 });
  };
  const reconnect = (tab: Tab, notice: string | null = null): void => {
    bump(tab.id);
    shown.current.delete(tab.id);
    if (notice === null) retriedOnce.current.delete(tab.id);
    stopEpisode(tab.id);
    const mine = tokens.current.get(tab.id) ?? 0;
    // Close, then open: the old console is gone before the new one starts.
    void (async () => {
      if (tab.handle !== null) await apiRef.current.close(tab.handle).catch(() => undefined);
      if ((tokens.current.get(tab.id) ?? 0) !== mine || closedTabs.current.has(tab.id)) return;
      await start(tab.id, tab.launch, 0);
      if (notice !== null) patch(tab.id, { notice });
    })();
  };
  const closeTab = (tab: Tab): void => {
    bump(tab.id);
    stopEpisode(tab.id);
    closedTabs.current.add(tab.id);
    terminalApis.current.delete(tab.id);
    closeQuietly(tab.handle);
    void apiRef.current.tabs?.remove(tab.uid).catch(() => undefined);
    setTabs((cur) => cur.filter((t) => t.id !== tab.id));
    setActive((cur) => (cur === tab.id ? (tabsRef.current.find((t) => t.id !== tab.id)?.id ?? null) : cur));
  };

  /**
   * A terminal console was lost: mark the scrollback and, when the reason is one another attempt can change, start (or
   * continue) the automatic attempts. A graphical console is only marked lost: it cannot be reattached.
   */
  const lost = (tab: Tab, code: string, final: "lost" | "error" = "lost", fingerprint: string | null = null): void => {
    const now = tabsRef.current.find((t) => t.id === tab.id);
    if (now === undefined || now.state === "disconnected" || now.state === "error" || now.state === "reconnecting" || closedTabs.current.has(tab.id)) return;
    const reason = { code, text: reasonText(code), fingerprint };
    if (isGraphics(now)) {
      patch(tab.id, { state: final, reason });
      return;
    }
    const api = terminalApis.current.get(tab.id)?.current ?? null;
    // Only a console that was live leaves a separator in the scrollback; an attempt that never became active adds nothing.
    if (api !== null && now.state === "active") api.note(LOST_SEPARATOR);
    const history = now.history;
    const e = episodeOf(tab.id);
    if (e.stable !== null) {
      clearTimeout(e.stable);
      e.stable = null;
    }
    const decision = decideReconnect(e.made, code, Math.random());
    if (decision.action === "wait") {
      patch(tab.id, { history, reason, attempt: decision.attempt, state: "reconnecting" });
      scheduleRef.current(tab.id, now.launch, decision.attempt, decision.delayMs);
    } else {
      stopEpisode(tab.id);
      patch(tab.id, { state: final, history, attempt: 0, reason: decision.why === "gave_up" ? { ...reason, text: `Gave up after ${RECONNECT_ATTEMPTS} attempts. ${reason.text}` } : reason });
    }
  };

  /** Events of a console that was replaced (Reconnect, an attempt) are ignored: only the tab's current console speaks for it. */
  const superseded = (tab: Tab): boolean => tabsRef.current.find((t) => t.id === tab.id)?.handle !== tab.handle;
  const onTerminalState = (tab: Tab) => (next: SshTerminalState, info?: SshExitInfo) => {
    if (superseded(tab)) return;
    if (next === "closed" && info !== undefined) {
      if (endStateOf(info.reason) === "disconnected") patch(tab.id, (t) => (t.state === "error" || t.state === "reconnecting" ? {} : { state: "disconnected", reason: null }));
      else lost(tab, info.reason);
    } else if (next === "detached" || next === "error") {
      lost(tab, "websocket_error");
    }
  };
  const onConsole = (tab: Tab) => (event: { state: string; reason: Tab["reason"] }) => {
    if (superseded(tab)) return;
    const state = event.state as PveConsoleState;
    const now = tabsRef.current.find((t) => t.id === tab.id);
    if (now === undefined || now.state === "disconnected" || now.state === "reconnecting") return;
    if (state === "lost" && isGraphics(now) && graphicsLostBeforeScreen(now, event.reason?.code ?? "websocket_error")) return;
    if (state === "lost") {
      lost(tab, event.reason?.code ?? "websocket_error");
      return;
    }
    // A console that fails to open during an episode of attempts goes through the same decision: another attempt or a stop.
    if (state === "error" && (episodes.current.get(tab.id)?.made ?? 0) > 0) {
      lost(tab, event.reason?.code ?? "open_failed", "error", event.reason?.fingerprint ?? null);
      return;
    }
    patch(tab.id, { state, reason: event.reason, ...(state === "active" ? { notice: null } : {}) });
    if (state === "active") {
      const e = episodes.current.get(tab.id);
      if (e !== undefined && e.stable === null) e.stable = setTimeout(() => stopEpisode(tab.id), STABLE_AFTER_MS);
    }
  };
  /**
   * A graphical console that ends before it ever showed a screen, with the other side closing it (Proxmox's VNC proxy gives up on a
   * viewer that took about ten seconds to answer): ONE automatic second try with a new console; if that fails the same way the
   * reason says so instead of "websocket error". Returns true when it handled the loss.
   */
  const graphicsLostBeforeScreen = (tab: Tab, code: string): boolean => {
    const now = tabsRef.current.find((t) => t.id === tab.id);
    if (now === undefined || shown.current.has(tab.id) || !(code === "websocket_error" || code === "remote_closed") || now.state === "disconnected" || now.state === "error") return false;
    if (!retriedOnce.current.has(tab.id)) {
      retriedOnce.current.add(tab.id);
      reconnect(now, "The graphical console was closed by Proxmox before it showed anything (its VNC proxy waits about ten seconds for the viewer). A new console was opened once, automatically.");
      return true;
    }
    patch(tab.id, { state: "lost", reason: { code: "vnc_start_timeout", text: reasonText("vnc_start_timeout"), fingerprint: null } });
    return true;
  };
  const onEnded = (tab: Tab) => (info: { code: string; text: string }) => {
    if (superseded(tab)) return;
    if ((info.code === "websocket_error" || info.code === "remote_closed") && isGraphics(tabsRef.current.find((t) => t.id === tab.id) ?? tab) && graphicsLostBeforeScreen(tab, info.code)) return;
    const state = info.code === "vnc_not_resumable" || info.code === "vnc_view_taken" || info.code === "viewer_unavailable" || info.code === "vnc_auth_failed" ? "error" : endStateOf(info.code);
    // The most specific reason seen so far is kept: a bare socket close (websocket_error) never replaces a real one.
    patch(tab.id, (t) => (t.state === "disconnected" || (t.reason !== null && (t.state === "error" || (info.code === "websocket_error" && t.state === "lost"))) ? {} : { state, reason: state === "disconnected" ? null : { code: info.code, text: info.text, fingerprint: null } }));
  };
  const onControl = (tab: Tab) => (message: ControlMessage) => {
    if (!superseded(tab)) patch(tab.id, (t) => ({ owner: nextControl(t.owner, message) }));
  };
  const apiRefFor = (id: number): MutableRefObject<TerminalApi | null> => {
    let r = terminalApis.current.get(id);
    if (r === undefined) {
      r = { current: null };
      terminalApis.current.set(id, r);
    }
    return r;
  };

  if (tabs.length === 0) return <p className="rh-hint">No Proxmox console is open. Open one from a guest or node in the Proxmox list.</p>;

  const nameOf = (t: Tab): string => (t.launch.connectionName !== "" ? t.launch.connectionName : (props.connectionName?.(t.launch.profileId) ?? "connection"));
  const canReconnect = (t: Tab): boolean => t.state === "lost" || t.state === "error" || t.state === "disconnected" || t.state === "restored";

  return (
    <section className="rh-pve-consoles" aria-label="Proxmox consoles">
      <div role="tablist" className="rh-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id} onClick={() => setActive(t.id)} data-testid="pve-console-tab">
            {nameOf(t)} · {where(t)} <span className="rh-badge">{labelOf(t)}</span>
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} hidden={active !== t.id} className="rh-pve-console" data-testid="pve-console" aria-label={`console ${where(t)}`}>
          <div className="rh-live-head">
            <strong>{nameOf(t)}</strong> · {where(t)} <span className="rh-status" data-testid="pve-console-state">{labelOf(t)}</span>
            <ControlBadge control={t.owner} />
            <button type="button" disabled={t.state === "disconnected" || t.state === "restored" || (t.handle === null && t.state !== "reconnecting")} onClick={() => disconnect(t)}>
              Disconnect
            </button>
            <button type="button" disabled={!canReconnect(t)} onClick={() => reconnect(t)}>
              Reconnect
            </button>
            <button type="button" onClick={() => closeTab(t)}>
              Close tab
            </button>
          </div>
          {t.reason !== null && (
            <p role="alert" className="rh-error" data-testid="pve-console-reason">
              {t.reason.text}
              {t.reason.fingerprint !== null && (
                <>
                  {" "}
                  Certificate fingerprint (SHA-256): <code>{t.reason.fingerprint}</code>. Confirm it in the connection first.
                </>
              )}
            </p>
          )}
          {t.state === "restored" && (
            <p className="rh-hint" data-testid="pve-console-restored">
              {RESTORED_TEXT}
            </p>
          )}
          {(t.state === "lost" || t.state === "error" || t.state === "disconnected") && (
            <p className="rh-hint" data-testid="pve-console-new-console">
              {isGraphics(t) ? GRAPHICS_TEXT : TERMINAL_TEXT}
            </p>
          )}
          {t.state === "reconnecting" && (
            <p role="status" className="rh-hint" data-testid="pve-console-reconnecting">
              {`The console was lost. Attempt ${t.attempt} of ${RECONNECT_ATTEMPTS}: a new console is opened with a fresh login. Nothing typed before the loss is sent again.`}
            </p>
          )}
          {t.notice !== null && (
            <p role="status" className="rh-notice" data-testid="pve-console-notice">
              {t.notice}
            </p>
          )}
          {t.attach !== null && t.handle !== null && t.state !== "disconnected" && (
            <AgentStage handle={t.handle} control={t.owner} onTakeover={async () => void (await apiRef.current.takeover?.(t.handle as SessionHandle))}>
              {t.kind === "vnc" ? (
                <VncView key={t.attach.token} onViewState={(v) => { if (v === "ready" && !superseded(t)) { shown.current.add(t.id); retriedOnce.current.delete(t.id); } }} wsUrl={t.attach.wsUrl} token={t.attach.token} onConsole={onConsole(t)} onEnded={onEnded(t)} onControl={onControl(t)} />
              ) : (
                <SshTerminal
                  key={t.attach.token}
                  wsUrl={t.attach.wsUrl}
                  token={t.attach.token}
                  apiRef={apiRefFor(t.id)}
                  history={t.history}
                  onDispose={(text) => void (text !== "" && screens.current.set(t.id, text))}
                  inputEnabled={t.state === "active"}
                  onInputRefused={() => patch(t.id, { notice: NOT_SENT })}
                  onStateChange={onTerminalState(t)}
                  onConsole={onConsole(t)}
                  onControl={onControl(t)}
                />
              )}
            </AgentStage>
          )}
        </div>
      ))}
    </section>
  );
}
