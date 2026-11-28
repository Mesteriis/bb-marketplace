// The window behind the lock: pick a scope, press a term; when open, the
// status and a close button sit on top and the terms extend the opening.
import { useState } from "react";
import type { GuardView } from "../core/service.ts";
import type { Minutes, Scope } from "../core/state.ts";
import { isAvailable, openNow, scopeLabel, statusLine } from "./format.ts";

export interface GuardPopupProps {
  /** null until the first answer arrives. */
  view: GuardView | null;
  /** Unix seconds. */
  now: number;
  /** A request is running. */
  busy: boolean;
  /** The last refusal, in the owner's language. */
  error: string | null;
  onOpen(scope: Scope, minutes: Minutes): void;
  onClose(): void;
}

const SCOPES: readonly Scope[] = ["thread", "tree", "global"];
const TERMS: readonly Minutes[] = [10, 30, 60];

const BUTTON =
  "inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function GuardPopup({ view, now, busy, error, onOpen, onClose }: GuardPopupProps) {
  const open = openNow(view, now);
  const [scope, setScope] = useState<Scope>(open?.scope ?? "thread");

  if (view === null) {
    return <div className="p-3 text-sm text-muted-foreground">Загрузка…</div>;
  }
  if (!isAvailable(view)) {
    return <div className="p-3 text-sm text-muted-foreground">{statusLine(view, now)}</div>;
  }
  return (
    <div className="flex min-w-64 flex-col gap-3 p-3 text-sm text-foreground">
      {open === null ? null : (
        <div className="flex items-center justify-between gap-3">
          <span>{statusLine(view, now)}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={onClose}>
            Закрыть
          </button>
        </div>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Охват</legend>
        {SCOPES.map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="secrets-guard-scope"
              value={value}
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            {scopeLabel(value)}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {TERMS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => onOpen(scope, minutes)}
          >
            {minutes} мин
          </button>
        ))}
      </div>
      {error === null ? null : (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
