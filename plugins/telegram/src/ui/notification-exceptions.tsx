import { ChevronDown } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { notificationScope, type NotificationExceptionPage, type NotificationScope } from "../core/contract.ts";
import { ChatNotifications, type ChatNotificationActions } from "./chat-notifications.tsx";

export type NotificationExceptionLoader = (scope: NotificationScope, offset: number) => Promise<NotificationExceptionPage>;

const labels: Record<NotificationScope, string> = { private: "Private chats", groups: "Groups", channels: "Channels" };

export function NotificationExceptions({ load, actions }: { load: NotificationExceptionLoader; actions: ChatNotificationActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<NotificationScope>("private");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<NotificationExceptionPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load(scope, offset).then((next) => {
      if (!active) return;
      setPage((previous) => offset > 0 && previous ? {
        chats: [...new Map([...previous.chats, ...next.chats].map((chat) => [chat.id, chat])).values()],
        nextOffset: next.nextOffset,
      } : next);
    }, () => { if (active) setError(true); }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, offset, open, revision, scope]);

  const nextOffset = page?.nextOffset;
  return <details onToggle={(event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (!next) { setPage(undefined); setOffset(0); setError(false); }
  }}>
    <summary>{tr("Notification exceptions")}<ChevronDown size={16} aria-hidden="true" className="mtg-settings-workspace-chevron" /></summary>
    {open && <>
      <label>{tr("Chat type for notification exceptions ")}<select value={scope} onChange={(event) => {
        const next = notificationScope.safeParse(event.currentTarget.value);
        if (next.success && next.data !== scope) {
          setPage(undefined);
          setOffset(0);
          setScope(next.data);
        }
      }}>
        {notificationScope.options.map((type) => <option key={type} value={type}>{tr(labels[type])}</option>)}
      </select></label>
      {loading && <p role="status">{tr("Loading notification exceptions…")}</p>}
      {error && <p role="alert">{tr("Could not load notification exceptions.")}</p>}
      {!loading && !error && page?.chats.length === 0 && page.nextOffset === null && <p>{tr("No notification exceptions.")}</p>}
      {!!page?.chats.length && <ul aria-label={tr("Chats with notification exceptions")}>
        {page.chats.map((chat) => <li key={chat.id}>
          <details>
            <summary><bdi>{chat.name}</bdi></summary>
            <ChatNotifications id={chat.id} {...actions} />
          </details>
        </li>)}
      </ul>}
      {nextOffset != null && <button type="button" className="mtg-action" disabled={loading || error}
        onClick={() => setOffset(nextOffset)}>{tr("Load more exceptions")}</button>}
      <button type="button" className="mtg-action" disabled={loading} onClick={() => {
        setPage(undefined);
        setOffset(0);
        setRevision((current) => current + 1);
      }}>{tr("Reload notification exceptions")}</button>
    </>}
  </details>;
}
