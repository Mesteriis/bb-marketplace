// One session an agent works on, filling the page: what the owner sees in the main pane while the agent's thread sits in
// the split beside it. The desk stays mounted behind it; Back returns there.
import { Button } from "@/components/ui/button";
import { tx } from "./i18n.ts";
import { LiveSession, type LiveSessionApi } from "./live-session.tsx";

export function WatchedView({ sessionKey, api, onBack }: { sessionKey: string; api: LiveSessionApi; onBack: () => void }) {
  return (
    <div className="rh-tokens flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="watched-view">
      <div className="flex h-[var(--rh-header)] shrink-0 items-center gap-2 border-b border-border px-4 text-sm">
        <strong className="font-semibold">{tx("live.title")}</strong>
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          {tx("live.toDesk")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
        <LiveSession sessionKey={sessionKey} api={api} />
      </div>
    </div>
  );
}
