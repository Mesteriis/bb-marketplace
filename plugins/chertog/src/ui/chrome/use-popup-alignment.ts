// The positioning parent wraps the trigger. Prefer the requested edge, flip
// when the opposite edge fits, and otherwise clamp to the visible surface.
import { useLayoutEffect, type RefObject } from "react";

export function usePopupAlignment(
  open: boolean,
  popupRef: RefObject<HTMLDivElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
  align: "start" | "end",
): void {
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    const parent = popup?.parentElement;
    const view = popup?.ownerDocument.defaultView;
    if (!open || !popup || !trigger || !parent || !view) return;

    const boundary = parent.closest("[data-chertog-surface], [data-chertog-route]");
    const position = () => {
      const bounds = boundary?.getBoundingClientRect();
      const left = Math.max(0, bounds?.left ?? 0);
      const right = Math.min(view.innerWidth, bounds?.right ?? view.innerWidth);
      popup.style.maxWidth = Math.max(0, right - left) + "px";
      const width = popup.getBoundingClientRect().width;
      const anchor = trigger.getBoundingClientRect();
      const start = anchor.left;
      const end = anchor.right - width;
      const preferred = align === "start" ? start : end;
      const alternate = align === "start" ? end : start;
      const fits = (x: number) => x >= left && x + width <= right;
      const x = fits(preferred) ? preferred : fits(alternate) ? alternate : Math.max(left, Math.min(preferred, right - width));
      popup.style.left = x - parent.getBoundingClientRect().left + "px";
    };

    position();
    const observer = view.ResizeObserver ? new view.ResizeObserver(position) : null;
    observer?.observe(popup);
    observer?.observe(parent);
    if (boundary) observer?.observe(boundary);
    view.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      view.removeEventListener("resize", position);
    };
  });
}
