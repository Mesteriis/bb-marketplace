import { useTelegramLocale } from "./i18n/index.tsx";
import { Image as ImageIcon, X } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { globalSearchChatList, globalSearchChatType, globalSearchMediaFilter, telegramSearchTagPrefix, telegramSearchTagKind, type TelegramSearchTagKind,
  type MessageSearchDateRange, type GlobalSearchMediaFilter, type GlobalSearchMode, type GlobalSearchPage, type GlobalSearchScope } from "../core/contract.ts";
import { searchDays } from "../core/message-timeline.ts";
import { maskSpoilers } from "../core/message-spoilers.ts";
import { displayMessagePreview } from "./i18n/message-labels.ts";
import { photoSource } from "./photo-preview.tsx";
import { HistoryMessageUpdates } from "./history-message-updates.ts";
import { useVisibleThumbnail } from "./visible-thumbnail.ts";
import { captureHistoryScroll, restoreHistoryScroll } from "./history-scroll.ts";

export type GlobalSearchLoader = (input: {
  query: string;
  mode: GlobalSearchMode;
  cursor?: NonNullable<GlobalSearchPage["next"]>;
  filter?: GlobalSearchMediaFilter;
  range?: MessageSearchDateRange;
  scope?: GlobalSearchScope;
}) => Promise<GlobalSearchPage>;
export type LoadGlobalMediaThumbnail = (chatId: string, messageId: string, fileId?: number) => Promise<import("../core/contract.ts").TelegramPhoto | null>;

export type RecentPublicTagActions = {
  load: (prefix: string) => Promise<string[]>;
  remove: (tag: string) => Promise<boolean>;
  clear: (kind: TelegramSearchTagKind) => Promise<boolean>;
};

type SearchResultsProps = {
  query: string;
  mode: GlobalSearchMode;
  search: GlobalSearchLoader;
  loadThumbnail?: LoadGlobalMediaThumbnail;
  recentTags?: RecentPublicTagActions;
  changeQuery?: (query: string) => void;
  focusQuery?: () => void;
  communityId?: string;
  open: (hit: GlobalSearchPage["hits"][number], trigger: HTMLButtonElement) => void;
};

const mediaLabels: Record<GlobalSearchMediaFilter, string> = {
  photoVideo: "Photos and videos", photo: "Photos", video: "Videos", document: "Documents", audio: "Audio",
  voiceVideoNotes: "Voice and video messages", gif: "GIFs", link: "Links",
};

export function GlobalSearchResults(props: SearchResultsProps) {
  const { t: tr } = useTelegramLocale();
  const [mediaFilter, setMediaFilter] = useState<GlobalSearchMediaFilter>("photoVideo");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [chatType, setChatType] = useState<GlobalSearchScope["chatType"]>();
  const [list, setList] = useState<GlobalSearchScope["list"]>();
  const [selectedTag, setSelectedTag] = useState<string>();
  useEffect(() => {
    if (selectedTag !== props.query) setSelectedTag(undefined);
  }, [selectedTag, props.query]);
  const selectTag = props.changeQuery && ((tag: string) => {
    setSelectedTag(tag);
    props.changeQuery?.(tag);
    props.focusQuery?.();
  });
  const filter = props.mode === "media" ? mediaFilter : undefined;
  const scope = useMemo(() => {
    if (props.mode === "public") return;
    if (props.communityId) return { communityId: props.communityId };
    if (chatType || list) return { ...(chatType && { chatType }), ...(list && { list }) };
  }, [chatType, list, props.mode, props.communityId]);
  const dates = useMemo(() => props.mode === "public" ? undefined : searchDays(from, through), [from, through, props.mode]);
  return <>
    {filter && <label className="mtg-global-media-filter">{tr("Media type")}<select value={filter} onChange={(event) => {
        const next = globalSearchMediaFilter.safeParse(event.currentTarget.value);
        if (next.success) setMediaFilter(next.data);
      }}>
        {globalSearchMediaFilter.options.map((value) => <option key={value} value={value}>{tr(mediaLabels[value])}</option>)}
      </select>
    </label>}
    {props.mode !== "public" && <details className="mtg-global-search-filter">
      <summary>{from || through ? tr("Dates · active") : tr("Filter by date")}</summary>
      <label>{tr("From date ")}<input type="date" value={from} max={through || undefined}
        onChange={(event) => setFrom(event.currentTarget.value)} /></label>
      <label>{tr("Through date ")}<input type="date" value={through} min={from || undefined}
        onChange={(event) => setThrough(event.currentTarget.value)} /></label>
      {(from || through) && <button type="button" className="mtg-action" onClick={() => { setFrom(""); setThrough(""); }}>{tr("Clear dates")}</button>}
    </details>}
    {props.mode !== "public" && !props.communityId && <details className="mtg-global-search-filter">
      <summary>{scope ? tr("Chat filters · active") : tr("Filter by chat")}</summary>
      <label>{tr("Search chat type ")}<select value={chatType ?? ""} onChange={(event) =>
        setChatType(globalSearchChatType.safeParse(event.currentTarget.value).data)}>
        <option value="">{tr("Any type")}</option>
        <option value="private">{tr("Private chats")}</option>
        <option value="group">{tr("Groups")}</option>
        <option value="channel">{tr("Channels")}</option>
      </select></label>
      <label>{tr("Search chat list ")}<select value={list ?? ""} onChange={(event) =>
        setList(globalSearchChatList.safeParse(event.currentTarget.value).data)}>
        <option value="">{tr("Main and archive")}</option>
        <option value="main">{tr("Main only")}</option>
        <option value="archive">{tr("Archive only")}</option>
      </select></label>
    </details>}
    {dates?.success === false ? <p className="mtg-empty" role="alert">{tr("Choose a valid date range.")}</p>
      : <SearchResultList key={JSON.stringify([props.mode, filter, props.query, dates?.data, scope])}
        {...props} filter={filter} range={dates?.data} scope={scope}
        selectedTag={selectedTag === props.query} selectTag={selectTag} />}
  </>;
}

function SearchThumbnail({ chatId, messageId, fileId, load }: {
  chatId: string; messageId: string; fileId?: number; load: LoadGlobalMediaThumbnail;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const loadFile = useCallback((id: string, message: string) => fileId === undefined
    ? load(id, message) : load(id, message, fileId), [load, fileId]);
  const { photo, discard } = useVisibleThumbnail(target, chatId, messageId, loadFile);
  return <span ref={target} className="mtg-global-search-thumbnail" aria-hidden="true">
    {photo ? <img src={photoSource(photo)} alt="" onError={discard} /> : <ImageIcon size={18} />}
  </span>;
}

function RecentPublicTags({ prefix, actions, select, focusQuery }: {
  prefix: string; actions: RecentPublicTagActions; select: (tag: string) => void; focusQuery?: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [changeFailed, setChangeFailed] = useState(false);
  const [confirm, setConfirm] = useState<TelegramSearchTagKind>();
  const clearTriggers = useRef<Partial<Record<TelegramSearchTagKind, HTMLButtonElement | null>>>({});

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void actions.load(prefix).then((found) => { if (active) setTags(found); }, () => { if (active) setTags([]); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [actions, prefix]);

  const tagKind = (tag: string): TelegramSearchTagKind => tag.startsWith("$") ? "cashtag" : "hashtag";
  async function change(action: { tag: string } | { kind: TelegramSearchTagKind }) {
    setBusy(true);
    setChangeFailed(false);
    focusQuery?.();
    try {
      const done = "tag" in action ? await actions.remove(action.tag) : await actions.clear(action.kind);
      if (!done) {
        setChangeFailed(true);
        return;
      }
      setTags((current) => current.filter((tag) => "tag" in action ? tag !== action.tag : tagKind(tag) !== action.kind));
      setConfirm(undefined);
    } catch {
      setChangeFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {(tags.length > 0 || changeFailed) && <li className="mtg-recent-search-heading">
      <strong>{tr("Recent search tags")}</strong>
      {prefix.length <= 1 && telegramSearchTagKind.options.map((kind) => tags.some((tag) => tagKind(tag) === kind) &&
        <button key={kind} ref={(button) => { clearTriggers.current[kind] = button; }}
          type="button" className="mtg-action" data-search-action disabled={busy} aria-expanded={confirm === kind}
          onClick={() => { setConfirm(confirm === kind ? undefined : kind); setChangeFailed(false); }}>{tr("Clear ")}{kind}{tr(" history")}</button>)}
    </li>}
    {confirm && <li className="mtg-recent-search-heading">
      <span>{tr("Clear all recent ")}{confirm}{tr(" searches?")}</span>
      <button type="button" className="mtg-action" data-search-action disabled={busy}
        onClick={() => void change({ kind: confirm })}>{tr("Clear ")}{confirm}s</button>
      <button type="button" className="mtg-action" data-search-action disabled={busy} onClick={() => {
        clearTriggers.current[confirm]?.focus({ preventScroll: true });
        setConfirm(undefined);
        setChangeFailed(false);
      }}>{tr("Cancel")}</button>
    </li>}
    {tags.map((tag) => <li key={tag} className="mtg-recent-search-row">
      <button type="button" className="mtg-row" disabled={busy} onClick={() => select(tag)}><bdi>{tag}</bdi></button>
      <button type="button" className="mtg-reply-action" data-search-action aria-label={tr("Remove {0} from recent searches", [tag])}
        disabled={busy} onClick={() => void change({ tag })}><X size={16} aria-hidden="true" /></button>
    </li>)}
    {changeFailed && <li className="mtg-empty" role="alert">{tr("Could not update the recent search tags.")}</li>}
  </>;
}

type SearchCursor = NonNullable<GlobalSearchPage["next"]>;
type SearchPageEntry = { cursor?: SearchCursor; page: GlobalSearchPage };
const searchCursorKey = (cursor?: SearchCursor) => JSON.stringify(cursor ?? null);
const searchHitKey = ({ chat, message }: GlobalSearchPage["hits"][number]) => `${chat.id}:${message.id}`;

function omitDeletedHits(page: GlobalSearchPage, deleted: ReadonlySet<string>) {
  const hits = page.hits.filter((hit) => !deleted.has(searchHitKey(hit)));
  return hits.length === page.hits.length ? page : { ...page, hits };
}

function SearchResultList({ query, mode, search, loadThumbnail, open, filter, range, scope, recentTags, selectedTag, selectTag, focusQuery }: SearchResultsProps & {
  selectedTag: boolean; selectTag?: (tag: string) => void;
  filter?: GlobalSearchMediaFilter; range?: MessageSearchDateRange; scope?: GlobalSearchScope;
}) {
  const { t: tr } = useTelegramLocale();
  const [pages, setPages] = useState<SearchPageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [publicStale, setPublicStale] = useState(false);
  const publicEdits = useRef(0);
  const historyUpdates = useContext(HistoryMessageUpdates);
  const deleted = useRef(new Set<string>());
  useLayoutEffect(() => {
    deleted.current.clear();
  }, [historyUpdates]);
  const loadedPages = useRef(pages);
  const list = useRef<HTMLUListElement>(null);
  const scrollAnchor = useRef<ReturnType<typeof captureHistoryScroll> | undefined>(undefined);
  useLayoutEffect(() => {
    loadedPages.current = pages;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = undefined;
    if (anchor && list.current) restoreHistoryScroll(list.current, anchor);
  }, [pages]);
  const awaitingSubmit = mode === "public" && retry === 0 && !selectedTag;
  const validQuery = mode === "media" || query.length >= 2;
  const load = useCallback((cursor?: SearchCursor) => search({ query, mode, ...(cursor !== undefined && { cursor }),
    ...(filter && { filter }), ...(range && { range }), ...(scope && { scope }) }), [query, mode, filter, range, scope, search]);
  const ready = pages.length > 0;
  const hitsById = new Map<string, GlobalSearchPage["hits"][number]>();
  for (const { page } of pages) for (const hit of page.hits) hitsById.set(searchHitKey(hit), hit);
  const next = pages.at(-1)?.page.next;
  const canLoadMore = next != null && !pages.some(({ cursor }) => searchCursorKey(cursor) === searchCursorKey(next));

  useEffect(() => {
    if (!validQuery || awaitingSubmit) return;
    let active = true;
    const revision = publicEdits.current;
    const timer = setTimeout(() => {
      void load().then((result) => {
        if (!active) return;
        setPages(() => [{ page: omitDeletedHits(result, deleted.current) }]);
        if (publicEdits.current === revision) setPublicStale(false);
      }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [load, retry, awaitingSubmit, validQuery]);

  useEffect(() => {
    if (!historyUpdates) return;
    let active = true;
    const pending = new Map<string, boolean>();
    async function refresh(cursor?: SearchCursor) {
      const key = searchCursorKey(cursor);
      pending.set(key, false);
      try {
        const page = await load(cursor);
        if (!active || pending.get(key)) return;
        const entry = loadedPages.current.find(({ cursor }) => searchCursorKey(cursor) === key);
        if (entry && list.current && !scrollAnchor.current) {
          const remaining = new Set([...page.hits, ...loadedPages.current.filter((row) => row !== entry)
            .flatMap((row) => row.page.hits)].map(searchHitKey));
          const removed = new Set(entry.page.hits.map(searchHitKey).filter((id) => !remaining.has(id)));
          scrollAnchor.current = captureHistoryScroll(list.current, "keep", removed);
        }
        setPages((previous) => {
          const visible = omitDeletedHits(page, deleted.current);
          return previous.map((entry, index) => searchCursorKey(entry.cursor) !== key ? entry : {
            cursor, page: index < previous.length - 1 ? { ...visible, next: entry.page.next } : visible,
          });
        });
      } catch {
        // Keep the loaded results available if Telegram cannot recheck this page.
      } finally {
        const changed = pending.get(key);
        pending.delete(key);
        if (active && changed) void refresh(cursor);
      }
    }
    const unsubscribe = historyUpdates.subscribe(({ id, messageId }) => {
      if (deleted.current.has(`${id}:${messageId}`)) return;
      const affected = loadedPages.current.filter(({ page }) => page.hits.some((hit) => hit.chat.id === id && hit.message.id === messageId));
      if (!affected.length) return;
      if (mode === "public") {
        publicEdits.current++;
        setPublicStale(true);
        return;
      }
      for (const { cursor } of affected) {
        const key = searchCursorKey(cursor);
        if (pending.has(key)) pending.set(key, true);
        else void refresh(cursor);
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [historyUpdates, load, mode]);

  useLayoutEffect(() => historyUpdates?.subscribeToDeletions?.(({ id, messageIds, retained }) => {
    const keys = new Set([...messageIds, ...(retained?.map((row) => row.id) ?? [])].map((messageId) => `${id}:${messageId}`));
    if (!keys.size) return;
    for (const key of keys) deleted.current.add(key);
    const visible = loadedPages.current.some(({ page }) => page.hits.some((hit) => keys.has(searchHitKey(hit))));
    if (visible && list.current && !scrollAnchor.current) scrollAnchor.current = captureHistoryScroll(list.current, "keep", keys);
    setPages((previous) => {
      const next = previous.map((entry) => {
        const page = omitDeletedHits(entry.page, keys);
        return page === entry.page ? entry : { ...entry, page };
      });
      return next.some((entry, index) => entry !== previous[index]) ? next : previous;
    });
  }), [historyUpdates]);

  async function more() {
    if (!canLoadMore || next == null || loading) return;
    setLoading(true);
    setError(false);
    try {
      const page = await load(next);
      const key = searchCursorKey(next);
      setPages((previous) => searchCursorKey(previous.at(-1)?.page.next ?? undefined) !== key
        || previous.some(({ cursor }) => searchCursorKey(cursor) === key)
        ? previous : [...previous, { cursor: next, page: omitDeletedHits(page, deleted.current) }]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return <ul ref={list} className="mtg-rows" aria-label={mode === "public" ? tr("Public posts") : mode === "media" ? tr("Telegram media results") : tr("Telegram message results")}>
    {!validQuery && <li className="mtg-empty">{tr("Enter at least two characters.")}</li>}
    {validQuery && awaitingSubmit && <li className="mtg-empty">
      <button type="button" className="mtg-action" data-search-action data-search-submit onClick={() => setRetry(1)}>{tr("Search public posts")}</button>
    </li>}
    {mode === "public" && (awaitingSubmit || !validQuery) && recentTags && selectTag && telegramSearchTagPrefix.safeParse(query).success
      && <RecentPublicTags prefix={query} actions={recentTags} select={selectTag} focusQuery={focusQuery} />}
    {validQuery && !awaitingSubmit && !ready && !error && <li className="mtg-empty" role="status">{tr("Searching Telegram…")}</li>}
    {publicStale && ready && <li className="mtg-history-more">
      <button type="button" className="mtg-action" data-search-action disabled={loading} onClick={() => {
        setError(false);
        setLoading(true);
        setRetry((value) => value + 1);
      }}>{loading ? tr("Refreshing public posts…") : tr("Refresh public posts")}</button>
    </li>}
    {[...hitsById.values()].map((hit) => {
      const { message } = hit;
      const caption = filter ? message.photoCaption || message.document?.caption : undefined;
      const excerpt = caption ? maskSpoilers(caption, message.styles, tr("[Spoiler]")) : displayMessagePreview(message, tr);
      const showThumbnail = filter && hit.thumbnail && loadThumbnail;
      return <li key={searchHitKey(hit)} data-message-id={searchHitKey(hit)}>
        <button type="button" className="mtg-row mtg-global-search-row" data-thumbnail={!!showThumbnail || undefined} onClick={(event) => open(hit, event.currentTarget)}>
          {showThumbnail && <SearchThumbnail key={hit.thumbnailFileId ?? message.editedAt} chatId={hit.chat.id} messageId={message.id}
            fileId={hit.thumbnailFileId} load={showThumbnail} />}
          <span className="mtg-row-body">
            <span className="mtg-row-line"><strong>{hit.chat.name}</strong><time>{message.time}</time></span>
            <span className="mtg-preview">{filter && message.document?.name && <><bdi>{message.document.name}</bdi>{excerpt && " · "}</>}{excerpt}</span>
          </span>
        </button>
      </li>;
    })}
    {ready && !hitsById.size && !canLoadMore && <li className="mtg-empty">{filter ? tr("No matching media.") : tr("No matching messages.")}</li>}
    {error && <li className="mtg-empty" role="alert">
      {mode === "public" ? tr("Free public post search is unavailable for this query. Try a hashtag.") : tr("Could not search Telegram messages.")}
      {!ready && <button type="button" className="mtg-action" data-search-action data-search-submit
        onClick={() => { setError(false); setRetry((value) => value + 1); }}>{tr("Retry")}</button>}
    </li>}
    {canLoadMore && <li className="mtg-history-more"><button type="button" className="mtg-action" data-search-action disabled={loading}
      onClick={() => void more()}>{loading ? tr("Loading…") : error ? tr("Retry more results") : tr("Load more results")}</button></li>}
  </ul>;
}
