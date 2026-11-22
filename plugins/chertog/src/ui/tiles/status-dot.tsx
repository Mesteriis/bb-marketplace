// The state dot of a panel: beside its tab in a tile, and before its name in the title bar.
import type { PanelLabel, PanelStatusTone } from "./labels.ts";

const STATUS_CLASS: Record<PanelStatusTone, string> = {
  idle: "bg-muted-foreground/50",
  busy: "bg-primary",
  attention: "bg-amber-500",
  error: "bg-destructive",
};

export function StatusDot({ status }: { status: NonNullable<PanelLabel["status"]> }) {
  return <span role="img" aria-label={status.label} title={status.label} className={"h-1.5 w-1.5 shrink-0 rounded-full " + STATUS_CLASS[status.tone]} />;
}
