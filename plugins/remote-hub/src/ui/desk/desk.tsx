// The work area: the open sessions, one or two on screen. Every session stays mounted (a hidden pane keeps its live view);
// the panes are the children, each placing itself by the desk state.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useDesk } from "../desk-store.ts";
import { plural, tx } from "../i18n.ts";
import { useDeskStore } from "./desk-context.tsx";

export function Desk({ children }: { children: ReactNode }) {
  const store = useDeskStore();
  const desk = useDesk(store);
  const empty = desk.shown.length === 0;
  return (
    <div className="rh-tokens rh-desk flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="rh-desk-toolbar" role="toolbar" aria-label={tx("desk.title")}>
        <h1 className="rh-desk-title">{tx("desk.title")}</h1>
        <div className="rh-layout-switch" role="group" aria-label={tx("desk.layout")}>
          <Button type="button" size="sm" variant="ghost" aria-pressed={desk.layout === "one"} onClick={() => store.layout("one")}>
            {tx("desk.one")}
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-pressed={desk.layout === "two"} onClick={() => store.layout("two")}>
            {tx("desk.two")}
          </Button>
        </div>
        <span className="rh-desk-count" role="status">
          {plural(desk.sessions.length, ["сессия", "сессии", "сессий"])}
        </span>
      </div>
      {empty && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center" data-testid="desk-empty">
          <p className="text-base font-medium">{tx("desk.empty.title")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{tx("desk.empty.hint")}</p>
        </div>
      )}
      <div className={empty ? "hidden" : "rh-desk-grid grid min-h-0 flex-1"} style={{ gridTemplateColumns: `repeat(${Math.max(desk.shown.length, 1)}, minmax(0, 1fr))` }} data-testid="desk-grid">
        {children}
      </div>
    </div>
  );
}
