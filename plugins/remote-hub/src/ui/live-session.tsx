// A live view of ONE session for the owner (stage 4c: agents are never hidden). Rendered inline in a thread by the
// `remote-session` message directive an agent puts in its reply, and on the Remote Hub page. It attaches to a session
// that already exists (an agent opened it, or the owner did); showing it is what lets an agent act on it, because the
// view reports in while it is visible (see watch-beat.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { tx } from "./i18n.ts";
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
  find: (
    handle: SessionHandle,
  ) => Promise<{
    generation: string;
    sessionId: number;
    kind: "echo" | "ssh" | "rdp" | "pve" | "vnc";
    state: "connecting" | "running" | "closed";
    pve?: { console: string; node: string; vmid: number | null; state: string; connectionName: string };
  } | null>;
  attach: (handle: SessionHandle, liveKind?: "ssh" | "rdp" | "vnc") => Promise<{ token: string; wsUrl: string }>;
  takeover: (handle: SessionHandle) => Promise<unknown>;
  /** Opens the Remote Hub page on this session: the one place a graphics console is viewed. */
  openRemoteHub?: (handle: SessionHandle) => void;
}

export { parseSessionKey };

export function LiveSession({ sessionKey, api }: { sessionKey: string; api: LiveSessionApi }) {
  const handle = parseSessionKey(sessionKey);
  const [view, setView] = useState<
    | { kind: "ssh" | "rdp" | "pve" | "vnc"; token: string; wsUrl: string }
    | { graphics: { console: string; node: string; vmid: number | null; state: string; connectionName: string } | null }
    | { problem: string; closed: boolean }
    | null
  >(null);
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
        if (found === null || found.state === "closed" || found.kind === "echo")
          return setView({ problem: tx("live.closed"), closed: true });
        // A graphics console has exactly ONE view for its whole life, and this card is not the place for it: attaching here would
        // take it from the Remote Hub page (an RFB stream cannot be shared or resumed). It shows the state and a way there.
        if (found.kind === "vnc") return setView({ graphics: found.pve ?? null });
        const attach = await apiRef.current.attach(h);
        if (!cancelled) setView({ kind: found.kind, token: attach.token, wsUrl: attach.wsUrl });
      } catch (e) {
        if (!cancelled)
          setView({
            problem: tx("live.failed", { reason: errorTextFromMessage(e instanceof Error ? e.message : String(e)) }),
            closed: false,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (handle === null) {
    return (
      <p role="alert" className="rh-error">
        {tx("live.notASession")}
      </p>
    );
  }
  if (view === null) return <p className="rh-notice">{tx("live.opening")}</p>;
  if ("graphics" in view) {
    const g = view.graphics;
    return (
      <div className="rh-live" data-testid="live-session-graphics">
        <p className="rh-notice">
          {g === null
            ? tx("live.graphicsUnknown")
            : tx("live.graphics", {
                what: `${g.console === "qemu" ? "VM" : g.console}${g.vmid === null ? "" : " " + g.vmid}`,
                connection: g.connectionName,
                node: g.node,
                state: g.state,
              })}{" "}
          {tx("live.graphicsOneView")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => api.openRemoteHub?.(handle)}
          disabled={api.openRemoteHub === undefined}
        >
          {tx("live.openHub")}
        </Button>
      </div>
    );
  }
  if ("problem" in view) {
    return !view.closed ? (
      <p role="alert" className="rh-error">
        {view.problem}
      </p>
    ) : (
      <p role="status" className="rh-notice">
        {view.problem}
      </p>
    );
  }
  return <AttachedSession handle={handle} view={view} takeover={api.takeover} />;
}

export type LiveViewStatus = "ready" | "lost" | "ended" | "denied";
export function AttachedSession({
  handle,
  view,
  takeover,
  canInput,
  onStatus,
}: {
  handle: SessionHandle;
  view: { kind: "ssh" | "pve" | "vnc" | "rdp"; token: string; wsUrl: string };
  takeover: LiveSessionApi["takeover"];
  canInput?: () => boolean;
  onStatus?: (status: LiveViewStatus) => void;
}) {
  const [owner, setOwner] = useState<ControlView>(HUMAN_CONTROL);
  const onControl = useCallback((message: ControlMessage) => setOwner((cur) => nextControl(cur, message)), []);
  // The commands an agent runs on this session, as they happen (shown, not stored: this lives in the open view only).
  const [commands, setCommands] = useState<LoggedCommand[]>([]);
  const onAgent = useCallback((event: FeedEvent) => setCommands((cur) => applyExecEvent(cur, event)), []);
  const ready = () => onStatus?.("ready");
  const closed = (reason?: string) => onStatus?.(!reason || reason === "helper_exited" ? "lost" : "ended");
  return (
    <div className="rh-live" data-testid="live-session">
      <div className="rh-live-head">
        <ControlBadge control={owner} />
      </div>
      <AgentStage handle={handle} control={owner} onTakeover={async () => void (await takeover(handle))}>
        {view.kind === "ssh" || view.kind === "pve" ? (
          <SshTerminal
            canInput={canInput}
            wsUrl={view.wsUrl}
            token={view.token}
            onControl={onControl}
            onAgent={onAgent}
            onLive={ready}
            onStateChange={(state, exit) => {
              if (state === "closed") closed(exit?.reason);
              if (state === "detached" || state === "error") onStatus?.("lost");
            }}
          />
        ) : view.kind === "vnc" ? (
          <VncView
            canInput={canInput}
            wsUrl={view.wsUrl}
            token={view.token}
            onControl={onControl}
            onAgent={onAgent}
            onViewState={(state) => {
              if (state === "ready") ready();
            }}
            onEnded={(event, confirmed) => {
              if (confirmed) closed(event.code);
              else onStatus?.(event.code === "vnc_view_taken" ? "denied" : "lost");
            }}
          />
        ) : (
          <div className="rh-rdp-wrap">
            <RdpCanvas
              canInput={canInput}
              wsUrl={view.wsUrl}
              token={view.token}
              fit="fit"
              label={tx("kind.desktop")}
              onFullFrame={ready}
              onEvent={(e) => {
                if (e.type === "control" || e.type === "input_blocked") onControl(e);
                if (e.type === "closed") closed(e.reason);
                if (e.type === "error" || (e.type === "socket" && (e.state === "detached" || e.state === "error"))) onStatus?.("lost");
              }}
            />
          </div>
        )}
      </AgentStage>
      {(view.kind === "ssh" || view.kind === "pve") && <CommandLog commands={commands} />}
    </div>
  );
}
