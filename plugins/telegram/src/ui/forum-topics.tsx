import { useTelegramLocale } from "./i18n/index.tsx";
import { ComposerActionMenu, ComposerActions } from "./composer-actions.tsx";
import { useHistoryMessageUpdates } from "./history-message-updates.ts";
import { handleMessageDoubleClick, type MessageDoubleClick } from "./message-double-click.ts";
import { useSwipeToReply } from "./swipe-reply.ts";
import { playbackLimitsForChat } from "./automatic-playback.tsx";
import { useTypingActivity, type SetTypingActivity } from "./typing-activity.ts";
import { ChatActivityIndicator, type SubscribeToActivity } from "./chat-activity.tsx";
import { InlineBotSearch, UseInlineBotDraft, draftWithInlineBot, inlineBotRequest, type InlineBotActions } from "./inline-bot-search.tsx";
import { ReplyBotKeyboard, type ReplyBotActions } from "./reply-bot-keyboard.tsx";
import { AttachmentMiniApps, type AttachmentMiniAppActions } from "./mini-app.tsx";
import { BotCommandMenu, type LoadBotCommands } from "./bot-command-menu.tsx";
import { droppedAttachment } from "./attachment-drop.ts";
import { ArchiveAttachment, droppedFolderArchive, type ArchiveAttachmentController } from "./archive-attachment.tsx";
import { photoTimeline } from "./photo-preview.tsx";
import { AttachmentPhotoPreview, MediaComposer, type ComposerMediaActions, type MediaComposerController } from "./media-composer.tsx";
import { TopicDraftSync, type TopicDraftActions } from "./topic-draft-sync.tsx";
import { LinkDraftInsert, type LinkDraft } from "./link-draft-insert.tsx";
import { hasWebLink } from "../core/message-links.ts";
import { LinkPreviewControls, linkPreviewDelivery, restoreDraftPreview, savedDraftPreview } from "./link-preview-controls.tsx";
import { ServiceMessageRow } from "./service-message.tsx";
import { composerKeys, isFindShortcut, isPanelShortcut, isPlainKey, isStashShortcut, moveListFocus, navigateReply, replyNavigationShortcuts } from "./composer-keys.ts";
import { attachmentDelivery, AttachmentDeliveryControls } from "./attachment-delivery.tsx";
import { MediaSendControls } from "./media-send-controls.tsx";
import type { CaptionPlacement, AttachmentSendOptions, MediaDelivery, ForumTopicAction, ForumTopicPage, ReplyQuote, StyledRange, TopicDelivery } from "../core/contract.ts";
import { CheckCheck, Pencil, Pin, Search } from "lucide-react";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useSentTextMotion } from "./sent-text-motion.ts";
import { OpenExternalReply } from "./external-reply-reference.tsx";
import { forumTopicColors, isVideoAttachmentName, maxTelegramUploadBytes, maxTelegramTextLength, type DocumentSender, type TelegramUploadProgress, type ForumTopic, type ForumTopicTarget, type MediaReply, type HistoryPage, type PollSender, type SendResult } from "../core/contract.ts";
import { displayMessagePreview } from "./i18n/message-labels.ts";
import { appendUnreadHistory, fillHistoryGap, mergeLatestHistory, prependHistory, replaceLoadedHistoryMessage } from "../core/history-refresh.ts";
import { captureHistoryScroll, focusHistoryMessage, focusUnreadBoundary, historyPageKey, historyWheelDirection, isAwayFromLatest, observeHistoryResize, rememberReadingPlace, restoreHistoryScroll, type HistoryView, type ReadingPlaces } from "./history-scroll.ts";
import { useVisibleMediaPrefetch, visibleMediaCandidates, type PrefetchVisibleMedia } from "./automatic-media.tsx";
import type { AutoMediaOverrides, AutoMediaPolicy, AutoPlaybackOverrides, AutoPlaybackPolicy } from "../core/contract.ts";
import { readableHistoryIds, useVisibleHistoryRead, type MarkHistoryRead } from "./visible-history-read.ts";
import { HistoryRemovalAnchor } from "./history-removal-anchor.tsx";
import type { Chat, Message } from "../core/demo.ts";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import { NotePlaybackQueueProvider } from "./note-playback-queue.tsx";
import { ConversationSearch, type AuthorFilter } from "./conversation-search.tsx";
import { CopyMessageReference, CopyRecipientReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { MessageViewerAction, type MessageViewerLoader } from "./message-viewers.tsx";
import { ChatNotifications, type ChatNotificationActions } from "./chat-notifications.tsx";
import { useMessageSelection, type MessageSelectionActions } from "./message-selection.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { MessageEdit, replacePreparedPhoto, type ReplacePhoto, type ReplaceAttachment, type ReplacementProgress, type AttachmentEditResult, editableMessageText, lastEditableMessage, submitMessageEdit, type EditCaption, type EditDraft, type EditText } from "./message-edit.tsx";
import { selectedReplyQuote } from "./selected-reply-quote.ts";
import { SelectReplyQuote } from "./select-reply-quote.tsx";
import { ScheduledMessages } from "./scheduled-messages.tsx";
import { MessagePin, type MessagePinActions } from "./message-pin.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, preparePhoto } from "./prepare-photo.ts";
import { EditDraftPhoto } from "./edit-draft-photo.tsx";
import { VideoAttachmentEdits, videoAttachmentOptions } from "./video-attachment-edits.tsx";
import { PollComposer } from "./poll-composer.tsx";
import { MessageAlbum, sharedAlbumCaption } from "./message-album.tsx";
import { firstLoadedUnread, groupMessageTimeline, localDateInputValue } from "../core/message-timeline.ts";
import { attachmentReply, composerMediaReply, drawnPhotoReplyId, originalAttachment, photoAttachmentReply, textDraftAttachment, useDraftRecord, useDraftStashCheck, type ComposerReply, type ConversationDrafts, type DraftAttachment, type DraftStash, type StashedDraft } from "./local-drafts.ts";
import { ComposerEmojiPickers, type LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { DraftFormatButton, DraftFormatControls, draftFormattingShortcuts, draftLinkShortcuts, useDraftFormatting } from "./draft-formatting.tsx";
import { sendSplitDraft } from "../core/split-draft.ts";
import { MessageBubble } from "./message-action-slot.tsx";
import { MessageFooter, openMessageMenu, messageMenuKey } from "./message-footer.tsx";
import { MessageContent, type MediaCollectionActions } from "./message-content.tsx";

export type ManageForumTopic = (id: string, action: ForumTopicAction) => Promise<ForumTopic>;
export type DeleteForumTopic = (id: string, topicId: number, name: string) => Promise<"deleted" | "refused" | "unknown">;
export type PinnedForumTopicActions = {
  pinnedForumTopicOrder?: (id: string) => Promise<number[] | null>;
  movePinnedForumTopic?: (id: string, topic: number, direction: "up" | "down", expected: number[]) =>
    Promise<"updated" | "changed" | "refused" | "unknown">;
};
export type MarkForumRead = (id: string) => Promise<{ read: number; failed: number }>;
export type MarkForumTopicRead = (id: string, topicId: number) => Promise<boolean>;
export type ForumActions = {
  loadForumTopics: (chatId: string, query: string) => Promise<ForumTopic[] | null>;
  sendTopicText: (chatId: string, topic: ForumTopicTarget, text: string, replyTo?: string, styles?: StyledRange[], quote?: ReplyQuote, delivery?: TopicDelivery) => Promise<SendResult>;
  loadTopicHistory: (chatId: string, topicId: number, before?: string) => Promise<HistoryPage>;
};

type TopicMessageActions = MessageSelectionActions & PinnedForumTopicActions & Partial<MessagePinActions & MessageDeletionActions & ChatNotificationActions> & {
  messageDoubleClick?: MessageDoubleClick;
  editText?: EditText;
  markHistoryRead?: MarkHistoryRead;
  drawPhotoReplyTarget?: (id: string, messageId: string, topicId?: number) => Promise<import("../core/contract.ts").DrawPhotoDestination | null>;
  automaticMedia?: AutoMediaPolicy;
  automaticPlayback?: AutoPlaybackPolicy;
  automaticPlaybackOverrides?: AutoPlaybackOverrides;
  automaticMediaOverrides?: AutoMediaOverrides;
  prefetchVisibleMedia?: PrefetchVisibleMedia;
  bulkUnpin?: import("./message-pin.tsx").BulkUnpinActions;
  loadUnreadHistory?: (id: string, after?: string, topicId?: number) => Promise<HistoryPage | null>;
  externalReplyAllowed?: (id: string, messageId: string) => Promise<boolean>;
  editCaption?: EditCaption;
  replacePhoto?: ReplacePhoto;
  replaceAttachment?: ReplaceAttachment;
  mediaCollection?: MediaCollectionActions;
  inlineBotActions?: InlineBotActions;
  subscribeToActivity?: SubscribeToActivity;
  setTypingActivity?: SetTypingActivity;
  replyBotActions?: ReplyBotActions;
  attachmentMiniApps?: AttachmentMiniAppActions;
  loadBotCommands?: LoadBotCommands;
  messageViewers?: MessageViewerLoader;
  searchMessages?: ComponentProps<typeof ConversationSearch>["search"];
  markActivityRead?: ComponentProps<typeof ConversationSearch>["markActivityRead"];
  loadMessageContextPage?: ComponentProps<typeof ConversationSearch>["loadContextPage"];
  loadFirstUnread?: (id: string, topicId: number) => Promise<string | null>;
  loadMessageAtDate?: ComponentProps<typeof ConversationSearch>["loadAtDate"];
  loadMessageContext?: ComponentProps<typeof ConversationSearch>["loadContext"];
};

export function ForumTopics({ chatId, chat, loadAvatar, loadMessageLink, loadTopicLink, topics, initialTopic, onActiveTopic, liveRevision, loadForumTopics, manageTopic, deleteTopic, markTopicRead, markForumRead, loadTopicDraft, saveTopicDraft, loadTopicPage, loadTopicHistory, sendTopicText, scheduleActions, sendDocument, sendPhoto, sendPoll, allowVideoAttachment, allowDocumentAttachment = true, loadGroupEmoji, mediaComposer, mediaPermissions, postingSender, postingSenderKey, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, messageActions, deletedIds, readingPlaces, historyView, draftStorage, draftStash, linkDraft, dismissLinkDraft, inlineDraft, dismissInlineDraft, openReplyPicker, focusReply, close }: Omit<ForumActions, "sendTopicText"> & {
  openReplyPicker?: (message: ComposerReply, topicId: number) => void;
  focusReply?: number;
  readingPlaces?: ReadingPlaces;
  historyView?: HistoryView;
  draftStorage?: ConversationDrafts;
  draftStash?: DraftStash;
  linkDraft?: LinkDraft;
  inlineDraft?: { topicId: number; username: string; query: string };
  dismissInlineDraft?: () => void;
  dismissLinkDraft?: () => void;
  initialTopic?: ForumTopic;
  onActiveTopic?: (topic?: ForumTopic) => void;
  sendTopicText?: ForumActions["sendTopicText"];
  scheduleActions?: Pick<ComponentProps<typeof ScheduledMessages>, "load" | "change" | "cancel" | "checkRepeat">;
  sendPoll?: PollSender;
  loadGroupEmoji?: LoadGroupEmoji;
  mediaComposer?: (id: string, topic: ForumTopicTarget, reply?: MediaReply) => ComposerMediaActions;
  postingSender?: string;
  postingSenderKey?: TopicDelivery["expectedPostingSender"];
  mediaPermissions?: { photos: boolean; audio?: boolean; voice: boolean; videoNote?: boolean; basicMedia?: boolean; otherMedia: boolean };
  sendDocument?: DocumentSender;
  allowVideoAttachment?: boolean;
  allowDocumentAttachment?: boolean;
  sendPhoto?: (id: string, caption: string, base64: string, topic?: ForumTopicTarget, replyTo?: import("../core/contract.ts").AttachmentReply, options?: AttachmentSendOptions, delivery?: MediaDelivery) => Promise<SendResult>;
  chatId: string;
  chat?: Chat;
  loadAvatar?: AvatarLoader;
  loadMessageLink?: MessageLinkLoader;
  loadTopicLink?: (id: string, topicId: number) => Promise<string | null>;
  topics: ForumTopic[];
  manageTopic?: ManageForumTopic;
  deleteTopic?: DeleteForumTopic;
  markTopicRead?: MarkForumTopicRead;
  markForumRead?: MarkForumRead;
  loadTopicDraft?: TopicDraftActions["load"];
  saveTopicDraft?: TopicDraftActions["save"];
  loadTopicPage?: (chatId: string, query: string, cursor?: NonNullable<ForumTopicPage["next"]>) => Promise<ForumTopicPage | null>;
  liveRevision?: number;
  loadPhoto: ComponentProps<typeof MessageContent>["loadPhoto"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument: ComponentProps<typeof MessageContent>["saveDocument"];
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  messageActions?: TopicMessageActions;
  deletedIds?: ReadonlySet<string>;
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const inlineDraftConfirmation = tr("Replace the current draft with the bot’s search query?");
  const [linkPreviews, setLinkPreviews] = useDraftRecord(draftStorage?.previews);
  const [drafts, setDrafts] = useDraftRecord(draftStorage?.text);
  const [draftStashNotice, setDraftStashNotice] = useState<{ topicId: number; text: string }>();
  const [delivery, setDelivery] = useDraftRecord(draftStorage?.attachmentDelivery);
  const [replies, setReplies] = useDraftRecord(draftStorage?.replies);
  const [attachments, setAttachments] = useDraftRecord(draftStorage?.attachments);
  const [fileErrors, setFileErrors] = useState<Record<number, string | undefined>>({});
  const topicInput = useRef<HTMLTextAreaElement>(null);
  const [uploads, setUploads] = useState<Record<number, { bytes: number; total: number; canCancel: boolean; telegram?: TelegramUploadProgress } | undefined>>({});
  const mediaController = useRef<MediaComposerController>(null);
  const archivePicker = useRef<ArchiveAttachmentController>(null);
  const [archivePreparing, setArchivePreparing] = useState(false);
  const uploadControls = useRef(new Map<number, { controller: AbortController; canCancel: boolean }>());
  useEffect(() => {
    const controls = uploadControls.current;
    return () => { for (const control of controls.values()) if (control.canCancel) control.controller.abort(); };
  }, []);
  const [sent, setSent] = useState<Record<number, Message[]>>({});
  const sending = useRef(new Set<number>());
  const [selected, setSelected] = useState<ForumTopic | undefined>(initialTopic);
  const captureSendMotion = useSentTextMotion(`${chatId}:${selected?.id ?? ""}`);
  useLayoutEffect(() => {
    if (initialTopic && focusReply === initialTopic.id) setSelected(initialTopic);
  }, [focusReply, initialTopic]);
  const panel = useRef<HTMLElement>(null);
  const topicSearch = useRef<HTMLInputElement>(null);
  const topicListPosition = useRef<{ id: number; top: number; offset: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const position = topicListPosition.current;
    const list = panel.current;
    if (selected || !position || !list) return;
    topicListPosition.current = undefined;
    const row = list.querySelector<HTMLButtonElement>(`[data-topic-row="${position.id}"]`);
    (row ?? topicSearch.current)?.focus({ preventScroll: true });
    list.scrollTop = position.top;
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - position.offset;
  }, [selected]);
  useLayoutEffect(() => {
    onActiveTopic?.(selected);
    return () => { onActiveTopic?.(undefined); };
  }, [onActiveTopic, selected]);
  const [searchText, setSearchText] = useState("");
  const [searchRequest, setSearchRequest] = useState<{ query: string }>();
  const query = searchRequest?.query ?? "";
  const [results, setResults] = useState<{ query: string; topics: ForumTopic[] | null }>();
  useEffect(() => {
    if (!query || loadTopicPage) return;
    let current = true;
    void loadForumTopics(chatId, query).then(
      (topics) => { if (current) setResults({ query, topics }); },
      () => { if (current) setResults({ query, topics: null }); },
    );
    return () => { current = false; };
  }, [chatId, searchRequest, query, loadForumTopics, loadTopicPage]);

  const [pageState, setPageState] = useState<{ query: string; page: ForumTopicPage | null }>();
  const [pageRequest, setPageRequest] = useState<{ query: string; cursor: NonNullable<ForumTopicPage["next"]> }>();
  const [pageError, setPageError] = useState(false);
  const page = pageState?.query === query ? pageState.page : undefined;
  const botTopics = chat?.subtitle === "Direct message";
  const canCreateOrDelete = !botTopics || pageState?.page?.canCreateBotTopics === true;
  const needsBotPermissions = botTopics && pageState === undefined;
  const pageLoad = useMemo(() => ({ chatId, loadTopicPage, query, pageRequest, searchRequest, liveRevision }),
    [chatId, loadTopicPage, query, pageRequest, searchRequest, liveRevision]);
  const loadedPage = useRef<typeof pageLoad | undefined>(undefined);
  useEffect(() => {
    const { chatId, loadTopicPage, query, pageRequest } = pageLoad;
    if (!loadTopicPage || (selected && !needsBotPermissions) || loadedPage.current === pageLoad) return;
    let current = true;
    const cursor = pageRequest?.query === query ? pageRequest.cursor : undefined;
    void loadTopicPage(chatId, query, cursor).then((result) => {
      if (!current) return;
      if (!result && cursor) {
        setPageError(true);
        return;
      }
      loadedPage.current = pageLoad;
      setPageState((previous) => {
        if (!cursor || !result) return { query, page: result };
        const rows = new Map(previous?.page?.topics.map((topic) => [topic.id, topic]));
        for (const topic of result.topics) rows.set(topic.id, topic);
        return { query, page: { ...result, topics: [...rows.values()] } };
      });
    }, () => {
      if (current) {
        if (!cursor) setPageState({ query, page: null });
        else setPageError(true);
      }
    });
    return () => { current = false; };
  }, [pageLoad, selected, needsBotPermissions]);

  const [changedTopics, setChangedTopics] = useState<ForumTopic[]>([]);
  const [deletedTopics, setDeletedTopics] = useState<ReadonlySet<number>>(() => new Set());
  const [readingTopic, setReadingTopic] = useState<number | "forum">();
  const [forumReadResult, setForumReadResult] = useState<Awaited<ReturnType<MarkForumRead>> | "error">();
  const [readError, setReadError] = useState(false);
  const found = loadTopicPage ? (page === null ? null : page?.topics ?? (!query ? topics : undefined))
    : query ? results?.query === query ? results.topics : undefined : topics;
  const displayed = found?.filter(({ id }) => !deletedTopics.has(id))
    .map((topic) => {
      const changed = changedTopics.find(({ id }) => id === topic.id);
      return changed ? { ...changed, unread: topic.unread, unreadMentions: topic.unreadMentions,
        unreadReactions: topic.unreadReactions, preview: topic.preview } : topic;
    });
  if (displayed && !query) displayed.unshift(...changedTopics.filter((topic) =>
    !deletedTopics.has(topic.id) && !displayed.some(({ id }) => id === topic.id)));
  const [readTopicSnapshots, setReadTopicSnapshots] = useState<Record<number, ForumTopic>>({});
  const topicLookup = useRef<AbortController | undefined>(undefined);
  const [topicLookupStatus, setTopicLookupStatus] = useState<"loading" | "empty" | "failed">();
  useLayoutEffect(() => {
    setTopicLookupStatus(undefined);
    return () => {
      topicLookup.current?.abort();
      topicLookup.current = undefined;
    };
  }, [chatId, selected?.id]);
  const knownTopics = query ? topics : displayed;
  const unreadTopic = (topic: ForumTopic) => topic.id !== selected?.id && !topic.hidden && !deletedTopics.has(topic.id)
    && !!(topic.unread || topic.unreadMentions || topic.unreadReactions);
  const nextUnreadTopic = selected && !botTopics
    ? knownTopics?.find((topic) => unreadTopic(topic) && topic !== readTopicSnapshots[topic.id]) : undefined;
  const canFindNextTopic = !!(selected && !botTopics && loadTopicPage && (query || !page || page.next));

  async function openNextUnreadTopic(currentRead: boolean, trigger: HTMLButtonElement) {
    if (!selected || topicLookup.current) return;
    function open(topic: ForumTopic) {
      const previous = knownTopics?.find(({ id }) => id === selected?.id);
      if (currentRead && previous) setReadTopicSnapshots((snapshots) => ({ ...snapshots, [previous.id]: previous }));
      setSelected(topic);
    }
    if (nextUnreadTopic) { open(nextUnreadTopic); return; }
    if (!canFindNextTopic || !loadTopicPage) return;
    const controller = new AbortController();
    const active = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    topicLookup.current = controller;
    setTopicLookupStatus("loading");
    const seen = new Set<string>();
    let cursor = query ? undefined : page?.next ?? undefined;
    try {
      for (;;) {
        active.throwIfAborted();
        const result = await loadTopicPage(chatId, "", cursor);
        if (controller.signal.aborted || !trigger.isConnected || trigger.closest("[hidden]")) return;
        active.throwIfAborted();
        if (!result) throw new Error("Telegram topics are unavailable.");
        const next = result.topics.find(unreadTopic);
        if (next) { open(next); return; }
        if (!result.next) { setTopicLookupStatus("empty"); return; }
        const key = JSON.stringify([result.next.date, result.next.message, result.next.topic]);
        if (seen.has(key)) throw new Error("Telegram returned a repeated topic page.");
        seen.add(key);
        cursor = result.next;
      }
    } catch {
      if (!controller.signal.aborted) setTopicLookupStatus("failed");
    } finally {
      if (topicLookup.current === controller) {
        topicLookup.current = undefined;
        setTopicLookupStatus((status) => status === "loading" ? undefined : status);
      }
    }
  }
  function applyTopic(topic: ForumTopic) {
    setChangedTopics((previous) => [...previous.filter(({ id }) => id !== topic.id), topic]);
    setSelected(topic);
  }
  async function readTopic(topic: ForumTopic) {
    if (!markTopicRead || !topic.unread || readingTopic !== undefined) return;
    setReadingTopic(topic.id);
    setReadError(false);
    try {
      if (!await markTopicRead(chatId, topic.id)) setReadError(true);
      // The next topic page provides the count, including any messages that arrived during the request.
      else setSearchRequest((current) => ({ query: current?.query ?? "" }));
    } catch {
      setReadError(true);
    } finally {
      setReadingTopic(undefined);
    }
  }
  async function readForum() {
    if (!markForumRead || readingTopic !== undefined) return;
    setReadingTopic("forum");
    setReadError(false);
    setForumReadResult(undefined);
    try {
      setForumReadResult(await markForumRead(chatId));
      setSearchRequest((current) => ({ query: current?.query ?? "" }));
    } catch {
      setForumReadResult("error");
    } finally {
      setReadingTopic(undefined);
    }
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setResults(undefined);
    setPageState(undefined);
    setPageRequest(undefined);
    setPageError(false);
    setSearchRequest({ query: searchText.trim() });
  }

  function acceptSend(topic: ForumTopic, text: string, message: Message, scheduled = false, textFileSource?: string) {
    if (!scheduled) setSent((previous) => ({ ...previous, [topic.id]: [...(previous[topic.id] ?? []), message] }));
    setDrafts((previous) => (textFileSource === undefined ? previous[topic.id]?.trim() === text : previous[topic.id] === textFileSource)
      ? { ...previous, [topic.id]: "" } : previous);
    formatting.clearSent(String(topic.id), textFileSource ?? text, textFileSource !== undefined);
    setLinkPreviews((previous) => ({ ...previous, [topic.id]: undefined }));
    setAttachments((previous) => ({ ...previous, [topic.id]: undefined }));
    setReplies((previous) => ({ ...previous, [topic.id]: undefined }));
    setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
  }

  async function sendWithOptions(topic: ForumTopic, options: TopicDelivery): Promise<SendResult> {
    const text = drafts[topic.id]?.trim();
    const reply = replies[topic.id];
    if (!sendTopicText || (delivery[topic.id] === "unknown" || delivery[topic.id] === "sending") || !text || text.length > maxTelegramTextLength || attachments[topic.id] || sending.current.has(topic.id) || archivePicker.current?.isPreparing()
      || (reply && (!reply.origin || reply.origin.chatId === chatId) && deletedIds?.has(reply.id))) return { state: "failed" };
    sending.current.add(topic.id);
    setDelivery((previous) => ({ ...previous, [topic.id]: "sending" }));
    try {
      const styles = formatting.deliveryStyles;
      const links = formatting.deliveryLinks;
      const customEmoji = formatting.deliveryCustomEmoji;
      return await sendTopicText(chatId, { id: topic.id, name: topic.name }, text, reply?.id,
        styles.length ? styles : undefined, reply?.selectedQuote,
        { ...options, ...(reply?.origin ? { externalReplyChatId: reply.origin.chatId } : {}),
          ...(postingSenderKey ? { expectedPostingSender: postingSenderKey } : {}),
          ...linkPreviewDelivery(linkPreviews[topic.id], text), ...(links.length ? { links } : {}),
          ...(customEmoji.length ? { customEmoji } : {}) });
    } finally {
      sending.current.delete(topic.id);
      setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
    }
  }

  async function send(event: FormEvent, topic: ForumTopic, asTextFile = false) {
    event.preventDefault();
    if (delivery[topic.id] === "unknown" || delivery[topic.id] === "sending") return;
    const source = drafts[topic.id] ?? "";
    const text = source.trim();
    const attached = attachments[topic.id];
    if (asTextFile && (attached || !sendTopicText || !sendDocument || !allowDocumentAttachment || topic.closed
      || text.length <= maxTelegramTextLength)) return;
    if (!asTextFile && !attached && text.length > maxTelegramTextLength) return;
    const attachment = asTextFile ? textDraftAttachment(source) : attached;
    const reply = replies[topic.id];
    const photoReply = attachment?.kind === "photo" ? photoAttachmentReply(attachment, reply) : undefined;
    if (photoReply === false) {
      setFileErrors((previous) => ({ ...previous, [topic.id]: "Select the original photo as the reply, or remove the drawing." }));
      return;
    }
    const medium = attachmentDelivery(attachment?.delivery);
    if (medium === null || medium?.whenOnline || sending.current.has(topic.id) || archivePicker.current?.isPreparing() || (reply && (!reply.origin || reply.origin.chatId === chatId) && deletedIds?.has(reply.id))
      || (attachment ? !canSendAttachment(attachment) || (!asTextFile && text.length > 1024) : !text || !sendTopicText)) return;
    const animateSent = !attachment
      ? captureSendMotion(topicInput.current, panel.current?.querySelector<HTMLElement>(".mtg-history") ?? null) : undefined;
    sending.current.add(topic.id);
    setDelivery((previous) => ({ ...previous, [topic.id]: "sending" }));
    setFileErrors((previous) => ({ ...previous, [topic.id]: undefined }));
    try {
      const target = { id: topic.id, name: topic.name };
      const replyTo = attachmentReply(reply);
      const captionFormat = asTextFile ? undefined : formatting.captionFormat;
      const mediaOptions = captionFormat ? { ...attachment?.options, captionFormat } : attachment?.options;
      let result: SendResult | { state: "cancelled" };
      if (attachment?.kind === "photo" && sendPhoto) {
        let base64: string;
        try { base64 = "data" in attachment ? attachment.data : await preparePhoto(attachment.file); }
        catch {
          setFileErrors((previous) => ({ ...previous, [topic.id]: "Could not prepare this photo." }));
          setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
          return;
        }
        result = medium ? await sendPhoto(chatId, text, base64, target, photoReply, mediaOptions, medium)
          : mediaOptions ? await sendPhoto(chatId, text, base64, target, photoReply, mediaOptions)
          : await sendPhoto(chatId, text, base64, target, ...(photoReply ? [photoReply] as const : []));
      } else if (attachment && attachment.kind !== "photo" && sendDocument) {
        const { file } = attachment;
        const control = { controller: new AbortController(), canCancel: true };
        uploadControls.current.set(topic.id, control);
        setUploads((previous) => ({ ...previous, [topic.id]: { bytes: 0, total: file.size, canCancel: true } }));
        const progress = (bytes: number, canCancel = true, telegram?: TelegramUploadProgress) => {
          control.canCancel = canCancel && !control.controller.signal.aborted;
          setUploads((previous) => ({ ...previous, [topic.id]: { bytes, total: file.size, canCancel: control.canCancel, telegram } }));
        };
        const args = [chatId, file, asTextFile ? "" : text, progress, control.controller.signal, target] as const;
        const video = attachment.kind === "video" && mediaOptions?.mediaKind !== "animation" ? true : undefined;
        const videoOptions = videoAttachmentOptions(mediaOptions);
        result = await (medium ? sendDocument(...args, replyTo, video, videoOptions, medium)
          : videoOptions ? sendDocument(...args, replyTo, video, videoOptions)
          : video ? sendDocument(...args, replyTo, true)
          : replyTo ? sendDocument(...args, replyTo) : sendDocument(...args));
      } else if (sendTopicText) {
        const styles = formatting.deliveryStyles;
        const links = formatting.deliveryLinks;
        const customEmoji = formatting.deliveryCustomEmoji;
        const options = hasWebLink(text) ? linkPreviewDelivery(linkPreviews[topic.id], text) : {};
        result = reply?.origin || links.length || customEmoji.length || options.linkPreview || postingSenderKey
          ? await sendTopicText(chatId, target, text, reply?.id, styles.length ? styles : undefined, reply?.selectedQuote,
            { ...options, ...(reply?.origin ? { externalReplyChatId: reply.origin.chatId } : {}),
              ...(postingSenderKey ? { expectedPostingSender: postingSenderKey } : {}), ...(links.length ? { links } : {}),
              ...(customEmoji.length ? { customEmoji } : {}) })
          : await (reply?.selectedQuote ? sendTopicText(chatId, target, text, reply.id, styles.length ? styles : undefined, reply.selectedQuote)
          : styles.length ? sendTopicText(chatId, target, text, reply?.id, styles)
          : reply ? sendTopicText(chatId, target, text, reply.id) : sendTopicText(chatId, target, text));
      } else {
        return;
      }
      if (result.state === "sent") {
        acceptSend(topic, text, result.message, medium?.at !== undefined, asTextFile ? source : undefined);
        animateSent?.(result.message);
        if (medium?.at !== undefined) setDelivery((previous) => ({ ...previous, [topic.id]: "scheduled" }));
      } else {
        const status = result.state === "failed" ? result.uploadRejection ?? "failed" : result.state;
        setDelivery((previous) => ({ ...previous, [topic.id]: status }));
      }
    } catch {
      setDelivery((previous) => ({ ...previous, [topic.id]: "unknown" }));
    } finally {
      sending.current.delete(topic.id);
      uploadControls.current.delete(topic.id);
      setUploads((previous) => ({ ...previous, [topic.id]: undefined }));
    }
  }

  function chooseAttachment(file: File | undefined, topicId: number, kind: DraftAttachment["kind"], deliveryDraft?: DraftAttachment["delivery"]) {
    if (!file || sending.current.has(topicId)) return;
    const valid = file.size > 0 && (kind === "photo"
      ? isPhotoMimeType(file.type) && file.size <= maxOriginalPhotoBytes : file.size <= maxTelegramUploadBytes && (kind !== "video" || isVideoAttachmentName(file.name)));
    setFileErrors((previous) => ({ ...previous, [topicId]: valid ? undefined : kind === "photo"
      ? "Choose a non-empty JPEG, PNG, or WebP photo up to 64 MiB." : kind === "video" ? "Choose a non-empty MP4 or MOV video up to 4000 MiB." : "Choose a non-empty document up to 4000 MiB." }));
    if (valid) {
      setAttachments((previous) => ({ ...previous, [topicId]: { kind, name: file.name, file, delivery: deliveryDraft } }));
      setDelivery((previous) => ({ ...previous, [topicId]: undefined }));
    }
  }

  const selectedId = selected?.id;
  const splitScope = useRef(0);
  useLayoutEffect(() => () => { splitScope.current++; }, [selectedId]);
  const topicDraft = selectedId === undefined ? "" : drafts[selectedId] ?? "";
  const inlineBot = messageActions?.inlineBotActions && inlineBotRequest(topicDraft);
  const formatting = useDraftFormatting(String(selectedId ?? ""), topicDraft, topicInput, [], true, [], draftStorage?.formatting);
  const savedDraft = selected?.draft;
  const attachment = selectedId === undefined ? undefined : attachments[selectedId];
  const longDraft = !attachment && topicDraft.trim().length > maxTelegramTextLength;
  const canSendTextFile = !!(sendTopicText && sendDocument && allowDocumentAttachment);
  const draftLimit = attachment ? 1024 : sendTopicText ? undefined : maxTelegramTextLength;
  const upload = selectedId === undefined ? undefined : uploads[selectedId];
  const reply = selectedId === undefined ? undefined : replies[selectedId];
  async function sendParts(topic: ForumTopic) {
    const id = topic.id;
    if (!sendTopicText || !longDraft || topic.closed || formatting.editingLink || sending.current.has(id)
      || delivery[id] === "sending" || delivery[id] === "unknown" || archivePicker.current?.isPreparing()
      || (reply && (!reply.origin || reply.origin.chatId === chatId) && deletedIds?.has(reply.id))) return;
    const scope = splitScope.current;
    sending.current.add(id);
    setDelivery((previous) => ({ ...previous, [id]: "sending" }));
    try {
      const result = await sendSplitDraft(topicDraft, formatting.captionFormat, () => scope === splitScope.current,
        (part, style, first) => sendTopicText(chatId, { id, name: topic.name }, part, first ? reply?.id : undefined,
          style.styles, first ? reply?.selectedQuote : undefined, {
            ...linkPreviewDelivery(linkPreviews[id], part), links: style.links, customEmoji: style.customEmoji,
            ...(postingSenderKey && { expectedPostingSender: postingSenderKey }),
            ...(first && reply?.origin && { externalReplyChatId: reply.origin.chatId }),
          }), (message) => setSent((previous) => ({ ...previous, [id]: [...(previous[id] ?? []), message] })));
      if (result.sentAny) {
        formatting.restore({ ...result.format, links: result.format.links ?? [], text: result.remaining });
        setDrafts((previous) => previous[id] === topicDraft ? { ...previous, [id]: result.remaining } : previous);
        setReplies((previous) => previous[id] === reply ? { ...previous, [id]: undefined } : previous);
      }
      setDelivery((previous) => ({ ...previous, [id]: result.status }));
    } finally { sending.current.delete(id); }
  }
  const focusedReply = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (selectedId === undefined || focusReply !== selectedId || !(reply?.origin || drawnPhotoReplyId(attachment))) {
      focusedReply.current = undefined;
      return;
    }
    if ((!sendTopicText && !sendPhoto) || !topicInput.current || focusedReply.current === selectedId) return;
    const frame = requestAnimationFrame(() => {
      if (!topicInput.current) return;
      focusedReply.current = selectedId;
      topicInput.current.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusReply, selectedId, reply, attachment, sendTopicText, sendPhoto]);

  const externalReply = reply?.origin;
  const mediaReply = composerMediaReply(reply);
  const replyDeleted = reply && (!externalReply || externalReply.chatId === chatId) && deletedIds?.has(reply.id);
  const beginExternalReplyCheck = useDraftStashCheck(JSON.stringify([chatId, selectedId, selected?.closed, topicDraft, reply?.id, reply?.origin,
    reply?.selectedQuote, !!attachment, selectedId === undefined ? undefined : linkPreviews[selectedId], formatting.ranges,
    formatting.links, formatting.customEmoji, !!sendTopicText, !!sendPhoto, !!sendDocument, allowDocumentAttachment, allowVideoAttachment,
    selectedId === undefined ? undefined : delivery[selectedId], archivePreparing]), attachment, reply);
  const checkDrawPhoto = messageActions?.drawPhotoReplyTarget;
  const drawTopic = selected && !selected.closed && sendPhoto && checkDrawPhoto
    && !attachment && !reply && !archivePreparing && delivery[selected.id] !== "sending" ? selected.id : undefined;
  const beginDrawCheck = useDraftStashCheck(JSON.stringify([chatId, drawTopic, liveRevision]), attachment, reply);
  async function verifyDrawPhoto(id: string) {
    if (drawTopic === undefined || !checkDrawPhoto || sending.current.has(drawTopic)
      || archivePicker.current?.isPreparing() || deletedIds?.has(id)) return false;
    const stillCurrent = beginDrawCheck();
    return !!await checkDrawPhoto(chatId, id, drawTopic).catch(() => null) && stillCurrent();
  }
  const drawnReply = drawnPhotoReplyId(attachment);
  const canStashDraft = !drawnReply && draftStash && (sendTopicText || sendPhoto || sendDocument) && selected && !selected.closed && !archivePreparing
    && delivery[selected.id] !== "sending" && (!attachment || delivery[selected.id] !== "unknown");
  const syncDraft = !!(loadTopicDraft && saveTopicDraft) && topicDraft.length <= maxTelegramTextLength;
  function renderLinkDraft(remote?: Awaited<ReturnType<TopicDraftActions["load"]>>) {
    if (!linkDraft || !dismissLinkDraft || !selected) return null;
    const id = selected.id;
    return <LinkDraftInsert draft={linkDraft} currentText={topicDraft} input={topicInput}
      disabled={!sendTopicText || selected.closed || !!reply || !!attachment || !!upload
        || delivery[id] === "sending" || (syncDraft && !remote)}
      requiresRemoteDraft={drafts[id] === undefined && !!(syncDraft ? remote?.draft : savedDraft)}
      insert={(text) => {
        formatting.change(text);
        setDrafts((previous) => ({ ...previous, [id]: text }));
      }} dismiss={dismissLinkDraft} />;
  }
  function renderPendingDrafts(remote?: Awaited<ReturnType<TopicDraftActions["load"]>>) {
    const id = selected?.id;
    const hasQuery = inlineDraft && dismissInlineDraft && selected && id !== undefined && inlineDraft.topicId === id;
    return <>{renderLinkDraft(remote)}{hasQuery && <section className="mtg-send-status" aria-label={tr("Bot query for this topic")}>
      <p><bdi>{`@${inlineDraft.username} ${inlineDraft.query}`}</bdi></p>
      <button type="button" className="mtg-action"
        disabled={!sendTopicText || selected.closed || !!reply || !!attachment || !!upload || delivery[id] === "sending"
          || (syncDraft && !remote?.writable)}
        onClick={() => {
          const current = drafts[id] ?? remote?.draft?.text ?? savedDraft ?? "";
          const next = draftWithInlineBot(current, inlineDraft.username, inlineDraft.query, false, inlineDraftConfirmation);
          if (next === undefined) return;
          formatting.restore({ text: next });
          setLinkPreviews((previous) => ({ ...previous, [id]: undefined }));
          setDrafts((previous) => ({ ...previous, [id]: next }));
          dismissInlineDraft();
          requestAnimationFrame(() => topicInput.current?.focus());
        }}>{tr("Use bot query")}</button>
      <button type="button" className="mtg-action" onClick={dismissInlineDraft}>{tr("Cancel bot query")}</button>
    </section>}</>;
  }
  const typingActivity = useTypingActivity(chatId,
    selected && !selected.closed && !attachment && sendTopicText && delivery[selected.id] !== "sending"
      ? messageActions?.setTypingActivity : undefined, selectedId);
  const topicMediaAvailable = !!mediaComposer && !!mediaPermissions && (mediaPermissions.photos || allowVideoAttachment
    || !!sendDocument && allowDocumentAttachment || mediaPermissions.audio || mediaPermissions.voice || mediaPermissions.videoNote || mediaPermissions.basicMedia || mediaPermissions.otherMedia);

  const dropKinds = { photo: !!sendPhoto, video: !!sendDocument && !!allowVideoAttachment, document: !!sendDocument && !!allowDocumentAttachment };
  const allowVideoAsGif = !!sendDocument && mediaPermissions?.otherMedia === true;
  const canSendAttachment = (draft: DraftAttachment) => draft.kind === "video" && draft.options?.mediaKind === "animation"
    ? allowVideoAsGif : dropKinds[draft.kind];
  const attachmentAsGif = attachment?.kind === "video" && attachment.options?.mediaKind === "animation";
  const canDrop = selected && !selected.closed && !sending.current.has(selected.id)
    && (dropKinds.photo || dropKinds.video || dropKinds.document || mediaPermissions?.audio);

  function chooseTopicFiles(files: File[]) {
    if (!selected || !canDrop || !files.length || sending.current.has(selected.id)) return;
    const file = files[0];
    if (files.length > 1 && !replyDeleted) {
      if (mediaController.current?.addDroppedMedia(files)) {
        setFileErrors((previous) => ({ ...previous, [selected.id]: undefined }));
        return;
      }
      if (archivePicker.current) {
        setFileErrors((previous) => ({ ...previous, [selected.id]: undefined }));
        archivePicker.current.offer(files);
        return;
      }
    }
    const kind = file && files.length === 1 ? droppedAttachment(file, dropKinds) : undefined;
    if (file && kind) chooseAttachment(file, selected.id, kind);
    else setFileErrors((previous) => ({ ...previous, [selected.id]: files.length > 1
      ? "Choose one file at a time, or use an album for supported attachments." : "This file type cannot be attached here." }));
  }

  return <UseInlineBotDraft.Provider value={selected && messageActions?.inlineBotActions && sendTopicText && !attachment && !selected.closed
    && delivery[selected.id] !== "sending" ? (id, username, query, reviewed) => {
      const text = id === chatId ? draftWithInlineBot(topicDraft, username, query, reviewed, inlineDraftConfirmation) : undefined;
      if (text === undefined) return false;
      formatting.change(text);
      setDrafts((previous) => ({ ...previous, [selected.id]: text }));
      if (reviewed) requestAnimationFrame(() => topicInput.current?.focus());
      else topicInput.current?.focus();
      return true;
    } : undefined}><section ref={panel} className="mtg-conversation-search mtg-forum" data-topic-open={!!selected} aria-label={tr("Forum topics")}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
    }}
    onDrop={(event) => {
      const files = event.dataTransfer.files;
      if (!files.length && !event.dataTransfer.items?.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (!selected || !canDrop || (event.target instanceof Element && event.target.closest("dialog, [role=dialog], .mtg-edit"))) return;
      const folder = droppedFolderArchive(event.dataTransfer);
      if (folder) {
        if (archivePicker.current) archivePicker.current.offer(folder);
        else setFileErrors((previous) => ({ ...previous, [selected.id]: "A folder requires an available document attachment." }));
        return;
      }
      chooseTopicFiles(Array.from(files));
    }}
    onKeyDown={(event) => {
      const target = event.target;
      if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
      const find = isFindShortcut(event);
      const searchShortcut = find || isPanelShortcut(event) && event.code === "KeyF";
      if (!selected) {
        if (searchShortcut && topicSearch.current) {
          event.preventDefault();
          event.stopPropagation();
          topicSearch.current.focus();
          topicSearch.current.select();
          return;
        }
        if (moveListFocus(event, topicSearch.current, "button[data-topic-row]:enabled")) return;
        if (isPlainKey(event, "Escape") && target instanceof HTMLElement
          && !target.closest("input:not([type=search]), textarea, select, dialog, [role=dialog], [contenteditable], details[open]")) {
          event.preventDefault();
          close();
        }
        return;
      }
      if (!searchShortcut) return;
      const button = event.currentTarget.querySelector<HTMLButtonElement>('[aria-keyshortcuts~="Alt+Shift+F"]');
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (find && button.getAttribute("aria-expanded") === "true") {
        const input = event.currentTarget.querySelector<HTMLInputElement>('.mtg-conversation-search input[type="search"]');
        input?.focus();
        input?.select();
        return;
      }
      button.focus();
      button.click();
    }}>
    {selected ? <TopicHistory readingPlaces={readingPlaces} historyView={historyView} key={selected.id} chatId={chatId} chat={chat} loadGroupEmoji={loadGroupEmoji} loadAvatar={loadAvatar} loadMessageLink={loadMessageLink} topic={selected} liveRevision={liveRevision} loadTopicHistory={loadTopicHistory}
      loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll} messageActions={messageActions} deletedIds={deletedIds} sent={sent[selected.id] ?? []}
      replaceSent={(updated) => setSent((previous) => ({ ...previous,
        [selected.id]: (previous[selected.id] ?? []).map((item) => item.id === updated.id ? updated : item),
      }))}
      drawPhotoReply={drawTopic === undefined ? undefined : {
        verify: verifyDrawPhoto,
        async stage(message, data) {
          if (!await verifyDrawPhoto(message.id)) return false;
          setAttachments((previous) => ({ ...previous, [drawTopic]: { kind: "photo", name: "Drawn reply.jpg", drawnPhotoReply: message.id, data } }));
          setReplies((previous) => ({ ...previous, [drawTopic]: message }));
          setFileErrors((previous) => ({ ...previous, [drawTopic]: undefined }));
          setDelivery((previous) => ({ ...previous, [drawTopic]: undefined }));
          requestAnimationFrame(() => topicInput.current?.focus());
          return true;
        },
      }}
      back={() => setSelected(undefined)}
      nextUnread={nextUnreadTopic || canFindNextTopic
        ? { topic: nextUnreadTopic, status: topicLookupStatus, open: openNextUnreadTopic } : undefined}
      openReplyPicker={openReplyPicker ? (value) => openReplyPicker(value, selected.id) : undefined}
      reply={reply} cancelReply={() => setReplies((previous) => ({ ...previous, [selected.id]: undefined }))}
      chooseReply={(sendTopicText || sendPhoto || sendDocument) && delivery[selected.id] !== "sending"
        ? (message) => {
          setReplies((previous) => ({ ...previous, [selected.id]: message }));
          topicInput.current?.focus();
        } : undefined}
      actions={<>
        <p>{tr("Chat ID ")}{chatId}{tr(" · Topic ID ")}{selected.id}</p>
        <CopyRecipientReference key={`copy-recipient-reference:${selected.id}`} chatId={chatId} forumTopicId={selected.id} />
        {loadTopicLink && <CopyTelegramLink key={`topic-link:${selected.id}`} chatId={chatId} messageId={String(selected.id)}
          kind="topic" load={(id) => loadTopicLink(id, selected.id)} />}
        {selected.pinned && messageActions?.pinnedForumTopicOrder && messageActions.movePinnedForumTopic &&
          <PinnedTopicOrder key={selected.id} chatId={chatId} topicId={selected.id}
            load={messageActions.pinnedForumTopicOrder} move={messageActions.movePinnedForumTopic} />}
        {messageActions?.chatNotificationState && messageActions.setChatNotificationMode &&
          <ChatNotifications id={chatId} topicId={selected.id} chatNotificationState={messageActions.chatNotificationState}
            setChatNotificationSound={messageActions.setChatNotificationSound} setChatNotificationMode={messageActions.setChatNotificationMode} setChatNotificationOverride={messageActions.setChatNotificationOverride} />}
        {manageTopic && <TopicControls key={`topic-controls:${selected.id}`} chatId={chatId} topic={selected} bot={botTopics} manage={manageTopic} onChange={applyTopic}
          deleteTopic={delivery[selected.id] === "sending" || !canCreateOrDelete ? undefined : deleteTopic}
          onDeleted={(id) => {
            readingPlaces?.delete(`${chatId}:${id}`);
            historyView?.forget(`${chatId}:${id}`);
            setDeletedTopics((previous) => new Set([...previous, id]));
            setSelected((topic) => topic?.id === id ? undefined : topic);
          }} />}
      </>}
      composer={(sendTopicText || sendDocument || sendPhoto || sendPoll || topicMediaAvailable) ? (editLast, navigateTopicReply) => <ComposerActions><div>
        {postingSender && <p className="mtg-send-status">{tr("Sending as ")}<bdi>{postingSender}</bdi></p>}
        {!selected.closed && !replyDeleted && !attachment && delivery[selected.id] !== "sending" && topicMediaAvailable
          && <MediaComposer controller={mediaController} draftStash={draftStash} groupEmoji={loadGroupEmoji ? { id: chatId, load: loadGroupEmoji } : undefined} groupStickers={chat?.subtitle === "Group"} key={`${selected.id}:${reply?.origin?.chatId ?? ""}:${reply?.id ?? ""}`}
            richDraftStorage={draftStorage && { key: String(selected.id), record: draftStorage.rich, replies: draftStorage.richReplies }}
            draftContext={{ destination: { chatId, topicId: selected.id }, reply, checkExternalReply: messageActions?.externalReplyAllowed,
              actionsForReply: (restored) => mediaComposer(chatId, { id: selected.id, name: selected.name }, restored) }}
            actions={mediaReply ? mediaComposer(chatId, { id: selected.id, name: selected.name }, mediaReply)
              : mediaComposer(chatId, { id: selected.id, name: selected.name })}
            onSent={reply && (() => setReplies((previous) => previous[selected.id] === reply
              ? { ...previous, [selected.id]: undefined } : previous))} albumVideo={allowVideoAttachment}
            albumDocuments={!!sendDocument && allowDocumentAttachment} {...mediaPermissions} />}
        {sendPoll && !replyDeleted && !selected.closed && <PollComposer key={JSON.stringify([selected.id, mediaReply])} chatId={chatId}
          topic={{ id: selected.id, name: selected.name }} reply={mediaReply}
          onSent={reply && (() => setReplies((previous) => previous[selected.id] === reply
            ? { ...previous, [selected.id]: undefined } : previous))} allowVisibleVotes send={sendPoll} />}
        {reply && <div className="mtg-reply-preview">
          <div><strong>{replyDeleted ? tr("Original message was deleted") : tr("Replying to {0}{1}", [reply.author, externalReply ? " in another conversation" : ""])}</strong>
            {!replyDeleted && (!externalReply || reply.selectedQuote) && <p>{reply.selectedQuote?.text ?? displayMessagePreview(reply, tr)}</p>}
            {!replyDeleted && !externalReply && !attachment && sendTopicText && reply.canQuote &&
              <SelectReplyQuote key={reply.id} text={reply.text} layout={reply.richMessage} quote={reply.selectedQuote}
                disabled={delivery[selected.id] === "sending"} change={(selectedQuote) =>
                  setReplies((previous) => ({ ...previous, [selected.id]: { ...reply, selectedQuote } }))} />}
          </div>
          {openReplyPicker && !externalReply && !replyDeleted && <button type="button" className="mtg-action"
            onClick={() => openReplyPicker(reply, selected.id)}>{tr("Reply in another chat")}</button>}
          <button type="button" className="mtg-action" disabled={delivery[selected.id] === "sending"}
            onClick={() => {
              setReplies((previous) => ({ ...previous, [selected.id]: undefined }));
              topicInput.current?.focus();
            }}>{tr("Cancel reply")}</button>
        </div>}
        {!attachment && !replyDeleted && !selected.closed && dropKinds.document
          && delivery[selected.id] !== "sending" && <ArchiveAttachment key={selected.id} controller={archivePicker}
            preparing={archivePreparing} setPreparing={setArchivePreparing}
            attach={(file) => chooseAttachment(file, selected.id, "document")} />}
        {attachment && <div className="mtg-reply-preview">
          {attachment.kind === "photo" && ("data" in attachment
            ? <img className="mtg-attachment-preview" src={`data:image/jpeg;base64,${attachment.data}`} alt={tr("Selected photo")} />
            : <AttachmentPhotoPreview file={attachment.file} alt={tr("Selected photo")} />)}
          <div><bdi>{attachment.name}</bdi>
          {attachment.kind === "photo" && <EditDraftPhoto key={`photo-draft:${selected.id}`} source={"data" in attachment ? attachment.data : attachment.file}
            disabled={delivery[selected.id] === "sending"} apply={(data) =>
              setAttachments((previous) => previous[selected.id] === attachment
                ? { ...previous, [selected.id]: { kind: "photo", name: attachment.name, options: attachment.options, delivery: attachment.delivery, data, drawnPhotoReply: drawnReply, originalFile: originalAttachment(attachment) } }
                : previous)} />}
          {attachment.kind === "video" && <VideoAttachmentEdits key={`video-draft:${selected.id}`} file={attachment.file}
            options={attachment.options} allowGif={allowVideoAsGif} disabled={delivery[selected.id] === "sending"} change={(options) =>
              setAttachments((previous) => previous[selected.id] === attachment
                ? { ...previous, [selected.id]: { ...attachment, options } } : previous)} />}
          <AttachmentDeliveryControls draft={attachment.delivery} disabled={delivery[selected.id] === "sending"}
            change={(delivery) => setAttachments((previous) => previous[selected.id] === attachment
              ? { ...previous, [selected.id]: { ...attachment, delivery } } : previous)} />
          {attachment.kind !== "document" && <MediaSendControls kind={attachmentAsGif ? "GIF" : attachment.kind} options={attachment.options} hasCaption={!!topicDraft.trim()}
            allowOriginalVideo={attachment.kind === "video" && !attachmentAsGif && !attachment.options?.videoEdit}
            disabled={delivery[selected.id] === "sending"} change={(options) =>
              setAttachments((previous) => previous[selected.id] === attachment
                ? { ...previous, [selected.id]: { ...attachment, options } } : previous)} />}
          {dropKinds.document && attachment.kind !== "document" && originalAttachment(attachment) &&
            <button type="button" className="mtg-action" disabled={delivery[selected.id] === "sending"}
              onClick={() => chooseAttachment(originalAttachment(attachment), selected.id, "document", attachment.delivery)}>{tr("Send original as file")}</button>}
          </div>
          <button type="button" className="mtg-action" disabled={delivery[selected.id] === "sending"}
            onClick={() => setAttachments((previous) => ({ ...previous, [selected.id]: undefined }))}>{tr("Remove ")}{attachment.kind}</button>
        </div>}
        {upload && <div className="mtg-send-status">
          {upload.telegram ? <>
            <progress aria-label={tr("Topic document upload to Telegram")} max={upload.telegram.total} value={upload.telegram.uploaded} />
            <span> {upload.telegram.uploaded === upload.telegram.total ? tr("Waiting for Telegram to confirm delivery.")
              : tr("{0}% uploaded to Telegram", [Math.floor(upload.telegram.uploaded / upload.telegram.total * 100)])}</span>
          </> : <>
            <progress aria-label={tr("Topic document upload to BB")} max={upload.total} value={upload.bytes} />
            {upload.bytes === upload.total && <span> {upload.canCancel ? tr("Preparing file for Telegram.") : tr("Waiting for Telegram.")}</span>}
          </>}
          {upload.canCancel && <button type="button" className="mtg-action" onClick={() => {
            const control = uploadControls.current.get(selected.id);
            if (!control?.canCancel) return;
            control.canCancel = false;
            control.controller.abort();
            setUploads((previous) => ({ ...previous, [selected.id]: { ...upload, canCancel: false } }));
          }}>{tr("Cancel upload")}</button>}
        </div>}
        {!(syncDraft && sendTopicText && !attachment && !reply) && renderPendingDrafts()}
        {syncDraft && loadTopicDraft && saveTopicDraft && sendTopicText && !attachment && !reply &&
          <TopicDraftSync key={`topic-draft-sync:${selected.id}`} chatId={chatId} topicId={selected.id} load={loadTopicDraft} save={saveTopicDraft}
            draft={topicDraft.trim() ? { text: topicDraft, styles: formatting.ranges, links: formatting.links,
              ...(formatting.customEmoji.length ? { customEmoji: formatting.customEmoji } : {}),
              preview: savedDraftPreview(linkPreviews[selected.id], topicDraft, formatting.links.length > 0) } : null} edited={drafts[selected.id] !== undefined}
            renderLinkDraft={linkDraft || inlineDraft ? renderPendingDrafts : undefined}
            busy={delivery[selected.id] === "sending"}
            useDraft={(draft) => {
              formatting.restore(draft);
              setLinkPreviews((previous) => ({ ...previous, [selected.id]: restoreDraftPreview(draft) }));
              setDrafts((previous) => ({ ...previous, [selected.id]: draft.text }));
              topicInput.current?.focus();
            }} />}
        {!(loadTopicDraft && saveTopicDraft) && savedDraft && sendTopicText && drafts[selected.id] === undefined && !attachment && !reply &&
          <button type="button" className="mtg-action" onClick={() => {
            setDrafts((previous) => previous[selected.id] === undefined ? { ...previous, [selected.id]: savedDraft } : previous);
          }}>{tr("Use Telegram draft")}</button>}
        {scheduleActions && !attachment && (sendTopicText || sendPhoto || (sendDocument && (allowDocumentAttachment || allowVideoAttachment))) &&
          <ScheduledMessages key={`scheduled-messages:${selected.id}`} chatId={chatId} topicId={selected.id} liveRevision={liveRevision ?? 0}
            loadGroupEmoji={loadGroupEmoji}
            mediaLoaders={{ loadPhoto, loadMedia, loadVideoStream, saveDocument }}
            saveSelectedAttachments={messageActions?.saveSelectedAttachments}
            editActions={messageActions}
            draft={topicDraft} textOptions={!!sendTopicText} canSend={!!sendTopicText && !longDraft && !replyDeleted && !archivePreparing && delivery[selected.id] !== "sending"} {...scheduleActions}
            send={(options) => sendWithOptions(selected, options)}
            accepted={(text, result, scheduled) => acceptSend(selected, text, result.message, scheduled)} />}
        {sendTopicText && !attachment && hasWebLink(topicDraft) && <LinkPreviewControls choice={linkPreviews[selected.id]} text={topicDraft}
          disabled={delivery[selected.id] === "sending"}
          change={(placement) => setLinkPreviews((previous) => ({ ...previous, [selected.id]: placement }))} />}
        {(sendTopicText || attachment) && <DraftFormatControls formatting={formatting} busy={delivery[selected.id] === "sending"} />}
        {inlineBot && messageActions?.inlineBotActions && sendTopicText && !attachment && !replyDeleted && !selected.closed &&
          <InlineBotSearch key={JSON.stringify([chatId, selected.id, inlineBot.username, inlineBot.query, mediaReply])}
            {...inlineBot} chatId={chatId} preview={messageActions.inlineBotActions.preview} disabled={delivery[selected.id] === "sending"}
            launchMiniApp={messageActions.inlineBotActions.launchMiniApp && ((token) => messageActions.inlineBotActions!.launchMiniApp!(chatId, token, { id: selected.id, name: selected.name }))}
            search={(username, query, offset) => messageActions.inlineBotActions!.search(chatId, username, query, offset, { id: selected.id, name: selected.name })}
            send={async (token) => {
              if (sending.current.has(selected.id)) return { state: "failed" };
              sending.current.add(selected.id);
              setDelivery((previous) => ({ ...previous, [selected.id]: "sending" }));
              try {
                const result = await messageActions.inlineBotActions!.send(chatId, token, { id: selected.id, name: selected.name },
                  mediaReply);
                if (result.state === "sent") acceptSend(selected, topicDraft.trim(), result.message);
                return result;
              } finally {
                sending.current.delete(selected.id);
                setDelivery((previous) => ({ ...previous, [selected.id]: undefined }));
              }
            }} />}
        {messageActions?.replyBotActions && sendTopicText && !selected.closed && !attachment && !reply &&
          <ReplyBotKeyboard key={`reply-bot-keyboard:${selected.id}`} chatId={chatId} topicId={selected.id} liveRevision={liveRevision}
            actions={messageActions.replyBotActions} disabled={delivery[selected.id] === "sending"} />}
        <form className="mtg-composer" onSubmit={(event) => void send(event, selected)} onPaste={(event) => {
          if (!sendPhoto || sending.current.has(selected.id)) return;
          const photo = Array.from(event.clipboardData.files).find((file) => isPhotoMimeType(file.type));
          if (!photo) return;
          event.preventDefault();
          chooseAttachment(photo, selected.id, "photo");
        }}>
        <ComposerActionMenu key={selected.id} allowed={dropKinds} topic disabled={delivery[selected.id] === "sending" || selected.closed}
          pickFiles={chooseTopicFiles} pickFile={(file, kind) => chooseAttachment(file, selected.id, kind)} />
        {chat && messageActions?.attachmentMiniApps && sendTopicText && !attachment && !reply && !selected.closed &&
          <AttachmentMiniApps key={selected.id} id={chatId} name={chat.name} topic={selected} actions={messageActions.attachmentMiniApps}
            disabled={delivery[selected.id] === "sending"} />}
        {(sendTopicText || attachment) && !selected.closed &&
          <ComposerEmojiPickers manage key={`emoji:${selected.id}`} disabled={delivery[selected.id] === "sending"}
            group={loadGroupEmoji ? { id: chatId, load: loadGroupEmoji } : undefined}
            insert={(choice) => formatting.insertCustomEmoji(choice, (value) => {
              setDrafts((previous) => ({ ...previous, [selected.id]: value }));
              typingActivity.changed(value);
            })} />}
        {messageActions?.loadBotCommands && sendTopicText && !attachment && !selected.closed &&
          <BotCommandMenu key={`bot-command-menu:${selected.id}`} chatId={chatId} load={messageActions.loadBotCommands} draft={topicDraft}
            disabled={delivery[selected.id] === "sending"} apply={(value) => {
              formatting.change(value);
              setDrafts((previous) => ({ ...previous, [selected.id]: value }));
              topicInput.current?.focus();
            }} />}
        {(sendTopicText || attachment) && <DraftFormatButton formatting={formatting} busy={delivery[selected.id] === "sending"} />}
        {draftStashNotice?.topicId === selected.id && <p role="status">{draftStashNotice.text}</p>}
        {(sendTopicText || sendPhoto || attachment || canStashDraft) && <textarea ref={topicInput} rows={1}
          aria-keyshortcuts={sendTopicText || attachment ? `${reply ? "Escape " : attachment ? "" : "ArrowUp "}${draftFormattingShortcuts} ${draftLinkShortcuts}${navigateTopicReply ? ` ${replyNavigationShortcuts}` : ""}${canStashDraft ? " Control+S" : ""}`
            : canStashDraft ? "Control+S" : reply ? "Escape" : undefined}
          onKeyDown={(event) => {
            if (navigateTopicReply?.(event)) return;
            if (canStashDraft && !sending.current.has(selected.id) && !archivePicker.current?.isPreparing() && isStashShortcut(event)) {
              event.preventDefault();
              if (event.repeat) return;
              const current = { draft: { text: topicDraft, styles: formatting.ranges,
                links: formatting.links, customEmoji: formatting.customEmoji }, preview: linkPreviews[selected.id], reply, attachment };
              const destination = { chatId, topicId: selected.id, text: !!sendTopicText, attachments: dropKinds };
              const topicId = selected.id;
              function apply(restored: StashedDraft) {
                if (attachment || restored.attachment) {
                  setAttachments((previous) => ({ ...previous, [topicId]: restored.attachment }));
                  setDelivery((previous) => ({ ...previous, [topicId]: undefined }));
                  setFileErrors((previous) => ({ ...previous, [topicId]: undefined }));
                }
                formatting.restore(restored.draft);
                setDrafts((previous) => ({ ...previous, [topicId]: restored.draft.text }));
                setLinkPreviews((previous) => ({ ...previous, [topicId]: restored.preview }));
                setReplies((previous) => ({ ...previous, [topicId]: restored.reply }));
                typingActivity.stop();
                setDraftStashNotice({ topicId, text: restored.draft.text || restored.reply || restored.attachment ? "Draft restored." : "Draft set aside." });
              }
              const next = draftStash.exchange(current, destination);
              if (!next) return;
              if (next === "differentConversation") {
                const check = messageActions?.externalReplyAllowed;
                if (check) {
                  const stillCurrent = beginExternalReplyCheck();
                  setDraftStashNotice({ topicId, text: "Checking whether the reply can move here…" });
                  void draftStash.checkExternalReply(check).catch(() => undefined).then((proof) => {
                    if (!stillCurrent() || sending.current.has(topicId) || archivePicker.current?.isPreparing()) return;
                    const restored = proof && draftStash.exchange(current, destination, proof);
                    if (restored && typeof restored !== "string") apply(restored);
                    else setDraftStashNotice({ topicId, text: "This reply can only be restored in its original conversation." });
                  });
                } else {
                  setDraftStashNotice({ topicId, text: "Open the original chat or topic to restore the stashed reply." });
                }
                return;
              }
              if (next === "album" || next === "rich") {
                if (mediaController.current?.restoreStashedDraft(next)) {
                  setDraftStashNotice(undefined);
                  typingActivity.stop();
                } else {
                  setDraftStashNotice({ topicId: selected.id, text: next === "album"
                    ? "Open an album composer to restore the stashed album."
                    : "Open the formatted message editor to restore the stashed draft." });
                }
                return;
              }
              if (next === "unsupportedDraft") {
                setDraftStashNotice({ topicId: selected.id, text: "This topic cannot send the stashed draft." });
                return;
              }
              apply(next);
              return;
            }
            if (reply && delivery[selected.id] !== "sending" && isPlainKey(event, "Escape")) {
              event.preventDefault();
              setReplies((previous) => ({ ...previous, [selected.id]: undefined }));
              return;
            }
            if ((sendTopicText || attachment) && !selected.closed && delivery[selected.id] !== "sending") formatting.shortcut(event);
            composerKeys(event, sendTopicText && !attachment && !reply && delivery[selected.id] !== "sending" ? editLast : undefined);
          }}
          aria-label={attachment ? tr("Write a topic attachment caption") : !sendTopicText ? tr("Paste a topic photo or write a caption") : tr("Write a topic message")}
          placeholder={attachment ? tr("Write an attachment caption") : !sendTopicText ? tr("Paste a photo or write a caption") : tr("Write a topic message")} maxLength={draftLimit}
          value={topicDraft} onBlur={typingActivity.stop} disabled={delivery[selected.id] === "sending"}
          onSelect={(event) => formatting.select(event.currentTarget)}
          onPaste={(event) => {
            if ((sendTopicText || attachment) && !selected.closed && delivery[selected.id] !== "sending") {
              formatting.paste(event, (value) => setDrafts((previous) => ({ ...previous, [selected.id]: value })));
            }
          }}
          onChange={(event) => {
            const text = event.currentTarget.value;
            if (draftStashNotice?.topicId === selected.id) setDraftStashNotice(undefined);
            typingActivity.changed(text);
            formatting.change(text, event.currentTarget.selectionEnd);
            setDrafts((previous) => ({ ...previous, [selected.id]: text }));
          }} />}
        {longDraft && <div className="mtg-long-draft">
          <p role="status">{sendTopicText ? tr("This draft exceeds Telegram’s message limit. Choose how to send it.")
            : tr("Shorten this draft to send it as a message.")}</p>
          {sendTopicText && <button type="button" className="mtg-action"
            disabled={!!replyDeleted || !!formatting.editingLink || archivePreparing || delivery[selected.id] === "sending" || delivery[selected.id] === "unknown"}
            onClick={() => void sendParts(selected)}>{tr("Send as multiple messages")}</button>}
          {canSendTextFile && <button type="button" className="mtg-action"
            disabled={!!replyDeleted || archivePreparing || delivery[selected.id] === "sending" || delivery[selected.id] === "unknown"}
            onClick={(event) => void send(event, selected, true)}>{tr("Send as text file")}</button>}
        </div>}
        <button type="submit" className="mtg-action"
          disabled={longDraft || delivery[selected.id] === "unknown" || !!replyDeleted || archivePreparing || (attachment ? !canSendAttachment(attachment) || (drafts[selected.id]?.trim().length ?? 0) > 1024
              || attachmentDelivery(attachment.delivery) === null || !!attachment.delivery?.whenOnline
            : !sendTopicText || !drafts[selected.id]?.trim()) || delivery[selected.id] === "sending"}>{tr("Send to topic")}</button>
        </form>
        {fileErrors[selected.id] && <p role="alert">{fileErrors[selected.id]}</p>}
        {delivery[selected.id] === "failed" && <p role="alert">{tr("Telegram rejected the message. Your draft is still here.")}</p>}
        {delivery[selected.id] === "unknown" && <><p role="alert">{tr("Telegram did not confirm delivery. Check the topic before retrying.")}</p>
          <button type="button" className="mtg-action" onClick={() => setDelivery((previous) => ({ ...previous, [selected.id]: undefined }))}>{tr("Allow retry after checking the topic")}</button></>}
        {delivery[selected.id] === "cancelled" && <p role="status">{tr("Upload cancelled. Your draft is still here.")}</p>}
        {delivery[selected.id] === "legacy_tdlib" && <p role="alert">{tr("Update TDLib to send documents this large.")}</p>}
        {delivery[selected.id] === "premium_required" && <p role="alert">{tr("Telegram Premium is required to send documents over 2000 MiB.")}</p>}
        {delivery[selected.id] === "file_too_large" && <p role="alert">{tr("Telegram supports uploads up to 4000 MiB.")}</p>}
        {delivery[selected.id] === "scheduled" && <p role="status">{tr("Message scheduled.")}</p>}
        {delivery[selected.id] === "video_preparation_failed" && <p role="alert">{attachment?.options?.videoEdit
          ? tr("BB could not apply the video edits. Your draft is still here.")
          : attachment?.options?.originalVideo
          ? tr("Original video quality is unavailable for this file. Your file and caption are still here.")
          : tr("BB could not prepare this file for video playback. Your file and caption are still here.")}</p>}
        {allowDocumentAttachment && !selected.closed && attachment?.kind === "video" && delivery[selected.id] === "video_preparation_failed" &&
          <button type="button" className="mtg-action" onClick={() => {
            setAttachments((previous) => previous[selected.id] !== attachment ? previous : {
              ...previous, [selected.id]: { kind: "document", name: attachment.name, file: attachment.file, delivery: attachment.delivery },
            });
            setDelivery((previous) => ({ ...previous, [selected.id]: undefined }));
          }}>{tr("Attach original as document")}</button>}
        {delivery[selected.id] === "reply_unavailable" && <p role="alert">{tr("The original message is unavailable. Your draft is still here.")}</p>}
      </div></ComposerActions> : undefined} />
      : <>
        <form className="mtg-composer" onSubmit={search}>
          <input ref={topicSearch} autoFocus type="search" maxLength={128} aria-keyshortcuts="Meta+F Control+F ArrowDown" aria-label={tr("Find a topic")} placeholder={tr("Find a topic")}
            value={searchText} onChange={(event) => setSearchText(event.target.value)} />
          <button type="submit" className="mtg-action">{tr("Find")}</button>
          <button type="button" className="mtg-action" aria-keyshortcuts="Escape" onClick={close}>{tr("Back to conversation")}</button>
        </form>
        {linkDraft && dismissLinkDraft && <div role="status">
          <span>{tr("Choose a topic for the link draft.")}</span>
          <button type="button" className="mtg-action" onClick={dismissLinkDraft}>{tr("Cancel link draft")}</button>
        </div>}
        {!query && displayed && markForumRead && <button type="button" className="mtg-action"
          disabled={readingTopic !== undefined} onClick={() => void readForum()}>{tr("Mark all topics as read")}</button>}
        {readingTopic === "forum" && <p role="status">{tr("Marking topics as read…")}</p>}
        {forumReadResult === "error" && <p role="alert">{tr("Telegram could not complete the forum update.")}</p>}
        {forumReadResult && forumReadResult !== "error" && <p role="status">
          {forumReadResult.read}{tr(" marked as read.")}{forumReadResult.failed > 0 && tr(" {0} could not be updated.", [forumReadResult.failed])}
        </p>}
        {manageTopic && canCreateOrDelete && <TopicControls chatId={chatId} bot={botTopics} manage={manageTopic} onChange={applyTopic} />}
        {displayed === undefined && <p role="status">{tr("Searching topics…")}</p>}
        {displayed === null && <p role="alert">{tr("Could not load Telegram topics.")}</p>}
        {displayed?.length === 0 && <p role="status">{tr("No matching topics")}</p>}
        {readError && <p role="alert">{tr("Telegram could not mark the topic as read.")}</p>}
        {!!displayed?.length && <ul aria-label={tr("Forum topic results")} aria-keyshortcuts="ArrowUp ArrowDown Home End Escape">{displayed.map((topic) => <li key={topic.id}>
          <button type="button" className="mtg-action" data-topic-row={topic.id} onClick={(event) => {
            const list = panel.current;
            if (list) topicListPosition.current = { id: topic.id, top: list.scrollTop,
              offset: event.currentTarget.getBoundingClientRect().top - list.getBoundingClientRect().top };
            setSelected(topic);
          }}>
            <TopicName topic={topic} />{topic.closed && tr(" · Closed")}{topic.hidden && tr(" · Hidden")}{topic.pinned && tr(" · Pinned")}
            {topic.unread && <span className="mtg-unread mtg-topic-unread" aria-label={tr("{0} unread messages", [topic.unread])}>{topic.unread}</span>}
            {topic.unreadMentions && <span className="mtg-unread-mentions mtg-topic-unread" aria-label={tr("{0} unread mentions", [topic.unreadMentions])}>@{topic.unreadMentions}</span>}
            {topic.unreadReactions && <span className="mtg-unread-reactions mtg-topic-unread" aria-label={tr("{0} unread reactions", [topic.unreadReactions])}>♥ {topic.unreadReactions}</span>}
          </button>
          {!!topic.unread && markTopicRead && <button type="button" className="mtg-reply-action" disabled={readingTopic !== undefined}
            aria-label={tr("Mark {0} as read", [topic.name])} title={tr("Mark topic as read")}
            onClick={() => void readTopic(topic)}><CheckCheck size={16} aria-hidden="true" /></button>}
          {topic.preview && <p className="mtg-topic-preview">
            <span>{topic.preview.outgoing && <strong>{tr("You: ")}</strong>}<bdi>{topic.preview.text}</bdi></span>
            {topic.preview.time && <time>{topic.preview.time}</time>}
          </p>}
        </li>)}</ul>}
        {page?.next && <button type="button" className="mtg-action"
          disabled={pageRequest?.cursor === page.next && !pageError}
          onClick={() => { if (page.next) { setPageError(false); setPageRequest({ query, cursor: page.next }); } }}>
          {pageError ? tr("Retry more topics") : tr("Load more topics")}
        </button>}
      </>}
  </section></UseInlineBotDraft.Provider>;
}

function TopicName({ topic }: { topic: ForumTopic }) {
  return <>{topic.color !== undefined && <span className="mtg-topic-color" aria-hidden="true"
    style={{ backgroundColor: `#${topic.color.toString(16).padStart(6, "0")}` }} />}<bdi>{topic.name}</bdi></>;
}

function PinnedTopicOrder({ chatId, topicId, load, move }: {
  chatId: string;
  topicId: number;
  load: NonNullable<PinnedForumTopicActions["pinnedForumTopicOrder"]>;
  move: NonNullable<PinnedForumTopicActions["movePinnedForumTopic"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const [order, setOrder] = useState<number[]>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const index = order?.indexOf(topicId) ?? -1;
  async function reload() {
    const latest = await load(chatId).catch(() => null);
    setOrder(latest ?? undefined);
    return latest;
  }
  async function change(direction: "up" | "down") {
    if (!order || index < 0 || busy) return;
    setBusy(true);
    const result = await move(chatId, topicId, direction, order).catch(() => "unknown" as const);
    await reload();
    setStatus(result === "updated" ? "Pinned topic moved."
      : result === "changed" ? "Pinned topics changed. Review their order and try again."
      : "Telegram did not confirm the new order.");
    setBusy(false);
  }
  return <div role="group" aria-label={tr("Pinned topic order")}>
    <button type="button" className="mtg-action" disabled={busy} onClick={async () => {
      if (busy) return;
      setBusy(true);
      setStatus(await reload() ? "" : "Could not load pinned topics.");
      setBusy(false);
    }}>{order ? tr("Refresh pinned topic order") : tr("Show pinned topic order")}</button>
    {order && (index < 0 ? <p>{tr("This topic is no longer pinned.")}</p> : <>
      <p>{tr("Position ")}{index + 1}{tr(" of ")}{order.length}</p>
      <button type="button" className="mtg-action" disabled={busy || index === 0}
        onClick={() => void change("up")}>{tr("Move topic up")}</button>
      <button type="button" className="mtg-action" disabled={busy || index >= order.length - 1}
        onClick={() => void change("down")}>{tr("Move topic down")}</button>
    </>)}
    {status && <p role="status">{tr(status)}</p>}
  </div>;
}

function TopicControls({ chatId, topic, bot, manage, onChange, deleteTopic, onDeleted }: {
  chatId: string;
  topic?: ForumTopic;
  bot: boolean;
  manage: ManageForumTopic;
  onChange: (topic: ForumTopic) => void;
  deleteTopic?: DeleteForumTopic;
  onDeleted?: (id: number) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [name, setName] = useState(topic?.name ?? "");
  const [color, setColor] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const [deleteError, setDeleteError] = useState("");
  const canDelete = topic && !topic.general && (bot || topic.id > 1) && !!deleteTopic;
  async function run(action: Parameters<ManageForumTopic>[1]) {
    setBusy(true);
    setError(false);
    try {
      const result = await manage(chatId, action);
      setName(result.name);
      onChange(result);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!canDelete || !topic || !deleteTopic || busy || confirmation !== topic.name) return;
    setBusy(true);
    setDeleteError("");
    const result = await deleteTopic(chatId, topic.id, topic.name).catch(() => "unknown" as const);
    setBusy(false);
    if (result === "deleted") onDeleted?.(topic.id);
    else {
      setConfirmation(undefined);
      setDeleteError(result === "refused" ? "Telegram refused deletion or the topic changed."
        : "Telegram did not confirm deletion. Check the topic list before retrying.");
    }
  }
  return <details>
    <summary>{topic ? tr("Topic settings") : tr("New topic")}</summary>
    <form className="mtg-composer" onSubmit={(event) => {
      event.preventDefault();
      const title = name.trim();
      if (!busy && title) void run(topic ? { kind: "rename", topic: topic.id, name: title }
        : { kind: "create", name: title, ...(color === undefined ? {} : { color }) });
    }}>
      <input aria-label={tr("Topic name")} maxLength={128} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      {!topic && <select aria-label={tr("Topic icon color")} value={color ?? ""} disabled={busy} onChange={(event) =>
        setColor(forumTopicColors.find(({ value }) => String(value) === event.target.value)?.value)}>
        <option value="">{tr("Default color")}</option>
        {forumTopicColors.map(({ value, label }) => <option value={value} key={value}>{tr(label)}</option>)}
      </select>}
      <button className="mtg-action" type="submit" disabled={busy || !name.trim() || name.trim() === topic?.name}>{topic ? tr("Rename topic") : tr("Create topic")}</button>
    </form>
    {!bot && topic && <button className="mtg-action" type="button" disabled={busy} onClick={() =>
      void run({ kind: "close", topic: topic.id, closed: !topic.closed })}>{topic.closed ? tr("Reopen topic") : tr("Close topic")}</button>}
    {topic && <button className="mtg-action" type="button" disabled={busy} onClick={() =>
      void run({ kind: "pin", topic: topic.id, pinned: !topic.pinned })}>{topic.pinned ? tr("Unpin topic") : tr("Pin topic")}</button>}
    {!bot && topic?.general && <button className="mtg-action" type="button" disabled={busy} onClick={() =>
      void run({ kind: "hideGeneral", topic: topic.id, hidden: !topic.hidden })}>{topic.hidden ? tr("Show General topic") : tr("Hide General topic")}</button>}
    {topic && canDelete && (confirmation === undefined
      ? <button type="button" className="mtg-action" disabled={busy} onClick={() => {
        setDeleteError("");
        setConfirmation("");
      }}>{tr("Delete topic")}</button>
      : <div role="group" aria-label={tr("Confirm topic deletion")}>
        <p>{tr("Delete ")}<bdi>{topic.name}</bdi>{tr(" and all messages in it?")}</p>
        <label>{tr("Type the topic name ")}<input value={confirmation} disabled={busy}
          onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button type="button" className="mtg-action" disabled={busy || confirmation !== topic.name}
          onClick={() => void remove()}>{tr("Delete topic for everyone")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirmation(undefined)}>{tr("Cancel")}</button>
      </div>)}
    {deleteError && <p role="alert">{tr(deleteError)}</p>}
    {error && <p role="alert">{tr("Telegram could not apply this change. Check your topic permissions.")}</p>}
  </details>;
}

function TopicHistory({ chatId, chat, loadGroupEmoji, loadAvatar, loadMessageLink, topic, liveRevision, loadTopicHistory, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, messageActions, deletedIds, sent, replaceSent, actions, composer, reply, cancelReply, openReplyPicker, chooseReply, drawPhotoReply, readingPlaces, historyView, back, nextUnread }: {
  chatId: string;
  chat?: Chat;
  loadGroupEmoji?: LoadGroupEmoji;
  loadAvatar?: AvatarLoader;
  loadMessageLink?: MessageLinkLoader;
  topic: ForumTopic;
  liveRevision?: number;
  loadTopicHistory: ForumActions["loadTopicHistory"];
  loadPhoto: ComponentProps<typeof MessageContent>["loadPhoto"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument: ComponentProps<typeof MessageContent>["saveDocument"];
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  messageActions?: TopicMessageActions;
  deletedIds?: ReadonlySet<string>;
  sent: readonly Message[];
  replaceSent: (message: Message) => void;
  actions: ReactNode;
  composer?: (editLast: () => boolean, navigateTopicReply?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean) => ReactNode;
  reply?: ComposerReply;
  cancelReply: () => void;
  openReplyPicker?: (message: ComposerReply) => void;
  chooseReply?: (message: ComposerReply) => void;
  drawPhotoReply?: { verify: (id: string) => Promise<boolean>; stage: (message: Message, data: string) => Promise<boolean> };
  readingPlaces?: ReadingPlaces;
  historyView?: HistoryView;
  back: () => void;
  nextUnread?: { topic?: ForumTopic; status?: "loading" | "empty" | "failed";
    open: (currentRead: boolean, trigger: HTMLButtonElement) => void };
}) {
  const { t: tr } = useTelegramLocale();
  const readingKey = `${chatId}:${topic.id}`;
  const [restored] = useState(() => historyView?.get(readingKey));
  const [resumeMessage, setResumeMessage] = useState(() => restored ? undefined : readingPlaces?.get(readingKey)?.messageId);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [searchMode, setSearchMode] = useState<"pinned" | "search" | "author" | "date">();
  const [selectedDay, setSelectedDay] = useState<string>();
  const dateTrigger = useRef<HTMLButtonElement>(null);
  const [author, setAuthor] = useState<AuthorFilter>();
  const [authorRevision, setAuthorRevision] = useState(0);
  const authorTrigger = useRef<HTMLButtonElement>(null);
  const pinnedTrigger = useRef<HTMLButtonElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [originalSelection, setOriginalSelection] = useState<{ id: string; playback?: { time: number }; quote?: Message["replyQuoteAnchor"] }>();
  const original = originalSelection?.id;
  function setOriginal(id?: string, time?: number, quote?: Message["replyQuoteAnchor"]) {
    setOriginalSelection(id ? { id, playback: time === undefined ? undefined : { time }, quote } : undefined);
  }
  const originalTrigger = useRef<HTMLElement>(null);
  const openExternalReply = useContext(OpenExternalReply);
  const openingOriginal = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => openingOriginal.current?.abort(), [chatId, topic.id, searchMode, original]);
  const [editing, setEditing] = useState<EditDraft>();
  const [page, setPage] = useState<HistoryPage | undefined>(restored?.page);
  const [deferredLatest, setDeferredLatest] = useState<HistoryPage>();
  const stagedHistory = useRef(deferredLatest);
  useLayoutEffect(() => { stagedHistory.current = deferredLatest; }, [deferredLatest]);
  const shownPage = useRef<HistoryPage>(undefined);
  const loadUnreadHistory = messageActions?.loadUnreadHistory;
  const newerPending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [chatId, topic.id]);
  const unreadPositioned = useRef<string | undefined>(restored?.page.openAt);
  const [newerStatus, setNewerStatus] = useState<"loading" | "failed">();
  const [latestJump, setLatestJump] = useState<"loading" | "failed">();
  const latestJumpPending = useRef(false);
  const historyReplacement = useRef(0);
  const seenRevision = useRef<number | null | undefined>(restored ? null : liveRevision);
  const currentRevision = useRef(liveRevision);
  useLayoutEffect(() => { currentRevision.current = liveRevision; }, [liveRevision]);
  const history = useRef<HTMLOListElement>(null);
  const scrolling = useRef<Parameters<typeof restoreHistoryScroll>[1] | undefined>(restored?.position);
  const lastHistoryTop = useRef(0);
  const followLatest = useRef(true);
  useLayoutEffect(() => {
    shownPage.current = page;
    const list = history.current;
    const position = scrolling.current;
    scrolling.current = undefined;
    if (!list) return;
    const start = page?.openAt;
    const row = start && unreadPositioned.current !== start ? list.querySelector<HTMLElement>(`[data-message-id="${start}"]`) : undefined;
    if (row) {
      unreadPositioned.current = start;
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    } else if (position) {
      restoreHistoryScroll(list, position);
    } else if (followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
    lastHistoryTop.current = list.scrollTop;
    followLatest.current = !page?.after && !isAwayFromLatest(list);
    setAwayFromLatest(!followLatest.current);
  }, [page, sent.length]);
  useLayoutEffect(() => {
    const list = history.current;
    if (!list || original || searchMode) return;
    return observeHistoryResize(list, () => !list.hidden,
      () => followLatest.current, () => { lastHistoryTop.current = list.scrollTop; });
  }, [page, sent.length, deletedIds, original, searchMode]);
  const [pending, setPending] = useState(!restored);
  const pendingRequest = useRef(!restored);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<{ before?: string }>({});
  useEffect(() => {
    let current = true;
    if (!cursor.before && restored) return;
    const requestedRevision = currentRevision.current;
    const replacement = historyReplacement.current;
    const load = async () => {
      if (!cursor.before && loadUnreadHistory) {
        const unread = await loadUnreadHistory(chatId, undefined, topic.id);
        if (unread) return unread;
      }
      return loadTopicHistory(chatId, topic.id, cursor.before);
    };
    void load().then((next) => {
      if (!current || replacement !== historyReplacement.current) return;
      if (!cursor.before) seenRevision.current = requestedRevision;
      if (cursor.before && shownPage.current?.before !== cursor.before) return;
      const list = history.current;
      if (cursor.before && list) {
        scrolling.current = captureHistoryScroll(list, "prepend");
      }
      setPage((previous) => {
        if (!cursor.before) return next;
        return previous?.before === cursor.before ? prependHistory(previous, next) : previous;
      });
    }, () => { if (current && replacement === historyReplacement.current) setError(true); }).finally(() => {
      if (current) {
        pendingRequest.current = false;
        setPending(false);
      }
    });
    return () => { current = false; };
  }, [chatId, cursor, loadTopicHistory, loadUnreadHistory, topic.id, restored]);

  const historyLoaded = page !== undefined;
  useEffect(() => {
    if (!historyLoaded || seenRevision.current === liveRevision) return;
    const previous = shownPage.current;
    if (!previous || previous.after) return;
    seenRevision.current = liveRevision;
    let current = true;
    const staged = stagedHistory.current;
    const newest = Number((staged ?? previous).messages.at(-1)?.id);
    void loadTopicHistory(chatId, topic.id).then(async (page) => {
      const latest = await fillHistoryGap(page, newest, (before) => loadTopicHistory(chatId, topic.id, before), () => current);
      if (!latest || !current) return;
      const list = history.current;
      if (staged && stagedHistory.current === staged) {
        setDeferredLatest(latest.disconnected ? latest.page : mergeLatestHistory(staged, latest.page));
        return;
      }
      if (latest.disconnected) {
        if (!followLatest.current || (list && isAwayFromLatest(list))) {
          setDeferredLatest(latest.page);
        } else {
          historyReplacement.current++;
          setDeferredLatest(undefined);
          scrolling.current = undefined;
          setPage(latest.page);
        }
        return;
      }
      setDeferredLatest(undefined);
      if (list && !scrolling.current && isAwayFromLatest(list)) {
        scrolling.current = captureHistoryScroll(list, "keep");
      }
      setPage((previous) => mergeLatestHistory(previous, latest.page));
    }).catch(() => {
      // Preserve visible topic messages on a transient refresh failure.
    });
    return () => { current = false; };
  }, [chatId, historyLoaded, liveRevision, loadTopicHistory, page?.after, topic.id]);

  function load(before?: string) {
    if (pendingRequest.current) return;
    pendingRequest.current = true;
    setPending(true);
    setError(false);
    setCursor({ before });
  }

  const before = page?.before;
  const after = page?.after;
  async function loadNewer() {
    if (!after || !loadUnreadHistory || newerPending.current || latestJumpPending.current) return;
    const replacement = historyReplacement.current;
    newerPending.current = true;
    setNewerStatus("loading");
    try {
      const next = await loadUnreadHistory(chatId, after, topic.id);
      if (!alive.current || replacement !== historyReplacement.current || shownPage.current?.after !== after) return;
      if (!next) throw new Error("Newer topic history is unavailable.");
      if (history.current) scrolling.current = captureHistoryScroll(history.current, "keep");
      setPage((previous) => previous?.after === after ? appendUnreadHistory(previous, next) : previous);
      setNewerStatus(undefined);
    } catch {
      if (alive.current && replacement === historyReplacement.current) setNewerStatus("failed");
    } finally {
      newerPending.current = false;
    }
  }
  const canLoadOlderOnScroll = before && !pending && !error && !searchMode && !original;

  async function jumpToLatest() {
    const list = history.current;
    if (!list || latestJumpPending.current) return;
    const replacement = historyReplacement.current;
    const current = () => alive.current && historyReplacement.current === replacement;
    let latest = deferredLatest;
    if (!latest && after) {
      latestJumpPending.current = true;
      setLatestJump("loading");
      const revision = currentRevision.current;
      try {
        latest = await loadTopicHistory(chatId, topic.id);
        if (!current()) return;
        seenRevision.current = revision;
      } catch {
        if (current()) setLatestJump("failed");
        return;
      } finally {
        latestJumpPending.current = false;
        if (alive.current && !current()) setLatestJump(undefined);
      }
    }
    if (!current()) return;
    setLatestJump(undefined);
    readingPlaces?.delete(readingKey);
    historyView?.forget(readingKey);
    setResumeMessage(undefined);
    if (!list.hidden && !list.contains(document.activeElement)) list.focus({ preventScroll: true });
    if (latest) {
      historyReplacement.current++;
      scrolling.current = undefined;
      setNewerStatus(undefined);
      setPage(latest);
      setDeferredLatest(undefined);
    } else list.scrollTop = list.scrollHeight;
    lastHistoryTop.current = list.scrollTop;
    followLatest.current = true;
    setAwayFromLatest(false);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement, links?: import("../core/contract.ts").EditLinks, customEmoji?: import("../core/contract.ts").EditCustomEmoji) {
    event.preventDefault();
    if (!editing || editing.busy || !messageActions || deletedIds?.has(editing.message.id)) return;
    const { message, text } = editing;
    await applyEdit(editing, () => submitMessageEdit(chatId, message, text.trim(), messageActions, styles, removeLinkPreview, placement, links, undefined, customEmoji));
  }

  async function replaceEditedPhoto(file: File) {
    const replace = messageActions?.replacePhoto;
    if (!editing || editing.busy || !replace || deletedIds?.has(editing.message.id)) return;
    await applyEdit(editing, () => replacePreparedPhoto(replace, chatId, editing.message, file));
  }

  async function replaceEditedAttachment(file: File, progress: ReplacementProgress, signal: AbortSignal) {
    const replace = messageActions?.replaceAttachment;
    const attachment = editing?.message.attachmentEdit;
    if (!editing || editing.busy || !replace || !attachment || deletedIds?.has(editing.message.id)) return;
    await applyEdit(editing, () => replace(chatId, editing.message.id, attachment, file, progress, signal));
  }

  async function applyEdit(editing: EditDraft, perform: () => Promise<AttachmentEditResult> | undefined) {
    setEditing({ ...editing, busy: true, error: undefined });
    let result: AttachmentEditResult;
    try {
      result = await (perform() ?? { state: "failed" });
    } catch { result = { state: "unknown" }; }
    if (result.state === "sent") {
      const list = history.current;
      if (list && !scrolling.current) scrolling.current = captureHistoryScroll(list, "keep");
      setPage((previous) => previous && { ...previous, messages: previous.messages.map((item) =>
        item.id === result.message.id ? { ...item, ...result.message, photoCaption: result.message.photoCaption,
          attachmentEdit: result.message.attachmentEdit, document: result.message.document,
          captionAboveMedia: result.message.captionAboveMedia,
          styles: result.message.styles, links: result.message.links, customEmoji: result.message.customEmoji, linkPreview: result.message.linkPreview } : item) });
      replaceSent(result.message);
      setEditing(undefined);
    } else {
      setEditing({ ...editing, busy: false, error: result.state === "cancelled" ? undefined : result.state === "unknown"
        ? "Telegram did not confirm the edit." : "The message changed or Telegram rejected the edit." });
    }
  }

  const byId = new Map((page?.messages ?? []).map((item) => [item.id, item]));
  for (const item of sent) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  for (const id of deletedIds ?? []) byId.delete(id);
  useHistoryMessageUpdates(chatId, topic.id, true, (id) => !!byId.get(id) && !byId.get(id)?.retained, (row) => {
    const list = history.current;
    if (list && isAwayFromLatest(list) && !scrolling.current) scrolling.current = captureHistoryScroll(list, "keep");
    setPage((previous) => previous && replaceLoadedHistoryMessage(previous, row));
    setDeferredLatest((previous) => previous && replaceLoadedHistoryMessage(previous, row));
    if (sent.some(({ id }) => id === row.id)) replaceSent(row);
  });
  const displayed = [...byId.values()];
  async function openOriginal(item: Message, id: string, trigger: HTMLElement, time?: number) {
    const quote = time === undefined ? item.replyQuoteAnchor : undefined;
    openingOriginal.current?.abort();
    if (!byId.has(id) && openExternalReply) {
      const request = new AbortController();
      openingOriginal.current = request;
      const opened = await openExternalReply({ chatId, messageId: id, ...(quote && { quote }) },
        { chatId, messageId: item.id, topicId: topic.id }, request.signal, time).catch(() => false);
      if (opened || request.signal.aborted) return;
    }
    originalTrigger.current = trigger;
    setSearchMode(undefined);
    setOriginal(id, time, quote);
  }
  const albumPhotos = photoTimeline(displayed);
  const inbox = page?.readInbox;
  const unread = page?.unreadCount ?? topic.unread;
  useVisibleHistoryRead({
    list: history, chatId, topicId: topic.id, messageIds: readableHistoryIds(page?.messages, inbox, deletedIds), mark: messageActions?.markHistoryRead,
    enabled: !original && !searchMode && !editing,
  });
  const autoplayLimits = !original && !searchMode && !editing && messageActions?.automaticPlaybackOverrides
    ? playbackLimitsForChat(chat, messageActions.automaticPlayback, messageActions.automaticPlaybackOverrides[chatId]) : undefined;
  const chatMediaOverride = messageActions?.automaticMediaOverrides?.[chatId];
  useVisibleMediaPrefetch({
    list: history, chatId, topicId: topic.id, policy: messageActions?.automaticMedia, override: chatMediaOverride, prefetch: messageActions?.prefetchVisibleMedia,
    ids: visibleMediaCandidates(chat, displayed, messageActions?.automaticMedia, chatMediaOverride),
    enabled: !original && !searchMode && !editing,
  });
  const firstUnread = unread && inbox !== undefined
    ? firstLoadedUnread(displayed, page?.messages ?? [], inbox, page?.before === null) : undefined;
  const unreadDivider = useRef<HTMLLIElement>(null);
  const unreadDividerId = useId();
  const [unreadStatus, setUnreadStatus] = useState<"loading" | "unavailable">();

  async function jumpToUnread(trigger: HTMLButtonElement) {
    const list = history.current;
    if (!list || unreadStatus === "loading") return;
    if (unreadDivider.current && firstUnread) {
      focusUnreadBoundary(list, unreadDivider.current, firstUnread);
      lastHistoryTop.current = list.scrollTop;
      followLatest.current = !page?.after && !isAwayFromLatest(list);
      return;
    }
    if (!messageActions?.loadFirstUnread) return;
    setUnreadStatus("loading");
    const id = await messageActions.loadFirstUnread(chatId, topic.id).catch(() => null);
    if (!trigger.isConnected || trigger.hidden) { setUnreadStatus(undefined); return; }
    if (id) {
      setUnreadStatus(undefined);
      originalTrigger.current = trigger;
      setOriginal(id);
    } else setUnreadStatus("unavailable");
  }

  const selection = useMessageSelection(chatId, byId, messageActions, forwardActions, !original && !searchMode, deletedIds, String(topic.id), chat?.name);
  useSwipeToReply(history, `${chatId}:${topic.id}`, !original && !searchMode && !editing && !selection.active);
  const canNavigateReply = !!chooseReply && !topic.closed && !original && !searchMode && !editing && !selection.active && !reply?.origin;
  function navigateTopicReply(event: KeyboardEvent<HTMLTextAreaElement | HTMLOListElement>) {
    return canNavigateReply && navigateReply(event, history.current, reply?.id, cancelReply);
  }

  function backOnEscape(event: KeyboardEvent) {
    const target = event.target;
    if (original || searchMode || editing || !isPlainKey(event, "Escape") || !(target instanceof HTMLElement)
      || target.closest("input:not([type=checkbox]), textarea, select, dialog, [role=dialog], [contenteditable], details[open]")) return;
    event.preventDefault();
    if (selection.cancel()) history.current?.focus({ preventScroll: true });
    else if (!selection.active) back();
  }

  return <>
    <button autoFocus type="button" className="mtg-action" aria-keyshortcuts="Escape" onKeyDown={backOnEscape} onClick={back}>{tr("Back to topics")}</button>
    <h3><TopicName topic={topic} /></h3>
    {messageActions?.subscribeToActivity &&
      <ChatActivityIndicator key={`${chatId}:${topic.id}`} chatId={chatId} topicId={topic.id} subscribe={messageActions.subscribeToActivity} />}
    {actions}
    {messageActions?.searchMessages && <>
      <button ref={searchTrigger} type="button" className="mtg-chat-search-toggle"
        aria-label={tr("Search topic messages")} aria-keyshortcuts="Alt+Shift+F Meta+F Control+F" aria-expanded={searchMode === "search"} onClick={() => {
          setOriginal(undefined);
          setSearchMode(searchMode === "search" ? undefined : "search");
        }}><Search size={17} aria-hidden="true" /></button>
      <button ref={pinnedTrigger} type="button" className="mtg-chat-search-toggle"
        title={tr("Pinned topic messages")} aria-label={tr("Pinned topic messages")} aria-expanded={searchMode === "pinned"}
        onClick={() => {
          setOriginal(undefined);
          setSearchMode(searchMode === "pinned" ? undefined : "pinned");
        }}><Pin size={17} aria-hidden="true" /></button>
    </>}
    {(original || searchMode) && <ConversationSearch key={original ?? (searchMode === "author" ? `author:${authorRevision}` : searchMode === "date" ? `date:${selectedDay}` : searchMode)} chatId={chatId} chat={chat} loadAvatar={loadAvatar}
      initialReplyPlayback={originalSelection?.playback} initialQuote={originalSelection?.quote}
      drawPhotoReply={!editing && drawPhotoReply ? {
        verify: (source) => drawPhotoReply.verify(source.id),
        async stage(source, data) {
          if (!await drawPhotoReply.stage(source, data)) return false;
          setOriginal(undefined);
          setSearchMode(undefined);
          return true;
        },
      } : undefined}
      copySelectedText={messageActions?.copySelectedText}
      loadGroupEmoji={loadGroupEmoji}
      initialMessage={original} initialDay={searchMode === "date" ? selectedDay : undefined} loadAtDate={messageActions?.loadMessageAtDate} initialAuthor={searchMode === "author" ? author : undefined} initialFilter={searchMode === "pinned" ? "pinned" : undefined} topicId={topic.id} search={messageActions?.searchMessages} loadContext={messageActions?.loadMessageContext} loadContextPage={messageActions?.loadMessageContextPage}
      markActivityRead={messageActions?.markActivityRead} bulkUnpin={messageActions?.bulkUnpin}
      pinning={messageActions?.pinStatus && messageActions.setMessagePinned
        ? { pinStatus: messageActions.pinStatus, setMessagePinned: messageActions.setMessagePinned } : undefined} unpinTopic={{ id: topic.id, name: topic.name }} mediaCollection={messageActions?.mediaCollection} saveSelectedAttachments={messageActions?.saveSelectedAttachments} messageViewers={messageActions?.messageViewers} chatReportActions={messageActions?.chatReportActions}
      loadMessageLink={loadMessageLink} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll}
      deletedIds={deletedIds} close={() => {
        setOriginal(undefined);
        setSearchMode(undefined);
        (original ? originalTrigger : searchMode === "author" ? authorTrigger : searchMode === "pinned" ? pinnedTrigger : searchMode === "date" ? dateTrigger : searchTrigger).current?.focus();
      }} />}
    {selection.start()}
    {!original && !searchMode && resumeMessage && readingPlaces?.has(readingKey) && !deletedIds?.has(resumeMessage) && (page || error)
      && (byId.has(resumeMessage) || messageActions?.loadMessageContext) && <button type="button" className="mtg-action mtg-latest"
        onClick={() => {
          setResumeMessage(undefined);
          if (byId.has(resumeMessage)) focusHistoryMessage(history.current, resumeMessage);
          else {
            originalTrigger.current = history.current;
            setOriginal(resumeMessage);
          }
        }}>{tr("Resume reading")}</button>}
    {!original && !searchMode && (after || awayFromLatest || deferredLatest) && <button type="button" className="mtg-action mtg-latest"
      aria-busy={latestJump === "loading"} aria-disabled={latestJump === "loading"}
      onClick={() => void jumpToLatest()}>{latestJump === "loading" ? tr("Loading latest topic messages…")
        : latestJump === "failed" ? tr("Retry jump to latest topic message") : tr("Jump to latest topic message")}</button>}
    {(firstUnread || !!unread && inbox !== undefined && inbox > 0
      && messageActions?.loadFirstUnread && messageActions.loadMessageContext) && <>
      <button type="button" className="mtg-action mtg-latest" hidden={!!original || !!searchMode} disabled={unreadStatus === "loading"}
        onClick={(event) => void jumpToUnread(event.currentTarget)}>{tr("Jump to unread topic messages")}</button>
      {!original && !searchMode && unreadStatus === "unavailable" && <p role="status">{tr("Telegram could not locate the first unread message in this topic.")}</p>}
    </>}
    <HistoryRemovalAnchor list={history} removed={deletedIds} followLatest={followLatest.current}
      onAdjusted={(top) => { lastHistoryTop.current = top; }}>
    <ol className="mtg-history" ref={history} aria-label={tr("Topic messages")} data-selecting={selection.active || undefined}
      data-has-newer={after || original || searchMode ? "true" : undefined}
      aria-keyshortcuts={canNavigateReply ? `Escape ${replyNavigationShortcuts}` : "Escape"} tabIndex={0}
      onDoubleClick={(event) => {
        if (!original && !searchMode && !editing && !selection.active) {
          handleMessageDoubleClick(event, messageActions?.messageDoubleClick ?? "reply");
        }
      }}
      onKeyDown={(event) => {
        if (navigateTopicReply(event)) return;
        const row = event.target instanceof HTMLElement && event.target.matches(".mtg-message[data-message-id]") ? event.target : undefined;
        if (canLoadOlderOnScroll && event.currentTarget.scrollTop <= 0 && historyPageKey(event, "up", row)) {
          event.preventDefault();
          load(before);
        } else if (after && !original && !searchMode && !newerStatus
          && !isAwayFromLatest(event.currentTarget) && historyPageKey(event, "down", row)) {
          event.preventDefault();
          void loadNewer();
        } else backOnEscape(event);
      }}
      onScroll={(event) => {
        const list = event.currentTarget;
        const downward = list.scrollTop > lastHistoryTop.current;
        if (canLoadOlderOnScroll && list.scrollTop <= 96 && list.scrollTop < lastHistoryTop.current) load(before);
        lastHistoryTop.current = list.scrollTop;
        const away = isAwayFromLatest(list);
        if (downward && !away && !original && !searchMode && !newerStatus && after) void loadNewer();
        followLatest.current = !after && !away;
        setAwayFromLatest(!followLatest.current);
        if (readingPlaces && away && page && !original && !searchMode) {
          const position = captureHistoryScroll(list, "keep");
          const { rowId } = position;
          if (rowId && /^[1-9]\d{0,15}$/.test(rowId) && !byId.get(rowId)?.pendingDelivery) {
            rememberReadingPlace(readingPlaces, chatId, rowId, topic.id);
            historyView?.remember(readingKey, deletedIds?.size ? { ...page, messages: page.messages.filter((row) => !deletedIds.has(row.id)) } : page, position);
          }
        } else if (downward && !away && page && !original && !searchMode
          && !deferredLatest && !after && readingPlaces?.delete(readingKey)) {
          historyView?.forget(readingKey);
          setResumeMessage(undefined);
        }
      }}
      onWheel={(event) => {
        const direction = historyWheelDirection(event);
        if (canLoadOlderOnScroll && event.currentTarget.scrollTop <= 0 && direction === "up") load(before);
        if (after && !original && !searchMode && !newerStatus && direction === "down"
          && !isAwayFromLatest(event.currentTarget)) void loadNewer();
      }}>
      {before && <li className="mtg-history-start">
        {!error && <button type="button" className="mtg-action" aria-disabled={pending} aria-busy={pending}
          onClick={() => load(before)}>{tr("Load earlier topic messages")}</button>}
        {pending && <span role="status" className="mtg-visually-hidden">{tr("Loading topic history…")}</span>}
      </li>}
      {pending && !before && <li role="status">{tr("Loading topic history…")}</li>}
      {error && <li role="alert">{tr("Could not load topic history. ")}<button type="button" onClick={() => load(cursor.before)}>{tr("Retry")}</button></li>}
      {page && !pending && !displayed.length && <li role="status">{tr("No messages")}</li>}
      <NotePlaybackQueueProvider key={`${chatId}:${topic.id}`} messages={displayed} enabled={!original && !searchMode}>
      {groupMessageTimeline(displayed).flatMap(({ day, group, albumKey }) => {
        const albumCaption = sharedAlbumCaption(group);
        const groupPhotos = group[0]?.albumId ? photoTimeline(group) : albumPhotos;
        const rows = group.map((item) => item.service && !item.retained
          ? <ServiceMessageRow key={item.id} message={item}
            openMessage={messageActions?.loadMessageContext && !deletedIds?.has(item.gameScoreTargetId ?? item.pinnedTargetId ?? "")
              ? (id, event) => { originalTrigger.current = event.currentTarget; setSearchMode(undefined); setOriginal(id); }
              : undefined} /> : <li key={item.id} data-message-id={item.id} tabIndex={-1} onContextMenu={openMessageMenu} onKeyDown={messageMenuKey}
          aria-describedby={item.id === firstUnread ? unreadDividerId : undefined} data-album-id={item.albumId} className={`mtg-message${item.outgoing ? " mtg-outgoing" : ""}`}
                  data-sticker={(item.collectionKind === "sticker" || item.tgsSticker) || undefined}
                  data-photo={(item.hasPhoto && !item.oneView && item.collectionKind !== "sticker" && !item.tgsSticker) || undefined}>
          {selection.checkbox(item)}
          <MessageBubble>
            {item.author && <MessageAuthor message={item} chat={chat} load={loadAvatar}
              search={messageActions?.searchMessages && !item.retained && item.sender ? (button) => {
                authorTrigger.current = button;
                setAuthor({ sender: item.sender!, name: item.author });
                setAuthorRevision((revision) => revision + 1);
                setOriginal(undefined);
                setSearchMode("author");
              } : undefined} />}
            {item.replyTo && <blockquote className="mtg-reply-quote">
              {deletedIds?.has(item.replyTo) ? tr("Original message unavailable")
                : messageActions?.loadMessageContext
                  ? <button type="button" className="mtg-open-reply" aria-label={tr("Open original message")}
                    onClick={(event) => { if (item.replyTo) void openOriginal(item, item.replyTo, event.currentTarget); }}>
                    {item.replyQuote ?? displayMessagePreview(byId.get(item.replyTo), tr) ?? tr("Earlier message")}
                  </button>
                  : item.replyQuote ?? displayMessagePreview(byId.get(item.replyTo), tr) ?? tr("Earlier message")}
            </blockquote>}
            <MessageContent conversationPhotos chatId={chatId} message={item} autoplayLimits={autoplayLimits} loadGroupEmoji={loadGroupEmoji}
              drawPhotoReply={!editing && drawPhotoReply ? {
                verify: drawPhotoReply.verify,
                async stage(id, data) {
                  const source = byId.get(id);
                  return !!source?.canSavePhoto && !source.pendingDelivery && !source.failedDelivery
                    && await drawPhotoReply.stage(source, data);
                },
              } : undefined}
              openReplyTimestamp={messageActions?.loadMessageContext && item.replyTo && !deletedIds?.has(item.replyTo)
                ? (id, time, trigger) => { void openOriginal(item, id, trigger, time); } : undefined}
              loadMessageLink={loadMessageLink} hideCaption={albumCaption?.message === item} albumPhotos={groupPhotos} openPhotoMessage={(id) => focusHistoryMessage(history.current, id)} mediaCollection={messageActions?.mediaCollection} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll} />
            <MessageFooter chatId={chatId} message={item} selectionActions={(dismiss) => selection.actionsFor(item, dismiss)} reply={!item.pendingDelivery && /^[1-9]\d{0,15}$/.test(item.id) && chooseReply && <button type="button" className="mtg-reply-action"
                  data-swipe-reply={!item.retained && !item.pendingDelivery && !item.failedDelivery && /^[1-9]\d{0,15}$/.test(item.id) ? true : undefined}
                  title={openReplyPicker ? tr("Reply (Ctrl/⌘-click to choose another chat)") : undefined}
                  onMouseDown={(event) => {
                    if (event.button === 0 && selectedReplyQuote(history.current, item)) event.preventDefault();
                  }} onClick={(event) => {
                    const selectedQuote = selectedReplyQuote(history.current, item);
                    const target = selectedQuote ? { ...item, selectedQuote } : item;
                    if (selectedQuote) event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();
                    if (openReplyPicker && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey) {
                      openReplyPicker(!selectedQuote && reply?.id === item.id && !reply.origin ? reply : target);
                      return;
                    }
                    chooseReply(target);
                  }}>{tr("Reply")}</button>}>
              <MessageViewerAction key="viewer-slot" chatId={chatId} message={item} load={messageActions?.messageViewers} loadAvatar={loadAvatar} />
              {!item.pendingDelivery && /^[1-9]\d{0,15}$/.test(item.id) && <>
                <CopyMessageReference chatId={chatId} messageId={item.id} forumTopicId={topic.id} />
                {loadMessageLink && <CopyTelegramLink chatId={chatId} messageId={item.id} load={loadMessageLink} />}
                {messageActions?.pinStatus && messageActions.setMessagePinned &&
                  <MessagePin chatId={chatId} messageId={item.id} inTopic extraMode="notify" pinStatus={messageActions.pinStatus}
                    setMessagePinned={messageActions.setMessagePinned} />}
                {messageActions?.deletionOptions && messageActions.deleteMessage &&
                  <MessageDeletion chatId={chatId} messageId={item.id} deletionOptions={messageActions.deletionOptions}
                    deleteMessage={messageActions.deleteMessage} />}
                {(messageActions?.editText && item.editable || messageActions?.editCaption && item.editableCaption) && <button type="button" className="mtg-reply-action"
                  aria-label={item.editableCaption ? tr("Edit caption") : tr("Edit message")} title={tr("Edit")} disabled={editing?.busy}
                  onClick={() => setEditing({ message: item, text: editableMessageText(item), busy: false })}><Pencil size={15} aria-hidden="true" /></button>}

              </>}
            </MessageFooter>
          </MessageBubble>
        </li>);
        const first = group[0]!;
        const unreadIndex = firstUnread ? group.findIndex(({ id }) => id === firstUnread) : -1;
        const divider = unreadIndex < 0 ? undefined : <li key={`unread:${firstUnread}`} ref={unreadDivider}
          id={unreadDividerId} className="mtg-date mtg-history-day mtg-unread-divider">{tr("Unread messages")}</li>;
        if (unreadIndex > 0 && divider) rows.splice(unreadIndex, 0, divider);
        const entry = first.albumId ? [<MessageAlbum key={albumKey} first={first} caption={albumCaption}
                messages={group} chatId={chatId} forward={forwardActions} loadMessageLink={loadMessageLink}>{rows}</MessageAlbum>] : rows;
        if (unreadIndex === 0 && divider) entry.unshift(divider);
        if (!day) return entry;
        const date = first.timestamp && localDateInputValue(first.timestamp);
        return [<li key={`day:${first.id}`} className="mtg-date mtg-history-day">
          {date && messageActions?.loadMessageAtDate && messageActions.loadMessageContext
            ? <button type="button" className="mtg-history-day-jump" aria-label={tr("Jump to date from {0}", [day])}
              onClick={(event) => {
                dateTrigger.current = event.currentTarget;
                setOriginal(undefined);
                setSelectedDay(date);
                setSearchMode("date");
              }}>{day}</button>
            : day}
        </li>, ...entry];
      })}
      </NotePlaybackQueueProvider>
      {after && <li className="mtg-history-more">
        <button type="button" className="mtg-action" disabled={newerStatus === "loading"} onClick={() => void loadNewer()}>
          {newerStatus === "loading" ? tr("Loading newer messages…") : newerStatus === "failed" ? tr("Retry newer messages") : tr("Load newer messages")}
        </button>
      </li>}
      {page && !after && !deferredLatest && !original && !searchMode && !editing && nextUnread && <li className="mtg-history-more">
        <button type="button" className="mtg-action" disabled={nextUnread.status === "loading"}
          onClick={(event) => nextUnread.open(page.unreadCount === 0 && !topic.unreadMentions && !topic.unreadReactions, event.currentTarget)}>
          {nextUnread.status === "loading" ? tr("Finding unread topics…") : nextUnread.topic
            ? <>{tr("Next unread topic · ")}<bdi>{nextUnread.topic.name}</bdi></> : tr("Find next unread topic")}
        </button>
        {!nextUnread.topic && nextUnread.status === "empty" && <p role="status">{tr("No unread topics.")}</p>}
        {nextUnread.status === "failed" && <p role="status">{tr("Could not find an unread topic. Try again.")}</p>}
      </li>}
    </ol>
    </HistoryRemovalAnchor>
    {editing && !deletedIds?.has(editing.message.id) && <MessageEdit key={editing.message.id} draft={editing}
      change={(text) => setEditing({ ...editing, text })} cancel={() => setEditing(undefined)} save={saveEdit}
      groupEmoji={loadGroupEmoji ? { id: chatId, load: loadGroupEmoji } : undefined}
      replacePhoto={messageActions?.replacePhoto && editing.message.photoEditRevision ? replaceEditedPhoto : undefined}
      replaceAttachment={messageActions?.replaceAttachment && editing.message.attachmentEdit ? replaceEditedAttachment : undefined} />}
    {selection.toolbar}
    {!selection.active && composer?.(() => {
      if (!messageActions || editing || original || searchMode) return false;
      const item = lastEditableMessage(displayed, messageActions);
      if (!item) return false;
      setEditing({ message: item, text: editableMessageText(item), busy: false });
      return true;
    }, canNavigateReply ? navigateTopicReply : undefined)}
  </>;
}
