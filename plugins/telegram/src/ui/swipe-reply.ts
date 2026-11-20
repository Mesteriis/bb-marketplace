import { useEffect, type RefObject } from "react";

const swipeDistance = 64;
const wheelIdle = 180;
const holdDelay = 500;
const interactive = "a, button, input, select, textarea, label, summary, dialog, [contenteditable], audio, video, pre, [role=slider]";

function actionOn(row: HTMLElement, left: boolean) {
  return row.querySelector<HTMLButtonElement>(left ? "button[data-swipe-info]:enabled" : "button[data-swipe-reply]:enabled");
}

export function useSwipeToReply(listRef: RefObject<HTMLOListElement | null>, scope: string, enabled: boolean) {
  useEffect(() => {
    const history = listRef.current;
    if (!enabled || !history) return;
    const list = history;
    let wheel: { button?: HTMLButtonElement | null; distance: number; sign: number } | undefined;
    let resetWheel: ReturnType<typeof setTimeout> | undefined;
    let touch: { row: HTMLElement; id: number; x: number; y: number } | undefined;
    let hold: ReturnType<typeof setTimeout> | undefined;

    function messageRow(target: EventTarget | null) {
      if (!(target instanceof Element) || list.hidden) return;
      const control = target.closest(interactive);
      if (control && !control.classList.contains("mtg-photo-open")) return;
      const row = target.closest<HTMLElement>("[data-message-id]");
      if (!row || !list.contains(row)) return;
      const selected = list.ownerDocument.getSelection();
      if (selected?.anchorNode && !selected.isCollapsed && list.contains(selected.anchorNode)) return;
      for (let element: Element | null = target; element && element !== row; element = element.parentElement) {
        if (element.scrollWidth > element.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return;
      }
      return row;
    }

    function activate(button?: HTMLButtonElement | null) {
      if (button && !list.hidden && list.contains(button) && !button.disabled) button.click();
    }

    function onWheel(event: WheelEvent) {
      clearTimeout(resetWheel);
      resetWheel = setTimeout(() => { wheel = undefined; }, wheelIdle);
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5;
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.deltaMode !== 0 || !horizontal) {
        wheel = { distance: 0, sign: 0 };
        return;
      }
      const sign = Math.sign(event.deltaX);
      if (!wheel) {
        const row = messageRow(event.target);
        wheel = { button: row && actionOn(row, sign > 0), distance: 0, sign };
      }
      if (!wheel.button || wheel.sign !== sign) return;
      if (event.cancelable) event.preventDefault();
      wheel.distance += Math.abs(event.deltaX);
      if (wheel.distance < swipeDistance) return;
      const button = wheel.button;
      wheel.button = undefined;
      activate(button);
    }

    function cancelTouch() {
      touch = undefined;
      clearTimeout(hold);
    }

    function onTouchStart(event: TouchEvent) {
      cancelTouch();
      const start = event.touches[0];
      const row = event.touches.length === 1 && messageRow(event.target);
      if (!row || !start) return;
      touch = { row, id: start.identifier, x: start.clientX, y: start.clientY };
      hold = setTimeout(() => {
        if (touch?.row !== row) return;
        const button = row.querySelector<HTMLButtonElement>("[data-message-menu][aria-expanded=false]");
        cancelTouch();
        activate(button);
      }, holdDelay);
    }

    function onTouchMove(event: TouchEvent) {
      const point = event.touches[0];
      if (!touch || event.touches.length !== 1 || point?.identifier !== touch.id) {
        cancelTouch();
        return;
      }
      const horizontal = touch.x - point.clientX;
      const vertical = Math.abs(touch.y - point.clientY);
      if (Math.abs(horizontal) > 8 || vertical > 8) clearTimeout(hold);
      if (vertical >= 12 && vertical >= Math.abs(horizontal)) cancelTouch();
      else if (Math.abs(horizontal) >= 12 && Math.abs(horizontal) > vertical * 1.5
        && actionOn(touch.row, horizontal > 0) && event.cancelable) event.preventDefault();
    }

    function onTouchEnd(event: TouchEvent) {
      const start = touch;
      cancelTouch();
      const point = event.changedTouches[0];
      if (!start || event.touches.length || point?.identifier !== start.id) return;
      const horizontal = start.x - point.clientX;
      if (Math.abs(horizontal) < swipeDistance || Math.abs(horizontal) <= Math.abs(start.y - point.clientY) * 1.5) return;
      const button = actionOn(start.row, horizontal > 0);
      if (!button) return;
      if (event.cancelable) event.preventDefault();
      activate(button);
    }

    list.addEventListener("wheel", onWheel, { passive: false });
    list.addEventListener("touchstart", onTouchStart, { passive: true });
    list.addEventListener("touchmove", onTouchMove, { passive: false });
    list.addEventListener("touchend", onTouchEnd, { passive: false });
    list.addEventListener("touchcancel", cancelTouch);
    return () => {
      clearTimeout(resetWheel);
      cancelTouch();
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchstart", onTouchStart);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("touchend", onTouchEnd);
      list.removeEventListener("touchcancel", cancelTouch);
    };
  }, [listRef, scope, enabled]);
}
