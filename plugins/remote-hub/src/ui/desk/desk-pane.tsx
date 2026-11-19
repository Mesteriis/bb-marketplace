// One session on the desk: a header (what it is, its state, who drives it, its actions) over the session's own view.
// A pane places itself: it is on screen only while the desk shows its id, in the order the desk gives.
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DeskSession } from "../../core/desk.ts";
import { useDesk } from "../desk-store.ts";
import { tx } from "../i18n.ts";
import { registerCloser, useDeskStore } from "./desk-context.tsx";
import { SessionStatus } from "./status.tsx";
import { useThumb } from "./use-thumb.ts";

export interface DeskPaneProps {
  session: Pick<DeskSession, "id" | "title" | "detail" | "state" | "attempt" | "owner">;
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
  useEffect(() => registerCloser(session.id, onClose), [session.id, onClose]);
  const body = useRef<HTMLDivElement | null>(null);
  useThumb(session.id, body);
  return (
    <section
      hidden={order === -1}
      aria-label={session.title}
      data-testid="desk-pane"
      data-focused={focused ? "true" : "false"}
      style={{ order: order === -1 ? undefined : order }}
      onPointerDown={() => store.focus(session.id)}
      onFocus={() => store.focus(session.id)}
      className={cn("min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background", order === -1 ? "hidden" : "flex", focused && desk.shown.length > 1 ? "border-ring" : "border-border")}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
        <strong className="truncate font-semibold">{session.title}</strong>
        <span className="truncate text-muted-foreground">{session.detail}</span>
        <SessionStatus session={session} />
        {session.state === "active" && (
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground" data-testid="desk-pane-owner">
            {tx(session.owner === "agent" ? "session.drivenByAgent" : "session.drivenByYou")}
          </span>
        )}
        <span className="flex-1" />
        {actions}
      </header>
      {note}
      <div ref={body} className="relative flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </section>
  );
}
