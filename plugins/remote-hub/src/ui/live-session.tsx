// A live view of ONE session for the owner (stage 4c: agents are never hidden). Rendered inline in a thread by the
// `remote-session` message directive an agent puts in its reply, and on the Remote Hub page. It attaches to a session
// that already exists (an agent opened it, or the owner did); showing it is what lets an agent act on it, because the
// view reports in while it is visible (see watch-beat.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHandle } from "../core/rpc.ts";
import { parseSessionKey } from "./session-key.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import { ControlBadge, HUMAN_CONTROL, nextControl, type ControlMessage, type ControlView } from "./control-banner.tsx";
import { AgentStage } from "./agent-overlay.tsx";
import type { FeedEvent } from "../core/agent-feed.ts";
import { CommandLog, applyExecEvent, type LoggedCommand } from "./command-log.tsx";
import { RdpCanvas } from "./rdp-canvas.tsx";
import { VncView } from "./vnc-view.tsx";
import { SshTerminal } from "./ssh-terminal.tsx";

export interface LiveSessionApi {
  /** The session if it is open, else null. */
  find: (handle: SessionHandle) => Promise<{ generation: string; sessionId: number; kind: "echo" | "ssh" | "rdp" | "pve" | "vnc"; state: "connecting" | "running" | "closed"; pve?: { console: string; node: string; vmid: number | null; state: string; connectionName: string } } | null>;
  attach: (handle: SessionHandle) => Promise<{ token: string; wsUrl: string }>;
  takeover: (handle: SessionHandle) => Promise<unknown>;
  /** Opens the Remote Hub page on this session: the one place a graphics console is viewed. */
  openRemoteHub?: (handle: SessionHandle) => void;
}

export { parseSessionKey };

export function LiveSession({ sessionKey, api }: { sessionKey: string; api: LiveSessionApi }) {
  const handle = parseSessionKey(sessionKey);
  const [view, setView] = useState<{ kind: "ssh" | "rdp" | "pve" | "vnc"; token: string; wsUrl: string } | { graphics: { console: string; node: string; vmid: number | null; state: string; connectionName: string } | null } | { problem: string } | null>(null);
  const [owner, setOwner] = useState<ControlView>(HUMAN_CONTROL);
  const onControl = useCallback((message: ControlMessage) => setOwner((cur) => nextControl(cur, message)), []);
  // The commands an agent runs on this session, as they happen (shown, not stored: this lives in the open view only).
  const [commands, setCommands] = useState<LoggedCommand[]>([]);
  const onAgent = useCallback((event: FeedEvent) => setCommands((cur) => applyExecEvent(cur, event)), []);
  const apiRef = useRef(api);
  apiRef.current = api;
  const key = handle === null ? null : `${handle.generation}.${handle.sessionId}`;

  useEffect(() => {
    if (key === null) return;
    const h = parseSessionKey(key)!;
    let cancelled = false;
    setView(null);
    (async () => {
      try {
        const found = await apiRef.current.find(h);
        if (cancelled) return;
        if (found === null || found.state === "closed" || found.kind === "echo") return setView({ problem: "This session is no longer open." });
        // A graphics console has exactly ONE view for its whole life, and this card is not the place for it: attaching here would
        // take it from the Remote Hub page (an RFB stream cannot be shared or resumed). It shows the state and a way there.
        if (found.kind === "vnc") return setView({ graphics: found.pve ?? null });
        const attach = await apiRef.current.attach(h);
        if (!cancelled) setView({ kind: found.kind, token: attach.token, wsUrl: attach.wsUrl });
      } catch (e) {
        if (!cancelled) setView({ problem: "Could not show this session: " + errorTextFromMessage(e instanceof Error ? e.message : String(e)) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (handle === null) {
    return (
      <p role="alert" className="rh-error">
        This is not a session this plugin can show.
      </p>
    );
  }
  if (view === null) return <p className="rh-notice">Opening the live view…</p>;
  if ("graphics" in view) {
    const g = view.graphics;
    return (
      <div className="rh-live" data-testid="live-session-graphics">
        <p className="rh-notice">
          {g === null ? "A virtual machine's graphical console." : `Graphics of ${g.console === "qemu" ? "VM" : g.console}${g.vmid === null ? "" : " #" + g.vmid} on ${g.connectionName}, node ${g.node}: ${g.state}.`} It has one view, which is the Remote Hub
          page, so it is not shown here.
        </p>
        <button type="button" onClick={() => api.openRemoteHub?.(handle)} disabled={api.openRemoteHub === undefined}>
          View in Remote Hub
        </button>
      </div>
    );
  }
  if ("problem" in view) {
    return view.problem.startsWith("Could not") ? (
      <p role="alert" className="rh-error">
        {view.problem}
      </p>
    ) : (
      <p role="status" className="rh-notice">
        {view.problem}
      </p>
    );
  }
  return (
    <div className="rh-live" data-testid="live-session">
      <div className="rh-live-head">
        <ControlBadge control={owner} />
      </div>
      <AgentStage handle={handle} control={owner} onTakeover={async () => void (await api.takeover(handle))}>
        {view.kind === "ssh" || view.kind === "pve" ? (
          <SshTerminal wsUrl={view.wsUrl} token={view.token} onControl={onControl} onAgent={onAgent} />
        ) : view.kind === "vnc" ? (
          <VncView wsUrl={view.wsUrl} token={view.token} onControl={onControl} onAgent={onAgent} />
        ) : (
          <div className="rh-rdp-wrap">
            <RdpCanvas wsUrl={view.wsUrl} token={view.token} fit="fit" label="Remote desktop" onEvent={(e) => (e.type === "control" || e.type === "input_blocked" ? onControl(e as ControlMessage) : undefined)} />
          </div>
        )}
      </AgentStage>
      {(view.kind === "ssh" || view.kind === "pve") && <CommandLog commands={commands} />}
    </div>
  );
}
