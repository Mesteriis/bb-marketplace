import { useTelegramLocale } from "./i18n/index.tsx";
import type { SharedContentCounts } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { CommonGroups, type CommonGroupLoader } from "./common-groups.tsx";
import { Bell, ChevronDown, ChevronRight, Cpu, Image, Info, Search, Settings, Settings2, Users, X } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isPlainKey } from "./composer-keys.ts";

export function ChatDetails({ chatId, name, avatar, subtitle, load, change, browse, loadCounts, children, conversationActions, recentActions, members, notifications, commonGroups, openChat, clearCache, openRequest, onDismiss, sidePanel, leaving }: {
  chatId: string;
  openRequest?: number;
  onDismiss?: () => void;
  leaving?: boolean;
  sidePanel?: { target: HTMLElement | null; open: () => boolean; close?: () => boolean };
  name: string;
  avatar?: ReactNode;
  subtitle?: string;
  members?: ReactNode;
  notifications?: ReactNode;
  load?: (id: string) => Promise<boolean>;
  change?: (id: string, enabled: boolean) => Promise<boolean>;
  browse?: (counts: SharedContentCounts) => void;
  clearCache?: (id: string) => Promise<{ cleanupDeferred?: true }>;
  loadCounts?: (id: string) => Promise<SharedContentCounts>;
  children?: ReactNode;
  conversationActions?: (dismiss: () => void) => ReactNode;
  commonGroups?: CommonGroupLoader;
  openChat?: (chat: Chat) => void;
  recentActions?: (dismiss: () => void) => ReactNode;
}) {
  const { locale, t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastRequest = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cacheStatus, setCacheStatus] = useState<"busy" | "done" | "failed" | "deferred">();
  const clearingCache = useRef(false);
  const [counts, setCounts] = useState<SharedContentCounts>({});
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState<Set<string>>();
  const sections = useRef<HTMLDivElement>(null);
  const canBrowse = browse !== undefined;
  const visible = open || !!sidePanel?.target;

  useEffect(() => {
    if (!visible || !canBrowse || !loadCounts) return;
    let active = true;
    void loadCounts(chatId).then((result) => { if (active) setCounts(result); }).catch(() => {});
    return () => { active = false; };
  }, [visible, chatId, loadCounts, canBrowse]);

  useEffect(() => {
    if (!visible || !load) return;
    let active = true;
    void load(chatId).then(
      (value) => { if (active) setEnabled(value); },
      () => { if (active) setError("Could not load AI access."); },
    );
    return () => { active = false; };
  }, [visible, chatId, load]);

  async function update(value: boolean) {
    if (!change) return;
    setBusy(true);
    setError("");
    setSearch("");
    setMatches(undefined);
    try { setEnabled(await change(chatId, value)); }
    catch { setError("Could not change AI access."); }
    finally { setBusy(false); }
  }

  async function clearMedia() {
    if (!clearCache || clearingCache.current) return;
    clearingCache.current = true;
    setCacheStatus("busy");
    try {
      const result = await clearCache(chatId);
      setCacheStatus(result.cleanupDeferred ? "deferred" : "done");
    } catch { setCacheStatus("failed"); }
    finally { clearingCache.current = false; }
  }

  function openDetails() {
    if (sidePanel?.open()) return;
    const element = dialog.current;
    if (!element || element.open) return;
    setEnabled(undefined);
    setCounts({});
    setError("");
    element.showModal();
    setOpen(true);
  }

  function closeDetails() {
    if (sidePanel?.target) {
      if (sidePanel.close?.()) {
        onDismiss?.();
        trigger.current?.focus();
      }
    } else dialog.current?.close();
  }

  useEffect(() => {
    if (openRequest === undefined || lastRequest.current === openRequest) return;
    lastRequest.current = openRequest;
    openDetails();
  }, [openRequest]);

  useEffect(() => {
    const element = dialog.current;
    const conversation = trigger.current?.closest(".mtg-conversation");
    if (!open || !element || !conversation) return;
    function positionSheet() {
      if (!element || !conversation) return;
      const bounds = conversation.getBoundingClientRect();
      const compact = bounds.width > 0 && bounds.width <= 670;
      element.dataset.presentation = compact ? "sheet" : "dialog";
      if (!compact) return;
      element.style.setProperty("--mtg-sheet-left", `${Math.max(0, bounds.left)}px`);
      element.style.setProperty("--mtg-sheet-right", `${Math.max(0, window.innerWidth - bounds.right)}px`);
      element.style.setProperty("--mtg-sheet-bottom", `${Math.max(0, window.innerHeight - bounds.bottom)}px`);
      element.style.setProperty("--mtg-sheet-height", `${Math.min(bounds.height, window.innerHeight) * .76}px`);
    }
    positionSheet();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(positionSheet) : undefined;
    observer?.observe(conversation);
    window.addEventListener("resize", positionSheet);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionSheet);
    };
  }, [open]);

  const access = load && change && <>
      {enabled === undefined ? !error && <p role="status">{tr("Loading AI access…")}</p> : <>
        <label><input type="checkbox" checked={enabled} disabled={busy}
          onChange={(event) => void update(event.target.checked)} />{tr(" Allow AI to search and read this chat")}</label>
        <p>{tr("Agents can share the requested history with their model provider without a reading confirmation.")}</p>
      </>}
      {error && <p role="alert">{tr(error)}</p>}
    </>;
  const memberTools = <>
      {members}
      {visible && commonGroups && openChat && <CommonGroups id={chatId} load={commonGroups} onOpen={(chat) => {
        closeDetails();
        openChat(chat);
      }} />}
    </>;
  const settings = <>
      {conversationActions?.(closeDetails)}
      {visible && clearCache && <details>
        <summary>{tr("Media cache")}</summary>
        <button type="button" className="mtg-action" disabled={cacheStatus === "busy"}
          onClick={() => void clearMedia()}>{tr("Clear media cache for this chat")}</button>
        {cacheStatus === "busy" && <p role="status">{tr("Clearing this chat’s media cache…")}</p>}
        {cacheStatus === "done" && <p role="status">{tr("Media cache cleanup finished for this chat.")}</p>}
        {cacheStatus === "deferred" && <p role="status">{tr("Retry cache cleanup after the active media transfer finishes.")}</p>}
        {cacheStatus === "failed" && <p role="alert">{tr("Could not clear this chat’s media cache.")}</p>}
      </details>}
      {visible && (children || recentActions) && <div className="mtg-chat-detail-actions">
        {children}
        {recentActions?.(closeDetails)}
      </div>}
  </>;
  const items = [
    { id: "notifications", title: tr("Notifications"), Icon: Bell, body: notifications },
    { id: "members", title: tr("Members"), Icon: Users, body: members || commonGroups && openChat ? memberTools : undefined },
    { id: "ai", title: tr("AI access"), Icon: Cpu, body: access },
    { id: "settings", title: tr("Chat settings"), Icon: Settings, body: settings },
  ];
  const content = <>
    <div className="mtg-detail-profile">{avatar}<div><h2><bdi>{name}</bdi></h2>{subtitle && <small>{tr(subtitle)}</small>}</div></div>
    <label className="mtg-detail-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={tr("Search settings and actions")}
      placeholder={tr("Search settings and actions")} value={search} onChange={(event) => {
        const value = event.currentTarget.value;
        const words = value.toLocaleLowerCase(locale).trim().split(/\s+/).filter(Boolean);
        setSearch(value);
        setMatches(words.length ? new Set(Array.from(sections.current?.querySelectorAll<HTMLElement>("[data-detail-section]") ?? [])
          .filter((element) => {
            const text = `${element.textContent ?? ""} ${element.dataset.searchTerms ?? ""}`.toLocaleLowerCase(locale);
            return words.every((word) => text.includes(word));
          })
          .map((element) => element.dataset.detailSection!)) : undefined);
      }} /></label>
    <div className="mtg-detail-sections" ref={sections} hidden={matches?.size === 0}>
      {browse && <button type="button" className="mtg-library-entry" data-detail-section="media"
        hidden={matches !== undefined && !matches.has("media")} aria-label={tr("Shared media")}
        aria-description={counts.photoVideo === undefined ? undefined : tr("{0} messages", [counts.photoVideo.toLocaleString(locale)])}
        data-search-terms={["Photos and videos", "Files", "Links", "Audio", "Voice and video messages", "GIFs"].map((label) => tr(label)).join(" ")}
        onClick={() => { dialog.current?.close(); browse(counts); }}>
        <Image size={17} aria-hidden="true" /><span>{tr("Shared media")}</span>
        {counts.photoVideo !== undefined && <span className="mtg-shared-count">{counts.photoVideo.toLocaleString(locale)}</span>}
        <ChevronRight size={14} aria-hidden="true" />
      </button>}
      {items.filter(({ body }) => body).map(({ id, title, Icon, body }) => <details key={id} data-detail-section={id}
        hidden={matches !== undefined && !matches.has(id)} open={matches ? matches.has(id) : id === "settings" && openRequest !== undefined || undefined}>
        <summary><Icon size={17} aria-hidden="true" /><span>{title}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="mtg-detail-section-body">{body}</div>
      </details>)}
    </div>
    {matches?.size === 0 && <p role="status">{tr("No matching settings or actions.")}</p>}
  </>;
  return <>
    <Button ref={trigger} type="button" variant="ghost" size="icon" aria-label={tr("Chat details")} aria-haspopup={sidePanel ? undefined : "dialog"}
      aria-keyshortcuts={"Alt+Shift+I Control+\\"} onClick={openDetails}>
      <Settings2 size={16} aria-hidden="true" />
    </Button>
    {sidePanel?.target && !open ? createPortal(
      <section className="mtg-chat-inspector mtg-detail-overview" data-leaving={leaving || undefined} inert={leaving}
        aria-hidden={leaving || undefined} aria-label={tr("Telegram chat details")} onKeyDown={(event) => {
        if (!sidePanel.close || event.defaultPrevented || !isPlainKey(event, "Escape")
          || !(event.target instanceof Element) || event.target.closest("dialog")) return;
        event.preventDefault();
        event.stopPropagation();
        closeDetails();
      }}>
        <header className="mtg-details-heading"><Info size={18} aria-hidden="true" /><strong>{tr("About this chat")}</strong>
          {sidePanel.close && <Button type="button" variant="ghost" size="icon" aria-label={tr("Close")} onClick={closeDetails}><X size={16} aria-hidden="true" /></Button>}
        </header>
        {content}
    </section>, sidePanel.target) : <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details mtg-detail-overview" aria-label={tr("Chat details")} onKeyDown={(event) => {
      if (!isPlainKey(event, "Escape") || !(event.target instanceof Element) || event.target.closest("dialog") !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.close();
    }} onClick={(event) => {
      const element = event.currentTarget;
      if (event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) element.close();
    }} onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        setOpen(false);
        onDismiss?.();
      }}>
        <header className="mtg-details-heading">
          <Info size={18} aria-hidden="true" /><strong>{tr("About this chat")}</strong>
          <Button type="button" variant="ghost" size="icon" aria-label={tr("Done")}
            disabled={busy} onClick={() => dialog.current?.close()}><X size={17} aria-hidden="true" /></Button>
        </header>
        {content}
      </dialog>}
  </>;
}
