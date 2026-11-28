// The lock next to the send button: muted when closed, with the minutes left when open.
import type { GuardView } from "../core/service.ts";
import { isAvailable, openNow, remainingLabel, statusLine } from "./format.ts";

export interface GuardButtonProps {
  /** null until the first answer arrives. */
  view: GuardView | null;
  /** Unix seconds. */
  now: number;
  /** Why the state is unknown, when it is. */
  problem?: string | null;
  onOpen(): void;
}

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d={open ? "M8 11V7a4 4 0 0 1 7.5-2" : "M8 11V7a4 4 0 0 1 8 0v4"} />
    </svg>
  );
}

export function GuardButton({ view, now, problem, onOpen }: GuardButtonProps) {
  const open = openNow(view, now);
  const hint = view === null ? (problem ?? "Секреты") : statusLine(view, now);
  const tone = open === null ? "text-muted-foreground" : "text-foreground";
  return (
    <button
      type="button"
      data-state={open === null ? "closed" : "open"}
      disabled={view === null || !isAvailable(view)}
      title={hint}
      aria-label={view === null ? hint : `Секреты: ${hint}`}
      onClick={onOpen}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-xs tabular-nums ${tone} hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50`}
    >
      <LockIcon open={open !== null} />
      {open === null ? null : <span>{remainingLabel(open.until, now)}</span>}
    </button>
  );
}
