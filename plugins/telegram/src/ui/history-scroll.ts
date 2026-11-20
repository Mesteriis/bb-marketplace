import type { HistoryPage } from "../core/contract.ts";

export type ReadingPlaces = Map<string, { chatId: string; messageId: string }>;

export type HistoryViewport = Omit<ReturnType<typeof captureHistoryScroll>, "row">;

export function createHistoryView() {
  const viewports = new Map<string, { page: HistoryPage; position: HistoryViewport }>();
  return {
    places: new Map() as ReadingPlaces,
    get: (key: string) => viewports.get(key),
    forget: (key: string) => viewports.delete(key),
    remember(key: string, page: HistoryPage, { mode, top, height, rowId, rowOffset }: HistoryViewport) {
      viewports.delete(key);
      viewports.set(key, { page, position: { mode, top, height, rowId, rowOffset } });
      if (viewports.size > 12) viewports.delete(viewports.keys().next().value!);
    },
  };
}

export type HistoryView = ReturnType<typeof createHistoryView>;

export function rememberReadingPlace(places: ReadingPlaces, chatId: string, messageId: string, topicId?: number) {
  const key = topicId === undefined ? chatId : `${chatId}:${topicId}`;
  places.delete(key);
  places.set(key, { chatId, messageId });
  if (places.size > 32) places.delete(places.keys().next().value!);
}

export function isAwayFromLatest(list: HTMLElement) {
  return list.scrollHeight - list.clientHeight - list.scrollTop > 64;
}

type ScrollDirection = "up" | "down";

export function historyWheelDirection(event: Pick<WheelEvent, "deltaX" | "deltaY" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">) {
  if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || !(Math.abs(event.deltaY) > Math.abs(event.deltaX))) return;
  return event.deltaY < 0 ? "up" : "down";
}

export function historyPageKey(event: Pick<KeyboardEvent, "target" | "currentTarget" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  direction: ScrollDirection, focusedRow?: HTMLElement) {
  if ((event.target !== event.currentTarget && event.target !== focusedRow) || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
  return direction === "up" ? ["ArrowUp", "PageUp", "Home"].includes(event.key)
    : ["ArrowDown", "PageDown", "End"].includes(event.key);
}

export function focusHistoryMessage(list: HTMLElement | null, id: string) {
  const row = Array.from(list?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
    .find((item) => item.dataset.messageId === id);
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: "center" });
}

export function focusUnreadBoundary(list: HTMLOListElement, divider: HTMLElement, messageId: string) {
  const row = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  (row ?? list).focus({ preventScroll: true });
  list.scrollTop += divider.getBoundingClientRect().top - list.getBoundingClientRect().top;
}

export function captureHistoryScroll(list: HTMLElement, mode: "keep" | "prepend", excluded?: ReadonlySet<string>) {
  const viewport = list.getBoundingClientRect();
  const bottom = viewport.top + (list.clientHeight || viewport.height);
  let row: HTMLElement | undefined;
  let rowOffset: number | undefined;
  for (const item of Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"))) {
    if (excluded?.has(item.dataset.messageId ?? "")) continue;
    const rect = item.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= bottom) continue;
    if (!row || rect.top >= viewport.top) {
      row = item;
      rowOffset = rect.top - viewport.top;
    }
    // A visible row start survives height changes inside a clipped row above it.
    if (rect.top >= viewport.top) break;
  }
  return { mode, top: list.scrollTop, height: list.scrollHeight, row, rowId: row?.dataset.messageId, rowOffset };
}

export function restoreHistoryScroll(list: HTMLElement, position: HistoryViewport & { row?: HTMLElement }) {
  if (restoreHistoryRow(list, position)) return;
  const shift = position.mode === "prepend" ? list.scrollHeight - position.height : 0;
  list.scrollTop = Math.max(0, position.top + shift);
}

function restoreHistoryRow(list: HTMLElement, { row, rowId, rowOffset }: HistoryViewport & { row?: HTMLElement }) {
  if (rowOffset === undefined || rowId === undefined) return false;
  if (!row || row.dataset.messageId !== rowId || !list.contains(row)) {
    row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]")).find((item) => item.dataset.messageId === rowId);
  }
  if (!row) return false;
  const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  list.scrollTop += offset - rowOffset;
  return true;
}

export function observeHistoryResize(list: HTMLElement, isActive: () => boolean, followsLatest: () => boolean, onAdjusted: () => void,
  restored?: HistoryViewport) {
  if (typeof ResizeObserver !== "function") return;
  let position = restored ? { ...restored, top: list.scrollTop, height: list.scrollHeight, row: undefined }
    : captureHistoryScroll(list, "keep");
  let width = list.clientWidth;
  let height = list.clientHeight;
  function rememberPosition() {
    // Resizing can clamp scrollTop before the observer has restored the visible row.
    const sameGeometry = list.clientWidth === width && list.clientHeight === height && list.scrollHeight === position.height;
    if (isActive() && (!position.rowId || sameGeometry) && list.scrollTop !== position.top) {
      position = captureHistoryScroll(list, "keep");
    }
  }
  const observer = new ResizeObserver(() => {
    if (!isActive()) return;
    width = list.clientWidth;
    height = list.clientHeight;
    if (followsLatest()) {
      list.scrollTop = list.scrollHeight;
      position = captureHistoryScroll(list, "keep");
    } else if (restoreHistoryRow(list, position)) {
      // Keep the original row across consecutive reflows. A taller viewport can
      // temporarily expose a different row without the user moving the history.
      position = { ...position, top: list.scrollTop, height: list.scrollHeight };
    } else {
      position = captureHistoryScroll(list, "keep");
    }
    onAdjusted();
  });
  list.addEventListener("scroll", rememberPosition, { passive: true });
  observer.observe(list);
  let rows = new Set<Element>();
  const syncRows = () => {
    const current = new Set([...Array.from(list.children), ...Array.from(list.querySelectorAll("[data-message-id]"))]);
    for (const row of rows) if (!current.has(row)) observer.unobserve(row);
    for (const row of current) if (!rows.has(row)) observer.observe(row, { box: "border-box" });
    rows = current;
  };
  syncRows();
  const mutations = new MutationObserver((records) => {
    if (records.some(({ target, addedNodes, removedNodes }) => target === list
      || [...Array.from(addedNodes), ...Array.from(removedNodes)].some((node) => node instanceof Element
        && (node.matches("[data-message-id]") || node.querySelector("[data-message-id]"))))) syncRows();
  });
  mutations.observe(list, { childList: true, subtree: true });
  return () => {
    list.removeEventListener("scroll", rememberPosition);
    mutations.disconnect();
    observer.disconnect();
  };
}
