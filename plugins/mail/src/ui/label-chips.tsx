// Gmail label chips (slice 3h, #79): the owner's labels of a message, at
// most `max` of them on a list row and the rest as "+n". System labels are
// roles, never chips; the server already leaves them out, and this filters
// again so a stale or foreign value never shows as one.
import { ownerLabels } from "../core/labels.ts";
import { cn } from "@/lib/utils";
import { tx } from "./i18n/index.ts";

export function LabelChips({
  labels,
  max = 3,
  className,
}: {
  labels: readonly string[];
  /** How many chips show; the rest is "+n". */
  max?: number;
  className?: string;
}) {
  const shown = ownerLabels(labels);
  if (shown.length === 0) return null;
  const visible = shown.slice(0, max);
  const rest = shown.length - visible.length;
  return (
    <span role="list" aria-label={tx("Labels")} className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {visible.map((label) => (
        <span
          key={label}
          role="listitem"
          className="max-w-32 truncate rounded-sm bg-muted px-1 text-xs text-muted-foreground"
          title={label}
        >
          {label}
        </span>
      ))}
      {rest > 0 ? (
        <span role="listitem" className="text-xs text-muted-foreground">
          +{rest}
          <span className="sr-only">{rest === 1 ? tx(" more label") : tx(" more labels")}</span>
        </span>
      ) : null}
    </span>
  );
}
