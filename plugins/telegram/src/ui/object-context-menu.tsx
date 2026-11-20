import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

const controlSelector = "button, [role=button], a[href], summary, input[type=checkbox], input[type=radio]";
const editable = "textarea, input:not([type=checkbox]):not([type=radio]), select, [contenteditable]:not([contenteditable=false])";

export type ContextAction = { label: string; run: () => void };
type Menu = { target: HTMLElement; actions: ContextAction[]; point?: { x: number; y: number } };

export function contextMenuKey(event: KeyboardEvent) {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function contextSelection(target: Element, point?: Menu["point"]) {
  const selection = target.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(target)) return;
  if (point && typeof range.getClientRects === "function" && !Array.from(range.getClientRects()).some((rect) =>
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom)) return;
  return selection.toString();
}

export function contextControl(target: Element) {
  const control = target.closest<HTMLElement>(controlSelector);
  const labeled = target.closest("label")?.control;
  return control ?? (labeled?.matches(controlSelector) ? labeled : null);
}

function available(control: HTMLElement) {
  if (control.matches(":disabled,[aria-disabled=true]") || control.closest("[hidden],[inert],dialog:not([open])")) return false;
  const closed = control.closest("details:not([open])");
  return !closed || closed === control || !!closed.querySelector(":scope > summary")?.contains(control);
}

export function controlActions(controls: Iterable<HTMLElement>): ContextAction[] {
  return Array.from(controls).flatMap((control) => {
    if (!available(control)) return [];
    const label = (control.dataset.contextLabel || control.getAttribute("aria-label") ||
      control.getAttribute("title") || (control instanceof HTMLInputElement && control.labels?.[0]?.textContent) ||
      control.textContent || "").trim();
    if (!label) return [];
    return [{ label, run: () => {
      if (control.isConnected && available(control)) control.click();
    } }];
  });
}

function objectActions(target: Element, point?: Menu["point"]) {
  const text = contextSelection(target, point);
  if (text && typeof navigator.clipboard?.writeText === "function") {
    return [{ label: "Copy selected text", run: () => { void navigator.clipboard.writeText(text).catch(() => {}); } }];
  }
  const control = contextControl(target);
  if (control instanceof HTMLAnchorElement) {
    if (!available(control)) return [];
    const url = control.href;
    return [
      { label: "Open link", run: () => { if (control.isConnected && available(control)) control.click(); } },
      ...(typeof navigator.clipboard?.writeText === "function"
        ? [{ label: "Copy link", run: () => { void navigator.clipboard.writeText(url).catch(() => {}); } }] : []),
    ];
  }
  if (control) return controlActions([control]);
  const media = target.closest<HTMLMediaElement>("video, audio");
  if (media?.controls) return [
    { label: media.paused ? "Play" : "Pause", run: () => { if (media.paused) void media.play().catch(() => {}); else media.pause(); } },
    { label: media.muted ? "Unmute" : "Mute", run: () => { media.muted = !media.muted; } },
  ];
  const photo = target.closest(".mtg-photo-image");
  const viewer = photo?.closest("dialog.mtg-photo-viewer[open]");
  if (viewer) return controlActions(Array.from(viewer.querySelectorAll<HTMLElement>(
    ".mtg-viewer-actions button, .mtg-viewer-details button, .mtg-viewer-arrow, .mtg-photo-zoom-controls button")));

  const object = target.closest<HTMLElement>("[data-context-object]");
  if (!object) return [];
  const commands = object.querySelector(":scope > [data-context-commands]");
  const controls = commands?.querySelectorAll<HTMLElement>(controlSelector) ?? object.querySelectorAll<HTMLElement>(controlSelector);
  return controlActions(Array.from(controls).filter((item) => item.closest("[data-context-object]") === object));
}

export function useObjectContextMenu(scope: string) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState<Menu & { scope: string }>();
  const menu = open?.scope === scope ? open : undefined;
  const popup = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = popup.current;
    if (!menu || !panel) return;
    const { target, point } = menu;
    const native = typeof panel.showPopover === "function";
    const view = target.ownerDocument.defaultView;
    const bounds = target.closest("dialog, .mtg-conversation, .mtg-workspace-outlet, .mtg-layout")?.getBoundingClientRect();
    if (!view) return;
    if (native) panel.showPopover();
    const margin = 6;
    const left = Math.max(0, bounds?.left ?? 0) + margin;
    const right = Math.min(view.innerWidth, bounds?.right ?? view.innerWidth) - margin;
    const top = Math.max(0, bounds?.top ?? 0) + margin;
    const bottom = Math.min(view.innerHeight, bounds?.bottom ?? view.innerHeight) - margin;
    const anchor = target.getBoundingClientRect();
    const width = Math.max(0, Math.min(264, right - left));
    panel.style.setProperty("--mtg-message-menu-width", `${width}px`);
    const height = Math.min(panel.scrollHeight, Math.max(0, bottom - top));
    panel.style.setProperty("--mtg-message-menu-left", `${Math.max(left, Math.min(point?.x ?? anchor.left, right - width))}px`);
    panel.style.setProperty("--mtg-message-menu-top", `${Math.max(top, Math.min(point?.y ?? anchor.bottom, bottom - height))}px`);
    panel.style.setProperty("--mtg-message-menu-bottom", "auto");
    panel.style.setProperty("--mtg-message-menu-height", `${height}px`);
    panel.querySelector("button")?.focus({ preventScroll: true });

    function outside(event: Event) {
      if (event.target instanceof Node && !panel?.contains(event.target)) setOpen(undefined);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(undefined);
      target.focus({ preventScroll: true });
    }
    const doc = target.ownerDocument;
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("focusin", outside, true);
    doc.addEventListener("keydown", escape, true);
    view.addEventListener("scroll", outside, true);
    view.addEventListener("resize", outside);
    return () => {
      if (native && panel.matches(":popover-open")) panel.hidePopover();
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("focusin", outside, true);
      doc.removeEventListener("keydown", escape, true);
      view.removeEventListener("scroll", outside, true);
      view.removeEventListener("resize", outside);
    };
  }, [menu]);

  function show(target: Element, point?: Menu["point"], extra: ContextAction[] = []) {
    if (target.closest(".mtg-message-actions")) return;
    const actions = [...objectActions(target, point), ...extra];
    const anchor = contextControl(target) ?? target.closest("[data-context-object],.mtg-photo-image,video,audio") ?? target;
    setOpen(actions.length && anchor instanceof HTMLElement ? { target: anchor, actions, point, scope } : undefined);
  }

  const content = menu && <div ref={popup} className="mtg-message-actions mtg-object-context-menu" popover="manual"
    data-open="true" role="group" aria-label={tr("Object actions")} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault();
      event.stopPropagation();
      buttons[next]?.focus();
    }}>
    <div className="mtg-message-menu-commands">
      {menu.actions.map((action, index) => <button key={index} type="button" className="mtg-action" onClick={() => {
        setOpen(undefined);
        if (menu.target.isConnected) {
          menu.target.focus({ preventScroll: true });
          action.run();
        }
      }}>{tr(action.label)}</button>)}
    </div>
  </div>;
  const dialog = menu?.target.closest("dialog[open]");
  return {
    content: dialog ? createPortal(content, dialog) : content,
    onContextMenu(event: MouseEvent, extra?: ContextAction[]) {
      if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest(editable)) return;
      event.preventDefault();
      event.stopPropagation();
      show(event.target, { x: event.clientX, y: event.clientY }, extra);
    },
    onKeyDown(event: KeyboardEvent, extra?: ContextAction[]) {
      if (event.defaultPrevented || !contextMenuKey(event) || !(event.target instanceof Element) || event.target.closest(editable)) return;
      event.preventDefault();
      event.stopPropagation();
      show(event.target, undefined, extra);
    },
  };
}
