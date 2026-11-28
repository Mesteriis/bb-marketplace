// The guard's controls, shown in the plugin's own popover and in the host's
// window alike. Closed: one row — who gets access, then for how
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
  /**
   * "fit" (the default): as wide as the content, for the popover on the button.
   * "fill": takes the whole width it is given, for the host's window and drawer.
   */
  layout?: "fit" | "fill";
}

type Layout = "fit" | "fill";

const TERMS: readonly Minutes[] = [10, 30, 60];

const FRAME: Record<Layout, string> = {
  fit: "flex w-fit max-w-full flex-col gap-3.5 p-4 text-sm text-foreground",
  // A container, so the controls inside can fold by the window's width.
  fill: "@container flex w-full flex-col gap-3.5 p-4 text-sm text-foreground",
};

function Frame({ layout, busy, children }: { layout: Layout; busy?: boolean; children: ReactNode }) {
  return (
    <div data-layout={layout} aria-busy={busy} className={FRAME[layout]}>
      {children}
    </div>
  );
}

// "fit": the row of the two control groups folds when the window is narrow:
// the terms go under the scope. Each group carries a divider on its left, and
// the row is shifted left by the same amount inside a clipping box, so the
// divider of the first group in a line falls outside and only a divider
// between groups shows. The box's own padding leaves room for the focus rings.
const GROUPS_CLIP = "-m-0.5 overflow-hidden p-0.5";
const GROUPS = "-ml-7 flex flex-wrap items-end gap-y-3.5";
const GROUP =
  "relative min-w-0 pl-7 before:absolute before:bottom-0 before:left-3.5 before:h-10 before:w-px before:bg-border";

// "fill": the frame is a container, so the fold follows its width. Wide: the
// scope stretches, the terms sit at the end. Narrow: the terms go under the
// scope and share the row equally.
const FILL_GROUPS = "flex flex-col gap-3.5 @2xl:flex-row @2xl:items-end";
const FILL_DIVIDER = "hidden h-10 w-px flex-none bg-border @2xl:block";

/** A state with nothing to press: loading, the guard not found, another machine. */
function Notice({ layout, children }: { layout: Layout; children: ReactNode }) {
  return (
    <Frame layout={layout}>
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

export function GuardPopup({ view, now, busy, error, onOpen, onClose, layout = "fit" }: GuardPopupProps) {
  const open = openNow(view, now);
  // Derived on every render: the state may arrive after the window is shown.
  const [chosen, setScope] = useState<Scope | null>(null);
  const scope = pickScope(chosen, open);

  if (view === null) {
    return error === null ? (
      <Notice layout={layout}>Загрузка…</Notice>
    ) : (
      <Frame layout={layout}>
        <Problem>{error}</Problem>
      </Frame>
    );
  }
  if (!isAvailable(view)) return <Notice layout={layout}>{statusLine(view, now)}</Notice>;

  const fill = layout === "fill";
  const who = (
    <>
      <span className={CAPTION}>Кому</span>
      <ScopeSegments value={scope} onChange={setScope} layout={layout} />
    </>
  );
  const howLong = (
    <>
      <span className={CAPTION}>{open === null ? "Открыть на" : "Продлить на"}</span>
      <div className={fill ? "flex gap-1.5" : "flex flex-wrap gap-1.5"}>
        {TERMS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={fill ? `${TERM_BUTTON} flex-1 @2xl:flex-none` : TERM_BUTTON}
            disabled={busy}
            onClick={() => onOpen(scope, minutes)}
          >
            {minutes} мин
          </button>
        ))}
      </div>
    </>
  );

  return (
    <Frame layout={layout} busy={busy}>
      {open === null ? null : (
        <>
          <StatusRow until={open.until} scope={open.scope} now={now} busy={busy} onClose={onClose} />
          <RemainingBar until={open.until} now={now} />
        </>
      )}
      {fill ? (
        <div className={FILL_GROUPS}>
          <div className="min-w-0 @2xl:flex-1">{who}</div>
          <span aria-hidden="true" className={FILL_DIVIDER} />
          <div>{howLong}</div>
        </div>
      ) : (
        <div className={GROUPS_CLIP}>
          <div className={GROUPS}>
            <div className={GROUP}>{who}</div>
            <div className={GROUP}>{howLong}</div>
          </div>
        </div>
      )}
      {error === null ? null : <Problem>{error}</Problem>}
    </Frame>
  );
}
