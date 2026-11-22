// Keeps the ChatGPT window on the reserved area while the page is visible,
// and hides it when the page goes away. Sends only when something changed.
import { useEffect, type RefObject } from "react";
import { HIDDEN_ATTACHMENT, sameAttachment, type Attachment } from "../core/attachment.ts";
import { measureAttachment } from "./measure.ts";

/** How often to look for a moved page window that did not report a resize. */
export const POLL_MS = 500;

export function useAttachment(target: RefObject<Element | null>, send: (view: Attachment) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let last: Attachment | null = null;
    const report = () => {
      const next = measureAttachment(target.current, window, document.visibilityState === "visible");
      if (last !== null && sameAttachment(last, next)) return;
      last = next;
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
      send(HIDDEN_ATTACHMENT);
    };
  }, [target, send, enabled]);
}
