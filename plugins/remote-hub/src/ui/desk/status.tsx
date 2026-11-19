// The small pieces every surface uses to say what state a session is in.
import { cn } from "@/lib/utils";
import { toneOf, type Tone } from "../../core/desk-status.ts";
import type { DeskSession, DeskSessionKind } from "../../core/desk.ts";
import { tx, type TextKey } from "../i18n.ts";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--rh-ok)",
  warn: "var(--rh-warn)",
  bad: "var(--rh-bad)",
  agent: "var(--rh-agent)",
  idle: "var(--rh-idle)",
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  // An idle session is a ring, not a filled dot: off is told apart without relying on colour alone.
  const style = tone === "idle" ? { boxShadow: `inset 0 0 0 1.5px ${TONE_COLOR.idle}` } : { background: TONE_COLOR[tone] };
  return <span aria-hidden="true" data-tone={tone} className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={style} />;
}

const STATE_KEY: Record<DeskSession["state"], TextKey> = {
  connecting: "session.connecting",
  waiting: "session.waiting",
  active: "session.active",
  lost: "session.lost",
  reconnecting: "session.reconnecting",
  disconnected: "session.disconnected",
  not_connected: "session.notConnected",
  error: "session.error",
};

/** "подключено", "переподключение 2 из 5": the state of a session in words. */
export function stateText(session: Pick<DeskSession, "state" | "attempt">, maxAttempts = 5): string {
  return tx(STATE_KEY[session.state], { attempt: session.attempt, max: maxAttempts });
}

const KIND_KEY: Record<DeskSessionKind, TextKey> = {
  ssh: "kind.terminal",
  "pve-terminal": "kind.terminal",
  rdp: "kind.desktop",
  "pve-graphics": "kind.graphics",
};

export function kindText(kind: DeskSessionKind): string {
  return tx(KIND_KEY[kind]);
}

export function SessionStatus({ session }: { session: Pick<DeskSession, "state" | "attempt" | "owner"> }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground" data-testid="session-status">
      <StatusDot tone={toneOf(session)} />
      {stateText(session)}
    </span>
  );
}

export { toneOf };
