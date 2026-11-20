import { useTelegramLocale } from "./i18n/index.tsx";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Chat } from "../core/demo.ts";
import { Avatar, type AvatarLoader } from "./avatar.tsx";

export type RecentChatSearchActions = {
  load: () => Promise<Chat[]>;
  loadFrequent?: () => Promise<Chat[]>;
  record: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

export function RecentChatSearch({ actions, revision, open, loadAvatar }: {
  actions: RecentChatSearchActions;
  revision: number;
  open: (chat: Chat) => void;
  loadAvatar?: AvatarLoader;
}) {
  const { t: tr } = useTelegramLocale();
  const [chats, setChats] = useState<Chat[]>();
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [changeFailed, setChangeFailed] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const { load } = actions;
  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    void load().then((result) => {
      if (active) setChats(result);
    }, () => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [load, revision, attempt]);

  async function change(id?: string) {
    if (pending.current) return;
    pending.current = true;
    if (list.current?.contains(document.activeElement)) list.current.focus({ preventScroll: true });
    setBusy(true);
    setChangeFailed(false);
    try {
      const done = await (id === undefined ? actions.clear() : actions.remove(id)).catch(() => false);
      if (done) {
        setChats((previous) => id === undefined ? [] : previous?.filter((chat) => chat.id !== id));
        setConfirmClear(false);
        setAttempt((value) => value + 1);
      } else setChangeFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <div className="mtg-rows mtg-search-suggestions">
    {actions.loadFrequent && <FrequentContacts load={actions.loadFrequent} open={open} loadAvatar={loadAvatar} />}
    <ul ref={list} className="mtg-recent-search" aria-label={tr("Recent chats")} tabIndex={0}>
      <li className="mtg-recent-search-heading">
        <strong>{tr("Recent chats")}</strong>
        {!!chats?.length && <button ref={clearTrigger} type="button" className="mtg-action" disabled={busy}
          aria-expanded={confirmClear} onClick={() => setConfirmClear(!confirmClear)}>{tr("Clear recent chats")}</button>}
      </li>
      {confirmClear && <li className="mtg-recent-search-heading">
        <span>{tr("Clear recent chat searches?")}</span>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void change()}>{tr("Clear")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => {
          clearTrigger.current?.focus({ preventScroll: true });
          setConfirmClear(false);
        }}>{tr("Cancel")}</button>
      </li>}
      {loadFailed && <li className="mtg-empty"><p role="alert">{tr("Could not load recent chats.")}</p>
        <button type="button" className="mtg-action" onClick={() => setAttempt((value) => value + 1)}>{tr("Retry")}</button></li>}
      {changeFailed && <li className="mtg-empty" role="alert">{tr("Could not update recent chats.")}</li>}
      {!chats && !loadFailed && <li className="mtg-empty" role="status">{tr("Loading recent chats…")}</li>}
      {chats?.length === 0 && <li className="mtg-empty">{tr("No recent chats")}</li>}
      {chats?.map((chat) => <li key={chat.id} className="mtg-recent-search-row">
        <button type="button" className="mtg-row" onClick={() => open(chat)}>
          <Avatar chat={chat} load={loadAvatar} />
          <span className="mtg-row-body"><strong><bdi>{chat.name}</bdi></strong><span className="mtg-preview">{chat.subtitle}</span></span>
        </button>
        <button type="button" className="mtg-reply-action" aria-label={tr("Remove {0} from recent chats", [chat.name])}
          disabled={busy} onClick={() => void change(chat.id)}><X size={16} aria-hidden="true" /></button>
      </li>)}
    </ul>
  </div>;
}

function FrequentContacts({ load, open, loadAvatar }: {
  load: NonNullable<RecentChatSearchActions["loadFrequent"]>;
  open: (chat: Chat) => void;
  loadAvatar?: AvatarLoader;
}) {
  const { t: tr } = useTelegramLocale();
  const [contacts, setContacts] = useState<Chat[] | "failed">();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setContacts(undefined);
    void load().then((result) => {
      if (active) setContacts(result);
    }, () => { if (active) setContacts("failed"); });
    return () => { active = false; };
  }, [load, attempt]);
  if (contacts?.length === 0) return null;
  return <section className="mtg-frequent-search" aria-label={tr("Frequent contacts")}>
    <strong>{tr("Frequent contacts")}</strong>
    {!contacts && <p role="status">{tr("Loading frequent contacts…")}</p>}
    {contacts === "failed" && <div>
      <p role="alert">{tr("Could not load frequent contacts.")}</p>
      <button type="button" className="mtg-action" onClick={() => setAttempt((value) => value + 1)}>{tr("Retry")}</button>
    </div>}
    {Array.isArray(contacts) && <ul aria-label={tr("Frequent contacts")}>
      {contacts.map((chat) => <li key={chat.id}>
        <button type="button" className="mtg-row" onClick={() => open(chat)}>
          <Avatar chat={chat} load={loadAvatar} />
          <bdi>{chat.name}</bdi>
        </button>
      </li>)}
    </ul>}
  </section>;
}
