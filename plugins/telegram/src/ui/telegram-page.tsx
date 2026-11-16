import { SharedFolderInvite, type ImportFolderInvite } from "./shared-folder-invite.tsx";
import { folderColors } from "./folder-colors.ts";
import { LinkPreviewControls, linkPreviewDelivery, type LinkPreviewChoice } from "./link-preview-controls.tsx";
import { ServiceMessageRow } from "./service-message.tsx";
import { submitComposerOnEnter } from "./composer-keys.ts";
import { ChannelDiscussion, type ChannelDiscussionLoader } from "./channel-discussion.tsx";
import { SenderBlockSettings, type SenderBlockActions } from "./sender-block-settings.tsx";
import { ContactEditor, type ContactEditorActions } from "./contact-editor.tsx";
import { ContactResults, type ContactActions } from "./contact-results.tsx";
import { ChatEvents, type ChatEventLoader } from "./chat-events.tsx";
import { ChannelSignaturesPanel, type ChannelSignatureActions } from "./channel-signatures.tsx";
import { ChatInfoPanel, type ChatInfoActions } from "./chat-info.tsx";
import { AutoDeleteTimer, type AutoDeleteActions } from "./default-auto-delete.tsx";
import { GroupSlowMode, type SlowModeActions } from "./group-slow-mode.tsx";
import { GroupPermissions, type GroupPermissionActions } from "./group-permissions.tsx";
import { ChatJoinRequests, type JoinRequestActions } from "./chat-join-requests.tsx";
import { ChatInvites, type ChatInviteActions } from "./chat-invites.tsx";
import { ChatMembers, type ChatMemberLoader } from "./chat-members.tsx";
import { FolderNavigation } from "./folder-navigation.tsx";
import { ChatFolderMemberships, FolderSettings, type FolderActions } from "./folder-settings.tsx";
import { ScheduledMessages } from "./scheduled-messages.tsx";
import { MediaSendControls } from "./media-send-controls.tsx";
import type { CaptionPlacement, MediaSendOptions, MediaReply, ReplyQuote, StyledRange, TextDelivery } from "../core/contract.ts";
import { GlobalSearchResults, type GlobalSearchLoader } from "./global-search.tsx";
import type { GlobalSearchMode, MessageSearchFilter } from "../core/contract.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { Archive, ArrowLeft, Bookmark, Camera, Check, CheckCheck, Folder, Heart, List, MessageCircle, Paperclip, Pencil, Reply, Search, Send, X } from "lucide-react";
import { fillHistoryGap, mergeLatestHistory } from "../core/history-refresh.ts";
import { isTelegramFolderInviteLink, isTelegramInviteLink, isTelegramMessageLink, telegramStickerPackName } from "../core/public-chat-reference.ts";
import { hasWebLink } from "../core/message-links.ts";
import { previewMessageText } from "../core/message-spoilers.ts";
import { maxTelegramUploadBytes } from "../core/contract.ts";
import type { ChatJoinResult, ChatList, DocumentSender, ForumTopic, ForumTopicTarget, HistoryPage, FolderInvite, InvitePreview, InviteTarget, LinkedTelegramMessage, MessagesDeleted, PollSender, PostingPermissions, SendResult, TelegramFolder, PhotoSize, TelegramPhoto, UploadRejection } from "../core/contract.ts";
import { ChatNotifications, type ChatNotificationActions } from "./chat-notifications.tsx";
import { ChatPin, type ChatPinActions } from "./chat-pin.tsx";
import { ChatDetails } from "./chat-details.tsx";
import { CopyMessageReference, CopyRecipientReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { ChannelViewCount } from "./channel-view-count.tsx";
import { MessageViewers, type MessageViewerLoader } from "./message-viewers.tsx";
import { ReadTimeButton, type ReadTimeLoader } from "./message-read-time.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { MessageEdit, editableMessageText, submitMessageEdit, type EditCaption, type EditText } from "./message-edit.tsx";
import { SelectReplyQuote } from "./select-reply-quote.tsx";
import { MessagePin, type MessagePinActions } from "./message-pin.tsx";
import { Avatar, MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import type { ForwardActions } from "./message-forward.tsx";
import { PollComposer } from "./poll-composer.tsx";
import { MediaComposer, type ComposerMediaActions } from "./media-composer.tsx";
import { PlaybackHistoryProvider } from "./media-player.tsx";
import { MessageAlbum, sharedAlbumCaption } from "./message-album.tsx";
import { groupMessageTimeline, localDateInputValue } from "../core/message-timeline.ts";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import { MessageContent, StickerPackPreview, type MediaCollectionActions } from "./message-content.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { ForumTopics, type ManageForumTopic, type ForumActions } from "./forum-topics.tsx";
import { ConversationSearch, type AuthorFilter } from "./conversation-search.tsx";
import { chats as demoChats, type Chat, type Message } from "../core/demo.ts";

function isAwayFromLatest(list: HTMLElement) {
  return list.scrollHeight - list.clientHeight - list.scrollTop > 64;
}

type Attachment = { kind: "photo"; name: string; data: string; options?: MediaSendOptions } | { kind: "document" | "video"; name: string; file: File; options?: MediaSendOptions };

import type { MessageNotification, StickerPackPreviewData } from "../core/contract.ts";
import { MessageNotificationBanner } from "./message-notification-banner.tsx";

type Live = Partial<Pick<ForwardActions, "forwardOptions" | "forwardMessage"> & ChatNotificationActions & ChatPinActions & MessageDeletionActions & MessagePinActions & ForumActions> & {
  markActivityRead?: ComponentProps<typeof ConversationSearch>["markActivityRead"];
  loadMessageContextPage?: ComponentProps<typeof ConversationSearch>["loadContextPage"];
  loadMessageAtDate?: ComponentProps<typeof ConversationSearch>["loadAtDate"];
  messageReadTime?: ReadTimeLoader;
  messageViewers?: MessageViewerLoader;
  chats: Chat[];
  list: ChatList;
  folders: TelegramFolder[];
  selectList: (list: ChatList) => void;
  loading: boolean;
  loadingMore?: boolean;
  loadMore?: () => Promise<void>;
  liveRevision: number;
  agentAccess?: ReactNode;
  loadLinkedStickerPack?: (url: string, offset?: number) => Promise<StickerPackPreviewData | null>;
  installLinkedStickerPack?: (url: string, packId: string) => Promise<"installed" | "unavailable" | "unknown">;
  mediaCollection?: MediaCollectionActions;
  messageNotification?: MessageNotification;
  loadNotificationChat?: (id: string) => Promise<Chat | null>;
  dismissMessageNotification?: () => void;
  settings?: ReactNode | ((openChat: (chat: Chat) => void) => ReactNode);
  chatAgentAccess?: (id: string) => Promise<boolean>;
  setChatAgentAccess?: (id: string, enabled: boolean) => Promise<boolean>;
  error: string;
  previewFolderInvite?: (url: string) => Promise<FolderInvite | null>;
  importFolderInvite?: ImportFolderInvite;
  previewInvite?: (url: string) => Promise<InvitePreview | null>;
  joinInvite?: (url: string, expected: InviteTarget) => Promise<ChatJoinResult>;
  joinChat?: (id: string, name: string) => Promise<ChatJoinResult>;
  postingPermissions?: (id: string) => Promise<PostingPermissions>;
  archiveChat?: (id: string, archived: boolean) => Promise<Chat>;
  markChat?: (id: string, unread: boolean) => Promise<Chat>;
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument?: (id: string, messageId: string) => Promise<boolean>;
  loadAvatar?: AvatarLoader;
  loadPhoto?: (id: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
  subscribeToDeletions?: (listener: (event: MessagesDeleted) => void) => () => void;
  loadPinned?: (id: string) => Promise<Message | null>;
  loadHistory: (id: string, before?: string) => Promise<HistoryPage>;
  resolveMessageLink?: (url: string) => Promise<LinkedTelegramMessage | null>;
  senderBlockActions?: SenderBlockActions;
  contactEditor?: ContactEditorActions;
  contactsRevision?: number;
  contactActions?: ContactActions;
  globalSearch?: GlobalSearchLoader;
  folderActions?: FolderActions;
  loadForumTopicPage?: ComponentProps<typeof ForumTopics>["loadTopicPage"];
  manageForumTopic?: ManageForumTopic;
  findChats: (query: string, list: ChatList) => Promise<Chat[]>;
  sendPoll?: PollSender;
  mediaComposer?: (id: string, topic?: ForumTopicTarget, reply?: MediaReply) => ComposerMediaActions;
  sendDocument?: DocumentSender;
  sendPhoto?: ComponentProps<typeof ForumTopics>["sendPhoto"];
  sendText: (id: string, text: string, replyTo?: string, delivery?: TextDelivery) => Promise<SendResult>;
  sendChannelComment?: ComponentProps<typeof ChannelDiscussion>["send"];
  loadChannelDiscussion?: ChannelDiscussionLoader;
  loadChatEvents?: ChatEventLoader;
  channelSignatureActions?: ChannelSignatureActions;
  chatInfoActions?: ChatInfoActions;
  loadChatAutoDelete?: (id: string) => ReturnType<AutoDeleteActions["load"]>;
  saveChatAutoDelete?: (id: string, days: number, expected: number) => ReturnType<AutoDeleteActions["save"]>;
  slowModeActions?: SlowModeActions;
  groupPermissionActions?: GroupPermissionActions;
  joinRequestActions?: JoinRequestActions;
  chatInviteActions?: ChatInviteActions;
  loadChatMembers?: ChatMemberLoader;
  loadTopicDraft?: ComponentProps<typeof ForumTopics>["loadTopicDraft"];
  saveChatDraft?: (id: string, text: string, expected: string | null, topicId?: number) => Promise<"saved" | "changed" | "unsupported">;
  canScheduleRepeats?: ComponentProps<typeof ScheduledMessages>["checkRepeat"];
  canScheduleWhenOnline?: ComponentProps<typeof ScheduledMessages>["checkOnline"];
  scheduledMessages?: ComponentProps<typeof ScheduledMessages>["load"];
  changeScheduledMessage?: ComponentProps<typeof ScheduledMessages>["change"];
  cancelScheduledMessage?: ComponentProps<typeof ScheduledMessages>["cancel"];
  loadMessageLink?: MessageLinkLoader;
  loadMessageContext?: (id: string, messageId: string, topicId?: number) => Promise<Message[]>;
  searchMessages?: ComponentProps<typeof ConversationSearch>["search"];
  editText?: EditText;
  editCaption?: EditCaption;
  refresh: () => void;
};

export function TelegramPage({ live }: { live?: Live } = {}) {
  const [results, setResults] = useState<{ query: string; list: ChatList; chats: Chat[]; invite?: InvitePreview; folderInvite?: FolderInvite; stickerPack?: StickerPackPreviewData; linked?: LinkedTelegramMessage; error?: string }>();
  const findChats = live?.findChats;
  const [searchMode, setSearchMode] = useState<"chats" | "contacts" | GlobalSearchMode>("chats");
  const globalMode = live?.globalSearch && live.list === "main" && (searchMode === "messages" || searchMode === "public") ? searchMode : undefined;
  const contactsMode = live?.contactActions && live.list === "main" && searchMode === "contacts";
  const previewInvite = live?.previewInvite;
  const previewFolderInvite = live?.previewFolderInvite;
  const loadLinkedStickerPack = live?.loadLinkedStickerPack;
  const resolveMessageLink = live?.resolveMessageLink;
  const subscribeToDeletions = live?.subscribeToDeletions;
  const [deletions, setDeletions] = useState<{ id: string; ids: Set<string>; retained: Map<string, Message> }>();
  const loadPinned = live?.loadPinned;
  const [pinned, setPinned] = useState<{ id: string; message: Message | null }>();
  const loadHistory = live?.loadHistory;
  const liveRevision = live?.liveRevision;
  const seenRevision = useRef(liveRevision);
  const [remote, setRemote] = useState<{ id: string; page?: HistoryPage; error?: string }>();
  const renderedHistory = useRef<typeof remote>(undefined);
  const [olderError, setOlderError] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const generation = useRef(0);
  const olderPending = useRef(false);
  const scrollAnchor = useRef<{ id: string; height: number; top: number; mode: "prepend" | "keep"; row?: HTMLElement; rowTop?: number } | undefined>(undefined);
  const scrollChat = useRef<string | undefined>(undefined);
  const followLatest = useRef(true);
  const lastHistoryTop = useRef(0);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [folder, setFolder] = useState<"all" | "work">("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedChat, setSelectedChat] = useState<Chat>();
  const [archiveStatus, setArchiveStatus] = useState<Record<string, "busy" | "failed" | undefined>>({});
  const activeArchive = useRef(new Set<string>());
  const [activeId, setActiveId] = useState(live ? "" : demoChats[0]!.id);
  const [showConversation, setShowConversation] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [linkPreviews, setLinkPreviews] = useState<Record<string, LinkPreviewChoice | undefined>>({});
  const marking = useRef(new Set<string>());
  const [markStatus, setMarkStatus] = useState<Record<string, "busy" | "failed" | undefined>>({});
  const [searchView, setSearchView] = useState<{ chatId: string; messageId?: string; day?: string; topicId?: number; filter?: MessageSearchFilter; author?: AuthorFilter; revision?: number }>();
  const searching = searchView?.chatId === activeId;
  const [forumView, setForumView] = useState<string>();
  const [forum, setForum] = useState<{ chatId: string; topics: ForumTopic[] | null }>();
  const topicsOpen = forumView === activeId;
  const [discussion, setDiscussion] = useState<{ chatId: string; postId: string }>();
  const activeDiscussion = discussion?.chatId === activeId ? discussion : undefined;
  const overlayOpen = searching || topicsOpen || !!activeDiscussion;
  const [editing, setEditing] = useState<{ chat: string; message: Message; text: string; busy: boolean; error?: string }>();
  const [joinStatus, setJoinStatus] = useState<Record<string, ChatJoinResult | "joining" | undefined>>({});
  const [posting, setPosting] = useState<{ id: string; permissions: PostingPermissions | null }>();
  const [attachments, setAttachments] = useState<Record<string, Attachment | undefined>>({});
  const [attachmentStatus, setAttachmentStatus] = useState<Record<string, { preparing?: boolean; error?: string } | undefined>>({});
  const preparingAttachments = useRef(new Map<string, symbol>());
  const fileInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [replyTargets, setReplyTargets] = useState<Record<string, (Message & { selectedQuote?: ReplyQuote }) | undefined>>({});
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [sent, setSent] = useState<Record<string, Message[]>>({});
  const sending = useRef(new Set<string>());
  const uploadControls = useRef(new Map<string, { controller: AbortController; canCancel: boolean }>());
  const [uploadProgress, setUploadProgress] = useState<Record<string, { uploaded: number; total: number; canCancel: boolean } | undefined>>({});
  const [uploadRejections, setUploadRejections] = useState<Record<string, UploadRejection | undefined>>({});
  const [sendStatus, setSendStatus] = useState<Record<string, "pending" | "failed" | "unknown" | "cancelled">>({});
  const chatRows = useRef<HTMLUListElement>(null);
  const moreChats = useRef<HTMLLIElement>(null);
  const history = useRef<HTMLOListElement>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const autoPagination = typeof IntersectionObserver === "function";
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const chatList = live?.list;
  const forwardActions = live?.forwardOptions && live.forwardMessage ? {
    forwardOptions: live.forwardOptions, forwardMessage: live.forwardMessage,
    recipients: live.chats, loadTopics: live.loadForumTopics, searchRecipients: (query: string) => live.findChats(query, "main"),
  } : undefined;
  const remoteQuery = !globalMode && !contactsMode && chatList !== undefined && chatList !== "saved" && query.trim().length >= 2 ? query.trim() : "";
  const matched = results?.query === remoteQuery && results.list === chatList ? results : undefined;
  const chats = remoteQuery ? matched?.chats ?? [] : live?.chats ?? demoChats;
  const active = chats.find((chat) => chat.id === activeId) ?? (selectedChat?.id === activeId ? selectedChat : undefined);
  const loadChatAutoDelete = live?.loadChatAutoDelete;
  const saveChatAutoDelete = live?.saveChatAutoDelete;
  const chatAutoDeleteActions = useMemo<AutoDeleteActions | undefined>(() => loadChatAutoDelete && saveChatAutoDelete ? {
    load: () => loadChatAutoDelete(activeId),
    save: (days, expected) => saveChatAutoDelete(activeId, days, expected),
  } : undefined, [activeId, loadChatAutoDelete, saveChatAutoDelete]);
  const loadForumTopics = live?.loadForumTopics;
  const loadTopicHistory = live?.loadTopicHistory;
  const forumChatId = active?.subtitle === "Group" && loadTopicHistory ? active.id : undefined;
  const topics = forum?.chatId === activeId ? forum?.topics : undefined;
  const checkPosting = live?.postingPermissions;
  const restrictedChat = active && checkPosting && (active.subtitle === "Channel" || active.subtitle === "Group") ? active.id : undefined;
  const permissions = posting?.id === restrictedChat ? posting?.permissions : undefined;
  const canSendText = !restrictedChat || permissions?.text === true;
  const canAttachPhoto = !!live?.sendPhoto && (!restrictedChat || permissions?.photo === true);
  const sendPoll = permissions?.poll === true ? live?.sendPoll : undefined;
  const canAttachDocument = !!live?.sendDocument && (!restrictedChat || permissions?.document === true);
  const canAttachVideo = !!live?.sendDocument && (!restrictedChat || permissions?.video === true);
  const canCompose = canSendText || canAttachPhoto || canAttachDocument || canAttachVideo;
  const deletedIds = deletions?.id === activeId ? deletions.ids : undefined;
  const pinnedMessage = pinned?.id === activeId ? pinned.message : undefined;
  const pinnedText = live
    ? pinnedMessage && !deletedIds?.has(pinnedMessage.id) && previewMessageText(pinnedMessage)
    : active?.pinned;
  const selectedHistory = remote?.id === activeId ? remote : undefined;
  const readOutbox = live?.list === "saved" ? undefined : selectedHistory?.page?.readOutbox;
  const loadedMessages = live ? selectedHistory?.page?.messages ?? [] : active?.messages ?? [];
  const byId = new Map(loadedMessages.map((message) => [message.id, message]));
  if (deletions?.id === activeId) for (const [id, row] of deletions.retained) {
    if (byId.has(id)) byId.set(id, row);
  }
  for (const message of sent[activeId] ?? []) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  const messages = [...byId.values()].filter(({ id }) => !deletedIds?.has(id));
  const savedDraft = selectedHistory?.page?.draft;
  const draftSyncBusy = useRef(new Set<string>());
  const [draftSyncStatus, setDraftSyncStatus] = useState<Record<string, string>>({});
  const draft = drafts[activeId] ?? "";
  const formatting = useDraftFormatting(activeId, draft, draftInput);
  const sendStyles = formatting.deliveryStyles;
  const previewAvailable = !!live && hasWebLink(draft);
  const previewPlacement = previewAvailable ? linkPreviews[activeId] : undefined;
  const attachment = attachments[activeId];
  const currentAttachmentStatus = attachmentStatus[activeId];
  const uploading = uploadProgress[activeId];
  const canSendAttachment = attachment?.kind === "photo" ? canAttachPhoto : attachment?.kind === "video" ? canAttachVideo : canAttachDocument;
  const edit = editing?.chat === activeId ? editing : undefined;
  const replyTarget = replyTargets[activeId];
  const replyDeleted = replyTarget && deletedIds?.has(replyTarget.id);
  const search = query.trim().toLocaleLowerCase();
  const visible = chats.filter((chat) => {
    if (matched?.linked) return true;
    if (live && kind !== "all" && chat.subtitle !== kind) return false;
    if (folder === "work" && !chat.work) return false;
    if (remoteQuery) return true;
    return [chat.name, ...chat.messages.map((message) => previewMessageText(message) ?? ""), ...(sent[chat.id] ?? []).map((message) => previewMessageText(message) ?? "")]
      .some((text) => text.toLocaleLowerCase().includes(search));
  });

  useEffect(() => {
    if (!forumChatId || !loadForumTopics) return;
    let current = true;
    void loadForumTopics(forumChatId, "").then(
      (topics) => { if (current) setForum({ chatId: forumChatId, topics }); },
      () => { if (current) setForum({ chatId: forumChatId, topics: null }); },
    );
    return () => { current = false; };
  }, [forumChatId, loadForumTopics]);

  useEffect(() => {
    if (!restrictedChat || !checkPosting) return;
    let current = true;
    void checkPosting(restrictedChat).then(
      (permissions) => { if (current) setPosting({ id: restrictedChat, permissions }); },
      () => { if (current) setPosting({ id: restrictedChat, permissions: null }); },
    );
    return () => { current = false; };
  }, [restrictedChat, checkPosting, liveRevision]);

  useEffect(() => {
    setDeletions(undefined);
    return subscribeToDeletions?.(({ id, messageIds, retained }) => {
      const removed = new Set(messageIds);
      setSent((previous) => previous[id]?.some((message) => removed.has(message.id))
        ? { ...previous, [id]: previous[id]!.filter((message) => !removed.has(message.id)) }
        : previous);
      setEditing((previous) => previous?.chat === id && removed.has(previous.message.id) ? undefined : previous);
      if (id !== activeId) return;
      const list = history.current;
      if (list && isAwayFromLatest(list)) {
        const affected = new Set([...removed, ...(retained ?? []).map((row) => row.id)]);
        const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"));
        if (rows.some((row) => affected.has(row.dataset.messageId ?? ""))) {
          const top = list.getBoundingClientRect().top;
          const row = rows.find((item) => !removed.has(item.dataset.messageId ?? "") && item.getBoundingClientRect().bottom > top);
          scrollAnchor.current = { id, height: list.scrollHeight, top: list.scrollTop, mode: "keep",
            row, rowTop: row?.getBoundingClientRect().top };
        }
      }
      setDeletions((previous) => ({
        id, ids: new Set([...(previous?.ids ?? []), ...removed]),
        retained: new Map([...(previous?.retained ?? []), ...(retained ?? []).map((row) => [row.id, row] as const)]),
      }));
    });
  }, [activeId, subscribeToDeletions]);

  useEffect(() => {
    if (!loadPinned || !activeId || !showConversation) return;
    let current = true;
    void loadPinned(activeId).then(
      (message) => { if (current) setPinned({ id: activeId, message }); },
      () => {},
    );
    return () => { current = false; };
  }, [activeId, liveRevision, loadPinned, showConversation]);

  useLayoutEffect(() => {
    const list = history.current;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = undefined;
    if (!list || list.hidden) return;
    if (anchor?.id === activeId) {
      const shift = anchor.row && list.contains(anchor.row) && anchor.rowTop !== undefined
        ? anchor.row.getBoundingClientRect().top - anchor.rowTop
        : anchor.mode === "prepend" ? list.scrollHeight - anchor.height : 0;
      list.scrollTop = Math.max(0, anchor.top + shift);
    } else if (scrollChat.current !== activeId || followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
    scrollChat.current = activeId;
    lastHistoryTop.current = list.scrollTop;
    followLatest.current = !isAwayFromLatest(list);
    setAwayFromLatest(!followLatest.current);
  }, [activeId, messages.length, selectedHistory?.page, deletedIds, showConversation]);

  useLayoutEffect(() => {
    const list = history.current;
    if (!list || !showConversation || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (list.hidden || scrollChat.current !== activeId || !followLatest.current) return;
      list.scrollTop = list.scrollHeight;
      lastHistoryTop.current = list.scrollTop;
    });
    observer.observe(list);
    for (const row of Array.from(list.children)) observer.observe(row);
    return () => observer.disconnect();
  }, [activeId, messages.length, selectedHistory?.page, deletedIds, showConversation]);

  useEffect(() => {
    const request = ++generation.current;
    olderPending.current = false;
    setOlderLoading(false);
    setOlderError(false);
    if (!loadHistory || !activeId) return;
    setRemote({ id: activeId });
    void loadHistory(activeId).then(
      (page) => {
        if (generation.current === request) {
          setRemote((previous) => previous?.id === activeId && previous.page ? previous : { id: activeId, page });
        }
      },
      () => {
        if (generation.current === request) {
          setRemote((previous) => previous?.id === activeId && previous.page
            ? previous : { id: activeId, error: "Could not load this conversation." });
        }
      },
    );
    return () => { generation.current++; };
  }, [activeId, loadHistory, historyAttempt]);

  useLayoutEffect(() => { renderedHistory.current = remote; }, [remote]);

  useEffect(() => {
    const changed = seenRevision.current !== liveRevision;
    seenRevision.current = liveRevision;
    if (!changed || !loadHistory || !activeId || !showConversation) return;
    const request = generation.current;
    let current = true;
    const isCurrent = () => current && generation.current === request;
    void loadHistory(activeId).then(async (page) => {
      if (!isCurrent()) return;
      const previous = renderedHistory.current;
      const newestLoaded = previous?.id === activeId ? Number(previous.page?.messages.at(-1)?.id) : NaN;
      const latest = await fillHistoryGap(page, newestLoaded, (before) => loadHistory(activeId, before), isCurrent);
      if (!latest || !isCurrent()) return;
      const list = history.current;
      if (list && isAwayFromLatest(list)) {
        scrollAnchor.current = { id: activeId, height: list.scrollHeight, top: list.scrollTop, mode: "keep" };
      }
      setRemote((previous) => ({
        id: activeId, page: mergeLatestHistory(previous?.id === activeId ? previous.page : undefined, latest),
      }));
    }).catch(() => {
      // Keep the current history available when a live refresh fails.
    });
    return () => { current = false; };
  }, [activeId, liveRevision, loadHistory, showConversation]);

  useEffect(() => {
    if (!findChats || !remoteQuery || chatList === undefined) return;
    let current = true;
    const timer = setTimeout(() => {
      const result = chatList === "main" && loadLinkedStickerPack && telegramStickerPackName(remoteQuery)
        ? loadLinkedStickerPack(remoteQuery).then((stickerPack) => stickerPack ? { chats: [], stickerPack }
          : { chats: [], error: "This Telegram sticker pack is unavailable." })
        : chatList === "main" && previewFolderInvite && isTelegramFolderInviteLink(remoteQuery)
        ? previewFolderInvite(remoteQuery).then((folderInvite) => folderInvite ? { chats: [], folderInvite }
          : { chats: [], error: "This shared Telegram folder is unavailable." })
        : chatList === "main" && previewInvite && isTelegramInviteLink(remoteQuery)
        ? previewInvite(remoteQuery).then((invite) => invite ? { chats: [], invite }
          : { chats: [], error: "This Telegram invitation is unavailable." })
        : chatList === "main" && resolveMessageLink && isTelegramMessageLink(remoteQuery)
        ? resolveMessageLink(remoteQuery).then((linked) => linked ? { chats: [linked.chat], linked }
          : { chats: [], error: "This Telegram message is unavailable." })
        : findChats(remoteQuery, chatList).then((chats) => ({ chats }));
      void result.then(
        (payload) => { if (current) setResults({ query: remoteQuery, list: chatList, ...payload }); },
        () => { if (current) setResults({ query: remoteQuery, list: chatList, chats: [], error: "Telegram search failed." }); },
      );
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [chatList, findChats, loadLinkedStickerPack, previewFolderInvite, previewInvite, remoteQuery, resolveMessageLink]);

  const before = selectedHistory?.page?.before;
  const loadOlder = useCallback(async () => {
    if (!loadHistory || !before || olderPending.current) return;
    const request = generation.current;
    olderPending.current = true;
    setOlderLoading(true);
    setOlderError(false);
    try {
      const page = await loadHistory(activeId, before);
      if (generation.current !== request) return;
      const list = history.current;
      if (list) {
        const top = list.getBoundingClientRect().top;
        const row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"))
          .find((item) => item.getBoundingClientRect().bottom > top);
        scrollAnchor.current = { id: activeId, height: list.scrollHeight, top: list.scrollTop, mode: "prepend",
          row, rowTop: row?.getBoundingClientRect().top };
      }
      setRemote((previous) => {
        if (previous?.id !== activeId || previous.page?.before !== before) return previous;
        const existing = new Set(previous.page.messages.map(({ id }) => id));
        const older = page.messages.filter(({ id }) => !existing.has(id));
        return { id: activeId, page: { ...previous.page, messages: [...older, ...previous.page.messages], before: page.before } };
      });
    } catch {
      if (generation.current === request) setOlderError(true);
    } finally {
      if (generation.current === request) {
        olderPending.current = false;
        setOlderLoading(false);
      }
    }
  }, [activeId, before, loadHistory]);

  const canLoadOlderOnScroll = before && !overlayOpen && !olderError && !olderLoading;

  const loadMoreChats = live?.loadMore;
  const canLoadMore = !remoteQuery && !live?.loading && !live?.loadingMore;
  const chatLoadError = live?.error;
  useEffect(() => {
    const root = chatRows.current;
    const target = moreChats.current;
    if (!autoPagination || !root || !target || !loadMoreChats || !canLoadMore || chatLoadError) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) return;
      observer.disconnect();
      void loadMoreChats();
    }, { root });
    observer.observe(target);
    return () => observer.disconnect();
  }, [autoPagination, canLoadMore, chatLoadError, loadMoreChats, visible.length]);

  function switchList(next: ChatList) {
    if (!live || live.list === next) return;
    setSearchView(undefined);
    setForumView(undefined);
    setDiscussion(undefined);
    setSelectedChat(undefined);
    setActiveId("");
    setShowConversation(false);
    setKind("all");
    setSearchMode("chats");
    setQuery("");
    live.selectList(next);
  }

  function openConversation(chat: Chat) {
    setSearchView(undefined);
    setForumView(undefined);
    setDiscussion(undefined);
    setSelectedChat(chat);
    setActiveId(chat.id);
    setShowConversation(true);
    requestAnimationFrame(() => heading.current?.focus());
  }

  const listTitle = live
    ? live.list === "main" ? "All Chats" : live.list === "archive" ? "Archive" : live.list === "saved" ? "Saved Messages" : live.folders.find(({ id }) => id === live.list)?.title ?? "Folder"
    : folder === "all" ? "All Chats" : "Work";

  function changeDraft(value: string) {
    formatting.change(value);
    setDrafts((previous) => ({ ...previous, [activeId]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preparingAttachments.current.has(activeId) || replyDeleted) return;
    if (attachment ? !canSendAttachment : !canSendText) return;
    const value = draft.trim();
    if (!value && !attachment) return;
    if (live) {
      if (active && (!attachment || value.length <= 1024)) void sendLive(live, active.id, value, replyTarget?.id, attachment);
      return;
    }
    const message: Message = {
      id: `local-${messages.length}`,
      author: "You",
      time: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date()),
      text: value,
      outgoing: true,
    };
    setSent((previous) => ({ ...previous, [activeId]: [...(previous[activeId] ?? []), message] }));
    setDrafts((previous) => ({ ...previous, [activeId]: "" }));
  }

  async function joinActive(chat: Chat) {
    if (!live?.joinChat || !permissions?.join || joinStatus[chat.id] === "joining") return;
    setJoinStatus((previous) => ({ ...previous, [chat.id]: "joining" }));
    const result = await live.joinChat(chat.id, chat.name).catch(() => "unknown" as const);
    setJoinStatus((previous) => ({ ...previous, [chat.id]: result }));
    if (result === "joined") live.refresh();
  }

  async function moveActive(chat: Chat) {
    if (!live?.archiveChat || chat.archived === undefined || activeArchive.current.has(chat.id)) return;
    const id = chat.id;
    activeArchive.current.add(id);
    setArchiveStatus((previous) => ({ ...previous, [id]: "busy" }));
    try {
      const updated = await live.archiveChat(id, !chat.archived);
      setSelectedChat((previous) => previous?.id === id ? updated : previous);
      setResults((previous) => previous ? { ...previous, chats: previous.chats.map((entry) => entry.id === id ? updated : entry) } : previous);
      setArchiveStatus((previous) => ({ ...previous, [id]: undefined }));
    } catch {
      setArchiveStatus((previous) => ({ ...previous, [id]: "failed" }));
    } finally {
      activeArchive.current.delete(id);
    }
  }

  async function markActive(chat: Chat) {
    if (!live?.markChat || marking.current.has(chat.id)) return;
    const id = chat.id;
    marking.current.add(id);
    setMarkStatus((previous) => ({ ...previous, [id]: "busy" }));
    try {
      const updated = await live.markChat(id, !(chat.unread || chat.markedUnread));
      setResults((previous) => previous ? { ...previous, chats: previous.chats.map((entry) => entry.id === id
        ? { ...entry, unread: updated.unread, markedUnread: updated.markedUnread } : entry) } : previous);
      setMarkStatus((previous) => ({ ...previous, [id]: undefined }));
    } catch {
      setMarkStatus((previous) => ({ ...previous, [id]: "failed" }));
    } finally {
      marking.current.delete(id);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement) {
    event.preventDefault();
    if (!edit || edit.busy || !live) return;
    const text = edit.text.trim();
    setEditing({ ...edit, busy: true, error: undefined });
    let result: SendResult;
    try {
      result = await (submitMessageEdit(edit.chat, edit.message, text, live, styles, removeLinkPreview, placement) ?? { state: "failed" });
    }
    catch { result = { state: "unknown" }; }
    if (result.state === "sent") {
      const updated = result.message;
      setRemote((previous) => previous?.id === edit.chat && previous.page
        ? { ...previous, page: { ...previous.page, messages: previous.page.messages.map((item) => item.id === updated.id ? updated : item) } }
        : previous);
      setSent((previous) => ({ ...previous, [edit.chat]: (previous[edit.chat] ?? []).map((item) => item.id === updated.id ? updated : item) }));
      setEditing((previous) => previous?.chat === edit.chat && previous.message.id === edit.message.id ? undefined : previous);
    } else {
      const error = result.state === "unknown" ? "Telegram did not confirm the edit." : "The message changed or Telegram rejected the edit.";
      setEditing((previous) => previous?.chat === edit.chat && previous.message.id === edit.message.id
        ? { ...previous, busy: false, error } : previous);
    }
  }

  async function chooseAttachment(file: File | undefined, id: string, kind: Attachment["kind"]) {
    if (!file || !id || replyTargets[id]?.selectedQuote) return;
    preparingAttachments.current.delete(id);
    const updateStatus = (value: typeof currentAttachmentStatus) =>
      setAttachmentStatus((previous) => ({ ...previous, [id]: value }));
    updateStatus(undefined);
    if (kind !== "photo") {
      if (!file.size || file.size > maxTelegramUploadBytes || (kind === "video" && !/\.mp4$/i.test(file.name))) {
        updateStatus({ error: kind === "video" ? "Choose a non-empty MP4 video up to 4000 MiB." : "Choose a non-empty document up to 4000 MiB." });
        return;
      }
      setAttachments((previous) => ({ ...previous, [id]: { kind, name: file.name, file } }));
      return;
    }
    if (!isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes) {
      updateStatus({ error: "Choose a non-empty JPEG, PNG, or WebP photo up to 64 MiB. Use Attach document to send the original." });
      return;
    }
    const request = Symbol();
    preparingAttachments.current.set(id, request);
    updateStatus({ preparing: true });
    try {
      const data = await preparePhoto(file);
      if (preparingAttachments.current.get(id) !== request) return;
      setAttachments((previous) => ({ ...previous, [id]: { kind, name: file.name.slice(0, 255), data } }));
      updateStatus(undefined);
    } catch {
      if (preparingAttachments.current.get(id) === request) {
        updateStatus({ error: "Could not prepare this JPEG. Use Attach document to send the original." });
      }
    } finally {
      if (preparingAttachments.current.get(id) === request) preparingAttachments.current.delete(id);
    }
  }

  async function sendLive(live: Live, id: string, text: string, replyTo?: string, attachment?: Attachment) {
    if (sending.current.has(id)) return;
    sending.current.add(id);
    setUploadRejections((previous) => ({ ...previous, [id]: undefined }));
    setSendStatus((previous) => ({ ...previous, [id]: "pending" }));
    let result: SendResult | { state: "cancelled" };
    try {
      if (attachment?.kind === "photo" && live.sendPhoto) result = await live.sendPhoto(id, text, attachment.data, undefined, replyTo,
        ...(attachment.options ? [attachment.options] as const : []));
      else if (attachment && attachment.kind !== "photo" && live.sendDocument) {
        const total = attachment.file.size;
        const control = { controller: new AbortController(), canCancel: true };
        uploadControls.current.set(id, control);
        const progress = (uploaded: number, canCancel = true) => {
          control.canCancel = canCancel && !control.controller.signal.aborted;
          setUploadProgress((previous) => ({ ...previous, [id]: { uploaded, total, canCancel: control.canCancel } }));
        };
        progress(0);
        const videoArgs: [video?: true, options?: MediaSendOptions] = attachment.kind === "video"
          ? attachment.options ? [true, attachment.options] : [true] : [];
        result = await live.sendDocument(id, attachment.file, text, progress, control.controller.signal, undefined, replyTo, ...videoArgs);
      }
      else if (attachment) result = { state: "failed" };
      else if (previewPlacement || sendStyles.length || replyTarget?.selectedQuote) result = await live.sendText(id, text, replyTo, {
        ...linkPreviewDelivery(previewPlacement, text), ...(sendStyles.length ? { styles: sendStyles } : {}),
        ...(replyTarget?.selectedQuote ? { quote: replyTarget.selectedQuote } : {}),
      });
      else result = await (replyTo ? live.sendText(id, text, replyTo) : live.sendText(id, text));
    }
    catch { result = { state: "unknown" }; }
    sending.current.delete(id);
    uploadControls.current.delete(id);
    if (attachment && attachment.kind !== "photo") setUploadProgress((previous) => ({ ...previous, [id]: undefined }));
    if (result.state === "sent") {
      const message = result.message;
      if (!attachment) setLinkPreviews((previous) => ({ ...previous, [id]: undefined }));
      formatting.clearSent(id, text);
      if (attachment) setAttachments((previous) => previous[id] === attachment ? { ...previous, [id]: undefined } : previous);
      setReplyTargets((previous) => previous[id]?.id === replyTo ? { ...previous, [id]: undefined } : previous);
      setSent((previous) => ({ ...previous, [id]: [...(previous[id] ?? []), message] }));
      setDrafts((previous) => previous[id]?.trim() === text ? { ...previous, [id]: "" } : previous);
      setSendStatus((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    } else {
      const state = result.state;
      if (state === "failed" && result.uploadRejection) setUploadRejections((previous) => ({ ...previous, [id]: result.uploadRejection }));
      setSendStatus((previous) => ({ ...previous, [id]: state }));
    }
  }

  const messageNotification = live?.messageNotification;
  const notificationChat = messageNotification && live?.chats.find(({ id }) => id === messageNotification.chatId);
  return (
    <PlaybackHistoryProvider><div className="mtg">
      {messageNotification && !(showConversation && !overlayOpen && activeId === messageNotification.chatId && messageNotification.topicId === undefined) &&
        <MessageNotificationBanner key={messageNotification.key} notification={messageNotification} chat={notificationChat}
          load={live?.loadNotificationChat} dismiss={live?.dismissMessageNotification} open={(chat) => {
            openConversation(chat);
            if (live?.loadMessageContext) setSearchView({
              chatId: chat.id, messageId: messageNotification.messageId, topicId: messageNotification.topicId,
            });
            live?.dismissMessageNotification?.();
          }} />}
      <div className="mtg-layout" data-conversation={showConversation}>
        <nav className="mtg-rail" aria-label="Chat folders">
          <span className="mtg-avatar mtg-account" aria-label={live ? "Telegram account" : "Demo account"}>{live ? "TG" : "AM"}</span>
          <button type="button" aria-pressed={live ? live.list === "main" : folder === "all"} onClick={() => live ? switchList("main") : setFolder("all")}><MessageCircle size={20} />All chats</button>
          {live && <>
            <button type="button" aria-pressed={live.list === "archive"} onClick={() => switchList("archive")}><Archive size={20} />Archive</button>
            <button type="button" aria-pressed={live.list === "saved"} onClick={() => switchList("saved")}><Bookmark size={20} />Saved</button>
            {live.folders.length > 0 && <FolderNavigation folders={live.folders} selected={live.list} select={switchList} />}
          </>}
          {live?.folderActions && <FolderSettings folders={live.folders} actions={live.folderActions} />}
          {live?.agentAccess}
          {typeof live?.settings === "function" ? live.settings(openConversation) : live?.settings}
          {!live && <button type="button" aria-pressed={folder === "work"} onClick={() => setFolder("work")}><Folder size={20} />Work</button>}
        </nav>

        <section className="mtg-chats" aria-labelledby="mtg-chat-list">
          <header>
            <div className="mtg-list-title"><h1 id="mtg-chat-list" ref={listHeading} tabIndex={-1}>{listTitle}</h1>{live ? <button type="button" className="mtg-action" onClick={live.refresh} disabled={live.loading}>Refresh</button> : <span>Demo</span>}</div>
            <label className="mtg-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" aria-label={contactsMode ? "Search Telegram contacts" : globalMode ? "Search Telegram messages" : live ? live.list === "main" ? "Search Telegram chats" : live.list === "saved" ? "Filter saved chats" : "Search this list" : "Search chats and messages"} placeholder={contactsMode ? "Search contacts" : globalMode ? "Search messages" : live ? live.list === "main" ? "Search chats or paste a link" : live.list === "saved" ? "Filter saved chats" : "Search this list" : "Search chats and messages"} maxLength={live ? 128 : undefined} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {live?.globalSearch && live.list === "main" && <div className="mtg-kind-filter" role="group" aria-label="Search scope">
              {([["chats", "Chats"], ["messages", "Messages"], ["public", "Public posts"], ["contacts", "Contacts"]] as const).filter(([value]) => value !== "contacts" || live.contactActions).map(([value, label]) =>
                <button type="button" key={value} aria-pressed={searchMode === value} onClick={() => setSearchMode(value)}>{label}</button>)}
            </div>}
            {live && !globalMode && !contactsMode && <div className="mtg-kind-filter" role="group" aria-label="Chat type">
              {[["all", "All"], ["Direct message", "People"], ["Group", "Groups"], ["Channel", "Channels"]].map(([value, label]) =>
                <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value!)}>{label}</button>)}
            </div>}
          </header>
          {contactsMode && live?.contactActions ? <ContactResults key={`${live.contactsRevision ?? 0}:${query.trim()}`} query={query.trim()} actions={live.contactActions} select={openConversation} /> : globalMode && live?.globalSearch ? <GlobalSearchResults key={`${globalMode}:${query.trim()}`} mode={globalMode}
            query={query.trim()} search={live.globalSearch} open={({ chat, message }) => {
              setSearchView({ chatId: chat.id, messageId: message.id, topicId: message.forumTopicId });
              setForumView(undefined);
              setSelectedChat(chat);
              setActiveId(chat.id);
              setShowConversation(true);
              requestAnimationFrame(() => heading.current?.focus());
            }} /> : <ul className="mtg-rows" ref={chatRows} aria-label="Telegram chats" tabIndex={0}>
            {visible.map((chat) => {
              const tags = chat.folderIds && live?.folders.filter(({ id, color }) =>
                color !== undefined && color >= 0 && chat.folderIds?.includes(id));
              const linked = matched?.linked?.chat.id === chat.id ? matched.linked : undefined;
              const latest = (sent[chat.id] ?? []).at(-1) ?? chat.messages.at(-1);
              return <li key={chat.id}>
                <button type="button" className="mtg-row" aria-current={chat.id === activeId ? "true" : undefined} onClick={() => {
                  if (linked) {
                    setSearchView({ chatId: chat.id, messageId: linked.messageId, topicId: linked.topicId });
                    setForumView(undefined);
                  } else if (chat.id !== activeId) {
                    setSearchView(undefined);
                    setForumView(undefined);
                  }
                  setSelectedChat(chat);
                  setActiveId(chat.id);
                  setShowConversation(true);
                  requestAnimationFrame(() => heading.current?.focus());
                }}>
                  <Avatar key={chat.avatarFileId} chat={chat} load={live?.loadAvatar} />
                  <span className="mtg-row-body">
                    <span className="mtg-row-line"><strong>{chat.name}</strong><time>{latest?.time}</time></span>
                    <span className="mtg-row-line"><span className="mtg-preview">{latest?.outgoing && <b>You: </b>}{linked ? "Open linked message" : previewMessageText(latest) ?? "No messages"}</span>{!!chat.unreadMentions && <span className="mtg-unread-mentions" aria-label={`${chat.unreadMentions} unread mentions or replies`}>@{chat.unreadMentions}</span>}{!!chat.unreadReactions && <span className="mtg-unread-reactions" aria-label={`${chat.unreadReactions} messages with unread reactions`}><Heart size={12} aria-hidden="true" />{chat.unreadReactions}</span>}{(!!chat.unread || chat.markedUnread) && <span className="mtg-unread" aria-label={chat.unread ? `${chat.unread} unread` : "Marked unread"}>{chat.unread || "•"}</span>}</span>
                    {!!tags?.length && <span className="mtg-row-folder-tags" aria-label="Folders">
                      {tags.map(({ id, color, title }) => <span key={id} title={title}
                        style={{ color: color === undefined ? undefined : folderColors[color]?.value }}>{title}</span>)}
                    </span>}
                  </span>
                </button>
              </li>;
            })}
            {!remoteQuery && loadMoreChats && <li ref={moreChats} className="mtg-history-more mtg-history-start">
              {live?.loadingMore && <span role="status">Loading more chats…</span>}
              {(!autoPagination || chatLoadError) && !live?.loadingMore && <button type="button" className="mtg-action"
                disabled={!canLoadMore} onClick={() => void loadMoreChats()}>
                {chatLoadError ? "Retry loading chats" : "Load more chats"}
              </button>}
            </li>}
            {remoteQuery && !matched && <li className="mtg-empty" role="status">Searching Telegram…</li>}
            {matched?.stickerPack && loadLinkedStickerPack && <li className="mtg-empty">
              <StickerPackPreview key={remoteQuery} initial={matched.stickerPack} load={(offset) => loadLinkedStickerPack(remoteQuery, offset)}
                install={live?.installLinkedStickerPack && ((id) => live.installLinkedStickerPack!(remoteQuery, id))} />
            </li>}
            {matched?.folderInvite && <SharedFolderInvite key={remoteQuery} url={remoteQuery} folder={matched.folderInvite}
              importFolder={live?.importFolderInvite} />}
            {matched?.invite && <li className="mtg-empty">
              <InviteResult key={remoteQuery} url={remoteQuery} invite={matched.invite} join={live?.joinInvite} refresh={live?.refresh} />
            </li>}
            {matched?.error && <li className="mtg-empty" role="alert">{matched.error}</li>}
            {live?.error && <li className="mtg-empty" role="alert">{live.error}</li>}
            {live?.loading && <li className="mtg-empty" role="status">Loading chats…</li>}
            {!live?.error && !live?.loading && (!remoteQuery || matched && !matched.error && !matched.invite && !matched.folderInvite && !matched.stickerPack) && visible.length === 0 && <li className="mtg-empty">{search || kind !== "all" ? "No matching chats" : "No chats"}</li>}
          </ul>}
        </section>

        <section className="mtg-conversation" aria-labelledby="mtg-conversation-title" onKeyDown={(event) => {
          if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || !event.altKey || !event.shiftKey
            || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)
            || event.target.closest("input, textarea, select, dialog, [contenteditable]")) return;
          const shortcut = event.code === "KeyI" ? "Alt+Shift+I" : event.code === "KeyF" ? "Alt+Shift+F" : undefined;
          if (!shortcut) return;
          const button = event.currentTarget.querySelector<HTMLButtonElement>(`.mtg-conversation-header [aria-keyshortcuts="${shortcut}"]`);
          if (!button || button.disabled) return;
          event.preventDefault();
          button.focus();
          button.click();
        }}>
          <header className="mtg-conversation-header">
            <button className="mtg-back" type="button" aria-label="Back to chats" onClick={() => {
              setShowConversation(false);
              requestAnimationFrame(() => listHeading.current?.focus());
            }}><ArrowLeft size={21} /></button>
            {active && <Avatar key={`${active.id}:${active.avatarFileId}`} chat={active} load={live?.loadAvatar} />}
            <div className="mtg-chat-heading"><h2 id="mtg-conversation-title" ref={heading} tabIndex={-1}>{active?.name ?? "Select a chat"}</h2>
              <div className="mtg-chat-subtitle">
                <p>{active?.subtitle}</p>
                {active && live && <CopyRecipientReference key={active.id} chatId={active.id} />}
              </div>
            </div>
            {active && live?.joinChat && permissions?.join && joinStatus[active.id] !== "requested"
              && joinStatus[active.id] !== "joined" && joinStatus[active.id] !== "verification_required" &&
              <button type="button" className="mtg-action" disabled={joinStatus[active.id] === "joining"}
                onClick={() => void joinActive(active)}>{permissions.join === "request" ? "Request to join" : "Join"}</button>}
            {active && live && <ChatDetails key={`details:${active.id}`}
              chatId={active.id} name={active.name} load={live.chatAgentAccess} change={live.setChatAgentAccess}
              browse={live.searchMessages ? (filter) => {
                setForumView(undefined);
                setDiscussion(undefined);
                setSearchView({ chatId: active.id, filter });
              } : undefined}>
              {live.contactEditor && chatList !== "saved" && active.subtitle === "Direct message"
                && <ContactEditor chatId={active.id} actions={live.contactEditor} />}
              {live.senderBlockActions && chatList !== "saved" && active.subtitle === "Direct message"
                && <SenderBlockSettings chatId={active.id} actions={live.senderBlockActions} />}
              {live.folderActions && live.folders.length > 0 && <ChatFolderMemberships key={active.id}
                chatId={active.id} folders={live.folders} actions={live.folderActions} />}
              {live.loadChatMembers && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatMembers chatId={active.id} load={live.loadChatMembers} />}
              {live.chatInviteActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatInvites chatId={active.id} actions={live.chatInviteActions} />}
              {live.joinRequestActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatJoinRequests chatId={active.id} actions={live.joinRequestActions} />}
              {live.channelSignatureActions && active.subtitle === "Channel"
                && <ChannelSignaturesPanel chatId={active.id} actions={live.channelSignatureActions} />}
              {live.chatInfoActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatInfoPanel chatId={active.id} actions={live.chatInfoActions} />}
              {chatAutoDeleteActions && chatList !== "saved" && <AutoDeleteTimer chat actions={chatAutoDeleteActions} />}
              {live.slowModeActions && active.subtitle === "Group"
                && <GroupSlowMode chatId={active.id} actions={live.slowModeActions} />}
              {live.groupPermissionActions && active.subtitle === "Group"
                && <GroupPermissions chatId={active.id} actions={live.groupPermissionActions} />}
              {live.loadChatEvents && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatEvents chatId={active.id} load={live.loadChatEvents} />}
              {live.markChat && <button type="button" className="mtg-action mtg-mark-chat"
                disabled={markStatus[active.id] === "busy"} onClick={() => void markActive(active)}>
                {active.unread || active.markedUnread ? "Mark read" : "Mark unread"}
              </button>}
              {chatList !== "saved" && live.chatNotificationState && live.setChatNotificationMode &&
                <ChatNotifications key={`notifications:${active.id}`} id={active.id} chatNotificationState={live.chatNotificationState}
                  setChatNotificationSound={live.setChatNotificationSound} setChatNotificationMode={live.setChatNotificationMode} setChatNotificationOverride={live.setChatNotificationOverride} />}
              {chatList !== undefined && chatList !== "saved" && live.chatPinStatus && live.setChatPinned &&
                <ChatPin key={`pin:${active.id}:${chatList}`} id={active.id} list={chatList} revision={live.liveRevision}
                  chatPinStatus={live.chatPinStatus} setChatPinned={live.setChatPinned} />}
              {active.archived !== undefined && live.archiveChat && <button type="button"
                className="mtg-chat-archive" aria-label={active.archived ? "Restore chat from archive" : "Archive chat"}
                title={active.archived ? "Restore chat from archive" : "Archive chat"} disabled={archiveStatus[active.id] === "busy"}
                onClick={() => void moveActive(active)}><Archive size={18} aria-hidden="true" /> {active.archived ? "Restore chat from archive" : "Archive chat"}</button>}
              {archiveStatus[active.id] === "failed" && <p role="alert">Could not move this chat.</p>}
              {markStatus[active.id] === "failed" && <p role="alert">Could not update the read state.</p>}
            </ChatDetails>}
            {topics && <button type="button" className="mtg-action" aria-pressed={topicsOpen} onClick={() => {
              setSearchView(undefined);
              setForumView(topicsOpen ? undefined : activeId);
            }}>Topics</button>}
            {!!active?.unreadMentions && !topicsOpen && !activeDiscussion && live?.searchMessages &&
              <button type="button" className="mtg-chat-search-toggle mtg-unread-mentions" aria-label="Unread mentions and replies"
                aria-pressed={searching && searchView?.filter === "unreadMentions"}
                title={`${active.unreadMentions} unread mentions or replies`}
                onClick={() => setSearchView(searching && searchView?.filter === "unreadMentions"
                  ? undefined : { chatId: activeId, filter: "unreadMentions" })}>@{active.unreadMentions}</button>}
            {!!active?.unreadReactions && !topicsOpen && !activeDiscussion && live?.searchMessages &&
              <button type="button" className="mtg-chat-search-toggle mtg-unread-reactions" aria-label="Unread reactions"
                aria-pressed={searching && searchView?.filter === "unreadReactions"}
                title={`${active.unreadReactions} messages with unread reactions`}
                onClick={() => setSearchView(searching && searchView?.filter === "unreadReactions"
                  ? undefined : { chatId: activeId, filter: "unreadReactions" })}>
                <Heart size={15} aria-hidden="true" />{active.unreadReactions}
              </button>}
            {active && !topicsOpen && !activeDiscussion && live?.searchMessages && <button type="button" className="mtg-chat-search-toggle"
              aria-label="Search conversation" aria-keyshortcuts="Alt+Shift+F" title="Search conversation (Alt+Shift+F)" aria-pressed={searching && !searchView?.messageId} onClick={() => setSearchView(searching && !searchView?.messageId ? undefined : { chatId: activeId })}>
              <Search size={18} aria-hidden="true" />
            </button>}
          </header>
          {joinStatus[activeId] && <p className="mtg-send-status" role="status">{joinMessages[joinStatus[activeId]!]}</p>}
          {!topicsOpen && pinnedText && <div className="mtg-pinned">
            {pinnedMessage && live?.loadMessageContext
              ? <button type="button" className="mtg-pinned-open" onClick={() => setSearchView({ chatId: activeId, messageId: pinnedMessage.id })}>
                <strong>Pinned message</strong><span>{pinnedText}</span>
              </button>
              : <div><strong>Pinned message</strong><p>{pinnedText}</p></div>}
            {live?.searchMessages && <button type="button" className="mtg-reply-action" title="All pinned messages"
              aria-label="All pinned messages" onClick={() => {
                setDiscussion(undefined);
                setSearchView({ chatId: activeId, filter: "pinned" });
              }}><List size={17} aria-hidden="true" /></button>}
          </div>}
          {searching && <ConversationSearch key={`${activeId}:${searchView?.messageId ?? searchView?.day ?? searchView?.filter ?? searchView?.author?.sender.id ?? "search"}:${searchView?.revision ?? 0}`} chatId={activeId}
            chat={active} loadAvatar={live?.loadAvatar} initialMessage={searchView?.messageId} initialDay={searchView?.day} initialFilter={searchView?.filter} initialAuthor={searchView?.author} topicId={searchView?.topicId} search={live?.searchMessages} loadMessageLink={live?.loadMessageLink} loadAtDate={live?.loadMessageAtDate} loadContext={live?.loadMessageContext} loadContextPage={live?.loadMessageContextPage} markActivityRead={live?.markActivityRead} loadPhoto={live?.loadPhoto} loadMedia={live?.loadMedia} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} saveDocument={live?.saveDocument}
            mediaCollection={live?.mediaCollection} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} deletedIds={deletedIds} close={() => { setSearchView(undefined); heading.current?.focus(); }} />}
          {topicsOpen && topics && loadForumTopics && loadTopicHistory && <ForumTopics key={activeId} chatId={activeId} chat={active} loadAvatar={live?.loadAvatar} loadMessageLink={live?.loadMessageLink} topics={topics} liveRevision={liveRevision}
            loadForumTopics={loadForumTopics} loadTopicHistory={loadTopicHistory} sendTopicText={canSendText ? live?.sendTopicText : undefined}
            scheduleActions={live?.scheduledMessages && live.cancelScheduledMessage ? {
              load: live.scheduledMessages, cancel: live.cancelScheduledMessage, change: live.changeScheduledMessage,
              checkRepeat: live.canScheduleRepeats,
            } : undefined}
            mediaComposer={live?.mediaComposer} mediaPermissions={{ photos: canAttachPhoto,
              voice: !restrictedChat || permissions?.voice === true, videoNote: !restrictedChat || permissions?.videoNote === true, otherMedia: !restrictedChat || permissions?.otherMedia === true }}
            sendPoll={sendPoll} sendPhoto={canAttachPhoto ? live?.sendPhoto : undefined} sendDocument={canAttachDocument || canAttachVideo ? live?.sendDocument : undefined}
            allowVideoAttachment={canAttachVideo} allowDocumentAttachment={canAttachDocument} loadPhoto={live?.loadPhoto}
            manageTopic={live?.manageForumTopic} loadTopicDraft={live?.loadTopicDraft} saveTopicDraft={live?.saveChatDraft} loadTopicPage={live?.loadForumTopicPage} messageActions={live} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} loadMedia={live?.loadMedia} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} saveDocument={live?.saveDocument} deletedIds={deletedIds} close={() => { setForumView(undefined); heading.current?.focus(); }} />}
          {activeDiscussion && live?.loadChannelDiscussion && <ChannelDiscussion key={`${activeId}:${activeDiscussion.postId}`}
            chatId={activeId} postId={activeDiscussion.postId} load={live.loadChannelDiscussion} send={live.sendChannelComment}
            loadAvatar={live.loadAvatar} loadPhoto={live.loadPhoto} loadMedia={live.loadMedia} loadVideoStream={live.loadVideoStream}
            transcribeVoice={live.transcribeVoice} saveDocument={live.saveDocument} mediaCollection={live.mediaCollection}
            close={() => { setDiscussion(undefined); heading.current?.focus(); }} />}
          <ol hidden={overlayOpen} className="mtg-history" ref={history} aria-label="Messages" tabIndex={0}
            onScroll={(event) => {
              const list = event.currentTarget;
              const upward = list.scrollTop < lastHistoryTop.current;
              if (canLoadOlderOnScroll && list.scrollTop <= 96 && upward) void loadOlder();
              lastHistoryTop.current = list.scrollTop;
              if (upward || !isAwayFromLatest(list)) followLatest.current = !isAwayFromLatest(list);
              setAwayFromLatest(!followLatest.current);
            }}
            onWheel={(event) => {
              if (canLoadOlderOnScroll && event.deltaY < 0 && event.currentTarget.scrollTop <= 0) void loadOlder();
            }}>
            {before && <li className="mtg-history-more mtg-history-start">
              {olderLoading && <span role="status">Loading earlier messages…</span>}
              {!olderLoading && <button type="button" className="mtg-action" onClick={() => void loadOlder()}>
                {olderError ? "Retry earlier messages" : "Load earlier messages"}
              </button>}
              {olderError && <p role="alert">Could not load earlier messages. Try again.</p>}
            </li>}
            {!live && <li className="mtg-date"><span>Today</span></li>}
            {live && active && !selectedHistory?.page?.messages && !selectedHistory?.error && <li className="mtg-empty" role="status">Loading messages…</li>}
            {selectedHistory?.error && <li className="mtg-empty" role="alert">{selectedHistory.error} <button type="button" className="mtg-action" onClick={() => setHistoryAttempt((attempt) => attempt + 1)}>Retry</button></li>}
            {live && selectedHistory?.page?.messages && messages.length === 0 && <li className="mtg-empty">No messages</li>}
            {groupMessageTimeline(messages).flatMap(({ day, group }) => {
              const albumCaption = sharedAlbumCaption(group);
              const albumPhotos = group.length > 1
                ? group.filter((entry) => entry.hasPhoto).map(({ id, photoSpoiler, canSavePhoto }) => ({ id, spoiler: photoSpoiler, canSave: canSavePhoto }))
                : undefined;
              const rows = group.map((message) => message.service && !message.retained
                ? <ServiceMessageRow key={message.id} message={message}
                  openPinned={live?.loadMessageContext && !deletedIds?.has(message.pinnedTargetId ?? "")
                    ? (id) => setSearchView({ chatId: activeId, messageId: id }) : undefined} /> : <li key={message.id} data-message-id={message.id} data-album-id={message.albumId} className={`mtg-message${message.outgoing ? " mtg-outgoing" : ""}`}>
                <div className="mtg-bubble">
                  {message.replyTo && <blockquote className="mtg-reply-quote">
                    {deletedIds?.has(message.replyTo) ? "Original message unavailable"
                      : live?.loadMessageContext
                        ? <button type="button" className="mtg-open-reply" aria-label="Open original message"
                          onClick={() => setSearchView({ chatId: activeId, messageId: message.replyTo })}>
                          {message.replyQuote ?? previewMessageText(byId.get(message.replyTo)) ?? "Earlier message"}
                        </button>
                        : message.replyQuote ?? previewMessageText(byId.get(message.replyTo)) ?? "Earlier message"}
                  </blockquote>}
                  {message.author && (!message.outgoing || active?.subtitle === "Group" && message.sender) &&
                    <MessageAuthor message={message} chat={active} load={live?.loadAvatar}
                      search={live?.searchMessages && active?.subtitle === "Group" && !message.retained && message.sender
                        ? () => setSearchView((previous) => ({
                          chatId: activeId, author: { sender: message.sender!, name: message.author },
                          revision: (previous?.revision ?? 0) + 1,
                        }))
                        : undefined} />}
                  {message.retained && <p className="mtg-retained-message">
                    {message.retained === "expired" ? "Media expired · kept locally" : "Deleted in Telegram · kept locally"}
                  </p>}
                  <MessageContent chatId={activeId} message={message} hideCaption={albumCaption?.message === message} albumPhotos={albumPhotos} mediaCollection={live?.mediaCollection} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} loadPhoto={live?.loadPhoto} loadMedia={live?.loadMedia} saveDocument={live?.saveDocument} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} />
                  {live?.loadChannelDiscussion && active?.subtitle === "Channel" && message.commentCount !== undefined
                    && <button type="button" className="mtg-action" onClick={() => {
                      setSearchView(undefined);
                      setDiscussion({ chatId: activeId, postId: message.id });
                    }}>{message.commentCount ? `Comments (${message.commentCount})` : "Comments"}</button>}
                  <div className="mtg-message-time">
                    {message.viewCount !== undefined && <ChannelViewCount count={message.viewCount} />}
                    <MessageTimestamp message={message} />
                    {message.outgoing && !message.pendingDelivery && readOutbox !== undefined && /^[1-9]\d{0,15}$/.test(message.id) && (
                      live?.messageReadTime && active?.subtitle === "Direct message" && live.list !== "saved"
                        && !message.retained && Number(message.id) <= readOutbox
                        ? <ReadTimeButton key={activeId} chatId={activeId} messageId={message.id} load={live.messageReadTime} />
                        : <span role="img" aria-label={Number(message.id) <= readOutbox ? "Read" : "Sent"}
                          title={Number(message.id) <= readOutbox ? "Read" : "Sent"}>
                          {Number(message.id) <= readOutbox ? <CheckCheck size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        </span>
                    )}
                  </div>
                  <div key="viewer-slot" className="mtg-message-viewer-slot">
                    {live?.messageViewers && active?.subtitle === "Group" && message.outgoing
                      && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id)
                      && <MessageViewers key={`${activeId}:${message.id}`} chatId={activeId} messageId={message.id} load={live.messageViewers} />}
                  </div>
                  {live && !message.retained && !message.pendingDelivery && <CopyMessageReference key={`reference:${activeId}`}
                    chatId={activeId} messageId={message.id} forumTopicId={message.forumTopicId} />}
                  {live?.loadMessageLink && active && (active.subtitle === "Channel" || active.subtitle === "Group")
                    && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                    <CopyTelegramLink chatId={activeId} messageId={message.id} load={live.loadMessageLink} />
                  )}
                  {live?.pinStatus && live.setMessagePinned && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                    <MessagePin key={`pin:${activeId}`} chatId={activeId} messageId={message.id}
                      pinStatus={live.pinStatus} setMessagePinned={live.setMessagePinned} />
                  )}
                  {live?.deletionOptions && live.deleteMessage && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                    <MessageDeletion key={`delete:${activeId}`} chatId={activeId} messageId={message.id}
                      deletionOptions={live.deletionOptions} deleteMessage={live.deleteMessage} />
                  )}
                  {active && (live?.editText && message.editable || live?.editCaption && message.editableCaption) && <button type="button" className="mtg-reply-action"
                    aria-label={message.editableCaption ? "Edit caption" : "Edit message"} title="Edit" disabled={editing?.busy} onClick={() => {
                      setEditing({ chat: active.id, message, text: editableMessageText(message), busy: false });
                    }}><Pencil size={15} aria-hidden="true" /></button>}
                  {live && active && canCompose && !message.retained && /^[1-9]\d{0,15}$/.test(message.id) && <button type="button" className="mtg-reply-action"
                    aria-label="Reply to message" title="Reply" disabled={sendStatus[activeId] === "pending" || currentAttachmentStatus?.preparing} onClick={() => {
                      setReplyTargets((previous) => ({ ...previous, [active.id]: message }));
                      draftInput.current?.focus();
                    }}><Reply size={15} aria-hidden="true" /></button>}
                </div>
              </li>);
              const first = group[0]!;
              const entry = first.albumId ? [<MessageAlbum key={`album:${first.albumId}:${first.id}`} first={first} caption={albumCaption}>{rows}</MessageAlbum>] : rows;
              if (!day) return entry;
              const date = first.timestamp && localDateInputValue(first.timestamp);
              return [<li key={`day:${first.id}`} className="mtg-date mtg-history-day">
                {date && live?.loadMessageAtDate && live.loadMessageContext
                  ? <button type="button" className="mtg-history-day-jump" aria-label={`Jump to date from ${day}`}
                    onClick={() => setSearchView({ chatId: activeId, day: date })}>{day}</button>
                  : day}
              </li>, ...entry];
            })}
          </ol>
          {!overlayOpen && active && awayFromLatest && <button type="button" className="mtg-action mtg-latest"
            onClick={() => {
              const list = history.current;
              if (!list) return;
              list.focus({ preventScroll: true });
              list.scrollTop = list.scrollHeight;
              lastHistoryTop.current = list.scrollTop;
              followLatest.current = true;
              setAwayFromLatest(false);
            }}>Jump to latest</button>}
          {uploading && <div className="mtg-send-status">
            <progress aria-label="Document upload to BB" max={uploading.total} value={uploading.uploaded} />
            <span> {uploading.uploaded === uploading.total
              ? "Uploaded to BB. Waiting for Telegram."
              : `${Math.floor(uploading.uploaded / uploading.total * 100)}% uploaded to BB`}</span>
            {uploading.canCancel && <button type="button" className="mtg-action" onClick={() => {
              const control = uploadControls.current.get(activeId);
              if (!control?.canCancel) return;
              control.canCancel = false;
              control.controller.abort();
              setUploadProgress((previous) => ({ ...previous, [activeId]: { ...uploading, canCancel: false } }));
            }}>Cancel upload</button>}
          </div>}
          {sendStatus[activeId] && <p className="mtg-send-status" role="status">{
            uploadRejections[activeId] === "legacy_tdlib" ? "Update TDLib to send documents this large."
              : uploadRejections[activeId] === "premium_required" ? "Telegram Premium is required to send documents over 2000 MiB."
              : uploadRejections[activeId] === "file_too_large" ? "Telegram supports uploads up to 4000 MiB."
              : uploadRejections[activeId] === "reply_unavailable" ? "The original message is unavailable. Your draft is still here."
              : sendStatus[activeId] === "cancelled" ? "Upload cancelled. Your draft is still here."
              : sendStatus[activeId] === "pending" ? "Sending…" : sendStatus[activeId] === "failed"
              ? "Telegram rejected the message. Your draft is still here."
              : "Telegram did not confirm delivery. Check the conversation before sending again."
          }</p>}
          {!overlayOpen && edit && <MessageEdit key={`${edit.chat}:${edit.message.id}`} draft={edit} change={(text) => setEditing({ ...edit, text })}
            cancel={() => setEditing(undefined)} save={saveEdit} />}
          {!overlayOpen && !edit && replyTarget && <div className="mtg-reply-preview">
            <div><strong>{replyDeleted ? "Original message was deleted" : `Replying to ${replyTarget.author}`}</strong>
              {!replyDeleted && <p>{replyTarget.selectedQuote?.text ?? previewMessageText(replyTarget)}</p>}
              {!replyDeleted && canSendText && !attachment && !currentAttachmentStatus?.preparing && replyTarget.canQuote &&
                <SelectReplyQuote key={replyTarget.id} text={replyTarget.text} quote={replyTarget.selectedQuote}
                  disabled={sendStatus[activeId] === "pending"} change={(selectedQuote) =>
                    setReplyTargets((previous) => ({ ...previous, [activeId]: { ...replyTarget, selectedQuote } }))} />}
            </div>
            <button type="button" aria-label="Cancel reply" title="Cancel reply"
              onClick={() => setReplyTargets((previous) => ({ ...previous, [activeId]: undefined }))}><X size={17} aria-hidden="true" /></button>
          </div>}
          {active && !overlayOpen && !edit && attachment && <div className="mtg-reply-preview">
            {attachment.kind === "photo" && <img className="mtg-attachment-preview" src={`data:image/jpeg;base64,${attachment.data}`} alt="Selected photo" />}
            <div><p>{attachment.name}</p>{draft.trim().length > 1024 && <p role="alert">Caption must be at most 1024 characters.</p>}
              {attachment.kind !== "document" && <MediaSendControls kind={attachment.kind} options={attachment.options} hasCaption={!!draft.trim()}
                disabled={sendStatus[activeId] === "pending"} change={(options) =>
                  setAttachments((previous) => previous[activeId] === attachment
                    ? { ...previous, [activeId]: { ...attachment, options } } : previous)} />}
            </div>
            <button type="button" aria-label={`Remove ${attachment.kind}`} disabled={sendStatus[activeId] === "pending"}
              onClick={() => setAttachments((previous) => ({ ...previous, [activeId]: undefined }))}><X size={17} aria-hidden="true" /></button>
          </div>}
          {active && !overlayOpen && !edit && currentAttachmentStatus?.preparing && <p className="mtg-send-status" role="status">Preparing photo…</p>}
          {active && !overlayOpen && !edit && currentAttachmentStatus?.error && <p className="mtg-send-status" role="alert">{currentAttachmentStatus.error}</p>}
          {active && !overlayOpen && !edit && !canCompose && <p className="mtg-send-status" role="status">
            {permissions === undefined ? "Checking posting permission…" : permissions === null ? "Could not check posting permission." : "Your account cannot send messages in this chat."}
          </p>}
          {active && !overlayOpen && !edit && canSendText && savedDraft && drafts[activeId] === undefined
            && !attachment && !replyTarget && <button type="button" className="mtg-action" onClick={() => {
              setDrafts((previous) => previous[activeId] === undefined ? { ...previous, [activeId]: savedDraft } : previous);
              draftInput.current?.focus();
            }}>Use Telegram draft</button>}
          {active && !overlayOpen && !edit && canSendText && !attachment && !replyTarget && selectedHistory?.page
            && live?.saveChatDraft && (draft.trim() || (drafts[activeId] !== undefined && savedDraft)) && <div className="mtg-composer-media">
              <button type="button" className="mtg-action" disabled={draftSyncStatus[activeId] === "Saving…"}
                onClick={() => {
                  const save = live.saveChatDraft;
                  if (!save || draftSyncBusy.current.has(activeId)) return;
                  draftSyncBusy.current.add(activeId);
                  setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Saving…" }));
                  void save(activeId, draft, savedDraft ?? null).then((result) => {
                    setDraftSyncStatus((previous) => ({ ...previous, [activeId]: result === "saved"
                      ? draft.trim() ? "Draft saved to Telegram." : "Telegram draft cleared."
                      : result === "changed" ? "The Telegram draft changed. Check it and try again."
                      : "This Telegram draft cannot be replaced from BB." }));
                    live.refresh();
                  }, () => setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Could not save the Telegram draft." })))
                    .finally(() => draftSyncBusy.current.delete(activeId));
                }}>{draft.trim() ? "Save draft to Telegram" : "Clear Telegram draft"}</button>
              {draftSyncStatus[activeId] && <p role="status">{draftSyncStatus[activeId]}</p>}
            </div>}
          {active && !overlayOpen && !edit && live?.scheduledMessages && live.cancelScheduledMessage && canSendText && !attachment
            && <ScheduledMessages key={`schedule:${activeId}`} chatId={activeId} liveRevision={live.liveRevision} draft={draft} canSend={!replyDeleted && sendStatus[activeId] !== "pending"}
              mediaLoaders={{ loadPhoto: live.loadPhoto, loadMedia: live.loadMedia, loadVideoStream: live.loadVideoStream }}
              load={live.scheduledMessages} checkRepeat={live.canScheduleRepeats} checkOnline={chatList !== "saved" && active.subtitle === "Direct message" ? live.canScheduleWhenOnline : undefined} cancel={live.cancelScheduledMessage} change={live.changeScheduledMessage}
              send={async (delivery) => {
                if (sending.current.has(activeId)) return { state: "failed" };
                sending.current.add(activeId);
                setSendStatus((previous) => ({ ...previous, [activeId]: "pending" }));
                try { return await live.sendText(activeId, draft.trim(), replyTarget?.id, {
                  ...delivery, ...linkPreviewDelivery(previewPlacement, draft.trim()), ...(sendStyles.length ? { styles: sendStyles } : {}),
                  ...(replyTarget?.selectedQuote ? { quote: replyTarget.selectedQuote } : {}),
                }); }
                finally {
                  sending.current.delete(activeId);
                  setSendStatus((previous) => {
                    const next = { ...previous };
                    delete next[activeId];
                    return next;
                  });
                }
              }}
              accepted={(text, result, scheduled) => {
                setLinkPreviews((previous) => ({ ...previous, [activeId]: undefined }));
                formatting.clearSent(activeId, text);
                if (!scheduled) setSent((previous) => ({ ...previous, [activeId]: [...(previous[activeId] ?? []), result.message] }));
                setDrafts((previous) => previous[activeId]?.trim() === text ? { ...previous, [activeId]: "" } : previous);
                setReplyTargets((previous) => previous[activeId]?.id === replyTarget?.id
                  ? { ...previous, [activeId]: undefined } : previous);
              }} />}
          {active && !overlayOpen && !edit && !replyDeleted && !attachment && live?.mediaComposer
            && (canAttachPhoto || permissions?.voice || permissions?.videoNote || permissions?.otherMedia || !restrictedChat)
            && <MediaComposer key={`media:${activeId}:${replyTarget?.id ?? ""}`}
              actions={replyTarget ? live.mediaComposer(activeId, undefined, { messageId: replyTarget.id, ...(replyTarget.selectedQuote ? { quote: replyTarget.selectedQuote } : {}) }) : live.mediaComposer(activeId)}
              onSent={replyTarget && (() => setReplyTargets((previous) => previous[activeId] === replyTarget
                ? { ...previous, [activeId]: undefined } : previous))}
              photos={canAttachPhoto} voice={!restrictedChat || permissions?.voice === true} videoNote={!restrictedChat || permissions?.videoNote === true} otherMedia={!restrictedChat || permissions?.otherMedia === true} />}
          {active && !overlayOpen && !edit && sendPoll && <PollComposer key={`poll:${activeId}`} chatId={activeId} send={sendPoll} />}
          {active && !overlayOpen && !edit && canSendText && !attachment && previewAvailable &&
            <LinkPreviewControls choice={previewPlacement} text={draft} disabled={sendStatus[activeId] === "pending"}
              change={(placement) => setLinkPreviews((previous) => ({ ...previous, [activeId]: placement }))} />}
          {active && live && !overlayOpen && !edit && canSendText && !attachment &&
            <DraftFormatControls formatting={formatting} busy={sendStatus[activeId] === "pending"} />}
          {active && !overlayOpen && !edit && canCompose && <form className="mtg-composer" onSubmit={submit} onPaste={(event) => {
            if (!canAttachPhoto || replyTarget?.selectedQuote || sending.current.has(activeId)) return;
            const photo = Array.from(event.clipboardData.files).find((file) => isPhotoMimeType(file.type));
            if (!photo) return;
            event.preventDefault();
            void chooseAttachment(photo, activeId, "photo");
          }}>
            {canAttachPhoto && <>
              <input ref={fileInput} type="file" aria-label="Choose photo" accept={photoAccept} style={{ display: "none" }}
                onChange={(event) => { void chooseAttachment(event.target.files?.[0], activeId, "photo"); event.target.value = ""; }} />
              <button type="button" aria-label="Attach photo" title="Attach photo" disabled={!!replyTarget?.selectedQuote || sendStatus[activeId] === "pending"}
                onClick={() => fileInput.current?.click()}><Camera size={17} aria-hidden="true" /></button>
            </>}
            {canAttachVideo && <>
              <input ref={videoInput} type="file" aria-label="Choose video" accept=".mp4,video/mp4" hidden
                onChange={(event) => { void chooseAttachment(event.target.files?.[0], activeId, "video"); event.target.value = ""; }} />
              <button type="button" className="mtg-action" disabled={!!replyTarget?.selectedQuote || sendStatus[activeId] === "pending"}
                onClick={() => videoInput.current?.click()}>Attach video</button>
            </>}
            {canAttachDocument && <>
              <input ref={documentInput} type="file" aria-label="Choose document" style={{ display: "none" }}
                onChange={(event) => { void chooseAttachment(event.target.files?.[0], activeId, "document"); event.target.value = ""; }} />
              <button type="button" aria-label="Attach document" title="Attach document" disabled={!!replyTarget?.selectedQuote || sendStatus[activeId] === "pending"}
                onClick={() => documentInput.current?.click()}><Paperclip size={17} aria-hidden="true" /></button>
            </>}
            {!canSendText && !attachment && <span>{canAttachVideo ? "Choose an attachment to send in this chat."
              : canAttachPhoto && canAttachDocument ? "Only photos and documents can be sent in this chat."
              : canAttachPhoto ? "Only photos can be sent in this chat." : "Only documents can be sent in this chat."}</span>}
            {live && canSendText && !attachment && <DraftFormatButton formatting={formatting} busy={sendStatus[activeId] === "pending"} />}
            {(canSendText || canAttachPhoto || attachment) && <textarea ref={draftInput} rows={1} onKeyDown={submitComposerOnEnter} aria-label={attachment ? "Write an attachment caption" : !canSendText ? "Paste a photo or write a caption" : live ? "Write a message" : "Write a demo message"}
              placeholder={attachment ? "Write an attachment caption" : !canSendText ? "Paste a photo or write a caption" : live ? "Write a message" : "Write a demo message"}
              value={draft} maxLength={4096} onChange={(event) => changeDraft(event.target.value)}
              onSelect={(event) => formatting.select(event.currentTarget)} />}
            <button type="submit" aria-label={live ? "Send message" : "Send demo message"} disabled={!!replyDeleted || (attachment ? !canSendAttachment || draft.trim().length > 1024 : !canSendText || !draft.trim()) || currentAttachmentStatus?.preparing || sendStatus[activeId] === "pending"}><Send size={17} aria-hidden="true" /></button>
          </form>}
        </section>
      </div>
    </div></PlaybackHistoryProvider>
  );
}

const joinMessages: Record<ChatJoinResult | "joining", string> = {
  joining: "Joining…",
  joined: "Joined.",
  requested: "Join request sent.",
  verification_required: "Open Telegram to complete the join verification.",
  refused: "Telegram declined the join request.",
  unknown: "Telegram did not confirm membership. Check before trying again.",
};

function InviteResult({ url, invite, join, refresh }: {
  url: string;
  invite: InvitePreview;
  join?: Live["joinInvite"];
  refresh?: () => void;
}) {
  const [status, setStatus] = useState<ChatJoinResult | "joining">();
  async function joinChat() {
    if (!join || status === "joining" || invite.mode === "subscription") return;
    setStatus("joining");
    const { title, kind, mode, chatId } = invite;
    const result = await join(url, { title, kind, mode, ...(chatId === undefined ? {} : { chatId }) })
      .catch(() => "unknown" as const);
    setStatus(result);
    if (result === "joined") refresh?.();
  }

  const canJoin = invite.mode !== "subscription" && join
    && status !== "requested" && status !== "joined" && status !== "verification_required";
  return <>
    <strong><bdi>{invite.title}</bdi></strong>
    <p>{invite.kind}{invite.memberCount === undefined ? "" : ` · ${invite.memberCount.toLocaleString()} members`}</p>
    {invite.mode === "subscription" && <p>Open this invite in Telegram to review its subscription.</p>}
    {canJoin && <button type="button" className="mtg-action" disabled={status === "joining"}
      onClick={() => void joinChat()}>{invite.mode === "request" ? "Request to join" : "Join"}</button>}
    {status && <p role="status">{joinMessages[status]}</p>}
  </>;
}
