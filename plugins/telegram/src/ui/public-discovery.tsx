import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { PublicDiscoveryDirectoryMode, PublicDiscoveryMode, PublicDiscoveryPage } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { Avatar, type AvatarLoader } from "./avatar.tsx";

export type SearchPublicDiscovery = (query: string, mode: PublicDiscoveryMode) => Promise<Chat[]>;
export type BrowsePublicDiscovery = (mode: PublicDiscoveryDirectoryMode, offset?: string) => Promise<PublicDiscoveryPage>;

type DiscoveryActions = {
  loadAvatar?: AvatarLoader;
  openChat: (chat: Chat) => void;
  openApp?: (chat: Chat) => void;
};

export function PublicDiscovery({ query, mode, search, browse, ...actions }: DiscoveryActions & {
  query: string;
  mode: PublicDiscoveryMode;
  search: SearchPublicDiscovery;
  browse?: BrowsePublicDiscovery;
}) {
  if (!query && browse && mode !== "groups") return <DiscoveryDirectory mode={mode} browse={browse} {...actions} />;
  return <DiscoverySearch query={query} mode={mode} search={search} {...actions} />;
}

function DiscoverySearch({ query, mode, search, ...actions }: DiscoveryActions & {
  query: string;
  mode: PublicDiscoveryMode;
  search: SearchPublicDiscovery;
}) {
  const { t: tr } = useTelegramLocale();
  const [chats, setChats] = useState<Chat[]>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const label = mode === "apps" ? tr("Mini Apps") : mode === "groups" ? tr("public groups") : tr("public channels");

  useEffect(() => {
    if (!query) return;
    let current = true;
    const timer = setTimeout(() => {
      void search(query, mode).then(
        (result) => { if (current) setChats(result); },
        () => { if (current) setFailed(true); },
      );
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [mode, query, retry, search]);

  return <ul className="mtg-rows" aria-label={tr("Telegram {0}", [label])}>
    {!query && <li className="mtg-empty">{tr("Search Telegram ")}{label}{tr(" by name or username.")}{mode !== "apps" && tr(" You can also paste a public Telegram link.")}</li>}
    {query && !chats && !failed && <li className="mtg-empty" role="status">{tr("Searching Telegram…")}</li>}
    {failed && <li className="mtg-empty" role="alert">{tr("Could not search Telegram ")}{label}.{" "}
      <button type="button" className="mtg-action" onClick={() => {
        setFailed(false);
        setRetry((value) => value + 1);
      }}>{tr("Retry search")}</button>
    </li>}
    {chats?.length === 0 && <li className="mtg-empty">{tr("No matching ")}{label}.</li>}
    {chats?.map((chat) => <DiscoveryRow key={chat.id} chat={chat} mode={mode} {...actions} />)}
    {mode !== "apps" && <DiscoveryCatalog mode={mode} />}
  </ul>;
}

function DiscoveryDirectory({ mode, browse, ...actions }: DiscoveryActions & {
  mode: PublicDiscoveryDirectoryMode;
  browse: BrowsePublicDiscovery;
}) {
  const { t: tr } = useTelegramLocale();
  const [page, setPage] = useState<PublicDiscoveryPage>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const current = useRef<AbortController>(undefined);
  const offsets = useRef(new Set<string>());
  const label = mode === "apps" ? tr("Popular Mini Apps") : tr("Recommended channels");
  useEffect(() => {
    const request = new AbortController();
    current.current = request;
    offsets.current.clear();
    setPage(undefined);
    setFailed(false);
    void browse(mode).then(
      (result) => { if (!request.signal.aborted) setPage(result); },
      () => { if (!request.signal.aborted) setFailed(true); },
    );
    return () => request.abort();
  }, [browse, mode, retry]);

  async function more() {
    const offset = page?.next;
    const request = current.current;
    if (!offset || !request || loadingMore || offsets.current.has(offset)) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      const result = await browse(mode, offset);
      if (request.signal.aborted) return;
      offsets.current.add(offset);
      setPage((previous) => {
        if (!previous) return previous;
        const rows = new Map(previous.results.map((chat) => [chat.id, chat]));
        for (const chat of result.results) rows.set(chat.id, chat);
        return { ...previous, results: [...rows.values()], next: result.next && !offsets.current.has(result.next) ? result.next : null };
      });
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (!request.signal.aborted) setLoadingMore(false);
    }
  }

  const recent = new Set(page?.recent.map(({ id }) => id));
  const results = page?.results.filter(({ id }) => !recent.has(id));
  return <ul className="mtg-rows" aria-label={mode === "apps" ? tr("Telegram Mini App directory") : label}>
    {!page && !failed && <li className="mtg-empty" role="status">{tr("Loading Telegram recommendations…")}</li>}
    {page && page.recent.length > 0 && <>
      <li className="mtg-discovery-heading"><h3>{tr("Previously used Mini Apps")}</h3></li>
      {page.recent.map((chat) => <DiscoveryRow key={chat.id} chat={chat} mode={mode} {...actions} />)}
    </>}
    {page && <>
      <li className="mtg-discovery-heading"><h3>{label}</h3></li>
      {results?.map((chat) => <DiscoveryRow key={chat.id} chat={chat} mode={mode} {...actions} />)}
      {!results?.length && !page.next && <li className="mtg-empty">{tr("No recommendations available.")}</li>}
    </>}
    {failed && <li className="mtg-empty" role="alert">{tr("Could not load Telegram recommendations.")}{" "}
      <button type="button" className="mtg-action" onClick={() => page ? void more() : setRetry((value) => value + 1)}>{tr("Retry")}</button>
    </li>}
    {page?.next && !failed && <li className="mtg-history-more">
      <button type="button" className="mtg-action" disabled={loadingMore} onClick={() => void more()}>
        {loadingMore ? tr("Loading Mini Apps…") : tr("Load more Mini Apps")}
      </button>
    </li>}
    {mode === "channels" && <DiscoveryCatalog mode={mode} />}
  </ul>;
}

function DiscoveryCatalog({ mode }: { mode: "groups" | "channels" }) {
  const { t: tr } = useTelegramLocale();
  const url = mode === "groups" ? "https://tgstat.com/ratings/chats" : "https://tgstat.com/channels/search";
  return <li className="mtg-empty">
    <a className="mtg-action" href={url} target="_blank" rel="noopener noreferrer">{tr("Open TGStat catalog")}</a>
  </li>;
}

function DiscoveryRow({ chat, mode, loadAvatar, openChat, openApp }: DiscoveryActions & { chat: Chat; mode: PublicDiscoveryMode }) {
  const { t: tr } = useTelegramLocale();
  return <li className="mtg-public-discovery-row">
    <button type="button" className="mtg-row" onClick={() => openChat(chat)}>
      <Avatar chat={chat} load={loadAvatar} />
      <span className="mtg-row-body"><span className="mtg-row-line"><strong><bdi>{chat.name}</bdi></strong></span></span>
    </button>
    {openApp && mode === "apps" && <button type="button" className="mtg-action"
      aria-label={tr("Open Mini App {0}", [chat.name])} onClick={() => openApp(chat)}>{tr("Open app")}</button>}
  </li>;
}
