import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icon.tsx";

export type MenuEntry =
  | {kind: "item"; label: string; onSelect(): void; disabled?: boolean}
  | {kind: "check"; label: string; checked: boolean; onChange(checked: boolean): void}
  | {kind: "separator"};

/**
 * A button with a ▾ that opens a menu of actions and switches. Arrow keys move, Escape and a choice close it and give
 * the focus back to the button; a click or Tab elsewhere closes it. A switch keeps the menu open.
 */
export function MenuButton({label, icon, entries, busy = false, className = "g-btn", chevron = true, children}: {
  label: string; icon?: string; entries: MenuEntry[]; busy?: boolean; className?: string;
  /** The ▾ after the button's text; off for a button that is only an icon (⋯). */
  chevron?: boolean;
  /** What the button shows, when not its label. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function close() { setOpen(false); trigger.current?.focus(); }
  const items = () => Array.from(box.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    items()[0]?.focus();
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  // Keys belong to the menu only while the focus is in it; Escape stops there, so BB does not close the panel.
  const keys = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return;
    if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); return; }
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % list.length : event.key === "ArrowUp" ? (at - 1 + list.length) % list.length
      : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  };
  // Tab, or a click, taking the focus out closes it.
  const leave = (event: FocusEvent<HTMLSpanElement>) => { if (open && !box.current?.contains(event.relatedTarget as Node | null)) setOpen(false); };
  return <span className="g-menu" ref={box} onKeyDown={keys} onBlur={leave}>
    <button ref={trigger} type="button" className={className} aria-label={children ? label : undefined} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}>
      {icon && <Icon name={icon} small/>}{children ?? label}{chevron && <Icon name="ChevronDown" small/>}</button>
    {open && <span className="g-menu-list" role="menu" aria-label={label}>{entries.map((entry, index) => entry.kind === "separator"
      ? <span key={index} role="separator" className="g-menu-sep"/>
      : entry.kind === "check"
        ? <button key={index} type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={entry.checked} onClick={() => entry.onChange(!entry.checked)}>
          <span className="g-menu-mark" aria-hidden="true">{entry.checked ? <Icon name="Check" small/> : null}</span>{entry.label}</button>
        // A choice that cannot be taken now stays in the menu, so it is found and said, but does nothing.
        : <button key={index} type="button" role="menuitem" tabIndex={-1} aria-disabled={entry.disabled || undefined}
          onClick={() => { if (entry.disabled) return; close(); entry.onSelect(); }}>
          <span className="g-menu-mark" aria-hidden="true"/>{entry.label}</button>)}</span>}
  </span>;
}
