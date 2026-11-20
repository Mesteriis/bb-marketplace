import { useEffect, useRef, type RefObject } from "react";
import type { Message } from "../core/demo.ts";

export type MarkHistoryRead = (chatId: string, messageId: string, topicId?: number, clearUnreadMark?: true) => Promise<boolean>;

type ReadReceipt = { id: number; clearUnreadMark?: true };
type ReadState = {
  confirmed?: ReadReceipt;
  pending?: ReadReceipt;
  queued?: ReadReceipt;
  retry?: { receipt: ReadReceipt; after: number; attempted: boolean };
};

export function readableHistoryIds(messages: readonly Message[] | undefined, inbox: number | undefined, deleted?: ReadonlySet<string>, clearUnreadMark?: true) {
  const rows = (messages ?? []).filter((message) => !message.retained && !message.pendingDelivery
    && !message.failedDelivery && !deleted?.has(message.id) && /^[1-9]\d{0,15}$/.test(message.id));
  const unread = rows.filter(({ id, outgoing }) => !outgoing && (inbox === undefined || Number(id) > inbox));
  return (unread.length || !clearUnreadMark ? unread : rows).map(({ id }) => id).join(" ");
}

export function useVisibleHistoryRead({ list, chatId, topicId, messageIds, enabled, clearUnreadMark, mark, onVisible }: {
  list: RefObject<HTMLOListElement | null>;
  chatId: string;
  topicId?: number;
  messageIds: string;
  enabled: boolean;
  clearUnreadMark?: true;
  mark?: MarkHistoryRead;
  onVisible?: (ids: readonly string[]) => void;
}) {
  const state = useRef<ReadState>({});
  const recheck = useRef<(() => void) | undefined>(undefined);
  useEffect(() => { state.current = {}; }, [chatId, topicId]);
  useEffect(() => {
    if (!enabled || (!mark && !onVisible) || !messageIds || typeof IntersectionObserver !== "function") return;
    const history = list.current;
    if (!history) return;
    const ids = new Set(messageIds.split(" "));
    const visible = new Map<HTMLElement, IntersectionObserverEntry>();
    const observed = new Set<HTMLElement>();
    const scope = state.current;
    let active = true;
    let frame = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      if (!active || history.hidden || document.visibilityState !== "visible") return;
      // IntersectionObserver still reports rows behind a native modal's backdrop.
      if (Array.from(document.querySelectorAll("dialog:modal")).some((dialog) => !dialog.contains(history))) return;
      let id = 0;
      const visibleIds: string[] = [];
      const scrollport = history.getBoundingClientRect();
      for (const [row, entry] of visible) {
        const messageId = row.dataset.messageId;
        if (!messageId || !history.contains(row)) continue;
        // A jump or layout shift can move a row before the next observer delivery.
        if (entry.rootBounds && !overlapsReadViewport(row.getBoundingClientRect(), scrollport, entry.rootBounds)) continue;
        id = Math.max(id, Number(messageId));
        if (onVisible) visibleIds.push(messageId);
      }
      if (visibleIds.length) onVisible?.(visibleIds);
      const { confirmed, pending, queued, retry } = scope;
      if (queued && queued.clearUnreadMark === clearUnreadMark && ids.has(String(queued.id))) id = Math.max(id, queued.id);
      if (!mark || !id || (confirmed && confirmed.id >= id && confirmed.clearUnreadMark === clearUnreadMark)) return;
      const receipt = { id, clearUnreadMark };
      if (pending) {
        if (pending.id < id || pending.clearUnreadMark !== clearUnreadMark) scope.queued = receipt;
        return;
      }
      const retrying = retry?.receipt.id === id && retry.receipt.clearUnreadMark === clearUnreadMark;
      if (retrying) {
        if (retry.attempted) return;
        const wait = retry.after - Date.now();
        if (wait > 0) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(scheduleSend, wait);
          return;
        }
        retry.attempted = true;
      }
      scope.queued = undefined;
      scope.pending = receipt;
      void mark(chatId, String(id), topicId, clearUnreadMark).catch(() => false).then((ok) => {
        if (state.current !== scope) return;
        scope.pending = undefined;
        if (ok) {
          scope.confirmed = receipt;
          scope.retry = undefined;
        } else if (!retrying) {
          scope.retry = { receipt, after: Date.now() + 500, attempted: false };
        }
        // React may have replaced this observer while Telegram was acknowledging the read.
        if (!ok || scope.queued) recheck.current?.();
      });
    };
    const scheduleSend = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        send();
      });
    };
    const retryVisibleRead = () => {
      if (scope.retry?.attempted) scope.retry = undefined;
      scheduleSend();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") retryVisibleRead();
    };
    recheck.current = scheduleSend;
    // Threshold 0 alone can report edge contact without reporting the first visible pixel.
    // The viewport root also clips rows against the enclosing BB panel.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        if (observed.has(row) && entry.isIntersecting && entry.intersectionRatio > 0) visible.set(row, entry);
        else visible.delete(row);
      }
      scheduleSend();
    }, { threshold: [0, Number.EPSILON] });
    const syncRows = () => {
      for (const row of observed) {
        if (history.contains(row) && ids.has(row.dataset.messageId ?? "")) continue;
        observed.delete(row);
        visible.delete(row);
        observer.unobserve(row);
      }
      for (const row of Array.from(history.querySelectorAll<HTMLElement>("[data-message-id]"))) {
        if (observed.has(row) || !ids.has(row.dataset.messageId ?? "")) continue;
        observed.add(row);
        observer.observe(row);
      }
    };
    syncRows();
    // Album regrouping can replace DOM rows while keeping the same message IDs.
    const mutations = new MutationObserver((records) => {
      for (const { addedNodes, removedNodes } of records) {
        if ([...Array.from(addedNodes), ...Array.from(removedNodes)].some((node) => node instanceof Element
          && (node.matches("[data-message-id]") || node.querySelector("[data-message-id]")))) {
          syncRows();
          break;
        }
      }
    });
    mutations.observe(history, { childList: true, subtree: true });
    // Dialogs can close in place or unmount without a close event.
    const modals = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes"
        ? record.target instanceof HTMLDialogElement
        : [...Array.from(record.removedNodes), ...Array.from(record.addedNodes)].some((node) => node instanceof Element
          && (node.matches("dialog") || node.querySelector("dialog[open]"))))) scheduleSend();
    });
    modals.observe(document.body, { attributes: true, attributeFilter: ["open"], childList: true, subtree: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", retryVisibleRead);
    return () => {
      active = false;
      if (recheck.current === scheduleSend) recheck.current = undefined;
      cancelAnimationFrame(frame);
      clearTimeout(retryTimer);
      modals.disconnect();
      mutations.disconnect();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", retryVisibleRead);
    };
  }, [chatId, topicId, messageIds, enabled, clearUnreadMark, list, mark, onVisible]);
}

function overlapsReadViewport(row: DOMRectReadOnly, scrollport: DOMRectReadOnly, viewport: DOMRectReadOnly) {
  return Math.min(row.right, scrollport.right, viewport.right) > Math.max(row.left, scrollport.left, viewport.left)
    && Math.min(row.bottom, scrollport.bottom, viewport.bottom) > Math.max(row.top, scrollport.top, viewport.top);
}
