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
}

export function ScopeSegments({ value, onChange }: ScopeSegmentsProps) {
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextScope(value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    group.current?.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Охват"
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border p-0.5"
    >
      {SCOPES.map((scope) => {
        const Icon = SCOPE_ICONS[scope];
        const selected = scope === value;
        return (
          <button
            key={scope}
            type="button"
            role="radio"
            aria-checked={selected}
            data-scope={scope}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(scope)}
            onKeyDown={onKeyDown}
            className={`${SEGMENT} ${selected ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            <Icon aria-hidden="true" className={ICON} />
            {scopeShortLabel(scope)}
          </button>
        );
      })}
    </div>
  );
}
