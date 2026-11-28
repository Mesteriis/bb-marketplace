// The scope switch: three segments that behave as one radio group. Tab enters
// the selected segment; arrows, Home and End move the selection and the focus.
import { GitFork, Globe, MessageSquare, type LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import type { Scope } from "../core/state.ts";
import { nextScope, SCOPES, scopeShortLabel } from "./format.ts";
import { ICON, SEGMENT, SEGMENT_OFF, SEGMENT_ON } from "./styles.ts";

const SCOPE_ICONS: Record<Scope, LucideIcon> = {
  thread: MessageSquare,
  tree: GitFork,
  global: Globe,
};

export interface ScopeSegmentsProps {
  value: Scope;
  onChange(scope: Scope): void;
  /**
   * "fit": as wide as the labels. "fill": the group takes the whole row and
   * never wraps; where the row is narrow only the selected segment keeps its
   * label and the others shrink to their icons.
   */
  layout?: "fit" | "fill";
}

const GROUP = {
  fit: "inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border p-0.5",
  fill: "flex w-full flex-nowrap gap-0.5 rounded-md border border-border p-0.5",
} as const;

/** Extra classes of a segment and of its label, by layout and selection. */
function shape(layout: "fit" | "fill", selected: boolean): { segment: string; label: string } {
  if (layout === "fit") return { segment: "", label: "truncate" };
  return selected
    ? { segment: "min-w-0 flex-1 justify-center", label: "truncate" }
    : { segment: "flex-none justify-center @md:min-w-0 @md:flex-1", label: "hidden truncate @md:inline" };
}

export function ScopeSegments({ value, onChange, layout = "fit" }: ScopeSegmentsProps) {
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextScope(value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    group.current?.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
  };

  return (
    <div ref={group} role="radiogroup" aria-label="Охват" className={GROUP[layout]}>
      {SCOPES.map((scope) => {
        const Icon = SCOPE_ICONS[scope];
        const selected = scope === value;
        const label = scopeShortLabel(scope);
        const classes = shape(layout, selected);
        return (
          <button
            key={scope}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            data-scope={scope}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(scope)}
            onKeyDown={onKeyDown}
            className={`${SEGMENT} ${selected ? SEGMENT_ON : SEGMENT_OFF} ${classes.segment}`}
          >
            <Icon aria-hidden="true" className={ICON} />
            <span className={classes.label}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
