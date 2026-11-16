import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import { CopyMessageReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { ChannelViewCount } from "./channel-view-count.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { MessageContent } from "./message-content.tsx";
import { messageSearchFilter, searchRequiresEmptyQuery, type ContextDirection, type UnreadActivityFilter, type MessageSender, type MessageSearchFilter, type MessageSearchPage, type PhotoSize, type TelegramPhoto } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";

const filterLabels: Record<MessageSearchFilter, string> = {
  photoVideo: "Photos and videos", photo: "Photos", document: "Documents", audio: "Audio", video: "Videos", voiceVideoNotes: "Voice and video messages", gif: "GIFs", link: "Links", pinned: "Pinned messages", mentions: "Mentions and replies", unreadMentions: "Unread mentions and replies", unreadReactions: "Unread reactions",
};

type Result = { messages: Message[]; error: boolean };
export type AuthorFilter = { sender: MessageSender; name: string };
type ContextPageRequest = { focus: string; boundary: string; direction: ContextDirection };

export function ConversationSearch({ chatId, chat, loadAvatar, initialMessage, initialDay, initialFilter, initialAuthor, topicId, search, loadMessageLink, loadAtDate, loadContext, loadContextPage, markActivityRead, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, mediaCollection, deletedIds, close }: {
  chatId: string;
  chat?: Chat;
  loadAvatar?: AvatarLoader;
  initialMessage?: string;
  initialDay?: string;
  initialFilter?: MessageSearchFilter;
  initialAuthor?: AuthorFilter;
  topicId?: number;
  search?: (id: string, query: string, filter?: MessageSearchFilter, topicId?: number, before?: string, sender?: MessageSender) => Promise<MessageSearchPage>;
  close: () => void;
  loadMessageLink?: MessageLinkLoader;
  loadAtDate?: (id: string, date: number, topicId?: number) => Promise<string | null>;
  loadContext?: (id: string, messageId: string, topicId?: number) => Promise<Message[]>;
  markActivityRead?: (id: string, filter: UnreadActivityFilter, topicId?: number) => Promise<boolean>;
  loadContextPage?: (id: string, boundary: string, direction: ContextDirection, topicId?: number) => Promise<Message[]>;
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  mediaCollection?: ComponentProps<typeof MessageContent>["mediaCollection"];
  saveDocument?: (id: string, messageId: string) => Promise<boolean>;
  loadPhoto?: (chatId: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
  deletedIds?: ReadonlySet<string>;
}) {
  const [gallerySelected, setGallerySelected] = useState(true);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<MessageSearchFilter | undefined>(initialFilter);
  const [author, setAuthor] = useState(initialAuthor);
  const [request, setRequest] = useState<{ query: string; filter?: MessageSearchFilter; before?: string; sender?: MessageSender } | undefined>(
    initialFilter || initialAuthor ? { query: "", filter: initialFilter, sender: initialAuthor?.sender } : undefined,
  );
  const queryGeneration = useRef(0);
  const [pages, setPages] = useState<Array<{ cursor?: string; page: MessageSearchPage }>>([]);
  const [searchStatus, setSearchStatus] = useState<"pending" | "failed" | undefined>(initialFilter || initialAuthor ? "pending" : undefined);
  const [activityStatus, setActivityStatus] = useState<"pending" | "saved" | "failed">();
  const [day, setDay] = useState(initialDay ?? "");
  const [dateStatus, setDateStatus] = useState<"pending" | "empty" | "failed">();
  const [dateFocus, setDateFocus] = useState("");
  const [focus, setFocus] = useState(initialMessage);
  const [contextRevision, setContextRevision] = useState(0);
  const [context, setContext] = useState<Result>();
  const [contextPageRequest, setContextPageRequest] = useState<ContextPageRequest>();
  const [contextPages, setContextPages] = useState<{ focus: string; messages: Message[]; ends: ContextDirection[] }>();
  const [contextPageError, setContextPageError] = useState<ContextPageRequest>();
  const viewport = useRef<HTMLElement>(null);
  const scrollAnchor = useRef<{ id: string; top: number } | undefined>(undefined);

  useEffect(() => {
    setContextPageRequest(undefined);
    setContextPageError(undefined);
    setContextPages(undefined);
    scrollAnchor.current = undefined;
  }, [chatId, focus, topicId]);

  useEffect(() => {
    if (!focus || contextPageRequest?.focus !== focus || !loadContextPage) return;
    const { boundary, direction } = contextPageRequest;
    let active = true;
    void loadContextPage(chatId, boundary, direction, topicId).then((messages) => {
      if (!active) return;
      const next = messages.filter(({ id }) => direction === "older" ? Number(id) < Number(boundary) : Number(id) > Number(boundary));
      if (direction === "older" && next.length) {
        const row = viewport.current?.querySelector(`[data-context-id="${boundary}"]`);
        if (row) scrollAnchor.current = { id: boundary, top: row.getBoundingClientRect().top };
      }
      setContextPages((previous) => {
        const current = previous?.focus === focus ? previous : { focus, messages: [], ends: [] };
        return next.length ? { ...current, messages: [...current.messages, ...next] }
          : { ...current, ends: [...current.ends, direction] };
      });
      setContextPageRequest(undefined);
    }, () => {
      if (!active) return;
      setContextPageError(contextPageRequest);
      setContextPageRequest(undefined);
    });
    return () => { active = false; };
  }, [chatId, contextPageRequest, focus, loadContextPage, topicId]);

  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const panel = viewport.current;
    if (!anchor || !panel) return;
    scrollAnchor.current = undefined;
    const row = panel.querySelector(`[data-context-id="${anchor.id}"]`);
    if (row) panel.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [contextPages]);

  useEffect(() => {
    if (!focus || !loadContext) return;
    let current = true;
    const nearby = topicId === undefined ? loadContext(chatId, focus) : loadContext(chatId, focus, topicId);
    void nearby.then(
      (messages) => { if (current) setContext({ messages, error: false }); },
      () => { if (current) setContext({ messages: [], error: true }); },
    );
    return () => { current = false; };
  }, [chatId, focus, loadContext, contextRevision, topicId]);

  useEffect(() => {
    if (!request || !search) return;
    let current = true;
    const { query, filter, before, sender } = request;
    const results = sender ? search(chatId, query, filter, topicId, before, sender)
      : before !== undefined ? search(chatId, query, filter, topicId, before)
      : topicId !== undefined ? search(chatId, query, filter, topicId)
      : filter ? search(chatId, query, filter) : search(chatId, query);
    void results.then((page) => {
      if (!current) return;
      setPages((previous) => {
        const index = previous.findIndex(({ cursor }) => cursor === before);
        const entry = { cursor: before, page };
        if (index < 0) return [...previous, entry];
        return previous.map((row, i) => i === index ? entry : row);
      });
      setSearchStatus(undefined);
    }, () => { if (current) setSearchStatus("failed"); });
    return () => { current = false; };
  }, [chatId, request, search, topicId]);

  function refreshMessage(messageId: string, generation: number) {
    if (generation !== queryGeneration.current) return;
    if (focus) setContextRevision((revision) => revision + 1);
    if (!focus && request) {
      const page = pages.find(({ page }) => page.messages.some(({ id }) => id === messageId));
      if (page) {
        setSearchStatus("pending");
        setRequest({ ...request, before: page.cursor });
      }
    }
  }

  const voteAndRefresh: typeof voteInPoll = voteInPoll && (async (id, messageId, choices) => {
    const generation = queryGeneration.current;
    const accepted = await voteInPoll(id, messageId, choices);
    if (accepted) refreshMessage(messageId, generation);
    return accepted;
  });
  const stopAndRefresh: typeof stopPoll = stopPoll && (async (id, messageId) => {
    const generation = queryGeneration.current;
    const accepted = await stopPoll(id, messageId);
    if (accepted) refreshMessage(messageId, generation);
    return accepted;
  });
  const reactAndRefresh = reactionActions && {
    ...reactionActions,
    async setReaction(id: string, messageId: string, emoji: string, chosen: boolean) {
      const generation = queryGeneration.current;
      const accepted = await reactionActions.setReaction(id, messageId, emoji, chosen);
      if (accepted) refreshMessage(messageId, generation);
      return accepted;
    },
  };

  function startSearch(query: string, nextFilter?: MessageSearchFilter, sender?: MessageSender) {
    if (searchRequiresEmptyQuery(nextFilter)) query = "";
    const canSearch = !!nextFilter || !!sender || query.length >= 2;
    queryGeneration.current++;
    setActivityStatus(undefined);
    setDateStatus(undefined);
    setDateFocus("");
    setFocus(undefined);
    setContext(undefined);
    setPages([]);
    setSearchStatus(canSearch ? "pending" : undefined);
    setRequest(canSearch ? { query, filter: nextFilter, sender } : undefined);
  }

  async function markAllActivityRead(selected: UnreadActivityFilter) {
    if (!markActivityRead || activityStatus === "pending") return;
    const generation = queryGeneration.current;
    setActivityStatus("pending");
    let saved = false;
    try {
      saved = await markActivityRead(chatId, selected, topicId);
    } catch {
      // Keep the result list available for another attempt.
    }
    if (generation !== queryGeneration.current) return;
    if (saved) startSearch("", selected);
    setActivityStatus(saved ? "saved" : "failed");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startSearch(text.trim(), filter, author?.sender);
  }

  async function jumpToDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loadAtDate || dateStatus === "pending" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const boundary = new Date(`${day}T00:00:00`);
    boundary.setDate(boundary.getDate() + 1);
    const end = Math.min(2147483647, Math.floor(boundary.getTime() / 1000) - 1);
    if (!Number.isInteger(end) || end < 1) return;

    const generation = ++queryGeneration.current;
    setDateStatus("pending");
    try {
      const id = await (topicId === undefined ? loadAtDate(chatId, end) : loadAtDate(chatId, end, topicId));
      if (generation !== queryGeneration.current) return;
      setDateStatus(id ? undefined : "empty");
      if (!id) {
        if (dateFocus) {
          setFocus(undefined);
          setContext(undefined);
          setDateFocus("");
        }
        return;
      }
      setContext(undefined);
      setDateFocus(day);
      if (focus === id) setContextRevision((revision) => revision + 1);
      else setFocus(id);
    } catch {
      if (generation === queryGeneration.current) setDateStatus("failed");
    }
  }

  const matching = new Map<string, Message>();
  for (const { page } of pages) for (const message of page.messages) {
    if (!matching.has(message.id)) matching.set(message.id, message);
  }
  const next = pages.at(-1)?.page.before;
  const canLoadMore = next && !pages.some(({ cursor }) => cursor === next);
  const expanded = contextPages?.focus === focus ? contextPages : undefined;
  const nearby = new Map([...(expanded?.messages ?? []), ...(context?.messages ?? [])].map((message) => [message.id, message]));
  const displayed = (focus ? [...nearby.values()].sort((a, b) => Number(a.id) - Number(b.id)) : [...matching.values()])
    .filter(({ id }) => !deletedIds?.has(id));
  const searchLabel = topicId === undefined ? "Find in this conversation" : "Find in this topic";
  const mediaFilter = request?.filter === "photoVideo" || request?.filter === "photo" || request?.filter === "video";
  const gallery = !focus && mediaFilter && gallerySelected;
  const galleryPhotos = gallery ? displayed.filter((message) => message.hasPhoto)
    .map(({ id, photoSpoiler, canSavePhoto }) => ({ id, spoiler: photoSpoiler, canSave: canSavePhoto })) : undefined;
  const sectionLabel = initialMessage ? "Message context" : topicId === undefined ? "Conversation search" : "Topic search";
  const activityOnly = searchRequiresEmptyQuery(filter);
  const focusAvailable = focus && displayed.some(({ id }) => id === focus);

  function contextPageControl(direction: ContextDirection) {
    const boundary = (direction === "older" ? displayed[0] : displayed.at(-1))?.id;
    if (!focus || !focusAvailable || !loadContextPage || !boundary || !/^[1-9]\d{0,15}$/.test(boundary)) return null;
    const exhausted = expanded?.ends.includes(direction);
    const pending = contextPageRequest?.direction === direction;
    const failed = contextPageError?.direction === direction;
    const label = direction === "older" ? "earlier" : "newer";
    return <div>
      <button type="button" className="mtg-action" disabled={!!contextPageRequest || exhausted} onClick={() => {
        setContextPageError(undefined);
        setContextPageRequest({ focus, boundary, direction });
      }}>{pending ? `Loading ${label} messages…` : exhausted ? `No ${label} messages` : `Load ${label} messages`}</button>
      {failed && <p role="alert">Could not load {label} messages.</p>}
    </div>;
  }

  return <section ref={viewport} className="mtg-conversation-search" aria-label={sectionLabel}>
    {initialMessage ? <button autoFocus type="button" className="mtg-action" onClick={close}>{topicId === undefined ? "Back to conversation" : "Close original message"}</button> : <form onSubmit={submit} className="mtg-composer">
      <input autoFocus={!initialDay} type="search" aria-label={searchLabel} placeholder={searchLabel}
        disabled={activityOnly} value={activityOnly ? "" : text} maxLength={128} onChange={(event) => setText(event.target.value)} />
      <select aria-label="Search message type" disabled={activityStatus === "pending"} value={filter ?? ""} onChange={(event) => {
        const parsed = messageSearchFilter.safeParse(event.currentTarget.value);
        const nextFilter = parsed.success ? parsed.data : undefined;
        setFilter(nextFilter);
        if (initialFilter || author) startSearch(text.trim(), nextFilter, author?.sender);
      }}>
        <option value="">All messages</option>
        {messageSearchFilter.options.map((filter) => <option key={filter} value={filter} disabled={searchRequiresEmptyQuery(filter) && !!author}>{filterLabels[filter]}</option>)}
      </select>
      <button type="submit" className="mtg-action" disabled={activityStatus === "pending" || !author && !filter && text.trim().length < 2}>Find</button>
      <button type="button" className="mtg-action" onClick={close}>Close</button>
    </form>}
    {!focus && markActivityRead && activityOnly && request?.filter === filter
      && (displayed.length > 0 || canLoadMore) && <button type="button" className="mtg-action"
        disabled={activityStatus === "pending" || searchStatus === "pending"} onClick={() => void markAllActivityRead(filter)}>
        {filter === "unreadMentions" ? "Mark all mentions and replies read" : "Mark all reactions read"}
      </button>}
    {activityStatus === "saved" && <p role="status">Marked as read.</p>}
    {activityStatus === "failed" && <p role="alert">Telegram could not mark the activity as read.</p>}
    {author && <p>From <strong><bdi>{author.name}</bdi></strong>{" "}
      <button type="button" className="mtg-action" onClick={() => {
        setAuthor(undefined);
        startSearch(text.trim(), filter);
      }}>Clear author</button>
    </p>}
    {!initialMessage && loadAtDate && loadContext && <form onSubmit={(event) => void jumpToDate(event)} className="mtg-composer">
      <label>Jump to date <input autoFocus={!!initialDay} type="date" min="1970-01-01" max="2038-01-19" required value={day}
        disabled={dateStatus === "pending" || activityStatus === "pending"} onChange={(event) => { setDay(event.target.value); setDateStatus(undefined); }} /></label>
      <button type="submit" className="mtg-action" disabled={!day || dateStatus === "pending" || activityStatus === "pending"}>Go to date</button>
    </form>}
    {dateStatus === "pending" && <p role="status">Locating messages by date…</p>}
    {dateStatus === "empty" && <p role="status">No messages on or before the selected date.</p>}
    {dateStatus === "failed" && <p role="alert">Could not locate messages by date.</p>}
    {focus && dateFocus && <p>Nearest message on or before <time dateTime={dateFocus}>{dateFocus}</time></p>}
    {focus && (request || dateFocus) && <button type="button" className="mtg-action" onClick={() => {
      setFocus(undefined);
      setContext(undefined);
      setDateFocus("");
    }}>{request ? "Back to results" : "Back to search"}</button>}
    {focus && !context && <p role="status">Loading nearby messages…</p>}
    {!focus && searchStatus === "pending" && <p role="status">{pages.length ? "Updating matches…" : "Searching conversation…"}</p>}
    {focus && context?.error && <p role="alert">Could not load nearby messages.</p>}
    {!focus && searchStatus === "failed" && <p role="alert">Could not load matching messages. <button type="button" onClick={() => {
      if (request) {
        setSearchStatus("pending");
        setRequest({ ...request });
      }
    }}>Retry</button></p>}
    {focus && context && !context.error && !focusAvailable && <p role="status">This message is no longer available.</p>}
    {!focus && pages.length > 0 && !canLoadMore && !searchStatus && displayed.length === 0 && <p role="status">No matching messages</p>}
    {!focus && mediaFilter && displayed.length > 0 && <div className="mtg-media-layout" role="group" aria-label="Media layout">
      <button type="button" className="mtg-action" aria-pressed={gallery} onClick={() => setGallerySelected(true)}>Grid</button>
      <button type="button" className="mtg-action" aria-pressed={!gallery} onClick={() => setGallerySelected(false)}>List</button>
    </div>}
    {contextPageControl("older")}
    {displayed.length > 0 && (!focus || focusAvailable) && <ol aria-label={focus ? "Nearby messages" : gallery ? "Media gallery" : "Matching messages"}
      className={gallery ? "mtg-shared-media-grid" : undefined}>
      {displayed.map((message) => <li key={message.id} data-context-id={focus ? message.id : undefined} aria-current={message.id === focus ? "true" : undefined}>
        {!gallery && message.author && <MessageAuthor message={message} chat={chat} load={loadAvatar} />}
        <div className="mtg-message-time">
          {message.viewCount !== undefined && <ChannelViewCount count={message.viewCount} />}
          <MessageTimestamp message={message} />
        </div>
        <MessageContent key={`${chatId}:${message.id}`} chatId={chatId} message={message} albumPhotos={galleryPhotos} mediaCollection={gallery ? undefined : mediaCollection} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} stopPoll={stopAndRefresh} voteInPoll={voteAndRefresh} forwardActions={gallery ? undefined : forwardActions} reactionActions={gallery ? undefined : reactAndRefresh} />
        {!gallery && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && <>
          <CopyMessageReference chatId={chatId} messageId={message.id} forumTopicId={message.forumTopicId} />
          {loadMessageLink && (chat?.subtitle === "Group" || chat?.subtitle === "Channel") &&
            <CopyTelegramLink chatId={chatId} messageId={message.id} load={loadMessageLink} />}
        </>}
        {!focus && loadContext && <button type="button" className="mtg-action" onClick={() => {
          setContext(undefined);
          setFocus(message.id);
        }}>Show nearby messages</button>}
      </li>)}
    </ol>}
    {contextPageControl("newer")}
    {!focus && request && canLoadMore && <button type="button" className="mtg-action" disabled={searchStatus !== undefined}
      onClick={() => { setSearchStatus("pending"); setRequest({ ...request, before: next }); }}>Load more matches</button>}
  </section>;
}
