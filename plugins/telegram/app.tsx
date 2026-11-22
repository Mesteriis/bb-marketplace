import { TelegramEmbedOverlay } from "./src/adapters/bb/embed-overlay.tsx";
import { showDesktopMessageNotice, telegramWindowInBackground } from "./src/adapters/bb/desktop-message-notices.ts";
import { useTelegramAiTransfer } from "./src/adapters/bb/ai-transfer.ts";
import { TelegramAiTransfer } from "./src/ui/ai-transfer.tsx";
import { useTelegramLocale } from "./src/ui/i18n/index.tsx";
import { historyMessageChangedChannel, historyMessageChangedEvent, type HistoryMessageChanged } from "./src/core/contract.ts";
import { HistoryMessageUpdates } from "./src/ui/history-message-updates.ts";
import { ContactPhotoSuggestionActions } from "./src/ui/contact-photo-suggestion.tsx";
import { AcceptContactBirthday, type AcceptBirthday } from "./src/ui/contact-birthday-suggestion.tsx";
import { channelInboxMessageChannel, channelInboxMessageEvent, channelInboxTopicsChanged, channelInboxTopicsChangedChannel, type ChannelInboxMessageEvent } from "./src/core/contract.ts";
import { PhotoTextRecognition } from "./src/ui/photo-text.tsx";
import { PreparePhotoFileDrag } from "./src/ui/photo-file-drag.tsx";
import type { MessageDoubleClick } from "./src/ui/message-double-click.ts";
import { PollStickerActions } from "./src/ui/poll-stickers.tsx";
import { PollFileUpload } from "./src/ui/poll-composer.tsx";
import { downloadActivityChannel, downloadActivityEvent, downloadProgressChannel, downloadProgressEvent, type DownloadQueueCounts, type DownloadQueueProgress } from "./src/core/contract.ts";
import { AutomaticPlaybackSettings } from "./src/ui/automatic-playback.tsx";
import { omitUndefinedRpcFields } from "./src/adapters/bb/rpc-wire.ts";
import { LoadBotWidgetPreview } from "./src/ui/bot-widget-preview.tsx";
import { PollFileActions, LoadPollPhoto, LoadMessagePreviewCover, LoadMessagePreviewPlayback, PurchasePaidMedia } from "./src/ui/message-content.tsx";
import type { MessageLinkTarget } from "./src/core/contract.ts";
import { MiniAppSessionActions } from "./src/ui/mini-app.tsx";
import { miniAppClosedChannel, miniAppClosedEvent } from "./src/core/contract.ts";
import { InlineMiniApps, type InlineMiniAppActions } from "./src/ui/inline-bot-keyboard.tsx";
import { preparePhoto, preparedPhotoBlob } from "./src/ui/prepare-photo.ts";
import { decodeAvatar } from "./src/ui/avatar.tsx";
import { RetryMessageDelivery } from "./src/ui/message-delivery.tsx";
import { chatActivityChannel, chatActivitySchema, groupOnlineChannel, groupOnlineEvent, type GroupOnlineEvent, peerPresenceChannel, peerPresenceEvent, type PeerPresenceEvent, type ChatActivity } from "./src/core/contract.ts";
import { InlineBotDestinations, PressInlineBotButton, type LoadInlineBotProfile } from "./src/ui/inline-bot-keyboard.tsx";
import type { InlineBotButton } from "./src/core/contract.ts";
import type { ChatReactionActions } from "./src/ui/chat-reaction-settings.tsx";
import type { ContactEditorActions } from "./src/ui/contact-editor.tsx";
import type { ContactActions } from "./src/ui/contact-results.tsx";
import type { ChannelSignatureActions } from "./src/ui/channel-signatures.tsx";
import type { ChatInfoActions } from "./src/ui/chat-info.tsx";
import type { SlowModeActions } from "./src/ui/group-slow-mode.tsx";
import type { GroupModerationActions } from "./src/ui/group-moderation-setting.tsx";
import type { GroupPermissionActions } from "./src/ui/group-permissions.tsx";
import type { JoinRequestActions } from "./src/ui/chat-join-requests.tsx";
import type { ChatInviteActions } from "./src/ui/chat-invites.tsx";
import type { FolderActions } from "./src/ui/folder-settings.tsx";
import type { GlobalSearchLoader } from "./src/ui/global-search.tsx";
import { definePluginApp, experimental_saveFile, experimental_useSidebarThreads, useRealtime, useRpc, useSettings, useBbNavigate, type PluginNavPanelProps, type PluginPendingInteractionProps, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { InstantViewJoin, type InstantViewJoinActions } from "./src/ui/instant-view.tsx";
import { type ComponentType, type ContextType, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { TelegramLocaleProvider, resolveTelegramLanguage } from "./src/ui/i18n/index.tsx";
import type { rpcContract } from "./server.ts";
import { communityChangedChannel, contactBirthdaysChangedChannel, storyDeletedChannel, storyFeedChangedChannel, storyStealthChangedChannel, storyStealthTimes, type StoryStealthTimes, storyReference, type StoryReference, chatChangedChannel, deviceSignInsChangedChannel, messageNotificationChannel, canRefreshMessageNotification, messageNotificationDelivery, type MessageNotification, type ChatExportOptions, type LocationPoint, type TranslationLanguage, type ContactDraft, type MessagePinMode, type UnreadListCount, messagesDeletedChannel, messagesDeletedSchema, maxPlaybackBytes, schemas, type PollChoice, type PollDraft, type PollAttachmentReference, type InviteTarget, type ForwardPresentation, type ForwardTarget, type ChatNotificationMode, type ChatMutePeriod, type ChatNotificationOverride, type ChatNotificationField, type DeletionScope, type ForumTopicPage, type ForumTopicAction, type ForumTopicTarget, type TelegramPhoto, type MessageSearchFilter, type MessagesDeleted, type MediaReply, type MediaDelivery, type AttachmentSendDelivery, type PhotoSize, type AgentAccess, type Auth, type ChatList, type FolderLayout, type TelegramFolder, type TelegramDevice } from "./src/core/contract.ts";
import { documentSender, uploadDocument, uploadPollFiles, uploadQuickReplyDocument } from "./src/adapters/bb/document-delivery-client.ts";
import type { ComposerMediaActions } from "./src/ui/media-composer.tsx";
import type { Chat } from "./src/core/demo.ts";
import { readRenderer } from "./src/core/agent-read.ts";
import { AgentReadApproval } from "./src/ui/agent-read-approval.tsx";
import { approvalRenderer } from "./src/core/agent-approval.ts";
import { AgentSendApproval } from "./src/ui/agent-send-approval.tsx";
import { AgentAccessPanel } from "./src/ui/agent-access-panel.tsx";
import { TelegramProfile, type ProfileActions } from "./src/ui/telegram-profile.tsx";
import { createAccountDrafts, type AccountDrafts } from "./src/ui/local-drafts.ts";
import { forgetConversationLocation } from "./src/ui/conversation-location.ts";
import { TelegramAccounts } from "./src/ui/telegram-accounts.tsx";
import type { SelectTelegramAccount } from "./src/core/contract.ts";
import type { SenderBlockActions } from "./src/ui/sender-block-settings.tsx";
import { TelegramPrivacy, type TelegramPrivacyActions } from "./src/ui/telegram-privacy.tsx";
import { TelegramDevices, type SessionInactivityActions } from "./src/ui/telegram-devices.tsx";
import { IncomingCallSettings, type IncomingCallSettingsActions } from "./src/ui/incoming-call-settings.tsx";
import { privateCallChangedChannel, type PrivateCallStatus } from "./src/core/contract.ts";
import type { PrivateCallControls } from "./src/ui/private-call.tsx";
import { NotificationSoundLibrary, type NotificationSoundLibraryActions } from "./src/ui/notification-sound-library.tsx";
import { ReactionNotificationSettings, type ReactionNotificationActions } from "./src/ui/reaction-notification-settings.tsx";
import { NotificationExceptions, type NotificationExceptionLoader } from "./src/ui/notification-exceptions.tsx";
import { NotificationDefaults, type NotificationDefaultActions } from "./src/ui/notification-defaults.tsx";
import type { SyncedDraft } from "./src/core/contract.ts";
import type { StoryActions } from "./src/ui/stories.tsx";
import { ProxySettings, type ProxyActions } from "./src/ui/proxy-settings.tsx";
import { BusinessBotSettings } from "./src/ui/business-bot.tsx";
import { BusinessAwaySettings } from "./src/ui/business-away.tsx";
import { BusinessGreetingSettings } from "./src/ui/business-greeting.tsx";
import { BusinessHoursSettings } from "./src/ui/business-hours.tsx";
import { BusinessLocationSettings } from "./src/ui/business-location.tsx";
import { BusinessChatLinksSettings } from "./src/ui/business-chat-links.tsx";
import { BusinessStartPageSettings } from "./src/ui/business-start-page.tsx";
import { QuickReplySettings, type QuickReplyReference, type SendQuickReply } from "./src/ui/quick-replies.tsx";
import { NetworkUsageSettings } from "./src/ui/network-usage.tsx";
import { ChatExport } from "./src/ui/chat-export.tsx";
import { AddProfileAudioAction } from "./src/ui/profile-audio.tsx";
import { MarkdownDocumentLoader } from "./src/ui/markdown-document.tsx";
import { TelegramStartup } from "./src/ui/telegram-startup.tsx";
import { TelegramQrSignIn } from "./src/ui/telegram-qr-sign-in.tsx";
import { DownloadQueue, DownloadQueueDialog, QueueDownloadAction, type DownloadQueueActions, type SubscribeToDownloadProgress } from "./src/ui/download-queue.tsx";
import { CacheSettings } from "./src/ui/cache-settings.tsx";
import { DesktopNotificationSettings, LanguageSettings, type LanguagePreference } from "./src/ui/settings-preferences.tsx";
import { defaultTranslationLanguage, telegramInterfaceLanguage } from "./src/core/contract.ts";
import { AutomaticMediaSettings } from "./src/ui/automatic-media.tsx";
import type { AutoMediaLimits, AutoMediaOverrides, AutoMediaPolicy, AutoPlaybackLimits, AutoPlaybackOverrides, AutoPlaybackPolicy } from "./src/core/contract.ts";
import { StarSubscriptions, StarTransactions } from "./src/ui/star-subscriptions.tsx";
import type { MediaCollectionActions } from "./src/ui/message-content.tsx";
import { CustomEmojiLoader } from "./src/ui/custom-emoji.tsx";
import { MessageEmojiPackActions, MessageEmojiStatusActions } from "./src/ui/message-emoji-status.tsx";
import type { CustomEmojiMedia, ReactionPersonReference, SelectableReaction, WelcomeRichComposeDraft } from "./src/core/contract.ts";
import { LoadTgsSticker } from "./src/ui/tgs-sticker.tsx";
import { LoadMessageEffect } from "./src/ui/message-effect.tsx";
import { EditRichMessage, RunRichBotCommand } from "./src/ui/rich-message.tsx";
import { LoadRichBankCard } from "./src/ui/rich-bank-card.tsx";
import { AddChecklistTask, EditChecklist, SetChecklistTask } from "./src/ui/checklist.tsx";
import { PollOptionActions } from "./src/ui/poll-options.tsx";
import { LoadPollVoteHistory } from "./src/ui/poll-vote-history.tsx";
import { LoadPollVoters } from "./src/ui/poll-voters.tsx";
import { TelegramPage, type ExternalReplyDraftActions } from "./src/ui/telegram-page.tsx";
import { TelegramDetailsOutlet, TelegramSidebarOutlet, useTelegramWorkspace, useTelegramWorkspaceMode } from "./src/adapters/bb/workspace-panels.tsx";
import "./src/ui/telegram.css";

async function prepareRichMessageFiles(draft: WelcomeRichComposeDraft, files: Blob[], signal: AbortSignal) {
  const parts: BlobPart[] = [];
  const prepared: WelcomeRichComposeDraft = [];
  for (const block of draft) {
    if (signal.aborted) return;
    if (!("size" in block)) {
      prepared.push(block);
      continue;
    }
    const file = files[parts.length];
    if (!file || (!(file instanceof File) && (block.kind !== "photo" || file.type !== "image/jpeg"))) return;
    const part = block.kind === "photo" && file instanceof File ? preparedPhotoBlob(await preparePhoto(file)) : file;
    parts.push(part);
    prepared.push({ ...block, size: part.size });
  }
  if (!signal.aborted && parts.length === files.length) return { draft: prepared, blob: new Blob(parts) };
}

// BB may remount a navigation page when the split layout changes.
const draftBuckets = new Map<string, AccountDrafts>();
const callCameraClient = globalThis.crypto?.randomUUID?.();

function TelegramPanel({ subPath }: PluginNavPanelProps) {
  const { t: tr } = useTelegramLocale();
  const navigate = useBbNavigate();
  const settingsView = subPath === "settings";
  const closeSettings = () => navigate.toPluginPanel("telegram", { replace: true });
  const { values: settingsValues } = useSettings();
  const interfaceLanguage = telegramInterfaceLanguage.safeParse(settingsValues?.language).data ?? "auto";
  const translationLanguage = defaultTranslationLanguage.safeParse(settingsValues?.defaultTranslationLanguage).data ?? "auto";
  const transport = useRpc<typeof rpcContract>();
  async function saveLanguagePreference(preference: LanguagePreference) {
    await transport.call("setLanguagePreference", preference);
  }
  const workspace = useTelegramWorkspace(settingsView);
  const { threads } = experimental_useSidebarThreads();
  const miniAppAgentThreads = useMemo(() => threads.map(({ id, displayTitle }) => ({ id, title: displayTitle })), [threads]);
  const [auth, setAuth] = useState<Auth>({ state: "idle" });
  const [checkingStatus, setCheckingStatus] = useState(true);
  const initialConnectionChecked = useRef(false);
  const [loadedConnection, setLoadedConnection] = useState<string>();
  const draftScope = auth.state === "ready" ? auth.draftScope : undefined;
  const navigationScope = auth.state === "ready" ? auth.navigationScope : undefined;
  const drafts = useMemo(() => {
    if (!draftScope) return;
    const buckets = draftBuckets;
    const existing = buckets.get(draftScope);
    if (existing) return existing;
    const storage = createAccountDrafts();
    if (buckets.size >= 16) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    buckets.set(draftScope, storage);
    return storage;
  }, [draftScope]);
  const connection = auth.state === "ready"
    ? `${auth.connectionId ?? "legacy"}:${draftScope ?? ""}`
    : undefined;
  const connectionId = auth.connectionId;
  const rpc = useMemo<PluginRpcClient<typeof rpcContract>>(() => ({
    call(method, ...args) {
      const input = omitUndefinedRpcFields(args[0]);
      if (!connectionId || method === "status" || method === "connect" || method === "accountSelection") {
        return transport.call(method, ...(args.length ? [input] as typeof args : args));
      }
      return transport.call("sessionRpc", { connectionId, method, payload: input ?? null }) as
        ReturnType<typeof transport.call<typeof method>>;
    },
  }), [connectionId, transport]);
  const [busy, setBusy] = useState(false);
  const authAction = useRef({ generation: 0, pending: false });
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const aiThreads = useMemo(() => threads.map(({ id, projectId, displayTitle }) => ({ id, projectId, name: displayTitle })), [threads]);
  const aiTransfer = useTelegramAiTransfer(rpc, aiThreads, chats);
  const [loading, setLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listGeneration = useRef(0);
  const morePending = useRef(false);
  const loadedMultiple = useRef(false);
  const [chatError, setChatError] = useState("");
  const [unreadCounts, setUnreadCounts] = useState<UnreadListCount[]>([]);
  const [messageDoubleClick, setMessageDoubleClick] = useState<MessageDoubleClick>(() => {
    try {
      const value = localStorage.getItem("makosh.telegram.messageDoubleClick");
      if (value === "reaction" || value === "off") return value;
    } catch {}
    return "reply";
  });
  useEffect(() => {
    try { localStorage.setItem("makosh.telegram.messageDoubleClick", messageDoubleClick); } catch {}
  }, [messageDoubleClick]);
  const [unreadBadgeMode, setUnreadBadgeMode] = useState<"chats" | "messages">(() => {
    try { if (localStorage.getItem("makosh.telegram.unreadMode") === "messages") return "messages"; } catch {}
    return "chats";
  });
  const [includeMuted, setIncludeMuted] = useState(() => {
    try { return localStorage.getItem("makosh.telegram.unreadMuted") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try {
      localStorage.setItem("makosh.telegram.unreadMode", unreadBadgeMode);
      localStorage.setItem("makosh.telegram.unreadMuted", String(includeMuted));
    } catch {}
  }, [unreadBadgeMode, includeMuted]);
  const unreadBadges = useMemo(() => new Map<ChatList, number>(unreadCounts.map((row) => [
    row.list, row[unreadBadgeMode]?.[includeMuted ? "total" : "unmuted"] ?? 0,
  ])), [includeMuted, unreadBadgeMode, unreadCounts]);
  const [list, setList] = useState<ChatList>("main");
  const [settledList, setSettledList] = useState<ChatList>();
  const startupListChosen = useRef(false);
  const folderLayoutKnown = useRef(false);
  const selectList = useCallback((next: ChatList) => {
    startupListChosen.current = true;
    setList(next);
  }, []);
  const [folderLayout, setFolderLayout] = useState<FolderLayout>({ folders: [] });
  const { folders, mainPosition } = folderLayout;
  const updateFolders = useCallback((change: (previous: TelegramFolder[]) => TelegramFolder[]) => {
    setFolderLayout((previous) => ({ ...previous, folders: change(previous.folders) }));
  }, []);
  const [revision, setRevision] = useState(0);
  const [liveRevision, setLiveRevision] = useState(0);
  useRealtime(chatChangedChannel, () => setLiveRevision((n) => n + 1));
  const loadNotificationChat = useCallback((id: string) => rpc.call("notificationChat", { id }), [rpc]);
  const loadChannelDirectMessages = useCallback((id: string) => rpc.call("channelDirectMessages", { id }), [rpc]);
  const inboxDeletionListeners = useRef(new Set<(event: MessagesDeleted) => void>());
  const inboxMessageListeners = useRef(new Set<(event: ChannelInboxMessageEvent) => void>());
  const inboxTopicListeners = useRef(new Set<(id: string) => void>());
  useRealtime(channelInboxMessageChannel, (payload) => {
    const event = channelInboxMessageEvent.safeParse(payload);
    if (event.success) for (const listener of inboxMessageListeners.current) listener(event.data);
  });
  useRealtime(channelInboxTopicsChangedChannel, (payload) => {
    const event = channelInboxTopicsChanged.safeParse(payload);
    if (event.success) for (const listener of inboxTopicListeners.current) listener(event.data.id);
  });
  const channelInbox = useMemo<import("./src/ui/channel-direct-messages.tsx").ChannelInboxActions>(() => ({
    loadTopics: (id, inboxId, offset) => rpc.call("channelInboxTopics", { id, inboxId, offset }),
    loadTopicsSnapshot: (id, inboxId, count, selected) => rpc.call("channelInboxTopicsSnapshot", { id, inboxId, count, selected }),
    subscribeToTopics: (listener) => {
      inboxTopicListeners.current.add(listener);
      return () => { inboxTopicListeners.current.delete(listener); };
    },
    loadHistory: (id, inboxId, topicId, before, after) => rpc.call("channelInboxHistory", { id, inboxId, topicId, before, after }),
    loadMessage: (id, inboxId, topicId, messageId) => rpc.call("channelInboxMessage", { id, inboxId, topicId, messageId }),
    editText: (id, inboxId, topicId, edit) => rpc.call("editChannelInboxText", { id, inboxId, topicId, ...edit }),
    editCaption: (id, inboxId, topicId, edit) => rpc.call("editChannelInboxCaption", { id, inboxId, topicId, ...edit }),
    subscribeToMessages: (listener) => {
      inboxMessageListeners.current.add(listener);
      return () => { inboxMessageListeners.current.delete(listener); };
    },
    subscribeToDeletions: (listener) => {
      inboxDeletionListeners.current.add(listener);
      return () => { inboxDeletionListeners.current.delete(listener); };
    },
    search: (id, inboxId, topicId, query, before, range, filter) =>
      rpc.call("searchChannelInboxMessages", { id, inboxId, topicId, query, before, range, filter }),
    messageAtDate: (id, inboxId, topicId, date) => rpc.call("channelInboxMessageAtDate", { id, inboxId, topicId, date }),
    loadMessageContext: (id, inboxId, topicId, messageId, direction) => rpc.call("channelInboxMessageContext", { id, inboxId, topicId, messageId, direction }),
    mark: (id, inboxId, topicId, unread) => rpc.call("markChannelInboxTopic", { id, inboxId, topicId, unread }),
    markVisible: (id, inboxId, topicId, messageId, clearUnreadMark) =>
      rpc.call("markVisibleChannelInboxMessage", { id, inboxId, topicId, messageId, clearUnreadMark }),
    loadBan: (id, inboxId, topicId) => rpc.call("channelInboxBan", { id, inboxId, topicId }),
    changeBan: (id, inboxId, topicId, expected) => rpc.call("changeChannelInboxBan", { id, inboxId, topicId, expected }),
    clearByDate: (id, inboxId, topicId, range) => rpc.call("clearChannelInboxByDate", { id, inboxId, topicId, range }),
    clearConversation: (id, inboxId, topicId) => rpc.call("clearChannelInboxConversation", { id, inboxId, topicId }),
    messageDeletable: (id, inboxId, topicId, messageId) => rpc.call("channelInboxMessageDeletable", { id, inboxId, topicId, messageId }),
    messagePinStatus: (id, inboxId, topicId, messageId) => rpc.call("channelInboxMessagePinStatus", { id, inboxId, topicId, messageId }),
    setMessagePinned: (id, inboxId, topicId, messageId, pinned) => rpc.call("setChannelInboxMessagePinned", { id, inboxId, topicId, messageId, pinned }),
    bulkUnpinPreview: (id, inboxId, topicId) => rpc.call("channelInboxBulkUnpinPreview", { id, inboxId, topicId }),
    bulkUnpin: (id, inboxId, topicId, messageId) => rpc.call("unpinChannelInboxMessages", { id, inboxId, topicId, messageId }),
    deleteMessage: (id, inboxId, topicId, messageId) => rpc.call("deleteChannelInboxMessage", { id, inboxId, topicId, messageId }),
    deleteSelection: {
      available: (scope) => rpc.call("channelInboxSelectionDeletable", scope),
      remove: (scope) => rpc.call("deleteChannelInboxSelection", scope),
    },
    runRichBotCommand: (id, inboxId, topicId, messageId, command) =>
      rpc.call("runChannelInboxRichBotCommand", { id, inboxId, topicId, messageId, command }),
    sendText: (id, inboxId, topicId, text, replyTo, format) =>
      rpc.call("sendChannelInboxText", { id, inboxId, topicId, text, replyTo, format }),
    sendVoice: (id, inboxId, topicId, { base64, duration, format, trim }, replyTo) =>
      rpc.call("sendChannelInboxVoice", { id, inboxId, topicId, base64, duration, format, trim, replyTo }),
    sendVideoNote: (id, inboxId, topicId, { base64, format }, replyTo) =>
      rpc.call("sendChannelInboxVideoNote", { id, inboxId, topicId, base64, format, replyTo }),
    copySelectedText: (scope, format) => rpc.call("copyChannelInboxSelection", { ...scope, includeHtml: format ?? true }),
    saveSelectedAttachments: async (scope, format) => {
      const { name, url } = await rpc.call("saveChannelInboxAttachments", { ...scope, format });
      return await experimental_saveFile({ fileName: name, url }) === "started";
    },
    forwarding: {
      options: (scope, album) => rpc.call("channelInboxForwardOptions", { ...scope, album }),
      send: (scope, target, album, presentation, delivery, comment) =>
        rpc.call("forwardChannelInboxMessage", { ...scope, target, album, presentation, delivery, comment }),
      selection: {
        options: (scope) => rpc.call("channelInboxForwardSelectionOptions", scope),
        send: (scope, target, presentation, delivery, comment) =>
          rpc.call("forwardChannelInboxSelection", { ...scope, target, presentation, delivery, comment }),
      },
    },
    reactions: {
      list: (scope) => rpc.call("channelInboxReactions", scope),
      set: (scope, reaction, chosen) => rpc.call("setChannelInboxReaction", { ...scope, reaction, chosen }),
      people: (scope, reaction, offset) => rpc.call("channelInboxReactionPeople", { ...scope, reaction, offset }),
      person: (scope, target) => rpc.call("channelInboxReactionPerson", { ...scope, target }),
    },
    mediaPicker: {
      choices: (kind, stickerQuery) => rpc.call("mediaChoices", stickerQuery ? { stickerQuery } : kind),
      packs: () => rpc.call("installedStickerPacks", null),
      packPage: (packId, offset) => rpc.call("stickerPackPage", { packId, offset }),
      send: (id, inboxId, topicId, selection, replyTo) =>
        rpc.call("sendChannelInboxMediaChoice", { id, inboxId, topicId, ...selection, replyTo }),
    },
    sendFile: async (id, inboxId, topicId, file, caption, replyTo, progress, signal, kind, captionFormat) => {
      const body = kind === "photo" ? await preparePhoto(file).then((data) => preparedPhotoBlob(data), () => undefined) : file;
      if (signal.aborted) return { state: "cancelled" };
      if (!body) return { state: "failed", uploadRejection: "media_preparation_failed" };
      const name = kind === "photo" ? "photo.jpg" : file.name.slice(0, 255);
      const prepared = await rpc.call("prepareChannelInboxDocument", { id, inboxId, topicId, name,
        caption, size: body.size, replyTo, kind, captionFormat });
      return "rejection" in prepared ? { state: "failed", uploadRejection: prepared.rejection }
        : uploadDocument(prepared.url, body, (bytes, canCancel, telegram) =>
          progress(Math.round(bytes * file.size / body.size), canCancel, telegram), signal);
    },
    sendAlbum: async (id, inboxId, topicId, files, caption, replyTo, progress, signal, captionFormat) => {
      const parts: Blob[] = [];
      const items: import("./src/core/contract.ts").ChannelInboxAlbumUpload["items"] = [];
      for (const { file, kind } of files) {
        if (signal.aborted) return { state: "cancelled" };
        if (kind === "photo") {
          const data = await preparePhoto(file).catch(() => undefined);
          if (signal.aborted) return { state: "cancelled" };
          if (!data) return { state: "failed", uploadRejection: "media_preparation_failed" };
          const photo = preparedPhotoBlob(data);
          parts.push(photo);
          items.push({ kind, size: photo.size });
        } else {
          parts.push(file);
          items.push({ kind, name: file.name.slice(0, 255), size: file.size });
        }
      }
      if (signal.aborted) return { state: "cancelled" };
      const prepared = await rpc.call("prepareChannelInboxAlbum", { id, inboxId, topicId, caption, replyTo, items, captionFormat });
      if ("rejection" in prepared) return { state: "failed", uploadRejection: prepared.rejection };
      const body = new Blob(parts);
      const total = files.reduce((bytes, { file }) => bytes + file.size, 0);
      return uploadDocument(prepared.url, body,
        (bytes, canCancel, telegram) => progress(Math.round(bytes / body.size * total), canCancel, telegram), signal);
    },
  }), [rpc]);
  const resumeConversation = useCallback((location: import("./src/core/contract.ts").ConversationLocation) =>
    rpc.call("resumeConversation", location), [rpc]);
  const [notificationState, setNotificationState] = useState<{
    connection: string;
    entries: { notice: MessageNotification; received: number; desktop: boolean }[];
  }>();
  const desktopNotices = useRef(new Map<string, Notification>());
  const [desktopNoticeTarget, setDesktopNoticeTarget] = useState<{ connection: string; notice: MessageNotification }>();
  useEffect(() => {
    if (settingsView && desktopNoticeTarget) navigate.toPluginPanel("telegram", { replace: true });
  }, [desktopNoticeTarget, navigate, settingsView]);
  const [desktopPermission, setDesktopPermission] = useState<NotificationPermission | "unsupported">(
    () => globalThis.Notification?.permission ?? "unsupported",
  );
  useEffect(() => {
    const refresh = () => setDesktopPermission(globalThis.Notification?.permission ?? "unsupported");
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const notices = notificationState?.connection === connection ? notificationState?.entries : undefined;
  const foregroundNotices = notices?.filter(({ desktop }) => !desktop).map(({ notice }) => notice) ?? [];
  const [signInRevision, setSignInRevision] = useState(0);
  const [signInNotice, setSignInNotice] = useState<{ connection: string; count: number }>();
  const [devicesReview, setDevicesReview] = useState<{ connection: string; revision: number }>();
  const pendingSignIns = connection && signInNotice?.connection === connection ? signInNotice.count : 0;
  const [quickReplyReview, setQuickReplyReview] = useState<{ connection: string; shortcut: QuickReplyReference }>();
  const openQuickReplyRequest = quickReplyReview?.connection === connection ? quickReplyReview?.shortcut : undefined;
  const openDevicesRequest = devicesReview?.connection === connection ? devicesReview?.revision : undefined;
  useRealtime(deviceSignInsChangedChannel, () => setSignInRevision((n) => n + 1));
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("pendingDeviceSignIns", null).then((count) => {
      if (active) setSignInNotice({ connection, count });
    }, () => {});
    return () => { active = false; };
  }, [connection, rpc, signInRevision]);
  function openDeviceReview() {
    if (connection) setDevicesReview((current) => ({ connection, revision: (current?.revision ?? 0) + 1 }));
  }
  function openQuickReplyReview(shortcut: QuickReplyReference) {
    if (connection) setQuickReplyReview({ connection, shortcut });
  }
  useRealtime(messageNotificationChannel, (payload) => {
    const delivery = messageNotificationDelivery.safeParse(payload);
    if (!connection || !delivery.success || delivery.data.connectionId !== connectionId) return;
    const { event } = delivery.data;
    const received = Date.now();
    const desktop = telegramWindowInBackground(document);
    setNotificationState((previous) => {
      const entries = previous?.connection === connection ? previous.entries : [];
      if ("removed" in event) return { connection, entries: entries.filter(({ notice }) => !event.removed.includes(notice.key)) };
      if ("refreshed" in event) {
        const next = event.refreshed;
        if (!entries.some(({ notice }) => canRefreshMessageNotification(notice, next))) return previous;
        return { connection, entries: entries.map((entry) => entry.notice.key === next.key ? { ...entry, notice: next } : entry) };
      }
      if (entries.some(({ notice }) => notice.key === event.key)) return previous;
      return { connection, entries: [{ notice: event, received, desktop }, ...entries].slice(0, 30) };
    });
  });
  useEffect(() => {
    const update = () => setDesktopPermission(globalThis.Notification?.permission ?? "unsupported");
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  useEffect(() => {
    const delivered = desktopNotices.current;
    return () => {
      for (const banner of delivered.values()) banner.close();
      delivered.clear();
    };
  }, [connection]);
  useEffect(() => {
    if (!connection) return;
    const delivered = desktopNotices.current;
    const available = new Set(notices?.map(({ notice }) => notice.key));
    for (const [key, banner] of delivered) {
      if (!available.has(key)) {
        banner.close();
        delivered.delete(key);
      }
    }
    for (const { notice, received, desktop } of notices ?? []) {
      if (!desktop || delivered.has(notice.key) || received + 15_000 <= Date.now()) continue;
      const title = chats.find(({ id }) => id === notice.chatId)?.name ?? "Telegram";
      const banner = showDesktopMessageNotice(notice, {
        title, fallback: tr("New message"), scope: connectionId ?? "telegram",
        open: (target) => {
          setDesktopNoticeTarget({ connection, notice: target });
        },
      });
      if (banner) delivered.set(notice.key, banner);
    }
  }, [chats, connection, connectionId, desktopPermission, notices, tr]);
  async function requestDesktopPermission() {
    if (!globalThis.Notification) return;
    try { setDesktopPermission(await Notification.requestPermission()); }
    catch { setDesktopPermission(Notification.permission); }
  }
  function dismissMessageNotification(key?: string) {
    setNotificationState((current) => current?.connection === connection && current
      ? { ...current, entries: key === undefined ? [] : current.entries.filter(({ notice }) => notice.key !== key) } : current);
  }
  useLayoutEffect(() => {
    setNotificationState(undefined);
    setSignInNotice(undefined);
    setDevicesReview(undefined);
    setUnreadCounts([]);
    setFolderLayout({ folders: [] });
    startupListChosen.current = false;
    folderLayoutKnown.current = false;
    setList("main");
  }, [connection]);
  const groupOnlineListener = useRef<((event: GroupOnlineEvent) => void) | undefined>(undefined);
  useRealtime(groupOnlineChannel, (payload) => {
    const event = groupOnlineEvent.safeParse(payload);
    if (event.success) groupOnlineListener.current?.(event.data);
  });
  const subscribeToGroupOnline = useCallback((listener: (event: GroupOnlineEvent) => void) => {
    groupOnlineListener.current = listener;
    return () => { if (groupOnlineListener.current === listener) groupOnlineListener.current = undefined; };
  }, []);
  const setOpenChatView = useCallback((id: string, view: string, open: boolean) => rpc.call("openChatView", { id, view, open }), [rpc]);
  const presenceListener = useRef<((event: PeerPresenceEvent) => void) | undefined>(undefined);
  useRealtime(peerPresenceChannel, (payload) => {
    const event = peerPresenceEvent.safeParse(payload);
    if (event.success) presenceListener.current?.(event.data);
  });
  const subscribeToPresence = useCallback((listener: (event: PeerPresenceEvent) => void) => {
    presenceListener.current = listener;
    return () => { if (presenceListener.current === listener) presenceListener.current = undefined; };
  }, []);
  const loadPeerPresence = useCallback((id: string) => rpc.call("peerPresence", { id }), [rpc]);
  const activityListeners = useRef(new Set<(activity: ChatActivity) => void>());
  useRealtime(chatActivityChannel, (payload) => {
    const event = chatActivitySchema.safeParse(payload);
    if (event.success) for (const listener of activityListeners.current) listener(event.data);
  });
  const retryMessageDelivery = useCallback((id: string, messageId: string) => rpc.call("retryFailedMessage", { id, messageId }), [rpc]);
  const setTypingActivity = useCallback((id: string, typing: boolean, topicId?: number) =>
    rpc.call("setTypingActivity", { id, typing, topicId }), [rpc]);
  const subscribeToActivity = useCallback((listener: (activity: ChatActivity) => void) => {
    activityListeners.current.add(listener);
    return () => { activityListeners.current.delete(listener); };
  }, []);
  const historyMessageListeners = useRef(new Set<(event: HistoryMessageChanged) => void>());
  const historyDeletionListeners = useRef(new Set<(event: MessagesDeleted) => void>());
  useRealtime(historyMessageChangedChannel, (payload) => {
    const event = historyMessageChangedEvent.safeParse(payload);
    if (event.success && event.data.connectionId === connectionId) {
      for (const listener of historyMessageListeners.current) listener(event.data);
    }
  });
  const historyMessageUpdates = useMemo<NonNullable<ContextType<typeof HistoryMessageUpdates>>>(() => ({
    subscribeToDeletions: (listener) => {
      historyDeletionListeners.current.add(listener);
      return () => { historyDeletionListeners.current.delete(listener); };
    },
    subscribe: (listener) => {
      historyMessageListeners.current.add(listener);
      return () => { historyMessageListeners.current.delete(listener); };
    },
    load: (id, messageId, topicId) => rpc.call("historyMessage", { id, messageId, topicId }),
  }), [rpc, connectionId]);
  const deletionListener = useRef<(event: MessagesDeleted) => void>(undefined);
  useRealtime(messagesDeletedChannel, (payload) => {
    const event = messagesDeletedSchema.safeParse(payload);
    if (!event.success || event.data.connectionId !== connectionId) return;
    deletionListener.current?.(event.data);
    for (const listener of inboxDeletionListeners.current) listener(event.data);
    for (const listener of historyDeletionListeners.current) listener(event.data);
  });
  const subscribeToDeletions = useCallback((listener: (event: MessagesDeleted) => void) => {
    deletionListener.current = listener;
    return () => { deletionListener.current = undefined; };
  }, []);
  const miniAppClosedListeners = useRef(new Set<(session: string) => void>());
  useRealtime(miniAppClosedChannel, (payload) => {
    const event = miniAppClosedEvent.safeParse(payload);
    if (event.success) for (const listener of miniAppClosedListeners.current) listener(event.data.session);
  });
  const subscribeToMiniAppClosures = useCallback((listener: (session: string) => void) => {
    miniAppClosedListeners.current.add(listener);
    return () => { miniAppClosedListeners.current.delete(listener); };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!authAction.current.pending) {
        const generation = authAction.current.generation;
        const isCurrent = () => alive && generation === authAction.current.generation;
        try {
          const next = await transport.call("status", null);
          if (isCurrent()) {
            setAuth(next);
            setCheckingStatus(false);
          }
        } catch {
          if (isCurrent()) {
            setAuth({ state: "error", message: "Cannot reach the Telegram plugin." });
            setCheckingStatus(false);
          }
        }
      }
      if (alive) timer = setTimeout(refresh, 1500);
    }
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [transport]);

  useEffect(() => {
    if (!connection) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshFolders() {
      try {
        const next = await rpc.call("folderLayout", null);
        if (alive) {
          setFolderLayout(next);
          const startup = !startupListChosen.current && next.mainPosition !== undefined;
          if (startup) startupListChosen.current = true;
          if (next.mainPosition !== undefined || next.folders.length > 0) folderLayoutKnown.current = true;
          const canCheckMembership = folderLayoutKnown.current;
          setList((previous) => {
            if (startup && (next.mainPosition ?? 0) > 0) return next.folders[0]?.id ?? "main";
            return canCheckMembership && typeof previous === "number" && !next.folders.some(({ id }) => id === previous) ? "main" : previous;
          });
        }
      } finally {
        if (alive) timer = setTimeout(() => void refreshFolders().catch(() => {}), 5000);
      }
    }
    void refreshFolders().catch(() => {});
    return () => { alive = false; clearTimeout(timer); };
  }, [connection, rpc]);

  useLayoutEffect(() => {
    listGeneration.current++;
    morePending.current = false;
    loadedMultiple.current = false;
    setSettledList(undefined);
    setChats([]);
    setNextOffset(null);
    setLoadingMore(false);
  }, [connection, list]);

  useEffect(() => {
    if (!connection) return;
    let alive = true;
    setLoading(true);
    setChatError("");
    void rpc.call("chatPage", { list, offset: 0 }).then(
      (page) => {
        if (!alive) return;
        setUnreadCounts(page.unreadCounts ?? []);
        if (!loadedMultiple.current && !morePending.current) setNextOffset(page.nextOffset);
        setChats((previous) => {
          if (!loadedMultiple.current) return page.chats;
          const updated = new Map(page.chats.map((chat) => [chat.id, chat]));
          // Keep already loaded pages and the open chat in place.
          return [...page.chats, ...previous.filter((chat) => !updated.has(chat.id))];
        });
      },
      () => { if (alive) setChatError("Could not load Telegram chats. Try refreshing."); },
    ).finally(() => {
      if (alive) {
        setSettledList(list);
        setLoadedConnection(connection);
        setLoading(false);
      }
    });
    return () => { alive = false; };
  }, [connection, list, revision, liveRevision, rpc]);

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
  const setMessagePinned = useCallback((id: string, messageId: string, pinned: boolean, mode?: MessagePinMode) =>
    rpc.call("setMessagePinned", { id, messageId, pinned, mode }), [rpc]);
  const bulkUnpin = useMemo<import("./src/ui/message-pin.tsx").BulkUnpinActions>(() => ({
    preview: (id, topic) => rpc.call("unpinAllPreview", { id, topic }),
    unpin: (id, messageId, topic) => rpc.call("unpinAllMessages", { id, messageId, topic }),
  }), [rpc]);
  const loadPinned = useCallback((id: string) => rpc.call("pinnedMessage", { id }), [rpc]);
  const gameLinks = useMemo<import("./src/ui/game-link.tsx").GameLinkActions>(() => ({
    resolve: (url) => rpc.call("resolveGameLink", { url }),
    find: (query) => rpc.call("gameLinkChats", { query }),
    topics: (chat, query, cursor) => rpc.call("gameLinkTopics", { id: chat.id, query, ...(cursor && { cursor }) }),
    send: (url, bot, target) => rpc.call("sendGameLink", { url, bot, target }),
  }), [rpc]);
  const resolveBotStartLink = useCallback((url: string) => rpc.call("resolveBotStartLink", { url }), [rpc]);
  const resolveTemporaryContactLink = useCallback((url: string) => rpc.call("resolveTemporaryContactLink", { url }), [rpc]);
  const resolveBusinessChatLink = useCallback((url: string) => rpc.call("resolveBusinessChatLink", { url }), [rpc]);
  const startLinkedBot = useCallback((url: string, id: string, name: string) => rpc.call("startLinkedBot", { url, id, name }), [rpc]);
  const resolveCollectibleGift = useCallback((url: string) => rpc.call("resolveCollectibleGift", { url }), [rpc]);
  const resolveBoostLink = useCallback((url: string) => rpc.call("resolveBoostLink", { url }), [rpc]);
  const managedBotLinks = useMemo<import("./src/ui/managed-bot-creation.tsx").LinkedManagedBotActions>(() => ({
    preview: (url) => rpc.call("previewManagedBotLink", { url }),
    create: (confirmation, draft) => rpc.call("createLinkedManagedBot", { confirmation, draft }),
  }), [rpc]);
  const resolveMessageLink = useCallback((url: string) => rpc.call("resolveMessageLink", { url }), [rpc]);
  const [contactsRevision, setContactsRevision] = useState(0);
  const [contactBirthdaysRevision, setContactBirthdaysRevision] = useState(0);
  useRealtime(contactBirthdaysChangedChannel, () => setContactBirthdaysRevision((value) => value + 1));
  const senderBlockActions = useMemo<SenderBlockActions>(() => ({
    load: (id: string) => rpc.call("senderBlockState", { id }),
    change: (id, expected, next) => rpc.call("setSenderBlockState", { id, expected, next }),
  }), [rpc]);
  const acceptContactBirthday = useCallback<AcceptBirthday>((id, messageId, birthdate) =>
    rpc.call("acceptBirthdaySuggestion", { id, messageId, birthdate }), [rpc]);
  const contactPhotoSuggestion = useMemo<NonNullable<React.ContextType<typeof ContactPhotoSuggestionActions>>>(() => ({
    load: (id, messageId, photoId) => rpc.call("suggestedProfilePhoto", { id, messageId, photoId }),
    accept: (id, messageId, photoId, expected) => rpc.call("acceptSuggestedProfilePhoto", { id, messageId, photoId, expected }),
  }), [rpc]);
  const contactEditor = useMemo<ContactEditorActions>(() => ({
    load: (id) => rpc.call("contactDetails", { id }),
    suggestPhoto: (id, userId, base64) => rpc.call("suggestContactProfilePhoto", { id, userId, base64 }),
    suggestBirthday: (id, userId, birthdate) => rpc.call("suggestContactBirthday", { id, userId, birthdate }),
    personalPhoto: {
      load: (id, userId) => rpc.call("personalContactPhoto", { id, userId }),
      save: (id, userId, base64, expected) => rpc.call("savePersonalContactPhoto", { id, userId, base64, expected }),
      remove: (id, userId, expected) => rpc.call("removePersonalContactPhoto", { id, userId, expected }),
    },
    note: (id) => rpc.call("contactNote", { id }),
    saveNote: (id, revision, text) => rpc.call("saveContactNote", { id, revision, text }),
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
    birthdays: () => rpc.call("contactBirthdays", null),
    load: (query, offset) => rpc.call("contacts", { query, ...(offset === undefined ? {} : { offset }) }),
    directory: (initial, offset) => rpc.call("contactDirectory", {
      ...(initial === undefined ? {} : { initial }), ...(offset === undefined ? {} : { offset }),
    }),
    open: (id) => rpc.call("openContact", { id }),
  }), [rpc]);
  const globalSearch = useCallback((input: Parameters<GlobalSearchLoader>[0]) =>
    rpc.call("globalSearch", input), [rpc]);
  const loadGlobalMediaThumbnail = useCallback((id: string, messageId: string, fileId?: number) =>
    rpc.call("globalMediaThumbnail", { id, messageId, fileId }), [rpc]);
  const searchPublicDiscovery = useCallback<import("./src/ui/public-discovery.tsx").SearchPublicDiscovery>((query, mode) =>
    rpc.call("searchPublicDiscovery", { query, mode }), [rpc]);
  const loadRecentPublicTags = useCallback((prefix: string) => rpc.call("recentPublicTags", { prefix }), [rpc]);
  const removeRecentPublicTag = useCallback((tag: string) => rpc.call("removeRecentPublicTag", { tag }), [rpc]);
  const recentPublicTags = useMemo<import("./src/ui/global-search.tsx").RecentPublicTagActions>(() => ({
    load: loadRecentPublicTags,
    remove: removeRecentPublicTag,
    clear: (kind) => rpc.call("clearRecentPublicTags", { kind }),
  }), [rpc, loadRecentPublicTags, removeRecentPublicTag]);
  const browsePublicDiscovery = useCallback<import("./src/ui/public-discovery.tsx").BrowsePublicDiscovery>((mode, offset) =>
    rpc.call("browsePublicDiscovery", { mode, ...(offset === undefined ? {} : { offset }) }), [rpc]);
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
    canMoveMain: async () => (await rpc.call("runtimeInfo", null)).premium === true,
    reorder: async (order, expected, positions) => {
      const result = await rpc.call("reorderFolders", { order, expected, ...positions });
      if (result === "saved") setFolderLayout((previous) => {
        if (previous.folders.length !== expected.length || previous.folders.some(({ id }, index) => id !== expected[index])
          || (positions && previous.mainPosition !== positions.expectedMainPosition)) return previous;
        const foldersById = new Map(previous.folders.map((folder) => [folder.id, folder]));
        return { folders: order.map((id) => foldersById.get(id)!), mainPosition: positions?.mainPosition ?? previous.mainPosition };
      });
      return result;
    },
    recommend: () => rpc.call("recommendedFolders", null),
    addRecommended: async (token) => {
      const saved = await rpc.call("addRecommendedFolder", { token });
      updateFolders((previous) => previous.some(({ id }) => id === saved.id) ? previous : [...previous, saved]);
      return saved;
    },
    save: async (draft, id, expectedRevision) => {
      const saved = await rpc.call("saveFolder", { ...draft, ...(id === undefined ? {} : { id }), ...(expectedRevision ? { expectedRevision } : {}) });
      if (!saved) return null;
      updateFolders((previous) => previous.some((folder) => folder.id === saved.id)
        ? previous.map((folder) => folder.id === saved.id ? saved : folder) : [...previous, saved]);
      return saved;
    },
    remove: async (id, title) => {
      const removed = await rpc.call("deleteFolder", { id, title });
      if (removed) {
        setFolderLayout((previous) => {
          const index = previous.folders.findIndex((folder) => folder.id === id);
          if (index < 0) return previous;
          const position = previous.mainPosition;
          return { folders: previous.folders.filter((folder) => folder.id !== id),
            mainPosition: position !== undefined && index < position ? position - 1 : position };
        });
        setList((previous) => previous === id ? "main" : previous);
      }
      return removed;
    },
    memberships: (chatId) => rpc.call("folderMemberships", { chatId }),
    setMembership: (id, chatId, mode) => rpc.call("setFolderMembership", { id, chatId, mode }),
  }), [rpc, updateFolders]);
  const loadRecipientChatPage = useCallback((id: number, offset: number) => rpc.call("chatPage", { list: id, offset }), [rpc]);
  const findNextUnreadChannel = useCallback(async (id: string, current: Exclude<ChatList, "saved">, signal: AbortSignal) => {
    const active = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const lists = new Set<ChatList>([current, ...folders.map(({ id }) => id), "main", "archive"]);
    for (const list of lists) {
      let offset: number | null = 0;
      while (offset !== null) {
        active.throwIfAborted();
        const page: { chats: Chat[]; nextOffset: number | null } = await rpc.call("chatPage", { list, offset });
        active.throwIfAborted();
        const chat = page.chats.find((candidate) => candidate.id !== id && candidate.subtitle === "Channel" && (candidate.unread ?? 0) > 0);
        if (chat) return { chat, list };
        offset = page.nextOffset !== null && page.nextOffset > offset ? page.nextOffset : null;
      }
    }
    return null;
  }, [folders, rpc]);
  const findChats = useCallback((query: string, list: ChatList) => rpc.call("search", { query, list }), [rpc]);
  const recentChatSearch = useMemo<import("./src/ui/recent-chat-search.tsx").RecentChatSearchActions>(() => ({
    load: () => rpc.call("recentSearchChats", null),
    loadFrequent: () => rpc.call("frequentSearchContacts", null),
    record: (id) => rpc.call("updateRecentSearch", { action: "record", id }),
    remove: (id) => rpc.call("updateRecentSearch", { action: "remove", id }),
    clear: () => rpc.call("updateRecentSearch", { action: "clear" }),
  }), [rpc]);
  const reactionNotificationActions = useMemo<ReactionNotificationActions>(() => ({
    load: () => rpc.call("reactionNotifications", null),
    save: (values, expected) => rpc.call("saveReactionNotifications", { values, expected }),
  }), [rpc]);
  const loadNotificationExceptions = useCallback<NotificationExceptionLoader>((scope, offset) =>
    rpc.call("notificationExceptions", { scope, offset }), [rpc]);
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
  const pinnedChatOrder = useCallback((list: Exclude<ChatList, "saved">) => rpc.call("pinnedChatOrder", { list }), [rpc]);
  const movePinnedChat = useCallback((list: Exclude<ChatList, "saved">, id: string, direction: "up" | "down", expected: string[]) =>
    rpc.call("movePinnedChat", { list, id, direction, expected }), [rpc]);
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
  const previewWebLink = useCallback((url: string) => rpc.call("previewWebLink", { url }), [rpc]);
  const joinInvite = useCallback((url: string, expected: InviteTarget) => rpc.call("joinInvite", { url, expected }), [rpc]);
  const joinChat = useCallback((id: string, name: string) => rpc.call("joinChat", { id, name }), [rpc]);
  const createPrivateChat = useCallback((title: string, kind: "Group" | "Channel") =>
    rpc.call("createPrivateChatSpace", { title, kind }), [rpc]);
  const replyBotActions = useMemo<import("./src/ui/reply-bot-keyboard.tsx").ReplyBotActions>(() => ({
    miniApp: {
      launch: (id, messageId, revision, row, column) => rpc.call("launchReplyMiniApp", { id, messageId, revision, row, column }),
      close: (session) => rpc.call("closeMiniApp", { session }),
      send: (session, data) => rpc.call("sendReplyMiniAppData", { session, data }),
    },
    load: (id, topicId) => rpc.call("replyBotKeyboard", { id, topicId }),
    press: (id, topicId, messageId, revision, row, column) =>
      rpc.call("pressReplyBotButton", { id, topicId, messageId, revision, row, column }),
  }), [rpc]);
  const inlineBotActions = useMemo<import("./src/ui/inline-bot-search.tsx").InlineBotActions>(() => ({
    search: (id, username, query, offset, topic) => rpc.call("searchInlineBot", { id, username, query, offset, topic }),
    preview: (id, token) => rpc.call("inlineBotPreview", { id, token }),
    launchMiniApp: (id, token, topic) => rpc.call("launchInlineResultMiniApp", { id, token, topic }),
    send: (id, token, topic, reply) => rpc.call("sendInlineBotResult", { id, token, topic, reply }),
  }), [rpc]);
  const loadBotCommands = useCallback((id: string) => rpc.call("botCommands", { id }), [rpc]);
  const pressInlineBotButton = useCallback((id: string, messageId: string, button: Extract<InlineBotButton, { kind: "callback" }>) =>
    rpc.call("pressInlineBotButton", { id, messageId, row: button.row, column: button.column, revision: button.revision }), [rpc]);
  const loadInlineBotProfile = useCallback<LoadInlineBotProfile>((id, messageId, { row, column, revision }) =>
    rpc.call("inlineBotProfile", { id, messageId, row, column, revision }), [rpc]);
  const inlineBotDestinations = useMemo<NonNullable<ContextType<typeof InlineBotDestinations>>>(() => ({
    find: (id, messageId, { row, column, revision }, query) =>
      rpc.call("inlineBotDestinationChats", { id, messageId, row, column, revision, query }),
    validate: (id, messageId, { row, column, revision }, destination) =>
      rpc.call("inlineBotDestinationChat", { id, messageId, row, column, revision, destination }),
    topics: (id, messageId, { row, column, revision }, destination, query, cursor) =>
      rpc.call("inlineBotDestinationTopics", { id, messageId, row, column, revision, destination, query, ...(cursor && { cursor }) }),
    validateTopic: (id, messageId, { row, column, revision }, destination, topic) =>
      rpc.call("inlineBotDestinationTopic", { id, messageId, row, column, revision, destination, topic }),
  }), [rpc]);
  const chatReportActions = useMemo<import("./src/ui/chat-report.tsx").ChatReportActions>(() => ({
    available: (id) => rpc.call("canReportChat", { id }),
    report: (id, name, step, messageIds) => rpc.call("reportChat", { id, name, step, messageIds }),
  }), [rpc]);
  const chatLeaveActions = useMemo<import("./src/ui/chat-leave.tsx").ChatLeaveActions>(() => ({
    load: (id, name) => rpc.call("chatLeaveOptions", { id, name }),
    leave: (id, name, expectedOwner) => rpc.call("leaveChat", { id, name, expectedOwner }),
    deleteOwned: (id, title, kind) => rpc.call("deleteOwnedChatSpace", { id, title, kind }),
  }), [rpc]);
  const postingPermissions = useCallback((id: string) => rpc.call("postingPermissions", { id }), [rpc]);
  const markActivityRead = useCallback((id: string, filter: import("./src/core/contract.ts").UnreadActivityFilter, topicId?: number) =>
    rpc.call("markActivityRead", { id, filter, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const markChatListRead = useCallback((list: Exclude<ChatList, "saved">) =>
    rpc.call("markChatListRead", { list }), [rpc]);
  const markHistoryRead = useCallback((id: string, messageId: string, topicId?: number, clearUnreadMark?: true) =>
    rpc.call("markHistoryRead", { id, messageId, ...(topicId === undefined ? {} : { topicId }), ...(clearUnreadMark ? { clearUnreadMark } : {}) }), [rpc]);
  const syncChatReadState = useCallback((updated: Pick<Chat, "id" | "unread" | "markedUnread">) => {
    setChats((before) => before.map((chat) => chat.id === updated.id ? {
      ...chat, unread: updated.unread, markedUnread: updated.markedUnread,
    } : chat));
  }, []);
  const markChat = useCallback(async (id: string, unread: boolean) => {
    const updated = await rpc.call("markChat", { id, unread });
    syncChatReadState(updated);
    return updated;
  }, [rpc, syncChatReadState]);
  const loadMedia = useCallback(async (id: string, messageId: string, signal: AbortSignal, oneView?: true, attachment?: import("./src/core/contract.ts").RichAttachmentReference, playbackFileId?: number) => {
    const { url } = await rpc.call("document", oneView ? { id, messageId, oneView }
      : { id, messageId, playback: true, ...(attachment ? { attachment } : {}), ...(playbackFileId && { playbackFileId }) });
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
  const transcribeVoice = useCallback(async (id: string, messageId: string, signal: AbortSignal, timed?: true) => {
    signal.throwIfAborted();
    const ticket = await rpc.call("prepareVoiceTranscription", { id, messageId });
    const cancel = () => { void rpc.call("cancelVoiceTranscription", { ticket }).catch(() => {}); };
    if (signal.aborted) {
      cancel();
      signal.throwIfAborted();
    }
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const transcript = await rpc.call("transcribeVoice", { id, messageId, ticket, timed });
      signal.throwIfAborted();
      return transcript;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }, [rpc]);
  const markNotePlayed = useCallback((id: string, messageId: string) => rpc.call("markNotePlayed", { id, messageId }), [rpc]);
  const loadVideoStream = useCallback((id: string, messageId: string,
    attachment?: import("./src/core/contract.ts").RichAttachmentReference, motionFileId?: number, qualityFileId?: number, playbackFileId?: number) =>
    rpc.call("videoStream", { id, messageId, attachment, motionFileId, qualityFileId, playbackFileId }), [rpc]);
  const loadLinkedStickerPack = useCallback((url: string, offset = 0, refresh?: true) =>
    rpc.call("linkedStickerPack", { url, offset, ...(refresh && { refresh }) }), [rpc]);
  const installLinkedStickerPack = useCallback((url: string, packId: string) => rpc.call("installLinkedStickerPack", { url, packId }), [rpc]);
  const mediaCollection = useMemo<MediaCollectionActions>(() => ({
    loadPack: (id, messageId, offset) => rpc.call("messageStickerPack", { id, messageId, offset }),
    installPack: (id, messageId, packId) => rpc.call("installMessageStickerPack", { id, messageId, packId }),
    ownedSticker: {
      list: (id, messageId, after) => rpc.call("ownedStickerDestinations", { id, messageId, after }),
      add: (id, messageId, sourceFileId, packId, title) =>
        rpc.call("addMessageStickerToOwnedPack", { id, messageId, sourceFileId, packId, title }),
      create: (id, messageId, sourceFileId, name, title) =>
        rpc.call("createOwnedPackFromMessage", { id, messageId, sourceFileId, name, title }),
    },
    load: (id, messageId, kind) => rpc.call("mediaCollectionState", { id, messageId, kind }),
    save: (id, messageId, kind, saved, expected) => rpc.call("setMediaCollection", { id, messageId, kind, saved, expected }),
  }), [rpc]);
  const stickerPackLibrary = useMemo<NonNullable<ComposerMediaActions["stickerPackLibrary"]>>(() => ({
    installed: () => rpc.call("installedStickerPacks", null),
    archived: (after) => rpc.call("archivedStickerPacks", { after }),
    owned: {
      list: (after) => rpc.call("ownedStickerPacks", { after }),
      load: (id) => rpc.call("ownedStickerPack", { id }),
      preview: (id, fileId) => rpc.call("ownedStickerPreview", { id, fileId }),
      rename: (id, expected, title) => rpc.call("renameOwnedStickerPack", { id, expected, title }),
      move: (id, fileId, direction, expected) => rpc.call("moveOwnedSticker", { id, fileId, direction, expected }),
      remove: (id, fileId, title, expected) => rpc.call("removeOwnedSticker", { id, fileId, title, expected }),
      setEmojis: (id, fileId, expected, emojis) => rpc.call("setOwnedStickerEmojis", { id, fileId, expected, emojis }),
      setEmojiCover: (id, expected, fileId) => rpc.call("setOwnedEmojiPackCover", { id, expected, fileId }),
      imageCover: (id, fileId) => rpc.call("ownedStickerImageCover", { id, fileId }),
      setImageCover: (id, expected, base64) => rpc.call("setOwnedStickerImageCover", { id, expected, base64 }),
      deletePack: (target) => rpc.call("deleteOwnedStickerPack", target),
      inspectTgs: (base64) => rpc.call("inspectOwnedTgsSticker", { base64 }),
      inspectWebm: (base64) => rpc.call("inspectOwnedWebmSticker", { base64 }),
      createFromImage: (name, title, emojis, base64, format) => rpc.call("createOwnedPackFromImage", { name, title, emojis, base64, format }),
      addFromImage: (target, emojis, base64, format) => rpc.call("addImageToOwnedStickerPack", { target, emojis, base64, format }),
      replaceFromImage: (target, fileId, emojis, base64, format) => rpc.call("replaceImageInOwnedStickerPack", { target, fileId, emojis, base64, format }),
    },
    change: (id, action) => rpc.call("changeStickerPack", { id, action }),
  }), [rpc]);
  const stickerPackDiscovery = useMemo<NonNullable<ComposerMediaActions["stickerPackDiscovery"]>>(() => ({
    find: (input) => rpc.call("discoverStickerPacks", input),
    load: loadLinkedStickerPack,
    install: installLinkedStickerPack,
  }), [rpc, loadLinkedStickerPack, installLinkedStickerPack]);
  const mediaComposer = useCallback((id: string, topic?: ForumTopicTarget, reply?: MediaReply): ComposerMediaActions => ({
    recordingActivity: list === "saved" ? undefined : (activity: import("./src/core/contract.ts").RecordingActivity) =>
      rpc.call("setRecordingActivity", { id, topicId: topic?.id, activity }),
    choices: (kind: "sticker" | "gif") => rpc.call("mediaChoices", kind),
    searchGifs: (query: string) => rpc.call("searchGifs", { id, query, ...(topic ? { topic } : {}) }),
    sendFoundGif: async (token, delivery, gif) => (await rpc.call("sendFoundGif", { id, token, topic, reply, delivery, gif })).state,
    stickerPackLibrary,
    stickerPackDiscovery,
    clearRecentStickers: () => rpc.call("clearRecentStickers", null),
    stickerPacks: () => rpc.call("installedStickerPacks", null),
    reorderStickerPacks: (order: string[], expected: string[]) => rpc.call("reorderStickerPacks", { order, expected }),
    stickerPackPage: (packId: string, offset: number) => rpc.call("stickerPackPage", { packId, offset }),
    groupStickerPage: (packId, offset) => rpc.call("groupStickerPage", { id, packId, offset }),
    sendGroupSticker: async (packId, fileId, delivery) => (await rpc.call("sendMediaChoice", {
      id, kind: "sticker", fileId, packId, groupPack: true, topic, reply, delivery,
    })).state,
    searchStickers: (stickerQuery: string) => rpc.call("mediaChoices", { stickerQuery }),
    sendChoice: async (kind: "sticker" | "gif", fileId: number, stickerQuery?: string, packId?: string, delivery?: MediaDelivery, gif?: import("./src/core/contract.ts").GifSendOptions) =>
      (await rpc.call("sendMediaChoice", { id, kind, fileId, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}),
        ...(stickerQuery === undefined ? {} : { stickerQuery }), ...(packId === undefined ? {} : { packId }), ...(gif ? { gif } : {}) })).state,
    paidMediaLimit: !topic && !reply?.externalReplyChatId ? () => rpc.call("paidMediaLimit", { id }) : undefined,
    sendAlbum: (caption: string, photos: string[], delivery?: AttachmentSendDelivery, options?: import("./src/core/contract.ts").AlbumSendOptions) =>
      rpc.call("sendPhotoAlbum", { id, caption, photos, ...(topic ? { topic } : {}), ...(reply ? { reply } : {}),
        ...(delivery ? { delivery } : {}), ...(options ? { options } : {}) }),
    sendMediaFile: async (file, caption, signal, progress, delivery, options) => {
      const preparation = await rpc.call("prepareDocumentUpload", {
        id, name: file.name.slice(0, 255), size: file.size, caption, topic, reply, delivery, options,
      });
      if ("rejection" in preparation) return preparation.rejection;
      const result = await uploadDocument(preparation.url, file, (uploaded, canCancel) =>
        progress(uploaded, canCancel ?? true), signal);
      return result.state === "failed" ? result.uploadRejection ?? "failed" : result.state;
    },
    sendMixedAlbum: async (caption, items, signal, progress, delivery, options) => {
      const blob = new Blob(items.flatMap((item) => item.kind === "photo" ? [] : item.kind === "livePhoto" && typeof item.photo !== "string"
        ? [item.photo, item.file] : [item.file]));
      const upload = await rpc.call("prepareAlbumUpload", {
        id, caption, topic, reply, delivery, options,
        items: items.map((item) => item.kind === "photo" ? item : item.kind === "livePhoto"
          ? { kind: item.kind, name: item.file.name.slice(0, 255), size: item.file.size,
            photo: typeof item.photo === "string" ? item.photo : { heicBytes: item.photo.size } }
          : { kind: item.kind, name: item.file.name, size: item.file.size,
            ...(item.kind === "video" && item.videoEdit && { videoEdit: item.videoEdit }) }),
      });
      if ("rejection" in upload) return upload.rejection;
      const result = await uploadDocument(upload.url, blob, (offset, canCancel) =>
        progress(offset, blob.size, canCancel ?? true), signal);
      return result.state === "failed" ? result.uploadRejection ?? "failed" : result.state;
    },
    sendLivePhoto: async (caption, photo, clip, signal, progress, delivery, options) => {
      if (signal.aborted) return "cancelled";
      const file = typeof photo === "string" ? clip : new Blob([photo, clip]);
      const upload = await rpc.call("prepareLivePhotoUpload", {
        id, caption, photo: typeof photo === "string" ? photo : { heicBytes: photo.size },
        name: clip.name.slice(0, 255), size: clip.size, topic, reply, delivery, options,
      });
      if ("rejection" in upload) return "failed";
      return (await uploadDocument(upload.url, file, (offset, canCancel) =>
        progress(offset, file.size, canCancel ?? true), signal)).state;
    },
    richMessageLimits: () => rpc.call("richMessageLimits", {}),
    sendRichMessage: async (draft, files, signal, progress, delivery) => {
      if (!files.length) return (await rpc.call("sendRichMessage", { id, draft, topic, reply, delivery })).state;
      const prepared = await prepareRichMessageFiles(draft, files, signal);
      if (!prepared) return signal.aborted ? "cancelled" : "failed";
      const { blob } = prepared;
      const input = schemas.prepareRichMessageUpload.input.safeParse({ id, draft: prepared.draft, topic, reply, delivery });
      if (!input.success) return "failed";
      const upload = await rpc.call("prepareRichMessageUpload", input.data);
      if ("rejection" in upload) return "failed";
      const result = await uploadDocument(upload.url, blob, (offset, canCancel) =>
        progress(offset, blob.size, canCancel ?? true), signal);
      return result.state === "failed" && result.uploadRejection === "video_preparation_failed" ? result.uploadRejection : result.state;
    },
    checklistAvailability: () => rpc.call("checklistAvailability", { id }),
    sendChecklist: async (draft: import("./src/core/contract.ts").ChecklistDraft, delivery?: MediaDelivery) =>
      (await rpc.call("sendChecklist", { id, draft, topic, reply, delivery })).state,
    sendContactCard: async (contact: ContactDraft, delivery?: MediaDelivery) =>
      (await rpc.call("sendContactCard", { id, contact, topic, reply, delivery })).state,
    sendLocation: async (point: LocationPoint, delivery?: MediaDelivery) =>
      (await rpc.call("sendLocation", { id, point, topic, reply, delivery })).state,
    sendVideoNote: async (base64: string, format: "webm" | "mp4", delivery?: MediaDelivery) =>
      (await rpc.call("sendVideoNote", { id, base64, format, ...(topic ? { topic } : {}),
        ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}) })).state,
    sendVoice: async (base64: string, duration: number, format: "ogg" | "webm" | "mp4", delivery?: MediaDelivery, trim?: import("./src/core/contract.ts").VoiceTrim) =>
      (await rpc.call("sendVoice", { id, base64, duration, format, ...(trim ? { trim } : {}), ...(topic ? { topic } : {}), ...(reply ? { reply } : {}), ...(delivery ? { delivery } : {}) })).state,
  }), [list, rpc, stickerPackLibrary, stickerPackDiscovery]);
  const saveSelectedAttachments = useCallback(async (id: string, ids: string[], format?: "html") => {
    const { name, url } = await rpc.call("saveSelectedAttachments", { id, ids, format });
    return await experimental_saveFile({ fileName: name, url }) === "started";
  }, [rpc]);
  const saveDocument = useCallback(async (id: string, messageId: string, attachment?: import("./src/core/contract.ts").RichAttachmentReference) => {
    const { name, url } = await rpc.call("document", { id, messageId, ...(attachment ? { attachment } : {}) });
    return await experimental_saveFile({ fileName: name, url }) === "started";
  }, [rpc]);
  const queueDownload = useCallback((id: string, messageId: string) => rpc.call("queueDownload", { id, messageId }), [rpc]);
  const downloadQueueActions = useMemo<DownloadQueueActions>(() => ({
    load: (filter, offset, query) => rpc.call("downloadQueue", { filter, offset, query }),
    thumbnail: (id, messageId, fileId) => rpc.call("downloadThumbnail", { id, messageId, fileId }),
    change: (fileId, action) => rpc.call("manageDownload", { fileId, action }),
    save: saveDocument,
    pauseAll: (paused) => rpc.call("pauseAllDownloads", { paused }),
    clearCompleted: () => rpc.call("clearCompletedDownloads", null),
  }), [rpc, saveDocument]);
  const [downloadActivity, setDownloadActivity] = useState<{ connection: string; counts: DownloadQueueCounts; revision: number }>();
  const lastDownloadProgress = useRef<{ connection: string; progress: DownloadQueueProgress } | undefined>(undefined);
  const downloadProgressListener = useRef<Parameters<SubscribeToDownloadProgress>[0] | undefined>(undefined);
  const subscribeToDownloadProgress = useCallback<SubscribeToDownloadProgress>((listener) => {
    downloadProgressListener.current = listener;
    const latest = lastDownloadProgress.current;
    if (latest && latest.connection === connection) listener(latest.progress);
    return () => {
      if (downloadProgressListener.current === listener) downloadProgressListener.current = undefined;
    };
  }, [connection]);
  useRealtime(downloadProgressChannel, (payload) => {
    const event = downloadProgressEvent.safeParse(payload).data;
    if (!event || !connection || event.connectionId !== connectionId) return;
    lastDownloadProgress.current = { connection, progress: event.progress };
    downloadProgressListener.current?.(event.progress);
  });
  useRealtime(downloadActivityChannel, (payload) => {
    const event = downloadActivityEvent.safeParse(payload).data;
    if (!event || !connection || event.connectionId !== connectionId) return;
    setDownloadActivity((previous) => ({ connection, counts: event.counts,
      revision: previous?.connection === connection ? previous.revision + 1 : 1 }));
  });
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("downloadCounts", null).then((snapshot) => {
      if (!active || !snapshot) return;
      const { progress, ...counts } = snapshot;
      if (progress && lastDownloadProgress.current?.connection !== connection) {
        lastDownloadProgress.current = { connection, progress };
        downloadProgressListener.current?.(progress);
      }
      setDownloadActivity((previous) =>
        previous?.connection === connection ? previous : { connection, counts, revision: 0 });
    }, () => {});
    return () => { active = false; };
  }, [connection, rpc]);
  const currentDownloadActivity = downloadActivity?.connection === connection ? downloadActivity : undefined;
  const avatars = useMemo(() => new Map<string, Promise<TelegramPhoto>>(), [connection, rpc]);
  const loadAvatar = useCallback((id: string, fileId: number, user?: boolean) => {
    const key = `${user === true}:${id}:${fileId}`;
    const cache = avatars;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    const pending = rpc.call("avatar", user ? { id, fileId, user } : { id, fileId }).then(decodeAvatar).catch((error) => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }, [avatars, rpc]);
  const loadInstantView = useCallback((url: string) => rpc.call("instantView", { url }), [rpc]);
  const saveInstantViewDocument = useCallback(async (articleUrl: string, fileId: number) => {
    const { name, url } = await rpc.call("instantViewDocument", { url: articleUrl, fileId });
    return await experimental_saveFile({ fileName: name, url }) === "started";
  }, [rpc]);
  const loadInstantViewMap = useCallback((url: string, point: import("./src/core/contract.ts").ArticleMapPoint) =>
    rpc.call("instantViewMap", { url, point }), [rpc]);
  const loadInstantViewIcon = useCallback((url: string, fileId: number) => rpc.call("instantViewIcon", { url, fileId }), [rpc]);
  const loadInstantViewMention = useCallback((url: string, userId: number) => rpc.call("instantViewMention", { url, userId }), [rpc]);
  const instantViewJoin = useMemo<InstantViewJoinActions>(() => ({
    review: (url, target) => rpc.call("instantViewJoinTarget", { url, target }),
    join: (url, target, expected) => rpc.call("joinInstantViewChat", { url, target, expected }),
  }), [rpc]);
  const loadInstantViewPhoto = useCallback((url: string, fileId: number, size?: PhotoSize) =>
    rpc.call("instantViewPhoto", { url, fileId, ...(size && { size }) }), [rpc]);
  const loadMessagePreviewCover = useCallback((id: string, messageId: string, fileId: number, size?: PhotoSize) =>
    rpc.call("messagePreviewCover", { id, messageId, fileId, ...(size && { size }) }), [rpc]);
  const loadMessagePreviewPlayback = useCallback((id: string, messageId: string, fileId: number) =>
    rpc.call("messagePreviewPlayback", { id, messageId, fileId }), [rpc]);
  const loadInstantViewPlayback = useCallback((url: string, fileId: number) =>
    rpc.call("instantViewPlayback", { url, fileId }), [rpc]);
  const translateMessage = useCallback((id: string, messageId: string, language: TranslationLanguage) =>
    rpc.call("translateMessage", { id, messageId, language }), [rpc]);
  const loadSharedContact = useCallback((id: string, messageId: string, userId: string) =>
    rpc.call("openSharedContact", { id, messageId, userId }), [rpc]);
  const loadLocationMap = useCallback((id: string, messageId: string) => rpc.call("locationMap", { id, messageId }), [rpc]);
  const emojiCache = useMemo(() => new Map<string, Promise<CustomEmojiMedia | null>>(), [connection, rpc]);
  const installedEmoji = useMemo(() => ({
    list: () => rpc.call("installedEmojiPacks", null),
    page: (packId: string, offset: number) => rpc.call("installedEmojiPage", { packId, offset }),
    discovery: {
      find: (input: { query: string } | { offset: number }) => rpc.call("discoverStickerPacks", { ...input, emoji: true }),
      load: loadLinkedStickerPack,
      install: installLinkedStickerPack,
    },
    library: {
      installed: () => rpc.call("installedEmojiPacks", null),
      archived: (after?: string) => rpc.call("archivedStickerPacks", { after, emoji: true }),
      change: (id: string, action: "archive" | "restore" | "remove") => rpc.call("changeStickerPack", { id, action, emoji: true }),
      reorder: (order: string[], expected: string[]) => rpc.call("reorderStickerPacks", { order, expected, emoji: true }),
    },
  }), [rpc, loadLinkedStickerPack, installLinkedStickerPack]);
  const loadGroupEmoji = useCallback((id: string, offset: number, packId?: string) =>
    rpc.call("groupEmojiPage", { id, offset, packId }), [rpc]);
  const loadCustomEmoji = useCallback((id: string) => {
    const cached = emojiCache.get(id);
    if (cached) return cached;
    const request = rpc.call("customEmoji", { id }).catch((error) => {
      emojiCache.delete(id);
      throw error;
    });
    if (emojiCache.size >= 32) emojiCache.delete(emojiCache.keys().next().value!);
    emojiCache.set(id, request);
    return request;
  }, [emojiCache, rpc]);
  const loadTgsSticker = useCallback((id: string, messageId: string) => rpc.call("tgsSticker", { id, messageId }), [rpc]);
  const loadMessageEffect = useCallback((id: string, messageId: string, effect: string, animate: boolean) =>
    rpc.call("messageEffect", { id, messageId, effect, animate }), [rpc]);
  const loadMessageEffects = useCallback((id: string) => rpc.call("messageEffects", { id }), [rpc]);
  const recognizePhotoText = useCallback((id: string, messageId: string, size: PhotoSize, sha256: string) =>
    rpc.call("recognizePhotoText", { id, messageId, size, sha256 }), [rpc]);
  const preparePhotoDrag = useCallback((id: string, messageId: string) =>
    rpc.call("preparePhotoDrag", { id, messageId }), [rpc]);
  const loadPhoto = useCallback((id: string, messageId: string, size?: PhotoSize, attachment?: import("./src/core/contract.ts").RichAttachmentReference) =>
    rpc.call("photo", { id, messageId, ...(size ? { size } : {}), ...(attachment ? { attachment } : {}) }), [rpc]);
  const drawPhotoReplyTarget = useCallback((id: string, messageId: string, topicId?: number) =>
    rpc.call("drawPhotoReplyTarget", { id, messageId, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const loadForumTopicLink = useCallback((id: string, topic: number) => rpc.call("forumTopicLink", { id, topic }), [rpc]);
  const loadMessageLink = useCallback((id: string, messageId: string, target?: MessageLinkTarget) => rpc.call("messageLink", { id, messageId, target }), [rpc]);
  const sendChannelComment = useCallback((id: string, messageId: string, group: string, root: string, text: string) =>
    rpc.call("sendChannelComment", { id, messageId, group, root, text }), [rpc]);
  const loadChannelDiscussion = useCallback((id: string, messageId: string, before?: string) =>
    rpc.call("channelDiscussion", { id, messageId, ...(before ? { before } : {}) }), [rpc]);
  const loadFirstUnread = useCallback((id: string, topicId?: number) => rpc.call("firstUnreadMessage", { id, topicId }), [rpc]);
  const loadMessageAtDate = useCallback((id: string, date: number, topicId?: number) => rpc.call("messageAtDate", { id, date, topicId }), [rpc]);
  const loadMessageContextPage = useCallback((id: string, messageId: string, direction: import("./src/core/contract.ts").ContextDirection, topicId?: number) =>
    rpc.call("messageContextPage", { id, messageId, direction, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const loadMessageContext = useCallback((id: string, messageId: string, topicId?: number) => rpc.call("messageContext", topicId === undefined ? { id, messageId } : { id, messageId, topicId }), [rpc]);
  const loadSharedContentCounts = useCallback((id: string) => rpc.call("sharedContentCounts", { id }), [rpc]);
  const searchMessages = useCallback((id: string, query: string, filter?: MessageSearchFilter, topicId?: number, before?: string, sender?: import("./src/core/contract.ts").MessageSender, range?: import("./src/core/contract.ts").MessageSearchDateRange) =>
    rpc.call("searchMessages", { id, query, ...(filter === undefined ? {} : { filter }),
      ...(topicId === undefined ? {} : { topicId }), ...(before === undefined ? {} : { before }), ...(sender ? { sender } : {}), ...(range ? { range } : {}) }), [rpc]);
  const messageViewers = useCallback((id: string, messageId: string) => rpc.call("messageViewers", { id, messageId }), [rpc]);
  const loadMessageViewerProfile = useCallback((id: string, messageId: string, userId: string) =>
    rpc.call("messageViewerProfile", { id, messageId, userId }), [rpc]);
  const messageReadTime = useCallback((id: string, messageId: string) => rpc.call("messageReadTime", { id, messageId }), [rpc]);
  const batchDeletion = useMemo(() => ({
    options: (id: string, ids: string[]) => rpc.call("batchDeletionOptions", { id, ids }),
    remove: (id: string, ids: string[], scope: DeletionScope) => rpc.call("deleteSelectedMessages", { id, ids, scope }),
  }), [rpc]);
  const deletionOptions = useCallback((id: string, messageId: string) => rpc.call("deletionOptions", { id, messageId }), [rpc]);
  const deleteMessage = useCallback((id: string, messageId: string, scope: DeletionScope) =>
    rpc.call("deleteMessage", { id, messageId, scope }), [rpc]);
  const messageEmojiPackActions = useMemo<NonNullable<import("react").ContextType<typeof MessageEmojiPackActions>>>(() => ({
    load: (id, offset, packId) => rpc.call("customEmojiPack", { id, offset, packId }),
    install: installLinkedStickerPack,
  }), [rpc, installLinkedStickerPack]);
  const messageEmojiStatusActions = useMemo<NonNullable<import("react").ContextType<typeof MessageEmojiStatusActions>>>(() => ({
    review: (emoji) => rpc.call("messageEmojiStatus", { emoji }),
    save: (change) => rpc.call("saveMessageEmojiStatus", change),
  }), [rpc]);
  const copySelectedText = useCallback((id: string, ids: string[], format?: "portable") => rpc.call("copySelectedText", { id, ids, includeHtml: format ?? true }), [rpc]);
  const batchForward = useMemo(() => ({
    options: (id: string, ids: string[]) => rpc.call("forwardSelectionOptions", { id, ids }),
    send: (id: string, ids: string[], target: ForwardTarget, presentation?: ForwardPresentation,
      delivery?: import("./src/core/contract.ts").ForwardDelivery, comment?: string) =>
      rpc.call("forwardSelectedMessages", { id, ids, target, presentation, delivery, comment }),
  }), [rpc]);
  const forwardOptions = useCallback((id: string, messageId: string, album?: import("./src/core/contract.ts").ForwardAlbum) =>
    rpc.call("forwardOptions", { id, messageId, ...(album ? { album } : {}) }), [rpc]);
  const forwardMessage = useCallback((id: string, messageId: string, target: ForwardTarget, album?: import("./src/core/contract.ts").ForwardAlbum,
    presentation?: import("./src/core/contract.ts").ForwardPresentation, delivery?: import("./src/core/contract.ts").ForwardDelivery, comment?: string) =>
    rpc.call("forwardMessage", { id, messageId, target, comment, ...(album ? { album } : {}), ...(presentation ? { presentation } : {}), ...(delivery ? { delivery } : {}) }), [rpc]);
  const [quickReaction, setQuickReactionState] = useState<SelectableReaction>();
  useEffect(() => {
    if (!connection) { setQuickReactionState(undefined); return; }
    let active = true;
    void rpc.call("quickReaction", {}).then((reaction) => {
      if (active) setQuickReactionState(reaction ?? undefined);
    }).catch(() => {});
    return () => { active = false; };
  }, [connection, liveRevision, rpc]);
  const chatReactionActions = useMemo<ChatReactionActions>(() => ({
    load: (id) => rpc.call("chatReactionSettings", { id }),
    save: (id, policy, expected) => rpc.call("setChatReactionPolicy", { id, policy, expected }),
  }), [rpc]);
  const setQuickReaction = useCallback(async (reaction: SelectableReaction) => {
    const saved = await rpc.call("setQuickReaction", { reaction });
    if (saved) setQuickReactionState(reaction);
    return saved;
  }, [rpc]);
  const listReactions = useCallback((id: string, messageId: string) => rpc.call("listReactions", { id, messageId }), [rpc]);
  const loadReactionPeople = useCallback((id: string, messageId: string, reaction: SelectableReaction | undefined, offset: string) =>
    rpc.call("reactionPeople", { id, messageId, reaction, offset }), [rpc]);
  const loadReactionPerson = useCallback((id: string, messageId: string, target: ReactionPersonReference) =>
    rpc.call("reactionPerson", { id, messageId, target }), [rpc]);
  const setReaction = useCallback((id: string, messageId: string, reaction: SelectableReaction, chosen: boolean) =>
    rpc.call("setReaction", { id, messageId, reaction, chosen }), [rpc]);
  const pollFiles = useMemo<NonNullable<import("react").ContextType<typeof PollFileActions>>>(() => ({
    save: async (id, messageId, reference) => {
      const { name, url } = await rpc.call("pollDocument", { id, messageId, reference });
      return await experimental_saveFile({ fileName: name, url }) === "started";
    },
    play: (id, messageId, reference) => rpc.call("pollPlayback", { id, messageId, reference }),
  }), [rpc]);
  const pollOptionActions = useMemo<NonNullable<import("react").ContextType<typeof PollOptionActions>>>(() => ({
    add: (id, messageId, text) => rpc.call("addPollOption", { id, messageId, text }),
    canRemove: (id, messageId, optionId, text) => rpc.call("canRemovePollOption", { id, messageId, optionId, text }),
    remove: (id, messageId, optionId, text) => rpc.call("removePollOption", { id, messageId, optionId, text }),
  }), [rpc]);
  const pollStickers = useMemo<NonNullable<import("react").ContextType<typeof PollStickerActions>>>(() => ({
    list: () => rpc.call("installedStickerPacks", null),
    page: (packId, offset) => rpc.call("stickerPackPage", { packId, offset }),
    artwork: (id, messageId, reference) => rpc.call("pollStickerArtwork", { id, messageId, reference }),
  }), [rpc]);
  const sendPollFiles = useCallback<NonNullable<import("react").ContextType<typeof PollFileUpload>>>(async (target, draft, files, signal, progress, topic, reply) => {
    if (signal.aborted) return { state: "cancelled" };
    const blob = new Blob(files.flatMap((item) => item.kind === "livePhoto" && typeof item.photo !== "string"
      ? [item.photo, item.file] : [item.file]));
    const parts = files.map((item) => {
      const { file, slot } = item;
      const common = { slot, name: file.name.slice(0, 255), size: file.size };
      return item.kind === "livePhoto" ? { ...common, kind: item.kind,
        photo: typeof item.photo === "string" ? item.photo : { heicBytes: item.photo.size } } : { ...common, kind: item.kind };
    });
    const preparation = await rpc.call("preparePollUpload", typeof target === "string"
      ? { id: target, draft, topic, reply, files: parts } : { shortcut: target, draft, files: parts });
    if ("rejection" in preparation) return { state: "failed" };
    return uploadPollFiles(preparation.url, blob, (offset, canCancel) => progress(offset, blob.size, canCancel ?? true), signal);
  }, [rpc]);
  const loadChannelPollLimits = useCallback((id: string) => rpc.call("channelPollLimits", { id }), [rpc]);
  const sendPoll = useCallback((id: string, draft: PollDraft, topic?: ForumTopicTarget, reply?: MediaReply) =>
    rpc.call("sendPoll", { id, draft, topic, reply }), [rpc]);
  const editRichMessage = useMemo(() => ({
    load: () => rpc.call("richMessageLimits", {}),
    save: (id: string, messageId: string, revision: string, draft: import("./src/core/contract.ts").WelcomeRichEditDraft) =>
      rpc.call("editRichMessage", { id, messageId, revision, draft }),
    upload: async (id: string, messageId: string, revision: string, draft: WelcomeRichComposeDraft, files: Blob[],
      progress: (offset: number, total: number, canCancel: boolean) => void, signal: AbortSignal) => {
      const prepared = await prepareRichMessageFiles(draft, files, signal).catch(() => undefined);
      if (!prepared) return { state: signal.aborted ? "cancelled" as const : "failed" as const };
      const { blob } = prepared;
      const upload = await rpc.call("prepareRichMessageEditUpload", { id, messageId, revision, draft: prepared.draft });
      if ("rejection" in upload) return { state: "failed" as const, uploadRejection: upload.rejection };
      return uploadDocument(upload.url, blob, (offset, canCancel) => progress(offset, blob.size, canCancel ?? true), signal);
    },
  }), [rpc]);
  const editChecklist = useCallback((id: string, messageId: string, expected: string, draft: import("./src/core/contract.ts").ChecklistEdit) =>
    rpc.call("editChecklist", { id, messageId, expected, draft }), [rpc]);
  const addChecklistTask = useCallback((id: string, messageId: string, task: string, expected: number[]) =>
    rpc.call("addChecklistTask", { id, messageId, task, expected }), [rpc]);
  const setChecklistTask = useCallback((id: string, messageId: string, taskId: number, expected: boolean, done: boolean) =>
    rpc.call("setChecklistTask", { id, messageId, taskId, expected, done }), [rpc]);
  const loadPollVoters = useCallback((id: string, messageId: string, choice: PollChoice, offset: number) =>
    rpc.call("pollVoters", { id, messageId, choice, offset }), [rpc]);
  const stopPoll = useCallback((id: string, messageId: string) => rpc.call("stopPoll", { id, messageId }), [rpc]);
  const voteInPoll = useCallback((id: string, messageId: string, choices: PollChoice[]) => rpc.call("voteInPoll", { id, messageId, choices }), [rpc]);
  const replaceAttachment = useCallback<import("./src/ui/message-edit.tsx").ReplaceAttachment>(async (id, messageId, edit, file, progress, signal, scheduled) => {
    const preparation = await rpc.call("prepareAttachmentReplacement", { id, messageId, edit,
      name: file.name.slice(0, 255), size: file.size, scheduled });
    if ("rejection" in preparation) return { state: "failed", uploadRejection: preparation.rejection };
    return uploadDocument(preparation.url, file, progress, signal);
  }, [rpc]);
  const replacePhoto = useCallback<import("./src/ui/message-edit.tsx").ReplacePhoto>((id, messageId, revision, base64, scheduled) =>
    rpc.call("replaceMessagePhoto", { id, messageId, revision, base64, scheduled }), [rpc]);
  const editCaption = useCallback((id: string, messageId: string, text: string, original: string,
    originalStyles?: import("./src/core/contract.ts").StyledRange[], styles?: import("./src/core/contract.ts").StyledRange[],
    placement?: import("./src/core/contract.ts").CaptionPlacement, links?: import("./src/core/contract.ts").EditLinks, scheduled?: import("./src/core/contract.ts").ScheduledEdit, customEmoji?: import("./src/core/contract.ts").EditCustomEmoji) =>
    rpc.call("editCaption", { id, messageId, text, original,
      ...(originalStyles ? { originalStyles } : {}), ...(styles ? { styles } : {}), ...(placement ? { placement } : {}), ...(links ? { links } : {}), ...(scheduled ? { scheduled } : {}), ...(customEmoji ? { customEmoji } : {}) }), [rpc]);
  const editText = useCallback((id: string, messageId: string, text: string, original: string, originalStyles?: import("./src/core/contract.ts").StyledRange[], styles?: import("./src/core/contract.ts").StyledRange[], removeLinkPreview?: string, links?: import("./src/core/contract.ts").EditLinks, scheduled?: import("./src/core/contract.ts").ScheduledEdit, customEmoji?: import("./src/core/contract.ts").EditCustomEmoji) =>
    rpc.call("edit", { id, messageId, text, original, ...(originalStyles ? { originalStyles } : {}), ...(styles ? { styles } : {}), ...(removeLinkPreview ? { removeLinkPreview } : {}), ...(links ? { links } : {}), ...(scheduled ? { scheduled } : {}), ...(customEmoji ? { customEmoji } : {}) }), [rpc]);
  const sendDocument = useMemo(() => documentSender(input => rpc.call("prepareDocumentUpload", input)), [rpc]);
  const sendPhoto = useCallback((id: string, caption: string, base64: string, topic?: ForumTopicTarget, replyTo?: import("./src/core/contract.ts").AttachmentReply,
    options?: import("./src/core/contract.ts").AttachmentSendOptions, delivery?: AttachmentSendDelivery) => rpc.call("sendPhoto", {
      id, caption, base64, ...(topic ? { topic } : {}), ...(typeof replyTo === "string" ? { replyTo } : replyTo ? { reply: replyTo } : {}), ...(options ? { options } : {}), ...(delivery ? { delivery } : {}),
    }), [rpc]);
  const sendText = useCallback((id: string, text: string, replyTo?: string, delivery?: import("./src/core/contract.ts").TextDelivery) =>
    rpc.call("send", { id, text, ...(replyTo === undefined ? {} : { replyTo }), ...(delivery ? { delivery } : {}) }), [rpc]);
  const externalReplyDraft = useMemo<ExternalReplyDraftActions>(() => ({
    find: (query) => rpc.call("externalReplyChats", { query }),
    topics: (chat, query, cursor) => rpc.call("externalReplyTopics", { id: chat.id, query, cursor }),
    review: (source, chat, topic) => rpc.call("reviewExternalReply", {
      ...source, destination: chat.id, expectedName: chat.name, topic,
    }),
  }), [rpc]);
  const externalReplyAllowed = useCallback((id: string, messageId: string) =>
    rpc.call("externalReplyAllowed", { id, messageId }), [rpc]);
  const externalReplySource = useCallback((id: string, messageId: string) =>
    rpc.call("externalReplySource", { id, messageId }), [rpc]);
  const loadChatDraft = useCallback((id: string) => rpc.call("chatDraft", { id }), [rpc]);
  const loadTopicDraft = useCallback((id: string, topicId: number) => rpc.call("topicDraft", { id, topicId }), [rpc]);
  const saveChatDraft = useCallback((id: string, draft: SyncedDraft | null, expected: SyncedDraft | null, topicId?: number) =>
    rpc.call("saveChatDraft", { id, draft, expected, topicId }), [rpc]);
  const loadChatEvents = useCallback((id: string, query: string, cursor?: string, filters?: import("./src/core/contract.ts").ChatEventFilter[], actorId?: string) =>
    rpc.call("chatEvents", { id, query, cursor, filters, actorId }), [rpc]);
  const loadChatEventActors = useCallback((id: string) => rpc.call("chatEventActors", { id }), [rpc]);
  const reportAntiSpam = useCallback((id: string, eventId: string) => rpc.call("reportAntiSpamFalsePositive", { id, eventId }), [rpc]);
  const channelSignatureActions = useMemo<ChannelSignatureActions>(() => ({
    load: (id) => rpc.call("channelSignatures", { id }),
    save: (id, values, expected) => rpc.call("saveChannelSignatures", { id, values, expected }),
  }), [rpc]);
  const chatSendAsActions = useMemo<import("./src/ui/chat-send-as.tsx").ChatSendAsActions>(() => ({
    load: (id) => rpc.call("chatSendAs", { id }),
    save: (id, key, expected) => rpc.call("setChatSendAs", { id, key, expected }),
  }), [rpc]);
  const chatInfoActions = useMemo<ChatInfoActions>(() => ({
    groupPacks: {
      load: (id) => rpc.call("groupPacks", { id }),
      preview: (id, kind, reference) => rpc.call("previewGroupPack", { id, kind, reference }),
      save: (id, kind, expected, pack) => rpc.call("setGroupPack", { id, kind, expected, pack }),
    },
    upgradeGroup: (id, title) => rpc.call("upgradeBasicGroup", { id, title }),
    discussion: {
      load: (id) => rpc.call("discussionGroup", { id }),
      candidates: (id) => rpc.call("discussionGroupCandidates", { id }),
      save: (id, target, expected) => rpc.call("setDiscussionGroup", { id, target, expected }),
      enableHistory: (id, target, title, expected) => rpc.call("enableDiscussionHistory", { id, target, title, expected }),
      upgrade: (id, target, title, expected) => rpc.call("upgradeDiscussionGroup", { id, target, title, expected }),
    },
    boosts: {
      saveSetting: (id, change) => rpc.call("saveChannelBoostSetting", { id, ...change }),
      history: (id, onlyGiftCodes, offset) => rpc.call("chatBoostHistory", { id, onlyGiftCodes, offset }),
      list: (id) => rpc.call("chatBoostSlots", { id }),
      apply: (id, title, slots) => rpc.call("applyChatBoosts", { id, title, slots }),
    },
    emojiStatuses: {
      list: (id) => rpc.call("chatEmojiChoices", { id }),
      save: (id, change) => rpc.call("saveChatEmojiStatus", { id, ...change }),
    },
    load: (id) => rpc.call("chatInfo", { id }),
    removePhoto: (id, expected) => rpc.call("removeChatPhoto", { id, expected }),
    savePhoto: (id, base64, expected) => rpc.call("saveChatPhoto", { id, base64, expected }),
    saveVideo: (id, base64, expected, coverSeconds, trim) => rpc.call("saveChatVideo", { id, base64, expected, coverSeconds, trim }),
    save: (id, change) => rpc.call("saveChatInfo", { id, ...change }),
  }), [rpc]);
  const welcomeMessageActions = useMemo<import("./src/ui/chat-welcome-messages.tsx").ChatWelcomeMessageActions>(() => ({
    load: (id) => rpc.call("chatWelcomeMessages", { id }),
    loadPhoto: (id, messageId, revision, size, attachment) => rpc.call("chatWelcomePhoto", { id, messageId, revision, size, attachment }),
    listGifs: () => rpc.call("mediaChoices", "gif"),
    richLimits: () => rpc.call("richMessageLimits", {}),
    playback: (id, messageId, revision, attachment) => rpc.call("chatWelcomePlayback", { id, messageId, revision, attachment }),
    saveDocument: async (id, messageId, revision, attachment) => {
      const { name, url } = await rpc.call("chatWelcomeDocument", { id, messageId, revision, attachment });
      return await experimental_saveFile({ fileName: name, url }) === "started";
    },
    upload: async (input, file, progress, signal) => {
      const preparation = await rpc.call("prepareWelcomeMedia", input);
      if ("rejection" in preparation) return { state: "failed", rejection: preparation.rejection };
      return uploadQuickReplyDocument(preparation.url, file, progress, signal);
    },
    uploadRich: async (id, draft, files, progress, signal, replace) => {
      const prepared = await prepareRichMessageFiles(draft, files, signal).catch(() => undefined);
      if (!prepared) return { state: signal.aborted ? "cancelled" : "failed" };
      const { blob } = prepared;
      const upload = await rpc.call("prepareWelcomeRichUpload", { id, draft: prepared.draft, replace });
      if ("rejection" in upload) return { state: "failed", rejection: upload.rejection };
      return uploadQuickReplyDocument(upload.url, blob, (offset, canCancel) => progress(offset, blob.size, canCancel ?? true), signal);
    },
    stickers: {
      list: () => rpc.call("installedStickerPacks", null),
      page: (packId, offset) => rpc.call("stickerPackPage", { packId, offset }),
      artwork: (id, messageId, revision) => rpc.call("chatWelcomeSticker", { id, messageId, revision }),
    },
    change: (input) => rpc.call("changeChatWelcomeMessage", input),
  }), [rpc]);
  const chatPublicUsernameActions = useMemo<import("./src/ui/chat-public-username.tsx").ChatPublicUsernameActions>(() => ({
    load: (id) => rpc.call("chatPublicUsername", { id }),
    save: (id, username, expected) => rpc.call("saveChatPublicUsername", { id, username, expected }),
  }), [rpc]);
  const loadChatAutoDelete = useCallback((id: string) => rpc.call("chatAutoDelete", { id }), [rpc]);
  const saveChatAutoDelete = useCallback((id: string, days: number, expected: number) =>
    rpc.call("saveChatAutoDelete", { id, days, expected }), [rpc]);
  const clearChatHistoryByDate = useMemo<import("./src/ui/clear-chat-history-by-date.tsx").ClearChatHistoryByDateActions>(() => ({
    load: (id) => rpc.call("clearChatDateScopes", { id }),
    clear: (id, range, scope) => rpc.call("clearChatByDate", { id, range, scope }),
  }), [rpc]);
  const slowModeActions = useMemo<SlowModeActions>(() => ({
    load: (id) => rpc.call("groupSlowMode", { id }),
    save: (id, delay, expected) => rpc.call("saveGroupSlowMode", { id, delay, expected }),
  }), [rpc]);
  const groupMemberVisibilityActions = useMemo<GroupModerationActions>(() => ({
    load: async (id) => {
      const view = await rpc.call("groupMemberVisibility", { id });
      return view && { enabled: view.hidden, editable: view.editable };
    },
    save: (id, hidden, expected) => rpc.call("saveGroupMemberVisibility", { id, hidden, expected }),
  }), [rpc]);
  const groupAntiSpamActions = useMemo<GroupModerationActions>(() => ({
    load: (id) => rpc.call("groupAntiSpam", { id }),
    save: (id, enabled, expected) => rpc.call("saveGroupAntiSpam", { id, enabled, expected }),
  }), [rpc]);
  const groupPermissionActions = useMemo<GroupPermissionActions>(() => ({
    load: (id) => rpc.call("groupPermissions", { id }),
    save: (id, changes) => rpc.call("saveGroupPermissions", { id, changes }),
  }), [rpc]);
  const groupHistoryVisibilityActions = useMemo<GroupModerationActions>(() => ({
    load: (id) => rpc.call("groupHistoryVisibility", { id }),
    save: (id, enabled, expected) => rpc.call("saveGroupHistoryVisibility", { id, enabled, expected }),
  }), [rpc]);
  const chatContentProtectionActions = useMemo<GroupModerationActions>(() => ({
    load: (id) => rpc.call("chatContentProtection", { id }),
    save: (id, enabled, expected) => rpc.call("saveChatContentProtection", { id, enabled, expected }),
  }), [rpc]);
  const groupEntryActions = useMemo(() => {
    const forSetting = (setting: import("./src/core/contract.ts").GroupEntrySetting): GroupModerationActions => ({
      load: (id) => rpc.call("groupEntrySetting", { id, setting }),
      save: (id, enabled, expected) => rpc.call("saveGroupEntrySetting", { id, setting, enabled, expected }),
    });
    return { approval: forSetting("approval"), joinToSend: forSetting("joinToSend"), forum: forSetting("forum") };
  }, [rpc]);
  const joinRequestActions = useMemo<JoinRequestActions>(() => ({
    load: (id, query, cursor) => rpc.call("joinRequests", { id, query, ...(cursor ? { cursor } : {}) }),
    review: (id, userId, approve) => rpc.call("reviewJoinRequest", { id, userId, approve }),
  }), [rpc]);
  const chatInviteActions = useMemo<ChatInviteActions>(() => ({
    load: (id, cursor, revoked) => rpc.call("managedInvites", { id, cursor, revoked }),
    create: (id, draft) => rpc.call("createManagedInvite", { id, draft }),
    subscriptionLimit: (id) => rpc.call("subscriptionInviteLimit", { id }),
    createSubscription: (id, name, stars) => rpc.call("createSubscriptionInvite", { id, name, stars }),
    members: (id, link, cursor, expired) => rpc.call("managedInviteMembers", { id, link, cursor, expired }),
    revoke: (id, link) => rpc.call("revokeManagedInvite", { id, link }),
    deleteRevoked: (id, link) => rpc.call("deleteRevokedManagedInvite", { id, link }),
    edit: (id, link, expected, draft) => rpc.call("editManagedInvite", { id, link, expected, draft }),
  }), [rpc]);
  const chatBackgroundActions = useMemo<import("./src/ui/chat-background.tsx").ChatBackgroundActions>(() => ({
    load: (id) => rpc.call("chatBackground", { id }),
    save: (id, expected, color) => rpc.call("setChatBackground", { id, expected, color }),
    savePhoto: (id, expected, base64) => rpc.call("setChatBackgroundPhoto", { id, expected, base64 }),
    loadPhoto: (id, revision) => rpc.call("chatBackgroundPhoto", { id, revision }),
    loadPattern: (id, revision) => rpc.call("chatBackgroundPattern", { id, revision }),
    previewLink: (id, link) => rpc.call("previewChatBackgroundLink", { id, link }),
    saveLink: (id, expected, link, revision) => rpc.call("setChatBackgroundLink", { id, expected, link, revision }),
  }), [rpc]);
  const chatThemeActions = useMemo<import("./src/ui/chat-theme.tsx").ChatThemeActions>(() => ({
    load: (id) => rpc.call("chatTheme", { id }),
    save: (id, expected, name) => rpc.call("setChatTheme", { id, expected, name }),
  }), [rpc]);
  const [giftSettingsRevision, setGiftSettingsRevision] = useState(0);
  const profileGifts = useMemo<import("./src/ui/profile-gifts.tsx").ProfileGiftActions>(() => ({
    reviewResale: (id, payment) => rpc.call("reviewGiftResale", { id, payment }),
    confirmResale: (id, confirmation) => rpc.call("confirmGiftResale", { id, confirmation }),
    reviewBid: (id, bid) => rpc.call("reviewGiftAuctionBid", { id, bid }),
    confirmBid: (id, confirmation) => rpc.call("confirmGiftAuctionBid", { id, confirmation }),
    auction: (id, giftId, auctionId) => rpc.call("giftAuction", { id, giftId, auctionId }),
    resale: (id, query) => rpc.call("searchGiftResale", { id, ...query }),
    send: (id, giftId, confirmation, options) => rpc.call("confirmGiftSend", { id, giftId, confirmation, options }),
    quote: (id, giftId) => rpc.call("giftQuote", { id, giftId }),
    catalog: (id) => rpc.call("giftCatalog", { id }),
    showShortcut: (id) => rpc.call("chatGiftButton", { id }),
    animation: (id, fileId) => rpc.call("profileGiftAnimation", { id, fileId: Number(fileId) }),
    artwork: (id, fileId) => rpc.call("profileGiftArtwork", { id, fileId }),
    membership: (id, membership) => rpc.call("setProfileGiftMembership", { id, membership }),
    edit: (id, change) => rpc.call("editProfileGiftCollection", { id, change }),
    collections: (id) => rpc.call("profileGiftCollections", { id }),
    load: (id, collection, offset, includeHidden) => rpc.call("profileGifts", { id, collection, offset, includeHidden }),
    visibility: (id, gift, expected) => rpc.call("setProfileGiftVisibility", { id, gift, expected }),
    pin: (id, gift, expected) => rpc.call("setProfileGiftPinned", { id, gift, expected }),
    notifications: (id, expected, enabled) => rpc.call("setChannelGiftNotifications", { id, expected, enabled }),
    transferRecipients: async (query) => (await findChats(query, "main"))
      .filter(({ subtitle }) => subtitle === "Direct message" || subtitle === "Channel").map(({ id, name, subtitle }) => ({ id, name, subtitle })),
    reviewListing: (id, gift, price) => rpc.call("reviewGiftListing", { id, gift, price }),
    confirmListing: (id, gift, confirmation) => rpc.call("confirmGiftListing", { id, gift, confirmation }),
    reviewDropDetails: (id, gift) => rpc.call("reviewDropGiftDetails", { id, gift }),
    confirmDropDetails: (id, gift, confirmation) => rpc.call("confirmDropGiftDetails", { id, gift, confirmation }),
    reviewTransfer: (id, gift, recipient) => rpc.call("reviewProfileGiftTransfer", { id, gift, recipient }),
    confirmTransfer: (id, gift, confirmation) => rpc.call("confirmProfileGiftTransfer", { id, gift, confirmation }),
    reviewUpgrade: (id, gift) => rpc.call("reviewProfileGiftUpgrade", { id, gift }),
    confirmUpgrade: (id, gift, confirmation, keepOriginalDetails) => rpc.call("confirmProfileGiftUpgrade", { id, gift, confirmation, keepOriginalDetails }),
    reviewConversion: (id, gift) => rpc.call("reviewProfileGiftConversion", { id, gift }),
    confirmConversion: (id, gift, confirmation) => rpc.call("confirmProfileGiftConversion", { id, gift, confirmation }),
  }), [rpc, giftSettingsRevision, findChats]);
  const addProfileAudio = useCallback((id: string, messageId: string, fileId: number) =>
    rpc.call("addMessageProfileAudio", { id, messageId, fileId }), [rpc]);
  const profileAudio = useMemo<import("./src/ui/profile-audio.tsx").ProfileAudioActions>(() => ({
    list: (id, offset) => rpc.call("profileAudio", { id, offset }),
    playback: (id, index, fileId) => rpc.call("profileAudioPlayback", { id, index, fileId }),
    change: (id, change) => rpc.call("changeProfileAudio", { id, change }),
  }), [rpc]);
  const profilePhotos = useMemo<import("./src/ui/profile-photos.tsx").ProfilePhotoActions>(() => ({
    list: (id, offset) => rpc.call("profilePhotos", { id, offset }),
    load: (id, offset, photoId) => rpc.call("profilePhoto", { id, offset, photoId }),
    video: (id, offset, photoId, fileId) => rpc.call("profilePhotoVideo", { id, offset, photoId, fileId }),
  }), [rpc]);
  const revokeBotLocationAccess = useCallback((id: string) => rpc.call("revokeBotLocationAccess", { id }), [rpc]);
  const revokeBotEmojiAccess = useCallback((id: string) => rpc.call("revokeBotEmojiAccess", { id }), [rpc]);
  const loadPeerProfile = useCallback((id: string) => rpc.call("peerProfile", { id }), [rpc]);
  const inlineMiniApps = useMemo<InlineMiniAppActions>(() => ({
    launch: (id, messageId, { row, column, revision }) => rpc.call("launchInlineMiniApp", { id, messageId, row, column, revision }),
    close: (session) => rpc.call("closeMiniApp", { session }),
  }), [rpc]);
  const botMiniAppMenu = useMemo<import("./src/ui/mini-app.tsx").BotMiniAppMenuActions>(() => ({
    read: (id) => rpc.call("botMiniAppMenu", { id }),
    launch: (id, revision) => rpc.call("launchBotMiniAppMenu", { id, revision }),
    close: inlineMiniApps.close,
  }), [rpc, inlineMiniApps]);
  const attachmentMiniApps = useMemo<import("./src/ui/mini-app.tsx").AttachmentMiniAppActions>(() => ({
    list: (id, topic) => rpc.call("attachmentMiniApps", { id, topic }),
    launch: (id, app, topic) => rpc.call("launchAttachmentMiniApp", { id, app, topic }),
    close: inlineMiniApps.close,
  }), [rpc, inlineMiniApps]);
  const sideMenuMiniApps = useMemo<import("./src/ui/mini-app.tsx").SideMenuMiniAppActions>(() => ({
    list: () => rpc.call("sideMenuMiniApps", null),
    launch: (app, acceptedTerms) => rpc.call("launchSideMenuMiniApp", { app, acceptedTerms }),
    manage: {
      list: () => rpc.call("installedMenuMiniApps", null),
      remove: (app) => rpc.call("removeMenuMiniApp", { app }),
    },
  }), [rpc]);
  const attachmentMiniAppLinks = useMemo<import("./src/ui/mini-app.tsx").AttachmentMiniAppLinkActions>(() => ({
    preview: (url, id, topic) => rpc.call("previewAttachmentMiniAppLink", { url, id, topic }),
    chats: (url, query) => rpc.call("attachmentMiniAppLinkChats", { url, query }),
    destination: (url) => rpc.call("resolveAttachmentMiniAppDestination", { url }),
    launch: (url, id, expected, consent, topic) => rpc.call("launchAttachmentMiniAppLink", { url, id, expected, consent, topic }),
  }), [rpc]);
  const miniAppAgentActions = useMemo<import("./src/ui/mini-app-agent-panel.tsx").MiniAppAgentActions>(() => ({
    agentGrant: (session, threadId, mode, snapshot) => rpc.call("miniAppAgentGrant", { session, threadId, mode, snapshot }),
    agentRevoke: (session) => rpc.call("miniAppAgentRevoke", { session }),
    agentPoll: (session, snapshot, completed) => rpc.call("miniAppAgentPoll", { session, snapshot, ...(completed && { completed }) }),
  }), [rpc]);
  const miniAppSessionActions = useMemo<NonNullable<ContextType<typeof MiniAppSessionActions>>>(() => ({
    close: inlineMiniApps.close,
    ...miniAppAgentActions,
    agentThreads: miniAppAgentThreads,
    preferenceScope: navigationScope,
    subscribeToClosures: subscribeToMiniAppClosures,
    writeAccess: (session: string, confirm: boolean) => rpc.call("miniAppWriteAccess", { session, confirm }),
    previewPhone: (session: string) => rpc.call("previewMiniAppPhone", { session }),
    previewInvoice: (session: string, slug: string) => rpc.call("previewMiniAppInvoice", { session, slug }),
    payInvoice: (session: string, confirmation: string) => rpc.call("payMiniAppInvoice", { session, confirmation }),
    sharePhone: (session: string, confirmation: string) => rpc.call("shareMiniAppPhone", { session, confirmation }),
    previewEmojiAccess: (session) => rpc.call("previewMiniAppEmojiAccess", { session }),
    confirmEmojiAccess: (session, confirmation) => rpc.call("confirmMiniAppEmojiAccess", { session, confirmation }),
    previewEmojiStatus: (session, emoji, duration) => rpc.call("previewMiniAppEmojiStatus", { session, emoji, duration }),
    confirmEmojiStatus: (session, confirmation) => rpc.call("confirmMiniAppEmojiStatus", { session, confirmation }),
    locationAccess: (session, decision) => rpc.call("miniAppLocationAccess", { session, decision }),
    secureStorage: (session, operation) => rpc.call("miniAppSecureStorage", { session, operation }),
    deviceStorage: (session, operation) => rpc.call("miniAppDeviceStorage", { session, operation }),
    clipboardAccess: (session) => rpc.call("miniAppClipboardAccess", { session }),
    checkDownload: (session: string, url: string, fileName: string) => rpc.call("checkMiniAppDownload", { session, url, fileName }),
    invokeCustomMethod: (session: string, method: string, parameters: string) =>
      rpc.call("invokeMiniAppCustomMethod", { session, method, parameters }),
    previewPreparedMessage: (session, id) => rpc.call("previewMiniAppPreparedMessage", { session, id }),
    preparedThumbnail: (session, confirmation) => rpc.call("miniAppPreparedThumbnail", { session, confirmation }),
    preparedChats: (session, confirmation, query) => rpc.call("miniAppPreparedChats", { session, confirmation, query }),
    preparedTopics: (session, confirmation, id, query, cursor) => rpc.call("miniAppPreparedTopics", { session, confirmation, id, query, cursor }),
    sendPreparedMessage: (session, confirmation, id, expectedName, topic) => rpc.call("sendMiniAppPreparedMessage", { session, confirmation, id, expectedName, topic }),
    inlineChats: (session, types, query) => rpc.call("miniAppInlineChats", { session, types, query }),
    inlineTopics: (session, types, id, query, cursor) =>
      rpc.call("miniAppInlineTopics", { session, types, id, query, ...(cursor && { cursor }) }),
    inlineDestination: (session, types, id, topic) =>
      rpc.call("miniAppInlineDestination", { session, types, id, ...(topic && { topic }) }),
    previewChatRequest: (session, requestId) => rpc.call("previewMiniAppChatRequest", { session, requestId }),
    findRequestedChats: (session, confirmation, query) => rpc.call("findMiniAppRequestedChats", { session, confirmation, query }),
    shareRequestedChats: (session, confirmation, selected) => rpc.call("shareMiniAppRequestedChats", { session, confirmation, selected }),
    createRequestedChat: (session, confirmation, title, username) => rpc.call("createMiniAppRequestedChat", { session, confirmation, title, username }),
    createManagedBot: (session, confirmation, draft) => rpc.call("createMiniAppManagedBot", { session, confirmation, draft }),
  }), [miniAppAgentActions, miniAppAgentThreads, navigationScope, rpc, inlineMiniApps.close, subscribeToMiniAppClosures]);
  const launchProfileMiniApp = useCallback((id: string) => rpc.call("launchProfileMiniApp", { id }), [rpc]);
  const launchMiniApp = useCallback((url: string) => rpc.call("launchMiniApp", { url }), [rpc]);
  const loadCommonGroups = useCallback((id: string, after?: string) => rpc.call("commonGroups", { id, after }), [rpc]);
  const loadChatMembers = useCallback((id: string, query: string, offset?: number, filter?: import("./src/core/contract.ts").ChatMemberFilter) =>
    rpc.call("chatMembers", { id, query, offset, filter }), [rpc]);
  const setChatMemberTag = useCallback<import("./src/ui/chat-members.tsx").SetChatMemberTag>((id, userId, expected, tag) =>
    rpc.call("setChatMemberTag", { id, userId, expected, tag }), [rpc]);
  const chatMemberInvite = useMemo<import("./src/ui/chat-member-invite.tsx").ChatMemberInviteActions>(() => ({
    canAdd: (id, title) => rpc.call("canAddChatMember", { id, title }),
    add: (id, title, contacts) => rpc.call("addChatMembers", { id, title, contacts }),
    load: contactActions.load,
  }), [rpc, contactActions]);
  const saveChatAdministrator = useCallback<import("./src/ui/chat-members.tsx").SaveChatAdministrator>((id, userId, available, selected, expected) =>
    rpc.call("saveChatAdministrator", { id, userId, available, selected, expected }), [rpc]);
  const demoteChatAdministrator = useCallback((id: string, userId: string) => rpc.call("demoteChatAdministrator", { id, userId }), [rpc]);
  const restrictChatMember = useCallback((...args: Parameters<import("./src/ui/chat-members.tsx").RestrictChatMember>) => {
    const [id, userId, duration, expected, denied, previous] = args;
    return rpc.call("restrictChatMember", { id, userId, duration, expected, denied, previous });
  }, [rpc]);
  const liftChatMemberRestrictions = useCallback((id: string, userId: string, until: number, isMember: boolean) =>
    rpc.call("liftChatMemberRestrictions", { id, userId, until, isMember }), [rpc]);
  const communityModeration = useMemo<import("./src/ui/chat-members.tsx").CommunityModeration>(() => ({
    preview: (id, userId) => rpc.call("previewCommunityBan", { id, userId }),
    ban: (change) => rpc.call("banCommunityMember", change),
    previewUnban: (id, memberId, bannedUntil) => rpc.call("previewCommunityUnban", { id, memberId, bannedUntil }),
    unban: (change) => rpc.call("unbanCommunityMember", change),
  }), [rpc]);
  const banChatMember = useCallback((id: string, userId: string, role: "member" | "restricted", duration: import("./src/core/contract.ts").MemberBanDuration) =>
    rpc.call("banChatMember", { id, userId, role, duration }), [rpc]);
  const moderateChatMember = useCallback<import("./src/ui/chat-members.tsx").ModerateChatMember>(
    (change) => rpc.call("moderateChatMember", change), [rpc]);
  const banMessageChatSender = useCallback((id: string, messageId: string, senderChatId: string) =>
    rpc.call("banMessageChatSender", { id, messageId, senderChatId }), [rpc]);
  const unbanChatMember = useCallback((id: string, memberId: string, bannedUntil: number) =>
    rpc.call("unbanChatMember", memberId.startsWith("-")
      ? { id, senderChatId: memberId, bannedUntil } : { id, userId: memberId, bannedUntil }), [rpc]);
  const canScheduleWhenOnline = useCallback((id: string) => rpc.call("canScheduleWhenOnline", { id }), [rpc]);
  const scheduledMessages = useCallback((id: string, topicId?: number) =>
    rpc.call("scheduledMessages", { id, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const changeScheduledMessage = useCallback((id: string, row: import("./src/core/contract.ts").ScheduledMessage, at: number | null, topicId?: number) =>
    rpc.call("changeScheduledMessage", { id, expected: row, at, ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const cancelScheduledMessage = useCallback((id: string, messageId: string, topicId?: number,
    album?: import("./src/core/contract.ts").ScheduledAlbumCancellation) =>
    rpc.call("cancelScheduledMessage", { id, messageId, ...(topicId === undefined ? {} : { topicId }), ...(album ? { album } : {}) }), [rpc]);
  const savedSources = useMemo(() => ({
    list: (offset: number) => rpc.call("savedSources", { offset }),
    listTags: (sourceId: string) => rpc.call("savedSourceTags", { sourceId }),
    setPinned: (sourceId: string, pinned: boolean, expected: boolean) => rpc.call("setSavedSourcePinned", { sourceId, pinned, expected }),
    reorderPinned: (order: string[], expected: string[]) => rpc.call("reorderSavedSources", { order, expected }),
    history: (sourceId: string, before?: string, query?: string, date?: number, filter?: import("./src/core/contract.ts").SavedSourceFilter,
      tag?: import("./src/core/contract.ts").SavedTagType) => rpc.call("savedSourceHistory", { sourceId, before, query, date, filter, tag }),
  }), [rpc]);
  const loadHistory = useCallback((id: string, before?: string) => rpc.call("history", before === undefined ? { id } : { id, before }), [rpc]);
  const loadUnreadHistory = useCallback((id: string, after?: string, topicId?: number) =>
    rpc.call("unreadHistory", { id, ...(after === undefined ? {} : { after }), ...(topicId === undefined ? {} : { topicId }) }), [rpc]);
  const manageForumTopic = useCallback((id: string, action: ForumTopicAction) =>
    rpc.call("manageForumTopic", { id, action }), [rpc]);
  const deleteForumTopic = useCallback((id: string, topic: number, name: string) =>
    rpc.call("deleteForumTopic", { id, topic, name }), [rpc]);
  const pinnedForumTopicOrder = useCallback((id: string) => rpc.call("pinnedForumTopicOrder", { id }), [rpc]);
  const movePinnedForumTopic = useCallback((id: string, topic: number, direction: "up" | "down", expected: number[]) =>
    rpc.call("movePinnedForumTopic", { id, topic, direction, expected }), [rpc]);
  const markForumRead = useCallback((id: string) => rpc.call("markForumRead", { id }), [rpc]);
  const markForumTopicRead = useCallback((id: string, topic: number) => rpc.call("markForumTopicRead", { id, topic }), [rpc]);
  const loadForumTopicPage = useCallback((id: string, query: string, cursor?: NonNullable<ForumTopicPage["next"]>) =>
    rpc.call("forumTopicPage", { id, query, ...(cursor ? { cursor } : {}) }), [rpc]);
  const loadForumTopics = useCallback((id: string, query: string) => rpc.call("forumTopics", { id, query }), [rpc]);
  const sendTopicText = useCallback((id: string, topic: ForumTopicTarget, text: string, replyTo?: string, styles?: import("./src/core/contract.ts").StyledRange[], quote?: import("./src/core/contract.ts").ReplyQuote, delivery?: import("./src/core/contract.ts").TopicDelivery) =>
    rpc.call("sendTopicText", { id, topic, text, ...(replyTo === undefined ? {} : { replyTo }), ...(styles ? { styles } : {}), ...(quote ? { quote } : {}), ...(delivery ? { delivery } : {}) }), [rpc]);
  const loadTopicHistory = useCallback((id: string, topicId: number, before?: string) => rpc.call("history", before === undefined ? { id, topicId } : { id, topicId, before }), [rpc]);

  const readRuntime = useCallback(() => rpc.call("runtimeInfo", null), [rpc]);
  const canScheduleRepeats = useCallback(async () => (await readRuntime()).premium === true, [readRuntime]);
  const storyDeletionListeners = useRef(new Set<(event: StoryReference) => void>());
  const storyFeedListeners = useRef(new Set<() => void>());
  const storyStealthListeners = useRef(new Set<(times: StoryStealthTimes) => void>());
  useRealtime(storyDeletedChannel, (payload) => {
    const event = storyReference.safeParse(payload);
    if (event.success) for (const listener of storyDeletionListeners.current) listener(event.data);
  });
  useRealtime(storyFeedChangedChannel, () => {
    for (const listener of storyFeedListeners.current) listener();
  });
  useRealtime(storyStealthChangedChannel, (payload) => {
    const result = storyStealthTimes.safeParse(payload);
    if (result.success) for (const listener of storyStealthListeners.current) listener(result.data);
  });
  const [communityRevision, setCommunityRevision] = useState(0);
  useRealtime(communityChangedChannel, () => setCommunityRevision((value) => value + 1));
  const [communityRows, setCommunityRows] = useState<{ connection: string; groups: import("./src/core/contract.ts").CollapsedCommunity[] }>();
  const collapsedCommunities = communityRows?.connection === connection ? communityRows?.groups : undefined;
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("collapsedCommunities", null).then(
      (groups) => { if (active) setCommunityRows({ connection, groups }); },
      () => {},
    );
    return () => { active = false; };
  }, [connection, rpc, revision, communityRevision]);
  const [folderCommunityRows, setFolderCommunityRows] = useState<{
    connection: string; id: number; rows: import("./src/core/contract.ts").FolderCommunities | null;
  }>();
  const folderCommunities = folderCommunityRows && folderCommunityRows.connection === connection
    && folderCommunityRows.id === list ? folderCommunityRows.rows : undefined;
  useEffect(() => {
    if (!connection || typeof list !== "number") return;
    let active = true;
    void rpc.call("folderCommunities", { id: list }).then(
      (rows) => { if (active) setFolderCommunityRows({ connection, id: list, rows }); },
      () => { if (active) setFolderCommunityRows({ connection, id: list, rows: null }); },
    );
    return () => { active = false; };
  }, [connection, list, rpc, revision, communityRevision]);
  const communityActions = useMemo<import("./src/ui/community-browser.tsx").CommunityActions>(() => ({
    list: () => rpc.call("joinedCommunities", null),
    chats: (id) => rpc.call("communityChats", { id }),
    forwardChats: (id) => rpc.call("communityForwardChats", { id }),
    folders: {
      read: (id) => rpc.call("communityFolderMemberships", { id }),
      change: (input) => rpc.call("changeCommunityFolder", input),
    },
    unbanListedMember: (input) => rpc.call("unbanFromCommunityList", input),
    bannedMembers: (id, offset) => rpc.call("communityBannedMembers", { id, offset }),
    moderationCounts: (id) => rpc.call("communityModerationCounts", { id }),
    collapse: async (input) => {
      const result = await rpc.call("changeCommunityCollapse", input);
      if (result === "saved" || result === "changed") setRevision((value) => value + 1);
      return result;
    },
    candidates: () => rpc.call("communitySourceChats", null),
    create: (input) => rpc.call("createCommunity", input),
    rename: (input) => rpc.call("renameCommunity", input),
    remove: (input) => rpc.call("deleteCommunity", input),
    changePermissions: (input) => rpc.call("changeCommunityPermissions", input),
    photos: {
      read: (id) => rpc.call("communityPhotoState", { id }),
      save: (id, expected, base64) => rpc.call("saveCommunityPhoto", { id, expected, base64 }),
      saveVideo: (id, expected, base64, coverSeconds, trim) => rpc.call("saveCommunityVideo", { id, expected, base64, coverSeconds, trim }),
      remove: (id, expected) => rpc.call("removeCommunityPhoto", { id, expected }),
    },
    avatar: (id, fileId) => rpc.call("communityAvatar", { id, fileId }),
    avatarVideo: {
      read: (id) => rpc.call("communityAvatarVideoInfo", { id }),
      stream: (id, { photoId, fileId }) => rpc.call("communityAvatarVideo", { id, photoId, fileId }),
    },
    notifications: (id) => rpc.call("communityNotificationState", { id }),
    changeNotification: (input) => rpc.call("changeCommunityNotification", input),
    changeChat: (input) => rpc.call("changeCommunityChat", input),
    requests: (id, offset) => rpc.call("communityAddRequests", { id, offset }),
    decide: (input) => rpc.call("decideCommunityAddRequest", input),
    decideAll: (input) => rpc.call("decideCommunityAddRequests", input),
  }), [rpc]);
  const storyActions = useMemo<StoryActions>(() => ({
    subscribeToDeletions: (listener) => {
      storyDeletionListeners.current.add(listener);
      return () => { storyDeletionListeners.current.delete(listener); };
    },
    subscribeToFeedChanges: (listener) => {
      storyFeedListeners.current.add(listener);
      return () => { storyFeedListeners.current.delete(listener); };
    },
    subscribeToStealthChanges: (listener) => {
      storyStealthListeners.current.add(listener);
      return () => { storyStealthListeners.current.delete(listener); };
    },
    stealthStatus: () => rpc.call("storyStealthStatus", null),
    activateStealth: () => rpc.call("activateStoryStealth", null),
    feed: (list, more) => rpc.call("storyFeed", { list, more }),
    profile: (id, before) => rpc.call("profileStories", { id, before }),
    music: (id, story, fileId) => rpc.call("storyMusicPlayback", { id, story, fileId }),
    postLink: (id, story, post) => rpc.call("storyAreaPostLink", { id, story, post }),
    resolveAlbumLink: (url) => rpc.call("resolveStoryAlbumLink", { url }),
    albumLink: (id, album) => rpc.call("storyAlbumLink", { id, album: Number(album) }),
    albums: (id) => rpc.call("storyAlbums", { id }),
    albumPage: (id, album, offset) => rpc.call("storyAlbumPage", { id, album, offset }),
    profileEditable: (id) => rpc.call("storyProfileEditable", { id }),
    setProfileOrder: (id, expected, order) => rpc.call("setProfileStoryOrder", { id, expected, order }),
    setAlbumOrder: (id, expected, order) => rpc.call("setStoryAlbumOrder", { id, expected, order }),
    setAlbumStoryOrder: (id, album, expected, order) => rpc.call("setStoryAlbumStoryOrder", { id, album, expected, order }),
    albumCandidates: (id, archive, before) => rpc.call("storyAlbumCandidates", { id, archive, before }),
    createAlbum: (id, name, stories) => rpc.call("createStoryAlbum", { id, name, stories }),
    changeAlbum: (id, album, change) => rpc.call("changeStoryAlbum", { id, album, change }),
    ownArchive: (id, before) => rpc.call("ownArchivedStories", { id, before }),
    report: (id, story, step) => rpc.call("reportStory", { id, story, step }),
    reply: (id, story, text) => rpc.call("replyToStory", { id, story, text }),
    resolveLink: (url) => rpc.call("resolveStoryLink", { url }),
    link: (id, story) => rpc.call("storyLink", { id, story: Number(story) }),
    interactions: (id, story, offset, filter) => rpc.call("storyInteractions", { id, story, offset, filter }),
    changeAudience: (id, story, expected, audience) => rpc.call("changeStoryAudience", { id, story, expected, audience }),
    editCaption: (id, story, expected, caption) => rpc.call("editStoryCaption", { id, story, expected, caption }),
    manage: (id, story, action) => rpc.call("manageStory", { id, story, action }),
    view: (id, story) => rpc.call("storyView", { id, story }),
    viewing: (id, story, opened) => rpc.call("storyViewing", { id, story, opened }),
    reactSuggested: (id, story, reaction, remove) => rpc.call("setStorySuggestedReaction", { id, story, reaction, remove }),
    react: (id, story, emoji) => rpc.call("setStoryReaction", { id, story, emoji }),
    reactionCatalog: (id, story) => rpc.call("storyReactionCatalog", { id, story }),
    reactFromCatalog: (id, story, reaction) => rpc.call("setStoryCatalogReaction", { id, story, reaction }),
    move: (id, from) => rpc.call("moveStoryAuthor", { id, from }),
  }), [rpc]);
  const proxyActions = useMemo<ProxyActions>(() => ({
    load: () => rpc.call("proxies", null),
    save: (draft, id) => rpc.call("saveProxy", { draft, id }),
    change: (input) => rpc.call("changeProxy", input),
    ping: (id) => rpc.call("pingProxy", { id }),
  }), [rpc]);
  const exportAccount = useCallback(async (options: ChatExportOptions) => {
    const file = await rpc.call("exportTelegramAccount", options);
    return await experimental_saveFile({ fileName: file.name, url: file.url }) === "started";
  }, [rpc]);
  const exportChat = useCallback(async (id: string, options: ChatExportOptions) => {
    const file = await rpc.call("exportChat", { id, options });
    return await experimental_saveFile({ fileName: file.name, url: file.url }) === "started";
  }, [rpc]);
  const listBusinessStickerPacks = useCallback(() => rpc.call("installedStickerPacks", null), [rpc]);
  const loadBusinessStickerPack = useCallback((packId: string, offset: number) => rpc.call("stickerPackPage", { packId, offset }), [rpc]);
  const findBusinessRecipients = useCallback(async (query: string) => (await findChats(query, "main"))
    .filter((chat) => chat.subtitle === "Direct message" && /^[1-9]\d{0,15}$/.test(chat.id)), [findChats]);
  const chatBusinessBot = useMemo<import("./src/ui/chat-business-bot.tsx").ChatBusinessBotActions>(() => ({
    read: (id) => rpc.call("chatBusinessBot", { id }),
    change: (input) => rpc.call("changeChatBusinessBot", input),
  }), [rpc]);
  const readBusinessBot = useCallback(() => rpc.call("businessBot", null), [rpc]);
  const confirmBusinessBot = useCallback((revision: string) => rpc.call("confirmBusinessBot", { revision }), [rpc]);
  const findBusinessBot = useCallback((username: string) => rpc.call("findBusinessBot", { username }), [rpc]);
  const saveBusinessBot = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessBot.input>) =>
    rpc.call("saveBusinessBot", input), [rpc]);
  const readBusinessAway = useCallback(() => rpc.call("businessAway", null), [rpc]);
  const saveBusinessAway = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessAway.input>) =>
    rpc.call("saveBusinessAway", input), [rpc]);
  const readBusinessGreeting = useCallback(() => rpc.call("businessGreeting", null), [rpc]);
  const saveBusinessGreeting = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessGreeting.input>) =>
    rpc.call("saveBusinessGreeting", input), [rpc]);
  const readBusinessHours = useCallback(() => rpc.call("businessHours", null), [rpc]);
  const saveBusinessHours = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessHours.input>) =>
    rpc.call("saveBusinessHours", input), [rpc]);
  const readBusinessLocation = useCallback(() => rpc.call("businessLocation", null), [rpc]);
  const readBusinessChatLinks = useCallback(() => rpc.call("businessChatLinks", null), [rpc]);
  const changeBusinessChatLink = useCallback((input: import("zod").z.input<typeof schemas.changeBusinessChatLink.input>) =>
    rpc.call("changeBusinessChatLink", input), [rpc]);
  const saveBusinessLocation = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessLocation.input>) =>
    rpc.call("saveBusinessLocation", input), [rpc]);
  const readBusinessStartPage = useCallback(() => rpc.call("businessStartPage", null), [rpc]);
  const saveBusinessStartPage = useCallback((input: import("zod").z.input<typeof schemas.saveBusinessStartPage.input>) =>
    rpc.call("saveBusinessStartPage", input), [rpc]);
  const loadQuickReplies = useCallback(() => rpc.call("quickReplies", null), [rpc]);
  const loadChatQuickReplies = useCallback((chatId: string) => rpc.call("quickReplies", { chatId }), [rpc]);
  const loadQuickReplyMessages = useCallback((id: number) => rpc.call("quickReplyMessages", { id }), [rpc]);
  const loadQuickReplyPhoto = useCallback((id: number, messageId: number, fileId: number, size?: PhotoSize, pollSlot?: PollAttachmentReference["slot"]) =>
    rpc.call("quickReplyPhoto", { id, messageId, fileId, size, pollSlot }), [rpc]);
  const saveQuickReplyDocument = useCallback(async (id: number, messageId: number, fileId: number, pollSlot?: PollAttachmentReference["slot"]) => {
    const { name, url } = await rpc.call("quickReplyDocument", { id, messageId, fileId, pollSlot });
    return await experimental_saveFile({ fileName: name, url }) === "started";
  }, [rpc]);
  const loadQuickReplyTgsSticker = useCallback((id: number, messageId: number, fileId: number) =>
    rpc.call("quickReplyTgsSticker", { id, messageId, fileId }), [rpc]);
  const loadQuickReplyPollSticker = useCallback((id: number, messageId: number, reference: PollAttachmentReference) =>
    rpc.call("quickReplyPollSticker", { id, messageId, reference }), [rpc]);
  const loadQuickReplyPlayback = useCallback((id: number, messageId: number, fileId: number, pollSlot?: PollAttachmentReference["slot"]) =>
    rpc.call("quickReplyPlayback", { id, messageId, fileId, pollSlot }), [rpc]);
  const renameQuickReply = useCallback((id: number, expected: string, name: string) =>
    rpc.call("renameQuickReply", { id, expected, name }), [rpc]);
  const addQuickReplyText = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyText.input>) =>
    rpc.call("addQuickReplyText", input), [rpc]);
  const addQuickReplyDocument = useCallback<import("./src/ui/quick-replies.tsx").AddQuickReplyDocument>(async (input, file, progress, signal) => {
    const preparation = await rpc.call("prepareQuickReplyDocument", input);
    if ("rejection" in preparation) return { state: "failed" };
    return uploadQuickReplyDocument(preparation.url, file, progress, signal);
  }, [rpc]);
  const addQuickReplyContact = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyContact.input>) =>
    rpc.call("addQuickReplyContact", input), [rpc]);
  const addQuickReplyPoll = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyPoll.input>) =>
    rpc.call("addQuickReplyPoll", input), [rpc]);
  const addQuickReplyLocation = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyLocation.input>) =>
    rpc.call("addQuickReplyLocation", input), [rpc]);
  const addQuickReplySticker = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplySticker.input>) =>
    rpc.call("addQuickReplySticker", input), [rpc]);
  const addQuickReplyPhoto = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyPhoto.input>) =>
    rpc.call("addQuickReplyPhoto", input), [rpc]);
  const addQuickReplyPhotoAlbum = useCallback((input: import("zod").z.input<typeof schemas.addQuickReplyPhotoAlbum.input>) =>
    rpc.call("addQuickReplyPhotoAlbum", input), [rpc]);
  const addQuickReplyMixedAlbum = useCallback<import("./src/ui/quick-replies.tsx").AddQuickReplyMixedAlbum>(async (input, items, progress, signal) => {
    const preparation = await rpc.call("prepareQuickReplyAlbumUpload", { ...input,
      items: items.map((item) => item.kind === "photo" ? item : item.kind === "livePhoto"
        ? { kind: item.kind, name: item.file.name.slice(0, 255), size: item.file.size,
          photo: typeof item.photo === "string" ? item.photo : { heicBytes: item.photo.size } }
        : { kind: item.kind, name: item.file.name, size: item.file.size }),
    });
    if ("rejection" in preparation) return { state: "failed" };
    const files = new Blob(items.flatMap((item) => item.kind === "photo" ? [] : item.kind === "livePhoto" && typeof item.photo !== "string"
      ? [item.photo, item.file] : [item.file]));
    return uploadQuickReplyDocument(preparation.url, files, progress, signal);
  }, [rpc]);
  const deleteQuickReply = useCallback((input: { id: number; name: string; messageCount: number }) =>
    rpc.call("deleteQuickReply", input), [rpc]);
  const reorderQuickReplies = useCallback((input: { ids: number[]; expected: number[] }) =>
    rpc.call("reorderQuickReplies", input), [rpc]);
  const editQuickReplyText = useCallback((input: import("zod").z.input<typeof schemas.editQuickReplyText.input>) =>
    rpc.call("editQuickReplyText", input), [rpc]);
  const deleteQuickReplyMessage = useCallback((input: import("zod").z.input<typeof schemas.deleteQuickReplyMessage.input>) =>
    rpc.call("deleteQuickReplyMessage", input), [rpc]);
  const retryQuickReplyMessage = useCallback((input: import("zod").z.input<typeof schemas.retryQuickReplyMessage.input>) =>
    rpc.call("retryQuickReplyMessage", input), [rpc]);
  const sendQuickReply = useCallback<SendQuickReply>((input) => rpc.call("sendQuickReply", input), [rpc]);
  const readNetworkUsage = useCallback(() => rpc.call("networkUsage", null), [rpc]);
  const resetNetworkUsage = useCallback(() => rpc.call("resetNetworkUsage", null), [rpc]);
  const [automaticPlayback, setAutomaticPlayback] = useState<AutoPlaybackPolicy>();
  useEffect(() => {
    if (auth.state !== "ready") return;
    let active = true;
    void rpc.call("autoPlaybackPolicy", null).then((policy) => { if (active) setAutomaticPlayback(policy); }, () => {});
    return () => { active = false; };
  }, [auth.state, rpc]);
  const saveAutomaticPlayback = useCallback(async (policy: AutoPlaybackPolicy) => {
    const saved = await rpc.call("setAutoPlaybackPolicy", policy);
    setAutomaticPlayback(saved);
    return saved;
  }, [rpc]);
  const [automaticMedia, setAutomaticMedia] = useState<AutoMediaPolicy>();
  useEffect(() => {
    if (auth.state !== "ready") return;
    let active = true;
    void rpc.call("autoMediaPolicy", null).then((policy) => { if (active) setAutomaticMedia(policy); }, () => {});
    return () => { active = false; };
  }, [auth.state, rpc]);
  const saveAutomaticMedia = useCallback(async (policy: AutoMediaPolicy) => {
    const saved = await rpc.call("setAutoMediaPolicy", policy);
    setAutomaticMedia(saved);
    return saved;
  }, [rpc]);
  const [mediaExceptions, setMediaExceptions] = useState<{ connection: string; overrides: AutoMediaOverrides }>();
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("autoMediaOverrides", null).then((overrides) => {
      if (active) setMediaExceptions({ connection, overrides });
    }, () => {});
    return () => { active = false; };
  }, [connection, rpc]);
  const automaticMediaOverrides = mediaExceptions?.connection === connection ? mediaExceptions?.overrides : undefined;
  const saveChatMediaOverride = useCallback(async (id: string, limits: AutoMediaLimits | null) => {
    const saved = await rpc.call("setChatAutoMediaOverride", { id, limits });
    setMediaExceptions((previous) => {
      if (!previous || previous.connection !== connection) return previous;
      const overrides = { ...previous.overrides };
      if (saved) overrides[id] = saved;
      else delete overrides[id];
      return { connection: previous.connection, overrides };
    });
    return saved;
  }, [connection, rpc]);
  const [playbackExceptions, setPlaybackExceptions] = useState<{ connection: string; overrides: AutoPlaybackOverrides }>();
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("autoPlaybackOverrides", null).then((overrides) => {
      if (active) setPlaybackExceptions({ connection, overrides });
    }, () => {});
    return () => { active = false; };
  }, [connection, rpc]);
  const automaticPlaybackOverrides = playbackExceptions?.connection === connection ? playbackExceptions?.overrides : undefined;
  const saveChatPlaybackOverride = useCallback(async (id: string, limits: AutoPlaybackLimits | null) => {
    const saved = await rpc.call("setChatAutoPlaybackOverride", { id, limits });
    setPlaybackExceptions((previous) => {
      if (!previous || previous.connection !== connection) return previous;
      const overrides = { ...previous.overrides };
      if (saved === null) delete overrides[id];
      else overrides[id] = saved;
      return { connection: previous.connection, overrides };
    });
    return saved;
  }, [connection, rpc]);
  const prefetchVisibleMedia = useCallback((id: string, messageId: string, topicId?: number) =>
    rpc.call("prefetchVisibleMedia", { id, messageId, topicId }), [rpc]);
  const readCache = useCallback(() => rpc.call("cacheInfo", null), [rpc]);
  const setCacheLimit = useCallback((limitMiB: number, retentionDays?: number) =>
    rpc.call("setCacheLimit", { limitMiB, ...(retentionDays === undefined ? {} : { retentionDays }) }), [rpc]);
  const clearCache = useCallback((category?: import("./src/core/contract.ts").ClearableCacheCategory) =>
    rpc.call("clearCache", category ? { category } : null), [rpc]);
  const clearChatCache = useCallback((chatId: string) => rpc.call("clearCache", { chatId }), [rpc]);
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
      if (next.state === "idle") {
        if (draftScope) draftBuckets.delete(draftScope);
        if (navigationScope) forgetConversationLocation(navigationScope);
      }
      setPassword("");
      setList("main");
      return next;
    });
  }

  const loadAccounts = useCallback(() => transport.call("accountSelection", null), [transport]);
  async function selectAccount(selection: SelectTelegramAccount) {
    try {
      await runAuthAction(async () => {
        setAuth({ state: "disconnecting" });
        const next = await rpc.call("selectTelegramAccount", selection);
        setPassword("");
        setList("main");
        return next;
      });
    } catch {
      setAuth(await transport.call("status", null).catch(() => ({ state: "idle" as const })));
      setNotice("Could not switch Telegram accounts.");
    }
  }
  const accountsPanel = <TelegramAccounts key={connectionId ?? auth.state} load={loadAccounts} select={selectAccount}
    rename={(change) => rpc.call("renameTelegramAccount", change)} disabled={busy} />;

  async function connect() {
    try { await runAuthAction(() => rpc.call("connect", null)); }
    catch { setNotice("Could not start Telegram sign-in."); }
  }

  useEffect(() => {
    if (checkingStatus || initialConnectionChecked.current) return;
    initialConnectionChecked.current = true;
    if (auth.state === "idle") void connect();
  }, [checkingStatus, auth.state]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    const value = password;
    setPassword("");
    try { await runAuthAction(() => rpc.call("password", { password: value })); }
    catch { setNotice("Telegram did not accept the password. Try again."); }
  }

  const profileActions = useMemo<ProfileActions>(() => ({
    emojiStatuses: {
      list: () => rpc.call("profileEmojiChoices", null),
      save: (change) => rpc.call("saveProfileEmojiStatus", change),
    },
    load: () => rpc.call("telegramProfile", null),
    personalChannel: {
      load: () => rpc.call("personalChannelSettings", null),
      save: (change) => rpc.call("savePersonalChannel", change),
    },
    createTemporaryLink: () => rpc.call("temporaryProfileLink", null),
    photos: {
      list: (_, offset) => rpc.call("ownProfilePhotos", { offset }),
      load: (_, offset, photoId) => rpc.call("ownProfilePhoto", { offset, photoId }),
      video: (_, offset, photoId, fileId) => rpc.call("profilePhotoVideo", { offset, photoId, fileId }),
      restore: (offset, photoId, expected) => rpc.call("restoreProfilePhoto", { offset, photoId, expected }),
      remove: (offset, photoId, expected) => rpc.call("removePreviousProfilePhoto", { offset, photoId, expected }),
    },
    removePhoto: (expected) => rpc.call("removeProfilePhoto", { expected }),
    savePhoto: (base64, expected) => rpc.call("saveProfilePhoto", { base64, expected }),
    saveVideo: (base64, expected, coverSeconds, trim) => rpc.call("saveProfileVideo", { base64, expected, coverSeconds, trim }),
    check: (username) => rpc.call("checkTelegramUsername", { username }),
    save: async (change) => {
      const result = await rpc.call("saveTelegramProfile", change);
      if (change.kind === "gifts" && result === "saved") setGiftSettingsRevision((revision) => revision + 1);
      return result;
    },
  }), [rpc]);
  const privacyActions = useMemo<TelegramPrivacyActions>(() => ({
    exceptions: {
      load: (key, offset, version) => rpc.call("privacyExceptions", { key, offset, version }),
      search: (query) => rpc.call("searchPrivacyExceptionTargets", { query }),
      change: (change) => rpc.call("changePrivacyException", change),
      changePremiumInvites: (version, allowed) => rpc.call("changePremiumInvites", { version, allowed }),
    },
    publicPhoto: {
      load: () => rpc.call("publicProfilePhoto", null),
      save: (base64, expected) => rpc.call("savePublicProfilePhoto", { base64, expected }),
      remove: (expected) => rpc.call("removePublicProfilePhoto", { expected }),
    },
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
    newChatPrivacy: {
      load: () => rpc.call("newChatPrivacy", null),
      save: (audience, expected) => rpc.call("saveNewChatPrivacy", { audience, expected }),
    },
    sensitiveContent: {
      load: () => rpc.call("sensitiveContentSettings", null),
      save: (show, expected) => rpc.call("saveSensitiveContentSettings", { show, expected }),
      launchVerification: (expectedBot) => rpc.call("launchAgeVerification", { expectedBot }),
    },
    loadReadDate: () => rpc.call("readDatePrivacy", null),
    saveReadDate: (show, expected) => rpc.call("saveReadDatePrivacy", { show, expected }),
    save: (key, audience, expected) => rpc.call("saveTelegramPrivacy", { key, audience, expected }),
  }), [rpc]);
  const loadActiveDevices = useCallback(() => rpc.call("activeDevices", null), [rpc]);
  const incomingCallSettings = useMemo<IncomingCallSettingsActions>(() => ({
    load: () => rpc.call("incomingCalls", null),
    save: (enabled, expected) => rpc.call("setIncomingCalls", { enabled, expected }),
  }), [rpc]);
  const [callRevision, setCallRevision] = useState(0);
  const [callStatus, setCallStatus] = useState<{ scope: string; value: PrivateCallStatus }>();
  useRealtime(privateCallChangedChannel, () => setCallRevision((number) => number + 1));
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void rpc.call("privateCallStatus", callCameraClient ? { cameraClient: callCameraClient } : null).then((value) => {
      if (active) setCallStatus({ scope: connection, value });
    }, () => {});
    return () => { active = false; };
  }, [callRevision, connection, rpc]);
  const privateCall: PrivateCallControls | undefined = callStatus && callStatus.scope === connection ? {
    ...callStatus.value,
    start: (chatId, video) => rpc.call("startPrivateCall", { chatId, video, ...(video && { cameraClient: callCameraClient }) }),
    act: (id, action) => rpc.call("actOnPrivateCall", { ...(id !== undefined && { id }), action,
      ...((action === "accept-video" || action === "camera-on") && { cameraClient: callCameraClient }) }),
  } : undefined;
  const confirmDevice = useCallback((id: string, revision: string) => rpc.call("confirmDevice", { id, revision }), [rpc]);
  const sessionInactivity = useMemo<SessionInactivityActions>(() => ({
    load: () => rpc.call("sessionInactivity", null),
    save: (days, expected) => rpc.call("setSessionInactivity", { days, expected }),
  }), [rpc]);
  const terminateOtherDevices = useCallback((expected: string[]) => rpc.call("terminateOtherDevices", { expected }), [rpc]);
  const terminateDevice = useCallback(({ id, application, device }: TelegramDevice) =>
    rpc.call("terminateDevice", { id, application, device }), [rpc]);

  const notificationExceptions = <NotificationExceptions load={loadNotificationExceptions}
    actions={{ chatNotificationState, setChatNotificationMode, setChatNotificationOverride, setChatNotificationSound }} />;

  if (checkingStatus) return <TelegramStartup status="Checking Telegram connection…" />;
  if (connection && connection !== loadedConnection) return <TelegramStartup status="Loading Telegram chats…" />;
  if (auth.state === "ready") return <TelegramAiTransfer.Provider key={connection} value={aiTransfer}><HistoryMessageUpdates.Provider value={historyMessageUpdates}><InstantViewJoin.Provider value={instantViewJoin}><PreparePhotoFileDrag.Provider value={preparePhotoDrag}><PhotoTextRecognition.Provider value={recognizePhotoText}><MarkdownDocumentLoader.Provider value={(id, messageId, attachment, format) =>
    rpc.call("markdownDocument", { id, messageId, ...(attachment && { attachment }), ...(format && { format }) })}><RetryMessageDelivery.Provider value={retryMessageDelivery}><PressInlineBotButton.Provider value={pressInlineBotButton}><InlineBotDestinations.Provider value={inlineBotDestinations}><InlineMiniApps.Provider value={inlineMiniApps}><MiniAppSessionActions.Provider value={miniAppSessionActions}><QueueDownloadAction.Provider value={queueDownload}><AddProfileAudioAction.Provider value={addProfileAudio}><MessageEmojiPackActions.Provider value={messageEmojiPackActions}><MessageEmojiStatusActions.Provider value={messageEmojiStatusActions}><CustomEmojiLoader.Provider value={loadCustomEmoji}><LoadMessageEffect.Provider value={loadMessageEffect}><LoadTgsSticker.Provider value={loadTgsSticker}><PollStickerActions.Provider value={pollStickers}><PollFileUpload.Provider value={sendPollFiles}><PollFileActions.Provider value={pollFiles}><LoadPollPhoto.Provider value={(id, messageId, reference, size) =>
    rpc.call("pollPhoto", { id, messageId, reference, ...(size && { size }) })}><PollOptionActions.Provider value={pollOptionActions}><LoadPollVoteHistory.Provider value={(id, messageId, at) => rpc.call("pollVoteHistory", { id, messageId, ...(at === undefined ? {} : { at }) })}><LoadPollVoters.Provider value={loadPollVoters}><SetChecklistTask.Provider value={setChecklistTask}><AddChecklistTask.Provider value={addChecklistTask}><EditChecklist.Provider value={editChecklist}><LoadRichBankCard.Provider value={(id, messageId, reference, mode) => rpc.call("richBankCard", { id, messageId, reference, mode })}><RunRichBotCommand.Provider value={(id, messageId, command) => rpc.call("runRichBotCommand", { id, messageId, command })}><EditRichMessage.Provider value={editRichMessage}><LoadBotWidgetPreview.Provider value={(id, messageId) => rpc.call("messageWidgetPreview", { id, messageId })}><LoadMessagePreviewCover.Provider value={loadMessagePreviewCover}><LoadMessagePreviewPlayback.Provider value={loadMessagePreviewPlayback}><ContactPhotoSuggestionActions.Provider value={contactPhotoSuggestion}><AcceptContactBirthday.Provider value={acceptContactBirthday}><PurchasePaidMedia.Provider value={(id, messageId, stars) => rpc.call("purchasePaidMedia", { id, messageId, stars })}><TelegramPage key={connection} settingsView={settingsView} workspace={workspace} connectionScope={connectionId} privateCall={privateCall} draftStorage={drafts} navigation={navigationScope ? { scope: navigationScope, restore: resumeConversation } : undefined} live={{ chats, downloads: (openMessage) => <DownloadQueueDialog actions={downloadQueueActions}
      counts={currentDownloadActivity?.counts} changed={currentDownloadActivity?.revision} subscribeToProgress={subscribeToDownloadProgress}
      openSource={openMessage && (async ({ id, messageId, topicId }, close) => {
        const chat = await loadNotificationChat(id);
        if (!chat || chat.id !== id || !close()) return false;
        openMessage(chat, messageId, topicId);
        return true;
      })} />, accountLabel: auth.accountLabel, storyActions, communityActions, communityRevision, collapsedCommunities, folderCommunities, exportChat, unreadBadges, messageDoubleClick, foregroundNotices,
      desktopNoticeTarget: desktopNoticeTarget?.connection === connection ? desktopNoticeTarget?.notice : undefined,
      completeDesktopNotice: () => setDesktopNoticeTarget(undefined),
      desktopAlertPermission: desktopPermission, requestDesktopAlertPermission: requestDesktopPermission,
      messageNotifications: notices?.map(({ notice }) => notice) ?? [], deviceSignIns: { count: pendingSignIns, review: openDeviceReview, dismiss: () => setSignInNotice(undefined) }, loadNotificationChat, findNextUnreadChannel, loadChannelDirectMessages, channelInbox, dismissMessageNotification, loading: loading || settledList !== list, error: chatError, liveRevision, chatAgentAccess, setChatAgentAccess, agentAccess: <AgentAccessPanel read={readAgentAccess} readRuntime={readRuntime} change={changeAgentAccess} disconnect={disconnect} signOut={signOut} />, settings: (openChat, openMessage, openFolders) => <CacheSettings
      openWorkspace={() => navigate.toPluginPanel("telegram", { subPath: "settings" })}
      workspace={settingsView ? {
        sidebar: workspace.sidebar,
        back: closeSettings,
        language: <LanguageSettings interfaceLanguage={interfaceLanguage} translationLanguage={translationLanguage} save={saveLanguagePreference} />,
        desktopAlerts: <DesktopNotificationSettings permission={desktopPermission} request={requestDesktopPermission} />,
        agents: <AgentAccessPanel inline read={readAgentAccess} readRuntime={readRuntime} change={changeAgentAccess} disconnect={disconnect} signOut={signOut} />,
      } : undefined}
      openFolders={openFolders} read={readCache} setLimit={setCacheLimit} clear={clearCache} clearChat={clearChatCache} openDevicesRequest={openDevicesRequest}
      openQuickReplyRequest={openQuickReplyRequest} closeQuickReply={() => setQuickReplyReview(undefined)}
      calls={<IncomingCallSettings key={connection} actions={incomingCallSettings} audioAvailable={privateCall?.available} />}
      chatGestures={{ doubleClick: messageDoubleClick, setDoubleClick: setMessageDoubleClick }}
      accounts={accountsPanel} automaticPlayback={automaticPlayback && <AutomaticPlaybackSettings policy={automaticPlayback} save={saveAutomaticPlayback} />} automaticDownloads={automaticMedia && <AutomaticMediaSettings policy={automaticMedia} save={saveAutomaticMedia} />} downloads={(close) => <DownloadQueue actions={downloadQueueActions} changed={currentDownloadActivity?.revision} openSource={openMessage && (async ({ id, messageId, topicId }) => {
        const chat = await loadNotificationChat(id);
        if (!chat || chat.id !== id || !close()) return false;
        openMessage(chat, messageId, topicId);
        return true;
      })} />} business={<><BusinessBotSettings read={readBusinessBot} find={findBusinessBot} save={saveBusinessBot} approve={confirmBusinessBot}
        findRecipients={findBusinessRecipients} knownChats={chats} /><BusinessChatLinksSettings read={readBusinessChatLinks} change={changeBusinessChatLink} /><BusinessAwaySettings read={readBusinessAway} save={saveBusinessAway} loadShortcuts={loadQuickReplies}
        findRecipients={findBusinessRecipients} knownChats={chats} /><BusinessGreetingSettings read={readBusinessGreeting} save={saveBusinessGreeting} loadShortcuts={loadQuickReplies}
        findRecipients={findBusinessRecipients} knownChats={chats} /><BusinessHoursSettings read={readBusinessHours} save={saveBusinessHours} /><BusinessLocationSettings read={readBusinessLocation} save={saveBusinessLocation} /><BusinessStartPageSettings read={readBusinessStartPage} save={saveBusinessStartPage} listPacks={listBusinessStickerPacks} loadPack={loadBusinessStickerPack} /><QuickReplySettings review={openQuickReplyRequest} load={loadQuickReplies} loadMessages={loadQuickReplyMessages} loadPhoto={loadQuickReplyPhoto} loadPlayback={loadQuickReplyPlayback} loadSticker={loadQuickReplyTgsSticker} loadPollSticker={loadQuickReplyPollSticker} saveDocument={saveQuickReplyDocument} rename={renameQuickReply} addText={addQuickReplyText} addPhoto={addQuickReplyPhoto} addPhotoAlbum={addQuickReplyPhotoAlbum} addMixedAlbum={addQuickReplyMixedAlbum} addDocument={addQuickReplyDocument}
          addContact={addQuickReplyContact} addPoll={addQuickReplyPoll} addLocation={addQuickReplyLocation} stickers={{ list: listBusinessStickerPacks, load: loadBusinessStickerPack, add: addQuickReplySticker }} remove={deleteQuickReply} reorder={reorderQuickReplies} editText={editQuickReplyText} removeMessage={deleteQuickReplyMessage} retryMessage={retryQuickReplyMessage} /></>} dataExport={<ChatExport title={tr("Export account chats")} save={exportAccount} account />} network={<><NetworkUsageSettings read={readNetworkUsage} reset={resetNetworkUsage} /><ProxySettings actions={proxyActions} /></>} profile={<TelegramProfile actions={profileActions} music={profileAudio} />}
      stars={(close) => {
        const openSource = openMessage && (async ({ id, messageId }: { id: string; messageId: string }) => {
          const chat = await loadNotificationChat(id);
          if (!chat || chat.id !== id || !close()) return false;
          openMessage(chat, messageId);
          return true;
        });
        return <><StarSubscriptions load={(offset) => rpc.call("starSubscriptions", { offset })}
          loadTransactions={(offset, direction, subscription) => rpc.call("starTransactions", { offset, direction, subscription })}
          edit={(offset, expected, cancel) => rpc.call("editStarSubscription", { offset, expected, cancel })} openSource={openSource} />
          <StarTransactions load={(offset, direction) => rpc.call("starTransactions", { offset, direction })} openSource={openSource} /></>;
      }} privacy={(close) => <TelegramPrivacy actions={privacyActions} openChat={(chat) => { close(); openChat(chat); }} />} devices={(open) => <TelegramDevices key={String(open)} initialOpen={open} load={loadActiveDevices} terminate={terminateDevice} approve={confirmDevice} terminateOthers={terminateOtherDevices} inactivity={sessionInactivity} />} notifications={<>
      {settingsView && <NotificationDefaults inline actions={notificationDefaults} exceptions={notificationExceptions} />}
      <details>
      <summary>{tr("Unread counter")}</summary>
      <label>{tr("Count ")}<select value={unreadBadgeMode} onChange={(event) => setUnreadBadgeMode(event.currentTarget.value === "messages" ? "messages" : "chats")}>
        <option value="chats">{tr("Unread chats")}</option><option value="messages">{tr("Unread messages")}</option>
      </select></label>
      <label><input type="checkbox" checked={includeMuted} onChange={(event) => setIncludeMuted(event.currentTarget.checked)} />{tr(" Include muted chats")}</label>
    </details>{!settingsView && <><NotificationDefaults actions={notificationDefaults} />{notificationExceptions}</>}<ReactionNotificationSettings actions={reactionNotificationActions} /><NotificationSoundLibrary actions={notificationSoundLibrary} /></>} />, loadMore: nextOffset === null ? undefined : loadMore, loadingMore, loadHistory, loadUnreadHistory, savedSources, loadForumTopics, loadForumTopicPage, manageForumTopic, deleteForumTopic, pinnedForumTopicOrder, movePinnedForumTopic, markForumTopicRead, markForumRead, loadTopicHistory, sendTopicText, loadGroupEmoji, installedEmoji, loadPinned, pinStatus, setMessagePinned, bulkUnpin, subscribeToDeletions, subscribeToActivity, subscribeToPresence, loadPeerPresence, subscribeToGroupOnline, setOpenChatView, setTypingActivity, sendText, loadMessageEffects, externalReplyAllowed, externalReplySource, externalReplyDraft, saveChatDraft, loadChatDraft, loadTopicDraft, loadPeerProfile, revokeBotEmojiAccess, revokeBotLocationAccess, botMiniAppMenu, launchProfileMiniApp, launchMiniApp, attachmentMiniApps, attachmentMiniAppLinks, sideMenuMiniApps, chatBusinessBot, profileGifts, profilePhotos, profileAudio, clearChatCache, chatThemeActions, chatBackgroundActions, loadCommonGroups, loadChatMembers, setChatMemberTag, chatMemberInvite, communityModeration, banChatMember, moderateChatMember, banMessageChatSender, unbanChatMember, saveChatAdministrator, demoteChatAdministrator, restrictChatMember, liftChatMemberRestrictions, chatInviteActions, joinRequestActions, channelSignatureActions, groupPermissionActions, chatInfoActions, welcomeMessageActions, chatSendAsActions, chatReactionActions, channelStarTransactions: (ownerChat, offset, direction) => rpc.call("starTransactions", { ownerChat, offset, direction }), channelStarRevenue: (id) => rpc.call("channelStarRevenue", { id }), chatPublicUsernameActions, loadChatAutoDelete, saveChatAutoDelete, clearChatHistoryByDate, slowModeActions, groupMemberVisibilityActions, groupAntiSpamActions, groupHistoryVisibilityActions, chatContentProtectionActions, groupEntryActions, loadChatEvents, loadChatEventActors, reportAntiSpam, canScheduleWhenOnline, canScheduleRepeats, scheduledMessages, changeScheduledMessage, cancelScheduledMessage, sendPhoto, sendDocument, sendPoll, loadChannelPollLimits, forwardOptions, forwardMessage, batchForward, copySelectedText, loadReactionPerson, reactionActions: { listReactions, setReaction, loadPeople: loadReactionPeople, loadAvatar, loadPaidPeople: (id, messageId) => rpc.call("paidReactionPeople", { id, messageId }), paidLimit: (id, messageId) => rpc.call("paidReactionLimit", { id, messageId }), paidSenders: (id) => rpc.call("paidReactionSenders", { id }), sendPaid: (id, messageId, stars, anonymous, asChat) => rpc.call("sendPaidReaction", { id, messageId, stars, anonymous, asChat }), setPaidAnonymity: (id, messageId, expected, anonymous) => rpc.call("setPaidReactionAnonymity", { id, messageId, expected, anonymous }), quickReaction, setQuickReaction }, stopPoll, voteInPoll, editText, editCaption, replacePhoto, replaceAttachment, messageReadTime, messageViewers, loadMessageViewerProfile, deletionOptions, deleteMessage, batchDeletion, searchMessages, loadSharedContentCounts, loadMessageLink, loadForumTopicLink, loadFirstUnread, loadMessageAtDate, loadMessageContext, loadMessageContextPage, loadChannelDiscussion, sendChannelComment, loadMedia, loadVideoStream, transcribeVoice, markNotePlayed, mediaComposer, mediaCollection, loadLinkedStickerPack, installLinkedStickerPack, saveDocument, saveSelectedAttachments, loadPhoto, drawPhotoReplyTarget, loadLocationMap, loadSharedContact, translateMessage, defaultTranslationLanguage: translationLanguage === "auto" ? undefined : translationLanguage, loadInstantView, saveInstantViewDocument, loadInstantViewMap, loadInstantViewPhoto, loadInstantViewIcon, loadInstantViewMention, loadInstantViewPlayback, loadInlineBotProfile, quickReplies: { load: loadChatQuickReplies, send: sendQuickReply, edit: openQuickReplyReview }, loadAvatar, markActivityRead, markHistoryRead, syncChatReadState, automaticPlayback, automaticPlaybackOverrides, saveChatPlaybackOverride, automaticMedia, automaticMediaOverrides, saveChatMediaOverride, prefetchVisibleMedia, markChat, markChatListRead, archiveChat, chatNotificationState, setChatNotificationSound, setChatNotificationMode, setChatNotificationOverride, chatPinStatus, setChatPinned, pinnedChatOrder, movePinnedChat, joinChat, chatLeaveActions, createPrivateChat, previewFolderInvite, importFolderInvite, previewInvite, previewWebLink, joinInvite, postingPermissions, replyBotActions, inlineBotActions, loadBotCommands, chatReportActions, loadRecipientChatPage, findChats, recentChatSearch, globalSearch, loadGlobalMediaThumbnail, searchPublicDiscovery, browsePublicDiscovery, recentPublicTags, contactActions, contactEditor, senderBlockActions, contactsRevision, contactBirthdaysRevision, gameLinks, resolveBotStartLink, resolveTemporaryContactLink, resolveBusinessChatLink, startLinkedBot, resolveBoostLink, managedBotLinks, resolveCollectibleGift, resolveMessageLink, list, folders, mainFolderPosition: mainPosition, folderActions, selectList, refresh: () => setRevision((n) => n + 1) }} /></PurchasePaidMedia.Provider></AcceptContactBirthday.Provider></ContactPhotoSuggestionActions.Provider></LoadMessagePreviewPlayback.Provider></LoadMessagePreviewCover.Provider></LoadBotWidgetPreview.Provider></EditRichMessage.Provider></RunRichBotCommand.Provider></LoadRichBankCard.Provider></EditChecklist.Provider></AddChecklistTask.Provider></SetChecklistTask.Provider></LoadPollVoters.Provider></LoadPollVoteHistory.Provider></PollOptionActions.Provider></LoadPollPhoto.Provider></PollFileActions.Provider></PollFileUpload.Provider></PollStickerActions.Provider></LoadTgsSticker.Provider></LoadMessageEffect.Provider></CustomEmojiLoader.Provider></MessageEmojiStatusActions.Provider></MessageEmojiPackActions.Provider></AddProfileAudioAction.Provider></QueueDownloadAction.Provider></MiniAppSessionActions.Provider></InlineMiniApps.Provider></InlineBotDestinations.Provider></PressInlineBotButton.Provider></RetryMessageDelivery.Provider></MarkdownDocumentLoader.Provider></PhotoTextRecognition.Provider></PreparePhotoFileDrag.Provider></InstantViewJoin.Provider></HistoryMessageUpdates.Provider></TelegramAiTransfer.Provider>;
  const cancelConnection = <button type="button" className="mtg-action" disabled={busy}
    onClick={() => void disconnect().catch(() => setNotice("Could not disconnect Telegram."))}>{tr("Cancel connection")}</button>;
  if (auth.state === "qr") return <TelegramQrSignIn link={auth.link} accounts={accountsPanel}>
    <ProxySettings actions={proxyActions} />
    {cancelConnection}
    {notice && <p role="alert">{tr(notice)}</p>}
  </TelegramQrSignIn>;
  const startupStatus = auth.state === "connecting" || (auth.state === "idle" && !initialConnectionChecked.current)
    || (busy && (auth.state === "idle" || auth.state === "error"))
    ? "Connecting to Telegram…" : auth.state === "disconnecting" ? "Disconnecting Telegram…" : undefined;
  return <TelegramStartup status={startupStatus}>
      {auth.state === "password" && <form onSubmit={submitPassword}>
        <label>{tr("Telegram two-step verification password")}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button type="submit" className="mtg-action" data-variant="primary" disabled={busy || !password}>{tr("Unlock")}</button>
      </form>}
      {(auth.state === "connecting" || auth.state === "password") && <ProxySettings actions={proxyActions} />}
      {(auth.state === "password" || auth.state === "connecting") && cancelConnection}
      {auth.state === "error" && <p role="alert">{tr(auth.message)}</p>}
      {notice && <p role="alert">{tr(notice)}</p>}
      {!startupStatus && (auth.state === "idle" || auth.state === "error") &&
        <button type="button" className="mtg-action mtg-login-connect" data-variant="primary" onClick={() => void connect()}>{tr("Connect Telegram")}</button>}
      {auth.state !== "disconnecting" && (!startupStatus || auth.state === "connecting") && accountsPanel}
  </TelegramStartup>;
}

function PendingAgentRead({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback((requestId: string, id: string) => rpc.call("readPreview", { requestId, id }), [rpc]);
  return <AgentReadApproval key={interaction.id} payload={interaction.payload} expiresAt={interaction.expiresAt} submit={submit} cancel={cancel} load={load} />;
}

function PendingAgentSend({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  return <AgentSendApproval key={interaction.id} payload={interaction.payload} expiresAt={interaction.expiresAt} submit={submit} cancel={cancel} />;
}

function withTelegramLanguage<Props extends object>(Component: ComponentType<Props>) {
  return function LocalizedTelegramSlot(props: Props) {
    const { values } = useSettings();
    return <TelegramLocaleProvider preference={values?.language}><Component {...props} /></TelegramLocaleProvider>;
  };
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "chertog-chat", component: withTelegramLanguage(TelegramEmbedOverlay) });
  app.slots.pendingInteraction({
    id: readRenderer,
    component: withTelegramLanguage(PendingAgentRead),
  });
  app.slots.pendingInteraction({
    id: approvalRenderer,
    component: withTelegramLanguage(PendingAgentSend),
  });
  app.slots.navPanel({
    id: "telegram", title: "Telegram", icon: "MessagesSquare", path: "telegram", component: withTelegramLanguage(TelegramPanel),
    experimental_usePageTitle: ({ subPath }) => {
      const { values } = useSettings();
      const ru = resolveTelegramLanguage(values?.language, navigator.languages, document.documentElement.lang) === "ru";
      return subPath === "settings" ? { title: ru ? "Настройки" : "Settings",
        windowTitle: ru ? "Настройки Telegram" : "Telegram settings" } : null;
    },
    experimental_sidebar: withTelegramLanguage(TelegramSidebarOutlet),
  });
  app.slots.experimental_tab({
    id: "chat-details", title: "Chat details", icon: "Info",
    context: { kind: "nav-panel", panelId: "telegram" },
    availability: "fixed", layout: "flush",
    useVisible: useTelegramWorkspaceMode, component: withTelegramLanguage<PluginNavPanelProps>(TelegramDetailsOutlet),
  });
});
