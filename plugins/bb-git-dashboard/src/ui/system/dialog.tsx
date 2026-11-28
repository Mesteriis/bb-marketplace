import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

const focusable = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/**
 * Opens a <dialog> as modal while `open` holds: Tab and Shift+Tab cycle inside it (Chrome lets the focus leave a modal
 * dialog after its last control), Escape reaches only the dialog (BB closes the panel on it otherwise), and when it
 * closes or unmounts the focus goes back to what had it before.
 */
export function useModal(dialog: RefObject<HTMLDialogElement | null>, open = true, options: {modal?: boolean; onEscape?(): void} = {}) {
  const modal = options.modal !== false;
  const escape = useRef(options.onEscape);
  escape.current = options.onEscape;
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    // Duck-typed: the plugin's code may run with globals of its own, where instanceof HTMLElement fails.
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body && typeof active.focus === "function" ? active : null;
    if (!element.open) { if (modal) element.showModal(); else element.show(); }
    const onKey = (event: KeyboardEvent) => {
      const inside = element.contains(document.activeElement);
      // A popover of the dialog's own controls (a picker BB portals out of it) keeps its keys: Escape closes the popover.
      if (!modal && !inside && document.activeElement !== document.body) return;
      // Escape belongs to the dialog: BB's own Escape would close the whole panel behind it. A modal dialog closes by
      // its cancel event; one that is not modal is closed here.
      if (event.key === "Escape") {
        if (!element.open) return;
        event.stopPropagation();
        if (!modal) { event.preventDefault(); escape.current?.(); }
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(item => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [dialog, open, modal]);
}

/**
 * The plugin's dialog: centred over the page with a 12px radius, a title, its body and its actions at the bottom right.
 * Escape and the backdrop's cancel close it unless `busy`; the focus stays inside and goes back to the opener.
 * `modal` false keeps it out of the browser's top layer, under a backdrop of its own, so a popover BB portals out of
 * one of its controls (the model picker) can open over it.
 */
export function Dialog({title, busy = false, onClose, actions, children, modal = true}: {title: string; busy?: boolean; onClose(): void;
  actions: ReactNode; children?: ReactNode; modal?: boolean}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useModal(dialog, true, {modal, onEscape: () => { if (!busy) onClose(); }});
  const box = <dialog ref={dialog} className="g-dialog" data-modal={modal ? undefined : "own"} aria-modal={modal ? undefined : true} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose}>
    <h2 id={id}>{title}</h2>
    <div className="g-dialog-body">{children}</div>
    <div className="g-dialog-actions">{actions}</div>
  </dialog>;
  return modal ? box : <><div className="g-dialog-scrim" aria-hidden="true" onClick={() => { if (!busy) onClose(); }}/>{box}</>;
}
