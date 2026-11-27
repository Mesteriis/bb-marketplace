import { useEffect, type RefObject } from "react";

const focusable = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/**
 * Opens a <dialog> as modal while `open` holds: Tab and Shift+Tab cycle inside it (Chrome lets the focus leave a modal
 * dialog after its last control), Escape reaches only the dialog (BB closes the panel on it otherwise), and when it
 * closes or unmounts the focus goes back to what had it before.
 */
export function useModal(dialog: RefObject<HTMLDialogElement | null>, open = true) {
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    // Duck-typed: the plugin's code may run with globals of its own, where instanceof HTMLElement fails.
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body && typeof active.focus === "function" ? active : null;
    if (!element.open) element.showModal();
    const onKey = (event: KeyboardEvent) => {
      // Escape belongs to the dialog (its cancel closes it): BB's own Escape would close the whole panel behind it.
      if (event.key === "Escape") { if (element.open) event.stopPropagation(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(item => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      const inside = element.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [dialog, open]);
}
