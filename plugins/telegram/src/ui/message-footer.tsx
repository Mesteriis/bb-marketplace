import { useTelegramLocale } from "./i18n/index.tsx";
import { Ellipsis, Info, Reply } from "lucide-react";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button } from "../../components/ui/button.tsx";
import type { Message } from "../core/demo.ts";
import { MessageMenuSlot } from "./message-action-slot.tsx";
import { MessageInspectorAction } from "./message-inspector.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { contextControl, contextMenuKey, contextSelection, controlActions, type ContextAction } from "./object-context-menu.tsx";

const mediaControls = ".mtg-photo-open, .mtg-video-open, .mtg-video-download, button.mtg-document";

export function openMessageMenu(event: MouseEvent<HTMLLIElement>) {
  if (event.defaultPrevented || !(event.target instanceof Element) ||
    !event.target.closest(".mtg-bubble") ||
    event.target.closest("input, select, textarea, dialog, audio, video, [contenteditable], .mtg-file-unavailable, .mtg-message-actions")) return;
  const control = contextControl(event.target);
  if (control && !control.closest(".mtg-message-footer") && !control.matches(mediaControls)) return;
  if (contextSelection(event.target, { x: event.clientX, y: event.clientY }) && typeof navigator.clipboard?.writeText === "function") return;
  const trigger = event.currentTarget.querySelector<HTMLButtonElement>("[data-message-menu]");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
}

export function messageMenuKey(event: KeyboardEvent<HTMLLIElement>) {
  if (event.defaultPrevented || !contextMenuKey(event) || !(event.target instanceof Element)) return;
  const control = contextControl(event.target);
  if (control && !control.closest(".mtg-message-footer") && !control.matches(mediaControls)) return;
  const trigger = event.currentTarget.querySelector<HTMLButtonElement>("[data-message-menu]");
  if (!trigger) return;
  event.preventDefault(); event.stopPropagation();
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
}

export function MessageFooter({ message, chatId, beforeTime, afterTime, reply, selectionActions, children }: {
  message: Message;
  chatId?: string;
  beforeTime?: ReactNode;
  afterTime?: ReactNode;
  reply?: ReactNode;
  selectionActions?: (dismiss: () => void) => ReactNode;
  children?: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const inspector = useContext(MessageInspectorAction);
  const slot = useContext(MessageMenuSlot);
  const trigger = useRef<HTMLButtonElement>(null);
  const info = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const scope = `${chatId ?? ""}:${message.id}`;
  const [openScope, setOpenScope] = useState<string>();
  const [hasCommands, setHasCommands] = useState(false);
  const [media, setMedia] = useState<ContextAction[]>([]);
  const open = openScope === scope;

  function close(restore = false) {
    setOpenScope(undefined);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  const selectionCommands = selectionActions?.(() => close(true));

  useLayoutEffect(() => {
    const footer = menu.current?.parentElement;
    if (inspector || !footer) return;
    const update = () => setHasCommands(controlActions(Array.from(footer.querySelectorAll<HTMLElement>(
      ".mtg-quick-reply button, .mtg-message-actions button, .mtg-message-actions a[href]"))).length > 0);
    update();
    const observer = new MutationObserver(update);
    observer.observe(footer, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "href", "hidden", "aria-disabled"] });
    return () => observer.disconnect();
  }, [!!inspector, scope]);

  function toggle() {
    if (open) { close(); return; }
    const bubble = trigger.current?.closest(".mtg-bubble");
    const controls = bubble?.querySelectorAll<HTMLElement>(mediaControls);
    setMedia(controls ? controlActions(Array.from(controls)) : []);
    setOpenScope(scope);
  }

  useEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const panel = menu.current;
    const button = trigger.current;
    const native = typeof panel.showPopover === "function";
    if (native && !panel.matches(":popover-open")) panel.showPopover();
    const conversation = button.closest(".mtg-conversation");
    const history = button.closest(".mtg-history");
    function place(event?: Event) {
      if (event?.target instanceof Node && panel.contains(event.target)) return;
      const anchor = button.getBoundingClientRect();
      const bounds = conversation?.getBoundingClientRect();
      const rows = history?.getBoundingClientRect();
      if (event && rows && (anchor.bottom < rows.top || anchor.top > rows.bottom)) { close(); return; }
      const right = Math.min(bounds?.right ?? innerWidth, innerWidth);
      const left = Math.max(bounds?.left ?? 0, 0);
      const top = Math.max(bounds?.top ?? 0, 0);
      const bottom = Math.min(bounds?.bottom ?? innerHeight, innerHeight);
      const width = Math.max(0, Math.min(264, right - left - 12));
      panel.style.setProperty("--mtg-message-menu-width", `${width}px`);
      const below = bottom - anchor.bottom - 8;
      const above = anchor.top - top - 8;
      const fitsBelow = panel.scrollHeight <= below || below >= above;
      panel.style.setProperty("--mtg-message-menu-left", `${Math.max(left + 6, Math.min(anchor.right - width, right - width - 6))}px`);
      panel.style.setProperty("--mtg-message-menu-top", fitsBelow ? `${anchor.bottom + 4}px` : "auto");
      panel.style.setProperty("--mtg-message-menu-bottom", fitsBelow ? "auto" : `${innerHeight - anchor.top + 4}px`);
      panel.style.setProperty("--mtg-message-menu-height", `${Math.max(0, fitsBelow ? below : above)}px`);
    }
    place();
    panel.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !panel.contains(event.target) && !button.contains(event.target)) close();
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
        event.target instanceof Element && event.target.closest("dialog")) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : undefined;
    if (conversation) observer?.observe(conversation);
    for (const group of Array.from(panel.children)) observer?.observe(group);
    return () => {
      observer?.disconnect();
      if (native && panel.matches(":popover-open")) panel.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, scope]);

  return <div className="mtg-message-footer">
    <div className="mtg-quick-reply">{reply}</div>
    <div className="mtg-message-time">
      {beforeTime}
      <MessageTimestamp message={message} compact />
      {afterTime}
      {inspector && <Button ref={info} variant="ghost" size="icon" type="button" aria-label={tr("Message information")}
        data-swipe-info aria-expanded={!!info.current && inspector.selected === info.current}
        onClick={(event) => { close(); inspector.toggle(message, event.currentTarget, chatId); }}>
        <Info size={15} aria-hidden="true" />
      </Button>}
      {(inspector || hasCommands || selectionCommands || open) && <Button ref={trigger} variant="ghost" size="icon" type="button" aria-label={tr("Message options")} data-message-menu
        aria-controls={menuId} aria-expanded={open} onClick={toggle}>
        <Ellipsis size={16} aria-hidden="true" />
      </Button>}
    </div>
    <div ref={menu} id={menuId} className="mtg-message-actions" popover="manual" data-open={open}
      role={open ? "group" : undefined} aria-label={open ? tr("Message actions") : undefined}
      onKeyDown={(event) => {
        if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest("dialog")) return;
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          || !event.target.matches("button") || event.target.closest(".mtg-edit, .mtg-reaction-picker")) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"))
          .filter((button) => !button.closest("dialog") && button.getClientRects().length);
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus();
      }}>
      <div ref={slot?.setReactions} className="mtg-message-menu-reactions" />
      <div className="mtg-message-menu-commands">
      {open && media.map(({ label, run }, index) => <button key={index} type="button" className="mtg-action"
        onClick={() => { close(); run(); }}>{label}</button>)}
      {open && reply && <button type="button" className="mtg-action" onClick={() => {
        const footer = menu.current?.parentElement;
        const target = footer?.querySelector<HTMLButtonElement>(".mtg-quick-reply button:enabled");
        if (target) { close(); target.click(); }
      }}><Reply size={15} aria-hidden="true" />{tr("Reply")}</button>}
      {open && selectionCommands}
      {open && inspector && <button type="button" className="mtg-action" onClick={() => info.current?.click()}>
        <Info size={15} aria-hidden="true" />{tr("Message information")}</button>}
      {children}
      <div ref={slot?.setTarget} className="mtg-message-extra-actions" />
      </div>
    </div>
  </div>;
}
