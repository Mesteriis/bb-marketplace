import { useTelegramLocale } from "../../ui/i18n/index.tsx";
import { experimental_useAppPanel, experimental_usePanelTabs, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent } from "react";

const desktopQuery = "(min-width: 768px)";
const detailsTab = { id: "chat-details", context: { kind: "nav-panel", panelId: "telegram" }, availability: "fixed" } as const;

function subscribeDesktop(listener: () => void) {
  const query = window.matchMedia?.(desktopQuery);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

export function useTelegramWorkspaceMode() {
  const split = useSidebarSplitLayout();
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia?.(desktopQuery).matches ?? false, () => false);
  return desktop && !split;
}

// The nav page and BB's panel slots mount as separate React trees.
function createOutlet() {
  let target: HTMLDivElement | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => target,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: HTMLDivElement | null, previous?: HTMLDivElement) {
      if ((previous && target !== previous) || target === next) return;
      target = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const sidebarOutlet = createOutlet();
const detailsOutlet = createOutlet();
const noOutlet = () => null;

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
}

function useOutletRef(outlet: ReturnType<typeof createOutlet>, fitSidebar = false) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scroll = fitSidebar ? scrollParent(element) : undefined;
    let paddingBottom = 0;
    if (scroll) {
      for (let parent = element.parentElement; parent && parent !== scroll; parent = parent.parentElement) {
        paddingBottom += parseFloat(getComputedStyle(parent).paddingBottom) || 0;
      }
    }
    let intersects = true;
    function update() {
      if (!element) return;
      if (scroll) {
        const offset = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        element.style.height = `${Math.max(0, Math.floor(scroll.clientHeight - offset - paddingBottom))}px`;
      }
      if (intersects && element.clientWidth && element.clientHeight && getComputedStyle(element).visibility !== "hidden") outlet.set(element);
      else outlet.set(null, element);
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (scroll) observer.observe(scroll);
    const visibility = fitSidebar ? new IntersectionObserver(([entry]) => {
      intersects = (entry?.intersectionRect.width ?? 0) > 0;
      update();
    }) : undefined;
    visibility?.observe(element);
    return () => {
      observer.disconnect();
      visibility?.disconnect();
      outlet.set(null, element);
    };
  }, [outlet, fitSidebar]);
  return ref;
}

export function TelegramSidebarOutlet() {
  const { t: tr } = useTelegramLocale();
  const workspace = useTelegramWorkspaceMode();
  return workspace ? <WorkspaceSidebar /> : <p className="mtg-workspace-hint">{tr("Open the Telegram pane to see chats and folders.")}</p>;
}

function WorkspaceSidebar() {
  const { locale: uiLocale } = useTelegramLocale();
  const ref = useOutletRef(sidebarOutlet, true);
  return <div lang={uiLocale} data-bb-ru-skip className="mtg mtg-workspace-outlet" onContextMenu={suppressOutletBackgroundMenu}>
    <div ref={ref} className="mtg-sidebar-outlet" onContextMenu={suppressOutletBackgroundMenu} />
  </div>;
}

function suppressOutletBackgroundMenu(event: MouseEvent<HTMLElement>) {
  if (event.target === event.currentTarget) event.preventDefault();
}

export function TelegramDetailsOutlet() {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const ref = useOutletRef(detailsOutlet);
  return <div lang={uiLocale} data-bb-ru-skip className="mtg mtg-workspace-outlet" onContextMenu={suppressOutletBackgroundMenu}>
    <p className="mtg-workspace-hint" onContextMenu={suppressOutletBackgroundMenu}>{tr("Select a chat to see its details.")}</p>
    <div ref={ref} className="mtg-details-outlet" onContextMenu={suppressOutletBackgroundMenu} />
  </div>;
}

export function useTelegramWorkspace(settingsOpen = false) {
  const enabled = useTelegramWorkspaceMode();
  const panel = experimental_useAppPanel();
  const { open: rightPanelOpen } = experimental_usePanelTabs();
  useLayoutEffect(() => {
    if (settingsOpen && rightPanelOpen) panel.close();
  }, [panel, rightPanelOpen, settingsOpen]);
  const sidebar = useSyncExternalStore(sidebarOutlet.subscribe, sidebarOutlet.get, noOutlet);
  const details = useSyncExternalStore(detailsOutlet.subscribe, detailsOutlet.get, noOutlet);
  const openDetails = useCallback(() => enabled && panel.openTab({ tab: detailsTab }), [enabled, panel]);
  const closeDetails = useCallback(() => panel.close(), [panel]);
  return { sidebar: enabled ? sidebar ?? undefined : undefined, details: enabled ? details : null, openDetails, closeDetails };
}
