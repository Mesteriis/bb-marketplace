import { Avatar, type AvatarLoader } from "./avatar.tsx";
import { useTelegramLocale } from "./i18n/index.tsx";
import { Bell, Check, ChevronDown, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MessageNotification } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export function MessageNotificationBanner({ notification, chat, load, open, dismiss, markRead, markingOther = false, inList = false, stack = false, loadAvatar }: {
  notification: MessageNotification;
  chat?: Chat;
  load?: (id: string) => Promise<Chat | null>;
  open: (chat: Chat) => void;
  dismiss?: () => void;
  markRead?: () => Promise<boolean>;
  markingOther?: boolean;
  inList?: boolean;
  stack?: boolean;
  loadAvatar?: AvatarLoader;
}) {
  const { t: tr } = useTelegramLocale();
  const banner = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState<"open" | "read">();
  const [error, setError] = useState("");

  async function openMessage() {
    if (notification.pendingMessage || pending.current || markingOther) return;
    if (chat) { open(chat); return; }
    if (!load) return;
    pending.current = true;
    setBusy("open");
    setError("");
    const target = await load(notification.chatId).catch(() => null);
    if (!banner.current) return;
    pending.current = false;
    setBusy(undefined);
    if (target?.id === notification.chatId) open(target);
    else setError("Could not open this message.");
  }

  async function markMessageRead() {
    if (!markRead || notification.pendingMessage || pending.current || markingOther) return;
    pending.current = true;
    setBusy("read");
    setError("");
    const confirmed = await markRead().catch(() => false);
    if (!banner.current) return;
    pending.current = false;
    setBusy(undefined);
    if (!confirmed) setError("Could not mark this message as read. Try again.");
  }

  if (stack) {
    const readable = !notification.pendingMessage;
    const title = chat?.name ?? "Telegram";
    const body = notification.pendingMessage ? tr("Waiting for Telegram to load the message…") : notification.preview ?? tr("New message");
    return <section ref={banner} className="mtg-toast-card">
      <button type="button" className="mtg-toast-open" aria-label={tr("Open message")} title={tr("Open message")}
        disabled={!readable || (!chat && !load) || Boolean(busy)} onClick={() => void openMessage()}>
        {chat ? <Avatar chat={chat} load={loadAvatar} /> : <span className="mtg-toast-icon"><Bell size={18} /></span>}
        <span role="status"><strong><bdi>{title}</bdi></strong><small>{tr("Telegram")}</small></span>
        <span className="mtg-toast-preview" dir="auto">{busy === "open" ? tr("Opening…") : body}</span>
      </button>
      {dismiss && <button type="button" className="mtg-toast-dismiss" aria-label={tr("Dismiss notification")} title={tr("Dismiss notification")}
        onClick={dismiss}><X size={17} /></button>}
      {markRead && readable && <button type="button" className="mtg-toast-read" disabled={!!busy}
        aria-label={tr("Mark read")} onClick={() => void markMessageRead()}>
        <Check size={15} />{busy === "read" ? tr("Marking…") : tr("Read notification")}
      </button>}
      {error && <p role="alert">{tr(error)}</p>}
    </section>;
  }

  const Container = inList ? "section" : "aside";
  return <Container ref={banner} className="mtg-message-notification" aria-label={inList ? undefined : tr("Telegram notification")}>
    <div role={inList ? undefined : "status"}><strong><bdi>{chat?.name ?? "Telegram"}</bdi></strong>
      <div>{notification.pendingMessage ? tr("Waiting for Telegram to load the message…") : notification.preview ?? tr("New message")}</div></div>
    {error && <div role="alert">{tr(error)}</div>}
    {!notification.pendingMessage && (chat || load) && <button type="button" className="mtg-action" disabled={Boolean(busy) || markingOther}
      onClick={() => void openMessage()}>{busy === "open" ? tr("Opening…") : tr("Open message")}</button>}
    {markRead && !notification.pendingMessage && <button type="button" className="mtg-action" disabled={Boolean(busy) || markingOther}
      onClick={() => void markMessageRead()}>{busy === "read" ? tr("Marking…") : tr("Mark read")}</button>}
    <button type="button" className="mtg-action" disabled={Boolean(busy) || markingOther} onClick={dismiss}>{tr("Dismiss")}</button>
  </Container>;
}

export function MessageNotificationStack({ notices, chats, load, loadAvatar, open, markRead }: {
  notices: readonly MessageNotification[];
  chats: readonly Chat[];
  load?: (id: string) => Promise<Chat | null>;
  loadAvatar?: AvatarLoader;
  open: (notice: MessageNotification, chat: Chat) => void;
  markRead?: (notice: MessageNotification) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [exiting, setExiting] = useState<readonly MessageNotification[]>([]);
  const stackId = useId();
  const stackButton = useRef<HTMLButtonElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setDismissed((keys) => {
      const stillPresent = new Set(notices.map(({ key }) => key));
      const remaining = [...keys].filter((key) => stillPresent.has(key));
      return remaining.length === keys.size ? keys : new Set(remaining);
    });
  }, [notices]);
  const active = notices.filter(({ key }) => !dismissed.has(key));
  const shown = expanded ? active : active.slice(0, 1);
  const previous = useRef<readonly MessageNotification[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useLayoutEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    previous.current = [];
  }, []);
  useLayoutEffect(() => {
    if (active.length <= 1 && expanded) setExpanded(false);
    const keys = new Set(shown.map(({ key }) => key));
    const restored = new Set<string>();
    for (const key of keys) {
      const timer = timers.current.get(key);
      if (!timer) continue;
      clearTimeout(timer);
      timers.current.delete(key);
      restored.add(key);
    }
    const removed = previous.current.filter(({ key }) => !keys.has(key));
    previous.current = shown;
    if (restored.size || removed.length) {
      setExiting((items) => [...items.filter(({ key }) => !restored.has(key)), ...removed]);
    }
    for (const { key } of removed) {
      timers.current.set(key, setTimeout(() => {
        timers.current.delete(key);
        setExiting((items) => items.filter((item) => item.key !== key));
      }, 220));
    }
  });
  const visible = [...shown, ...exiting.filter((item) => !shown.some(({ key }) => key === item.key))];
  const additional = active.length - 1;
  if (!visible.length) return null;
  return <aside className="mtg-toast-stack" aria-label={tr("Telegram notification")} aria-hidden={!shown.length || undefined} inert={!shown.length}>
    {additional > 0 && <button type="button" ref={stackButton} className="mtg-toast-stack-toggle"
      aria-controls={stackId} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {expanded ? tr("Collapse notifications") : tr("More notifications ({0})", [additional])}<ChevronDown size={15} />
    </button>}
    <div className="mtg-toast-cards" id={stackId} ref={cards}>
      {visible.map((notice, index) => {
        const leaving = index >= shown.length;
        return <div key={notice.key} className="mtg-toast-entry" data-leaving={leaving || undefined} aria-hidden={leaving || undefined} inert={leaving}>
          <MessageNotificationBanner stack notification={notice} chat={chats.find(({ id }) => id === notice.chatId)} load={load} loadAvatar={loadAvatar}
            dismiss={() => {
              setDismissed((keys) => new Set([...keys, notice.key]));
              if (additional > 1) stackButton.current?.focus();
              else cards.current?.querySelector<HTMLButtonElement>(".mtg-toast-entry:not([data-leaving]) + .mtg-toast-entry .mtg-toast-open")?.focus();
            }}
            markRead={markRead && notice.canMarkRead !== false ? () => markRead(notice) : undefined}
            open={(chat) => open(notice, chat)} />
        </div>;
      })}
    </div>
  </aside>;
}

export function MessageNotificationCenter({ notices, chats, load, openMessage, dismiss, markRead, desktopPermission, requestDesktopPermission }: {
  notices: readonly MessageNotification[];
  chats: readonly Chat[];
  load?: (id: string) => Promise<Chat | null>;
  openMessage: (notice: MessageNotification, chat: Chat) => void;
  dismiss?: (key?: string) => void;
  markRead?: (notice: MessageNotification) => Promise<boolean>;
  desktopPermission?: NotificationPermission | "unsupported";
  requestDesktopPermission?: () => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const updating = useRef(false);
  const [marking, setMarking] = useState<"one" | "all">();
  const [failed, setFailed] = useState(0);
  const label = notices.length ? tr("Telegram notifications ({0})", [notices.length]) : tr("Telegram notifications");
  const readable = notices.filter(({ canMarkRead, pendingMessage }) => canMarkRead !== false && !pendingMessage);

  async function markOne(notice: MessageNotification) {
    if (!markRead || updating.current) return false;
    updating.current = true;
    close.current?.focus();
    setMarking("one");
    setFailed(0);
    const confirmed = await markRead(notice).catch(() => false);
    updating.current = false;
    if (dialog.current) setMarking(undefined);
    return confirmed;
  }

  async function markListed() {
    if (!markRead || updating.current) return;
    updating.current = true;
    close.current?.focus();
    setMarking("all");
    setFailed(0);
    const conversations = new Map<string, MessageNotification[]>();
    for (const notice of readable) {
      const key = `${notice.chatId}:${notice.topicId ?? ""}`;
      const entries = conversations.get(key) ?? [];
      entries.push(notice);
      conversations.set(key, entries);
    }
    let failures = 0;
    for (const entries of conversations.values()) {
      if (!dialog.current) return;
      entries.sort((left, right) => Number(right.messageId) - Number(left.messageId));
      const [latest, ...older] = entries;
      if (await markRead(latest!).catch(() => false)) {
        if (!dialog.current) return;
        for (const notice of older) dismiss?.(notice.key);
      } else failures++;
    }
    updating.current = false;
    if (dialog.current) {
      setMarking(undefined);
      setFailed(failures);
    }
  }

  return <>
    <button type="button" aria-label={label} aria-haspopup="dialog" onClick={() => {
      dialog.current?.showModal();
      setOpen(true);
    }}><Bell size={20} aria-hidden="true" />{tr(" Notifications ")}{notices.length > 0 && <span>{notices.length}</span>}</button>
    <dialog ref={dialog} aria-label={tr("Telegram notifications")} className="mtg-agent-settings mtg-chat-details" onClose={() => setOpen(false)}>
      <strong>{tr("Telegram notifications")}</strong>
      <div className="mtg-agent-settings-actions">
        <button ref={close} type="button" className="mtg-action" onClick={() => { setOpen(false); dialog.current?.close(); }}>{tr("Close notifications")}</button>
        {markRead && (readable.length > 1 || marking === "all") && <button type="button" className="mtg-action"
          disabled={Boolean(marking)} onClick={() => void markListed()}>{marking === "all" ? tr("Marking…") : tr("Mark listed as read")}</button>}
        {dismiss && notices.length > 0 && <button type="button" className="mtg-action" disabled={Boolean(marking)} onClick={() => {
          close.current?.focus();
          dismiss();
        }}>{tr("Dismiss all notifications")}</button>}
      </div>
      {open && desktopPermission === "default" && requestDesktopPermission &&
        <button type="button" className="mtg-action" onClick={() => void requestDesktopPermission()}>{tr("Enable system notifications")}</button>}
      {open && desktopPermission === "denied" &&
        <p>{tr("System notifications are blocked for BB. You can allow them in notification settings.")}</p>}
      {open && failed > 0 && <p role="alert">{failed === 1
        ? tr("Could not mark one conversation as read. Try again.") : tr("Could not mark {0} conversations as read. Try again.", [failed])}</p>}
      {open && (notices.length === 0 ? <p>{tr("No recent notifications.")}</p> : <ul aria-label={tr("Recent Telegram notifications")} className="mtg-message-notices">
        {notices.map((notice) => <li key={notice.key}>
          <MessageNotificationBanner notification={notice} chat={chats.find(({ id }) => id === notice.chatId)} inList
            load={load} dismiss={dismiss && (() => { close.current?.focus(); dismiss(notice.key); })}
            markRead={markRead && notice.canMarkRead !== false ? () => markOne(notice) : undefined}
            markingOther={Boolean(marking)}
            open={(chat) => {
              setOpen(false);
              dialog.current?.close();
              openMessage(notice, chat);
            }} />
        </li>)}
      </ul>)}
    </dialog>
  </>;
}
