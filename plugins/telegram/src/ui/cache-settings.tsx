import { createPortal } from "react-dom";
import { useTelegramLocale } from "./i18n/index.tsx";
import { ArrowDownUp, ArrowLeft, Bell, Bot, BriefcaseBusiness, Database, Folder, FolderCog, Monitor, RefreshCw, Search, Settings, Shield, TabletSmartphone } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cacheLimitMiB, cacheRetentionDays, type CacheInfo, type ClearableCacheCategory } from "../core/contract.ts";
import type { QuickReplyReference } from "./quick-replies.tsx";

import type { MessageDoubleClick } from "./message-double-click.ts";
import { KeyboardShortcutList } from "./keyboard-shortcuts.tsx";
import { formatSize } from "./format-size.ts";
import "./settings-workspace.css";

const cacheCategoryLabels = {
  photos: "Photos", videos: "Videos and GIFs", audio: "Audio and voice messages", documents: "Documents",
  stickers: "Stickers", previews: "Avatars and thumbnails", wallpapers: "Wallpapers", other: "Other files",
};

const settingKeywords = {
  language: "interface language translation default system язык интерфейс перевод русский",
  desktopAlerts: "system desktop notifications permission background системные уведомления баннер разрешение фон",
  agents: "agent AI permission access history send read агенты ии доступ чтение отправка",
  cache: "media cache storage disk size limit clear cleanup keep unused days retention expire кэш кеш диск очистка лимит срок хранения дней",
  keyboardShortcuts: "keyboard shortcuts hotkeys help keybindings горячие клавиши сочетания клавиатура",
  chatGestures: "chat gestures double click mouse reply quick reaction чат жесты двойной клик щелчок ответ реакция",
  automaticPlayback: "automatic autoplay playback video gif видео гиф автовоспроизведение",
  automaticDownloads: "automatic auto media download photo video document wifi cache автоматическая загрузка фото видео файлы",
  downloads: "downloads files queue pause загрузки скачивание файлы",
  network: "network usage statistics traffic telegram proxy socks5 http mtproto сеть трафик прокси",
  dataExport: "export account chats data history html json tar archive экспорт история",
  business: "telegram business address location map hours time zone opening quick replies shortcuts templates start page welcome greeting away offline chatbot bot automation автоответ бизнес адрес координаты часы работы быстрые ответы шаблоны страница приветствие",
  accounts: "telegram accounts add switch rename qr login аккаунт переключить вход",
  folders: "folders create rename edit parent hierarchy папки создать переименовать вложенность иерархия",
  profile: "profile name username photo bio birthday public link qr профиль имя аватар юзернейм",
  stars: "stars subscriptions payments renewal звёзды звезды подписки оплата продление",
  devices: "active devices inactive sessions terminate disconnect сеансы устройства сессии",
  calls: "calls incoming receive accept phone voice video звонки принять принимать входящие голосовые видеозвонки",
  notifications: "notifications defaults exceptions sounds mute messages preview reaction stories unread counter badge уведомления звук непрочитанные",
  privacy: "privacy phone last seen profile photos bio birthday blocked users groups forwarding read time auto delete show 18+ sensitive content disable filtering приватность номер блокировка автоудаление чувствительный контент",
} as const;

type SettingSection = keyof typeof settingKeywords;
const settingsLabels: Record<SettingSection, string> = {
  language: "Language and translation", desktopAlerts: "System notifications", agents: "Agent access",
  cache: "Media cache", keyboardShortcuts: "Keyboard shortcuts", chatGestures: "Chat gestures",
  automaticPlayback: "Automatic playback", automaticDownloads: "Automatic media downloads", downloads: "Downloads",
  network: "Network", dataExport: "Data export", business: "Telegram Business", accounts: "Accounts", folders: "Folders",
  profile: "Profile", stars: "Stars", devices: "Devices", calls: "Calls", notifications: "Notifications", privacy: "Privacy",
};
const categories: { id: string; label: string; icon: typeof Settings; sections: SettingSection[] }[] = [
  { id: "interface", label: "Interface", icon: Monitor, sections: ["language", "keyboardShortcuts", "chatGestures"] },
  { id: "notifications", label: "Notifications", icon: Bell, sections: ["desktopAlerts", "notifications", "calls"] },
  { id: "media", label: "Media and storage", icon: Database, sections: ["cache", "automaticDownloads", "automaticPlayback", "downloads"] },
  { id: "accounts", label: "Accounts and devices", icon: TabletSmartphone, sections: ["accounts", "profile", "devices", "stars"] },
  { id: "privacy", label: "Privacy", icon: Shield, sections: ["privacy"] },
  { id: "folders", label: "Folders and chats", icon: Folder, sections: ["folders"] },
  { id: "agents", label: "Agents", icon: Bot, sections: ["agents"] },
  { id: "business", label: "Business", icon: BriefcaseBusiness, sections: ["business"] },
  { id: "network", label: "Network and export", icon: ArrowDownUp, sections: ["network", "dataExport"] },
];

const recentSettingsKey = "makosh.telegram.recentSettings";
const maxRecentSettings = 6;

function loadRecentSettings(): SettingSection[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentSettingsKey) ?? "[]");
    if (Array.isArray(value)) return [...new Set(value.filter((item): item is SettingSection =>
      typeof item === "string" && Object.hasOwn(settingsLabels, item)))].slice(0, maxRecentSettings);
  } catch { /* The profile can decline browser storage. */ }
  return [];
}

export function CacheSettings({ read, setLimit, clear, clearChat, devices, openDevicesRequest, accounts, openFolders, privacy, profile, stars, notifications, calls, network, dataExport, downloads, automaticDownloads, automaticPlayback, chatGestures, business, openQuickReplyRequest, closeQuickReply, workspace, openWorkspace }: {
  workspace?: { sidebar?: HTMLElement; back: () => void; language: ReactNode; desktopAlerts: ReactNode; agents: ReactNode };
  openWorkspace?: () => void;
  devices?: ReactNode | ((openForReview: boolean) => ReactNode);
  openDevicesRequest?: number;
  accounts?: ReactNode;
  openFolders?: () => void;
  network?: ReactNode;
  dataExport?: ReactNode;
  business?: ReactNode;
  openQuickReplyRequest?: QuickReplyReference;
  closeQuickReply?: () => void;
  automaticDownloads?: ReactNode;
  automaticPlayback?: ReactNode;
  chatGestures?: { doubleClick: MessageDoubleClick; setDoubleClick: (action: MessageDoubleClick) => void };
  downloads?: ReactNode | ((close: () => boolean) => ReactNode);
  notifications?: ReactNode;
  calls?: ReactNode;
  profile?: ReactNode;
  stars?: ReactNode | ((close: () => boolean) => ReactNode);
  privacy?: ReactNode | ((close: () => void) => ReactNode);
  read: () => Promise<CacheInfo>;
  setLimit: (limitMiB: number, retentionDays?: number) => Promise<CacheInfo>;
  clear: (category?: ClearableCacheCategory) => Promise<CacheInfo>;
  clearChat?: (id: string) => Promise<CacheInfo>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsRoot = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<SettingSection>(undefined);
  const [category, setCategory] = useState(categories[0]!);
  const searchField = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLUListElement>(null);
  const [recent, setRecent] = useState(loadRecentSettings);
  const [opened, setOpened] = useState(false);
  const [reviewingDevices, setReviewingDevices] = useState(false);
  const [search, setSearch] = useState("");
  const [info, setInfo] = useState<CacheInfo>();
  const [draft, setDraft] = useState("");
  const [retention, setRetention] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const parsed = cacheLimitMiB.safeParse(Number(draft));
  const age = cacheRetentionDays.safeParse(retention.trim() ? Number(retention) : NaN);
  const ageChanged = age.success && age.data !== (info?.retentionDays ?? 0);
  const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const sections = { language: workspace?.language, desktopAlerts: workspace?.desktopAlerts, agents: workspace?.agents, downloads, automaticDownloads, automaticPlayback, chatGestures, network, dataExport, accounts, folders: openFolders, profile, stars, devices, calls, notifications, privacy, business };
  function matches(section: keyof typeof settingKeywords) {
    const label = tr(settingsLabels[section]).toLocaleLowerCase();
    return words.every((word) => label.includes(word) || settingKeywords[section].includes(word));
  }
  const allSections: SettingSection[] = ["cache", "keyboardShortcuts",
    ...(Object.keys(sections) as (keyof typeof sections)[]).filter((section) => sections[section] != null)];
  const query = words.join(" ");
  const results = allSections.filter(matches).sort((a, b) =>
    Number(tr(settingsLabels[b]).toLocaleLowerCase() === query) - Number(tr(settingsLabels[a]).toLocaleLowerCase() === query));
  const filteredRecent = recent.filter((section) => allSections.includes(section));
  const navigation = query ? results : workspace ? [] : filteredRecent;
  function sectionProps(section: SettingSection) {
    return { hidden: workspace ? !category.sections.includes(section) : !matches(section), "aria-label": tr(settingsLabels[section]), "data-setting-section": section, tabIndex: -1 };
  }

  useEffect(() => {
    try {
      if (recent.length) localStorage.setItem(recentSettingsKey, JSON.stringify(recent));
      else localStorage.removeItem(recentSettingsKey);
    } catch { /* Search history stays in memory when browser storage is unavailable. */ }
  }, [recent]);

  function focusSection(section: SettingSection) {
    const target = (settingsRoot.current ?? dialog.current)?.querySelector<HTMLElement>(`[data-setting-section="${section}"]`);
    if (!target || target.hidden) return;
    const disclosure = target.querySelector<HTMLDetailsElement>(":scope > details:only-child");
    if (disclosure) disclosure.open = true;
    const focus = disclosure?.querySelector("summary") ?? target;
    focus.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "start" });
  }

  function openSearchResult(section: SettingSection) {
    setRecent((previous) => [section, ...previous.filter((item) => item !== section)].slice(0, maxRecentSettings));
    if (!workspace) { focusSection(section); return; }
    const destination = categories.find((item) => item.sections.includes(section));
    if (!destination) return;
    setSearch("");
    if (destination === category) focusSection(section);
    else {
      pendingFocus.current = section;
      setCategory(destination);
    }
  }

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    const destination = pendingFocus.current;
    pendingFocus.current = undefined;
    if (destination) focusSection(destination);
  }, [category]);

  useEffect(() => {
    if (workspace && category.id === "media" && !info && !busy && !error) load();
  }, [workspace, category, info, busy, error]);

  useLayoutEffect(() => {
    const target = dialog.current;
    if (workspace || !openDevicesRequest || !target) return;
    setSearch("active devices");
    setReviewingDevices(true);
    if (!target.open) target.showModal();
    setOpened(true);
  }, [openDevicesRequest]);

  useLayoutEffect(() => {
    const target = dialog.current;
    if (workspace || !openQuickReplyRequest || !target) return;
    setSearch("quick replies");
    setReviewingDevices(false);
    if (!target.open) target.showModal();
    setOpened(true);
  }, [openQuickReplyRequest]);

  async function run(work: () => Promise<CacheInfo>, failure: string, success?: (result: CacheInfo) => string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      setInfo(result);
      setDraft(String(result.limitMiB));
      setRetention(String(result.retentionDays ?? 0));
      setNotice(success?.(result) ?? "");
    } catch { setError(failure); }
    finally { setBusy(false); }
  }

  function load() { void run(read, "Could not read the Telegram media cache."); }

  function save(event: FormEvent) {
    event.preventDefault();
    if (parsed.success && age.success) void run(() => ageChanged ? setLimit(parsed.data, age.data) : setLimit(parsed.data), "Could not save the cache limit.", (result) =>
      result.cleanupDeferred ? "Cache limit saved. Automatic cleanup will resume after active media transfers finish."
        : result.bytes > result.limitMiB * 1024 * 1024 ? "Cache limit saved. Current usage is still above the limit."
          : "Cache limit saved.");
  }

  function clearMedia(category?: ClearableCacheCategory) {
    void run(() => category ? clear(category) : clear(), "Could not clear the cache.", (result) => {
      if (result.cleanupDeferred) return "Retry cache cleanup after the active media transfer finishes.";
      if (category) return `Cleanup finished for ${cacheCategoryLabels[category].toLowerCase()}. Telegram reports ${formatSize(result.bytes)} total still on disk.`;
      return result.bytes === 0 ? "Media cache cleared."
        : `Cleanup finished. Telegram reports ${formatSize(result.bytes)} still on disk.`;
    });
  }

  function closeSettings() {
    if (workspace) { workspace.back(); return true; }
    if (!dialog.current?.open) return false;
    dialog.current.close();
    return true;
  }

  const searchBox = <>
      <label className="mtg-settings-search">{workspace ? <Search size={17} aria-hidden="true" /> : tr("Search Telegram settings ")}<input ref={searchField} type="search" value={search} maxLength={128}
        aria-label={workspace ? tr("Search Telegram settings") : undefined} placeholder={workspace ? tr("Find a setting") : undefined}
        onChange={(event) => setSearch(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "Escape" && search) {
            event.preventDefault();
            setSearch("");
          } else if (event.key === "ArrowDown" && navigation.length) {
            event.preventDefault();
            resultList.current?.querySelector("button")?.focus();
          } else if (event.key === "Enter" && query && results[0]) {
            event.preventDefault();
            if (!event.repeat) openSearchResult(results[0]);
          }
        }} /></label>
      {navigation.length > 0 && <div className="mtg-settings-search-results">
        <ul ref={resultList} aria-label={query ? tr("Settings search results") : tr("Recent settings")}>
          {navigation.map((section, index) => <li key={section}>
            <button type="button" className="mtg-action"
              onClick={() => openSearchResult(section)} onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                const buttons = resultList.current?.querySelectorAll("button");
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (index) buttons?.[index - 1]?.focus();
                  else searchField.current?.focus();
                } else if (event.key === "ArrowDown" && index + 1 < navigation.length) {
                  event.preventDefault();
                  buttons?.[index + 1]?.focus();
                }
              }}>{!workspace && tr("Go to ")}{tr(settingsLabels[section])}
                {workspace && <small>{tr(categories.find((item) => item.sections.includes(section))?.label ?? "")}</small>}</button>
          </li>)}
        </ul>
        {!query && <button type="button" className="mtg-action" onClick={() => {
          setRecent([]);
          searchField.current?.focus();
        }}>{tr("Clear recent settings")}</button>}
      </div>}
      {query && !results.length && <p role="status">{tr("No settings match this search.")}</p>}
  </>;
  const content = <>
      {workspace && <section {...sectionProps("language")}>{workspace.language}</section>}
      {workspace && <section {...sectionProps("desktopAlerts")}>{workspace.desktopAlerts}</section>}
      {workspace && category.sections.includes("agents") && <section {...sectionProps("agents")}>{workspace.agents}</section>}
      {openFolders && <section {...sectionProps("folders")}>
        <h2>{tr("Folders")}</h2>
        <button className="mtg-action" type="button" onClick={() => {
          dialog.current?.close();
          openFolders();
        }}><FolderCog size={16} aria-hidden="true" />{tr("Manage folders")}</button>
      </section>}
      <section {...sectionProps("cache")}>
        <h2>{tr("Media cache")}</h2>
        {info && <>
          <p>{tr("On disk: ")}<strong>{formatSize(info.bytes)}</strong></p>
          {!!info.breakdown?.length && <details>
            <summary>{tr("Cache by media type")}</summary>
            <dl>{info.breakdown.map(({ category, bytes }) => <div key={category}>
              <dt>{tr(cacheCategoryLabels[category])}</dt>
              <dd>{formatSize(bytes)} {category !== "other" && <button type="button" className="mtg-action" disabled={busy}
                aria-label={tr("Clear {0} cache", [cacheCategoryLabels[category].toLowerCase()])} onClick={() => clearMedia(category)}>{tr("Clear")}</button>}</dd>
            </div>)}</dl>
          </details>}
          {!!info.chats?.length && <details>
            <summary>{tr("Largest chat caches")}</summary>
            <dl>{info.chats.map(({ id, title, bytes }) => <div key={id}>
              <dt><bdi>{title}</bdi></dt>
              <dd>{formatSize(bytes)} {clearChat && <button type="button" className="mtg-action" disabled={busy}
                aria-label={tr("Clear cache for {0}", [title])} onClick={() => void run(() => clearChat(id), "Could not clear the chat cache.",
                  (result) => result.cleanupDeferred ? "Retry cache cleanup after the active media transfer finishes."
                    : `Chat cache cleanup finished. Telegram reports ${formatSize(result.bytes)} total still on disk.`)}>{tr("Clear")}</button>}</dd>
            </div>)}</dl>
          </details>}
          <form className="mtg-cache-limit" onSubmit={save}>
            <label>{tr("Cache limit (MiB) ")}<input type="number" min={64} max={32768} step={1} required
              value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} /></label>
            <label>{tr("Keep unused media (days) ")}<input type="number" min={0} max={365} step={1} required
              value={retention} disabled={busy} onChange={(event) => setRetention(event.target.value)} /></label>
            <button type="submit" className="mtg-action" disabled={busy || !parsed.success || !age.success || (parsed.data === info.limitMiB && !ageChanged)}>{tr("Save limit")}</button>
          </form>
          <p>{tr("BB removes older cached media first when usage exceeds the size limit. While Telegram is connected, BB checks hourly for media you have not used within the selected number of days. Set days to 0 to disable cleanup by age.")}</p>
          <button type="button" className="mtg-action" disabled={busy || info.bytes === 0}
            onClick={() => clearMedia()}>{tr("Clear cache")}</button>
          <p>{tr("Clearing media keeps your Telegram session and message history.")}</p>
        </>}
        {busy && <p role="status">{tr("Updating cache information…")}</p>}
        {notice && <p role="status">{tr(notice)}</p>}
        {error && <p role="alert">{tr(error)}</p>}
      </section>
      {(opened || (workspace && category.sections.includes("downloads"))) && downloads != null && <section {...sectionProps("downloads")}>
        {typeof downloads === "function" ? downloads(closeSettings) : downloads}
      </section>}
      {automaticDownloads != null && <section {...sectionProps("automaticDownloads")}>{automaticDownloads}</section>}
      {automaticPlayback != null && <section {...sectionProps("automaticPlayback")}>{automaticPlayback}</section>}
      <section {...sectionProps("keyboardShortcuts")}><details>
        <summary>{tr("Keyboard shortcuts")}</summary>
        <KeyboardShortcutList />
      </details></section>
      {chatGestures && <section {...sectionProps("chatGestures")}><details>
        <summary>{tr("Chat gestures")}</summary>
        <label>{tr("Double-click a message ")}<select value={chatGestures.doubleClick} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "reply" || value === "reaction" || value === "off") chatGestures.setDoubleClick(value);
        }}>
          <option value="reply">{tr("Reply")}</option>
          <option value="reaction">{tr("Quick reaction")}</option>
          <option value="off">{tr("Do nothing")}</option>
        </select></label>
      </details></section>}
      {network != null && <section {...sectionProps("network")}>{network}</section>}
      {dataExport != null && <section {...sectionProps("dataExport")}>{dataExport}</section>}
      {(opened || (workspace && category.sections.includes("business"))) && business != null && <section {...sectionProps("business")}>{business}</section>}
      {(opened || (workspace && category.sections.includes("accounts"))) && accounts != null && <section {...sectionProps("accounts")}>{accounts}</section>}
      {profile != null && <section {...sectionProps("profile")}>{profile}</section>}
      {(opened || (workspace && category.sections.includes("stars"))) && stars != null && <section {...sectionProps("stars")}>
        {typeof stars === "function" ? stars(closeSettings) : stars}
      </section>}
      {(opened || (workspace && category.sections.includes("devices"))) && devices != null && <section {...sectionProps("devices")}>
        {typeof devices === "function" ? devices(reviewingDevices) : devices}
      </section>}
      {(opened || (workspace && category.sections.includes("calls"))) && calls != null && <section {...sectionProps("calls")}>{calls}</section>}
      {notifications != null && (!workspace || category.sections.includes("notifications")) && <section {...sectionProps("notifications")}>{notifications}</section>}
      {privacy != null && <section {...sectionProps("privacy")}>
        {typeof privacy === "function" ? privacy(closeSettings) : privacy}
      </section>}
      <div className="mtg-agent-settings-actions">
        {(workspace ? category.id === "media" : matches("cache")) && <button type="button" className="mtg-action" disabled={busy} onClick={load}><RefreshCw size={16} aria-hidden="true" />{tr("Refresh size")}</button>}
        {!workspace && <button type="button" className="mtg-action" onClick={closeSettings}>{tr("Done")}</button>}
      </div>
  </>;

  if (workspace) {
    const sidebar = <aside className="mtg-settings-nav" data-sidebar-outlet={!!workspace.sidebar || undefined}>
      <header>
        <button type="button" className="mtg-settings-back" aria-label={tr("Back to Telegram")} title={tr("Back to Telegram")}
          onClick={workspace.back}><ArrowLeft size={19} aria-hidden="true" /></button>
        <h1>{tr("Telegram settings")}</h1>
      </header>
      {searchBox}
      {!query && <nav aria-label={tr("Settings sections")}>
        {categories.filter((item) => item.sections.some((section) => allSections.includes(section))).map((item) =>
          <button type="button" key={item.id} aria-current={item === category ? "page" : undefined} onClick={() => setCategory(item)}>
            <item.icon size={19} aria-hidden="true" /><span>{tr(item.label)}</span>
          </button>)}
      </nav>}
    </aside>;
    return <div className="mtg-settings-workspace" data-sidebar-outlet={!!workspace.sidebar || undefined} ref={settingsRoot}>
      {workspace.sidebar ? createPortal(sidebar, workspace.sidebar) : sidebar}
      <section className="mtg-settings-content" ref={contentRef} aria-label={tr(category.label)}>
        <h2>{tr(category.label)}</h2>
        {content}
      </section>
    </div>;
  }

  return <>
    <button type="button" aria-haspopup={openWorkspace ? undefined : "dialog"} aria-label={tr("Telegram settings")} onClick={() => {
      if (openWorkspace) { openWorkspace(); return; }
      setSearch("");
      setReviewingDevices(false);
      dialog.current?.showModal();
      setOpened(true);
      load();
    }}><Settings size={20} aria-hidden="true" /><span>{tr("Settings")}</span></button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details" aria-label={tr("Telegram settings")} onClose={() => {
      setOpened(false);
      if (openQuickReplyRequest) closeQuickReply?.();
    }}>
      {searchBox}
      {content}
    </dialog>
  </>;
}
