export const chatChangedChannel = "telegram-chat-changed";

import { z } from "zod";

export const authSchema = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["idle", "connecting", "disconnecting", "ready", "password"]) }),
  z.object({ state: z.literal("qr"), link: z.string().startsWith("tg://login?token=") }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type Auth = z.infer<typeof authSchema>;

export const maxPhotoBytes = 512 * 1024;
export const maxPhotoEdge = 1600;
export const maxDocumentUploadBytes = 512 * 1024;
export const documentDeliveryTimeoutMs = 2 * 60 * 60_000;
export const maxDocumentBytes = 4 * 1024 * 1024 * 1024;
export const maxStandardTelegramUploadBytes = 2000 * 1024 * 1024;
export const maxTelegramUploadBytes = 2 * maxStandardTelegramUploadBytes;
export const maxVideoNoteBytes = 8 * 1024 * 1024;
export const maxVoiceBytes = 4 * 1024 * 1024;
export const maxPlaybackBytes = 32 * 1024 * 1024;
export const playbackMime = z.enum(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "video/mp4", "video/webm", "image/webp", "image/gif"]);
export type PlaybackMime = z.infer<typeof playbackMime>;
const documentInfo = z.object({
  name: z.string().min(1).max(180), downloadable: z.boolean(), playbackMime: playbackMime.optional(), caption: z.string().max(8192).optional(),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), approximateSize: z.boolean().optional(),
});
export type DocumentInfo = z.infer<typeof documentInfo>;

export const mediaCollectionKind = z.enum(["sticker", "gif"]);
export type MediaCollectionKind = z.infer<typeof mediaCollectionKind>;

const messageStyle = z.enum(["bold", "italic", "underline", "strike", "code", "spoiler"]);
export type MessageStyle = z.infer<typeof messageStyle>;
const styledRange = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), style: messageStyle });
export type StyledRange = z.infer<typeof styledRange>;

const captionPlacement = z.object({ above: z.boolean(), expected: z.boolean() });
export type CaptionPlacement = z.infer<typeof captionPlacement>;

const mediaSendOptions = z.object({ spoiler: z.boolean().optional(), captionAbove: z.boolean().optional() });
export type MediaSendOptions = z.infer<typeof mediaSendOptions>;
const gifSendOptions = mediaSendOptions.extend({ caption: z.string().trim().max(1024) });
export type GifSendOptions = z.infer<typeof gifSendOptions>;

export const forumTopicId = z.number().int().positive().max(2147483647);
const telegramDraftText = z.string().min(1).max(4096);
const topicDraft = z.object({ text: telegramDraftText.nullable(), writable: z.boolean() });
export type TopicDraft = z.infer<typeof topicDraft>;
const forumTopic = z.object({ id: forumTopicId, name: z.string().min(1).max(256), closed: z.boolean(), pinned: z.literal(true).optional(), draft: telegramDraftText.optional() });
export const forumTopicTarget = forumTopic.pick({ id: true, name: true });
export type ForumTopicTarget = z.infer<typeof forumTopicTarget>;
export type ForumTopic = z.infer<typeof forumTopic>;

export const pollChoice = z.object({ index: z.number().int().min(0).max(99), id: z.string().max(128).optional(), text: z.string().min(1).max(1024) });
export type PollChoice = z.infer<typeof pollChoice>;
const pollInfo = z.object({
  question: z.string().min(1).max(1024),
  options: z.array(pollChoice.extend({ chosen: z.boolean(),
    percentage: z.number().int().min(0).max(100).optional() })).min(1).max(100),
  closed: z.boolean(), canVote: z.boolean(), multiple: z.boolean(), quiz: z.boolean(),
  voters: z.number().int().nonnegative().optional(),
});
export type PollInfo = z.infer<typeof pollInfo>;

const reactionEmoji = z.string().trim().min(1).max(64);
const reactionType = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("emoji"), emoji: reactionEmoji }),
  z.object({ kind: z.literal("custom"), id: z.string().regex(/^-?[1-9]\d{0,19}$/) }),
  z.object({ kind: z.literal("paid") }),
]);
const messageReaction = z.object({ type: reactionType, count: z.number().int().nonnegative(), chosen: z.boolean() });
const messageReactions = z.object({ tags: z.boolean(), items: z.array(messageReaction).min(1).max(100) });
export type MessageReactions = z.infer<typeof messageReactions>;

export const messageSender = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().regex(/^[1-9]\d{0,15}$/) }),
  z.object({ kind: z.literal("chat"), id: z.string().regex(/^-[1-9]\d{0,15}$/) }),
]);
export type MessageSender = z.infer<typeof messageSender>;

const messageLinkPreview = z.object({
  url: z.string().max(4096), site: z.string().max(256), title: z.string().max(512),
  description: z.string().max(1024), above: z.boolean(),
});
export type MessageLinkPreview = z.infer<typeof messageLinkPreview>;

const messageSchema = z.object({
  id: z.string(), author: z.string(), time: z.string(), text: z.string(),
  timestamp: z.number().int().positive().max(2147483647).optional(),
  links: z.array(z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), url: z.string().max(4096), hidden: z.boolean().optional() })).max(128).optional(),
  styles: z.array(styledRange).max(128).optional(),
  outgoing: z.boolean().optional(),
  sender: messageSender.optional(),
  linkPreview: messageLinkPreview.optional(),
  service: z.literal(true).optional(),
  pinnedTargetId: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  voiceNote: z.literal(true).optional(),
  videoNote: z.literal(true).optional(),
  animation: z.literal(true).optional(),
  collectionKind: mediaCollectionKind.optional(),
  hasStickerPack: z.literal(true).optional(),
  albumId: z.string().regex(/^-?\d+$/).optional(),
  oneView: z.enum(["photo", "video"]).optional(),
  retained: z.enum(["deleted", "expired"]).optional(),
  isChannelPost: z.boolean().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  viewCount: z.number().int().min(0).max(2147483647).optional(),
  pendingDelivery: z.boolean().optional(),
  replyTo: z.string().optional(),
  replyQuote: z.string().min(1).max(4096).optional(),
  canQuote: z.literal(true).optional(),
  authorAvatar: z.object({ id: z.string().regex(/^-?[1-9]\d{0,15}$/), user: z.boolean(),
    fileId: z.number().int().positive().optional(), preview: z.string().max(8192).optional() }).optional(),
  forwardedFrom: z.string().max(256).optional(),
  forumTopicId: forumTopicId.optional(),
  threadRoot: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  editable: z.boolean().optional(),
  editableCaption: z.boolean().optional(),
  canMoveCaption: z.literal(true).optional(),
  edited: z.boolean().optional(),
  editedAt: z.number().int().positive().max(2147483647).optional(),
  channelSignature: z.string().min(1).max(256).optional(),
  document: documentInfo.optional(),
  poll: pollInfo.optional(),
  canStopPoll: z.boolean().optional(),
  reactions: messageReactions.optional(),
  hasPhoto: z.boolean().optional(),
  photoDimensions: z.object({
    width: z.number().int().positive().max(maxPhotoEdge),
    height: z.number().int().positive().max(maxPhotoEdge),
  }).optional(),
  photoSpoiler: z.boolean().optional(),
  canSavePhoto: z.literal(true).optional(),
  videoSpoiler: z.literal(true).optional(),
  captionAboveMedia: z.boolean().optional(),
  photoCaption: z.string().optional(),
});
export const chatAvatarSchema = z.string().min(8).max(8192).regex(/^\/9j\/[A-Za-z0-9+/]+={0,2}$/);
const chatSchema = z.object({
  id: z.string(), name: z.string(), initials: z.string(), color: z.string(), avatarJpeg: chatAvatarSchema.optional(), avatarFileId: z.number().int().positive().optional(),
  folderIds: z.array(z.number().int().positive().max(2147483647)).max(100).optional(),
  subtitle: z.string(), unread: z.number().optional(), unreadMentions: z.number().int().positive().max(2147483647).optional(), unreadReactions: z.number().int().positive().max(2147483647).optional(), markedUnread: z.boolean().optional(), archived: z.boolean().optional(), messages: z.array(messageSchema),
});
const chatListSchema = z.union([z.enum(["main", "archive", "saved"]), z.number().int().positive().max(2147483647)]);
export type ChatList = z.infer<typeof chatListSchema>;
const folderIcon = z.enum(["All", "Unread", "Unmuted", "Bots", "Channels", "Groups", "Private", "Custom", "Setup",
  "Cat", "Crown", "Favorite", "Flower", "Game", "Home", "Love", "Mask", "Party", "Sport", "Study",
  "Trade", "Travel", "Work", "Airplane", "Book", "Light", "Like", "Money", "Note", "Palette"]);
export const folderIconNames = folderIcon.options;
export type FolderIcon = z.infer<typeof folderIcon>;
const folderColor = z.number().int().min(-1).max(6);
const folderSchema = z.object({ id: z.number().int().positive(), title: z.string(), color: folderColor.optional(), icon: folderIcon.optional() });
export type TelegramFolder = z.infer<typeof folderSchema>;
export const folderRuleLabels = {
  include_contacts: "Contacts", include_non_contacts: "Non-contacts", include_bots: "Bots",
  include_groups: "Groups", include_channels: "Channels", exclude_muted: "Exclude muted",
  exclude_read: "Exclude read", exclude_archived: "Exclude archived",
} as const;
const folderRules = z.enum(["include_contacts", "include_non_contacts", "include_bots", "include_groups",
  "include_channels", "exclude_muted", "exclude_read", "exclude_archived"]);
const folderDraft = z.object({ title: z.string().trim().min(1).max(12), rules: z.array(folderRules).max(8), color: folderColor.optional(), icon: folderIcon.nullable().optional() });
export type FolderDraft = z.infer<typeof folderDraft>;
const recommendedFolderToken = z.string().regex(/^[a-f0-9]{64}$/);
const recommendedFolder = z.object({ token: recommendedFolderToken,
  title: z.string().min(1).max(12), description: z.string().max(512) });
export type RecommendedFolder = z.infer<typeof recommendedFolder>;
const folderInviteChatId = z.string().regex(/^-?[1-9]\d{0,15}$/);
const folderShareChat = z.object({ id: folderInviteChatId, title: z.string().min(1).max(256), upgradesGroup: z.boolean() });
export type FolderShareChat = z.infer<typeof folderShareChat>;
const folderInvite = z.object({ title: z.string().min(1).max(128), token: recommendedFolderToken,
  alreadyAdded: z.number().int().nonnegative(),
  chats: z.array(z.object({ id: folderInviteChatId, title: z.string().min(1).max(256) })).max(200) });
export type FolderInvite = z.infer<typeof folderInvite>;
const managedFolderInvite = z.object({ url: z.string().max(128), name: z.string().max(128), chatCount: z.number().int().nonnegative() });
const folderInviteEditor = z.object({ token: recommendedFolderToken,
  choices: z.array(folderShareChat).max(200), selected: z.array(folderInviteChatId).max(200) });
export type FolderInviteEditor = z.infer<typeof folderInviteEditor>;
export type ManagedFolderInvite = z.infer<typeof managedFolderInvite>;
const folderId = z.number().int().positive().max(2147483647);
const folderEditor = folderDraft.extend({ shareable: z.boolean(), canEditColor: z.boolean().optional() });
export type FolderEditor = z.infer<typeof folderEditor>;
const folderTagsState = z.object({ enabled: z.boolean(), editable: z.boolean() });
export type FolderTagsState = z.infer<typeof folderTagsState>;
const folderMembershipMode = z.enum(["include", "exclude", "automatic"]);
const folderMembership = z.object({ id: folderId, mode: folderMembershipMode, shareable: z.boolean() });
export type FolderMembership = z.infer<typeof folderMembership>;

const chatId = z.string().regex(/^-?\d{1,16}$/);
export const messageNotificationChannel = "telegram-message-notification";
export const messageNotificationSchema = z.object({
  chatId, messageId: z.string().regex(/^[1-9]\d{0,15}$/), topicId: forumTopicId.optional(),
  key: z.string().max(48), preview: z.string().max(160).optional(),
});
export type MessageNotification = z.infer<typeof messageNotificationSchema>;
export const messagesDeletedChannel = "telegram-messages-deleted";
export const messagesDeletedSchema = z.object({
  id: chatId,
  messageIds: z.array(chatId),
  retained: z.array(messageSchema).optional(),
}).refine(({ messageIds, retained }) => messageIds.length > 0 || !!retained?.length);
export type MessagesDeleted = z.infer<typeof messagesDeletedSchema>;

const deletionScope = z.enum(["self", "everyone"]);
export type DeletionScope = z.infer<typeof deletionScope>;
const messageReadTime = z.union([
  z.number().int().positive().max(2147483647),
  z.enum(["unavailable", "unread", "tooOld", "recipientPrivacy", "ownPrivacy"]),
]);
export type MessageReadTime = z.infer<typeof messageReadTime>;

const messageViewer = z.object({
  id: z.string().regex(/^[1-9]\d{0,15}$/), name: z.string().min(1).max(256),
  viewedAt: z.number().int().nonnegative().max(2147483647),
});
export type MessageViewer = z.infer<typeof messageViewer>;

const contextDirection = z.enum(["older", "newer"]);
export type ContextDirection = z.infer<typeof contextDirection>;

const messageReference = z.object({ id: chatId, messageId: z.string().regex(/^[1-9]\d{0,15}$/) });
export const chatDiscoveryCursor = z.object({ chatId, before: messageReference.shape.messageId.optional() }).strict();
export type ChatDiscoveryCursor = z.infer<typeof chatDiscoveryCursor>;
export const agentHistoryGrants = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,15}$/),
  chatIds: z.array(chatId),
});

const uploadRejection = z.enum(["legacy_tdlib", "premium_required", "file_too_large", "reply_unavailable"]);
export type UploadRejection = z.infer<typeof uploadRejection>;

const replyQuote = z.object({ text: z.string().min(1).max(1024), position: z.number().int().min(0).max(4095) });
export type ReplyQuote = z.infer<typeof replyQuote>;
const mediaReply = z.object({ messageId: z.string().regex(/^[1-9]\d{0,15}$/), quote: replyQuote.optional() });
export type MediaReply = z.infer<typeof mediaReply>;

export const scheduleRepeatPeriods = [86400, 604800, 1209600, 2592000, 7862400, 15724800, 31536000] as const;
const scheduleRepeatPeriod = z.literal(scheduleRepeatPeriods);
export type ScheduleRepeatPeriod = z.infer<typeof scheduleRepeatPeriod>;

const textDelivery = z.object({
  silent: z.boolean().optional(),
  linkPreview: z.boolean().optional(),
  linkPreviewAbove: z.literal(true).optional(),
  linkPreviewUrl: messageLinkPreview.shape.url.optional(),
  quote: replyQuote.optional(),
  styles: z.array(styledRange).max(128).optional(),
  at: z.number().int().positive().max(2147483647).optional(),
  whenOnline: z.literal(true).optional(),
  repeatEvery: scheduleRepeatPeriod.optional(),
}).refine(({ at, whenOnline, repeatEvery }) => (at === undefined || !whenOnline) && (repeatEvery === undefined || at !== undefined));
export type TextDelivery = z.infer<typeof textDelivery>;
const mediaDelivery = z.object({ silent: textDelivery.shape.silent, at: textDelivery.shape.at });
export type MediaDelivery = z.infer<typeof mediaDelivery>;

const topicDelivery = z.object({ silent: textDelivery.shape.silent, linkPreview: textDelivery.shape.linkPreview, linkPreviewAbove: textDelivery.shape.linkPreviewAbove, linkPreviewUrl: textDelivery.shape.linkPreviewUrl, at: textDelivery.shape.at, repeatEvery: textDelivery.shape.repeatEvery })
  .refine(({ at, repeatEvery }) => repeatEvery === undefined || at !== undefined);
export type TopicDelivery = z.infer<typeof topicDelivery>;
const scheduledTime = z.number().int().positive().max(2147483647);
const scheduledMessage = z.object({ id: chatId, text: z.string().max(8192), media: messageSchema.optional(), at: scheduledTime.optional(), whenOnline: z.literal(true).optional(), repeatEvery: scheduledTime.optional() });
export type ScheduledMessage = z.infer<typeof scheduledMessage>;

const sendResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sent"), message: messageSchema }),
  z.object({ state: z.literal("failed"), uploadRejection: uploadRejection.optional() }),
  z.object({ state: z.literal("unknown") }),
]);
export type SendResult = z.infer<typeof sendResult>;
export const pollDraft = z.object({
  question: z.string().trim().min(1).max(255),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(10)
    .refine((options) => new Set(options.map((option) => option.normalize("NFC").toLowerCase())).size === options.length),
  multiple: z.boolean(),
});
const pollSendResult = z.union([sendResult, z.object({ state: z.literal("unavailable") })]);
export type PollDraft = z.infer<typeof pollDraft>;
export type PollSendResult = z.infer<typeof pollSendResult>;
export type PollSender = (id: string, draft: PollDraft, topic?: ForumTopicTarget) => Promise<PollSendResult>;
export type DocumentSender = (id: string, file: File, caption: string,
  progress: (bytes: number, canCancel?: boolean) => void, signal: AbortSignal, topic?: ForumTopicTarget, replyTo?: string, video?: true, options?: MediaSendOptions
) => Promise<SendResult | { state: "cancelled" }>;

export const notificationScope = z.enum(["private", "groups", "channels"]);
export type NotificationScope = z.infer<typeof notificationScope>;
export const reactionNotificationAudience = z.enum(["none", "contacts", "all"]);
export type ReactionNotificationAudience = z.infer<typeof reactionNotificationAudience>;
export const chatMutePeriods = [3600, 28800, 86400, 604800] as const;
const chatMutePeriod = z.literal(chatMutePeriods);
export type ChatMutePeriod = z.infer<typeof chatMutePeriod>;
const chatNotificationMode = z.enum(["default", "muted", "unmuted"]);
export type ChatNotificationMode = z.infer<typeof chatNotificationMode>;
export const chatNotificationField = z.enum(["preview", "pinned", "mentions", "stories", "storyPoster"]);
export type ChatNotificationField = z.infer<typeof chatNotificationField>;
export const chatNotificationOverride = z.enum(["default", "show", "hide"]);
export type ChatNotificationOverride = z.infer<typeof chatNotificationOverride>;
const savedNotificationSoundId = z.string().regex(/^-?[1-9]\d{0,18}$/).refine((id) => {
  const negative = id.startsWith("-");
  const magnitude = negative ? id.slice(1) : id;
  return id !== "-1" && (magnitude.length < 19 || magnitude <= (negative ? "9223372036854775808" : "9223372036854775807"));
});
export const notificationSound = z.union([z.literal(["inherit", "-1", "0"]), savedNotificationSoundId]);
const notificationSoundId = z.union([z.literal(["-1", "0"]), savedNotificationSoundId]);
export const maxNotificationSoundBytes = 307200;
const savedNotificationSounds = z.array(z.object({ id: savedNotificationSoundId, title: z.string() }));
const reactionNotifications = z.object({ messages: reactionNotificationAudience, stories: reactionNotificationAudience,
  votes: reactionNotificationAudience.optional(), preview: z.boolean(), sound: notificationSoundId.optional() });
export type ReactionNotifications = z.infer<typeof reactionNotifications>;
const reactionNotificationOptions = reactionNotifications.extend({ savedSounds: savedNotificationSounds.optional() });
export type ReactionNotificationOptions = z.infer<typeof reactionNotificationOptions>;
export const storyNotificationAudience = z.enum(["frequent", "all", "none"]);
const storyNotificationDefaults = z.object({ audience: storyNotificationAudience, showAuthor: z.boolean(),
  sound: notificationSoundId.optional() });
const scopeNotifications = z.object({ muted: z.boolean(), preview: z.boolean(),
  pinned: z.boolean(), mentions: z.boolean(), sound: notificationSoundId.optional(), stories: storyNotificationDefaults.optional() });
export type ScopeNotifications = z.infer<typeof scopeNotifications>;
const scopeNotificationOptions = scopeNotifications.extend({ savedSounds: savedNotificationSounds.optional() });
export type ScopeNotificationOptions = z.infer<typeof scopeNotificationOptions>;
const chatNotificationState = z.object({ mode: chatNotificationMode, muteUntil: z.number().int().positive().optional(),
  preview: chatNotificationOverride.optional(), pinned: chatNotificationOverride.optional(), mentions: chatNotificationOverride.optional(),
  stories: chatNotificationOverride.optional(), storyPoster: chatNotificationOverride.optional(),
  sound: notificationSound.optional(), storySound: notificationSound.optional(),
  savedSounds: savedNotificationSounds.optional() });
export type ChatNotificationState = z.infer<typeof chatNotificationState>;
const postingPermissions = z.object({
  text: z.boolean(), photo: z.boolean(), document: z.boolean(),
  join: z.enum(["join", "request"]).optional(),
  poll: z.boolean().optional(),
  voice: z.boolean().optional(),
  videoNote: z.boolean().optional(),
  video: z.boolean().optional(),
  otherMedia: z.boolean().optional(),
});
const chatJoinResult = z.enum(["joined", "requested", "verification_required", "refused", "unknown"]);
export type ChatJoinResult = z.infer<typeof chatJoinResult>;
const inviteTarget = z.object({
  title: z.string().min(1).max(256), kind: z.enum(["Group", "Channel"]),
  mode: z.enum(["join", "request", "subscription"]), chatId: chatId.optional(),
});
const invitePreview = inviteTarget.extend({ memberCount: z.number().int().nonnegative().optional() });
export type InviteTarget = z.infer<typeof inviteTarget>;
export type InvitePreview = z.infer<typeof invitePreview>;
export type PostingPermissions = z.infer<typeof postingPermissions>;

export const messageSearchFilter = z.enum(["photoVideo", "photo", "video", "document", "audio", "voiceVideoNotes", "gif", "link", "pinned", "mentions", "unreadMentions", "unreadReactions"]);
export type MessageSearchFilter = z.infer<typeof messageSearchFilter>;

const unreadActivityFilter = z.enum(["unreadMentions", "unreadReactions"]);
export type UnreadActivityFilter = z.infer<typeof unreadActivityFilter>;

export function searchRequiresEmptyQuery(filter?: MessageSearchFilter): filter is UnreadActivityFilter {
  return filter === "unreadMentions" || filter === "unreadReactions";
}

const historyPage = z.object({ messages: z.array(messageSchema), before: chatId.nullable(), draft: telegramDraftText.optional(), readOutbox: z.number().int().nonnegative().optional() });
export type HistoryPage = z.infer<typeof historyPage>;
const globalSearchCursor = z.union([z.string().min(1).max(2048), z.object({
  date: z.number().int().nonnegative(), chatId, messageId: chatId,
})]);
const globalSearchMode = z.enum(["messages", "public"]);
export type GlobalSearchMode = z.infer<typeof globalSearchMode>;
const globalSearchPage = z.object({
  hits: z.array(z.object({ chat: chatSchema, message: messageSchema })).max(30),
  next: globalSearchCursor.nullable(),
});
export type GlobalSearchPage = z.infer<typeof globalSearchPage>;

const messageSearchPage = historyPage.pick({ messages: true, before: true });
export type MessageSearchPage = z.infer<typeof messageSearchPage>;

const photoSize = z.enum(["preview", "large"]);
export type PhotoSize = z.infer<typeof photoSize>;

const photoSchema = z.object({
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  hasLarger: z.boolean().optional(),
  base64: z.string().max(699052).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type TelegramPhoto = z.infer<typeof photoSchema>;

const runtimeInfo = z.object({ tdlibVersion: z.string().max(32).regex(/^\d+\.\d+(?:\.\d+){0,2}$/), premium: z.boolean().optional() });
export type RuntimeInfo = z.infer<typeof runtimeInfo>;

const agentAccessSchema = z.object({ read: z.boolean(), send: z.boolean(), history: z.boolean() });
export type AgentAccess = z.infer<typeof agentAccessSchema>;

const forwardTarget = z.object({
  id: chatId, name: z.string().min(1).max(256), kind: z.enum(["Direct message", "Group", "Channel"]),
  topic: forumTopicTarget.optional(),
});
const forwardResult = z.enum(["sent", "refused", "unknown"]);
export type ForwardTarget = z.infer<typeof forwardTarget>;
export type ForwardResult = z.infer<typeof forwardResult>;

const linkedTelegramMessage = z.object({
  chat: chatSchema, messageId: messageReference.shape.messageId, topicId: forumTopicId.optional(),
});
export type LinkedTelegramMessage = z.infer<typeof linkedTelegramMessage>;

export const defaultCacheLimitMiB = 512;
export const cacheLimitMiB = z.number().int().min(64).max(32768);
const cacheInfo = z.object({ bytes: z.number().int().nonnegative(), limitMiB: cacheLimitMiB });
export type CacheInfo = z.infer<typeof cacheInfo>;

const forumTopicAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: z.string().trim().min(1).max(128) }),
  z.object({ kind: z.literal("rename"), topic: forumTopicId, name: z.string().trim().min(1).max(128) }),
  z.object({ kind: z.literal("close"), topic: forumTopicId, closed: z.boolean() }),
  z.object({ kind: z.literal("pin"), topic: forumTopicId, pinned: z.boolean() }),
]);
const forumTopicCursor = z.object({ date: z.number().int().nonnegative(), message: z.number().int().nonnegative(), topic: forumTopicId });
const forumTopicPage = z.object({ topics: z.array(forumTopic).max(40), next: forumTopicCursor.nullable() });
export type ForumTopicPage = z.infer<typeof forumTopicPage>;
export type ForumTopicAction = z.infer<typeof forumTopicAction>;

const chatMemberPage = z.object({
  members: z.array(z.object({ id: chatId, name: z.string().min(1).max(256),
    role: z.enum(["owner", "admin", "member", "restricted"]), tag: z.string().max(64).optional(),
  })).max(30),
  next: z.number().int().nonnegative().nullable(),
});
export type ChatMemberPage = z.infer<typeof chatMemberPage>;

const managedInvite = z.object({
  link: z.string().max(512), name: z.string().max(32), created: z.number().int().nonnegative(),
  expires: z.number().int().nonnegative(), uses: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  approval: z.boolean(), primary: z.boolean(),
});
export type ManagedInvite = z.infer<typeof managedInvite>;
const inviteDraft = z.object({
  name: z.string().trim().max(32), expires: z.number().int().min(0).max(2147483647),
  limit: z.number().int().min(0).max(99999), approval: z.boolean(),
}).refine((draft) => !draft.approval || draft.limit === 0);
export type InviteDraft = z.infer<typeof inviteDraft>;
const inviteCursor = managedInvite.pick({ link: true, created: true });
const invitePage = z.object({ links: z.array(managedInvite).max(30), next: inviteCursor.nullable() });
export type InvitePage = z.infer<typeof invitePage>;

const joinRequestCursor = z.object({ userId: z.string().regex(/^[1-9]\d{0,15}$/), date: z.number().int().nonnegative().max(2147483647) });
const joinRequestPage = z.object({
  requests: z.array(joinRequestCursor.extend({ name: z.string().min(1).max(256), bio: z.string().max(512) })).max(30),
  next: joinRequestCursor.nullable(),
});
export type JoinRequestPage = z.infer<typeof joinRequestPage>;

export const groupPermissionLabels = {
  can_send_basic_messages: "Send messages", can_send_messages: "Send messages",
  can_send_media_messages: "Send media", can_send_audios: "Send audio",
  can_send_documents: "Send files", can_send_photos: "Send photos", can_send_videos: "Send videos",
  can_send_video_notes: "Send video messages", can_send_voice_notes: "Send voice messages",
  can_send_polls: "Send polls", can_send_other_messages: "Send stickers and GIFs",
  can_add_link_previews: "Add link previews", can_add_web_page_previews: "Add link previews",
  can_react_to_messages: "React to messages", can_edit_tag: "Edit own member tag",
  can_change_info: "Change group info", can_invite_users: "Invite users",
  can_pin_messages: "Pin messages", can_create_topics: "Create topics",
} as const;
const groupPermission = z.enum(Object.keys(groupPermissionLabels) as (keyof typeof groupPermissionLabels)[]);
const groupPermissionValues = z.partialRecord(groupPermission, z.boolean());
const groupPermissionsView = z.object({ editable: z.boolean(), values: groupPermissionValues });
const groupPermissionChange = z.object({ key: groupPermission, expected: z.boolean(), enabled: z.boolean() });
export type GroupPermission = keyof typeof groupPermissionLabels;
export type GroupPermissionsView = z.infer<typeof groupPermissionsView>;
export type GroupPermissionChange = z.infer<typeof groupPermissionChange>;

const avatarVersion = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const existingAvatarVersion = z.string().regex(/^[0-9a-f]{64}$/);
const avatarUpdate = z.object({ expected: avatarVersion, base64: photoSchema.shape.base64 });
const saveAvatarResult = z.enum(["saved", "changed", "unavailable", "unknown"]);
export type SaveAvatarResult = z.infer<typeof saveAvatarResult>;
const chatInfo = z.object({
  title: z.string().min(1).max(256), description: z.string().max(510), editable: z.boolean(),
  photoVersion: avatarVersion.optional(),
});
const chatInfoChange = z.object({
  field: z.enum(["title", "description"]), value: z.string().max(510), expected: z.string().max(510),
});
export type ChatInfo = z.infer<typeof chatInfo>;
export type ChatInfoChange = z.infer<typeof chatInfoChange>;

export const slowModeDelays = [0, 5, 10, 30, 60, 300, 900, 3600] as const;
const slowModeDelay = z.literal(slowModeDelays);
const slowModeView = z.object({ editable: z.boolean(), delay: slowModeDelay });
export type SlowModeDelay = z.infer<typeof slowModeDelay>;
export type SlowModeView = z.infer<typeof slowModeView>;

const channelSignatures = z.object({ sign: z.boolean(), showProfile: z.boolean() });
const channelSignatureView = z.object({ editable: z.boolean(), values: channelSignatures });
export type ChannelSignatures = z.infer<typeof channelSignatures>;
export type ChannelSignatureView = z.infer<typeof channelSignatureView>;

const chatEventId = z.string().regex(/^[1-9]\d{0,18}$/);
const chatEventPage = z.object({
  events: z.array(z.object({ id: chatEventId, date: z.number().int().nonnegative(), actor: z.string().min(1).max(256),
    action: z.string().min(1).max(100), detail: z.string().max(512).optional(),
  })).max(30),
  next: chatEventId.nullable(),
});
export type ChatEventPage = z.infer<typeof chatEventPage>;

const discussionPage = z.object({
  chat: chatSchema, root: z.string().regex(/^[1-9]\d{0,15}$/), messages: z.array(messageSchema).max(40), before: z.string().regex(/^[1-9]\d{0,15}$/).nullable(),
});
export type DiscussionPage = z.infer<typeof discussionPage>;

export const autoDeleteDays = z.number().int().min(0).max(365);

const chatAutoDelete = z.object({ days: autoDeleteDays, editable: z.boolean() });
export type ChatAutoDelete = z.infer<typeof chatAutoDelete>;

export const archiveSettings = z.object({
  muteUnknown: z.boolean(), keepUnmuted: z.boolean(), keepFolderChats: z.boolean(),
});
export type ArchiveSettings = z.infer<typeof archiveSettings>;
const archiveSettingsView = archiveSettings.extend({ canMuteUnknown: z.boolean() });
export type ArchiveSettingsView = z.infer<typeof archiveSettingsView>;

const senderBlockList = z.enum(["main", "stories"]);
export type SenderBlockList = z.infer<typeof senderBlockList>;

const blockedSenderPage = z.object({
  entries: z.array(z.object({ sender: messageSender, name: z.string().min(1).max(256) })).max(30),
  next: z.number().int().positive().max(2147483647).nullable(),
});
export type BlockedSenderPage = z.infer<typeof blockedSenderPage>;

const senderBlockState = z.enum(["none", "stories", "main"]);
export type SenderBlockState = z.infer<typeof senderBlockState>;

const contactId = z.string().regex(/^[1-9]\d{0,15}$/);
const contactNames = z.object({ first: z.string().trim().max(64), last: z.string().trim().max(64) });
const contactDetails = contactNames.extend({ id: contactId, saved: z.boolean() });
export type ContactDetails = z.infer<typeof contactDetails>;
const contactPage = z.object({
  contacts: z.array(z.object({ id: contactId, name: z.string().min(1).max(256) })).max(30),
  next: z.number().int().nonnegative().nullable(),
});
export type ContactPage = z.infer<typeof contactPage>;

const deviceId = z.string().regex(/^-?[1-9]\d{0,18}$/);
const telegramDevice = z.object({
  id: z.union([deviceId, z.literal("0")]), current: z.boolean(), application: z.string().max(128), device: z.string().max(128),
  platform: z.string().max(128), activeAt: z.number().int().nonnegative(),
});
export type TelegramDevice = z.infer<typeof telegramDevice>;

export const telegramPrivacyLabels = {
  phone: "Phone number", findByPhone: "Find me by phone number", status: "Last seen and online",
  photo: "Profile photos", bio: "Bio", birthday: "Birthday", profileAudio: "Profile audio",
  forwardedLink: "Link to my profile in forwarded messages", invites: "Group and channel invitations",
} as const;
const telegramPrivacyKey = z.enum(Object.keys(telegramPrivacyLabels) as (keyof typeof telegramPrivacyLabels)[]);
const telegramPrivacyAudience = z.enum(["everyone", "contacts", "nobody"]);
const telegramPrivacyView = z.object({
  audience: telegramPrivacyAudience.nullable(), exceptions: z.number().int().nonnegative(), version: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TelegramPrivacyKey = z.infer<typeof telegramPrivacyKey>;
export type TelegramPrivacyAudience = z.infer<typeof telegramPrivacyAudience>;
export type TelegramPrivacyView = z.infer<typeof telegramPrivacyView>;

export function privacyAudiences(key: TelegramPrivacyKey): readonly TelegramPrivacyAudience[] {
  return key === "findByPhone" ? ["everyone", "contacts"] : telegramPrivacyAudience.options;
}

const profileFields = z.object({ first: z.string().max(64), last: z.string().max(64), bio: z.string().max(512) });
const editableUsername = z.string().max(32).regex(/^[A-Za-z0-9_]*$/);
const usernameCheck = z.enum(["available", "taken", "invalid", "collectible", "unavailable"]);
export type UsernameCheck = z.infer<typeof usernameCheck>;
export const telegramBirthdate = z.object({
  day: z.number().int().min(1).max(31),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(0).max(9999),
}).refine(({ day, month, year }) => {
  const leap = year === 0 || year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
});
const telegramProfile = profileFields.extend({ photoVersion: avatarVersion.optional(), canRemovePhoto: z.literal(true).optional(), birthdate: telegramBirthdate.nullable(), username: editableUsername, bioLimit: z.number().int().positive().max(512), bioEditable: z.boolean() });
const profileChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("name"), first: profileFields.shape.first, last: profileFields.shape.last,
    expectedFirst: profileFields.shape.first, expectedLast: profileFields.shape.last }),
  z.object({ kind: z.literal("bio"), bio: profileFields.shape.bio, expectedBio: profileFields.shape.bio }),
  z.object({ kind: z.literal("username"), username: editableUsername, expectedUsername: editableUsername }),
  z.object({ kind: z.literal("birthdate"), birthdate: telegramBirthdate.nullable(), expectedBirthdate: telegramBirthdate.nullable() }),
]);
export type TelegramProfile = z.infer<typeof telegramProfile>;
export type ProfileChange = z.infer<typeof profileChange>;

const stickerPackId = z.string().regex(/^-?[1-9]\d{0,18}$/);
const stickerPackPreview = z.object({ id: stickerPackId, title: z.string().min(1).max(128), installed: z.boolean(),
  link: z.string().regex(/^https:\/\/t\.me\/addstickers\/[A-Za-z0-9_]{1,64}$/).optional(),
  choices: z.array(z.object({ id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional() })).max(20),
  next: z.number().int().positive().nullable() });
const stickerPackInstallation = z.enum(["installed", "unavailable", "unknown"]);
export type StickerPackPreviewData = z.infer<typeof stickerPackPreview>;

export const schemas = {
  readPreview: { input: z.object({ requestId: z.uuid(), id: z.string().max(32) }), output: z.string().max(8192) },
  runtimeInfo: { input: z.null(), output: runtimeInfo },
  removeProfilePhoto: { input: z.object({ expected: existingAvatarVersion }), output: saveAvatarResult },
  saveProfilePhoto: { input: avatarUpdate, output: saveAvatarResult },
  telegramProfile: { input: z.null(), output: telegramProfile },
  checkTelegramUsername: { input: z.object({ username: editableUsername }), output: usernameCheck },
  saveTelegramProfile: { input: profileChange, output: z.enum(["saved", "changed", "unsupported"]) },
  telegramPrivacy: { input: z.object({ key: telegramPrivacyKey }), output: telegramPrivacyView },
  saveTelegramPrivacy: { input: z.object({ key: telegramPrivacyKey, audience: telegramPrivacyAudience, expected: telegramPrivacyView.shape.version }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  chatAutoDelete: { input: z.object({ id: chatId }), output: chatAutoDelete.nullable() },
  saveChatAutoDelete: { input: z.object({ id: chatId, days: autoDeleteDays, expected: autoDeleteDays }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  defaultAutoDeleteDays: { input: z.null(), output: autoDeleteDays },
  saveDefaultAutoDeleteDays: { input: z.object({ days: autoDeleteDays, expected: autoDeleteDays }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  archiveSettings: { input: z.null(), output: archiveSettingsView },
  saveArchiveSettings: { input: z.object({ values: archiveSettings, expected: archiveSettings }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  readDatePrivacy: { input: z.null(), output: z.boolean() },
  saveReadDatePrivacy: { input: z.object({ show: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  activeDevices: { input: z.null(), output: z.array(telegramDevice).max(200) },
  terminateDevice: { input: z.object({ id: deviceId, application: telegramDevice.shape.application, device: telegramDevice.shape.device }), output: z.boolean() },
  cacheInfo: { input: z.null(), output: cacheInfo },
  setCacheLimit: { input: z.object({ limitMiB: cacheLimitMiB }), output: cacheInfo },
  clearCache: { input: z.null(), output: cacheInfo },
  agentAccess: { input: z.null(), output: agentAccessSchema },
  setAgentAccess: { input: z.object({ capability: z.enum(["read", "send"]), enabled: z.boolean() }), output: agentAccessSchema },
  chatAgentAccess: { input: z.object({ id: chatId }), output: z.boolean() },
  setChatAgentAccess: { input: z.object({ id: chatId, enabled: z.boolean() }), output: z.boolean() },
  status: { input: z.null(), output: authSchema },
  disconnect: { input: z.null(), output: authSchema },
  signOut: { input: z.null(), output: authSchema },
  connect: { input: z.null(), output: authSchema },
  password: { input: z.object({ password: z.string().min(1).max(1024) }), output: authSchema },
  newFolderChats: { input: z.object({ id: folderId }), output: folderInvite.nullable() },
  dismissFolderUpdates: { input: z.object({ id: folderId, token: recommendedFolderToken }), output: z.boolean() },
  addNewFolderChats: { input: z.object({ id: folderId, token: recommendedFolderToken,
    ids: z.array(folderInviteChatId).min(1).max(200) }), output: z.boolean() },
  folderShareChats: { input: z.object({ id: folderId }), output: z.array(folderShareChat).max(200).nullable() },
  createFolderInvite: { input: z.object({ id: folderId, name: z.string().trim().max(32),
    ids: z.array(folderInviteChatId).min(1).max(200) }), output: managedFolderInvite.nullable() },
  folderInviteLinks: { input: z.object({ id: folderId }), output: z.array(managedFolderInvite).max(200).nullable() },
  folderInviteEditor: { input: z.object({ id: folderId, url: managedFolderInvite.shape.url }), output: folderInviteEditor.nullable() },
  saveFolderInviteChats: { input: z.object({ id: folderId, url: managedFolderInvite.shape.url, token: recommendedFolderToken,
    ids: z.array(folderInviteChatId).min(1).max(200) }), output: managedFolderInvite.nullable() },
  renameFolderInvite: { input: z.object({ id: folderId, url: managedFolderInvite.shape.url, expected: managedFolderInvite.shape.name,
    name: z.string().trim().max(32) }), output: managedFolderInvite.nullable() },
  revokeFolderInvite: { input: z.object({ id: folderId, url: managedFolderInvite.shape.url, name: managedFolderInvite.shape.name }),
    output: z.boolean() },
  previewFolderInvite: { input: z.object({ url: z.string().max(128) }), output: folderInvite.nullable() },
  importFolderInvite: { input: z.object({ url: z.string().max(128), token: recommendedFolderToken,
    ids: z.array(folderInvite.shape.chats.element.shape.id).min(1).max(200) }), output: z.enum(["added", "changed", "unavailable"]) },
  folderTags: { input: z.null(), output: folderTagsState.nullable() },
  setFolderTags: { input: z.object({ enabled: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  folderLimit: { input: z.null(), output: z.number().int().positive().nullable() },
  reorderFolders: { input: z.object({ order: z.array(folderId).min(2).max(100), expected: z.array(folderId).min(2).max(100) }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  recommendedFolders: { input: z.null(), output: z.array(recommendedFolder).max(30) },
  addRecommendedFolder: { input: z.object({ token: recommendedFolderToken }), output: folderSchema },
  folderEditor: { input: z.object({ id: folderId }), output: folderEditor },
  saveFolder: { input: folderDraft.extend({ id: folderId.optional() }), output: folderSchema },
  deleteFolder: { input: z.object({ id: folderId, title: z.string().min(1).max(128) }), output: z.boolean() },
  setFolderMembership: { input: z.object({ id: folderId, chatId, mode: folderMembershipMode }), output: z.boolean() },
  folderMemberships: { input: z.object({ chatId }), output: z.array(folderMembership) },
  folders: { input: z.null(), output: z.array(folderSchema) },
  contacts: { input: z.object({ query: z.string().trim().max(128), offset: z.number().int().nonnegative().max(10000).optional() }), output: contactPage },
  blockedSenders: { input: z.object({ list: senderBlockList, offset: z.number().int().min(0).max(2147483647) }), output: blockedSenderPage },
  openBlockedSender: { input: z.object({ sender: messageSender }), output: chatSchema },
  unblockListedSender: { input: z.object({ sender: messageSender, list: senderBlockList }), output: z.boolean() },
  senderBlockState: { input: z.object({ id: chatId }), output: senderBlockState.nullable() },
  setSenderBlockState: { input: z.object({ id: chatId, expected: senderBlockState, next: senderBlockState }), output: z.boolean() },
  contactDetails: { input: z.object({ id: chatId }), output: contactDetails.nullable() },
  saveContact: { input: z.object({ id: chatId, userId: contactId, expected: contactDetails, names: contactNames }), output: z.boolean() },
  removeContact: { input: z.object({ id: chatId, userId: contactId, expected: contactDetails }), output: z.boolean() },
  openContact: { input: z.object({ id: contactId }), output: chatSchema },
  search: { input: z.object({ query: z.string().trim().min(2).max(128), list: chatListSchema.optional() }), output: z.array(chatSchema) },
  chatPage: {
    input: z.object({ list: chatListSchema, offset: z.number().int().min(0).max(9999) }),
    output: z.object({ chats: z.array(chatSchema), nextOffset: z.number().int().nullable() }),
  },
  notificationChat: { input: z.object({ id: chatId }), output: chatSchema.nullable() },
  chats: { input: z.object({ list: chatListSchema }), output: z.array(chatSchema) },
  savedNotificationSounds: { input: z.null(), output: savedNotificationSounds },
  previewNotificationSound: { input: z.object({ id: savedNotificationSoundId }),
    output: z.object({ mime: z.enum(["audio/mpeg", "audio/ogg"]), base64: z.string() }) },
  addNotificationSound: { input: z.object({ base64: z.string().max(Math.ceil(maxNotificationSoundBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
    output: z.enum(["saved", "unavailable", "unknown"]) },
  removeNotificationSound: { input: z.object({ id: savedNotificationSoundId }), output: z.enum(["saved", "unavailable", "unknown"]) },
  reactionNotifications: { input: z.null(), output: reactionNotificationOptions.nullable() },
  saveReactionNotifications: { input: z.object({ values: reactionNotifications, expected: reactionNotifications }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  scopeNotifications: { input: z.object({ scope: notificationScope }), output: scopeNotificationOptions },
  saveScopeNotifications: { input: z.object({ scope: notificationScope, expected: scopeNotifications, values: scopeNotifications }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatNotificationState: { input: z.object({ id: chatId, topicId: forumTopicId.optional() }), output: chatNotificationState.nullable() },
  setChatNotificationOverride: { input: z.object({ id: chatId, topicId: forumTopicId.optional(), field: chatNotificationField, value: chatNotificationOverride, expected: chatNotificationOverride }),
    output: z.enum(["updated", "refused", "unknown"]) },
  setChatNotificationSound: { input: z.object({ id: chatId, topicId: forumTopicId.optional(), story: z.boolean().optional(), value: notificationSound, expected: notificationSound }),
    output: z.enum(["updated", "refused", "unknown"]) },
  setChatNotificationMode: { input: z.object({ id: chatId, topicId: forumTopicId.optional(), mode: chatNotificationMode, muteFor: chatMutePeriod.optional() })
    .refine(({ mode, muteFor }) => mode === "muted" || muteFor === undefined), output: z.enum(["updated", "refused", "unknown"]) },
  chatPinStatus: { input: z.object({ id: chatId, list: chatListSchema }), output: z.boolean().nullable() },
  setChatPinned: { input: z.object({ id: chatId, list: chatListSchema, pinned: z.boolean() }), output: z.enum(["updated", "refused", "unknown"]) },
  archiveChat: { input: z.object({ id: chatId, archived: z.boolean() }), output: chatSchema },
  previewInvite: { input: z.object({ url: z.string().max(128) }), output: invitePreview.nullable() },
  joinInvite: { input: z.object({ url: z.string().max(128), expected: inviteTarget }), output: chatJoinResult },
  joinChat: { input: z.object({ id: chatId, name: z.string().min(1).max(256) }), output: chatJoinResult },
  createPrivateChatSpace: {
    input: z.object({ title: z.string().trim().min(1).max(128), kind: z.enum(["Group", "Channel"]) }),
    output: chatSchema,
  },
  deleteOwnedChatSpace: {
    input: z.object({ id: chatId, title: z.string().min(1).max(256), kind: z.enum(["Group", "Channel"]) }),
    output: z.enum(["deleted", "refused", "not_owner", "not_deletable", "unknown"]),
  },
  postingPermissions: { input: z.object({ id: chatId }), output: postingPermissions },
  postingAllowed: { input: z.object({ id: chatId }), output: z.boolean() },
  markActivityRead: { input: z.object({ id: chatId, filter: unreadActivityFilter, topicId: forumTopicId.optional() }), output: z.boolean() },
  markChat: { input: z.object({ id: chatId, unread: z.boolean() }), output: chatSchema },
  avatar: { input: z.object({ id: chatId, fileId: z.number().int().positive(), user: z.boolean().optional() }), output: photoSchema },
  photo: { input: messageReference.extend({ size: photoSize.optional() }), output: photoSchema },
  resolveMessageLink: { input: z.object({ url: z.string().max(256) }), output: linkedTelegramMessage.nullable() },
  messageLink: { input: messageReference, output: z.string().max(256).nullable() },
  sendChannelComment: { input: messageReference.extend({ group: chatId, root: discussionPage.shape.root,
    text: z.string().trim().min(1).max(4096),
  }), output: sendResult },
  channelDiscussion: { input: messageReference.extend({ before: z.string().regex(/^[1-9]\d{0,15}$/).optional() }), output: discussionPage },
  messageAtDate: { input: z.object({ id: chatId, date: z.number().int().positive().max(2147483647), topicId: forumTopicId.optional() }),
    output: messageReference.shape.messageId.nullable() },
  messageContextPage: { input: messageReference.extend({ topicId: forumTopicId.optional(), direction: contextDirection }),
    output: z.array(messageSchema).max(20) },
  messageContext: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: z.array(messageSchema).max(13) },
  transcribeVoice: { input: messageReference, output: z.string().max(8192) },
  videoStream: { input: messageReference, output: z.string().startsWith("/api/v1/plugins/") },
  document: {
    input: messageReference.extend({ playback: z.boolean().optional(), oneView: z.literal(true).optional() }),
    output: z.object({ name: documentInfo.shape.name, url: z.string().startsWith("/api/v1/plugins/") }),
  },
  globalSearch: { input: z.object({
    query: z.string().trim().min(2).max(128), mode: globalSearchMode, cursor: globalSearchCursor.optional(),
  }), output: globalSearchPage },
  searchMessages: {
    input: z.object({ id: chatId, query: z.string().trim().max(128), filter: messageSearchFilter.optional(), topicId: forumTopicId.optional(), before: messageReference.shape.messageId.optional(), sender: messageSender.optional() })
      .refine(({ query, filter, sender }) => !!sender || filter !== undefined || query.length >= 2, { path: ["query"] })
      .refine(({ query, filter, sender }) => !searchRequiresEmptyQuery(filter) || !query && !sender, { path: ["filter"] }),
    output: messageSearchPage,
  },
  listReactions: { input: messageReference, output: z.array(reactionEmoji).max(100) },
  setReaction: { input: messageReference.extend({ emoji: reactionEmoji, chosen: z.boolean() }), output: z.boolean() },
  forwardOptions: { input: messageReference, output: z.boolean() },
  forwardMessage: { input: messageReference.extend({ target: forwardTarget }), output: forwardResult },
  sendPoll: { input: z.object({ id: chatId, draft: pollDraft, topic: forumTopicTarget.optional() }), output: pollSendResult },
  stopPoll: { input: messageReference, output: z.boolean() },
  voteInPoll: { input: messageReference.extend({ choices: z.array(pollChoice).max(100) }), output: z.boolean() },
  pinStatus: { input: messageReference, output: z.boolean().nullable() },
  setMessagePinned: { input: messageReference.extend({ pinned: z.boolean() }), output: z.enum(["updated", "refused", "unknown"]) },
  pinnedMessage: { input: z.object({ id: chatId }), output: messageSchema.nullable() },
  manageForumTopic: { input: z.object({ id: chatId, action: forumTopicAction }), output: forumTopic },
  forumTopicPage: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }), output: forumTopicPage.nullable() },
  forumTopics: { input: z.object({ id: chatId, query: z.string().trim().max(128) }), output: z.array(forumTopic).max(40).nullable() },
  history: { input: z.object({ id: chatId, before: chatId.optional(), topicId: forumTopicId.optional() }), output: historyPage },
  messageViewers: { input: messageReference, output: z.array(messageViewer).nullable() },
  messageReadTime: { input: messageReference, output: messageReadTime },
  deletionOptions: { input: messageReference, output: z.array(deletionScope).max(2) },
  deleteMessage: { input: messageReference.extend({ scope: deletionScope }), output: z.enum(["deleted", "refused", "unknown"]) },
  editCaption: { input: messageReference.extend({ text: z.string().trim().max(4096), original: z.string().max(8192),
    originalStyles: textDelivery.shape.styles, styles: textDelivery.shape.styles, placement: captionPlacement.optional() }), output: sendResult },
  edit: { input: z.object({ id: chatId, messageId: z.string().regex(/^[1-9]\d{0,15}$/), text: z.string().trim().min(1).max(4096), original: z.string().max(8192), originalStyles: textDelivery.shape.styles, styles: textDelivery.shape.styles, removeLinkPreview: messageLinkPreview.shape.url.optional() }), output: sendResult },
  prepareDocumentUpload: { input: z.object({
    id: chatId, name: z.string().min(1).max(255), caption: z.string().trim().max(1024),
    size: z.number().int().positive().max(maxDocumentBytes), topic: forumTopicTarget.optional(), video: z.literal(true).optional(), options: mediaSendOptions.optional(),
    replyTo: messageReference.shape.messageId.optional(),
  }).refine((input) => !input.options || input.video === true), output: z.union([
    z.object({ url: z.string().startsWith("/api/v1/plugins/") }),
    z.object({ rejection: uploadRejection }),
  ]) },
  sendDocument: { input: z.object({
    id: chatId, name: z.string().min(1).max(255), caption: z.string().trim().max(1024), base64: photoSchema.shape.base64,
  }), output: sendResult },
  mediaCollectionState: { input: messageReference.extend({ kind: mediaCollectionKind }), output: z.boolean().nullable() },
  setMediaCollection: { input: messageReference.extend({ kind: mediaCollectionKind, saved: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  searchGifs: { input: z.object({ id: chatId, query: z.string().trim().min(1).max(80), topic: forumTopicTarget.optional() }),
    output: z.array(z.object({ id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(),
      gifToken: z.uuid() })).max(20) },
  sendFoundGif: { input: z.object({ id: chatId, token: z.uuid(), topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional() }), output: sendResult },
  messageStickerPack: { input: messageReference.extend({ offset: z.number().int().nonnegative() }), output: stickerPackPreview.nullable() },
  installMessageStickerPack: { input: messageReference.extend({ packId: stickerPackId }), output: stickerPackInstallation },
  linkedStickerPack: { input: z.object({ url: z.string().max(128), offset: z.number().int().nonnegative() }),
    output: stickerPackPreview.nullable() },
  installLinkedStickerPack: { input: z.object({ url: z.string().max(128), packId: stickerPackId }), output: stickerPackInstallation },
  installedStickerPacks: { input: z.null(), output: z.array(z.object({
    id: z.string().regex(/^-?[1-9]\d{0,18}$/), title: z.string().min(1).max(128),
  })) },
  reorderStickerPacks: { input: z.object({ order: z.array(stickerPackId).min(2), expected: z.array(stickerPackId).min(2) }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  stickerPackPage: { input: z.object({ packId: z.string().regex(/^-?[1-9]\d{0,18}$/), offset: z.number().int().nonnegative() }),
    output: z.object({ choices: z.array(z.object({
      id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(),
    })).max(20), next: z.number().int().positive().nullable() }) },
  mediaChoices: { input: z.union([z.enum(["sticker", "gif"]),
    z.object({ stickerQuery: z.string().trim().min(1).max(80) })]), output: z.array(z.object({
    id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(),
  })).max(20) },
  sendMediaChoice: { input: z.object({ id: chatId, kind: z.enum(["sticker", "gif"]), fileId: z.number().int().positive(), stickerQuery: z.string().trim().min(1).max(80).optional(),
    packId: z.string().regex(/^-?[1-9]\d{0,18}$/).optional(), topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional(), gif: gifSendOptions.optional() })
    .refine(({ kind, stickerQuery, packId, gif }) => kind === "sticker" ? !gif && !(stickerQuery && packId) : !stickerQuery && !packId), output: sendResult },
  sendVideoNote: { input: z.object({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(),
    delivery: mediaDelivery.optional(), format: z.enum(["webm", "mp4"]),
    base64: z.string().max(Math.ceil(maxVideoNoteBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }), output: sendResult },
  sendVoice: { input: z.object({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional(), duration: z.number().int().min(1).max(120),
    format: z.enum(["ogg", "webm", "mp4"]), base64: z.string().max(Math.ceil(maxVoiceBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }), output: sendResult },
  sendPhotoAlbum: { input: z.object({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional(), caption: z.string().trim().max(1024),
    photos: z.array(photoSchema.shape.base64).min(2).max(10), options: mediaSendOptions.optional(),
  }), output: z.enum(["sent", "failed", "unknown"]) },
  sendPhoto: { input: z.object({
    id: chatId, caption: z.string().trim().max(1024), base64: photoSchema.shape.base64, topic: forumTopicTarget.optional(),
    replyTo: messageReference.shape.messageId.optional(), options: mediaSendOptions.optional(),
  }), output: sendResult },
  sendTopicText: {
    input: z.object({ id: chatId, topic: forumTopicTarget, text: z.string().trim().min(1).max(4096),
      replyTo: messageReference.shape.messageId.optional(), styles: textDelivery.shape.styles, quote: textDelivery.shape.quote, delivery: topicDelivery.optional() }),
    output: sendResult,
  },
  chatEvents: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: chatEventId.optional() }), output: chatEventPage.nullable() },
  channelSignatures: { input: z.object({ id: chatId }), output: channelSignatureView.nullable() },
  saveChannelSignatures: { input: z.object({ id: chatId, values: channelSignatures, expected: channelSignatures }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatInfo: { input: z.object({ id: chatId }), output: chatInfo.nullable() },
  removeChatPhoto: { input: z.object({ id: chatId, expected: existingAvatarVersion }), output: saveAvatarResult },
  saveChatPhoto: { input: avatarUpdate.extend({ id: chatId }), output: saveAvatarResult },
  saveChatInfo: { input: chatInfoChange.extend({ id: chatId }), output: z.enum(["saved", "changed", "unavailable"]) },
  groupSlowMode: { input: z.object({ id: chatId }), output: slowModeView.nullable() },
  saveGroupSlowMode: { input: z.object({ id: chatId, delay: slowModeDelay, expected: slowModeDelay }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  groupPermissions: { input: z.object({ id: chatId }), output: groupPermissionsView.nullable() },
  saveGroupPermissions: { input: z.object({ id: chatId, changes: z.array(groupPermissionChange).min(1).max(20) }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  joinRequests: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: joinRequestCursor.optional() }), output: joinRequestPage.nullable() },
  reviewJoinRequest: { input: z.object({ id: chatId, userId: joinRequestCursor.shape.userId, approve: z.boolean() }), output: z.boolean() },
  managedInvites: { input: z.object({ id: chatId, cursor: inviteCursor.optional() }), output: invitePage.nullable() },
  createManagedInvite: { input: z.object({ id: chatId, draft: inviteDraft }), output: managedInvite },
  revokeManagedInvite: { input: z.object({ id: chatId, link: managedInvite.shape.link }), output: z.boolean() },
  chatMembers: { input: z.object({ id: chatId, query: z.string().trim().max(128), offset: z.number().int().nonnegative().max(2147483600).optional() }),
    output: chatMemberPage.nullable() },
  canScheduleWhenOnline: { input: z.object({ id: chatId }), output: z.boolean() },
  scheduledMessages: { input: z.object({ id: chatId, topicId: forumTopicId.optional() }), output: z.array(scheduledMessage).max(100) },
  changeScheduledMessage: { input: z.object({ id: chatId, expected: scheduledMessage, at: scheduledTime.nullable(), topicId: forumTopicId.optional() }),
    output: z.enum(["updated", "changed", "unavailable"]) },
  cancelScheduledMessage: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: z.boolean() },
  topicDraft: { input: z.object({ id: chatId, topicId: forumTopicId }), output: topicDraft },
  saveChatDraft: { input: z.object({ id: chatId, text: z.string().max(4096), expected: telegramDraftText.nullable(), topicId: forumTopicId.optional() }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  send: { input: z.object({ id: chatId, text: z.string().trim().min(1).max(4096),
    replyTo: z.string().regex(/^[1-9]\d{0,15}$/).optional(), delivery: textDelivery.optional(),
  }), output: sendResult },
};
