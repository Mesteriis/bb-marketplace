// Keeps the ChatGPT window on the reserved area while the page is visible,
// and hides it when the page goes away. Sends when something changed, and
// repeats now and then so a page whose window was taken over gets it back.
import { useEffect, type RefObject } from "react";
import { hiddenFor, sameAttachment, type Attachment } from "../core/attachment.ts";
import { measureAttachment } from "./measure.ts";

/** How often to look for a moved page window that did not report a resize. */
export const POLL_MS = 500;
/** How often an unchanged placement is sent again. */
export const HEARTBEAT_MS = 2_000;

function newOwner(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useAttachment(target: RefObject<Element | null>, send: (view: Attachment) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const owner = newOwner();
    let last: Attachment | null = null;
    let sentAt = 0;
    const report = () => {
      const next = measureAttachment(target.current, window, document.visibilityState === "visible", owner);
      const now = Date.now();
      if (last !== null && sameAttachment(last, next) && (!next.visible || now - sentAt < HEARTBEAT_MS)) return;
      last = next;
      sentAt = now;
      send(next);
    };
    report();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(report) : null;
    if (target.current !== null) observer?.observe(target.current);
    window.addEventListener("resize", report);
    document.addEventListener("visibilitychange", report);
    const timer = setInterval(report, POLL_MS);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", report);
      document.removeEventListener("visibilitychange", report);
      clearInterval(timer);
      send(hiddenFor(owner));
    };
  }, [target, send, enabled]);
}
