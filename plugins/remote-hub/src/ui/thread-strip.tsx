// The piece of the row above a thread's composer: this thread's agent has remote sessions open, and one click shows them.
import { tx } from "./i18n.ts";
import { StatusDot } from "./desk/status.tsx";

export function ThreadStrip({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button type="button" className="rh-tokens inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" title={tx("strip.title")} onClick={onOpen} data-testid="thread-strip">
      <StatusDot tone="agent" />
      {tx("strip.sessions", { count })}
    </button>
  );
}
