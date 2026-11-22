import { useTelegramLocale } from "./i18n/index.tsx";
import { ComposerActionEntry, ComposerActionMenu, ComposerActions } from "./composer-actions.tsx";
import { ChatListDisclosure } from "./chat-list-disclosure.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CallContact, PrivateCallBanner, type PrivateCallControls } from "./private-call.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { createPortal } from "react-dom";
import { useHistoryMessageUpdates } from "./history-message-updates.ts";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts.tsx";
import { handleMessageDoubleClick, type MessageDoubleClick } from "./message-double-click.ts";
import { useSwipeToReply } from "./swipe-reply.ts";
import { ChatAutomaticPlayback, playbackLimitsForChat } from "./automatic-playback.tsx";
import type { LinkedBusinessChat, LinkedStoryAlbum, ReactionPersonReference } from "../core/contract.ts";
import { TelegramChatPickerDialog, AttachmentMiniApps, BotMiniAppMenu, OpenMiniApp, SideMenuMiniAppPicker, useMiniAppWindows, type AttachmentMiniAppActions, type AttachmentMiniAppLinkActions, type BotMiniAppMenuActions, type LaunchMiniApp, type SideMenuMiniAppActions } from "./mini-app.tsx";
import type { AttachmentMiniAppReview } from "../core/contract.ts";
import { attachmentMiniAppLinkReference, miniAppLinkReference } from "../core/mini-app.ts";
import { ChatBusinessBot, type ChatBusinessBotActions } from "./chat-business-bot.tsx";
import type { LinkedCollectibleGift } from "../core/contract.ts";
import { CollectibleGiftDialog, ComposerGiftShortcut, ProfileGifts, type ProfileGiftActions } from "./profile-gifts.tsx";
import { ProfileAudio, type ProfileAudioActions } from "./profile-audio.tsx";
import { CommunityBrowser, CommunityLabel, type CommunityActions, type CommunityBrowserController } from "./community-browser.tsx";
import type { CollapsedCommunity, CommunitySummary, FolderCommunities } from "../core/contract.ts";
import { backgroundFillStyle, ChatBackground, LinkedWallpaperDialog, WallpaperPatternLayer, type ChatBackgroundActions } from "./chat-background.tsx";
import { wallpaperPatternUrl } from "./wallpaper-pattern.ts";
import { MessageEffectPicker, type AutomaticMessageEffect } from "./message-effect.tsx";
import type { MessageEffectChoice } from "../core/contract.ts";
import { ChatTheme, type ChatThemeActions } from "./chat-theme.tsx";
import type { CSSProperties } from "react";
import { OpenTelegramMessageLink } from "./telegram-message-link.tsx";
import { canonicalTelegramManagedBotLink, telegramInstantViewLink, telegramShareDraft } from "../core/telegram-content-link.ts";
import type { ManagedBotReview } from "../core/contract.ts";
import { LinkedManagedBotDialog, type LinkedManagedBotActions } from "./managed-bot-creation.tsx";
import { PublicDiscovery, type BrowsePublicDiscovery, type SearchPublicDiscovery } from "./public-discovery.tsx";
import { LinkDraftInsert, type LinkDraft } from "./link-draft-insert.tsx";
import { OpenChatStatus, type SetOpenChatView, type SubscribeToGroupOnline } from "./open-chat-status.tsx";
import { PeerPresence, type SubscribeToPresence } from "./peer-presence.tsx";
import type { UserPresence } from "../core/contract.ts";
import { useTypingActivity, type SetTypingActivity } from "./typing-activity.ts";
import { ChatActivityIndicator, type SubscribeToActivity } from "./chat-activity.tsx";
import { InlineBotSearch, UseInlineBotDraft, UseInlineBotInOtherChat, draftWithInlineBot, inlineBotRequest, type InlineBotActions } from "./inline-bot-search.tsx";
import { ReplyBotKeyboard, type ReplyBotActions } from "./reply-bot-keyboard.tsx";
import { BotStartLink } from "./bot-start-link.tsx";
import { GameLinkCard, type GameLinkActions } from "./game-link.tsx";
import { ChatPreview } from "./chat-preview.tsx";
import type { BotStartResult, BotStartTarget, LinkedGame } from "../core/contract.ts";
import { BotCommandMenu, type LoadBotCommands } from "./bot-command-menu.tsx";
import type { SyncedDraft, TopicDraft } from "../core/contract.ts";
import { droppedAttachment } from "./attachment-drop.ts";
import { ArchiveAttachment, droppedFolderArchive, type ArchiveAttachmentController } from "./archive-attachment.tsx";
import { photoTimeline, type DrawPhotoReplyFromMessage } from "./photo-preview.tsx";
import { SharedFolderInvite, type ImportFolderInvite } from "./shared-folder-invite.tsx";
import { folderColors } from "./folder-colors.ts";
import { LinkPreviewControls, linkPreviewDelivery, restoreDraftPreview, savedDraftPreview } from "./link-preview-controls.tsx";
import { ServiceMessageRow } from "./service-message.tsx";
import { composerKeys, isControlPanelShortcut, isFindShortcut, isPanelShortcut, isPlainKey, isStashShortcut, moveListFocus, navigateReply, replyNavigationShortcuts } from "./composer-keys.ts";
import { ChannelDiscussion, type ChannelDiscussionLoader } from "./channel-discussion.tsx";
import { DiscussionGroupSettings } from "./discussion-group-settings.tsx";
import { ChannelDirectMessages, type ChannelDirectMessagesLoader, type ChannelInboxActions } from "./channel-direct-messages.tsx";
import { GroupPacks } from "./group-packs.tsx";
import { SenderBlockSettings, type SenderBlockActions } from "./sender-block-settings.tsx";
import { ContactEditor, type ContactEditorActions } from "./contact-editor.tsx";
import { ContactResults, type ContactActions } from "./contact-results.tsx";
import { ChatEvents, type AntiSpamReport, type ChatEventActorLoader, type ChatEventLoader } from "./chat-events.tsx";
import { ChatReport, type ChatReportActions } from "./chat-report.tsx";
import { ChatLeave, type ChatLeaveActions } from "./chat-leave.tsx";
import { CreatePrivateChatDialog, type CreatePrivateChat } from "./create-private-chat.tsx";
import { ChannelSignaturesPanel, type ChannelSignatureActions } from "./channel-signatures.tsx";
import { ChatReactionsSettings, type ChatReactionActions } from "./chat-reaction-settings.tsx";
import { OpenReactionPerson } from "./reaction-people.tsx";
import { RecentChatSearch, type RecentChatSearchActions } from "./recent-chat-search.tsx";
import { StarTransactions, formatStarBillingPeriod, type LoadStarTransactions } from "./star-subscriptions.tsx";
import { ChatInfoPanel, type ChatInfoActions } from "./chat-info.tsx";
import { ChatWelcomeMessages, type ChatWelcomeMessageActions } from "./chat-welcome-messages.tsx";
import { ChatPublicUsername, type ChatPublicUsernameActions } from "./chat-public-username.tsx";
import { AutoDeleteTimer, type AutoDeleteActions } from "./default-auto-delete.tsx";
import { GroupSlowMode, type SlowModeActions } from "./group-slow-mode.tsx";
import { GroupModerationSetting, type GroupModerationActions } from "./group-moderation-setting.tsx";
import { GroupPermissions, type GroupPermissionActions } from "./group-permissions.tsx";
import { ChatJoinRequests, type JoinRequestActions } from "./chat-join-requests.tsx";
import { ChatInvites, type ChatInviteActions } from "./chat-invites.tsx";
import { ChatMemberInvite, type ChatMemberInviteActions } from "./chat-member-invite.tsx";
import { ChatMembers, type ChatMemberLoader } from "./chat-members.tsx";
import { LinkedStoryPreview, MessageStoryDialog, OpenMessageStory, ProfileStories, ProfileStoryAlbums, StoryAlbumDialog, Stories, type StoryActions } from "./stories.tsx";
import { MarkChatListRead, type MarkChatListReadAction } from "./mark-chat-list-read.tsx";
import { chatFolderDragType, FolderNavigation, RecipientFolderSelect, UnreadListBadge } from "./folder-navigation.tsx";
import { ChatFolderMemberships, FolderSettings, type FolderActions, type FolderSettingsController } from "./folder-settings.tsx";
import { ScheduledMessages } from "./scheduled-messages.tsx";
import { attachmentDelivery, AttachmentDeliveryControls, useCanScheduleAttachmentWhenOnline } from "./attachment-delivery.tsx";
import { MediaSendControls } from "./media-send-controls.tsx";
import type { CaptionPlacement, AttachmentSendDelivery, AttachmentSendOptions, DocumentSendOptions, MediaReply, StyledRange, TextDelivery } from "../core/contract.ts";
import { GlobalSearchResults, type GlobalSearchLoader, type LoadGlobalMediaThumbnail, type RecentPublicTagActions } from "./global-search.tsx";
import type { GlobalSearchMode, MessageSearchFilter, PublicDiscoveryMode } from "../core/contract.ts";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Archive, ArrowDown, ArrowLeft, Bookmark, Check, CheckCheck, ChevronDown, Ellipsis, Folder, FolderCog, Heart, Languages, LayoutGrid, List, LoaderCircle, MessageCircle, Pencil, Pin, RefreshCw, Reply, Search, Send, X } from "lucide-react";
import { appendUnreadHistory, fillHistoryGap, mergeLatestHistory, prependHistory, replaceLoadedHistoryMessage } from "../core/history-refresh.ts";
import { captureHistoryScroll, createHistoryView, focusHistoryMessage, focusUnreadBoundary, historyPageKey, historyWheelDirection, isAwayFromLatest, observeHistoryResize, rememberReadingPlace, restoreHistoryScroll, type HistoryViewport } from "./history-scroll.ts";
import { ChatAutomaticMedia, mediaLimitsForChat, useVisibleMediaPrefetch, visibleMediaCandidates, type PrefetchVisibleMedia } from "./automatic-media.tsx";
import type { AutoMediaLimits, AutoMediaOverrides, AutoMediaPolicy, AutoPlaybackLimits, AutoPlaybackOverrides, AutoPlaybackPolicy } from "../core/contract.ts";
import { readableHistoryIds, useVisibleHistoryRead, type MarkHistoryRead } from "./visible-history-read.ts";
import { InstantViewDialog, InstantViewLoader, InstantViewMentionOpen, InstantViewShare, InstantViewTagSearch, InstantViewDocumentSaver, type SaveInstantViewDocument, InstantViewMapLoader, type LoadInstantViewMap, InstantViewPhotoLoader, InstantViewIconLoader, type LoadInstantViewIcon, InstantViewPlaybackLoader, type LoadInstantView, type LoadInstantViewPhoto, type LoadInstantViewPlayback, OpenInstantView, resumeInstantView } from "./instant-view.tsx";
import { QuickReplyComposer, type QuickReplyComposerControls, type SendQuickReply } from "./quick-replies.tsx";
import { OpenInlineBotProfile, type LoadInlineBotProfile } from "./inline-bot-keyboard.tsx";
import { canonicalTelegramStoryAlbumLink, canonicalTelegramBoostLink, canonicalTelegramGiftLink, canonicalTelegramInviteLink, canonicalTelegramPublicChatLink, canonicalTelegramWallpaperLink, isTelegramFolderInviteLink, isTelegramInviteLink, isTelegramMessageLink, parseTelegramBotStartLink, parseTelegramStoryLink, telegramBusinessChatLink, telegramGameLink, telegramPublicChatLink, telegramStickerPackReference, telegramTemporaryContactLink } from "../core/public-chat-reference.ts";
import { hasWebLink } from "../core/message-links.ts";
import { previewMessageText } from "../core/message-spoilers.ts";
import { displayMessagePreview } from "./i18n/message-labels.ts";
import { isVideoAttachmentName, maxTelegramUploadBytes, maxTelegramTextLength } from "../core/contract.ts";
import type { ChatJoinResult, ChatList, DocumentSender, TelegramUploadProgress, ForumTopic, ForumTopicTarget, HistoryPage, FolderInvite, InvitePreview, InviteTarget, LinkedStory, LinkedTelegramMessage, MessagesDeleted, PollSender, PostingPermissions, SendResult, TelegramFolder, PhotoSize, TelegramPhoto, UploadRejection } from "../core/contract.ts";
import { ChatNotifications, type ChatNotificationActions } from "./chat-notifications.tsx";
import { ChatPin, type ChatPinActions } from "./chat-pin.tsx";
import { ChatExport, type ExportChat } from "./chat-export.tsx";
import { TelegramDraftReview } from "./topic-draft-sync.tsx";
import type { CommonGroupLoader } from "./common-groups.tsx";
import { ProfilePhotos, type ProfilePhotoActions } from "./profile-photos.tsx";
import { ContactProfile, type PeerProfileLoader } from "./contact-profile.tsx";
import { ChatSendAsSettings, type ChatSendAsActions } from "./chat-send-as.tsx";
import { ChatDetails } from "./chat-details.tsx";
import { CopyMessageReference, CopyRecipientReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { ChannelViewCount } from "./channel-view-count.tsx";
import { MessageViewerAction, MessageViewerScope, type MessageViewerLoader } from "./message-viewers.tsx";
import { ReadTimeButton, type ReadTimeLoader } from "./message-read-time.tsx";
import { useMessageSelection, type MessageSelectionActions } from "./message-selection.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { MessageEdit, replacePreparedPhoto, type ReplacePhoto, type ReplaceAttachment, type ReplacementProgress, type AttachmentEditResult, editableMessageText, lastEditableMessage, submitMessageEdit, type EditCaption, type EditText } from "./message-edit.tsx";
import { selectedReplyQuote } from "./selected-reply-quote.ts";
import { SelectReplyQuote } from "./select-reply-quote.tsx";
import { MessagePin, type MessagePinActions } from "./message-pin.tsx";
import { Avatar, MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import type { ForwardActions, RecipientPage } from "./message-forward.tsx";
import { PollComposer } from "./poll-composer.tsx";
import { AttachmentPhotoPreview, MediaComposer, type ComposerMediaActions, type MediaComposerController } from "./media-composer.tsx";
import { SavedSources, type SavedSourcesActions } from "./saved-sources.tsx";
import { OpenExternalReply } from "./external-reply-reference.tsx";
import { ForwardedFrom, OpenForwardedPost } from "./forwarded-from.tsx";
import { ConversationTranslation, createTranslationQueue, translationLanguages, TranslateMessageService, TranslationDefault, type TranslateMessage } from "./message-translation.tsx";
import type { TranslationLanguage } from "../core/contract.ts";
import { OpenSharedContact, type LoadSharedContact } from "./shared-contact.tsx";
import { LocationMapLoader, type LoadLocationMap } from "./location-card.tsx";
import { MusicPlaybackProvider, MusicPlayerPanel } from "./music-playback.tsx";
import { PlaybackHistoryProvider } from "./media-player.tsx";
import { MessageAlbum, sharedAlbumCaption, sharedForwardedAlbum } from "./message-album.tsx";
import { firstLoadedUnread, groupMessageTimeline, localDateInputValue } from "../core/message-timeline.ts";
import { ClearChatHistoryByDate, type ClearChatHistoryByDateActions } from "./clear-chat-history-by-date.tsx";
import { MessageBubble } from "./message-action-slot.tsx";
import { MessageFooter, openMessageMenu, messageMenuKey } from "./message-footer.tsx";
import { contextMenuKey, useObjectContextMenu } from "./object-context-menu.tsx";
import { MessageInspector } from "./message-inspector.tsx";
import { ComposerEmojiPickers, InstalledEmojiPacks, type InstalledEmojiActions, type LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { DraftFormatButton, DraftFormatControls, draftFormattingShortcuts, draftLinkShortcuts, useDraftFormatting } from "./draft-formatting.tsx";
import { sendSplitDraft } from "../core/split-draft.ts";
import { LoadMessagePoster, MessageContent, NotePlaybackReceipt, type MarkNotePlayed, type MediaCollectionActions } from "./message-content.tsx";
import { ChatSenderBan, type BanMessageChatSender } from "./message-chat-sender-ban.tsx";
import { NotePlaybackQueueProvider } from "./note-playback-queue.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, preparePhoto } from "./prepare-photo.ts";
import { EditDraftPhoto } from "./edit-draft-photo.tsx";
import { VideoAttachmentEdits, videoAttachmentOptions } from "./video-attachment-edits.tsx";
import { ForumTopics, type DeleteForumTopic, type ManageForumTopic, type MarkForumTopicRead, type MarkForumRead, type ForumActions, type PinnedForumTopicActions } from "./forum-topics.tsx";
import { ConversationSearch, type AuthorFilter } from "./conversation-search.tsx";
import { chats as demoChats, type Chat, type Message } from "../core/demo.ts";


import type { MessageNotification, StickerPackPreviewData } from "../core/contract.ts";
import { StickerPackPreview } from "./sticker-pack-preview.tsx";
import { MessageNotificationBanner, MessageNotificationCenter, MessageNotificationStack } from "./message-notification-banner.tsx";

import { attachmentReply, composerMediaReply, drawnPhotoReplyId, originalAttachment, photoAttachmentReply, createAccountDrafts, createDraftStash, textDraftAttachment, useDraftRecord, useDraftStashCheck, type AccountDrafts, type ComposerReply, type DraftAttachment, type StashedDraft } from "./local-drafts.ts";
import { forgetConversationLocation, readConversationLocation, rememberConversationLocation } from "./conversation-location.ts";
import { useSentTextMotion } from "./sent-text-motion.ts";
import type { ConversationLocation, ResumedConversation } from "../core/contract.ts";

type ReplyChatPicker = ComponentProps<typeof TelegramChatPickerDialog>;
export type ExternalReplyDraftActions = {
  find: ReplyChatPicker["find"];
  topics: NonNullable<ReplyChatPicker["findTopics"]>;
  review: (source: { id: string; messageId: string; sourceTopicId?: number; quote?: ComposerReply["selectedQuote"] },
    chat: Chat, topic?: ForumTopicTarget) => Promise<{ chat: Chat; topic?: ForumTopic } | null>;
};

type Live = MessageSelectionActions & PinnedForumTopicActions & Partial<Pick<ForwardActions, "forwardOptions" | "forwardMessage"> & ChatNotificationActions & ChatPinActions & MessageDeletionActions & MessagePinActions & ForumActions> & {
  markActivityRead?: ComponentProps<typeof ConversationSearch>["markActivityRead"];
  loadMessageContextPage?: ComponentProps<typeof ConversationSearch>["loadContextPage"];
  loadMessageAtDate?: ComponentProps<typeof ConversationSearch>["loadAtDate"];
  messageReadTime?: ReadTimeLoader;
  messageViewers?: MessageViewerLoader;
  unreadBadges?: ReadonlyMap<ChatList, number>;
  messageDoubleClick?: MessageDoubleClick;
  loadLocationMap?: LoadLocationMap;
  loadSharedContact?: LoadSharedContact;
  translateMessage?: TranslateMessage;
  defaultTranslationLanguage?: TranslationLanguage;
  loadInstantView?: LoadInstantView;
  saveInstantViewDocument?: SaveInstantViewDocument;
  loadInstantViewMap?: LoadInstantViewMap;
  loadInstantViewPhoto?: LoadInstantViewPhoto;
  loadInstantViewIcon?: LoadInstantViewIcon;
  loadInstantViewMention?: (url: string, userId: number) => Promise<Chat | null>;
  loadInlineBotProfile?: LoadInlineBotProfile;
  loadInstantViewPlayback?: LoadInstantViewPlayback;
  quickReplies?: Pick<Parameters<typeof QuickReplyComposer>[0], "load" | "edit"> & { send: SendQuickReply };
  exportChat?: ExportChat;
  storyActions?: StoryActions;
  communityActions?: CommunityActions;
  communityRevision?: number;
  folderCommunities?: FolderCommunities | null;
  collapsedCommunities?: CollapsedCommunity[];
  chats: Chat[];
  list: ChatList;
  folders: TelegramFolder[];
  mainFolderPosition?: number;
  selectList: (list: ChatList) => void;
  loading: boolean;
  loadingMore?: boolean;
  loadMore?: () => Promise<void>;
  liveRevision: number;
  accountLabel?: string;
  agentAccess?: ReactNode;
  loadLinkedStickerPack?: (url: string, offset?: number, refresh?: true) => Promise<StickerPackPreviewData | null>;
  installLinkedStickerPack?: (url: string, packId: string) => Promise<"installed" | "unavailable" | "unknown">;
  mediaCollection?: MediaCollectionActions;
  messageNotification?: MessageNotification;
  foregroundNotices?: readonly MessageNotification[];
  desktopNoticeTarget?: MessageNotification;
  completeDesktopNotice?: () => void;
  desktopAlertPermission?: NotificationPermission | "unsupported";
  requestDesktopAlertPermission?: () => Promise<void>;
  messageNotifications?: readonly MessageNotification[];
  deviceSignIns?: { count: number; review: () => void; dismiss: () => void };
  savedSources?: SavedSourcesActions;
  loadNotificationChat?: (id: string) => Promise<Chat | null>;
  findNextUnreadChannel?: (id: string, list: Exclude<ChatList, "saved">, signal: AbortSignal) => Promise<{ chat: Chat; list: ChatList } | null>;
  loadChannelDirectMessages?: ChannelDirectMessagesLoader;
  channelInbox?: ChannelInboxActions;
  loadReactionPerson?: (id: string, messageId: string, target: ReactionPersonReference) => Promise<Chat | null>;
  loadMessageViewerProfile?: (id: string, messageId: string, userId: string) => Promise<Chat | null>;
  dismissMessageNotification?: (key?: string) => void;
  downloads?: (openMessage?: (chat: Chat, messageId: string, topicId?: number) => void) => ReactNode;
  settings?: ReactNode | ((openChat: (chat: Chat) => void,
    openMessage?: (chat: Chat, messageId: string, topicId?: number) => void, openFolders?: () => void) => ReactNode);
  chatAgentAccess?: (id: string) => Promise<boolean>;
  setChatAgentAccess?: (id: string, enabled: boolean) => Promise<boolean>;
  error: string;
  previewFolderInvite?: (url: string) => Promise<FolderInvite | null>;
  importFolderInvite?: ImportFolderInvite;
  previewInvite?: (url: string) => Promise<InvitePreview | null>;
  previewWebLink?: (url: string) => Promise<import("../core/contract.ts").LinkPreviewMetadata | null>;
  joinInvite?: (url: string, expected: InviteTarget) => Promise<ChatJoinResult>;
  joinChat?: (id: string, name: string) => Promise<ChatJoinResult>;
  inlineBotActions?: InlineBotActions;
  subscribeToActivity?: SubscribeToActivity;
  setOpenChatView?: SetOpenChatView;
  subscribeToGroupOnline?: SubscribeToGroupOnline;
  subscribeToPresence?: SubscribeToPresence;
  loadPeerPresence?: (id: string) => Promise<UserPresence>;
  setTypingActivity?: SetTypingActivity;
  replyBotActions?: ReplyBotActions;
  loadBotCommands?: LoadBotCommands;
  chatReportActions?: ChatReportActions;
  chatLeaveActions?: ChatLeaveActions;
  createPrivateChat?: CreatePrivateChat;
  postingPermissions?: (id: string) => Promise<PostingPermissions>;
  archiveChat?: (id: string, archived: boolean) => Promise<Chat>;
  markHistoryRead?: MarkHistoryRead;
  syncChatReadState?: (chat: Pick<Chat, "id" | "unread" | "markedUnread">) => void;
  automaticMedia?: AutoMediaPolicy;
  automaticPlayback?: AutoPlaybackPolicy;
  automaticPlaybackOverrides?: AutoPlaybackOverrides;
  saveChatPlaybackOverride?: (id: string, limits: AutoPlaybackLimits | null) => Promise<AutoPlaybackLimits | null>;
  automaticMediaOverrides?: AutoMediaOverrides;
  saveChatMediaOverride?: (id: string, limits: AutoMediaLimits | null) => Promise<AutoMediaLimits | null>;
  prefetchVisibleMedia?: PrefetchVisibleMedia;
  markChat?: (id: string, unread: boolean) => Promise<Chat>;
  markChatListRead?: MarkChatListReadAction;
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument?: (id: string, messageId: string) => Promise<boolean>;
  loadAvatar?: AvatarLoader;
  drawPhotoReplyTarget?: (id: string, messageId: string, topicId?: number) => Promise<import("../core/contract.ts").DrawPhotoDestination | null>;
  loadPhoto?: (id: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
  subscribeToDeletions?: (listener: (event: MessagesDeleted) => void) => () => void;
  bulkUnpin?: import("./message-pin.tsx").BulkUnpinActions;
  loadPinned?: (id: string) => Promise<Message | null>;
  loadHistory: (id: string, before?: string) => Promise<HistoryPage>;
  loadUnreadHistory?: (id: string, after?: string, topicId?: number) => Promise<HistoryPage | null>;
  gameLinks?: GameLinkActions;
  resolveBotStartLink?: (url: string) => Promise<BotStartTarget | null>;
  resolveTemporaryContactLink?: (url: string) => Promise<Chat | null>;
  resolveBusinessChatLink?: (url: string) => Promise<LinkedBusinessChat | null>;
  startLinkedBot?: (url: string, id: string, name: string) => Promise<BotStartResult>;
  resolveCollectibleGift?: (url: string) => Promise<LinkedCollectibleGift | null>;
  resolveBoostLink?: (url: string) => Promise<Chat | null>;
  managedBotLinks?: LinkedManagedBotActions;
  resolveMessageLink?: (url: string) => Promise<LinkedTelegramMessage | null>;
  senderBlockActions?: SenderBlockActions;
  contactEditor?: ContactEditorActions;
  contactsRevision?: number;
  contactBirthdaysRevision?: number;
  contactActions?: ContactActions;
  globalSearch?: GlobalSearchLoader;
  loadGlobalMediaThumbnail?: LoadGlobalMediaThumbnail;
  markNotePlayed?: MarkNotePlayed;
  searchPublicDiscovery?: SearchPublicDiscovery;
  browsePublicDiscovery?: BrowsePublicDiscovery;
  recentPublicTags?: RecentPublicTagActions;
  folderActions?: FolderActions;
  loadForumTopicPage?: ComponentProps<typeof ForumTopics>["loadTopicPage"];
  manageForumTopic?: ManageForumTopic;
  deleteForumTopic?: DeleteForumTopic;
  markForumTopicRead?: MarkForumTopicRead;
  markForumRead?: MarkForumRead;
  loadRecipientChatPage?: (id: number, offset: number) => Promise<RecipientPage>;
  findChats: (query: string, list: ChatList) => Promise<Chat[]>;
  recentChatSearch?: RecentChatSearchActions;
  sendPoll?: PollSender;
  loadChannelPollLimits?: (id: string) => Promise<import("../core/contract.ts").ChannelPollLimits | null>;
  loadGroupEmoji?: LoadGroupEmoji;
  installedEmoji?: InstalledEmojiActions;
  mediaComposer?: (id: string, topic?: ForumTopicTarget, reply?: MediaReply) => ComposerMediaActions;
  sendDocument?: DocumentSender;
  sendPhoto?: ComponentProps<typeof ForumTopics>["sendPhoto"];
  sendText: (id: string, text: string, replyTo?: string, delivery?: TextDelivery) => Promise<SendResult>;
  loadMessageEffects?: (id: string) => Promise<MessageEffectChoice[]>;
  externalReplySource?: (id: string, messageId: string) => Promise<LinkedTelegramMessage | null>;
  externalReplyAllowed?: (id: string, messageId: string) => Promise<boolean>;
  externalReplyDraft?: ExternalReplyDraftActions;
  sendChannelComment?: ComponentProps<typeof ChannelDiscussion>["send"];
  loadChannelDiscussion?: ChannelDiscussionLoader;
  loadChatEvents?: ChatEventLoader;
  reportAntiSpam?: AntiSpamReport;
  loadChatEventActors?: ChatEventActorLoader;
  channelSignatureActions?: ChannelSignatureActions;
  chatSendAsActions?: ChatSendAsActions;
  chatInfoActions?: ChatInfoActions;
  welcomeMessageActions?: ChatWelcomeMessageActions;
  chatReactionActions?: ChatReactionActions;
  channelStarTransactions?: (id: string, ...args: Parameters<LoadStarTransactions>) => ReturnType<LoadStarTransactions>;
  channelStarRevenue?: (id: string) => Promise<import("../core/contract.ts").StarRevenueSummary | null>;
  chatPublicUsernameActions?: ChatPublicUsernameActions;
  loadChatAutoDelete?: (id: string) => ReturnType<AutoDeleteActions["load"]>;
  saveChatAutoDelete?: (id: string, days: number, expected: number) => ReturnType<AutoDeleteActions["save"]>;
  clearChatHistoryByDate?: ClearChatHistoryByDateActions;
  slowModeActions?: SlowModeActions;
  groupMemberVisibilityActions?: GroupModerationActions;
  groupAntiSpamActions?: GroupModerationActions;
  groupHistoryVisibilityActions?: GroupModerationActions;
  chatContentProtectionActions?: GroupModerationActions;
  groupEntryActions?: Record<"approval" | "joinToSend" | "forum", GroupModerationActions>;
  groupPermissionActions?: GroupPermissionActions;
  joinRequestActions?: JoinRequestActions;
  chatInviteActions?: ChatInviteActions;
  profileGifts?: ProfileGiftActions;
  profilePhotos?: ProfilePhotoActions;
  profileAudio?: ProfileAudioActions;
  clearChatCache?: (id: string) => Promise<{ cleanupDeferred?: true }>;
  chatThemeActions?: ChatThemeActions;
  chatBackgroundActions?: ChatBackgroundActions;
  chatBusinessBot?: ChatBusinessBotActions;
  launchMiniApp?: LaunchMiniApp;
  launchProfileMiniApp?: LaunchMiniApp;
  botMiniAppMenu?: BotMiniAppMenuActions;
  attachmentMiniApps?: AttachmentMiniAppActions;
  attachmentMiniAppLinks?: AttachmentMiniAppLinkActions;
  sideMenuMiniApps?: SideMenuMiniAppActions;
  loadPeerProfile?: PeerProfileLoader;
  revokeBotLocationAccess?: (id: string) => Promise<boolean>;
  revokeBotEmojiAccess?: (id: string) => Promise<boolean>;
  loadCommonGroups?: CommonGroupLoader;
  setChatMemberTag?: import("./chat-members.tsx").SetChatMemberTag;
  chatMemberInvite?: ChatMemberInviteActions;
  loadChatMembers?: ChatMemberLoader;
  saveChatAdministrator?: import("./chat-members.tsx").SaveChatAdministrator;
  demoteChatAdministrator?: import("./chat-members.tsx").DemoteChatAdministrator;
  restrictChatMember?: import("./chat-members.tsx").RestrictChatMember;
  liftChatMemberRestrictions?: import("./chat-members.tsx").LiftChatMemberRestrictions;
  communityModeration?: import("./chat-members.tsx").CommunityModeration;
  banChatMember?: import("./chat-members.tsx").BanChatMember;
  moderateChatMember?: import("./chat-members.tsx").ModerateChatMember;
  banMessageChatSender?: BanMessageChatSender;
  unbanChatMember?: import("./chat-members.tsx").UnbanChatMember;
  loadTopicDraft?: ComponentProps<typeof ForumTopics>["loadTopicDraft"];
  loadChatDraft?: (id: string) => Promise<TopicDraft>;
  saveChatDraft?: (id: string, draft: SyncedDraft | null, expected: SyncedDraft | null, topicId?: number) => Promise<"saved" | "changed" | "unsupported">;
  canScheduleRepeats?: ComponentProps<typeof ScheduledMessages>["checkRepeat"];
  canScheduleWhenOnline?: ComponentProps<typeof ScheduledMessages>["checkOnline"];
  scheduledMessages?: ComponentProps<typeof ScheduledMessages>["load"];
  changeScheduledMessage?: ComponentProps<typeof ScheduledMessages>["change"];
  cancelScheduledMessage?: ComponentProps<typeof ScheduledMessages>["cancel"];
  loadMessageLink?: MessageLinkLoader;
  loadForumTopicLink?: ComponentProps<typeof ForumTopics>["loadTopicLink"];
  loadFirstUnread?: (id: string, topicId?: number) => Promise<string | null>;
  loadMessageContext?: (id: string, messageId: string, topicId?: number) => Promise<Message[]>;
  searchMessages?: ComponentProps<typeof ConversationSearch>["search"];
  loadSharedContentCounts?: ComponentProps<typeof ChatDetails>["loadCounts"];
  editText?: EditText;
  editCaption?: EditCaption;
  replacePhoto?: ReplacePhoto;
  replaceAttachment?: ReplaceAttachment;
  refresh: () => void;
};

function MigrationHistoryLink({ group, destination, open }: {
  group: NonNullable<HistoryPage["predecessor"]>; destination: "earlier group" | "supergroup";
  open: (id: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const request = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<"loading" | "unavailable">();
  useEffect(() => () => request.current?.abort(), []);
  async function navigate() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    const opened = await open(group.id, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    request.current = null;
    setStatus(opened ? undefined : "unavailable");
  }
  const earlier = destination === "earlier group";
  return <li className={earlier ? "mtg-history-more mtg-history-start" : "mtg-history-more"}>
    <p>{earlier ? tr("Earlier messages are in") : tr("This read-only group moved to")} <bdi>{group.title}</bdi>.</p>
    <button type="button" className="mtg-action" disabled={status === "loading"} onClick={() => void navigate()}>
      {status === "loading" ? tr("Opening {0}…", [destination]) : tr("Open {0}", [destination])}
    </button>
    {status === "unavailable" && <p role="status">{tr("Could not open the ")}{destination}.</p>}
  </li>;
}

function renderChatNavigation(target: HTMLElement | undefined, children: ReactNode) {
  return target ? createPortal(<div className="mtg-sidebar-layout">{children}</div>, target) : children;
}

export function TelegramPage({ live, boundChat, draftStorage, navigation, connectionScope, workspace, privateCall, settingsView }: {
  live?: Live;
  boundChat?: Chat;
  draftStorage?: AccountDrafts;
  navigation?: { scope: string; restore: (location: ConversationLocation) => Promise<ResumedConversation | null> };
  connectionScope?: string;
  privateCall?: PrivateCallControls;
  settingsView?: boolean;
  workspace?: { sidebar?: HTMLElement; details: HTMLElement | null; openDetails: () => boolean; closeDetails?: () => boolean };
} = {}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const rowTime = useMemo(() => new Intl.DateTimeFormat(uiLocale, { hour: "numeric", minute: "2-digit" }), [uiLocale]);
  const rowDate = useMemo(() => new Intl.DateTimeFormat(uiLocale, { month: "short", day: "numeric" }), [uiLocale]);
  const inlineDraftConfirmation = tr("Replace the current draft with the bot’s search query?");
  const [results, setResults] = useState<{ query: string; list: ChatList; chats: Chat[]; invite?: InvitePreview; folderInvite?: FolderInvite; stickerPack?: StickerPackPreviewData; linked?: LinkedTelegramMessage; linkedStory?: LinkedStory; linkedStoryAlbum?: LinkedStoryAlbum; linkedBot?: BotStartTarget; linkedGame?: LinkedGame; boostChat?: Chat; linkedManagedBot?: ManagedBotReview; error?: string }>();
  const findChats = live?.findChats;
  const [searchMode, setSearchMode] = useState<"chats" | "contacts" | GlobalSearchMode | PublicDiscoveryMode>("chats");
  const globalMode = live?.globalSearch && live.list === "main"
    && (searchMode === "messages" || searchMode === "public" || searchMode === "media") ? searchMode : undefined;
  const contactsMode = live?.contactActions && live.list === "main" && searchMode === "contacts";
  const discoveryMode = live?.searchPublicDiscovery && live.list === "main" && (searchMode === "apps" || searchMode === "channels" || searchMode === "groups")
    ? searchMode : undefined;
  const discoveryLabel = discoveryMode === "apps" ? "Search Telegram Mini Apps"
    : discoveryMode === "groups" ? "Search public Telegram groups" : "Search public Telegram channels";
  const previewInvite = live?.previewInvite;
  const previewFolderInvite = live?.previewFolderInvite;
  const loadLinkedStickerPack = live?.loadLinkedStickerPack;
  const resolveBoostLink = live?.chatInfoActions ? live.resolveBoostLink : undefined;
  const managedBotLinks = live?.managedBotLinks;
  const gameLinks = live?.gameLinks;
  const [previewChat, setPreviewChat] = useState<Chat>();
  const resolveBotStartLink = live?.startLinkedBot ? live.resolveBotStartLink : undefined;
  const resolveMessageLink = live?.resolveMessageLink;
  const resolveTemporaryContact = live?.resolveTemporaryContactLink;
  const resolveBusinessChat = live?.resolveBusinessChatLink;
  const resolveStoryAlbumLink = live?.storyActions?.albumPage ? live.storyActions.resolveAlbumLink : undefined;
  const resolveStoryLink = live?.storyActions?.resolveLink;
  const loadForwardedChat = live?.loadNotificationChat;
  const subscribeToDeletions = live?.subscribeToDeletions;
  const [deletions, setDeletions] = useState<{ id: string; ids: Set<string>; retained: Map<string, Message> }>();
  const loadPinned = live?.loadPinned;
  const [pinned, setPinned] = useState<{ id: string; message: Message | null }>();
  const loadHistory = live?.loadHistory;
  const loadUnreadHistory = live?.list !== "saved" ? live?.loadUnreadHistory : undefined;
  const liveRevision = live?.liveRevision;
  const seenRevision = useRef<number | null | undefined>(liveRevision);
  const historyReplacement = useRef(0);
  const currentRevision = useRef(liveRevision);
  useLayoutEffect(() => { currentRevision.current = liveRevision; }, [liveRevision]);
  const [deferredLatest, setDeferredLatest] = useState<{ id: string; page: HistoryPage }>();
  const stagedHistory = useRef(deferredLatest);
  useLayoutEffect(() => { stagedHistory.current = deferredLatest; }, [deferredLatest]);
  const [remote, setRemote] = useState<{ id: string; page?: HistoryPage; error?: string }>();
  const renderedHistory = useRef<typeof remote>(undefined);
  const [olderError, setOlderError] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const newerPending = useRef(false);
  const unreadPositioned = useRef<string | undefined>(undefined);
  const [newerStatus, setNewerStatus] = useState<"loading" | "failed">();
  const [latestJump, setLatestJump] = useState<"loading" | "failed">();
  const latestJumpPending = useRef(false);
  const generation = useRef(0);
  const openingTelegramLink = useRef(0);
  const olderPending = useRef(false);
  const scrollAnchor = useRef<({ id: string } & ReturnType<typeof captureHistoryScroll>) | undefined>(undefined);
  const [localHistoryView] = useState(createHistoryView);
  const historyView = draftStorage?.history ?? localHistoryView;
  const readingPlaces = historyView.places;
  const [resumePlace, setResumePlace] = useState<{ chatId: string; messageId: string }>();
  const scrollChat = useRef<string | undefined>(undefined);
  const followLatest = useRef(true);
  const lastHistoryTop = useRef(0);
  const lastHistoryWidth = useRef<number | undefined>(undefined);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [folder, setFolder] = useState<"all" | "work">("all");
  const [kind, setKind] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState<{ text: string; refreshStickerPack?: true }>({ text: "" });
  const { text: query } = searchQuery;
  const stickerRefresh = searchQuery.refreshStickerPack && searchQuery;
  const setQuery = useCallback((text: string) => {
    setSearchQuery((previous) => previous.text === text && !previous.refreshStickerPack ? previous : { text });
  }, []);
  const extraSearchScopes = [
    ...(live?.globalSearch ? [["public", "Public posts"]] as const : []),
    ...(live?.searchPublicDiscovery ? [["apps", "Mini Apps"], ["channels", "Public channels"], ["groups", "Public groups"]] as const : []),
    ...(live?.contactActions ? [["contacts", "Contacts"]] as const : []),
  ] as const;
  const searchScopes = [
    ["chats", "Chats"],
    ...(live?.globalSearch ? [["messages", "Messages"], ["media", "Media"]] as const : []),
  ] as const;
  const searchScopeLabel = [...searchScopes, ...extraSearchScopes].find(([mode]) => mode === searchMode)?.[1] ?? "Chats";
  const canChooseSearchScope = live?.list === "main" && extraSearchScopes.length > 0;
  const showSearchScope = canChooseSearchScope && (!!query.trim() || searchMode !== "chats");
  function clearChatSearch() {
    setQuery("");
    setSearchMode("chats");
    chatSearch.current?.focus({ preventScroll: true });
    setRecentSearchOpen(false);
  }
  function searchScopeOption([mode, label]: readonly [typeof searchMode, string], close: () => void) {
    return <button type="button" key={mode} className="mtg-action mtg-search-scope-option"
      aria-pressed={searchMode === mode} aria-keyshortcuts={mode === "contacts" ? "Control+J" : undefined}
      onClick={() => {
        setSearchMode(mode);
        close();
        chatSearch.current?.focus({ preventScroll: true });
      }}><span>{tr(label)}</span>{searchMode === mode && <Check size={16} aria-hidden="true" />}</button>;
  }
  const [recentSearchOpen, setRecentSearchOpen] = useState(false);
  const [recentSearchRevision, setRecentSearchRevision] = useState(0);
  const [recentRecordFailed, setRecentRecordFailed] = useState(false);
  const [directLinkStatus, setDirectLinkStatus] = useState<{ url: string; request: number; busy: boolean }>();
  const [selectedChat, setSelectedChat] = useState<Chat | undefined>(boundChat);
  const [archiveStatus, setArchiveStatus] = useState<Record<string, "busy" | "failed" | undefined>>({});
  const activeArchive = useRef(new Set<string>());
  const [detailsRequest, setDetailsRequest] = useState<{ id: string; nonce: number; kind: "profile" | "boost" }>();
  const [activeId, setActiveId] = useState(boundChat?.id ?? (live ? "" : demoChats[0]!.id));
  const [showConversation, setShowConversation] = useState(!!boundChat);
  const openWorkspaceDetails = useRef(workspace?.openDetails);
  const workspaceActive = workspace?.sidebar !== undefined;
  const [inlineDetails, setInlineDetails] = useState(false);
  const [inlineDetailsTarget, setInlineDetailsTarget] = useState<HTMLDivElement | null>(null);
  const showInlineDetails = inlineDetails && showConversation && !!activeId && !workspace?.details;
  const historyWorkspace = useRef(workspaceActive);
  const restoredHistoryPosition = useRef<HistoryViewport | undefined>(undefined);
  useLayoutEffect(() => { openWorkspaceDetails.current = workspace?.openDetails; }, [workspace?.openDetails]);
  useEffect(() => {
    if (workspaceActive && showConversation && activeId) openWorkspaceDetails.current?.();
  }, [workspaceActive, showConversation, activeId]);
  const navigationEdited = useRef(false);
  const [restoredScope, setRestoredScope] = useState<string>();
  const navigationScope = navigation?.scope;
  const restoreConversation = navigation?.restore;
  const selectNavigationList = live?.selectList;
  useLayoutEffect(() => { if (activeId) navigationEdited.current = true; }, [activeId]);
  const [drafts, setDrafts] = useDraftRecord(draftStorage?.chats.text);
  const [draftEffects, setDraftEffects] = useState<Record<string, MessageEffectChoice | undefined>>({});
  const [localDraftStash] = useState(createDraftStash);
  const draftStash = draftStorage?.stash ?? localDraftStash;
  const [draftStashNotice, setDraftStashNotice] = useState<{ chatId: string; text: string }>();
  const [linkDraft, setLinkDraft] = useState<LinkDraft>();
  const [linkPreviews, setLinkPreviews] = useDraftRecord(draftStorage?.chats.previews);
  const marking = useRef(new Set<string>());
  const [readPausedChat, setReadPausedChat] = useState<string>();
  const [markStatus, setMarkStatus] = useState<Record<string, "busy" | "failed" | undefined>>({});
  const linkedMessageRevision = useRef(0);
  const conversationFocusFrame = useRef<number | undefined>(undefined);
  const [searchView, setSearchView] = useState<{ chatId: string; messageId?: string; quote?: Message["replyQuoteAnchor"]; searchQuery?: string; day?: string; topicId?: number; mediaTimestamp?: number; replyPlayback?: { time: number }; checklistTaskId?: number; pollOptionId?: string; filter?: MessageSearchFilter; sharedLibrary?: ComponentProps<typeof ConversationSearch>["sharedLibrary"]; author?: AuthorFilter; revision?: number; returnToSavedSource?: boolean; returnToGlobalResult?: () => HTMLElement | undefined; returnToTopic?: ForumTopic; returnToReference?: { chat: Chat; messageId: string; topicId?: number; topic?: ForumTopic; label: string } }>();
  const searching = searchView?.chatId === activeId;
  const sharedLibraryOpen = searching && !!searchView?.sharedLibrary;
  const closeWorkspaceDetails = workspace?.closeDetails;
  const hasWorkspaceDetails = !!workspace?.details;
  useEffect(() => {
    if (!sharedLibraryOpen || (!inlineDetails && !hasWorkspaceDetails)) return;
    function finish() {
      if (hasWorkspaceDetails) closeWorkspaceDetails?.();
      setInlineDetails(false);
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, 210);
    return () => window.clearTimeout(timer);
  }, [sharedLibraryOpen, inlineDetails, hasWorkspaceDetails, closeWorkspaceDetails]);
  const searchingConversation = searching && !searchView?.messageId && !searchView?.day
    && !searchView?.filter && !searchView?.author;
  const [savedSourcesChat, setSavedSourcesChat] = useState<string>();
  const canBrowseSaved = live?.list === "saved" && live.chats.some(({ id }) => id === activeId) && !!live.savedSources;
  const savedSourcesOpen = canBrowseSaved && activeId === savedSourcesChat;
  const browsingSaved = savedSourcesOpen && !searching;
  const [forumView, setForumView] = useState<{ chatId: string; topic?: ForumTopic; revision?: number; focusReply?: number;
    inlineDraft?: { topicId: number; username: string; query: string } }>();
  const activeForumTopic = useRef<ForumTopic | undefined>(undefined);
  const [navigationTopic, setNavigationTopic] = useState<{ chatId: string; id: number }>();
  const reportActiveForumTopic = useCallback((topic?: ForumTopic) => {
    activeForumTopic.current = topic;
    if (navigationScope) setNavigationTopic(topic ? { chatId: activeId, id: topic.id } : undefined);
  }, [activeId, navigationScope]);
  const [forumRevision, setForumRevision] = useState(0);
  const [forum, setForum] = useState<{ chatId: string; topics: ForumTopic[] | null }>();
  const topicsOpen = forumView?.chatId === activeId;
  const linkedTopic = topicsOpen ? forumView?.topic : undefined;
  const navigationList = live?.list;
  useEffect(() => {
    if (!navigationScope || !restoreConversation || !selectNavigationList || restoredScope === navigationScope) return;
    const location = !navigationEdited.current && readConversationLocation(navigationScope);
    if (!location) {
      setRestoredScope(navigationScope);
      return;
    }
    let current = true;
    void restoreConversation(location).then((result) => {
      if (!current || navigationEdited.current) return;
      if (!result) {
        forgetConversationLocation(navigationScope);
        return;
      }
      if (result.chat.id !== location.id) return;
      selectNavigationList(result.list);
      setSelectedChat(result.chat);
      setActiveId(result.chat.id);
      setShowConversation(true);
      if (result.topic && result.topic.id === location.topicId) {
        setForumView({ chatId: result.chat.id, topic: result.topic });
        setNavigationTopic({ chatId: result.chat.id, id: result.topic.id });
      }
    }, () => {}).finally(() => {
      if (current) setRestoredScope(navigationScope);
    });
    return () => { current = false; };
  }, [navigationScope, restoreConversation, restoredScope, selectNavigationList]);
  useEffect(() => {
    if (!navigationScope || !showConversation || !activeId || navigationList === undefined) return;
    rememberConversationLocation(navigationScope, {
      id: activeId, list: navigationList,
      ...(topicsOpen && navigationTopic?.chatId === activeId && { topicId: navigationTopic.id }),
    });
  }, [activeId, navigationList, navigationScope, navigationTopic, showConversation, topicsOpen]);
  const [discussion, setDiscussion] = useState<{ chatId: string; postId: string }>();
  const activeDiscussion = discussion?.chatId === activeId ? discussion : undefined;
  const overlayOpen = browsingSaved || (searching && !sharedLibraryOpen) || topicsOpen || !!activeDiscussion;
  const [editing, setEditing] = useState<{ chat: string; message: Message; text: string; busy: boolean; error?: string }>();
  const [joinStatus, setJoinStatus] = useState<Record<string, ChatJoinResult | "joining" | undefined>>({});
  const [paidReview, setPaidReview] = useState<{ key: string; attachment?: DraftAttachment }>();
  const [posting, setPosting] = useState<{ id: string; permissions: PostingPermissions | null }>();
  const [attachments, setAttachments] = useState<Record<string, DraftAttachment | undefined>>({});
  const [attachmentStatus, setAttachmentStatus] = useState<Record<string, { preparing?: boolean; error?: string } | undefined>>({});
  const preparingAttachments = useRef(new Map<string, symbol>());
  const mediaController = useRef<MediaComposerController>(null);
  const quickReplyControls = useRef<QuickReplyComposerControls>(null);
  const archivePicker = useRef<ArchiveAttachmentController>(null);
  const [archivePreparing, setArchivePreparing] = useState(false);
  const [replyTargets, setReplyTargets] = useState<Record<string, ComposerReply | undefined>>({});
  const [localForumDrafts] = useState(createAccountDrafts);
  const forumDrafts = draftStorage ?? localForumDrafts;
  const [focusReplyChat, setFocusReplyChat] = useState<string>();
  const [shortcutsFrom, setShortcutsFrom] = useState<HTMLElement>();

  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [sent, setSent] = useState<Record<string, Message[]>>({});
  const sending = useRef(new Set<string>());
  const uploadControls = useRef(new Map<string, { controller: AbortController; canCancel: boolean }>());
  const [uploadProgress, setUploadProgress] = useState<Record<string, { uploaded: number; total: number; canCancel: boolean; telegram?: TelegramUploadProgress } | undefined>>({});
  const [uploadRejections, setUploadRejections] = useState<Record<string, UploadRejection | undefined>>({});
  const [sendStatus, setSendStatus] = useState<Record<string, "pending" | "failed" | "unknown" | "cancelled" | "scheduled" | undefined>>({});
  const splitScope = useRef(0);
  useLayoutEffect(() => () => { splitScope.current++; }, [activeId]);
  const longDraftRecord = (draftStorage ?? localForumDrafts).chats.longDraftDelivery;
  const [longDraftDelivery, setLongDraftDelivery] = useDraftRecord(longDraftRecord);
  const longDraftUnconfirmed = longDraftDelivery[activeId] === "unknown";
  const sendingDraft = longDraftDelivery[activeId] === "sending" || sendStatus[activeId] === "pending";
  const draggedChat = useRef<Chat>(undefined);
  const pendingFolderDrop = useRef(false);
  const [folderDropTarget, setFolderDropTarget] = useState<number>();
  const [folderDropNotice, setFolderDropNotice] = useState("");
  const folderSettings = useRef<FolderSettingsController>(null);
  const chatSearch = useRef<HTMLInputElement>(null);
  const chatRows = useRef<HTMLUListElement>(null);
  const chatListScroll = useRef(new Map<ChatList, number>());
  const chatListViewport = useRef<{ list?: ChatList; restore?: "folder" | "back" }>({ list: live?.list });
  const chatListMotion = useRef<Animation>(undefined);
  const communityBrowser = useRef<CommunityBrowserController>(null);
  const moreChats = useRef<HTMLLIElement>(null);
  const history = useRef<HTMLOListElement>(null);
  const captureSendMotion = useSentTextMotion(overlayOpen || !showConversation ? "" : activeId);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const autoPagination = typeof IntersectionObserver === "function";
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const chatList = live?.list;
  const mainUnread = live?.unreadBadges?.get("main");
  const archiveUnread = live?.unreadBadges?.get("archive");
  const forwardActions = live?.forwardOptions && live.forwardMessage ? {
    forwardOptions: live.forwardOptions, forwardMessage: live.forwardMessage,
    recipients: live.chats, loadTopics: live.loadForumTopics, loadMessageEffects: live.loadMessageEffects,
    canScheduleWhenOnline: live.canScheduleWhenOnline, canScheduleRepeats: live.canScheduleRepeats,
    searchRecipients: (query: string) => live.findChats(query, "main"),
    folders: live.loadRecipientChatPage && {
      items: live.folders, page: live.loadRecipientChatPage, search: (id: number, query: string) => live.findChats(query, id),
    },
    communities: live.communityActions?.forwardChats && { list: live.communityActions.list, chats: live.communityActions.forwardChats },
  } : undefined;
  const remoteQuery = !globalMode && !contactsMode && !discoveryMode && chatList !== undefined && chatList !== "saved" && query.trim().length >= 2 ? query.trim() : "";
  const publicLink = chatList === "main" ? telegramPublicChatLink(remoteQuery) : undefined;
  const publicLookup = publicLink?.chatUrl;
  const temporaryContactUrl = chatList === "main" && resolveTemporaryContact
    ? telegramTemporaryContactLink(remoteQuery)?.url : undefined;
  const businessChatUrl = chatList === "main" && resolveBusinessChat ? telegramBusinessChatLink(remoteQuery) : undefined;
  const directUrl = businessChatUrl ?? temporaryContactUrl;
  const directLinkBusy = directLinkStatus?.url === directUrl && directLinkStatus?.busy;
  const matched = results?.query === remoteQuery && results.list === chatList ? results : undefined;
  const chats = remoteQuery ? matched?.chats ?? [] : live?.chats ?? demoChats;
  const [translatedChats, setTranslatedChats] = useDraftRecord<{ language?: TranslationLanguage; enabled: boolean }>(draftStorage?.translation);
  const translationPreference = activeId && Object.hasOwn(translatedChats, activeId) ? translatedChats[activeId] : undefined;
  const translate = live?.translateMessage;
  const translationDefault = live?.defaultTranslationLanguage ?? uiLocale;
  const targetLanguage = showConversation && translationPreference?.enabled ? translationPreference.language ?? translationDefault : undefined;
  const translationScope = useMemo(() => translate && targetLanguage ? {
    chatId: activeId, language: targetLanguage, schedule: createTranslationQueue(translate, activeId, targetLanguage),
  } : undefined, [activeId, targetLanguage, translate]);
  const selected = selectedChat?.id === activeId ? selectedChat : undefined;
  const active = selected?.subtitle === "Channel messages" ? selected : chats.find((chat) => chat.id === activeId) ?? selected;
  const unreadChannelList = active?.subtitle === "Channel" && !query.trim() && !globalMode && !contactsMode && !discoveryMode
    && chatList !== "saved" ? chatList : undefined;
  const nextUnreadChannel = unreadChannelList !== undefined
    ? live?.chats.find((chat) => chat.id !== activeId && chat.subtitle === "Channel" && (chat.unread ?? 0) > 0)
    : undefined;
  const channelLookup = useRef<AbortController | undefined>(undefined);
  const [channelLookupStatus, setChannelLookupStatus] = useState<"loading" | "empty" | "failed">();
  useLayoutEffect(() => {
    setChannelLookupStatus(undefined);
    return () => {
      channelLookup.current?.abort();
      channelLookup.current = undefined;
    };
  }, [activeId, unreadChannelList, overlayOpen]);
  const linkedDetails = detailsRequest?.id === activeId ? detailsRequest : undefined;
  const backgroundPhotoRevision = showConversation ? active?.backgroundPhotoRevision : undefined;
  const loadBackgroundPhoto = live?.chatBackgroundActions?.loadPhoto;
  const [backgroundPhoto, setBackgroundPhoto] = useState<{ id: string; revision: string; url: string }>();
  const wallpaper = backgroundPhotoRevision && backgroundPhoto?.id === activeId && backgroundPhoto.revision === backgroundPhotoRevision
    ? backgroundPhoto.url : undefined;
  useEffect(() => {
    if (!loadBackgroundPhoto || !backgroundPhotoRevision) return;
    let active = true;
    void loadBackgroundPhoto(activeId, backgroundPhotoRevision).then((photo) => {
      if (active && /^[A-Za-z0-9+/]+={0,2}$/.test(photo.base64)) {
        setBackgroundPhoto({ id: activeId, revision: backgroundPhotoRevision, url: `url("data:${photo.mime};base64,${photo.base64}")` });
      }
    }, () => {});
    return () => { active = false; };
  }, [activeId, backgroundPhotoRevision, loadBackgroundPhoto]);
  const backgroundPattern = showConversation ? active?.backgroundPattern : undefined;
  const patternRevision = backgroundPattern?.revision;
  const loadPattern = live?.chatBackgroundActions?.loadPattern;
  const [patternAsset, setPatternAsset] = useState<{ id: string; revision: string; url: string }>();
  const patternUrl = patternAsset?.id === activeId && patternAsset.revision === patternRevision ? patternAsset.url : undefined;
  useEffect(() => {
    if (!loadPattern || !patternRevision) return;
    let current = true;
    void loadPattern(activeId, patternRevision).then((asset) => {
      if (!current) return;
      const url = wallpaperPatternUrl(asset);
      if (url) setPatternAsset({ id: activeId, revision: patternRevision, url });
    }, () => {});
    return () => { current = false; };
  }, [activeId, patternRevision, loadPattern]);
  const loadChatAutoDelete = live?.loadChatAutoDelete;
  const saveChatAutoDelete = live?.saveChatAutoDelete;
  const chatAutoDeleteActions = useMemo<AutoDeleteActions | undefined>(() => loadChatAutoDelete && saveChatAutoDelete ? {
    load: () => loadChatAutoDelete(activeId),
    save: (days, expected) => saveChatAutoDelete(activeId, days, expected),
  } : undefined, [activeId, loadChatAutoDelete, saveChatAutoDelete]);
  const loadForumTopics = live?.loadForumTopics;
  const loadTopicHistory = live?.loadTopicHistory;
  const forumChatId = chatList !== "saved" && loadTopicHistory
    && (active?.subtitle === "Group" || active?.subtitle === "Direct message") ? active.id : undefined;
  const topics = forum?.chatId === activeId ? forum?.topics : undefined;
  const openTopics = topics ?? (linkedTopic ? [linkedTopic] : undefined);
  const containingTopic = loadForumTopics && loadTopicHistory
    ? searchView?.returnToTopic ?? topics?.find(({ id }) => id === searchView?.topicId) : undefined;
  const checkPosting = live?.postingPermissions;
  const cachedHistory = historyView.get(activeId);
  const selectedHistory = remote?.id === activeId ? remote
    : cachedHistory && { id: activeId, page: cachedHistory.page };
  const migration = selectedHistory?.page?.migration;
  const restrictedChat = active && checkPosting
    && (active.subtitle === "Channel" || active.subtitle === "Group" || active.subtitle === "Channel messages") ? active.id : undefined;
  const postingChat = restrictedChat ?? (active?.subtitle === "Direct message" && chatList !== "saved" ? active.id : undefined);
  const permissions = posting?.id === postingChat ? posting?.permissions : undefined;
  const paidStars = permissions?.paidStars;
  const canSendText = !migration && (!restrictedChat || permissions?.text === true);
  const canAttachPhoto = !migration && !!live?.sendPhoto && (!restrictedChat || permissions?.photo === true);
  const sendPoll = !migration && permissions?.poll === true ? live?.sendPoll : undefined;
  const canAttachDocument = !migration && !!live?.sendDocument && (!restrictedChat || permissions?.document === true);
  const canAttachAudio = !migration && (!restrictedChat || permissions?.audio === true);
  const canAttachVideo = !migration && !!live?.sendDocument && (!restrictedChat || permissions?.video === true);
  const canCompose = canSendText || canAttachPhoto || canAttachDocument || canAttachVideo;
  const deletedIds = deletions?.id === activeId ? deletions.ids : undefined;
  const pinnedMessage = pinned?.id === activeId ? pinned.message : undefined;
  const pinnedText = live
    ? pinnedMessage && !deletedIds?.has(pinnedMessage.id) && displayMessagePreview(pinnedMessage, tr)
    : active?.pinned;
  const readOutbox = live?.list === "saved" ? undefined : selectedHistory?.page?.readOutbox;
  const loadedMessages = live ? selectedHistory?.page?.messages ?? [] : active?.messages ?? [];
  const byId = new Map(loadedMessages.map((message) => [message.id, message]));
  if (deletions?.id === activeId) for (const [id, row] of deletions.retained) {
    if (byId.has(id)) byId.set(id, row);
  }
  for (const message of sent[activeId] ?? []) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  useHistoryMessageUpdates(activeId, undefined, !!live && showConversation && !topicsOpen,
    (id) => !deletedIds?.has(id) && !!byId.get(id) && !byId.get(id)?.retained, (row) => {
      const list = history.current;
      if (list && isAwayFromLatest(list) && !scrollAnchor.current) {
        scrollAnchor.current = { id: activeId, ...captureHistoryScroll(list, "keep") };
      }
      setRemote((previous) => previous?.id === activeId && previous.page
        ? { ...previous, page: replaceLoadedHistoryMessage(previous.page, row) } : previous);
      setDeferredLatest((previous) => previous?.id === activeId
        ? { ...previous, page: replaceLoadedHistoryMessage(previous.page, row) } : previous);
      setSent((previous) => previous[activeId]?.some(({ id }) => id === row.id)
        ? { ...previous, [activeId]: previous[activeId].map((message) => message.id === row.id ? row : message) } : previous);
    });
  const messages = [...byId.values()].filter(({ id }) => !deletedIds?.has(id));
  const albumPhotos = photoTimeline(messages);
  const inbox = selectedHistory?.page?.readInbox;
  const hasUnread = (selectedHistory?.page?.unreadCount ?? active?.unread ?? 0) > 0;
  const firstUnread = hasUnread && live?.list !== "saved" && inbox !== undefined
    ? firstLoadedUnread(messages, loadedMessages, inbox, selectedHistory?.page?.before === null) : undefined;
  const unreadDivider = useRef<HTMLLIElement>(null);
  const chatListHeadingId = useId();
  const conversationHeadingId = useId();
  const unreadDividerId = useId();
  const [unreadJump, setUnreadJump] = useState<{ id: string; state: "loading" | "unavailable" }>();
  const canJumpToUnread = firstUnread || (hasUnread && live?.list !== "saved" && inbox !== undefined
    && live?.loadFirstUnread && live.loadMessageContext);

  async function jumpToUnread() {
    const list = history.current;
    if (!list || unreadJump?.id === activeId && unreadJump.state === "loading") return;
    const divider = unreadDivider.current;
    if (divider && firstUnread) {
      focusUnreadBoundary(list, divider, firstUnread);
      lastHistoryTop.current = list.scrollTop;
      followLatest.current = !selectedHistory?.page?.after && !isAwayFromLatest(list);
      setAwayFromLatest(!followLatest.current);
      return;
    }
    if (!live?.loadFirstUnread) return;
    const request = generation.current;
    const pending = { id: activeId, state: "loading" as const };
    setUnreadJump(pending);
    const id = await live.loadFirstUnread(activeId).catch(() => null);
    if (generation.current !== request) {
      setUnreadJump((current) => current === pending ? undefined : current);
      return;
    }
    if (id) {
      setUnreadJump(undefined);
      setSearchView({ chatId: activeId, messageId: id });
    } else setUnreadJump({ id: activeId, state: "unavailable" });
  }
  const canTranslateChat = !!translate && typeof IntersectionObserver === "function";
  const selection = useMessageSelection(activeId, byId, live, forwardActions, !overlayOpen, deletedIds, undefined, chatList === "saved" ? undefined : active?.name);
  const savedDraft = selectedHistory?.page?.draft;
  const draftSyncBusy = useRef(new Set<string>());
  const [draftConflict, setDraftConflict] = useState<Record<string, { reviewed?: TopicDraft } | undefined>>({});
  const conflict = draftConflict[activeId];
  const [draftSyncStatus, setDraftSyncStatus] = useState<Record<string, string>>({});
  const draft = drafts[activeId] ?? "";
  const inlineBot = live?.inlineBotActions && inlineBotRequest(draft);
  const formatting = useDraftFormatting(activeId, draft, draftInput, [], true, [], draftStorage?.chats.formatting);
  const sendStyles = formatting.deliveryStyles;
  const sendLinks = formatting.deliveryLinks;
  const sendEmoji = formatting.deliveryCustomEmoji;
  const previewAvailable = !!live && hasWebLink(draft);
  const previewPlacement = previewAvailable ? linkPreviews[activeId] : undefined;
  const attachment = attachments[activeId];
  const longDraft = !attachment && draft.trim().length > maxTelegramTextLength;
  const canSendTextFile = !!live && canSendText && canAttachDocument && !paidStars;
  const canSplitText = !!live && canSendText && !paidStars;
  const draftLimit = attachment ? 1024 : canSplitText ? undefined : maxTelegramTextLength;
  const currentAttachmentStatus = attachmentStatus[activeId];
  const uploading = uploadProgress[activeId];
  const attachmentAsGif = attachment?.kind === "video" && attachment.options?.mediaKind === "animation";
  const allowVideoAsGif = !migration && !!live?.sendDocument && !paidStars && (!restrictedChat || permissions?.otherMedia === true);
  const canSendAttachment = attachment?.kind === "photo" ? canAttachPhoto
    : attachment?.kind === "video" ? attachmentAsGif ? allowVideoAsGif : canAttachVideo : canAttachDocument;
  const edit = editing?.chat === activeId ? editing : undefined;
  useSwipeToReply(history, activeId, !!live && showConversation && !overlayOpen && !edit && !selection.active);
  const replyTarget = replyTargets[activeId];
  const canNavigateReply = !!live && showConversation && !overlayOpen && !edit && canCompose && !selection.active
    && !replyTarget?.origin && !sendingDraft && !currentAttachmentStatus?.preparing;
  function navigateChatReply(event: KeyboardEvent<HTMLTextAreaElement | HTMLOListElement>) {
    return canNavigateReply && navigateReply(event, history.current, replyTarget?.id, () => {
      setReplyTargets((previous) => ({ ...previous, [activeId]: undefined }));
    });
  }

  const checkDrawPhoto = live?.drawPhotoReplyTarget;
  const canDraw = !!checkDrawPhoto && showConversation && !overlayOpen && !edit && !selection.active && canAttachPhoto
    && !attachment && !replyTarget && !archivePreparing && !currentAttachmentStatus?.preparing && !sending.current.has(activeId);
  const beginDrawCheck = useDraftStashCheck(JSON.stringify([activeId, canDraw, live?.liveRevision]), attachment, replyTarget);
  async function verifyDrawPhoto(id: string) {
    if (!canDraw || !checkDrawPhoto || sending.current.has(activeId) || preparingAttachments.current.has(activeId)
      || deletedIds?.has(id) || !byId.get(id)?.canSavePhoto) return false;
    const stillCurrent = beginDrawCheck();
    return !!await checkDrawPhoto(activeId, id).catch(() => null) && stillCurrent();
  }
  function stageDrawnReply(source: Message, data: string) {
    setAttachments((previous) => ({ ...previous, [activeId]: { kind: "photo", name: "Drawn reply.jpg", drawnPhotoReply: source.id, data } }));
    setReplyTargets((previous) => ({ ...previous, [activeId]: source }));
    setAttachmentStatus((previous) => ({ ...previous, [activeId]: undefined }));
    setSendStatus((previous) => ({ ...previous, [activeId]: undefined }));
  }
  const drawPhotoReply = canDraw ? {
    verify: verifyDrawPhoto,
    async stage(id: string, data: string) {
      const source = byId.get(id);
      if (!source || !await verifyDrawPhoto(id)) return false;
      stageDrawnReply(source, data);
      requestAnimationFrame(() => draftInput.current?.focus());
      return true;
    },
  } : undefined;
  const canDrawFromShared = searching && showConversation && chatList !== "saved" && !!checkDrawPhoto && canAttachPhoto && !edit;
  const beginSharedDrawCheck = useDraftStashCheck(JSON.stringify([activeId, canDrawFromShared, liveRevision, !!attachment,
    archivePreparing, currentAttachmentStatus?.preparing, sendingDraft]), searchView, replyTarget);
  async function sharedDrawDestination(source: Message) {
    if (!canDrawFromShared || !checkDrawPhoto || deletedIds?.has(source.id)) return null;
    const topicId = source.forumTopicId;
    const forumDraft = topicId === undefined ? undefined : forumDrafts.forum(activeId);
    function available() {
      if (topicId !== undefined) return !!loadForumTopics && !!loadTopicHistory
        && !forumDraft?.attachments.getSnapshot()[topicId] && !forumDraft?.replies.getSnapshot()[topicId]
        && forumDraft?.attachmentDelivery.getSnapshot()[topicId] !== "sending";
      return !attachment && !replyTarget && !archivePreparing && !sending.current.has(activeId)
        && !preparingAttachments.current.has(activeId);
    }
    if (!available()) return null;
    const stillCurrent = beginSharedDrawCheck();
    const target = await checkDrawPhoto(activeId, source.id, topicId).catch(() => null);
    return target && target.topic?.id === topicId && stillCurrent() && available() ? target : null;
  }
  const drawFromShared: DrawPhotoReplyFromMessage | undefined = canDrawFromShared ? {
    verify: async (source) => !!await sharedDrawDestination(source),
    async stage(source, data) {
      const target = await sharedDrawDestination(source);
      if (!target) return false;
      if (target.topic) {
        const topic = target.topic;
        const drafts = forumDrafts.forum(activeId);
        drafts.attachments.update((previous) => ({ ...previous,
          [topic.id]: { kind: "photo", name: "Drawn reply.jpg", drawnPhotoReply: source.id, data },
        }));
        drafts.replies.update((previous) => ({ ...previous, [topic.id]: source }));
        drafts.attachmentDelivery.update((previous) => ({ ...previous, [topic.id]: undefined }));
        setForumView({ chatId: activeId, topic, focusReply: topic.id });
      } else {
        stageDrawnReply(source, data);
        setFocusReplyChat(activeId);
      }
      setSearchView(undefined);
      return true;
    },
  } : undefined;
  const drawnReply = drawnPhotoReplyId(attachment);
  const canStashDraft = !!live && canCompose && !drawnReply && !archivePreparing && !currentAttachmentStatus?.preparing
    && !sendingDraft && (!attachment || sendStatus[activeId] !== "unknown");
  const preparedDraft = linkDraft && (!linkDraft.chatId || linkDraft.chatId === activeId) ? linkDraft : undefined;
  const cannotInsertLinkDraft = !canSendText || !selectedHistory?.page || !!attachment || !!replyTarget
    || sendingDraft || preparingAttachments.current.has(activeId);
  const paidReviewKey = paidStars && (attachment ? !attachment.delivery?.date && draft.trim().length <= 1024 : draft.trim())
    ? JSON.stringify([activeId, paidStars, draft, replyTarget?.id, replyTarget?.selectedQuote, sendStyles, sendLinks, sendEmoji, previewPlacement])
    : undefined;

  useEffect(() => {
    setPaidReview(undefined);
  }, [paidReviewKey, attachment]);

  const externalReply = replyTarget?.origin;
  const canChooseMessageEffect = !!live?.loadMessageEffects && active?.subtitle === "Direct message" && chatList !== "saved"
    && !paidStars && !externalReply && (attachment
      ? (attachment.kind === "photo" || attachment.kind === "video" && !attachmentAsGif) && canSendAttachment
      : canSendText);
  const selectedMessageEffect = canChooseMessageEffect ? draftEffects[activeId] : undefined;
  const onlineAttachmentAllowed = useCanScheduleAttachmentWhenOnline(
    attachment && active?.subtitle === "Direct message" && chatList !== "saved" && !paidStars ? active.id : undefined,
    live?.canScheduleWhenOnline);
  const mediaReply = composerMediaReply(replyTarget);
  const replyDeleted = replyTarget && (!externalReply || externalReply.chatId === activeId) && deletedIds?.has(replyTarget.id);
  const beginExternalReplyCheck = useDraftStashCheck(JSON.stringify([activeId, !!forumView, showConversation, draft,
    replyTarget?.id, replyTarget?.origin, replyTarget?.selectedQuote, !!attachment, !!edit, linkPreviews[activeId],
    formatting.ranges, formatting.links, formatting.customEmoji, canSendText, canAttachPhoto, canAttachVideo, canAttachDocument,
    paidStars, sendingDraft, archivePreparing]), attachment, replyTarget);
  const search = query.trim().toLocaleLowerCase();
  const showRecentSearch = !!live?.recentChatSearch && recentSearchOpen && chatList === "main" && searchMode === "chats"
    && kind === "all" && !unreadOnly && !search && !linkDraft;
  const visible = chats.filter((chat) => {
    if (matched?.linked) return true;
    if (live && live.list !== "saved" && unreadOnly && !chat.unread && !chat.markedUnread) return false;
    if (live && kind !== "all" && chat.subtitle !== kind) return false;
    if (folder === "work" && !chat.work) return false;
    if (remoteQuery) return true;
    return [chat.name, ...chat.messages.map((message) => previewMessageText(message) ?? ""), ...(sent[chat.id] ?? []).map((message) => previewMessageText(message) ?? "")]
      .some((text) => text.toLocaleLowerCase().includes(search));
  });
  const showCommunityRows = kind === "all" && !unreadOnly && !search && !globalMode && !contactsMode && !discoveryMode
    && !!live?.communityActions && !!live.loadNotificationChat;
  const collapsed = showCommunityRows && chatList === "main" ? live.collapsedCommunities ?? [] : [];
  const folderCommunityRows = showCommunityRows && typeof chatList === "number" ? live.folderCommunities : undefined;
  const folderGroups = new Map(folderCommunityRows?.communities.map((group) => [group.id, group]));
  const visibleChats = new Map(visible.map((chat) => [chat.id, chat]));
  const pinnedChatIds = new Set<string>();
  const pinnedRows: Array<{ chat: Chat } | { group: CommunitySummary }> = [];
  for (const pin of folderCommunityRows?.pinned ?? []) {
    if (pin.community) {
      const group = folderGroups.get(pin.id);
      if (group) pinnedRows.push({ group });
    } else {
      const chat = visibleChats.get(pin.id);
      if (!chat || !chat.pinnedInList) continue;
      pinnedRows.push({ chat });
      pinnedChatIds.add(chat.id);
    }
  }
  const chatRowsInOrder = [...pinnedRows, ...visible.filter((chat) => !pinnedChatIds.has(chat.id)).map((chat) => ({ chat }))];
  const today = new Date().toDateString();
  const communityByChat = new Map(collapsed.flatMap(({ community, chatIds }) => chatIds.map((id) => [id, community] as const)));
  const communityRows = new Set<string>();
  function collapsedRow(group: CommunitySummary) {
    if (communityRows.has(group.id)) return null;
    communityRows.add(group.id);
    return <li key={`community:${group.id}`}>
      <button type="button" className="mtg-row" aria-haspopup="dialog" onClick={() => communityBrowser.current?.open(group)}>
        <CommunityLabel group={group} load={live?.communityActions?.avatar} />
      </button>
    </li>;
  }

  useEffect(() => {
    if (!forumChatId || !loadForumTopics) return;
    let current = true;
    void loadForumTopics(forumChatId, "").then(
      (topics) => { if (current) setForum({ chatId: forumChatId, topics }); },
      () => { if (current) setForum({ chatId: forumChatId, topics: null }); },
    );
    return () => { current = false; };
  }, [forumChatId, loadForumTopics, forumRevision]);

  useEffect(() => {
    if (!postingChat || !checkPosting) return;
    let current = true;
    void checkPosting(postingChat).then(
      (permissions) => { if (current) setPosting({ id: postingChat, permissions }); },
      () => { if (current) setPosting({ id: postingChat, permissions: null }); },
    );
    return () => { current = false; };
  }, [postingChat, checkPosting, liveRevision]);

  useEffect(() => {
    setDeletions(undefined);
    return subscribeToDeletions?.(({ id, messageIds, retained }) => {
      const removed = new Set(messageIds);
      setSent((previous) => previous[id]?.some((message) => removed.has(message.id))
        ? { ...previous, [id]: previous[id]!.filter((message) => !removed.has(message.id)) }
        : previous);
      setEditing((previous) => previous?.chat === id && removed.has(previous.message.id) ? undefined : previous);
      for (const [key, place] of readingPlaces) {
        if (place.chatId !== id) continue;
        if (removed.has(place.messageId)) readingPlaces.delete(key);
        if (historyView.get(key)?.page.messages.some((row) => removed.has(row.id))) historyView.forget(key);
      }
      setResumePlace((previous) => previous?.chatId === id && removed.has(previous.messageId) ? undefined : previous);
      if (id !== activeId) return;
      const list = history.current;
      if (list && isAwayFromLatest(list)) {
        const affected = new Set([...removed, ...(retained ?? []).map((row) => row.id)]);
        const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"));
        if (rows.some((row) => affected.has(row.dataset.messageId ?? ""))) {
          scrollAnchor.current = { id, ...captureHistoryScroll(list, "keep", removed) };
        }
      }
      setDeletions((previous) => ({
        id, ids: new Set([...(previous?.ids ?? []), ...removed]),
        retained: new Map([...(previous?.retained ?? []), ...(retained ?? []).map((row) => [row.id, row] as const)]),
      }));
    });
  }, [activeId, subscribeToDeletions, historyView, readingPlaces]);

  useEffect(() => {
    setReadPausedChat((previous) => previous === activeId ? previous : undefined);
  }, [activeId]);

  const markHistoryRead = live?.markHistoryRead;
  const refreshReadChat = live?.loadNotificationChat;
  const syncChatReadState = live?.syncChatReadState;
  const readRefreshes = useRef(new Map<string, symbol>());
  const readLifetime = useRef<symbol | undefined>(undefined);
  useLayoutEffect(() => {
    readLifetime.current = Symbol();
    const requests = readRefreshes.current;
    return () => { readLifetime.current = undefined; requests.clear(); };
  }, []);
  const markConversationHistoryRead = useCallback<MarkHistoryRead>(async (id, messageId, topicId, clearUnreadMark) => {
    if (!markHistoryRead || marking.current.has(id)) return false;
    const lifetime = readLifetime.current;
    const confirmed = await markHistoryRead(id, messageId, topicId, clearUnreadMark);
    if (confirmed && topicId === undefined && refreshReadChat && lifetime && lifetime === readLifetime.current
      && !marking.current.has(id)) {
      const request = Symbol();
      readRefreshes.current.set(id, request);
      const updated = await refreshReadChat(id).catch(() => null);
      if (readRefreshes.current.get(id) === request) {
        readRefreshes.current.delete(id);
        if (updated?.id === id) {
          const read = { unread: updated.unread, markedUnread: updated.markedUnread };
          syncChatReadState?.(updated);
          setSelectedChat((previous) => previous?.id === id ? { ...previous, ...read } : previous);
          setResults((previous) => previous && { ...previous, chats: previous.chats.map((chat) =>
            chat.id === id ? { ...chat, ...read } : chat) });
        }
      }
    }
    return confirmed;
  }, [markHistoryRead, refreshReadChat, syncChatReadState]);
  const dismissMessageNotification = live?.dismissMessageNotification;
  const markNotificationRead = markHistoryRead && (async (notice: MessageNotification) => {
    if (notice.pendingMessage || notice.canMarkRead === false) return false;
    const confirmed = await markConversationHistoryRead(notice.chatId, notice.messageId, notice.topicId);
    if (confirmed) dismissMessageNotification?.(notice.key);
    return confirmed;
  });

  const readVisibleHistory = showConversation && !overlayOpen && !edit && !migration && live?.list !== "saved"
    && readPausedChat !== activeId && markStatus[activeId] !== "busy";
  const unreadEffects = useMemo(() => new Map(
    inbox === undefined ? [] : (selectedHistory?.page?.messages ?? [])
      .filter((message) => message.effectId && !message.outgoing && !message.oneView && !message.retained
        && !message.pendingDelivery && !message.failedDelivery && !deletedIds?.has(message.id) && Number(message.id) > inbox)
      .map((message) => [message.id, message.effectId!] as const)
  ), [deletedIds, inbox, selectedHistory?.page?.messages]);
  const seenEffects = useRef(new Set<string>());
  const [automaticEffect, setAutomaticEffect] = useState<{
    chatId: string; messageId: string; effectId: string; playback: AutomaticMessageEffect;
  }>();
  const queueVisibleEffect = useCallback((ids: readonly string[]) => {
    let newest: { messageId: string; effectId: string } | undefined;
    for (const messageId of ids) {
      const effectId = unreadEffects.get(messageId);
      if (!effectId) continue;
      const key = `${activeId}:${messageId}`;
      if (seenEffects.current.has(key)) continue;
      seenEffects.current.add(key);
      if (seenEffects.current.size > 4096) seenEffects.current.delete(seenEffects.current.values().next().value!);
      if (!newest || Number(messageId) > Number(newest.messageId)) newest = { messageId, effectId };
    }
    if (!newest) return;
    let pending = true;
    setAutomaticEffect({ chatId: activeId, ...newest, playback: { claim: () => {
      const available = pending;
      pending = false;
      return available;
    } } });
  }, [activeId, unreadEffects]);
  useEffect(() => {
    setAutomaticEffect((current) => readVisibleHistory && current?.chatId === activeId ? current : undefined);
  }, [activeId, readVisibleHistory]);

  useVisibleHistoryRead({
    list: history, chatId: activeId, messageIds: readableHistoryIds(selectedHistory?.page?.messages, inbox, deletedIds, active?.markedUnread ? true : undefined),
    mark: markHistoryRead ? markConversationHistoryRead : undefined,
    enabled: readVisibleHistory,
    clearUnreadMark: active?.markedUnread ? true : undefined,
    onVisible: unreadEffects.size ? queueVisibleEffect : undefined,
  });

  const chatMediaOverride = live?.automaticMediaOverrides?.[activeId];
  const playbackOverride = live?.automaticPlaybackOverrides?.[activeId];
  const defaultChatPlayback = playbackLimitsForChat(active, live?.automaticPlayback);
  const saveChatPlaybackOverride = live?.saveChatPlaybackOverride;
  const autoplayLimits = showConversation && !overlayOpen && !edit && chatList !== "saved" && live?.automaticPlaybackOverrides
    ? playbackLimitsForChat(active, live.automaticPlayback, playbackOverride) : undefined;
  const defaultChatMedia = mediaLimitsForChat(active, live?.automaticMedia);
  const saveChatMediaOverride = live?.saveChatMediaOverride;
  useVisibleMediaPrefetch({
    list: history, chatId: activeId, policy: live?.automaticMedia, override: chatMediaOverride, prefetch: live?.prefetchVisibleMedia,
    ids: visibleMediaCandidates(active, messages, live?.automaticMedia, chatMediaOverride),
    enabled: showConversation && !overlayOpen && !edit && live?.list !== "saved",
  });

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
    restoredHistoryPosition.current = undefined;
    if (!activeId || !showConversation) {
      scrollChat.current = undefined;
      return;
    }
    if (!list || list.hidden) return;
    if (live && !selectedHistory?.page) return;
    const reopening = scrollChat.current !== activeId;
    const layoutChanged = historyWorkspace.current !== workspaceActive;
    historyWorkspace.current = workspaceActive;
    const remembered = (reopening || layoutChanged) && cachedHistory;
    const openAt = selectedHistory?.page?.openAt;
    const positionKey = openAt && `${activeId}:${openAt}`;
    const startingRow = openAt && unreadPositioned.current !== positionKey
      ? list.querySelector<HTMLElement>(`[data-message-id="${openAt}"]`) : undefined;
    if (remembered) {
      unreadPositioned.current = positionKey;
      restoreHistoryScroll(list, remembered.position);
      restoredHistoryPosition.current = remembered.position;
    } else if (startingRow) {
      unreadPositioned.current = positionKey;
      list.scrollTop += startingRow.getBoundingClientRect().top - list.getBoundingClientRect().top;
    } else if (anchor?.id === activeId) {
      restoreHistoryScroll(list, anchor);
    } else if (scrollChat.current !== activeId || followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
    scrollChat.current = activeId;
    lastHistoryTop.current = list.scrollTop;
    lastHistoryWidth.current = list.clientWidth;
    followLatest.current = !selectedHistory?.page?.after && !isAwayFromLatest(list);
    setAwayFromLatest(!followLatest.current);
  }, [activeId, messages.length, selectedHistory?.page, deletedIds, overlayOpen, showConversation, workspaceActive]);

  useLayoutEffect(() => {
    const list = history.current;
    if (!list || !showConversation) return;
    return observeHistoryResize(list, () => !list.hidden && scrollChat.current === activeId,
      () => followLatest.current, () => {
        lastHistoryTop.current = list.scrollTop;
        lastHistoryWidth.current = list.clientWidth;
      }, restoredHistoryPosition.current);
  }, [activeId, messages.length, selectedHistory?.page, deletedIds, showConversation, workspaceActive]);

  useEffect(() => {
    const request = ++generation.current;
    olderPending.current = false;
    newerPending.current = false;
    latestJumpPending.current = false;
    setLatestJump(undefined);
    unreadPositioned.current = undefined;
    setNewerStatus(undefined);
    setDeferredLatest(undefined);
    setOlderLoading(false);
    setOlderError(false);
    if (!loadHistory || !activeId) return;
    const requestedRevision = currentRevision.current;
    const cached = historyView.get(activeId);
    if (cached) {
      unreadPositioned.current = cached.page.openAt && `${activeId}:${cached.page.openAt}`;
      seenRevision.current = null;
      setRemote({ id: activeId, page: cached.page });
      return () => { generation.current++; };
    }
    setRemote({ id: activeId });
    const initial = loadUnreadHistory
      ? loadUnreadHistory(activeId).then((page) => page ?? loadHistory(activeId))
      : loadHistory(activeId);
    void initial.then(
      (page) => {
        if (generation.current === request) {
          seenRevision.current = requestedRevision;
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
  }, [activeId, loadHistory, loadUnreadHistory, historyAttempt, historyView]);

  useLayoutEffect(() => { renderedHistory.current = remote; }, [remote]);

  useEffect(() => {
    setResumePlace(showConversation && !historyView.get(activeId) ? readingPlaces.get(activeId) : undefined);
  }, [activeId, showConversation, historyView, readingPlaces]);

  const historyLoaded = selectedHistory?.page !== undefined;
  useEffect(() => {
    if (!loadHistory || !activeId) {
      seenRevision.current = liveRevision;
      return;
    }
    if (!showConversation || !historyLoaded || seenRevision.current === liveRevision) return;
    if (selectedHistory?.page?.after) return;
    const request = generation.current;
    let current = true;
    const isCurrent = () => current && generation.current === request;
    void loadHistory(activeId).then(async (page) => {
      if (!isCurrent()) return;
      const previous = renderedHistory.current;
      const staged = stagedHistory.current?.id === activeId ? stagedHistory.current.page : undefined;
      const base = staged ?? (previous?.id === activeId ? previous.page : historyView.get(activeId)?.page);
      const newestLoaded = Number(base?.messages.at(-1)?.id);
      const latest = await fillHistoryGap(page, newestLoaded, (before) => loadHistory(activeId, before), isCurrent);
      if (!latest || !isCurrent()) return;
      seenRevision.current = liveRevision;
      const list = history.current;
      if (staged && stagedHistory.current?.page === staged) {
        setDeferredLatest({ id: activeId, page: latest.disconnected ? latest.page : mergeLatestHistory(staged, latest.page) });
        return;
      }
      if (latest.disconnected) {
        if (!followLatest.current || (list && isAwayFromLatest(list))) {
          setDeferredLatest({ id: activeId, page: latest.page });
        } else {
          historyReplacement.current++;
          setDeferredLatest(undefined);
          scrollAnchor.current = undefined;
          setRemote({ id: activeId, page: latest.page });
        }
        return;
      }
      setDeferredLatest(undefined);
      if (list && !scrollAnchor.current && isAwayFromLatest(list)) {
        scrollAnchor.current = { id: activeId, ...captureHistoryScroll(list, "keep") };
      }
      setRemote((previous) => ({
        id: activeId, page: mergeLatestHistory(previous?.id === activeId ? previous.page : base, latest.page),
      }));
    }).catch(() => {
      // Keep the current history available when a live refresh fails.
    });
    return () => { current = false; };
  }, [activeId, historyLoaded, historyView, liveRevision, loadHistory, selectedHistory?.page?.after, showConversation]);

  useEffect(() => {
    if (!findChats || !remoteQuery || chatList === undefined || directUrl) return;
    let current = true;
    const timer = setTimeout(() => {
      const boostUrl = resolveBoostLink && canonicalTelegramBoostLink(remoteQuery);
      const managedBotUrl = managedBotLinks && chatList === "main" && canonicalTelegramManagedBotLink(remoteQuery);
      const gameUrl = gameLinks && chatList === "main" && telegramGameLink(remoteQuery)?.url;
      const packLink = chatList === "main" && telegramStickerPackReference(remoteQuery);
      const result = gameUrl && gameLinks
        ? gameLinks.resolve(gameUrl).then((linkedGame) => linkedGame ? { chats: [], linkedGame }
          : { chats: [], error: "This Telegram game link is unavailable." })
        : managedBotUrl && managedBotLinks
        ? managedBotLinks.preview(managedBotUrl).then((linkedManagedBot) => linkedManagedBot ? { chats: [], linkedManagedBot }
          : { chats: [], error: "This Telegram managed bot link is unavailable." })
        : boostUrl && resolveBoostLink
        ? resolveBoostLink(boostUrl).then((boostChat) => boostChat ? { chats: [], boostChat }
          : { chats: [], error: "This Telegram boost link is unavailable." })
        : chatList === "main" && resolveBotStartLink && parseTelegramBotStartLink(remoteQuery)
        ? resolveBotStartLink(remoteQuery).then((linkedBot) => linkedBot ? { chats: [], linkedBot }
          : { chats: [], error: "This Telegram bot link is unavailable." })
        : packLink && loadLinkedStickerPack
        ? (stickerRefresh ? loadLinkedStickerPack(remoteQuery, 0, true) : loadLinkedStickerPack(remoteQuery))
          .then((stickerPack) => stickerPack ? { chats: [], stickerPack }
          : { chats: [], error: packLink.emoji ? "This Telegram emoji pack is unavailable." : "This Telegram sticker pack is unavailable." })
        : chatList === "main" && previewFolderInvite && isTelegramFolderInviteLink(remoteQuery)
        ? previewFolderInvite(remoteQuery).then((folderInvite) => folderInvite ? { chats: [], folderInvite }
          : { chats: [], error: "This shared Telegram folder is unavailable." })
        : chatList === "main" && previewInvite && isTelegramInviteLink(remoteQuery)
        ? previewInvite(remoteQuery).then((invite) => invite ? { chats: [], invite }
          : { chats: [], error: "This Telegram invitation is unavailable." })
        : chatList === "main" && resolveStoryAlbumLink && canonicalTelegramStoryAlbumLink(remoteQuery)
        ? resolveStoryAlbumLink(remoteQuery).then((linkedStoryAlbum) => linkedStoryAlbum ? { chats: [], linkedStoryAlbum }
          : { chats: [], error: "This Telegram story album is unavailable." })
        : chatList === "main" && resolveStoryLink && parseTelegramStoryLink(remoteQuery)
        ? resolveStoryLink(remoteQuery).then((linkedStory) => linkedStory ? { chats: [], linkedStory }
          : { chats: [], error: "This Telegram story is unavailable." })
        : chatList === "main" && resolveMessageLink && isTelegramMessageLink(remoteQuery)
        ? resolveMessageLink(remoteQuery).then((linked) => linked ? { chats: [linked.chat], linked }
          : { chats: [], error: "This Telegram message is unavailable." })
        : findChats(publicLookup ?? remoteQuery, chatList).then((chats) => publicLookup && chats.length !== 1
          ? { chats: [], error: "This Telegram destination is unavailable." } : { chats });
      void result.then(
        (payload) => { if (current) setResults({ query: remoteQuery, list: chatList, ...payload }); },
        () => { if (current) setResults({ query: remoteQuery, list: chatList, chats: [], error: "Telegram search failed." }); },
      );
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [chatList, directUrl, findChats, gameLinks, loadLinkedStickerPack, managedBotLinks, previewFolderInvite, previewInvite, publicLookup, remoteQuery, resolveBoostLink, resolveBotStartLink, resolveMessageLink, resolveStoryAlbumLink, resolveStoryLink, stickerRefresh]);

  const before = selectedHistory?.page?.before;
  const predecessor = before === null ? selectedHistory?.page?.predecessor : undefined;
  const loadOlder = useCallback(async () => {
    if (!loadHistory || !before || olderPending.current) return;
    const request = generation.current;
    const replacement = historyReplacement.current;
    olderPending.current = true;
    setOlderLoading(true);
    setOlderError(false);
    try {
      const page = await loadHistory(activeId, before);
      if (generation.current !== request || replacement !== historyReplacement.current
        || renderedHistory.current?.id !== activeId || renderedHistory.current.page?.before !== before) return;
      const list = history.current;
      if (list) {
        scrollAnchor.current = { id: activeId, ...captureHistoryScroll(list, "prepend") };
      }
      setRemote((previous) => {
        if (previous?.id !== activeId || previous.page?.before !== before) return previous;
        return { id: activeId, page: prependHistory(previous.page, page) };
      });
    } catch {
      if (generation.current === request && replacement === historyReplacement.current) setOlderError(true);
    } finally {
      if (generation.current === request) {
        olderPending.current = false;
        setOlderLoading(false);
      }
    }
  }, [activeId, before, loadHistory]);

  const after = selectedHistory?.page?.after;
  async function loadNewer() {
    if (!loadUnreadHistory || !after || newerPending.current || latestJumpPending.current) return;
    const request = generation.current;
    const replacement = historyReplacement.current;
    const current = () => generation.current === request && historyReplacement.current === replacement;
    newerPending.current = true;
    setNewerStatus("loading");
    try {
      const next = await loadUnreadHistory(activeId, after);
      if (!current() || renderedHistory.current?.id !== activeId || renderedHistory.current.page?.after !== after) return;
      if (!next) throw new Error("Newer history is unavailable.");
      const list = history.current;
      if (list) scrollAnchor.current = { id: activeId, ...captureHistoryScroll(list, "keep") };
      setRemote((previous) => {
        if (previous?.id !== activeId || previous.page?.after !== after) return previous;
        return { id: activeId, page: appendUnreadHistory(previous.page, next) };
      });
      setNewerStatus(undefined);
    } catch {
      if (current()) setNewerStatus("failed");
    } finally {
      if (generation.current === request) newerPending.current = false;
    }
  }

  async function jumpToLatest() {
    const list = history.current;
    if (!list || latestJumpPending.current) return;
    const request = generation.current;
    const replacement = historyReplacement.current;
    const current = () => generation.current === request && historyReplacement.current === replacement;
    let latest = deferredLatest?.id === activeId ? deferredLatest.page : undefined;
    if (!latest && after && loadHistory) {
      latestJumpPending.current = true;
      setLatestJump("loading");
      const revision = currentRevision.current;
      try {
        latest = await loadHistory(activeId);
        if (!current()) return;
        seenRevision.current = revision;
      } catch {
        if (current()) setLatestJump("failed");
        return;
      } finally {
        if (generation.current === request) {
          latestJumpPending.current = false;
          if (!current()) setLatestJump(undefined);
        }
      }
    }
    if (!current()) return;
    setLatestJump(undefined);
    readingPlaces.delete(activeId);
    historyView.forget(activeId);
    setResumePlace(undefined);
    if (!list.hidden && !list.contains(document.activeElement)) list.focus({ preventScroll: true });
    if (latest) {
      historyReplacement.current++;
      scrollAnchor.current = undefined;
      setNewerStatus(undefined);
      setRemote({ id: activeId, page: latest });
      setDeferredLatest(undefined);
    } else list.scrollTop = list.scrollHeight;
    lastHistoryTop.current = list.scrollTop;
    followLatest.current = true;
    setAwayFromLatest(false);
  }

  const canLoadOlderOnScroll = before && !overlayOpen && !olderError && !olderLoading;

  const loadMoreChats = live?.loadMore;
  const canLoadMore = !remoteQuery && !live?.loading && !live?.loadingMore;
  const chatLoadError = live?.error;
  const browsingChatList = !search && kind === "all" && !unreadOnly && !globalMode && !contactsMode && !discoveryMode && !showRecentSearch;
  useLayoutEffect(() => {
    const viewport = chatListViewport.current;
    if (viewport.list !== chatList) {
      chatListMotion.current?.cancel();
      chatListViewport.current = { list: chatList, restore: "folder" };
    }
    const rows = chatRows.current;
    if (chatList === undefined || !browsingChatList || !rows?.clientHeight || live?.loading) return;
    const top = chatListScroll.current.get(chatList) ?? 0;
    const restore = chatListViewport.current.restore;
    if (!restore || (restore === "back" && showConversation)) return;
    if (!chatLoadError && loadMoreChats && top > rows.scrollHeight - rows.clientHeight) {
      if (canLoadMore) void loadMoreChats();
      return;
    }
    chatListViewport.current.restore = undefined;
    rows.scrollTop = top;
    if (restore === "folder" && window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches) {
      chatListMotion.current = rows.animate?.([{ opacity: .65 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
    }
  }, [browsingChatList, canLoadMore, chatList, chatLoadError, live?.loading, loadMoreChats, showConversation, workspaceActive]);
  useEffect(() => {
    const root = chatRows.current;
    const target = moreChats.current;
    if (showRecentSearch || !autoPagination || !root || !target || !loadMoreChats || !canLoadMore || chatLoadError) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) return;
      observer.disconnect();
      void loadMoreChats();
    }, { root });
    observer.observe(target);
    return () => observer.disconnect();
  }, [autoPagination, canLoadMore, chatLoadError, loadMoreChats, showRecentSearch, visible.length]);

  async function addDraggedChat(folderId: number) {
    const chat = draggedChat.current;
    const actions = live?.folderActions;
    draggedChat.current = undefined;
    if (!chat || !actions || pendingFolderDrop.current) return;
    const folder = live.folders.find(({ id }) => id === folderId);
    if (!folder || chatList === folderId) return;
    pendingFolderDrop.current = true;
    setFolderDropNotice("");
    try {
      if (await actions.setMembership(folderId, chat.id, "include")) {
        setFolderDropNotice(tr("Chat added to {0}.", [folder.title]));
        live.refresh();
      } else setFolderDropNotice("Telegram did not add the chat to this folder.");
    } catch {
      setFolderDropNotice("Could not add the chat to this folder.");
    } finally {
      pendingFolderDrop.current = false;
    }
  }

  function switchList(next: ChatList) {
    if (!live || live.list === next) return;
    closeConversation();
    setKind("all");
    setUnreadOnly(false);
    setSearchMode("chats");
    setQuery("");
    setRecentSearchOpen(false);
    live.selectList(next);
  }

  function closeConversation() {
    scheduleNavigationFocus();
    navigationEdited.current = true;
    if (navigationScope) forgetConversationLocation(navigationScope);
    setDetailsRequest(undefined);
    setShowConversation(false);
    setActiveId("");
    setSelectedChat(undefined);
    setReadPausedChat(undefined);
    setSearchView(undefined);
    setForumView(undefined);
    setDiscussion(undefined);
    setSavedSourcesChat(undefined);
  }

  function backToChats() {
    if (searchView?.returnToGlobalResult) {
      backToGlobalResults(searchView.returnToGlobalResult);
      return;
    }
    const row = chatRows.current?.querySelector<HTMLButtonElement>(".mtg-row[aria-current=true]");
    if (browsingChatList && chatList !== undefined) chatListViewport.current.restore = "back";
    closeConversation();
    scheduleNavigationFocus(() => row?.isConnected && !row.closest("[hidden]") ? row : listHeading.current ?? undefined, true);
  }

  function backToGlobalResults(restore: () => HTMLElement | undefined) {
    closeConversation();
    scheduleNavigationFocus(restore, true);
  }

  function scheduleNavigationFocus(target?: () => HTMLElement | undefined, preventScroll = false) {
    if (conversationFocusFrame.current !== undefined) cancelAnimationFrame(conversationFocusFrame.current);
    const previous = document.activeElement;
    conversationFocusFrame.current = target ? requestAnimationFrame(() => {
      conversationFocusFrame.current = undefined;
      if (document.activeElement === previous || document.activeElement === document.body) target()?.focus({ preventScroll });
    }) : undefined;
  }

  function scheduleConversationFocus(focusHeading = true) {
    scheduleNavigationFocus(focusHeading ? () => heading.current ?? undefined : undefined);
  }

  function openConversation(chat: Chat, focusHeading = true) {
    navigationEdited.current = true;
    setReadPausedChat(undefined);
    setDetailsRequest(undefined);
    setSavedSourcesChat(undefined);
    setSearchView(undefined);
    setForumView(undefined);
    setDiscussion(undefined);
    setSelectedChat(chat);
    setActiveId(chat.id);
    setShowConversation(true);
    scheduleConversationFocus(focusHeading);
  }

  async function openNextUnreadChannel() {
    if (unreadChannelList === undefined || overlayOpen || channelLookup.current) return;
    if (nextUnreadChannel) {
      openConversation(nextUnreadChannel);
      return;
    }
    if (!live?.findNextUnreadChannel) return;
    const controller = new AbortController();
    channelLookup.current = controller;
    setChannelLookupStatus("loading");
    try {
      const target = await live.findNextUnreadChannel(activeId, unreadChannelList, controller.signal);
      if (controller.signal.aborted) return;
      if (!target) setChannelLookupStatus("empty");
      else {
        setChannelLookupStatus(undefined);
        switchList(target.list);
        openConversation(target.chat);
      }
    } catch {
      if (!controller.signal.aborted) setChannelLookupStatus("failed");
    } finally {
      if (channelLookup.current === controller) channelLookup.current = undefined;
    }
  }

  function recordSearchChat(id: string) {
    const recent = live?.recentChatSearch;
    if (!recent) return;
    void recent.record(id).catch(() => false).then((saved) => {
      setRecentRecordFailed(!saved);
      if (saved) setRecentSearchRevision((revision) => revision + 1);
    });
  }

  async function openMigratedConversation(id: string, signal: AbortSignal) {
    const scope = generation.current;
    const chat = await live?.loadNotificationChat?.(id);
    if (signal.aborted || scope !== generation.current || chat?.id !== id || chat.subtitle !== "Group" || id === activeId) return false;
    openConversation(chat);
    return true;
  }

  function openLinkedDetails(chat: Chat, kind: "profile" | "boost") {
    openConversation(chat, false);
    setDetailsRequest({ id: chat.id, kind, nonce: ++openingTelegramLink.current });
  }

  function openLinkedMessage(linked: LinkedTelegramMessage) {
    if ("topic" in linked && (!loadForumTopics || !loadTopicHistory)) return false;
    if ("messageId" in linked && !live?.loadMessageContext && !live?.loadMessageContextPage) return false;
    openConversation(linked.chat, !("messageId" in linked && (linked.checklistTaskId !== undefined || linked.pollOptionId !== undefined)));
    if ("topic" in linked) {
      setForumView((previous) => ({ chatId: linked.chat.id, topic: linked.topic, revision: (previous?.revision ?? 0) + 1 }));
    } else {
      const returnToTopic = loadForumTopics && loadTopicHistory && linked.parentTopic?.id === linked.topicId
        ? linked.parentTopic : undefined;
      setSearchView({ chatId: linked.chat.id, messageId: linked.messageId, topicId: linked.topicId,
        mediaTimestamp: linked.mediaTimestamp, checklistTaskId: linked.checklistTaskId, pollOptionId: linked.pollOptionId,
        returnToTopic, revision: ++linkedMessageRevision.current });
    }
    return true;
  }

  const listTitle = live
    ? live.list === "main" ? tr("All Chats") : live.list === "archive" ? tr("Archive") : live.list === "saved" ? tr("Saved Messages") : live.folders.find(({ id }) => id === live.list)?.title ?? tr("Folder")
    : folder === "all" ? tr("All Chats") : tr("Work");

  const typingActivity = useTypingActivity(activeId,
    showConversation && !overlayOpen && !edit && !attachment && canSendText && chatList !== "saved" &&
      (active?.subtitle === "Group" || active?.subtitle === "Direct message") && !sendingDraft
      ? live?.setTypingActivity : undefined);
  function changeDraft(value: string, caret?: number) {
    formatting.change(value, caret);
    setDrafts((previous) => ({ ...previous, [activeId]: value }));
  }

  async function openTemporaryProfile(url: string, request: number, stillCurrent: () => boolean) {
    const scope = generation.current;
    const chat = await resolveTemporaryContact?.(url);
    if (!stillCurrent() || request !== openingTelegramLink.current || scope !== generation.current || chat?.subtitle !== "Direct message") return false;
    switchList("main");
    setQuery("");
    openLinkedDetails(chat, "profile");
    return true;
  }

  async function openBusinessConversation(url: string, request: number, stillCurrent: () => boolean) {
    const scope = generation.current;
    const target = await resolveBusinessChat?.(url);
    if (!stillCurrent() || request !== openingTelegramLink.current || scope !== generation.current
      || target?.chat.subtitle !== "Direct message") return false;
    switchList("main");
    setQuery("");
    openConversation(target.chat);
    setLinkDraft(target.draft ? { ...target.draft, chatId: target.chat.id, selectionStart: 0,
      formattingReduced: target.formattingReduced } : undefined);
    return true;
  }

  function openPublicLink(chat: Chat, link: NonNullable<typeof publicLink>) {
    if (link.profile) openLinkedDetails(chat, "profile");
    else openConversation(chat);
    setLinkDraft(link.text ? { text: link.text, selectionStart: 0, chatId: chat.id } : undefined);
  }

  function chooseShareDestination(share: { url: string; text?: string }) {
    switchList("main");
    backToChats();
    setSearchMode("chats");
    setKind("all");
    setUnreadOnly(false);
    setQuery("");
    setLinkDraft({ text: [share.url, share.text].filter(Boolean).join("\n"),
      selectionStart: share.url.length + (share.text ? 1 : 0) });
    requestAnimationFrame(() => chatSearch.current?.focus());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (longDraftRecord.getSnapshot()[activeId]) return;
    if (preparingAttachments.current.has(activeId) || archivePicker.current?.isPreparing() || replyDeleted) return;
    if (attachment?.delivery?.whenOnline && !onlineAttachmentAllowed) return;
    if (attachment ? !canSendAttachment : !canSendText) return;
    const value = draft.trim();
    if ((!value && !attachment) || longDraft) return;
    if (live) {
      if (paidStars) {
        if (paidReviewKey) setPaidReview({ key: paidReviewKey, attachment });
        return;
      }
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
    const unread = !((chat.id === activeId ? hasUnread : !!chat.unread) || chat.markedUnread);
    readRefreshes.current.delete(id);
    if (chat.id === activeId) setReadPausedChat(unread ? id : undefined);
    marking.current.add(id);
    setMarkStatus((previous) => ({ ...previous, [id]: "busy" }));
    try {
      const updated = await live.markChat(id, unread);
      setRemote((previous) => previous?.id === id && previous.page && (unread === false || updated.unread !== undefined)
        ? { ...previous, page: { ...previous.page, unreadCount: updated.unread ?? 0 } }
        : previous);
      setSelectedChat((previous) => previous?.id === id
        ? { ...previous, unread: updated.unread, markedUnread: updated.markedUnread } : previous);
      setResults((previous) => previous ? { ...previous, chats: previous.chats.map((entry) => entry.id === id
        ? { ...entry, unread: updated.unread, markedUnread: updated.markedUnread } : entry) } : previous);
      setMarkStatus((previous) => ({ ...previous, [id]: undefined }));
    } catch {
      if (unread) setReadPausedChat((previous) => previous === id ? undefined : previous);
      setMarkStatus((previous) => ({ ...previous, [id]: "failed" }));
    } finally {
      marking.current.delete(id);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement, links?: import("../core/contract.ts").EditLinks, customEmoji?: import("../core/contract.ts").EditCustomEmoji) {
    event.preventDefault();
    if (!edit || edit.busy || !live) return;
    const text = edit.text.trim();
    await applyEdit(edit, () => submitMessageEdit(edit.chat, edit.message, text, live, styles, removeLinkPreview, placement, links, undefined, customEmoji));
  }

  async function replaceEditedPhoto(file: File) {
    const replace = live?.replacePhoto;
    if (!edit || edit.busy || !replace) return;
    await applyEdit(edit, () => replacePreparedPhoto(replace, edit.chat, edit.message, file));
  }

  async function replaceEditedAttachment(file: File, progress: ReplacementProgress, signal: AbortSignal) {
    const replace = live?.replaceAttachment;
    const attachment = edit?.message.attachmentEdit;
    if (!edit || edit.busy || !replace || !attachment) return;
    await applyEdit(edit, () => replace(edit.chat, edit.message.id, attachment, file, progress, signal));
  }

  async function applyEdit(edit: NonNullable<typeof editing>, apply: () => Promise<AttachmentEditResult> | undefined) {
    setEditing({ ...edit, busy: true, error: undefined });
    let result: AttachmentEditResult;
    try {
      result = await (apply() ?? { state: "failed" });
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
      const error = result.state === "cancelled" ? undefined : result.state === "unknown" ? "Telegram did not confirm the edit." : "The message changed or Telegram rejected the edit.";
      setEditing((previous) => previous?.chat === edit.chat && previous.message.id === edit.message.id
        ? { ...previous, busy: false, error } : previous);
    }
  }

  async function chooseAttachment(file: File | undefined, id: string, kind: DraftAttachment["kind"], delivery?: DraftAttachment["delivery"]) {
    if (!file || !id) return;
    preparingAttachments.current.delete(id);
    const updateStatus = (value: typeof currentAttachmentStatus) =>
      setAttachmentStatus((previous) => ({ ...previous, [id]: value }));
    updateStatus(undefined);
    if (kind !== "photo") {
      if (!file.size || file.size > maxTelegramUploadBytes || (kind === "video" && !isVideoAttachmentName(file.name))) {
        updateStatus({ error: kind === "video" ? "Choose a non-empty MP4 or MOV video up to 4000 MiB." : "Choose a non-empty document up to 4000 MiB." });
        return;
      }
      setAttachments((previous) => ({ ...previous, [id]: { kind, name: file.name, file, delivery } }));
      setUploadRejections((previous) => ({ ...previous, [id]: undefined }));
      setSendStatus((previous) => ({ ...previous, [id]: undefined }));
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
      setAttachments((previous) => ({ ...previous, [id]: { kind, name: file.name.slice(0, 255), data, originalFile: file } }));
      updateStatus(undefined);
    } catch {
      if (preparingAttachments.current.get(id) === request) {
        updateStatus({ error: "Could not prepare this JPEG. Use Attach document to send the original." });
      }
    } finally {
      if (preparingAttachments.current.get(id) === request) preparingAttachments.current.delete(id);
    }
  }

  function chooseChatFiles(files: File[]) {
    if (!files.length || sending.current.has(activeId)) return;
    const file = files[0];
    const multiple = files.length > 1;
    if (multiple && !replyDeleted) {
      if (mediaController.current?.addDroppedMedia(files)) {
        setAttachmentStatus((previous) => ({ ...previous, [activeId]: undefined }));
        return;
      }
      if (archivePicker.current) {
        setAttachmentStatus((previous) => ({ ...previous, [activeId]: undefined }));
        archivePicker.current.offer(files);
        return;
      }
    }
    const kind = file && !multiple
      ? droppedAttachment(file, { photo: canAttachPhoto, video: canAttachVideo, document: canAttachDocument }) : undefined;
    if (file && kind) void chooseAttachment(file, activeId, kind);
    else setAttachmentStatus((previous) => ({ ...previous, [activeId]: {
      error: multiple ? "Choose one file at a time, or use an album for supported attachments." : "This file type cannot be attached here.",
    } }));
  }

  async function sendParts() {
    const id = activeId;
    if (!live || !canSplitText || !longDraft || replyDeleted || formatting.editingLink || longDraftRecord.getSnapshot()[id]
      || sending.current.has(id) || preparingAttachments.current.has(id) || archivePicker.current?.isPreparing()) return;
    const scope = splitScope.current;
    sending.current.add(id);
    setLongDraftDelivery((previous) => ({ ...previous, [id]: "sending" }));
    setUploadRejections((previous) => ({ ...previous, [id]: undefined }));
    setSendStatus((previous) => ({ ...previous, [id]: undefined }));
    let uncertain = true;
    try {
      const result = await sendSplitDraft(draft, formatting.captionFormat, () => scope === splitScope.current,
        (part, style, first) => live.sendText(id, part, first ? replyTarget?.id : undefined, {
          ...style, ...linkPreviewDelivery(previewPlacement, part),
          ...(permissions?.postingSenderKey && { expectedPostingSender: permissions.postingSenderKey }),
          ...(first && externalReply && { externalReplyChatId: externalReply.chatId }),
          ...(first && replyTarget?.selectedQuote && { quote: replyTarget.selectedQuote }),
        }), (message) => setSent((previous) => ({ ...previous, [id]: [...(previous[id] ?? []), message] })));
      if (result.sentAny) {
        formatting.restore({ ...result.format, links: result.format.links ?? [], text: result.remaining });
        setDrafts((previous) => previous[id] === draft ? { ...previous, [id]: result.remaining } : previous);
        setReplyTargets((previous) => previous[id] === replyTarget ? { ...previous, [id]: undefined } : previous);
      }
      uncertain = result.status === "unknown";
      setSendStatus((previous) => ({ ...previous, [id]: result.status }));
    } finally {
      sending.current.delete(id);
      setLongDraftDelivery((previous) => ({ ...previous, [id]: uncertain ? "unknown" : undefined }));
    }
  }

  async function sendLive(live: Live, id: string, text: string, replyTo?: string, attachment?: DraftAttachment, paidStars?: number, textFileSource?: string) {
    const photoReply = attachment?.kind === "photo" ? photoAttachmentReply(attachment, replyTarget) : undefined;
    if (photoReply === false) {
      setAttachmentStatus((previous) => ({ ...previous, [id]: { error: "Select the original photo as the reply, or remove the drawing." } }));
      return;
    }
    const attachmentOptions = attachmentDelivery(attachment?.delivery);
    if (attachmentOptions?.whenOnline && (!onlineAttachmentAllowed || paidStars)) return;
    const captionFormat = textFileSource === undefined ? formatting.captionFormat : undefined;
    const mediaOptions = captionFormat ? { ...attachment?.options, captionFormat } : attachment?.options;
    if ((externalReply && paidStars) || (paidStars && attachment?.options?.videoEdit) || sending.current.has(id) || longDraftRecord.getSnapshot()[id] || attachmentOptions === null || (paidStars && attachmentOptions?.at)) return;
    const effect = attachment?.kind !== "document" ? selectedMessageEffect : undefined;
    const delivery = attachment && (paidStars || effect)
      ? { ...attachmentOptions, ...(paidStars ? { paidStars } : {}), ...(effect ? { effect: effect.id } : {}) }
      : attachmentOptions;
    const scheduled = delivery?.at !== undefined || delivery?.whenOnline;
    const animateSent = !attachment && !paidStars && !scheduled && !overlayOpen && !selectedHistory?.page?.after
      ? captureSendMotion(draftInput.current, history.current) : undefined;
    sending.current.add(id);
    if (textFileSource !== undefined) setLongDraftDelivery((previous) => ({ ...previous, [id]: "sending" }));
    setUploadRejections((previous) => ({ ...previous, [id]: undefined }));
    setSendStatus((previous) => ({ ...previous, [id]: "pending" }));
    let result: SendResult | { state: "cancelled" };
    try {
      if (attachment?.kind === "photo" && live.sendPhoto) {
        const photoArgs: [options?: AttachmentSendOptions, delivery?: AttachmentSendDelivery] = delivery
          ? [mediaOptions, delivery] : mediaOptions ? [mediaOptions] : [];
        let data: string;
        try { data = "data" in attachment ? attachment.data : await preparePhoto(attachment.file); }
        catch {
          setAttachmentStatus((previous) => ({ ...previous, [id]: { error: "Could not prepare this photo." } }));
          setSendStatus((previous) => ({ ...previous, [id]: undefined }));
          sending.current.delete(id);
          return;
        }
        result = await live.sendPhoto(id, text, data, undefined, photoReply, ...photoArgs);
      }
      else if (attachment && attachment.kind !== "photo" && live.sendDocument) {
        const total = attachment.file.size;
        const control = { controller: new AbortController(), canCancel: true };
        uploadControls.current.set(id, control);
        const progress = (uploaded: number, canCancel = true, telegram?: TelegramUploadProgress) => {
          control.canCancel = canCancel && !control.controller.signal.aborted;
          setUploadProgress((previous) => ({ ...previous, [id]: { uploaded, total, canCancel: control.canCancel, telegram } }));
        };
        progress(0);
        const video = attachment.kind === "video" && mediaOptions?.mediaKind !== "animation" ? true : undefined;
        const videoOptions = videoAttachmentOptions(mediaOptions);
        const videoArgs: [video?: true, options?: DocumentSendOptions, delivery?: AttachmentSendDelivery] = delivery
          ? [video, videoOptions, delivery] : videoOptions ? [video, videoOptions] : video ? [video] : [];
        result = await live.sendDocument(id, attachment.file, text, progress, control.controller.signal, undefined, attachmentReply(replyTarget), ...videoArgs);
      }
      else if (attachment) result = { state: "failed" };
      else if (effect || externalReply || paidStars || previewPlacement || sendStyles.length || sendLinks.length || sendEmoji.length || replyTarget?.selectedQuote || permissions?.postingSenderKey) result = await live.sendText(id, text, replyTo, {
        ...(effect ? { effect: effect.id } : {}),
        ...(permissions?.postingSenderKey ? { expectedPostingSender: permissions.postingSenderKey } : {}),
        ...(paidStars ? { paidStars } : {}),
        ...(externalReply ? { externalReplyChatId: externalReply.chatId } : {}),
        ...linkPreviewDelivery(previewPlacement, text), ...(sendStyles.length ? { styles: sendStyles } : {}), ...(sendLinks.length ? { links: sendLinks } : {}),
        ...(sendEmoji.length ? { customEmoji: sendEmoji } : {}),
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
      if (effect) setDraftEffects((previous) => previous[id] === effect ? { ...previous, [id]: undefined } : previous);
      if (!attachment || textFileSource !== undefined) setLinkPreviews((previous) => ({ ...previous, [id]: undefined }));
      formatting.clearSent(id, textFileSource ?? text, textFileSource !== undefined);
      if (attachment) setAttachments((previous) => previous[id] === attachment ? { ...previous, [id]: undefined } : previous);
      setReplyTargets((previous) => previous[id]?.id === replyTo ? { ...previous, [id]: undefined } : previous);
      if (!scheduled) setSent((previous) => ({ ...previous, [id]: [...(previous[id] ?? []), message] }));
      animateSent?.(message);
      setDrafts((previous) => (textFileSource === undefined ? previous[id]?.trim() === text : previous[id] === textFileSource)
        ? { ...previous, [id]: "" } : previous);
      setSendStatus((previous) => {
        const next = { ...previous };
        if (scheduled) next[id] = "scheduled";
        else delete next[id];
        return next;
      });
    } else {
      const state = result.state;
      if (state === "failed" && result.uploadRejection) setUploadRejections((previous) => ({ ...previous, [id]: result.uploadRejection }));
      setSendStatus((previous) => ({ ...previous, [id]: state }));
    }
    if (textFileSource !== undefined) setLongDraftDelivery((previous) => ({
      ...previous, [id]: result.state === "unknown" ? "unknown" : undefined,
    }));
  }

  const messageNotification = live?.messageNotification;
  const notificationChat = messageNotification && live?.chats.find(({ id }) => id === messageNotification.chatId);
  function openNotification(notice: MessageNotification, chat: Chat, dismiss = true) {
    if (notice.pendingMessage) return;
    openConversation(chat);
    if (live?.loadMessageContext) setSearchView({
      chatId: chat.id, messageId: notice.messageId, topicId: notice.topicId,
    });
    if (dismiss) live?.dismissMessageNotification?.(notice.key);
  }
  const desktopNoticeOpen = useRef<(notice: MessageNotification, resolved?: Chat) => void>(undefined);
  useLayoutEffect(() => {
    desktopNoticeOpen.current = (notice, resolved) => {
      const known = resolved ?? live?.chats.find(({ id }) => id === notice.chatId);
      if (known) {
        openNotification(notice, known);
      }
      live?.completeDesktopNotice?.();
    };
  });
  const desktopTarget = live?.desktopNoticeTarget;
  const loadDesktopTarget = live?.loadNotificationChat;
  useEffect(() => {
    if (!desktopTarget) return;
    if (!loadDesktopTarget) {
      desktopNoticeOpen.current?.(desktopTarget);
      return;
    }
    let cancelled = false;
    void loadDesktopTarget(desktopTarget.chatId).then((chat) => {
      if (!cancelled) desktopNoticeOpen.current?.(desktopTarget, chat?.id === desktopTarget.chatId ? chat : undefined);
    }, () => { if (!cancelled) desktopNoticeOpen.current?.(desktopTarget); });
    return () => { cancelled = true; };
  }, [desktopTarget, loadDesktopTarget]);
  const loadSharedContact = live?.loadSharedContact;
  const [linkedGift, setLinkedGift] = useState<LinkedCollectibleGift>();
  const [linkedArticle, setLinkedArticle] = useState<{
    url: string; opener?: HTMLButtonElement; resumed?: ReturnType<typeof resumeInstantView>;
  }>();
  const openMessageArticle = useCallback((url: string, opener: HTMLButtonElement) => setLinkedArticle({ url, opener }), []);
  const loadInstantView = live?.loadInstantView;
  useLayoutEffect(() => {
    const resumed = resumeInstantView(connectionScope);
    const first = resumed?.pages[0];
    if (first) setLinkedArticle((current) => current ?? { url: first.url, resumed });
  }, [connectionScope]);
  const [managedBotReview, setManagedBotReview] = useState<ManagedBotReview>();
  const [storyAlbum, setStoryAlbum] = useState<LinkedStoryAlbum>();
  const [messageStory, setMessageStory] = useState<{ id: string; story: number }>();
  const { open: openMiniApp, dialog: miniAppWindows } = useMiniAppWindows();
  const [replyPicker, setReplyPicker] = useState<Pick<ReplyChatPicker, "find" | "findTopics" | "prepare">>();
  const applyExternalReply = useRef<(chat: Chat, topic: ForumTopic | undefined, reply: ComposerReply) => boolean>(undefined);
  useLayoutEffect(() => {
    applyExternalReply.current = (chat, topic, reply) => {
      if (topic) {
        if (!live?.sendTopicText || !loadForumTopics || !loadTopicHistory || topic.closed) return false;
        const record = forumDrafts.forum(chat.id).replies;
        if (record.getSnapshot()[topic.id]) return false;
        record.update((previous) => ({ ...previous, [topic.id]: reply }));
        switchList("main");
        openConversation(chat, false);
        setForumView({ chatId: chat.id, topic, focusReply: topic.id });
      } else {
        if (replyTargets[chat.id] || editing?.chat === chat.id || sendStatus[chat.id] === "pending" || longDraftRecord.getSnapshot()[chat.id]) return false;
        setReplyTargets((previous) => ({ ...previous, [chat.id]: reply }));
        switchList("main");
        openConversation(chat, false);
        setFocusReplyChat(chat.id);
      }
      return true;
    };
  });
  useLayoutEffect(() => {
    if (focusReplyChat !== activeId || replyPicker || overlayOpen || (!canSendText && !canAttachPhoto) || !draftInput.current) return;
    draftInput.current.focus();
    setFocusReplyChat(undefined);
  }, [activeId, canSendText, canAttachPhoto, focusReplyChat, overlayOpen, replyPicker]);

  function openReplyPicker(message: ComposerReply, topicId = message.forumTopicId) {
    const actions = live?.externalReplyDraft;
    if (!actions || !activeId || message.origin || message.retained || message.pendingDelivery || message.failedDelivery) return;
    const scope = generation.current;
    const source = { id: activeId, messageId: message.id, sourceTopicId: topicId, quote: message.selectedQuote };
    setReplyPicker({
      find: async (query) => (await actions.find(query))
        .filter((chat) => chat.id !== source.id || chat.forum === true && topicId !== undefined),
      findTopics: async (chat, query, cursor) => {
        const page = await actions.topics(chat, query, cursor);
        return page && { ...page, topics: page.topics.filter((topic) => chat.id !== source.id || topic.id !== topicId) };
      },
      prepare: async (chat, signal, topic) => {
        const reviewed = await actions.review(source, chat, topic);
        if (!reviewed || signal.aborted || generation.current !== scope
          || (topicsOpen && activeForumTopic.current?.id !== topicId)
          || reviewed.chat.id !== chat.id || reviewed.chat.name !== chat.name
          || reviewed.topic?.id !== topic?.id || reviewed.topic?.name !== topic?.name) return false;
        return applyExternalReply.current?.(reviewed.chat, reviewed.topic, {
          ...message, origin: { chatId: source.id, topicId },
        }) ?? false;
      },
    });
  }
  const [attachmentChatPicker, setAttachmentChatPicker] = useState<Pick<ComponentProps<typeof TelegramChatPickerDialog>, "find" | "prepare"> & { request: number }>();
  const [wallpaperLink, setWallpaperLink] = useState<{ link: string; request: number; chat?: Chat }>();
  const wallpaperActions = live?.chatBackgroundActions;
  const canOpenWallpaper = !!(wallpaperActions?.previewLink && wallpaperActions.saveLink);
  function openWallpaperLink(value: string, request: number, preferActive: boolean) {
    const link = canOpenWallpaper && canonicalTelegramWallpaperLink(value);
    if (!link) return false;
    const chat = preferActive && showConversation && chatList !== "saved" && active?.subtitle === "Direct message" ? active : undefined;
    setWallpaperLink({ link, request, chat });
    return true;
  }
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  const sideMenu = live?.sideMenuMiniApps;
  const canUseInlineBotDraft = !!live?.inlineBotActions && canSendText && !overlayOpen && !edit && !attachment
    && !sendingDraft;
  const latestInlineDraft = useRef<(chatId: string, username: string, query?: string, reviewed?: boolean) => boolean>(undefined);
  const latestOtherInlineDraft = useRef<(chat: Chat, username: string, query: string, topic?: ForumTopic) => boolean>(undefined);
  useLayoutEffect(() => {
    latestInlineDraft.current = canUseInlineBotDraft ? (chatId, username, query, reviewed) => {
      const text = chatId === activeId ? draftWithInlineBot(draft, username, query, reviewed, inlineDraftConfirmation) : undefined;
      if (text === undefined) return false;
      changeDraft(text);
      if (reviewed) requestAnimationFrame(() => draftInput.current?.focus());
      else draftInput.current?.focus();
      return true;
    } : undefined;
    latestOtherInlineDraft.current = (chat, username, query, topic) => {
      if (topic) {
        if (!live?.inlineBotActions || !live.sendTopicText || !loadForumTopics || !loadTopicHistory || topic.closed
          || !draftWithInlineBot("", username, query)) return false;
        const alreadyOpen = chat.id === activeId && topicsOpen && activeForumTopic.current?.id === topic.id;
        if (chat.id !== activeId || !topicsOpen) openConversation(chat, false);
        setForumView((previous) => ({ chatId: chat.id, topic,
          revision: (previous?.revision ?? 0) + (alreadyOpen ? 0 : 1), inlineDraft: { topicId: topic.id, username, query } }));
        return true;
      }
      if (attachments[chat.id] || editing?.chat === chat.id || sendStatus[chat.id] === "pending" || longDraftRecord.getSnapshot()[chat.id]) return false;
      const text = draftWithInlineBot(drafts[chat.id] ?? "", username, query, false, inlineDraftConfirmation);
      if (text === undefined) return false;
      if (chat.id === activeId) changeDraft(text);
      else setDrafts((previous) => ({ ...previous, [chat.id]: text }));
      openConversation(chat);
      requestAnimationFrame(() => draftInput.current?.focus());
      return true;
    };
  });
  const useInlineDraft = useCallback((chatId: string, username: string, query?: string, reviewed?: boolean) =>
    latestInlineDraft.current?.(chatId, username, query, reviewed) ?? false, []);
  const useOtherInlineDraft = useCallback((chat: Chat, username: string, query: string, topic?: ForumTopic) =>
    latestOtherInlineDraft.current?.(chat, username, query, topic) ?? false, []);
  const mainFolderPosition = live?.mainFolderPosition ?? 0;
  function renderFolders(folders: TelegramFolder[]) {
    if (!live || !folders.length) return null;
    return <FolderNavigation folders={folders} selected={live.list} select={switchList} unreadBadges={live.unreadBadges}
      drop={live.folderActions && {
        target: folderDropTarget, canDrop: (id) => id !== live.list && !!draggedChat.current && !pendingFolderDrop.current,
        highlight: setFolderDropTarget, add: (id) => void addDraggedChat(id),
      }} />;
  }
  async function openReactionProfile(id: string, target: ReactionPersonReference, signal: AbortSignal, load: () => Promise<Chat | null>) {
    if (signal.aborted || activeId !== id) return false;
    const request = ++openingTelegramLink.current;
    const scope = generation.current;
    const chat = await load();
    if (signal.aborted || scope !== generation.current || request !== openingTelegramLink.current || chat?.id !== target.sender.id
      || (target.sender.kind === "user" ? chat.subtitle !== "Direct message" : chat.subtitle !== "Channel" && chat.subtitle !== "Group")) return false;
    switchList("main");
    openLinkedDetails(chat, "profile");
    return true;
  }

  const objectMenu = useObjectContextMenu(activeId);
  const conversationSearch = searching && <ConversationSearch key={`${activeId}:${searchView?.messageId ?? searchView?.day ?? searchView?.filter ?? searchView?.author?.sender.id ?? "search"}:${searchView?.revision ?? 0}:${searchView?.searchQuery ?? ""}`} chatId={activeId}
            sharedLibrary={searchView?.sharedLibrary} loadLibraryCounts={live?.loadSharedContentCounts}
            previewInvite={previewInvite} previewWebLink={live?.previewWebLink}
            initialReplyPlayback={searchView?.replyPlayback} initialQuote={searchView?.quote} drawPhotoReply={drawFromShared}
            copySelectedText={live?.copySelectedText}
            loadGroupEmoji={active?.subtitle === "Group" ? live?.loadGroupEmoji : undefined}
            chat={active} loadAvatar={live?.loadAvatar} initialMessage={searchView?.messageId} initialSearchQuery={searchView?.searchQuery} mediaTimestamp={searchView?.mediaTimestamp} checklistTaskId={searchView?.checklistTaskId} pollOptionId={searchView?.pollOptionId} initialDay={searchView?.day} initialFilter={searchView?.filter} initialAuthor={searchView?.author} topicId={searchView?.topicId} search={live?.searchMessages} loadMessageLink={live?.loadMessageLink} loadAtDate={live?.loadMessageAtDate} loadContext={live?.loadMessageContext} loadContextPage={live?.loadMessageContextPage} markActivityRead={live?.markActivityRead} bulkUnpin={chatList !== "saved" && !topics?.length ? live?.bulkUnpin : undefined}
            pinning={live?.pinStatus && live.setMessagePinned ? { pinStatus: live.pinStatus, setMessagePinned: live.setMessagePinned } : undefined} loadPhoto={live?.loadPhoto} loadMedia={live?.loadMedia} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} saveDocument={live?.saveDocument}
            mediaCollection={live?.mediaCollection} saveSelectedAttachments={live?.saveSelectedAttachments} messageViewers={live?.messageViewers} chatReportActions={chatList === "saved" ? undefined : live?.chatReportActions} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} deletedIds={deletedIds}
            backLabel={searchView?.returnToGlobalResult ? tr("Back to search results")
              : searchView?.returnToReference?.label ?? (searchView?.returnToSavedSource ? tr("Back to saved source")
                : containingTopic ? tr("Open containing topic") : undefined)}
            openContainingTopic={searchView?.returnToGlobalResult && containingTopic ? () => {
              setSearchView(undefined);
              setForumView({ chatId: activeId, topic: containingTopic });
            } : undefined} close={() => {
              if (searchView?.returnToGlobalResult) {
                backToGlobalResults(searchView.returnToGlobalResult);
                return;
              }
              const previous = searchView?.returnToReference;
              if (previous) {
                openConversation(previous.chat);
                setSearchView({ chatId: previous.chat.id, messageId: previous.messageId, topicId: previous.topicId, returnToTopic: previous.topic });
              } else {
                setSearchView(undefined);
                if (containingTopic) setForumView({ chatId: activeId, topic: containingTopic });
                else if (!searchView?.returnToSavedSource) {
                  if (sharedLibraryOpen) scheduleConversationFocus();
                  else heading.current?.focus();
                }
              }
            }} />;

  const settings = typeof live?.settings === "function" ? live.settings(openConversation, live.loadMessageContext && ((chat, messageId, topicId) => {
    openConversation(chat);
    setSearchView({ chatId: chat.id, messageId, topicId });
  }), live.folderActions && (() => folderSettings.current?.open())) : live?.settings;
  const foldersPanel = live?.folderActions && <FolderSettings hideTrigger={settingsView} controller={folderSettings} folders={live.folders} mainPosition={live.mainFolderPosition} actions={live.folderActions} />;

  if (settingsView) return <div lang={uiLocale} data-bb-ru-skip className="mtg">
    {settings}
    {foldersPanel}
  </div>;

  return (
    <InstalledEmojiPacks.Provider value={live?.installedEmoji}>
    <OpenTelegramMessageLink.Provider value={resolveMessageLink || loadLinkedStickerPack || previewInvite || previewFolderInvite || resolveStoryLink || resolveStoryAlbumLink || resolveBotStartLink || resolveTemporaryContact || resolveBusinessChat || findChats || live?.launchMiniApp || live?.attachmentMiniAppLinks || resolveBoostLink || live?.resolveCollectibleGift || managedBotLinks || gameLinks || loadInstantView || canOpenWallpaper ? async (url, signal, options) => {
      const request = ++openingTelegramLink.current;
      if (signal.aborted) return false;
      if (openWallpaperLink(url, request, true)) return true;
      const article = loadInstantView && telegramInstantViewLink(url);
      if (article) {
        setLinkedArticle({ url: article.link });
        return true;
      }
      const attachmentLink = attachmentMiniAppLinkReference(url);
      const attachmentLinks = live?.attachmentMiniAppLinks;
      if (attachmentLink && attachmentLinks) {
        const launchReviewed = (chat: Chat, review: AttachmentMiniAppReview, topic?: ForumTopicTarget) => {
          openMiniApp({ target: { label: review.label }, attachmentReview: review,
            attachmentDestination: { chat: chat.name, topic: topic?.name },
            launch: (_, consent) => consent ? attachmentLinks.launch(attachmentLink.url, chat.id, review, consent, topic) : Promise.resolve(null) });
        };
        if (attachmentLink.destination) {
          const result = await attachmentLinks.destination?.(attachmentLink.url);
          if (!result || signal.aborted || request !== openingTelegramLink.current) return false;
          switchList("main");
          openConversation(result.chat);
          launchReviewed(result.chat, result.review);
          return true;
        }
        if (attachmentLink.types.length) {
          const list = attachmentLinks.chats;
          if (!list) return false;
          setAttachmentChatPicker({ request, find: (query) => list(attachmentLink.url, query), prepare: async (chat, cancelled) => {
            const review = await attachmentLinks.preview(attachmentLink.url, chat.id);
            if (!review || cancelled.aborted || request !== openingTelegramLink.current) return false;
            switchList("main");
            openConversation(chat);
            launchReviewed(chat, review);
            return true;
          } });
          return true;
        }
        const topic = topicsOpen ? activeForumTopic.current : undefined;
        if (!active || !showConversation || (topicsOpen && !topic) || topic?.closed) return false;
        const scope = generation.current;
        const id = active.id;
        const review = await attachmentLinks.preview(attachmentLink.url, id, topic);
        if (!review || signal.aborted || scope !== generation.current || request !== openingTelegramLink.current
          || (topicsOpen && topic !== activeForumTopic.current)) return false;
        launchReviewed(active, review, topic);
        return true;
      }
      const temporaryContact = resolveTemporaryContact && telegramTemporaryContactLink(url);
      if (temporaryContact) return openTemporaryProfile(temporaryContact.url, request, () => !signal.aborted);
      const businessChat = resolveBusinessChat && telegramBusinessChatLink(url);
      if (businessChat) return openBusinessConversation(businessChat, request, () => !signal.aborted);
      const managedBotUrl = managedBotLinks && canonicalTelegramManagedBotLink(url);
      if (managedBotUrl && managedBotLinks) {
        const review = await managedBotLinks.preview(managedBotUrl);
        if (!review || signal.aborted || request !== openingTelegramLink.current) return false;
        setManagedBotReview(review);
        return true;
      }
      const share = live && telegramShareDraft(url);
      if (share) {
        chooseShareDestination(share);
        return true;
      }
      const giftUrl = canonicalTelegramGiftLink(url);
      if (giftUrl && live?.resolveCollectibleGift) {
        const scope = generation.current;
        const gift = await live.resolveCollectibleGift(giftUrl);
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || !gift) return false;
        setLinkedGift(gift);
        return true;
      }
      const launchApp = live?.launchMiniApp;
      const app = launchApp && miniAppLinkReference(url);
      if (app && launchApp) {
        openMiniApp({ target: app, launch: launchApp });
        return true;
      }
      if ((loadLinkedStickerPack && telegramStickerPackReference(url))
        || (previewInvite && isTelegramInviteLink(url))
        || (previewFolderInvite && isTelegramFolderInviteLink(url))
        || (resolveBotStartLink && parseTelegramBotStartLink(url)) || (gameLinks && telegramGameLink(url))) {
        switchList("main");
        setSearchMode("chats");
        setKind("all");
        setUnreadOnly(false);
        closeConversation();
        if (options?.refreshStickerPack && telegramStickerPackReference(url)) {
          setResults(undefined);
          setSearchQuery({ text: url, refreshStickerPack: true });
        } else setQuery(url);
        return true;
      }
      const scope = generation.current;
      const boostUrl = canonicalTelegramBoostLink(url);
      if (boostUrl && resolveBoostLink) {
        const chat = await resolveBoostLink(boostUrl);
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || !chat) return false;
        openLinkedDetails(chat, "boost");
        return true;
      }
      if (resolveStoryAlbumLink && canonicalTelegramStoryAlbumLink(url)) {
        const album = await resolveStoryAlbumLink(url);
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || !album) return false;
        setStoryAlbum(album);
        return true;
      }
      if (resolveStoryLink && live?.storyActions && parseTelegramStoryLink(url)) {
        const story = await resolveStoryLink(url);
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || !story) return false;
        setMessageStory(story);
        return true;
      }
      const destination = findChats && telegramPublicChatLink(url);
      if (destination && findChats) {
        const chats = await findChats(destination.chatUrl, "main");
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || chats.length !== 1) return false;
        switchList("main");
        openPublicLink(chats[0]!, destination);
        return true;
      }
      if (findChats && canonicalTelegramPublicChatLink(url)) {
        const chats = await findChats(url, "main");
        if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || chats.length !== 1) return false;
        openConversation(chats[0]!);
        return true;
      }
      const linked = await resolveMessageLink?.(url);
      if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current || !linked) return false;
      return openLinkedMessage(linked);
    } : undefined}>
    <UseInlineBotDraft.Provider value={canUseInlineBotDraft ? useInlineDraft : undefined}>
    <UseInlineBotInOtherChat.Provider value={useOtherInlineDraft}>
    <InstantViewShare.Provider value={live ? (url) => chooseShareDestination({ url }) : undefined}>
    <InstantViewTagSearch.Provider value={live?.globalSearch ? (tag) => {
      switchList("main");
      backToChats();
      setQuery(tag);
      setSearchMode("public");
      requestAnimationFrame(() => chatSearch.current?.focus());
    } : undefined}>
    <InstantViewMentionOpen.Provider value={live?.loadInstantViewMention ? async (url, userId, signal) => {
      if (signal.aborted) return false;
      const request = ++openingTelegramLink.current;
      const scope = generation.current;
      const chat = await live.loadInstantViewMention!(url, userId);
      if (signal.aborted || scope !== generation.current || request !== openingTelegramLink.current
        || chat?.id !== String(userId) || chat.subtitle !== "Direct message") return false;
      switchList("main");
      openLinkedDetails(chat, "profile");
      return true;
    } : undefined}>
    <OpenInlineBotProfile.Provider value={live?.loadInlineBotProfile ? async (id, messageId, button, signal) => {
      if (signal.aborted) return false;
      const request = ++openingTelegramLink.current;
      const scope = generation.current;
      const chat = await live.loadInlineBotProfile!(id, messageId, button);
      if (signal.aborted || scope !== generation.current || request !== openingTelegramLink.current
        || chat?.id !== String(button.userId) || chat.subtitle !== "Direct message") return false;
      switchList("main");
      openLinkedDetails(chat, "profile");
      return true;
    } : undefined}>
    <OpenReactionPerson.Provider value={live?.loadReactionPerson ? (id, messageId, target, signal) =>
      openReactionProfile(id, target, signal, () => live.loadReactionPerson!(id, messageId, target)) : undefined}>
    <OpenMessageStory.Provider value={live?.storyActions ? setMessageStory : undefined}>
    <OpenForwardedPost.Provider value={loadForwardedChat && live?.loadMessageContext
      ? async (source, from, signal) => {
        const [chat, previousChat] = await Promise.all([
          loadForwardedChat(source.chatId),
          active?.id === from.chatId ? active : loadForwardedChat(from.chatId).catch(() => null),
        ]);
        if (signal.aborted || chat?.id !== source.chatId || chat.subtitle !== "Channel") return false;
        openConversation(chat);
        setSearchView({ chatId: chat.id, messageId: source.messageId,
          returnToReference: previousChat?.id === from.chatId
            ? { chat: previousChat, messageId: from.messageId, topicId: from.topicId, label: "Back to forwarded message" } : undefined });
        return true;
      } : undefined}>
    <OpenExternalReply.Provider value={live?.externalReplySource && live.loadMessageContext ? async (expected, from, signal, playbackTime) => {
      const source = live.externalReplySource;
      if (!source || signal.aborted || active?.id !== from.chatId) return false;
      const request = ++openingTelegramLink.current;
      const scope = generation.current;
      const linked = await source(from.chatId, from.messageId);
      if (signal.aborted || scope !== generation.current || request !== openingTelegramLink.current || !linked || !("messageId" in linked)
        || (linked.chat.id === from.chatId && linked.topicId === from.topicId)
        || linked.chat.id !== expected.chatId || linked.messageId !== expected.messageId || !openLinkedMessage(linked)) return false;
      const topic = topicsOpen && activeForumTopic.current?.id === from.topicId ? activeForumTopic.current : undefined;
      setSearchView((previous) => previous && { ...previous, quote: expected.quote, replyPlayback: playbackTime === undefined ? undefined : { time: playbackTime },
        returnToReference: { chat: active, messageId: from.messageId, topicId: from.topicId, topic, label: "Back to reply" } });
      return true;
    } : undefined}>
    <OpenSharedContact.Provider value={loadSharedContact ? async (chatId, messageId, userId, signal) => {
      const chat = await loadSharedContact(chatId, messageId, userId);
      if (signal.aborted) return;
      if (chat.subtitle !== "Direct message") throw new Error("Telegram returned an unexpected conversation.");
      openConversation(chat);
    } : undefined}>
    <InstantViewLoader.Provider value={live?.loadInstantView}><InstantViewDocumentSaver.Provider value={live?.saveInstantViewDocument}><InstantViewMapLoader.Provider value={live?.loadInstantViewMap}><InstantViewPhotoLoader.Provider value={live?.loadInstantViewPhoto}><InstantViewIconLoader.Provider value={live?.loadInstantViewIcon}><InstantViewPlaybackLoader.Provider value={live?.loadInstantViewPlayback}><TranslationDefault.Provider value={translationDefault}><TranslateMessageService.Provider value={live?.translateMessage}><LocationMapLoader.Provider value={live?.loadLocationMap}><PlaybackHistoryProvider><MusicPlaybackProvider><div lang={uiLocale} data-bb-ru-skip className="mtg"
      onContextMenu={objectMenu.onContextMenu}
      onClickCapture={() => { navigationEdited.current = true; }}
      onChangeCapture={() => { navigationEdited.current = true; }}
      onKeyDown={(event) => {
      if (contextMenuKey(event)) { objectMenu.onKeyDown(event); return; }
      const target = event.target;
      if (!live || shortcutsFrom || event.key !== "?" || event.defaultPrevented || event.repeat
        || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
        || !(target instanceof HTMLElement) || !event.currentTarget.contains(target)
        || target.closest("input, textarea, select, [contenteditable], dialog, [role=dialog], audio, video")) return;
      event.preventDefault();
      setShortcutsFrom(target);
    }}>
      {shortcutsFrom && <KeyboardShortcutsDialog close={() => {
        setShortcutsFrom(undefined);
        if (shortcutsFrom.isConnected) shortcutsFrom.focus({ preventScroll: true });
      }} />}
      <OpenMiniApp.Provider value={openMiniApp}>
      <OpenInstantView.Provider value={openMessageArticle}>
      {linkedArticle && loadInstantView && <InstantViewDialog key={linkedArticle.url} url={linkedArticle.url} load={loadInstantView}
        continuityScope={connectionScope} resumed={linkedArticle.resumed}
        close={() => {
          setLinkedArticle((current) => current === linkedArticle ? undefined : current);
          const opener = linkedArticle.opener;
          if (opener) scheduleNavigationFocus(() => opener.isConnected ? opener : heading.current ?? listHeading.current ?? undefined, true);
        }} />}
      {sideMenuOpen && sideMenu && <SideMenuMiniAppPicker list={sideMenu.list} manage={sideMenu.manage} close={() => setSideMenuOpen(false)} choose={(app) => {
        setSideMenuOpen(false);
        openMiniApp({ target: { label: app.label }, entryPoint: ["side-menu", app.botId], attachmentReview: app,
          launch: (_, consent) => sideMenu.launch(app, consent?.acceptedTerms === true) });
      }} />}
      {replyPicker && <TelegramChatPickerDialog find={replyPicker.find} findTopics={replyPicker.findTopics}
        title={tr("Choose where to reply")} unavailableText={tr("This reply is unavailable in the selected conversation. An existing reply draft may already be open there.")}
        prepare={replyPicker.prepare} close={() => setReplyPicker(undefined)} />}
      {attachmentChatPicker && <TelegramChatPickerDialog key={attachmentChatPicker.request} find={attachmentChatPicker.find}
        title={tr("Choose a chat for the Mini App")} unavailableText={tr("This Mini App could not open in that chat.")}
        prepare={attachmentChatPicker.prepare} close={() => setAttachmentChatPicker((current) => current === attachmentChatPicker ? undefined : current)} />}
      {wallpaperLink && wallpaperActions && (wallpaperLink.chat
        ? <LinkedWallpaperDialog key={wallpaperLink.request} id={wallpaperLink.chat.id} name={wallpaperLink.chat.name}
          link={wallpaperLink.link} actions={wallpaperActions}
          chooseChat={() => setWallpaperLink((current) => current === wallpaperLink ? { ...current, chat: undefined } : current)}
          close={() => setWallpaperLink((current) => current === wallpaperLink ? undefined : current)} />
        : <TelegramChatPickerDialog title={tr("Choose a private chat for the wallpaper")}
          unavailableText={tr("Wallpaper settings are unavailable for this chat.")}
          find={async (query) => (query && findChats ? await findChats(query, "main") : live?.chats ?? [])
            .filter(({ subtitle }) => subtitle === "Direct message")}
          prepare={async (chat, signal) => {
            if (signal.aborted || chat.subtitle !== "Direct message") return false;
            setWallpaperLink((current) => current === wallpaperLink ? { ...current, chat } : current);
            return true;
          }}
          close={() => setWallpaperLink((current) => current === wallpaperLink ? undefined : current)} />)}
      {miniAppWindows}
      {previewChat && live && <ChatPreview key={previewChat.id} chat={previewChat} load={live.loadHistory}
        loadPhoto={live.loadPhoto} close={() => setPreviewChat(undefined)} open={() => {
          setPreviewChat(undefined);
          openConversation(previewChat);
        }} />}
      {linkedGift && <CollectibleGiftDialog key={linkedGift.slug} gift={linkedGift} close={() => setLinkedGift(undefined)} />}
      {managedBotReview && managedBotLinks && <LinkedManagedBotDialog key={managedBotReview.confirmation} review={managedBotReview}
        create={managedBotLinks.create} close={() => setManagedBotReview(undefined)} />}
      {storyAlbum && live?.storyActions && <StoryAlbumDialog key={`${storyAlbum.chatId}:${storyAlbum.album.id}`}
        target={storyAlbum} actions={live.storyActions} close={() => setStoryAlbum(undefined)} />}
      {messageStory && live?.storyActions && <MessageStoryDialog key={`${messageStory.id}:${messageStory.story}`}
        target={messageStory} actions={live.storyActions} close={() => setMessageStory(undefined)} />}
      <div className="mtg-notification-stack">
        {privateCall?.call && <PrivateCallBanner key={privateCall.call.id ?? "starting"} call={privateCall.call} act={privateCall.act} frameRoute={privateCall.frameRoute} />}
        {live?.deviceSignIns && live.deviceSignIns.count > 0 && <aside className="mtg-message-notification" aria-label={tr("New Telegram sign-ins")}>
          <div role="status">{live.deviceSignIns.count === 1 ? tr("A Telegram sign-in is awaiting confirmation.")
            : tr("{0} Telegram sign-ins are awaiting confirmation.", [live.deviceSignIns.count])}</div>
          <button type="button" className="mtg-action" onClick={live.deviceSignIns.review}>{tr("Review devices")}</button>
          <button type="button" className="mtg-action" aria-label={tr("Dismiss sign-in notice")} onClick={live.deviceSignIns.dismiss}>{tr("Dismiss")}</button>
        </aside>}
        {messageNotification && !(showConversation && !overlayOpen && activeId === messageNotification.chatId
          && messageNotification.topicId === undefined && !messageNotification.pendingMessage) &&
          <MessageNotificationBanner key={messageNotification.key} notification={messageNotification} chat={notificationChat}
            load={live?.loadNotificationChat}
            dismiss={live?.dismissMessageNotification && (() => live.dismissMessageNotification?.(messageNotification.key))}
            markRead={markNotificationRead && messageNotification.canMarkRead !== false
              ? () => markNotificationRead(messageNotification) : undefined}
            open={(chat) => openNotification(messageNotification, chat)} />}
      </div>
      {live?.foregroundNotices && <MessageNotificationStack notices={live.foregroundNotices} chats={live.chats}
        load={live.loadNotificationChat} loadAvatar={live.loadAvatar}
        open={(notice, chat) => openNotification(notice, chat, false)} markRead={markNotificationRead} />}
      <MusicPlayerPanel openSource={live?.loadNotificationChat && live.loadMessageContext ? async ({ chatId, messageId, topicId }, signal) => {
        const chat = await live.loadNotificationChat!(chatId);
        if (signal.aborted || !chat || chat.id !== chatId) return false;
        openConversation(chat);
        setSearchView({ chatId, messageId, topicId });
        return true;
      } : undefined} />
      <div className="mtg-layout" data-gallery={sharedLibraryOpen || undefined} data-layout={workspaceActive ? "workspace" : "embedded"} data-conversation={showConversation && !!activeId} onKeyDown={(event) => {
        const target = event.target;
        if (isFindShortcut(event) && (!(target instanceof Element) || !target.closest(".mtg-conversation") || !showConversation)
          && chatSearch.current) {
          event.preventDefault();
          chatSearch.current.focus();
          chatSearch.current.select();
          return;
        }
        if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
          || !(target instanceof HTMLElement)
          || target.closest("input, textarea, select, dialog, [role=dialog], [contenteditable]")) return;
        if (live?.contactActions && isControlPanelShortcut(event, "j", "KeyJ")) {
          event.preventDefault();
          switchList("main");
          closeConversation();
          if (!contactsMode) setQuery("");
          setSearchMode("contacts");
          requestAnimationFrame(() => chatSearch.current?.focus());
          return;
        }
        if (live && isControlPanelShortcut(event, "]")) {
          const row = target.closest<HTMLElement>("[data-chat-preview-id]");
          const chat = row ? visible.find(({ id }) => id === row.dataset.chatPreviewId)
            : showConversation && target.closest(".mtg-conversation") ? active : undefined;
          if (!chat) return;
          event.preventDefault();
          navigationEdited.current = true;
          setPreviewChat(chat);
          return;
        }
        const command = event.ctrlKey !== event.metaKey;
        if (event.shiftKey) {
          if (!live || !command || event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          const folders = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".mtg-rail [data-folder-shortcut], .mtg-rail [data-current-folder-branch]",
          )).filter((button) => !button.closest("[hidden], [inert]"));
          const current = folders.findIndex((button) => button.getAttribute("aria-pressed") === "true" || button.hasAttribute("data-current-folder-branch"));
          const step = event.key === "ArrowUp" ? -1 : 1;
          let next: HTMLButtonElement | undefined = folders[current < 0 ? 0 : current + step];
          if (current >= 0 && folders[current]?.hasAttribute("data-current-folder-branch")) {
            // The hidden selection comes after any selectable folder on the collapsing row.
            const branch = folders[current]?.parentElement;
            const following = folders.slice(current + 1);
            next = step > 0 ? following.find((button) => button.parentElement !== branch)
              : following.filter((button) => button.parentElement === branch).at(-1) ?? next;
          }
          if (!next) return;
          event.preventDefault();
          next.click();
          scheduleNavigationFocus(() => next.isConnected ? next : listHeading.current ?? undefined);
          return;
        }
        if (live && event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "0" || event.key === "9")) {
          event.preventDefault();
          switchList(event.key === "0" ? "saved" : "archive");
          scheduleNavigationFocus(() => listHeading.current ?? undefined);
          return;
        }
        if (live && event.ctrlKey && !event.metaKey && !event.altKey && /^[1-8]$/.test(event.key)) {
          const chat = live.chats.filter(({ pinnedInList }) => pinnedInList)[Number(event.key) - 1];
          if (!chat || live.list === "saved") return;
          event.preventDefault();
          openConversation(chat);
          return;
        }
        const optionOnly = event.altKey && !event.ctrlKey && !event.metaKey;
        const pageShortcut = command && !event.altKey;
        const boundary = command && event.altKey && (event.key === "Home" || event.key === "End");
        const previous = (optionOnly && event.key === "ArrowUp") || (pageShortcut && event.key === "PageUp");
        const following = (optionOnly && event.key === "ArrowDown") || (pageShortcut && event.key === "PageDown");
        if (showRecentSearch || !boundary && !previous && !following) return;
        const rows = Array.from(chatRows.current?.querySelectorAll<HTMLButtonElement>(".mtg-row") ?? []);
        const current = rows.findIndex((row) => row.getAttribute("aria-current") === "true");
        const focused = rows.findIndex((row) => row.contains(target));
        const index = focused >= 0 ? focused : current;
        const next = boundary
          ? rows.at(event.key === "Home" ? 0 : -1)
          : rows[index >= 0 ? index + (previous ? -1 : 1) : previous ? rows.length - 1 : 0];
        if (!next) return;
        event.preventDefault();
        next.scrollIntoView?.({ block: "nearest" });
        next.click();
      }}>
        {renderChatNavigation(workspace?.sidebar, <>
        <nav className="mtg-rail mtg-folder-rail" aria-label={tr("Chat folders")}
          aria-keyshortcuts={live ? "Meta+Shift+ArrowUp Meta+Shift+ArrowDown Control+Shift+ArrowUp Control+Shift+ArrowDown" : undefined}>
          <span className="mtg-avatar mtg-account" aria-label={live ? tr("Telegram account") : tr("Demo account")}>{live ? tr("TG") : tr("AM")}</span>
          {live && renderFolders(live.folders.slice(0, mainFolderPosition))}
          <button type="button" data-folder-shortcut aria-pressed={live ? live.list === "main" : folder === "all"}
            aria-description={mainUnread ? tr("{0} unread", [mainUnread]) : undefined}
            onClick={() => live ? switchList("main") : setFolder("all")}><MessageCircle size={20} /><span className="mtg-rail-label">{tr("All chats")}</span><UnreadListBadge count={mainUnread} /></button>
          {live && <>
            <button type="button" aria-keyshortcuts="Control+9" aria-pressed={live.list === "archive"} aria-description={archiveUnread ? tr("{0} unread", [archiveUnread]) : undefined}
              onClick={() => switchList("archive")}><Archive size={20} /><span className="mtg-rail-label">{tr("Archive")}</span><UnreadListBadge count={archiveUnread} /></button>
            <button type="button" aria-keyshortcuts="Control+0" aria-pressed={live.list === "saved"} onClick={() => switchList("saved")}><Bookmark size={20} /><span className="mtg-rail-label">{tr("Saved")}</span></button>
            {renderFolders(live.folders.slice(mainFolderPosition))}
          </>}
          {folderDropNotice && <span className="mtg-folder-drop-status" role="status">{tr(folderDropNotice)}</span>}
          {live?.storyActions && <Stories actions={live.storyActions} />}
          {sideMenu && <button type="button" aria-label={tr("Sidebar Mini Apps")} aria-haspopup="dialog" onClick={() => setSideMenuOpen(true)}>
            <LayoutGrid size={20} aria-hidden="true" /><span className="mtg-rail-label">{tr("Mini Apps")}</span></button>}
          {live?.communityActions && live.loadNotificationChat &&
            <CommunityBrowser controller={communityBrowser} actions={live.communityActions} loadChat={live.loadNotificationChat} openChat={openConversation}
              changeRevision={live.communityRevision} search={live.globalSearch} loadSearchThumbnail={live.loadGlobalMediaThumbnail}
              openMessage={live.loadMessageContext && (({ chat, message }, searchQuery) => {
                openConversation(chat);
                setSearchView({ chatId: chat.id, messageId: message.id, topicId: message.forumTopicId, searchQuery });
              })} />}
          {foldersPanel}
          {live?.downloads?.(live.loadMessageContext && ((chat, messageId, topicId) => {
            openConversation(chat);
            setSearchView({ chatId: chat.id, messageId, topicId });
          }))}
          {live?.agentAccess}
          {live?.messageNotifications && <MessageNotificationCenter notices={live.messageNotifications} chats={live.chats}
            load={live.loadNotificationChat} openMessage={openNotification} dismiss={live.dismissMessageNotification}
            markRead={markNotificationRead} desktopPermission={live.desktopAlertPermission} requestDesktopPermission={live.requestDesktopAlertPermission} />}
          {settings}
          {!live && <button type="button" aria-pressed={folder === "work"} onClick={() => setFolder("work")}><Folder size={20} />{tr("Work")}</button>}
        </nav>

        <section className="mtg-chats" aria-labelledby={chatListHeadingId} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Control+PageUp Control+PageDown Meta+PageUp Meta+PageDown Control+Alt+Home Control+Alt+End Meta+Alt+Home Meta+Alt+End"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setRecentSearchOpen(false);
          }}
          onKeyDown={(event) => {
            if (!(event.target instanceof Element)) return;
            const search = chatSearch.current;
            const fromSearch = event.target === search;
            if (fromSearch && (query || searchMode !== "chats") && isPlainKey(event, "Escape")) {
              event.preventDefault();
              event.stopPropagation();
              clearChatSearch();
              return;
            }
            if (showRecentSearch && live?.recentChatSearch && isPlainKey(event, "Escape")) {
              event.preventDefault();
              event.stopPropagation();
              search?.focus();
              setRecentSearchOpen(false);
              return;
            }
            const resultSelector = ".mtg-rows:not([hidden]) button:is(.mtg-row, [data-search-action]):enabled";
            if (fromSearch && globalMode && isPlainKey(event, "Enter")) {
              const result = event.currentTarget.querySelector<HTMLButtonElement>(
                ".mtg-rows button:is(.mtg-row, [data-search-submit]):enabled");
              if (result) {
                event.preventDefault();
                result.click();
              }
              return;
            }
            moveListFocus(event, search, resultSelector);
          }}>
          <header>
            <div className="mtg-list-title"><h1 id={chatListHeadingId} ref={listHeading} tabIndex={-1}>{listTitle}</h1>
              {live?.list === "main" && live.createPrivateChat && <CreatePrivateChatDialog create={live.createPrivateChat}
                onCreated={(chat) => {
                  setQuery("");
                  setSearchMode("chats");
                  setKind("all");
                  setUnreadOnly(false);
                  openConversation(chat);
                  live.refresh();
                }} />}
              {live ? <ChatListDisclosure key={chatList} label={tr("Chat list actions")} iconOnly trigger={<Ellipsis size={18} aria-hidden="true" />}>
                {(close) => <>
                  <button type="button" className="mtg-action" onClick={() => { close(); live.refresh(); }} disabled={live.loading}>
                    <RefreshCw size={16} aria-hidden="true" />{tr("Refresh")}
                  </button>
                  {live.folderActions && typeof chatList === "number" && live.folders.some(({ id }) => id === chatList) &&
                    <button type="button" className="mtg-action" aria-haspopup="dialog" onClick={() => {
                      close();
                      folderSettings.current?.open(chatList);
                    }}><FolderCog size={16} aria-hidden="true" />{tr("Edit this folder")}</button>}
                  {live.markChatListRead && live.list !== "saved" && !globalMode && !contactsMode && !discoveryMode &&
                    <MarkChatListRead list={live.list} title={listTitle} mark={live.markChatListRead} />}
                  {canChooseSearchScope && !showSearchScope && <details className="mtg-search-more">
                    <summary>{tr("More search options")}</summary>
                    {live.globalSearch && searchScopeOption(["media", "Media"], close)}
                    {extraSearchScopes.map((option) => searchScopeOption(option, close))}
                  </details>}
                </>}
              </ChatListDisclosure> : <span>{tr("Demo")}</span>}
            </div>
            <div className="mtg-search mtg-sidebar-search">
              <Search className="mtg-sidebar-search-icon" size={16} aria-hidden="true" />
              <Input ref={chatSearch} type="search" className="mtg-search-field" aria-keyshortcuts={globalMode ? "Meta+F Control+F ArrowDown Enter" : "Meta+F Control+F ArrowDown"} aria-label={contactsMode ? tr("Search Telegram contacts") : globalMode === "media" ? tr("Search Telegram media") : globalMode ? tr("Search Telegram messages") : discoveryMode ? tr(discoveryLabel) : live ? (live.list === "main" ? tr("Search Telegram chats") : live.list === "saved" ? tr("Filter saved chats") : tr("Search this list")) : tr("Search chats and messages")} placeholder={contactsMode ? tr("Search contacts") : globalMode === "media" ? tr("Search media or enter a caption") : globalMode ? tr("Search messages") : discoveryMode ? tr(discoveryLabel) : live ? (live.list === "saved" ? tr("Filter saved chats") : tr("Find a chat")) : tr("Search chats and messages")} maxLength={live ? 128 : undefined} value={query} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (!value.trim() && searchMode !== "chats") setSearchMode("chats");
                  setQuery(value);
                }}
                onFocus={() => setRecentSearchOpen(true)} onClick={() => setRecentSearchOpen(true)}
                onPaste={(event) => {
                  if (live?.list !== "main" || globalMode || contactsMode || discoveryMode) return;
                  const value = event.clipboardData.getData("text/plain").trim();
                  const share = telegramShareDraft(value);
                  const article = loadInstantView && telegramInstantViewLink(value);
                  if (canOpenWallpaper && canonicalTelegramWallpaperLink(value)) {
                    event.preventDefault();
                    openWallpaperLink(value, ++openingTelegramLink.current, false);
                  } else if (article) {
                    event.preventDefault();
                    setLinkedArticle({ url: article.link });
                  } else if (share) {
                    event.preventDefault();
                    chooseShareDestination(share);
                  } else if (telegramPublicChatLink(value) || (resolveTemporaryContact && telegramTemporaryContactLink(value))
                    || (resolveBusinessChat && telegramBusinessChatLink(value))
                    || (managedBotLinks && canonicalTelegramManagedBotLink(value))) {
                    event.preventDefault();
                    setQuery(value);
                  }
                }} />
              {showSearchScope && <ChatListDisclosure label={tr("Search scope")} description={tr(searchScopeLabel)} className="mtg-search-scope"
                trigger={<><span>{tr(searchScopeLabel)}</span><ChevronDown size={13} aria-hidden="true" /></>}>
                {(close) => <>
                  {searchScopes.map((option) => searchScopeOption(option, close))}
                  <details className="mtg-search-more">
                    <summary>{tr("More…")}</summary>
                    {extraSearchScopes.map((option) => searchScopeOption(option, close))}
                  </details>
                </>}
              </ChatListDisclosure>}
              {(query || searchMode !== "chats") && <button className="mtg-search-clear" type="button" aria-label={tr("Clear chat search")}
                onClick={clearChatSearch}><X size={17} aria-hidden="true" /></button>}
            </div>
            {recentRecordFailed && <p role="status">{tr("Could not save the last chat search.")}</p>}
            {linkDraft && !linkDraft.chatId && !active && <div>
              <p role="status">{tr("Choose a chat for the shared link.")}</p>
              {live && <RecipientFolderSelect folders={live.folders} selected={typeof live.list === "number" ? live.list : undefined}
                defaultLabel="All chats" select={(id) => switchList(id ?? "main")} />}
              <button type="button" className="mtg-action" onClick={() => setLinkDraft(undefined)}>{tr("Cancel share")}</button>
            </div>}
            {live && !showSearchScope && !globalMode && !contactsMode && !discoveryMode && <div className="mtg-chat-filters">
              <select aria-label={tr("Chat type")} value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
                {([["all", "All chats"], ["Direct message", "People"], ["Group", "Groups"], ["Channel", "Channels"]] as const)
                  .map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}
              </select>
              {live.list !== "saved" && <label className="mtg-unread-filter">
                <span>{tr("Unread")}</span>
                <input type="checkbox" role="switch" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.currentTarget.checked)} />
              </label>}
            </div>}
          </header>
          {discoveryMode && live?.searchPublicDiscovery ? <PublicDiscovery key={`${discoveryMode}:${query.trim()}`}
            mode={discoveryMode} query={query.trim()} search={live.searchPublicDiscovery} browse={live.browsePublicDiscovery}
            openChat={openConversation} loadAvatar={live.loadAvatar}
            openApp={live.launchProfileMiniApp && ((chat) => openMiniApp({ target: { label: chat.name }, entryPoint: ["bot-profile", chat.id], launch: () => live.launchProfileMiniApp!(chat.id) }))} />
            : contactsMode && live?.contactActions ? <ContactResults key={`${live.contactsRevision ?? 0}:${query.trim()}`} query={query.trim()} actions={live.contactActions} birthdaysRevision={live.contactBirthdaysRevision} select={openConversation} /> : globalMode && live?.globalSearch ? <GlobalSearchResults key={globalMode} mode={globalMode}
            query={query.trim()} search={live.globalSearch} recentTags={live.recentPublicTags} changeQuery={setQuery}
            focusQuery={() => chatSearch.current?.focus({ preventScroll: true })}
            loadThumbnail={live.loadGlobalMediaThumbnail} open={({ chat, message }, trigger) => {
              const resultList = trigger.closest("ul");
              const scrollTop = resultList?.scrollTop ?? 0;
              openConversation(chat);
              setSearchView({ chatId: chat.id, messageId: message.id, topicId: message.forumTopicId, searchQuery: query.trim(),
                returnToGlobalResult: () => {
                  if (!trigger.isConnected || !resultList?.isConnected) return chatSearch.current ?? undefined;
                  resultList.scrollTop = scrollTop;
                  return trigger;
                } });
            }} /> : <>
            {showRecentSearch && live?.recentChatSearch
              && <RecentChatSearch actions={live.recentChatSearch} revision={recentSearchRevision} loadAvatar={live.loadAvatar}
              open={(chat) => {
                setRecentSearchOpen(false);
                openConversation(chat);
                recordSearchChat(chat.id);
              }} />}
            <ul className="mtg-rows" ref={chatRows} aria-label={tr("Telegram chats")} tabIndex={0} hidden={showRecentSearch}
              onScroll={(event) => {
                if (chatList !== undefined && browsingChatList && !live?.loading && !chatListViewport.current.restore
                  && event.currentTarget.clientHeight) chatListScroll.current.set(chatList, event.currentTarget.scrollTop);
              }}>
            {chatRowsInOrder.map((row) => {
              if ("group" in row) return collapsedRow(row.group);
              const { chat } = row;
              const community = communityByChat.get(chat.id);
              if (community) return collapsedRow(community);
              const tags = chat.folderIds && live?.folders.filter(({ id, color }) =>
                color !== undefined && color >= 0 && chat.folderIds?.includes(id));
              const linked = matched?.linked?.chat.id === chat.id ? matched.linked : undefined;
              const latest = (sent[chat.id] ?? []).at(-1) ?? chat.messages.at(-1);
              const date = latest?.timestamp ? new Date(latest.timestamp * 1000) : undefined;
              const timestamp = date ? (date.toDateString() === today ? rowTime : rowDate).format(date) : latest?.time;
              const contextActions = linked || publicLink ? [] : [
                ...(live?.markChat && markStatus[chat.id] !== "busy" ? [{
                  label: (chat.id === activeId ? hasUnread : !!chat.unread) || chat.markedUnread ? "Mark read" : "Mark unread",
                  run: () => void markActive(chat),
                }] : []),
                ...(live?.archiveChat && chat.archived !== undefined && archiveStatus[chat.id] !== "busy" ? [{
                  label: chat.archived ? "Restore chat from archive" : "Archive chat", run: () => void moveActive(chat),
                }] : []),
              ];
              return <li key={chat.id}>
                <Button type="button" variant="ghost" className="mtg-row" aria-current={chat.id === activeId ? "true" : undefined}
                  data-context-label={tr("Open chat")}
                  onContextMenu={(event) => objectMenu.onContextMenu(event, contextActions)}
                  onKeyDown={(event) => objectMenu.onKeyDown(event, contextActions)}
                  data-chat-preview-id={live && !linked ? chat.id : undefined}
                  aria-keyshortcuts={live && !linked ? "Control+]" : undefined}
                  draggable={!!live?.folderActions && !!live.folders.length && !linked}
                  onDragStart={(event) => {
                    if (!live?.folderActions || !live.folders.length || linked || pendingFolderDrop.current || !/^-?[1-9]\d{0,15}$/.test(chat.id)) {
                      event.preventDefault();
                      return;
                    }
                    draggedChat.current = chat;
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(chatFolderDragType, "chat");
                  }}
                  onDragEnd={() => { draggedChat.current = undefined; setFolderDropTarget(undefined); }}
                  onClick={() => {
                  if (linked && openLinkedMessage(linked)) return;
                  if (publicLink && chats.length === 1) {
                    openPublicLink(chat, publicLink);
                    return;
                  }
                  if (search && chatList === "main") recordSearchChat(chat.id);
                  setDetailsRequest(undefined);
                  if (chat.id !== activeId) {
                    setReadPausedChat(undefined);
                    setSearchView(undefined);
                    setForumView(undefined);
                  }
                  setSelectedChat(chat);
                  setActiveId(chat.id);
                  setShowConversation(true);
                  scheduleConversationFocus();
                }}>
                  <Avatar key={chat.avatarFileId} chat={chat} load={live?.loadAvatar} />
                  <span className="mtg-row-body">
                    <span className="mtg-row-line"><strong title={chat.name}>{chat.name}</strong>
                      <time title={latest?.time} dateTime={date?.toISOString()}>{timestamp}</time></span>
                    <span className="mtg-row-line"><span className="mtg-preview">{latest?.outgoing && <b>{tr("You: ")}</b>}{linked ? ("topic" in linked ? tr("Open linked topic") : tr("Open linked message")) : publicLink ? (publicLink.profile ? tr("Open Telegram profile") : tr("Open Telegram draft")) : displayMessagePreview(latest, tr) ?? tr("No messages")}</span>{!!chat.unreadMentions && <span className="mtg-unread-mentions" aria-label={tr("{0} unread mentions or replies", [chat.unreadMentions])}>@{chat.unreadMentions}</span>}{!!chat.unreadReactions && <span className="mtg-unread-reactions" aria-label={tr("{0} messages with unread reactions", [chat.unreadReactions])}><Heart size={12} aria-hidden="true" />{chat.unreadReactions}</span>}{chat.pinnedInList && <Pin size={12} role="img" aria-label={tr("Pinned chat")} />}{(!!chat.unread || chat.markedUnread) && <span className="mtg-unread" aria-label={chat.unread ? tr("{0} unread", [chat.unread]) : tr("Marked unread")}>{chat.unread || "•"}</span>}</span>
                    {!!tags?.length && <span className="mtg-row-folder-tags" aria-label={tr("Folders")}>
                      {tags.map(({ id, color, title }) => <span key={id} title={title}
                        style={{ color: color === undefined ? undefined : folderColors[color]?.value }}>{title}</span>)}
                    </span>}
                  </span>
                </Button>
              </li>;
            })}
            {folderCommunityRows?.communities.map((group) => collapsedRow(group))}
            {collapsed.map(({ community }) => collapsedRow(community))}
            {!remoteQuery && loadMoreChats && <li ref={moreChats} className="mtg-history-more mtg-history-start">
              {live?.loadingMore && <span role="status">{tr("Loading more chats…")}</span>}
              {(!autoPagination || chatLoadError) && !live?.loadingMore && <button type="button" className="mtg-action"
                disabled={!canLoadMore} onClick={() => void loadMoreChats()}>
                {chatLoadError ? tr("Retry loading chats") : tr("Load more chats")}
              </button>}
            </li>}
            {directUrl && <li className="mtg-empty">
              <button type="button" className="mtg-action" disabled={directLinkBusy} onClick={() => {
                const request = ++openingTelegramLink.current;
                const stillCurrent = () => {
                  const value = chatSearch.current?.value.trim() ?? "";
                  return (businessChatUrl ? telegramBusinessChatLink(value) : telegramTemporaryContactLink(value)?.url) === directUrl;
                };
                setDirectLinkStatus({ url: directUrl, request, busy: true });
                const open = businessChatUrl ? openBusinessConversation : openTemporaryProfile;
                void open(directUrl, request, stillCurrent).catch(() => false).then((opened) => {
                  const unavailable = !opened && request === openingTelegramLink.current && stillCurrent();
                  setDirectLinkStatus((previous) => previous?.request === request
                    ? unavailable ? { url: directUrl, request, busy: false } : undefined : previous);
                });
              }}>{businessChatUrl ? (directLinkBusy ? tr("Opening Business chat…") : tr("Open Business chat"))
                : (directLinkBusy ? tr("Opening temporary profile…") : tr("Open temporary profile"))}</button>
              {directLinkStatus?.url === directUrl && !directLinkStatus.busy
                && <p role="status">{businessChatUrl ? tr("This Telegram Business chat link is unavailable.")
                  : tr("This temporary Telegram profile is unavailable.")}</p>}
            </li>}
            {remoteQuery && !matched && !directUrl && <li className="mtg-empty" role="status">{tr("Searching Telegram…")}</li>}
            {matched?.stickerPack && loadLinkedStickerPack && <li className="mtg-empty">
              <StickerPackPreview key={remoteQuery} initial={matched.stickerPack} load={(offset) => loadLinkedStickerPack(remoteQuery, offset)}
                install={live?.installLinkedStickerPack && ((id) => live.installLinkedStickerPack!(remoteQuery, id))} />
            </li>}
            {matched?.folderInvite && <SharedFolderInvite key={`folder-invite:${remoteQuery}`} url={remoteQuery} folder={matched.folderInvite}
              importFolder={live?.importFolderInvite} openChannel={live && (async (id, username, signal) => {
                const scope = generation.current;
                const [chat, ...other] = await live.findChats(`https://t.me/${username}`, "main");
                if (signal.aborted || scope !== generation.current || chatSearch.current?.value.trim() !== remoteQuery
                  || other.length || chat?.id !== id || chat.subtitle !== "Channel") return false;
                openConversation(chat);
                return true;
              })} />}
            {matched?.invite && <li className="mtg-empty">
              <InviteResult key={remoteQuery} url={remoteQuery} invite={matched.invite} join={live?.joinInvite} refresh={live?.refresh} />
            </li>}
            {matched?.linkedGame && gameLinks && live && <GameLinkCard key={`game-link:${remoteQuery}`} url={remoteQuery}
              game={matched.linkedGame} actions={gameLinks} refresh={live.refresh} />}
            {matched?.linkedBot && live?.startLinkedBot && <li className="mtg-empty">
              <BotStartLink key={remoteQuery} target={matched.linkedBot} start={() => live.startLinkedBot!(remoteQuery, matched.linkedBot!.chat.id, matched.linkedBot!.chat.name)}
                open={() => { openConversation(matched.linkedBot!.chat); setQuery(""); live.refresh(); }} />
            </li>}
            {matched?.boostChat && <li className="mtg-empty">
              <button type="button" className="mtg-action" onClick={() => {
                openLinkedDetails(matched.boostChat!, "boost");
                setQuery("");
              }}>{tr("Open boosts for ")}<bdi>{matched.boostChat.name}</bdi></button>
            </li>}
            {matched?.linkedManagedBot && managedBotLinks && <li className="mtg-empty">
              <button type="button" className="mtg-action" onClick={() => {
                const url = canonicalTelegramManagedBotLink(remoteQuery);
                if (!url) return;
                const request = ++openingTelegramLink.current;
                const stillCurrent = () => request === openingTelegramLink.current
                  && canonicalTelegramManagedBotLink(chatSearch.current?.value.trim() ?? "") === url;
                void managedBotLinks.preview(url).catch(() => null).then((review) => {
                  if (!stillCurrent()) return;
                  if (review) setManagedBotReview(review);
                  else setResults({ query: remoteQuery, list: "main", chats: [], error: "This Telegram managed bot link is unavailable." });
                });
              }}>{tr("Review bot creation with ")}<bdi>{matched.linkedManagedBot.bot}</bdi>
              </button>
            </li>}
            {matched?.linkedStoryAlbum && <li className="mtg-empty">
              <button className="mtg-action" type="button" onClick={() => setStoryAlbum(matched.linkedStoryAlbum)}>{tr("Open story album ")}<bdi>{matched.linkedStoryAlbum.album.title}</bdi>
              </button>
            </li>}
            {matched?.linkedStory && live?.storyActions && <li className="mtg-empty">
              <LinkedStoryPreview key={remoteQuery} target={matched.linkedStory} actions={live.storyActions} />
            </li>}
            {matched?.error && <li className="mtg-empty" role="alert">{matched.error}</li>}
            {live?.error && <li className="mtg-empty" role="alert">{live.error}</li>}
            {live?.loading && <li className="mtg-empty" role="status">{tr("Loading chats…")}</li>}
            {!live?.error && !live?.loading && (!remoteQuery || matched && !matched.error && !matched.invite && !matched.folderInvite && !matched.stickerPack && !matched.linkedStory && !matched.linkedStoryAlbum && !matched.linkedBot && !matched.boostChat && !matched.linkedManagedBot) && visible.length === 0 && collapsed.length === 0 && !folderCommunityRows?.communities.length
              && !(unreadOnly && loadMoreChats && !remoteQuery) && <li className="mtg-empty">{
                unreadOnly && !search ? tr("No unread chats") : search || kind !== "all" ? tr("No matching chats") : tr("No chats")
              }</li>}
          </ul></>}
        </section>

        </>)}
        <MessageViewerScope openViewer={live?.loadMessageViewerProfile ? async (id, messageId, userId, signal) => {
          if (signal.aborted || activeId !== id) return false;
          const request = ++openingTelegramLink.current;
          const scope = generation.current;
          const chat = await live.loadMessageViewerProfile!(id, messageId, userId);
          if (signal.aborted || request !== openingTelegramLink.current || scope !== generation.current
            || chat?.id !== userId || chat.subtitle !== "Direct message") return false;
          switchList("main");
          openLinkedDetails(chat, "profile");
          return true;
        } : undefined}>
        <ConversationTranslation.Provider value={translationScope}>
        <LoadMessagePoster.Provider value={live?.loadGlobalMediaThumbnail}>
        <NotePlaybackReceipt.Provider value={live?.markNotePlayed}>
        <ChatSenderBan.Provider value={permissions?.canBanChatSenders && active && live?.banMessageChatSender
          ? { chatId: active.id, chatName: active.name, ban: live.banMessageChatSender } : undefined}>
        <section className="mtg-conversation" data-shared-library={sharedLibraryOpen || undefined} data-chat-background={!!(active?.backgroundColor || active?.backgroundFill)}
          data-chat-wallpaper={patternUrl ? "pattern" : wallpaper ? active?.backgroundPhotoBlurred ? "blurred" : "true" : undefined} style={{
          "--mtg-chat-accent": active?.themeAccent ? `${active.themeAccent}55` : undefined,
          "--mtg-chat-background": active?.backgroundFill ? backgroundFillStyle(active.backgroundFill) : active?.backgroundColor,
          "--mtg-chat-wallpaper": wallpaper,
        } as CSSProperties}
          aria-labelledby={conversationHeadingId} aria-keyshortcuts="Escape Alt+ArrowUp Alt+ArrowDown Control+PageUp Control+PageDown Meta+PageUp Meta+PageDown Control+Alt+Home Control+Alt+End Meta+Alt+Home Meta+Alt+End"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = showConversation && !overlayOpen && !sharedLibraryOpen && !edit
              && !sending.current.has(activeId) && (canAttachPhoto || canAttachVideo || canAttachDocument || canAttachAudio) ? "copy" : "none";
          }}
          onDrop={(event) => {
            const { files } = event.dataTransfer;
            if (!files.length && !event.dataTransfer.items?.length) return;
            event.preventDefault();
            if (!showConversation || overlayOpen || sharedLibraryOpen || edit || sending.current.has(activeId)
              || !(canAttachPhoto || canAttachVideo || canAttachDocument || canAttachAudio)
              || (event.target instanceof Element && event.target.closest("dialog, [role=dialog]"))) return;
            const folder = droppedFolderArchive(event.dataTransfer);
            if (folder) {
              if (archivePicker.current) archivePicker.current.offer(folder);
              else setAttachmentStatus((previous) => ({ ...previous, [activeId]: { error: "A folder requires an available document attachment." } }));
              return;
            }
            chooseChatFiles(Array.from(files));
          }} onKeyDown={(event) => {
          const target = event.target;
          if (showConversation && !overlayOpen && !edit && isPlainKey(event, "Escape")
            && target instanceof HTMLElement && !target.closest("input:not([type=checkbox]), textarea, select, dialog, [role=dialog], [contenteditable], details[open]")) {
            if (selection.active && !selection.cancel()) return;
            event.preventDefault();
            if (selection.active) history.current?.focus({ preventScroll: true });
            else backToChats();
            return;
          }
          const find = isFindShortcut(event);
          const details = isControlPanelShortcut(event, "\\");
          if (!showConversation || (sharedLibraryOpen && !find) || (!find && !details && !isPanelShortcut(event))) return;
          const shortcut = find ? "Alt+Shift+F" : details || event.code === "KeyI" ? "Alt+Shift+I"
            : event.code === "KeyF" ? "Alt+Shift+F" : undefined;
          if (!shortcut) return;
          const button = event.currentTarget.querySelector<HTMLButtonElement>(`.mtg-conversation-header [aria-keyshortcuts~="${shortcut}"]`);
          if (!button || button.disabled) return;
          event.preventDefault();
          if (find && button.getAttribute("aria-pressed") === "true") {
            event.currentTarget.querySelector<HTMLInputElement>('.mtg-conversation-search input[type="search"]')?.focus();
            return;
          }
          button.focus();
          button.click();
        }}>
          {backgroundPattern && patternUrl && <WallpaperPatternLayer pattern={backgroundPattern} url={patternUrl} />}
          <MessageInspector scope={`${activeId}:${overlayOpen}`} workspace={workspaceActive ? workspace : undefined}>
          <div className="mtg-conversation-content" inert={sharedLibraryOpen} aria-hidden={sharedLibraryOpen || undefined}>
          <header className="mtg-conversation-header">
            <Button className="mtg-back" variant="ghost" size="icon" type="button" aria-label={tr("Back to chats")} onClick={backToChats}><ArrowLeft size={18} aria-hidden="true" /></Button>
            {active && <Avatar key={`${active.id}:${active.avatarFileId}`} chat={active} load={live?.loadAvatar} />}
            <div className="mtg-chat-heading"><h2 id={conversationHeadingId} ref={heading} tabIndex={-1} title={active?.name}>{active?.name ?? tr("Select a chat")}</h2>
              {live?.accountLabel && <p className="mtg-account-label" title={live.accountLabel}>{tr("Telegram account: ")}<bdi>{live.accountLabel}</bdi>
              </p>}
              <div className="mtg-chat-subtitle">
                {active?.subtitle === "Direct message" && live?.loadPeerPresence && chatList !== "saved"
                  ? <PeerPresence key={`peer-presence:${active.id}`} id={active.id} load={live.loadPeerPresence} subscribe={live.subscribeToPresence} />
                  : active?.subtitle !== "Group" || !live?.setOpenChatView || !showConversation
                    ? <p>{tr(active?.subtitle)}</p> : null}
                {active && live?.setOpenChatView && showConversation &&
                  <OpenChatStatus key={`open-chat-status:${active.id}`} id={active.id} setView={live.setOpenChatView}
                    label={active.subtitle === "Group" ? tr("Group") : undefined} subscribe={live.subscribeToGroupOnline} />}
                {active && live?.subscribeToActivity && chatList !== "saved" && active.subtitle !== "Channel" &&
                  <ChatActivityIndicator key={`chat-activity-indicator:${active.id}`} chatId={active.id} subscribe={live.subscribeToActivity} />}
                {active && live && <CopyRecipientReference key={`copy-recipient-reference:${active.id}`} chatId={active.id} />}
              </div>
            </div>
            {active && <div className="mtg-chat-toolbar" role="group" aria-label={tr("Conversation actions")}>
            {live && (active.subtitle === "Direct message" || active.subtitle === "Bot") && chatList !== "saved"
              && (live.botMiniAppMenu || (live.loadPeerProfile && live.launchProfileMiniApp)) &&
              <BotMiniAppMenu key={`bot-mini-app-header:${active.id}`} id={active.id} name={active.name} actions={live.botMiniAppMenu}
                loadProfile={live.loadPeerProfile} loadPresence={active.subtitle === "Direct message" ? live.loadPeerPresence : undefined}
                launchProfile={live.launchProfileMiniApp} disabled={!showConversation} />}
            {privateCall?.available && chatList !== "saved" && active.subtitle === "Direct message" &&
              <CallContact key={active.id} chatId={active.id} controls={privateCall} />}
            {live?.joinChat && permissions?.join && joinStatus[active.id] !== "requested"
              && joinStatus[active.id] !== "joined" && joinStatus[active.id] !== "verification_required" &&
              <button type="button" className="mtg-action" disabled={joinStatus[active.id] === "joining"}
                onClick={() => void joinActive(active)}>{permissions.join === "request" ? tr("Request to join") : tr("Join")}</button>}
            {active && live && <ChatDetails key={`details:${active.id}`}
              sidePanel={workspace && {
                target: workspace.details ?? (showInlineDetails ? inlineDetailsTarget : null),
                open: () => {
                  if (!workspace.openDetails()) setInlineDetails(true);
                  return true;
                },
                close: () => {
                  if (workspace.details) return workspace.closeDetails?.() ?? false;
                  setInlineDetails(false);
                  return true;
                },
              }}
              leaving={sharedLibraryOpen}
              openRequest={linkedDetails?.nonce}
              avatar={<Avatar key={active.avatarFileId} chat={active} load={live.loadAvatar} />}
              subtitle={active.subtitle}
              members={["Group", "Channel"].includes(active.subtitle)
                && (live.chatMemberInvite || live.loadChatMembers || live.chatInviteActions || live.joinRequestActions) ? <>
                {live.chatMemberInvite && (active.subtitle === "Group" || active.subtitle === "Channel")
                  && <ChatMemberInvite key={`chat-member-invite:${active.id}`} chatId={active.id} title={active.name} actions={live.chatMemberInvite} />}
                {live.loadChatMembers && (active.subtitle === "Group" || active.subtitle === "Channel")
                  && <ChatMembers key={`chat-members:${active.id}`} chatId={active.id} load={live.loadChatMembers} ban={live.banChatMember} unban={live.unbanChatMember}
                    communityModeration={live.communityModeration} moderate={live.moderateChatMember}
                    setTag={live.setChatMemberTag} saveAdministrator={live.saveChatAdministrator} demote={live.demoteChatAdministrator} restrict={live.restrictChatMember} liftRestrictions={live.liftChatMemberRestrictions} channel={active.subtitle === "Channel"} />}
                {live.chatInviteActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                  && <ChatInvites key={`chat-invites:${active.id}`} chatId={active.id} actions={live.chatInviteActions} />}
                {live.joinRequestActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                  && <ChatJoinRequests chatId={active.id} actions={live.joinRequestActions} />}
              </> : undefined}
              notifications={chatList !== "saved" && live.chatNotificationState && live.setChatNotificationMode &&
                <ChatNotifications key={`notifications:${active.id}`} id={active.id} chatNotificationState={live.chatNotificationState}
                  setChatNotificationSound={live.setChatNotificationSound} setChatNotificationMode={live.setChatNotificationMode} setChatNotificationOverride={live.setChatNotificationOverride} />}
              conversationActions={(dismiss) => showConversation && (selection.available || canTranslateChat) &&
                <div className="mtg-chat-detail-actions mtg-conversation-actions" role="group" aria-label={tr("Chat actions")}>
                  <h3>{tr("Actions")}</h3>
                  {canTranslateChat && (
                    <div className="mtg-chat-translation" role="group" aria-label={tr("Chat translation")}>
                      {targetLanguage ? <>
                        <label>{tr("Chat language ")}<select value={targetLanguage} onChange={(event) => {
                          const language = event.currentTarget.value as TranslationLanguage;
                          setTranslatedChats((previous) => ({ ...previous, [activeId]: { language, enabled: true } }));
                        }}>
                          {translationLanguages.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                        </select></label>
                        <button type="button" className="mtg-action" onClick={() => setTranslatedChats((previous) => ({
                          ...previous, [activeId]: { language: translationPreference?.language, enabled: false },
                        }))}>{tr("Show original messages")}</button>
                      </> : <button type="button" className="mtg-action" onClick={() => {
                        setTranslatedChats((previous) => ({ ...previous, [activeId]: {
                          language: translationPreference?.language, enabled: true,
                        } }));
                      }}><Languages size={16} aria-hidden="true" />{tr("Translate chat")}</button>}
                    </div>
                  )}
                  {selection.start(dismiss)}
                </div>}
              onDismiss={() => setDetailsRequest((current) => current === linkedDetails ? undefined : current)}
              chatId={active.id} name={active.name} clearCache={live.clearChatCache} load={live.chatAgentAccess} change={live.setChatAgentAccess} loadCounts={live.loadSharedContentCounts}
              commonGroups={chatList !== "saved" && active.subtitle === "Direct message" ? live.loadCommonGroups : undefined}
              openChat={openConversation}
              browse={live.searchMessages ? (counts) => {
                setSearchView((previous) => ({ chatId: active.id, filter: "photoVideo", sharedLibrary: counts, revision: (previous?.revision ?? 0) + 1 }));
              } : undefined}
              recentActions={live.loadChatEvents && (active.subtitle === "Group" || active.subtitle === "Channel")
                ? (dismiss) => <ChatEvents key={active.id} chatId={active.id} load={live.loadChatEvents!} loadActors={live.loadChatEventActors}
                  reportAntiSpam={live.reportAntiSpam}
                  openTopic={loadForumTopics && loadTopicHistory && live.loadForumTopicLink && resolveMessageLink ? async (topicId, signal) => {
                    const scope = generation.current;
                    const url = await live.loadForumTopicLink?.(active.id, topicId);
                    if (signal.aborted || scope !== generation.current || !url) return false;
                    const linked = await resolveMessageLink(url);
                    if (signal.aborted || scope !== generation.current || !linked || linked.chat.id !== active.id
                      || !("topic" in linked) || linked.topic.id !== topicId) return false;
                    dismiss();
                    return openLinkedMessage(linked);
                  } : undefined}
                  openMessage={live.loadMessageContext && ((messageId, topicId) => {
                    dismiss();
                    setForumView(undefined);
                    setDiscussion(undefined);
                    setSearchView({ chatId: active.id, messageId, topicId });
                  })} /> : undefined}>
              {chatList !== "saved" && defaultChatMedia && live.automaticMediaOverrides && saveChatMediaOverride &&
                <ChatAutomaticMedia value={chatMediaOverride} defaults={defaultChatMedia}
                  save={(limits) => saveChatMediaOverride(active.id, limits)} />}
              {chatList !== "saved" && defaultChatPlayback && live.automaticPlaybackOverrides && saveChatPlaybackOverride &&
                <ChatAutomaticPlayback value={playbackOverride} defaults={defaultChatPlayback}
                  save={(limits) => saveChatPlaybackOverride(active.id, limits)} />}
              {live.storyActions?.profile && (active.subtitle === "Direct message" || active.subtitle === "Channel" || chatList === "saved")
                && <ProfileStories id={active.id} actions={live.storyActions} />}
              {live.storyActions?.albums && (active.subtitle === "Direct message" || active.subtitle === "Channel" || chatList === "saved") &&
                <ProfileStoryAlbums key={`profile-story-albums:${active.id}`} id={active.id} actions={live.storyActions} />}
              {chatList === "saved" && live.storyActions?.ownArchive && <ProfileStories id={active.id} actions={live.storyActions} archive />}
              {live.exportChat && <ChatExport save={(options) => live.exportChat!(active.id, options)} />}
              {live.clearChatHistoryByDate && chatList !== "saved" && (active.subtitle === "Direct message" || active.subtitle === "Group")
                && <ClearChatHistoryByDate id={active.id} name={active.name} actions={live.clearChatHistoryByDate} />}
              {live.chatBusinessBot && chatList !== "saved" && active.subtitle === "Direct message"
                && <ChatBusinessBot key={`chat-business-bot:${active.id}`} id={active.id} actions={live.chatBusinessBot} />}
              {live.loadPeerProfile && chatList !== "saved" && (active.subtitle === "Direct message" || active.subtitle === "Bot")
                && <ContactProfile key={linkedDetails?.kind === "profile" ? linkedDetails.nonce : active.id}
                  id={active.id} name={active.name} load={live.loadPeerProfile} startExpanded={linkedDetails?.kind === "profile"} launchMainApp={live.launchProfileMiniApp} revokeEmojiAccess={live.revokeBotEmojiAccess}
                  revokeLocationAccess={live.revokeBotLocationAccess} openPersonalChannel={live.loadNotificationChat && (async (id) => {
                    const scope = generation.current;
                    const chat = await live.loadNotificationChat?.(id);
                    if (scope !== generation.current || chat?.id !== id || chat.subtitle !== "Channel") return false;
                    openConversation(chat);
                    return true;
                  })} />}
              {live.chatThemeActions && chatList !== "saved" && active.subtitle === "Direct message"
                && <ChatTheme key={`chat-theme:${active.id}`} id={active.id} actions={live.chatThemeActions} />}
              {live.chatBackgroundActions && chatList !== "saved" && active.subtitle === "Direct message"
                && <ChatBackground key={`chat-background:${active.id}`} id={active.id} actions={live.chatBackgroundActions} />}
              {live.profileGifts && (chatList === "saved" || ["Direct message", "Channel"].includes(active.subtitle))
                && <ProfileGifts key={`profile-gifts:${active.id}`} id={active.id} actions={live.profileGifts} recipient={active.name} own={chatList === "saved"} />}
              {live.profilePhotos && chatList !== "saved" && ["Direct message", "Group", "Channel"].includes(active.subtitle)
                && <ProfilePhotos key={`profile-photos:${active.id}`} id={active.id} actions={live.profilePhotos} group={active.subtitle !== "Direct message"} />}
              {live.profileAudio && (chatList === "saved" || active.subtitle === "Direct message")
                && <ProfileAudio key={`profile-audio:${active.id}`} id={active.id} actions={live.profileAudio} own={chatList === "saved"} />}
              {live.contactEditor && chatList !== "saved" && active.subtitle === "Direct message"
                && <ContactEditor chatId={active.id} actions={live.contactEditor} />}
              {live.senderBlockActions && chatList !== "saved" && active.subtitle === "Direct message"
                && <SenderBlockSettings chatId={active.id} actions={live.senderBlockActions} />}
              {live.folderActions && live.folders.length > 0 && <ChatFolderMemberships key={`chat-folder-memberships:${active.id}`}
                chatId={active.id} folders={live.folders} actions={live.folderActions} />}
              {live.channelSignatureActions && active.subtitle === "Channel"
                && <ChannelSignaturesPanel chatId={active.id} actions={live.channelSignatureActions} />}
              {live.loadChannelDirectMessages && active.subtitle === "Channel"
                && <ChannelDirectMessages key={`channel-direct-messages:${active.id}`} id={active.id} channelName={active.name} load={live.loadChannelDirectMessages}
                  draftStorage={forumDrafts.inbox}
                  inboxMedia={{ loadPhoto: live.loadPhoto, loadMedia: live.loadMedia, loadVideoStream: live.loadVideoStream,
                    transcribeVoice: live.transcribeVoice, saveDocument: live.saveDocument, mediaCollection: live.mediaCollection, loadAvatar: live.loadAvatar }}
                  forwardRecipients={forwardActions}
                  openReactionProfile={(target, signal, load) => openReactionProfile(active.id, target, signal, load)}
                  inboxActions={live.channelInbox} open={openConversation} />}
              {live.chatSendAsActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatSendAsSettings id={active.id} actions={live.chatSendAsActions} />}
              {live.chatInfoActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatInfoPanel key={linkedDetails?.nonce} chatId={active.id}
                  actions={live.chatInfoActions} startExpanded={!!linkedDetails} focusBoosts={linkedDetails?.kind === "boost"}
                  openUpgradedGroup={live.loadNotificationChat && openMigratedConversation} />}
              {live.chatInfoActions?.discussion && (active.subtitle === "Channel" || active.subtitle === "Group")
                && <DiscussionGroupSettings key={`discussion-group:${active.id}`} id={active.id} channel={active.subtitle === "Channel"} actions={live.chatInfoActions.discussion} />}
              {live.chatInfoActions?.groupPacks && active.subtitle === "Group"
                && <GroupPacks key={`group-packs:${active.id}`} id={active.id} actions={live.chatInfoActions.groupPacks} />}
              {live.welcomeMessageActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatWelcomeMessages key={`welcome-messages:${active.id}`} chatId={active.id} actions={live.welcomeMessageActions}
                  loadGroupEmoji={active.subtitle === "Group" ? live.loadGroupEmoji : undefined} />}
              {live.chatReactionActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatReactionsSettings key={`chat-reactions-settings:${active.id}`} chatId={active.id} actions={live.chatReactionActions} />}
              {live.channelStarTransactions && active.subtitle === "Channel" && <details key={`stars:${active.id}`}>
                <summary>{tr("Stars revenue")}</summary>
                <StarTransactions revenue load={(offset, direction) => live.channelStarTransactions!(active.id, offset, direction)}
                  loadRevenue={live.channelStarRevenue && (() => live.channelStarRevenue!(active.id))}
                  openSource={async ({ id, messageId }) => {
                    const chat = id === active.id ? active : await live.loadNotificationChat?.(id);
                    return !!chat && chat.id === id && openLinkedMessage({ chat, messageId });
                  }} />
              </details>}
              {live.chatPublicUsernameActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <ChatPublicUsername chatId={active.id} actions={live.chatPublicUsernameActions} />}
              {chatAutoDeleteActions && chatList !== "saved" && <AutoDeleteTimer chat actions={chatAutoDeleteActions} />}
              {live.slowModeActions && active.subtitle === "Group"
                && <GroupSlowMode chatId={active.id} actions={live.slowModeActions} />}
              {live.groupMemberVisibilityActions && active.subtitle === "Group"
                && <GroupModerationSetting kind="members" key={`members:${active.id}`} chatId={active.id} actions={live.groupMemberVisibilityActions} />}
              {live.groupAntiSpamActions && active.subtitle === "Group"
                && <GroupModerationSetting kind="spam" key={`spam:${active.id}`} chatId={active.id} actions={live.groupAntiSpamActions} />}
              {live.groupHistoryVisibilityActions && active.subtitle === "Group"
                && <GroupModerationSetting kind="history" key={`history:${active.id}`} chatId={active.id} actions={live.groupHistoryVisibilityActions} />}
              {live.chatContentProtectionActions && (active.subtitle === "Group" || active.subtitle === "Channel")
                && <GroupModerationSetting kind="content" key={`content:${active.id}`} chatId={active.id} actions={live.chatContentProtectionActions} />}
              {live.groupEntryActions && active.subtitle === "Group" && (["approval", "joinToSend", "forum"] as const).map((setting) =>
                <GroupModerationSetting kind={setting} key={setting} chatId={active.id} actions={live.groupEntryActions![setting]}
                  onSaved={setting === "forum" ? (enabled) => {
                    if (!enabled) setForumView((view) => view?.chatId === active.id ? undefined : view);
                    setForumRevision((value) => value + 1);
                  } : undefined} />)}
              {live.groupPermissionActions && active.subtitle === "Group"
                && <GroupPermissions chatId={active.id} actions={live.groupPermissionActions} />}
              {chatList !== "saved" && live.chatReportActions &&
                <ChatReport key={JSON.stringify([active.id, active.name])} id={active.id} name={active.name} actions={live.chatReportActions} />}
              {live.chatLeaveActions && (active.subtitle === "Group" || active.subtitle === "Channel") &&
                <ChatLeave id={active.id} name={active.name} kind={active.subtitle === "Group" ? "group" : "channel"}
                  actions={live.chatLeaveActions} onLeft={() => {
                    setActiveId((id) => id === active.id ? "" : id);
                    setSelectedChat((chat) => chat?.id === active.id ? undefined : chat);
                    setSearchView((view) => view?.chatId === active.id ? undefined : view);
                    setForumView((view) => view?.chatId === active.id ? undefined : view);
                    setDiscussion((view) => view?.chatId === active.id ? undefined : view);
                    live.refresh();
                  }} />}
              {live.markChat && <button type="button" className="mtg-action mtg-mark-chat"
                disabled={markStatus[active.id] === "busy"} onClick={() => void markActive(active)}>
                {hasUnread || active.markedUnread ? tr("Mark read") : tr("Mark unread")}
              </button>}
              {chatList !== undefined && chatList !== "saved" && live.chatPinStatus && live.setChatPinned &&
                <ChatPin key={`pin:${active.id}:${chatList}`} id={active.id} list={chatList} revision={live.liveRevision}
                  chatPinStatus={live.chatPinStatus} setChatPinned={live.setChatPinned}
                  pinnedChatOrder={live.pinnedChatOrder} movePinnedChat={live.movePinnedChat} />}
              {active.archived !== undefined && live.archiveChat && <button type="button"
                className="mtg-chat-archive" aria-label={active.archived ? tr("Restore chat from archive") : tr("Archive chat")}
                title={active.archived ? tr("Restore chat from archive") : tr("Archive chat")} disabled={archiveStatus[active.id] === "busy"}
                onClick={() => void moveActive(active)}><Archive size={18} aria-hidden="true" /> {active.archived ? tr("Restore chat from archive") : tr("Archive chat")}</button>}
              {archiveStatus[active.id] === "failed" && <p role="alert">{tr("Could not move this chat.")}</p>}
              {markStatus[active.id] === "failed" && <p role="alert">{tr("Could not update the read state.")}</p>}
            </ChatDetails>}
            {topics && <Button type="button" variant="ghost" size="sm" aria-pressed={topicsOpen} onClick={() => {
              setSearchView(undefined);
              setForumView(topicsOpen ? undefined : { chatId: activeId });
            }}>{tr("Topics")}</Button>}
            {!!active?.unreadMentions && !topicsOpen && !activeDiscussion && live?.searchMessages &&
              <button type="button" className="mtg-chat-search-toggle mtg-unread-mentions" aria-label={tr("Unread mentions and replies")}
                aria-pressed={searching && searchView?.filter === "unreadMentions"}
                title={tr("{0} unread mentions or replies", [active.unreadMentions])}
                onClick={() => setSearchView(searching && searchView?.filter === "unreadMentions"
                  ? undefined : { chatId: activeId, filter: "unreadMentions" })}>@{active.unreadMentions}</button>}
            {!!active?.unreadReactions && !topicsOpen && !activeDiscussion && live?.searchMessages &&
              <button type="button" className="mtg-chat-search-toggle mtg-unread-reactions" aria-label={tr("Unread reactions")}
                aria-pressed={searching && searchView?.filter === "unreadReactions"}
                title={tr("{0} messages with unread reactions", [active.unreadReactions])}
                onClick={() => setSearchView(searching && searchView?.filter === "unreadReactions"
                  ? undefined : { chatId: activeId, filter: "unreadReactions" })}>
                <Heart size={15} aria-hidden="true" />{active.unreadReactions}
              </button>}
            {active && !topicsOpen && !activeDiscussion && live?.searchMessages && <Button type="button" variant="ghost" size="icon"
              aria-label={tr("Search conversation")} aria-keyshortcuts="Alt+Shift+F Meta+F Control+F"
              aria-pressed={searchingConversation} onClick={() => setSearchView(searchingConversation ? undefined : { chatId: activeId })}>
              <Search size={18} aria-hidden="true" />
            </Button>}
            {active && canBrowseSaved && !browsingSaved &&
              <button type="button" className="mtg-action" onClick={() => {
                setSearchView(undefined);
                setSavedSourcesChat(activeId);
              }}>{tr("Saved by chat")}</button>}
            </div>}
          </header>
          {!sharedLibraryOpen && joinStatus[activeId] && <p className="mtg-send-status" role="status">{joinMessages[joinStatus[activeId]!]}</p>}
          {!sharedLibraryOpen && !topicsOpen && pinnedText && <div className="mtg-pinned">
            {pinnedMessage && live?.loadMessageContext
              ? <button type="button" className="mtg-pinned-open" onClick={() => setSearchView({ chatId: activeId, messageId: pinnedMessage.id })}>
                <strong>{tr("Pinned message")}</strong><span>{pinnedText}</span>
              </button>
              : <div><strong>{tr("Pinned message")}</strong><p>{pinnedText}</p></div>}
            {live?.searchMessages && <button type="button" className="mtg-reply-action" title={tr("All pinned messages")}
              aria-label={tr("All pinned messages")} onClick={() => {
                setDiscussion(undefined);
                setSearchView({ chatId: activeId, filter: "pinned" });
              }}><List size={17} aria-hidden="true" /></button>}
          </div>}
          {savedSourcesOpen && live?.savedSources && <SavedSources key={`saved-sources:${activeId}`} hidden={searching} liveRevision={liveRevision} chatId={activeId} actions={live.savedSources}
            editActions={{ editText: live.editText, editCaption: live.editCaption }}
            deletedIds={deletedIds} deletion={live.deletionOptions && live.deleteMessage ? {
              deletionOptions: live.deletionOptions, deleteMessage: live.deleteMessage,
            } : undefined}
            pinning={live.pinStatus && live.setMessagePinned ? {
              pinStatus: live.pinStatus, setMessagePinned: live.setMessagePinned,
            } : undefined}
            media={{ loadPhoto: live.loadPhoto, loadMedia: live.loadMedia, loadVideoStream: live.loadVideoStream,
              saveDocument: live.saveDocument, transcribeVoice: live.transcribeVoice, mediaCollection: live.mediaCollection,
              forwardActions, reactionActions: live.reactionActions, stopPoll: live.stopPoll, voteInPoll: live.voteInPoll }}
            openMessage={live.loadMessageContext && ((messageId) => setSearchView({ chatId: activeId, messageId, returnToSavedSource: true }))}
            openSourceChat={loadForwardedChat && (async (id, signal) => {
              const chat = await loadForwardedChat(id);
              if (signal.aborted || chat?.id !== id) return false;
              openConversation(chat);
              return true;
            })}
            close={() => { setSavedSourcesChat(undefined); heading.current?.focus(); }} />}
          {!sharedLibraryOpen && conversationSearch}
          {topicsOpen && openTopics && loadForumTopics && loadTopicHistory && <ForumTopics draftStorage={forumDrafts.forum(activeId)} focusReply={forumView?.focusReply}
            openReplyPicker={live?.externalReplyDraft && active?.subtitle === "Group" ? openReplyPicker : undefined} draftStash={draftStash} readingPlaces={readingPlaces} historyView={historyView} key={`${activeId}:${forumView?.revision ?? 0}`} initialTopic={linkedTopic} onActiveTopic={reportActiveForumTopic} chatId={activeId} chat={active} loadAvatar={live?.loadAvatar} loadMessageLink={live?.loadMessageLink} loadTopicLink={live?.loadForumTopicLink} topics={openTopics} liveRevision={liveRevision}
            loadForumTopics={loadForumTopics} loadTopicHistory={loadTopicHistory} sendTopicText={canSendText ? live?.sendTopicText : undefined}
            linkDraft={preparedDraft} dismissLinkDraft={() => setLinkDraft(undefined)}
            inlineDraft={forumView?.inlineDraft}
            dismissInlineDraft={() => setForumView((view) => view && { ...view, inlineDraft: undefined })}
            scheduleActions={live?.scheduledMessages && live.cancelScheduledMessage ? {
              load: live.scheduledMessages, cancel: live.cancelScheduledMessage, change: live.changeScheduledMessage,
              checkRepeat: live.canScheduleRepeats,
            } : undefined}
            postingSender={permissions?.postingSender}
            postingSenderKey={permissions?.postingSenderKey}
            loadGroupEmoji={live?.loadGroupEmoji} mediaComposer={live?.mediaComposer} mediaPermissions={{ photos: canAttachPhoto, audio: canAttachAudio,
              voice: !restrictedChat || permissions?.voice === true, videoNote: !restrictedChat || permissions?.videoNote === true, basicMedia: canSendText, otherMedia: !restrictedChat || permissions?.otherMedia === true }}
            sendPoll={sendPoll} sendPhoto={canAttachPhoto ? live?.sendPhoto : undefined} sendDocument={canAttachDocument || canAttachVideo ? live?.sendDocument : undefined}
            allowVideoAttachment={canAttachVideo} allowDocumentAttachment={canAttachDocument} loadPhoto={live?.loadPhoto}
            manageTopic={live?.manageForumTopic} deleteTopic={live?.deleteForumTopic}
            markTopicRead={live?.markForumTopicRead} markForumRead={live?.markForumRead}
            loadTopicDraft={live?.loadTopicDraft} saveTopicDraft={live?.saveChatDraft} loadTopicPage={live?.loadForumTopicPage} messageActions={live} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} loadMedia={live?.loadMedia} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} saveDocument={live?.saveDocument} deletedIds={deletedIds} close={() => { setForumView(undefined); heading.current?.focus(); }} />}
          {activeDiscussion && live?.loadChannelDiscussion && <ChannelDiscussion key={`${activeId}:${activeDiscussion.postId}`}
            chatId={activeId} postId={activeDiscussion.postId} load={live.loadChannelDiscussion} send={live.sendChannelComment}
            loadAvatar={live.loadAvatar} loadPhoto={live.loadPhoto} loadMedia={live.loadMedia} loadVideoStream={live.loadVideoStream}
            transcribeVoice={live.transcribeVoice} saveDocument={live.saveDocument} mediaCollection={live.mediaCollection}
            close={() => { setDiscussion(undefined); heading.current?.focus(); }} />}
          <ol hidden={overlayOpen} className="mtg-history" ref={history} aria-label={tr("Messages")} tabIndex={0} data-selecting={selection.active || undefined}
            data-has-newer={after ? "true" : undefined}
            aria-keyshortcuts={canNavigateReply ? replyNavigationShortcuts : undefined}
            onDoubleClick={(event) => {
              if (live && showConversation && !overlayOpen && !edit && !selection.active) {
                handleMessageDoubleClick(event, live.messageDoubleClick ?? "reply");
              }
            }}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (list.hidden || !showConversation || (live && scrollChat.current !== activeId)) return;
              if (lastHistoryWidth.current !== list.clientWidth && typeof ResizeObserver === "function") return;
              const upward = list.scrollTop < lastHistoryTop.current;
              const downward = list.scrollTop > lastHistoryTop.current;
              if (canLoadOlderOnScroll && list.scrollTop <= 96 && upward) void loadOlder();
              lastHistoryTop.current = list.scrollTop;
              const away = isAwayFromLatest(list);
              if (downward && !away && !overlayOpen && !newerStatus && after) void loadNewer();
              if (upward || !away) followLatest.current = !after && !away;
              if ((upward || downward) && live && activeId && away && selectedHistory?.page) {
                const position = captureHistoryScroll(list, "keep");
                const { rowId } = position;
                if (rowId && /^[1-9]\d{0,15}$/.test(rowId) && !byId.get(rowId)?.pendingDelivery) {
                  rememberReadingPlace(readingPlaces, activeId, rowId);
                  const page = selectedHistory.page;
                  historyView.remember(activeId, deletedIds?.size ? { ...page, messages: page.messages.filter((row) => !deletedIds.has(row.id)) } : page, position);
                }
              } else if (downward && !away && !list.hidden && selectedHistory?.page
                && deferredLatest?.id !== activeId && !after && readingPlaces.delete(activeId)) {
                historyView.forget(activeId);
                setResumePlace(undefined);
              }
              setAwayFromLatest(!followLatest.current);
            }}
            onWheel={(event) => {
              const direction = historyWheelDirection(event);
              if (canLoadOlderOnScroll && event.currentTarget.scrollTop <= 0 && direction === "up") void loadOlder();
              if (after && !overlayOpen && !newerStatus && direction === "down" && !isAwayFromLatest(event.currentTarget)) void loadNewer();
            }}
            onKeyDown={(event) => {
              if (navigateChatReply(event)) return;
              const row = event.target instanceof HTMLElement && event.target.matches(".mtg-message[data-message-id]") ? event.target : undefined;
              if (canLoadOlderOnScroll && event.currentTarget.scrollTop <= 0 && historyPageKey(event, "up", row)) {
                event.preventDefault();
                void loadOlder();
              } else if (after && !overlayOpen && !newerStatus && !isAwayFromLatest(event.currentTarget) && historyPageKey(event, "down", row)) {
                event.preventDefault();
                void loadNewer();
              }
            }}>
            {before && <li className="mtg-history-more mtg-history-start">
              <button type="button" className="mtg-action" aria-disabled={olderLoading} aria-busy={olderLoading}
                onClick={() => { if (!olderLoading) void loadOlder(); }}>
                {olderError ? tr("Retry earlier messages") : tr("Load earlier messages")}
              </button>
              {olderLoading && <span role="status" className="mtg-visually-hidden">{tr("Loading earlier messages…")}</span>}
              {olderError && <p role="alert">{tr("Could not load earlier messages. Try again.")}</p>}
            </li>}
            {predecessor && live?.loadNotificationChat && <MigrationHistoryLink key={`${activeId}:${predecessor.id}`} group={predecessor}
              destination="earlier group" open={openMigratedConversation} />}
            {!live && <li className="mtg-date"><span>{tr("Today")}</span></li>}
            {live && active && !selectedHistory?.page?.messages && !selectedHistory?.error && <li className="mtg-empty" role="status">{tr("Loading messages…")}</li>}
            {selectedHistory?.error && <li className="mtg-empty" role="alert">{selectedHistory.error} <button type="button" className="mtg-action" onClick={() => setHistoryAttempt((attempt) => attempt + 1)}>{tr("Retry")}</button></li>}
            {live && selectedHistory?.page?.messages && messages.length === 0 && <li className="mtg-empty">{tr("No messages")}</li>}
            <NotePlaybackQueueProvider key={activeId} messages={messages} enabled={!!live && !overlayOpen}>
            {groupMessageTimeline(messages).flatMap(({ day, group, albumKey }) => {
              const albumCaption = sharedAlbumCaption(group);
              const forwardedAlbum = sharedForwardedAlbum(group);
              const renderAuthor = (message: Message) => message.author && (!message.outgoing || active?.subtitle === "Group" && message.sender) &&
                <MessageAuthor message={message} chat={active} load={live?.loadAvatar}
                  search={live?.searchMessages && active?.subtitle === "Group" && !message.retained && message.sender
                    ? () => setSearchView((previous) => ({
                      chatId: activeId, author: { sender: message.sender!, name: message.author },
                      revision: (previous?.revision ?? 0) + 1,
                    }))
                    : undefined} />;
              const groupPhotos = group[0]?.albumId ? photoTimeline(group) : albumPhotos;
              const rows = group.map((message) => message.service && !message.retained
                ? <ServiceMessageRow key={message.id} message={message}
                  openMessage={live?.loadMessageContext && !deletedIds?.has(message.gameScoreTargetId ?? message.pinnedTargetId ?? "")
                    ? (id) => setSearchView({ chatId: activeId, messageId: id }) : undefined} /> : <li key={message.id} data-message-id={message.id} tabIndex={-1} onContextMenu={openMessageMenu} onKeyDown={messageMenuKey}
                  aria-describedby={message.id === firstUnread ? unreadDividerId : undefined} data-album-id={message.albumId} className={`mtg-message${message.outgoing ? " mtg-outgoing" : ""}`}
                  data-sticker={(message.collectionKind === "sticker" || message.tgsSticker) || undefined}
                  data-photo={(message.hasPhoto && !message.oneView && message.collectionKind !== "sticker" && !message.tgsSticker) || undefined}>
                {selection.checkbox(message)}
                <MessageBubble>
                  {!forwardedAlbum && renderAuthor(message)}
                  {message.replyTo && <blockquote className="mtg-reply-quote">
                    {deletedIds?.has(message.replyTo) ? tr("Original message unavailable")
                      : live?.loadMessageContext
                        ? <button type="button" className="mtg-open-reply" aria-label={tr("Open original message")}
                          onClick={() => setSearchView({ chatId: activeId, messageId: message.replyTo, quote: message.replyQuoteAnchor })}>
                          {message.replyQuote ?? displayMessagePreview(byId.get(message.replyTo), tr) ?? tr("Earlier message")}
                        </button>
                        : message.replyQuote ?? displayMessagePreview(byId.get(message.replyTo), tr) ?? tr("Earlier message")}
                  </blockquote>}
                  {message.retained && <p className="mtg-retained-message">
                    {message.retained === "expired" ? tr("Media expired · kept locally") : tr("Deleted in Telegram · kept locally")}
                  </p>}
                  <MessageContent conversationPhotos chatId={activeId} message={message} forwardedInAlbum={!!forwardedAlbum} autoplayLimits={autoplayLimits} drawPhotoReply={drawPhotoReply}
                    automaticEffect={readVisibleHistory && automaticEffect?.chatId === activeId && automaticEffect.messageId === message.id
                      && automaticEffect.effectId === message.effectId ? automaticEffect.playback : undefined}
                    loadGroupEmoji={active?.subtitle === "Group" ? live?.loadGroupEmoji : undefined}
                    openReplyTimestamp={live?.loadMessageContext && message.replyTo && !deletedIds?.has(message.replyTo)
                      ? (id, time) => setSearchView({ chatId: activeId, messageId: id, replyPlayback: { time } }) : undefined}
                    loadMessageLink={active?.subtitle === "Channel" || active?.subtitle === "Group" ? live?.loadMessageLink : undefined} hideCaption={albumCaption?.message === message} albumPhotos={groupPhotos} openPhotoMessage={(id) => focusHistoryMessage(history.current, id)} mediaCollection={live?.mediaCollection} loadVideoStream={live?.loadVideoStream} transcribeVoice={live?.transcribeVoice} loadPhoto={live?.loadPhoto} loadMedia={live?.loadMedia} saveDocument={live?.saveDocument} forwardActions={forwardActions} reactionActions={live?.reactionActions} stopPoll={live?.stopPoll} voteInPoll={live?.voteInPoll} />
                  {live?.loadChannelDiscussion && active?.subtitle === "Channel" && message.commentCount !== undefined
                    && <button type="button" className="mtg-action" onClick={() => {
                      setSearchView(undefined);
                      setDiscussion({ chatId: activeId, postId: message.id });
                    }}>{message.commentCount ? tr("Comments ({0})", [message.commentCount]) : tr("Comments")}</button>}
                  <MessageFooter chatId={activeId} message={message} selectionActions={(dismiss) => selection.actionsFor(message, dismiss)} beforeTime={message.viewCount !== undefined && <ChannelViewCount count={message.viewCount} />}
                    afterTime={message.outgoing && !message.pendingDelivery && readOutbox !== undefined && /^[1-9]\d{0,15}$/.test(message.id) && (
                      live?.messageReadTime && active?.subtitle === "Direct message" && live.list !== "saved"
                        && !message.retained && Number(message.id) <= readOutbox
                        ? <ReadTimeButton key={`read-time-button:${activeId}`} chatId={activeId} messageId={message.id} load={live.messageReadTime} />
                        : <span role="img" aria-label={Number(message.id) <= readOutbox ? tr("Read") : tr("Sent")}
                          title={Number(message.id) <= readOutbox ? tr("Read") : tr("Sent")}>
                          {Number(message.id) <= readOutbox ? <CheckCheck size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        </span>
                    )} reply={live && active && canCompose && !message.retained && /^[1-9]\d{0,15}$/.test(message.id) && <button type="button" className="mtg-reply-action"
                      data-swipe-reply={!message.pendingDelivery && !message.failedDelivery ? true : undefined}
                      aria-label={tr("Reply to message")} title={live.externalReplyDraft && active.subtitle === "Group" ? tr("Reply (Ctrl/⌘-click to choose another chat)") : tr("Reply")}
                      disabled={sendingDraft || currentAttachmentStatus?.preparing}
                      onMouseDown={(event) => {
                        if (event.button === 0 && selectedReplyQuote(history.current, message)) event.preventDefault();
                      }} onClick={(event) => {
                        const selectedQuote = selectedReplyQuote(history.current, message);
                        const target = selectedQuote ? { ...message, selectedQuote } : message;
                        if (selectedQuote) event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();
                        if (live.externalReplyDraft && active.subtitle === "Group" && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey) {
                          openReplyPicker(!selectedQuote && replyTarget?.id === message.id && !replyTarget.origin ? replyTarget : target);
                          return;
                        }
                        setReplyTargets((previous) => ({ ...previous, [active.id]: target }));
                        draftInput.current?.focus();
                      }}><Reply size={15} aria-hidden="true" /></button>}>
                    <MessageViewerAction key="viewer-slot" chatId={activeId} message={message}
                      load={active?.subtitle === "Group" ? live?.messageViewers : undefined} loadAvatar={live?.loadAvatar} />
                    {live && !message.retained && !message.pendingDelivery && <CopyMessageReference key={`reference:${activeId}`}
                      chatId={activeId} messageId={message.id} forumTopicId={message.forumTopicId} />}
                    {live?.loadMessageLink && active && (active.subtitle === "Channel" || active.subtitle === "Group")
                      && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                      <CopyTelegramLink chatId={activeId} messageId={message.id} load={live.loadMessageLink} />
                    )}
                    {live?.pinStatus && live.setMessagePinned && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                      <MessagePin key={`pin:${activeId}`} chatId={activeId} messageId={message.id}
                        extraMode={active?.subtitle === "Group" ? "notify"
                          : active?.subtitle === "Direct message" && live.list !== "saved" ? "self" : undefined}
                        pinStatus={live.pinStatus} setMessagePinned={live.setMessagePinned} />
                    )}
                    {live?.deletionOptions && live.deleteMessage && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && (
                      <MessageDeletion key={`delete:${activeId}`} chatId={activeId} messageId={message.id}
                        deletionOptions={live.deletionOptions} deleteMessage={live.deleteMessage} />
                    )}
                    {active && (live?.editText && message.editable || live?.editCaption && message.editableCaption) && <button type="button" className="mtg-reply-action"
                      aria-label={message.editableCaption ? tr("Edit caption") : tr("Edit message")} title={tr("Edit")} disabled={editing?.busy} onClick={() => {
                        setEditing({ chat: active.id, message, text: editableMessageText(message), busy: false });
                      }}><Pencil size={15} aria-hidden="true" /></button>}

                  </MessageFooter>
                </MessageBubble>
              </li>);
              const first = group[0]!;
              const unreadIndex = firstUnread ? group.findIndex(({ id }) => id === firstUnread) : -1;
              const divider = unreadIndex < 0 ? undefined : <li key={`unread:${firstUnread}`} ref={unreadDivider}
                id={unreadDividerId} className="mtg-date mtg-history-day mtg-unread-divider">{tr("Unread messages")}</li>;
              if (unreadIndex > 0 && divider) rows.splice(unreadIndex, 0, divider);
              const entry = first.albumId ? [<MessageAlbum key={albumKey} first={first} caption={albumCaption}
                messages={group} chatId={activeId} forward={forwardActions}
                forwardedHeader={forwardedAlbum && <>
                  {renderAuthor(forwardedAlbum)}
                  <ForwardedFrom name={forwardedAlbum.forwardedFrom ?? ""} source={forwardedAlbum.forwardedPost}
                    from={{ chatId: activeId, messageId: forwardedAlbum.id, topicId: forwardedAlbum.forumTopicId }} />
                </>}
                loadMessageLink={active?.subtitle === "Group" || active?.subtitle === "Channel" ? live?.loadMessageLink : undefined}>{rows}</MessageAlbum>] : rows;
              if (unreadIndex === 0 && divider) entry.unshift(divider);
              if (!day) return entry;
              const date = first.timestamp && localDateInputValue(first.timestamp);
              return [<li key={`day:${first.id}`} className="mtg-date mtg-history-day">
                {date && live?.loadMessageAtDate && live.loadMessageContext
                  ? <button type="button" className="mtg-history-day-jump" aria-label={tr("Jump to date from {0}", [day])}
                    onClick={() => setSearchView({ chatId: activeId, day: date })}>{day}</button>
                  : day}
              </li>, ...entry];
            })}
            </NotePlaybackQueueProvider>
            {after && <li className="mtg-history-more">
              <button type="button" className="mtg-action" disabled={newerStatus === "loading"} onClick={() => void loadNewer()}>
                {newerStatus === "loading" ? tr("Loading newer messages…") : newerStatus === "failed" ? tr("Retry newer messages") : tr("Load newer messages")}
              </button>
            </li>}
            {migration?.group && live?.loadNotificationChat && <MigrationHistoryLink key={`${activeId}:${migration.group.id}`}
              group={migration.group} destination="supergroup" open={openMigratedConversation} />}
            {!overlayOpen && !editing && !after && deferredLatest?.id !== activeId && selectedHistory?.page
              && unreadChannelList !== undefined && (nextUnreadChannel || live?.findNextUnreadChannel) && <li className="mtg-history-more">
              <button type="button" className="mtg-action" disabled={channelLookupStatus === "loading"}
                onClick={() => void openNextUnreadChannel()}>
                {channelLookupStatus === "loading" ? tr("Finding unread channels…") : nextUnreadChannel
                  ? <>{tr("Next unread channel · ")}<bdi>{nextUnreadChannel.name}</bdi></> : tr("Find next unread channel")}
              </button>
              {!nextUnreadChannel && channelLookupStatus === "empty" && <p role="status">{tr("No unread channels.")}</p>}
              {channelLookupStatus === "failed" && <p role="status">{tr("Could not find an unread channel. Try again.")}</p>}
            </li>}
          </ol>
          {!overlayOpen && resumePlace?.chatId === activeId && !deletedIds?.has(resumePlace.messageId)
            && (selectedHistory?.page || selectedHistory?.error)
            && (byId.has(resumePlace.messageId) || live?.loadMessageContext) && <button type="button" className="mtg-action mtg-latest"
              onClick={() => {
                setResumePlace(undefined);
                if (byId.has(resumePlace.messageId)) focusHistoryMessage(history.current, resumePlace.messageId);
                else setSearchView({ chatId: activeId, messageId: resumePlace.messageId });
              }}>{tr("Resume reading")}</button>}
          {!overlayOpen && canJumpToUnread && <button type="button" className="mtg-action mtg-latest"
            disabled={unreadJump?.id === activeId && unreadJump.state === "loading"}
            onClick={() => void jumpToUnread()}>{tr("Jump to unread")}</button>}
          {!overlayOpen && canJumpToUnread && unreadJump?.id === activeId && unreadJump.state === "unavailable"
            && <p role="status">{tr("Telegram could not locate the first unread message.")}</p>}
          {!overlayOpen && active && (awayFromLatest || deferredLatest?.id === activeId) && <div className="mtg-history-float"><Button type="button" variant="secondary" size="icon"
            className="mtg-latest mtg-latest-icon"
            aria-label={latestJump === "loading" ? tr("Loading latest messages…") : latestJump === "failed" ? tr("Retry jump to latest") : tr("Jump to latest")}
            aria-busy={latestJump === "loading"} aria-disabled={latestJump === "loading"}
            onClick={() => void jumpToLatest()}>{latestJump === "loading" ? <LoaderCircle size={16} aria-hidden="true" /> : <ArrowDown size={17} aria-hidden="true" />}</Button></div>}
          {uploading && <div className="mtg-send-status">
            {uploading.telegram ? <>
              <progress aria-label={tr("Document upload to Telegram")} max={uploading.telegram.total} value={uploading.telegram.uploaded} />
              <span> {uploading.telegram.uploaded === uploading.telegram.total ? tr("Waiting for Telegram to confirm delivery.")
                : tr("{0}% uploaded to Telegram", [Math.floor(uploading.telegram.uploaded / uploading.telegram.total * 100)])}</span>
            </> : <><progress aria-label={tr("Document upload to BB")} max={uploading.total} value={uploading.uploaded} />
            <span> {uploading.uploaded === uploading.total
              ? uploading.canCancel ? tr("Preparing file for Telegram.") : tr("Uploaded to BB. Waiting for Telegram.")
              : tr("{0}% uploaded to BB", [Math.floor(uploading.uploaded / uploading.total * 100)])}</span></>}
            {uploading.canCancel && <button type="button" className="mtg-action" onClick={() => {
              const control = uploadControls.current.get(activeId);
              if (!control?.canCancel) return;
              control.canCancel = false;
              control.controller.abort();
              setUploadProgress((previous) => ({ ...previous, [activeId]: { ...uploading, canCancel: false } }));
            }}>{tr("Cancel upload")}</button>}
          </div>}
          {(sendStatus[activeId] || longDraftDelivery[activeId]) && <p className="mtg-send-status" role="status">{
            sendingDraft ? tr("Sending…")
              : longDraftUnconfirmed ? tr("Telegram did not confirm delivery. Check the conversation before sending again.")
              : uploadRejections[activeId] === "legacy_tdlib" ? tr("Update TDLib to send documents this large.")
              : uploadRejections[activeId] === "premium_required" ? tr("Telegram Premium is required to send documents over 2000 MiB.")
              : uploadRejections[activeId] === "file_too_large" ? tr("Telegram supports uploads up to 4000 MiB.")
              : uploadRejections[activeId] === "video_preparation_failed" ? attachment?.options?.videoEdit
                ? tr("BB could not apply the video edits. Your draft is still here.")
                : attachment?.options?.originalVideo
                ? tr("Original video quality is unavailable for this file. Your file and caption are still here.")
                : tr("BB could not prepare this file for video playback. Your file and caption are still here.")
              : uploadRejections[activeId] === "reply_unavailable" ? tr("The original message is unavailable. Your draft is still here.")
              : sendStatus[activeId] === "scheduled" ? tr("Attachment scheduled.")
              : sendStatus[activeId] === "cancelled" ? tr("Upload cancelled. Your draft is still here.")
              : sendStatus[activeId] === "failed"
              ? tr("Telegram rejected the message. Your draft is still here.")
              : tr("Telegram did not confirm delivery. Check the conversation before sending again.")
          }</p>}
          {!overlayOpen && !edit && canAttachDocument && attachment?.kind === "video" && uploadRejections[activeId] === "video_preparation_failed" &&
            <button type="button" className="mtg-action" onClick={() => {
              setAttachments((previous) => previous[activeId] !== attachment ? previous : {
                ...previous, [activeId]: { kind: "document", name: attachment.name, file: attachment.file, delivery: attachment.delivery },
              });
              setUploadRejections((previous) => ({ ...previous, [activeId]: undefined }));
              setSendStatus((previous) => ({ ...previous, [activeId]: undefined }));
            }}>{tr("Attach original as document")}</button>}
          {!overlayOpen && edit && <MessageEdit key={`${edit.chat}:${edit.message.id}`} draft={edit} change={(text) => setEditing({ ...edit, text })}
            cancel={() => setEditing(undefined)} save={saveEdit}
            groupEmoji={active?.subtitle === "Group" && live?.loadGroupEmoji ? { id: edit.chat, load: live.loadGroupEmoji } : undefined}
            replacePhoto={live?.replacePhoto && edit.message.photoEditRevision ? replaceEditedPhoto : undefined}
            replaceAttachment={live?.replaceAttachment && edit.message.attachmentEdit ? replaceEditedAttachment : undefined} />}
          {selection.toolbar}
          <div className="mtg-compose-region" hidden={selection.active}>
          {!overlayOpen && !edit && replyTarget && <div className="mtg-reply-preview">
            <div><strong>{replyDeleted ? tr("Original message was deleted") : tr("Replying to {0}{1}", [replyTarget.author, externalReply ? " in another conversation" : ""])}</strong>
              {!replyDeleted && (!externalReply || replyTarget.selectedQuote) && <p>{replyTarget.selectedQuote?.text ?? displayMessagePreview(replyTarget, tr)}</p>}
              {!replyDeleted && !externalReply && canSendText && !attachment && !currentAttachmentStatus?.preparing && replyTarget.canQuote &&
                <SelectReplyQuote key={replyTarget.id} text={replyTarget.text} layout={replyTarget.richMessage} quote={replyTarget.selectedQuote}
                  disabled={sendingDraft} change={(selectedQuote) =>
                    setReplyTargets((previous) => ({ ...previous, [activeId]: { ...replyTarget, selectedQuote } }))} />}
            </div>
            {live?.externalReplyDraft && active?.subtitle === "Group" && !externalReply && !replyDeleted
              && <button type="button" className="mtg-action" onClick={() => openReplyPicker(replyTarget)}>{tr("Reply in another chat")}</button>}
            <button type="button" aria-label={tr("Cancel reply")} title={tr("Cancel reply")}
              onClick={() => {
                setReplyTargets((previous) => ({ ...previous, [activeId]: undefined }));
                draftInput.current?.focus();
              }}><X size={17} aria-hidden="true" /></button>
          </div>}
          <ComposerActions>
          {active && !overlayOpen && !edit && !attachment && !replyDeleted && canAttachDocument
            && !currentAttachmentStatus?.preparing && !sendingDraft
            && <ArchiveAttachment key={activeId} controller={archivePicker} preparing={archivePreparing}
              setPreparing={setArchivePreparing} attach={(file) => void chooseAttachment(file, activeId, "document")} />}
          {active && !overlayOpen && !edit && attachment && <div className="mtg-reply-preview">
            {attachment.kind === "photo" && ("data" in attachment
              ? <img className="mtg-attachment-preview" src={`data:image/jpeg;base64,${attachment.data}`} alt={tr("Selected photo")} />
              : <AttachmentPhotoPreview file={attachment.file} alt={tr("Selected photo")} />)}
            <div><p>{attachment.name}</p>{draft.trim().length > 1024 && <p role="alert">{tr("Caption must be at most 1024 characters.")}</p>}
              {attachment.kind === "photo" && <EditDraftPhoto key={`photo-draft:${activeId}`} source={"data" in attachment ? attachment.data : attachment.file}
                disabled={sendingDraft || currentAttachmentStatus?.preparing} apply={(data) =>
                  setAttachments((previous) => previous[activeId] === attachment
                    ? { ...previous, [activeId]: { kind: "photo", name: attachment.name, options: attachment.options, delivery: attachment.delivery,
                      data, drawnPhotoReply: drawnReply, originalFile: originalAttachment(attachment) } }
                    : previous)} />}
              {attachment.kind === "video" && (!paidStars || attachmentAsGif) && <VideoAttachmentEdits key={`video-draft:${activeId}`} file={attachment.file}
                options={attachment.options} allowGif={allowVideoAsGif} disabled={sendingDraft} change={(options) =>
                  setAttachments((previous) => previous[activeId] === attachment
                    ? { ...previous, [activeId]: { ...attachment, options } } : previous)} />}
              <AttachmentDeliveryControls draft={attachment.delivery} disabled={sendingDraft} onlineAllowed={onlineAttachmentAllowed}
                change={(delivery) => setAttachments((previous) => previous[activeId] === attachment
                  ? { ...previous, [activeId]: { ...attachment, delivery } } : previous)} />
              {attachment.kind !== "document" && <MediaSendControls kind={attachmentAsGif ? "GIF" : attachment.kind} options={attachment.options} hasCaption={!!draft.trim()}
                allowOriginalVideo={attachment.kind === "video" && !attachmentAsGif && !paidStars && !attachment.options?.videoEdit}
                disabled={sendingDraft} change={(options) =>
                  setAttachments((previous) => previous[activeId] === attachment
                    ? { ...previous, [activeId]: { ...attachment, options } } : previous)} />}
              {canAttachDocument && attachment.kind !== "document" && originalAttachment(attachment) &&
                <button type="button" className="mtg-action" disabled={sendingDraft || currentAttachmentStatus?.preparing}
                  onClick={() => void chooseAttachment(originalAttachment(attachment), activeId, "document", attachment.delivery)}>{tr("Send original as file")}</button>}
            </div>
            <button type="button" aria-label={tr("Remove {0}", [attachment.kind])} disabled={sendingDraft}
              onClick={() => setAttachments((previous) => ({ ...previous, [activeId]: undefined }))}><X size={17} aria-hidden="true" /></button>
          </div>}
          {active && !overlayOpen && !edit && currentAttachmentStatus?.preparing && <p className="mtg-send-status" role="status">{tr("Preparing photo…")}</p>}
          {active && !overlayOpen && !edit && currentAttachmentStatus?.error && <p className="mtg-send-status" role="alert">{currentAttachmentStatus.error}</p>}
          {active && !overlayOpen && !edit && !canCompose && (!migration?.group || !live?.loadNotificationChat) && <p className="mtg-send-status" role="status">
            {migration ? tr("This group moved to a supergroup and is read-only.")
              : permissions === undefined ? tr("Checking posting permission…") : permissions === null ? tr("Could not check posting permission.") : tr("Your account cannot send messages in this chat.")}
          </p>}
          {active && !overlayOpen && !edit && canCompose && permissions?.postingSender &&
            <p className="mtg-send-status">{tr("Sending as ")}<bdi>{permissions.postingSender}</bdi></p>}
          {active && !overlayOpen && !edit && draftStashNotice?.chatId === activeId &&
            <p className="mtg-send-status" role="status">{draftStashNotice.text}</p>}
          {active && !overlayOpen && !edit && preparedDraft && <LinkDraftInsert draft={preparedDraft}
            currentText={draft} input={draftInput} disabled={cannotInsertLinkDraft}
            currentFormatting={{ styles: formatting.ranges, links: formatting.links }}
            requiresRemoteDraft={!!savedDraft && drafts[activeId] === undefined}
            insert={(text, ranges) => {
              if (ranges) {
                formatting.restore({ text, ...ranges });
                setDrafts((previous) => ({ ...previous, [activeId]: text }));
              } else changeDraft(text);
            }} dismiss={() => setLinkDraft(undefined)} />}
          {active && !overlayOpen && !edit && canSendText && savedDraft && drafts[activeId] === undefined
            && !attachment && !replyTarget && <ComposerActionEntry primary><button type="button" className="mtg-action" onClick={() => {
              setDrafts((previous) => previous[activeId] === undefined ? { ...previous, [activeId]: savedDraft.text } : previous);
              formatting.restore(savedDraft);
              setLinkPreviews((previous) => ({ ...previous, [activeId]: restoreDraftPreview(savedDraft) }));
              draftInput.current?.focus();
            }}>{tr("Use Telegram draft")}</button></ComposerActionEntry>}
          {active && !overlayOpen && !edit && canSendText && !attachment && !replyTarget && selectedHistory?.page
            && live?.saveChatDraft && draft.length <= maxTelegramTextLength && (conflict || draft.trim() || (drafts[activeId] !== undefined && savedDraft)) && <ComposerActionEntry primary keepOpen><div className="mtg-composer-media mtg-draft-sync">
              {conflict && live.loadChatDraft && !conflict.reviewed && <button type="button" className="mtg-action"
                disabled={draftSyncStatus[activeId] === "Loading…"} onClick={() => {
                  const load = live.loadChatDraft;
                  if (!load || draftSyncBusy.current.has(activeId)) return;
                  draftSyncBusy.current.add(activeId);
                  setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Loading…" }));
                  void load(activeId).then((reviewed) => {
                    setDraftConflict((previous) => ({ ...previous, [activeId]: { reviewed } }));
                    setDraftSyncStatus((previous) => ({ ...previous, [activeId]: reviewed.writable ? "" : "This Telegram draft cannot be replaced from BB." }));
                  }, () => setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Could not reload the Telegram draft." })))
                    .finally(() => draftSyncBusy.current.delete(activeId));
                }}>{tr("Review newer Telegram draft")}</button>}
              {conflict?.reviewed && <TelegramDraftReview remote={conflict.reviewed}
                disabled={draftSyncStatus[activeId] === "Saving…"} useDraft={(reviewed) => {
                  setRemote((previous) => previous?.id === activeId && previous.page
                    ? { ...previous, page: { ...previous.page, draft: reviewed ?? undefined } } : previous);
                  formatting.restore(reviewed ?? { text: "" });
                  setDrafts((previous) => ({ ...previous, [activeId]: reviewed?.text ?? "" }));
                  setLinkPreviews((previous) => ({ ...previous, [activeId]: reviewed ? restoreDraftPreview(reviewed) : undefined }));
                  setDraftConflict((previous) => ({ ...previous, [activeId]: undefined }));
                  setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "" }));
                  draftInput.current?.focus();
                }} />}
              <button type="button" className="mtg-action" disabled={draftSyncStatus[activeId] === "Saving…" ||
                !!(conflict && !conflict.reviewed?.writable)}
                onClick={() => {
                  const save = live.saveChatDraft;
                  if (!save || draftSyncBusy.current.has(activeId)) return;
                  draftSyncBusy.current.add(activeId);
                  setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Saving…" }));
                  const next = draft.trim() ? { text: draft, styles: formatting.ranges, links: formatting.links,
                    ...(formatting.customEmoji.length ? { customEmoji: formatting.customEmoji } : {}),
                    preview: savedDraftPreview(previewPlacement, draft, formatting.links.length > 0) } : null;
                  const expected = conflict?.reviewed ? conflict.reviewed.draft : savedDraft ?? null;
                  void save(activeId, next, expected).then((result) => {
                    if (result === "changed" && live.loadChatDraft) {
                      setDraftConflict((previous) => ({ ...previous, [activeId]: {} }));
                    } else if (result === "saved") {
                      setDraftConflict((previous) => ({ ...previous, [activeId]: undefined }));
                    }
                    setDraftSyncStatus((previous) => ({ ...previous, [activeId]: result === "saved"
                      ? draft.trim() ? "Draft saved to Telegram." : "Telegram draft cleared."
                      : result === "changed" ? "The Telegram draft changed. Check it and try again."
                      : "This Telegram draft cannot be replaced from BB." }));
                    live.refresh();
                  }, () => setDraftSyncStatus((previous) => ({ ...previous, [activeId]: "Could not save the Telegram draft." })))
                    .finally(() => draftSyncBusy.current.delete(activeId));
                }}>{draft.trim() ? tr("Save draft to Telegram") : tr("Clear Telegram draft")}</button>
              {draftSyncStatus[activeId] && <p role="status">{draftSyncStatus[activeId]}</p>}
            </div></ComposerActionEntry>}
          {active && !overlayOpen && !edit && live?.scheduledMessages && live.cancelScheduledMessage
            && (canSendText || canAttachDocument || canAttachVideo || canAttachPhoto) && !attachment
            && <ScheduledMessages key={`schedule:${activeId}`} chatId={activeId} liveRevision={live.liveRevision} draft={draft}
              loadGroupEmoji={active?.subtitle === "Group" ? live.loadGroupEmoji : undefined}
              textOptions={canSendText} canSend={canSendText && !longDraft && !replyDeleted && !archivePreparing && !sendingDraft}
              mediaLoaders={{ loadPhoto: live.loadPhoto, loadMedia: live.loadMedia, loadVideoStream: live.loadVideoStream, saveDocument: live.saveDocument }}
              saveSelectedAttachments={live.saveSelectedAttachments}
              editActions={{ editText: live.editText, editCaption: live.editCaption, replacePhoto: live.replacePhoto, replaceAttachment: live.replaceAttachment }}
              load={live.scheduledMessages} checkRepeat={live.canScheduleRepeats} checkOnline={chatList !== "saved" && active.subtitle === "Direct message" ? live.canScheduleWhenOnline : undefined} cancel={live.cancelScheduledMessage} change={live.changeScheduledMessage}
              send={async (delivery) => {
                if (longDraft || sending.current.has(activeId) || archivePicker.current?.isPreparing()) return { state: "failed" };
                sending.current.add(activeId);
                setSendStatus((previous) => ({ ...previous, [activeId]: "pending" }));
                try { return await live.sendText(activeId, draft.trim(), replyTarget?.id, {
                  ...delivery, ...(selectedMessageEffect ? { effect: selectedMessageEffect.id } : {}),
                  ...(externalReply ? { externalReplyChatId: externalReply.chatId } : {}),
                  ...(permissions?.postingSenderKey ? { expectedPostingSender: permissions.postingSenderKey } : {}),
                  ...linkPreviewDelivery(previewPlacement, draft.trim()), ...(sendStyles.length ? { styles: sendStyles } : {}), ...(sendLinks.length ? { links: sendLinks } : {}),
                  ...(sendEmoji.length ? { customEmoji: sendEmoji } : {}),
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
                if (selectedMessageEffect) setDraftEffects((previous) => previous[activeId] === selectedMessageEffect
                  ? { ...previous, [activeId]: undefined } : previous);
                setLinkPreviews((previous) => ({ ...previous, [activeId]: undefined }));
                formatting.clearSent(activeId, text);
                if (!scheduled) setSent((previous) => ({ ...previous, [activeId]: [...(previous[activeId] ?? []), result.message] }));
                setDrafts((previous) => previous[activeId]?.trim() === text ? { ...previous, [activeId]: "" } : previous);
                setReplyTargets((previous) => previous[activeId]?.id === replyTarget?.id
                  ? { ...previous, [activeId]: undefined } : previous);
              }} />}
          {active && !overlayOpen && !edit && !replyDeleted && !attachment && live?.mediaComposer
            && (canAttachPhoto || canAttachVideo || canAttachDocument || canAttachAudio || permissions?.voice || permissions?.videoNote || permissions?.otherMedia || canSendText)
            && <MediaComposer controller={mediaController} draftStash={draftStash}
              groupEmoji={active.subtitle === "Group" && live.loadGroupEmoji ? { id: activeId, load: live.loadGroupEmoji } : undefined}
              paidMessageStars={paidStars} groupStickers={active.subtitle === "Group"} key={`media:${activeId}:${replyTarget?.origin?.chatId ?? ""}:${replyTarget?.id ?? ""}`}
              richDraftStorage={draftStorage && { key: activeId, record: draftStorage.chats.rich, replies: draftStorage.chats.richReplies }}
              draftContext={{ destination: { chatId: activeId }, reply: replyTarget, checkExternalReply: live.externalReplyAllowed,
                actionsForReply: (reply) => live.mediaComposer!(activeId, undefined, reply) }}
              actions={mediaReply ? live.mediaComposer(activeId, undefined, mediaReply) : live.mediaComposer(activeId)}
              albumEffects={active.subtitle === "Direct message" && chatList !== "saved" && live.loadMessageEffects
                ? { chatId: activeId, load: live.loadMessageEffects } : undefined}
              scheduleWhenOnline={active.subtitle === "Direct message" && chatList !== "saved" && live.canScheduleWhenOnline
                ? { chatId: activeId, check: live.canScheduleWhenOnline } : undefined}
              onSent={replyTarget && (() => setReplyTargets((previous) => previous[activeId] === replyTarget
                ? { ...previous, [activeId]: undefined } : previous))}
              photos={canAttachPhoto} audio={canAttachAudio} albumVideo={canAttachVideo} albumDocuments={canAttachDocument} basicMedia={canSendText}
              checklistAllowed={active.subtitle !== "Channel"} voice={!restrictedChat || permissions?.voice === true} videoNote={!restrictedChat || permissions?.videoNote === true} otherMedia={!restrictedChat || permissions?.otherMedia === true} />}
          {active && !overlayOpen && !edit && !replyDeleted && sendPoll && <PollComposer key={JSON.stringify([activeId, mediaReply])} chatId={activeId}
            reply={mediaReply} onSent={replyTarget && (() => setReplyTargets((previous) => previous[activeId] === replyTarget
              ? { ...previous, [activeId]: undefined } : previous))}
            allowVisibleVotes={active.subtitle === "Group"}
            loadChannelLimits={active.subtitle === "Channel" ? live?.loadChannelPollLimits : undefined} send={sendPoll} />}
          {active && !overlayOpen && !edit && canSendText && !attachment && previewAvailable &&
            <LinkPreviewControls choice={previewPlacement} text={draft} disabled={sendingDraft}
              change={(placement) => setLinkPreviews((previous) => ({ ...previous, [activeId]: placement }))} />}
          {active && !overlayOpen && !edit && canSendText && !attachment && !replyDeleted && inlineBot && live?.inlineBotActions &&
            <InlineBotSearch key={JSON.stringify([activeId, inlineBot.username, inlineBot.query, mediaReply])}
              {...inlineBot} chatId={activeId} preview={live.inlineBotActions.preview} disabled={sendingDraft}
              launchMiniApp={live.inlineBotActions.launchMiniApp && ((token) => live.inlineBotActions!.launchMiniApp!(activeId, token))}
              search={(username, query, offset) => live.inlineBotActions!.search(activeId, username, query, offset)}
              send={async (token) => {
                if (sending.current.has(activeId)) return { state: "failed" };
                sending.current.add(activeId);
                setSendStatus((previous) => ({ ...previous, [activeId]: "pending" }));
                try {
                  const result = await live.inlineBotActions!.send(activeId, token, undefined, mediaReply);
                  if (result.state === "sent") {
                    const message = result.message;
                    setSent((previous) => ({ ...previous, [activeId]: [...(previous[activeId] ?? []), message] }));
                    setDrafts((previous) => previous[activeId] === draft ? { ...previous, [activeId]: "" } : previous);
                    setReplyTargets((previous) => previous[activeId] === replyTarget ? { ...previous, [activeId]: undefined } : previous);
                    formatting.clearSent(activeId, draft.trim());
                    live.refresh();
                  }
                  return result;
                } finally {
                  sending.current.delete(activeId);
                  setSendStatus((previous) => ({ ...previous, [activeId]: undefined }));
                }
              }} />}
          {active && !overlayOpen && !edit && canSendText && !attachment && !replyTarget && chatList !== "saved" &&
            live?.replyBotActions && (active.subtitle === "Direct message" || active.subtitle === "Group") &&
            <ReplyBotKeyboard key={`reply-bot-keyboard:${activeId}`} chatId={activeId} liveRevision={liveRevision} actions={live.replyBotActions}
              disabled={sendingDraft} />}
          {active && !overlayOpen && !edit && !attachment && canCompose && chatList !== "saved"
            && active.subtitle === "Direct message" && live?.profileGifts?.showShortcut &&
            <ComposerGiftShortcut key={`composer-gift-shortcut:${activeId}`} id={activeId} recipient={active.name} actions={live.profileGifts} />}
          {active && !overlayOpen && !edit && canCompose && <Card className="mtg-composer-card"><form className="mtg-chat-composer" onSubmit={submit} onPaste={(event) => {
            if (!canAttachPhoto || sending.current.has(activeId)) return;
            const photo = Array.from(event.clipboardData.files).find((file) => isPhotoMimeType(file.type));
            if (!photo) return;
            event.preventDefault();
            void chooseAttachment(photo, activeId, "photo");
          }}>
            <ComposerActionMenu key={activeId} allowed={{ photo: canAttachPhoto, video: canAttachVideo, document: canAttachDocument }}
              disabled={sendingDraft} pickFiles={chooseChatFiles} pickFile={(file, kind) => void chooseAttachment(file, activeId, kind)} />
            {(canSendText || canAttachPhoto || attachment || canStashDraft) && <Textarea className="mtg-compose-field" ref={draftInput} rows={1} disabled={longDraftDelivery[activeId] === "sending"}
              aria-keyshortcuts={live && (canSendText || attachment) ? `${replyTarget ? "Escape " : attachment ? "" : "ArrowUp "}${draftFormattingShortcuts} ${draftLinkShortcuts}${canNavigateReply ? ` ${replyNavigationShortcuts}` : ""}${canStashDraft ? " Control+S" : ""}`
                : canStashDraft ? "Control+S" : replyTarget ? "Escape" : undefined}
              onKeyDown={(event) => {
                if (quickReplyControls.current?.handleDraftKey(event) || navigateChatReply(event)) return;
                if (canStashDraft && !sending.current.has(activeId) && !preparingAttachments.current.has(activeId)
                  && !archivePicker.current?.isPreparing() && isStashShortcut(event)) {
                  event.preventDefault();
                  if (event.repeat) return;
                  const current = { draft: { text: draft, styles: formatting.ranges,
                    links: formatting.links, customEmoji: formatting.customEmoji }, preview: linkPreviews[activeId], reply: replyTarget, attachment };
                  const destination = { chatId: activeId, text: canSendText, attachments: { photo: canAttachPhoto, video: canAttachVideo, document: canAttachDocument } };
                  function apply(restored: StashedDraft) {
                    if (attachment || restored.attachment) {
                      setAttachments((previous) => ({ ...previous, [activeId]: restored.attachment }));
                      setAttachmentStatus((previous) => ({ ...previous, [activeId]: undefined }));
                      setUploadRejections((previous) => ({ ...previous, [activeId]: undefined }));
                      setSendStatus((previous) => ({ ...previous, [activeId]: undefined }));
                    }
                    formatting.restore(restored.draft);
                    setDrafts((previous) => ({ ...previous, [activeId]: restored.draft.text }));
                    setLinkPreviews((previous) => ({ ...previous, [activeId]: restored.preview }));
                    setReplyTargets((previous) => ({ ...previous, [activeId]: restored.reply }));
                    typingActivity.stop();
                    setDraftStashNotice({ chatId: activeId, text: restored.draft.text || restored.reply || restored.attachment ? "Draft restored." : "Draft set aside." });
                  }
                  const next = draftStash.exchange(current, destination);
                  if (!next) return;
                  if (next === "differentConversation") {
                    const check = live?.externalReplyAllowed;
                    if (check && !paidStars) {
                      const stillCurrent = beginExternalReplyCheck();
                      setDraftStashNotice({ chatId: activeId, text: "Checking whether the reply can move here…" });
                      void draftStash.checkExternalReply(check).catch(() => undefined).then((proof) => {
                        if (!stillCurrent() || sending.current.has(activeId) || preparingAttachments.current.has(activeId)
                          || archivePicker.current?.isPreparing()) return;
                        const restored = proof && draftStash.exchange(current, destination, proof);
                        if (restored && typeof restored !== "string") apply(restored);
                        else setDraftStashNotice({ chatId: activeId, text: "This reply can only be restored in its original conversation." });
                      });
                    } else {
                      setDraftStashNotice({ chatId: activeId, text: "Open the original chat or topic to restore the stashed reply." });
                    }
                    return;
                  }
                  if (next === "album" || next === "rich") {
                    if (mediaController.current?.restoreStashedDraft(next)) {
                      setDraftStashNotice(undefined);
                      typingActivity.stop();
                    } else {
                      setDraftStashNotice({ chatId: activeId, text: next === "album"
                        ? "Open an album composer to restore the stashed album."
                        : "Open the formatted message editor to restore the stashed draft." });
                    }
                    return;
                  }
                  if (next === "unsupportedDraft") {
                    setDraftStashNotice({ chatId: activeId, text: "This chat cannot send the stashed draft." });
                    return;
                  }
                  apply(next);
                  return;
                }
                if (replyTarget && !sendingDraft && isPlainKey(event, "Escape")) {
                  event.preventDefault();
                  setReplyTargets((previous) => ({ ...previous, [activeId]: undefined }));
                  return;
                }
                if (live && (canSendText || attachment) && !sendingDraft) formatting.shortcut(event);
                composerKeys(event, () => {
                  if (!live || !active || !canSendText || attachment || replyTarget || sendingDraft) return false;
                  const message = lastEditableMessage(messages, live);
                  if (!message) return false;
                  setEditing({ chat: active.id, message, text: editableMessageText(message), busy: false });
                  return true;
                });
              }} aria-label={attachment ? tr("Write an attachment caption") : !canSendText ? tr("Paste a photo or write a caption") : live ? tr("Write a message") : tr("Write a demo message")}
              placeholder={attachment ? tr("Write an attachment caption") : !canSendText ? tr("Paste a photo or write a caption") : live ? tr("Write a message") : tr("Write a demo message")}
              value={draft} maxLength={draftLimit} onBlur={typingActivity.stop} onChange={(event) => {
                const text = event.currentTarget.value;
                if (draftStashNotice?.chatId === activeId) setDraftStashNotice(undefined);
                changeDraft(text, event.currentTarget.selectionEnd);
                typingActivity.changed(text);
              }}
              onPaste={(event) => {
                if (live && (canSendText || attachment) && !sendingDraft) {
                  formatting.paste(event, (value) => setDrafts((previous) => ({ ...previous, [activeId]: value })));
                }
              }}
              onSelect={(event) => formatting.select(event.currentTarget, !!live && (canSendText || !!attachment))} />}
            <div className="mtg-composer-toolbar" role="group" aria-label={tr("Composer tools")}>
            {!canSendText && !attachment && <span>{canAttachVideo ? tr("Choose an attachment to send in this chat.")
              : canAttachPhoto && canAttachDocument ? tr("Only photos and documents can be sent in this chat.")
              : canAttachPhoto ? tr("Only photos can be sent in this chat.") : tr("Only documents can be sent in this chat.")}</span>}
            {live?.attachmentMiniApps && canSendText && !attachment && !replyTarget &&
              <ComposerActionEntry primary keepOpen><AttachmentMiniApps menu key={`attachment-mini-apps:${activeId}`} id={activeId} name={active.name} actions={live.attachmentMiniApps}
                disabled={sendingDraft} /></ComposerActionEntry>}
            {live?.loadBotCommands && canSendText && !attachment && chatList !== "saved"
              && (active?.subtitle === "Direct message" || active?.subtitle === "Group")
              && <ComposerActionEntry primary keepOpen><BotCommandMenu menu key={`bot-command-menu:${activeId}`} chatId={activeId} load={live.loadBotCommands} draft={draft}
                disabled={sendingDraft} apply={(value) => {
                  changeDraft(value);
                  draftInput.current?.focus();
                }} /></ComposerActionEntry>}
          {active?.subtitle === "Direct message" && canSendText && !paidStars && !overlayOpen && !edit && !attachment && !replyTarget
            && chatList !== "saved" && live?.quickReplies &&
            <QuickReplyComposer key={`quick-reply-composer:${activeId}`} chatId={activeId} {...live.quickReplies} draft={draft}
              disabled={sendingDraft} controls={quickReplyControls} focusDraft={() => draftInput.current?.focus()}
              onSubmitted={(command) => {
                if (command) {
                  formatting.clearSent(activeId, command);
                  setDrafts((previous) => previous[activeId] === command ? { ...previous, [activeId]: "" } : previous);
                }
                live.refresh();
              }} />}
            {(canSendText || attachment) &&
              <ComposerEmojiPickers manage compact key={`emoji:${activeId}`} disabled={sendingDraft}
                group={active.subtitle === "Group" && live?.loadGroupEmoji ? { id: activeId, load: live.loadGroupEmoji } : undefined}
                insert={(choice) => formatting.insertCustomEmoji(choice, (value) => {
                  setDrafts((previous) => ({ ...previous, [activeId]: value }));
                  typingActivity.changed(value);
                })} />}
            {live && (canSendText || attachment) && <DraftFormatButton formatting={formatting} busy={sendingDraft} floating />}
            {longDraft && <div className="mtg-long-draft">
              <p role="status">{canSplitText ? tr("This draft exceeds Telegram’s message limit. Choose how to send it.")
                : tr("Shorten this draft to send it as a message.")}</p>
              {canSplitText && <button type="button" className="mtg-action"
                disabled={!!replyDeleted || !!formatting.editingLink || archivePreparing || currentAttachmentStatus?.preparing || sendingDraft || longDraftUnconfirmed}
                onClick={() => void sendParts()}>{tr("Send as multiple messages")}</button>}
              {canSendTextFile && live && <button type="button" className="mtg-action"
                disabled={!!replyDeleted || archivePreparing || currentAttachmentStatus?.preparing || sendingDraft || longDraftUnconfirmed}
                onClick={() => {
                  if (archivePicker.current?.isPreparing() || preparingAttachments.current.has(activeId)) return;
                  void sendLive(live, activeId, "", replyTarget?.id, textDraftAttachment(draft), undefined, draft);
                }}>{tr("Send as text file")}</button>}
            </div>}
            {longDraftUnconfirmed && <button type="button" className="mtg-action" onClick={() => {
              setLongDraftDelivery((previous) => ({ ...previous, [activeId]: undefined }));
              setSendStatus((previous) => ({ ...previous, [activeId]: undefined }));
            }}>{tr("Allow retry after checking the conversation")}</button>}
            {live && paidStars !== undefined && <span>{attachment?.delivery?.date ? tr("Paid messages cannot be scheduled.") : tr("{0} Stars per message", [paidStars])}</span>}
            {live && paidStars !== undefined && paidReviewKey !== undefined && paidReview?.key === paidReviewKey && paidReview.attachment === attachment && <>
              <button type="button" onClick={() => setPaidReview(undefined)}>{tr("Cancel")}</button>
              <button type="button" disabled={!!replyDeleted || archivePreparing || sendingDraft} onClick={() => {
                if (archivePicker.current?.isPreparing()) return;
                setPaidReview(undefined);
                void sendLive(live, activeId, draft.trim(), replyTarget?.id, attachment, paidStars);
              }}>{tr("Send for ")}{paidStars}{tr(" Stars")}</button>
            </>}
            {canChooseMessageEffect && live?.loadMessageEffects && <ComposerActionEntry primary keepOpen><MessageEffectPicker menu key={`message-effect:${activeId}`} chatId={activeId}
              load={live.loadMessageEffects} selected={draftEffects[activeId]} disabled={sendingDraft}
              choose={(effect) => setDraftEffects((previous) => ({ ...previous, [activeId]: effect }))} /></ComposerActionEntry>}
            </div>
            <Button className="mtg-send" size="icon" type="submit" aria-label={live ? paidStars ? tr("Review paid message") : tr("Send message") : tr("Send demo message")} disabled={longDraft || longDraftUnconfirmed || !!replyDeleted || archivePreparing || (!!paidStars && !!attachment?.delivery?.date) || (attachment ? !canSendAttachment || draft.trim().length > 1024 || attachmentDelivery(attachment.delivery) === null || !!attachment.delivery?.whenOnline && !onlineAttachmentAllowed : !canSendText || !draft.trim()) || currentAttachmentStatus?.preparing || sendingDraft}><Send size={17} aria-hidden="true" /></Button>
            {live && (canSendText || attachment) && <DraftFormatControls formatting={formatting} busy={sendingDraft} floating />}
          </form></Card>}
          </ComposerActions>
          </div>
          </div>
          {sharedLibraryOpen && <div className="mtg-conversation-gallery">{conversationSearch}</div>}
          </MessageInspector>
        </section>
        {showInlineDetails && <div ref={setInlineDetailsTarget} className="mtg-inline-details" />}
        </ChatSenderBan.Provider>
        </NotePlaybackReceipt.Provider>
        </LoadMessagePoster.Provider>
        </ConversationTranslation.Provider>
        </MessageViewerScope>
      </div>
    </OpenInstantView.Provider></OpenMiniApp.Provider>{objectMenu.content}</div></MusicPlaybackProvider></PlaybackHistoryProvider></LocationMapLoader.Provider></TranslateMessageService.Provider></TranslationDefault.Provider></InstantViewPlaybackLoader.Provider></InstantViewIconLoader.Provider></InstantViewPhotoLoader.Provider></InstantViewMapLoader.Provider></InstantViewDocumentSaver.Provider></InstantViewLoader.Provider></OpenSharedContact.Provider></OpenExternalReply.Provider></OpenForwardedPost.Provider></OpenMessageStory.Provider></OpenReactionPerson.Provider></OpenInlineBotProfile.Provider></InstantViewMentionOpen.Provider></InstantViewTagSearch.Provider></InstantViewShare.Provider></UseInlineBotInOtherChat.Provider></UseInlineBotDraft.Provider></OpenTelegramMessageLink.Provider>
    </InstalledEmojiPacks.Provider>
  );
}

const joinMessages: Record<ChatJoinResult | "joining", string> = {
  joining: "Joining…",
  joined: "Joined.",
  requested: "Join request sent.",
  verification_required: "Open Telegram to complete the join verification.",
  subscribed: "Subscription paid. Telegram will add the channel to your chats.",
  refused: "Telegram declined the join request.",
  unknown: "Telegram did not confirm membership. Check before trying again.",
};

function InviteResult({ url, invite, join, refresh }: {
  url: string;
  invite: InvitePreview;
  join?: Live["joinInvite"];
  refresh?: () => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<ChatJoinResult | "joining">();
  const subscription = invite.mode === "subscription" ? invite.subscription : undefined;
  const payable = subscription?.payable && !subscription.reusable;
  async function joinChat() {
    if (!join || status === "joining" || (invite.mode === "subscription" && !subscription?.reusable && !payable)) return;
    setStatus("joining");
    const { title, kind, mode, chatId } = invite;
    const result = await join(url, { title, kind, mode, ...(chatId === undefined ? {} : { chatId }), ...(subscription && { subscription }) })
      .catch(() => "unknown" as const);
    setStatus(result);
    if (result === "joined" || result === "subscribed") refresh?.();
  }

  const canJoin = (invite.mode !== "subscription" || subscription?.reusable || payable) && join
    && status !== "requested" && status !== "joined" && status !== "subscribed" && status !== "verification_required" && !(payable && status === "unknown");
  return <>
    <strong><bdi>{invite.title}</bdi></strong>
    <p>{invite.kind}{invite.memberCount === undefined ? "" : tr(" · {0} members", [invite.memberCount.toLocaleString(uiLocale)])}</p>
    {subscription && <p>{subscription.reusable ? tr("Already paid for the current subscription period.")
      : tr("{0} Stars every {1}. Renews until canceled.", [subscription.stars.toLocaleString(uiLocale), formatStarBillingPeriod(subscription.period)])}</p>}
    {invite.mode === "subscription" && !subscription?.reusable && !payable && <p>
      <a href={canonicalTelegramInviteLink(url)} target="_blank" rel="noopener noreferrer">{tr("Open in Telegram to review the subscription")}</a>
    </p>}
    {canJoin && <button type="button" className="mtg-action" disabled={status === "joining"}
      onClick={() => void joinChat()}>{invite.mode === "request" ? tr("Request to join") : payable ? tr("Confirm Stars subscription") : tr("Join")}</button>}
    {status && <p role="status">{payable && status === "unknown"
      ? tr("Payment status is unconfirmed. Check Stars transactions before trying again.") : joinMessages[status]}</p>}
  </>;
}
