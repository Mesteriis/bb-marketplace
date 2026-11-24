// One session on the desk: a header (what it is, its state, who drives it, its actions) over the session's own view.
// A pane places itself: it is on screen only while the desk shows its id, in the order the desk gives.
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DeskSession } from "../../core/desk.ts";
import { useDesk } from "../desk-store.ts";
import { tx } from "../i18n.ts";
import { registerCloser, useDeskStore, useDeskThumbStore } from "./desk-context.tsx";
import { SessionIcon, sessionKindLabel, SessionStatus } from "./status.tsx";
import { useThumb } from "./use-thumb.ts";

export interface DeskPaneProps {
  session: Pick<DeskSession, "id" | "kind" | "title" | "detail" | "state" | "attempt" | "owner">;
  /** Buttons for this session (Disconnect, Reconnect …), drawn at the right of the header. */
  actions?: ReactNode;
  /** Disconnects the session and takes it off the desk. */
  onClose: () => void | Promise<void>;
  /** A line under the header: why it was lost, what Reconnect will do. */
  note?: ReactNode;
  children: ReactNode;
}

export function DeskPane({ session, actions, onClose, note, children }: DeskPaneProps) {
  const store = useDeskStore();
  const desk = useDesk(store);
  const order = desk.shown.indexOf(session.id);
  const focused = desk.focus === session.id;
  useEffect(() => registerCloser(store, session.id, onClose), [store, session.id, onClose]);
  const body = useRef<HTMLDivElement | null>(null);
  useThumb(session.id, body, useDeskThumbStore());
  return (
    <section
      hidden={order === -1}
      aria-label={session.title}
      data-testid="desk-pane"
      data-focused={focused ? "true" : "false"}
      style={{ order: order === -1 ? undefined : order }}
      onPointerDown={() => store.focus(session.id)}
      onFocus={() => store.focus(session.id)}
      className={cn("rh-desk-pane min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background", order === -1 ? "hidden" : "flex", focused && desk.shown.length > 1 ? "border-ring" : "border-border")}
    >
      <header className="rh-pane-header">
        <SessionIcon kind={session.kind} className="rh-pane-icon" />
        <div className="rh-pane-identity">
          <div className="rh-pane-title-row">
            <strong className="truncate font-semibold" title={session.title}>{session.title}</strong>
            <span className="rh-pane-kind">{sessionKindLabel(session.kind)}</span>
          </div>
          <div className="rh-pane-detail-row">
            {session.detail !== "" && <span className="rh-pane-detail" title={session.detail}>{session.detail}</span>}
            <SessionStatus session={session} />
          </div>
        </div>
        {session.state === "active" && session.owner === "agent" && (
          <span className="rh-pane-owner" data-testid="desk-pane-owner">
            {tx("session.drivenByAgent")}
          </span>
        )}
        <div className="rh-pane-actions">{actions}</div>
      </header>
      {note}
      <div ref={body} className="relative flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </section>
  );
}
