import { isTelegramFolderInviteLink, telegramStickerPackName } from "../../core/public-chat-reference.ts";
import { chatMutePeriods, notificationSound, maxNotificationSoundBytes, type ChatMutePeriod, type MediaDelivery, type MediaReply, type MessageNotification, type MediaCollectionKind, type ChatNotificationState, type ChatNotificationOverride, type ChatNotificationField, type NotificationScope, type ScopeNotifications, type ScopeNotificationOptions, type ReactionNotifications, type ReactionNotificationOptions, type ReactionNotificationAudience, folderIconNames, type FolderIcon, type FolderTagsState, type FolderInvite, type FolderShareChat, type ManagedFolderInvite, type FolderInviteEditor } from "../../core/contract.ts";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { CaptionPlacement, GifSendOptions, MediaSendOptions, ChatJoinResult, ChatNotificationMode, DeletionScope, ForwardResult, ForwardTarget, ForumTopic, ForumTopicTarget, MessagesDeleted, Auth, ChatList, HistoryPage, InvitePreview, InviteTarget, PhotoSize, PostingPermissions, SendResult, RuntimeInfo, MessageReactions, PollChoice, PollDraft, PollSendResult, PollInfo, MessageSearchFilter, MessageSearchPage, MessageStyle, StyledRange, TelegramFolder, TelegramPhoto, UploadRejection } from "../../core/contract.ts";
import { groupPermissionLabels, folderRuleLabels, chatAvatarSchema, documentDeliveryTimeoutMs, maxDocumentBytes, maxDocumentUploadBytes, maxStandardTelegramUploadBytes, maxTelegramUploadBytes, maxPhotoBytes, maxPhotoEdge, maxPlaybackBytes, maxVoiceBytes, maxVideoNoteBytes, playbackMime, pollDraft, telegramBirthdate, privacyAudiences, messageSender, searchRequiresEmptyQuery, scheduleRepeatPeriods, slowModeDelays } from "../../core/contract.ts";
import type { ChatDiscoveryCursor, GlobalSearchMode, GlobalSearchPage, TextDelivery, ScheduledMessage, FolderDraft, FolderEditor, RecommendedFolder, ForumTopicAction, ForumTopicPage, ChatMemberPage, InviteDraft, InvitePage, ManagedInvite, JoinRequestPage, GroupPermission, GroupPermissionChange, GroupPermissionsView, ChatEventPage, DiscussionPage, ContactPage, ContactDetails, TelegramDevice, TelegramPrivacyKey, TelegramPrivacyAudience, TelegramPrivacyView, TelegramProfile, ProfileChange, UsernameCheck, MessageReadTime, MessageViewer, ChannelSignatures, ChannelSignatureView, ContextDirection, MessageSender, UnreadActivityFilter, ReplyQuote, SlowModeDelay, SlowModeView, ChatInfo, ChatInfoChange, SaveAvatarResult, SenderBlockState, BlockedSenderPage, SenderBlockList, ArchiveSettings, ArchiveSettingsView, ChatAutoDelete, TopicDraft } from "../../core/contract.ts";
import { readTelegramFile, streamTelegramFile } from "./telegram-file.ts";
import { isTelegramInviteLink, isTelegramMessageLink, publicChatReference } from "../../core/public-chat-reference.ts";
import { previewMessageText } from "../../core/message-spoilers.ts";
import { moveDraftStyles, sameDraftStyles, validDraftStyles } from "../../core/draft-formatting.ts";
import { textWebLinks, webLink, type MessageLink } from "../../core/message-links.ts";
import type { Chat, Message } from "../../core/demo.ts";
import { createLocalTranscription, videoNoteAudio } from "./local-transcription.ts";
import { inspectJpeg, stageAttachment } from "./photo-upload.ts";
import { readTelegramPhoto, telegramPhotoMime } from "./photo.ts";
import type { ChannelPostReceipts } from "./channel-post-receipts.ts";
import type { createPrivateHistory, PrivateMediaMime } from "./private-history.ts";
import { connectTdJson, TdError, type TdObject } from "./tdjson.ts";

type SendIdentity = string | { key: string; name: string; kind: string };

function chatTitle(raw: TdObject): string {
  return typeof raw.title === "string" && raw.title.trim() ? raw.title.slice(0, 256) : "Chat";
}

function chatKind(raw: TdObject): string {
  const type = object(raw.type);
  return type?.["@type"] === "chatTypePrivate" ? "Direct message" : type?.is_channel ? "Channel" : "Group";
}

type Transport = ReturnType<typeof connectTdJson>;
type Options = { library: string; directory: string; key: string; apiId: number; apiHash: string; channelPosts?: ChannelPostReceipts;
  privateHistory?: ReturnType<typeof createPrivateHistory> };
const expiredMedia = new Set(["messageExpiredPhoto", "messageExpiredVideo", "messageExpiredVideoNote", "messageExpiredVoiceNote"]);
const runMediaConverter = promisify(execFile);
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

function plainDraftText(container: TdObject): string | undefined {
  const draft = object(container.draft_message);
  if (draft?.["@type"] !== "draftMessage" || draft.reply_to || draft.reply_to_message_id || draft.suggested_post_info
    || (draft.effect_id !== undefined && draft.effect_id !== "0" && draft.effect_id !== 0)) return;
  const content = object(draft.content) ?? object(draft.input_message_text);
  if (content?.["@type"] !== "draftMessageContentText" && content?.["@type"] !== "inputMessageText") return;
  const formatted = object(content.text);
  const text = formatted?.text;
  if (typeof text === "string" && text.trim() && text.length <= 4096 && array(formatted?.entities).length === 0) return text;
}

function messageTime(date: unknown): string {
  return typeof date === "number" && date > 0 && date <= 8.64e12 ? timeFormat.format(date * 1000) : "";
}

function object(value: unknown): TdObject | undefined {
  return value && typeof value === "object" && "@type" in value ? value as TdObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function photoFiles(raw: TdObject, mode: "preview" | "oneView" | "export" = "preview"): { preview: number; large: number; dimensions: { width: number; height: number } } | undefined {
  const content = object(raw.content);
  if (content?.["@type"] !== "messagePhoto" || (mode !== "oneView" && (content.is_secret || raw.self_destruct_type || raw.ttl))) return;
  const sizes = array(object(content.photo)?.sizes);
  const candidates = sizes.flatMap((entry) => {
    const size = object(entry);
    const file = object(size?.photo);
    if (!size || !file || typeof file.id !== "number" || !Number.isSafeInteger(file.id) || file.id <= 0) return [];
    const width = Number(size.width);
    const height = Number(size.height);
    const expected = Math.max(Number(file.size) || 0, Number(file.expected_size) || 0);
    return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
      && (mode === "export" || (width <= maxPhotoEdge && height <= maxPhotoEdge))
      && expected <= (mode === "preview" ? maxPhotoBytes : maxPlaybackBytes)
      ? [{ id: file.id, width, height, area: width * height, longestEdge: Math.max(width, height) }] : [];
  }).sort((a, b) => b.area - a.area);
  const large = candidates[0];
  if (!large) return;
  const preview = candidates.find(({ longestEdge }) => longestEdge >= 320 && longestEdge <= 640) ?? large;
  return { preview: preview.id, large: large.id, dimensions: { width: preview.width, height: preview.height } };
}

function oneViewFile(raw: TdObject): { kind: "photo" | "video"; id: number; mime?: PrivateMediaMime } | undefined {
  if (raw.is_outgoing !== false || raw.sending_state || raw.has_protected_content
    || object(raw.self_destruct_type)?.["@type"] !== "messageSelfDestructTypeImmediately") return;
  const content = object(raw.content);
  if (content?.["@type"] === "messagePhoto") {
    const id = photoFiles(raw, "oneView")?.large;
    return id === undefined ? undefined : { kind: "photo", id };
  }
  if (content?.["@type"] === "messageVideo") {
    const video = object(content.video);
    const file = object(video?.video);
    const mime = video?.mime_type;
    if (typeof file?.id === "number" && Number.isSafeInteger(file.id) && file.id > 0
      && Math.max(Number(file.size) || 0, Number(file.expected_size) || 0) <= maxPlaybackBytes
      && (mime === "video/mp4" || mime === "video/webm")) return { kind: "video", id: file.id, mime };
  }
}

function documentName(value: unknown, fallback = "Telegram document") {
  const cleaned = typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>:"/\\|?*]/gu, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 180).replace(/[\p{Cs}]$/u, "")
    : "";
  return cleaned || fallback;
}

const messageSearchFilters: Record<MessageSearchFilter, { tdType: string; contentTypes?: readonly string[] }> = {
  photoVideo: { tdType: "searchMessagesFilterPhotoAndVideo", contentTypes: ["messagePhoto", "messageVideo"] },
  photo: { tdType: "searchMessagesFilterPhoto", contentTypes: ["messagePhoto"] },
  document: { tdType: "searchMessagesFilterDocument", contentTypes: ["messageDocument"] },
  audio: { tdType: "searchMessagesFilterAudio", contentTypes: ["messageAudio"] },
  video: { tdType: "searchMessagesFilterVideo", contentTypes: ["messageVideo"] },
  gif: { tdType: "searchMessagesFilterAnimation", contentTypes: ["messageAnimation"] },
  link: { tdType: "searchMessagesFilterUrl" },
  pinned: { tdType: "searchMessagesFilterPinned" },
  mentions: { tdType: "searchMessagesFilterMention" },
  unreadMentions: { tdType: "searchMessagesFilterUnreadMention" },
  unreadReactions: { tdType: "searchMessagesFilterUnreadReaction" },
  voiceVideoNotes: { tdType: "searchMessagesFilterVoiceAndVideoNote", contentTypes: ["messageVoiceNote", "messageVideoNote"] },
};

const attachmentFields = new Map<string, { contentField: string; fileField: string; fallback: string }>([
  ["messageDocument", { contentField: "document", fileField: "document", fallback: "Telegram document" }],
  ["messageVideo", { contentField: "video", fileField: "video", fallback: "Telegram video" }],
  ["messageAudio", { contentField: "audio", fileField: "audio", fallback: "Telegram audio" }],
  ["messageSticker", { contentField: "sticker", fileField: "sticker", fallback: "Sticker" }],
  ["messageAnimation", { contentField: "animation", fileField: "animation", fallback: "Telegram animation" }],
  ["messageVideoNote", { contentField: "video_note", fileField: "video", fallback: "Telegram video note.mp4" }],
  ["messageVoiceNote", { contentField: "voice_note", fileField: "voice", fallback: "Telegram voice message" }],
]);

function documentFile(raw: TdObject) {
  const content = object(raw.content);
  if (!content) return;
  const fields = attachmentFields.get(content["@type"]);
  if (!fields) return;
  const attachment = object(content[fields.contentField]);
  if (!attachment) return;
  const file = object(attachment[fields.fileField]);
  const id = file?.id;
  const exactSize = typeof file?.size === "number" && Number.isSafeInteger(file.size) && file.size > 0 ? file.size : undefined;
  const expectedSize = typeof file?.expected_size === "number" && Number.isSafeInteger(file.expected_size)
    && file.expected_size > 0 ? file.expected_size : undefined;
  const size = exactSize ?? expectedSize;
  const downloadable = typeof id === "number" && Number.isSafeInteger(id) && id > 0
    && size !== undefined && size <= maxDocumentBytes && raw.can_be_saved !== false && !raw.has_protected_content
    && !raw.self_destruct_type && !raw.ttl && !content.is_secret && !raw.sending_state;
  const fallback = content["@type"] === "messageVoiceNote" && attachment.mime_type === "audio/ogg"
    ? `${fields.fallback}.ogg` : fields.fallback;
  const stickerFormat = object(attachment.format)?.["@type"];
  const mime = playbackMime.safeParse(content["@type"] === "messageVideoNote" ? "video/mp4"
    : stickerFormat === "stickerFormatWebp" ? "image/webp" : stickerFormat === "stickerFormatWebm" ? "video/webm" : attachment.mime_type);
  const mediaType = content["@type"] === "messageSticker" ? (stickerFormat === "stickerFormatWebp" ? "image/" : "video/") : ["messageVideo", "messageVideoNote", "messageAnimation"].includes(content["@type"]) ? "video/"
    : ["messageAudio", "messageVoiceNote"].includes(content["@type"]) ? "audio/" : undefined;
  return { id, name: documentName(attachment.file_name, fallback), downloadable,
    ...(downloadable && (size <= maxPlaybackBytes || content["@type"] === "messageVideo") && mediaType && mime.success && (mime.data.startsWith(mediaType) || mime.data === "image/gif")
      ? { playbackMime: mime.data } : {}),
    ...(size === undefined ? {} : { sizeBytes: size, ...(exactSize === undefined ? { approximateSize: true } : {}) }),
  };
}

function threadRoot(raw: TdObject): string | undefined {
  const topic = object(raw.topic_id);
  const id = topic?.["@type"] === "messageTopicThread" ? topic.message_thread_id : raw.message_thread_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}

const outgoingTextStyles: Record<MessageStyle, string> = {
  bold: "textEntityTypeBold", italic: "textEntityTypeItalic", underline: "textEntityTypeUnderline",
  strike: "textEntityTypeStrikethrough", code: "textEntityTypeCode", spoiler: "textEntityTypeSpoiler",
};

function textEntities(styles: readonly StyledRange[]) {
  return [...styles].sort((a, b) => a.offset - b.offset || b.length - a.length)
    .map(({ offset, length, style }) => ({ "@type": "textEntity", offset, length,
      type: { "@type": outgoingTextStyles[style] } }));
}

function displayReplyQuote(raw: TdObject | undefined) {
  if (raw?.["@type"] !== "messageReplyToMessage") return;
  const quote = object(raw.quote);
  const formatted = object(quote?.text);
  const text = formatted?.text;
  if (quote?.is_manual !== true || typeof text !== "string" || !text.trim() || text.length > 1024) return;
  const styles = array(formatted?.entities).flatMap((entry): StyledRange[] => {
    const entity = object(entry);
    return object(entity?.type)?.["@type"] === "textEntityTypeSpoiler"
      && typeof entity?.offset === "number" && typeof entity.length === "number"
      ? [{ offset: entity.offset, length: entity.length, style: "spoiler" }] : [];
  });
  return previewMessageText({ id: "", author: "", time: "", text, styles });
}

function manualTextQuote(parent: TdObject, quote: ReplyQuote) {
  const content = object(parent.content);
  const source = object(content?.text);
  const end = quote.position + quote.text.length;
  if (content?.["@type"] !== "messageText" || typeof source?.text !== "string" || !quote.text.trim()
    || !validDraftStyles(source.text, [{ offset: quote.position, length: quote.text.length, style: "bold" }])
    || source.text.slice(quote.position, end) !== quote.text || quote.text.length > 1024) return;
  const kept = new Set(["textEntityTypeBold", "textEntityTypeItalic", "textEntityTypeUnderline",
    "textEntityTypeStrikethrough", "textEntityTypeSpoiler", "textEntityTypeCustomEmoji", "textEntityTypeDateTime"]);
  const entities: TdObject[] = [];
  for (const entry of array(source.entities)) {
    const entity = object(entry);
    const type = object(entity?.type);
    if (!entity || !type || !kept.has(type["@type"]) || typeof entity.offset !== "number" || typeof entity.length !== "number") continue;
    const left = Math.max(entity.offset, quote.position);
    const right = Math.min(entity.offset + entity.length, end);
    if (left < right) entities.push({ "@type": "textEntity", offset: left - quote.position, length: right - left, type });
  }
  return { "@type": "inputTextQuote", position: quote.position, rich_texts: [],
    text: { "@type": "formattedText", text: quote.text, entities } };
}

function forumTopicId(raw: TdObject): number | undefined {
  const topic = object(raw.topic_id);
  const id = topic?.forum_topic_id;
  return topic?.["@type"] === "messageTopicForum" && typeof id === "number"
    && Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : undefined;
}

const telegramStyles = new Map<string, MessageStyle>([
  ["textEntityTypeBold", "bold"],
  ["textEntityTypeItalic", "italic"],
  ["textEntityTypeUnderline", "underline"],
  ["textEntityTypeStrikethrough", "strike"],
  ["textEntityTypeCode", "code"],
  ["textEntityTypePre", "code"],
  ["textEntityTypePreCode", "code"],
  ["textEntityTypeSpoiler", "spoiler"],
]);

function pollView(content: TdObject | undefined): PollInfo | undefined {
  if (content?.["@type"] !== "messagePoll") return;
  const poll = object(content.poll);
  if (!poll) return;
  const label = (value: unknown) => {
    const text = typeof value === "string" ? value : object(value)?.text;
    return typeof text === "string" ? text.trim().slice(0, 1024) : "";
  };
  const question = label(poll.question);
  const options = array(poll.options).slice(0, 100).map(object);
  const resultsVisible = typeof poll.can_see_results === "boolean" ? poll.can_see_results
    : poll.is_closed === true || options.some((option) => option?.is_chosen === true);
  const order = array(poll.option_order);
  const indexes = order.length === options.length && new Set(order).size === options.length
    && order.every((index) => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < options.length)
    ? order as number[] : options.map((_, index) => index);
  const answers = indexes.flatMap((index) => {
    const option = options[index];
    const text = label(option?.text);
    if (!text) return [];
    const percentage = option?.vote_percentage;
    return [{ index, text, ...(typeof option?.id === "string" && option.id.length <= 128 ? { id: option.id } : {}), chosen: option?.is_chosen === true,
      ...(resultsVisible && typeof percentage === "number" && Number.isInteger(percentage)
        && percentage >= 0 && percentage <= 100 ? { percentage } : {}) }];
  });
  if (!question || !answers.length) return;
  const voters = poll.total_voter_count;
  const type = object(poll.type);
  const quiz = type?.["@type"] === "pollTypeQuiz";
  const canVote = poll.is_closed !== true && !poll.vote_restriction_reason
    && !options.some((option) => option?.is_being_chosen === true)
    && (!answers.some((option) => option.chosen) || (poll.allows_revoting ?? !quiz) === true);
  return { question, options: answers, closed: poll.is_closed === true, canVote,
    multiple: (poll.allows_multiple_answers ?? type?.allow_multiple_answers) === true,
    quiz,
    ...(resultsVisible && typeof voters === "number" && Number.isSafeInteger(voters) && voters >= 0 ? { voters } : {}),
  };
}

function messageSenderView(value: unknown): MessageSender | undefined {
  const raw = object(value);
  const user = raw?.["@type"] === "messageSenderUser";
  if (!user && raw?.["@type"] !== "messageSenderChat") return;
  const id = user ? raw?.user_id : raw?.chat_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
  const result = messageSender.safeParse({ kind: user ? "user" : "chat", id: String(id) });
  return result.success ? result.data : undefined;
}

function authorSignature(raw: TdObject): string {
  return typeof raw.author_signature === "string" ? raw.author_signature.trim().slice(0, 256) : "";
}

function channelPostCounts(raw: TdObject) {
  const info = object(raw.interaction_info);
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value)
    && value >= 0 && value <= 2147483647 ? value : undefined;
  return { viewCount: count(info?.view_count), commentCount: count(object(info?.reply_info)?.reply_count) };
}

function reactionsView(raw: TdObject): MessageReactions | undefined {
  const reactions = object(object(raw.interaction_info)?.reactions);
  const items = array(reactions?.reactions).slice(0, 100).flatMap((entry): MessageReactions["items"] => {
    const reaction = object(entry);
    const type = object(reaction?.type);
    const count = reaction?.total_count;
    if (!type || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return [];
    const detail = { count, chosen: reaction?.is_chosen === true };
    if (type["@type"] === "reactionTypeEmoji" && typeof type.emoji === "string" && type.emoji.trim() && type.emoji.length <= 64) {
      return [{ ...detail, type: { kind: "emoji", emoji: type.emoji } }];
    }
    if (type["@type"] === "reactionTypeCustomEmoji" && typeof type.custom_emoji_id === "string" && /^-?[1-9]\d{0,19}$/.test(type.custom_emoji_id)) {
      return [{ ...detail, type: { kind: "custom", id: type.custom_emoji_id } }];
    }
    if (type["@type"] === "reactionTypePaid") return [{ ...detail, type: { kind: "paid" } }];
    return [];
  });
  return items.length ? { items, tags: reactions?.are_tags === true } : undefined;
}

const serviceLabels = new Map([
  ["messageBasicGroupChatCreate", "Group created"],
  ["messageSupergroupChatCreate", "Chat created"],
  ["messageChatChangePhoto", "Chat photo changed"],
  ["messageChatDeletePhoto", "Chat photo removed"],
  ["messageChatJoinByLink", "Joined via invite link"],
  ["messageChatJoinByRequest", "Join request approved"],
  ["messageChatDeleteMember", "Chat member left or was removed"],
  ["messageChatUpgradeTo", "Group upgraded to a supergroup"],
  ["messageChatUpgradeFrom", "Group upgraded to a supergroup"],
  ["messagePinMessage", "Message pinned"],
  ["messageScreenshotTaken", "Screenshot taken"],
  ["messageChatSetBackground", "Chat background changed"],
  ["messageChatSetTheme", "Chat theme changed"],
]);

function serviceMessageText(content: TdObject | undefined): string | undefined {
  switch (content?.["@type"]) {
    case "messageChatSetMessageAutoDeleteTime": {
      const seconds = content.message_auto_delete_time;
      if (seconds === 0) return "Message auto-delete turned off";
      if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) return "Message auto-delete timer changed";
      const [amount, unit] = seconds % 86400 === 0 ? [seconds / 86400, "day"]
        : seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
      return `Message auto-delete set to ${amount} ${unit}${amount === 1 ? "" : "s"}`;
    }
    case "messageChatChangeTitle": {
      const title = typeof content.title === "string" ? content.title.trim().slice(0, 256) : "";
      return title ? `Chat renamed to “${title}”` : "Chat name changed";
    }
    case "messageChatAddMembers": {
      const count = array(content.member_user_ids).length;
      return count > 1 ? `${count} members added to the chat` : "Member joined the chat";
    }
    case "messageForumTopicCreated": return "Topic created";
    case "messageForumTopicEdited": return "Topic edited";
    case "messageForumTopicIsClosedToggled": return content.is_closed === true ? "Topic closed" : "Topic reopened";
    case "messageForumTopicIsHiddenToggled": return content.is_hidden === true ? "Topic hidden" : "Topic shown";
    default: return content ? serviceLabels.get(content["@type"]) : undefined;
  }
}

function stickerSetId(value: unknown) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^-?[1-9]\d{0,18}$/.test(id) ? id : undefined;
}

function message(value: unknown, author: string): Message | undefined {
  const raw = object(value);
  if (!raw || !Number.isSafeInteger(raw.id)) return;
  const content = object(raw.content);
  const photo = photoFiles(raw);
  const sticker = object(content?.sticker);
  const stickerThumbnail = content?.["@type"] === "messageSticker" && mayShareHistoryMessage(raw)
    && object(sticker?.format)?.["@type"] !== "stickerFormatWebm"
    && object(object(sticker?.thumbnail)?.file);
  const formatted = object(content?.text) ?? object(content?.caption);
  const text = formatted?.text;
  const links: MessageLink[] = [];
  const styles: StyledRange[] = [];
  const spoilers: StyledRange[] = [];
  const maxStyles = 128;
  const entities = array(formatted?.entities);
  if (typeof text === "string" && text.trim()) {
    for (const entry of entities) {
      const entity = object(entry);
      const type = object(entity?.type);
      const offset = entity?.offset;
      const length = entity?.length;
      if (!type || typeof offset !== "number" || typeof length !== "number" || !Number.isSafeInteger(offset)
        || !Number.isSafeInteger(length) || offset < 0 || offset >= 8192 || length < 1 || offset + length > text.length) continue;
      const style = telegramStyles.get(type["@type"]);
      if (style === "spoiler") {
        const end = Math.min(8192, offset + length);
        if (spoilers.length < maxStyles) spoilers.push({ offset, length: end - offset, style });
        else {
          const tail = spoilers[maxStyles - 1]!;
          const start = Math.min(tail.offset, offset);
          tail.length = Math.max(tail.offset + tail.length, end) - start;
          tail.offset = start;
        }
      } else if (style && styles.length < maxStyles && offset + length <= 8192) {
        styles.push({ offset, length, style });
      }
      if (links.length >= 128 || offset + length > 8192) continue;
      const label = text.slice(offset, offset + length);
      const value = type["@type"] === "textEntityTypeTextUrl" ? type.url
        : type["@type"] === "textEntityTypeUrl" ? (/^[^:/\s]+\.[^:/\s]+/.test(label) ? `https://${label}` : label)
        : undefined;
      const url = typeof value === "string" ? webLink(value)?.href : undefined;
      if (url && url.length <= 4096) links.push({ offset, length, url, ...(type["@type"] === "textEntityTypeTextUrl" ? { hidden: true } : {}) });
    }
    links.sort((a, b) => a.offset - b.offset);
  }
  const type = content?.["@type"];
  const sender = messageSenderView(raw.sender_id);
  const preview = type === "messageText" ? object(content?.link_preview) : undefined;
  const previewUrl = typeof preview?.url === "string" ? webLink(preview.url) : undefined;
  const previewText = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  const counts = raw.is_channel_post === true ? channelPostCounts(raw) : undefined;
  const channelSignature = raw.is_channel_post === true ? authorSignature(raw) : "";
  const editedAt = typeof raw.edit_date === "number" && Number.isInteger(raw.edit_date)
    && raw.edit_date > 0 && raw.edit_date <= 2147483647 ? raw.edit_date : undefined;
  const serviceText = serviceMessageText(content);
  const pinnedTarget = type === "messagePinMessage" ? content?.message_id : undefined;
  const label = type?.startsWith("message") ? type.slice(7).replace(/([a-z])([A-Z])/g, "$1 $2") : "";
  const modern = object(raw.reply_to);
  const document = documentFile(raw);
  const poll = pollView(content);
  const reactions = reactionsView(raw);
  const topic = forumTopicId(raw);
  const thread = topic === undefined ? threadRoot(raw) : undefined;
  const replyQuote = displayReplyQuote(modern);
  const replyId = modern
    ? modern["@type"] === "messageReplyToMessage" && modern.chat_id === raw.chat_id ? modern.message_id : undefined
    : raw.reply_in_chat_id === raw.chat_id || !raw.reply_in_chat_id ? raw.reply_to_message_id : undefined;
  const editableFormatting = entities.length === styles.length + spoilers.length
    && entities.every((entry) => {
      const entityType = object(object(entry)?.type)?.["@type"];
      return !!entityType && Object.values(outgoingTextStyles).includes(entityType);
    }) && validDraftStyles(typeof text === "string" ? text : "", [...styles, ...spoilers]);
  return {
    ...(replyQuote ? { replyQuote } : {}),
    ...(type === "messageText" && typeof text === "string" && text.trim() && text.length <= 8192
      && !spoilers.length && !raw.sending_state ? { canQuote: true as const } : {}),
    ...(typeof replyId === "number" && Number.isSafeInteger(replyId) && replyId > 0 ? { replyTo: String(replyId) } : {}),
    ...(topic === undefined ? {} : { forumTopicId: topic }),
    ...(thread === undefined ? {} : { threadRoot: thread }),
    ...(object(raw.forward_info) ? { forwardedFrom: "" } : {}),
    id: String(raw.id), author, time: messageTime(raw.date),
    ...(typeof raw.date === "number" && Number.isInteger(raw.date) && raw.date > 0 && raw.date <= 2147483647
      ? { timestamp: raw.date } : {}),
    ...(type === "messageAnimation" ? { animation: true as const } : {}),
    ...((type === "messageSticker" || type === "messageAnimation") && mayShareHistoryMessage(raw) && document?.id
      ? { collectionKind: type === "messageSticker" ? "sticker" as const : "gif" as const,
        ...(type === "messageSticker" && stickerSetId(sticker?.set_id) ? { hasStickerPack: true as const } : {}) } : {}),
    ...(type === "messageVoiceNote" && document?.downloadable ? { voiceNote: true as const } : {}),
    ...(type === "messageVideoNote" && document?.downloadable ? { videoNote: true as const } : {}),
    ...(typeof raw.media_album_id === "string" && /^-?[1-9]\d*$/.test(raw.media_album_id) ? { albumId: raw.media_album_id } : {}),
    text: serviceText ?? (typeof text === "string" && text.trim() ? text.slice(0, 8192) : poll?.question ?? (label || "Message")),
    ...(serviceText ? { service: true as const } : {}),
    ...(typeof pinnedTarget === "number" && Number.isSafeInteger(pinnedTarget) && pinnedTarget > 0
      ? { pinnedTargetId: String(pinnedTarget) } : {}),
    ...(poll ? { poll } : {}),
    ...(reactions ? { reactions } : {}),
    ...(links.length ? { links } : {}),
    ...(styles.length || spoilers.length ? { styles: [...spoilers, ...styles.slice(0, maxStyles - spoilers.length)] } : {}),
    ...(document ? { document: { name: document.name, downloadable: document.downloadable,
      ...(document.sizeBytes === undefined ? {} : { sizeBytes: document.sizeBytes }),
      ...(document.approximateSize ? { approximateSize: true } : {}),
      ...(document.playbackMime ? { playbackMime: document.playbackMime } : {}),
      ...(typeof text === "string" && text.trim() ? { caption: text.slice(0, 8192) } : {}) } } : {}),
    outgoing: raw.is_outgoing === true,
    ...(sender ? { sender } : {}),
    ...(previewUrl && previewUrl.href.length <= 4096 ? { linkPreview: {
      url: previewUrl.href,
      site: previewText(preview?.site_name, 256),
      title: previewText(preview?.title, 512),
      description: previewText(object(preview?.description)?.text, 1024),
      above: preview?.show_above_text === true,
    } } : {}),
    ...(raw.is_channel_post === true ? { isChannelPost: true } : {}),
    ...(counts?.commentCount === undefined ? {} : { commentCount: counts.commentCount }),
    ...(counts?.viewCount === undefined ? {} : { viewCount: counts.viewCount }),
    ...(object(raw.sending_state) ? { pendingDelivery: true } : {}),
    editable: raw.is_outgoing === true && raw.can_be_edited !== false && type === "messageText"
      && typeof text === "string" && text.length <= 4096 && editableFormatting,
    ...(["messagePhoto", "messageVideo", "messageAnimation", "messageAudio", "messageDocument"].includes(type ?? "")
      && raw.is_outgoing === true && raw.can_be_edited !== false && !raw.sending_state
      && !raw.self_destruct_type && !content?.is_secret && editableFormatting ? {
        editableCaption: true,
        ...(["messagePhoto", "messageVideo", "messageAnimation"].includes(type ?? "") ? { canMoveCaption: true as const } : {}),
      } : {}),
    ...(content?.show_caption_above_media === true ? { captionAboveMedia: true } : {}),
    ...(content?.has_spoiler === true && (type === "messageVideo" || type === "messageAnimation") ? { videoSpoiler: true as const } : {}),
    ...(stickerThumbnail ? { hasPhoto: true } : {}),
    ...(photo
      ? { hasPhoto: true, photoDimensions: photo.dimensions, ...(content?.has_spoiler === true ? { photoSpoiler: true } : {}),
        ...(mayShareHistoryMessage(raw) ? { canSavePhoto: true as const } : {}),
        ...(typeof text === "string" && text.trim() ? { photoCaption: text.slice(0, 8192) } : {}) }
      : {}),
    edited: editedAt !== undefined,
    ...(editedAt === undefined ? {} : { editedAt }),
    ...(channelSignature ? { channelSignature } : {}),
  };
}

function originalText(raw: TdObject | undefined, chatId: string): string | undefined {
  if (!raw || String(raw.chat_id) !== chatId
    || raw.can_be_saved === false || raw.has_protected_content || raw.forward_info || raw.import_info
    || raw.via_bot_user_id && raw.via_bot_user_id !== "0"
    || raw.sending_state || object(raw.content)?.["@type"] !== "messageText") return;
  const content = object(object(raw.content)?.text)?.text;
  if (typeof content === "string" && content.trim() && Buffer.byteLength(content, "utf8") <= 4096) return content;
}

type OwnNote = Pick<Message, "id" | "time" | "text" | "forumTopicId">;
type NoteDateRange = { from?: number; until?: number };

function isInNoteDateRange(raw: unknown, range?: NoteDateRange): boolean {
  if (!range) return true;
  const date = object(raw)?.date;
  return typeof date === "number" && Number.isSafeInteger(date)
    && (range.from === undefined || date >= range.from)
    && (range.until === undefined || date < range.until);
}

function mayShareHistoryMessage(row: TdObject): boolean {
  return row.can_be_saved !== false && !row.has_protected_content && !row.self_destruct_type
    && !row.ttl && !row.sending_state && !object(row.content)?.is_secret;
}

function noteFromText(raw: TdObject, text: string): OwnNote | undefined {
  if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id <= 0) return;
  const topic = forumTopicId(raw);
  return { id: String(raw.id), time: messageTime(raw.date), text, ...(topic === undefined ? {} : { forumTopicId: topic }) };
}

function ownText(item: unknown, chatId: string, ownerId: string): OwnNote[] {
  const raw = object(item);
  const sender = object(raw?.sender_id);
  if (!raw || (raw.is_channel_post === true ? Number(raw.edit_date) > 0 : raw.is_outgoing !== true)
    || sender?.["@type"] !== "messageSenderUser" || String(sender.user_id) !== ownerId) return [];
  const text = originalText(raw, chatId);
  const note = text === undefined ? undefined : noteFromText(raw, text);
  return note ? [note] : [];
}

export function createTelegram(
  options: Options,
  open = connectTdJson,
  notifyChatChanged: () => void = () => {},
  notifyMessagesDeleted: (event: MessagesDeleted) => void = () => {},
  notifyMessage?: (event: MessageNotification) => void,
) {
  let notificationsSince = Infinity;
  const recentNotificationKeys = new Set<string>();
  let state: Auth = { state: "connecting" };
  let current = "";
  let folders: TelegramFolder[] = [];
  let modernFolders = false;
  let mainFolderPosition: number | undefined;
  let folderTagsEnabled = false;
  let reactionNotificationSettings: TdObject | undefined;
  const folderUpdates = new Map<number, { until: number; preview: Promise<FolderInvite | null> }>();
  const applyingFolderUpdates = new Set<number>();
  const addingRecommendedFolders = new Set<string>();
  let finishLogout: ((closed: boolean) => void) | undefined;
  let transport: Transport;
  let outgoingAttachment = false;
  const outcomes = new Map<string, SendResult>();
  const transcription = createLocalTranscription();
  const transcriptionSession = new AbortController();
  const gifResults = new Map<string, { chatId: number; topic?: ForumTopicTarget; queryId: string; resultId: string; expires: number }>();
  const openingOneView = new Set<string>();
  const downloadingDocuments = new Set<number>();
  const videoParts = new Map<number, Promise<void>>();
  const waiting = new Map<string, (result: SendResult) => void>();
  let retentionWork = Promise.resolve();
  let retentionAccount: Promise<string> | undefined;

  async function accountId(): Promise<string> {
    requireReady();
    const user = await request({ "@type": "getMe" });
    if (user["@type"] !== "user" || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
      throw new Error("Telegram account is unavailable.");
    }
    return String(user.id);
  }

  function archiveAccount() {
    return retentionAccount ??= accountId().catch((error) => { retentionAccount = undefined; throw error; });
  }

  function snapshot(raw: TdObject, author: string): Message | undefined {
    if (raw.is_outgoing !== false || !Number.isSafeInteger(raw.id) || Number(raw.id) <= 0 || raw.sending_state) return;
    const content = object(raw.content);
    const view = message(raw, author);
    if (!view) return;
    const expires = !!(raw.self_destruct_type || raw.ttl || content?.is_secret || expiredMedia.has(content?.["@type"] ?? ""));
    if (expires || raw.can_be_saved === false || raw.has_protected_content) {
      return { id: view.id, time: view.time, timestamp: view.timestamp, author, text: expires ? "Disappearing media" : "Protected message" };
    }
    return {
      id: view.id, time: view.time, timestamp: view.timestamp, author, text: view.text, links: view.links, styles: view.styles, service: view.service,
      ...(view.document ? { document: { ...view.document, downloadable: false, playbackMime: undefined } } : {}),
      ...(view.hasPhoto ? { text: view.photoCaption ?? "Photo" } : {}),
    };
  }

  function queueRetention<T>(work: () => Promise<T>) {
    const next = retentionWork.then(work);
    retentionWork = next.then(() => {}, () => {});
    return next;
  }

  function trackDelivery(event: TdObject) {
    const raw = object(event.message);
    if (!raw || !Number.isSafeInteger(raw.chat_id) || !Number.isSafeInteger(event.old_message_id)) return;
    const key = `${raw.chat_id}:${event.old_message_id}`;
    const sent = event["@type"] === "updateMessageSendSucceeded" ? message(raw, "You") : undefined;
    if (state.state === "ready" && sent && raw.id !== event.old_message_id) {
      // A successful send replaces the temporary TDLib message. Remove its
      // row from any loaded history while the normal refresh fetches the new ID.
      notifyMessagesDeleted({ id: String(raw.chat_id), messageIds: [String(event.old_message_id)] });
    }
    const result: SendResult = sent ? { state: "sent", message: sent }
      : { state: event["@type"] === "updateMessageSendFailed" ? "failed" : "unknown" };
    const resolve = waiting.get(key);
    if (resolve) resolve(result);
    else {
      outcomes.set(key, result);
      if (outcomes.size > 32) outcomes.delete(outcomes.keys().next().value!);
    }
  }

  function waitForDelivery(key: string, timeoutMs: number): Promise<SendResult> {
    const outcome = outcomes.get(key);
    if (outcome) {
      outcomes.delete(key);
      return Promise.resolve(outcome);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ state: "unknown" }), timeoutMs);
      function finish(result: SendResult) {
        clearTimeout(timer);
        waiting.delete(key);
        resolve(result);
      }
      waiting.set(key, finish);
    });
  }
  function stopWaitingForDelivery() {
    for (const finish of waiting.values()) finish({ state: "unknown" });
    outcomes.clear();
  }

  function fail(message: string) { state = { state: "error", message }; }
  const request = (query: TdObject, timeoutMs?: number, signal?: AbortSignal) => signal
    ? transport.request(query, timeoutMs, signal)
    : timeoutMs === undefined ? transport.request(query) : transport.request(query, timeoutMs);

  async function postingPermissions(chatId: string, expectedTitle?: string): Promise<PostingPermissions> {
    requireReady();
    const both = (allowed: boolean) => ({ text: allowed, photo: allowed, document: allowed });
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id) return both(false);
    const chat = await request({ "@type": "getChat", chat_id });
    if (chat.id !== chat_id || (expectedTitle !== undefined && chatTitle(chat) !== expectedTitle)) return both(false);
    const type = object(chat.type);
    if (type?.["@type"] === "chatTypeSecret") return both(false);
    const basic = type?.["@type"] === "chatTypeBasicGroup";
    if (!basic && type?.["@type"] !== "chatTypeSupergroup") return { ...both(true), voice: true, videoNote: true, video: true, otherMedia: true };
    const groupId = basic ? type.basic_group_id : type.supergroup_id;
    if (!Number.isSafeInteger(groupId)) return both(false);
    const group = await request(basic
      ? { "@type": "getBasicGroup", basic_group_id: groupId }
      : { "@type": "getSupergroup", supergroup_id: groupId });
    if (group.id !== groupId || (basic && group.is_active === false)
      || (!basic && (group.is_channel === true) !== (type.is_channel === true))) return both(false);
    const status = object(group.status);
    if (!basic && status?.["@type"] === "chatMemberStatusLeft") {
      const isPublic = (typeof group.username === "string" && group.username.length > 0)
        || array(object(group.usernames)?.active_usernames).some((name) => typeof name === "string" && name.length > 0);
      if (isPublic) return { ...both(false), join: group.join_by_request === true ? "request" : "join" };
    }
    const pollsAllowed = group.is_direct_messages_group !== true;
    const allGroupRights = (allowed: boolean) => ({ ...both(allowed), ...(allowed && pollsAllowed ? { poll: true } : {}), ...(allowed ? { voice: true, videoNote: true, video: true, otherMedia: true } : {}) });
    if (status?.["@type"] === "chatMemberStatusCreator") return allGroupRights(status.is_member === true);
    if (type.is_channel === true) {
      return allGroupRights(status?.["@type"] === "chatMemberStatusAdministrator"
        && (object(status.rights)?.can_post_messages === true || status.can_post_messages === true));
    }
    if (status?.["@type"] === "chatMemberStatusAdministrator") return allGroupRights(true);
    const permissions = status?.["@type"] === "chatMemberStatusRestricted" && status.is_member === true
      ? object(status.permissions)
      : status?.["@type"] === "chatMemberStatusMember" ? object(chat.permissions) : undefined;
    return {
      text: (permissions?.can_send_basic_messages ?? permissions?.can_send_messages) === true,
      photo: (permissions?.can_send_photos ?? permissions?.can_send_media_messages) === true,
      document: (permissions?.can_send_documents ?? permissions?.can_send_media_messages) === true,
      ...(permissions?.can_send_voice_notes === true ? { voice: true } : {}),
      ...(permissions?.can_send_video_notes === true ? { videoNote: true } : {}),
      ...(permissions?.can_send_videos === true ? { video: true } : {}),
      ...(permissions?.can_send_other_messages === true ? { otherMedia: true } : {}),
      ...(pollsAllowed && permissions?.can_send_polls === true ? { poll: true } : {}),
    };
  }

  function senderKey(chat: TdObject): string {
    const sender = object(chat.message_sender_id);
    if (sender?.["@type"] === "messageSenderChat" && Number.isSafeInteger(sender.chat_id)) return `chat:${sender.chat_id}`;
    if (sender?.["@type"] === "messageSenderUser" && Number.isSafeInteger(sender.user_id)) return `user:${sender.user_id}`;
    return object(chat.type)?.is_channel === true ? `chat:${chat.id}` : "account";
  }

  async function forumTopicRecord(chatId: string, id: number) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isInteger(id) || id <= 0 || id > 2147483647) return;
    const topic = await request({ "@type": "getForumTopic", chat_id, forum_topic_id: id });
    const info = object(topic.info);
    if (topic["@type"] === "forumTopic" && info?.["@type"] === "forumTopicInfo" && info.chat_id === chat_id
      && info.forum_topic_id === id) return { topic, info };
  }

  async function forumTopicName(chatId: string, id: number): Promise<string | undefined> {
    const record = await forumTopicRecord(chatId, id);
    const name = record?.info.name;
    if (typeof name === "string" && name.trim()) return name.slice(0, 256);
  }

  async function readTopicDraft(chatId: string, topicId: number): Promise<TopicDraft> {
    const record = await forumTopicRecord(chatId, topicId);
    if (!record) return { text: null, writable: false };
    const text = plainDraftText(record.topic);
    const draft = object(record.topic.draft_message);
    const preview = object(object(draft?.content)?.link_preview_options);
    const customPreview = preview && (preview.url || preview.show_above_text || preview.force_small_media
      || preview.force_large_media || preview.is_disabled);
    return { text: text ?? null, writable: !customPreview && (!record.topic.draft_message || text !== undefined) };
  }

  async function canScheduleWhenOnline(chatId: string): Promise<boolean> {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || chat_id <= 0) return false;
    const chat = await request({ "@type": "getChat", chat_id });
    const kind = object(chat.type);
    if (chat["@type"] !== "chat" || chat.id !== chat_id || kind?.["@type"] !== "chatTypePrivate" || kind.user_id !== chat_id) return false;
    const [own, user] = await Promise.all([
      request({ "@type": "getMe" }), request({ "@type": "getUser", user_id: chat_id }),
    ]);
    if (own["@type"] !== "user" || !Number.isSafeInteger(own.id) || own.id === chat_id
      || object(own.type)?.["@type"] === "userTypeBot" || user["@type"] !== "user"
      || user.id !== chat_id || object(user.type)?.["@type"] !== "userTypeRegular") return false;
    const status = object(user.status);
    return status?.["@type"] === "userStatusOnline" || status?.["@type"] === "userStatusOffline"
      && typeof status.was_online === "number" && status.was_online > 0;
  }

  async function sendContent(id: number, input_message_content: TdObject, reply?: TdObject, authorizeDispatch?: () => boolean, expectedSender?: SendIdentity, protectSharedReply = false, deliveryTimeoutMs = 6500, topic?: number | { thread: number }, deliveryOptions?: TextDelivery): Promise<SendResult> {
    const permissions = await postingPermissions(String(id));
    const type = input_message_content["@type"];
    if (!permissions[type === "inputMessagePhoto" ? "photo" : type === "inputMessageDocument" ? "document" : type === "inputMessagePoll" ? "poll" : type === "inputMessageVoiceNote" ? "voice"
      : type === "inputMessageVideoNote" ? "videoNote" : type === "inputMessageVideo" ? "video" : type === "inputMessageSticker" || type === "inputMessageAnimation" ? "otherMedia" : "text"]) return { state: "failed" };
    if (expectedSender !== undefined || protectSharedReply) {
      const chat = await request({ "@type": "getChat", chat_id: id });
      const key = typeof expectedSender === "object" ? expectedSender.key : expectedSender;
      if (chat.id !== id || (key !== undefined && senderKey(chat) !== key)
        || (protectSharedReply && !allowsSharing(chat))) return { state: "failed" };
      if (typeof expectedSender === "object") {
        const kind = chatKind(chat);
        if (kind !== expectedSender.kind) return { state: "failed" };
        if (chatTitle(chat) !== expectedSender.name) {
          // Saved Messages has a fixed UI title, distinct from the account name returned by TDLib.
          if (kind !== "Direct message" || expectedSender.name !== "Saved Messages") return { state: "failed" };
          const user = await request({ "@type": "getMe" });
          if (user["@type"] !== "user" || user.id !== id) return { state: "failed" };
        }
      }
    }
    if (state.state !== "ready" || (authorizeDispatch && !authorizeDispatch())) return { state: "failed" };
    const at = deliveryOptions?.at;
    if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) {
      return { state: "failed" };
    }
    const repeatEvery = deliveryOptions?.repeatEvery;
    if (repeatEvery !== undefined) {
      if (at === undefined || authorizeDispatch || !scheduleRepeatPeriods.includes(repeatEvery)) return { state: "failed" };
      const user = await request({ "@type": "getMe" });
      if (user["@type"] !== "user" || user.is_premium !== true) return { state: "failed" };
    }
    const online = deliveryOptions?.whenOnline === true;
    if (online && (at !== undefined || authorizeDispatch || topic !== undefined || !await canScheduleWhenOnline(String(id)))) {
      return { state: "failed" };
    }
    const scheduling = online ? { "@type": "messageSchedulingStateSendWhenOnline" }
      : at === undefined ? undefined : { "@type": "messageSchedulingStateSendAtDate", send_date: at, ...(repeatEvery ? { repeat_period: repeatEvery } : {}) };
    const result = await request({
      "@type": "sendMessage", chat_id: id,
      ...(topic === undefined ? {} : { topic_id: typeof topic === "number"
        ? { "@type": "messageTopicForum", forum_topic_id: topic }
        : { "@type": "messageTopicThread", message_thread_id: topic.thread } }),
      ...(reply ? { reply_to_message_id: reply.message_id, reply_to: reply } : {}),
      ...(scheduling || deliveryOptions?.silent ? { options: {
        "@type": "messageSendOptions", disable_notification: deliveryOptions?.silent === true,
        ...(scheduling ? { scheduling_state: scheduling } : {}),
      } } : {}),
      input_message_content,
    });
    if (result["@type"] !== "message" || result.chat_id !== id || !Number.isSafeInteger(result.id)) return { state: "unknown" };
    const sending = object(result.sending_state)?.["@type"];
    if (sending === "messageSendingStateFailed") return { state: "failed" };
    const scheduled = object(result.scheduling_state);
    if (at !== undefined && (scheduled?.send_date !== at || (scheduled.repeat_period ?? 0) !== (repeatEvery ?? 0))
      || online && scheduled?.["@type"] !== "messageSchedulingStateSendWhenOnline") return { state: "unknown" };
    let delivery: SendResult = { state: "unknown" };
    if (sending === "messageSendingStatePending" && state.state === "ready") {
      delivery = await waitForDelivery(`${id}:${result.id}`, deliveryTimeoutMs);
    } else if (!sending) {
      const sent = message(result, "You");
      if (sent) delivery = { state: "sent", message: sent };
    }
    if (delivery.state === "sent" && ((reply && delivery.message.replyTo !== String(reply.message_id))
      || (typeof topic === "number" && delivery.message.forumTopicId !== topic)
      || (typeof topic === "object" && delivery.message.threadRoot !== String(topic.thread)))) return { state: "unknown" };
    return delivery;
  }

  async function publicChat(username: string): Promise<Chat | undefined> {
    requireReady();
    if (!/^[a-z0-9_]{1,64}$/i.test(username)) return;
    try {
      const chat = await request({ "@type": "searchPublicChat", username });
      if (chat["@type"] === "chat" && object(chat.type)?.["@type"] !== "chatTypeSecret") return chatView(chat);
    } catch (error) {
      if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
    }
  }

  async function previewFolderInvite(url: string): Promise<FolderInvite | null> {
    requireReady();
    if (!modernFolders || !isTelegramFolderInviteLink(url)) return null;
    let result: TdObject;
    try {
      result = await request({ "@type": "checkChatFolderInviteLink", invite_link: url });
    } catch (error) {
      if (error instanceof TdError && [400, 404].includes(error.code)) return null;
      throw error;
    }
    const folder = object(result.chat_folder_info);
    const title = folder && folderTitle(folder)?.slice(0, 128);
    if (result["@type"] !== "chatFolderInviteLinkInfo" || folder?.["@type"] !== "chatFolderInfo" || !title) return null;
    const addedIds = new Set(array(result.added_chat_ids).filter((id) =>
      typeof id === "number" && Number.isSafeInteger(id) && id !== 0));
    const ids = [...new Set(array(result.missing_chat_ids).filter((id): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id !== 0 && !addedIds.has(id)))].slice(0, 200);
    const rows = await Promise.all(ids.map(async (id) => {
      const chat = await request({ "@type": "getChat", chat_id: id }).catch(() => undefined);
      if (chat?.["@type"] !== "chat" || chat.id !== id || typeof chat.title !== "string" || !chat.title.trim()) return;
      return { id: String(id), title: chat.title.slice(0, 256) };
    }));
    const chats = rows.filter((row) => row !== undefined);
    const token = createHash("sha256").update(JSON.stringify([url, folder.id, title, chats])).digest("hex");
    return { title, token, chats, alreadyAdded: addedIds.size };
  }

  async function previewInvite(url: string): Promise<InvitePreview | null> {
    requireReady();
    if (!isTelegramInviteLink(url)) return null;
    try {
      const info = await request({ "@type": "checkChatInviteLink", invite_link: url });
      if (info["@type"] !== "chatInviteLinkInfo" || typeof info.title !== "string" || !info.title.trim()) return null;
      const type = object(info.type);
      const kind = type?.["@type"] === "inviteLinkChatTypeChannel" || type?.is_channel === true ? "Channel" : "Group";
      const id = info.chat_id;
      const count = info.member_count;
      return {
        title: info.title.slice(0, 256), kind,
        mode: info.subscription_info ? "subscription" : info.creates_join_request === true ? "request" : "join",
        ...(typeof id === "number" && Number.isSafeInteger(id) && id !== 0 ? { chatId: String(id) } : {}),
        ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? { memberCount: count } : {}),
      };
    } catch (error) {
      if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
      return null;
    }
  }

  function joinResult(result: TdObject, expectedId?: number): ChatJoinResult {
    switch (result["@type"]) {
      case "chatJoinResultSuccess":
      case "chat": {
        const id = result["@type"] === "chat" ? result.id : result.chat_id;
        if (!Number.isSafeInteger(id) || !id || (expectedId !== undefined && id !== expectedId)) return "unknown";
        notifyChatChanged();
        return "joined";
      }
      case "ok":
        notifyChatChanged();
        return "joined";
      case "chatJoinResultRequestSent": return "requested";
      case "chatJoinResultGuardBotApprovalRequired": return "verification_required";
      case "chatJoinResultDeclined": return "refused";
      default: return "unknown";
    }
  }

  async function listReactions(chatId: string, messageId: string): Promise<string[]> {
    requireReady();
    const chat_id = Number(chatId);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return [];
    const available = await request({ "@type": "getMessageAvailableReactions", chat_id, message_id, row_size: 8 });
    if (available["@type"] !== "availableReactions") return [];
    const allowed = [available.top_reactions, available.recent_reactions, available.popular_reactions].flatMap((rows) =>
      array(rows).slice(0, 100).flatMap((item) => {
        const reaction = object(item);
        const type = object(reaction?.type);
        return reaction?.needs_premium !== true && type?.["@type"] === "reactionTypeEmoji"
          && typeof type.emoji === "string" && type.emoji.trim() && type.emoji.length <= 64 ? [type.emoji] : [];
      }));
    return [...new Set(allowed)].slice(0, 100);
  }

  const observedInteractions = new Map<string, { signature: string; channel: boolean }>();
  function rememberInteractions(chatId: unknown, messageId: unknown, raw: TdObject, channel?: boolean): boolean {
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)
      || typeof messageId !== "number" || !Number.isSafeInteger(messageId)) return false;
    const key = `${chatId}:${messageId}`;
    const previous = observedInteractions.get(key);
    const channelPost = channel ?? previous?.channel ?? false;
    const reactions = reactionsView(raw);
    if (!channelPost && !reactions) return observedInteractions.delete(key);
    const signature = JSON.stringify([reactions, channelPost ? channelPostCounts(raw) : null]);
    if (previous?.signature === signature && previous.channel === channelPost) return false;
    observedInteractions.set(key, { signature, channel: channelPost });
    if (observedInteractions.size > 1024) {
      const oldest = observedInteractions.keys().next().value;
      if (oldest !== undefined) observedInteractions.delete(oldest);
    }
    return true;
  }

  function publishMessageNotification(event: TdObject) {
    if (!notifyMessage || state.state !== "ready" || !Array.isArray(event.added_notifications)
      || !Number.isSafeInteger(event.chat_id) || !event.chat_id || !Number.isInteger(event.notification_group_id)) return;
    const chatId = Number(event.chat_id);
    const now = Math.floor(Date.now() / 1000);
    for (const data of event.added_notifications.slice().reverse()) {
      const notification = object(data);
      const type = object(notification?.type);
      const rawMessage = object(type?.message);
      const date = notification?.date;
      if (notification?.["@type"] !== "notification" || !Number.isInteger(notification.id)
        || typeof date !== "number" || date < Math.max(notificationsSince, now - 30)
        || type?.["@type"] !== "notificationTypeNewMessage" || rawMessage?.["@type"] !== "message"
        || rawMessage.chat_id !== chatId || rawMessage.is_outgoing !== false
        || typeof rawMessage.id !== "number" || !Number.isSafeInteger(rawMessage.id) || rawMessage.id <= 0) continue;
      const key = `${event.notification_group_id}:${notification.id}`;
      if (recentNotificationKeys.has(key)) continue;
      recentNotificationKeys.add(key);
      if (recentNotificationKeys.size > 128) recentNotificationKeys.delete(recentNotificationKeys.values().next().value!);
      const preview = type.show_preview === true && object(rawMessage.content)?.["@type"] === "messageText"
        ? previewMessageText(message(rawMessage, ""))?.trim().slice(0, 160) : undefined;
      const topicId = forumTopicId(rawMessage);
      notifyMessage({ key, chatId: String(chatId), messageId: String(rawMessage.id),
        ...(topicId === undefined ? {} : { topicId }), ...(preview ? { preview } : {}) });
      return;
    }
  }

  async function apply(event: TdObject) {
    if (event["@type"] === "updateNotificationGroup") publishMessageNotification(event);
    if (event["@type"] === "makoshTdlibLoadFailed") {
      fail("Python could not load TDLib. Check the library, its dependencies, and the Mac architecture.");
      return;
    }
    const archive = options.privateHistory;
    if (archive && state.state === "ready" && event["@type"] === "updateNewMessage") {
      const raw = object(event.message);
      if (raw?.is_outgoing === false && Number.isSafeInteger(raw.chat_id) && Number(raw.chat_id) > 0) {
        void queueRetention(async () => {
          const chat = await request({ "@type": "getChat", chat_id: raw.chat_id });
          if (chat.id !== raw.chat_id || object(chat.type)?.["@type"] !== "chatTypePrivate") return;
          const account = await archiveAccount();
          const copy = snapshot(raw, chatTitle(chat));
          if (copy && state.state === "ready" && account !== String(chat.id)) {
            archive.save(account, String(chat.id), [
              allowsSharing(chat) ? copy : { id: copy.id, time: copy.time, author: copy.author, text: "Protected message" },
            ]);
          }
        }).catch(() => {});
      }
    }
    if (archive && state.state === "ready" && event["@type"] === "updateMessageContent"
      && Number.isSafeInteger(event.chat_id) && Number(event.chat_id) > 0 && Number.isSafeInteger(event.message_id)
      && expiredMedia.has(object(event.new_content)?.["@type"] ?? "")) {
      void queueRetention(async () => {
        const account = await archiveAccount();
        const id = String(event.chat_id);
        if (state.state === "ready") {
          const retained = archive.mark(account, id, String(event.message_id), "expired");
          if (retained) notifyMessagesDeleted({ id, messageIds: [], retained: [retained] });
        }
      }).catch(() => {});
    }
    if (state.state === "ready" && event["@type"] === "updateDeleteMessages" && event.from_cache !== true
      && typeof event.chat_id === "number" && Number.isSafeInteger(event.chat_id) && event.chat_id !== 0) {
      const messageIds = array(event.message_ids)
        .filter((id) => typeof id === "number" && Number.isSafeInteger(id) && id !== 0)
        .map(String);
      if (messageIds.length) {
        const id = String(event.chat_id);
        if (archive && event.is_permanent === true && event.chat_id > 0) {
          void queueRetention(async () => {
            const account = await archiveAccount();
            const retained: Message[] = [];
            const removed = messageIds.filter((messageId) => {
              const copy = archive.mark(account, id, messageId, "deleted");
              if (copy) retained.push(copy);
              return !copy;
            });
            return { id, messageIds: removed, ...(retained.length ? { retained } : {}) };
          }).catch(() => ({ id, messageIds })).then((change) => {
            if (state.state === "ready") notifyMessagesDeleted(change);
          });
        } else notifyMessagesDeleted({ id, messageIds });
      }
    }
    if (state.state === "ready" && event["@type"] === "updateMessageInteractionInfo"
      && rememberInteractions(event.chat_id, event.message_id, event)) notifyChatChanged();
    if (state.state === "ready" && ["updateNewMessage", "updatePoll", "updateChatDraftMessage", "updateChatLastMessage", "updateMessageSendSucceeded", "updateMessageContent", "updateMessageEdited", "updateMessageIsPinned", "updateDeleteMessages", "updateChatPhoto", "updateChatTitle", "updateChatReadInbox", "updateChatReadOutbox", "updateChatUnreadMentionCount", "updateMessageMentionRead", "updateChatUnreadReactionCount", "updateMessageUnreadReactions", "updateChatIsMarkedAsUnread", "updateChatPosition", "updateChatAddedToList", "updateChatRemovedFromList", "updateChatPermissions", "updateChatBlockList", "updateChatMessageAutoDeleteTime", "updateBasicGroup", "updateSupergroup"].includes(event["@type"])) {
      notifyChatChanged();
    }
    if (event["@type"] === "updateMessageSendSucceeded" || event["@type"] === "updateMessageSendFailed") {
      trackDelivery(event);
      return;
    }
    if (event["@type"] === "updateReactionNotificationSettings") {
      reactionNotificationSettings = object(event.notification_settings);
      return;
    }
    if (event["@type"] === "updateChatFilters" || event["@type"] === "updateChatFolders") {
      modernFolders = event["@type"] === "updateChatFolders";
      folderTagsEnabled = modernFolders && event.are_tags_enabled === true;
      folders = array(modernFolders ? event.chat_folders : event.chat_filters).flatMap((item) => {
        const folder = object(item);
        const id = folder?.id;
        const title = modernFolders ? folder?.name ?? folder?.title : folder?.title;
        const name = typeof title === "string" ? title : object(object(title)?.text)?.text;
        return typeof id === "number" && Number.isInteger(id) && id > 0 && typeof name === "string" && name.trim()
          ? [{ id, title: name.slice(0, 128), ...folderColorView(folder, folderTagsEnabled), ...folderIconView(folder) }] : [];
      });
      const mainPosition = event.main_chat_list_position;
      mainFolderPosition = modernFolders && typeof mainPosition === "number" && Number.isInteger(mainPosition)
        && mainPosition >= 0 && mainPosition <= folders.length ? mainPosition : undefined;
      if (state.state === "ready") notifyChatChanged();
      return;
    }
    const auth = object(event.authorization_state);
    if (event["@type"] !== "updateAuthorizationState" || !auth || auth["@type"] === current && current !== "authorizationStateWaitOtherDeviceConfirmation") return;
    current = auth["@type"];
    switch (current) {
      case "authorizationStateWaitTdlibParameters": {
        const parameters = {
          database_directory: options.directory, files_directory: options.directory,
          use_file_database: true, use_chat_info_database: true, use_message_database: true,
          use_secret_chats: false, api_id: options.apiId, api_hash: options.apiHash,
          system_language_code: "en", device_model: "BB Makosh on macOS",
          system_version: "macOS", application_version: "0.1.0",
        };
        try {
          await request({ "@type": "setTdlibParameters", ...parameters, database_encryption_key: options.key });
        } catch (error) {
          if (!(error instanceof TdError) || error.code !== 400) throw error;
          await request({
            "@type": "setTdlibParameters",
            parameters: { ...parameters, enable_storage_optimizer: true },
          });
        }
        break;
      }
      case "authorizationStateWaitEncryptionKey":
        await request({ "@type": "checkDatabaseEncryptionKey", encryption_key: options.key });
        break;
      case "authorizationStateWaitPhoneNumber":
        state = { state: "connecting" };
        await request({ "@type": "requestQrCodeAuthentication", other_user_ids: [] });
        break;
      case "authorizationStateWaitOtherDeviceConfirmation":
        if (typeof auth.link !== "string" || !/^tg:\/\/login\?token=[\w=-]+$/.test(auth.link)) {
          fail("TDLib returned an invalid sign-in link.");
        } else {
          state = { state: "qr", link: auth.link };
        }
        break;
      case "authorizationStateWaitPassword":
        state = { state: "password" };
        break;
      case "authorizationStateReady":
        state = { state: "ready" };
        if (notifyMessage) {
          notificationsSince = Math.floor(Date.now() / 1000);
          void request({ "@type": "setOption", name: "notification_group_count_max",
            value: { "@type": "optionValueInteger", value: "20" } }).catch(() => {});
        }
        break;
      case "authorizationStateClosing":
      case "authorizationStateLoggingOut":
        gifResults.clear();
        state = { state: finishLogout ? "disconnecting" : "connecting" };
        break;
      case "authorizationStateClosed":
        if (finishLogout) finishLogout(true);
        else if (state.state !== "idle") fail("Telegram sign-in stopped. Try reconnecting.");
        break;
      default:
        fail("Telegram sign-in stopped. Try reconnecting.");
    }
  }

  transport = open(options.library, (event) => {
    void apply(event).catch((error) => fail(error instanceof TdError
      ? `Telegram could not start sign-in (TDLib ${error.code}).` : "TDLib could not start sign-in."));
  }, () => {
    stopWaitingForDelivery();
    if (finishLogout) finishLogout(false);
    else if (state.state !== "error" && state.state !== "idle") fail("TDLib stopped. Check the macOS runtime and reconnect.");
  });
  void request({ "@type": "getAuthorizationState" }).then(
    (auth) => apply({ "@type": "updateAuthorizationState", authorization_state: auth }),
  ).catch(() => { if (state.state !== "error") fail("Could not connect to the TDLib runtime."); });

  function requireReady() {
    if (state.state !== "ready") throw new Error("Connect Telegram first.");
  }

  function chatLists(chat: TdObject): TdObject[] {
    const rows = Array.isArray(chat.chat_lists) ? chat.chat_lists : array(chat.positions).flatMap((item) => {
      const position = object(item);
      return position?.order && position.order !== "0" ? [position.list] : [];
    });
    return rows.map(object).filter((row): row is TdObject => row !== undefined);
  }

  function chatView(raw: TdObject): Chat | undefined {
    const id = raw.id;
    if (!Number.isSafeInteger(id)) return;
    const name = chatTitle(raw);
    const latest = message(raw.last_message, name);
    const photo = object(raw.photo);
    const avatar = chatAvatarSchema.safeParse(object(photo?.minithumbnail)?.data);
    const avatarFileId = object(photo?.small)?.id;
    const lists = chatLists(raw);
    const folderIds = [...new Set(lists.flatMap((list) => {
      const id = list["@type"] === "chatListFolder" ? list.chat_folder_id
        : list["@type"] === "chatListFilter" ? list.chat_filter_id : undefined;
      return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 2147483647 ? [id] : [];
    }))].slice(0, 100);
    const archived = lists.some((list) => list["@type"] === "chatListArchive") ? true
      : lists.some((list) => list["@type"] === "chatListMain") ? false : undefined;
    const colors = ["#247b78", "#387c7d", "#7760a4", "#246dbd", "#a75436"];
    return {
      id: String(id), name, senderKey: senderKey(raw),
      ...(avatar.success ? { avatarJpeg: avatar.data } : {}),
      ...(typeof avatarFileId === "number" && Number.isSafeInteger(avatarFileId) && avatarFileId > 0 ? { avatarFileId } : {}),
      initials: name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase(),
      color: colors[Math.abs(Number(id)) % colors.length]!,
      subtitle: chatKind(raw),
      unread: typeof raw.unread_count === "number" ? raw.unread_count : 0,
      ...(typeof raw.unread_mention_count === "number" && Number.isInteger(raw.unread_mention_count)
        && raw.unread_mention_count > 0 && raw.unread_mention_count <= 2147483647 ? { unreadMentions: raw.unread_mention_count } : {}),
      ...(typeof raw.unread_reaction_count === "number" && Number.isInteger(raw.unread_reaction_count)
        && raw.unread_reaction_count > 0 && raw.unread_reaction_count <= 2147483647 ? { unreadReactions: raw.unread_reaction_count } : {}),
      markedUnread: raw.is_marked_as_unread === true,
      ...(archived === undefined ? {} : { archived }),
      ...(folderIds.length ? { folderIds } : {}),
      messages: latest ? [latest] : [],
    };
  }

  async function resolveChats(result: TdObject, limit: number, belongs: (raw: TdObject) => boolean = () => true): Promise<Chat[]> {
    const ids = [...new Set(array(result.chat_ids).filter(Number.isSafeInteger))].slice(0, limit);
    const rows = await Promise.all(ids.map(async (id) => {
      const raw = await request({ "@type": "getChat", chat_id: id });
      return raw.id === id && belongs(raw) ? chatView(raw) : undefined;
    }));
    return rows.filter((chat): chat is Chat => chat !== undefined);
  }

  async function saved(): Promise<Chat> {
    requireReady();
    const user = await request({ "@type": "getMe" });
    if (!Number.isSafeInteger(user.id)) throw new Error("Telegram account is unavailable.");
    const raw = await request({ "@type": "createPrivateChat", user_id: user.id, force: true });
    const chat = chatView(raw);
    if (!chat || chat.id !== String(user.id)) throw new Error("Saved Messages is unavailable.");
    const { archived: _, avatarJpeg: _avatar, avatarFileId: _avatarFileId, folderIds: _folderIds, ...view } = chat;
    return { ...view, name: "Saved Messages", initials: "SM", subtitle: "Direct message" };
  }

  function tdChatList(list: Exclude<ChatList, "saved">): TdObject {
    return list === "main" ? { "@type": "chatListMain" }
      : list === "archive" ? { "@type": "chatListArchive" }
      : modernFolders ? { "@type": "chatListFolder", chat_folder_id: list }
      : { "@type": "chatListFilter", chat_filter_id: list };
  }

  function matchesChatList(membership: TdObject, list: Exclude<ChatList, "saved">): boolean {
    return list === "main" ? membership["@type"] === "chatListMain"
      : list === "archive" ? membership["@type"] === "chatListArchive"
      : (membership["@type"] === "chatListFolder" && membership.chat_folder_id === list)
        || (membership["@type"] === "chatListFilter" && membership.chat_filter_id === list);
  }

  const notificationOverrideFields = {
    preview: { inherit: "use_default_show_preview", setting: "show_preview", enabled: true },
    pinned: { inherit: "use_default_disable_pinned_message_notifications", setting: "disable_pinned_message_notifications", enabled: false },
    mentions: { inherit: "use_default_disable_mention_notifications", setting: "disable_mention_notifications", enabled: false },
    stories: { inherit: "use_default_mute_stories", setting: "mute_stories", enabled: false },
    storyPoster: { inherit: "use_default_show_story_poster", setting: "show_story_poster", enabled: true },
  };
  const notificationOverrideKeys = Object.keys(notificationOverrideFields) as ChatNotificationField[];

  async function chatNotifications(chatId: string, topicId?: number) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id) return;
    let settings;
    if (topicId === undefined) {
      const chat = await request({ "@type": "getChat", chat_id });
      if (chat["@type"] !== "chat" || chat.id !== chat_id) return;
      settings = object(chat.notification_settings);
    } else {
      const record = await forumTopicRecord(chatId, topicId);
      settings = object(record?.topic.notification_settings);
    }
    if (settings?.["@type"] !== "chatNotificationSettings"
      || typeof settings.use_default_mute_for !== "boolean" || typeof settings.mute_for !== "number") return;
    const mode: ChatNotificationMode = settings.use_default_mute_for ? "default" : settings.mute_for > 0 ? "muted" : "unmuted";
    const overrides: Partial<Record<ChatNotificationField, ChatNotificationOverride>> = {};
    for (const key of notificationOverrideKeys) {
      if (topicId !== undefined && (key === "stories" || key === "storyPoster")) continue;
      const { inherit, setting, enabled } = notificationOverrideFields[key];
      if (settings[inherit] === true) overrides[key] = "default";
      else if (settings[inherit] === false && typeof settings[setting] === "boolean") {
        overrides[key] = settings[setting] === enabled ? "show" : "hide";
      }
    }
    return { chat_id, settings, mode, overrides };
  }

  function readNotificationSoundId(raw: unknown) {
    const id = notificationSound.safeParse(typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw);
    return id.success && id.data !== "inherit" ? id.data : undefined;
  }

  const chatNotificationSoundFields = { inherit: "use_default_sound", id: "sound_id" };
  const storyNotificationSoundFields = { inherit: "use_default_story_sound", id: "story_sound_id" };

  function readChatNotificationSound(settings: TdObject, fields = chatNotificationSoundFields) {
    if (settings[fields.inherit] === true) return "inherit";
    if (settings[fields.inherit] === false) return readNotificationSoundId(settings[fields.id]);
  }

  async function savedNotificationSounds() {
    requireReady();
    const result = await request({ "@type": "getSavedNotificationSounds" });
    if (result["@type"] !== "notificationSounds" || !Array.isArray(result.notification_sounds)) {
      throw new Error("Telegram did not return the saved notification sounds.");
    }
    const sounds = new Map<string, string>();
    for (const entry of result.notification_sounds) {
      const sound = object(entry);
      if (sound?.["@type"] !== "notificationSound") continue;
      const id = readNotificationSoundId(sound.id);
      if (id && id !== "-1" && id !== "0") sounds.set(id, typeof sound.title === "string" && sound.title.trim() ? sound.title : "Saved sound");
    }
    return [...sounds].map(([id, title]) => ({ id, title }));
  }

  function isMp3(bytes: Buffer) {
    return bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3"
      || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
  }

  async function canSelectNotificationSound(id: string) {
    return id === "0" || id === "-1" || (await savedNotificationSounds()).some((sound) => sound.id === id);
  }

  function writeChatNotificationSettings(chat_id: number, topicId: number | undefined, notification_settings: Record<string, unknown>) {
    return request(topicId === undefined
      ? { "@type": "setChatNotificationSettings", chat_id, notification_settings }
      : { "@type": "setForumTopicNotificationSettings", chat_id, forum_topic_id: topicId, notification_settings });
  }

  const reactionNotificationTypes = {
    none: "reactionNotificationSourceNone", contacts: "reactionNotificationSourceContacts", all: "reactionNotificationSourceAll",
  };
  function readReactionNotifications(): ReactionNotifications | null {
    requireReady();
    const settings = reactionNotificationSettings;
    if (settings?.["@type"] !== "reactionNotificationSettings" || typeof settings.show_preview !== "boolean") return null;
    const audience = (value: unknown) => (Object.keys(reactionNotificationTypes) as ReactionNotificationAudience[])
      .find((key) => reactionNotificationTypes[key] === object(value)?.["@type"]);
    const messages = audience(settings.message_reaction_source);
    const stories = audience(settings.story_reaction_source);
    const votes = audience(settings.poll_vote_source);
    const sound = readNotificationSoundId(settings.sound_id);
    return messages && stories ? { messages, stories, ...(votes ? { votes } : {}),
      ...(sound === undefined ? {} : { sound }), preview: settings.show_preview } : null;
  }

  function readStoryNotificationDefaults(settings: TdObject): ScopeNotifications["stories"] {
    const { use_default_mute_stories, mute_stories, show_story_poster, story_sound_id } = settings;
    if (typeof use_default_mute_stories !== "boolean" || typeof mute_stories !== "boolean"
      || typeof show_story_poster !== "boolean") return;
    const sound = readNotificationSoundId(story_sound_id);
    return { audience: use_default_mute_stories ? "frequent" : mute_stories ? "none" : "all",
      showAuthor: show_story_poster, ...(sound === undefined ? {} : { sound }) };
  }

  async function scopeNotificationSource(kind: NotificationScope) {
    requireReady();
    const scope = { "@type": {
      private: "notificationSettingsScopePrivateChats",
      groups: "notificationSettingsScopeGroupChats",
      channels: "notificationSettingsScopeChannelChats",
    }[kind] };
    const settings = await request({ "@type": "getScopeNotificationSettings", scope });
    const { mute_for, show_preview, disable_pinned_message_notifications, disable_mention_notifications } = settings;
    if (settings["@type"] !== "scopeNotificationSettings" || typeof mute_for !== "number" || !Number.isInteger(mute_for)
      || typeof show_preview !== "boolean" || typeof disable_pinned_message_notifications !== "boolean"
      || typeof disable_mention_notifications !== "boolean") throw new Error("Telegram notification defaults are unavailable.");
    const values: ScopeNotifications = { muted: mute_for > 0, preview: show_preview,
      pinned: !disable_pinned_message_notifications, mentions: !disable_mention_notifications };
    return { scope, settings, values };
  }

  const folderRules = Object.keys(folderRuleLabels) as FolderDraft["rules"];

  function folderIconView(folder: TdObject | undefined): { icon?: FolderIcon } {
    const icon = object(folder?.icon);
    const name = icon?.["@type"] === "chatFolderIcon" ? icon.name : undefined;
    const known = folderIconNames.find((candidate) => candidate === name);
    return known ? { icon: known } : {};
  }

  function folderColorView(folder: TdObject | undefined, enabled: boolean) {
    const color = folder?.color_id;
    return enabled && typeof color === "number" && Number.isInteger(color) && color >= -1 && color <= 6 ? { color } : {};
  }

  async function readFolderTags(): Promise<FolderTagsState | null> {
    requireReady();
    if (!modernFolders) return null;
    const user = await request({ "@type": "getMe" });
    const editable = user["@type"] === "user" && user.is_premium === true;
    return modernFolders ? { enabled: folderTagsEnabled, editable } : null;
  }

  async function canEditFolderColor() {
    const tags = folderTagsEnabled ? await readFolderTags() : null;
    return !!tags?.enabled && tags.editable;
  }

  function folderTitle(folder: TdObject) {
    const title = folder.name ?? folder.title;
    const text = typeof title === "string" ? title : object(object(title)?.text)?.text;
    if (typeof text === "string" && text.trim()) return text;
  }

  async function recommendedFolderRecords() {
    requireReady();
    if (!modernFolders) return [];
    const result = await request({ "@type": "getRecommendedChatFolders" });
    if (result["@type"] !== "recommendedChatFolders") throw new Error("Telegram folder recommendations are unavailable.");
    const records = new Map<string, { view: RecommendedFolder; folder: TdObject }>();
    for (const item of array(result.chat_folders).slice(0, 30)) {
      const recommendation = object(item);
      const folder = object(recommendation?.folder);
      if (recommendation?.["@type"] !== "recommendedChatFolder" || folder?.["@type"] !== "chatFolder") continue;
      const title = folderTitle(folder);
      if (!title || title.length > 12 || folders.some((entry) => entry.title === title)) continue;
      const description = typeof recommendation.description === "string" ? recommendation.description.slice(0, 512) : "";
      const token = createHash("sha256").update(JSON.stringify([folder, description])).digest("hex");
      records.set(token, { view: { token, title, description }, folder });
    }
    return [...records.values()];
  }

  async function storedFolder(id: number) {
    requireReady();
    if (!folders.some((entry) => entry.id === id)) throw new Error("Unknown Telegram folder.");
    const folder = await request(modernFolders ? { "@type": "getChatFolder", chat_folder_id: id }
      : { "@type": "getChatFilter", chat_filter_id: id });
    if (folder["@type"] !== (modernFolders ? "chatFolder" : "chatFilter")) throw new Error("Invalid Telegram folder.");
    return folder;
  }

  function managedFolderLink(item: unknown): ManagedFolderInvite | undefined {
    const link = object(item);
    const url = link?.invite_link;
    if (link?.["@type"] !== "chatFolderInviteLink" || typeof url !== "string" || !isTelegramFolderInviteLink(url)) return;
    const name = typeof link.name === "string" ? link.name.slice(0, 128) : "";
    const chatCount = new Set(array(link.chat_ids).filter(Number.isSafeInteger)).size;
    return { url, name, chatCount };
  }

  async function newFolderChats(id: number): Promise<FolderInvite | null> {
    requireReady();
    if (!modernFolders || !folders.some((folder) => folder.id === id)) return null;
    const current = folderUpdates.get(id);
    if (current && current.until > Date.now()) return current.preview;

    const entry: NonNullable<typeof current> = { until: Infinity, preview: Promise.resolve(null) };
    const preview = (async () => {
      const folder = await storedFolder(id);
      const title = folderTitle(folder)?.slice(0, 128);
      if (!title || folder.is_shareable !== true) return null;
      const option = await request({ "@type": "getOption", name: "chat_folder_new_chats_update_period" });
      const period = Number(option.value);
      entry.until = Date.now() + (option["@type"] === "optionValueInteger" && Number.isSafeInteger(period) && period > 0
        ? period : 3600) * 1000;
      const result = await request({ "@type": "getChatFolderNewChats", chat_folder_id: id });
      if (result["@type"] !== "chats") throw new Error("Folder updates are unavailable.");
      const ids = [...new Set(array(result.chat_ids).filter((id): id is number =>
        typeof id === "number" && Number.isSafeInteger(id) && id < 0))].slice(0, 200);
      const rows = await Promise.all(ids.map(async (chat_id) => {
        const chat = await request({ "@type": "getChat", chat_id }).catch(() => undefined);
        if (chat?.["@type"] !== "chat" || chat.id !== chat_id) return;
        return { id: String(chat_id), title: chatTitle(chat) };
      }));
      const chats = rows.filter((row) => row !== undefined);
      const token = createHash("sha256").update(JSON.stringify([id, title, chats])).digest("hex");
      return { title, token, chats, alreadyAdded: 0 };
    })().finally(() => {
      if (entry.until === Infinity && folderUpdates.get(id) === entry) folderUpdates.delete(id);
    });
    entry.preview = preview;
    folderUpdates.set(id, entry);
    return preview;
  }

  async function folderShareChats(id: number): Promise<FolderShareChat[] | null> {
    requireReady();
    if (!modernFolders || !folders.some((folder) => folder.id === id)) return null;
    const folder = await storedFolder(id);
    if (folderRules.some((rule) => folder[rule] === true) || array(folder.excluded_chat_ids).length) return null;
    const result = await request({ "@type": "getChatsForChatFolderInviteLink", chat_folder_id: id });
    if (result["@type"] !== "chats") throw new Error("Shareable chats are unavailable.");
    const ids = [...new Set(array(result.chat_ids).filter((id): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id < 0))].slice(0, 200);
    const chats = await Promise.all(ids.map(async (chat_id) => {
      const chat = await request({ "@type": "getChat", chat_id }).catch(() => undefined);
      const type = object(chat?.type)?.["@type"];
      if (chat?.["@type"] !== "chat" || chat.id !== chat_id || (type !== "chatTypeBasicGroup" && type !== "chatTypeSupergroup")) return;
      return { id: String(chat_id), title: chatTitle(chat), upgradesGroup: type === "chatTypeBasicGroup" };
    }));
    return chats.filter((chat) => chat !== undefined);
  }

  async function folderInviteRecords(id: number) {
    requireReady();
    if (!modernFolders || !folders.some((folder) => folder.id === id)) return null;
    const result = await request({ "@type": "getChatFolderInviteLinks", chat_folder_id: id });
    if (result["@type"] !== "chatFolderInviteLinks") throw new Error("Folder invitation links are unavailable.");
    const links = new Map<string, { link: ManagedFolderInvite; chatIds: unknown }>();
    for (const item of array(result.invite_links).slice(0, 200)) {
      const link = managedFolderLink(item);
      if (link) links.set(link.url, { link, chatIds: object(item)?.chat_ids });
    }
    return [...links.values()];
  }

  async function folderInviteEditor(id: number, url: string) {
    if (!isTelegramFolderInviteLink(url)) return null;
    const choices = await folderShareChats(id);
    if (!choices?.length) return null;
    const records = await folderInviteRecords(id);
    const record = records?.find(({ link }) => link.url === url);
    if (!record || !Array.isArray(record.chatIds) || !record.chatIds.length || record.chatIds.length > 200) return null;
    const available = new Set(choices.map((choice) => choice.id));
    const selected = record.chatIds.map(String);
    if (new Set(selected).size !== selected.length || selected.some((chatId) => !available.has(chatId))) return null;
    const token = createHash("sha256").update(JSON.stringify([id, url, record.link.name, selected])).digest("hex");
    const editor: FolderInviteEditor = { choices, selected, token };
    return { editor, link: record.link };
  }

  async function editFolder(id: number | undefined, folder: TdObject) {
    const result = await request(modernFolders
      ? id === undefined ? { "@type": "createChatFolder", folder } : { "@type": "editChatFolder", chat_folder_id: id, folder }
      : id === undefined ? { "@type": "createChatFilter", filter: folder } : { "@type": "editChatFilter", chat_filter_id: id, filter: folder });
    const title = folderTitle(result);
    if (!title || !Number.isInteger(result.id) || Number(result.id) < 1 || (id !== undefined && result.id !== id)) {
      throw new Error("Telegram did not confirm the folder change.");
    }
    return { id: Number(result.id), title, ...folderColorView(result, folderTagsEnabled), ...folderIconView(result) };
  }

  async function forumTopicPage(chatId: string, query: string, cursor?: NonNullable<ForumTopicPage["next"]>, signal?: AbortSignal, requireShareable = false): Promise<ForumTopicPage | null> {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id) return null;
    const chat = await request({ "@type": "getChat", chat_id }, undefined, signal);
    const type = object(chat.type);
    if (chat.id !== chat_id || (requireShareable && !allowsSharing(chat)) || type?.["@type"] !== "chatTypeSupergroup"
      || type.is_channel || !Number.isSafeInteger(type.supergroup_id)) return null;
    const group = await request({ "@type": "getSupergroup", supergroup_id: type.supergroup_id }, undefined, signal);
    if (group.id !== type.supergroup_id || group.is_forum !== true || group.is_channel === true) return null;
    const result = await request({
      "@type": "getForumTopics", chat_id, query, offset_date: cursor?.date ?? 0, offset_message_id: cursor?.message ?? 0,
      offset_forum_topic_id: cursor?.topic ?? 0, limit: 40,
    }, undefined, signal);
    if (result["@type"] !== "forumTopics") throw new Error("Telegram topics are unavailable.");
    const topics = new Map<number, ForumTopic>();
    for (const entry of array(result.topics).slice(0, 40)) {
      const row = object(entry);
      const info = object(row?.info);
      const id = info?.forum_topic_id;
      if (info?.["@type"] !== "forumTopicInfo" || info.chat_id !== chat_id || typeof id !== "number"
        || !Number.isInteger(id) || id < 1 || id > 2147483647 || typeof info.name !== "string" || !info.name.trim()) continue;
      const draft = row && plainDraftText(row);
      topics.set(id, { id, name: info.name.slice(0, 256), closed: info.is_closed === true,
        ...(row?.is_pinned === true ? { pinned: true } : {}), ...(draft === undefined ? {} : { draft }) });
    }
    const date = result.next_offset_date;
    const message = result.next_offset_message_id;
    const topic = result.next_offset_forum_topic_id;
    const next = typeof date === "number" && Number.isSafeInteger(date) && date >= 0
      && typeof message === "number" && Number.isSafeInteger(message) && message >= 0
      && typeof topic === "number" && Number.isInteger(topic) && topic > 0 && topic <= 2147483647
      && (date !== cursor?.date || message !== cursor?.message || topic !== cursor?.topic)
      ? { date, message, topic } : null;
    return { topics: [...topics.values()], next };
  }

  const privacyKeys = {
    phone: "userPrivacySettingShowPhoneNumber", findByPhone: "userPrivacySettingAllowFindingByPhoneNumber",
    status: "userPrivacySettingShowStatus", photo: "userPrivacySettingShowProfilePhoto", bio: "userPrivacySettingShowBio",
    birthday: "userPrivacySettingShowBirthdate", profileAudio: "userPrivacySettingShowProfileAudio",
    forwardedLink: "userPrivacySettingShowLinkInForwardedMessages", invites: "userPrivacySettingAllowChatInvites",
  } satisfies Record<TelegramPrivacyKey, string>;
  const privacyBase = { everyone: "userPrivacySettingRuleAllowAll", contacts: "userPrivacySettingRuleAllowContacts",
    nobody: "userPrivacySettingRuleRestrictAll" } as const;
  const privacyExceptions = new Set(["userPrivacySettingRuleAllowUsers", "userPrivacySettingRuleRestrictUsers",
    "userPrivacySettingRuleAllowChatMembers", "userPrivacySettingRuleRestrictChatMembers",
    "userPrivacySettingRuleAllowBots", "userPrivacySettingRuleRestrictBots", "userPrivacySettingRuleAllowPremiumUsers"]);

  async function privacyRules(key: TelegramPrivacyKey) {
    requireReady();
    const setting = { "@type": privacyKeys[key] };
    const result = await request({ "@type": "getUserPrivacySettingRules", setting });
    if (result["@type"] !== "userPrivacySettingRules" || !Array.isArray(result.rules)) throw new Error("Telegram privacy is unavailable.");
    const rules = result.rules.map(object);
    const firstBase = rules.findIndex((rule) => !rule || !privacyExceptions.has(rule["@type"]));
    const index = firstBase < 0 ? rules.length : firstBase;
    const prefix = rules.slice(0, index);
    const tail = rules.slice(index).map((rule) => rule?.["@type"]);
    const audience: TelegramPrivacyAudience | null = tail.length === 0 ? "nobody"
      : tail.length === 1 && tail[0] === privacyBase.everyone ? "everyone"
      : tail.length === 1 && tail[0] === privacyBase.nobody ? "nobody"
      : tail[0] === privacyBase.contacts && (tail.length === 1 || tail.length === 2 && tail[1] === privacyBase.nobody) ? "contacts" : null;
    const version = createHash("sha256").update(JSON.stringify([key, result.rules])).digest("hex");
    const view: TelegramPrivacyView = {
      audience: audience && privacyAudiences(key).includes(audience) ? audience : null, exceptions: prefix.length, version,
    };
    return { setting, prefix, view };
  }

  async function defaultAutoDeleteDays(): Promise<number> {
    requireReady();
    const result = await request({ "@type": "getDefaultMessageAutoDeleteTime" });
    const days = typeof result.time === "number" ? result.time / 86400 : NaN;
    if (result["@type"] !== "messageAutoDeleteTime" || !Number.isInteger(days) || days < 0 || days > 365) {
      throw new Error("Telegram auto-delete timer is unavailable.");
    }
    return days;
  }

  async function readArchiveSettings(): Promise<ArchiveSettingsView> {
    requireReady();
    const [settings, option] = await Promise.all([
      request({ "@type": "getArchiveChatListSettings" }),
      request({ "@type": "getOption", name: "can_archive_and_mute_new_chats_from_unknown_users" }),
    ]);
    const { archive_and_mute_new_chats_from_unknown_users: muteUnknown,
      keep_unmuted_chats_archived: keepUnmuted, keep_chats_from_folders_archived: keepFolderChats } = settings;
    if (settings["@type"] !== "archiveChatListSettings" || typeof muteUnknown !== "boolean"
      || typeof keepUnmuted !== "boolean" || typeof keepFolderChats !== "boolean") {
      throw new Error("Telegram archive settings are unavailable.");
    }
    return { muteUnknown, keepUnmuted, keepFolderChats, canMuteUnknown: option["@type"] === "optionValueBoolean" && option.value === true };
  }

  async function readDatePrivacy(): Promise<boolean> {
    requireReady();
    const result = await request({ "@type": "getReadDatePrivacySettings" });
    if (result["@type"] !== "readDatePrivacySettings" || typeof result.show_read_date !== "boolean") {
      throw new Error("Telegram read time privacy is unavailable.");
    }
    return result.show_read_date;
  }

  async function checkTelegramUsername(username: string): Promise<UsernameCheck> {
    requireReady();
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) || username.endsWith("_")) return "invalid";
    const chat = await saved();
    const result = await request({ "@type": "checkChatUsername", chat_id: Number(chat.id), username });
    switch (result["@type"]) {
      case "checkChatUsernameResultOk": return "available";
      case "checkChatUsernameResultUsernameOccupied": return "taken";
      case "checkChatUsernameResultUsernameInvalid": return "invalid";
      case "checkChatUsernameResultUsernamePurchasable": return "collectible";
      default: return "unavailable";
    }
  }

  function mainProfilePhotoId(user: TdObject, full: TdObject): string | undefined {
    const id = object(full.photo)?.id;
    const current = object(user.profile_photo)?.id;
    if (typeof id !== "string" && !Number.isSafeInteger(id)) return;
    const value = String(id);
    if (!/^-?[1-9]\d{0,18}$/.test(value) || (typeof current !== "string" && !Number.isSafeInteger(current))
      || String(current) !== value || String(object(full.public_photo)?.id) === value) return;
    return value;
  }

  async function readTelegramProfile(): Promise<TelegramProfile> {
    requireReady();
    const user = await request({ "@type": "getMe" });
    if (user["@type"] !== "user" || !Number.isSafeInteger(user.id) || Number(user.id) < 1) throw new Error("Telegram profile is unavailable.");
    const [full, option] = await Promise.all([
      request({ "@type": "getUserFullInfo", user_id: user.id }), request({ "@type": "getOption", name: "bio_length_max" }),
    ]);
    if (full["@type"] !== "userFullInfo") throw new Error("Telegram profile is unavailable.");
    const rawBio = object(full.bio);
    const bio = typeof full.bio === "string" ? full.bio : typeof rawBio?.text === "string" ? rawBio.text : "";
    const limit = Number(option.value);
    const names = object(user.usernames);
    const username = names ? names.editable_username : user.username;
    const birthdate = telegramBirthdate.safeParse(full.birthdate);
    const photoVersion = avatarVersion(user.profile_photo);
    return {
      ...(photoVersion === undefined ? {} : { photoVersion }),
      ...(photoVersion && mainProfilePhotoId(user, full) ? { canRemovePhoto: true as const } : {}),
      birthdate: birthdate.success ? birthdate.data : null,
      username: typeof username === "string" && /^[A-Za-z0-9_]{0,32}$/.test(username) ? username : "",
      first: typeof user.first_name === "string" ? user.first_name.slice(0, 64) : "",
      last: typeof user.last_name === "string" ? user.last_name.slice(0, 64) : "",
      bio: bio.slice(0, 512),
      bioLimit: option["@type"] === "optionValueInteger" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 512) : 70,
      bioEditable: bio.length <= 512 && array(rawBio?.entities).length === 0,
    };
  }

  async function activeDevices(): Promise<TelegramDevice[]> {
    requireReady();
    const result = await request({ "@type": "getActiveSessions" });
    if (result["@type"] !== "sessions") throw new Error("Telegram sessions are unavailable.");
    const devices = new Map<string, TelegramDevice>();
    for (const value of array(result.sessions).slice(0, 200)) {
      const raw = object(value);
      const id = typeof raw?.id === "string" || Number.isSafeInteger(raw?.id) ? String(raw?.id) : "";
      if (raw?.["@type"] !== "session" || typeof raw.is_current !== "boolean"
        || (!(id === "0" && raw.is_current) && !/^-?[1-9]\d{0,18}$/.test(id))) continue;
      const field = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 128) : "";
      const activeAt = typeof raw.last_active_date === "number" && Number.isSafeInteger(raw.last_active_date)
        && raw.last_active_date > 0 ? raw.last_active_date : 0;
      devices.set(id, { id, current: raw.is_current, application: field(raw.application_name), device: field(raw.device_model),
        platform: field(raw.platform), activeAt });
    }
    return [...devices.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.activeAt - a.activeAt);
  }

  async function privatePeer(chatId: string) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || chat_id < 1) return;
    const chat = await request({ "@type": "getChat", chat_id });
    const type = object(chat.type);
    const user_id = type?.user_id;
    if (chat.id !== chat_id || type?.["@type"] !== "chatTypePrivate" || typeof user_id !== "number"
      || !Number.isSafeInteger(user_id) || user_id < 1 || String(user_id) === await archiveAccount()) return;
    return { chat, user_id };
  }

  function tdBlockList(list: SenderBlockList) {
    return { "@type": list === "main" ? "blockListMain" : "blockListStories" };
  }

  async function writeSenderBlockList(sender: MessageSender, next: SenderBlockState): Promise<boolean> {
    const id = Number(sender.id);
    const sender_id = sender.kind === "user" ? { "@type": "messageSenderUser", user_id: id }
      : { "@type": "messageSenderChat", chat_id: id };
    const result = await request({ "@type": "setMessageSenderBlockList", sender_id,
      block_list: next === "none" ? null : tdBlockList(next) });
    if (result["@type"] !== "ok") return false;
    notifyChatChanged();
    return true;
  }

  async function senderBlockSource(chatId: string): Promise<{ user_id: number; state: SenderBlockState } | undefined> {
    const peer = await privatePeer(chatId);
    if (!peer) return;
    const list = peer.chat.block_list;
    const kind = object(list)?.["@type"];
    const state = kind === "blockListMain" ? "main" : kind === "blockListStories" ? "stories"
      : list == null ? "none" : undefined;
    if (state) return { user_id: peer.user_id, state };
  }

  async function contactSource(chatId: string) {
    const peer = await privatePeer(chatId);
    if (!peer) return;
    const { user_id } = peer;
    const user = await request({ "@type": "getUser", user_id });
    if (user.id !== user_id || ["userTypeDeleted", "userTypeBot"].includes(object(user.type)?.["@type"] ?? "")) return;
    const name = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 64) : "";
    return { user_id, user, view: { id: String(user_id), first: name(user.first_name), last: name(user.last_name), saved: user.is_contact === true } };
  }

  function matchesContact(actual: ContactDetails, expected: ContactDetails, userId: string) {
    return actual.id === userId && actual.id === expected.id && actual.saved === expected.saved
      && actual.first === expected.first && actual.last === expected.last;
  }

  async function resolveChannelPost(chat_id: number, message_id: number) {
    requireReady();
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) {
      throw new Error("Invalid channel post reference.");
    }
    const [post, channel] = await Promise.all([
      request({ "@type": "getMessage", chat_id, message_id }), request({ "@type": "getChat", chat_id }),
    ]);
    if (channel.id !== chat_id || object(channel.type)?.is_channel !== true || post.id !== message_id
      || post.chat_id !== chat_id || post.is_channel_post !== true) throw new Error("This message is not a channel post.");
    const thread = await request({ "@type": "getMessageThread", chat_id, message_id });
    const groupId = thread.chat_id;
    const threadId = thread.message_thread_id;
    if (thread["@type"] !== "messageThreadInfo" || typeof groupId !== "number" || !Number.isSafeInteger(groupId) || !groupId
      || groupId === chat_id || typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new Error("This post has no available discussion.");
    }
    return { groupId, threadId };
  }

  async function channelSignatureSource(chatId: string) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || chat_id >= 0) return;
    const chat = await request({ "@type": "getChat", chat_id });
    const type = object(chat.type);
    const supergroup_id = type?.supergroup_id;
    if (chat["@type"] !== "chat" || chat.id !== chat_id || type?.["@type"] !== "chatTypeSupergroup"
      || type.is_channel !== true || typeof supergroup_id !== "number"
      || !Number.isSafeInteger(supergroup_id) || supergroup_id <= 0) return;
    const group = await request({ "@type": "getSupergroup", supergroup_id });
    if (group["@type"] !== "supergroup" || group.id !== supergroup_id || group.is_channel !== true
      || typeof group.sign_messages !== "boolean" || typeof group.show_message_sender !== "boolean") return;
    const status = object(group.status);
    const editable = status?.["@type"] === "chatMemberStatusCreator" && status.is_member === true
      || status?.["@type"] === "chatMemberStatusAdministrator" && object(status.rights)?.can_change_info === true;
    return { supergroup_id, editable, values: { sign: group.sign_messages, showProfile: group.show_message_sender } };
  }

  async function groupPermissionsSource(chatId: string) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id) return;
    const chat = await request({ "@type": "getChat", chat_id });
    const type = object(chat.type);
    const permissions = object(chat.permissions);
    if (chat.id !== chat_id || permissions?.["@type"] !== "chatPermissions") return;
    const basic = type?.["@type"] === "chatTypeBasicGroup";
    if (!basic && (type?.["@type"] !== "chatTypeSupergroup" || type.is_channel === true)) return;
    const groupId = basic ? type?.basic_group_id : type?.supergroup_id;
    if (!Number.isSafeInteger(groupId)) return;
    const group = await request(basic ? { "@type": "getBasicGroup", basic_group_id: groupId }
      : { "@type": "getSupergroup", supergroup_id: groupId });
    if (group.id !== groupId || group.is_channel === true || group.is_active === false) return;
    const status = object(group.status);
    const editable = status?.["@type"] === "chatMemberStatusCreator" && status.is_member === true
      || status?.["@type"] === "chatMemberStatusAdministrator" && (object(status.rights)?.can_restrict_members ?? status.can_restrict_members) === true;
    return { chat_id, permissions, editable, supergroupId: basic ? undefined : groupId };
  }

  async function removeAvatar(query: TdObject): Promise<SaveAvatarResult> {
    try {
      const result = await request(query);
      if (result["@type"] !== "ok") return "unknown";
      notifyChatChanged();
      return "saved";
    } catch (error) {
      return error instanceof TdError && error.code >= 400 && error.code < 500 ? "unavailable" : "unknown";
    }
  }

  async function uploadAvatar(base64: string, target: TdObject): Promise<SaveAvatarResult> {
    const jpeg = inspectJpeg(base64);
    if (!jpeg || jpeg.width !== jpeg.height) return "unavailable";
    const staged = await stageAttachment(options.directory, jpeg.bytes, "avatar.jpg", "photo");
    let confirmed = false;
    try {
      const result = await request({ ...target,
        photo: { "@type": "inputChatPhotoStatic", photo: { "@type": "inputFileLocal", path: staged.path } },
      }, 60_000);
      if (result["@type"] !== "ok") return "unknown";
      confirmed = true;
      notifyChatChanged();
      return "saved";
    } catch (error) {
      if (!(error instanceof TdError) || error.code === 0 || error.code >= 500) return "unknown";
      confirmed = true;
      return "unavailable";
    } finally {
      if (confirmed) await staged.dispose().catch(() => {});
    }
  }

  function avatarVersion(value: unknown): ChatInfo["photoVersion"] {
    const photo = object(value);
    if (!photo) return value == null ? null : undefined;
    const file = object(photo.small) ?? object(photo.big);
    const unique = object(file?.remote)?.unique_id;
    const token = typeof unique === "string" && unique ? unique : Number.isSafeInteger(file?.id) ? String(file?.id) : undefined;
    return token ? createHash("sha256").update(token).digest("hex") : undefined;
  }

  async function readChatAutoDelete(chatId: string): Promise<ChatAutoDelete | null> {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || chat_id === 0) return null;
    const chat = await request({ "@type": "getChat", chat_id });
    if (chat["@type"] !== "chat" || chat.id !== chat_id || typeof chat.message_auto_delete_time !== "number") return null;
    const days = chat.message_auto_delete_time / 86400;
    if (!Number.isInteger(days) || days < 0 || days > 365) return null;
    const kind = object(chat.type);
    if (kind?.["@type"] === "chatTypePrivate") {
      if (chat_id === 777000 || String(kind.user_id) === await archiveAccount()) return null;
      return { days, editable: true };
    }
    if (kind?.["@type"] !== "chatTypeBasicGroup" && kind?.["@type"] !== "chatTypeSupergroup") return null;
    const editable = (await groupInfoAccess(chat))?.editable === true;
    return { days, editable };
  }

  async function groupInfoAccess(chat: TdObject) {
    const kind = object(chat.type);
    const basic = kind?.["@type"] === "chatTypeBasicGroup";
    const groupId = basic ? kind.basic_group_id : kind?.supergroup_id;
    if ((!basic && kind?.["@type"] !== "chatTypeSupergroup")
      || typeof groupId !== "number" || !Number.isSafeInteger(groupId) || groupId <= 0) return;
    const group = await request(basic ? { "@type": "getBasicGroup", basic_group_id: groupId }
      : { "@type": "getSupergroup", supergroup_id: groupId });
    if (group.id !== groupId || group["@type"] !== (basic ? "basicGroup" : "supergroup")
      || (!basic && (group.is_channel === true) !== (kind?.is_channel === true)) || group.is_active === false) return;
    const status = object(group.status);
    const memberPermissions = status?.["@type"] === "chatMemberStatusRestricted" && status.is_member === true
      ? object(status.permissions) : status?.["@type"] === "chatMemberStatusMember" ? object(chat.permissions) : undefined;
    const editable = status?.["@type"] === "chatMemberStatusCreator"
      || status?.["@type"] === "chatMemberStatusAdministrator" && (object(status.rights)?.can_change_info ?? status.can_change_info) === true
      || kind?.is_channel !== true && memberPermissions?.can_change_info === true;
    return { basic, groupId, editable };
  }

  async function readChatInfo(chatId: string): Promise<ChatInfo | null> {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || chat_id >= 0) return null;
    const chat = await request({ "@type": "getChat", chat_id });
    if (chat["@type"] !== "chat" || chat.id !== chat_id || typeof chat.title !== "string"
      || !chat.title || chat.title.length > 256) return null;
    const access = await groupInfoAccess(chat);
    if (!access) return null;
    const { basic, groupId, editable } = access;
    const full = await request(basic ? { "@type": "getBasicGroupFullInfo", basic_group_id: groupId }
      : { "@type": "getSupergroupFullInfo", supergroup_id: groupId });
    if (full["@type"] !== (basic ? "basicGroupFullInfo" : "supergroupFullInfo")
      || typeof full.description !== "string" || full.description.length > 510) return null;
    const photoVersion = avatarVersion(chat.photo);
    return { title: chat.title, description: full.description, editable, ...(photoVersion === undefined ? {} : { photoVersion }) };
  }

  async function groupSlowMode(chatId: string): Promise<SlowModeView | null> {
    const source = await groupPermissionsSource(chatId);
    if (!source || source.supergroupId === undefined) return null;
    const full = await request({ "@type": "getSupergroupFullInfo", supergroup_id: source.supergroupId });
    if (full["@type"] !== "supergroupFullInfo") return null;
    const delay = slowModeDelays.find((delay) => delay === full.slow_mode_delay);
    return delay === undefined ? null : { delay, editable: source.editable };
  }

  async function inviteChat(chatId: string) {
    requireReady();
    const chat_id = Number(chatId);
    if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid Telegram chat.");
    const chat = await request({ "@type": "getChat", chat_id });
    const kind = object(chat.type)?.["@type"];
    if (chat.id !== chat_id || (kind !== "chatTypeBasicGroup" && kind !== "chatTypeSupergroup")) {
      throw new Error("Invitations are unavailable for this chat.");
    }
    return chat_id;
  }

  function managedInvite(raw: TdObject | undefined, owner: number): ManagedInvite | undefined {
    if (raw?.["@type"] !== "chatInviteLink" || raw.creator_user_id !== owner || raw.is_revoked === true
      || typeof raw.invite_link !== "string" || raw.invite_link.length > 512 || !isTelegramInviteLink(raw.invite_link)) return;
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return { link: raw.invite_link, name: typeof raw.name === "string" ? raw.name.slice(0, 32) : "",
      created: count(raw.date), expires: count(raw.expiration_date), uses: count(raw.member_count),
      limit: count(raw.member_limit), pending: count(raw.pending_join_request_count),
      approval: raw.creates_join_request === true, primary: raw.is_primary === true };
  }

  async function chatPinStatus(chatId: string, list: ChatList): Promise<boolean | null> {
    requireReady();
    const chat_id = Number(chatId);
    if (list === "saved" || !Number.isSafeInteger(chat_id) || !chat_id) return null;
    if (typeof list === "number" && !folders.some((folder) => folder.id === list)) return null;
    const chat = await request({ "@type": "getChat", chat_id });
    if (chat.id !== chat_id || !chatLists(chat).some((membership) => matchesChatList(membership, list))) return null;
    if (typeof list === "number") {
      const folder = await request(modernFolders
        ? { "@type": "getChatFolder", chat_folder_id: list }
        : { "@type": "getChatFilter", chat_filter_id: list });
      if (folder["@type"] !== (modernFolders ? "chatFolder" : "chatFilter") || !Array.isArray(folder.pinned_chat_ids)) return null;
      return folder.pinned_chat_ids.includes(chat_id);
    }
    return array(chat.positions).map(object).some((position) => {
      const membership = object(position?.list);
      return membership && matchesChatList(membership, list) && position?.is_pinned === true;
    });
  }

  async function chatPage(list: ChatList, offset: number): Promise<{ chats: Chat[]; nextOffset: number | null }> {
    requireReady();
    if (list === "saved") return { chats: offset === 0 ? [await saved()] : [], nextOffset: null };
    if (typeof list === "number" && !folders.some((folder) => folder.id === list)) throw new Error("Unknown folder");
    const chat_list = tdChatList(list);
    const limit = Math.min(offset + 40, 10_000);
    const query = { "@type": "getChats", chat_list, limit };
    let result = await request(query);
    let atEnd = false;
    for (let attempt = 0; attempt < 3 && array(result.chat_ids).length < limit; attempt++) {
      const count = array(result.chat_ids).length;
      try { await request({ "@type": "loadChats", chat_list, limit: 40 }); }
      catch (error) {
        if (!(error instanceof TdError && error.code === 404)) throw error;
        atEnd = true;
        break;
      }
      result = await request(query);
      if (array(result.chat_ids).length <= count) break;
    }
    const ids = array(result.chat_ids);
    const next = Math.min(limit, ids.length);
    return {
      chats: await resolveChats({ ...result, chat_ids: ids.slice(offset, next) }, 40),
      nextOffset: !atEnd && next > offset && next < 10_000 ? next : null,
    };
  }

  async function ownNote(chatId: string, messageId: string): Promise<OwnNote | undefined> {
    requireReady();
    const chat_id = Number(chatId);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return;
    const user = await request({ "@type": "getMe" });
    if (!Number.isSafeInteger(user.id) || !user.id) return;
    try {
      const raw = await request({ "@type": "getMessage", chat_id, message_id });
      if (raw.id !== message_id) return;
      const note = ownText(raw, chatId, String(user.id))[0] ?? recordedChannelPost(raw, chatId, String(user.id));
      if (note && await canExportChatContent(chat_id)) return note;
    } catch (error) {
      if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
    }
  }

  async function contextRows(chatId: string, messageId: string, topicId: number | undefined, offset: number, limit: number) {
    requireReady();
    const chat_id = Number(chatId);
    const from_message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(from_message_id) || from_message_id <= 0) {
      throw new Error("Invalid message reference.");
    }
    if (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647)) {
      throw new Error("Invalid forum topic.");
    }
    const result = await request(topicId === undefined
      ? { "@type": "getChatHistory", chat_id, from_message_id, offset, limit, only_local: false }
      : { "@type": "getForumTopicHistory", chat_id, forum_topic_id: topicId, from_message_id, offset, limit });
    if (result["@type"] !== "messages" || !Array.isArray(result.messages)) throw new Error("Unexpected Telegram context page.");
    const rows = new Map<number, TdObject>();
    for (const item of array(result.messages).slice(0, limit)) {
      const raw = object(item);
      if (raw?.["@type"] === "message" && raw.chat_id === chat_id && typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0
        && (topicId === undefined || forumTopicId(raw) === topicId)) {
        rows.set(raw.id, raw);
      }
    }
    return { chat_id, from_message_id, rows };
  }

  async function historyDateAnchor(chatId: number, range?: NoteDateRange, signal?: AbortSignal): Promise<TdObject | null | undefined> {
    if (range?.until === undefined || range.until > Math.floor(Date.now() / 1000)) return;
    if (range.until <= 0) return null;
    const raw = await messageAtDate(chatId, Math.min(range.until - 1, 2147483647), signal);
    return raw && isInNoteDateRange(raw, range) ? raw : null;
  }

  async function messageAtDate(chatId: number, date: number, signal?: AbortSignal) {
    try {
      const raw = await request({ "@type": "getChatMessageByDate", chat_id: chatId, date }, undefined, signal);
      if (raw["@type"] !== "message" || raw.chat_id !== chatId || typeof raw.id !== "number"
        || !Number.isSafeInteger(raw.id) || raw.id <= 0) throw new Error("Unexpected Telegram history date anchor.");
      return raw;
    } catch (error) {
      if (error instanceof TdError && error.code === 404) return null;
      throw error;
    }
  }

  function isChannelPublication(raw: TdObject, chatId: number): boolean {
    const sender = object(raw.sender_id);
    return raw.is_channel_post === true && !(Number(raw.edit_date) > 0)
      && sender?.["@type"] === "messageSenderChat" && sender.chat_id === chatId;
  }

  function recordedChannelPost(raw: TdObject, chatId: string, accountId: string): OwnNote | undefined {
    if (!options.channelPosts || !isChannelPublication(raw, Number(chatId)) || !Number.isSafeInteger(raw.id)) return;
    const text = originalText(raw, chatId);
    if (text !== undefined && options.channelPosts.matches(accountId, chatId, String(raw.id), text)) return noteFromText(raw, text);
  }

  function allowsSharing(chat: TdObject): boolean {
    return chat.has_protected_content !== true && object(chat.type)?.["@type"] !== "chatTypeSecret";
  }

  async function canExportChatContent(chatId: number): Promise<boolean> {
    const chat = await request({ "@type": "getChat", chat_id: chatId });
    return chat.id === chatId && allowsSharing(chat);
  }

  async function documentReference(chatId: string, messageId: string, playback: boolean | "stream" = false) {
    requireReady();
    const chat_id = Number(chatId);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0
      || !await canExportChatContent(chat_id)) throw new Error("Document is unavailable.");
    const raw = await request({ "@type": "getMessage", chat_id, message_id });
    if (raw.chat_id !== chat_id || raw.id !== message_id) throw new Error("Document is unavailable.");
    const photo = !playback && mayShareHistoryMessage(raw) ? photoFiles(raw, "export") : undefined;
    if (photo) return {
      id: photo.large, name: `telegram-photo-${message_id}.jpg`, playbackMime: undefined, size: undefined, photo: true,
    };
    const document = documentFile(raw);
    if (!document?.downloadable || typeof document.id !== "number" || (playback && (!document.playbackMime || (playback === true && (document.sizeBytes ?? 0) > maxPlaybackBytes)))) throw new Error("Document is unavailable.");
    return { id: document.id, name: document.name, playbackMime: document.playbackMime, size: document.approximateSize ? undefined : document.sizeBytes, photo: false };
  }

  function speechNote(raw: TdObject) {
    if (!mayShareHistoryMessage(raw)) return;
    const content = object(raw.content);
    if (content?.["@type"] === "messageVoiceNote") return "voice";
    if (content?.["@type"] === "messageVideoNote") return "video";
  }

  async function transcribeSpeechNote(chatId: number, raw: TdObject, signal?: AbortSignal) {
    requireReady();
    const kind = speechNote(raw);
    if (!kind || raw.chat_id !== chatId || !Number.isSafeInteger(raw.id)) throw new Error("Telegram speech note is unavailable.");
    const content = object(raw.content);
    const note = object(kind === "video" ? content?.video_note : content?.voice_note);
    const file = object(kind === "video" ? note?.video : note?.voice);
    const fileId = file?.id;
    const limit = 16 * 1024 * 1024;
    if (typeof fileId !== "number" || !Number.isSafeInteger(fileId) || fileId <= 0
      || Number(note?.duration) > (kind === "video" ? 60 : 600)
      || Math.max(Number(file?.size) || 0, Number(file?.expected_size) || 0) > limit) {
      throw new Error("Telegram speech note is too long or unavailable.");
    }
    const active = signal ? AbortSignal.any([signal, transcriptionSession.signal]) : transcriptionSession.signal;
    return transcription.transcribe(`${chatId}:${raw.id}`, `${kind}:${fileId}`, async () => {
      if (!await canExportChatContent(chatId)) throw new Error("Telegram speech note is unavailable.");
      const downloaded = await request({ "@type": "downloadFile", file_id: fileId, priority: 8, limit: limit + 1, synchronous: true }, 30_000, active);
      const local = object(downloaded.local);
      if (downloaded.id !== fileId || local?.is_downloading_completed !== true || typeof local.path !== "string") {
        throw new Error("Telegram speech note is unavailable.");
      }
      const bytes = await readTelegramFile(options.directory, local.path, 1, limit);
      return kind === "video" ? videoNoteAudio(bytes, active) : bytes;
    }, active);
  }

  async function pinStatus(id: string, messageId: string): Promise<boolean | null> {
    requireReady();
    const chat_id = Number(id);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return null;
    const raw = await request({ "@type": "getMessage", chat_id, message_id });
    if (raw["@type"] !== "message" || raw.chat_id !== chat_id || raw.id !== message_id || raw.sending_state
      || raw.scheduling_state || typeof raw.is_pinned !== "boolean") return null;
    // TDLib 1.8.0 exposes permissions on the message and enforces pinning
    // rights in pinChatMessage/unpinChatMessage.
    if (typeof raw.can_be_edited === "boolean") return raw.is_pinned;
    const properties = await request({ "@type": "getMessageProperties", chat_id, message_id });
    return properties["@type"] === "messageProperties" && properties.can_be_pinned === true ? raw.is_pinned : null;
  }

  async function deletionOptions(id: string, messageId: string): Promise<DeletionScope[]> {
    requireReady();
    const chat_id = Number(id);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return [];
    const raw = await request({ "@type": "getMessage", chat_id, message_id });
    if (raw["@type"] !== "message" || raw.chat_id !== chat_id || raw.id !== message_id || raw.sending_state) return [];
    const properties = typeof raw.can_be_deleted_only_for_self === "boolean"
      && typeof raw.can_be_deleted_for_all_users === "boolean"
      ? raw : await request({ "@type": "getMessageProperties", chat_id, message_id });
    if (properties !== raw && properties["@type"] !== "messageProperties") return [];
    const scopes: DeletionScope[] = [];
    if (properties.can_be_deleted_only_for_self === true) scopes.push("self");
    if (properties.can_be_deleted_for_all_users === true) scopes.push("everyone");
    return scopes;
  }

  async function mayEdit(raw: TdObject, chatId: number): Promise<boolean> {
    if (typeof raw.can_be_edited === "boolean") return raw.can_be_edited;
    try {
      const properties = await request({ "@type": "getMessageProperties", chat_id: chatId, message_id: raw.id });
      return properties["@type"] === "messageProperties" && properties.can_be_edited === true;
    } catch {
      return false;
    }
  }

  async function withAuthors(items: TdObject[], chatId: number, fallback: string): Promise<Message[]> {
    const profiles = new Map<string, Promise<TdObject | undefined>>();
    function resolveProfile(user: boolean, id: unknown) {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || !id) return;
      const key = `${user ? "user" : "chat"}:${id}`;
      let profile = profiles.get(key);
      if (!profile) {
        profile = request(user ? { "@type": "getUser", user_id: id } : { "@type": "getChat", chat_id: id })
          .then((result) => result.id === id ? result : undefined).catch(() => undefined);
        profiles.set(key, profile);
      }
      return profile;
    }

    async function resolveName(user: boolean, id: unknown) {
      if (!user && id === chatId && fallback) return fallback;
      const profile = await resolveProfile(user, id);
      if (!profile) return;
      const display = user ? [profile.first_name, profile.last_name].filter((part) => typeof part === "string").join(" ")
        : typeof profile.title === "string" ? profile.title : "";
      return display.trim().slice(0, 256) || undefined;
    }

    async function forwardSource(raw: TdObject) {
      const origin = object(object(raw.forward_info)?.origin);
      switch (origin?.["@type"]) {
        case "messageOriginUser":
        case "messageForwardOriginUser": return resolveName(true, origin.sender_user_id);
        case "messageOriginHiddenUser":
        case "messageForwardOriginHiddenUser":
          return typeof origin.sender_name === "string" ? origin.sender_name.trim().slice(0, 256) : undefined;
        case "messageOriginChat":
        case "messageForwardOriginChat": return resolveName(false, origin.sender_chat_id);
        case "messageOriginChannel":
        case "messageForwardOriginChannel": return resolveName(false, origin.chat_id);
      }
    }

    const views = await Promise.all(items.map(async (raw) => {
      const sender = object(raw.sender_id);
      const signature = raw.is_channel_post === true ? "" : authorSignature(raw);
      const author = raw.is_outgoing ? "You" : signature || (sender?.["@type"] === "messageSenderUser"
        ? await resolveName(true, sender.user_id)
        : sender?.["@type"] === "messageSenderChat" ? await resolveName(false, sender.chat_id) : undefined) || fallback;
      const view = message(raw, author);
      if (view) rememberInteractions(chatId, raw.id, raw, view.isChannelPost === true);
      if (view && !raw.is_outgoing) {
        const user = sender?.["@type"] === "messageSenderUser";
        const id = user ? sender.user_id : sender?.["@type"] === "messageSenderChat" ? sender.chat_id : undefined;
        const profile = await resolveProfile(user, id);
        const photo = object(user ? profile?.profile_photo : profile?.photo);
        const fileId = object(photo?.small)?.id;
        const preview = chatAvatarSchema.safeParse(object(photo?.minithumbnail)?.data);
        if (photo && (preview.success || typeof fileId === "number" && Number.isSafeInteger(fileId) && fileId > 0)) {
          view.authorAvatar = { id: String(id), user,
            ...(preview.success ? { preview: preview.data } : {}),
            ...(typeof fileId === "number" && Number.isSafeInteger(fileId) && fileId > 0 ? { fileId } : {}) };
        }
      }
      if (raw.is_outgoing && (view?.editable || view?.editableCaption)) {
        const allowed = await mayEdit(raw, chatId);
        if (view.editable) view.editable = allowed;
        if (view.editableCaption) view.editableCaption = allowed;
      }
      if (view?.poll && !view.poll.closed && (raw.is_outgoing === true || raw.is_channel_post === true)
        && await mayEdit(raw, chatId)) view.canStopPoll = true;
      if (view?.forwardedFrom !== undefined) view.forwardedFrom = await forwardSource(raw) ?? "";
      return view;
    }));
    return views.filter((view): view is Message => view !== undefined);
  }

  async function manualReplyParent(chatId: number, messageId: number, topicId?: number) {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0) return;
    try {
      const parent = await request({ "@type": "getMessage", chat_id: chatId, message_id: messageId });
      if (parent["@type"] === "message" && parent.id === messageId && parent.chat_id === chatId
        && (topicId === undefined || forumTopicId(parent) === topicId)) return parent;
    } catch (error) {
      if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
    }
  }

  async function mediaDestination(chatId: string, topic?: ForumTopicTarget, target?: MediaReply) {
    if (topic && await forumTopicName(chatId, topic.id) !== topic.name) return;
    if (!target) return { topicId: topic?.id };
    const messageId = Number(target.messageId);
    const parent = await manualReplyParent(Number(chatId), messageId, topic?.id);
    if (!parent) return;
    const quote = target.quote && manualTextQuote(parent, target.quote);
    if (target.quote && !quote) return;
    return { topicId: forumTopicId(parent),
      reply: { "@type": "inputMessageReplyToMessage", message_id: messageId, ...(quote ? { quote } : {}) } };
  }

  function validMediaDelivery(delivery?: MediaDelivery) {
    const at = delivery?.at;
    return at === undefined || (Number.isSafeInteger(at) && at > Math.floor(Date.now() / 1000) + 10 && at <= 2147483647);
  }

  function mediaSendOptions(delivery?: MediaDelivery) {
    const at = delivery?.at;
    if (at === undefined && !delivery?.silent) return {};
    return { options: { "@type": "messageSendOptions", disable_notification: delivery?.silent === true,
      ...(at === undefined ? {} : { scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: at } }) } };
  }

  function mediaScheduleMatches(row: TdObject, at?: number) {
    return at === undefined || object(row.scheduling_state)?.send_date === at;
  }

  function mediaDeliveryMatches(row: TdObject, topicId?: number, target?: MediaReply) {
    if (topicId !== undefined && forumTopicId(row) !== topicId) return false;
    return !target || message(row, "")?.replyTo === target.messageId;
  }

  function mediaDeliveryResult(delivery: SendResult, topicId?: number, target?: MediaReply): SendResult {
    return delivery.state === "sent" && ((topicId !== undefined && delivery.message.forumTopicId !== topicId)
      || (target && delivery.message.replyTo !== target.messageId)) ? { state: "unknown" } : delivery;
  }

  async function forwardOptions(chatId: string, messageId: string): Promise<boolean> {
    requireReady();
    const chat_id = Number(chatId);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return false;
    const [chat, source] = await Promise.all([
      request({ "@type": "getChat", chat_id }),
      request({ "@type": "getMessage", chat_id, message_id }),
    ]);
    if (chat.id !== chat_id || !allowsSharing(chat) || source["@type"] !== "message" || source.id !== message_id
      || source.chat_id !== chat_id || source.has_protected_content === true || source.sending_state) return false;
    if (typeof source.can_be_forwarded === "boolean") return source.can_be_forwarded;
    const properties = await request({ "@type": "getMessageProperties", chat_id, message_id });
    return properties["@type"] === "messageProperties" && properties.can_be_forwarded === true;
  }

  function usesNestedPhoto(version: TdObject) {
    const [major = 0, minor = 0, patch = 0] = typeof version.value === "string" ? version.value.split(".").map(Number) : [];
    return major > 1 || (major === 1 && (minor > 8 || (minor === 8 && patch >= 70)));
  }

  async function mediaChoice(kind: "sticker" | "gif", id: number, media: TdObject, index: number) {
    const label = String(media.emoji || media.file_name || `${kind === "gif" ? "GIF" : "Sticker"} ${index + 1}`).slice(0, 80);
    const thumbnail = object(object(media.thumbnail)?.file);
    const limit = 24 * 1024;
    if (typeof thumbnail?.id !== "number" || Math.max(Number(thumbnail.size) || 0, Number(thumbnail.expected_size) || 0) > limit) return { id, label };
    try {
      const file = await request({ "@type": "downloadFile", file_id: thumbnail.id, priority: 6, limit: limit + 1, synchronous: true }, 5000);
      const local = object(file.local);
      if (file.id === thumbnail.id && Number(file.size) <= limit && local?.is_downloading_completed === true && typeof local.path === "string") {
        return { id, label, preview: await readTelegramPhoto(options.directory, local.path) };
      }
    } catch {
      // A missing thumbnail leaves the media available by label.
    }
    return { id, label };
  }

  const collectionQueries = {
    sticker: { list: "getFavoriteStickers", result: "stickers", field: "sticker", add: "addFavoriteSticker", remove: "removeFavoriteSticker" },
    gif: { list: "getSavedAnimations", result: "animations", field: "animation", add: "addSavedAnimation", remove: "removeSavedAnimation" },
  } as const;

  async function collectionSource(chatId: string, messageId: string, kind: MediaCollectionKind) {
    requireReady();
    const chat_id = Number(chatId);
    const message_id = Number(messageId);
    if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return;
    const [raw, sharing] = await Promise.all([request({ "@type": "getMessage", chat_id, message_id }), canExportChatContent(chat_id)]);
    const content = object(raw.content);
    if (!sharing || raw["@type"] !== "message" || raw.chat_id !== chat_id || raw.id !== message_id
      || content?.["@type"] !== (kind === "sticker" ? "messageSticker" : "messageAnimation") || !mayShareHistoryMessage(raw)) return;
    const field = collectionQueries[kind].field;
    const media = object(content[field]);
    const file = object(media?.[field]);
    if (media && file?.["@type"] === "file" && typeof file.id === "number" && Number.isSafeInteger(file.id) && file.id > 0) {
      return { media, file: { ...file, id: file.id } };
    }
  }

  async function inMediaCollection(kind: MediaCollectionKind, file: TdObject) {
    const { list, result, field } = collectionQueries[kind];
    const collection = await request({ "@type": list });
    if (collection["@type"] !== result || !Array.isArray(collection[result])) throw new Error("Telegram media collection is unavailable.");
    const unique = object(file.remote)?.unique_id;
    return collection[result].some((value) => {
      const candidate = object(object(value)?.[field]);
      return candidate?.id === file.id || (typeof unique === "string" && !!unique && object(candidate?.remote)?.unique_id === unique);
    });
  }

  async function availableMedia(kind: "sticker" | "gif", stickerQuery?: string) {
    requireReady();
    if (stickerQuery !== undefined && (kind !== "sticker" || !stickerQuery.trim() || stickerQuery.length > 80)) return [];
    const search = stickerQuery?.trim();
    const emojiOnly = search && !/[\p{L}\p{N}]/u.test(search);
    const entries = search ? array((await request({
      "@type": "searchStickers", sticker_type: { "@type": "stickerTypeRegular" }, query: emojiOnly ? "" : search,
      emojis: emojiOnly ? search : "", input_language_codes: [], offset: 0, limit: 20,
    })).stickers) : kind === "sticker" ? (await Promise.all([
      request({ "@type": "getRecentStickers", is_attached: false }),
      request({ "@type": "getFavoriteStickers" }),
    ])).flatMap((result) => array(result.stickers)) : array((await request({ "@type": "getSavedAnimations" })).animations);
    return mediaEntries(kind, entries).slice(0, 20);
  }

  function mediaEntries(kind: "sticker" | "gif", entries: unknown[]) {
    const field = kind === "sticker" ? "sticker" : "animation";
    const seen = new Set<number>();
    return entries.flatMap((value) => {
      const media = object(value);
      const id = object(media?.[field])?.id;
      if (!media || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return [];
      seen.add(id);
      return [{ id, media }];
    });
  }

  function regularStickerSet(set: TdObject) {
    return set.is_installed === true && set.is_archived !== true && object(set.sticker_type)?.["@type"] === "stickerTypeRegular";
  }

  async function installedStickerPacks() {
    requireReady();
    const result = await request({ "@type": "getInstalledStickerSets", sticker_type: { "@type": "stickerTypeRegular" } });
    if (result["@type"] !== "stickerSets" || !Array.isArray(result.sets)) throw new Error("Installed sticker packs are unavailable.");
    const packs = new Map<string, string>();
    for (const value of result.sets) {
      const pack = object(value);
      if (pack?.["@type"] !== "stickerSetInfo" || !regularStickerSet(pack)) continue;
      const id = stickerSetId(pack.id);
      if (id && typeof pack.title === "string" && pack.title.trim()) packs.set(id, pack.title.trim().slice(0, 128));
    }
    return [...packs].map(([id, title]) => ({ id, title }));
  }

  async function readStickerSet(id: string) {
    const set = await request({ "@type": "getStickerSet", set_id: id });
    if (set["@type"] === "stickerSet" && stickerSetId(set.id) === id
      && object(set.sticker_type)?.["@type"] === "stickerTypeRegular") return set;
  }

  async function linkedStickerSet(url: string) {
    requireReady();
    const name = telegramStickerPackName(url);
    if (!name) return;
    const set = await request({ "@type": "searchStickerSet", name, ignore_cache: false });
    if (set["@type"] === "stickerSet" && typeof set.name === "string" && set.name.toLowerCase() === name.toLowerCase()
      && object(set.sticker_type)?.["@type"] === "stickerTypeRegular") return set;
  }

  async function stickerPackPreview(set: TdObject | undefined, offset: number) {
    const id = stickerSetId(set?.id);
    if (!set || !id || typeof set.title !== "string" || !set.title.trim()) return null;
    const entries = mediaEntries("sticker", array(set.stickers));
    const choices = await Promise.all(entries.slice(offset, offset + 20).map(({ id, media }, index) =>
      mediaChoice("sticker", id, media, offset + index)));
    const link = typeof set.name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(set.name) ? `https://t.me/addstickers/${set.name}` : undefined;
    return { id, title: set.title.trim().slice(0, 128), installed: regularStickerSet(set), ...(link ? { link } : {}),
      choices, next: offset + choices.length < entries.length ? offset + choices.length : null };
  }

  async function installStickerSet(set: TdObject | undefined, id: string) {
    if (!set || stickerSetId(set.id) !== id || state.state !== "ready") return "unavailable" as const;
    if (regularStickerSet(set)) return "installed" as const;
    const result = await request({ "@type": "changeStickerSet", set_id: id, is_installed: true, is_archived: false });
    const confirmed = result["@type"] === "ok" ? await readStickerSet(id) : undefined;
    return confirmed && regularStickerSet(confirmed) ? "installed" as const : "unknown" as const;
  }

  async function stickersInPack(id: string) {
    requireReady();
    if (!(await installedStickerPacks()).some((pack) => pack.id === id)) return [];
    const set = await readStickerSet(id);
    if (!set || !regularStickerSet(set)) return [];
    return mediaEntries("sticker", array(set.stickers));
  }

  async function prepareVideoAttachment(path: string): Promise<TdObject | undefined> {
    const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find(existsSync);
    if (!ffprobe) return;
    try {
      const result = await runMediaConverter(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-enable_drefs", "0",
        "-f", "mov", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration",
        "-of", "json", path], { timeout: 15000, maxBuffer: 32 * 1024 });
      const metadata = JSON.parse(result.stdout) as {
        streams?: Array<{ codec_name?: string; width?: number; height?: number }>; format?: { duration?: string };
      };
      const stream = metadata.streams?.[0];
      const duration = Math.ceil(Number(metadata.format?.duration));
      if (!stream || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)
        || !stream.width || stream.width < 1 || !stream.height || stream.height < 1 || !Number.isSafeInteger(duration)
        || duration < 1 || duration > 2147483647) return;
      return { "@type": "inputMessageVideo", video: { "@type": "inputFileLocal", path }, width: stream.width,
        height: stream.height, duration, supports_streaming: stream.codec_name === "h264" };
    } catch { return; }
  }

  async function sendAttachment(chatId: string, caption: string, bytes: Parameters<typeof stageAttachment>[1], name: string,
    kind: "photo" | "document" | "video", content: (path: string) => TdObject | undefined | Promise<TdObject | undefined>, active?: () => boolean, topic?: ForumTopicTarget, replyTo?: string): Promise<SendResult> {
    requireReady();
    const id = Number(chatId);
    if (!Number.isSafeInteger(id) || !id || caption.length > 1024 || outgoingAttachment) return { state: "failed" };
    outgoingAttachment = true;
    let staged: Awaited<ReturnType<typeof stageAttachment>> | undefined;
    let result: SendResult = { state: "failed" };
    try {
      staged = await stageAttachment(options.directory, bytes, name, kind === "photo" ? "photo" : "document");
      const prepared = await content(staged.path);
      if (!prepared || active?.() === false) return result;
      if (topic && await forumTopicName(chatId, topic.id) !== topic.name) return result;
      let topicId = topic?.id;
      let reply: TdObject | undefined;
      if (replyTo !== undefined) {
        const messageId = Number(replyTo);
        const parent = await manualReplyParent(id, messageId, topic?.id);
        if (!parent) {
          result = { state: "failed", uploadRejection: "reply_unavailable" };
          return result;
        }
        topicId = forumTopicId(parent);
        reply = { "@type": "inputMessageReplyToMessage", message_id: messageId };
      }
      const version = await request({ "@type": "getOption", name: "version" });
      const { "@type": messageType, has_spoiler, show_caption_above_media, ...media } = prepared;
      const nested = usesNestedPhoto(version);
      result = await sendContent(id, {
        "@type": messageType,
        ...(nested ? { [kind]: { "@type": kind === "document" ? "inputDocument" : kind === "video" ? "inputVideo" : "inputPhoto", ...media } } : media),
        caption: { "@type": "formattedText", text: caption, entities: [] },
        ...(has_spoiler === true ? { has_spoiler: true } : {}),
        ...(show_caption_above_media === true ? { show_caption_above_media: true } : {}),
      }, reply, active, undefined, false, Buffer.isBuffer(bytes) ? undefined : documentDeliveryTimeoutMs, topicId);
    } catch (error) {
      result = { state: !staged || error instanceof TdError ? "failed" : "unknown" };
    } finally {
      if (result.state !== "unknown") await staged?.dispose().catch(() => {});
      outgoingAttachment = false;
    }
    return result;
  }

  return {
    status: () => state,
    close() {
      transcriptionSession.abort();
      transcription.clear();
      state = { state: "idle" };
      stopWaitingForDelivery();
      return transport.close();
    },
    async signOut() {
      requireReady();
      const account = options.privateHistory ? await archiveAccount() : undefined;
      state = { state: "disconnecting" };
      stopWaitingForDelivery();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = new Promise<boolean>((resolve) => {
        finishLogout = resolve;
        timer = setTimeout(() => resolve(false), 35_000);
      });
      try {
        const response = await request({ "@type": "logOut" });
        if (response["@type"] !== "ok" || !await closed) throw new Error("Telegram did not confirm sign-out.");
        transcriptionSession.abort();
        transcription.clear();
        if (account) await queueRetention(async () => { options.privateHistory?.purge(account); });
      } catch (error) {
        if (current === "authorizationStateReady" && error instanceof TdError) state = { state: "ready" };
        else fail("Telegram did not confirm sign-out. Reconnect to check your session.");
        throw error;
      } finally {
        clearTimeout(timer);
        finishLogout = undefined;
      }
    },
    async password(password: string) {
      if (state.state !== "password") throw new Error("Telegram is not waiting for a password.");
      await request({ "@type": "checkAuthenticationPassword", password });
      return state;
    },
    newFolderChats,
    async processFolderUpdates(id: number, token: string, ids: string[]) {
      requireReady();
      if (applyingFolderUpdates.has(id) || new Set(ids).size !== ids.length) return false;
      const entry = folderUpdates.get(id);
      if (!entry || entry.until <= Date.now() || !folders.some((folder) => folder.id === id)) return false;
      applyingFolderUpdates.add(id);
      try {
        const preview = await entry.preview;
        if (!preview?.chats.length || preview.token !== token || ids.some((chatId) => !preview.chats.some((chat) => chat.id === chatId))) return false;
        const folder = await storedFolder(id);
        if (folder.is_shareable !== true) return false;
        const result = await request({ "@type": "processChatFolderNewChats", chat_folder_id: id, added_chat_ids: ids.map(Number) });
        if (result["@type"] !== "ok") return false;
        entry.preview = Promise.resolve({ ...preview, chats: [] });
        notifyChatChanged();
        return true;
      } finally { applyingFolderUpdates.delete(id); }
    },
    folderShareChats,
    async createFolderInvite(id: number, name: string, ids: string[]) {
      const current = await folderShareChats(id);
      const allowed = new Set(current?.map((chat) => chat.id));
      if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length || ids.some((item) => !allowed.has(item))
        || name.length > 32) return null;
      const result = await request({ "@type": "createChatFolderInviteLink", chat_folder_id: id, name, chat_ids: ids.map(Number) });
      const link = managedFolderLink(result);
      if (!link) throw new Error("Telegram did not confirm creating a folder link.");
      notifyChatChanged();
      return link;
    },
    async folderInviteLinks(id: number): Promise<ManagedFolderInvite[] | null> {
      return (await folderInviteRecords(id))?.map(({ link }) => link) ?? null;
    },
    async folderInviteEditor(id: number, url: string) {
      return (await folderInviteEditor(id, url))?.editor ?? null;
    },
    async saveFolderInviteChats(id: number, url: string, token: string, ids: string[]) {
      const current = await folderInviteEditor(id, url);
      if (!current || current.editor.token !== token) return null;
      const available = new Set(current.editor.choices.map((choice) => choice.id));
      if (!ids.length || new Set(ids).size !== ids.length || ids.some((chatId) => !available.has(chatId))) return null;
      const result = await request({ "@type": "editChatFolderInviteLink", chat_folder_id: id, invite_link: url,
        name: current.link.name, chat_ids: ids.map(Number) });
      const link = managedFolderLink(result);
      if (!link || link.url !== url) throw new Error("Telegram did not confirm editing the folder link.");
      return link;
    },
    async renameFolderInvite(id: number, url: string, expected: string, name: string) {
      if (!isTelegramFolderInviteLink(url) || name.length > 32) return null;
      const records = await folderInviteRecords(id);
      const record = records?.find(({ link }) => link.url === url && link.name === expected);
      if (!record || !Array.isArray(record.chatIds) || !record.chatIds.length
        || !record.chatIds.every((chatId) => typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId < 0)) return null;
      if (name === expected) return record.link;
      const result = await request({ "@type": "editChatFolderInviteLink", chat_folder_id: id, invite_link: url,
        name, chat_ids: record.chatIds });
      const link = managedFolderLink(result);
      if (!link || link.url !== url) throw new Error("Telegram did not confirm editing the folder link.");
      return link;
    },
    async revokeFolderInvite(id: number, url: string, name: string) {
      if (!isTelegramFolderInviteLink(url)) return false;
      const links = await folderInviteRecords(id);
      if (!links?.some(({ link }) => link.url === url && link.name === name)) return false;
      const result = await request({ "@type": "deleteChatFolderInviteLink", chat_folder_id: id, invite_link: url });
      if (result["@type"] !== "ok") return false;
      notifyChatChanged();
      return true;
    },
    previewFolderInvite,
    async importFolderInvite(url: string, token: string, ids: string[]) {
      const preview = await previewFolderInvite(url);
      if (!preview) return "unavailable" as const;
      if (preview.token !== token) return "changed" as const;
      const allowed = new Set(preview.chats.map(({ id }) => id));
      if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) return "unavailable" as const;
      const result = await request({ "@type": "addChatFolderByInviteLink", invite_link: url, chat_ids: ids.map(Number) });
      if (result["@type"] !== "ok") return "unavailable" as const;
      notifyChatChanged();
      return "added" as const;
    },
    folderTags: readFolderTags,
    async setFolderTags(enabled: boolean, expected: boolean) {
      const current = await readFolderTags();
      if (!current?.editable) return "unavailable" as const;
      if (current.enabled !== expected) return "changed" as const;
      if (enabled === expected) return "saved" as const;
      const result = await request({ "@type": "toggleChatFolderTags", are_tags_enabled: enabled });
      if (result["@type"] !== "ok") return "unavailable" as const;
      return "saved" as const;
    },
    async folderLimit() {
      requireReady();
      const option = await request({ "@type": "getOption", name: modernFolders ? "chat_folder_count_max" : "chat_filter_count_max" });
      const value = Number(option.value);
      return option["@type"] === "optionValueInteger" && Number.isSafeInteger(value) && value > 0 ? value : null;
    },
    async reorderFolders(order: number[], expected: number[]) {
      requireReady();
      if (!modernFolders || mainFolderPosition === undefined) return "unavailable" as const;
      const matchesExpected = () => folders.length === expected.length && folders.every(({ id }, index) => id === expected[index]);
      if (!matchesExpected()) return "changed" as const;
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      if (order.length !== byId.size || new Set(order).size !== byId.size || order.some((id) => !byId.has(id))) {
        return "unavailable" as const;
      }
      if (order.every((id, index) => expected[index] === id)) return "saved" as const;
      const result = await request({ "@type": "reorderChatFolders", chat_folder_ids: order,
        main_chat_list_position: mainFolderPosition });
      if (result["@type"] !== "ok") return "unavailable" as const;
      if (matchesExpected()) {
        const latest = new Map(folders.map((folder) => [folder.id, folder]));
        folders = order.map((id) => latest.get(id)!);
      }
      notifyChatChanged();
      return "saved" as const;
    },
    async recommendedFolders(): Promise<RecommendedFolder[]> {
      return (await recommendedFolderRecords()).map(({ view }) => view);
    },
    async addRecommendedFolder(token: string) {
      const record = (await recommendedFolderRecords()).find(({ view }) => view.token === token);
      const title = record?.view.title;
      if (!record || !title || addingRecommendedFolders.has(title) || folders.some((entry) => entry.title === title)) {
        throw new Error("This recommended folder is no longer available.");
      }
      addingRecommendedFolders.add(title);
      try {
        const saved = await editFolder(undefined, record.folder);
        if (!folders.some(({ id }) => id === saved.id)) folders = [...folders, saved];
        notifyChatChanged();
        return saved;
      } finally {
        addingRecommendedFolders.delete(title);
      }
    },
    async folderEditor(id: number): Promise<FolderEditor> {
      const folder = await storedFolder(id);
      const title = folderTitle(folder);
      if (!title) throw new Error("Folder name is unavailable.");
      const canEditColor = await canEditFolderColor();
      return { title, rules: folderRules.filter((rule) => folder[rule] === true), shareable: folder.is_shareable === true,
        ...folderColorView(folder, modernFolders), ...(modernFolders ? { icon: folderIconView(folder).icon ?? null } : {}), ...(canEditColor ? { canEditColor } : {}) };
    },
    async saveFolder(draft: FolderDraft, id?: number) {
      requireReady();
      const title = draft.title.trim();
      if (!title || title.length > 12) throw new Error("Invalid folder name.");
      const prior = id === undefined ? undefined : await storedFolder(id);
      const icon = draft.icon;
      if (icon !== undefined && (!modernFolders || (icon !== null && !folderIconNames.includes(icon)))) {
        throw new Error("Telegram folder icon cannot be changed.");
      }
      const color = draft.color;
      const changeColor = color !== undefined && color !== (prior?.color_id ?? -1);
      if (changeColor && (!Number.isInteger(color) || color < -1 || color > 6 || !await canEditFolderColor())) {
        throw new Error("Telegram folder color cannot be changed.");
      }
      const rules = prior?.is_shareable === true ? {} : Object.fromEntries(folderRules.map((rule) => [rule, draft.rules.includes(rule)]));
      const name = title === (prior && folderTitle(prior)) ? {} : modernFolders
        ? { name: { "@type": "chatFolderName", text: { "@type": "formattedText", text: title, entities: [] } } }
        : { title };
      const saved = await editFolder(id, { "@type": modernFolders ? "chatFolder" : "chatFilter",
        ...(modernFolders ? { color_id: -1 } : {}), ...prior, ...rules, ...name, ...(changeColor ? { color_id: draft.color } : {}),
        ...(icon === undefined ? {} : { icon: icon === null ? null : { "@type": "chatFolderIcon", name: icon } }) });
      folders = folders.some((folder) => folder.id === saved.id)
        ? folders.map((folder) => folder.id === saved.id ? saved : folder) : [...folders, saved];
      notifyChatChanged();
      return saved;
    },
    async deleteFolder(id: number, title: string) {
      const folder = await storedFolder(id);
      if (folderTitle(folder) !== title) return false;
      const result = await request(modernFolders ? { "@type": "deleteChatFolder", chat_folder_id: id, leave_chat_ids: [] }
        : { "@type": "deleteChatFilter", chat_filter_id: id });
      if (result["@type"] !== "ok") return false;
      folders = folders.filter((entry) => entry.id !== id);
      folderUpdates.delete(id);
      notifyChatChanged();
      return true;
    },
    async folderMemberships(chatId: string) {
      requireReady();
      const candidate = Number(chatId);
      if (!Number.isSafeInteger(candidate) || !candidate) throw new Error("Invalid Telegram chat.");
      return Promise.all(folders.map(async ({ id }) => {
        const folder = await storedFolder(id);
        const mode = [...array(folder.included_chat_ids), ...array(folder.pinned_chat_ids)].includes(candidate) ? "include" as const
          : array(folder.excluded_chat_ids).includes(candidate) ? "exclude" as const : "automatic" as const;
        return { id, mode, shareable: folder.is_shareable === true };
      }));
    },
    async setFolderMembership(id: number, chatId: string, mode: "include" | "exclude" | "automatic") {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) return false;
      const chat = await request({ "@type": "getChat", chat_id });
      if (chat.id !== chat_id || object(chat.type)?.["@type"] === "chatTypeSecret") return false;
      const folder = await storedFolder(id);
      if (folder.is_shareable === true && mode === "exclude") return false;
      const pinned = array(folder.pinned_chat_ids);
      const included = array(folder.included_chat_ids);
      const excluded = array(folder.excluded_chat_ids);
      const next = { ...folder, pinned_chat_ids: mode === "include" ? pinned : pinned.filter((value) => value !== chat_id),
        included_chat_ids: mode === "include" && !pinned.includes(chat_id)
          ? [...new Set([...included, chat_id])] : included.filter((value) => value !== chat_id),
        excluded_chat_ids: mode === "exclude" ? [...new Set([...excluded, chat_id])] : excluded.filter((value) => value !== chat_id),
      };
      await editFolder(id, next);
      return true;
    },
    folders() {
      requireReady();
      return folders;
    },
    async chats(list: ChatList = "main"): Promise<Chat[]> {
      return (await chatPage(list, 0)).chats;
    },
    chatPage,
    async chatById(id: string): Promise<Chat | undefined> {
      requireReady();
      const chat_id = Number(id);
      if (!Number.isSafeInteger(chat_id) || !chat_id) return;
      const raw = await request({ "@type": "getChat", chat_id });
      if (raw.id === chat_id && object(raw.type)?.["@type"] !== "chatTypeSecret") return chatView(raw);
    },
    async messageLink(chatId: string, messageId: string): Promise<string | null> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return null;
      try {
        const link = await request({ "@type": "getMessageLink", chat_id, message_id, in_message_thread: false, for_album: false });
        return link["@type"] === "messageLink" && typeof link.link === "string" && isTelegramMessageLink(link.link) ? link.link : null;
      } catch (error) {
        if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
        return null;
      }
    },
    async messageLinkReference(url: string): Promise<{ chatId: string; messageId: string; topicId?: number } | undefined> {
      requireReady();
      if (!isTelegramMessageLink(url)) return;
      try {
        const info = await request({ "@type": "getMessageLinkInfo", url });
        const raw = object(info.message);
        const chat = info.chat_id;
        const id = raw?.id;
        if (info["@type"] !== "messageLinkInfo" || raw?.["@type"] !== "message" || raw.chat_id !== chat
          || typeof chat !== "number" || !Number.isSafeInteger(chat) || !chat
          || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return;
        const topicId = forumTopicId(raw);
        return { chatId: String(chat), messageId: String(id), ...(topicId === undefined ? {} : { topicId }) };
      } catch (error) {
        if (!(error instanceof TdError) || ![400, 404].includes(error.code)) throw error;
      }
    },
    publicChat,
    accountId,
    async canShareAgentHistory(id: string): Promise<boolean> {
      requireReady();
      return canExportChatContent(Number(id));
    },
    async findRelatedChats(query: string, range: Required<NoteDateRange>, grantedChatIds: readonly string[],
      cursor?: ChatDiscoveryCursor, signal?: AbortSignal) {
      requireReady();
      const first = cursor ? grantedChatIds.indexOf(cursor.chatId) : 0;
      if (first < 0) throw new Error("The Telegram search scope changed.");
      const folded = query.normalize("NFC").toLowerCase();
      const matchesCriterion = (value: unknown) => typeof value === "string" && value.normalize("NFC").toLowerCase().includes(folded);
      const chats: { id: string; name: string; kind: string; matchedName: boolean; matchedMessages: boolean }[] = [];
      let index = first;
      for (; index < Math.min(grantedChatIds.length, first + 8) && !signal?.aborted; index++) {
        const id = grantedChatIds[index]!;
        const chat_id = Number(id);
        const chat = await request({ "@type": "getChat", chat_id }, undefined, signal).catch((error: unknown) => {
          if (error instanceof TdError && [400, 404].includes(error.code)) return undefined;
          throw error;
        });
        if (chat?.id !== chat_id || !allowsSharing(chat)) continue;
        const name = chatTitle(chat);
        const match = { id, name, kind: chatKind(chat) };
        if (matchesCriterion(name)) {
          chats.push({ ...match, matchedName: true, matchedMessages: false });
          continue;
        }
        const before = index === first && cursor?.before ? Number(cursor.before) : undefined;
        const anchor = before === undefined ? await historyDateAnchor(chat_id, range, signal) : undefined;
        if (anchor === null) continue;
        const eligible = (row: TdObject | undefined): row is TdObject => row?.["@type"] === "message"
          && row.chat_id === chat_id && mayShareHistoryMessage(row) && isInNoteDateRange(row, range);
        if (eligible(anchor)) {
          const content = object(anchor.content);
          if (matchesCriterion(object(content?.text)?.text ?? object(content?.caption)?.text)) {
            chats.push({ ...match, matchedName: false, matchedMessages: true });
            continue;
          }
        }
        const result = await request({ "@type": "searchChatMessages", query, chat_id,
          from_message_id: before ?? Number(anchor?.id ?? 0), offset: 0, limit: 25 }, undefined, signal);
        if (result["@type"] !== "messages" && result["@type"] !== "foundChatMessages") throw new Error("Unexpected Telegram search page.");
        const rows = array(result.messages).slice(0, 25).map(object);
        if (rows.some(eligible)) {
          chats.push({ ...match, matchedName: false, matchedMessages: true });
          continue;
        }
        const oldest = rows.at(-1);
        const next = result["@type"] === "foundChatMessages" ? result.next_from_message_id : oldest?.id;
        const start = before ?? Number(anchor?.id ?? 0);
        if (typeof next === "number" && Number.isSafeInteger(next) && next > 0 && (!start || next < start)
          && !(typeof oldest?.date === "number" && oldest.date < range.from)) {
          return { chats, next: { chatId: id, before: String(next) } };
        }
      }
      const following = grantedChatIds[index];
      return { chats, next: following ? { chatId: following } : null };
    },
    async contacts(query: string, offset = 0): Promise<ContactPage> {
      requireReady();
      const result = await request(query ? { "@type": "searchContacts", query, limit: 10000 } : { "@type": "getContacts" });
      if (result["@type"] !== "users") throw new Error("Telegram contacts are unavailable.");
      const ids = [...new Set(array(result.user_ids))].filter((id): id is number =>
        typeof id === "number" && Number.isSafeInteger(id) && id > 0).slice(0, 10000);
      const contacts = await Promise.all(ids.slice(offset, offset + 30).map(async (user_id) => {
        const user = await request({ "@type": "getUser", user_id }).catch(() => undefined);
        if (user?.id !== user_id || user.is_contact !== true) return;
        const name = [user.first_name, user.last_name].filter((part) => typeof part === "string").join(" ").trim().slice(0, 256);
        return { id: String(user_id), name: name || "Telegram contact" };
      }));
      return { contacts: contacts.filter((item) => item !== undefined), next: offset + 30 < ids.length ? offset + 30 : null };
    },
    async blockedSenders(list: SenderBlockList, offset: number): Promise<BlockedSenderPage> {
      requireReady();
      const result = await request({ "@type": "getBlockedMessageSenders", block_list: tdBlockList(list), offset, limit: 30 });
      if (result["@type"] !== "messageSenders") throw new Error("Telegram blocked senders are unavailable.");
      const raw = array(result.senders).slice(0, 30);
      const senders = raw.map(messageSenderView).filter((sender) => sender !== undefined);
      const entries = await Promise.all(senders.map(async (sender) => {
        const details = await request(sender.kind === "user" ? { "@type": "getUser", user_id: Number(sender.id) }
          : { "@type": "getChat", chat_id: Number(sender.id) }).catch(() => undefined);
        const name = (sender.kind === "user" ? [details?.first_name, details?.last_name]
          .filter((part) => typeof part === "string").join(" ") : String(details?.title ?? "")).trim().slice(0, 256);
        return { sender, name: name || (sender.kind === "user" ? "Telegram user" : "Telegram chat") };
      }));
      const next = offset + raw.length;
      return { entries, next: raw.length > 0 && next <= 2147483647 && next < Number(result.total_count) ? next : null };
    },
    async openBlockedSender(sender: MessageSender): Promise<Chat> {
      requireReady();
      const id = Number(sender.id);
      const raw = await request(sender.kind === "user" ? { "@type": "createPrivateChat", user_id: id, force: false }
        : { "@type": "getChat", chat_id: id });
      const type = object(raw.type);
      const matches = sender.kind === "user" ? type?.["@type"] === "chatTypePrivate" && type.user_id === id
        : raw.id === id && type?.["@type"] === "chatTypeSupergroup";
      const chat = matches ? chatView(raw) : undefined;
      if (!chat) throw new Error("Telegram conversation is unavailable.");
      return chat;
    },
    async unblockListedSender(sender: MessageSender, list: SenderBlockList): Promise<boolean> {
      requireReady();
      const source = await request(sender.kind === "user" ? { "@type": "getUserFullInfo", user_id: Number(sender.id) }
        : { "@type": "getChat", chat_id: Number(sender.id) });
      if (source["@type"] !== (sender.kind === "user" ? "userFullInfo" : "chat")
        || object(source.block_list)?.["@type"] !== tdBlockList(list)["@type"]) return false;
      return writeSenderBlockList(sender, "none");
    },
    async senderBlockState(chatId: string): Promise<SenderBlockState | null> {
      return (await senderBlockSource(chatId))?.state ?? null;
    },
    async setSenderBlockState(chatId: string, expected: SenderBlockState, next: SenderBlockState): Promise<boolean> {
      const source = await senderBlockSource(chatId);
      if (!source || source.state !== expected) return false;
      if (next === expected) return true;
      if (expected === "main" && next === "stories") return false;
      return writeSenderBlockList({ kind: "user", id: String(source.user_id) }, next);
    },
    async contactDetails(chatId: string): Promise<ContactDetails | null> {
      return (await contactSource(chatId))?.view ?? null;
    },
    async saveContact(chatId: string, userId: string, expected: ContactDetails, names: Pick<ContactDetails, "first" | "last">) {
      const first = names.first.trim();
      const last = names.last.trim();
      if ((!first && !last) || first.length > 64 || last.length > 64) return false;
      const source = await contactSource(chatId);
      if (!source || !matchesContact(source.view, expected, userId)) return false;
      const modern = usesNestedPhoto(await request({ "@type": "getOption", name: "version" }));
      const phone_number = typeof source.user.phone_number === "string" ? source.user.phone_number : "";
      const fields = { phone_number, first_name: first, last_name: last };
      const info = modern && source.view.saved ? await request({ "@type": "getUserFullInfo", user_id: source.user_id }) : undefined;
      if (info && info["@type"] !== "userFullInfo") return false;
      const note = object(info?.note);
      const result = await request({
        "@type": "addContact",
        ...(modern ? { user_id: source.user_id, contact: { "@type": "importedContact", ...fields, ...(note ? { note } : {}) } }
          : { contact: { "@type": "contact", user_id: source.user_id, ...fields } }),
        share_phone_number: false,
      });
      if (result["@type"] !== "ok") return false;
      notifyChatChanged();
      return true;
    },
    async removeContact(chatId: string, userId: string, expected: ContactDetails) {
      const source = await contactSource(chatId);
      if (!source?.view.saved || !matchesContact(source.view, expected, userId)) return false;
      const result = await request({ "@type": "removeContacts", user_ids: [source.user_id] });
      if (result["@type"] !== "ok") return false;
      notifyChatChanged();
      return true;
    },
    async openContact(id: string): Promise<Chat> {
      requireReady();
      const user_id = Number(id);
      if (!Number.isSafeInteger(user_id) || user_id <= 0) throw new Error("Invalid Telegram contact.");
      const user = await request({ "@type": "getUser", user_id });
      if (user.id !== user_id || user.is_contact !== true) throw new Error("Telegram contact is unavailable.");
      const raw = await request({ "@type": "createPrivateChat", user_id, force: false });
      const type = object(raw.type);
      const chat = type?.["@type"] === "chatTypePrivate" && type.user_id === user_id ? chatView(raw) : undefined;
      if (!chat) throw new Error("Telegram contact conversation is unavailable.");
      return chat;
    },
    async search(query: string, list: ChatList = "main"): Promise<Chat[]> {
      requireReady();
      if (list === "saved") return [];
      if (list === "main") {
        const username = publicChatReference(query.trim());
        if (username === null) return [];
        if (username !== undefined) {
          const chat = await publicChat(username);
          return chat ? [chat] : [];
        }
      }
      const results = await Promise.allSettled([
        request({ "@type": "searchChats", query, limit: 40 }),
        request({ "@type": "searchChatsOnServer", query, limit: 40 }),
      ]);
      const [local, remote] = results;
      if (local.status === "rejected" && remote.status === "rejected") throw remote.reason;
      const chat_ids = results.flatMap((result) => result.status === "fulfilled" ? array(result.value.chat_ids) : []);
      if (list === "main") return resolveChats({ "@type": "chats", chat_ids }, 40);
      const found = await resolveChats({ "@type": "chats", chat_ids }, 80, (chat) =>
        chatLists(chat).some((membership) => matchesChatList(membership, list)));
      return found.slice(0, 40);
    },
    saved,
    async ownSavedNotes(query?: string, range?: NoteDateRange, signal?: AbortSignal): Promise<OwnNote[]> {
      const self = await saved();
      const chat_id = Number(self.id);
      if (signal?.aborted || !await canExportChatContent(chat_id)) return [];
      const start = await historyDateAnchor(chat_id, range, signal);
      if (start === null) return [];
      const folded = query?.normalize("NFC").toLowerCase();
      const notes = new Map<string, OwnNote>();
      const collect = (item: unknown) => {
        if (!isInNoteDateRange(item, range)) return;
        for (const note of ownText(item, self.id, self.id)) {
          if (!folded || note.text.normalize("NFC").toLowerCase().includes(folded)) notes.set(note.id, note);
        }
      };
      if (start) collect(start);
      let cursor = Number(start?.id ?? 0);
      for (let page = 0; page < (range ? 4 : 1) && notes.size < 5 && !signal?.aborted; page++) {
        const common = { chat_id, from_message_id: cursor, offset: 0, limit: 25 };
        const result = await request(query
          ? { "@type": "searchChatMessages", ...common, query }
          : { "@type": "getChatHistory", ...common, only_local: false }, undefined, signal);
        const rows = array(result.messages).slice(0, 25);
        rows.forEach(collect);
        const next = result["@type"] === "foundChatMessages" ? result.next_from_message_id : object(rows.at(-1))?.id;
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= 0 || (cursor && next >= cursor)) break;
        cursor = next;
      }
      return [...notes.values()].slice(0, 5);
    },
    async ownChatNotes(chatId: string, query = "", topicId?: number, signal?: AbortSignal, range?: NoteDateRange): Promise<OwnNote[]> {
      requireReady();
      if (signal?.aborted) return [];
      const id = Number(chatId);
      if (!Number.isSafeInteger(id) || !id) throw new Error("Invalid chat");
      if (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647)) {
        throw new Error("Invalid forum topic.");
      }
      const chat = await request({ "@type": "getChat", chat_id: id });
      if (chat.id !== id || !allowsSharing(chat)) return [];
      const user = await request({ "@type": "getMe" });
      if (!Number.isSafeInteger(user.id)) throw new Error("Telegram account is unavailable.");
      const accountId = String(user.id);
      const channel = topicId === undefined && object(chat.type)?.is_channel === true;
      const receipts = channel ? options.channelPosts?.recent(accountId, chatId) ?? [] : [];
      const folded = query.normalize("NFC").toLowerCase();
      const search = (async () => {
        const notes = new Map<string, OwnNote>();
        const start = await historyDateAnchor(id, range, signal);
        if (start === null) return [];
        const collect = (row: TdObject) => {
          if (!isInNoteDateRange(row, range) || (topicId !== undefined && forumTopicId(row) !== topicId)) return;
          for (const note of ownText(row, chatId, accountId)) {
            if (note.text.normalize("NFC").toLowerCase().includes(folded)) notes.set(note.id, note);
          }
        };
        if (start) collect(start);
        let cursor = Number(start?.id ?? 0);
        for (let page = 0; page < 4 && notes.size < 5 && !signal?.aborted; page++) {
          const result = await request({
            "@type": "searchChatMessages", chat_id: id, query, from_message_id: cursor, offset: 0, limit: 25,
            sender_id: { "@type": "messageSenderUser", user_id: user.id },
            ...(topicId === undefined ? {} : { topic_id: { "@type": "messageTopicForum", forum_topic_id: topicId } }),
          }, undefined, signal);
          const modern = result["@type"] === "foundChatMessages";
          const rows = array(result.messages).slice(0, 25).map(object).filter((row): row is TdObject =>
            row?.chat_id === id && typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0
            && (modern || cursor === 0 || row.id < cursor)
            && (topicId === undefined || forumTopicId(row) === topicId));
          rows.forEach(collect);
          const next = modern ? result.next_from_message_id : rows.at(-1)?.id;
          if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= 0 || (cursor !== 0 && next >= cursor)) break;
          cursor = next;
        }
        return [...notes.values()].slice(0, 5);
      })();
      const fetched = receipts.map(async (messageId) => {
        const message_id = Number(messageId);
        if (!Number.isSafeInteger(message_id) || message_id <= 0) return;
        const raw = await request({ "@type": "getMessage", chat_id: id, message_id }).catch(() => undefined);
        if (raw?.id === message_id && isInNoteDateRange(raw, range)) return recordedChannelPost(raw, chatId, accountId);
      });
      const [own, recorded] = await Promise.all([
        search.catch((error: unknown) => {
          if (!receipts.length) throw error;
          return [];
        }),
        Promise.all(fetched),
      ]);
      if (!channel) return own;
      const notes = new Map(own.map((note) => [note.id, note]));
      for (const note of recorded) {
        if (note && note.text.normalize("NFC").toLowerCase().includes(folded)) notes.set(note.id, note);
      }
      return [...notes.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 5);
    },
    ownNote,
    async recordManualChannelPost(chatId: string, sent: Message, text: string) {
      const receipts = options.channelPosts;
      if (!receipts || sent.isChannelPost !== true || !/^[1-9]\d{0,15}$/.test(sent.id) || sent.text !== text) return;
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(sent.id);
      const [user, raw, sharing] = await Promise.all([
        request({ "@type": "getMe" }),
        request({ "@type": "getMessage", chat_id, message_id }),
        canExportChatContent(chat_id),
      ]);
      if (state.state === "ready" && sharing && user["@type"] === "user" && Number.isSafeInteger(user.id)
        && raw.id === message_id && isChannelPublication(raw, chat_id) && originalText(raw, chatId) === text) {
        receipts.record(String(user.id), chatId, sent.id, text);
      }
    },
    pinStatus,
    async setMessagePinned(id: string, messageId: string, pinned: boolean): Promise<"updated" | "refused" | "unknown"> {
      let current: boolean | null;
      try {
        current = await pinStatus(id, messageId);
      } catch {
        return "refused";
      }
      if (current === null || state.state !== "ready") return "refused";
      if (current === pinned) return "updated";
      const reference = { chat_id: Number(id), message_id: Number(messageId) };
      try {
        const result = await request(pinned
          ? { "@type": "pinChatMessage", ...reference, disable_notification: true, only_for_self: false }
          : { "@type": "unpinChatMessage", ...reference });
        if (result["@type"] !== "ok") return "unknown";
        notifyChatChanged();
        return "updated";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    async messageViewers(id: string, messageId: string): Promise<MessageViewer[] | null> {
      requireReady();
      const chat_id = Number(id);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || chat_id >= 0 || !Number.isSafeInteger(message_id) || message_id <= 0) return null;
      const properties = await request({ "@type": "getMessageProperties", chat_id, message_id });
      if (properties["@type"] !== "messageProperties" || properties.can_get_viewers !== true) return null;
      const result = await request({ "@type": "getMessageViewers", chat_id, message_id });
      if (result["@type"] !== "messageViewers" || !Array.isArray(result.viewers)) return null;
      const viewers = new Map<number, number>();
      for (const raw of result.viewers) {
        const viewer = object(raw);
        if (viewer?.["@type"] !== "messageViewer" || typeof viewer.user_id !== "number"
          || !Number.isSafeInteger(viewer.user_id) || viewer.user_id <= 0) continue;
        const date = viewer.view_date;
        const viewedAt = typeof date === "number" && Number.isInteger(date) && date > 0 && date <= 2147483647 ? date : 0;
        viewers.set(viewer.user_id, Math.max(viewers.get(viewer.user_id) ?? 0, viewedAt));
      }
      return Promise.all([...viewers].sort((a, b) => b[1] - a[1]).map(async ([user_id, viewedAt]) => {
        const user = await request({ "@type": "getUser", user_id }).catch(() => undefined);
        const name = user?.["@type"] === "user" && user.id === user_id
          ? [user.first_name, user.last_name].filter((part) => typeof part === "string").join(" ").trim().slice(0, 256)
          : "";
        return { id: String(user_id), name: name || "Telegram user", viewedAt };
      }));
    },
    async messageReadTime(id: string, messageId: string): Promise<MessageReadTime> {
      requireReady();
      const chat_id = Number(id);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || chat_id <= 0 || !Number.isSafeInteger(message_id) || message_id <= 0) return "unavailable";
      const message = await request({ "@type": "getMessage", chat_id, message_id });
      if (message["@type"] !== "message" || message.id !== message_id || message.chat_id !== chat_id
        || message.is_outgoing !== true || message.sending_state || message.scheduling_state) return "unavailable";
      const properties = await request({ "@type": "getMessageProperties", chat_id, message_id });
      if (properties["@type"] !== "messageProperties" || properties.can_get_read_date !== true) return "unavailable";
      const result = await request({ "@type": "getMessageReadDate", chat_id, message_id });
      switch (result["@type"]) {
        case "messageReadDateRead":
          return typeof result.read_date === "number" && Number.isInteger(result.read_date)
            && result.read_date > 0 && result.read_date <= 2147483647 ? result.read_date : "unavailable";
        case "messageReadDateUnread": return "unread";
        case "messageReadDateTooOld": return "tooOld";
        case "messageReadDateUserPrivacyRestricted": return "recipientPrivacy";
        case "messageReadDateMyPrivacyRestricted": return "ownPrivacy";
        default: return "unavailable";
      }
    },
    deletionOptions,
    async deleteMessage(id: string, messageId: string, scope: DeletionScope): Promise<"deleted" | "refused" | "unknown"> {
      try {
        if (!(await deletionOptions(id, messageId)).includes(scope)) return "refused";
      } catch {
        return "refused";
      }
      try {
        const result = await request({
          "@type": "deleteMessages", chat_id: Number(id), message_ids: [Number(messageId)], revoke: scope === "everyone",
        });
        if (result["@type"] !== "ok") return "unknown";
        if (options.privateHistory && Number(id) > 0) {
          await queueRetention(async () => {
            options.privateHistory?.remove(await archiveAccount(), id, messageId);
          });
        }
        notifyMessagesDeleted({ id: String(Number(id)), messageIds: [messageId] });
        notifyChatChanged();
        return "deleted";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    forwardOptions,
    async forwardMessage(chatId: string, messageId: string, target: ForwardTarget): Promise<ForwardResult> {
      try {
        if (!await forwardOptions(chatId, messageId)) return "refused";
        const chat_id = Number(target.id);
        if (!Number.isSafeInteger(chat_id) || !chat_id) return "refused";
        const chat = await request({ "@type": "getChat", chat_id });
        if (chat["@type"] !== "chat" || chat.id !== chat_id || object(chat.type)?.["@type"] === "chatTypeSecret"
          || chatKind(chat) !== target.kind) return "refused";
        if (chatTitle(chat) !== target.name) {
          if (target.kind !== "Direct message" || target.name !== "Saved Messages") return "refused";
          const user = await request({ "@type": "getMe" });
          if (user["@type"] !== "user" || user.id !== chat_id) return "refused";
        }
        const topic = target.topic;
        if (topic && (target.kind !== "Group" || await forumTopicName(target.id, topic.id) !== topic.name)) return "refused";
        if (state.state !== "ready") return "refused";
        const result = await request({
          "@type": "forwardMessages", chat_id, from_chat_id: Number(chatId), message_ids: [Number(messageId)],
          ...(topic ? { topic_id: { "@type": "messageTopicForum", forum_topic_id: topic.id } } : {}),
          send_copy: false, remove_caption: false, only_preview: false,
        });
        const rows = array(result.messages);
        if (result["@type"] !== "messages" || rows.length !== 1) return "unknown";
        if (rows[0] === null) return "refused";
        const sent = object(rows[0]);
        if (sent?.["@type"] !== "message" || sent.chat_id !== chat_id || !Number.isSafeInteger(sent.id)) return "unknown";
        const sending = object(sent.sending_state)?.["@type"];
        if (sending === "messageSendingStateFailed") return "refused";
        if (sending === "messageSendingStatePending") {
          if (state.state !== "ready") return "unknown";
          const delivery = await waitForDelivery(`${chat_id}:${sent.id}`, 6500);
          if (delivery.state === "failed") return "refused";
          if (delivery.state === "sent" && topic && delivery.message.forumTopicId !== topic.id) return "unknown";
          return delivery.state;
        }
        if (sending || (topic && forumTopicId(sent) !== topic.id)) return "unknown";
        notifyChatChanged();
        return "sent";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    listReactions,
    async setReaction(chatId: string, messageId: string, emoji: string, chosen: boolean): Promise<boolean> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0
        || !emoji.trim() || emoji.length > 64) return false;
      try {
        const current = await request({ "@type": "getMessage", chat_id, message_id });
        if (current["@type"] !== "message" || current.chat_id !== chat_id || current.id !== message_id) return false;
        const selected = reactionsView(current)?.items.some(({ type, chosen }) =>
          chosen && type.kind === "emoji" && type.emoji === emoji) ?? false;
        if (selected === chosen) return true;
        if (chosen && !(await listReactions(chatId, messageId)).includes(emoji)) return false;
        const reaction_type = { "@type": "reactionTypeEmoji", emoji };
        const result = await request(chosen
          ? { "@type": "addMessageReaction", chat_id, message_id, reaction_type, is_big: false, update_recent_reactions: true }
          : { "@type": "removeMessageReaction", chat_id, message_id, reaction_type });
        if (result["@type"] !== "ok") return false;
        notifyChatChanged();
        return true;
      } catch {
        return false;
      }
    },
    async sendPoll(chatId: string, draft: PollDraft, topic?: ForumTopicTarget): Promise<PollSendResult> {
      requireReady();
      const id = Number(chatId);
      const parsed = pollDraft.safeParse(draft);
      if (!Number.isSafeInteger(id) || !id || !parsed.success) return { state: "failed" };
      try {
        const version = await request({ "@type": "getOption", name: "version" });
        const { question, options, multiple } = parsed.data;
        const base = { "@type": "inputMessagePoll", is_anonymous: true, open_period: 0, close_date: 0, is_closed: false };
        let content: TdObject;
        if (version["@type"] !== "optionValueString" || typeof version.value !== "string") return { state: "unavailable" };
        if (version.value === "1.8.0") {
          content = { ...base, question, options, type: { "@type": "pollTypeRegular", allow_multiple_answers: multiple } };
        } else {
          const [major, minor, patch] = version.value.split(".").map(Number);
          if (major !== 1 || minor !== 8 || (patch ?? 0) < 70 || !Number.isInteger(patch)) return { state: "unavailable" };
          const formatted = (text: string) => ({ "@type": "formattedText", text, entities: [] });
          content = { ...base, question: formatted(question), description: formatted(""), allows_multiple_answers: multiple,
            allows_revoting: true, type: { "@type": "inputPollTypeRegular", allow_adding_options: false },
            options: options.map((text) => ({ "@type": "inputPollOption", text: formatted(text) })),
          };
        }
        if (topic && await forumTopicName(chatId, topic.id) !== topic.name) return { state: "failed" };
        const delivery = await sendContent(id, content, undefined, undefined, undefined, false, undefined, topic?.id);
        if (delivery.state === "sent") notifyChatChanged();
        return delivery;
      } catch (error) {
        return { state: error instanceof TdError ? "failed" : "unknown" };
      }
    },
    async stopPoll(chatId: string, messageId: string): Promise<boolean> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return false;
      try {
        const raw = await request({ "@type": "getMessage", chat_id, message_id });
        if (raw["@type"] !== "message" || raw.chat_id !== chat_id || raw.id !== message_id
          || (raw.is_outgoing !== true && raw.is_channel_post !== true)) return false;
        const poll = pollView(object(raw.content));
        if (!poll || poll.closed || !await mayEdit(raw, chat_id) || state.state !== "ready") return false;
        const result = await request({ "@type": "stopPoll", chat_id, message_id });
        if (result["@type"] !== "ok") return false;
        notifyChatChanged();
        return true;
      } catch {
        return false;
      }
    },
    async voteInPoll(chatId: string, messageId: string, choices: PollChoice[]): Promise<boolean> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) return false;
      try {
        const current = await request({ "@type": "getMessage", chat_id, message_id });
        if (current.chat_id !== chat_id || current.id !== message_id) return false;
        const poll = pollView(object(current.content));
        if (!poll?.canVote || (!poll.multiple && choices.length > 1) || (!choices.length && !poll.options.some(({ chosen }) => chosen))) return false;
        const option_ids = choices.map(({ index }) => index);
        if (new Set(option_ids).size !== choices.length || !choices.every((choice) =>
          poll.options.some(({ index, id, text }) => index === choice.index && id === choice.id && text === choice.text))) return false;
        const result = await request({ "@type": "setPollAnswer", chat_id, message_id, option_ids });
        if (result["@type"] !== "ok") return false;
        notifyChatChanged();
        return true;
      } catch {
        return false;
      }
    },
    async editCaption(chatId: string, messageId: string, text: string, original: string, originalStyles: StyledRange[] = [], newStyles?: StyledRange[], placement?: CaptionPlacement): Promise<SendResult> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0
        || text.length > 4096) return { state: "failed" };
      try {
        const current = await request({ "@type": "getMessage", chat_id, message_id });
        const content = object(current.content);
        const view = message(current, "You");
        const actual = object(content?.caption)?.text ?? "";
        const above = content?.show_caption_above_media === true;
        if (current["@type"] !== "message" || current.chat_id !== chat_id || current.id !== message_id
          || !view?.editableCaption || actual !== original
          || (placement && (!text.trim() || !view.canMoveCaption || above !== placement.expected))
          || !await mayEdit(current, chat_id)) return { state: "failed" };
        const previous = view.styles ?? [];
        if (!sameDraftStyles(previous, originalStyles)) return { state: "failed" };
        const styles = newStyles ?? moveDraftStyles(original, text, previous);
        if (!validDraftStyles(text, styles) || state.state !== "ready") return { state: "failed" };
        const updated = await request({ "@type": "editMessageCaption", chat_id, message_id,
          caption: { "@type": "formattedText", text, entities: textEntities(styles) },
          show_caption_above_media: placement?.above ?? above });
        if (updated["@type"] !== "message" || updated.id !== message_id || updated.chat_id !== chat_id
          || (object(object(updated.content)?.caption)?.text ?? "") !== text) return { state: "unknown" };
        const result = message(updated, "You");
        if (placement && (result?.captionAboveMedia === true) !== placement.above) return { state: "unknown" };
        return result ? { state: "sent", message: result } : { state: "unknown" };
      } catch (error) { return error instanceof TdError ? { state: "failed" } : { state: "unknown" }; }
    },
    async editText(chatId: string, messageId: string, text: string, original: string, originalStyles: StyledRange[] = [], newStyles?: StyledRange[], removeLinkPreview?: string): Promise<SendResult> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0
        || !text.trim() || text.length > 4096) return { state: "failed" };
      try {
        const current = await request({ "@type": "getMessage", chat_id, message_id });
        const view = message(current, "You");
        if (current.chat_id !== chat_id || current.id !== message_id || !view?.editable || view.text !== original
          || !await mayEdit(current, chat_id)) {
          return { state: "failed" };
        }
        if (removeLinkPreview !== undefined && view.linkPreview?.url !== removeLinkPreview) return { state: "failed" };
        const previous = view.styles ?? [];
        if (!sameDraftStyles(previous, originalStyles)) return { state: "failed" };
        const styles = newStyles ?? moveDraftStyles(original, text, previous);
        if (!validDraftStyles(text, styles)) return { state: "failed" };
        const options = object(object(current.content)?.link_preview_options);
        const currentLinks = textWebLinks(original);
        const editedLinks = textWebLinks(text);
        const configuredUrl = typeof options?.url === "string" && options.url ? options.url : view.linkPreview?.url;
        const previewUrl = options?.is_disabled === true ? undefined
          : configuredUrl ? webLink(configuredUrl)?.href
          : options?.is_disabled === false ? currentLinks[0]?.href : undefined;
        const preservePreview = removeLinkPreview === undefined && !!previewUrl && currentLinks.some(({ href }) => href === previewUrl)
          && editedLinks.some(({ href }) => href === previewUrl);
        const linkPreviewOptions = preservePreview ? {
          "@type": "linkPreviewOptions", is_disabled: false, url: previewUrl,
          force_small_media: options?.force_small_media === true && options.force_large_media !== true,
          force_large_media: options?.force_large_media === true && options.force_small_media !== true,
          show_above_text: typeof options?.show_above_text === "boolean" ? options.show_above_text : view.linkPreview?.above === true,
        } : { "@type": "linkPreviewOptions", is_disabled: true };
        const updated = await request({
          "@type": "editMessageText", chat_id, message_id,
          input_message_content: {
            "@type": "inputMessageText", text: { "@type": "formattedText", text, entities: textEntities(styles) },
            disable_web_page_preview: !preservePreview || editedLinks[0]?.href !== previewUrl,
            link_preview_options: linkPreviewOptions,
          },
        });
        const result = message(updated, "You");
        return result && updated.chat_id === chat_id && updated.id === message_id
          ? { state: "sent", message: result } : { state: "unknown" };
      } catch (error) {
        return { state: error instanceof TdError ? "failed" : "unknown" };
      }
    },
    postingPermissions,
    previewInvite,
    async joinInvite(url: string, expected: InviteTarget): Promise<ChatJoinResult> {
      try {
        const current = await previewInvite(url);
        if (!current || current.mode === "subscription" || current.title !== expected.title
          || current.kind !== expected.kind || current.mode !== expected.mode || current.chatId !== expected.chatId
          || state.state !== "ready") return "refused";
        const result = await request({ "@type": "joinChatByInviteLink", invite_link: url });
        return joinResult(result, current.chatId === undefined ? undefined : Number(current.chatId));
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    async joinChat(chatId: string, title: string): Promise<ChatJoinResult> {
      requireReady();
      try {
        const permissions = await postingPermissions(chatId, title);
        if (!permissions.join) return "refused";
        const chat_id = Number(chatId);
        return joinResult(await request({ "@type": "joinChat", chat_id }), chat_id);
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    async createPrivateChatSpace(title: string, kind: "Group" | "Channel"): Promise<Chat> {
      requireReady();
      const raw = await request({
        "@type": "createNewSupergroupChat", title, is_channel: kind === "Channel",
        description: "", for_import: false,
      });
      const type = object(raw.type);
      const chat = raw["@type"] === "chat" && type?.["@type"] === "chatTypeSupergroup" ? chatView(raw) : undefined;
      if (!chat || chat.subtitle !== kind) throw new Error("Unexpected response to Telegram chat creation.");
      return chat;
    },
    async deleteOwnedChatSpace(id: string, title: string, kind: "Group" | "Channel"): Promise<"deleted" | "refused" | "not_owner" | "not_deletable" | "unknown"> {
      requireReady();
      const chat_id = Number(id);
      try {
        const chat = await request({ "@type": "getChat", chat_id });
        const type = object(chat.type);
        if (chat["@type"] !== "chat" || chat.id !== chat_id || chat.title !== title || chatKind(chat) !== kind
          || type?.["@type"] !== "chatTypeSupergroup"
          || !Number.isSafeInteger(type.supergroup_id)) return "refused";
        const group = await request({ "@type": "getSupergroup", supergroup_id: type.supergroup_id });
        if (group["@type"] !== "supergroup" || group.id !== type.supergroup_id
          || object(group.status)?.["@type"] !== "chatMemberStatusCreator") return "not_owner";
        if (state.state !== "ready") return "refused";
        if (chat.can_be_deleted_for_all_users !== true) {
          // TDLib 1.8.0 reports deleteChatHistory rights in this field.
          const version = await request({ "@type": "getOption", name: "version" });
          if (version.value !== "1.8.0") return "not_deletable";
          if (state.state !== "ready") return "refused";
        }
        const result = await request({ "@type": "deleteChat", chat_id });
        return result["@type"] === "ok" ? "deleted" : "unknown";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    forumTopicName,
    async manageForumTopic(chatId: string, action: ForumTopicAction): Promise<ForumTopic> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid Telegram forum.");
      const chat = await request({ "@type": "getChat", chat_id });
      const type = object(chat.type);
      if (chat.id !== chat_id || type?.["@type"] !== "chatTypeSupergroup"
        || type.is_channel || !Number.isSafeInteger(type.supergroup_id)) throw new Error("Telegram forum is unavailable.");
      const group = await request({ "@type": "getSupergroup", supergroup_id: type.supergroup_id });
      if (group.id !== type.supergroup_id || group.is_forum !== true || group.is_channel === true) throw new Error("Telegram forum is unavailable.");
      function view(info: TdObject | undefined, expected?: number): ForumTopic {
        const id = info?.forum_topic_id;
        if (info?.["@type"] !== "forumTopicInfo" || info.chat_id !== chat_id || typeof id !== "number"
          || !Number.isInteger(id) || id < 1 || id > 2147483647 || (expected !== undefined && id !== expected)
          || typeof info.name !== "string" || !info.name.trim()) throw new Error("Telegram did not confirm the topic.");
        return { id, name: info.name.slice(0, 256), closed: info.is_closed === true };
      }
      if (action.kind === "create") {
        const info = await request({ "@type": "createForumTopic", chat_id, name: action.name });
        notifyChatChanged();
        return view(info);
      }
      const forum_topic_id = action.topic;
      const get = () => request({ "@type": "getForumTopic", chat_id, forum_topic_id });
      view(object((await get()).info), forum_topic_id);
      const result = await request(action.kind === "rename"
        ? { "@type": "editForumTopic", chat_id, forum_topic_id, name: action.name, edit_icon_custom_emoji: false }
        : action.kind === "pin" ? { "@type": "toggleForumTopicIsPinned", chat_id, forum_topic_id, is_pinned: action.pinned }
          : { "@type": "toggleForumTopicIsClosed", chat_id, forum_topic_id, is_closed: action.closed });
      if (result["@type"] !== "ok") throw new Error("Telegram did not apply the topic change.");
      const confirmed = await get();
      const updated = view(object(confirmed.info), forum_topic_id);
      notifyChatChanged();
      return confirmed.is_pinned === true ? { ...updated, pinned: true } : updated;
    },
    forumTopicPage,
    async forumTopics(chatId: string, query: string, signal?: AbortSignal, requireShareable = false): Promise<ForumTopic[] | null> {
      return (await forumTopicPage(chatId, query, undefined, signal, requireShareable))?.topics ?? null;
    },
    async postingAllowed(id: string) { return (await postingPermissions(id)).text; },
    async sendText(chatId: string, text: string, replyTo?: string, expectedParentText?: string, authorizeDispatch?: () => boolean,
      expectedSender?: SendIdentity, expectedTopic?: ForumTopicTarget, replySource?: "history", delivery?: TextDelivery): Promise<SendResult> {
      requireReady();
      const id = Number(chatId);
      if (!Number.isSafeInteger(id) || !id || !text.trim() || text.length > 4096) return { state: "failed" };
      try {
        let reply: TdObject | undefined;
        let quote: TdObject | undefined;
        let topic = expectedTopic?.id;
        if (delivery?.quote && (!replyTo || authorizeDispatch || expectedParentText !== undefined)) return { state: "failed" };
        if (expectedTopic && await forumTopicName(chatId, expectedTopic.id) !== expectedTopic.name) return { state: "failed" };
        if (replyTo !== undefined) {
          const messageId = Number(replyTo);
          if (!Number.isSafeInteger(messageId) || messageId <= 0) return { state: "failed" };
          if (expectedParentText !== undefined) {
            let parent: Pick<Message, "text" | "forumTopicId"> | undefined;
            if (replySource === "history") {
              const raw = await manualReplyParent(id, messageId, expectedTopic?.id);
              if (!raw || !mayShareHistoryMessage(raw) || !await canExportChatContent(id)) return { state: "failed" };
              parent = message(raw, "");
            } else {
              parent = await ownNote(chatId, replyTo);
            }
            if (parent?.text !== expectedParentText || parent.forumTopicId !== expectedTopic?.id) return { state: "failed" };
            topic = parent.forumTopicId;
          } else {
            const parent = await manualReplyParent(id, messageId, expectedTopic?.id);
            if (!parent) return { state: "failed" };
            topic = forumTopicId(parent);
            if (delivery?.quote) {
              quote = manualTextQuote(parent, delivery.quote);
              if (!quote) return { state: "failed" };
            }
          }
          reply = { "@type": "inputMessageReplyToMessage", message_id: messageId, ...(quote ? { quote } : {}) };
        }
        const styles = authorizeDispatch === undefined ? delivery?.styles ?? [] : [];
        if (!validDraftStyles(text, styles)) return { state: "failed" };
        const entities = textEntities(styles);
        const previewLinks = delivery?.linkPreview === true && authorizeDispatch === undefined ? textWebLinks(text) : [];
        const previewEnabled = previewLinks.length > 0;
        const previewUrl = previewEnabled && delivery?.linkPreviewUrl
          ? previewLinks.find(({ href }) => href === delivery.linkPreviewUrl)?.href
          : undefined;
        if (previewEnabled && delivery?.linkPreviewUrl && !previewUrl) return { state: "failed" };
        return await sendContent(id, {
          "@type": "inputMessageText", text: { "@type": "formattedText", text, entities },
          disable_web_page_preview: !previewEnabled || !!previewUrl && previewLinks[0]?.href !== previewUrl,
          link_preview_options: { "@type": "linkPreviewOptions", is_disabled: !previewEnabled,
            ...(previewUrl ? { url: previewUrl } : {}),
            ...(previewEnabled && delivery?.linkPreviewAbove ? { show_above_text: true } : {}) },
        }, reply, authorizeDispatch, expectedSender, expectedParentText !== undefined, undefined, topic, delivery);
      } catch (error) {
        return { state: error instanceof TdError ? "failed" : "unknown" };
      }
    },
    topicDraft: readTopicDraft,
    async saveChatDraft(chatId: string, text: string, expected: string | null, topicId?: number): Promise<"saved" | "changed" | "unsupported"> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || text.length > 4096) return "unsupported";
      const version = await request({ "@type": "getOption", name: "version" });
      const modern = usesNestedPhoto(version);
      let current: string | null;
      if (topicId === undefined) {
        const chat = await request({ "@type": "getChat", chat_id });
        if (chat.id !== chat_id || object(chat.type)?.["@type"] === "chatTypeSecret") return "unsupported";
        const plain = plainDraftText(chat);
        if (chat.draft_message && plain === undefined) return "unsupported";
        current = plain ?? null;
      } else {
        if (!modern) return "unsupported";
        const draft = await readTopicDraft(chatId, topicId);
        if (!draft.writable) return "unsupported";
        current = draft.text;
      }
      if (current !== expected) return "changed";
      const formatted = { "@type": "formattedText", text, entities: [] };
      const draft_message = text.trim() ? { "@type": "draftMessage",
        ...(modern ? { content: { "@type": "draftMessageContentText", text: formatted } }
          : { input_message_text: { "@type": "inputMessageText", text: formatted } }),
      } : null;
      const result = await request({ "@type": "setChatDraftMessage", chat_id, draft_message,
        ...(topicId === undefined ? {} : { topic_id: { "@type": "messageTopicForum", forum_topic_id: topicId } }) });
      if (result["@type"] !== "ok") throw new Error("Telegram did not save the draft.");
      notifyChatChanged();
      return "saved";
    },
    async chatEvents(chatId: string, query: string, cursor?: string): Promise<ChatEventPage | null> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) return null;
      const chat = await request({ "@type": "getChat", chat_id });
      if (chat.id !== chat_id || object(chat.type)?.["@type"] !== "chatTypeSupergroup") return null;
      let result: TdObject;
      try {
        result = await request({ "@type": "getChatEventLog", chat_id, query, from_event_id: cursor ?? "0", limit: 30 });
      } catch (error) {
        if (error instanceof TdError && (error.code === 400 || error.code === 403)) return null;
        throw error;
      }
      if (result["@type"] !== "chatEvents") throw new Error("Unexpected Telegram event response.");
      const actors = new Map<string, Promise<string>>();
      function actor(sender: TdObject | undefined) {
        const user = sender?.["@type"] === "messageSenderUser";
        const id = user ? sender.user_id : sender?.chat_id;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || !id) return Promise.resolve("Telegram");
        const key = `${user}:${id}`;
        let profile = actors.get(key);
        if (!profile) {
          profile = request(user ? { "@type": "getUser", user_id: id } : { "@type": "getChat", chat_id: id }).then((value) => {
            if (value.id !== id) return "Telegram";
            return user ? [value.first_name, value.last_name].filter((part) => typeof part === "string").join(" ").trim().slice(0, 256) || "Telegram user"
              : chatTitle(value);
          }).catch(() => "Telegram");
          actors.set(key, profile);
        }
        return profile;
      }
      const rows = array(result.events).slice(0, 30);
      const events = await Promise.all(rows.map(async (entry) => {
        const raw = object(entry);
        const payload = object(raw?.action);
        const date = raw?.date;
        const id = typeof raw?.id === "string" || Number.isSafeInteger(raw?.id) ? String(raw?.id) : "";
        if (!/^[1-9]\d{0,18}$/.test(id) || (cursor && BigInt(id) >= BigInt(cursor)) || !payload
          || typeof date !== "number" || !Number.isInteger(date) || date < 0) return;
        const action = payload["@type"].replace(/^chatEvent/, "").replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 100) || "Chat event";
        const topic = object(payload.new_topic_info) ?? object(payload.topic_info);
        const detail = typeof topic?.name === "string" ? topic.name
          : typeof payload.new_title === "string" ? payload.new_title : undefined;
        return { id, date, actor: await actor(object(raw?.member_id)), action,
          ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }) };
      }));
      const entries = events.filter((event) => event !== undefined);
      return { events: entries, next: rows.length === 30 ? entries.at(-1)?.id ?? null : null };
    },
    async channelSignatures(chatId: string): Promise<ChannelSignatureView | null> {
      const source = await channelSignatureSource(chatId);
      return source ? { editable: source.editable, values: source.values } : null;
    },
    async saveChannelSignatures(chatId: string, values: ChannelSignatures, expected: ChannelSignatures): Promise<"saved" | "changed" | "unavailable"> {
      const source = await channelSignatureSource(chatId);
      if (!source?.editable) return "unavailable";
      if (source.values.sign !== expected.sign || source.values.showProfile !== expected.showProfile) return "changed";
      if (values.sign === expected.sign && values.showProfile === expected.showProfile) return "saved";
      const result = await request({ "@type": "toggleSupergroupSignMessages", supergroup_id: source.supergroup_id,
        sign_messages: values.sign, show_message_sender: values.showProfile });
      if (result["@type"] !== "ok") return "unavailable";
      notifyChatChanged();
      return "saved";
    },
    chatInfo: readChatInfo,
    async removeChatPhoto(chatId: string, expected: string): Promise<SaveAvatarResult> {
      const current = await readChatInfo(chatId);
      if (!current?.editable) return "unavailable";
      if (current.photoVersion !== expected) return "changed";
      return removeAvatar({ "@type": "setChatPhoto", chat_id: Number(chatId), photo: null });
    },
    async saveChatPhoto(chatId: string, base64: string, expected: string | null): Promise<SaveAvatarResult> {
      const current = await readChatInfo(chatId);
      if (!current?.editable || current.photoVersion === undefined) return "unavailable";
      if (current.photoVersion !== expected) return "changed";
      return uploadAvatar(base64, { "@type": "setChatPhoto", chat_id: Number(chatId) });
    },
    async removeProfilePhoto(expected: string): Promise<SaveAvatarResult> {
      requireReady();
      const user = await request({ "@type": "getMe" });
      if (user["@type"] !== "user" || !Number.isSafeInteger(user.id) || Number(user.id) < 1) return "unavailable";
      if (avatarVersion(user.profile_photo) !== expected) return "changed";
      const full = await request({ "@type": "getUserFullInfo", user_id: user.id });
      const id = full["@type"] === "userFullInfo" && mainProfilePhotoId(user, full);
      return id ? removeAvatar({ "@type": "deleteProfilePhoto", profile_photo_id: id }) : "changed";
    },
    async saveProfilePhoto(base64: string, expected: string | null): Promise<SaveAvatarResult> {
      requireReady();
      const user = await request({ "@type": "getMe" });
      if (user["@type"] !== "user" || !Number.isSafeInteger(user.id) || Number(user.id) < 1) return "unavailable";
      const version = avatarVersion(user.profile_photo);
      if (version === undefined) return "unavailable";
      if (version !== expected) return "changed";
      return uploadAvatar(base64, { "@type": "setProfilePhoto", is_public: false });
    },
    async saveChatInfo(chatId: string, change: ChatInfoChange): Promise<"saved" | "changed" | "unavailable"> {
      const current = await readChatInfo(chatId);
      if (!current?.editable) return "unavailable";
      if (current[change.field] !== change.expected) return "changed";
      const value = change.value.trim();
      const length = [...value].length;
      if (change.field === "title" ? !length || length > 128 || /[\r\n]/.test(value) : length > 255) return "unavailable";
      if (current[change.field] === value) return "saved";
      const chat_id = Number(chatId);
      const result = await request(change.field === "title" ? { "@type": "setChatTitle", chat_id, title: value }
        : { "@type": "setChatDescription", chat_id, description: value });
      if (result["@type"] !== "ok") return "unavailable";
      notifyChatChanged();
      return "saved";
    },
    groupSlowMode,
    async saveGroupSlowMode(chatId: string, delay: SlowModeDelay, expected: SlowModeDelay): Promise<"saved" | "changed" | "unavailable"> {
      if (!slowModeDelays.includes(delay)) return "unavailable";
      const current = await groupSlowMode(chatId);
      if (!current?.editable) return "unavailable";
      if (current.delay !== expected) return "changed";
      if (current.delay === delay) return "saved";
      const result = await request({ "@type": "setChatSlowModeDelay", chat_id: Number(chatId), slow_mode_delay: delay });
      if (result["@type"] !== "ok") return "unavailable";
      notifyChatChanged();
      return "saved";
    },
    async groupPermissions(chatId: string): Promise<GroupPermissionsView | null> {
      const source = await groupPermissionsSource(chatId);
      if (!source) return null;
      const values: GroupPermissionsView["values"] = {};
      for (const key of Object.keys(groupPermissionLabels) as GroupPermission[]) {
        const value = source.permissions[key];
        if (typeof value === "boolean") values[key] = value;
      }
      return { editable: source.editable, values };
    },
    async saveGroupPermissions(chatId: string, changes: GroupPermissionChange[]): Promise<"saved" | "changed" | "unavailable"> {
      const source = await groupPermissionsSource(chatId);
      if (!source?.editable || !changes.length || new Set(changes.map(({ key }) => key)).size !== changes.length) return "unavailable";
      const permissions = { ...source.permissions };
      for (const { key, expected, enabled } of changes) {
        if (!Object.hasOwn(groupPermissionLabels, key) || typeof permissions[key] !== "boolean") return "unavailable";
        if (permissions[key] !== expected) return "changed";
        permissions[key] = enabled;
      }
      const result = await request({ "@type": "setChatPermissions", chat_id: source.chat_id, permissions });
      if (result["@type"] !== "ok") return "unavailable";
      notifyChatChanged();
      return "saved";
    },
    async joinRequests(chatId: string, query: string, cursor?: NonNullable<JoinRequestPage["next"]>): Promise<JoinRequestPage | null> {
      const chat_id = await inviteChat(chatId);
      let result: TdObject;
      try {
        result = await request({ "@type": "getChatJoinRequests", chat_id, query, limit: 30,
          ...(cursor ? { offset_request: { "@type": "chatJoinRequest", user_id: Number(cursor.userId), date: cursor.date } } : {}) });
      } catch (error) {
        if (error instanceof TdError && (error.code === 400 || error.code === 403)) return null;
        throw error;
      }
      if (result["@type"] !== "chatJoinRequests") throw new Error("Unexpected Telegram join request response.");
      const rows = array(result.requests).slice(0, 30).map(object);
      const requests = await Promise.all(rows.map(async (raw) => {
        const id = raw?.user_id;
        const date = raw?.date;
        if (raw?.["@type"] !== "chatJoinRequest" || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0
          || typeof date !== "number" || !Number.isInteger(date) || date < 0 || date > 2147483647) return;
        const user = await request({ "@type": "getUser", user_id: id }).catch(() => undefined);
        const name = user?.id === id
          ? [user.first_name, user.last_name].filter((field) => typeof field === "string").join(" ").trim().slice(0, 256) : "";
        return { userId: String(id), date, name: name || "Telegram user",
          bio: typeof raw.bio === "string" ? raw.bio.slice(0, 512) : "" };
      }));
      const last = requests.at(-1);
      const next = last && (rows.length === 30 || (!cursor && Number(result.total_count) > rows.length))
        && (last.userId !== cursor?.userId || last.date !== cursor?.date) ? { userId: last.userId, date: last.date } : null;
      return { requests: requests.filter((row) => row !== undefined), next };
    },
    async reviewJoinRequest(chatId: string, userId: string, approve: boolean) {
      const chat_id = await inviteChat(chatId);
      const user_id = Number(userId);
      if (!Number.isSafeInteger(user_id) || user_id <= 0) return false;
      const result = await request({ "@type": "processChatJoinRequest", chat_id, user_id, approve });
      return result["@type"] === "ok";
    },
    async managedInvites(chatId: string, cursor?: NonNullable<InvitePage["next"]>): Promise<InvitePage | null> {
      const chat_id = await inviteChat(chatId);
      const owner = Number(await archiveAccount());
      let result: TdObject;
      try {
        result = await request({ "@type": "getChatInviteLinks", chat_id, creator_user_id: owner, is_revoked: false,
          offset_date: cursor?.created ?? 0, offset_invite_link: cursor?.link ?? "", limit: 30 });
      } catch (error) {
        if (error instanceof TdError && (error.code === 400 || error.code === 403)) return null;
        throw error;
      }
      if (result["@type"] !== "chatInviteLinks") throw new Error("Unexpected Telegram invite response.");
      const rows = array(result.invite_links).slice(0, 30);
      const links = rows.flatMap((row) => {
        const link = managedInvite(object(row), owner);
        return link ? [link] : [];
      });
      const last = managedInvite(object(rows.at(-1)), owner);
      const next = last && rows.length === 30 && last.created > 0 && last.link !== cursor?.link
        ? { link: last.link, created: last.created } : null;
      return { links, next };
    },
    async createManagedInvite(chatId: string, draft: InviteDraft) {
      const chat_id = await inviteChat(chatId);
      const owner = Number(await archiveAccount());
      if (draft.expires && draft.expires <= Math.floor(Date.now() / 1000)) throw new Error("Invite expiry must be in the future.");
      const result = await request({ "@type": "createChatInviteLink", chat_id, name: draft.name,
        expiration_date: draft.expires, member_limit: draft.limit, creates_join_request: draft.approval });
      const link = managedInvite(result, owner);
      if (!link) throw new Error("Telegram did not confirm the new invite.");
      return link;
    },
    async revokeManagedInvite(chatId: string, link: string) {
      if (!isTelegramInviteLink(link)) return false;
      const chat_id = await inviteChat(chatId);
      const owner = Number(await archiveAccount());
      const existing = await request({ "@type": "getChatInviteLink", chat_id, invite_link: link });
      if (managedInvite(existing, owner)?.link !== link) return false;
      const result = await request({ "@type": "revokeChatInviteLink", chat_id, invite_link: link });
      return result["@type"] === "chatInviteLinks" && array(result.invite_links).some((entry) => {
        const raw = object(entry);
        return raw?.invite_link === link && raw.is_revoked === true;
      });
    },
    async chatMembers(chatId: string, query: string, offset = 0): Promise<ChatMemberPage | null> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isInteger(offset) || offset < 0 || offset > 2147483600) return null;
      const chat = await request({ "@type": "getChat", chat_id });
      const type = object(chat.type);
      if (chat.id !== chat_id) return null;
      const limit = 30;
      async function member(row: unknown): Promise<ChatMemberPage["members"][number] | undefined> {
        const raw = object(row);
        const sender = object(raw?.member_id);
        const status = object(raw?.status);
        const role = status?.["@type"] === "chatMemberStatusCreator" ? "owner"
          : status?.["@type"] === "chatMemberStatusAdministrator" ? "admin"
          : status?.["@type"] === "chatMemberStatusMember" ? "member"
          : status?.["@type"] === "chatMemberStatusRestricted" && status.is_member === true ? "restricted" : undefined;
        if (!role || sender?.["@type"] !== "messageSenderUser"
          || typeof sender.user_id !== "number" || !Number.isSafeInteger(sender.user_id) || sender.user_id < 1) return;
        const userId = sender.user_id;
        const user = await request({ "@type": "getUser", user_id: userId }).catch(() => undefined);
        if (!user || user.id !== userId) return;
        const name = [user.first_name, user.last_name].filter((field) => typeof field === "string").join(" ").trim().slice(0, 256);
        const tag = typeof raw?.tag === "string" ? raw.tag.trim().slice(0, 64) : "";
        return { id: String(userId), name: name || "Telegram user", role, ...(tag ? { tag } : {}) };
      }

      if (type?.["@type"] === "chatTypeBasicGroup" && Number.isSafeInteger(type.basic_group_id)) {
        const group = await request({ "@type": "getBasicGroupFullInfo", basic_group_id: type.basic_group_id });
        if (group["@type"] !== "basicGroupFullInfo") return null;
        const rows = array(group.members);
        if (!query) {
          const members = await Promise.all(rows.slice(offset, offset + limit).map(member));
          return { members: members.filter((item) => item !== undefined), next: offset + limit < rows.length ? offset + limit : null };
        }
        const members: ChatMemberPage["members"] = [];
        const needle = query.toLocaleLowerCase();
        for (let i = 0; i < rows.length; i += limit) {
          const chunk = await Promise.all(rows.slice(i, i + limit).map(member));
          for (const entry of chunk) if (entry?.name.toLocaleLowerCase().includes(needle)) members.push(entry);
        }
        return { members: members.slice(offset, offset + limit), next: offset + limit < members.length ? offset + limit : null };
      }

      if (type?.["@type"] !== "chatTypeSupergroup" || !Number.isSafeInteger(type.supergroup_id)) return null;
      const result = await request({ "@type": "getSupergroupMembers", supergroup_id: type.supergroup_id,
        ...(query ? { filter: { "@type": "supergroupMembersFilterSearch", query } } : {}), offset, limit });
      if (result["@type"] !== "chatMembers") return null;
      const rows = array(result.members).slice(0, limit);
      const members = await Promise.all(rows.map(member));
      const next = offset + rows.length;
      return { members: members.filter((item) => item !== undefined),
        next: rows.length && (rows.length === limit || Number(result.total_count) > next) ? next : null };
    },
    canScheduleWhenOnline,
    async scheduledMessages(chatId: string, topicId?: number): Promise<ScheduledMessage[]> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid chat.");
      const result = await request({ "@type": "getChatScheduledMessages", chat_id });
      if (result["@type"] !== "messages") throw new Error("Scheduled messages are unavailable.");
      return array(result.messages).flatMap((item) => {
        const raw = object(item);
        const state = object(raw?.scheduling_state);
        if (raw?.chat_id !== chat_id || !Number.isSafeInteger(raw.id) || Number(raw.id) < 1 || !state
          || (topicId !== undefined && forumTopicId(raw) !== topicId)) return [];
        const view = message(raw, "You");
        const at = state.send_date;
        const repeatEvery = state.repeat_period;
        return view ? [{ id: view.id, text: view.text,
          ...((view.hasPhoto || view.document) && !view.oneView && mayShareHistoryMessage(raw) ? { media: view } : {}),
          ...(state["@type"] === "messageSchedulingStateSendWhenOnline" ? { whenOnline: true as const } : {}),
          ...(typeof repeatEvery === "number" && Number.isInteger(repeatEvery) && repeatEvery > 0
            && repeatEvery <= 2147483647 ? { repeatEvery } : {}),
          ...(typeof at === "number" && Number.isInteger(at) && at > 0 && at <= 2147483647 ? { at } : {}) }] : [];
      }).slice(0, 100);
    },
    async changeScheduledMessage(chatId: string, expected: ScheduledMessage, at: number | null, topicId?: number): Promise<"updated" | "changed" | "unavailable"> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(expected.id);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id < 1
        || at !== null && (!Number.isInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) return "unavailable";
      const current = await request({ "@type": "getMessage", chat_id, message_id });
      const schedule = object(current.scheduling_state);
      if (current["@type"] !== "message" || current.chat_id !== chat_id || current.id !== message_id
        || current.is_outgoing !== true || !schedule || (topicId !== undefined && forumTopicId(current) !== topicId)
        || message(current, "You")?.text !== expected.text || schedule.send_date !== expected.at
        || (schedule["@type"] === "messageSchedulingStateSendWhenOnline") !== (expected.whenOnline === true)
        || (schedule.repeat_period ?? 0) !== (expected.repeatEvery ?? 0)) return "changed";
      const properties = await request({ "@type": "getMessageProperties", chat_id, message_id });
      if (properties["@type"] !== "messageProperties" || properties.can_edit_scheduling_state !== true) return "unavailable";
      if (at !== null && schedule["@type"] !== "messageSchedulingStateSendAtDate" && expected.whenOnline !== true) return "unavailable";
      if (at !== null && at === expected.at) return "updated";
      const result = await request({ "@type": "editMessageSchedulingState", chat_id, message_id,
        scheduling_state: at === null ? null : { "@type": "messageSchedulingStateSendAtDate", send_date: at,
          ...(expected.repeatEvery ? { repeat_period: expected.repeatEvery } : {}) } });
      if (result["@type"] !== "ok") return "unavailable";
      notifyChatChanged();
      return "updated";
    },
    async cancelScheduledMessage(chatId: string, messageId: string, topicId?: number) {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id < 1) return false;
      const current = await request({ "@type": "getMessage", chat_id, message_id });
      if (current.chat_id !== chat_id || current.id !== message_id || !object(current.scheduling_state) || current.is_outgoing !== true
        || (topicId !== undefined && forumTopicId(current) !== topicId)) return false;
      const result = await request({ "@type": "deleteMessages", chat_id, message_ids: [message_id], revoke: true });
      return result["@type"] === "ok";
    },
    async mediaCollectionState(chatId: string, messageId: string, kind: MediaCollectionKind) {
      const source = await collectionSource(chatId, messageId, kind);
      return source ? inMediaCollection(kind, source.file) : null;
    },
    async setMediaCollection(chatId: string, messageId: string, kind: MediaCollectionKind, saved: boolean, expected: boolean) {
      try {
        const initial = (await collectionSource(chatId, messageId, kind))?.file;
        if (!initial) return "unavailable" as const;
        if (await inMediaCollection(kind, initial) !== expected) return "changed" as const;
        if (saved === expected) return "saved" as const;
        const file = (await collectionSource(chatId, messageId, kind))?.file;
        if (!file || file.id !== initial.id || state.state !== "ready") return "unavailable" as const;
        const method = collectionQueries[kind];
        const result = await request({ "@type": saved ? method.add : method.remove,
          [method.field]: { "@type": "inputFileId", id: file.id } });
        if (result["@type"] !== "ok" || await inMediaCollection(kind, file) !== saved) return "unknown" as const;
        return "saved" as const;
      } catch (error) { return error instanceof TdError ? "unavailable" as const : "unknown" as const; }
    },
    async messageStickerPack(chatId: string, messageId: string, offset: number) {
      const source = await collectionSource(chatId, messageId, "sticker");
      const id = stickerSetId(source?.media.set_id);
      return stickerPackPreview(id ? await readStickerSet(id) : undefined, offset);
    },
    async linkedStickerPack(url: string, offset: number) {
      return stickerPackPreview(await linkedStickerSet(url), offset);
    },
    async installLinkedStickerPack(url: string, packId: string) {
      try { return await installStickerSet(await linkedStickerSet(url), packId); }
      catch (error) { return error instanceof TdError ? "unavailable" as const : "unknown" as const; }
    },
    async installMessageStickerPack(chatId: string, messageId: string, packId: string) {
      try {
        const source = await collectionSource(chatId, messageId, "sticker");
        if (stickerSetId(source?.media.set_id) !== packId) return "unavailable" as const;
        return await installStickerSet(await readStickerSet(packId), packId);
      } catch (error) { return error instanceof TdError ? "unavailable" as const : "unknown" as const; }
    },
    installedStickerPacks,
    async reorderStickerPacks(order: string[], expected: string[]) {
      try {
        const current = (await installedStickerPacks()).map(({ id }) => id);
        if (current.length !== expected.length || current.some((id, index) => id !== expected[index])) return "changed" as const;
        const ids = new Set(current);
        if (order.length !== current.length || new Set(order).size !== current.length || order.some((id) => !ids.has(id))) {
          return "unavailable" as const;
        }
        if (order.every((id, index) => id === current[index])) return "saved" as const;
        if (state.state !== "ready") return "unavailable" as const;
        const result = await request({ "@type": "reorderInstalledStickerSets",
          sticker_type: { "@type": "stickerTypeRegular" }, sticker_set_ids: order });
        if (result["@type"] !== "ok") return "unknown" as const;
        const latest = (await installedStickerPacks()).map(({ id }) => id);
        return latest.length === order.length && latest.every((id, index) => id === order[index]) ? "saved" as const : "unknown" as const;
      } catch (error) { return error instanceof TdError ? "unavailable" as const : "unknown" as const; }
    },
    async stickerPackPage(packId: string, offset: number) {
      const entries = await stickersInPack(packId);
      const choices = await Promise.all(entries.slice(offset, offset + 20).map(({ id, media }, index) =>
        mediaChoice("sticker", id, media, offset + index)));
      return { choices, next: offset + choices.length < entries.length ? offset + choices.length : null };
    },
    async mediaChoices(kind: "sticker" | "gif", stickerQuery?: string) {
      const results = await availableMedia(kind, stickerQuery);
      return Promise.all(results.map(({ id, media }, index) => mediaChoice(kind, id, media, index)));
    },
    async searchGifs(id: string, query: string, topic?: ForumTopicTarget) {
      requireReady();
      const chatId = Number(id);
      if (!Number.isSafeInteger(chatId) || !chatId || !query.trim() || query.length > 80) return [];
      const option = await request({ "@type": "getOption", name: "animation_search_bot_username" });
      const username = option.value;
      if (option["@type"] !== "optionValueString" || typeof username !== "string" || !/^[a-z0-9_]{1,64}$/i.test(username)) {
        throw new Error("Telegram has not configured GIF search.");
      }
      const peer = await request({ "@type": "searchPublicChat", username });
      const peerType = object(peer.type);
      const botId = peerType?.user_id;
      if (peer["@type"] !== "chat" || peerType?.["@type"] !== "chatTypePrivate"
        || typeof botId !== "number" || !Number.isSafeInteger(botId) || botId <= 0) throw new Error("Telegram GIF search is unavailable.");
      const bot = await request({ "@type": "getUser", user_id: botId });
      const botType = object(bot.type);
      if (bot["@type"] !== "user" || bot.id !== botId || botType?.["@type"] !== "userTypeBot"
        || botType.is_inline !== true || botType.need_location === true) throw new Error("Telegram GIF search is unavailable.");
      const results = await request({ "@type": "getInlineQueryResults", bot_user_id: botId, chat_id: chatId, query: query.trim(), offset: "" });
      const queryId = typeof results.inline_query_id === "number" && Number.isSafeInteger(results.inline_query_id)
        ? String(results.inline_query_id) : results.inline_query_id;
      if (results["@type"] !== "inlineQueryResults" || typeof queryId !== "string" || !/^-?[1-9]\d{0,18}$/.test(queryId)) {
        throw new Error("Telegram GIF search is unavailable.");
      }
      const hits = array(results.results).flatMap((value, index) => {
        const result = object(value);
        const media = object(result?.animation);
        if (result?.["@type"] !== "inlineQueryResultAnimation" || media?.["@type"] !== "animation"
          || typeof result.id !== "string" || !result.id || result.id.length > 256) return [];
        return [{ id: index + 1, media, resultId: result.id }];
      }).slice(0, 20);
      const now = Date.now();
      for (const [token, entry] of gifResults) if (entry.expires <= now) gifResults.delete(token);
      return Promise.all(hits.map(async ({ id, media, resultId }, index) => {
        const token = randomUUID();
        gifResults.set(token, { chatId, topic, queryId, resultId, expires: now + 300_000 });
        if (gifResults.size > 160) gifResults.delete(gifResults.keys().next().value!);
        return { ...await mediaChoice("gif", id, media, index), gifToken: token };
      }));
    },
    async sendFoundGif(id: string, token: string, topic?: ForumTopicTarget, target?: MediaReply, sendOptions?: MediaDelivery): Promise<SendResult> {
      const result = gifResults.get(token);
      const chat_id = Number(id);
      if (!validMediaDelivery(sendOptions) || !result || result.chatId !== chat_id || result.topic?.id !== topic?.id || result.topic?.name !== topic?.name || result.expires <= Date.now()) return { state: "failed" };
      gifResults.delete(token);
      try {
        if (!(await postingPermissions(id)).otherMedia) return { state: "failed" };
        const destination = await mediaDestination(id, topic, target);
        if (!destination || !validMediaDelivery(sendOptions) || state.state !== "ready") return { state: "failed" };
        const { reply, topicId } = destination;
        const sent = await request({ "@type": "sendInlineQueryResultMessage", chat_id,
          ...(topicId === undefined ? {} : { topic_id: { "@type": "messageTopicForum", forum_topic_id: topicId } }),
          ...(reply ? { reply_to: reply } : {}), ...mediaSendOptions(sendOptions),
          query_id: result.queryId, result_id: result.resultId, hide_via_bot: false });
        if (sent["@type"] !== "message" || sent.chat_id !== chat_id || !Number.isSafeInteger(sent.id)) return { state: "unknown" };
        const sending = object(sent.sending_state)?.["@type"];
        if (sending === "messageSendingStateFailed") return { state: "failed" };
        if (!mediaScheduleMatches(sent, sendOptions?.at)) return { state: "unknown" };
        if (sending === "messageSendingStatePending") {
          const delivery = await waitForDelivery(`${chat_id}:${sent.id}`, 6500);
          return mediaDeliveryResult(delivery, topicId, target);
        }
        const view = !sending && mediaDeliveryMatches(sent, topicId, target) && message(sent, "You");
        return view ? { state: "sent", message: view } : { state: "unknown" };
      } catch (error) {
        return { state: error instanceof TdError ? "failed" : "unknown" };
      }
    },
    async sendMediaChoice(chatId: string, kind: "sticker" | "gif", fileId: number, stickerQuery?: string, packId?: string, topic?: ForumTopicTarget, target?: MediaReply, sendOptions?: MediaDelivery, gif?: GifSendOptions): Promise<SendResult> {
      try {
        if ((gif && (kind !== "gif" || gif.caption.length > 1024)) || !validMediaDelivery(sendOptions)) return { state: "failed" };
        if (packId !== undefined && (kind !== "sticker" || stickerQuery !== undefined)) return { state: "failed" };
        const choices = packId === undefined ? await availableMedia(kind, stickerQuery) : await stickersInPack(packId);
        const match = choices.find(({ id }) => id === fileId);
        if (!match) return { state: "failed" };
        const input = { "@type": "inputFileId", id: fileId };
        const { width, height, duration } = match.media;
        const modern = usesNestedPhoto(await request({ "@type": "getOption", name: "version" }));
        const sticker = { sticker: input, width, height };
        const animation = { animation: input, width, height, duration };
        const destination = await mediaDestination(chatId, topic, target);
        if (!destination) return { state: "failed" };
        return await sendContent(Number(chatId), kind === "sticker"
          ? { "@type": "inputMessageSticker", ...(modern ? { sticker: { "@type": "inputSticker", ...sticker } } : sticker) }
          : { "@type": "inputMessageAnimation", ...(modern ? { animation: { "@type": "inputAnimation", ...animation } } : animation),
            ...(gif?.caption ? { caption: { "@type": "formattedText", text: gif.caption, entities: [] } } : {}),
            ...(gif?.caption && gif.captionAbove ? { show_caption_above_media: true } : {}),
            ...(gif?.spoiler ? { has_spoiler: true } : {}) },
          destination.reply, undefined, undefined, false, undefined, destination.topicId, sendOptions);
      } catch (error) {
        return { state: error instanceof TdError ? "failed" : "unknown" };
      }
    },
    async sendVideoNote(chatId: string, base64: string, format: "webm" | "mp4", topic?: ForumTopicTarget, target?: MediaReply, sendOptions?: MediaDelivery): Promise<SendResult> {
      requireReady();
      if (!validMediaDelivery(sendOptions) || outgoingAttachment || base64.length > Math.ceil(maxVideoNoteBytes / 3) * 4) return { state: "failed" };
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > maxVideoNoteBytes || bytes.toString("base64") !== base64) return { state: "failed" };
      const directory = ["/opt/homebrew/bin", "/usr/local/bin"].find((bin) =>
        existsSync(`${bin}/ffmpeg`) && existsSync(`${bin}/ffprobe`));
      if (!directory) return { state: "failed" };
      outgoingAttachment = true;
      let staged: Awaited<ReturnType<typeof stageAttachment>> | undefined;
      let result: SendResult = { state: "failed" };
      let dispatched = false;
      try {
        if (!(await postingPermissions(chatId)).videoNote) return result;
        staged = await stageAttachment(options.directory, bytes, `video-note.${format}`, "document");
        const path = staged.path + ".mp4";
        const length = 384;
        await runMediaConverter(`${directory}/ffmpeg`, ["-nostdin", "-v", "error", "-protocol_whitelist", "file",
          ...(format === "mp4" ? ["-enable_drefs", "0"] : []), "-f", format === "webm" ? "matroska" : "mov",
          "-i", staged.path, "-map", "0:v:0", "-map", "0:a:0?", "-t", "60", "-r", "30",
          "-vf", `scale=${length}:${length}:force_original_aspect_ratio=increase,crop=${length}:${length},setsar=1`,
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", "650k", "-maxrate", "800k", "-bufsize", "1600k",
          "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", path],
          { timeout: 40_000, maxBuffer: 64 * 1024 });
        const probe = await runMediaConverter(`${directory}/ffprobe`, ["-v", "error", "-f", "mov",
          "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { timeout: 5000, maxBuffer: 4096 });
        const seconds = Number(probe.stdout.trim());
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 61) return result;
        const media = { video_note: { "@type": "inputFileLocal", path }, duration: Math.min(60, Math.ceil(seconds)), length };
        const modern = usesNestedPhoto(await request({ "@type": "getOption", name: "version" }));
        const destination = await mediaDestination(chatId, topic, target);
        if (!destination) return result;
        dispatched = true;
        result = await sendContent(Number(chatId), { "@type": "inputMessageVideoNote",
          ...(modern ? { video_note: { "@type": "inputVideoNote", ...media } } : media) },
          destination.reply, undefined, undefined, false, undefined, destination.topicId, sendOptions);
        return result;
      } catch (error) {
        result = { state: !dispatched || error instanceof TdError ? "failed" : "unknown" };
        return result;
      } finally {
        if (result.state !== "unknown") await staged?.dispose().catch(() => {});
        outgoingAttachment = false;
      }
    },
    async sendVoice(chatId: string, base64: string, duration: number, format: "ogg" | "webm" | "mp4", topic?: ForumTopicTarget, target?: MediaReply, sendOptions?: MediaDelivery): Promise<SendResult> {
      requireReady();
      const bytes = Buffer.from(base64, "base64");
      if (!validMediaDelivery(sendOptions) || outgoingAttachment || !bytes.length || bytes.length > maxVoiceBytes || bytes.toString("base64") !== base64) return { state: "failed" };
      outgoingAttachment = true;
      let staged: Awaited<ReturnType<typeof stageAttachment>> | undefined;
      let result: SendResult = { state: "failed" };
      try {
        staged = await stageAttachment(options.directory, bytes, `voice.${format}`, "document");
        let path = staged.path;
        if (format !== "ogg") {
          const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
          if (!ffmpeg) return result;
          path = staged.path + ".ogg";
          await runMediaConverter(ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file",
            "-f", format === "webm" ? "matroska" : "mov", "-i", staged.path, "-map", "0:a:0", "-t", "120", "-ac", "1",
            "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", path], { timeout: 20_000, maxBuffer: 64 * 1024 });
        } else if (bytes.toString("ascii", 0, 4) !== "OggS" || !bytes.subarray(0, 256).includes(Buffer.from("OpusHead"))) {
          return result;
        }
        const media = { voice_note: { "@type": "inputFileLocal", path }, duration, waveform: "" };
        const modern = usesNestedPhoto(await request({ "@type": "getOption", name: "version" }));
        const destination = await mediaDestination(chatId, topic, target);
        if (!destination) return result;
        result = await sendContent(Number(chatId), { "@type": "inputMessageVoiceNote",
          ...(modern ? { voice_note: { "@type": "inputVoiceNote", ...media } } : media) },
          destination.reply, undefined, undefined, false, undefined, destination.topicId, sendOptions);
        return result;
      } catch (error) {
        result = { state: error instanceof TdError ? "failed" : "unknown" };
        return result;
      } finally {
        if (result.state !== "unknown") await staged?.dispose().catch(() => {});
        outgoingAttachment = false;
      }
    },
    async sendPhotoAlbum(chatId: string, caption: string, photos: string[], topic?: ForumTopicTarget, target?: MediaReply, sendOptions?: MediaDelivery, albumOptions?: MediaSendOptions): Promise<"sent" | "failed" | "unknown"> {
      requireReady();
      const images = photos.map(inspectJpeg);
      if (!validMediaDelivery(sendOptions) || outgoingAttachment || images.length < 2 || images.length > 10 || images.some((image) => !image)) return "failed";
      outgoingAttachment = true;
      const staging: Awaited<ReturnType<typeof stageAttachment>>[] = [];
      let result: "sent" | "failed" | "unknown" = "failed";
      try {
        if (!(await postingPermissions(chatId)).photo) return result;
        const id = Number(chatId);
        const modern = usesNestedPhoto(await request({ "@type": "getOption", name: "version" }));
        const contents: TdObject[] = [];
        for (const [index, image] of images.entries()) {
          if (!image) return result;
          const staged = await stageAttachment(options.directory, image.bytes, "photo.jpg", "photo");
          staging.push(staged);
          const media = { photo: { "@type": "inputFileLocal", path: staged.path }, width: image.width, height: image.height };
          contents.push({ "@type": "inputMessagePhoto", ...(modern ? { photo: { "@type": "inputPhoto", ...media } } : media),
            caption: { "@type": "formattedText", text: index === 0 ? caption : "", entities: [] },
            ...(albumOptions?.spoiler ? { has_spoiler: true } : {}),
            ...(caption.trim() && albumOptions?.captionAbove ? { show_caption_above_media: true } : {}) });
        }
        const destination = await mediaDestination(chatId, topic, target);
        if (!destination || !validMediaDelivery(sendOptions)) return result;
        const { topicId, reply } = destination;
        requireReady();
        result = "unknown";
        const response = await request({ "@type": "sendMessageAlbum", chat_id: id, input_message_contents: contents,
          ...(topicId === undefined ? {} : { topic_id: { "@type": "messageTopicForum", forum_topic_id: topicId } }),
          ...(reply ? { reply_to: reply } : {}), ...mediaSendOptions(sendOptions) });
        const entries = array(response.messages).map(object);
        if (response["@type"] !== "messages" || entries.length !== images.length
          || entries.some((entry) => entry?.chat_id !== id || !Number.isSafeInteger(entry.id))) return result;
        const sent = await Promise.all(entries.map(async (entry) => {
          if (!entry || !mediaScheduleMatches(entry, sendOptions?.at)) return "unknown";
          const sending = object(entry.sending_state)?.["@type"];
          if (!sending) return entry && mediaDeliveryMatches(entry, topicId, target) ? "sent" : "unknown";
          if (sending === "messageSendingStateFailed") return "failed";
          if (sending === "messageSendingStatePending") {
            const delivery = await waitForDelivery(`${id}:${entry?.id}`, 30_000);
            return mediaDeliveryResult(delivery, topicId, target).state;
          }
          return "unknown";
        }));
        result = sent.every((status) => status === "sent") ? "sent" : sent.every((status) => status === "failed") ? "failed" : "unknown";
        return result;
      } catch (error) {
        if (error instanceof TdError) result = "failed";
        return result;
      } finally {
        if (result !== "unknown") await Promise.allSettled(staging.map((item) => item.dispose()));
        outgoingAttachment = false;
      }
    },
    async sendPhoto(chatId: string, caption: string, base64: string, topic?: ForumTopicTarget, replyTo?: string, options?: MediaSendOptions): Promise<SendResult> {
      const jpeg = inspectJpeg(base64);
      if (!jpeg) return { state: "failed" };
      return sendAttachment(chatId, caption, jpeg.bytes, "photo.jpg", "photo", (path) => ({
        "@type": "inputMessagePhoto", photo: { "@type": "inputFileLocal", path },
        width: jpeg.width, height: jpeg.height,
        ...(options?.spoiler ? { has_spoiler: true } : {}),
        ...(options?.captionAbove && caption.trim() ? { show_caption_above_media: true } : {}),
      }), undefined, topic, replyTo);
    },
    telegramProfile: readTelegramProfile,
    checkTelegramUsername,
    async saveTelegramProfile(change: ProfileChange) {
      const current = await readTelegramProfile();
      let query: TdObject;
      if (change.kind === "name") {
        if (current.first !== change.expectedFirst || current.last !== change.expectedLast) return "changed";
        const first_name = change.first.trim();
        const last_name = change.last.trim();
        if (!first_name || first_name.length > 64 || last_name.length > 64) return "unsupported";
        query = { "@type": "setName", first_name, last_name };
      } else if (change.kind === "username") {
        if (current.username !== change.expectedUsername) return "changed";
        if (current.username === change.username) return "saved";
        if (change.username && change.username.toLowerCase() !== current.username.toLowerCase()
          && await checkTelegramUsername(change.username) !== "available") return "unsupported";
        query = { "@type": "setUsername", username: change.username };
      } else if (change.kind === "birthdate") {
        const expected = change.expectedBirthdate;
        if (current.birthdate?.day !== expected?.day || current.birthdate?.month !== expected?.month
          || current.birthdate?.year !== expected?.year) return "changed";
        query = { "@type": "setBirthdate", birthdate: change.birthdate && { "@type": "birthdate", ...change.birthdate } };
      } else {
        if (current.bio !== change.expectedBio) return "changed";
        if (!current.bioEditable || /[\r\n]/.test(change.bio) || [...change.bio].length > current.bioLimit) return "unsupported";
        query = { "@type": "setBio", bio: change.bio };
      }
      const result = await request(query);
      if (result["@type"] !== "ok") return "unsupported";
      notifyChatChanged();
      return "saved";
    },
    async telegramPrivacy(key: TelegramPrivacyKey) {
      return (await privacyRules(key)).view;
    },
    async saveTelegramPrivacy(key: TelegramPrivacyKey, audience: TelegramPrivacyAudience, expected: string) {
      if (!privacyAudiences(key).includes(audience)) return "unsupported";
      const current = await privacyRules(key);
      if (current.view.version !== expected) return "changed";
      if (current.view.audience === null) return "unsupported";
      if (current.view.audience === audience) return "saved";
      const result = await request({ "@type": "setUserPrivacySettingRules", setting: current.setting,
        rules: { "@type": "userPrivacySettingRules", rules: [...current.prefix, { "@type": privacyBase[audience] }] } });
      return result["@type"] === "ok" ? "saved" : "unsupported";
    },
    chatAutoDelete: readChatAutoDelete,
    async saveChatAutoDelete(chatId: string, days: number, expected: number) {
      if (!Number.isInteger(days) || days < 0 || days > 365) return "unavailable" as const;
      const current = await readChatAutoDelete(chatId);
      if (!current?.editable) return "unavailable" as const;
      if (current.days !== expected) return "changed" as const;
      if (days === expected) return "saved" as const;
      const result = await request({ "@type": "setChatMessageAutoDeleteTime",
        chat_id: Number(chatId), message_auto_delete_time: days * 86400 });
      if (result["@type"] !== "ok") return "unavailable" as const;
      notifyChatChanged();
      return "saved" as const;
    },
    defaultAutoDeleteDays,
    async saveDefaultAutoDeleteDays(days: number, expected: number) {
      if (!Number.isInteger(days) || days < 0 || days > 365) return "unavailable" as const;
      if (await defaultAutoDeleteDays() !== expected) return "changed" as const;
      if (days === expected) return "saved" as const;
      const result = await request({ "@type": "setDefaultMessageAutoDeleteTime",
        message_auto_delete_time: { "@type": "messageAutoDeleteTime", time: days * 86400 } });
      return result["@type"] === "ok" ? "saved" as const : "unavailable" as const;
    },
    archiveSettings: readArchiveSettings,
    async saveArchiveSettings(values: ArchiveSettings, expected: ArchiveSettings) {
      const current = await readArchiveSettings();
      if (current.muteUnknown !== expected.muteUnknown || current.keepUnmuted !== expected.keepUnmuted
        || current.keepFolderChats !== expected.keepFolderChats) return "changed" as const;
      if (values.muteUnknown && !current.muteUnknown && !current.canMuteUnknown) return "unavailable" as const;
      const result = await request({ "@type": "setArchiveChatListSettings", settings: {
        "@type": "archiveChatListSettings", archive_and_mute_new_chats_from_unknown_users: values.muteUnknown,
        keep_unmuted_chats_archived: values.keepUnmuted, keep_chats_from_folders_archived: values.keepFolderChats,
      } });
      return result["@type"] === "ok" ? "saved" as const : "unavailable" as const;
    },
    readDatePrivacy,
    async saveReadDatePrivacy(show: boolean, expected: boolean) {
      const current = await readDatePrivacy();
      if (current !== expected) return "changed";
      if (current === show) return "saved";
      const result = await request({ "@type": "setReadDatePrivacySettings",
        settings: { "@type": "readDatePrivacySettings", show_read_date: show } });
      return result["@type"] === "ok" ? "saved" : "unsupported";
    },
    activeDevices,
    async terminateDevice(id: string, application: string, device: string) {
      const match = (await activeDevices()).find((entry) => entry.id === id);
      if (!match || match.current || match.application !== application || match.device !== device) return false;
      const result = await request({ "@type": "terminateSession", session_id: id });
      return result["@type"] === "ok";
    },
    async cacheBytes(): Promise<number> {
      requireReady();
      const stats = await request({ "@type": "getStorageStatistics", chat_limit: 0 }, 60_000);
      if (stats["@type"] !== "storageStatistics" || typeof stats.size !== "number"
        || !Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error("Telegram cache size is unavailable.");
      return stats.size;
    },
    async optimizeCache(limitBytes: number): Promise<void> {
      requireReady();
      if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error("Invalid Telegram cache limit.");
      // The default type selection skips previews, avatars and stickers.
      const file_types = ["Animation", "Audio", "Document", "Photo", "ProfilePhoto",
        "Sticker", "Thumbnail", "Video", "VideoNote", "VoiceNote", "Wallpaper"]
        .map((type) => ({ "@type": `fileType${type}` }));
      const result = await request({
        "@type": "optimizeStorage", size: limitBytes, count: 2147483647, ttl: 2147483647,
        immunity_delay: limitBytes === 0 ? 0 : 60, file_types, chat_ids: [], exclude_chat_ids: [],
        return_deleted_file_statistics: false, chat_limit: 0,
      }, 60_000);
      if (result["@type"] !== "storageStatistics") throw new Error("Telegram did not confirm cache cleanup.");
    },
    async runtimeInfo(): Promise<RuntimeInfo> {
      requireReady();
      const [version, user] = await Promise.all([
        request({ "@type": "getOption", name: "version" }),
        request({ "@type": "getMe" }).catch(() => undefined),
      ]);
      if (version["@type"] !== "optionValueString" || typeof version.value !== "string") {
        throw new Error("TDLib version is unavailable.");
      }
      const premium = user?.is_premium;
      return { tdlibVersion: version.value, ...(typeof premium === "boolean" ? { premium } : {}) };
    },
    async attachmentReplyAvailable(chatId: string, replyTo: string, topicId?: number): Promise<boolean> {
      requireReady();
      return !!await manualReplyParent(Number(chatId), Number(replyTo), topicId);
    },
    async checkDocumentUpload(size: number): Promise<UploadRejection | undefined> {
      requireReady();
      if (size > maxTelegramUploadBytes) return "file_too_large";
      if (size <= maxStandardTelegramUploadBytes) return;
      const version = await request({ "@type": "getOption", name: "version" });
      if (version.value === "1.8.0") return "legacy_tdlib";
      const user = await request({ "@type": "getMe" });
      if (user.is_premium !== true) return "premium_required";
    },
    async sendDocumentStream(chatId: string, name: string, caption: string, size: number, body: ReadableStream<Uint8Array>, active: () => boolean, topic?: ForumTopicTarget, replyTo?: string, video?: true, mediaOptions?: MediaSendOptions) {
      if (!Number.isSafeInteger(size) || size <= 0 || size > maxTelegramUploadBytes || !active()
        || !(await postingPermissions(chatId))[video ? "video" : "document"] || (video && !/\.mp4$/i.test(name))) {
        return { state: "failed" } as const;
      }
      return sendAttachment(chatId, caption, { size, body }, documentName(name), video ? "video" : "document", async (path) => {
        if (!video) return {
          "@type": "inputMessageDocument", document: { "@type": "inputFileLocal", path },
          disable_content_type_detection: true,
        };
        const prepared = await prepareVideoAttachment(path);
        if (prepared) return {
          ...prepared,
          ...(mediaOptions?.spoiler ? { has_spoiler: true } : {}),
          ...(mediaOptions?.captionAbove && caption.trim() ? { show_caption_above_media: true } : {}),
        };
      }, active, topic, replyTo);
    },
    async sendDocument(chatId: string, name: string, caption: string, base64: string): Promise<SendResult> {
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > maxDocumentUploadBytes || bytes.toString("base64") !== base64) return { state: "failed" };
      return sendAttachment(chatId, caption, bytes, documentName(name), "document", (path) => ({
        "@type": "inputMessageDocument", document: { "@type": "inputFileLocal", path },
        disable_content_type_detection: true,
      }));
    },
    savedNotificationSounds,
    async previewNotificationSound(id: string) {
      requireReady();
      if (id === "-1" || id === "0" || readNotificationSoundId(id) !== id) throw new Error("Saved sound is unavailable.");
      const sound = await request({ "@type": "getSavedNotificationSound", notification_sound_id: id });
      const file = object(sound.sound);
      const fileId = file?.id;
      if (sound["@type"] !== "notificationSound" || readNotificationSoundId(sound.id) !== id
        || file?.["@type"] !== "file" || typeof fileId !== "number" || !Number.isInteger(fileId) || fileId <= 0
        || Math.max(Number(file.size) || 0, Number(file.expected_size) || 0) > maxNotificationSoundBytes) {
        throw new Error("Saved sound is unavailable.");
      }
      const downloaded = await request({ "@type": "downloadFile", file_id: fileId, priority: 16,
        limit: maxNotificationSoundBytes + 1, synchronous: true }, 30_000);
      const local = object(downloaded.local);
      if (downloaded["@type"] !== "file" || downloaded.id !== fileId
        || local?.is_downloading_completed !== true || typeof local.path !== "string") throw new Error("Sound download is incomplete.");
      const bytes = await readTelegramFile(options.directory, local.path, 4, maxNotificationSoundBytes);
      const mime = isMp3(bytes) ? "audio/mpeg" : bytes.toString("ascii", 0, 4) === "OggS" ? "audio/ogg" : undefined;
      if (!mime) throw new Error("Unsupported notification sound format.");
      return { mime, base64: bytes.toString("base64") } as const;
    },
    async addNotificationSound(base64: string) {
      requireReady();
      if (base64.length > Math.ceil(maxNotificationSoundBytes / 3) * 4) return "unavailable" as const;
      const bytes = Buffer.from(base64, "base64");
      if (!isMp3(bytes) || bytes.length > maxNotificationSoundBytes || bytes.toString("base64") !== base64) return "unavailable" as const;
      const staged = await stageAttachment(options.directory, bytes, "notification.mp3", "document");
      let finished = false;
      try {
        const result = await request({ "@type": "addSavedNotificationSound",
          sound: { "@type": "inputFileLocal", path: staged.path } }, 60_000);
        finished = true;
        return result["@type"] === "notificationSound" ? "saved" as const : "unknown" as const;
      } catch (error) {
        finished = error instanceof TdError && error.code >= 400 && error.code < 500;
        return finished ? "unavailable" as const : "unknown" as const;
      } finally {
        if (finished) await staged.dispose().catch(() => {});
      }
    },
    async removeNotificationSound(id: string) {
      try {
        if (!(await savedNotificationSounds()).some((entry) => entry.id === id)) return "unavailable" as const;
        const result = await request({ "@type": "removeSavedNotificationSound", notification_sound_id: id });
        return result["@type"] === "ok" ? "saved" as const : "unknown" as const;
      } catch (error) {
        return error instanceof TdError && error.code >= 400 && error.code < 500 ? "unavailable" as const : "unknown" as const;
      }
    },
    async reactionNotifications(): Promise<ReactionNotificationOptions | null> {
      const current = readReactionNotifications();
      if (current?.sound === undefined) return current;
      return { ...current, savedSounds: await savedNotificationSounds().catch(() => []) };
    },
    async saveReactionNotifications(values: ReactionNotifications, expected: ReactionNotifications) {
      const soundChanged = values.sound !== expected.sound;
      if (soundChanged && (values.sound === undefined || expected.sound === undefined
        || !(await canSelectNotificationSound(values.sound)))) return "unavailable" as const;
      const current = readReactionNotifications();
      const settings = reactionNotificationSettings;
      if (!current || !settings || (values.votes === undefined) !== (current.votes === undefined)) return "unavailable" as const;
      if (current.messages !== expected.messages || current.stories !== expected.stories || current.votes !== expected.votes
        || current.preview !== expected.preview
        || (expected.sound !== undefined && current.sound !== expected.sound)) return "changed" as const;
      const source = (key: ReactionNotificationAudience) => ({ "@type": reactionNotificationTypes[key] });
      const result = await request({ "@type": "setReactionNotificationSettings", notification_settings: {
        ...settings, message_reaction_source: source(values.messages), story_reaction_source: source(values.stories),
        ...(values.votes ? { poll_vote_source: source(values.votes) } : {}), show_preview: values.preview,
        ...(soundChanged ? { sound_id: values.sound } : {}),
      } });
      return result["@type"] === "ok" ? "saved" as const : "unavailable" as const;
    },
    async scopeNotifications(scope: NotificationScope): Promise<ScopeNotificationOptions> {
      const { values, settings } = await scopeNotificationSource(scope);
      const sound = readNotificationSoundId(settings.sound_id);
      const stories = scope === "private" ? readStoryNotificationDefaults(settings) : undefined;
      const savedSounds = sound !== undefined || stories?.sound !== undefined ? await savedNotificationSounds().catch(() => []) : undefined;
      return { ...values, ...(sound === undefined ? {} : { sound }), ...(stories ? { stories } : {}),
        ...(savedSounds ? { savedSounds } : {}) };
    },
    async saveScopeNotifications(kind: NotificationScope, values: ScopeNotifications, expected: ScopeNotifications) {
      const soundChanged = values.sound !== expected.sound;
      const stories = values.stories;
      const previousStories = expected.stories;
      if ((stories === undefined) !== (previousStories === undefined) || (stories && kind !== "private")) return "unavailable" as const;
      const storySoundChanged = stories?.sound !== previousStories?.sound;
      if (soundChanged && (values.sound === undefined || expected.sound === undefined
        || !(await canSelectNotificationSound(values.sound)))) return "unavailable" as const;
      if (storySoundChanged && (stories?.sound === undefined || previousStories?.sound === undefined
        || !(await canSelectNotificationSound(stories.sound)))) return "unavailable" as const;
      const current = await scopeNotificationSource(kind);
      if (previousStories) {
        const currentStories = readStoryNotificationDefaults(current.settings);
        if (currentStories?.audience !== previousStories.audience || currentStories.showAuthor !== previousStories.showAuthor
          || (previousStories.sound !== undefined && currentStories.sound !== previousStories.sound)) return "changed" as const;
      }
      const audienceChanged = stories?.audience !== previousStories?.audience;
      const authorChanged = stories?.showAuthor !== previousStories?.showAuthor;
      const keys = Object.keys(current.values) as (keyof ScopeNotifications)[];
      if (keys.some((key) => current.values[key] !== expected[key])
        || (expected.sound !== undefined && readNotificationSoundId(current.settings.sound_id) !== expected.sound)) return "changed" as const;
      if (!soundChanged && !storySoundChanged && !audienceChanged && !authorChanged && keys.every((key) => values[key] === expected[key])) return "saved" as const;
      const result = await request({ "@type": "setScopeNotificationSettings", scope: current.scope, notification_settings: {
        ...current.settings, mute_for: values.muted === current.values.muted ? current.settings.mute_for
          : values.muted ? 367 * 86400 : 0,
        show_preview: values.preview, disable_pinned_message_notifications: !values.pinned,
        disable_mention_notifications: !values.mentions,
        ...(soundChanged ? { sound_id: values.sound } : {}),
        ...(audienceChanged && stories ? { use_default_mute_stories: stories.audience === "frequent",
          mute_stories: stories.audience === "none" } : {}),
        ...(authorChanged ? { show_story_poster: stories?.showAuthor } : {}),
        ...(storySoundChanged ? { story_sound_id: stories?.sound } : {}),
      } });
      return result["@type"] === "ok" ? "saved" as const : "unavailable" as const;
    },
    async chatNotificationState(chatId: string, topicId?: number): Promise<ChatNotificationState | null> {
      const current = await chatNotifications(chatId, topicId);
      if (!current) return null;
      const seconds = current.settings.mute_for;
      const sound = readChatNotificationSound(current.settings);
      const storySound = topicId === undefined ? readChatNotificationSound(current.settings, storyNotificationSoundFields) : undefined;
      const savedSounds = sound !== undefined || storySound !== undefined ? await savedNotificationSounds().catch(() => []) : undefined;
      return { ...(sound === undefined ? {} : { sound }), ...(storySound === undefined ? {} : { storySound }),
        ...(savedSounds ? { savedSounds } : {}), mode: current.mode, ...current.overrides, ...(current.mode === "muted" && typeof seconds === "number"
        && Number.isInteger(seconds) && seconds > 0 && seconds < 366 * 86400
        ? { muteUntil: Math.floor(Date.now() / 1000) + seconds } : {}) };
    },
    async setChatNotificationSound(chatId: string, value: string, expected: string, topicId?: number, story = false) {
      try {
        if ((story && topicId !== undefined) || !notificationSound.safeParse(value).success) return "refused" as const;
        const fields = story ? storyNotificationSoundFields : chatNotificationSoundFields;
        if (value !== expected && value !== "inherit" && !(await canSelectNotificationSound(value))) return "refused" as const;
        const current = await chatNotifications(chatId, topicId);
        if (!current || readChatNotificationSound(current.settings, fields) !== expected) return "refused" as const;
        if (value === expected) return "updated" as const;
        const result = await writeChatNotificationSettings(current.chat_id, topicId, {
          ...current.settings, [fields.inherit]: value === "inherit",
          [fields.id]: value === "inherit" ? current.settings[fields.id] : value,
        });
        const confirmed = result["@type"] === "ok" && await chatNotifications(chatId, topicId);
        if (!confirmed || readChatNotificationSound(confirmed.settings, fields) !== value) return "unknown" as const;
        notifyChatChanged();
        return "updated" as const;
      } catch (error) { return error instanceof TdError ? "refused" as const : "unknown" as const; }
    },
    async setChatNotificationMode(chatId: string, mode: ChatNotificationMode, muteFor?: ChatMutePeriod, topicId?: number): Promise<"updated" | "refused" | "unknown"> {
      try {
        if (muteFor !== undefined && (mode !== "muted" || !chatMutePeriods.includes(muteFor))) return "refused";
        const current = await chatNotifications(chatId, topicId);
        if (!current || state.state !== "ready") return "refused";
        const { chat_id, settings } = current;
        const sentAt = Date.now();
        const result = await writeChatNotificationSettings(chat_id, topicId, {
          ...settings, use_default_mute_for: mode === "default",
          mute_for: mode === "muted" ? muteFor ?? 367 * 24 * 60 * 60 : 0,
        });
        if (result["@type"] !== "ok") return "unknown";
        const confirmed = await chatNotifications(chatId, topicId);
        if (confirmed?.mode !== mode) return "unknown";
        if (muteFor !== undefined) {
          const remaining = Number(confirmed.settings.mute_for);
          const elapsed = Math.max(0, Math.ceil((Date.now() - sentAt) / 1000));
          if (remaining > muteFor + 2 || remaining < muteFor - elapsed - 2) return "unknown";
        }
        notifyChatChanged();
        return "updated";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    async setChatNotificationOverride(chatId: string, field: ChatNotificationField, value: ChatNotificationOverride, expected: ChatNotificationOverride, topicId?: number) {
      try {
        const current = await chatNotifications(chatId, topicId);
        if (!current || current.overrides[field] !== expected) return "refused" as const;
        if (value === expected) return "updated" as const;
        const { inherit, setting, enabled } = notificationOverrideFields[field];
        const result = await writeChatNotificationSettings(current.chat_id, topicId, {
          ...current.settings, [inherit]: value === "default",
          [setting]: value === "default" ? current.settings[setting] : value === "show" ? enabled : !enabled,
        });
        if (result["@type"] !== "ok" || (await chatNotifications(chatId, topicId))?.overrides[field] !== value) return "unknown" as const;
        notifyChatChanged();
        return "updated" as const;
      } catch (error) { return error instanceof TdError ? "refused" as const : "unknown" as const; }
    },
    chatPinStatus,
    async setChatPinned(chatId: string, list: ChatList, pinned: boolean): Promise<"updated" | "refused" | "unknown"> {
      if (list === "saved") return "refused";
      try {
        const previous = await chatPinStatus(chatId, list);
        if (previous === null) return "refused";
        if (previous === pinned) return "updated";
        const result = await request({ "@type": "toggleChatIsPinned", chat_list: tdChatList(list), chat_id: Number(chatId), is_pinned: pinned });
        if (result["@type"] !== "ok" || await chatPinStatus(chatId, list) !== pinned) return "unknown";
        notifyChatChanged();
        return "updated";
      } catch (error) {
        return error instanceof TdError ? "refused" : "unknown";
      }
    },
    async archiveChat(chatId: string, archived: boolean): Promise<Chat> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid chat.");
      const current = await request({ "@type": "getChat", chat_id });
      const view = current.id === chat_id ? chatView(current) : undefined;
      if (!view || view.archived === undefined) throw new Error("This chat is not in Main or Archive.");
      if (view.archived === archived) return view;
      const kind = archived ? "chatListArchive" : "chatListMain";
      const choices = await request({ "@type": "getChatListsToAddChat", chat_id });
      if (!array(choices.chat_lists).some((item) => object(item)?.["@type"] === kind)) {
        throw new Error("Telegram does not allow moving this chat there.");
      }
      await request({ "@type": "addChatToList", chat_id, chat_list: { "@type": kind } });
      const updated = chatView(await request({ "@type": "getChat", chat_id }));
      if (updated?.id !== chatId || updated.archived !== archived) throw new Error("Chat move is not confirmed.");
      return updated;
    },
    async markActivityRead(chatId: string, filter: UnreadActivityFilter, topicId?: number): Promise<boolean> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id
        || (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647))) return false;
      if (!searchRequiresEmptyQuery(filter)) return false;
      const mentions = filter === "unreadMentions";
      const result = await request(topicId === undefined
        ? { "@type": mentions ? "readAllChatMentions" : "readAllChatReactions", chat_id }
        : { "@type": mentions ? "readAllForumTopicMentions" : "readAllForumTopicReactions", chat_id, forum_topic_id: topicId });
      if (result["@type"] !== "ok") return false;
      notifyChatChanged();
      return true;
    },
    async markChat(chatId: string, unread: boolean): Promise<Chat> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid chat.");
      const chat = await request({ "@type": "getChat", chat_id });
      if (chat.id !== chat_id || object(chat.type)?.["@type"] === "chatTypeSecret") throw new Error("Chat is unavailable.");
      const last = object(chat.last_message);
      if (!unread && typeof chat.unread_count === "number" && chat.unread_count > 0) {
        if (!last || last.chat_id !== chat_id || typeof last.id !== "number" || !Number.isSafeInteger(last.id) || last.id <= 0) {
          throw new Error("Cannot identify the most recent Telegram message.");
        }
        await request({ "@type": "viewMessages", chat_id, message_ids: [last.id], force_read: true });
      }
      if ((chat.is_marked_as_unread === true) !== unread) {
        await request({ "@type": "toggleChatIsMarkedAsUnread", chat_id, is_marked_as_unread: unread });
      }
      const updated = chatView(await request({ "@type": "getChat", chat_id }));
      if (updated?.id !== chatId) throw new Error("Could not verify the updated chat.");
      return updated;
    },
    async openOneView(chatId: string, messageId: string, signal: AbortSignal) {
      requireReady();
      const archive = options.privateHistory;
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!archive || !Number.isSafeInteger(chat_id) || chat_id <= 0 || !Number.isSafeInteger(message_id) || message_id <= 0) {
        throw new Error("Invalid one-view media reference.");
      }
      const key = `${chatId}:${messageId}`;
      if (signal.aborted || openingOneView.has(key)) throw new Error("One-view media is unavailable.");
      openingOneView.add(key);
      try {
        const [account, chat] = await Promise.all([archiveAccount(), request({ "@type": "getChat", chat_id })]);
        if (account === chatId || chat.id !== chat_id || object(chat.type)?.["@type"] !== "chatTypePrivate"
          || !allowsSharing(chat)) throw new Error("One-view media is unavailable.");
        requireReady();
        const localCopy = archive.media(account, chatId, messageId);
        if (localCopy) return localCopy;

        const raw = await request({ "@type": "getMessage", chat_id, message_id });
        const reference = raw.chat_id === chat_id && raw.id === message_id ? oneViewFile(raw) : undefined;
        const copy = reference && snapshot(raw, chatTitle(chat));
        if (!reference || !copy || signal.aborted) throw new Error("One-view media is unavailable.");
        const file = await request({ "@type": "downloadFile", file_id: reference.id,
          priority: 16, limit: maxPlaybackBytes + 1, synchronous: true }, 60_000, signal);
        const local = object(file.local);
        if (file.id !== reference.id || local?.is_downloading_completed !== true || typeof local.path !== "string") {
          throw new Error("One-view download is incomplete.");
        }
        const bytes = await readTelegramFile(options.directory, local.path, 12, maxPlaybackBytes);
        const mime = reference.mime ?? telegramPhotoMime(bytes);
        if (!mime) throw new Error("Unsupported one-view media format.");
        const current = await request({ "@type": "getMessage", chat_id, message_id });
        if (current.chat_id !== chat_id || current.id !== message_id || oneViewFile(current)?.id !== reference.id) {
          throw new Error("One-view media changed during download.");
        }

        await queueRetention(async () => {
          requireReady();
          if (signal.aborted) throw new Error("One-view media request was cancelled.");
          archive.stageMedia(account, chatId, { ...copy, oneView: reference.kind }, mime, bytes);
          try {
            const result = await request({ "@type": "openMessageContent", chat_id, message_id });
            if (result["@type"] !== "ok") throw new Error("Telegram did not confirm the media view.");
          } catch (error) {
            archive.discardMedia(account, chatId, messageId);
            throw error;
          }
          const retained = archive.mark(account, chatId, messageId, "expired");
          if (retained && state.state === "ready") notifyMessagesDeleted({ id: chatId, messageIds: [], retained: [retained] });
        });
        return { bytes, mime };
      } finally {
        openingOneView.delete(key);
      }
    },
    async transcribeVoice(chatId: string, messageId: string) {
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id < 1
        || !await canExportChatContent(chat_id)) throw new Error("Voice note is unavailable.");
      const raw = await request({ "@type": "getMessage", chat_id, message_id });
      if (raw.id !== message_id) throw new Error("Voice note is unavailable.");
      return transcribeSpeechNote(chat_id, raw);
    },
    async videoReference(chatId: string, messageId: string) {
      const file = await documentReference(chatId, messageId, "stream");
      if (!file.size || !file.playbackMime?.startsWith("video/")) throw new Error("Video streaming is unavailable.");
      return { id: file.id, size: file.size, mime: file.playbackMime };
    },
    async videoPart(fileId: number, offset: number, count: number, signal: AbortSignal) {
      const previous = videoParts.get(fileId);
      let finish!: () => void;
      const current = new Promise<void>((resolve) => { finish = resolve; });
      videoParts.set(fileId, current);
      let reserved = false;
      try {
        await previous;
        requireReady();
        if (signal.aborted || downloadingDocuments.has(fileId)) throw new Error("Video request is unavailable.");
        downloadingDocuments.add(fileId);
        reserved = true;
        const read = () => request({ "@type": "readFilePart", file_id: fileId, offset, count }, 15_000, signal);
        const data = await read().catch(async () => {
          if (signal.aborted) throw new Error("Video request cancelled.");
          await request({ "@type": "downloadFile", file_id: fileId, priority: 24, offset, limit: count, synchronous: true }, 45_000, signal);
          return read();
        });
        const bytes = data["@type"] === "data" && typeof data.data === "string" ? Buffer.from(data.data, "base64") : undefined;
        if (bytes?.length !== count) throw new Error("Incomplete video range.");
        return new Uint8Array(bytes);
      } finally {
        if (reserved) downloadingDocuments.delete(fileId);
        finish();
        if (videoParts.get(fileId) === current) videoParts.delete(fileId);
      }
    },
    async documentName(chatId: string, messageId: string, playback = false) {
      return (await documentReference(chatId, messageId, playback)).name;
    },
    async document(chatId: string, messageId: string, signal?: AbortSignal, playback = false) {
      const document = await documentReference(chatId, messageId, playback);
      if (signal?.aborted || downloadingDocuments.has(document.id)) throw new Error("Document download is unavailable.");
      downloadingDocuments.add(document.id);
      let file: TdObject;
      try {
        file = await request({ "@type": "downloadFile", file_id: document.id,
          priority: 16, limit: playback || document.photo ? maxPlaybackBytes + 1 : 0, synchronous: true }, 2 * 60 * 60_000, signal);
      } catch (error) {
        if (signal?.aborted && state.state === "ready") {
          await request({ "@type": "cancelDownloadFile", file_id: document.id, only_if_pending: false }).catch(() => {});
        }
        throw error;
      } finally {
        downloadingDocuments.delete(document.id);
      }
      const local = object(file.local);
      if (file.id !== document.id || local?.is_downloading_completed !== true || typeof local.path !== "string" || signal?.aborted) {
        throw new Error("Document download is unavailable.");
      }
      const current = await documentReference(chatId, messageId, playback);
      if (current.id !== document.id || current.name !== document.name || current.photo !== document.photo || (playback && current.playbackMime !== document.playbackMime) || signal?.aborted) {
        throw new Error("The document changed or the download was cancelled.");
      }
      const download = await streamTelegramFile(options.directory, local.path, playback || document.photo ? maxPlaybackBytes : maxDocumentBytes);
      return { name: document.name, ...download };
    },
    async avatar(chatId: string, fileId: number, user = false): Promise<TelegramPhoto> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(fileId) || fileId <= 0) {
        throw new Error("Invalid avatar reference.");
      }
      const profile = await request(user ? { "@type": "getUser", user_id: chat_id } : { "@type": "getChat", chat_id });
      if (profile.id !== chat_id || object(object(user ? profile.profile_photo : profile.photo)?.small)?.id !== fileId) {
        throw new Error("Avatar changed.");
      }
      const file = await request({ "@type": "downloadFile", file_id: fileId, priority: 8, limit: maxPhotoBytes + 1, synchronous: true });
      const local = object(file.local);
      if (file.id !== fileId || local?.is_downloading_completed !== true || typeof local.path !== "string") {
        throw new Error("Avatar download is incomplete.");
      }
      return readTelegramPhoto(options.directory, local.path);
    },
    async photo(chatId: string, messageId: string, size: PhotoSize = "preview"): Promise<TelegramPhoto> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) {
        throw new Error("Invalid photo reference.");
      }
      const raw = await request({ "@type": "getMessage", chat_id, message_id });
      const files = raw.chat_id === chat_id && raw.id === message_id ? photoFiles(raw) : undefined;
      const content = object(raw.content);
      let file_id = files?.[size];
      if (file_id === undefined && raw.chat_id === chat_id && raw.id === message_id
        && content?.["@type"] === "messageSticker" && mayShareHistoryMessage(raw) && await canExportChatContent(chat_id)) {
        const sticker = object(content.sticker);
        const preview = object(object(sticker?.thumbnail)?.file)?.id;
        const original = object(sticker?.sticker)?.id;
        const candidate = size === "large" && object(sticker?.format)?.["@type"] === "stickerFormatWebp" ? original : preview;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) file_id = candidate;
      }
      if (file_id === undefined) throw new Error("No eligible photo.");
      const file = await request({ "@type": "downloadFile", file_id, priority: 16, limit: maxPhotoBytes + 1, synchronous: true });
      const local = object(file.local);
      if (file.id !== file_id || local?.is_downloading_completed !== true || typeof local.path !== "string") {
        throw new Error("Photo download is incomplete.");
      }
      const photo = await readTelegramPhoto(options.directory, local.path);
      return size === "preview" && files && files.large !== file_id ? { ...photo, hasLarger: true } : photo;
    },
    async pinnedMessage(chatId: string): Promise<Message | null> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id) throw new Error("Invalid chat.");
      try {
        const raw = await request({ "@type": "getChatPinnedMessage", chat_id });
        if (raw.chat_id !== chat_id) throw new Error("Pinned message belongs to a different chat.");
        return message(raw, raw.is_outgoing ? "You" : "") ?? null;
      } catch (error) {
        if (error instanceof TdError && error.code === 404) return null;
        throw error;
      }
    },
    async sendChannelComment(chatId: string, postId: string, group: string, root: string, text: string): Promise<SendResult> {
      if (!text.trim() || text.length > 4096) return { state: "failed" };
      let target: Awaited<ReturnType<typeof resolveChannelPost>>;
      try {
        target = await resolveChannelPost(Number(chatId), Number(postId));
        if (String(target.groupId) !== group || String(target.threadId) !== root) return { state: "failed" };
        const current = await request({ "@type": "getChat", chat_id: target.groupId });
        if (current.id !== target.groupId || object(current.type)?.["@type"] !== "chatTypeSupergroup"
          || object(current.type)?.is_channel === true) return { state: "failed" };
      } catch { return { state: "failed" }; }
      try {
        return await sendContent(target.groupId, {
          "@type": "inputMessageText", text: { "@type": "formattedText", text, entities: [] },
        }, undefined, undefined, undefined, false, undefined, { thread: target.threadId });
      } catch (error) { return { state: error instanceof TdError ? "failed" : "unknown" }; }
    },
    async channelDiscussion(chatId: string, messageId: string, before?: string): Promise<DiscussionPage> {
      requireReady();
      const chat_id = Number(chatId);
      const message_id = Number(messageId);
      const from_message_id = before === undefined ? 0 : Number(before);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0
        || !Number.isSafeInteger(from_message_id) || from_message_id < 0) throw new Error("Invalid channel post reference.");
      const { groupId, threadId } = await resolveChannelPost(chat_id, message_id);
      const [group, history] = await Promise.all([
        request({ "@type": "getChat", chat_id: groupId }),
        request({ "@type": "getMessageThreadHistory", chat_id, message_id, from_message_id, offset: 0, limit: 40 }),
      ]);
      const view = group.id === groupId && object(group.type)?.["@type"] === "chatTypeSupergroup"
        && object(group.type)?.is_channel !== true ? chatView(group) : undefined;
      if (!view || history["@type"] !== "messages") throw new Error("Telegram discussion is unavailable.");
      const rows = new Map<number, TdObject>();
      for (const value of array(history.messages).slice(0, 40)) {
        const row = object(value);
        const id = row?.id;
        if (row?.chat_id === groupId && typeof id === "number" && Number.isSafeInteger(id)
          && id >= threadId && (!from_message_id || id < from_message_id)) rows.set(id, row);
      }
      const ordered = [...rows.entries()].sort(([a], [b]) => a - b);
      const oldest = ordered[0]?.[0];
      const messages = await withAuthors(ordered.filter(([id]) => id !== threadId).map(([, row]) => row), groupId, view.name);
      if (!allowsSharing(group)) for (const message of messages) {
        if (message.document) message.document.downloadable = false;
        delete message.hasPhoto;
        delete message.voiceNote;
      }
      return { chat: { ...view, messages: [] }, root: String(threadId), messages,
        before: oldest !== undefined && oldest > threadId ? String(oldest) : null };
    },
    async messageAtDate(chatId: string, date: number, topicId?: number): Promise<string | null> {
      requireReady();
      const chat_id = Number(chatId);
      if (!Number.isSafeInteger(chat_id) || !chat_id || !Number.isInteger(date) || date < 1 || date > 2147483647) {
        throw new Error("Invalid chat date.");
      }
      if (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647)) {
        throw new Error("Invalid forum topic.");
      }
      const raw = await messageAtDate(chat_id, date);
      if (!raw) return null;
      if (typeof raw.date !== "number" || !Number.isInteger(raw.date) || raw.date < 1 || raw.date > date) {
        throw new Error("Unexpected Telegram message date.");
      }
      if (topicId === undefined || forumTopicId(raw) === topicId) return String(raw.id);
      const { from_message_id, rows } = await contextRows(chatId, String(raw.id), topicId, 0, 20);
      const candidates = [...rows].filter(([id, item]) => id <= from_message_id && typeof item.date === "number"
        && Number.isInteger(item.date) && item.date >= 1 && item.date <= date);
      return candidates.length ? String(Math.max(...candidates.map(([id]) => id))) : null;
    },
    async messageContext(chatId: string, messageId: string, topicId?: number): Promise<Message[]> {
      const { chat_id, from_message_id, rows } = await contextRows(chatId, messageId, topicId, -6, 13);
      if (!rows.has(from_message_id)) return [];
      return withAuthors([...rows.values()].sort((a, b) => Number(a.id) - Number(b.id)), chat_id, "");
    },
    async messageContextPage(chatId: string, messageId: string, direction: ContextDirection, topicId?: number): Promise<Message[]> {
      const { chat_id, from_message_id, rows } = await contextRows(chatId, messageId, topicId, direction === "newer" ? -20 : 0, 21);
      const entries = [...rows].filter(([id]) => direction === "older" ? id < from_message_id : id > from_message_id)
        .sort(([a], [b]) => a - b);
      const closest = direction === "older" ? entries.slice(-20) : entries.slice(0, 20);
      return withAuthors(closest.map(([, raw]) => raw), chat_id, "");
    },
    async globalSearch(query: string, mode: GlobalSearchMode, cursor?: NonNullable<GlobalSearchPage["next"]>): Promise<GlobalSearchPage> {
      requireReady();
      if (query.trim().length < 2 || query.length > 128 || (mode === "public" && typeof cursor === "object")) {
        throw new Error("Invalid Telegram search.");
      }
      const legacy = typeof cursor === "object" ? cursor : undefined;
      const offset = typeof cursor === "string" ? cursor : "";
      const byTag = mode === "public" && /^[#$][\p{L}\p{N}_]+$/u.test(query);
      const result = await request(mode === "public"
        ? byTag ? { "@type": "searchPublicMessagesByTag", tag: query, offset, limit: 30 }
          : { "@type": "searchPublicPosts", query, offset, limit: 30, star_count: 0 }
        : { "@type": "searchMessages", query, offset, limit: 30,
          offset_date: legacy?.date ?? 0, offset_chat_id: Number(legacy?.chatId ?? 0), offset_message_id: Number(legacy?.messageId ?? 0) });
      const type = result["@type"];
      if (mode === "public" && result.are_limits_exceeded === true) throw new Error("Free public post search limit reached.");
      if (mode === "public" ? type !== (byTag ? "foundMessages" : "foundPublicPosts") : type !== "foundMessages" && type !== "messages") {
        throw new Error("Unexpected Telegram search result.");
      }
      const rows = array(result.messages).slice(0, 30).map(object).filter((raw): raw is TdObject =>
        raw?.["@type"] === "message" && Number.isSafeInteger(raw.chat_id) && Number(raw.chat_id) !== 0
        && Number.isSafeInteger(raw.id) && Number(raw.id) > 0);
      const last = rows.at(-1);
      const next = typeof result.next_offset === "string" && result.next_offset.length > 0
        && result.next_offset.length <= 2048 && result.next_offset !== offset ? result.next_offset
        : type === "messages" && last && Number.isSafeInteger(last.date) && Number(last.date) >= 0
          && (legacy?.messageId !== String(last.id) || legacy.chatId !== String(last.chat_id))
        ? { date: Number(last.date), chatId: String(last.chat_id), messageId: String(last.id) } : null;
      const chats = new Map<number, Promise<TdObject | undefined>>();
      const seen = new Set<string>();
      const hits = await Promise.all(rows.map(async (raw) => {
        const id = Number(raw.chat_id);
        const key = `${id}:${raw.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        let chat = chats.get(id);
        if (!chat) {
          chat = request({ "@type": "getChat", chat_id: id }).then((value) => value.id === id ? value : undefined).catch(() => undefined);
          chats.set(id, chat);
        }
        const source = await chat;
        if (!source || object(source.type)?.["@type"] === "chatTypeSecret") return;
        const view = chatView(source);
        const hit = message(raw, chatTitle(source));
        if (!view || !hit) return;
        if (!mayShareHistoryMessage(raw) || !allowsSharing(source)) {
          return { chat: { ...view, messages: [] }, message: {
            id: hit.id, author: hit.author, text: "Protected message", time: hit.time,
            ...(hit.forumTopicId === undefined ? {} : { forumTopicId: hit.forumTopicId }),
          } };
        }
        return { chat: { ...view, messages: [] }, message: hit };
      }));
      return { hits: hits.filter((hit) => hit !== undefined), next };
    },
    async searchMessages(chatId: string, query: string, filter?: MessageSearchFilter, topicId?: number, before?: string, sender?: MessageSender): Promise<MessageSearchPage> {
      requireReady();
      const id = Number(chatId);
      if (!Number.isSafeInteger(id) || !id) throw new Error("Invalid chat.");
      if (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647)) {
        throw new Error("Invalid forum topic.");
      }
      const from_message_id = before === undefined ? 0 : Number(before);
      if (before !== undefined && (!Number.isSafeInteger(from_message_id) || from_message_id <= 0)) throw new Error("Invalid search cursor.");
      if (searchRequiresEmptyQuery(filter) && (query || sender)) throw new Error("This unread activity filter only supports a chat or topic.");
      const media = filter === undefined ? undefined : messageSearchFilters[filter];
      const senderId = Number(sender?.id);
      if (sender && (!Number.isSafeInteger(senderId) || (sender.kind === "user" ? senderId <= 0 : senderId >= 0))) {
        throw new Error("Invalid Telegram message sender.");
      }
      const result = await request({
        "@type": "searchChatMessages", chat_id: id, query, from_message_id, offset: 0, limit: 40,
        ...(topicId === undefined ? {} : { topic_id: { "@type": "messageTopicForum", forum_topic_id: topicId } }),
        ...(media ? { filter: { "@type": media.tdType } } : {}),
        ...(sender ? { sender_id: sender.kind === "user" ? { "@type": "messageSenderUser", user_id: senderId }
          : { "@type": "messageSenderChat", chat_id: senderId } } : {}),
      });
      const modern = result["@type"] === "foundChatMessages";
      const rows = array(result.messages).slice(0, 40).map(object).filter((item): item is TdObject => item?.chat_id === id
        && typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0
        && (modern || from_message_id === 0 || item.id < from_message_id)
        && (topicId === undefined || forumTopicId(item) === topicId));
      const next = modern ? result.next_from_message_id : rows.at(-1)?.id;
      const cursor = typeof next === "number" && Number.isSafeInteger(next) && next > 0
        && (from_message_id === 0 || next < from_message_id) ? String(next) : null;
      const types = media?.contentTypes;
      const items = rows.filter((item) => {
        if (filter === "pinned" && item.is_pinned !== true || types && !types.includes(object(item.content)?.["@type"] ?? "")) return false;
        if (filter === "unreadMentions" && item.contains_unread_mention !== true) return false;
        if (filter === "unreadReactions" && !array(item.unread_reactions).length) return false;
        if (!sender) return true;
        const actual = messageSenderView(item.sender_id);
        return actual?.kind === sender.kind && actual.id === sender.id;
      });
      return { messages: await withAuthors(items, id, ""), before: cursor };
    },
    async historyInDateRange(chatId: string, range: Required<NoteDateRange>, before?: string, signal?: AbortSignal, topicId?: number) {
      requireReady();
      const chat_id = Number(chatId);
      const cursor = before === undefined ? undefined : Number(before);
      if (!Number.isSafeInteger(chat_id) || !chat_id || (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor <= 0))
        || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.until) || range.from >= range.until
        || (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647))) {
        throw new Error("Invalid Telegram history range.");
      }
      const chat = await request({ "@type": "getChat", chat_id }, undefined, signal);
      if (chat.id !== chat_id || !allowsSharing(chat) || object(chat.type)?.["@type"] === "chatTypeSecret") {
        throw new Error("This Telegram conversation cannot be shared.");
      }
      const anchor = cursor === undefined && topicId === undefined ? await historyDateAnchor(chat_id, range, signal) : undefined;
      if (anchor === null) return { messages: [], before: null };
      const page = { chat_id, from_message_id: cursor ?? Number(anchor?.id ?? 0), offset: 0, limit: 50 };
      const result = await request(topicId === undefined
        ? { "@type": "getChatHistory", ...page, only_local: false }
        : { "@type": "getForumTopicHistory", ...page, forum_topic_id: topicId }, undefined, signal);
      if (result["@type"] !== "messages") throw new Error("Unexpected Telegram history page.");
      const rows = new Map<number, TdObject>();
      for (const raw of [anchor, ...array(result.messages).slice(0, 50).map(object)]) {
        if (raw?.["@type"] !== "message" || raw.chat_id !== chat_id || typeof raw.id !== "number"
          || !Number.isSafeInteger(raw.id) || raw.id <= 0 || (cursor !== undefined && raw.id >= cursor)
          || (topicId !== undefined && forumTopicId(raw) !== topicId)) continue;
        rows.set(raw.id, raw);
      }
      const ordered = [...rows.entries()].sort(([a], [b]) => b - a);
      const included = ordered.filter(([, row]) => isInNoteDateRange(row, range));
      const shareable = included.map(([, row]) => row).filter(mayShareHistoryMessage);
      const views = new Map((await withAuthors(shareable, chat_id, chatTitle(chat))).map((view) => [view.id, view]));
      const candidates = [];
      let speechCount = 0;
      let speechCursor: string | undefined;
      for (const [id, row] of included) {
        const kind = speechNote(row);
        if (signal?.aborted) throw new Error("Telegram history was cancelled.");
        if (kind && speechCount >= 2 && candidates.length) {
          speechCursor = candidates.at(-1)!.id;
          break;
        }
        if (kind) speechCount++;
        const transcript = kind ? await transcribeSpeechNote(chat_id, row, signal).catch(() => null) : undefined;
        const status = transcript === null ? "unavailable" as const : "local" as const;
        const view = views.get(String(id));
        candidates.push(view ? { id: view.id, date: Number(row.date), author: view.author,
          text: transcript || view.text, ...(kind === "voice" ? { voiceTranscript: status } : kind === "video" ? { videoTranscript: status } : {}),
          ...(view.replyTo ? { replyTo: view.replyTo } : {}),
          ...(view.forumTopicId === undefined ? {} : { forumTopicId: view.forumTopicId }) }
          : { id: String(id), date: Number(row.date), withheld: true as const });
      }
      const messages: typeof candidates = [];
      let bytes = 0;
      for (const candidate of candidates) {
        const size = Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1;
        if (messages.length && bytes + size > 48 * 1024) {
          return { messages, before: messages[messages.length - 1]!.id };
        }
        messages.push(candidate);
        bytes += size;
      }
      const oldest = ordered.at(-1);
      const next = speechCursor ?? (oldest && !(typeof oldest[1].date === "number" && oldest[1].date < range.from) ? String(oldest[0]) : null);
      return { messages, before: next };
    },
    async history(chatId: string, before?: string, topicId?: number): Promise<HistoryPage> {
      requireReady();
      const id = Number(chatId);
      if (!Number.isSafeInteger(id) || !id) throw new Error("Invalid chat.");
      const anchor = before === undefined ? 0 : Number(before);
      if (!Number.isSafeInteger(anchor) || anchor < 0 || (before !== undefined && anchor === 0)) throw new Error("Invalid history cursor.");
      if (topicId !== undefined && (!Number.isInteger(topicId) || topicId < 1 || topicId > 2147483647)) {
        throw new Error("Invalid forum topic.");
      }
      const [chat, result] = await Promise.all([
        request({ "@type": "getChat", chat_id: id }),
        request(topicId === undefined
          ? { "@type": "getChatHistory", chat_id: id, from_message_id: anchor, offset: 0, limit: 50, only_local: false }
          : { "@type": "getForumTopicHistory", chat_id: id, forum_topic_id: topicId, from_message_id: anchor, offset: 0, limit: 50 }),
      ]);
      if (chat.id !== id) throw new Error("Telegram history belongs to a different chat.");
      const fallback = typeof chat.title === "string" ? chat.title.slice(0, 256) : "Telegram";
      const seen = new Set<number>();
      const items = array(result.messages).slice(0, 50).map(object).filter((item): item is TdObject => {
        const id = item?.id;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || (anchor && id >= anchor) || seen.has(id)
          || (item?.chat_id !== undefined && item.chat_id !== chat.id)
          || (topicId !== undefined && (!item || item.chat_id !== chat.id || forumTopicId(item) !== topicId))) return false;
        seen.add(id);
        return true;
      });
      const shareable = allowsSharing(chat);
      let next = seen.size ? String(Math.min(...seen)) : null;
      const archive = options.privateHistory;
      const retained = archive && topicId === undefined && object(chat.type)?.["@type"] === "chatTypePrivate"
        ? queueRetention(async () => {
          const account = await archiveAccount();
          if (account === chatId || state.state !== "ready") return [];
          const incoming = items.flatMap((raw) => {
            const copy = snapshot(raw, fallback);
            return copy ? [shareable ? copy : { id: copy.id, time: copy.time, author: copy.author, text: "Protected message" }] : [];
          });
          archive.save(account, chatId, incoming);
          for (const raw of items) {
            if (expiredMedia.has(object(raw.content)?.["@type"] ?? "")) archive.mark(account, chatId, String(raw.id), "expired");
          }
          return archive.page(account, chatId, anchor, seen.size ? Math.min(...seen) : 0);
        }) : Promise.resolve([]);
      const [views, saved] = await Promise.all([withAuthors(items, id, fallback), retained]);
      let messages = views;
      if (archive && topicId === undefined && shareable && object(chat.type)?.["@type"] === "chatTypePrivate") {
        const originals = new Map(items.map((item) => [String(item.id), item]));
        for (const view of views) {
          const raw = originals.get(view.id);
          const media = raw && oneViewFile(raw);
          if (media) {
            view.oneView = media.kind;
            view.text = media.kind === "photo" ? "One-view photo" : "One-view video";
            delete view.document;
            delete view.links;
            delete view.styles;
          }
        }
      }
      if (!shareable) {
        for (const row of messages) {
          if (row.document) row.document.downloadable = false;
          if (row.document?.name === "Sticker") delete row.hasPhoto;
          delete row.voiceNote;
        }
      }
      if (saved.length) {
        const merged = new Map(messages.map((row) => [row.id, row]));
        for (const row of saved) merged.set(row.id, row);
        messages = [...merged.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 50);
        next = messages.at(-1)?.id ?? next;
      }
      const outbox = chat.last_read_outbox_message_id;
      const readOutbox = object(chat.type)?.["@type"] === "chatTypePrivate"
        && typeof outbox === "number" && Number.isSafeInteger(outbox) && outbox >= 0 ? outbox : undefined;
      const draft = topicId === undefined ? plainDraftText(chat) : undefined;
      return {
        messages: messages.reverse(),
        ...(draft === undefined ? {} : { draft }),
        ...(readOutbox === undefined ? {} : { readOutbox }),
        before: next,
      };
    },
  };
}
