// The Proxmox console tabs: a node shell or a container terminal (the same xterm view as SSH) and a virtual machine's graphics
// (noVNC), several at once. Every tab stays mounted (the inactive ones hidden), so switching tabs or re-rendering never opens a
// second upstream connection and never closes the backend session. Each tab's header shows the connection, the node or guest, its
// state (connecting, active, lost, disconnected, error) and the concrete reason; Disconnect closes the console at once, and
// Reconnect opens it again as a NEW console (an RFB stream cannot be resumed; automatic retries come in a later stage).
import { useCallback, useEffect, useRef, useState } from "react";
import { endStateOf, reasonText, type PveConsoleState } from "../core/pve-console.ts";
import type { SessionHandle } from "../core/rpc.ts";
import { ControlBadge, HUMAN_CONTROL, nextControl, type ControlMessage, type ControlView } from "./control-banner.tsx";
import { AgentStage } from "./agent-overlay.tsx";
import type { PveConsoleOpened, PveConsoleRequest } from "./pve-api.ts";
import { SshTerminal, type SshExitInfo, type SshTerminalState } from "./ssh-terminal.tsx";
import { VncView } from "./vnc-view.tsx";

export interface PveConsolesApi {
  open(input: PveConsoleRequest & { profileId: string; cols: number; rows: number }): Promise<PveConsoleOpened>;
  attach(handle: SessionHandle): Promise<{ token: string; wsUrl: string }>;
  close(handle: SessionHandle): Promise<void>;
  takeover?(handle: SessionHandle): Promise<void>;
}

/** A request to open a console; a new `nonce` is a new request. */
export interface PveConsoleLaunch {
  nonce: number;
  profileId: string;
  connectionName: string;
  request: PveConsoleRequest;
  /** The guest's name, for the tab. */
  title: string;
}

export interface PveConsolesProps {
  api: PveConsolesApi;
  launch?: PveConsoleLaunch;
}

type TabState = PveConsoleState | "opening";

interface Tab {
  id: number;
  launch: PveConsoleLaunch;
  handle: SessionHandle | null;
  kind: "pve" | "vnc" | null;
  attach: { token: string; wsUrl: string } | null;
  state: TabState;
  reason: { code: string; text: string; fingerprint: string | null } | null;
  owner: ControlView;
}

const STATE_LABEL: Record<TabState, string> = {
  opening: "connecting",
  connecting: "connecting",
  active: "active",
  lost: "lost",
  disconnected: "disconnected",
  error: "error",
};

const describe = (r: PveConsoleRequest, title: string): string => (r.console === "node" ? `node ${r.node}` : `${r.console === "qemu" ? "VM" : "container"} ${title === "" ? "" : title + " "}#${r.vmid}`.replace("  ", " "));

export function PveConsoles(props: PveConsolesProps) {
  const { api } = props;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const nextId = useRef(1);
  const lastNonce = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;

  const patch = useCallback((id: number, change: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t)));
  }, []);

  /** Opens (or re-opens) the console of tab `id`. A tab closed meanwhile has its new session closed again: never orphaned. */
  const start = useCallback(
    async (id: number, launch: PveConsoleLaunch) => {
      patch(id, { state: "opening", reason: null, handle: null, attach: null, kind: null, owner: HUMAN_CONTROL });
      let opened: PveConsoleOpened;
      try {
        opened = await apiRef.current.open({ ...launch.request, profileId: launch.profileId, cols: 80, rows: 24 });
      } catch (e) {
        patch(id, { state: "error", reason: { code: "open_failed", text: e instanceof Error ? e.message : String(e), fingerprint: null } });
        return;
      }
      if (!opened.ok) {
        patch(id, { state: "error", reason: { code: opened.code, text: reasonText(opened.code) === `The console ended (${opened.code}).` ? opened.message : reasonText(opened.code), fingerprint: opened.fingerprint } });
        return;
      }
      const handle: SessionHandle = { generation: opened.generation, sessionId: opened.sessionId };
      if (!tabsRef.current.some((t) => t.id === id)) {
        void apiRef.current.close(handle).catch(() => undefined);
        return;
      }
      patch(id, { handle, kind: opened.kind });
      try {
        const attach = await apiRef.current.attach(handle);
        patch(id, (t) => (t.handle === handle ? { attach } : {}));
      } catch (e) {
        patch(id, { state: "error", reason: { code: "attach_failed", text: e instanceof Error ? e.message : String(e), fingerprint: null } });
      }
    },
    [patch],
  );

  useEffect(() => {
    const launch = props.launch;
    if (launch === undefined || launch.nonce === lastNonce.current) return;
    lastNonce.current = launch.nonce;
    const id = nextId.current++;
    setTabs((cur) => [...cur, { id, launch, handle: null, kind: null, attach: null, state: "opening", reason: null, owner: HUMAN_CONTROL }]);
    setActive(id);
    void start(id, launch);
  }, [props.launch, start]);

  const closeQuietly = (handle: SessionHandle | null): void => {
    if (handle !== null) void apiRef.current.close(handle).catch(() => undefined);
  };

  const disconnect = (tab: Tab): void => {
    closeQuietly(tab.handle);
    patch(tab.id, { state: "disconnected", reason: null });
  };
  const reconnect = (tab: Tab): void => {
    closeQuietly(tab.handle);
    void start(tab.id, tab.launch);
  };
  const closeTab = (tab: Tab): void => {
    closeQuietly(tab.handle);
    setTabs((cur) => cur.filter((t) => t.id !== tab.id));
    setActive((cur) => (cur === tab.id ? (tabsRef.current.find((t) => t.id !== tab.id)?.id ?? null) : cur));
  };

  // Closing the page ends the consoles it holds only through the service's idle policy; nothing is closed here on unmount.
  const onTerminalState = (tab: Tab) => (next: SshTerminalState, info?: SshExitInfo) => {
    if (next === "closed" && info !== undefined) {
      const state = endStateOf(info.reason);
      patch(tab.id, (t) => (t.state === "error" || t.state === "disconnected" ? {} : { state, reason: state === "lost" ? { code: info.reason, text: reasonText(info.reason), fingerprint: null } : null }));
    } else if (next === "detached" || next === "error") {
      patch(tab.id, (t) => (t.state === "disconnected" || t.state === "error" ? {} : { state: "lost", reason: { code: "websocket_error", text: reasonText("websocket_error"), fingerprint: null } }));
    }
  };
  const onConsole = (tab: Tab) => (event: { state: string; reason: Tab["reason"] }) => {
    const state = event.state as PveConsoleState;
    patch(tab.id, (t) => (t.state === "disconnected" ? {} : { state, reason: event.reason }));
  };
  const onEnded = (tab: Tab) => (info: { code: string; text: string }) => {
    const state = info.code === "vnc_not_resumable" || info.code === "vnc_view_taken" || info.code === "viewer_unavailable" || info.code === "vnc_auth_failed" ? "error" : endStateOf(info.code);
    patch(tab.id, (t) => (t.state === "disconnected" || (t.state === "error" && t.reason !== null) ? {} : { state, reason: state === "disconnected" ? null : { code: info.code, text: info.text, fingerprint: null } }));
  };
  const onControl = (tab: Tab) => (message: ControlMessage) => patch(tab.id, (t) => ({ owner: nextControl(t.owner, message) }));

  if (tabs.length === 0) return <p className="rh-hint">No Proxmox console is open. Open one from a guest or node in the Proxmox list.</p>;

  return (
    <section className="rh-pve-consoles" aria-label="Proxmox consoles">
      <div role="tablist" className="rh-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id} onClick={() => setActive(t.id)} data-testid="pve-console-tab">
            {t.launch.connectionName} · {describe(t.launch.request, t.launch.title)} <span className="rh-badge">{STATE_LABEL[t.state]}</span>
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} hidden={active !== t.id} className="rh-pve-console" data-testid="pve-console" aria-label={`console ${describe(t.launch.request, t.launch.title)}`}>
          <div className="rh-live-head">
            <strong>{t.launch.connectionName}</strong> · {describe(t.launch.request, t.launch.title)} <span className="rh-status" data-testid="pve-console-state">{STATE_LABEL[t.state]}</span>
            <ControlBadge control={t.owner} />
            <button type="button" disabled={t.state === "disconnected" || t.handle === null} onClick={() => disconnect(t)}>
              Disconnect
            </button>
            <button type="button" disabled={t.state === "opening" || t.state === "connecting" || t.state === "active"} onClick={() => reconnect(t)}>
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
          {t.attach !== null && t.handle !== null && t.state !== "disconnected" && (
            <AgentStage handle={t.handle} control={t.owner} onTakeover={async () => void (await apiRef.current.takeover?.(t.handle as SessionHandle))}>
              {t.kind === "vnc" ? (
                <VncView key={t.attach.token} wsUrl={t.attach.wsUrl} token={t.attach.token} onConsole={onConsole(t)} onEnded={onEnded(t)} onControl={onControl(t)} />
              ) : (
                <SshTerminal key={t.attach.token} wsUrl={t.attach.wsUrl} token={t.attach.token} onStateChange={onTerminalState(t)} onConsole={onConsole(t)} onControl={onControl(t)} />
              )}
            </AgentStage>
          )}
        </div>
      ))}
    </section>
  );
}
