// The window behind the lock. Closed: one row — who gets access, then for how
// long; a term opens at once. Open: the status with a close button and the
// remaining bar on top, and the same row extends the opening.
import { Lock, LockOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { GuardView } from "../core/service.ts";
import type { Minutes, Scope } from "../core/state.ts";
import {
  isAvailable,
  openHeadline,
  openNow,
  pickScope,
  remainingMinutes,
  remainingShare,
  scopeShortLabel,
  statusLine,
} from "./format.ts";
import { ScopeSegments } from "./scope-segments.tsx";
import { CAPTION, ICON, QUIET_BUTTON, TERM_BUTTON } from "./styles.ts";

export interface GuardPopupProps {
  /** null until the first answer arrives, and whenever the state is unknown. */
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

const TERMS: readonly Minutes[] = [10, 30, 60];

/** The window is as wide as its content, wherever the host puts it and however wide it makes the popup. */
function Frame({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <div aria-busy={busy} className="flex w-fit max-w-full flex-col gap-3.5 p-4 text-sm text-foreground">
      {children}
    </div>
  );
}

// The row of the two control groups folds when the window is narrow: the terms
// go under the scope. Each group carries a divider on its left, and the row is
// shifted left by the same amount inside a clipping box, so the divider of the
// first group in a line falls outside and only a divider between groups shows.
// The box's own padding leaves room for the focus rings.
const GROUPS_CLIP = "-m-0.5 overflow-hidden p-0.5";
const GROUPS = "-ml-7 flex flex-wrap items-end gap-y-3.5";
const GROUP =
  "relative min-w-0 pl-7 before:absolute before:bottom-0 before:left-3.5 before:h-10 before:w-px before:bg-border";

/** A state with nothing to press: loading, the guard not found, another machine. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <Frame>
      <p className="flex max-w-md items-start gap-2 text-muted-foreground">
        <Lock aria-hidden="true" className={`${ICON} mt-0.5`} />
        <span>{children}</span>
      </p>
    </Frame>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-md text-destructive" role="alert">
      {children}
    </p>
  );
}

function StatusRow(props: { until: number; scope: Scope; now: number; busy: boolean; onClose(): void }) {
  const label = scopeShortLabel(props.scope);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <LockOpen aria-hidden="true" className={`${ICON} text-warning-text`} />
      <span className="font-semibold text-warning-text">{openHeadline(props.until, props.now)}</span>
      <span className="text-muted-foreground">· {label.charAt(0).toLowerCase() + label.slice(1)}</span>
      <span className="flex-1" />
      <button type="button" className={QUIET_BUTTON} disabled={props.busy} onClick={props.onClose}>
        <Lock aria-hidden="true" className={ICON} />
        Закрыть
      </button>
    </div>
  );
}

function RemainingBar({ until, now }: { until: number; now: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Остаток срока"
      aria-valuemin={0}
      aria-valuemax={60}
      aria-valuenow={remainingMinutes(until, now)}
      className="h-1 overflow-hidden rounded-full bg-border"
    >
      <div className="h-full rounded-full bg-warning" style={{ width: `${remainingShare(until, now) * 100}%` }} />
    </div>
  );
}

export function GuardPopup({ view, now, busy, error, onOpen, onClose }: GuardPopupProps) {
  const open = openNow(view, now);
  // Derived on every render: the state may arrive after the window is shown.
  const [chosen, setScope] = useState<Scope | null>(null);
  const scope = pickScope(chosen, open);

  if (view === null) {
    return error === null ? (
      <Notice>Загрузка…</Notice>
    ) : (
      <Frame>
        <Problem>{error}</Problem>
      </Frame>
    );
  }
  if (!isAvailable(view)) return <Notice>{statusLine(view, now)}</Notice>;

  return (
    <Frame busy={busy}>
      {open === null ? null : (
        <>
          <StatusRow until={open.until} scope={open.scope} now={now} busy={busy} onClose={onClose} />
          <RemainingBar until={open.until} now={now} />
        </>
      )}
      <div className={GROUPS_CLIP}>
        <div className={GROUPS}>
          <div className={GROUP}>
            <span className={CAPTION}>Кому</span>
            <ScopeSegments value={scope} onChange={setScope} />
          </div>
          <div className={GROUP}>
            <span className={CAPTION}>{open === null ? "Открыть на" : "Продлить на"}</span>
            <div className="flex flex-wrap gap-1.5">
              {TERMS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={TERM_BUTTON}
                  disabled={busy}
                  onClick={() => onOpen(scope, minutes)}
                >
                  {minutes} мин
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error === null ? null : <Problem>{error}</Problem>}
    </Frame>
  );
}
