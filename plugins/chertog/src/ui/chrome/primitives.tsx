// Shared pieces of the workspace chrome: the class sets that carry BB's
// density and theme tokens, focus helpers, a popover hook and a modal dialog.
// The chrome draws native elements, so it needs no host component.
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonBase = `inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium disabled:pointer-events-none disabled:opacity-50 ${focusRing}`;

export const classes = {
  focusRing,
  button: `${buttonBase} border border-border bg-transparent text-foreground hover:bg-state-hover`,
  ghostButton: `${buttonBase} text-foreground hover:bg-state-hover`,
  iconButton: `inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 ${focusRing}`,
  primaryButton: `${buttonBase} bg-foreground text-background hover:bg-foreground/90`,
  dangerButton: `${buttonBase} bg-destructive text-destructive-foreground hover:bg-destructive/90`,
  input: `h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground ${focusRing}`,
  popover:
    "absolute top-full z-50 mt-1 flex max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-auto rounded-md border border-border bg-background p-2 text-sm text-foreground shadow-sm",
  sectionHeading: "px-1 text-xs font-medium text-muted-foreground",
  error: "px-1 text-xs text-destructive",
  muted: "px-1 text-xs text-muted-foreground",
} as const;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Arrow-key movement between the `[data-nav]` elements of a container: Down
 * and Up step, Home and End jump. Stops at the ends. A text field keeps Home
 * and End for its caret.
 */
export function moveByArrows(event: ReactKeyboardEvent, container: HTMLElement | null): void {
  if (container === null) return;
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  if ((key === "Home" || key === "End") && event.target instanceof HTMLInputElement) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>("[data-nav]"));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  let next: number;
  if (key === "Home") next = 0;
  else if (key === "End") next = last;
  else if (key === "ArrowDown") next = Math.min(index + 1, last);
  else next = Math.max(index - 1, 0);
  event.preventDefault();
  items[next].focus();
}

/**
 * Focus to set once the next render is in the DOM: the element is often one
 * the same state change creates. `request` takes a finder that runs against
 * the container after that render.
 */
export function usePendingFocus(containerRef: RefObject<HTMLElement | null>) {
  const pending = useRef<((container: HTMLElement) => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const find = pending.current;
    if (find === null || containerRef.current === null) return;
    pending.current = null;
    find(containerRef.current)?.focus();
  });
  return useCallback((find: (container: HTMLElement) => HTMLElement | null | undefined) => {
    pending.current = find;
  }, []);
}

/**
 * Open state of a popover under a trigger button. Escape closes it and
 * returns focus to the trigger; a press outside, or focus moving outside,
 * closes it and leaves focus where it went.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    close();
  };

  /** Focus that goes nowhere (its element was removed by a re-render) is not a move outside. */
  const onBlur = (event: ReactFocusEvent) => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget) === false) setOpen(false);
  };

  return { open, setOpen, close, rootRef, triggerRef, onKeyDown, onBlur };
}

interface ModalProps {
  labelledBy: string;
  describedBy?: string;
  /** Escape and a press on the backdrop. */
  onDismiss: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * A modal dialog. Focus starts on the `[data-autofocus]` element (or the
 * first control), Tab cycles inside, and when the dialog goes away focus
 * returns to the element that had it before.
 */
export function Modal({ labelledBy, describedBy, onDismiss, className, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog !== null) {
      const first = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusableElements(dialog)[0] ?? dialog;
      first.focus();
    }
    return () => {
      if (source?.isConnected) source.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableElements(event.currentTarget);
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-full w-full flex-col gap-3 overflow-auto rounded-md border border-border bg-background p-4 text-sm text-foreground shadow-sm ${classes.focusRing} ${className ?? "max-w-md"}`}
      >
        {children}
      </div>
    </div>
  );
}

type IconName = "chevron" | "plus" | "pencil" | "copy" | "trash" | "hidden";

const ICON_PATHS: Record<IconName, string> = {
  chevron: "M4 6l4 4 4-4",
  plus: "M8 3v10M3 8h10",
  pencil: "M10.5 3.5l2 2L6 12l-2.5.5L4 10z",
  copy: "M6 6h7v7H6zM3 10V3h7",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5",
  hidden: "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13L13 3",
};

/** A decorative 16-pixel glyph; the control around it carries the name. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
