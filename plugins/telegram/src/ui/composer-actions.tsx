import { useTelegramLocale } from "./i18n/index.tsx";
import { File, Image, Paperclip, Upload, Video, X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/button.tsx";
import type { DraftAttachment } from "./local-drafts.ts";
import { photoAccept } from "./prepare-photo.ts";
import { videoAttachmentAccept } from "../core/contract.ts";

type Attachments = Record<DraftAttachment["kind"], boolean>;
const ActionsSlot = createContext<{
  primary: HTMLElement | null;
  more: HTMLElement | null;
  registerPrimary: (target: HTMLElement | null) => void;
  registerMore: (target: HTMLElement | null) => void;
} | undefined>(undefined);

export function ComposerActions({ children }: { children: ReactNode }) {
  const [primary, registerPrimary] = useState<HTMLElement | null>(null);
  const [more, registerMore] = useState<HTMLElement | null>(null);
  return <ActionsSlot.Provider value={{ primary, more, registerPrimary, registerMore }}>{children}</ActionsSlot.Provider>;
}

export function ComposerActionEntry({ children, primary = false, inline = false, keepOpen = false }: {
  children: ReactNode; primary?: boolean; inline?: boolean; keepOpen?: boolean;
}) {
  const slot = useContext(ActionsSlot);
  const target = primary ? slot?.primary : slot?.more;
  return target && !inline ? createPortal(keepOpen ? <div data-keep-composer-open>{children}</div> : children, target) : children;
}

const fileTypes = [
  { kind: "photo", input: "Choose photo", action: "Attach photo", topicInput: "Choose a topic photo", topicAction: "Attach topic photo", accept: photoAccept, Icon: Image },
  { kind: "video", input: "Choose video", action: "Attach video", topicInput: "Choose a topic video", topicAction: "Attach topic video", accept: videoAttachmentAccept, Icon: Video },
  { kind: "document", input: "Choose document", action: "Attach document", topicInput: "Choose a topic document", topicAction: "Attach topic document", accept: undefined, Icon: File },
] as const;

export function ComposerActionMenu({ allowed, disabled, topic, pickFiles, pickFile }: {
  allowed: Attachments;
  disabled: boolean;
  topic?: boolean;
  pickFiles: (files: File[]) => void;
  pickFile: (file: File, kind: DraftAttachment["kind"]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const slot = useContext(ActionsSlot);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const allFiles = useRef<HTMLInputElement>(null);
  const typed = useRef<Partial<Record<DraftAttachment["kind"], HTMLInputElement>>>({});
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const visibleTypes = fileTypes.filter(({ kind }) => allowed[kind]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const button = trigger.current;
    if (!panel || !button) return;
    const native = typeof panel.showPopover === "function";
    if (native && !panel.matches(":popover-open")) panel.showPopover();
    const workspace = button.closest(".mtg-conversation");
    const composer = button.closest("form");

    function place() {
      if (!panel || !button) return;
      const anchor = button.getBoundingClientRect();
      const composerTop = composer?.getBoundingClientRect().top ?? anchor.top;
      const bounds = workspace?.getBoundingClientRect();
      const embedded = button.closest<HTMLElement>(".mtg-layout")?.dataset.layout !== "workspace";
      const compact = embedded && (button.closest(".mtg")?.clientWidth || window.innerWidth) <= 670;
      panel.dataset.compact = String(compact);
      const width = compact && bounds ? bounds.width - 12 : Math.min(312, (bounds?.width ?? window.innerWidth) - 16);
      const edge = Math.max(8, Math.min(anchor.left, (bounds?.right ?? window.innerWidth) - width - 8));
      panel.style.setProperty("--composer-menu-left", `${compact && bounds ? bounds.left + 6 : edge}px`);
      panel.style.setProperty("--composer-menu-width", `${Math.max(0, width)}px`);
      panel.style.setProperty("--composer-menu-bottom", `${Math.max(8, window.innerHeight - composerTop + 6)}px`);
      panel.style.setProperty("--composer-menu-height", `${Math.max(72, composerTop - Math.max(8, bounds?.top ?? 0) - 12)}px`);
    }

    place();
    panel.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !panel?.contains(event.target) && !button?.contains(event.target)) close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.target instanceof Node && panel?.contains(event.target) ||
        event.target instanceof Element && event.target.closest("dialog")) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    function selectEntry(event: MouseEvent) {
      const route = event.composedPath();
      if (route.some((part) => part instanceof HTMLElement && part.hasAttribute("data-keep-composer-open"))) return;
      if (route.some((part) => part instanceof HTMLButtonElement)
        && route.some((part) => part instanceof HTMLElement && part.hasAttribute("data-composer-entries"))) close(true);
    }
    function anchorScroll(event: Event) {
      if (event.target instanceof Node && panel?.contains(event.target)) return;
      place();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    panel.addEventListener("click", selectEntry);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", anchorScroll, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
    if (workspace) observer?.observe(workspace);
    if (composer) observer?.observe(composer);
    return () => {
      if (native && panel.matches(":popover-open")) panel.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      panel.removeEventListener("click", selectEntry);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", anchorScroll, true);
      observer?.disconnect();
    };
  }, [open]);

  return <>
    <Button ref={trigger} type="button" variant="ghost" size="icon" aria-label={tr("Attachments and actions")} data-composer-attachments
      aria-controls={id} aria-expanded={open} disabled={disabled}
      onClick={() => { if (open) close(); else { setAll(false); setOpen(true); } }}>
      <Paperclip size={17} aria-hidden="true" />
    </Button>
    {visibleTypes.length > 0 && <input ref={allFiles} type="file" aria-label={tr("Choose files")} multiple hidden
      disabled={disabled} accept={allowed.document ? undefined : visibleTypes.map((type) => type.accept).join(",")}
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) pickFiles(files);
      }} />}
    {visibleTypes.map(({ kind, input, topicInput, accept }) => <input key={kind} type="file" hidden accept={accept}
      aria-label={topic ? topicInput : input} disabled={disabled}
      ref={(element) => { if (element) typed.current[kind] = element; else delete typed.current[kind]; }}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) pickFile(file, kind);
      }} />)}
    <div ref={menu} id={id} popover="manual" hidden={!open} className="mtg-composer-menu"
      role="group" aria-label={tr("Composer actions")} onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing ||
          event.target instanceof Element && event.target.closest("dialog")) return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}>
      <div className="mtg-composer-menu-heading">
        <strong>{tr("Attachments")}</strong>
        <Button type="button" variant="ghost" size="icon" aria-label={tr("Close composer actions")} onClick={() => close(true)}>
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      {visibleTypes.length > 0 && <button type="button" className="mtg-composer-menu-row" disabled={disabled}
        onClick={() => { allFiles.current?.click(); close(true); }}><Upload size={16} aria-hidden="true" />{tr(" Choose files")}</button>}
      <div ref={slot?.registerPrimary} className="mtg-composer-menu-entries" data-composer-entries />
      <details className="mtg-composer-menu-more" open={all} onToggle={(event) => setAll(event.currentTarget.open)}>
        <summary>{tr("All actions")}</summary>
        {visibleTypes.map(({ kind, action, topicAction, Icon }) => <button key={kind} type="button" className="mtg-composer-menu-row"
          disabled={disabled} onClick={() => { typed.current[kind]?.click(); close(true); }}>
          <Icon size={16} aria-hidden="true" /> {topic ? topicAction : action}
        </button>)}
        <div ref={slot?.registerMore} className="mtg-composer-menu-entries" data-composer-entries />
      </details>
    </div>
  </>;
}
