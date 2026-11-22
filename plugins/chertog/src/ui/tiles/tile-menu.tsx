// The "…" menu of a tile: actions on the layout that are not gestures.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePopupAlignment } from "../chrome/use-popup-alignment.ts";
import { MoreIcon } from "./icons.tsx";
import { CONTROL_CLASS } from "./styles.ts";

export interface TileMenuItem {
  readonly label: string;
  readonly reason?: string;
  onSelect?(): void;
}

/**
 * A button that opens a menu below itself. It closes on a choice, on Escape
 * (the focus returns to the button) and on a press outside. It uses no
 * backdrop: nothing invisible lies over the rest of the surface while it is
 * open.
 */
export function TileMenu({ label, items }: { label: string; items: readonly TileMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const menu = useRef<HTMLDivElement>(null);
  usePopupAlignment(open, menu, button, "end");

  useEffect(() => {
    const element = root.current;
    if (!open || element === null) return;
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const view = element.ownerDocument;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) setOpen(false);
    };
    view.addEventListener("pointerdown", onPointerDown, true);
    return () => view.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const at = entries.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : entries.length - 1;
    entries[(at + step + entries.length) % entries.length]?.focus();
  };

  return (
    <div ref={root} data-tile-control className="relative flex">
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={CONTROL_CLASS}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          style={{ position: "absolute", top: "100%", zIndex: 20 }}
          className="mt-1 flex w-max flex-col rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              aria-disabled={!item.onSelect || undefined}
              tabIndex={-1}
              className="rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
              onClick={() => {
                if (!item.onSelect) return;
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
              {item.reason && <span className="block max-w-56 whitespace-normal text-muted-foreground">{item.reason}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
