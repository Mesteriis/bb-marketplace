import { isSharedSpeechNote, SharedSpeechNote } from "./shared-speech-note.tsx";
import { AiTransferButton } from "./ai-transfer.tsx";
import { DocumentIcon } from "./document-icon.tsx";
import { FileInspector } from "./file-inspector.tsx";
import { extractSharedLinks, SharedLinkInspector, SharedLinkRow } from "./shared-link-row.tsx";
import { formatSize } from "./format-size.ts";
import { useTelegramLocale } from "./i18n/index.tsx";
import { photoTimeline, type DrawPhotoReplyFromMessage } from "./photo-preview.tsx";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import { CopyMessageReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { ChannelViewCount } from "./channel-view-count.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { HistoryMessageUpdates, useHistoryMessageUpdates } from "./history-message-updates.ts";
import { replaceLoadedHistoryMessage } from "../core/history-refresh.ts";
import { MessageContent } from "./message-content.tsx";
import { MessageQuoteFocus, MessageSearchLabel, MessageSearchQuery } from "./message-text.tsx";
import { MessageViewerAction, type MessageViewerLoader } from "./message-viewers.tsx";
import { messageSearchFilter, searchRequiresEmptyQuery, sharedContentFilter, type ContextDirection, type ForumTopicTarget, type UnreadActivityFilter, type MessageSender, type MessageSearchDateRange, type MessageSearchFilter, type MessageSearchPage, type PhotoSize, type TelegramPhoto } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";
import { groupMessageTimeline, localDayEnd, searchDays } from "../core/message-timeline.ts";
import { isPlainKey, moveListFocus } from "./composer-keys.ts";
import { isSaveableAttachment, useMessageSelection, type MessageSelectionActions } from "./message-selection.tsx";
import { captureHistoryScroll, historyPageKey, historyWheelDirection, observeHistoryResize, restoreHistoryScroll } from "./history-scroll.ts";
import { MessageAlbum, sharedAlbumCaption } from "./message-album.tsx";
import { BulkUnpin, MessagePin, type BulkUnpinActions, type MessagePinActions } from "./message-pin.tsx";
import { musicTrack, PlayMusic, PlaySharedMusic } from "./music-playback.tsx";
import { isPlayableAlbumTrack } from "./note-playback-queue.tsx";
import { formatPlaybackTime } from "./video-seek-preview.tsx";
import { useObjectContextMenu } from "./object-context-menu.tsx";
import { ArrowLeft, CalendarDays, File, Headphones, Image, LayoutGrid, Link2, List, MessageSquare, Mic, Play, Search } from "lucide-react";
import type { SharedContentCounts } from "../core/contract.ts";

const filterLabels: Record<MessageSearchFilter, string> = {
  photoVideo: "Photos and videos", photo: "Photos", document: "Documents", audio: "Audio", video: "Videos", voiceVideoNotes: "Voice and video messages", gif: "GIFs", link: "Links", pinned: "Pinned messages", mentions: "Mentions and replies", unreadMentions: "Unread mentions and replies", unreadReactions: "Unread reactions",
};
const libraryCategories = {
  photoVideo: { Icon: Image, label: "Photos and videos" },
  document: { Icon: File, label: "Files" },
  link: { Icon: Link2, label: "Links" },
  audio: { Icon: Headphones, label: "Audio" },
  voiceVideoNotes: { Icon: Mic, label: "Voice and video messages" },
} as const;

type Result = { messages: Message[]; error: boolean };
export type AuthorFilter = { sender: MessageSender; name: string };
type ContextPageRequest = { focus: string; boundary: string; direction: ContextDirection };

export function ConversationSearch({ chatId, chat, loadAvatar, initialMessage, initialQuote, initialSearchQuery, mediaTimestamp, initialReplyPlayback, checklistTaskId, pollOptionId, initialDay, initialFilter: requestedFilter, initialAuthor, topicId, search, searchTypes = messageSearchFilter.options, sharedLibrary, loadLibraryCounts, previewInvite, previewWebLink, loadMessageLink, loadGroupEmoji, loadAtDate, loadContext, loadContextPage, markActivityRead, bulkUnpin, bulkUnpinName, unpinTopic, pinning, pinInTopic = topicId !== undefined, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, saveSelectedAttachments, saveSelectedAttachmentsInSearch, copySelectedText, chatReportActions, voteInPoll, stopPoll, reactionActions, forwardActions, batchForward, batchDeletion, mediaCollection, messageViewers, deletedIds, drawPhotoReply, backLabel, openContainingTopic, close }: {
  chatId: string;
  chat?: Chat;
  loadAvatar?: AvatarLoader;
  initialMessage?: string;
  initialQuote?: Message["replyQuoteAnchor"];
  initialSearchQuery?: string;
  mediaTimestamp?: number;
  initialReplyPlayback?: { time: number };
  checklistTaskId?: number;
  pollOptionId?: string;
  initialDay?: string;
  initialFilter?: MessageSearchFilter;
  initialAuthor?: AuthorFilter;
  topicId?: number;
  search?: (id: string, query: string, filter?: MessageSearchFilter, topicId?: number, before?: string, sender?: MessageSender, range?: MessageSearchDateRange) => Promise<MessageSearchPage>;
  searchTypes?: readonly MessageSearchFilter[];
  sharedLibrary?: SharedContentCounts;
  previewInvite?: ComponentProps<typeof SharedLinkInspector>["previewInvite"];
  previewWebLink?: ComponentProps<typeof SharedLinkInspector>["previewWebLink"];
  loadLibraryCounts?: (id: string) => Promise<SharedContentCounts>;
  close: () => void;
  backLabel?: string;
  openContainingTopic?: () => void;
  drawPhotoReply?: DrawPhotoReplyFromMessage;
  loadMessageLink?: MessageLinkLoader;
  loadGroupEmoji?: import("./group-emoji-picker.tsx").LoadGroupEmoji;
  copySelectedText?: import("./message-selection.tsx").MessageSelectionActions["copySelectedText"];
  loadAtDate?: (id: string, date: number, topicId?: number) => Promise<string | null>;
  loadContext?: (id: string, messageId: string, topicId?: number) => Promise<Message[]>;
  bulkUnpin?: BulkUnpinActions;
  bulkUnpinName?: string;
  pinning?: MessagePinActions;
  pinInTopic?: boolean;
  unpinTopic?: ForumTopicTarget;
  markActivityRead?: (id: string, filter: UnreadActivityFilter, topicId?: number) => Promise<boolean>;
  loadContextPage?: (id: string, boundary: string, direction: ContextDirection, topicId?: number) => Promise<Message[]>;
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  batchForward?: MessageSelectionActions["batchForward"];
  batchDeletion?: MessageSelectionActions["batchDeletion"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  mediaCollection?: ComponentProps<typeof MessageContent>["mediaCollection"];
  messageViewers?: MessageViewerLoader;
  saveDocument?: (id: string, messageId: string) => Promise<boolean>;
  chatReportActions?: MessageSelectionActions["chatReportActions"];
  saveSelectedAttachments?: MessageSelectionActions["saveSelectedAttachments"];
  saveSelectedAttachmentsInSearch?: true;
  loadPhoto?: (chatId: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
  deletedIds?: ReadonlySet<string>;
}) {
  const { locale, t: tr } = useTelegramLocale();
  const initialFilter = sharedLibrary && requestedFilter === "gif" ? "photoVideo" : requestedFilter;
  const playMusic = useContext(PlayMusic);
  const [gallerySelected, setGallerySelected] = useState(true);
  const [inspectedFile, setInspectedFile] = useState<string>();
  const [inspectedNote, setInspectedNote] = useState<string>();
  const [noteReader, setNoteReader] = useState<HTMLElement | null>(null);
  const [inspectedLink, setInspectedLink] = useState<{ id: string; href?: string }>();
  const [libraryCounts, setLibraryCounts] = useState(sharedLibrary);
  useEffect(() => {
    if (!sharedLibrary || Object.keys(sharedLibrary).length || !loadLibraryCounts) return;
    let active = true;
    void loadLibraryCounts(chatId).then((counts) => { if (active) setLibraryCounts(counts); }).catch(() => {});
    return () => { active = false; };
  }, [chatId, loadLibraryCounts, sharedLibrary]);
  const [dateTools, setDateTools] = useState(false);
  const libraryTabs = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<MessageSearchFilter | undefined>(initialFilter);
  const [author, setAuthor] = useState(initialAuthor);
  const [request, setRequest] = useState<{ query: string; filter?: MessageSearchFilter; before?: string; sender?: MessageSender; range?: MessageSearchDateRange } | undefined>(
    initialFilter || initialAuthor ? { query: "", filter: initialFilter, sender: initialAuthor?.sender } : undefined,
  );
  const queryGeneration = useRef(0);
  const historyUpdates = useContext(HistoryMessageUpdates);
  const queuedEdits = useRef(new Set<string | undefined>());
  const deletedSearchResults = useRef(new Set<string>());
  const [editRevision, setEditRevision] = useState(0);
  const searchPages = useRef<Array<{ cursor?: string; page: MessageSearchPage }>>([]);
  const [pages, setPages] = useState<Array<{ cursor?: string; page: MessageSearchPage }>>([]);
  useLayoutEffect(() => { searchPages.current = pages; }, [pages]);
  const [removedPins, setRemovedPins] = useState<ReadonlySet<string>>(new Set());
  const pinFocus = useRef<{ id?: string }>(undefined);
  const [searchStatus, setSearchStatus] = useState<"pending" | "failed" | undefined>(initialFilter || initialAuthor ? "pending" : undefined);
  const [activityStatus, setActivityStatus] = useState<"pending" | "saved" | "failed">();
  const [day, setDay] = useState(initialDay ?? "");
  const [fromDay, setFromDay] = useState("");
  const [throughDay, setThroughDay] = useState("");
  const dates = searchDays(fromDay, throughDay);
  const [dateStatus, setDateStatus] = useState<"pending" | "empty" | "failed">();
  const [dateFocus, setDateFocus] = useState("");
  const [focus, setFocus] = useState(initialMessage);
  useLayoutEffect(() => {
    const tabs = libraryTabs.current;
    const active = tabs?.querySelector('button[aria-pressed="true"]');
    if (!tabs || !active) return;
    const strip = tabs.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < strip.left) tabs.scrollLeft += tab.left - strip.left;
    else if (tab.right > strip.right) tabs.scrollLeft += tab.right - strip.right;
  }, [filter, focus]);
  const objectMenu = useObjectContextMenu(`${chatId}:${topicId ?? ""}:${focus ?? ""}`);
  const focusForScroll = useRef(focus);
  useLayoutEffect(() => { focusForScroll.current = focus; }, [focus]);
  const [resultQuote, setResultQuote] = useState<Message["replyQuoteAnchor"]>();
  const focusedQuote = focus === initialMessage ? initialQuote : resultQuote;
  const [replyPlayback, setReplyPlayback] = useState(() => initialMessage && initialReplyPlayback
    ? { id: initialMessage, time: initialReplyPlayback.time } : undefined);
  const [focusQuery, setFocusQuery] = useState(initialSearchQuery);
  const [contextRevision, setContextRevision] = useState(0);
  const [context, setContext] = useState<Result>();
  const [contextPageRequest, setContextPageRequest] = useState<ContextPageRequest>();
  const [contextPages, setContextPages] = useState<{ focus: string; messages: Message[]; ends: ContextDirection[] }>();
  const [contextPageError, setContextPageError] = useState<ContextPageRequest>();
  const viewport = useRef<HTMLElement>(null);
  const setLibraryViewport = useCallback((element: HTMLDivElement | null) => { viewport.current = element; }, []);
  const searchField = useRef<HTMLInputElement>(null);
  const nearbyBack = useRef<HTMLButtonElement>(null);
  const returnMatch = useRef<{ id: string; top: number; source?: "reply" | "photo"; link?: string } | undefined>(undefined);
  const scrollAnchor = useRef<ReturnType<typeof captureHistoryScroll> | undefined>(undefined);
  const contextPending = useRef(false);
  const lastContextTop = useRef(0);
  const feedTouchStart = useRef<number>(undefined);
  const centeredMessage = useRef<string | undefined>(undefined);

  useEffect(() => {
    setContextPageRequest(undefined);
    setContextPageError(undefined);
    setContextPages(undefined);
    scrollAnchor.current = undefined;
    contextPending.current = false;
  }, [chatId, focus, topicId]);

  useEffect(() => {
    if (!focus || contextPageRequest?.focus !== focus || !loadContextPage) return;
    const { boundary, direction } = contextPageRequest;
    let active = true;
    void loadContextPage(chatId, boundary, direction, topicId).then((messages) => {
      if (!active) return;
      const next = messages.filter(({ id }) => direction === "older" ? Number(id) < Number(boundary) : Number(id) > Number(boundary));
      const panel = viewport.current;
      if (panel && next.length) scrollAnchor.current = captureHistoryScroll(panel, direction === "older" ? "prepend" : "keep");
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
    restoreHistoryScroll(panel, anchor);
    lastContextTop.current = panel.scrollTop;
  }, [contextPages, context, pages]);

  useLayoutEffect(() => {
    if (!contextPageRequest) contextPending.current = false;
  }, [contextPageRequest]);

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
    const { query, filter, before, sender, range } = request;
    const results = range ? search(chatId, query, filter, topicId, before, sender, range)
      : sender ? search(chatId, query, filter, topicId, before, sender)
      : before !== undefined ? search(chatId, query, filter, topicId, before)
      : topicId !== undefined ? search(chatId, query, filter, topicId)
      : filter ? search(chatId, query, filter) : search(chatId, query);
    void results.then((page) => {
      if (!current) return;
      const panel = viewport.current;
      if (!focusForScroll.current && panel && searchPages.current.some(({ cursor }) => cursor === before)) {
        const remaining = new Set(page.messages.map(({ id }) => id));
        const replaced = searchPages.current.find(({ cursor }) => cursor === before);
        const removed = new Set(replaced?.page.messages.flatMap(({ id }) => remaining.has(id) ? [] : [id]) ?? []);
        scrollAnchor.current ??= captureHistoryScroll(panel, "keep", removed);
      }
      setPages((previous) => {
        const index = previous.findIndex(({ cursor }) => cursor === before);
        const visible = { ...page, messages: page.messages.filter(({ id }) => !deletedSearchResults.current.has(id)) };
        const entry = { cursor: before, page: visible };
        if (index < 0) return [...previous, entry];
        const revised = index < previous.length - 1
          ? { ...entry, page: { ...visible, before: previous[index]!.page.before } }
          : entry;
        return previous.map((row, i) => i === index ? revised : row);
      });
      setSearchStatus(undefined);
    }, () => { if (current) setSearchStatus("failed"); });
    return () => { current = false; };
  }, [chatId, request, search, topicId]);

  useLayoutEffect(() => {
    queuedEdits.current.clear();
    deletedSearchResults.current.clear();
    const unsubscribe = historyUpdates?.subscribe(({ id, messageId }) => {
      if (id !== chatId || deletedSearchResults.current.has(messageId)) return;
      let queued = false;
      for (const { cursor, page } of searchPages.current) {
        if (queuedEdits.current.has(cursor) || !page.messages.some((message) => message.id === messageId)) continue;
        queuedEdits.current.add(cursor);
        queued = true;
      }
      if (queued) setEditRevision((revision) => revision + 1);
    });
    const unsubscribeDeletions = historyUpdates?.subscribeToDeletions?.(({ id, messageIds, retained }) => {
      if (id !== chatId) return;
      const removed = new Set([...messageIds, ...(retained?.map((row) => row.id) ?? [])]);
      for (const messageId of removed) deletedSearchResults.current.add(messageId);
      const visible = searchPages.current.some(({ page }) => page.messages.some((message) => removed.has(message.id)));
      if (visible && !focusForScroll.current && viewport.current && !scrollAnchor.current) {
        scrollAnchor.current = captureHistoryScroll(viewport.current, "keep", removed);
      }
      setPages((previous) => {
        const next = previous.map((entry) => {
          const messages = entry.page.messages.filter((message) => !removed.has(message.id));
          return messages.length === entry.page.messages.length ? entry : { ...entry, page: { ...entry.page, messages } };
        });
        return next.some((entry, index) => entry !== previous[index]) ? next : previous;
      });
    });
    return () => { unsubscribe?.(); unsubscribeDeletions?.(); };
  }, [chatId, historyUpdates, topicId]);
  useEffect(() => {
    if (!request || !search || searchStatus === "pending") return;
    const next = queuedEdits.current.values().next();
    if (next.done) return;
    queuedEdits.current.delete(next.value);
    setSearchStatus("pending");
    setRequest({ ...request, before: next.value });
  }, [editRevision, request, search, searchStatus]);

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
    async setReaction(id: string, messageId: string, reaction: import("../core/contract.ts").SelectableReaction, chosen: boolean) {
      const generation = queryGeneration.current;
      const accepted = await reactionActions.setReaction(id, messageId, reaction, chosen);
      if (accepted) refreshMessage(messageId, generation);
      return accepted;
    },
  };

  function startSearch(query: string, nextFilter?: MessageSearchFilter, sender?: MessageSender) {
    const activity = searchRequiresEmptyQuery(nextFilter);
    if (activity) query = "";
    else if (dates?.success === false) return;
    const canSearch = !!nextFilter || !!sender || query.length >= 2;
    if (sharedLibrary && viewport.current) {
      viewport.current.scrollTop = 0;
      lastContextTop.current = 0;
    }
    queryGeneration.current++;
    queuedEdits.current.clear();
    searchPages.current = [];
    returnMatch.current = undefined;
    setActivityStatus(undefined);
    setDateStatus(undefined);
    setDateFocus("");
    setResultQuote(undefined);
    setReplyPlayback(undefined);
    setFocus(undefined);
    setContext(undefined);
    setPages([]);
    setInspectedLink(undefined);
    setInspectedNote(undefined);
    setRemovedPins(new Set());
    setSearchStatus(canSearch ? "pending" : undefined);
    setRequest(canSearch ? { query, filter: nextFilter, sender, range: activity ? undefined : dates?.data } : undefined);
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

  function chooseLibraryCategory(next: MessageSearchFilter) {
    if (filter === next) return;
    setFilter(next);
    startSearch(text.trim(), next, author?.sender);
  }

  async function jumpToDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loadAtDate || dateStatus === "pending") return;
    const end = localDayEnd(day);
    if (end === undefined) return;

    const generation = ++queryGeneration.current;
    setDateStatus("pending");
    try {
      const id = await (topicId === undefined ? loadAtDate(chatId, end) : loadAtDate(chatId, end, topicId));
      if (generation !== queryGeneration.current) return;
      setDateStatus(id ? undefined : "empty");
      setResultQuote(undefined);
      setReplyPlayback(undefined);
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
      setFocusQuery(undefined);
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
  useHistoryMessageUpdates(chatId, topicId, !!focus, (id) => !deletedIds?.has(id) && !!nearby.get(id) && !nearby.get(id)?.retained, (row) => {
    const panel = viewport.current;
    if (panel && !scrollAnchor.current) scrollAnchor.current = captureHistoryScroll(panel, "keep");
    setContext((previous) => previous && replaceLoadedHistoryMessage(previous, row));
    setContextPages((previous) => previous && previous.focus === focus ? replaceLoadedHistoryMessage(previous, row) : previous);
  });
  const pinnedResults = !focus && request?.filter === "pinned";
  const displayed = (focus ? [...nearby.values()].sort((a, b) => Number(a.id) - Number(b.id)) : [...matching.values()])
    .filter(({ id }) => !deletedIds?.has(id) && !(pinnedResults && removedPins.has(id)));
  const linkLibrary = !!sharedLibrary && !focus && filter === "link";
  const speechLibrary = !!sharedLibrary && !focus && filter === "voiceVideoNotes";
  const audioLibrary = !!sharedLibrary && !focus && filter === "audio";
  const searchLabel = sharedLibrary ? tr(linkLibrary ? "Search links" : filter === "document" ? "Search files" : audioLibrary ? "Search audio" : speechLibrary ? "Search voice and video messages" : "Search shared media") : topicId === undefined ? tr("Find in this conversation") : tr("Find in this topic");
  const mediaFilter = request?.filter === "photoVideo" || request?.filter === "photo" || request?.filter === "video";
  const gallery = !focus && mediaFilter && gallerySelected;
  const loadingLibrary = !!sharedLibrary && !focus && searchStatus === "pending";
  const loadingCategory = loadingLibrary ? sharedContentFilter.safeParse(filter).data : undefined;
  const loadingCount = loadingCategory ? libraryCounts?.[loadingCategory] : undefined;
  const skeletonLimit = gallery ? 8 : 5;
  const skeletonCount = loadingCount ? Math.min(skeletonLimit, loadingCount) : skeletonLimit;
  const canOpenPhotoMessage = !focus && mediaFilter && !!loadContext;
  const galleryPhotos = (mediaFilter || focus) ? photoTimeline(displayed) : undefined;
  const morePhotos = !focus && mediaFilter && request?.filter !== "video" && canLoadMore && request ? {
    pending: searchStatus === "pending",
    failed: searchStatus === "failed" && request.before === next,
    load: loadMoreMatches,
  } : undefined;
  const drawablePhoto = (id: string) => displayed.find((message) => message.id === id && message.canSavePhoto
    && !message.pendingDelivery && !message.failedDelivery && !message.retained);
  const drawFromGallery = drawPhotoReply && mediaFilter && !focus ? {
    verify: async (id: string) => {
      const source = drawablePhoto(id);
      return !!source && await drawPhotoReply.verify(source);
    },
    stage: async (id: string, data: string) => {
      const source = drawablePhoto(id);
      return !!source && await drawPhotoReply.stage(source, data);
    },
  } : undefined;
  const sectionLabel = sharedLibrary ? tr("Shared media") : initialMessage ? tr("Message context") : topicId === undefined ? tr("Conversation search") : tr("Topic search");
  const browsingShared = sharedContentFilter.safeParse(initialFilter).success;
  const playShared = (browsingShared || audioLibrary) && !focus && request?.filter === "audio" && playMusic && loadMedia
    ? (id: string, opener?: HTMLButtonElement) => {
      const toTracks = (messages: readonly Message[]) => messages.flatMap((message) =>
        deletedIds?.has(message.id) ? [] : musicTrack(message, chatId, loadMedia, loadVideoStream) ?? []);
      const tracks = toTracks(displayed);
      const more = canLoadMore && search ? {
        cursor: next,
        load: async (cursor: string) => {
          const page = await search(chatId, request.query, "audio", topicId, cursor, request.sender, request.range);
          return { tracks: toTracks(page.messages), before: page.before };
        },
      } : undefined;
      playMusic(tracks, tracks.findIndex(({ messageId }) => messageId === id), {
        more, viewer: opener && { opener, save: saveDocument, openSource: loadContext ? async (track, signal) => {
          if (signal.aborted || !viewport.current?.isConnected) return false;
          inspectSource(track.messageId);
          return true;
        } : undefined },
      });
    } : undefined;
  const report = chat && chatReportActions;
  const selectionForward = !gallery && forwardActions ? batchForward : undefined;
  const selectionDeletion = !gallery ? batchDeletion : undefined;
  const saveAttachments = saveSelectedAttachmentsInSearch || browsingShared && !focus ? saveSelectedAttachments : undefined;
  const selection = useMessageSelection(chatId,
    new Map((report || copySelectedText || selectionForward || selectionDeletion ? displayed : displayed.filter(isSaveableAttachment)).map((item) => [item.id, item])),
    { saveSelectedAttachments: saveAttachments, chatReportActions: report, copySelectedText,
      batchForward: selectionForward, batchDeletion: selectionDeletion },
    forwardActions, !!(report || copySelectedText || selectionForward || selectionDeletion || saveAttachments || browsingShared && !focus), deletedIds,
    JSON.stringify([request?.filter, request?.query, request?.range, focus, gallery]), chat?.name);
  const activityOnly = searchRequiresEmptyQuery(filter);
  const pinGeneration = queryGeneration.current;
  function removePin(id: string, restoreFocus: boolean) {
    if (pinGeneration !== queryGeneration.current) return;
    if (restoreFocus) {
      const index = displayed.findIndex((match) => match.id === id);
      pinFocus.current = { id: displayed[index + 1]?.id ?? displayed[index - 1]?.id };
    }
    setRemovedPins((previous) => new Set([...previous, id]));
  }

  useLayoutEffect(() => {
    const next = pinFocus.current;
    if (!next) return;
    pinFocus.current = undefined;
    const panel = viewport.current;
    const row = Array.from(panel?.querySelectorAll<HTMLElement>("[data-pinned-result]") ?? [])
      .find(({ dataset }) => dataset.pinnedResult === next.id);
    (row?.querySelector<HTMLButtonElement>("button[data-message-pin]")
      ?? (searchField.current?.disabled ? panel : searchField.current) ?? panel)?.focus({ preventScroll: true });
  }, [removedPins]);

  const focusAvailable = focus && displayed.some(({ id }) => id === focus);

  useLayoutEffect(() => {
    if (!focus) {
      centeredMessage.current = undefined;
      const previous = returnMatch.current;
      const panel = viewport.current;
      if (previous && panel) {
        returnMatch.current = undefined;
        const attribute = previous.source === "reply" ? "data-result-reply"
          : previous.source === "photo" ? "data-photo-opener" : "data-search-result";
        const button = Array.from(panel.querySelectorAll<HTMLButtonElement>(`button[${attribute}]`))
          .find((item) => item.getAttribute(attribute) === previous.id &&
            (previous.link === undefined || item.dataset.linkInspect === previous.link));
        const photoRow = previous.source === "photo" && Array.from(panel.querySelectorAll<HTMLElement>("[data-photo-result]"))
          .find((item) => item.dataset.photoResult === previous.id);
        const input = searchField.current;
        (button ?? (photoRow || undefined) ?? (input && !input.disabled ? input : panel)).focus({ preventScroll: true });
        panel.scrollTop = previous.top;
      }
      return;
    }
    if (!focusAvailable || centeredMessage.current === focus) return;
    const panel = viewport.current;
    const row = panel?.querySelector<HTMLElement>('li[aria-current="true"]');
    if (!panel || !row) return;
    const linkedItem = focus === initialMessage ? row.querySelector<HTMLElement>('li[aria-current="location"]') : null;
    const quote = focusedQuote ? panel.querySelector<HTMLElement>("[data-reply-quote-match]") : undefined;
    const quoteBounds = quote?.getBoundingClientRect();
    const target = quoteBounds?.height ? quoteBounds : (linkedItem ?? row).getBoundingClientRect();
    (linkedItem ?? (returnMatch.current && panel.ownerDocument.activeElement === nearbyBack.current ? row : undefined))?.focus({ preventScroll: true });
    const inset = Math.max(0, (panel.clientHeight - target.height) / 2);
    panel.scrollTop = Math.max(0, panel.scrollTop + target.top - panel.getBoundingClientRect().top - inset);
    centeredMessage.current = focus;
    lastContextTop.current = panel.scrollTop;
  }, [focus, focusAvailable, initialMessage, focusedQuote]);

  useLayoutEffect(() => {
    const panel = viewport.current;
    if (!panel || !focusAvailable) return;
    return observeHistoryResize(panel, () => panel.isConnected, () => false, () => {
      lastContextTop.current = panel.scrollTop;
    });
  }, [focusAvailable, contextPages, context]);

  function showNearbyMessages(id: string, time?: number) {
    setReplyPlayback(time === undefined ? undefined : { id, time });
    if (id === focus) return;
    setResultQuote(undefined);
    setContext(undefined);
    if (!focus) setFocusQuery(request?.query);
    setFocus(id);
  }

  function loadMoreMatches() {
    if (!request || !canLoadMore || searchStatus === "pending") return;
    setSearchStatus("pending");
    setRequest({ ...request, before: next });
  }

  function loadLibraryAtEnd(panel: HTMLElement) {
    if (!sharedLibrary || focus || searchStatus || panel.scrollHeight - panel.clientHeight - panel.scrollTop > 12) return;
    loadMoreMatches();
  }

  function onViewportScroll(panel: HTMLElement) {
    const top = panel.scrollTop;
    const previous = lastContextTop.current;
    lastContextTop.current = top;
    if (focusAvailable && top !== previous) loadContextAtEdge(panel, top < previous ? "up" : "down", 96);
    else if (top > previous) loadLibraryAtEnd(panel);
  }

  function openResultPhoto(opener: string, selected: string) {
    returnMatch.current = { id: opener, top: viewport.current?.scrollTop ?? 0, source: "photo" };
    showNearbyMessages(selected);
  }

  function openResultOriginal(message: Message) {
    if (!message.replyTo) return;
    returnMatch.current = { id: message.id, top: viewport.current?.scrollTop ?? 0, source: "reply" };
    showNearbyMessages(message.replyTo);
    setResultQuote(message.replyQuoteAnchor);
  }

  function backToResults() {
    setResultQuote(undefined);
    setReplyPlayback(undefined);
    setFocus(undefined);
    setContext(undefined);
    setDateFocus("");
  }

  function contextBoundary(direction: ContextDirection) {
    const boundary = (direction === "older" ? displayed[0] : displayed.at(-1))?.id;
    return focus && focusAvailable && loadContextPage && boundary && /^[1-9]\d{0,15}$/.test(boundary) ? boundary : undefined;
  }

  function requestContextPage(direction: ContextDirection, retry = false) {
    const boundary = contextBoundary(direction);
    if (!focus || !boundary || contextPending.current || expanded?.ends.includes(direction)
      || (!retry && contextPageError?.direction === direction)) return false;
    contextPending.current = true;
    setContextPageError(undefined);
    setContextPageRequest({ focus, boundary, direction });
    return true;
  }

  function loadContextAtEdge(panel: HTMLElement, direction: "up" | "down", threshold: number) {
    const distance = direction === "up" ? panel.scrollTop : panel.scrollHeight - panel.clientHeight - panel.scrollTop;
    return distance <= threshold && requestContextPage(direction === "up" ? "older" : "newer");
  }

  function contextPageControl(direction: ContextDirection) {
    if (!contextBoundary(direction)) return null;
    const exhausted = expanded?.ends.includes(direction);
    const pending = contextPageRequest?.direction === direction;
    const failed = contextPageError?.direction === direction;
    const label = direction === "older" ? tr("earlier") : tr("newer");
    return <div>
      <button type="button" className="mtg-action" disabled={!!contextPageRequest || exhausted}
        onClick={() => requestContextPage(direction, true)}>
        {pending ? tr("Loading {0} messages…", [label]) : exhausted ? tr("No {0} messages", [label]) : tr("Load {0} messages", [label])}
      </button>
      {failed && <p role="alert">{tr("Could not load ")}{label}{tr(" messages.")}</p>}
    </div>;
  }

  const dateFields = <>
    <label>{tr("From date ")}<input type="date" value={fromDay} max={throughDay || undefined}
      onChange={(event) => setFromDay(event.currentTarget.value)} /></label>
    <label>{tr("Through date ")}<input type="date" value={throughDay} min={fromDay || undefined}
      onChange={(event) => setThroughDay(event.currentTarget.value)} /></label>
    {(fromDay || throughDay) && <button type="button" className="mtg-action" onClick={() => {
      setFromDay("");
      setThroughDay("");
    }}>{tr("Clear dates")}</button>}
    {dates?.success === false && <p role="alert">{tr("Choose a valid date range.")}</p>}
  </>;
  const jumpDateForm = !initialMessage && loadAtDate && loadContext && <form onSubmit={(event) => void jumpToDate(event)} className="mtg-composer">
    <label>{tr("Jump to date ")}<input autoFocus={!!initialDay} type="date" min="1970-01-01" max="2038-01-19" required value={day}
      disabled={dateStatus === "pending" || activityStatus === "pending"} onChange={(event) => { setDay(event.target.value); setDateStatus(undefined); }} /></label>
    <button type="submit" className="mtg-action" disabled={!day || dateStatus === "pending" || activityStatus === "pending"}>{tr("Go to date")}</button>
  </form>;
  const audioRows = audioLibrary && playShared
    ? displayed.filter((message) => !deletedIds?.has(message.id) && isPlayableAlbumTrack(message)) : [];
  const speechRows = speechLibrary && (loadMedia || loadVideoStream)
    ? displayed.filter((message) => !deletedIds?.has(message.id) && isSharedSpeechNote(message)
      && (!!loadMedia || message.videoNote && !message.document?.approximateSize)) : [];
  const specializedIds = new Set([...audioRows, ...speechRows].map(({ id }) => id));
  const messageRows = specializedIds.size ? displayed.filter(({ id }) => !specializedIds.has(id)) : displayed;
  const activeNote = speechRows.find(({ id }) => id === inspectedNote);
  const speechDate = new Intl.DateTimeFormat(locale, { dateStyle: "long" });
  const speechDay = (message?: Message) => message?.timestamp ? speechDate.format(message.timestamp * 1000) : undefined;
  const monthLabels = sharedLibrary && (gallery || linkLibrary)
    ? new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" })
    : undefined;
  const monthFor = (message?: Message) => monthLabels && message?.timestamp
    ? monthLabels.format(message.timestamp * 1000)
    : undefined;

  const inViewport = (contents: ReactNode) => sharedLibrary
    ? <div ref={setLibraryViewport} className="mtg-library-feed" tabIndex={0}
      role="region" aria-label={tr("Shared media results")} onScroll={(event) => onViewportScroll(event.currentTarget)}
      onTouchStart={(event) => { feedTouchStart.current = event.touches[0]?.clientY; }}
      onTouchEnd={(event) => {
        const start = feedTouchStart.current;
        const end = event.changedTouches[0]?.clientY;
        feedTouchStart.current = undefined;
        if (start !== undefined && end !== undefined && start - end > 24) loadLibraryAtEnd(event.currentTarget);
      }}>{contents}</div>
    : contents;

  const fileLibrary = !!sharedLibrary && !focus && filter === "document";
  const files = fileLibrary ? displayed.filter((message) => !!message.document) : [];
  const inspected = files.find(({ id }) => id === inspectedFile);
  const transferable = (message: Message) => message.document?.downloadable && !message.pendingDelivery && !message.oneView
    && !message.retained && !message.restricted && !message.failedDelivery;
  const selectedFiles = files.filter((message) => transferable(message) && selection.selectedIds.includes(message.id))
    .map(({ id, document }) => ({ id, chatId, name: document!.name }));
  const fileDate = (message: Message) => message.timestamp === undefined
    ? <MessageTimestamp message={message} />
    : <time dateTime={new Date(message.timestamp * 1000).toISOString()}>
      {new Date(message.timestamp * 1000).toLocaleDateString(locale, { dateStyle: "medium" })}
    </time>;
  function inspectSource(id: string, link?: string) {
    returnMatch.current = { id, top: viewport.current?.scrollTop ?? 0, link };
    showNearbyMessages(id);
  }
  const fileInspector = inspected?.document && <FileInspector key={inspected.id} chatId={chatId}
    message={inspected} document={inspected.document} date={fileDate(inspected)} shareable={!!transferable(inspected)}
    showSource={loadContext ? () => inspectSource(inspected.id) : undefined} close={() => {
      viewport.current?.querySelector<HTMLButtonElement>(`[data-file-inspect][data-search-result="${inspected.id}"]`)?.focus({ preventScroll: true });
      setInspectedFile(undefined);
    }} saveDocument={saveDocument} loadMedia={loadMedia} loadVideoStream={loadVideoStream}
    forwardActions={forwardActions} reactionActions={reactAndRefresh} />;

  const inspectedLinkMessage = linkLibrary ? displayed.find(({ id }) => id === inspectedLink?.id) : undefined;
  const selectedLink = inspectedLinkMessage && extractSharedLinks(inspectedLinkMessage).find(({ url }) => url.href === inspectedLink?.href);
  function closeLinkInspector() {
    const row = Array.from(viewport.current?.querySelectorAll<HTMLButtonElement>("button[data-link-inspect]") ?? [])
      .find(({ dataset }) => dataset.searchResult === inspectedLink?.id && dataset.linkInspect === (inspectedLink?.href ?? ""));
    (row ?? searchField.current ?? viewport.current)?.focus({ preventScroll: true });
    setInspectedLink(undefined);
  }
  const linkInspector = inspectedLinkMessage && (selectedLink || inspectedLink?.href === undefined) &&
    <SharedLinkInspector key={JSON.stringify(inspectedLink)} chatId={chatId} message={inspectedLinkMessage} link={selectedLink}
      close={closeLinkInspector} previewInvite={previewInvite} previewWebLink={previewWebLink} showSource={loadContext ? () => inspectSource(inspectedLinkMessage.id, inspectedLink?.href ?? "") : undefined} />;
  function closeNoteReader() {
    const row = Array.from(viewport.current?.querySelectorAll<HTMLButtonElement>("button[data-note-inspect]") ?? [])
      .find((button) => button.dataset.searchResult === inspectedNote);
    (row ?? searchField.current ?? viewport.current)?.focus({ preventScroll: true });
    setInspectedNote(undefined);
  }
  const libraryLayout = (content: ReactNode) => fileLibrary || linkLibrary || speechLibrary
    ? <div className={`mtg-file-library${linkLibrary ? " mtg-link-library" : ""}${speechLibrary ? " mtg-speech-library" : ""}`}>
      {content}{fileInspector}{linkInspector}
      {activeNote && <aside className="mtg-speech-reader" ref={setNoteReader} aria-label={tr("Note details")} />}
    </div> : content;

  return <section ref={sharedLibrary ? undefined : viewport} className="mtg-conversation-search" data-shared-library={sharedLibrary ? true : undefined} aria-label={sectionLabel} tabIndex={-1}
    onContextMenu={objectMenu.onContextMenu}
    data-context-view={!!focus} aria-keyshortcuts={focus && loadContextPage ? "Escape ArrowUp ArrowDown PageUp PageDown Home End" : "Escape"}
    onScroll={sharedLibrary ? undefined : (event) => onViewportScroll(event.currentTarget)}
    onWheel={(event) => {
      const panel = viewport.current;
      if (!panel || !(event.target instanceof Element)
        || !panel.contains(event.target) || event.target.closest("dialog, [role=dialog], textarea, select, [contenteditable]")) return;
      const direction = historyWheelDirection(event);
      if (focusAvailable && direction) loadContextAtEdge(panel, direction, 96);
      else if (direction === "down") loadLibraryAtEnd(panel);
    }}
    onKeyDown={(event) => {
      objectMenu.onKeyDown(event);
      if (event.defaultPrevented) return;
      if (focusAvailable && !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        const target = event.target;
        const row = target instanceof HTMLElement && (target === viewport.current || target.dataset.contextId && event.currentTarget.contains(target)) ? target : undefined;
        const direction = historyPageKey(event, "up", row) ? "up" : historyPageKey(event, "down", row) ? "down" : undefined;
        if (direction && viewport.current && loadContextAtEdge(viewport.current, direction, 0)) {
          event.preventDefault();
          return;
        }
      }
      if (sharedLibrary && event.target === viewport.current && ["End", "PageDown", "ArrowDown"].includes(event.key)
        && isPlainKey(event, event.key) && viewport.current) loadLibraryAtEnd(viewport.current);
      if (activeNote && isPlainKey(event, "Escape") && !event.currentTarget.querySelector(":is(select:open)")
        && event.target instanceof Element
        && event.target.closest(".mtg-speech-reader, button[data-note-inspect]")) {
        event.preventDefault();
        event.stopPropagation();
        closeNoteReader();
        return;
      }
      if (linkInspector && isPlainKey(event, "Escape") && event.target instanceof Element
        && event.target.closest("button[data-link-inspect]")) {
        event.preventDefault();
        event.stopPropagation();
        closeLinkInspector();
        return;
      }
      if (!focus && moveListFocus(event, searchField.current, "button[data-search-result]:enabled")) return;
      if (!isPlainKey(event, "Escape") || !(event.target instanceof HTMLElement)
        || !event.currentTarget.contains(event.target)
        || event.currentTarget.contains(event.target.closest("select, dialog, [role=dialog], [contenteditable]"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (focus && returnMatch.current && !selection.active) backToResults();
      else close();
    }}>
    {sharedLibrary ? <header className="mtg-library-header">
      <div className="mtg-library-heading">
        <button type="button" className="mtg-library-icon" aria-label={tr("Back to conversation")} title={tr("Back to conversation")} onClick={close}>
          <ArrowLeft size={19} aria-hidden="true" />
        </button>
        <h2>{tr("Shared media")}</h2>
        {chat?.name && <bdi title={chat.name}>{chat.name}</bdi>}
      </div>
      {!focus && <>
        <div ref={libraryTabs} className="mtg-library-categories" role="group" aria-label={tr("Shared content type")}>
          {sharedContentFilter.options.filter((option) => option !== "gif").map((option) => {
            const { Icon, label } = libraryCategories[option];
            const count = libraryCounts?.[option];
            return <button type="button" key={option} aria-pressed={filter === option} onClick={() => chooseLibraryCategory(option)}>
              <Icon size={17} aria-hidden="true" /><span>{tr(label)}</span>
              {filter === option && count !== undefined && <span className="mtg-shared-count">{count.toLocaleString(locale)}</span>}
            </button>;
          })}
        </div>
        <div className="mtg-library-tools">
          <form className="mtg-library-search" onSubmit={submit}>
            <button type="submit" className="mtg-library-icon" title={tr("Find")} aria-label={tr("Find")} disabled={dates?.success === false}>
              <Search size={17} aria-hidden="true" />
            </button>
            <input ref={searchField} autoFocus type="search" aria-label={searchLabel} placeholder={searchLabel}
              aria-keyshortcuts={loadContext ? "ArrowDown" : undefined} value={text} maxLength={128} onChange={(event) => setText(event.currentTarget.value)} />
          </form>
          {search && <button type="button" className="mtg-library-icon" aria-expanded={dateTools} data-filtered={!!(fromDay || throughDay)}
            aria-label={tr("Filter by date")} title={tr("Filter by date")} onClick={() => setDateTools((open) => !open)}>
            <CalendarDays size={17} aria-hidden="true" />
          </button>}
          {mediaFilter && <div className="mtg-library-layout" role="group" aria-label={tr("Media layout")}>
            <button type="button" className="mtg-library-icon" aria-label={tr("Grid")} title={tr("Grid")} aria-pressed={gallery}
              onClick={() => setGallerySelected(true)}><LayoutGrid size={17} aria-hidden="true" /></button>
            <button type="button" className="mtg-library-icon" aria-label={tr("List")} title={tr("List")} aria-pressed={!gallery}
              onClick={() => setGallerySelected(false)}><List size={17} aria-hidden="true" /></button>
          </div>}
          {selection.start(undefined, true)}
        </div>
        {dateTools && <div className="mtg-library-dates">
          <form className="mtg-library-range" onSubmit={(event) => { submit(event); if (dates?.success !== false) setDateTools(false); }}>
            {dateFields}
            <button type="submit" className="mtg-action" disabled={dates?.success === false}>{tr("Apply")}</button>
          </form>
          {jumpDateForm}
        </div>}
      </>}
    </header> : initialMessage ? <button autoFocus type="button" className="mtg-action" onClick={close}>{backLabel ?? (topicId === undefined ? tr("Back to conversation") : tr("Close original message"))}</button> : <form onSubmit={submit} className="mtg-composer">
      <input ref={searchField} autoFocus={!initialDay} type="search" aria-keyshortcuts={loadContext ? "ArrowDown" : undefined} aria-label={searchLabel} placeholder={searchLabel}
        disabled={activityOnly} value={activityOnly ? "" : text} maxLength={128} onChange={(event) => setText(event.target.value)} />
      {!browsingShared && <select aria-label={tr("Search message type")} disabled={activityStatus === "pending"} value={filter ?? ""} onChange={(event) => {
        const nextFilter = searchTypes.find((type) => type === event.currentTarget.value);
        setFilter(nextFilter);
        if (initialFilter || author) startSearch(text.trim(), nextFilter, author?.sender);
      }}>
        <option value="">{tr("All messages")}</option>
        {searchTypes.map((filter) => <option key={filter} value={filter} disabled={searchRequiresEmptyQuery(filter) && !!author}>{tr(filterLabels[filter])}</option>)}
      </select>}
      <button type="submit" className="mtg-action" disabled={activityStatus === "pending"
        || (!activityOnly && dates?.success === false) || (!author && !filter && text.trim().length < 2)}>{tr("Find")}</button>
      <button type="button" className="mtg-action" onClick={close}>{tr("Close")}</button>
    </form>}
    {openContainingTopic && <button type="button" className="mtg-action" onClick={openContainingTopic}>{tr("Open containing topic")}</button>}
    {!sharedLibrary && !initialMessage && search && !activityOnly && <details className="mtg-global-search-filter">
      <summary>{fromDay || throughDay ? tr("Search dates · selected") : tr("Filter by date")}</summary>
      {dateFields}
    </details>}
    {!sharedLibrary && !initialMessage && browsingShared && <div className="mtg-kind-filter" role="group" aria-label={tr("Shared content type")}>
      {sharedContentFilter.options.map((option) => <button type="button" key={option} aria-pressed={filter === option}
        onClick={() => chooseLibraryCategory(option)}>{tr(filterLabels[option])}</button>)}
    </div>}
    {!focus && markActivityRead && activityOnly && request?.filter === filter
      && (displayed.length > 0 || canLoadMore) && <button type="button" className="mtg-action"
        disabled={activityStatus === "pending" || searchStatus === "pending"} onClick={() => void markAllActivityRead(filter)}>
        {filter === "unreadMentions" ? tr("Mark all mentions and replies read") : tr("Mark all reactions read")}
      </button>}
    {!focus && bulkUnpin && (topicId === undefined || unpinTopic?.id === topicId)
      && request?.filter === "pinned" && !request.query && !request.sender && !request.range &&
      <BulkUnpin key={JSON.stringify([chatId, unpinTopic])} chatId={chatId} topic={unpinTopic} conversationName={bulkUnpinName} actions={bulkUnpin} hasPins={displayed.length > 0 && searchStatus !== "pending"}
        refresh={() => startSearch("", "pinned")} />}
    {activityStatus === "saved" && <p role="status">{tr("Marked as read.")}</p>}
    {activityStatus === "failed" && <p role="alert">{tr("Telegram could not mark the activity as read.")}</p>}
    {author && <p>{tr("From ")}<strong><bdi>{author.name}</bdi></strong>{" "}
      <button type="button" className="mtg-action" onClick={() => {
        setAuthor(undefined);
        startSearch(text.trim(), filter);
      }}>{tr("Clear author")}</button>
    </p>}
    {!sharedLibrary && jumpDateForm}
    {libraryLayout(inViewport(<>
    {dateStatus === "pending" && <p role="status">{tr("Locating messages by date…")}</p>}
    {dateStatus === "empty" && <p role="status">{tr("No messages on or before the selected date.")}</p>}
    {dateStatus === "failed" && <p role="alert">{tr("Could not locate messages by date.")}</p>}
    {focus && dateFocus && <p>{tr("Nearest message on or before ")}<time dateTime={dateFocus}>{dateFocus}</time></p>}
    {focus && (request || dateFocus) && <button ref={nearbyBack} type="button" className="mtg-action" autoFocus={!!returnMatch.current}
      onClick={backToResults}>{request ? tr("Back to results") : tr("Back to search")}</button>}
    {focus && !context && <p role="status">{tr("Loading nearby messages…")}</p>}
    {!focus && searchStatus === "pending" && !sharedLibrary && <p role="status">{pages.length ? tr("Updating matches…") : tr("Searching conversation…")}</p>}
    {loadingLibrary && !pages.length && <>
      <p className="mtg-visually-hidden" role="status">{tr("Loading shared media…")}</p>
      <div aria-hidden="true" className={gallery ? "mtg-shared-media-grid mtg-library-skeleton-grid" : "mtg-library-skeleton-list"}>
        {gallery && <span className="mtg-library-skeleton-label" />}
        {Array.from({ length: skeletonCount }, (_, index) => gallery
          ? <span key={index} className="mtg-library-skeleton-tile" />
          : <div key={index} className="mtg-library-skeleton-row">
            <span /><span><i /><i /></span>
          </div>)}
      </div>
    </>}
    {focus && context?.error && <p role="alert">{tr("Could not load nearby messages.")}</p>}
    {!focus && searchStatus === "failed" && (!sharedLibrary || !pages.length) && <p role="alert">{tr("Could not load matching messages. ")}<button type="button" onClick={() => {
      if (request) {
        setSearchStatus("pending");
        setRequest({ ...request });
      }
    }}>{tr("Retry")}</button></p>}
    {focus && context && !context.error && !focusAvailable && <p role="status">{tr("This message is no longer available.")}</p>}
    {!focus && pages.length > 0 && !canLoadMore && !searchStatus && displayed.length === 0 && <p role="status">{tr("No matching messages")}</p>}
    {!sharedLibrary && !focus && mediaFilter && displayed.length > 0 && <div className="mtg-media-layout" role="group" aria-label={tr("Media layout")}>
      <button type="button" className="mtg-action" aria-pressed={gallery} onClick={() => setGallerySelected(true)}>{tr("Grid")}</button>
      <button type="button" className="mtg-action" aria-pressed={!gallery} onClick={() => setGallerySelected(false)}>{tr("List")}</button>
    </div>}
    {contextPageControl("older")}
    {!sharedLibrary && selection.start()}
    {fileLibrary && files.length > 0 && <ol className="mtg-file-list" aria-label={tr("Matching messages")}>
      {files.map((file) => <li key={file.id} data-context-object>
        {selection.checkbox(file)}
        <button type="button" className="mtg-file-row" data-file-inspect data-search-result={file.id}
          aria-pressed={file.id === inspected?.id} onClick={() => setInspectedFile(file.id)}>
          <DocumentIcon document={file.document!} />
          <span><bdi>{file.document!.name}</bdi>
            {file.document!.sizeBytes !== undefined && <small>{file.document!.approximateSize && "≈ "}{formatSize(file.document!.sizeBytes)}</small>}
          </span>
          {fileDate(file)}
        </button>
      </li>)}
    </ol>}
    {linkLibrary && displayed.length > 0 && <ol className="mtg-shared-link-list" aria-label={tr("Shared links")}>
      {displayed.map((message, index) => {
        const month = monthFor(message);
        const row = <SharedLinkRow key={message.id} message={message} links={extractSharedLinks(message)} checkbox={selection.checkbox(message)}
          selected={inspectedLink?.id === message.id ? inspectedLink : undefined} date={fileDate(message)}
          inspect={(href) => setInspectedLink({ id: message.id, href })} />;
        return month && month !== monthFor(displayed[index - 1])
          ? [<li className="mtg-library-month" key={`month:${message.id}`}><h3>{month}</h3></li>, row]
          : row;
      })}
    </ol>}
    {speechRows.length > 0 && <ol className="mtg-speech-list" aria-label={tr("Voice and video messages")}>
      {speechRows.flatMap((message, index) => {
        const day = speechDay(message);
        const row = <SharedSpeechNote key={`${chatId}:${message.id}:${message.document?.playbackFileId ?? ""}`} chatId={chatId}
          chat={chat} message={message} loadAvatar={loadAvatar} loadMedia={loadMedia} stream={loadVideoStream}
          transcribe={transcribeVoice} save={saveDocument} checkbox={selection.checkbox(message)}
          selected={message.id === activeNote?.id} reader={noteReader}
          inspect={() => setInspectedNote(message.id)} close={closeNoteReader}
          source={loadContext ? () => inspectSource(message.id) : undefined} />;
        return day && day !== speechDay(speechRows[index - 1])
          ? [<li key={`day:${message.id}`} className="mtg-speech-day"><h3>{day}</h3></li>, row] : row;
      })}
    </ol>}
    {audioRows.length > 0 && <ol className="mtg-file-list mtg-audio-list" aria-label={tr("Audio")}>
      {audioRows.map((message) => {
        const document = message.document!;
        const title = document.audioTrack?.title || document.name;
        return <li key={message.id} data-context-object>
          {selection.checkbox(message)}
          <button type="button" className="mtg-file-row mtg-audio-row" data-search-result={message.id}
            aria-haspopup="dialog" aria-label={tr("Play {0}", [title])} onClick={(event) => playShared?.(message.id, event.currentTarget)}>
            <span className="mtg-audio-row-play"><Play size={15} fill="currentColor" /></span>
            <span className="mtg-audio-row-title">
              <bdi><MessageSearchLabel text={title} /></bdi>
              <small className="mtg-audio-row-meta">
                {document.audioTrack?.artist && <bdi>{document.audioTrack.artist}</bdi>}
                {document.durationSeconds !== undefined && <span>{formatPlaybackTime(document.durationSeconds)}</span>}
                {document.sizeBytes !== undefined && <span>{document.approximateSize && "≈ "}{formatSize(document.sizeBytes)}</span>}
              </small>
            </span>
            {fileDate(message)}
          </button>
        </li>;
      })}
    </ol>}
    {!fileLibrary && !linkLibrary && messageRows.length > 0 && (!focus || focusAvailable) &&
      <MessageQuoteFocus.Provider value={focus && focusedQuote ? { id: focus, quote: focusedQuote } : undefined}>
      <PlaySharedMusic.Provider value={playShared}>
      <ol aria-keyshortcuts={!focus && loadContext ? "ArrowUp ArrowDown Home End Escape" : undefined} aria-label={focus ? tr("Nearby messages") : gallery ? tr("Media gallery") : tr("Matching messages")}
      className={gallery ? "mtg-shared-media-grid" : undefined}>
      {(focus ? groupMessageTimeline(messageRows) : messageRows.map((item) => ({ group: [item], albumKey: undefined }))).flatMap(({ group, albumKey }, index) => {
        const first = group[0]!;
        const month = monthFor(first);
        const mediaTile = !!sharedLibrary && gallery;
        const albumCaption = sharedAlbumCaption(group);
        const matchQuery = focus ? focusQuery : request?.query;
        const rows = group.map((message) => <li key={message.id} data-context-object data-library-tile={mediaTile || undefined} data-pinned-result={pinnedResults ? message.id : undefined} data-context-id={focus ? message.id : undefined} data-message-id={message.id}
          data-photo-result={canOpenPhotoMessage && message.hasPhoto ? message.id : undefined}
          tabIndex={message.id === focus || (canOpenPhotoMessage && message.hasPhoto) ? -1 : undefined} aria-current={message.id === focus ? "true" : undefined}>
          {selection.checkbox(message)}
          {!gallery && message.author && <MessageAuthor message={message} chat={chat} load={loadAvatar} />}
          {!mediaTile && <div className="mtg-message-time">
            {message.viewCount !== undefined && <ChannelViewCount count={message.viewCount} />}
            <MessageTimestamp message={message} />
          </div>}
          {!focus && !gallery && message.replyTo && <blockquote className="mtg-reply-quote">
            {deletedIds?.has(message.replyTo) ? tr("Original message unavailable") : loadContext
              ? <button type="button" className="mtg-open-reply" aria-label={tr("Open original message")} data-result-reply={message.id}
                onClick={() => openResultOriginal(message)}>{message.replyQuote ?? tr("Earlier message")}</button>
              : message.replyQuote ?? tr("Earlier message")}
          </blockquote>}
          {message.retained && <p className="mtg-retained-message">
            {message.retained === "expired" ? tr("Media expired · kept locally") : tr("Deleted in Telegram · kept locally")}
          </p>}
          <MessageSearchQuery.Provider value={!focus || message.id === focus ? matchQuery : undefined}>
            <MessageContent key={`${chatId}:${message.id}`} chatId={chatId} message={message} libraryTile={mediaTile} hideCaption={mediaTile || albumCaption?.message === message} drawPhotoReply={drawFromGallery}
              loadGroupEmoji={loadGroupEmoji}
              replyPlayback={message.id === focus && replyPlayback?.id === focus ? replyPlayback : undefined}
              openReplyTimestamp={loadContext && message.replyTo && !deletedIds?.has(message.replyTo) ? showNearbyMessages : undefined}
              mediaTimestamp={message.id === initialMessage ? mediaTimestamp : undefined} checklistTaskId={message.id === initialMessage ? checklistTaskId : undefined} pollOptionId={message.id === initialMessage ? pollOptionId : undefined} loadMessageLink={chat?.subtitle === "Group" || chat?.subtitle === "Channel" ? loadMessageLink : undefined} albumPhotos={galleryPhotos} morePhotos={morePhotos}
              openPhotoMessage={canOpenPhotoMessage ? (selected) => openResultPhoto(message.id, selected) : undefined}
              openVideoMessage={canOpenPhotoMessage ? () => {
                returnMatch.current = { id: message.id, top: viewport.current?.scrollTop ?? 0 };
                showNearbyMessages(message.id);
              } : undefined} mediaCollection={gallery ? undefined : mediaCollection} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} stopPoll={stopAndRefresh} voteInPoll={voteAndRefresh} forwardActions={gallery ? undefined : forwardActions} reactionActions={gallery ? undefined : reactAndRefresh} />
          </MessageSearchQuery.Provider>
          {!gallery && (topicId !== undefined || chat?.subtitle === "Group") && messageViewers
            && <MessageViewerAction chatId={chatId} message={message} load={messageViewers} loadAvatar={loadAvatar} />}
          {!gallery && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && <>
            {pinnedResults && !message.retained && !message.failedDelivery && pinning &&
              <MessagePin {...pinning} chatId={chatId} messageId={message.id} inTopic={pinInTopic}
                onlyUnpin onUnpinned={(restoreFocus) => removePin(message.id, restoreFocus)} />}
            <CopyMessageReference chatId={chatId} messageId={message.id} forumTopicId={message.forumTopicId} />
            {loadMessageLink && (chat?.subtitle === "Group" || chat?.subtitle === "Channel") &&
              <CopyTelegramLink chatId={chatId} messageId={message.id} load={loadMessageLink} />}
          </>}
          {!focus && loadContext && <button type="button" className={mediaTile ? "mtg-library-tile-context" : "mtg-action"} data-search-result={message.id}
            aria-label={mediaTile ? tr("Show nearby messages") : undefined} title={mediaTile ? tr("Show nearby messages") : undefined} onClick={() => {
            returnMatch.current = { id: message.id, top: viewport.current?.scrollTop ?? 0 };
            showNearbyMessages(message.id);
          }}>{mediaTile ? <MessageSquare size={15} aria-hidden="true" /> : tr("Show nearby messages")}</button>}
        </li>);
        return albumKey ? [<MessageAlbum key={albumKey} first={first} caption={albumCaption} messages={group}
          searchQuery={group.some(({ id }) => id === focus) ? matchQuery : undefined}
          chatId={chatId} loadMessageLink={chat?.subtitle === "Group" || chat?.subtitle === "Channel" ? loadMessageLink : undefined}>{rows}</MessageAlbum>]
          : month && month !== monthFor(displayed[index - 1])
            ? [<li className="mtg-library-month" key={`month:${first.id}`}><h3>{month}</h3></li>, ...rows]
            : rows;
      })}
    </ol></PlaySharedMusic.Provider></MessageQuoteFocus.Provider>}
    {!sharedLibrary && selection.toolbar}
    {contextPageControl("newer")}
    {!sharedLibrary && !focus && request && canLoadMore && <button type="button" className="mtg-action" disabled={searchStatus === "pending"}
      onClick={loadMoreMatches}>{tr("Load more matches")}</button>}
    {loadingLibrary && pages.length > 0 && <div className="mtg-library-more" role="status">
      <span className="mtg-visually-hidden">{tr("Loading more results…")}</span>
      <span aria-hidden="true" />
    </div>}
    {sharedLibrary && !focus && pages.length > 0 && searchStatus === "failed" && <p role="alert">
      {tr("Could not load matching messages. ")}<button type="button" onClick={loadMoreMatches}>{tr("Retry")}</button>
    </p>}
    </>))}
    {fileLibrary && <div className="mtg-file-library-footer">
      <AiTransferButton files={selection.active ? selectedFiles : []} />
    </div>}
    {sharedLibrary && selection.toolbar}
    {objectMenu.content}
  </section>;
}
