import type { ContactEditorActions } from "./src/ui/contact-editor.tsx";
import type { ContactActions } from "./src/ui/contact-results.tsx";
import type { ChannelSignatureActions } from "./src/ui/channel-signatures.tsx";
import type { ChatInfoActions } from "./src/ui/chat-info.tsx";
import type { SlowModeActions } from "./src/ui/group-slow-mode.tsx";
import type { GroupPermissionActions } from "./src/ui/group-permissions.tsx";
import type { JoinRequestActions } from "./src/ui/chat-join-requests.tsx";
import type { ChatInviteActions } from "./src/ui/chat-invites.tsx";
import type { FolderActions } from "./src/ui/folder-settings.tsx";
import type { GlobalSearchLoader } from "./src/ui/global-search.tsx";
import { definePluginApp, experimental_saveFile, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { rpcContract } from "./server.ts";
import { chatChangedChannel, messageNotificationChannel, messageNotificationSchema, type MessageNotification, messagesDeletedChannel, messagesDeletedSchema, maxPlaybackBytes, schemas, type PollChoice, type PollDraft, type InviteTarget, type ForwardTarget, type ChatNotificationMode, type ChatMutePeriod, type ChatNotificationOverride, type ChatNotificationField, type DeletionScope, type ForumTopicPage, type ForumTopicAction, type ForumTopicTarget, type TelegramPhoto, type MessageSearchFilter, type MessagesDeleted, type MediaReply, type MediaDelivery, type PhotoSize, type AgentAccess, type Auth, type ChatList, type TelegramFolder, type TelegramDevice } from "./src/core/contract.ts";
import { waitForDocumentDelivery } from "./src/adapters/bb/document-delivery-client.ts";
import type { Chat } from "./src/core/demo.ts";
import { readRenderer } from "./src/core/agent-read.ts";
import { AgentReadApproval } from "./src/ui/agent-read-approval.tsx";
import { approvalRenderer } from "./src/core/agent-approval.ts";
import { AgentSendApproval } from "./src/ui/agent-send-approval.tsx";
import { AgentAccessPanel } from "./src/ui/agent-access-panel.tsx";
import { TelegramProfile, type ProfileActions } from "./src/ui/telegram-profile.tsx";
import type { SenderBlockActions } from "./src/ui/sender-block-settings.tsx";
import { TelegramPrivacy, type TelegramPrivacyActions } from "./src/ui/telegram-privacy.tsx";
import { TelegramDevices } from "./src/ui/telegram-devices.tsx";
import { NotificationSoundLibrary, type NotificationSoundLibraryActions } from "./src/ui/notification-sound-library.tsx";
import { ReactionNotificationSettings, type ReactionNotificationActions } from "./src/ui/reaction-notification-settings.tsx";
import { NotificationDefaults, type NotificationDefaultActions } from "./src/ui/notification-defaults.tsx";
import { CacheSettings } from "./src/ui/cache-settings.tsx";
import type { MediaCollectionActions } from "./src/ui/message-content.tsx";
import { TelegramPage } from "./src/ui/telegram-page.tsx";
import "./src/ui/telegram.css";

function TelegramPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [demo, setDemo] = useState(false);
  const [auth, setAuth] = useState<Auth>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const authAction = useRef({ generation: 0, pending: false });
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listGeneration = useRef(0);
  const morePending = useRef(false);
  const loadedMultiple = useRef(false);
  const [chatError, setChatError] = useState("");
  const [list, setList] = useState<ChatList>("main");
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [revision, setRevision] = useState(0);
  const [liveRevision, setLiveRevision] = useState(0);
  useRealtime(chatChangedChannel, () => setLiveRevision((n) => n + 1));
  const loadNotificationChat = useCallback((id: string) => rpc.call("notificationChat", { id }), [rpc]);
  const [messageNotification, setMessageNotification] = useState<MessageNotification>();
  useRealtime(messageNotificationChannel, (payload) => {
    const event = messageNotificationSchema.safeParse(payload);
    if (event.success) setMessageNotification((previous) => previous?.key === event.data.key ? previous : event.data);
  });
  useEffect(() => {
    if (auth.state !== "ready" || !messageNotification) return;
    const timer = setTimeout(() => setMessageNotification(undefined), 15_000);
    return () => clearTimeout(timer);
  }, [auth.state, messageNotification]);
  useEffect(() => {
    if (auth.state !== "ready") setMessageNotification(undefined);
  }, [auth.state]);
  const deletionListener = useRef<(event: MessagesDeleted) => void>(undefined);
  useRealtime(messagesDeletedChannel, (payload) => {
    const event = messagesDeletedSchema.safeParse(payload);
    if (event.success) deletionListener.current?.(event.data);
  });
  const subscribeToDeletions = useCallback((listener: (event: MessagesDeleted) => void) => {
    deletionListener.current = listener;
    return () => { deletionListener.current = undefined; };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!authAction.current.pending) {
        const generation = authAction.current.generation;
        const isCurrent = () => alive && generation === authAction.current.generation;
        try {
          const next = await rpc.call("status", null);
          if (isCurrent()) setAuth(next);
        } catch {
          if (isCurrent()) setAuth({ state: "error", message: "Cannot reach the Telegram plugin." });
        }
      }
      if (alive) timer = setTimeout(refresh, 1500);
    }
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [rpc]);

  useEffect(() => {
    if (auth.state !== "ready") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshFolders() {
      try {
        const next = await rpc.call("folders", null);
        if (alive) {
          setFolders(next);
          setList((previous) => typeof previous === "number" && !next.some(({ id }) => id === previous) ? "main" : previous);
        }
      } finally {
        if (alive) timer = setTimeout(() => void refreshFolders().catch(() => {}), 5000);
      }
    }
    void refreshFolders().catch(() => {});
    return () => { alive = false; clearTimeout(timer); };
  }, [auth.state, rpc]);

  useEffect(() => {
    listGeneration.current++;
    morePending.current = false;
    loadedMultiple.current = false;
    setChats([]);
    setNextOffset(null);
    setLoadingMore(false);
  }, [auth.state, list]);

  useEffect(() => {
    if (auth.state !== "ready") return;
    let alive = true;
    setLoading(true);
    setChatError("");
    void rpc.call("chatPage", { list, offset: 0 }).then(
      (page) => {
        if (!alive) return;
        if (!loadedMultiple.current && !morePending.current) setNextOffset(page.nextOffset);
        setChats((previous) => {
          if (!loadedMultiple.current) return page.chats;
          const updated = new Map(page.chats.map((chat) => [chat.id, chat]));
          // Keep already loaded pages and the open chat in place.
          return [...page.chats, ...previous.filter((chat) => !updated.has(chat.id))];
        });
      },
      () => { if (alive) setChatError("Could not load Telegram chats. Try refreshing."); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [auth.state, list, revision, liveRevision, rpc]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || morePending.current) return;
    const request = listGeneration.current;
    morePending.current = true;
    setLoadingMore(true);
    setChatError("");
    try {
      const page = await rpc.call("chatPage", { list, offset: nextOffset });
      if (listGeneration.current !== request) return;
      loadedMultiple.current = true;
      setChats((previous) => {
        const merged = new Map(previous.map((chat) => [chat.id, chat]));
        for (const chat of page.chats) merged.set(chat.id, chat);
        return [...merged.values()];
      });
      setNextOffset(page.nextOffset);
    } catch {
      if (listGeneration.current === request) setChatError("Could not load more chats. Try again.");
    } finally {
      if (listGeneration.current === request) {
        morePending.current = false;
        setLoadingMore(false);
      }
    }
  }, [list, nextOffset, rpc]);

  const pinStatus = useCallback((id: string, messageId: string) => rpc.call("pinStatus", { id, messageId }), [rpc]);
  const setMessagePinned = useCallback((id: string, messageId: string, pinned: boolean) =>
    rpc.call("setMessagePinned", { id, messageId, pinned }), [rpc]);
  const loadPinned = useCallback((id: string) => rpc.call("pinnedMessage", { id }), [rpc]);
  const resolveMessageLink = useCallback((url: string) => rpc.call("resolveMessageLink", { url }), [rpc]);
  const [contactsRevision, setContactsRevision] = useState(0);
  const senderBlockActions = useMemo<SenderBlockActions>(() => ({
    load: (id: string) => rpc.call("senderBlockState", { id }),
    change: (id, expected, next) => rpc.call("setSenderBlockState", { id, expected, next }),
  }), [rpc]);
  const contactEditor = useMemo<ContactEditorActions>(() => ({
    load: (id) => rpc.call("contactDetails", { id }),
    save: async (id, expected, names) => {
      const saved = await rpc.call("saveContact", { id, userId: expected.id, expected, names });
      if (saved) setContactsRevision((revision) => revision + 1);
      return saved;
    },
    remove: async (id, expected) => {
      const removed = await rpc.call("removeContact", { id, userId: expected.id, expected });
      if (removed) setContactsRevision((revision) => revision + 1);
      return removed;
    },
  }), [rpc]);
  const contactActions = useMemo<ContactActions>(() => ({
    load: (query, offset) => rpc.call("contacts", { query, ...(offset === undefined ? {} : { offset }) }),
    open: (id) => rpc.call("openContact", { id }),
  }), [rpc]);
  const globalSearch = useCallback((input: Parameters<GlobalSearchLoader>[0]) =>
    rpc.call("globalSearch", input), [rpc]);
  const folderActions = useMemo<FolderActions>(() => ({
    limit: () => rpc.call("folderLimit", null),
    folderUpdates: {
      load: (id) => rpc.call("newFolderChats", { id }),
      add: (id, token, ids) => rpc.call("addNewFolderChats", { id, token, ids }),
      dismiss: (id, token) => rpc.call("dismissFolderUpdates", { id, token }),
    },
    invites: {
      shareChats: (id) => rpc.call("folderShareChats", { id }),
      create: (id, name, ids) => rpc.call("createFolderInvite", { id, name, ids }),
      load: (id) => rpc.call("folderInviteLinks", { id }),
      editChats: (id, url) => rpc.call("folderInviteEditor", { id, url }),
      saveChats: (id, url, token, ids) => rpc.call("saveFolderInviteChats", { id, url, token, ids }),
      rename: (id, url, expected, name) => rpc.call("renameFolderInvite", { id, url, expected, name }),
      revoke: (id, url, name) => rpc.call("revokeFolderInvite", { id, url, name }),
    },
    tags: {
      load: () => rpc.call("folderTags", null),
      save: (enabled, expected) => rpc.call("setFolderTags", { enabled, expected }),
    },
    load: (id) => rpc.call("folderEditor", { id }),
    reorder: async (order, expected) => {
      const result = await rpc.call("reorderFolders", { order, expected });
      if (result === "saved") setFolders((previous) => {
        if (previous.length !== expected.length || previous.some(({ id }, index) => id !== expected[index])) return previous;
        const foldersById = new Map(previous.map((folder) => [folder.id, folder]));
        return order.map((id) => foldersById.get(id)!);
      });
      return result;
    },
    recommend: () => rpc.call("recommendedFolders", null),
    addRecommended: async (token) => {
      const saved = await rpc.call("addRecommendedFolder", { token });
      setFolders((previous) => previous.some(({ id }) => id === saved.id) ? previous : [...previous, saved]);
      return saved;
    },
    save: async (draft, id) => {
      const saved = await rpc.call("saveFolder", { ...draft, ...(id === undefined ? {} : { id }) });
      setFolders((previous) => previous.some((folder) => folder.id === saved.id)
        ? previous.map((folder) => folder.id === saved.id ? saved : folder) : [...previous, saved]);
      return saved;
    },
    remove: async (id, title) => {
      const removed = await rpc.call("deleteFolder", { id, title });
      if (removed) {
        setFolders((previous) => previous.filter((folder) => folder.id !== id));
        setList((previous) => previous === id ? "main" : previous);
      }
      return removed;
    },
    memberships: (chatId) => rpc.call("folderMemberships", { chatId }),
    setMembership: (id, chatId, mode) => rpc.call("setFolderMembership", { id, chatId, mode }),
  }), [rpc]);
  const findChats = useCallback((query: string, list: ChatList) => rpc.call("search", { query, list }), [rpc]);
  const reactionNotificationActions = useMemo<ReactionNotificationActions>(() => ({
    load: () => rpc.call("reactionNotifications", null),
    save: (values, expected) => rpc.call("saveReactionNotifications", { values, expected }),
  }), [rpc]);
  const notificationDefaults = useMemo<NotificationDefaultActions>(() => ({
    load: (scope) => rpc.call("scopeNotifications", { scope }),
    save: (scope, values, expected) => rpc.call("saveScopeNotifications", { scope, values, expected }),
  }), [rpc]);
  const notificationSoundLibrary = useMemo<NotificationSoundLibraryActions>(() => ({
    load: () => rpc.call("savedNotificationSounds", null),
    preview: (id) => rpc.call("previewNotificationSound", { id }),
    add: (base64) => rpc.call("addNotificationSound", { base64 }),
    remove: (id) => rpc.call("removeNotificationSound", { id }),
  }), [rpc]);
  const chatNotificationState = useCallback((id: string, topicId?: number) => rpc.call("chatNotificationState", { id, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const setChatNotificationOverride = useCallback((id: string, field: ChatNotificationField, value: ChatNotificationOverride, expected: ChatNotificationOverride, topicId?: number) =>
    rpc.call("setChatNotificationOverride", { id, field, value, expected, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const setChatNotificationSound = useCallback((id: string, value: string, expected: string, topicId?: number, story?: boolean) =>
    rpc.call("setChatNotificationSound", { id, value, expected, ...(topicId === undefined ? {} : { topicId }), ...(story ? { story } : {}) }), [rpc]);
  const setChatNotificationMode = useCallback((id: string, mode: ChatNotificationMode, muteFor?: ChatMutePeriod, topicId?: number) =>
    rpc.call("setChatNotificationMode", { id, mode, ...(topicId === undefined ? {} : { topicId }), ...(muteFor === undefined ? {} : { muteFor }) }), [rpc]);
  const chatPinStatus = useCallback((id: string, list: ChatList) => rpc.call("chatPinStatus", { id, list }), [rpc]);
  const setChatPinned = useCallback((id: string, list: ChatList, pinned: boolean) =>
    rpc.call("setChatPinned", { id, list, pinned }), [rpc]);
  const archiveChat = useCallback(async (id: string, archived: boolean) => {
    const generation = listGeneration.current;
    const updated = await rpc.call("archiveChat", { id, archived });
    if (generation !== listGeneration.current) {
      setRevision((n) => n + 1);
      return updated;
    }
    setChats((previous) => list === (archived ? "main" : "archive")
      ? previous.filter((chat) => chat.id !== id)
      : previous.map((chat) => chat.id === id ? updated : chat));
    if (list === "main" || list === "archive") {
      listGeneration.current++;
      morePending.current = false;
      loadedMultiple.current = false;
      setNextOffset(null);
      setLoadingMore(false);
    }
    setRevision((n) => n + 1);
    return updated;
  }, [list, rpc]);
  const previewFolderInvite = useCallback((url: string) => rpc.call("previewFolderInvite", { url }), [rpc]);
  const importFolderInvite = useCallback((url: string, token: string, ids: string[]) =>
    rpc.call("importFolderInvite", { url, token, ids }), [rpc]);
  const previewInvite = useCallback((url: string) => rpc.call("previewInvite", { url }), [rpc]);
  const joinInvite = useCallback((url: string, expected: InviteTarget) => rpc.call("joinInvite", { url, expected }), [rpc]);
  const joinChat = useCallback((id: string, name: string) => rpc.call("joinChat", { id, name }), [rpc]);
  const postingPermissions = useCallback((id: string) => rpc.call("postingPermissions", { id }), [rpc]);
  const markActivityRead = useCallback((id: string, filter: import("./src/core/contract.ts").UnreadActivityFilter, topicId?: number) =>
    rpc.call("markActivityRead", { id, filter, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const markChat = useCallback(async (id: string, unread: boolean) => {
    const updated = await rpc.call("markChat", { id, unread });
    setChats((before) => before.map((chat) => chat.id === id ? {
      ...chat, unread: updated.unread, markedUnread: updated.markedUnread,
    } : chat));
    return updated;
  }, [rpc]);
  const loadMedia = useCallback(async (id: string, messageId: string, signal: AbortSignal, oneView?: true) => {
    const { url } = await rpc.call("document", oneView ? { id, messageId, oneView } : { id, messageId, playback: true });
    const response = await fetch(url, { credentials: "same-origin", signal });
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !Number.isSafeInteger(size) || size < 1 || size > maxPlaybackBytes) {
      await response.body?.cancel();
      throw new Error("Telegram media is unavailable.");
    }
    const data = await response.blob();
    if (data.size !== size) throw new Error("Telegram media is incomplete.");
    return data;
  }, [rpc]);
  const transcribeVoice = useCallback((id: string, messageId: string) => rpc.call("transcribeVoice", { id, messageId }), [rpc]);
  const loadVideoStream = useCallback((id: string, messageId: string) => rpc.call("videoStream", { id, messageId }), [rpc]);
  const loadLinkedStickerPack = useCallback((url: string, offset = 0) => rpc.call("linkedStickerPack", { url, offset }), [rpc]);
  const installLinkedStickerPack = useCallback((url: string, packId: string) => rpc.call("installLinkedStickerPack", { url, packId }), [rpc]);
  const mediaCollection = useMemo<MediaCollectionActions>(() => ({
    loadPack: (id, messageId, offset) => rpc.call("messageStickerPack", { id, messageId, offset }),
    installPack: (id, messageId, packId) => rpc.call("installMessageStickerPack", { id, messageId, packId }),
    load: (id, messageId, kind) => rpc.call("mediaCollectionState", { id, messageId, kind }),
    save: (id, messageId, kind, saved, expected) => rpc.call("setMediaCollection", { id, messageId, kind, saved, expected }),
  }), [rpc]);
  const mediaComposer = useCallback((id: string, topic?: ForumTopicTarget, reply?: MediaReply) => ({
    choices: (kind: "sticker" | "gif") => rpc.call("mediaChoices", kind),
    searchGifs: (query: string) => rpc.call("searchGifs", { id, query, ...(topic ? { topic } : {}) }),
    sendFoundGif: async (token: string, delivery?: MediaDelivery) => (await rpc.call("sendFoundGif", { id, token, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}) })).state,
    stickerPacks: () => rpc.call("installedStickerPacks", null),
    reorderStickerPacks: (order: string[], expected: string[]) => rpc.call("reorderStickerPacks", { order, expected }),
    stickerPackPage: (packId: string, offset: number) => rpc.call("stickerPackPage", { packId, offset }),
    searchStickers: (stickerQuery: string) => rpc.call("mediaChoices", { stickerQuery }),
    sendChoice: async (kind: "sticker" | "gif", fileId: number, stickerQuery?: string, packId?: string, delivery?: MediaDelivery, gif?: import("./src/core/contract.ts").GifSendOptions) =>
      (await rpc.call("sendMediaChoice", { id, kind, fileId, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}),
        ...(stickerQuery === undefined ? {} : { stickerQuery }), ...(packId === undefined ? {} : { packId }), ...(gif ? { gif } : {}) })).state,
    sendAlbum: (caption: string, photos: string[], delivery?: MediaDelivery, options?: import("./src/core/contract.ts").MediaSendOptions) =>
      rpc.call("sendPhotoAlbum", { id, caption, photos, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}),
        ...(delivery ? { delivery } : {}), ...(options ? { options } : {}) }),
    sendVideoNote: async (base64: string, format: "webm" | "mp4", delivery?: MediaDelivery) =>
      (await rpc.call("sendVideoNote", { id, base64, format, ...(topic ? { topic } : {}),
        ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}) })).state,
    sendVoice: async (base64: string, duration: number, format: "ogg" | "webm" | "mp4", delivery?: MediaDelivery) => (await rpc.call("sendVoice", { id, base64, duration, format, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}) })).state,
  }), [rpc]);
  const saveDocument = useCallback(async (id: string, messageId: string) => {
    const { name, url } = await rpc.call("document", { id, messageId });
    return await experimental_saveFile({ fileName: name, url }) === "started";
  }, [rpc]);
  const avatars = useRef(new Map<string, Promise<TelegramPhoto>>());
  useEffect(() => { if (auth.state !== "ready") avatars.current.clear(); }, [auth.state]);
  const loadAvatar = useCallback((id: string, fileId: number, user?: boolean) => {
    const key = `${user === true}:${id}:${fileId}`;
    const cache = avatars.current;
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    const pending = rpc.call("avatar", user ? { id, fileId, user } : { id, fileId }).catch((error) => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }, [rpc]);
  const loadPhoto = useCallback((id: string, messageId: string, size?: PhotoSize) => rpc.call("photo", size === undefined ? { id, messageId } : { id, messageId, size }), [rpc]);
  const loadMessageLink = useCallback((id: string, messageId: string) => rpc.call("messageLink", { id, messageId }), [rpc]);
  const sendChannelComment = useCallback((id: string, messageId: string, group: string, root: string, text: string) =>
    rpc.call("sendChannelComment", { id, messageId, group, root, text }), [rpc]);
  const loadChannelDiscussion = useCallback((id: string, messageId: string, before?: string) =>
    rpc.call("channelDiscussion", { id, messageId, ...(before ? { before } : {}) }), [rpc]);
  const loadMessageAtDate = useCallback((id: string, date: number, topicId?: number) => rpc.call("messageAtDate", { id, date, topicId }), [rpc]);
  const loadMessageContextPage = useCallback((id: string, messageId: string, direction: import("./src/core/contract.ts").ContextDirection, topicId?: number) =>
    rpc.call("messageContextPage", { id, messageId, direction, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const loadMessageContext = useCallback((id: string, messageId: string, topicId?: number) => rpc.call("messageContext", topicId === undefined ? { id, messageId } : { id, messageId, topicId }), [rpc]);
  const searchMessages = useCallback((id: string, query: string, filter?: MessageSearchFilter, topicId?: number, before?: string, sender?: import("./src/core/contract.ts").MessageSender) =>
    rpc.call("searchMessages", { id, query, ...(filter === undefined ? {} : { filter }),
      ...(topicId === undefined ? {} : { topicId }), ...(before === undefined ? {} : { before }), ...(sender ? { sender } : {}) }), [rpc]);
  const messageViewers = useCallback((id: string, messageId: string) => rpc.call("messageViewers", { id, messageId }), [rpc]);
  const messageReadTime = useCallback((id: string, messageId: string) => rpc.call("messageReadTime", { id, messageId }), [rpc]);
  const deletionOptions = useCallback((id: string, messageId: string) => rpc.call("deletionOptions", { id, messageId }), [rpc]);
  const deleteMessage = useCallback((id: string, messageId: string, scope: DeletionScope) =>
    rpc.call("deleteMessage", { id, messageId, scope }), [rpc]);
  const forwardOptions = useCallback((id: string, messageId: string) => rpc.call("forwardOptions", { id, messageId }), [rpc]);
  const forwardMessage = useCallback((id: string, messageId: string, target: ForwardTarget) =>
    rpc.call("forwardMessage", { id, messageId, target }), [rpc]);
  const listReactions = useCallback((id: string, messageId: string) => rpc.call("listReactions", { id, messageId }), [rpc]);
  const setReaction = useCallback((id: string, messageId: string, emoji: string, chosen: boolean) =>
    rpc.call("setReaction", { id, messageId, emoji, chosen }), [rpc]);
  const sendPoll = useCallback((id: string, draft: PollDraft, topic?: ForumTopicTarget) =>
    rpc.call("sendPoll", { id, draft, topic }), [rpc]);
  const stopPoll = useCallback((id: string, messageId: string) => rpc.call("stopPoll", { id, messageId }), [rpc]);
  const voteInPoll = useCallback((id: string, messageId: string, choices: PollChoice[]) => rpc.call("voteInPoll", { id, messageId, choices }), [rpc]);
  const editCaption = useCallback((id: string, messageId: string, text: string, original: string,
    originalStyles?: import("./src/core/contract.ts").StyledRange[], styles?: import("./src/core/contract.ts").StyledRange[],
    placement?: import("./src/core/contract.ts").CaptionPlacement) =>
    rpc.call("editCaption", { id, messageId, text, original,
      ...(originalStyles ? { originalStyles } : {}), ...(styles ? { styles } : {}), ...(placement ? { placement } : {}) }), [rpc]);
  const editText = useCallback((id: string, messageId: string, text: string, original: string, originalStyles?: import("./src/core/contract.ts").StyledRange[], styles?: import("./src/core/contract.ts").StyledRange[], removeLinkPreview?: string) =>
    rpc.call("edit", { id, messageId, text, original, ...(originalStyles ? { originalStyles } : {}), ...(styles ? { styles } : {}), ...(removeLinkPreview ? { removeLinkPreview } : {}) }), [rpc]);
  const sendDocument = useCallback(async (id: string, file: File, caption: string, progress: (bytes: number, canCancel?: boolean) => void, signal: AbortSignal, topic?: ForumTopicTarget, replyTo?: string, video?: true, options?: import("./src/core/contract.ts").MediaSendOptions) => {
    const preparation = await rpc.call("prepareDocumentUpload", { id, name: file.name.slice(0, 255), caption, size: file.size, ...(topic ? { topic } : {}), ...(replyTo ? { replyTo } : {}), ...(video ? { video } : {}), ...(video && options ? { options } : {}) });
    if ("rejection" in preparation) return { state: "failed" as const, uploadRejection: preparation.rejection };
    const { url } = preparation;
    async function cancelUpload() {
      const response = await fetch(url, {
        method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      return response.ok ? { state: "cancelled" as const } : { state: "unknown" as const };
    }
    for (let offset = 0; offset < file.size;) {
      if (signal.aborted) return cancelUpload();
      const slice = file.slice(offset, offset + 512 * 1024);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      }
      const body = JSON.stringify({ offset, base64: btoa(binary) });
      const finalChunk = offset + slice.size === file.size;
      if (signal.aborted) return cancelUpload();
      if (finalChunk) progress(offset, false);
      const post = async () => {
        const response = await fetch(url, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body,
        });
        return { ok: response.ok, payload: await response.json() };
      };
      let reply = await post().catch(() => undefined);
      if (!reply || reply.payload?.retry === true) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (signal.aborted && !finalChunk) return cancelUpload();
        reply = await post().catch(() => undefined);
      }
      if (!reply) return { state: "unknown" as const };
      const { ok, payload } = reply;
      const result = schemas.sendDocument.output.safeParse(payload);
      if (result.success) {
        if (result.data.state === "sent") progress(file.size);
        return result.data;
      }
      offset += slice.size;
      if (!ok || payload?.received !== offset) return { state: "unknown" as const };
      progress(offset, !finalChunk);
    }
    return waitForDocumentDelivery(url);
  }, [rpc]);
  const sendPhoto = useCallback((id: string, caption: string, base64: string, topic?: ForumTopicTarget, replyTo?: string,
    options?: import("./src/core/contract.ts").MediaSendOptions) => rpc.call("sendPhoto", {
      id, caption, base64, ...(topic ? { topic } : {}), ...(replyTo ? { replyTo } : {}), ...(options ? { options } : {}),
    }), [rpc]);
  const sendText = useCallback((id: string, text: string, replyTo?: string, delivery?: import("./src/core/contract.ts").TextDelivery) =>
    rpc.call("send", { id, text, ...(replyTo === undefined ? {} : { replyTo }), ...(delivery ? { delivery } : {}) }), [rpc]);
  const loadTopicDraft = useCallback((id: string, topicId: number) => rpc.call("topicDraft", { id, topicId }), [rpc]);
  const saveChatDraft = useCallback((id: string, text: string, expected: string | null, topicId?: number) =>
    rpc.call("saveChatDraft", { id, text, expected, topicId }), [rpc]);
  const loadChatEvents = useCallback((id: string, query: string, cursor?: string) =>
    rpc.call("chatEvents", { id, query, ...(cursor ? { cursor } : {}) }), [rpc]);
  const channelSignatureActions = useMemo<ChannelSignatureActions>(() => ({
    load: (id) => rpc.call("channelSignatures", { id }),
    save: (id, values, expected) => rpc.call("saveChannelSignatures", { id, values, expected }),
  }), [rpc]);
  const chatInfoActions = useMemo<ChatInfoActions>(() => ({
    load: (id) => rpc.call("chatInfo", { id }),
    removePhoto: (id, expected) => rpc.call("removeChatPhoto", { id, expected }),
    savePhoto: (id, base64, expected) => rpc.call("saveChatPhoto", { id, base64, expected }),
    save: (id, change) => rpc.call("saveChatInfo", { id, ...change }),
  }), [rpc]);
  const loadChatAutoDelete = useCallback((id: string) => rpc.call("chatAutoDelete", { id }), [rpc]);
  const saveChatAutoDelete = useCallback((id: string, days: number, expected: number) =>
    rpc.call("saveChatAutoDelete", { id, days, expected }), [rpc]);
  const slowModeActions = useMemo<SlowModeActions>(() => ({
    load: (id) => rpc.call("groupSlowMode", { id }),
    save: (id, delay, expected) => rpc.call("saveGroupSlowMode", { id, delay, expected }),
  }), [rpc]);
  const groupPermissionActions = useMemo<GroupPermissionActions>(() => ({
    load: (id) => rpc.call("groupPermissions", { id }),
    save: (id, changes) => rpc.call("saveGroupPermissions", { id, changes }),
  }), [rpc]);
  const joinRequestActions = useMemo<JoinRequestActions>(() => ({
    load: (id, query, cursor) => rpc.call("joinRequests", { id, query, ...(cursor ? { cursor } : {}) }),
    review: (id, userId, approve) => rpc.call("reviewJoinRequest", { id, userId, approve }),
  }), [rpc]);
  const chatInviteActions = useMemo<ChatInviteActions>(() => ({
    load: (id, cursor) => rpc.call("managedInvites", { id, ...(cursor ? { cursor } : {}) }),
    create: (id, draft) => rpc.call("createManagedInvite", { id, draft }),
    revoke: (id, link) => rpc.call("revokeManagedInvite", { id, link }),
  }), [rpc]);
  const loadChatMembers = useCallback((id: string, query: string, offset?: number) =>
    rpc.call("chatMembers", { id, query, ...(offset === undefined ? {} : { offset }) }), [rpc]);
  const canScheduleWhenOnline = useCallback((id: string) => rpc.call("canScheduleWhenOnline", { id }), [rpc]);
  const scheduledMessages = useCallback((id: string, topicId?: number) =>
    rpc.call("scheduledMessages", { id, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const changeScheduledMessage = useCallback((id: string, row: import("./src/core/contract.ts").ScheduledMessage, at: number | null, topicId?: number) =>
    rpc.call("changeScheduledMessage", { id, expected: row, at, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const cancelScheduledMessage = useCallback((id: string, messageId: string, topicId?: number) =>
    rpc.call("cancelScheduledMessage", { id, messageId, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const loadHistory = useCallback((id: string, before?: string) => rpc.call("history", before === undefined ? { id } : { id, before }), [rpc]);
  const manageForumTopic = useCallback((id: string, action: ForumTopicAction) =>
    rpc.call("manageForumTopic", { id, action }), [rpc]);
  const loadForumTopicPage = useCallback((id: string, query: string, cursor?: NonNullable<ForumTopicPage["next"]>) =>
    rpc.call("forumTopicPage", { id, query, ...(cursor ? { cursor } : {}) }), [rpc]);
  const loadForumTopics = useCallback((id: string, query: string) => rpc.call("forumTopics", { id, query }), [rpc]);
  const sendTopicText = useCallback((id: string, topic: ForumTopicTarget, text: string, replyTo?: string, styles?: import("./src/core/contract.ts").StyledRange[], quote?: import("./src/core/contract.ts").ReplyQuote, delivery?: import("./src/core/contract.ts").TopicDelivery) =>
    rpc.call("sendTopicText", { id, topic, text, ...(replyTo === undefined ? {} : { replyTo }), ...(styles ? { styles } : {}), ...(quote ? { quote } : {}), ...(delivery ? { delivery } : {}) }), [rpc]);
  const loadTopicHistory = useCallback((id: string, topicId: number, before?: string) => rpc.call("history", before === undefined ? { id, topicId } : { id, topicId, before }), [rpc]);

  const readRuntime = useCallback(() => rpc.call("runtimeInfo", null), [rpc]);
  const canScheduleRepeats = useCallback(async () => (await readRuntime()).premium === true, [readRuntime]);
  const readCache = useCallback(() => rpc.call("cacheInfo", null), [rpc]);
  const setCacheLimit = useCallback((limitMiB: number) => rpc.call("setCacheLimit", { limitMiB }), [rpc]);
  const clearCache = useCallback(() => rpc.call("clearCache", null), [rpc]);
  const readAgentAccess = useCallback(() => rpc.call("agentAccess", null), [rpc]);
  const changeAgentAccess = useCallback((capability: Exclude<keyof AgentAccess, "history">, enabled: boolean) => rpc.call("setAgentAccess", { capability, enabled }), [rpc]);
  const chatAgentAccess = useCallback((id: string) => rpc.call("chatAgentAccess", { id }), [rpc]);
  const setChatAgentAccess = useCallback((id: string, enabled: boolean) => rpc.call("setChatAgentAccess", { id, enabled }), [rpc]);

  async function runAuthAction(action: () => Promise<Auth>) {
    if (authAction.current.pending) return;
    authAction.current = { generation: authAction.current.generation + 1, pending: true };
    setBusy(true);
    setNotice("");
    try { setAuth(await action()); }
    finally {
      authAction.current.pending = false;
      setBusy(false);
    }
  }

  async function disconnect() {
    await runAuthAction(async () => {
      const next = await rpc.call("disconnect", null);
      setPassword("");
      return next;
    });
  }

  async function signOut() {
    await runAuthAction(async () => {
      const next = await rpc.call("signOut", null);
      setPassword("");
      setList("main");
      return next;
    });
  }

  async function connect() {
    try { await runAuthAction(() => rpc.call("connect", null)); }
    catch { setNotice("Could not start Telegram sign-in."); }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    const value = password;
    setPassword("");
    try { await runAuthAction(() => rpc.call("password", { password: value })); }
    catch { setNotice("Telegram did not accept the password. Try again."); }
  }

  const profileActions = useMemo<ProfileActions>(() => ({
    load: () => rpc.call("telegramProfile", null),
    removePhoto: (expected) => rpc.call("removeProfilePhoto", { expected }),
    savePhoto: (base64, expected) => rpc.call("saveProfilePhoto", { base64, expected }),
    check: (username) => rpc.call("checkTelegramUsername", { username }),
    save: (change) => rpc.call("saveTelegramProfile", change),
  }), [rpc]);
  const privacyActions = useMemo<TelegramPrivacyActions>(() => ({
    blockedSenders: {
      load: (list, offset) => rpc.call("blockedSenders", { list, offset }),
      open: (sender) => rpc.call("openBlockedSender", { sender }),
      unblock: (sender, list) => rpc.call("unblockListedSender", { sender, list }),
    },
    load: (key) => rpc.call("telegramPrivacy", { key }),
    defaultAutoDelete: {
      load: async () => ({ days: await rpc.call("defaultAutoDeleteDays", null), editable: true }),
      save: (days, expected) => rpc.call("saveDefaultAutoDeleteDays", { days, expected }),
    },
    archiveSettings: {
      load: () => rpc.call("archiveSettings", null),
      save: (values, expected) => rpc.call("saveArchiveSettings", { values, expected }),
    },
    loadReadDate: () => rpc.call("readDatePrivacy", null),
    saveReadDate: (show, expected) => rpc.call("saveReadDatePrivacy", { show, expected }),
    save: (key, audience, expected) => rpc.call("saveTelegramPrivacy", { key, audience, expected }),
  }), [rpc]);
  const loadActiveDevices = useCallback(() => rpc.call("activeDevices", null), [rpc]);
  const terminateDevice = useCallback(({ id, application, device }: TelegramDevice) =>
    rpc.call("terminateDevice", { id, application, device }), [rpc]);

  if (demo) return <div className="mtg-demo-host"><button className="mtg-action" type="button" onClick={() => setDemo(false)}>Back to sign-in</button><TelegramPage /></div>;
  if (auth.state === "ready") return <TelegramPage live={{ chats, messageNotification, loadNotificationChat, dismissMessageNotification: () => setMessageNotification(undefined), loading, error: chatError, liveRevision, chatAgentAccess, setChatAgentAccess, agentAccess: <AgentAccessPanel read={readAgentAccess} readRuntime={readRuntime} change={changeAgentAccess} disconnect={disconnect} signOut={signOut} />, settings: (openChat) => <CacheSettings read={readCache} setLimit={setCacheLimit} clear={clearCache} profile={<TelegramProfile actions={profileActions} />} privacy={(close) => <TelegramPrivacy actions={privacyActions} openChat={(chat) => { close(); openChat(chat); }} />} devices={<TelegramDevices load={loadActiveDevices} terminate={terminateDevice} />} notifications={<><NotificationDefaults actions={notificationDefaults} /><ReactionNotificationSettings actions={reactionNotificationActions} /><NotificationSoundLibrary actions={notificationSoundLibrary} /></>} />, loadMore: nextOffset === null ? undefined : loadMore, loadingMore, loadHistory, loadForumTopics, loadForumTopicPage, manageForumTopic, loadTopicHistory, sendTopicText, loadPinned, pinStatus, setMessagePinned, subscribeToDeletions, sendText, saveChatDraft, loadTopicDraft, loadChatMembers, chatInviteActions, joinRequestActions, channelSignatureActions, groupPermissionActions, chatInfoActions, loadChatAutoDelete, saveChatAutoDelete, slowModeActions, loadChatEvents, canScheduleWhenOnline, canScheduleRepeats, scheduledMessages, changeScheduledMessage, cancelScheduledMessage, sendPhoto, sendDocument, sendPoll, forwardOptions, forwardMessage, reactionActions: { listReactions, setReaction }, stopPoll, voteInPoll, editText, editCaption, messageReadTime, messageViewers, deletionOptions, deleteMessage, searchMessages, loadMessageLink, loadMessageAtDate, loadMessageContext, loadMessageContextPage, loadChannelDiscussion, sendChannelComment, loadMedia, loadVideoStream, transcribeVoice, mediaComposer, mediaCollection, loadLinkedStickerPack, installLinkedStickerPack, saveDocument, loadPhoto, loadAvatar, markActivityRead, markChat, archiveChat, chatNotificationState, setChatNotificationSound, setChatNotificationMode, setChatNotificationOverride, chatPinStatus, setChatPinned, joinChat, previewFolderInvite, importFolderInvite, previewInvite, joinInvite, postingPermissions, findChats, globalSearch, contactActions, contactEditor, senderBlockActions, contactsRevision, resolveMessageLink, list, folders, folderActions, selectList: setList, refresh: () => setRevision((n) => n + 1) }} />;
  return <div className="mtg mtg-login">
    <section aria-labelledby="telegram-sign-in">
      <h1 id="telegram-sign-in">Connect Telegram</h1>
      {auth.state === "qr" && <>
        <p>On your phone, open Telegram → Settings → Devices → Link Desktop Device, then scan this code.</p>
        <QRCodeSVG value={auth.link} size={208} level="M" marginSize={4} role="img" aria-label="Telegram sign-in QR code" />
        <p role="status">Waiting for confirmation on your phone…</p>
      </>}
      {auth.state === "password" && <form onSubmit={submitPassword}>
        <label>Telegram two-step verification password
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button type="submit" className="mtg-action" disabled={busy || !password}>Unlock</button>
      </form>}
      {auth.state === "connecting" && <p role="status">Connecting to Telegram…</p>}
      {auth.state === "disconnecting" && <p role="status">Disconnecting Telegram…</p>}
      {(auth.state === "qr" || auth.state === "password" || auth.state === "connecting") &&
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void disconnect().catch(() => setNotice("Could not disconnect Telegram."))}>Cancel connection</button>}
      {auth.state === "error" && <p role="alert">{auth.message}</p>}
      {notice && <p role="alert">{notice}</p>}
      {(auth.state === "idle" || auth.state === "error") && <div className="mtg-login-actions">
        <button type="button" className="mtg-action" onClick={() => void connect()} disabled={busy}>Connect Telegram</button>
        <button type="button" className="mtg-action" onClick={() => setDemo(true)}>Open demo</button>
      </div>}
    </section>
  </div>;
}

function PendingAgentRead({ interaction, submit, cancel }: import("@get-bb/plugin-sdk/app").PluginPendingInteractionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback((requestId: string, id: string) => rpc.call("readPreview", { requestId, id }), [rpc]);
  return <AgentReadApproval key={interaction.id} payload={interaction.payload} expiresAt={interaction.expiresAt} submit={submit} cancel={cancel} load={load} />;
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: readRenderer,
    component: PendingAgentRead,
  });
  app.slots.pendingInteraction({
    id: approvalRenderer,
    component: ({ interaction, submit, cancel }) => <AgentSendApproval key={interaction.id} payload={interaction.payload} expiresAt={interaction.expiresAt} submit={submit} cancel={cancel} />,
  });
  app.slots.navPanel({
    id: "telegram", title: "Telegram", icon: "MessagesSquare", path: "telegram", component: TelegramPanel,
  });
});
