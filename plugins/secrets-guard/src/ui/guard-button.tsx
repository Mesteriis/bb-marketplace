// The lock next to the send button: a muted lock when closed, a highlighted
// chip with an open lock and the minutes left when open.
import { Lock, LockOpen } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import type { GuardView } from "../core/service.ts";
import { isAvailable, openNow, remainingLabel, statusLine } from "./format.ts";
import { FOCUS, ICON } from "./styles.ts";

export interface GuardButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "children" | "type"> {
  /** null until the first answer arrives. */
  view: GuardView | null;
  /** Unix seconds. */
  now: number;
  /** Why the state is unknown, when it is. */
  problem?: string | null;
  /** Pressed. A popover trigger passes its own handlers instead. */
  onOpen?(): void;
}

// `data-[state=open]` is the popover's: the lock stays highlighted while its window is open.
const CLOSED =
  "text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";
const OPEN = "bg-warning/15 text-warning-text hover:bg-warning/25 data-[state=open]:bg-warning/25";

/**
 * Takes a ref and any button props, so a popover can use it as its trigger.
 * `data-guard` is the guard's state; `data-state` is left to the popover.
 */
export const GuardButton = forwardRef<HTMLButtonElement, GuardButtonProps>(function GuardButton(
  { view, now, problem, onOpen, onClick, ...rest },
  ref,
) {
  const open = openNow(view, now);
  const hint = view === null ? (problem ?? "Секреты") : statusLine(view, now);
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      data-guard={open === null ? "closed" : "open"}
      disabled={view === null || !isAvailable(view)}
      title={hint}
      aria-label={view === null ? hint : `Секреты: ${hint}`}
      onClick={(event) => {
        onClick?.(event);
        onOpen?.();
      }}
      className={`inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs tabular-nums transition-colors ${open === null ? CLOSED : OPEN} ${FOCUS} disabled:pointer-events-none disabled:opacity-50`}
    >
      {open === null ? (
        <Lock aria-hidden="true" className={ICON} />
      ) : (
        <>
          <LockOpen aria-hidden="true" className={ICON} />
          <span>{remainingLabel(open.until, now)}</span>
        </>
      )}
    </button>
  );
});
