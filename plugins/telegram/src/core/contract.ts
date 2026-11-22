import { miniAppAgentMode, miniAppAgentSnapshot, miniAppAgentState } from "./mini-app-agent.ts";
export const chatChangedChannel = "telegram-chat-changed";
export const contactBirthdaysChangedChannel = "telegram-contact-birthdays-changed";
export const communityChangedChannel = "telegram-community-changed";

import { z } from "zod";
import { maxMarkdownDocumentBytes } from "./markdown-document.ts";
import { webLink, type MessageLink } from "./message-links.ts";
import { telegramBusinessChatLink } from "./public-chat-reference.ts";
import { isStickerEmoji, stickerEmojiKey } from "./sticker-emoji.ts";
import { tonAddress } from "./ton-address.ts";

export const authSchema = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["idle", "connecting", "disconnecting", "password"]), connectionId: z.uuid().optional() }),
  z.object({ state: z.literal("ready"), connectionId: z.uuid().optional(), accountLabel: z.string().max(48).optional(),
    draftScope: z.uuid().optional(), navigationScope: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.object({ state: z.literal("qr"), link: z.string().startsWith("tg://login?token="), connectionId: z.uuid().optional() }),
  z.object({ state: z.literal("error"), message: z.string(), connectionId: z.uuid().optional() }),
]);
export type Auth = z.infer<typeof authSchema>;

const miniAppLocationDecision = z.enum(["ask", "allowed", "denied"]);
export type MiniAppLocationDecision = z.infer<typeof miniAppLocationDecision>;

export const maxMiniAppDeviceStorageBytes = 5 * 1024 * 1024;
const miniAppDeviceKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const miniAppDeviceStorageOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get"), key: miniAppDeviceKey }),
  z.object({ kind: z.literal("save"), key: miniAppDeviceKey, value: z.string().max(maxMiniAppDeviceStorageBytes).nullable() }),
  z.object({ kind: z.literal("clear") }),
]);
export type MiniAppDeviceStorageOperation = z.infer<typeof miniAppDeviceStorageOperation>;

export const miniAppSecureStorageResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), value: z.string().max(maxMiniAppDeviceStorageBytes).nullable() }),
  z.object({ status: z.literal("failed"), error: z.enum(["QUOTA_EXCEEDED", "UNKNOWN_ERROR", "UNSUPPORTED"]) }),
]);
export type MiniAppSecureStorageResult = z.infer<typeof miniAppSecureStorageResult>;

const telegramAccountId = z.union([z.literal("primary"), z.uuid()]);
const telegramAccountLabel = z.string().trim().min(1).max(48);
export const telegramAccountSelection = z.object({
  selected: telegramAccountId,
  accounts: z.array(z.object({ id: telegramAccountId, label: telegramAccountLabel,
    agent: z.object({ accountId: z.string().regex(/^[1-9]\d{0,15}$/), read: z.boolean(), send: z.boolean() }).optional(),
  })).min(1).max(10),
}).refine(({ selected, accounts }) => accounts.some(({ id }) => id === selected)
  && accounts.some(({ id }) => id === "primary") && new Set(accounts.map(({ id }) => id)).size === accounts.length);
export type TelegramAccountSelection = z.infer<typeof telegramAccountSelection>;
const selectTelegramAccount = z.object({
  expected: telegramAccountId,
  target: z.union([z.object({ id: telegramAccountId }).strict(), z.object({ label: telegramAccountLabel }).strict()]),
}).strict();
export type SelectTelegramAccount = z.infer<typeof selectTelegramAccount>;
const renameTelegramAccount = z.object({
  expected: telegramAccountId, previousLabel: telegramAccountLabel, label: telegramAccountLabel,
}).strict();
export type RenameTelegramAccount = z.infer<typeof renameTelegramAccount>;

export const videoAttachmentAccept = ".mp4,.mov,video/mp4,video/quicktime";
export const isGifAttachmentName = (name: string) => /\.gif$/i.test(name);
export const isChatAnimationAttachmentName = (name: string) => /\.(gif|mp4|mov)$/i.test(name);
export const isAudioAttachmentName = (name: string) => /\.(mp3|m4a)$/i.test(name);
export const isVideoAttachmentName = (name: string) => /\.(mp4|mov)$/i.test(name);
export const maxPhotoBytes = 512 * 1024;
const photoBase64 = z.string().max(Math.ceil(maxPhotoBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const maxPhotoEdge = 1600;
export const maxOriginalPhotoBytes = 64 * 1024 * 1024;
const channelInboxAttachmentKind = z.enum(["document", "photo", "video", "audio", "animation"]);
export type ChannelInboxAttachmentKind = z.infer<typeof channelInboxAttachmentKind>;
export function validChannelInboxAttachment(kind: ChannelInboxAttachmentKind, name: string, size: number) {
  switch (kind) {
    case "photo": return size <= maxPhotoBytes;
    case "video": return isVideoAttachmentName(name);
    case "audio": return isAudioAttachmentName(name);
    case "animation": return isGifAttachmentName(name);
    case "document": return true;
  }
}
export const maxDocumentUploadBytes = 512 * 1024;
export const documentDeliveryTimeoutMs = 2 * 60 * 60_000;
export const maxDocumentBytes = 4 * 1024 * 1024 * 1024;
export const maxStandardTelegramUploadBytes = 2000 * 1024 * 1024;
export const maxTelegramUploadBytes = 2 * maxStandardTelegramUploadBytes;
export const maxVideoNoteBytes = 8 * 1024 * 1024;
export const maxVoiceBytes = 4 * 1024 * 1024;
export const maxPlaybackBytes = 32 * 1024 * 1024;
const audioPlaybackMime = z.enum(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/flac"]);
export const playbackMime = z.enum([...audioPlaybackMime.options, "video/mp4", "video/webm", "image/webp", "image/gif"]);
export function readAudioPlaybackMime(value: unknown) {
  return audioPlaybackMime.safeParse(value === "audio/x-flac" ? "audio/flac" : value).data;
}
const profileAudioOffset = z.number().int().min(0).max(10_000);
const profileAudioTrack = z.object({
  index: profileAudioOffset, fileId: z.number().int().positive().max(2147483647),
  title: z.string().min(1).max(256), performer: z.string().max(256),
  mime: audioPlaybackMime.optional(),
});
const profileAudioPage = z.object({ tracks: z.array(profileAudioTrack).max(20), next: profileAudioOffset.nullable() });
export type ProfileAudioPage = z.infer<typeof profileAudioPage>;
export const profileAudioChange = z.object({
  index: profileAudioOffset, fileId: profileAudioTrack.shape.fileId,
  action: z.enum(["up", "down", "remove"]), neighbor: profileAudioTrack.shape.fileId.optional(),
}).refine(({ action, neighbor }) => action === "remove" ? neighbor === undefined : neighbor !== undefined);
export type ProfileAudioChange = z.infer<typeof profileAudioChange>;
export type PlaybackMime = z.infer<typeof playbackMime>;
export const customEmojiId = z.string().regex(/^-?[1-9]\d{0,19}$/);
const customEmojiRange = z.object({ id: customEmojiId, offset: z.number().int().min(0).max(8191), length: z.number().int().min(1).max(8192) });
export type CustomEmojiRange = z.infer<typeof customEmojiRange>;
const draftCustomEmoji = z.array(customEmojiRange).max(128);
const customEmojiMedia = z.discriminatedUnion("format", [
  z.object({ format: z.literal("tgs"), json: z.string().min(1).max(2 * 1024 * 1024) }),
  z.object({ format: z.enum(["webp", "webm"]), base64: z.string().min(1).max(349528).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
]);
export type CustomEmojiMedia = z.infer<typeof customEmojiMedia>;
const mediaTimestampRanges = z.array(z.object({
  offset: z.number().int().min(0).max(8191), length: z.number().int().min(1).max(8192),
  time: z.number().int().min(0).max(2147483647),
})).max(128);
export type MediaTimestampRange = z.infer<typeof mediaTimestampRanges>[number];
const videoQuality = z.object({ fileId: z.number().int().positive().max(2147483647),
  width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  sizeBytes: z.number().int().positive().max(maxDocumentBytes).optional() });
export type VideoQuality = z.infer<typeof videoQuality>;
const playbackFileId = z.number().int().positive().max(2147483647);
const documentInfo = z.object({
  playbackFileId: playbackFileId.optional(),
  name: z.string().min(1).max(180), downloadable: z.boolean(), playbackMime: playbackMime.optional(), caption: z.string().max(8192).optional(),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), approximateSize: z.boolean().optional(),
  timestamps: mediaTimestampRanges.optional(),
  posterSize: z.object({ width: z.number().int().min(1).max(320), height: z.number().int().min(1).max(320) }).optional(),
  durationSeconds: z.number().int().positive().max(2147483647).optional(),
  waveform: z.array(z.number().int().min(0).max(31)).min(1).max(100).optional(),
  audioTrack: z.object({ title: z.string().min(1).max(256).optional(), artist: z.string().min(1).max(256).optional() }).optional(),
  videoQualities: z.array(videoQuality).min(1).max(16).optional(),
});
export type DocumentInfo = z.infer<typeof documentInfo>;

export const mediaCollectionKind = z.enum(["sticker", "gif"]);
export type MediaCollectionKind = z.infer<typeof mediaCollectionKind>;

const messageStyle = z.enum(["bold", "italic", "underline", "strike", "code", "spoiler", "quote", "expandableQuote"]);
export type MessageStyle = z.infer<typeof messageStyle>;
const styledRange = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), style: messageStyle });
export type StyledRange = z.infer<typeof styledRange>;

const captionPlacement = z.object({ above: z.boolean(), expected: z.boolean() });
export type CaptionPlacement = z.infer<typeof captionPlacement>;

const draftLinks = z.array(z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), url: z.string().max(4096) })).max(128);
const captionFormat = z.object({ styles: z.array(styledRange).max(128).optional(),
  links: draftLinks.optional(), customEmoji: draftCustomEmoji.optional() });
export type CaptionFormat = z.infer<typeof captionFormat>;
export const voiceTrim = z.object({
  startMs: z.number().int().min(0).max(119900),
  endMs: z.number().int().min(100).max(120000),
}).refine(({ startMs, endMs }) => endMs - startMs >= 100);
export type VoiceTrim = z.infer<typeof voiceTrim>;
const voiceRecording = z.object({
  duration: z.number().int().min(1).max(120), trim: voiceTrim.optional(), format: z.enum(["ogg", "webm", "mp4"]),
  base64: z.string().max(Math.ceil(maxVoiceBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type VoiceRecording = z.infer<typeof voiceRecording>;
const videoNoteRecording = z.object({
  format: z.enum(["webm", "mp4"]),
  base64: z.string().max(Math.ceil(maxVideoNoteBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type VideoNoteRecording = z.infer<typeof videoNoteRecording>;
const mediaSendOptions = z.object({
  spoiler: z.boolean().optional(), captionAbove: z.boolean().optional(), originalVideo: z.boolean().optional(),
});
export type MediaSendOptions = z.infer<typeof mediaSendOptions>;
const attachmentSendOptions = mediaSendOptions.extend({ captionFormat: captionFormat.optional() });
export type AttachmentSendOptions = z.infer<typeof attachmentSendOptions>;
export const videoEditQuality = {
  "480": { edge: 480, kbps: 1500 },
  "720": { edge: 720, kbps: 3000 },
  "1080": { edge: 1080, kbps: 6000 },
} as const;
export const videoEditAudioKbps = 128;
const mediaTrimRange = z.object({
  startMs: z.number().int().nonnegative().max(2147483647),
  endMs: z.number().int().positive().max(2147483647),
});
export const animationTrim = mediaTrimRange.refine(({ startMs, endMs }) => endMs - startMs >= 250);
export type AnimationTrim = z.infer<typeof animationTrim>;
export const videoEdit = mediaTrimRange.extend({
  quality: z.enum(["original", "480", "720", "1080"]),
  coverMs: z.number().int().nonnegative().max(2147483647).optional(),
}).refine(({ startMs, endMs, coverMs, quality }) => endMs - startMs >= 250
  && (quality !== "original" || startMs === 0)
  && (coverMs === undefined || coverMs >= startMs && coverMs < endMs));
export type VideoEdit = z.infer<typeof videoEdit>;
const localMediaKind = z.enum(["audio", "animation"]);
export type LocalMediaKind = z.infer<typeof localMediaKind>;
const documentSendOptions = attachmentSendOptions.extend({
  videoEdit: videoEdit.optional(),
  animationTrim: animationTrim.optional(),
  mediaKind: localMediaKind.optional(),
});
export type DocumentSendOptions = z.infer<typeof documentSendOptions>;
const albumSendOptions = attachmentSendOptions.extend({
  paidStars: z.number().int().positive().optional(),
  itemCaptions: z.array(z.union([
    z.string().trim().max(1024),
    z.object({ text: z.string().trim().min(1).max(1024), format: captionFormat }),
  ])).min(2).max(10).optional(),
});
export type AlbumSendOptions = z.infer<typeof albumSendOptions>;

export function validAlbumItemCaptions(count: number, caption: string, options?: AlbumSendOptions, pricePerMessage?: number) {
  const captions = options?.itemCaptions;
  return captions === undefined || (count >= 2 && captions.length === count && !caption.trim()
    && options?.captionFormat === undefined && options?.paidStars === undefined && pricePerMessage === undefined
    && captions.some((item) => (typeof item === "string" ? item : item.text).trim())
    && captions.every((item) => (typeof item === "string" ? item : item.text).length <= 1024));
}
const gifSendOptions = attachmentSendOptions.extend({ caption: z.string().trim().max(1024) });
export type GifSendOptions = z.infer<typeof gifSendOptions>;

export const forumTopicId = z.number().int().positive().max(2147483647);
export const forumTopicColors = [
  { value: 0x6fb9f0, label: "Blue" }, { value: 0xffd67e, label: "Yellow" },
  { value: 0xcb86db, label: "Purple" }, { value: 0x8eee98, label: "Green" },
  { value: 0xff93b2, label: "Pink" }, { value: 0xfb6f5f, label: "Red" },
] as const;
const forumTopicColor = z.number().int().refine((color) => forumTopicColors.some(({ value }) => value === color));
export const maxTelegramTextLength = 4096;
const telegramDraftText = z.string().min(1).max(maxTelegramTextLength);
const messageLink = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(),
  url: z.string().max(4096), hidden: z.boolean().optional() });
const messageLinks = z.array(messageLink).max(128).optional();
const draftPreview = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }),
  z.object({ mode: z.literal("enabled"), above: z.literal(true).optional(), url: z.string().max(4096).optional() }),
]);
export type DraftPreview = z.infer<typeof draftPreview>;
const syncedDraft = z.object({
  text: telegramDraftText, links: messageLinks, styles: z.array(styledRange).max(128).optional(), customEmoji: draftCustomEmoji.optional(), preview: draftPreview.optional(),
});
export type SyncedDraft = z.infer<typeof syncedDraft>;
const topicDraft = z.object({ draft: syncedDraft.nullable(), writable: z.boolean() });
export type TopicDraft = z.infer<typeof topicDraft>;
const forumTopic = z.object({ id: forumTopicId, name: z.string().min(1).max(256), closed: z.boolean(), pinned: z.literal(true).optional(),
  general: z.literal(true).optional(), hidden: z.literal(true).optional(), color: forumTopicColor.optional(), draft: telegramDraftText.optional(),
  unread: z.number().int().positive().max(2147483647).optional(),
  unreadMentions: z.number().int().positive().max(2147483647).optional(),
  unreadReactions: z.number().int().positive().max(2147483647).optional(),
  preview: z.object({ text: z.string().max(256), time: z.string().max(64), outgoing: z.boolean() }).optional(),
});
export const forumTopicTarget = forumTopic.pick({ id: true, name: true });
export type ForumTopicTarget = z.infer<typeof forumTopicTarget>;
export type ForumTopic = z.infer<typeof forumTopic>;
const drawPhotoDestination = z.object({ topic: forumTopic.optional() });
export type DrawPhotoDestination = z.infer<typeof drawPhotoDestination>;

export const messageLocation = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  place: z.object({ title: z.string().max(256), address: z.string().max(512) }).optional(),
  liveUntil: z.union([z.number().int().positive(), z.enum(["indefinite", "ended"])]).optional(),
  canOpenMap: z.boolean(),
});
export type MessageLocation = z.infer<typeof messageLocation>;
export const locationPoint = messageLocation.pick({ latitude: true, longitude: true });
export type LocationPoint = z.infer<typeof locationPoint>;
export const quickReplyVenue = z.object({ title: z.string().trim().min(1).max(256), address: z.string().trim().min(1).max(512) });
export type QuickReplyVenue = z.infer<typeof quickReplyVenue>;
const pollOptionLink = z.string().trim().max(4096).refine((value) => !!webLink(value));
const pollFileId = z.number().int().positive().max(2147483647);
const pollAttachmentReference = z.object({
  slot: z.union([z.enum(["question", "explanation"]), z.number().int().min(0).max(99)]),
  fileId: pollFileId,
});
export type PollAttachmentReference = z.infer<typeof pollAttachmentReference>;
const photoMotion = z.object({ fileId: pollFileId, mime: z.enum(["video/mp4", "video/webm"]), sizeBytes: z.number().int().positive() });
export type PhotoMotion = z.infer<typeof photoMotion>;
const pollMediaAttachment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("photo"), fileId: pollFileId, previewId: pollFileId, motion: photoMotion.optional(),
    dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }) }),
  z.object({ kind: z.literal("file"), fileId: pollFileId, document: documentInfo,
    animation: z.literal(true).optional(), startTime: z.number().int().min(1).max(2147483647).optional() }),
  z.object({ kind: z.literal("sticker"), fileId: pollFileId, label: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("location"), location: messageLocation }),
  z.object({ kind: z.literal("link"), url: pollOptionLink, title: z.string().max(256).optional() }),
]);
export type PollMediaAttachment = z.infer<typeof pollMediaAttachment>;

export const pollChoice = z.object({ index: z.number().int().min(0).max(99), id: z.string().max(128).optional(), text: z.string().min(1).max(1024) });
export type PollChoice = z.infer<typeof pollChoice>;
const pollCountryCode = z.string().regex(/^[A-Z]{2}$/);
const pollCountryCodes = z.array(pollCountryCode).min(1).max(250)
  .refine((countries) => new Set(countries).size === countries.length);
const channelPollLimits = z.object({
  countryLimit: z.number().int().min(0).max(250),
  countries: z.array(z.object({ code: pollCountryCode, name: z.string().min(1).max(128) })).max(250),
});
export type ChannelPollLimits = z.infer<typeof channelPollLimits>;
export const pollOptionText = z.string().trim().min(1).max(100);
const pollSuggestedOption = z.object({ optionId: z.string().min(1).max(128), text: z.string().min(1).max(1024) });
const pollOptionChangeResult = z.enum(["updated", "unavailable", "unknown"]);
export type PollOptionChangeResult = z.infer<typeof pollOptionChangeResult>;
const pollInfo = z.object({
  question: z.string().min(1).max(1024),
  options: z.array(pollChoice.extend({ chosen: z.boolean(), correct: z.literal(true).optional(), suggested: z.literal(true).optional(),
    percentage: z.number().int().min(0).max(100).optional(),
    voterCount: z.number().int().min(0).max(2147483647).optional(),
    media: pollMediaAttachment.optional() })).min(1).max(100),
  media: pollMediaAttachment.optional(),
  explanationMedia: pollMediaAttachment.optional(),
  closed: z.boolean(), canVote: z.boolean(), multiple: z.boolean(), quiz: z.boolean(),
  anonymous: z.boolean().optional(),
  canGetVoters: z.boolean().optional(),
  canAddOption: z.literal(true).optional(),
  membersOnly: z.literal(true).optional(),
  countryCodes: pollCountryCodes.optional(),
  voteRestriction: z.enum(["country", "membership", "scheduled", "unavailable"]).optional(),
  voters: z.number().int().nonnegative().optional(),
  description: z.string().min(1).max(4096).optional(),
  closesAt: z.number().int().positive().max(2147483647).optional(),
  explanation: z.string().min(1).max(1024).optional(),
});
export type PollInfo = z.infer<typeof pollInfo>;

const pollGraphTime = z.number().int().positive().max(8_640_000_000_000_000);
const pollGraphValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const pollVoteGraph = z.object({
  dates: z.array(pollGraphTime).min(1).max(3660)
    .refine((dates) => dates.every((date, i) => i === 0 || date > dates[i - 1]!)),
  chartType: z.enum(["line", "step", "bar", "area"]),
  stacked: z.boolean(),
  percentage: z.boolean(),
  scaled: z.boolean(),
  zoomable: z.boolean(),
  series: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    values: z.array(pollGraphValue).min(1).max(3660),
  })).min(1).max(49),
}).refine(({ dates, series }) => series.every(({ values }) => values.length === dates.length));
export type PollVoteGraph = z.infer<typeof pollVoteGraph>;

const reactionEmoji = z.string().trim().min(1).max(64);
const emojiReaction = z.object({ kind: z.literal("emoji"), emoji: reactionEmoji });
const customReaction = z.object({ kind: z.literal("custom"), id: customEmojiId });
export const selectableReaction = z.discriminatedUnion("kind", [emojiReaction, customReaction]);
export type SelectableReaction = z.infer<typeof selectableReaction>;
const reactionType = z.discriminatedUnion("kind", [emojiReaction, customReaction, z.object({ kind: z.literal("paid") })]);
export type ReactionType = z.infer<typeof reactionType>;
export function reactionKey(reaction: ReactionType) {
  return reaction.kind === "emoji" ? `emoji:${reaction.emoji}` : reaction.kind === "custom" ? `custom:${reaction.id}` : "paid";
}
const reactionLimit = z.number().int().min(1).max(11);
export const chatReactionPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all"), limit: reactionLimit }),
  z.object({ mode: z.literal("selected"), limit: reactionLimit, paid: z.literal(true).optional(),
    reactions: z.array(selectableReaction).max(100)
      .refine((rows) => new Set(rows.map(reactionKey)).size === rows.length) }),
]);
export type ChatReactionPolicy = z.infer<typeof chatReactionPolicy>;
const chatReactionSettings = z.object({
  policy: chatReactionPolicy, editable: z.boolean(), channel: z.boolean(), activeEmoji: z.array(reactionEmoji).max(100),
});
export type ChatReactionSettings = z.infer<typeof chatReactionSettings>;
const messageReaction = z.object({ type: reactionType, count: z.number().int().nonnegative(), chosen: z.boolean() });
const messageReactions = z.object({ tags: z.boolean(), items: z.array(messageReaction).min(1).max(100), canView: z.literal(true).optional() });
export type MessageReactions = z.infer<typeof messageReactions>;

export const messageSender = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().regex(/^[1-9]\d{0,15}$/) }),
  z.object({ kind: z.literal("chat"), id: z.string().regex(/^-[1-9]\d{0,15}$/) }),
]);
export type MessageSender = z.infer<typeof messageSender>;
const sendAsKey = z.string().regex(/^(user:[1-9]\d{0,15}|chat:-[1-9]\d{0,15})$/);
const chatSendAs = z.object({ current: sendAsKey, choices: z.array(z.object({
  key: sendAsKey, name: z.string().min(1).max(256), available: z.boolean(),
})).max(40) });
export type ChatSendAs = z.infer<typeof chatSendAs>;

const messagePreviewCover = z.object({
  fileId: z.number().int().positive(), width: z.number().int().positive().max(640), height: z.number().int().positive().max(640),
});
const messagePreviewMedia = z.object({
  fileId: z.number().int().positive(), mime: playbackMime, startTime: z.number().int().positive().max(2147483647).optional(),
  loop: z.literal(true).optional(), videoNote: z.literal(true).optional(), voiceNote: z.literal(true).optional(),
});
const messageLinkPreview = z.object({
  url: z.string().max(4096), site: z.string().max(256), title: z.string().max(512),
  description: z.string().max(1024), above: z.boolean(), instantView: z.literal(true).optional(),
  cover: messagePreviewCover.optional(), media: messagePreviewMedia.optional(),
  timestamps: mediaTimestampRanges.optional(),
  album: z.object({ items: z.array(z.union([messagePreviewCover, messagePreviewMedia])).min(1).max(20),
    caption: z.string().max(1024).optional() }).optional(),
});
export type MessageLinkPreview = z.infer<typeof messageLinkPreview>;
const linkPreviewMetadata = messageLinkPreview.pick({ title: true, site: true, description: true });
export type LinkPreviewMetadata = z.infer<typeof linkPreviewMetadata>;

const forwardedPost = z.object({ chatId: z.string().regex(/^-[1-9]\d{0,15}$/), messageId: z.string().regex(/^[1-9]\d{0,15}$/) });
export type ForwardedPost = z.infer<typeof forwardedPost>;

export const maxMapPreviewBytes = 1024 * 1024 - 1;
const mapPreview = z.string().max(Math.ceil(maxMapPreviewBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const defaultMapPreviewDimensions = { width: 320, height: 176 };
const mapPreviewEdge = z.number().int().min(16).max(1024);
const mapPreviewDimensions = z.object({ width: mapPreviewEdge, height: mapPreviewEdge });
export type MapPreviewDimensions = z.infer<typeof mapPreviewDimensions>;
export const articleMapPoint = locationPoint.extend({
  zoom: z.number().int().min(13).max(20),
  dimensions: mapPreviewDimensions.optional(),
});
export type ArticleMapPoint = z.infer<typeof articleMapPoint>;

const sharedContact = z.object({
  firstName: z.string().max(64), lastName: z.string().max(64),
  phone: z.string().max(64),
  userId: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
});
export const contactDraft = sharedContact.pick({ firstName: true, lastName: true, phone: true }).extend({
  firstName: z.string().trim().min(1).max(64),
  lastName: z.string().trim().max(64),
  phone: z.string().trim().max(64).regex(/^\+?[0-9 ()-]+$/)
    .transform((phone) => phone.replace(/[ ()-]/g, ""))
    .pipe(z.string().regex(/^\+?[0-9]{3,15}$/)),
});
export type ContactDraft = z.infer<typeof contactDraft>;
export const welcomeCardDraft = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contact"), contact: contactDraft }),
  z.object({ kind: z.literal("location"), point: locationPoint, venue: quickReplyVenue.optional() }),
]);
export type WelcomeCardDraft = z.infer<typeof welcomeCardDraft>;
export type SharedContact = z.infer<typeof sharedContact>;

export const translationLanguage = z.enum([
  "af", "sq", "am", "ar", "hy", "az", "eu", "be", "bn", "bs", "bg", "ca", "ceb", "zh-Hans", "zh-Hant",
  "co", "hr", "cs", "da", "nl", "en", "eo", "et", "fi", "fr", "fy", "gl", "ka", "de", "el", "gu", "ht",
  "ha", "haw", "he", "hi", "hmn", "hu", "is", "ig", "id", "ga", "it", "ja", "jv", "kn", "kk", "km",
  "rw", "ko", "ku", "ky", "lo", "la", "lv", "lt", "lb", "mk", "mg", "ms", "ml", "mt", "mi", "mr", "mn",
  "my", "ne", "no", "ny", "or", "ps", "fa", "pl", "pt", "pa", "ro", "ru", "sm", "gd", "sr", "st",
  "sn", "sd", "si", "sk", "sl", "so", "es", "su", "sw", "sv", "tl", "tg", "ta", "tt", "te", "th",
  "tr", "tk", "uk", "ur", "ug", "uz", "vi", "cy", "xh", "yi", "yo", "zu",
]);
export const telegramInterfaceLanguage = z.enum(["auto", "ru", "en"]);
export const defaultTranslationLanguage = z.union([z.literal("auto"), translationLanguage]);
export type TelegramInterfaceLanguage = z.infer<typeof telegramInterfaceLanguage>;
export type DefaultTranslationLanguage = z.infer<typeof defaultTranslationLanguage>;
export type TranslationLanguage = z.infer<typeof translationLanguage>;

const messageStoryReference = z.object({ id: z.string().regex(/^-?[1-9]\d{0,15}$/),
  story: z.number().int().positive().max(2147483647) });
const checklistText = z.object({
  text: z.string().min(1).max(1024), links: messageLinks, styles: z.array(styledRange).max(128).optional(),
  customEmoji: z.array(customEmojiRange).max(128).optional(),
});
const checklistTaskId = z.number().int().positive().max(2147483647);
const checklist = z.object({
  title: checklistText, tasks: z.array(z.object({ id: checklistTaskId, label: checklistText, done: z.boolean() })).min(1).max(100),
  canToggle: z.literal(true).optional(), canAdd: z.literal(true).optional(),
  editRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  othersCanAdd: z.boolean().optional(), othersCanComplete: z.boolean().optional(),
});
export type Checklist = z.infer<typeof checklist>;
const checklistChange = z.union([z.object({ state: z.literal("updated"), checklist }),
  z.object({ state: z.enum(["changed", "unavailable", "unknown"]) })]);
export type ChecklistChange = z.infer<typeof checklistChange>;
const botCommand = z.object({
  command: z.string().regex(/^\/[a-z0-9_]{1,32}(?:@[a-z0-9_]{1,64})?$/i),
  description: z.string().max(256),
});
export type BotCommand = z.infer<typeof botCommand>;
const inlineBotResult = z.object({ token: z.uuid(), title: z.string().min(1).max(256),
  description: z.string().max(512), kind: z.string().min(1).max(64), hasPreview: z.literal(true).optional() });
const inlineBotPage = z.object({
  startBot: z.object({ label: z.string().min(1).max(128), url: z.string().max(160) }).optional(),
  results: z.array(inlineBotResult).max(50), next: z.string().max(512).nullable(),
  miniApp: z.object({ label: z.string().min(1).max(128), token: z.uuid() }).optional(),
});
export type InlineBotPage = z.infer<typeof inlineBotPage>;
const inlineBotRow = z.number().int().min(0).max(19);
const inlineBotColumn = z.number().int().min(0).max(9);
const inlineBotRevision = z.string().regex(/^[a-f0-9]{64}$/);
const botButtonAppearance = z.object({
  style: z.enum(["primary", "danger", "success"]).optional(),
  iconCustomEmojiId: customEmojiId.optional(),
});
export type BotButtonAppearance = z.infer<typeof botButtonAppearance>;
const inlineBotButtonBase = botButtonAppearance.extend({ label: z.string().min(1).max(256) });
const inlineBotButton = z.discriminatedUnion("kind", [
  inlineBotButtonBase.extend({ kind: z.literal("callback"), row: inlineBotRow, column: inlineBotColumn,
    revision: inlineBotRevision }),
  inlineBotButtonBase.extend({ kind: z.literal("webApp"), row: inlineBotRow, column: inlineBotColumn,
    revision: inlineBotRevision }),
  inlineBotButtonBase.extend({ kind: z.literal("profile"), row: inlineBotRow, column: inlineBotColumn,
    revision: inlineBotRevision, userId: z.number().int().positive() }),
  inlineBotButtonBase.extend({ kind: z.literal("switchInline"),
    bot: z.string().regex(/^[a-z0-9_]{1,64}$/i), query: z.string().max(256) }),
  inlineBotButtonBase.extend({ kind: z.literal("switchInlineChoose"), row: inlineBotRow, column: inlineBotColumn,
    revision: inlineBotRevision, bot: z.string().regex(/^[a-z0-9_]{1,64}$/i), query: z.string().max(256) }),
  inlineBotButtonBase.extend({ kind: z.literal("copy"), text: z.string().min(1).max(256) }),
  inlineBotButtonBase.extend({ kind: z.literal("disabled") }),
  inlineBotButtonBase.extend({ kind: z.literal("url"), url: z.string().max(4096) }),
]);
export type InlineBotButton = z.infer<typeof inlineBotButton>;
const replyBotKeyboard = z.object({
  messageId: z.string().regex(/^[1-9]\d{0,15}$/), revision: inlineBotRevision, oneTime: z.boolean(),
  rows: z.array(z.array(botButtonAppearance.extend({ text: z.string().min(1).max(256), row: inlineBotRow, column: inlineBotColumn,
    webApp: z.literal(true).optional() })).min(1).max(10)).min(1).max(20),
});
export type ReplyBotKeyboard = z.infer<typeof replyBotKeyboard>;
const replyBotResult = z.enum(["sent", "changed", "failed", "unknown"]);
export type ReplyBotResult = z.infer<typeof replyBotResult>;
const botButtonAnswer = z.discriminatedUnion("state", [
  z.object({ state: z.literal("answered"), text: z.string().max(4096), alert: z.boolean(), url: z.string().max(4096).optional(),
    gameUrl: z.string().max(4096).optional() }),
  z.object({ state: z.enum(["changed", "unavailable", "unknown"]) }),
]);
export type BotButtonAnswer = z.infer<typeof botButtonAnswer>;
const richStyledRange = styledRange.extend({ style: messageStyle.or(z.enum(["subscript", "superscript", "marked"])) });
export type RichStyledRange = z.infer<typeof richStyledRange>;
export const richMathExpression = z.string().min(1).max(4096).refine((expression) => !!expression.trim());
const richFormulaRange = z.object({ offset: z.number().int().min(0).max(32767), length: z.number().int().min(1).max(4096) });
export type RichFormulaRange = z.infer<typeof richFormulaRange>;
const articleButtonLabel = z.string().min(1).max(256);
export const richButtonStyle = z.enum(["primary", "danger", "success", "link"]);
const richButtonAlignment = z.enum(["left", "center", "right"]);
const buttonLabelFormat = z.object({
  styles: z.array(richStyledRange).max(64).optional(),
  customEmoji: z.array(customEmojiRange).max(128).optional(),
  formulas: z.array(richFormulaRange).max(32).optional(),
});
const messageActionButtons = [
  z.object({ kind: z.literal("url"), label: articleButtonLabel, url: z.string().url().max(4096), style: richButtonStyle.optional(),
    labelFormat: buttonLabelFormat.optional() }),
  z.object({ kind: z.literal("copy"), label: articleButtonLabel, text: z.string().min(1).max(256), style: richButtonStyle.optional(),
    labelFormat: buttonLabelFormat.optional() }),
] as const;
const messageActionButton = z.discriminatedUnion("kind", messageActionButtons);
const articleButton = z.discriminatedUnion("kind", [
  ...messageActionButtons,
  z.object({ kind: z.literal("profile"), label: articleButtonLabel, userId: z.number().int().positive(),
    style: richButtonStyle.optional(), labelFormat: buttonLabelFormat.optional() }),
  z.object({ kind: z.literal("disabled"), label: articleButtonLabel,
    style: richButtonStyle.optional(), labelFormat: buttonLabelFormat.optional() }),
]);
export type ArticleButton = z.infer<typeof articleButton>;
export const richBotCommand = z.string().regex(/^\/[a-zA-Z0-9_]{1,64}(?:@[a-zA-Z0-9_]{1,32})?$/);
const richBankCardReference = z.string().regex(/^[a-f0-9]{64}$/);
const richBankCardNumber = z.string().regex(/^\d{12,19}$/);
const richBankCardMode = z.enum(["copy", "info"]);
export type RichBankCardMode = z.infer<typeof richBankCardMode>;
const richBankCardResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("copy"), number: richBankCardNumber }),
  z.object({ kind: z.literal("info"), title: z.string().max(256),
    links: z.array(z.object({ text: z.string().min(1).max(128), url: z.string().max(4096).url() })).max(12) }),
  z.object({ kind: z.literal("unavailable") }),
]);
export type RichBankCardResult = z.infer<typeof richBankCardResult>;
const richInline = z.object({
  text: z.string().max(32768),
  styles: z.array(richStyledRange).max(128).optional(),
  links: messageLinks,
  customEmoji: z.array(customEmojiRange.extend({ offset: z.number().int().min(0).max(32767) })).max(128).optional(),
  formulas: z.array(richFormulaRange).max(32).optional(),
  inlineButtons: z.array(richFormulaRange.extend({ button: messageActionButton })).max(32).optional(),
  botCommands: z.array(richFormulaRange.extend({ command: richBotCommand })).max(32).optional(),
  bankCards: z.array(richFormulaRange.extend({ reference: richBankCardReference })).max(32).optional(),
  tonAddresses: z.array(richFormulaRange.extend({
    address: z.string().max(96).refine((address) => tonAddress(address) === address),
  })).max(32).optional(),
});
const instantViewFormulaRange = z.object({
  offset: z.number().int().min(0).max(8191),
  length: z.number().int().min(1).max(4096),
});
export type InstantViewFormulaRange = z.infer<typeof instantViewFormulaRange>;
const articleDatePrecision = z.enum(["none", "short", "long"]);
const instantViewDateRange = instantViewFormulaRange.extend({
  unixTime: z.number().int().min(-2147483648).max(2147483647),
  format: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("original") }),
    z.object({ kind: z.literal("relative") }),
    z.object({ kind: z.literal("absolute"), date: articleDatePrecision, time: articleDatePrecision, weekday: z.boolean() }),
  ]),
});
export type InstantViewDateRange = z.infer<typeof instantViewDateRange>;
export const instantViewIconMime = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const instantViewIconRange = z.object({
  offset: z.number().int().min(0).max(8191),
  fileId: z.number().int().positive(),
  mime: instantViewIconMime,
  width: z.number().int().min(0).max(maxPhotoEdge),
  height: z.number().int().min(0).max(maxPhotoEdge),
});
export type InstantViewIconRange = z.infer<typeof instantViewIconRange>;
export const telegramSearchTag = z.string().max(128).regex(/^[#$][\p{L}\p{N}_]+$/u);
export const telegramSearchTagKind = z.enum(["hashtag", "cashtag"]);
export type TelegramSearchTagKind = z.infer<typeof telegramSearchTagKind>;
export const telegramSearchTagPrefix = z.string().max(128).regex(/^(?:[#$][\p{L}\p{N}_]*)?$/u);
const instantViewTagRange = instantViewFormulaRange.extend({ tag: telegramSearchTag });
export type InstantViewTagRange = z.infer<typeof instantViewTagRange>;
const instantViewMentionRange = instantViewFormulaRange.extend({ userId: z.number().int().positive() });
export type InstantViewMentionRange = z.infer<typeof instantViewMentionRange>;
const instantViewText = richInline.pick({ text: true, styles: true, links: true, customEmoji: true }).extend({
  text: z.string().max(8192),
  links: z.array(messageLink.extend({ instantView: z.literal(true).optional() })).max(128).optional(),
  formulas: z.array(instantViewFormulaRange).max(32).optional(),
  dates: z.array(instantViewDateRange).max(32).optional(),
  icons: z.array(instantViewIconRange).max(32).optional(),
  inlineButtons: z.array(instantViewFormulaRange.extend({ button: articleButton })).max(32).optional(),
  tags: z.array(instantViewTagRange).max(64).optional(),
  mentions: z.array(instantViewMentionRange).max(64).optional(),
  anchors: z.array(z.string().min(1).max(256)).max(32).optional(),
});
const instantViewPhoto = z.object({
  fileId: z.number().int().positive(),
  dimensions: z.object({ width: z.number().int().positive().max(maxPhotoEdge), height: z.number().int().positive().max(maxPhotoEdge) }),
  fullWidth: z.number().int().positive().max(maxPhotoEdge).optional(),
  spoiler: z.boolean(),
});
const instantViewCaption = instantViewText.extend({ credit: instantViewText.omit({ anchors: true }).optional() });
const instantViewPhotoBlock = instantViewCaption.extend({
  kind: z.literal("photo"),
  photo: instantViewPhoto,
  url: z.string().max(4096).refine((value) => Boolean(webLink(value))).optional(),
});
const instantViewVideoBlock = instantViewCaption.extend({ kind: z.literal("video"), video: z.object({
  fileId: z.number().int().positive(),
  mime: z.enum(["video/mp4", "video/webm", "image/gif"]),
  spoiler: z.boolean(),
  loop: z.boolean(),
  posterFileId: instantViewPhoto.shape.fileId.optional(),
  dimensions: videoQuality.pick({ width: true, height: true }).optional(),
  durationSeconds: documentInfo.shape.durationSeconds,
  autoplay: z.literal(true).optional(),
  document: documentInfo.optional(),
}) });
const instantViewAudioBlock = instantViewCaption.extend({ kind: z.literal("audio"), audio: z.object({
  fileId: z.number().int().positive(),
  mime: audioPlaybackMime,
  voiceNote: z.boolean(),
  audioTrack: documentInfo.shape.audioTrack,
  coverFileId: instantViewPhoto.shape.fileId.optional(),
  durationSeconds: documentInfo.shape.durationSeconds,
  waveform: documentInfo.shape.waveform,
  document: documentInfo.optional(),
}) });
const instantViewTableCell = instantViewText.extend({
  header: z.boolean(),
  invisible: z.literal(true).optional(),
  colSpan: z.number().int().min(1).max(20),
  rowSpan: z.number().int().min(1).max(30),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});
const instantViewListText = instantViewText.extend({
  kind: z.enum(["title", "heading", "paragraph", "quote", "code"]),
});
const instantViewListMarker = z.object({
  label: z.string().max(32).optional(),
  numbering: z.enum(["1", "a", "A", "i", "I"]).optional(),
  value: z.number().int().min(-2147483648).max(2147483647).optional(),
  checked: z.boolean().optional(),
});
const articleAvatarFileId = instantViewPhoto.shape.fileId.optional();
const articlePublishedAt = z.number().int().positive().max(2147483647).optional();
const instantViewDocumentBlock = instantViewCaption.extend({
  kind: z.literal("document"), fileId: instantViewPhoto.shape.fileId, document: documentInfo,
});
const instantViewMissingMedia = instantViewCaption.extend({
  kind: z.literal("missingMedia"),
  url: instantViewPhotoBlock.shape.url,
});
const instantViewMapBlock = instantViewCaption.extend({ kind: z.literal("map"), point: articleMapPoint });
export const maxInstantViewBlocks = 200;
const instantViewLeaf = z.union([
  instantViewText.extend({ kind: z.literal("byline"), publishedAt: articlePublishedAt }),
  instantViewText.extend({ kind: z.literal("math"), text: z.string().min(1).max(4096) }),
  instantViewText.extend({ kind: z.literal("heading"), level: z.number().int().min(1).max(6).optional() }),
  instantViewText.extend({ kind: z.enum(["title", "subtitle", "kicker", "footer", "paragraph", "quote"]) }),
  instantViewText.extend({ kind: z.literal("code"), language: z.string().regex(/^[a-z0-9][a-z0-9+#._-]{0,31}$/i).optional() }),
  instantViewPhotoBlock, instantViewVideoBlock, instantViewAudioBlock,
  instantViewCaption.extend({ kind: z.enum(["collage", "slideshow"]),
    media: z.array(z.discriminatedUnion("kind", [
      instantViewPhotoBlock, instantViewVideoBlock, instantViewAudioBlock, instantViewDocumentBlock, instantViewMissingMedia, instantViewMapBlock,
    ])).min(1).max(maxInstantViewBlocks) }),
  instantViewText.extend({ kind: z.literal("table"), rows: z.array(z.array(instantViewTableCell).max(20)).min(1).max(30),
    bordered: z.boolean(), striped: z.boolean(), compact: z.boolean() }),
  instantViewText.extend({ kind: z.literal("quoteGroup"), expandable: z.boolean(),
    pull: z.literal(true).optional(),
    paragraphs: z.array(instantViewListText).min(1).max(maxInstantViewBlocks),
    credit: instantViewText.optional() }),
  instantViewText.extend({ kind: z.literal("divider") }),
  instantViewText.extend({ kind: z.literal("anchor"), text: z.literal(""),
    anchors: instantViewText.shape.anchors.unwrap().min(1) }),
  instantViewText.extend({ kind: z.literal("buttons"), buttons: z.array(articleButton).min(1).max(20),
    align: z.enum(["left", "center", "right"]).optional() }),
  instantViewDocumentBlock,
  instantViewMissingMedia,
  instantViewMapBlock,
  instantViewCaption.extend({ kind: z.literal("webEmbed"), photo: instantViewPhoto.optional(),
    dimensions: instantViewPhoto.shape.dimensions.optional(), fullWidth: z.literal(true).optional(),
    allowScrolling: z.boolean().optional(),
    staticHtml: z.string().min(1).max(32768).optional(),
    source: z.string().max(4096).refine((value) => Boolean(webLink(value))).optional() }),
  instantViewText.extend({ kind: z.literal("chatLink"), url: z.string().url().max(128), avatarFileId: articleAvatarFileId }),
  instantViewText.extend({ kind: z.literal("related"), articles: z.array(z.object({
    url: z.string().min(1).max(4096),
    title: z.string().max(512),
    description: z.string().max(1024),
    author: z.string().max(256),
    publishedAt: articlePublishedAt,
    previewFileId: instantViewPhoto.shape.fileId.optional(),
  })).min(1).max(20) }),
]);
type InstantViewDetails = z.infer<typeof instantViewText> & {
  kind: "details"; open: boolean; blocks: InstantViewBlock[];
};
const embeddedPostMetadata = z.object({
  avatarFileId: articleAvatarFileId,
  source: z.string().url().max(4096).optional(),
  author: z.string().max(256),
  publishedAt: articlePublishedAt,
});
type InstantViewPost = z.infer<typeof instantViewCaption> & z.infer<typeof embeddedPostMetadata> & {
  kind: "embeddedPost"; blocks: InstantViewBlock[];
};
type InstantViewRichQuote = z.infer<typeof instantViewText> & {
  kind: "richQuote"; blocks: InstantViewBlock[]; credit?: z.infer<typeof instantViewText>;
};
export type InstantViewList = z.infer<typeof instantViewText> & {
  kind: "list"; items: (z.infer<typeof instantViewListMarker> & { blocks: InstantViewBlock[] })[];
};
type InstantViewBlock = z.infer<typeof instantViewLeaf> | InstantViewDetails | InstantViewPost | InstantViewRichQuote | InstantViewList;
const instantViewBlock: z.ZodType<InstantViewBlock> = z.union([
  instantViewLeaf,
  instantViewText.extend({ kind: z.literal("list"), items: z.array(instantViewListMarker.extend({
    blocks: z.array(z.lazy(() => instantViewBlock)).min(1).max(maxInstantViewBlocks),
  })).min(1).max(64) }),
  instantViewText.extend({ kind: z.literal("details"), open: z.boolean(),
    blocks: z.array(z.lazy(() => instantViewBlock)).min(1).max(maxInstantViewBlocks) }),
  instantViewCaption.extend({ ...embeddedPostMetadata.shape, kind: z.literal("embeddedPost"),
    blocks: z.array(z.lazy(() => instantViewBlock)).max(maxInstantViewBlocks) }),
  instantViewText.extend({ kind: z.literal("richQuote"), blocks: z.array(z.lazy(() => instantViewBlock)).min(1).max(maxInstantViewBlocks),
    credit: instantViewText.optional() }),
]);
const instantViewArticle = z.object({
  rtl: z.boolean(),
  partial: z.boolean(),
  incompleteSource: z.literal(true).optional(),
  feedbackUrl: z.string().max(256).optional(),
  changes: z.array(z.object({ original: z.string().max(1024), current: z.string().max(1024) })).min(1).max(32).optional(),
  blocks: z.array(instantViewBlock).max(maxInstantViewBlocks),
}).refine((article) => article.blocks.length > 0 || !!article.changes?.length);
export type InstantViewArticle = z.infer<typeof instantViewArticle>;
const richDraftText = z.string().min(1).max(32768).refine((text) => !!text.trim());
export const richHeadingSize = z.number().int().min(1).max(6);
export const richCodeLanguage = z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).refine((language) => !!language.trim());
const richDraftStyle = z.enum(["bold", "italic", "underline", "strike", "code", "spoiler", "marked", "subscript", "superscript"]);
const richDraftRange = styledRange.extend({ style: richDraftStyle });
export type RichDraftRange = z.infer<typeof richDraftRange>;
const richDraftRanges = z.array(richDraftRange).max(64).optional();

const richDraftEmoji = richInline.shape.customEmoji;

function validRichDraftRanges(text: string, styles: readonly RichDraftRange[] = [], links: readonly MessageLink[] = [],
  customEmoji: readonly CustomEmojiRange[] = [], formulas: readonly RichFormulaRange[] = []) {
  const boundary = (index: number) => !(index > 0 && index < text.length
    && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff
    && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff);
  const fits = ({ offset, length }: { offset: number; length: number }) =>
    offset + length <= text.length && boundary(offset) && boundary(offset + length);
  let previousEnd = 0;
  if (!styles.every(fits) || !links.every((link) => {
    if (!fits(link) || link.offset < previousEnd || !webLink(link.url)) return false;
    previousEnd = link.offset + link.length;
    return true;
  })) return false;
  const formatting = [...styles, ...links];
  const ordered = [...customEmoji, ...formulas].sort((a, b) => a.offset - b.offset);
  return ordered.every((range, index) => {
    const end = range.offset + range.length;
    const previous = ordered[index - 1];
    const label = text.slice(range.offset, end);
    return fits(range) && ("id" in range ? range.length <= 32 && isStickerEmoji(label) : !!label.trim())
      && (!previous || previous.offset + previous.length <= range.offset)
      && formatting.every(({ offset, length }) => offset + length <= range.offset || end <= offset
        || (offset <= range.offset && end <= offset + length));
  });
}

const richDraftAttachment = z.object({ kind: z.enum(["photo", "video", "document"]),
  name: z.string().min(1).max(255), size: z.number().int().positive().max(maxTelegramUploadBytes),
  caption: z.string().max(32768), spoiler: z.boolean(), styles: richDraftRanges, links: messageLinks, customEmoji: richDraftEmoji,
  formulas: richInline.shape.formulas, videoEdit: videoEdit.optional(),
}).refine(({ kind, videoEdit, caption, styles, links, customEmoji, formulas }) => (videoEdit === undefined || kind === "video")
  && validRichDraftRanges(caption, styles, links, customEmoji, formulas));
export const richCaptionDraft = richInline.extend({ styles: richDraftRanges })
  .refine(({ text, styles, links, customEmoji, formulas }) => validRichDraftRanges(text, styles, links, customEmoji, formulas));
export type RichCaptionDraft = z.infer<typeof richCaptionDraft>;
const draftButtonLabel = articleButtonLabel.refine((label) => !!label.trim() && !/[\r\n]/.test(label));
const draftButtonFormat = buttonLabelFormat.extend({ styles: richDraftRanges });
export const draftRichButton = z.discriminatedUnion("kind", [
    messageActionButtons[0].extend({ label: draftButtonLabel, labelFormat: draftButtonFormat.optional(),
      url: z.string().max(4096).refine((url) => (webLink(url)?.href.length ?? Infinity) <= 4096) }),
    messageActionButtons[1].extend({ label: draftButtonLabel, labelFormat: draftButtonFormat.optional() }),
]).refine(({ label, labelFormat }) =>
  validRichDraftRanges(label, labelFormat?.styles, [], labelFormat?.customEmoji, labelFormat?.formulas));
const draftInlineButtons = z.array(richFormulaRange.extend({ button: draftRichButton })).max(32);
export type DraftInlineButton = z.infer<typeof draftInlineButtons>[number];
export const richButtonRow = z.object({ kind: z.literal("buttons"), align: richButtonAlignment,
  buttons: z.array(draftRichButton).min(1).max(20),
});
export type RichButtonRow = z.infer<typeof richButtonRow>;
const richTextBlock = z.object({ kind: z.enum(["paragraph", "heading", "quote", "expandableQuote", "code"]),
  text: richDraftText, styles: richDraftRanges, links: messageLinks, customEmoji: richDraftEmoji,
  headingSize: richHeadingSize.optional(), language: richCodeLanguage.optional(), credit: richCaptionDraft.optional(),
  formulas: richInline.shape.formulas, inlineButtons: draftInlineButtons.optional(),
}).refine(({ kind, text, styles, links, customEmoji, headingSize, language, credit, formulas, inlineButtons }) =>
  (headingSize === undefined || kind === "heading") && (language === undefined || kind === "code")
  && (credit === undefined || kind === "quote" || kind === "expandableQuote")
  && (!inlineButtons?.length || kind === "paragraph" && inlineButtons.every(({ offset, length, button }, index) =>
    text.slice(offset, offset + length) === button.label && button.label.length === length
    && (index === 0 || inlineButtons[index - 1]!.offset + inlineButtons[index - 1]!.length <= offset)
    && ![...(styles ?? []), ...(links ?? []), ...(customEmoji ?? []), ...(formulas ?? [])]
      .some((range) => range.offset < offset + length && range.offset + range.length > offset)))
  && validRichDraftRanges(text, styles, links, customEmoji, formulas));
const richListBlock = z.object({ kind: z.enum(["bulletList", "numberedList"]),
  items: z.array(richDraftText.refine((text) => !/[\r\n]/.test(text))).min(1).max(64) });
export const richListNumbering = z.enum(["", "1", "a", "A", "i", "I"]);
export const richListNumber = z.number().int().min(-2147483648).max(2147483647);
const richFormattedListItem = z.object({
  numbering: richListNumbering, value: richListNumber, checked: z.boolean().optional(),
  paragraphs: z.array(richCaptionDraft.refine(({ text }) => !!text.trim())).min(1).max(16),
}).refine(({ numbering, value }) => numbering !== "" || value === 0);
export type RichFormattedListItem = z.infer<typeof richFormattedListItem>;
const richFormattedListBlock = z.object({ kind: z.literal("formattedList"),
  entries: z.array(richFormattedListItem).min(1).max(64)
    .refine((entries) => entries.every(({ numbering }) => !!numbering === !!entries[0]?.numbering)) });
const richTableOptions = z.object({ caption: z.union([z.string().max(32768), richCaptionDraft]).optional(), bordered: z.boolean().optional(),
  striped: z.boolean().optional(), compact: z.boolean().optional() });
export type RichTableOptions = z.infer<typeof richTableOptions>;
const richTableCell = z.object({
  content: richCaptionDraft.nullable(), header: z.boolean(),
  colSpan: z.number().int().min(1).max(16), rowSpan: z.number().int().min(1).max(32),
  align: z.enum(["left", "center", "right"]), verticalAlign: z.enum(["top", "middle", "bottom"]),
});
export type RichTableCell = z.infer<typeof richTableCell>;

export function isStructuredRichTable(rows: string[][] | RichTableCell[][]): rows is RichTableCell[][] {
  return rows.some((row) => row.some((cell) => typeof cell === "object"));
}

export function layoutRichTable(rows: readonly (readonly RichTableCell[])[]) {
  const occupied = rows.map(() => Array<boolean>(16).fill(false));
  const positioned: { column: number; cell: RichTableCell }[][] = [];
  let width = 0;
  for (const [y, row] of rows.entries()) {
    const entries: (typeof positioned)[number] = [];
    let x = 0;
    for (const cell of row) {
      const { colSpan, rowSpan } = cell;
      while (occupied[y]![x]) x++;
      if (x + colSpan > 16 || y + rowSpan > rows.length) return;
      for (let vertical = y; vertical < y + rowSpan; vertical++) {
        for (let horizontal = x; horizontal < x + colSpan; horizontal++) {
          if (occupied[vertical]![horizontal]) return;
          occupied[vertical]![horizontal] = true;
        }
      }
      entries.push({ column: x, cell });
      x += colSpan;
      width = Math.max(width, x);
    }
    positioned.push(entries);
  }
  return width ? { width, rows: positioned } : undefined;
}

const simpleRichTableRows = z.array(z.array(z.string().max(32768).refine((text) => !/[\t\r\n]/.test(text))).min(1).max(16)).min(1).max(32)
  .refine((rows) => rows.every((row) => row.length === rows[0]?.length && row.some((cell) => cell.trim())));
const structuredRichTableRows = z.array(z.array(richTableCell).max(16)).min(1).max(32)
  .refine((rows) => layoutRichTable(rows) !== undefined);
const richTableBlock = z.object({ kind: z.literal("table"),
  rows: z.union([simpleRichTableRows, structuredRichTableRows]),
  options: richTableOptions.optional() });
const richRuleBlock = z.object({ kind: z.literal("rule") });
const richMathBlock = z.object({ kind: z.literal("math"), expression: richMathExpression });
const richBlockQuote = z.object({ kind: z.literal("blockQuote"), paragraphs: z.array(richCaptionDraft).min(1).max(16),
  credit: richCaptionDraft.optional() });
const editableRichBlocks = [richTextBlock, richListBlock, richFormattedListBlock, richTableBlock, richRuleBlock, richMathBlock, richBlockQuote, richButtonRow] as const;
export const editableRichDraft = z.array(z.discriminatedUnion("kind", editableRichBlocks)).min(1).max(128);
export type EditableRichDraft = z.infer<typeof editableRichDraft>;
export const richMessageDraft = z.array(z.discriminatedUnion("kind", [richDraftAttachment, ...editableRichBlocks])).min(1).max(128);
export type RichMessageDraft = z.infer<typeof richMessageDraft>;
const existingWelcomeMedia = z.object({ kind: z.literal("existingMedia"), index: z.number().int().min(0).max(127),
  captionEdit: richCaptionDraft.optional() });
export const welcomeRichEditDraft = z.array(z.discriminatedUnion("kind", [existingWelcomeMedia, ...editableRichBlocks])).min(1).max(128);
export type WelcomeRichEditDraft = z.infer<typeof welcomeRichEditDraft>;
const existingWelcomeMediaView = existingWelcomeMedia.extend({ label: z.string().min(1).max(180), caption: z.string().max(32768),
  captionDraft: richCaptionDraft.optional(),
  replaceKind: z.enum(["photo", "video", "document"]).optional() });
export type ExistingWelcomeMedia = z.infer<typeof existingWelcomeMediaView>;
export const welcomeRichEditView = z.array(z.discriminatedUnion("kind", [existingWelcomeMediaView, ...editableRichBlocks])).min(1).max(128);
export type WelcomeRichEditView = z.infer<typeof welcomeRichEditView>;
const welcomeRichFile = richDraftAttachment.safeExtend({ replaces: existingWelcomeMedia.shape.index.optional(),
  captionEdit: richCaptionDraft.optional() }).refine((block) => !block.captionEdit || block.replaces !== undefined);
export const welcomeRichComposeDraft = z.array(z.discriminatedUnion("kind", [welcomeRichFile, existingWelcomeMediaView, ...editableRichBlocks])).min(1).max(128);
export type WelcomeRichComposeDraft = z.infer<typeof welcomeRichComposeDraft>;
const richEdit = z.object({ draft: welcomeRichEditView, revision: z.string().regex(/^[a-f0-9]{64}$/) });
export type RichEdit = z.infer<typeof richEdit>;

const richMessageLimits = z.object({
  text: z.number().int().positive().max(32768), blocks: z.number().int().positive().max(128),
  columns: z.number().int().min(0).max(16), media: z.number().int().min(0).max(10),
});

export function fitsRichMessageLimits(draft: WelcomeRichComposeDraft, limits: z.infer<typeof richMessageLimits>): boolean {
  let text = 0;
  let blocks = draft.length;
  let media = 0;
  for (const block of draft) {
    if ("size" in block || block.kind === "existingMedia") {
      media++;
      text += block.caption.length;
    } else if (block.kind === "formattedList") {
      for (const entry of block.entries) {
        blocks += 1 + entry.paragraphs.length;
        for (const paragraph of entry.paragraphs) text += paragraph.text.length;
      }
    } else if ("items" in block) {
      blocks += 2 * block.items.length;
      for (const item of block.items) text += item.length;
    } else if (block.kind === "table") {
      const width = isStructuredRichTable(block.rows) ? layoutRichTable(block.rows)?.width : block.rows[0]?.length;
      if (width === undefined || width > limits.columns) return false;
      blocks += block.rows.length;
      const caption = block.options?.caption;
      text += typeof caption === "string" ? caption.length : caption?.text.length ?? 0;
      for (const row of block.rows) for (const cell of row) text += typeof cell === "string" ? cell.length : cell.content?.text.length ?? 0;
    } else if (block.kind === "math") {
      text += block.expression.length;
    } else if (block.kind === "buttons") {
      for (const button of block.buttons) text += button.label.length + (button.kind === "url" ? button.url.length : button.text.length);
    } else if (block.kind === "blockQuote") {
      blocks += block.paragraphs.length;
      text += block.credit?.text.length ?? 0;
      for (const paragraph of block.paragraphs) text += paragraph.text.length;
    } else if (block.kind !== "rule") {
      text += block.text.length + (block.credit?.text.length ?? 0);
      for (const { button } of block.inlineButtons ?? []) text += button.kind === "url" ? button.url.length : button.text.length;
    }
  }
  return text <= limits.text && blocks <= limits.blocks && media <= limits.media;
}
const richMessageAvailability = z.union([richMessageLimits, z.literal("premium_required"), z.null()]);
export type RichMessageAvailability = z.infer<typeof richMessageAvailability>;

const richAttachmentReference = z.object({ index: z.number().int().min(0).max(127), fileId: z.number().int().positive().max(2147483647),
  paid: z.literal(true).optional() });
const welcomeAttachmentReference = richAttachmentReference.omit({ paid: true }).strict().optional();
export type RichAttachmentReference = z.infer<typeof richAttachmentReference>;
const richAttachmentCaption = {
  content: richInline, quotableCaption: z.literal(true).optional(), credit: richInline.optional(),
};
const richMessageBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("buttons"), buttons: z.array(messageActionButton).min(1).max(20),
    align: richButtonAlignment.optional() }),
  z.object({ kind: z.literal("document"), ...richAttachmentCaption, reference: richAttachmentReference, document: documentInfo,
    media: z.enum(["file", "video", "gif", "audio", "voice"]), spoiler: z.boolean(), loop: z.boolean() }),
  z.object({ kind: z.literal("photo"), ...richAttachmentCaption, reference: richAttachmentReference, spoiler: z.boolean(),
    dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }) }),
  z.object({ kind: z.literal("attachment"), ...richAttachmentCaption }),
  z.object({ kind: z.enum(["title", "paragraph", "thinking"]), content: richInline }),
  z.object({ kind: z.literal("heading"), content: richInline, headingSize: richHeadingSize.optional() }),
  z.object({ kind: z.literal("code"), content: richInline, language: richCodeLanguage.optional() }),
  z.object({ kind: z.literal("quote"), content: richInline, continuation: z.array(richInline).max(15).optional(),
    credit: richInline.optional(), expandable: z.literal(true).optional() }),
  z.object({ kind: z.literal("rule") }),
  richMathBlock,
  z.object({ kind: z.literal("list"), items: z.array(z.object({
    label: z.string().max(32), content: richInline, continuation: z.array(richInline).max(15).optional(), checked: z.boolean().optional(),
    number: z.number().int().min(-2147483648).max(2147483647).optional(), numbering: z.enum(["1", "a", "A", "i", "I"]).optional(),
  })).max(64) }),
  z.object({ kind: z.literal("table"), caption: richInline, bordered: z.boolean().optional(),
    striped: z.boolean().optional(), compact: z.boolean().optional(), rows: z.array(z.array(z.object({
      header: z.boolean(), content: richInline, colSpan: z.number().int().min(2).max(16).optional(),
      rowSpan: z.number().int().min(2).max(32).optional(), invisible: z.literal(true).optional(),
      align: z.enum(["left", "center", "right"]).optional(), verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    })).max(16)).max(32) }),
]);
export type RichInline = z.infer<typeof richInline>;
const selectionHtml = z.union([z.literal(true), z.literal("portable")]);
const selectedRichText = z.object({ text: z.string().min(1).max(524288), html: z.string().min(1).max(524288) });
export type SelectedText = string | z.infer<typeof selectedRichText>;
export type RichMessageBlock = z.infer<typeof richMessageBlock>;
const richMessageLayout = z.object({ rtl: z.boolean(), complete: z.boolean(), quoteLayout: z.literal(true).optional(), blocks: z.array(richMessageBlock).max(128) });
export type RichMessageLayout = z.infer<typeof richMessageLayout>;

export const chatAvatarSchema = z.string().min(8).max(8192).regex(/^\/9j\/[A-Za-z0-9+/]+={0,2}$/);
const paidMedia = z.object({
  stars: z.number().int().positive(),
  items: z.array(z.object({ kind: z.enum(["locked", "photo", "video", "unsupported"]),
    preview: chatAvatarSchema.optional(), reference: richAttachmentReference.optional(),
    dimensions: z.object({ width: z.number().int().positive().max(maxPhotoEdge), height: z.number().int().positive().max(maxPhotoEdge) }).optional(),
    mime: z.enum(["video/mp4", "video/webm"]).optional(), startTime: z.number().int().positive().max(2147483647).optional(),
    cover: richAttachmentReference.optional(),
    motion: z.object({ reference: richAttachmentReference, mime: z.enum(["video/mp4", "video/webm"]) }).optional() })).min(1).max(20),
  caption: z.string().max(8192).optional(),
});
export type PaidMedia = z.infer<typeof paidMedia>;

const replyQuote = z.object({ text: z.string().min(1).max(1024), position: z.number().int().min(0).max(65535), rich: z.literal(true).optional() })
  .refine(({ position, rich }) => rich || position <= 4095);
export type ReplyQuote = z.infer<typeof replyQuote>;
const replyQuoteAnchor = replyQuote.safeExtend({
  richEmoji: z.array(customEmojiRange).max(1024).optional() });
export type ReplyQuoteAnchor = z.infer<typeof replyQuoteAnchor>;
export const telegramBirthdate = z.object({
  day: z.number().int().min(1).max(31),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(0).max(9999),
}).refine(({ day, month, year }) => {
  const leap = year === 0 || year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
});
export type TelegramBirthdate = z.infer<typeof telegramBirthdate>;
const profilePhotoId = z.string().regex(/^-?[1-9]\d{0,18}$/);
const galleryPhotoId = z.string().regex(/^(?:current:[0-9a-f]{64}:)?-?[1-9]\d{0,18}$/);
export const messageEffectId = z.string().regex(/^[1-9]\d{0,18}$/)
  .refine((id) => id.length < 19 || id <= "9223372036854775807");
const messageEffectView = z.object({ emoji: z.string().min(1).max(32), animation: z.string().min(1).max(2 * 1024 * 1024).optional() });
export type MessageEffectView = z.infer<typeof messageEffectView>;
const messageEffectChoice = z.object({ id: messageEffectId, emoji: messageEffectView.shape.emoji, premium: z.boolean(), available: z.boolean() });
export type MessageEffectChoice = z.infer<typeof messageEffectChoice>;
const messageSchema = z.object({
  suggestedProfilePhotoId: profilePhotoId.optional(),
  suggestedBirthday: telegramBirthdate.optional(),
  id: z.string(), author: z.string(), time: z.string(), text: z.string(),
  effectId: messageEffectId.optional(),
  timestamp: z.number().int().positive().max(2147483647).optional(),
  links: messageLinks,
  richMessage: richMessageLayout.optional(),
  richEdit: richEdit.optional(),
  checklist: checklist.optional(),
  viaBot: z.string().regex(/^[a-z0-9_]{1,64}$/i).optional(),
  inlineBotKeyboard: z.array(z.array(inlineBotButton).min(1).max(10)).min(1).max(20).optional(),
  widget: z.literal(true).optional(),
  gameTitle: z.string().min(1).max(256).optional(),
  gameArtwork: z.object({ cover: messagePreviewCover.optional(), animation: messagePreviewMedia.optional() }).optional(),
  gameScoreTargetId: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  styles: z.array(styledRange).max(128).optional(),
  outgoing: z.boolean().optional(),
  sender: messageSender.optional(),
  linkPreview: messageLinkPreview.optional(),
  location: messageLocation.optional(),
  contact: sharedContact.optional(),
  canTranslate: z.literal(true).optional(),
  service: z.literal(true).optional(),
  textIsLabel: z.literal(true).optional(),
  pinnedTargetId: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  voiceNote: z.literal(true).optional(),
  profileAudioFileId: profileAudioTrack.shape.fileId.optional(),
  videoNote: z.literal(true).optional(),
  animation: z.literal(true).optional(),
  tgsSticker: z.literal(true).optional(),
  customEmoji: z.array(customEmojiRange).max(128).optional(),
  collectionKind: mediaCollectionKind.optional(),
  canAddToStickerPack: z.literal(true).optional(),
  hasStickerPack: z.literal(true).optional(),
  albumId: z.string().regex(/^-?\d+$/).optional(),
  oneView: z.enum(["photo", "video"]).optional(),
  retained: z.enum(["deleted", "expired"]).optional(),
  isChannelPost: z.boolean().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  viewCount: z.number().int().min(0).max(2147483647).optional(),
  pendingDelivery: z.boolean().optional(),
  failedDelivery: z.object({ retryAt: z.number().int().nonnegative().optional() }).optional(),
  replyTo: z.string().optional(),
  replyFromChat: z.object({ chatId: z.string().regex(/^-?[1-9]\d{0,15}$/), messageId: z.string().regex(/^[1-9]\d{0,15}$/) }).optional(),
  replyTimestamps: mediaTimestampRanges.optional(),
  notePlayed: z.boolean().optional(),
  replyToStory: messageStoryReference.optional(),
  sharedStory: messageStoryReference.optional(),
  replyQuote: z.string().min(1).max(4096).optional(),
  replyQuoteAnchor: replyQuoteAnchor.optional(),
  canQuote: z.literal(true).optional(),
  authorAvatar: z.object({ id: z.string().regex(/^-?[1-9]\d{0,15}$/), user: z.boolean(),
    fileId: z.number().int().positive().optional(), preview: z.string().max(8192).optional() }).optional(),
  forwardedFrom: z.string().max(256).optional(),
  forwardedPost: forwardedPost.optional(),
  forumTopicId: forumTopicId.optional(),
  threadRoot: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  editable: z.boolean().optional(),
  editableCaption: z.boolean().optional(),
  photoEditRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attachmentEdit: z.object({ kind: z.enum(["document", "video"]), revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  canMoveCaption: z.literal(true).optional(),
  edited: z.boolean().optional(),
  editedAt: z.number().int().positive().max(2147483647).optional(),
  channelSignature: z.string().min(1).max(256).optional(),
  document: documentInfo.optional(),
  poll: pollInfo.optional(),
  canStopPoll: z.boolean().optional(),
  reactions: messageReactions.optional(),
  restricted: z.literal(true).optional(),
  hasPhoto: z.boolean().optional(),
  photoDimensions: z.object({
    width: z.number().int().positive().max(maxPhotoEdge),
    height: z.number().int().positive().max(maxPhotoEdge),
  }).optional(),
  photoSpoiler: z.boolean().optional(),
  photoMotion: photoMotion.optional(),
  canSavePhoto: z.literal(true).optional(),
  videoSpoiler: z.literal(true).optional(),
  captionAboveMedia: z.boolean().optional(),
  paidMedia: paidMedia.optional(),
  photoCaption: z.string().optional(),
});
const messageTranslation = messageSchema.pick({ styles: true, links: true }).extend({
  text: z.string().min(1).max(8192), rich: richMessageLayout.optional(),
});
const voiceTranscriptSegment = z.object({ start: z.number().min(0).max(600), text: z.string().min(1).max(8192) });
export const voiceTranscript = z.object({ text: z.string().max(8192), segments: z.array(voiceTranscriptSegment).max(256) });
export type VoiceTranscriptData = z.infer<typeof voiceTranscript>;
export const voiceTranscriptResult = z.union([z.string().max(8192), voiceTranscript]);

export type MessageTranslation = z.infer<typeof messageTranslation>;
const themeAccent = z.string().regex(/^#[0-9a-f]{6}$/);
const emojiThemeName = z.string().min(1).max(32);
const emojiTheme = z.object({ name: emojiThemeName, accent: themeAccent });
export type EmojiTheme = z.infer<typeof emojiTheme>;
const chatThemeView = z.object({ current: emojiThemeName.nullable(), themes: z.array(emojiTheme).max(64) });
export type ChatThemeView = z.infer<typeof chatThemeView>;
const chatBackgroundRevision = z.string().regex(/^[a-f0-9]{64}$/);
const chatBackgroundView = z.object({ revision: chatBackgroundRevision.nullable(), color: themeAccent.optional() });
export type ChatBackgroundView = z.infer<typeof chatBackgroundView>;
const chatBackgroundFill = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color: themeAccent }),
  z.object({ kind: z.literal("linear"), top: themeAccent, bottom: themeAccent, rotation: z.number().int().min(0).max(315).multipleOf(45) }),
  z.object({ kind: z.literal("freeform"), colors: z.array(themeAccent).min(3).max(4) }),
]);
export type ChatBackgroundFill = z.infer<typeof chatBackgroundFill>;
const wallpaperPattern = z.object({ fill: chatBackgroundFill, intensity: z.number().int().min(0).max(100), inverted: z.boolean() });
export type WallpaperPattern = z.infer<typeof wallpaperPattern>;
const chatWallpaperPattern = wallpaperPattern.extend({ revision: chatBackgroundRevision });
export type ChatWallpaperPattern = z.infer<typeof chatWallpaperPattern>;
const chatSchema = z.object({
  themeAccent: themeAccent.optional(),
  backgroundColor: themeAccent.optional(),
  backgroundFill: chatBackgroundFill.optional(),
  backgroundPhotoRevision: chatBackgroundRevision.optional(),
  backgroundPhotoBlurred: z.literal(true).optional(),
  backgroundPattern: chatWallpaperPattern.optional(),
  id: z.string(), name: z.string(), initials: z.string(), color: z.string(), avatarJpeg: chatAvatarSchema.optional(), avatarFileId: z.number().int().positive().optional(),
  folderIds: z.array(z.number().int().positive().max(2147483647)).max(100).optional(),
  pinnedInList: z.literal(true).optional(),
  subtitle: z.string(), unread: z.number().optional(), unreadMentions: z.number().int().positive().max(2147483647).optional(), unreadReactions: z.number().int().positive().max(2147483647).optional(), markedUnread: z.boolean().optional(), archived: z.boolean().optional(), messages: z.array(messageSchema),
});
export const miniAppChatType = z.enum(["users", "bots", "groups", "channels"]);
export type MiniAppChatType = z.infer<typeof miniAppChatType>;
const commonGroupPage = z.object({ chats: z.array(chatSchema).max(20), next: z.string().regex(/^-\d{1,16}$/).nullable() });
export type CommonGroupPage = z.infer<typeof commonGroupPage>;
const chatListSchema = z.union([z.enum(["main", "archive", "saved"]), z.number().int().positive().max(2147483647)]);
export type ChatList = z.infer<typeof chatListSchema>;
const markableChatList = z.union([z.enum(["main", "archive"]), z.number().int().positive().max(2147483647)]);
const markReadResult = z.object({ read: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type MarkReadResult = z.infer<typeof markReadResult>;
const unreadTotals = z.object({ total: z.number().int().nonnegative(), unmuted: z.number().int().nonnegative() });
const unreadListCount = z.object({
  list: z.union([z.enum(["main", "archive"]), z.number().int().positive().max(2147483647)]),
  chats: unreadTotals.optional(),
  messages: unreadTotals.optional(),
});
export type UnreadListCount = z.infer<typeof unreadListCount>;
const folderIcon = z.enum(["All", "Unread", "Unmuted", "Bots", "Channels", "Groups", "Private", "Custom", "Setup",
  "Cat", "Crown", "Favorite", "Flower", "Game", "Home", "Love", "Mask", "Party", "Sport", "Study",
  "Trade", "Travel", "Work", "Airplane", "Book", "Light", "Like", "Money", "Note", "Palette"]);
export const folderIconNames = folderIcon.options;
export type FolderIcon = z.infer<typeof folderIcon>;
const folderColor = z.number().int().min(-1).max(6);
const folderSchema = z.object({ id: z.number().int().positive(), title: z.string(), color: folderColor.optional(), icon: folderIcon.optional() });
export type TelegramFolder = z.infer<typeof folderSchema>;
const folderPosition = z.number().int().nonnegative().max(100);
const folderLayoutSchema = z.object({ folders: z.array(folderSchema), mainPosition: folderPosition.optional() });
export type FolderLayout = z.infer<typeof folderLayoutSchema>;
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
  chats: z.array(z.object({ id: folderInviteChatId, title: z.string().min(1).max(256),
    channelUsername: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional() })).max(200) });
export type FolderInvite = z.infer<typeof folderInvite>;
const managedFolderInvite = z.object({ url: z.string().max(128), name: z.string().max(128), chatCount: z.number().int().nonnegative() });
const folderInviteEditor = z.object({ token: recommendedFolderToken,
  choices: z.array(folderShareChat).max(200), selected: z.array(folderInviteChatId).max(200) });
export type FolderInviteEditor = z.infer<typeof folderInviteEditor>;
export type ManagedFolderInvite = z.infer<typeof managedFolderInvite>;
const folderId = z.number().int().positive().max(2147483647);
const folderEditor = folderDraft.extend({ shareable: z.boolean(), canEditColor: z.boolean().optional(), revision: recommendedFolderToken.optional() });
export type FolderEditor = z.infer<typeof folderEditor>;
const folderTagsState = z.object({ enabled: z.boolean(), editable: z.boolean() });
export type FolderTagsState = z.infer<typeof folderTagsState>;
const folderMembershipMode = z.enum(["include", "exclude", "automatic"]);
const folderMembership = z.object({ id: folderId, mode: folderMembershipMode, shareable: z.boolean() });
export type FolderMembership = z.infer<typeof folderMembership>;

const chatId = z.string().regex(/^-?\d{1,16}$/);
export const conversationLocation = z.object({
  id: chatId.regex(/^-?[1-9]\d{0,15}$/u), list: chatListSchema, topicId: forumTopicId.optional(),
});
export type ConversationLocation = z.infer<typeof conversationLocation>;
const resumedConversation = z.object({ chat: chatSchema, list: chatListSchema, topic: forumTopic.optional() });
export type ResumedConversation = z.infer<typeof resumedConversation>;
const avatarVersion = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const userPresence = z.discriminatedUnion("state", [
  z.object({ state: z.literal("online"), expires: z.number().int().positive().max(2147483647) }),
  z.object({ state: z.literal("offline"), lastSeen: z.number().int().positive().max(2147483647) }),
  z.object({ state: z.enum(["recently", "week", "month", "bot", "unavailable"]) }),
]);
export type UserPresence = z.infer<typeof userPresence>;
const onlineMemberCount = z.number().int().positive().max(2147483647).nullable();
export const groupOnlineChannel = "telegram-group-online";
export const groupOnlineEvent = z.object({ chatId, online: onlineMemberCount });
export type GroupOnlineEvent = z.infer<typeof groupOnlineEvent>;
export const peerPresenceChannel = "telegram-peer-presence";
export const peerPresenceEvent = z.object({ chatId, presence: userPresence });
export type PeerPresenceEvent = z.infer<typeof peerPresenceEvent>;
export const chatActivityChannel = "telegram-chat-activity";
export const chatActivitySchema = z.object({
  chatId, topicId: forumTopicId.optional(), sender: messageSender,
  activity: z.enum(["typing", "voice", "video", "uploading", "cancel"]),
  progress: z.number().int().min(0).max(100).optional(),
});
export type ChatActivity = z.infer<typeof chatActivitySchema>;
const recordingActivity = z.enum(["voice", "video", "cancel"]);
export type RecordingActivity = z.infer<typeof recordingActivity>;
export const messageNotificationChannel = "telegram-message-notification";
export const deviceSignInsChangedChannel = "telegram-device-sign-ins-changed";
export const privateCallChangedChannel = "telegram-private-call-changed";
export const privateCallVideo = { width: 1280, height: 720, frameRate: 24, maxJpegBytes: 384 * 1024 } as const;

const privateCall = z.object({
  id: z.number().int().positive().max(2147483647).optional(),
  name: z.string().min(1).max(256), outgoing: z.boolean(), video: z.boolean(), muted: z.boolean(),
  camera: z.boolean(), cameraUnavailable: z.boolean(),
  frameTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  cameraTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  phase: z.enum(["incoming", "calling", "connecting", "active", "ending", "failed", "ended"]),
  emojis: z.array(z.string().max(16)).max(4),
});
const privateCallStatus = z.object({ available: z.boolean(), call: privateCall.nullable(), frameRoute: z.string().optional() });
export type PrivateCall = z.infer<typeof privateCall>;
export type PrivateCallStatus = z.infer<typeof privateCallStatus>;
const privateCallAction = z.enum(["accept", "accept-video", "end", "mute", "unmute", "camera-on", "camera-off", "dismiss"]);
export type PrivateCallAction = z.infer<typeof privateCallAction>;
export const miniAppClosedChannel = "telegram-mini-app-closed";
export const miniAppClosedEvent = z.object({ session: z.uuid() });
export const messageNotificationSchema = z.object({
  chatId, messageId: z.string().regex(/^[1-9]\d{0,15}$/), topicId: forumTopicId.optional(),
  key: z.string().max(48), preview: z.string().max(160).optional(), canMarkRead: z.literal(false).optional(),
  pendingMessage: z.literal(true).optional(),
});
export type MessageNotification = z.infer<typeof messageNotificationSchema>;
export function canRefreshMessageNotification(previous: MessageNotification, next: MessageNotification) {
  return previous.key === next.key && previous.chatId === next.chatId && previous.messageId === next.messageId
    && !next.pendingMessage
    && (previous.pendingMessage || (previous.topicId === next.topicId && previous.canMarkRead === next.canMarkRead));
}
export const messageNotificationEvent = z.union([
  z.object({ removed: z.array(messageNotificationSchema.shape.key).min(1).max(128) }),
  z.object({ refreshed: messageNotificationSchema }),
  messageNotificationSchema,
]);
export type MessageNotificationEvent = z.infer<typeof messageNotificationEvent>;
export const messageNotificationDelivery = z.object({ connectionId: z.uuid(), event: messageNotificationEvent });
export const messagesDeletedChannel = "telegram-messages-deleted";
export const messagesDeletedSchema = z.object({
  connectionId: z.uuid().optional(),
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
  avatarJpeg: chatAvatarSchema.optional(), avatarFileId: z.number().int().positive().max(2147483647).optional(),
});
export type MessageViewer = z.infer<typeof messageViewer>;

export const initialMessageContextLimit = 21;
const contextDirection = z.enum(["older", "newer"]);
export type ContextDirection = z.infer<typeof contextDirection>;

const messagePinMode = z.enum(["notify", "self"]);
export type MessagePinMode = z.infer<typeof messagePinMode>;

const messageReference = z.object({ id: chatId, messageId: z.string().regex(/^[1-9]\d{0,15}$/) });
export const historyMessageChangedChannel = "telegram-history-message-changed";
export const historyMessageChangedEvent = messageReference.extend({ connectionId: z.uuid() });
export type HistoryMessageChanged = z.infer<typeof messageReference>;
const channelInboxReply = z.union([messageReference.shape.messageId,
  z.strictObject({ messageId: messageReference.shape.messageId, quote: replyQuote })]);
export type ChannelInboxReply = z.infer<typeof channelInboxReply>;
const channelInboxMessageReference = messageReference.extend({ inboxId: chatId, topicId: chatId });
export type ChannelInboxMessageReference = z.infer<typeof channelInboxMessageReference>;
const channelInboxTopicReference = channelInboxMessageReference.omit({ messageId: true });
const copySelection = z.array(messageReference.shape.messageId).min(1).max(100);
const channelInboxSelection = channelInboxTopicReference.extend({ ids: copySelection });
export type ChannelInboxSelection = z.infer<typeof channelInboxSelection>;
const messageBatch = z.array(messageReference.shape.messageId).min(2).max(100);
const channelInboxMessageBatch = channelInboxTopicReference.extend({ ids: messageBatch });
export type ChannelInboxMessageBatch = z.infer<typeof channelInboxMessageBatch>;
export const channelInboxMessageChannel = "telegram-channel-inbox-message";
export const channelInboxMessageEvent = z.discriminatedUnion("kind", [
  messageReference.extend({ kind: z.literal("arrived"), topicId: messageReference.shape.messageId }),
  messageReference.extend({ kind: z.literal("changed") }),
]);
export type ChannelInboxMessageEvent = z.infer<typeof channelInboxMessageEvent>;
const queueFileId = z.number().int().positive().max(2147483647);
const queueBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const downloadQueueFilter = z.enum(["all", "active", "completed"]);
export type DownloadQueueFilter = z.infer<typeof downloadQueueFilter>;
export const downloadQueueAction = z.enum(["pause", "resume", "remove"]);
export type DownloadQueueAction = z.infer<typeof downloadQueueAction>;
export const downloadQueueCounts = z.object({ active: queueBytes, paused: queueBytes, completed: queueBytes });
export type DownloadQueueCounts = z.infer<typeof downloadQueueCounts>;
export const downloadActivityChannel = "telegram-download-activity";
export const downloadActivityEvent = z.object({ connectionId: z.uuid(), counts: downloadQueueCounts });
export const downloadQueueProgress = z.object({ totalBytes: queueBytes, downloadedBytes: queueBytes })
  .refine(({ totalBytes, downloadedBytes }) => downloadedBytes <= totalBytes);
export type DownloadQueueProgress = z.infer<typeof downloadQueueProgress>;
export const downloadProgressChannel = "telegram-download-progress";
export const downloadProgressEvent = z.object({ connectionId: z.uuid(), progress: downloadQueueProgress });
export type DownloadQueueSnapshot = DownloadQueueCounts & { progress?: DownloadQueueProgress };
const downloadQueuePage = z.object({
  entries: z.array(z.object({ reference: messageReference.extend({ topicId: forumTopicId.optional() }), fileId: queueFileId, name: z.string().min(1).max(180),
    total: queueBytes, downloaded: queueBytes, state: z.enum(["waiting", "downloading", "paused", "completed"]), thumbnail: z.literal(true).optional(),
  })).max(30),
  next: z.string().min(1).max(1024).nullable(),
  counts: downloadQueueCounts.optional(),
});
export type DownloadQueuePage = z.infer<typeof downloadQueuePage>;
export const chatDiscoveryCursor = z.object({ chatId, before: messageReference.shape.messageId.optional() }).strict();
export type ChatDiscoveryCursor = z.infer<typeof chatDiscoveryCursor>;
const accountHistoryGrants = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,15}$/),
  chatIds: z.array(chatId),
});
const accountHistoryGrantList = z.array(accountHistoryGrants)
  .refine((entries) => new Set(entries.map(({ accountId }) => accountId)).size === entries.length);
export const agentHistoryGrants = z.union([accountHistoryGrantList, accountHistoryGrants.transform((entry) => [entry])]);
export type AccountHistoryGrant = z.infer<typeof accountHistoryGrants>;

const uploadRejection = z.enum(["legacy_tdlib", "premium_required", "file_too_large", "reply_unavailable", "video_preparation_failed", "media_preparation_failed"]);
export type UploadRejection = z.infer<typeof uploadRejection>;

const mediaReply = z.object({ messageId: z.string().regex(/^[1-9]\d{0,15}$/), quote: replyQuote.optional(), externalReplyChatId: chatId.optional(),
  drawnPhoto: z.literal(true).optional() });
export type MediaReply = z.infer<typeof mediaReply>;
export type AttachmentReply = string | MediaReply;

export const scheduleRepeatPeriods = [86400, 604800, 1209600, 2592000, 7862400, 15724800, 31536000] as const;
const scheduleRepeatPeriod = z.literal(scheduleRepeatPeriods);
export type ScheduleRepeatPeriod = z.infer<typeof scheduleRepeatPeriod>;

const editLinks = z.object({ original: draftLinks, replacement: draftLinks });
export type EditLinks = z.infer<typeof editLinks>;
const editCustomEmoji = z.object({ original: draftCustomEmoji, replacement: draftCustomEmoji });
export type EditCustomEmoji = z.infer<typeof editCustomEmoji>;
const postingSenderKey = z.union([sendAsKey, z.literal("account")]);
const textDelivery = z.object({
  effect: messageEffectId.optional(),
  expectedPostingSender: postingSenderKey.optional(),
  silent: z.boolean().optional(),
  paidStars: z.number().int().positive().max(2147483647).optional(),
  linkPreview: z.boolean().optional(),
  linkPreviewAbove: z.literal(true).optional(),
  linkPreviewUrl: messageLinkPreview.shape.url.optional(),
  quote: replyQuote.optional(),
  externalReplyChatId: chatId.optional(),
  styles: z.array(styledRange).max(128).optional(),
  links: draftLinks.optional(),
  customEmoji: draftCustomEmoji.optional(),
  at: z.number().int().positive().max(2147483647).optional(),
  whenOnline: z.literal(true).optional(),
  repeatEvery: scheduleRepeatPeriod.optional(),
}).refine(({ at, whenOnline, repeatEvery }) => (at === undefined || !whenOnline) && (repeatEvery === undefined || at !== undefined));
export type TextDelivery = z.infer<typeof textDelivery>;
const checklistLine = z.string().trim().min(1).max(1024).refine((text) => !/[\r\n]/.test(text));
export const checklistDraft = z.object({
  title: checklistLine, tasks: z.array(checklistLine).min(1).max(100),
  othersCanAdd: z.boolean(), othersCanComplete: z.boolean(),
});
export type ChecklistDraft = z.infer<typeof checklistDraft>;
export const checklistEdit = checklistDraft.omit({ tasks: true }).extend({
  tasks: z.array(z.object({ id: checklistTaskId, text: checklistLine })).min(1).max(100),
  removed: z.array(z.object({ id: checklistTaskId, done: z.boolean() })).max(99).optional(),
});
export type ChecklistEdit = z.infer<typeof checklistEdit>;
const checklistLimits = z.object({ title: z.number().int().min(1).max(1024),
  task: z.number().int().min(1).max(1024), count: z.number().int().min(1).max(100) });
export type ChecklistLimits = z.infer<typeof checklistLimits>;
const checklistAvailability = z.union([
  z.object({ state: z.literal("ready"), limits: checklistLimits }),
  z.object({ state: z.enum(["premium_required", "unavailable"]) }),
]);
export type ChecklistAvailability = z.infer<typeof checklistAvailability>;
const mediaDelivery = z.object({ silent: textDelivery.shape.silent, at: textDelivery.shape.at });
export type MediaDelivery = z.infer<typeof mediaDelivery>;
const onlineMediaDeliveryFields = mediaDelivery.extend({ whenOnline: textDelivery.shape.whenOnline });
const forwardBatchDelivery = onlineMediaDeliveryFields.strict().refine(({ at, whenOnline }) => at === undefined || !whenOnline);
const forwardDelivery = onlineMediaDeliveryFields.extend({
  effect: textDelivery.shape.effect,
  repeatEvery: textDelivery.shape.repeatEvery,
}).strict().refine(({ at, whenOnline, repeatEvery }) => (at === undefined || !whenOnline) && (repeatEvery === undefined || at !== undefined));
export type ForwardDelivery = z.infer<typeof forwardDelivery>;
const attachmentDeliveryFields = onlineMediaDeliveryFields.extend({ paidStars: textDelivery.shape.paidStars });
const attachmentSendDelivery = attachmentDeliveryFields.extend({ effect: textDelivery.shape.effect })
  .refine(({ at, paidStars, effect, whenOnline }) => (at === undefined || !whenOnline)
    && (paidStars === undefined || (at === undefined && !whenOnline && effect === undefined)));
export type AttachmentSendDelivery = z.infer<typeof attachmentSendDelivery>;
export const maxPaidAlbumStars = 1_000_000;

const topicDelivery = z.object({ expectedPostingSender: textDelivery.shape.expectedPostingSender, links: textDelivery.shape.links, customEmoji: textDelivery.shape.customEmoji, silent: textDelivery.shape.silent, linkPreview: textDelivery.shape.linkPreview, linkPreviewAbove: textDelivery.shape.linkPreviewAbove, linkPreviewUrl: textDelivery.shape.linkPreviewUrl, at: textDelivery.shape.at, repeatEvery: textDelivery.shape.repeatEvery,
  externalReplyChatId: textDelivery.shape.externalReplyChatId })
  .refine(({ at, repeatEvery }) => repeatEvery === undefined || at !== undefined);
export type TopicDelivery = z.infer<typeof topicDelivery>;
const scheduledTime = z.number().int().positive().max(2147483647);
const scheduledContentRevision = z.string().regex(/^[a-f0-9]{64}$/);
const scheduledEdit = z.object({ revision: scheduledContentRevision, topicId: forumTopicId.optional() });
export type ScheduledEdit = z.infer<typeof scheduledEdit>;
const scheduledMessage = z.object({ id: chatId, albumId: messageSchema.shape.albumId, text: z.string().max(8192),
  revision: scheduledContentRevision.optional(), editable: messageSchema.optional(),
  styles: messageSchema.shape.styles, links: messageSchema.shape.links, customEmoji: messageSchema.shape.customEmoji, media: messageSchema.optional(), at: scheduledTime.optional(), whenOnline: z.literal(true).optional(), repeatEvery: scheduledTime.optional() });
export type ScheduledMessage = z.infer<typeof scheduledMessage>;
const albumSelection = z.object({
  id: messageSchema.shape.albumId.unwrap(),
  members: z.array(z.string().regex(/^[1-9]\d{0,15}$/)).min(2).max(10),
});
export type ScheduledAlbumCancellation = z.infer<typeof albumSelection>;
export type ForwardAlbum = ScheduledAlbumCancellation;

const sendResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sent"), message: messageSchema, album: z.array(messageSchema).min(2).max(10).optional() }),
  z.object({ state: z.literal("failed"), uploadRejection: uploadRejection.optional() }),
  z.object({ state: z.literal("unknown") }),
]);
export type SendResult = z.infer<typeof sendResult>;
export function quickReplyMediaKind(filename: string) {
  if (isVideoAttachmentName(filename)) return "video";
  if (isAudioAttachmentName(filename)) return "audio";
  if (isGifAttachmentName(filename)) return "animation";
  if (/\.(ogg|opus)$/i.test(filename)) return "voice";
}

export function quickReplyVideoNoteFormat(filename: string) {
  if (/\.mp4$/i.test(filename)) return "mp4";
  if (/\.webm$/i.test(filename)) return "webm";
}

export function validQuickReplyAttachmentKind(input: {
  filename: string; video?: true; audio?: true; animation?: true; voice?: true; videoNote?: true; media?: MediaSendOptions;
}) {
  if (input.media && !input.video && !input.animation) return false;
  const kinds = (["video", "audio", "animation", "voice"] as const).filter((kind) => input[kind]);
  if (input.videoNote) return !kinds.length && !!quickReplyVideoNoteFormat(input.filename);
  return !kinds.length || (kinds.length === 1 && quickReplyMediaKind(input.filename) === kinds[0]);
}

const streamedMediaUpload = z.object({
  filename: z.string().min(1).max(255),
  caption: z.string().trim().max(1024),
  styles: textDelivery.shape.styles,
  links: textDelivery.shape.links,
  size: z.number().int().positive().max(maxDocumentBytes),
  video: z.literal(true).optional(),
  audio: z.literal(true).optional(),
  animation: z.literal(true).optional(),
  voice: z.literal(true).optional(),
  videoNote: z.literal(true).optional(),
  media: mediaSendOptions.optional(),
}).refine(validQuickReplyAttachmentKind).refine((input) => !input.videoNote
  || (input.size <= maxVideoNoteBytes && !input.caption && !input.styles?.length && !input.links?.length));
export const quickReplyDocumentUpload = streamedMediaUpload.safeExtend({
  id: z.number().int().positive().max(2147483647).optional(), name: z.string().trim().min(1).max(128),
});
export type QuickReplyDocumentUpload = z.infer<typeof quickReplyDocumentUpload>;
export const welcomeMediaUpload = streamedMediaUpload.safeExtend({
  id: chatId,
  replace: z.object({ messageId: z.number().int().positive().max(2147483647), revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type WelcomeMediaUpload = z.infer<typeof welcomeMediaUpload>;
export const quickReplyDocumentResult = z.object({ state: z.enum(["submitted", "changed", "failed", "unknown"]) });
export type QuickReplyDocumentResult = z.infer<typeof quickReplyDocumentResult>;
const pollPlace = z.object({ point: locationPoint, venue: quickReplyVenue.optional() });
export type PollPlace = z.infer<typeof pollPlace>;

export const pollDraft = z.object({
  question: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1024).optional(),
  options: z.array(pollOptionText).min(1).max(10)
    .refine((options) => new Set(options.map((option) => option.normalize("NFC").toLowerCase())).size === options.length),
  optionStickers: z.array(z.object({ index: z.number().int().min(0).max(9),
    packId: z.string().regex(/^-?[1-9]\d{0,18}$/), fileId: pollFileId })).min(1).max(10).optional(),
  optionLinks: z.array(z.object({ index: z.number().int().min(0).max(9), url: pollOptionLink })).min(1).max(10).optional(),
  questionPlace: pollPlace.optional(),
  questionPhoto: photoBase64.optional(),
  optionPhotos: z.array(z.object({ index: z.number().int().min(0).max(9), base64: photoBase64 })).min(1).max(10).optional(),
  optionPlaces: z.array(pollPlace.extend({ index: z.number().int().min(0).max(9) })).min(1).max(10).optional(),
  multiple: z.boolean(),
  anonymous: z.boolean().optional(),
  allowSuggestions: z.literal(true).optional(),
  membersOnly: z.literal(true).optional(),
  countryCodes: pollCountryCodes.optional(),
  shuffle: z.boolean().optional(),
  disableRevoting: z.boolean().optional(),
  durationMinutes: z.number().int().min(1).max(Math.floor(2147483647 / 60)).optional(),
  hideResultsUntilClosed: z.boolean().optional(),
  quiz: z.object({
    correctIndexes: z.array(z.number().int().nonnegative()).min(1).max(10)
      .refine((indexes) => new Set(indexes).size === indexes.length),
    explanation: z.string().trim().max(200).refine((text) => text.split("\n").length <= 3),
    place: pollPlace.optional(),
    photo: photoBase64.optional(),
  }).optional(),
}).refine(({ optionLinks = [], optionPlaces = [], optionPhotos = [], optionStickers = [], options }) => {
  const indexes = [...optionLinks, ...optionPlaces, ...optionPhotos, ...optionStickers].map(({ index }) => index);
  return indexes.every((index) => index < options.length) && new Set(indexes).size === indexes.length;
})
.refine(({ questionPlace, questionPhoto, quiz }) => !(questionPlace && questionPhoto) && !(quiz?.place && quiz?.photo))
.refine(({ allowSuggestions, anonymous, quiz }) => !allowSuggestions || anonymous === false && !quiz)
.refine(({ hideResultsUntilClosed, durationMinutes }) => !hideResultsUntilClosed || durationMinutes !== undefined)
.refine(({ quiz, options, multiple }) => !quiz || (
  quiz.correctIndexes.every((index) => index < options.length) && multiple === (quiz.correctIndexes.length > 1)
));
const pollSendResult = z.union([sendResult, z.object({ state: z.literal("unavailable") })]);
export type PollDraft = z.infer<typeof pollDraft>;
const livePhotoStill = z.union([photoBase64, z.object({ heicBytes: z.number().int().positive().max(maxOriginalPhotoBytes) })]);
const pollUploadPart = z.object({
  slot: pollAttachmentReference.shape.slot,
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(maxTelegramUploadBytes),
});
const pollUploadFile = z.discriminatedUnion("kind", [
  pollUploadPart.extend({ kind: z.enum(["document", "video", "audio", "gif"]) }),
  pollUploadPart.extend({ kind: z.literal("livePhoto"), photo: livePhotoStill }),
]).refine(({ slot, kind, name }) => {
  if (typeof slot === "number" && (kind === "audio" || kind === "document")) return false;
  if (kind === "video" || kind === "livePhoto") return isVideoAttachmentName(name);
  if (kind === "audio") return /\.(?:mp3|m4a)$/i.test(name);
  return kind === "document" || /\.gif$/i.test(name);
});
export type PollUploadFile = z.infer<typeof pollUploadFile>;
export type PollSendResult = z.infer<typeof pollSendResult>;
export type PollSender = (id: string, draft: PollDraft, topic?: ForumTopicTarget, reply?: MediaReply) => Promise<PollSendResult>;
export const telegramUploadProgress = z.object({
  uploaded: z.number().int().nonnegative(), total: z.number().int().positive(),
}).refine(({ uploaded, total }) => uploaded <= total);
export type TelegramUploadProgress = z.infer<typeof telegramUploadProgress>;
export type DocumentSender = (id: string, file: File, caption: string,
  progress: (bytes: number, canCancel?: boolean, telegram?: TelegramUploadProgress) => void, signal: AbortSignal, topic?: ForumTopicTarget, replyTo?: AttachmentReply, video?: true, options?: DocumentSendOptions, delivery?: AttachmentSendDelivery
) => Promise<SendResult | { state: "cancelled" }>;

export const notificationScope = z.enum(["private", "groups", "channels"]);
export type NotificationScope = z.infer<typeof notificationScope>;
export const reactionNotificationAudience = z.enum(["none", "contacts", "all"]);
export type ReactionNotificationAudience = z.infer<typeof reactionNotificationAudience>;
export const chatMutePeriods = [3600, 28800, 86400, 604800] as const;
export const maxChatMuteSeconds = 365 * 86400;
export const chatMutePeriod = z.number().int().min(60).max(maxChatMuteSeconds);
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
const notificationExceptionPage = z.object({
  chats: chatSchema.pick({ id: true, name: true }).array(),
  nextOffset: z.number().int().nullable(),
});
export type NotificationExceptionPage = z.infer<typeof notificationExceptionPage>;
const chatNotificationState = z.object({ mode: chatNotificationMode, muteUntil: z.number().int().positive().optional(),
  preview: chatNotificationOverride.optional(), pinned: chatNotificationOverride.optional(), mentions: chatNotificationOverride.optional(),
  stories: chatNotificationOverride.optional(), storyPoster: chatNotificationOverride.optional(),
  sound: notificationSound.optional(), storySound: notificationSound.optional(),
  savedSounds: savedNotificationSounds.optional() });
export type ChatNotificationState = z.infer<typeof chatNotificationState>;
const postingPermissions = z.object({
  text: z.boolean(), photo: z.boolean(), document: z.boolean(),
  canBanChatSenders: z.literal(true).optional(),
  paidStars: textDelivery.shape.paidStars,
  postingSender: z.string().min(1).max(256).optional(),
  postingSenderKey: postingSenderKey.optional(),
  join: z.enum(["join", "request"]).optional(),
  poll: z.boolean().optional(),
  voice: z.boolean().optional(),
  audio: z.boolean().optional(),
  videoNote: z.boolean().optional(),
  video: z.boolean().optional(),
  otherMedia: z.boolean().optional(),
});
const chatJoinResult = z.enum(["joined", "subscribed", "requested", "verification_required", "refused", "unknown"]);
export type ChatJoinResult = z.infer<typeof chatJoinResult>;
const instantViewJoinTarget = z.object({
  id: chatId, name: z.string().min(1).max(256), mode: postingPermissions.shape.join.unwrap(),
});
export type InstantViewJoinTarget = z.infer<typeof instantViewJoinTarget>;
const instantViewChatLinkReference = z.object({ url: messageLinkPreview.shape.url, target: z.string().url().max(128) });
const inviteSubscriptionPricing = z.object({ stars: z.number().int().positive(), period: z.number().int().positive().max(2147483647) });
const inviteTarget = z.object({
  title: z.string().min(1).max(256), kind: z.enum(["Group", "Channel"]),
  mode: z.enum(["join", "request", "subscription"]), chatId: chatId.optional(),
  subscription: inviteSubscriptionPricing.extend({ reusable: z.boolean(), payable: z.boolean() }).optional(),
});
const invitePreview = inviteTarget.extend({ memberCount: z.number().int().nonnegative().optional(), description: z.string().max(1024).optional() });
export type InviteTarget = z.infer<typeof inviteTarget>;
export type InvitePreview = z.infer<typeof invitePreview>;
export type PostingPermissions = z.infer<typeof postingPermissions>;

export const messageSearchFilter = z.enum(["photoVideo", "photo", "video", "document", "audio", "voiceVideoNotes", "gif", "link", "pinned", "mentions", "unreadMentions", "unreadReactions"]);
export const channelInboxSearchFilter = messageSearchFilter.exclude(["mentions", "unreadMentions", "unreadReactions"]);
export type ChannelInboxSearchFilter = z.infer<typeof channelInboxSearchFilter>;
export const sharedContentFilter = z.enum(["photoVideo", "document", "link", "audio", "voiceVideoNotes", "gif"]);
const sharedContentCounts = z.partialRecord(sharedContentFilter, z.number().int().nonnegative().max(2147483647));
export type SharedContentCounts = z.infer<typeof sharedContentCounts>;
export type MessageSearchFilter = z.infer<typeof messageSearchFilter>;
export const savedSourceFilter = z.enum(["photo", "video", "document", "audio", "voiceVideoNotes", "gif", "link", "pinned"]);
export type SavedSourceFilter = z.infer<typeof savedSourceFilter>;
const savedTagType = z.union([
  z.object({ kind: z.literal("emoji"), emoji: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal("custom"), id: z.string().regex(/^-?[1-9]\d{0,19}$/) }),
]);
export type SavedTagType = z.infer<typeof savedTagType>;
export const savedTag = z.object({ type: savedTagType, label: z.string().max(128), count: z.number().int().nonnegative() });
export type SavedTag = z.infer<typeof savedTag>;

const unreadActivityFilter = z.enum(["unreadMentions", "unreadReactions"]);
export type UnreadActivityFilter = z.infer<typeof unreadActivityFilter>;

export function searchRequiresEmptyQuery(filter?: MessageSearchFilter): filter is UnreadActivityFilter {
  return filter === "unreadMentions" || filter === "unreadReactions";
}

const migrationChat = z.object({ id: chatId, title: z.string().min(1).max(256) });
const chatMigration = z.object({ group: migrationChat.optional() });
const historyPage = z.object({ messages: z.array(messageSchema), before: chatId.nullable(), after: messageReference.shape.messageId.optional(), openAt: messageReference.shape.messageId.optional(), draft: syncedDraft.optional(), readInbox: z.number().int().nonnegative().optional(), unreadCount: z.number().int().nonnegative().optional(), readOutbox: z.number().int().nonnegative().optional(),
  predecessor: migrationChat.optional(),
  migration: chatMigration.optional(),
});
const savedSourceId = z.string().regex(/^-?[1-9]\d{0,15}$/);
const savedSource = z.object({ id: savedSourceId, title: z.string().min(1).max(256), pinned: z.boolean(), chatId: chatId.optional() });
const savedSourcePage = z.object({ sources: z.array(savedSource).max(40), next: z.number().int().nonnegative().nullable() });
export type SavedSourcePage = z.infer<typeof savedSourcePage>;
export type HistoryPage = z.infer<typeof historyPage>;
const channelInboxTopic = z.object({ id: chatId, name: z.string().min(1).max(256),
  unread: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), markedUnread: z.boolean(),
  readInbox: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
export type ChannelInboxTopic = z.infer<typeof channelInboxTopic>;
const channelInboxReadState = channelInboxTopic.pick({ unread: true, markedUnread: true, readInbox: true });
export type ChannelInboxReadState = z.infer<typeof channelInboxReadState>;
const channelInboxTopics = z.object({
  topics: z.array(channelInboxTopic).max(30), next: z.number().int().nonnegative().max(2147483647).nullable(),
});
export type ChannelInboxTopics = z.infer<typeof channelInboxTopics>;
export const channelInboxTopicsChangedChannel = "telegram-channel-inbox-topics";
export const channelInboxTopicsChanged = z.object({ id: chatId });
const channelInboxTopicsSnapshot = channelInboxTopics.extend({
  topics: z.array(channelInboxTopic),
  selected: channelInboxReadState.optional(),
});
const channelInboxBan = z.object({
  userId: chatId.regex(/^[1-9]\d{0,15}$/), name: z.string().min(1).max(256),
  role: z.enum(["banned", "left", "member", "restricted"]),
  expires: z.number().int().nonnegative().max(2147483647).optional(),
});
export type ChannelInboxBan = z.infer<typeof channelInboxBan>;
const globalSearchCursor = z.union([z.string().min(1).max(2048), z.object({
  date: z.number().int().nonnegative(), chatId, messageId: chatId,
})]);
const globalSearchMode = z.enum(["messages", "public", "media"]);
export type GlobalSearchMode = z.infer<typeof globalSearchMode>;
export const globalSearchMediaFilter = messageSearchFilter.extract(["photoVideo", "photo", "video", "document", "audio", "voiceVideoNotes", "gif", "link"]);
export type GlobalSearchMediaFilter = z.infer<typeof globalSearchMediaFilter>;
export const messageSearchDateRange = z.object({
  from: z.number().int().nonnegative().max(2147483647).optional(),
  until: z.number().int().positive().max(2147483648).optional(),
}).strict().refine(({ from, until }) => (from !== undefined || until !== undefined)
  && (from === undefined || until === undefined || from < until), "Invalid search dates");
export type MessageSearchDateRange = z.infer<typeof messageSearchDateRange>;
export const globalSearchChatType = z.enum(["private", "group", "channel"]);
export const globalSearchChatList = z.enum(["main", "archive"]);
export const globalSearchScope = z.object({ chatType: globalSearchChatType.optional(), list: globalSearchChatList.optional(),
  communityId: chatId.optional() }).strict()
  .refine(({ chatType, list, communityId }) => communityId ? !chatType && !list : Boolean(chatType || list), "Choose a chat scope");
export type GlobalSearchScope = z.infer<typeof globalSearchScope>;
const globalSearchPage = z.object({
  hits: z.array(z.object({ chat: chatSchema, message: messageSchema, thumbnail: z.literal(true).optional(),
    thumbnailFileId: z.number().int().positive().optional() })).max(30),
  next: globalSearchCursor.nullable(),
});
export type GlobalSearchPage = z.infer<typeof globalSearchPage>;
const publicDiscoveryDirectoryMode = z.enum(["apps", "channels"]);
const publicDiscoveryMode = z.enum([...publicDiscoveryDirectoryMode.options, "groups"]);
export type PublicDiscoveryDirectoryMode = z.infer<typeof publicDiscoveryDirectoryMode>;
export type PublicDiscoveryMode = z.infer<typeof publicDiscoveryMode>;
const publicDiscoveryOffset = z.string().min(1).max(512);
const publicDiscoveryPage = z.object({
  recent: z.array(chatSchema).max(15),
  results: z.array(chatSchema).max(50),
  next: publicDiscoveryOffset.nullable(),
});
export type PublicDiscoveryPage = z.infer<typeof publicDiscoveryPage>;

const messageSearchPage = historyPage.pick({ messages: true, before: true });
export type MessageSearchPage = z.infer<typeof messageSearchPage>;

const photoSize = z.enum(["preview", "large"]);
export type PhotoSize = z.infer<typeof photoSize>;

const photoSchema = z.object({
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  hasLarger: z.boolean().optional(),
  base64: photoBase64,
});
export type TelegramPhoto = z.infer<typeof photoSchema>;
const wallpaperPatternAsset = z.object({ format: z.enum(["png", "svg"]), base64: photoBase64 });
export type WallpaperPatternAsset = z.infer<typeof wallpaperPatternAsset>;
const wallpaperLinkPreview = z.union([
  z.object({ revision: chatBackgroundRevision, photo: photoSchema, blurred: z.boolean() }),
  z.object({ revision: chatBackgroundRevision, fill: chatBackgroundFill }),
  z.object({ revision: chatBackgroundRevision, pattern: wallpaperPattern, asset: wallpaperPatternAsset }),
]);
export type WallpaperLinkPreview = z.infer<typeof wallpaperLinkPreview>;
const photoDragTicket = z.object({ name: documentInfo.shape.name, url: z.string().startsWith("/api/v1/plugins/"),
  validForMs: z.number().int().positive().max(60_000) });
export type PhotoDragTicket = z.infer<typeof photoDragTicket>;
export const photoTextResult = z.object({
  lines: z.array(z.object({
    text: z.string().min(1).max(1024),
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1),
  }).refine(({ x, y, width, height }) => x + width <= 1.000001 && y + height <= 1.000001)).max(128),
});
export type PhotoTextResult = z.infer<typeof photoTextResult>;
const instantViewIconImage = photoSchema.pick({ base64: true }).extend({ mime: instantViewIconMime });
export type InstantViewIconImage = z.infer<typeof instantViewIconImage>;

const runtimeInfo = z.object({ tdlibVersion: z.string().max(32).regex(/^\d+\.\d+(?:\.\d+){0,2}$/), premium: z.boolean().optional() });
export type RuntimeInfo = z.infer<typeof runtimeInfo>;

const agentAccessSchema = z.object({ read: z.boolean(), send: z.boolean(), history: z.boolean() });
export type AgentAccess = z.infer<typeof agentAccessSchema>;

const forwardTarget = z.object({
  id: chatId, name: z.string().min(1).max(256), kind: z.enum(["Direct message", "Group", "Channel"]),
  topic: forumTopicTarget.optional(),
});
const forwardPresentation = z.object({
  hideSender: z.literal(true),
  removeCaption: z.literal(true).optional(),
});
export type ForwardPresentation = z.infer<typeof forwardPresentation>;
const forwardComment = z.string().trim().min(1).max(4096);
const forwardResult = z.enum(["sent", "refused", "unknown", "commentRefused", "commentUnknown", "forwardRefusedAfterComment", "forwardUnknownAfterComment"]);
export type ForwardTarget = z.infer<typeof forwardTarget>;
export type ForwardResult = z.infer<typeof forwardResult>;

const messageLinkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("album"), id: albumSelection.shape.id.max(20).regex(/^-?[1-9]\d*$/) }),
  z.object({ kind: z.literal("playback position"), seconds: z.number().int().positive().max(2147483647) }),
  z.object({ kind: z.literal("checklist task"), id: checklistTaskId }),
  z.object({ kind: z.literal("poll option"), id: z.string().min(1).max(128) }),
]);
export type MessageLinkTarget = z.infer<typeof messageLinkTarget>;

const linkedTelegramMessage = z.union([
  z.object({ chat: chatSchema, messageId: messageReference.shape.messageId, topicId: forumTopicId.optional(),
    parentTopic: forumTopic.optional(),
    mediaTimestamp: z.number().int().min(0).max(2147483647).optional(), checklistTaskId: checklistTaskId.optional(),
    pollOptionId: z.string().min(1).max(128).optional() }),
  z.object({ chat: chatSchema, topic: forumTopic }),
]);
export type LinkedTelegramMessage = z.infer<typeof linkedTelegramMessage>;

const botStartTarget = z.object({ chat: chatSchema, username: z.string().regex(/^[a-z0-9_]{1,64}$/) });
const botStartResult = z.enum(["sent", "changed", "failed", "unknown"]);
const linkedGame = botStartTarget.extend({ shortName: z.string().regex(/^[a-z0-9_]{1,64}$/i) });
export type LinkedGame = z.infer<typeof linkedGame>;
export type BotStartTarget = z.infer<typeof botStartTarget>;
export type BotStartResult = z.infer<typeof botStartResult>;

export const defaultCacheLimitMiB = 512;
export const cacheLimitMiB = z.number().int().min(64).max(32768);
export const cacheRetentionDays = z.number().int().min(0).max(365);
const clearableCacheCategory = z.enum(["photos", "videos", "audio", "documents", "stickers", "previews", "wallpapers"]);
export type ClearableCacheCategory = z.infer<typeof clearableCacheCategory>;
const cacheCategory = clearableCacheCategory.or(z.literal("other"));
const cacheUsage = z.object({ bytes: z.number().int().nonnegative(), breakdown: z.array(z.object({
  category: cacheCategory, bytes: z.number().int().positive(),
})).max(clearableCacheCategory.options.length + 1).optional(), chats: z.array(z.object({
  id: chatId, title: z.string().min(1).max(256), bytes: z.number().int().positive(),
})).max(10).optional() });
export type CacheUsage = z.infer<typeof cacheUsage>;
export const maxAutoMediaMiB = 4000;
const autoMediaLimitMiB = z.number().int().min(0).max(maxAutoMediaMiB);
export const autoMediaLimits = z.object({
  photo: autoMediaLimitMiB,
  video: autoMediaLimitMiB,
  file: autoMediaLimitMiB,
});
export const autoMediaScopes = ["private", "group", "channel"] as const;
export const autoMediaPolicy = z.object({ private: autoMediaLimits, group: autoMediaLimits, channel: autoMediaLimits });
export type AutoMediaPolicy = z.infer<typeof autoMediaPolicy>;
export type AutoMediaLimits = z.infer<typeof autoMediaLimits>;
export const autoMediaOverrides = z.record(chatId, autoMediaLimits);
export const accountAutoMediaOverrides = z.record(z.string().regex(/^[1-9]\d{0,15}$/), autoMediaOverrides);
export type AutoMediaOverrides = z.infer<typeof autoMediaOverrides>;
const disabledAutoMedia: AutoMediaLimits = { photo: 0, video: 0, file: 0 };
export const defaultAutoMediaPolicy: AutoMediaPolicy = {
  private: disabledAutoMedia, group: disabledAutoMedia, channel: disabledAutoMedia,
};
const legacyAutoMediaPolicy = autoMediaLimits.extend({
  scopes: z.array(z.enum(autoMediaScopes)).max(3).refine((scopes) => new Set(scopes).size === scopes.length),
}).transform(({ scopes, ...limits }): AutoMediaPolicy => ({
  private: scopes.includes("private") ? limits : disabledAutoMedia,
  group: scopes.includes("group") ? limits : disabledAutoMedia,
  channel: scopes.includes("channel") ? limits : disabledAutoMedia,
}));
export const readableAutoMediaPolicy = z.union([autoMediaPolicy, legacyAutoMediaPolicy]);
export const autoPlaybackLimits = z.object({ video: autoMediaLimitMiB, gif: autoMediaLimitMiB, videoNote: autoMediaLimitMiB });
export const autoPlaybackPolicy = z.object({ private: autoPlaybackLimits, group: autoPlaybackLimits, channel: autoPlaybackLimits });
export type AutoPlaybackPolicy = z.infer<typeof autoPlaybackPolicy>;
export type AutoPlaybackLimits = z.infer<typeof autoPlaybackLimits>;
export const autoPlaybackOverrides = z.record(chatId, autoPlaybackLimits);
export const accountAutoPlaybackOverrides = z.record(z.string().regex(/^[1-9]\d{0,15}$/), autoPlaybackOverrides);
export type AutoPlaybackOverrides = z.infer<typeof autoPlaybackOverrides>;
export const disabledAutoPlayback: AutoPlaybackLimits = { video: 0, gif: 0, videoNote: 0 };
export const defaultAutoPlaybackPolicy: AutoPlaybackPolicy = {
  private: disabledAutoPlayback, group: disabledAutoPlayback, channel: disabledAutoPlayback,
};

const cacheInfo = cacheUsage.extend({ limitMiB: cacheLimitMiB, retentionDays: cacheRetentionDays.optional(),
  cleanupDeferred: z.literal(true).optional() });
export type CacheInfo = z.infer<typeof cacheInfo>;
export const proxyKind = z.enum(["socks5", "http", "mtproto"]);
const proxyId = z.number().int().positive().max(2147483647);
const proxyAddress = z.object({
  server: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9_.:\[\]-]+$/),
  port: z.number().int().min(1).max(65535),
  kind: proxyKind,
});
const telegramProxy = proxyAddress.extend({ id: proxyId, enabled: z.boolean(), httpOnly: z.boolean().optional() });
export type TelegramProxy = z.infer<typeof telegramProxy>;
export const proxyDraft = proxyAddress.extend({
  username: z.string().max(255).optional(), password: z.string().max(255).optional(),
  secret: z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_+\/=-]+$/).optional(),
  httpOnly: z.boolean().optional(),
});
export type ProxyDraft = z.infer<typeof proxyDraft>;
const exportTimestamp = z.number().int().nonnegative().max(2147483648);
const chatExportRange = z.object({ from: exportTimestamp.optional(), until: exportTimestamp.optional() })
  .refine(({ from, until }) => (from !== undefined || until !== undefined)
    && (from === undefined || until === undefined || from < until), "Invalid export dates");
export const chatExportOptions = z.object({ format: z.enum(["json", "html"]), media: z.boolean(), range: chatExportRange.optional(),
  profileMusic: z.literal(true).optional() });
export type ChatExportOptions = z.infer<typeof chatExportOptions>;
const storyList = z.enum(["main", "archive"]);
const communityAvatar = z.object({ avatarJpeg: chatAvatarSchema.optional(), avatarFileId: pollFileId.optional(),
  hasAvatarVideo: z.literal(true).optional() });
const communityAvatarVideo = z.object({ photoId: galleryPhotoId, fileId: pollFileId });
export type CommunityAvatarVideo = z.infer<typeof communityAvatarVideo>;
const communitySummary = communityAvatar.extend({ id: chatId, name: z.string().min(1).max(256), canRename: z.literal(true).optional(),
  canManageChats: z.literal(true).optional(), canRequestChats: z.literal(true).optional(), canDelete: z.literal(true).optional(),
  canEditMemberPermissions: z.literal(true).optional(), membersCanEditChats: z.boolean().optional(),
  collapsed: z.boolean().optional(), photoVersion: avatarVersion.optional() });
const communityFolderMembership = z.object({
  id: folderId, title: z.string().min(1).max(128), included: z.boolean(),
});
const communityFolderMemberships = z.object({
  canAdd: z.boolean(),
  folders: z.array(communityFolderMembership).max(100),
});
export type CommunityFolderMemberships = z.infer<typeof communityFolderMemberships>;
export const communityFolderChange = z.object({
  id: chatId, folder: folderId, expectedTitle: communityFolderMembership.shape.title,
  expectedIncluded: z.boolean(), included: z.boolean(),
});
export type CommunityFolderChange = z.infer<typeof communityFolderChange>;
const folderCommunities = z.object({
  communities: z.array(communitySummary).max(200),
  pinned: z.array(z.object({ id: chatId, community: z.boolean() })).max(400),
});
export type FolderCommunities = z.infer<typeof folderCommunities>;
const collapsedCommunity = z.object({ community: communitySummary, chatIds: z.array(chatId).max(100) });
export type CollapsedCommunity = z.infer<typeof collapsedCommunity>;
const communityChatTitle = z.string().min(1).max(256);
const communitySourceChat = z.object({ id: chatId, title: communityChatTitle, bot: z.literal(true).optional() });
export const communityCreation = z.object({ id: chatId, name: z.string().trim().min(1).max(128), hidden: z.boolean(),
  expectedTitle: communityChatTitle.optional() });
export const communityRename = communityCreation.pick({ id: true, name: true }).extend({ expected: communitySummary.shape.name });
export const communityDeletion = communityRename.pick({ id: true, expected: true });
export type CommunityDeletion = z.infer<typeof communityDeletion>;
export const communityPermissionChange = z.object({ id: chatId, expected: z.boolean(), canEditChats: z.boolean() });
export type CommunityPermissionChange = z.infer<typeof communityPermissionChange>;
export const communityCollapseChange = z.object({ id: chatId, expected: z.boolean(), collapsed: z.boolean() });
export type CommunityCollapseChange = z.infer<typeof communityCollapseChange>;
export const communityNotificationChange = z.object({ id: chatId, expected: chatNotificationMode,
  mode: chatNotificationMode, muteFor: chatMutePeriod.optional() }).refine(({ mode, muteFor }) => mode === "muted" || muteFor === undefined);
export type CommunityNotificationChange = z.infer<typeof communityNotificationChange>;
export const communityChatChange = z.discriminatedUnion("action", [
  z.object({ id: chatId, chat: chatId, action: z.literal("add"), hidden: z.boolean(), expectedTitle: communityChatTitle.optional() }),
  z.object({ id: chatId, chat: chatId, action: z.literal("remove"), expectedHidden: z.boolean(),
    expectedTitle: communityChatTitle.optional() }),
]);
export type CommunityChatChange = z.infer<typeof communityChatChange>;
const communityRequestOffset = z.string().max(1024);
const communityRequestReference = z.object({
  chat: chatId, sender: chatId, date: z.number().int().min(1).max(2147483647), hidden: z.boolean(), offset: communityRequestOffset,
});
const communityRequests = z.object({
  requests: z.array(communityRequestReference.extend({ title: z.string().min(1).max(256), requester: z.string().min(1).max(256) })).max(20),
  next: communityRequestOffset.nullable(),
});
export const communityRequestDecision = communityRequestReference.extend({ id: chatId, approve: z.boolean() });
export const communityRequestBatch = z.object({
  id: chatId, approve: z.boolean(), expected: z.array(communityRequestReference.omit({ offset: true })).min(1).max(500),
});
export type CommunityRequestBatch = z.infer<typeof communityRequestBatch>;
export type CommunityRequests = z.infer<typeof communityRequests>;
export type CommunityRequestDecision = z.infer<typeof communityRequestDecision>;
export type CommunityRename = z.infer<typeof communityRename>;
export type CommunityCreation = z.infer<typeof communityCreation>;
export type CommunitySourceChat = z.infer<typeof communitySourceChat>;
const communityChats = z.array(z.object({
  id: chatId, title: z.string().min(1).max(256), canView: z.boolean(), hidden: z.boolean(), canRemove: z.literal(true).optional(),
})).max(100);
export type CommunitySummary = z.infer<typeof communitySummary>;
export type CommunityChats = z.infer<typeof communityChats>;
const communityModerationCounts = z.object({
  administrators: z.number().int().nonnegative(),
  banned: z.number().int().nonnegative(),
  chatRequests: z.number().int().nonnegative(),
});
const communityBannedOffset = z.number().int().min(0).max(2147483597);
const communityListUnban = z.object({
  id: chatId, offset: communityBannedOffset, sender: messageSender, bannedUntil: z.number().int().min(0).max(2147483647),
});
export type CommunityListUnban = z.infer<typeof communityListUnban>;
const communityBannedMembers = z.object({
  members: z.array(z.object({
    sender: messageSender,
    name: z.string().min(1).max(256),
    bannedUntil: z.number().int().min(0).max(2147483647),
  })).max(50),
  next: communityBannedOffset.nullable(),
  canUnban: z.literal(true).optional(),
});
export type CommunityBannedMembers = z.infer<typeof communityBannedMembers>;
export type CommunityModerationCounts = z.infer<typeof communityModerationCounts>;
export type StoryList = z.infer<typeof storyList>;
const storyId = z.number().int().positive().max(2147483647);
export const storyDeletedChannel = "telegram-story-deleted";
export const storyFeedChangedChannel = "telegram-story-feed-changed";
export const storyStealthChangedChannel = "telegram-story-stealth-changed";
export const storyStealthTimes = z.object({
  activeUntil: z.number().int().min(0).max(2147483647),
  cooldownUntil: z.number().int().min(0).max(2147483647),
});
export type StoryStealthTimes = z.infer<typeof storyStealthTimes>;
const storyStealthStatus = storyStealthTimes.extend({
  premium: z.boolean(),
  pastSeconds: z.number().int().positive().optional(),
  futureSeconds: z.number().int().positive().optional(),
});
export type StoryStealthStatus = z.infer<typeof storyStealthStatus>;
const storyStealthActivation = z.object({
  state: z.enum(["active", "unavailable", "unknown"]),
  times: storyStealthTimes.optional(),
});
export type StoryStealthActivation = z.infer<typeof storyStealthActivation>;
export const storyReference = z.object({ id: chatId, story: storyId });
export type StoryReference = z.infer<typeof storyReference>;
const linkedStory = storyReference.extend({ title: z.string() });
export type LinkedStory = z.infer<typeof linkedStory>;
const storyFeed = z.object({
  groups: z.array(z.object({ id: chatId, title: z.string(), canArchive: z.boolean().optional(), stories: z.array(z.object({ id: storyId, unread: z.boolean() })) })),
  more: z.boolean(),
});
export type StoryFeed = z.infer<typeof storyFeed>;
const storyAlbum = z.object({ id: storyId, title: z.string().min(1).max(256) });
export type StoryAlbum = z.infer<typeof storyAlbum>;
const linkedStoryAlbum = z.object({ chatId, album: storyAlbum });
export type LinkedStoryAlbum = z.infer<typeof linkedStoryAlbum>;
const profileStoryPage = z.object({
  stories: z.array(z.object({ id: storyId, date: z.number().int().positive().max(2147483647), pinned: z.boolean() })),
  before: storyId.nullable(),
  pinnedOrder: z.array(storyId).max(100).optional(),
});
export type ProfileStoryPage = z.infer<typeof profileStoryPage>;
const storyOrder = z.array(storyId).max(100).refine((ids) => new Set(ids).size === ids.length);
const storyOrderEdit = z.object({ id: chatId, expected: storyOrder, order: storyOrder });
const storyOrderResult = z.enum(["saved", "changed", "unavailable"]);
export type StoryOrderResult = z.infer<typeof storyOrderResult>;
export const storyAlbumName = z.string().trim().min(1).max(24).refine((name) => [...name].length <= 12);
const storyAlbumChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename"), name: storyAlbumName }),
  z.object({ kind: z.literal("delete") }),
  z.object({ kind: z.literal("add"), stories: storyOrder.refine((ids) => ids.length > 0) }),
  z.object({ kind: z.literal("remove"), story: storyId }),
]);
export type StoryAlbumChange = z.infer<typeof storyAlbumChange>;
const storyAlbumChangeResult = z.enum(["saved", "changed", "unavailable", "full"]);
export type StoryAlbumChangeResult = z.infer<typeof storyAlbumChangeResult>;
export const storyAudience = z.enum(["contacts", "closeFriends", "everyone"]);
export type StoryAudience = z.infer<typeof storyAudience>;
export const storyAudienceLabels: Record<StoryAudience, string> = {
  contacts: "My contacts", closeFriends: "Close friends", everyone: "Everyone",
};
const storyManagement = z.enum(["delete", "showOnProfile", "hideFromProfile"]);
export type StoryManagement = z.infer<typeof storyManagement>;
const storyActivityFilter = z.object({ query: z.string().trim().max(128), contactsOnly: z.boolean(),
  order: z.enum(["recent", "reactions", "forwards"]) });
export type StoryActivityFilter = z.infer<typeof storyActivityFilter>;
export const defaultStoryActivityFilter: StoryActivityFilter = { query: "", contactsOnly: false, order: "recent" };
const storyInteractionPage = z.object({
  rows: z.array(z.object({ key: z.string(), name: z.string(), date: z.number().int().positive().max(2147483647),
    kind: z.enum(["view", "reaction", "forward", "repost"]), emoji: reactionEmoji.optional(),
    customEmoji: customReaction.shape.id.optional() })).max(50),
  next: z.string().max(1024).nullable(),
});
export type StoryInteractionPage = z.infer<typeof storyInteractionPage>;
const storyAreaPosition = z.object({
  x: z.number().min(0).max(100), y: z.number().min(0).max(100),
  width: z.number().positive().max(100), height: z.number().positive().max(100), rotation: z.number().min(0).max(360),
});
const storyLinkArea = z.union([
  storyAreaPosition.extend({ url: z.string().max(4096), label: z.string().min(1).max(256).optional() }),
  storyAreaPosition.extend({ post: forwardedPost }),
  storyAreaPosition.extend({ weather: z.object({
    temperature: z.number(), emoji: z.string().min(1).max(32),
    color: z.number().int().min(-2147483648).max(2147483647).optional(),
  }) }),
  storyAreaPosition.extend({ suggested: selectableReaction, count: z.number().int().nonnegative(), dark: z.boolean(), flipped: z.boolean() }),
]);
const storyView = z.object({
  repost: z.union([
    z.object({ origin: storyReference, edited: z.boolean() }),
    z.object({ posterName: z.string().min(1).max(256), edited: z.boolean() }),
  ]).optional(),
  music: z.object({ fileId: z.number().int().positive(), mime: playbackMime,
    title: z.string().max(256), performer: z.string().max(256) }).optional(),
  links: z.array(storyLinkArea).max(10).optional(),
  counts: z.object({ views: z.number().int().nonnegative(), forwards: z.number().int().nonnegative(),
    reactions: z.number().int().nonnegative() }).optional(),
  canGetInteractions: z.boolean().optional(),
  canCopyLink: z.boolean().optional(),
  canReply: z.boolean().optional(),
  editableAudience: storyAudience.optional(),
  canDelete: z.boolean().optional(),
  canEditCaption: z.boolean().optional(),
  profileVisibility: z.boolean().optional(),
  caption: z.string().max(8192),
  captionLinks: messageLinks,
  captionStyles: z.array(styledRange).max(128).optional(),
  captionEmoji: z.array(customEmojiRange).max(128).optional(),
  reaction: reactionEmoji.optional(),
  customReaction: customEmojiId.optional(),
  kind: z.enum(["photo", "video"]),
  url: z.string().startsWith("/api/v1/plugins/"),
});
export type StoryView = z.infer<typeof storyView>;
const networkUsage = z.object({
  since: z.number().int().min(0).max(2147483647),
  entries: z.array(z.object({
    connection: z.string(), category: z.string(),
    sent: z.number().int().nonnegative(), received: z.number().int().nonnegative(),
  })),
});
export type NetworkUsage = z.infer<typeof networkUsage>;

const forumTopicAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: z.string().trim().min(1).max(128), color: forumTopicColor.optional() }),
  z.object({ kind: z.literal("rename"), topic: forumTopicId, name: z.string().trim().min(1).max(128) }),
  z.object({ kind: z.literal("close"), topic: forumTopicId, closed: z.boolean() }),
  z.object({ kind: z.literal("pin"), topic: forumTopicId, pinned: z.boolean() }),
  z.object({ kind: z.literal("hideGeneral"), topic: forumTopicId, hidden: z.boolean() }),
]);
const forumTopicCursor = z.object({ date: z.number().int().nonnegative(), message: z.number().int().nonnegative(), topic: forumTopicId });
const forumTopicPage = z.object({ topics: z.array(forumTopic).max(40), next: forumTopicCursor.nullable(),
  canCreateBotTopics: z.literal(true).optional() });
export type ForumTopicPage = z.infer<typeof forumTopicPage>;
export type ForumTopicAction = z.infer<typeof forumTopicAction>;

const managedInvite = z.object({
  link: z.string().max(512), name: z.string().max(32), created: z.number().int().nonnegative(),
  expires: z.number().int().nonnegative(), uses: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  approval: z.boolean(), primary: z.boolean(), subscription: z.literal(true).optional(),
  pricing: inviteSubscriptionPricing.optional(),
  expiredMembers: z.number().int().nonnegative().optional(),
});
export type ManagedInvite = z.infer<typeof managedInvite>;
const inviteEditExpected = managedInvite.pick({ name: true, expires: true, limit: true, approval: true, pricing: true });
export type InviteEditExpected = z.infer<typeof inviteEditExpected>;
const inviteEditResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("saved"), invite: managedInvite }),
  z.object({ state: z.enum(["changed", "unavailable"]) }),
]);
export type InviteEditResult = z.infer<typeof inviteEditResult>;
const inviteDraft = z.object({
  name: z.string().trim().max(32), expires: z.number().int().min(0).max(2147483647),
  limit: z.number().int().min(0).max(99999), approval: z.boolean(),
}).refine((draft) => !draft.approval || draft.limit === 0);
export type InviteDraft = z.infer<typeof inviteDraft>;
const inviteCursor = managedInvite.pick({ link: true, created: true });
const invitePage = z.object({ links: z.array(managedInvite).max(30), next: inviteCursor.nullable() });
export type InvitePage = z.infer<typeof invitePage>;
const inviteMembersCursor = z.object({ userId: z.string().regex(/^[1-9]\d{0,15}$/),
  date: z.number().int().nonnegative().max(2147483647) });
const inviteMembersPage = z.object({
  members: z.array(inviteMembersCursor.extend({ name: z.string().min(1).max(256) })).max(30),
  next: inviteMembersCursor.nullable(),
});
export type InviteMembersPage = z.infer<typeof inviteMembersPage>;

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

export const chatMemberFilter = z.enum(["administrators", "banned", "restricted", "contacts", "bots"]);
export type ChatMemberFilter = z.infer<typeof chatMemberFilter>;
const memberBanDuration = z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(2592000)]);
export type MemberBanDuration = z.infer<typeof memberBanDuration>;
const memberBanExpiry = z.number().int().nonnegative().max(2147483647);
const memberRestriction = z.object({ until: memberBanExpiry, isMember: z.boolean() });
const editableMemberRestriction = memberRestriction.extend({ values: groupPermissionValues });
export type EditableMemberRestriction = z.infer<typeof editableMemberRestriction>;
export const administratorRightLabels = {
  can_manage_chat: "Manage chat", can_change_info: "Change chat info", can_delete_messages: "Delete messages",
  can_invite_users: "Invite users", can_restrict_members: "Restrict members", can_promote_members: "Manage administrators",
  can_pin_messages: "Pin messages", can_manage_topics: "Manage topics", can_manage_tags: "Manage member tags",
  can_post_messages: "Publish channel posts", can_edit_messages: "Edit channel posts",
  can_manage_direct_messages: "Manage channel direct messages", is_anonymous: "Remain anonymous",
  can_edit_stories: "Manage published stories", can_delete_stories: "Delete stories",
} as const;
export type AdministratorRight = keyof typeof administratorRightLabels;
const administratorRight = z.enum(Object.keys(administratorRightLabels) as AdministratorRight[]);
const administratorRights = z.array(administratorRight).max(administratorRight.options.length);
export const miniAppAdministratorRightLabels = {
  ...administratorRightLabels,
  can_manage_video_chats: "Manage video chats",
  can_post_stories: "Publish stories",
  can_send_welcome_messages: "Send welcome messages",
} as const;
const miniAppAdministratorRight = z.enum(Object.keys(miniAppAdministratorRightLabels) as (keyof typeof miniAppAdministratorRightLabels)[]);
const miniAppRequestedBotAccess = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member") }),
  z.object({ kind: z.literal("administrator"),
    rights: z.array(miniAppAdministratorRight).max(miniAppAdministratorRight.options.length) }),
]);
export type MiniAppRequestedBotAccess = z.infer<typeof miniAppRequestedBotAccess>;
export const miniAppPublicUsername = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/);
const managedBotName = z.string().trim().min(1).max(128)
  .refine((name) => Array.from(name).length <= 64 && !/\p{Cc}/u.test(name));
const managedBotUsername = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/);
export const managedBotDraft = z.object({ name: managedBotName, username: managedBotUsername });
export type ManagedBotDraft = z.infer<typeof managedBotDraft>;
const managedBotReview = z.object({ confirmation: z.uuid(), bot: z.string().min(1).max(256),
  suggestedName: managedBotName.optional(), suggestedUsername: managedBotUsername.optional() });
export type ManagedBotReview = z.infer<typeof managedBotReview>;
const communityImpactChat = z.object({ id: chatId, name: z.string().min(1).max(256) });
const communityBanImpact = z.object({
  community: z.string().min(1).max(256), communityId: chatId,
  owned: z.array(communityImpactChat).max(200), joined: z.array(communityImpactChat).max(200), canBan: z.boolean(),
});
export type CommunityBanImpact = z.infer<typeof communityBanImpact>;
const communityBanChange = z.object({
  id: chatId, userId: messageSender.options[0].shape.id, communityId: chatId,
  owned: z.array(chatId).max(200), joined: z.array(chatId).max(200),
});
export type CommunityBanChange = z.infer<typeof communityBanChange>;

const communityUnbanTarget = communityBanChange.pick({ id: true, communityId: true }).extend({
  memberId: chatId,
  bannedUntil: memberBanExpiry,
});
export type CommunityUnbanTarget = z.infer<typeof communityUnbanTarget>;
const communityUnbanPreview = communityBanImpact.pick({ community: true, communityId: true });
export type CommunityUnbanPreview = z.infer<typeof communityUnbanPreview>;

const chatMemberAction = z.strictObject({ id: chatId, userId: messageSender.options[0].shape.id,
  role: z.enum(["member", "restricted"]), joinedAt: z.number().int().nonnegative().max(2147483647),
  action: z.enum(["remove", "deleteMessages"]) });
export type ChatMemberAction = z.infer<typeof chatMemberAction>;

const chatMemberPage = z.object({
  communityModeration: z.literal(true).optional(),
  grantableAdministratorRights: administratorRights.optional(),
  canUnban: z.literal(true).optional(),
  restrictionDefaults: groupPermissionValues.optional(),
  canBan: z.literal(true).optional(),
  canRemoveMembers: z.literal(true).optional(),
  canDeleteMemberMessages: z.literal(true).optional(),
  canLiftRestrictions: z.literal(true).optional(),
  members: z.array(z.object({ id: chatId, name: z.string().min(1).max(256),
    role: z.enum(["owner", "admin", "member", "restricted", "banned"]), tag: z.string().max(64).optional(),
    joinedAt: z.number().int().nonnegative().max(2147483647).optional(),
    canDemote: z.literal(true).optional(),
    canEditTag: z.literal(true).optional(),
    administratorRights: administratorRights.optional(),
    bannedUntil: memberBanExpiry.optional(),
    restriction: memberRestriction.extend({ values: groupPermissionValues.optional() }).optional(),
  })).max(30),
  next: z.number().int().nonnegative().nullable(),
});
export type ChatMemberPage = z.infer<typeof chatMemberPage>;

const existingAvatarVersion = z.string().regex(/^[0-9a-f]{64}$/);
const avatarUpdate = z.object({ expected: avatarVersion, base64: photoSchema.shape.base64 });
export const maxAvatarVideoBytes = 2_000_000;
export const maxAvatarVideoSourceBytes = 4_000_000;
export const avatarVideoTrim = z.object({ start: z.number().min(0).lt(120), end: z.number().positive().max(120) })
  .refine(({ start, end }) => end > start && end - start <= 10);
export type AvatarVideoTrim = z.infer<typeof avatarVideoTrim>;
const avatarVideoUpdate = z.object({
  expected: avatarVersion,
  base64: z.string().min(16).max(Math.ceil(maxAvatarVideoSourceBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  coverSeconds: z.number().min(0).lt(120),
  trim: avatarVideoTrim.optional(),
});
const saveAvatarResult = z.enum(["saved", "changed", "unavailable", "unknown"]);
export type SaveAvatarResult = z.infer<typeof saveAvatarResult>;
const profileEmojiKey = z.string().regex(/^(?:emoji|gift):-?[1-9]\d{0,19}$/);
export const profileEmojiStatus = z.object({
  key: profileEmojiKey.optional(),
  emoji: customEmojiId,
  expiresAt: z.number().int().min(0).max(2147483647),
  giftTitle: z.string().min(1).max(128).optional(),
});
export type ProfileEmojiStatus = z.infer<typeof profileEmojiStatus>;
const profileEmojiChoice = profileEmojiStatus.omit({ expiresAt: true }).extend({
  key: profileEmojiKey, emoji: customEmojiId.optional(), section: z.enum(["themed", "recent", "default", "gifts"]),
});
export type ProfileEmojiChoice = z.infer<typeof profileEmojiChoice>;
const profileEmojiChange = z.object({
  key: profileEmojiKey.nullable(), expected: profileEmojiStatus.nullable(),
  duration: z.number().int().min(0).max(2147483647),
});
export type ProfileEmojiChange = z.infer<typeof profileEmojiChange>;
const messageEmojiStatusChange = profileEmojiChange.extend({ emoji: customEmojiId });
const boostCount = z.number().int().min(0).max(2147483647);
export const chatBoostInfo = z.object({
  level: boostCount, count: boostCount, next: boostCount.optional(), applied: boostCount,
  link: z.string().url().max(128).optional(),
  storiesPerDay: boostCount.optional(), customReactions: boostCount.optional(),
  features: z.array(z.enum(["emojiStatus", "customBackground", "customStickerSet", "translation", "transcription", "noSponsoredMessages"])).max(6),
});
export type ChatBoostInfo = z.infer<typeof chatBoostInfo>;

const chatBoostSlotSnapshot = z.object({
  slot: boostCount, source: z.string().regex(/^-?[1-9]\d{0,15}$/).nullable(),
  expiresAt: boostCount, cooldownUntil: boostCount,
});
const chatBoostSlot = chatBoostSlotSnapshot.extend({ sourceName: z.string().max(256).optional() });
export type ChatBoostSlotSnapshot = z.infer<typeof chatBoostSlotSnapshot>;
export type ChatBoostSlot = z.infer<typeof chatBoostSlot>;
const chatBoostResult = z.enum(["applied", "changed", "unavailable", "unknown"]);
export type ChatBoostResult = z.infer<typeof chatBoostResult>;

const chatBoostRecord = z.object({
  id: z.string().min(1).max(256), source: z.enum(["premium", "giftCode", "giveaway"]), name: z.string().max(128).optional(),
  count: boostCount.min(1), expiresAt: boostCount.min(1), startedAt: boostCount,
  unclaimed: z.literal(true).optional(), stars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const chatBoostPage = z.object({ boosts: z.array(chatBoostRecord).max(30), next: z.string().min(1).max(512).nullable() });
export type ChatBoostPage = z.infer<typeof chatBoostPage>;

const channelBoostSettings = z.object({
  automaticTranslation: z.object({ enabled: z.boolean(), canEnable: z.boolean() }).optional(),
  sponsoredMessages: z.object({ enabled: z.boolean(), canDisable: z.boolean() }).optional(),
});
export type ChannelBoostSettings = z.infer<typeof channelBoostSettings>;
const channelBoostSettingChange = z.object({
  setting: z.enum(["automaticTranslation", "sponsoredMessages"]), enabled: z.boolean(), expected: z.boolean(),
});
export type ChannelBoostSettingChange = z.infer<typeof channelBoostSettingChange>;

const chatInfo = z.object({
  boosts: chatBoostInfo.optional(), channelBoostSettings: channelBoostSettings.optional(), canViewBoosts: z.literal(true).optional(),
  emojiStatus: profileEmojiStatus.optional(), canSetEmojiStatus: z.literal(true).optional(),
  title: z.string().min(1).max(256), description: z.string().max(510), editable: z.boolean(),
  photoVersion: avatarVersion.optional(),
  canUpgrade: z.literal(true).optional(),
  migration: chatMigration.optional(),
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
const antiSpamReportResult = z.enum(["sent", "unavailable", "unknown"]);
export type AntiSpamReportResult = z.infer<typeof antiSpamReportResult>;
export const chatEventFilter = z.enum(["messages", "members", "settings", "invites", "topics", "subscriptions"]);
export type ChatEventFilter = z.infer<typeof chatEventFilter>;
const chatEventActorId = z.string().regex(/^[1-9]\d{0,15}$/);
const chatEventActor = z.object({ id: chatEventActorId, name: z.string().min(1).max(256) });
export type ChatEventActor = z.infer<typeof chatEventActor>;
const groupEntrySetting = z.enum(["approval", "joinToSend", "forum"]);
export type GroupEntrySetting = z.infer<typeof groupEntrySetting>;
const chatEventPermissionChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("administrator"), key: miniAppAdministratorRight, enabled: z.boolean() }),
  z.object({ kind: z.literal("member"), key: groupPermission, enabled: z.boolean() }),
]);
const chatEventInviteSettings = z.object({
  name: z.string().max(256).optional(),
  expiresAt: z.number().int().nonnegative().max(2147483647).optional(),
  memberLimit: z.number().int().nonnegative().max(2147483647).optional(),
  approval: z.boolean().optional(),
  primary: z.literal(true).optional(),
});
const chatEventReactionPolicy = z.discriminatedUnion("mode", [
  chatReactionPolicy.options[0], chatReactionPolicy.options[1].omit({ paid: true }),
]);
export const maxChatEventSnapshotHtml = 65536;
const chatEventSnapshotHtml = z.string().min(1).max(maxChatEventSnapshotHtml);
const chatEventPage = z.object({
  events: z.array(z.object({ id: chatEventId, date: z.number().int().nonnegative(), actor: z.string().min(1).max(256),
    action: z.string().min(1).max(100), detail: z.string().max(512).optional(),
    member: z.string().min(1).max(256).optional(), approver: z.string().min(1).max(256).optional(),
    memberChange: z.object({ field: z.enum(["status", "tag"]), before: z.string().max(256), after: z.string().max(256) }).optional(),
    moderationPeriod: z.object({ kind: z.enum(["ban", "restriction"]), until: memberBanExpiry,
      previousUntil: memberBanExpiry.optional() }).optional(),
    permissionChanges: z.array(chatEventPermissionChange).min(1)
      .max(Math.max(miniAppAdministratorRight.options.length, groupPermission.options.length)).optional(),
    message: z.object({ id: messageReference.shape.messageId, topicId: forumTopicId.optional() }).optional(),
    edit: z.object({ before: z.string().max(8192), after: z.string().max(8192),
      beforeHtml: chatEventSnapshotHtml.optional(), afterHtml: chatEventSnapshotHtml.optional() }).optional(),
    richSnapshot: chatEventSnapshotHtml.optional(),
    settingChange: z.object({ before: z.string().max(2048), after: z.string().max(2048) }).optional(),
    topic: forumTopicTarget.optional(),
    invite: z.object({ settings: chatEventInviteSettings, previous: chatEventInviteSettings.optional() }).optional(),
    reactionChange: z.object({ before: chatEventReactionPolicy, after: chatEventReactionPolicy }).optional(),
    deleted: z.object({ text: z.string().min(1).max(8192), html: chatEventSnapshotHtml.optional(),
      author: z.string().min(1).max(256).optional() }).optional(),
    reportSpamDeletion: z.literal(true).optional(),
  })).max(30),
  next: chatEventId.nullable(),
});
export type ChatEventPage = z.infer<typeof chatEventPage>;

const discussionPage = z.object({
  chat: chatSchema, root: z.string().regex(/^[1-9]\d{0,15}$/), messages: z.array(messageSchema).max(40), before: z.string().regex(/^[1-9]\d{0,15}$/).nullable(),
});
export type DiscussionPage = z.infer<typeof discussionPage>;
const discussionGroupSummary = z.object({ id: chatId, title: z.string().min(1).max(256) });
const discussionGroupView = z.object({ editable: z.boolean(), current: discussionGroupSummary.nullable() });
const discussionGroupCandidate = discussionGroupSummary.extend({ upgradeRequired: z.boolean() });
const discussionGroupResult = z.enum(["saved", "changed", "historyHidden", "unavailable"]);
const groupUpgradeResult = z.union([
  z.enum(["changed", "unavailable", "unknown"]),
  z.object({ group: discussionGroupCandidate.extend({ upgradeRequired: z.literal(false) }) }),
]);
export type DiscussionGroupView = z.infer<typeof discussionGroupView>;
export type DiscussionGroupCandidate = z.infer<typeof discussionGroupCandidate>;
export type DiscussionGroupResult = z.infer<typeof discussionGroupResult>;
export type GroupUpgradeResult = z.infer<typeof groupUpgradeResult>;

export const autoDeleteDays = z.number().int().min(0).max(365);

const chatAutoDelete = z.object({ days: autoDeleteDays, editable: z.boolean() });
export const clearChatDateRange = z.object({
  start: z.number().int().positive().max(2147483647),
  end: z.number().int().positive().max(2147483647),
}).refine(({ start, end }) => start <= end);
export type ClearChatDateRange = z.infer<typeof clearChatDateRange>;
const clearChatDateScope = z.enum(["self", "everyone"]);
export type ClearChatDateScope = z.infer<typeof clearChatDateScope>;
export type ClearChatDateResult = "deleted" | "refused" | "unknown" | "localUnconfirmed";
export type ChatAutoDelete = z.infer<typeof chatAutoDelete>;

export const archiveSettings = z.object({
  muteUnknown: z.boolean(), keepUnmuted: z.boolean(), keepFolderChats: z.boolean(),
});
export type ArchiveSettings = z.infer<typeof archiveSettings>;
const archiveSettingsView = archiveSettings.extend({ canMuteUnknown: z.boolean() });
export type ArchiveSettingsView = z.infer<typeof archiveSettingsView>;
const newChatAudience = z.enum(["everyone", "contactsAndPremium"]);
const newChatPrivacy = z.object({ audience: newChatAudience.nullable(), editable: z.boolean() });
export type NewChatAudience = z.infer<typeof newChatAudience>;
export type NewChatPrivacy = z.infer<typeof newChatPrivacy>;

const sensitiveContentSettings = z.object({
  show: z.boolean(), editable: z.boolean(), ageVerificationRequired: z.literal(true).optional(),
  verificationBot: miniAppPublicUsername.optional(),
});
export type SensitiveContentSettings = z.infer<typeof sensitiveContentSettings>;

const senderBlockList = z.enum(["main", "stories"]);
export type SenderBlockList = z.infer<typeof senderBlockList>;

const namedSenderPage = z.object({
  entries: z.array(z.object({ sender: messageSender, name: z.string().min(1).max(256) })).max(30),
  next: z.number().int().positive().max(2147483647).nullable(),
});
export type BlockedSenderPage = z.infer<typeof namedSenderPage>;
export type PollVoterPage = z.infer<typeof namedSenderPage>;
export type PollVoterLoader = (chatId: string, messageId: string, choice: PollChoice, offset: number) => Promise<PollVoterPage | null>;
const reactionPeoplePage = z.object({
  entries: z.array(z.object({
    sender: messageSender, name: z.string().min(1).max(256), reaction: selectableReaction,
    avatarJpeg: chatAvatarSchema.optional(), avatarFileId: z.number().int().positive().max(2147483647).optional(),
    reactedAt: z.number().int().positive().max(2147483647).optional(),
  })).max(30),
  next: z.string().min(1).max(1024).nullable(),
});
export type ReactionPeoplePage = z.infer<typeof reactionPeoplePage>;
const reactionPersonReference = z.object({
  sender: messageSender, reaction: selectableReaction, filter: selectableReaction.optional(), offset: z.string().max(1024),
});
export type ReactionPersonReference = z.infer<typeof reactionPersonReference>;

const senderBlockState = z.enum(["none", "stories", "main"]);
export type SenderBlockState = z.infer<typeof senderBlockState>;

const contactId = z.string().regex(/^[1-9]\d{0,15}$/);
const contactNames = z.object({ first: z.string().trim().max(64), last: z.string().trim().max(64) });
const contactDetails = contactNames.extend({ id: contactId, saved: z.boolean() });
export type ContactDetails = z.infer<typeof contactDetails>;
export const maxContactNoteLength = 4096;
const secondaryAvatarPhoto = z.object({ version: avatarVersion, preview: photoSchema.optional() });
export type SecondaryAvatarPhoto = z.infer<typeof secondaryAvatarPhoto>;
const contactNote = z.object({
  content: messageTranslation.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.number().int().positive().max(maxContactNoteLength),
});
export type ContactNote = z.infer<typeof contactNote>;
const namedContact = z.object({ id: contactId, name: z.string().min(1).max(256) });
const contactPage = z.object({
  contacts: z.array(namedContact).max(30),
  next: z.number().int().nonnegative().nullable(),
});
export type ContactPage = z.infer<typeof contactPage>;
export const chatMemberInviteLimit = 100;
const chatMemberInviteOutcome = z.enum(["added", "alreadyMember", "changed", "unavailable"]);
export type ChatMemberInviteOutcome = z.infer<typeof chatMemberInviteOutcome>;
const contactInitial = z.string().min(1).max(4).regex(/^(#|\p{L}+)$/u);
const contactDirectoryPage = contactPage.extend({ initials: z.array(contactInitial).max(10000) });
export type ContactDirectoryPage = z.infer<typeof contactDirectoryPage>;

const deviceId = z.string().regex(/^-?[1-9]\d{0,18}$/);
const deviceReviewRevision = z.string().regex(/^[a-f0-9]{64}$/);
const telegramDevice = z.object({
  id: z.union([deviceId, z.literal("0")]), current: z.boolean(), application: z.string().max(128), device: z.string().max(128),
  platform: z.string().max(128), activeAt: z.number().int().nonnegative(),
  passwordPending: z.literal(true).optional(),
  unconfirmed: z.object({
    signedInAt: z.number().int().min(0).max(2147483647), location: z.string().max(128), revision: deviceReviewRevision,
  }).optional(),
});
export type TelegramDevice = z.infer<typeof telegramDevice>;
export const sessionInactivityDays = z.number().int().min(1).max(366);
const otherDeviceIds = z.array(deviceId).min(1).max(199).refine((ids) => new Set(ids).size === ids.length);

export const telegramPrivacyLabels = {
  phone: "Phone number", findByPhone: "Find me by phone number", status: "Last seen and online",
  photo: "Profile photos", bio: "Bio", birthday: "Birthday", profileAudio: "Profile audio",
  forwardedLink: "Link to my profile in forwarded messages", invites: "Group and channel invitations",
  voiceAndVideoNotes: "Voice and video messages",
} as const;
const telegramPrivacyKey = z.enum(Object.keys(telegramPrivacyLabels) as (keyof typeof telegramPrivacyLabels)[]);
const telegramPrivacyAudience = z.enum(["everyone", "contacts", "nobody"]);
const telegramPrivacyView = z.object({
  audience: telegramPrivacyAudience.nullable(), exceptions: z.number().int().nonnegative(), version: z.string().regex(/^[a-f0-9]{64}$/),
  requiresPremium: z.literal(true).optional(),
});
export type TelegramPrivacyKey = z.infer<typeof telegramPrivacyKey>;
export type TelegramPrivacyAudience = z.infer<typeof telegramPrivacyAudience>;
export type TelegramPrivacyView = z.infer<typeof telegramPrivacyView>;

const privacyExceptionDecision = z.enum(["allow", "restrict"]);
const privacyExceptionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), id: contactId }),
  z.object({ kind: z.literal("group"), id: z.string().regex(/^-[1-9]\d{0,15}$/) }),
]);
const namedPrivacyException = z.object({ target: privacyExceptionTarget, name: z.string().min(1).max(256) });
const privacyExceptionEntry = namedPrivacyException.extend({ decision: privacyExceptionDecision });
const privacyExceptionPage = z.object({
  version: telegramPrivacyView.shape.version, editable: z.boolean(), entries: z.array(privacyExceptionEntry).max(30),
  next: z.number().int().min(0).max(1020).nullable(),
  premiumInvites: z.object({ allowed: z.boolean(), editable: z.boolean() }).optional(),
});
const privacyExceptionChange = z.object({
  key: telegramPrivacyKey, version: telegramPrivacyView.shape.version, action: z.enum(["add", "remove"]),
  target: privacyExceptionTarget, decision: privacyExceptionDecision,
});
export type PrivacyExceptionTarget = z.infer<typeof privacyExceptionTarget>;
export type PrivacyExceptionChange = z.infer<typeof privacyExceptionChange>;
export type PrivacyExceptionPage = z.infer<typeof privacyExceptionPage>;
export type NamedPrivacyException = z.infer<typeof namedPrivacyException>;

export function privacyAudiences(key: TelegramPrivacyKey): readonly TelegramPrivacyAudience[] {
  return key === "findByPhone" ? ["everyone", "contacts"] : telegramPrivacyAudience.options;
}

const profileFields = z.object({ first: z.string().max(64), last: z.string().max(64), bio: z.string().max(512) });
const editableUsername = z.string().max(32).regex(/^[A-Za-z0-9_]*$/);
const usernameCheck = z.enum(["available", "taken", "invalid", "collectible", "unavailable"]);
export type UsernameCheck = z.infer<typeof usernameCheck>;
const contactBirthday = contactPage.shape.contacts.element.extend({ birthdate: telegramBirthdate });
export type ContactBirthday = z.infer<typeof contactBirthday>;
export const contactBirthdayLimit = 100;
const personalChannelId = z.string().regex(/^-[1-9]\d{0,15}$/);
const personalChannelChoice = z.object({ id: personalChannelId, title: z.string().min(1).max(256) });
const personalChannelCard = personalChannelChoice.extend({ preview: z.string().max(256).optional() });
const personalChannelSettings = z.object({
  selected: personalChannelId.nullable(), current: personalChannelCard.nullable(), choices: z.array(personalChannelChoice).max(1000),
});
const personalChannelChange = z.object({ expected: personalChannelId.nullable(), choice: personalChannelChoice.nullable() });
export type PersonalChannelSettings = z.infer<typeof personalChannelSettings>;
export type PersonalChannelChange = z.infer<typeof personalChannelChange>;
const peerProfile = z.object({
  emojiStatus: profileEmojiStatus.optional(),
  hasMainMiniApp: z.literal(true).optional(),
  botCanManageEmojiStatus: z.literal(true).optional(),
  botCanAccessLocation: z.literal(true).optional(),
  usernames: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(32),
  phone: z.string().regex(/^\+\d{1,20}$/).optional(),
  bio: messageTranslation.nullable(),
  note: messageTranslation.optional(),
  birthdate: telegramBirthdate.nullable(),
  personalChannel: personalChannelCard.optional(),
});
export type PeerProfile = z.infer<typeof peerProfile>;
const profilePhotoOffset = z.number().int().nonnegative();
const giftCollectionId = z.number().int().positive().max(2147483647);
const profileGiftCollection = z.object({
  id: giftCollectionId, name: z.string().min(1).max(128), count: z.number().int().nonnegative(),
});
const profileGiftCollections = z.array(profileGiftCollection).max(100);
const giftCollectionName = z.string().trim().min(1).refine((name) => Array.from(name).length <= 12
  && !/[\p{Cc}\p{Cf}]/u.test(name));
export const giftCollectionChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: giftCollectionName }),
  z.object({ action: z.literal("rename"), collection: giftCollectionId, name: giftCollectionName,
    expectedName: profileGiftCollection.shape.name }),
  z.object({ action: z.literal("delete"), collection: giftCollectionId, expectedName: profileGiftCollection.shape.name }),
  z.object({ action: z.literal("move"), collection: giftCollectionId, direction: z.enum(["up", "down"]),
    expectedOrder: z.array(giftCollectionId).min(2).max(100) }),
]);
export type GiftCollectionChange = z.infer<typeof giftCollectionChange>;
export const receivedProfileGiftId = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
export const giftMembership = z.object({
  gift: receivedProfileGiftId, collection: giftCollectionId, present: z.boolean(),
});
export type GiftMembership = z.infer<typeof giftMembership>;
const giftArtworkFields = {
  emoji: z.string().max(24).optional(), artworkFileId: z.number().int().positive().optional(),
  animationFileId: z.number().int().positive().optional(),
};
const catalogGiftId = z.string().regex(/^[1-9]\d{0,18}$/);
const giftAuctionId = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const giftCatalog = z.array(z.object({
  ...giftArtworkFields, id: catalogGiftId,
  title: z.string().min(1).max(256), stars: z.number().int().nonnegative(),
  premiumOnly: z.boolean(),
  auctionId: giftAuctionId.optional(),
  supply: z.object({ total: z.number().int().positive(), remaining: z.number().int().nonnegative() }).optional(),
  resale: z.object({ count: z.number().int().positive(), minStars: z.number().int().positive().optional() }).optional(),
})).max(100);
const giftResaleAttributeId = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), id: catalogGiftId }),
  z.object({ kind: z.literal("symbol"), id: catalogGiftId }),
  z.object({ kind: z.literal("backdrop"), id: z.number().int().positive().max(2147483647) }),
]);
export type GiftResaleAttributeId = z.infer<typeof giftResaleAttributeId>;
const giftResaleAttributeOption = z.object({
  attribute: giftResaleAttributeId, name: z.string().min(1).max(128), count: z.number().int().nonnegative(),
});
export type GiftResaleAttributeOption = z.infer<typeof giftResaleAttributeOption>;
export const giftResaleQuery = z.object({
  giftId: catalogGiftId, order: z.enum(["price", "recent", "number"]),
  starsOnly: z.boolean(), offset: z.string().max(1024).optional(), attributes: z.array(giftResaleAttributeId).max(100).optional(),
});
export type GiftResaleQuery = z.infer<typeof giftResaleQuery>;
const giftResaleSlug = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
const giftResalePrice = z.object({ currency: z.enum(["stars", "gram"]), amount: z.number().int().positive() });
export type GiftResalePrice = z.infer<typeof giftResalePrice>;
export const giftResalePayment = giftResalePrice.extend({ slug: giftResaleSlug });
export type GiftResalePayment = z.infer<typeof giftResalePayment>;
const collectibleAttribute = z.object({
  name: z.string().min(1).max(128),
  rarity: z.union([z.number().int().min(0).max(1000), z.enum(["uncommon", "rare", "epic", "legendary"])]).optional(),
});
const collectibleDetails = z.object({
  model: collectibleAttribute.optional(), symbol: collectibleAttribute.optional(), backdrop: collectibleAttribute.optional(),
  supply: z.object({ minted: z.number().int().positive(), limit: z.number().int().positive() }).optional(),
});
export type CollectibleDetails = z.infer<typeof collectibleDetails>;

const linkedCollectibleGift = z.object({
  slug: giftResaleSlug, title: z.string().min(1).max(256), number: z.number().int().positive().optional(),
  emoji: z.string().max(24).optional(), details: collectibleDetails.optional(), thumbnail: photoSchema.optional(),
});
export type LinkedCollectibleGift = z.infer<typeof linkedCollectibleGift>;

const giftResalePage = z.object({
  attributes: z.array(giftResaleAttributeOption).max(600).optional(),
  total: z.number().int().nonnegative(),
  gifts: z.array(z.object({
    ...giftArtworkFields, slug: giftResaleSlug, details: collectibleDetails.optional(),
    title: z.string().min(1).max(256), number: z.number().int().positive().optional(),
    stars: z.number().int().positive().optional(), gramCents: z.number().int().positive().optional(),
    owned: z.boolean(),
  })).max(20),
  next: z.string().min(1).max(1024).nullable(),
});
export type GiftResalePage = z.infer<typeof giftResalePage>;
const giftQuote = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), stars: z.number().int().nonnegative(), confirmation: z.uuid().optional(),
    upgradeStars: z.number().int().positive().optional(), textLimit: z.number().int().min(0).max(1024).optional() }),
  z.object({ state: z.literal("unavailable"), reason: z.string().min(1).max(512) }),
]);
export type GiftQuote = z.infer<typeof giftQuote>;
export const giftSendOptions = z.object({ text: z.string().max(2048), upgrade: z.boolean(), showSenderPublicly: z.boolean().optional() });
export type GiftSendOptions = z.infer<typeof giftSendOptions>;
const giftSendResult = z.enum(["sent", "changed", "unavailable", "unknown"]);
export type GiftSendResult = z.infer<typeof giftSendResult>;
const giftAuctionTime = z.number().int().positive().max(2147483647);
const giftAuctionView = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("active"), startsAt: giftAuctionTime, endsAt: giftAuctionTime,
    round: z.number().int().positive().optional(), totalRounds: z.number().int().positive().optional(),
    roundEndsAt: giftAuctionTime.optional(), minBid: z.number().int().positive().optional(),
    remaining: z.number().int().nonnegative().optional(),
    ownBid: z.number().int().positive().optional(), nextBid: z.number().int().positive().optional(),
    canBid: z.boolean().optional(),
  }),
  z.object({
    state: z.literal("finished"), endsAt: giftAuctionTime,
    averageStars: z.number().int().positive().optional(), acquired: z.number().int().nonnegative().optional(),
  }),
]);
export const giftAuctionBid = z.object({ giftId: catalogGiftId, auctionId: giftAuctionId, stars: z.number().int().positive() });
export type GiftAuctionBid = z.infer<typeof giftAuctionBid>;
export type GiftAuctionView = z.infer<typeof giftAuctionView>;
export type GiftCatalog = z.infer<typeof giftCatalog>;
const profileGiftPage = z.object({
  canManage: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  total: z.number().int().nonnegative(),
  gifts: z.array(z.object({
    ...giftArtworkFields, title: z.string().min(1).max(256), details: collectibleDetails.optional(),
    slug: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/).optional(),
    number: z.number().int().positive().optional(),
    receivedId: receivedProfileGiftId.optional(), collectionIds: z.array(giftCollectionId).max(100).optional(), pinned: z.boolean(),
    visible: z.boolean().optional(),
    conversionStars: z.number().int().positive().optional(),
    upgradeable: z.literal(true).optional(),
    transferable: z.literal(true).optional(),
    canDropOriginalDetails: z.literal(true).optional(),
    resaleListing: z.object({ current: giftResalePrice.nullable() }).optional(),
  })).max(20),
  next: z.string().min(1).max(1024).nullable(),
});
export type ProfileGiftCollections = z.infer<typeof profileGiftCollections>;
export type ProfileGiftPage = z.infer<typeof profileGiftPage>;

const profilePhotoPage = z.object({
  photos: z.array(z.object({ id: galleryPhotoId, date: z.number().int().nonnegative().max(2147483647),
    videoFileId: pollFileId.optional() })).max(13),
  next: profilePhotoOffset.nullable(),
  current: z.object({ version: z.string().regex(/^[a-f0-9]{64}$/).nullable(), photoId: profilePhotoId.optional() }).optional(),
});
export type ProfilePhotoPage = z.infer<typeof profilePhotoPage>;
export const giftReceivingSettings = z.object({
  showButton: z.boolean(),
  accepted: z.object({
    unlimited_gifts: z.boolean(), limited_gifts: z.boolean(), upgraded_gifts: z.boolean(),
    gifts_from_channels: z.boolean(), premium_subscription: z.boolean(),
  }),
});
export type GiftReceivingSettings = z.infer<typeof giftReceivingSettings>;
const telegramProfile = profileFields.extend({ photoVersion: avatarVersion.optional(), canRemovePhoto: z.literal(true).optional(),
  accountId: chatId.optional(),
  canSetEmojiStatus: z.literal(true).optional(),
  emojiStatus: profileEmojiStatus.optional(),
  birthdate: telegramBirthdate.nullable(), username: editableUsername, bioLimit: z.number().int().positive().max(512), bioEditable: z.boolean(),
  giftSettings: z.object({ values: giftReceivingSettings, canFilter: z.boolean() }).optional(),
});
const profileChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("name"), first: profileFields.shape.first, last: profileFields.shape.last,
    expectedFirst: profileFields.shape.first, expectedLast: profileFields.shape.last }),
  z.object({ kind: z.literal("bio"), bio: profileFields.shape.bio, expectedBio: profileFields.shape.bio }),
  z.object({ kind: z.literal("username"), username: editableUsername, expectedUsername: editableUsername }),
  z.object({ kind: z.literal("birthdate"), birthdate: telegramBirthdate.nullable(), expectedBirthdate: telegramBirthdate.nullable() }),
  z.object({ kind: z.literal("gifts"), values: giftReceivingSettings, expected: giftReceivingSettings }),
]);
export type TelegramProfile = z.infer<typeof telegramProfile>;
export type ProfileChange = z.infer<typeof profileChange>;

const stickerPackId = z.string().regex(/^-?[1-9]\d{0,18}$/);
const ownedStickerFileId = z.number().int().positive().max(2147483647);
export const ownedStickerPackName = z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/);
export const ownedStickerTitle = z.string().trim().min(1).max(100)
  .refine((title) => [...title].length <= 50 && !/\p{Cc}/u.test(title));
export const newStickerPackTitle = z.string().trim().min(1).max(128)
  .refine((title) => [...title].length <= 64 && !/\p{Cc}/u.test(title));
export const stickerEmojis = z.array(z.string().min(1).max(32).refine(isStickerEmoji)).max(20)
  .refine((items) => new Set(items.map(stickerEmojiKey)).size === items.length);
export const maxStaticStickerBytes = 512 * 1024;
export const maxTgsBytes = 64 * 1024;
export const maxWebmStickerBytes = 256 * 1024;
export const localStickerFormat = z.enum(["webp", "tgs", "webm"]);
export type LocalStickerFormat = z.infer<typeof localStickerFormat>;
export const maxStickerCoverBytes = 128 * 1024;
const stickerPackCreationResult = z.enum(["created", "nameTaken", "nameInvalid", "changed", "unavailable", "unknown"]);
export type StickerPackCreationResult = z.infer<typeof stickerPackCreationResult>;
const ownedStickerPack = z.object({
  id: stickerPackId, title: z.string().min(1).max(128),
  canRename: z.literal(true).optional(),
  canAddImage: z.literal(true).optional(),
  canReplaceImage: z.literal(true).optional(),
  emojiCoverFileId: ownedStickerFileId.nullable().optional(),
  imageCoverFileId: ownedStickerFileId.nullable().optional(),
  name: ownedStickerPackName.optional(),
  stickers: z.array(z.object({ id: ownedStickerFileId, label: z.string().min(1).max(80),
    preview: z.literal(true).optional(), emojis: stickerEmojis.optional() })).max(200),
});
export type OwnedStickerPack = z.infer<typeof ownedStickerPack>;
const ownedStickerEditResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("saved"), pack: ownedStickerPack }),
  z.object({ state: z.enum(["changed", "unavailable", "unknown"]) }),
]);
export type OwnedStickerEditResult = z.infer<typeof ownedStickerEditResult>;
const ownedStickerPackSnapshot = ownedStickerPack.pick({ id: true, title: true }).extend({
  name: ownedStickerPackName,
  stickerIds: z.array(ownedStickerFileId).max(200),
});
export type OwnedStickerPackSnapshot = z.infer<typeof ownedStickerPackSnapshot>;
const localStickerUpload = z.object({
  emojis: stickerEmojis.refine((items) => items.length > 0),
  base64: z.string().min(1).max(Math.ceil(maxStaticStickerBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  format: localStickerFormat.optional(),
});
const groupEmojiChoice = z.object({ id: customEmojiId, emoji: z.string().min(1).max(32) });
export type GroupEmojiChoice = z.infer<typeof groupEmojiChoice>;
const groupEmojiChoicePage = z.object({ id: stickerPackId, title: z.string().min(1).max(128),
  choices: z.array(groupEmojiChoice).max(20), next: z.number().int().positive().nullable() });
export type GroupEmojiChoicePage = z.infer<typeof groupEmojiChoicePage>;
const groupPackKind = z.enum(["sticker", "emoji"]);
const groupPackChoice = z.object({ id: stickerPackId, title: z.string().min(1).max(128), name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const groupPackSlot = z.object({ id: stickerPackId.nullable(), title: z.string().min(1).max(128).optional(), canSet: z.boolean(), canRemove: z.boolean() });
const groupPacksView = z.object({ sticker: groupPackSlot.optional(), emoji: groupPackSlot.optional() });
const groupPacksResult = z.enum(["saved", "changed", "unavailable"]);
const mediaChoice = z.object({
  id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(),
});
export type MediaChoice = z.infer<typeof mediaChoice>;
const stickerChoicePage = z.object({ choices: z.array(mediaChoice).max(20), next: z.number().int().positive().nullable() });
const mediaChoiceSelection = z.object({ kind: mediaCollectionKind, fileId: z.number().int().positive(),
  stickerQuery: z.string().trim().min(1).max(80).optional(), packId: stickerPackId.optional(), gif: gifSendOptions.optional() })
  .refine(({ kind, stickerQuery, packId, gif }) => kind === "sticker" ? !gif && !(stickerQuery && packId) : !stickerQuery && !packId);
export type MediaChoiceSelection = z.infer<typeof mediaChoiceSelection>;
const groupStickerChoicePage = stickerChoicePage.extend({ id: stickerPackId, title: z.string().min(1).max(128) });
export type GroupPackKind = z.infer<typeof groupPackKind>;
export type GroupPackChoice = z.infer<typeof groupPackChoice>;
export type GroupPacksView = z.infer<typeof groupPacksView>;
export type GroupPacksResult = z.infer<typeof groupPacksResult>;
const stickerPackPreview = z.object({ id: stickerPackId, title: z.string().min(1).max(128), installed: z.boolean(),
  emoji: z.literal(true).optional(),
  link: z.string().regex(/^https:\/\/t\.me\/(?:addstickers|addemoji)\/[A-Za-z0-9_]{1,64}$/).optional(),
  choices: z.array(z.object({
    id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(), customEmoji: customEmojiId.optional(),
  })).max(20),
  next: z.number().int().positive().nullable() });
const stickerPackInstallation = z.enum(["installed", "unavailable", "unknown"]);
export type StickerPackPreviewData = z.infer<typeof stickerPackPreview>;

const reportOptionId = z.string().max(1024).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const reportStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("choose"), option: reportOptionId }),
  z.object({ action: z.literal("details"), option: reportOptionId, text: z.string().max(1024) }),
]);
const chatReportResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("options"), title: z.string().max(512),
    options: z.array(z.object({ id: reportOptionId, label: z.string().min(1).max(512) })).min(1).max(40) }),
  z.object({ state: z.literal("details"), id: reportOptionId, optional: z.boolean() }),
  z.object({ state: z.enum(["sent", "messagesRequired", "unavailable", "unknown"]) }),
]);
export type ChatReportResult = z.infer<typeof chatReportResult>;

const albumPhotoUpload = z.object({ kind: z.literal("photo"), base64: photoSchema.shape.base64 });
const albumFileUpload = z.object({ name: z.string().min(1).max(255), size: z.number().int().positive().max(maxTelegramUploadBytes) });
const albumVideoUpload = albumFileUpload.extend({ kind: z.literal("video"), name: albumFileUpload.shape.name.refine(isVideoAttachmentName) });
const editableAlbumVideoUpload = albumVideoUpload.extend({ videoEdit: videoEdit.optional() });
const albumAudioUpload = albumFileUpload.extend({ kind: z.literal("audio"), name: albumFileUpload.shape.name.refine(isAudioAttachmentName) });
const albumDocumentUpload = albumFileUpload.extend({ kind: z.literal("document") });
const albumLivePhotoUpload = albumVideoUpload.extend({ kind: z.literal("livePhoto"), photo: livePhotoStill });
const albumUploadFields = z.object({
  id: chatId, caption: z.string().trim().max(1024), topic: forumTopicTarget.optional(), reply: mediaReply.optional(),
  delivery: attachmentSendDelivery.optional(), options: albumSendOptions.optional(),
  items: z.array(z.discriminatedUnion("kind", [albumPhotoUpload, editableAlbumVideoUpload, albumDocumentUpload, albumAudioUpload, albumLivePhotoUpload])).min(1).max(10),
});
const albumUpload = albumUploadFields.refine(({ items, caption, options, delivery }) =>
  validAlbumItemCaptions(items.length, caption, options, delivery?.paidStars)
  && (options?.paidStars === undefined && delivery?.paidStars === undefined
    || items.every((item) => item.kind !== "video" || item.videoEdit === undefined))
  && (!options?.originalVideo || options.paidStars === undefined && delivery?.paidStars === undefined
    && items.some(({ kind }) => kind === "video"))).refine(({ items, options, delivery, topic, reply }) => {
  const fileKind = items.find(({ kind }) => kind === "document" || kind === "audio")?.kind;
  if (delivery?.whenOnline && (topic || options?.paidStars !== undefined)) return false;
  if (delivery?.effect !== undefined && (topic || reply?.externalReplyChatId !== undefined || options?.paidStars !== undefined)) return false;
  if (fileKind) return items.length >= 2 && items.every(({ kind }) => kind === fileKind)
    && options?.spoiler === undefined && options?.captionAbove === undefined && options?.paidStars === undefined && delivery?.paidStars === undefined;
  if (items.some(({ kind }) => kind === "livePhoto")) return items.length >= 2 && options?.paidStars === undefined && delivery?.paidStars === undefined;
  return items.some(({ kind }) => kind === "video") && (items.length >= 2 || options?.paidStars !== undefined);
});
export type AlbumUpload = z.infer<typeof albumUpload>;
const channelInboxAlbumPhoto = z.object({ kind: z.literal("photo"), size: z.number().int().positive().max(maxPhotoBytes) });
const channelInboxAlbumUpload = z.object({
  id: chatId, inboxId: chatId, topicId: chatId, caption: albumUploadFields.shape.caption,
  captionFormat: captionFormat.optional(),
  replyTo: channelInboxReply.optional(),
  items: z.array(z.discriminatedUnion("kind", [channelInboxAlbumPhoto, albumVideoUpload, albumDocumentUpload, albumAudioUpload]))
    .min(2).max(10).refine((items) => {
      const fileKind = items.find(({ kind }) => kind === "document" || kind === "audio")?.kind;
      return !fileKind || items.every(({ kind }) => kind === fileKind);
    }),
});
export type ChannelInboxAlbumUpload = z.infer<typeof channelInboxAlbumUpload>;
const quickReplyAlbumUpload = albumUploadFields.pick({ caption: true, items: true }).extend({
  items: z.array(z.discriminatedUnion("kind", [albumPhotoUpload, albumVideoUpload, albumLivePhotoUpload])).min(2).max(10)
    .refine((items) => items.some(({ kind }) => kind !== "photo")),
  media: mediaSendOptions.optional(),
  id: z.number().int().positive().max(2147483647).optional(),
  name: z.string().trim().min(1).max(128),
  styles: textDelivery.shape.styles,
  links: textDelivery.shape.links,
}).refine(({ items }) => items.length >= 2);
export type QuickReplyAlbumUpload = z.infer<typeof quickReplyAlbumUpload>;
function validRichUploadFiles({ draft }: { draft: WelcomeRichComposeDraft }) {
  const media = draft.filter((block) => "size" in block);
  return media.length > 0 && media.length <= 10 && media.every((block) => block.kind === "photo" ? block.size <= maxPhotoBytes
    : block.kind !== "video" || isVideoAttachmentName(block.name));
}
export const welcomeRichUpload = z.object({ id: chatId, draft: welcomeRichComposeDraft,
  replace: z.object({ messageId: z.number().int().positive().max(2147483647), revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).refine(validRichUploadFiles).refine(({ draft, replace }) => !!replace
  || draft.every((block) => block.kind !== "existingMedia" && !("replaces" in block && block.replaces !== undefined)));
export type WelcomeRichUpload = z.infer<typeof welcomeRichUpload>;
export const richMessageUpload = z.object({ id: chatId, draft: richMessageDraft, topic: forumTopicTarget.optional(),
  reply: mediaReply.optional(), delivery: mediaDelivery.optional() }).refine(validRichUploadFiles);
export type RichMessageUpload = z.infer<typeof richMessageUpload>;
export const richMessageEditUpload = messageReference.extend({
  revision: richEdit.shape.revision, draft: welcomeRichComposeDraft,
}).refine(validRichUploadFiles);
export type RichMessageEditUpload = z.infer<typeof richMessageEditUpload>;
const uploadPreparation = z.union([
  z.object({ url: z.string().startsWith("/api/v1/plugins/") }),
  z.object({ rejection: uploadRejection }),
]);

export const businessDayMinutes = 24 * 60;
const businessHoursInterval = z.object({
  startMinute: z.number().int().min(0).max(7 * businessDayMinutes),
  endMinute: z.number().int().min(1).max(8 * businessDayMinutes),
}).refine(({ startMinute, endMinute }) => startMinute < endMinute);
export const businessHours = z.object({
  zone: z.string().min(1).max(128),
  intervals: z.array(businessHoursInterval).min(1).max(28),
});
export type BusinessHours = z.infer<typeof businessHours>;
const businessRecipientId = z.string().regex(/^[1-9]\d{0,15}$/).refine((id) => Number.isSafeInteger(Number(id)));
export const businessRecipients = z.object({
  chats: z.array(businessRecipientId).max(1000).refine((ids) => new Set(ids).size === ids.length),
  existing: z.boolean(), newChats: z.boolean(), contacts: z.boolean(), nonContacts: z.boolean(), exclude: z.boolean(),
});
export const businessBotRightLabels = {
  can_reply: "Reply to messages",
  can_read_messages: "Mark messages as read",
  can_delete_sent_messages: "Delete messages sent by the bot",
  can_delete_all_messages: "Delete any messages",
  can_edit_name: "Edit profile name",
  can_edit_bio: "Edit bio",
  can_edit_profile_photo: "Edit profile photo",
  can_edit_username: "Edit username",
  can_view_gifts_and_stars: "View gifts and Stars",
  can_sell_gifts: "Sell gifts",
  can_change_gift_settings: "Change gift settings",
  can_transfer_and_upgrade_gifts: "Transfer and upgrade gifts",
  can_transfer_stars: "Transfer Stars",
  can_manage_stories: "Manage stories",
} as const;
export type BusinessBotRight = keyof typeof businessBotRightLabels;
export const businessBotRights = Object.keys(businessBotRightLabels) as BusinessBotRight[];
const businessBotIdentity = z.object({
  id: businessRecipientId, name: z.string().min(1).max(256), username: z.string().max(64),
});
export type BusinessBotIdentity = z.infer<typeof businessBotIdentity>;
export const businessBotConnection = z.object({
  botId: businessRecipientId, recipients: businessRecipients,
  excludedChats: businessRecipients.shape.chats,
  rights: z.array(z.enum(businessBotRights)).max(businessBotRights.length).refine((rights) => new Set(rights).size === rights.length),
});
export type BusinessBotConnection = z.infer<typeof businessBotConnection>;
const businessBotRevision = z.string().regex(/^[a-f0-9]{64}$/);
const businessChatLinkUrl = z.string().max(256).refine((url) => telegramBusinessChatLink(url) === url);
const businessChatLinkDraft = z.object({
  text: z.string().max(4096), styles: z.array(styledRange).max(128).optional(), links: messageLinks,
});
const businessChatLinkEntry = z.object({
  url: businessChatLinkUrl, title: z.string().max(128),
  views: z.number().int().nonnegative().max(2147483647), message: businessChatLinkDraft,
  messageEditable: z.boolean(), revision: businessBotRevision,
});
const businessChatLinkTarget = businessChatLinkEntry.pick({ url: true, revision: true });
const linkedBusinessChat = z.object({
  chat: chatSchema, draft: syncedDraft.nullable(), formattingReduced: z.literal(true).optional(),
});
export type LinkedBusinessChat = z.infer<typeof linkedBusinessChat>;
const businessChatLinkChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: businessChatLinkEntry.shape.title, message: businessChatLinkDraft }),
  businessChatLinkTarget.extend({ action: z.literal("edit"), title: businessChatLinkEntry.shape.title,
    message: businessChatLinkDraft.optional() }),
  businessChatLinkTarget.extend({ action: z.literal("delete") }),
]);
export type BusinessChatLinkChange = z.infer<typeof businessChatLinkChange>;
export const businessGreeting = z.object({
  shortcutId: z.number().int().positive().max(2147483647),
  inactivity: z.union([z.literal(7), z.literal(14), z.literal(21), z.literal(28)]),
  recipients: businessRecipients,
});
export type BusinessGreeting = z.infer<typeof businessGreeting>;
const businessAwaySchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({ kind: z.literal("outside") }),
  z.object({ kind: z.literal("custom"), start: z.number().int().positive().max(2147483647),
    end: z.number().int().positive().max(2147483647) }),
]).refine((value) => value.kind !== "custom" || value.end > value.start);
export const businessAway = z.object({
  shortcutId: z.number().int().positive().max(2147483647), recipients: businessRecipients,
  schedule: businessAwaySchedule, offlineOnly: z.boolean(),
});
export type BusinessAway = z.infer<typeof businessAway>;

export const starSubscription = z.object({
  id: z.string().min(1).max(256), title: z.string().min(1).max(256), stars: z.number().int().positive(),
  period: z.number().int().positive().max(2147483647), expires: z.number().int().nonnegative().max(2147483647),
  canceled: z.boolean(), expiring: z.boolean(), canceledByBot: z.boolean(),
});
export type StarSubscription = z.infer<typeof starSubscription>;
const starSubscriptionOffset = z.string().max(1024);
const starAmount = z.object({ stars: z.number().int(), nanostars: z.number().int().min(-999999999).max(999999999) });
export type StarAmount = z.infer<typeof starAmount>;
const starRevenueSummary = z.object({ total: starAmount, current: starAmount, available: starAmount,
  withdrawalEnabled: z.boolean(), nextWithdrawalIn: z.number().int().nonnegative().max(2147483647),
  daily: z.array(z.object({ name: z.string().min(1).max(128), points: z.array(z.object({
    date: z.number().int().positive().max(8640000000000000), stars: z.number().finite(),
  })).min(1).max(3660) })).min(1).max(49).optional() });
export type StarRevenueSummary = z.infer<typeof starRevenueSummary>;
const starTransaction = z.object({
  id: z.string().min(1).max(256), date: z.number().int().positive().max(2147483647),
  amount: starAmount, refund: z.boolean(), label: z.string().min(1).max(256), product: z.string().max(256).optional(),
  counterparty: z.string().min(1).max(256).optional(),
  source: messageReference.optional(),
});
export type StarTransaction = z.infer<typeof starTransaction>;
const starTransactionDirection = z.enum(["all", "incoming", "outgoing"]);
export type StarTransactionDirection = z.infer<typeof starTransactionDirection>;

const miniAppLaunchMode = z.enum(["compact", "fullSize", "fullScreen"]);
export type MiniAppLaunchMode = z.infer<typeof miniAppLaunchMode>;
const miniAppLaunchResult = z.object({ url: z.string().url().max(4096), session: z.uuid(), mode: miniAppLaunchMode.optional(), requireSameOrigin: z.literal(true).optional() }).nullable();
const attachmentMiniApp = z.object({ botId: z.number().int().positive(), label: z.string().min(1).max(256) });
export type AttachmentMiniApp = z.infer<typeof attachmentMiniApp>;
const installedMenuMiniApp = attachmentMiniApp.extend({ attachmentMenu: z.boolean(), sideMenu: z.boolean() });
export type InstalledMenuMiniApp = z.infer<typeof installedMenuMiniApp>;
const attachmentMiniAppReview = attachmentMiniApp.extend({
  installed: z.boolean(), requireTerms: z.boolean(), requestWriteAccess: z.boolean(),
});
export type AttachmentMiniAppReview = z.infer<typeof attachmentMiniAppReview>;
const attachmentMiniAppConsent = z.object({ acceptedTerms: z.boolean(), allowWriteAccess: z.boolean() });
export type AttachmentMiniAppConsent = z.infer<typeof attachmentMiniAppConsent>;

const quickReplyPollTarget = z.object({ id: z.number().int().positive().max(2147483647).optional(),
  name: z.string().trim().min(1).max(128) });
const pollUploadContent = z.object({ draft: pollDraft, files: z.array(pollUploadFile).min(1).max(12) });
export const livePhotoUpload = z.object({
  id: chatId, caption: z.string().trim().max(1024),
  photo: livePhotoStill,
  name: z.string().min(1).max(255).refine(isVideoAttachmentName), size: z.number().int().positive().max(maxDocumentBytes),
  topic: forumTopicTarget.optional(), reply: mediaReply.optional(),
  options: attachmentSendOptions.optional(), delivery: mediaDelivery.optional(),
});
export type LivePhotoUpload = z.infer<typeof livePhotoUpload>;

export const pollUpload = z.union([
  pollUploadContent.extend({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional() }).strict(),
  pollUploadContent.extend({ shortcut: quickReplyPollTarget }).strict(),
]).refine(({ draft, files }) => {
  const slots = files.map(({ slot }) => slot);
  return new Set(slots).size === slots.length && slots.every((slot) => slot === "question"
    ? !draft.questionPhoto && !draft.questionPlace
    : slot === "explanation" ? !!draft.quiz && !draft.quiz.photo && !draft.quiz.place
    : slot < draft.options.length && ![...draft.optionLinks ?? [], ...draft.optionPlaces ?? [], ...draft.optionPhotos ?? [], ...draft.optionStickers ?? []]
      .some(({ index }) => index === slot));
});
export type PollUpload = z.infer<typeof pollUpload>;
export const pollUploadResult = z.union([pollSendResult, z.object({ state: z.literal("submitted") }),
  z.object({ state: z.literal("changed") })]);

const textEditInput = messageReference.extend({
  text: z.string().trim().min(1).max(4096), original: z.string().max(8192),
  originalStyles: textDelivery.shape.styles, styles: textDelivery.shape.styles, links: editLinks.optional(),
  customEmoji: editCustomEmoji.optional(), removeLinkPreview: messageLinkPreview.shape.url.optional(),
});
export type InboxTextEdit = Omit<z.infer<typeof textEditInput>, "id">;
const captionEditInput = textEditInput.omit({ removeLinkPreview: true }).extend({
  text: z.string().trim().max(4096), placement: captionPlacement.optional(),
});
export type InboxCaptionEdit = Omit<z.infer<typeof captionEditInput>, "id">;

export const schemas = {
  openChatView: { input: z.object({ id: chatId, view: z.uuid(), open: z.boolean() }), output: onlineMemberCount },
  peerPresence: { input: z.object({ id: chatId }), output: userPresence },
  retryFailedMessage: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId }),
    output: z.enum(["sent", "failed", "unavailable", "unknown"]) },
  setRecordingActivity: { input: z.object({ id: chatId, topicId: forumTopicId.optional(), activity: recordingActivity }), output: z.boolean() },
  setTypingActivity: { input: z.object({ id: chatId, topicId: forumTopicId.optional(), typing: z.boolean() }), output: z.boolean() },
  botCommands: { input: z.object({ id: chatId }), output: z.array(botCommand).max(100) },
  replyBotKeyboard: { input: z.object({ id: chatId, topicId: forumTopicId.optional() }), output: replyBotKeyboard.nullable() },
  launchReplyMiniApp: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision }),
    output: z.object({ url: z.string().url().max(4096), session: z.uuid() }).nullable() },
  sendReplyMiniAppData: { input: z.object({ session: z.uuid(), data: z.string().min(1).max(4096) }), output: replyBotResult },
  pressReplyBotButton: { input: z.object({ id: chatId, topicId: forumTopicId.optional(),
    messageId: messageReference.shape.messageId, row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision }),
    output: replyBotResult },
  botMiniAppMenu: { input: z.object({ id: chatId }),
    output: z.object({ label: z.string().min(1).max(256), revision: inlineBotRevision }).nullable() },
  launchBotMiniAppMenu: { input: z.object({ id: chatId, revision: inlineBotRevision }),
    output: z.object({ url: z.string().url().max(4096), session: z.uuid() }).nullable() },
  attachmentMiniApps: { input: z.object({ id: chatId, topic: forumTopicTarget.optional() }), output: z.array(attachmentMiniApp).max(64) },
  launchAttachmentMiniApp: { input: z.object({ id: chatId, topic: forumTopicTarget.optional(), app: attachmentMiniApp }), output: miniAppLaunchResult },
  sideMenuMiniApps: { input: z.null(), output: z.array(attachmentMiniAppReview).max(64) },
  launchSideMenuMiniApp: { input: z.object({ app: attachmentMiniAppReview, acceptedTerms: z.boolean() }), output: miniAppLaunchResult },
  installedMenuMiniApps: { input: z.null(), output: z.array(installedMenuMiniApp).max(64) },
  removeMenuMiniApp: { input: z.object({ app: installedMenuMiniApp }), output: z.enum(["removed", "changed", "failed", "unknown"]) },
  previewAttachmentMiniAppLink: { input: z.object({ url: z.string().max(1024), id: chatId, topic: forumTopicTarget.optional() }),
    output: attachmentMiniAppReview.nullable() },
  attachmentMiniAppLinkChats: { input: z.object({ url: z.string().max(1024), query: z.string().max(128) }), output: z.array(chatSchema).max(40) },
  resolveAttachmentMiniAppDestination: { input: z.object({ url: z.string().max(1024) }),
    output: z.object({ chat: chatSchema, review: attachmentMiniAppReview }).nullable() },
  launchAttachmentMiniAppLink: { input: z.object({ url: z.string().max(1024), id: chatId, topic: forumTopicTarget.optional(),
    expected: attachmentMiniAppReview, consent: attachmentMiniAppConsent }), output: miniAppLaunchResult },
  launchInlineMiniApp: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId, row: inlineBotRow,
    column: inlineBotColumn, revision: inlineBotRevision }),
    output: z.object({ url: z.string().url().max(4096), session: z.uuid() }).nullable() },
  previewMiniAppPreparedMessage: { input: z.object({ session: z.uuid(), id: z.string().min(1).max(256) }),
    output: z.union([
      z.object({ confirmation: z.uuid(), title: z.string().min(1).max(256),
        description: z.string().max(512), kind: z.string().min(1).max(64), hasPreview: z.literal(true).optional(),
        details: z.object({
          url: z.string().max(2048).refine((value) => Boolean(webLink(value))).optional(),
          address: z.string().min(1).max(512).optional(),
          artist: z.string().min(1).max(256).optional(),
          fileName: z.string().min(1).max(255).optional(),
          sizeBytes: z.number().int().positive().max(maxDocumentBytes).optional(),
          approximateSize: z.literal(true).optional(),
          durationSeconds: z.number().int().positive().max(2147483647).optional(),
          dimensions: z.object({ width: z.number().int().positive().max(65535), height: z.number().int().positive().max(65535) }).optional(),
        }).optional() }),
      z.object({ error: z.enum(["ID_EXPIRED", "ID_INVALID"]) }),
    ]).nullable() },
  miniAppPreparedThumbnail: { input: z.object({ session: z.uuid(), confirmation: z.uuid() }), output: photoSchema.nullable() },
  miniAppPreparedChats: { input: z.object({ session: z.uuid(), confirmation: z.uuid(), query: z.string().max(128) }),
    output: z.array(chatSchema.extend({ forum: z.literal(true).optional() })).max(40) },
  miniAppPreparedTopics: { input: z.object({ session: z.uuid(), confirmation: z.uuid(), id: chatId, query: z.string().trim().max(128),
    cursor: forumTopicCursor.optional() }), output: z.object({ topics: z.array(forumTopicTarget).max(40), next: forumTopicCursor.nullable() }).nullable() },
  sendMiniAppPreparedMessage: { input: z.object({ session: z.uuid(), confirmation: z.uuid(), id: chatId,
    expectedName: z.string().min(1).max(256), topic: forumTopicTarget.optional() }), output: z.enum(["sent", "failed", "unknown"]) },
  miniAppInlineChats: { input: z.object({ session: z.uuid(), types: z.array(miniAppChatType).min(1).max(4),
    query: z.string().trim().max(128) }), output: z.array(chatSchema.extend({ forum: z.literal(true).optional() })).max(40) },
  miniAppInlineTopics: { input: z.object({ session: z.uuid(), types: z.array(miniAppChatType).min(1).max(4), id: chatId,
    query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }),
    output: z.object({ topics: z.array(forumTopicTarget).max(40), next: forumTopicCursor.nullable() }).nullable() },
  miniAppInlineDestination: { input: z.object({ session: z.uuid(), types: z.array(miniAppChatType).min(1).max(4), id: chatId,
    topic: forumTopicTarget.optional() }), output: z.object({ chat: chatSchema, topic: forumTopic.optional() }).nullable() },
  previewMiniAppChatRequest: { input: z.object({ session: z.uuid(), requestId: z.string().min(1).max(128) }),
    output: z.union([
      z.object({ confirmation: z.uuid(), bot: z.string().min(1).max(256), kind: z.enum(["users", "group", "channel"]),
        max: z.number().int().min(1).max(10), fields: z.array(z.enum(["name", "username", "photo"])).max(3),
        botAccess: miniAppRequestedBotAccess.optional(), creation: z.enum(["group", "forum", "channel"]).optional(),
        requiresUsername: z.literal(true).optional() }),
      managedBotReview.extend({ kind: z.literal("managedBot") }),
      z.object({ error: z.enum(["UNSUPPORTED", "REQUEST_UNAVAILABLE"]) }),
    ]) },
  findMiniAppRequestedChats: { input: z.object({ session: z.uuid(), confirmation: z.uuid(), query: z.string().trim().max(128) }),
    output: z.array(z.object({ id: chatId, name: z.string().min(1).max(256), subtitle: z.string().max(32) })).max(40) },
  createMiniAppRequestedChat: { input: z.object({ session: z.uuid(), confirmation: z.uuid(),
    title: z.string().trim().min(1).max(128), username: miniAppPublicUsername.optional() }), output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready"), chat: z.object({ id: chatId, name: z.string().min(1).max(256), subtitle: z.string().max(32) }) }),
    z.object({ state: z.literal("usernameUnavailable"), chatCreated: z.boolean() }),
    z.object({ state: z.enum(["createdUnshareable", "failed", "unknown"]) }),
  ]) },
  shareMiniAppRequestedChats: { input: z.object({ session: z.uuid(), confirmation: z.uuid(),
    selected: z.array(z.object({ id: chatId, name: z.string().min(1).max(256) })).min(1).max(10) }),
    output: z.enum(["sent", "failed", "unknown"]) },
  createMiniAppManagedBot: { input: z.object({ session: z.uuid(), confirmation: z.uuid(), draft: managedBotDraft }),
    output: z.enum(["createdAndShared", "createdUnconfirmed", "usernameUnavailable", "limitReached", "failed", "unknown"]) },
  previewManagedBotLink: { input: z.object({ url: z.string().max(4096) }), output: managedBotReview.nullable() },
  createLinkedManagedBot: { input: z.object({ confirmation: z.uuid(), draft: managedBotDraft }),
    output: z.enum(["created", "usernameUnavailable", "limitReached", "failed", "unknown"]) },
  closeMiniApp: { input: z.object({ session: z.uuid() }), output: z.boolean() },
  previewMiniAppInvoice: { input: z.object({ session: z.uuid(), slug: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) }),
    output: z.object({ title: z.string().min(1).max(256), description: z.string().max(4096), stars: z.number().int().positive(),
      confirmation: z.uuid(), billingPeriodSeconds: z.number().int().positive().max(2147483647).optional() }).nullable() },
  payMiniAppInvoice: { input: z.object({ session: z.uuid(), confirmation: z.uuid() }), output: z.enum(["paid", "failed", "pending"]) },
  purchasePaidMedia: { input: messageReference.extend({ stars: z.number().int().positive() }),
    output: z.enum(["paid", "changed", "failed", "pending"]) },
  starSubscriptions: { input: z.object({ offset: starSubscriptionOffset }),
    output: z.object({ subscriptions: z.array(starSubscription).max(100), next: starSubscriptionOffset,
      balance: starAmount.optional(),
      requiredStars: z.number().int().nonnegative().optional() }).nullable() },
  editStarSubscription: { input: z.object({ offset: starSubscriptionOffset, expected: starSubscription, cancel: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  starTransactions: { input: z.object({ offset: starSubscriptionOffset, direction: starTransactionDirection,
    subscription: starSubscription.shape.id.optional(), ownerChat: chatId.optional() }),
    output: z.object({ transactions: z.array(starTransaction).max(50), next: starSubscriptionOffset, balance: starAmount.optional() }).nullable() },
  channelStarRevenue: { input: z.object({ id: chatId }), output: starRevenueSummary.nullable() },
  previewMiniAppPhone: { input: z.object({ session: z.uuid() }),
    output: z.object({ confirmation: z.uuid(), bot: z.string().min(1).max(256) }).nullable() },
  shareMiniAppPhone: { input: z.object({ session: z.uuid(), confirmation: z.uuid() }),
    output: z.enum(["sent", "failed", "unknown"]) },
  miniAppWriteAccess: { input: z.object({ session: z.uuid(), confirm: z.boolean() }),
    output: z.enum(["allowed", "prompt", "unavailable"]) },
  previewMiniAppEmojiAccess: { input: z.object({ session: z.uuid() }), output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("allowed") }),
    z.object({ kind: z.literal("review"), confirmation: z.uuid(), bot: z.string().min(1).max(256) }),
  ]).nullable() },
  confirmMiniAppEmojiAccess: { input: z.object({ session: z.uuid(), confirmation: z.uuid() }), output: z.boolean() },
  previewMiniAppEmojiStatus: { input: z.object({ session: z.uuid(), emoji: customEmojiId.nullable(),
    duration: z.number().int().min(0).max(2147483647) }), output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("review"), confirmation: z.uuid(), label: z.string().max(64) }),
      z.object({ kind: z.literal("failed"), error: z.enum(["UNSUPPORTED", "SUGGESTED_EMOJI_INVALID", "DURATION_INVALID", "SERVER_ERROR"]) }),
    ]) },
  confirmMiniAppEmojiStatus: { input: z.object({ session: z.uuid(), confirmation: z.uuid() }), output: z.boolean() },
  miniAppLocationAccess: { input: z.object({ session: z.uuid(), decision: miniAppLocationDecision.optional() }),
    output: z.object({ bot: z.string().min(1).max(256), decision: miniAppLocationDecision }).nullable() },
  miniAppSecureStorage: { input: z.object({ session: z.uuid(), operation: miniAppDeviceStorageOperation }),
    output: miniAppSecureStorageResult },
  miniAppDeviceStorage: { input: z.object({ session: z.uuid(), operation: miniAppDeviceStorageOperation }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), value: z.string().max(maxMiniAppDeviceStorageBytes).nullable() }),
      z.object({ status: z.literal("failed"), error: z.enum(["QUOTA_EXCEEDED", "UNKNOWN_ERROR"]) }),
    ]) },
  miniAppClipboardAccess: { input: z.object({ session: z.uuid() }),
    output: z.object({ bot: z.string().min(1).max(256) }).nullable() },
  checkMiniAppDownload: { input: z.object({ session: z.uuid(), url: z.string().min(1).max(4096), fileName: z.string().min(1).max(255) }),
    output: z.object({ bot: z.string().min(1).max(256) }).nullable() },
  invokeMiniAppCustomMethod: { input: z.object({ session: z.uuid(), method: z.string().min(1).max(128), parameters: z.string().max(32 * 1024) }),
    output: z.union([z.object({ result: z.string().max(64 * 1024) }),
      z.object({ error: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/) })]).nullable() },
  pressInlineBotButton: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision }), output: botButtonAnswer },
  inlineBotProfile: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision }), output: chatSchema.nullable() },
  inlineBotDestinationChats: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision, query: z.string().trim().max(128) }),
    output: z.array(chatSchema.extend({ forum: z.literal(true).optional() })).max(40) },
  inlineBotDestinationChat: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision, destination: chatId }),
    output: chatSchema.extend({ forum: z.literal(true).optional() }).nullable() },
  inlineBotDestinationTopics: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision, destination: chatId,
    query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }),
    output: z.object({ topics: z.array(forumTopicTarget).max(40), next: forumTopicCursor.nullable() }).nullable() },
  inlineBotDestinationTopic: { input: z.object({ id: chatId, messageId: messageReference.shape.messageId,
    row: inlineBotRow, column: inlineBotColumn, revision: inlineBotRevision, destination: chatId, topic: forumTopicTarget }),
    output: forumTopic.nullable() },
  readPreview: { input: z.object({ requestId: z.uuid(), id: z.string().max(32) }), output: z.string().max(8192) },
  runtimeInfo: { input: z.null(), output: runtimeInfo },
  removeProfilePhoto: { input: z.object({ expected: existingAvatarVersion }), output: saveAvatarResult },
  publicProfilePhoto: { input: z.null(), output: secondaryAvatarPhoto.nullable() },
  savePublicProfilePhoto: { input: avatarUpdate, output: saveAvatarResult },
  removePublicProfilePhoto: { input: z.object({ expected: existingAvatarVersion }), output: saveAvatarResult },
  saveProfilePhoto: { input: avatarUpdate, output: saveAvatarResult },
  saveProfileVideo: { input: avatarVideoUpdate, output: saveAvatarResult },
  ownProfilePhotos: { input: z.object({ offset: profilePhotoOffset }), output: profilePhotoPage },
  ownProfilePhoto: { input: z.object({ offset: profilePhotoOffset, photoId: profilePhotoId }), output: photoSchema },
  restoreProfilePhoto: { input: z.object({ offset: profilePhotoOffset, photoId: profilePhotoId, expected: avatarVersion }), output: saveAvatarResult },
  removePreviousProfilePhoto: { input: z.object({ offset: profilePhotoOffset, photoId: profilePhotoId, expected: avatarVersion }), output: saveAvatarResult },
  telegramProfile: { input: z.null(), output: telegramProfile },
  messageEmojiStatus: { input: z.object({ emoji: customEmojiId }),
    output: z.object({ expected: profileEmojiStatus.nullable() }).nullable() },
  saveMessageEmojiStatus: { input: messageEmojiStatusChange, output: z.enum(["saved", "changed", "unsupported"]) },
  personalChannelSettings: { input: z.null(), output: personalChannelSettings },
  savePersonalChannel: { input: personalChannelChange, output: z.enum(["saved", "changed", "unsupported"]) },
  checkTelegramUsername: { input: z.object({ username: editableUsername }), output: usernameCheck },
  temporaryProfileLink: { input: z.null(), output: z.object({
    url: z.string().max(256), expiresIn: z.number().int().positive().max(2147483647),
  }).nullable() },
  chatEmojiChoices: { input: z.object({ id: chatId }), output: z.array(profileEmojiChoice).max(120) },
  saveChatEmojiStatus: { input: profileEmojiChange.extend({ id: chatId }), output: z.enum(["saved", "changed", "unsupported"]) },
  profileEmojiChoices: { input: z.null(), output: z.array(profileEmojiChoice).max(120) },
  saveProfileEmojiStatus: { input: profileEmojiChange, output: z.enum(["saved", "changed", "unsupported"]) },
  saveTelegramProfile: { input: profileChange, output: z.enum(["saved", "changed", "unsupported"]) },
  telegramPrivacy: { input: z.object({ key: telegramPrivacyKey }), output: telegramPrivacyView },
  privacyExceptions: { input: z.object({ key: telegramPrivacyKey, offset: z.number().int().min(0).max(1020), version: telegramPrivacyView.shape.version.optional() }), output: privacyExceptionPage.nullable() },
  searchPrivacyExceptionTargets: { input: z.object({ query: z.string().trim().min(2).max(128) }),
    output: z.array(namedPrivacyException).max(30) },
  changePrivacyException: { input: privacyExceptionChange, output: z.enum(["saved", "changed", "unsupported"]) },
  changePremiumInvites: { input: z.object({ version: telegramPrivacyView.shape.version, allowed: z.boolean() }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  saveTelegramPrivacy: { input: z.object({ key: telegramPrivacyKey, audience: telegramPrivacyAudience, expected: telegramPrivacyView.shape.version }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  chatAutoDelete: { input: z.object({ id: chatId }), output: chatAutoDelete.nullable() },
  saveChatAutoDelete: { input: z.object({ id: chatId, days: autoDeleteDays, expected: autoDeleteDays }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  clearChatDateScopes: { input: z.object({ id: chatId }), output: z.array(clearChatDateScope).max(2) },
  clearChatByDate: { input: z.object({ id: chatId, range: clearChatDateRange, scope: clearChatDateScope }),
    output: z.enum(["deleted", "refused", "unknown", "localUnconfirmed"]) },
  defaultAutoDeleteDays: { input: z.null(), output: autoDeleteDays },
  saveDefaultAutoDeleteDays: { input: z.object({ days: autoDeleteDays, expected: autoDeleteDays }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  archiveSettings: { input: z.null(), output: archiveSettingsView },
  saveArchiveSettings: { input: z.object({ values: archiveSettings, expected: archiveSettings }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  readDatePrivacy: { input: z.null(), output: z.boolean() },
  sensitiveContentSettings: { input: z.null(), output: sensitiveContentSettings },
  saveSensitiveContentSettings: { input: z.object({ show: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  newChatPrivacy: { input: z.null(), output: newChatPrivacy },
  saveNewChatPrivacy: { input: z.object({ audience: newChatAudience, expected: newChatAudience }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  saveReadDatePrivacy: { input: z.object({ show: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  activeDevices: { input: z.null(), output: z.array(telegramDevice).max(200) },
  pendingDeviceSignIns: { input: z.null(), output: z.number().int().min(0).max(200) },
  confirmDevice: { input: z.object({ id: deviceId, revision: deviceReviewRevision }),
    output: z.enum(["confirmed", "changed", "unavailable"]) },
  terminateDevice: { input: z.object({ id: deviceId, application: telegramDevice.shape.application, device: telegramDevice.shape.device }), output: z.boolean() },
  terminateOtherDevices: { input: z.object({ expected: otherDeviceIds }), output: z.enum(["terminated", "changed", "unavailable"]) },
  sessionInactivity: { input: z.null(), output: sessionInactivityDays.nullable() },
  setSessionInactivity: { input: z.object({ days: sessionInactivityDays, expected: sessionInactivityDays }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  incomingCalls: { input: z.null(), output: z.boolean().nullable() },
  setIncomingCalls: { input: z.object({ enabled: z.boolean(), expected: z.boolean() }).strict(),
    output: z.enum(["saved", "changed", "unavailable"]) },
  privateCallStatus: { input: z.object({ cameraClient: z.uuid() }).strict().nullable(), output: privateCallStatus },
  startPrivateCall: { input: z.object({ chatId, video: z.boolean().optional(), cameraClient: z.uuid().optional() }).strict(), output: z.boolean() },
  actOnPrivateCall: { input: z.object({ id: privateCall.shape.id,
    action: privateCallAction, cameraClient: z.uuid().optional() }).strict(), output: z.boolean() },
  autoMediaPolicy: { input: z.null(), output: autoMediaPolicy },
  setAutoMediaPolicy: { input: autoMediaPolicy, output: autoMediaPolicy },
  autoPlaybackPolicy: { input: z.null(), output: autoPlaybackPolicy },
  setAutoPlaybackPolicy: { input: autoPlaybackPolicy, output: autoPlaybackPolicy },
  autoPlaybackOverrides: { input: z.null(), output: autoPlaybackOverrides },
  setChatAutoPlaybackOverride: { input: z.object({ id: chatId, limits: autoPlaybackLimits.nullable() }), output: autoPlaybackLimits.nullable() },
  autoMediaOverrides: { input: z.null(), output: autoMediaOverrides },
  setChatAutoMediaOverride: { input: z.object({ id: chatId, limits: autoMediaLimits.nullable() }), output: autoMediaLimits.nullable() },
  prefetchVisibleMedia: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: z.boolean() },
  setLanguagePreference: {
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("interface"), value: telegramInterfaceLanguage }),
      z.object({ kind: z.literal("translation"), value: defaultTranslationLanguage }),
    ]),
    output: z.null(),
  },
  cacheInfo: { input: z.null(), output: cacheInfo },
  setCacheLimit: { input: z.object({ limitMiB: cacheLimitMiB, retentionDays: cacheRetentionDays.optional() }), output: cacheInfo },
  clearCache: { input: z.union([z.null(), z.object({ category: clearableCacheCategory }).strict(), z.object({ chatId }).strict()]), output: cacheInfo },
  proxies: { input: z.null(), output: telegramProxy.array() },
  saveProxy: { input: z.object({ id: proxyId.optional(), draft: proxyDraft }), output: telegramProxy },
  changeProxy: { input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("disable") }),
    z.object({ action: z.enum(["enable", "remove"]), id: proxyId }),
  ]), output: z.boolean() },
  pingProxy: { input: z.object({ id: proxyId }), output: z.number().int().nonnegative() },
  exportTelegramAccount: { input: chatExportOptions,
    output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  exportChat: { input: z.object({ id: chatId, options: chatExportOptions }),
    output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  aiHistoryExcerpt: { input: z.object({ id: chatId }), output: z.array(z.object({
    author: z.string(), text: z.string(), timestamp: z.number().optional(),
  })).max(20) },
  saveSelectedAttachments: { input: z.object({ id: chatId, ids: z.array(messageReference.shape.messageId).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length), format: z.literal("html").optional() }),
    output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  saveChannelInboxAttachments: { input: channelInboxSelection.extend({ format: z.literal("html").optional() })
    .refine(({ ids }) => new Set(ids).size === ids.length),
    output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  storyFeed: { input: z.object({ list: storyList, more: z.boolean() }), output: storyFeed },
  joinedCommunities: { input: z.null(), output: z.array(communitySummary).max(100).nullable() },
  communityFolderMemberships: { input: z.object({ id: chatId }), output: communityFolderMemberships.nullable() },
  changeCommunityFolder: { input: communityFolderChange, output: z.enum(["queued", "changed", "unavailable"]) },
  folderCommunities: { input: z.object({ id: folderId }), output: folderCommunities.nullable() },
  collapsedCommunities: { input: z.null(), output: z.array(collapsedCommunity).max(100) },
  changeCommunityCollapse: { input: communityCollapseChange, output: z.enum(["saved", "changed", "unavailable"]) },
  communityChats: { input: z.object({ id: chatId }), output: communityChats.nullable() },
  communityForwardChats: { input: z.object({ id: chatId }), output: z.array(forwardTarget.omit({ topic: true })).max(100).nullable() },
  unbanFromCommunityList: { input: communityListUnban, output: z.enum(["communityUnbanned", "changed", "unavailable"]) },
  communityBannedMembers: { input: z.object({ id: chatId, offset: communityBannedOffset }), output: communityBannedMembers.nullable() },
  communityModerationCounts: { input: z.object({ id: chatId }), output: communityModerationCounts.nullable() },
  communitySourceChats: { input: z.null(), output: z.array(communitySourceChat).max(200).nullable() },
  createCommunity: { input: communityCreation, output: communitySummary.nullable() },
  renameCommunity: { input: communityRename, output: z.enum(["saved", "changed", "unavailable"]) },
  deleteCommunity: { input: communityDeletion, output: z.enum(["deleted", "changed", "unavailable"]) },
  changeCommunityPermissions: { input: communityPermissionChange, output: z.enum(["saved", "changed", "unavailable"]) },
  communityPhotoState: { input: z.object({ id: chatId }), output: communityAvatar.extend({ version: avatarVersion }).nullable() },
  communityAvatar: { input: z.object({ id: chatId, fileId: pollFileId }), output: photoSchema },
  communityAvatarVideoInfo: { input: z.object({ id: chatId }), output: communityAvatarVideo.nullable() },
  communityAvatarVideo: { input: communityAvatarVideo.extend({ id: chatId }), output: z.string().startsWith("/api/v1/plugins/") },
  saveCommunityPhoto: { input: avatarUpdate.extend({ id: chatId }), output: saveAvatarResult },
  saveCommunityVideo: { input: avatarVideoUpdate.extend({ id: chatId }), output: saveAvatarResult },
  removeCommunityPhoto: { input: z.object({ id: chatId, expected: existingAvatarVersion }), output: saveAvatarResult },
  communityNotificationState: { input: z.object({ id: chatId }), output: chatNotificationState.nullable() },
  changeCommunityNotification: { input: communityNotificationChange, output: z.enum(["saved", "changed", "unavailable"]) },
  changeCommunityChat: { input: communityChatChange, output: z.enum(["saved", "requested", "changed", "unavailable"]) },
  communityAddRequests: { input: z.object({ id: chatId, offset: communityRequestOffset }), output: communityRequests.nullable() },
  decideCommunityAddRequests: { input: communityRequestBatch, output: z.enum(["saved", "changed", "unavailable"]) },
  decideCommunityAddRequest: { input: communityRequestDecision, output: z.enum(["saved", "changed", "unavailable"]) },
  resolveStoryAlbumLink: { input: z.object({ url: z.string().max(256) }), output: linkedStoryAlbum.nullable() },
  storyAlbumLink: { input: z.object({ id: chatId, album: storyId }), output: z.string().max(256).nullable() },
  storyAlbums: { input: z.object({ id: chatId }), output: z.array(storyAlbum).max(100) },
  storyAlbumPage: { input: z.object({ id: chatId, album: storyId, offset: storyId.optional() }), output: profileStoryPage },
  storyProfileEditable: { input: z.object({ id: chatId }), output: z.boolean() },
  setProfileStoryOrder: { input: storyOrderEdit, output: storyOrderResult },
  setStoryAlbumOrder: { input: storyOrderEdit, output: storyOrderResult },
  setStoryAlbumStoryOrder: { input: storyOrderEdit.extend({ album: storyId }), output: storyOrderResult },
  storyAlbumCandidates: { input: z.object({ id: chatId, archive: z.boolean(), before: storyId.optional() }), output: profileStoryPage },
  createStoryAlbum: { input: z.object({ id: chatId, name: storyAlbumName, stories: storyOrder }), output: storyAlbumChangeResult },
  changeStoryAlbum: { input: z.object({ id: chatId, album: storyAlbum, change: storyAlbumChange }), output: storyAlbumChangeResult },
  profileStories: { input: z.object({ id: chatId, before: storyId.optional() }), output: profileStoryPage },
  ownArchivedStories: { input: z.object({ id: chatId, before: storyId.optional() }), output: profileStoryPage },
  storyMusicPlayback: { input: storyReference.extend({ fileId: z.number().int().positive() }), output: z.string().startsWith("/api/v1/plugins/") },
  storyAreaPostLink: { input: storyReference.extend({ post: forwardedPost }), output: z.string().max(256).nullable() },
  storyView: { input: storyReference, output: storyView },
  replyToStory: { input: storyReference.extend({ text: z.string().trim().min(1).max(4096) }),
    output: z.enum(["sent", "failed", "unknown"]) },
  resolveStoryLink: { input: z.object({ url: z.string().max(256) }), output: linkedStory.nullable() },
  storyLink: { input: storyReference, output: z.string().url().nullable() },
  storyInteractions: { input: storyReference.extend({ offset: z.string().max(1024).optional(), filter: storyActivityFilter.optional() }), output: storyInteractionPage },
  changeStoryAudience: { input: storyReference.extend({ expected: storyAudience, audience: storyAudience }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  editStoryCaption: { input: storyReference.extend({ expected: z.string().max(8192), caption: z.string().max(200) }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  manageStory: { input: storyReference.extend({ action: storyManagement }), output: z.boolean() },
  storyViewing: { input: storyReference.extend({ opened: z.boolean() }), output: z.boolean() },
  setStorySuggestedReaction: { input: storyReference.extend({ reaction: selectableReaction, remove: z.boolean() }), output: z.boolean() },
  setStoryReaction: { input: storyReference.extend({ emoji: reactionEmoji.nullable() }), output: z.boolean() },
  storyReactionCatalog: { input: storyReference, output: z.array(selectableReaction).max(100) },
  setStoryCatalogReaction: { input: storyReference.extend({ reaction: selectableReaction.nullable() }), output: z.boolean() },
  moveStoryAuthor: { input: z.object({ id: chatId, from: storyList }), output: z.boolean() },
  storyStealthStatus: { input: z.null(), output: storyStealthStatus },
  activateStoryStealth: { input: z.null(), output: storyStealthActivation },
  networkUsage: { input: z.null(), output: networkUsage },
  businessChatLinks: { input: z.null(), output: z.object({
    links: z.array(businessChatLinkEntry).max(1000), canEdit: z.boolean(),
  }) },
  changeBusinessChatLink: { input: businessChatLinkChange, output: z.enum(["saved", "deleted", "changed", "unavailable", "invalid"]) },
  businessStartPage: { input: z.null(), output: z.object({
    title: z.string().max(1024), message: z.string().max(4096),
    titleLimit: z.number().int().positive().max(1024), messageLimit: z.number().int().positive().max(4096),
    hasSticker: z.boolean(), editable: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable() },
  saveBusinessStartPage: { input: z.object({ title: z.string().max(1024), message: z.string().max(4096),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    sticker: z.object({ packId: stickerPackId, fileId: z.number().int().positive() }).nullable().optional(),
  }), output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  businessLocation: { input: z.null(), output: z.object({ address: z.string().max(384), point: locationPoint.nullable(),
    revision: z.string().regex(/^[a-f0-9]{64}$/) }).nullable() },
  saveBusinessLocation: { input: z.object({
    location: z.object({ address: z.string().trim().min(1).max(384), point: locationPoint.nullable() }).nullable(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }), output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  businessHours: { input: z.null(), output: z.object({
    hours: businessHours.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    zones: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(128) })).max(1000),
  }).nullable() },
  saveBusinessHours: { input: z.object({ hours: businessHours.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  businessBot: { input: z.null(), output: z.object({
    connection: businessBotConnection.nullable(), identity: businessBotIdentity.nullable(), revision: businessBotRevision,
    pending: z.object({ date: z.number().int().positive().max(2147483647), device: z.string().max(256),
      location: z.string().max(256), revision: businessBotRevision }).optional(),
  }) },
  confirmBusinessBot: { input: z.object({ revision: businessBotRevision }), output: z.enum(["saved", "changed", "unavailable"]) },
  chatBusinessBot: { input: z.object({ id: chatId }), output: z.object({
    botId: businessRecipientId, identity: businessBotIdentity.nullable(), paused: z.boolean(), canReply: z.boolean(),
    revision: businessBotRevision,
  }).nullable() },
  changeChatBusinessBot: { input: z.object({ id: chatId, action: z.enum(["pause", "resume", "remove"]), revision: businessBotRevision }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  findBusinessBot: { input: z.object({ username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }), output: businessBotIdentity.nullable() },
  saveBusinessBot: { input: z.object({ connection: businessBotConnection.nullable(), revision: businessBotRevision }),
    output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  businessGreeting: { input: z.null(), output: z.object({
    greeting: businessGreeting.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable() },
  saveBusinessGreeting: { input: z.object({ greeting: businessGreeting.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  businessAway: { input: z.null(), output: z.object({ away: businessAway.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).nullable() },
  saveBusinessAway: { input: z.object({ away: businessAway.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.enum(["saved", "changed", "unavailable", "invalid"]) },
  quickReplies: { input: z.object({ chatId }).nullable(), output: z.array(z.object({
    id: z.number().int().positive().max(2147483647),
    name: z.string().min(1).max(128),
    messageCount: z.number().int().nonnegative().max(2147483647),
    preview: z.string().max(512).optional(),
  })).max(100) },
  quickReplyMessages: { input: z.object({ id: z.number().int().positive().max(2147483647) }),
    output: z.array(richInline.pick({ text: true, styles: true, links: true, customEmoji: true }).extend({
      id: z.number().int().positive(),
      albumId: messageSchema.shape.albumId,
      text: z.string().max(8192),
      styles: z.array(styledRange).max(128).optional(),
      mediaLabel: z.string().max(80).optional(),
      captionAboveMedia: z.literal(true).optional(),
      mediaSpoiler: z.literal(true).optional(),
      delivery: z.enum(["pending", "failed"]).optional(),
      retryRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      contact: sharedContact.optional(),
      location: messageLocation.optional(),
      poll: pollInfo.optional(),
      editRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      deleteRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      photo: instantViewPhoto.extend({ motion: photoMotion.optional() }).optional(),
      document: documentInfo.extend({ fileId: instantViewPhoto.shape.fileId.optional() }).optional(),
      tgsStickerFileId: instantViewPhoto.shape.fileId.optional(),
      playback: z.object({ fileId: z.number().int().positive(), mime: playbackMime,
        spoiler: z.boolean(), loop: z.boolean(), voiceNote: z.boolean(), videoNote: z.boolean() }).optional(),
    })).max(100) },
  quickReplyPhoto: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), fileId: instantViewPhoto.shape.fileId, size: photoSize.optional(), pollSlot: pollAttachmentReference.shape.slot.optional() }), output: photoSchema },
  quickReplyPollSticker: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), reference: pollAttachmentReference }), output: customEmojiMedia.nullable() },
  quickReplyTgsSticker: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), fileId: instantViewPhoto.shape.fileId }),
    output: z.string().min(1).max(2 * 1024 * 1024) },
  quickReplyPlayback: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), fileId: z.number().int().positive(), pollSlot: pollAttachmentReference.shape.slot.optional() }),
    output: z.string().startsWith("/api/v1/plugins/") },
  quickReplyDocument: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), fileId: instantViewPhoto.shape.fileId, pollSlot: pollAttachmentReference.shape.slot.optional() }),
    output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  renameQuickReply: { input: z.object({ id: z.number().int().positive().max(2147483647),
    expected: z.string().min(1).max(128), name: z.string().trim().min(1).max(128) }),
    output: z.enum(["renamed", "changed", "invalid"]) },
  editQuickReplyText: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().trim().max(4096), styles: textDelivery.shape.styles, links: textDelivery.shape.links,
    captionAbove: z.boolean().optional(), spoiler: z.boolean().optional() }),
    output: z.enum(["updated", "changed", "invalid"]) },
  retryQuickReplyMessage: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(128) }), output: z.enum(["submitted", "changed", "unavailable", "unknown"]) },
  deleteQuickReplyMessage: { input: z.object({ id: z.number().int().positive().max(2147483647),
    messageId: z.number().int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    messageCount: z.number().int().positive().max(100) }),
    output: z.enum(["deleted", "changed"]) },
  addQuickReplyText: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), text: z.string().trim().min(1).max(4096),
    styles: textDelivery.shape.styles, links: textDelivery.shape.links }),
    output: z.enum(["submitted", "changed", "invalid"]) },
  addQuickReplyContact: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), contact: contactDraft }),
    output: z.enum(["submitted", "changed", "invalid"]) },
  addQuickReplyPoll: { input: quickReplyPollTarget.extend({ draft: pollDraft }),
    output: z.enum(["submitted", "changed", "invalid", "unavailable"]) },
  addQuickReplyLocation: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), point: locationPoint, venue: quickReplyVenue.optional() }),
    output: z.enum(["submitted", "changed", "invalid"]) },
  addQuickReplySticker: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), packId: stickerPackId, fileId: z.number().int().positive() }),
    output: z.enum(["submitted", "changed", "invalid"]) },
  addQuickReplyPhoto: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), caption: z.string().trim().max(1024), base64: photoSchema.shape.base64,
    styles: textDelivery.shape.styles, links: textDelivery.shape.links, media: mediaSendOptions.optional() }),
    output: z.enum(["submitted", "changed", "invalid"]) },
  addQuickReplyPhotoAlbum: { input: z.object({ id: z.number().int().positive().max(2147483647).optional(),
    name: z.string().trim().min(1).max(128), caption: z.string().trim().max(1024),
    photos: z.array(photoSchema.shape.base64).min(2).max(10),
    styles: textDelivery.shape.styles, links: textDelivery.shape.links, media: mediaSendOptions.optional() }),
    output: quickReplyDocumentResult },
  sendQuickReply: { input: z.object({ chatId, id: z.number().int().positive().max(2147483647),
    name: z.string().min(1).max(128), messageCount: z.number().int().positive().max(2147483647),
    preview: z.string().max(512).optional() }),
    output: z.enum(["submitted", "changed", "unavailable", "unknown", "incomplete"]) },
  deleteQuickReply: { input: z.object({ id: z.number().int().positive().max(2147483647),
    name: z.string().min(1).max(128), messageCount: z.number().int().nonnegative().max(2147483647) }),
    output: z.enum(["deleted", "changed"]) },
  reorderQuickReplies: { input: z.object({
    ids: z.array(z.number().int().positive().max(2147483647)).min(2).max(100),
    expected: z.array(z.number().int().positive().max(2147483647)).min(2).max(100),
  }), output: z.enum(["updated", "changed", "invalid"]) },
  resetNetworkUsage: { input: z.null(), output: z.boolean() },
  agentAccess: { input: z.null(), output: agentAccessSchema },
  setAgentAccess: { input: z.object({ capability: z.enum(["read", "send"]), enabled: z.boolean() }), output: agentAccessSchema },
  chatAgentAccess: { input: z.object({ id: chatId }), output: z.boolean() },
  setChatAgentAccess: { input: z.object({ id: chatId, enabled: z.boolean() }), output: z.boolean() },
  status: { input: z.null(), output: authSchema },
  accountSelection: { input: z.null(), output: telegramAccountSelection },
  selectTelegramAccount: { input: selectTelegramAccount, output: authSchema },
  renameTelegramAccount: { input: renameTelegramAccount, output: telegramAccountSelection },
  embedChatChoices: { input: z.strictObject({ query: z.string().trim().max(128) }),
    output: z.array(z.object({ id: chatId, name: z.string(), forum: z.literal(true).optional() })).max(40) },
  bindEmbedChat: { input: conversationLocation.strict(), output: z.uuidv4() },
  resolveEmbedChat: { input: z.strictObject({ resourceRef: z.uuidv4() }), output: resumedConversation },
  embedChatAction: { input: z.strictObject({ resourceRef: z.uuidv4(), method: z.enum(["history", "historyMessage", "peerProfile", "send", "sendTopicText",
    "prepareDocumentUpload", "chatDraft", "topicDraft", "saveChatDraft"]), payload: z.record(z.string(), z.unknown()) }), output: z.unknown() },
  sessionRpc: { input: z.object({ connectionId: z.uuid(), method: z.string().min(1).max(80), payload: z.unknown() }).strict(), output: z.unknown() },
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
  reorderFolders: { input: z.object({
    order: z.array(folderId).min(1).max(100), expected: z.array(folderId).min(1).max(100),
    mainPosition: folderPosition.optional(), expectedMainPosition: folderPosition.optional(),
  }).refine(({ mainPosition, expectedMainPosition }) => (mainPosition === undefined) === (expectedMainPosition === undefined)),
    output: z.enum(["saved", "changed", "unavailable"]) },
  recommendedFolders: { input: z.null(), output: z.array(recommendedFolder).max(30) },
  addRecommendedFolder: { input: z.object({ token: recommendedFolderToken }), output: folderSchema },
  folderEditor: { input: z.object({ id: folderId }), output: folderEditor },
  saveFolder: { input: folderDraft.extend({ id: folderId.optional(), expectedRevision: recommendedFolderToken.optional() }), output: folderSchema.nullable() },
  deleteFolder: { input: z.object({ id: folderId, title: z.string().min(1).max(128) }), output: z.boolean() },
  setFolderMembership: { input: z.object({ id: folderId, chatId, mode: folderMembershipMode }), output: z.boolean() },
  folderMemberships: { input: z.object({ chatId }), output: z.array(folderMembership) },
  folders: { input: z.null(), output: z.array(folderSchema) },
  folderLayout: { input: z.null(), output: folderLayoutSchema },
  contacts: { input: z.object({ query: z.string().trim().max(128), offset: z.number().int().nonnegative().max(10000).optional() }), output: contactPage },
  contactBirthdays: { input: z.null(), output: z.array(contactBirthday).max(contactBirthdayLimit) },
  contactDirectory: { input: z.object({ initial: contactInitial.optional(), offset: z.number().int().nonnegative().max(10000).optional() }), output: contactDirectoryPage },
  blockedSenders: { input: z.object({ list: senderBlockList, offset: z.number().int().min(0).max(2147483647) }), output: namedSenderPage },
  openBlockedSender: { input: z.object({ sender: messageSender }), output: chatSchema },
  unblockListedSender: { input: z.object({ sender: messageSender, list: senderBlockList }), output: z.boolean() },
  senderBlockState: { input: z.object({ id: chatId }), output: senderBlockState.nullable() },
  setSenderBlockState: { input: z.object({ id: chatId, expected: senderBlockState, next: senderBlockState }), output: z.boolean() },
  contactDetails: { input: z.object({ id: chatId }), output: contactDetails.nullable() },
  personalContactPhoto: { input: z.object({ id: chatId, userId: contactId }), output: secondaryAvatarPhoto.nullable() },
  savePersonalContactPhoto: { input: avatarUpdate.extend({ id: chatId, userId: contactId }), output: saveAvatarResult },
  removePersonalContactPhoto: { input: z.object({ id: chatId, userId: contactId, expected: existingAvatarVersion }), output: saveAvatarResult },
  contactNote: { input: z.object({ id: chatId }), output: contactNote.nullable() },
  suggestContactProfilePhoto: { input: z.object({ id: chatId, userId: contactId, base64: photoSchema.shape.base64 }),
    output: z.enum(["sent", "unavailable", "unknown"]) },
  suggestedProfilePhoto: { input: messageReference.extend({ photoId: profilePhotoId }),
    output: z.object({ photo: photoSchema, currentVersion: avatarVersion.optional() }).nullable() },
  acceptSuggestedProfilePhoto: { input: messageReference.extend({ photoId: profilePhotoId, expected: avatarVersion }),
    output: saveAvatarResult },
  suggestContactBirthday: { input: z.object({ id: chatId, userId: contactId, birthdate: telegramBirthdate }),
    output: z.enum(["sent", "unavailable", "unknown"]) },
  acceptBirthdaySuggestion: { input: messageReference.extend({ birthdate: telegramBirthdate }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  saveContactNote: { input: z.object({ id: chatId, revision: contactNote.shape.revision,
    text: z.string().max(maxContactNoteLength) }), output: z.enum(["saved", "changed", "unavailable"]) },
  saveContact: { input: z.object({ id: chatId, userId: contactId, expected: contactDetails, names: contactNames }), output: z.boolean() },
  removeContact: { input: z.object({ id: chatId, userId: contactId, expected: contactDetails }), output: z.boolean() },
  openSharedContact: { input: messageReference.extend({ userId: contactId }), output: chatSchema },
  openContact: { input: z.object({ id: contactId }), output: chatSchema },
  search: { input: z.object({ query: z.string().trim().min(2).max(128), list: chatListSchema.optional() }), output: z.array(chatSchema) },
  recentSearchChats: { input: z.null(), output: z.array(chatSchema).max(50) },
  frequentSearchContacts: { input: z.null(), output: z.array(chatSchema).max(12) },
  updateRecentSearch: { input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("record"), id: chatId }),
    z.object({ action: z.literal("remove"), id: chatId }),
    z.object({ action: z.literal("clear") }),
  ]), output: z.boolean() },
  chatPage: {
    input: z.object({ list: chatListSchema, offset: z.number().int().min(0).max(9999) }),
    output: z.object({ chats: z.array(chatSchema), nextOffset: z.number().int().nullable(), unreadCounts: unreadListCount.array().optional() }),
  },
  notificationChat: { input: z.object({ id: chatId }), output: chatSchema.nullable() },
  channelDirectMessages: { input: z.object({ id: chatId }), output: chatSchema.nullable() },
  channelInboxTopics: { input: z.object({ id: chatId, inboxId: chatId, offset: z.number().int().nonnegative().max(2147483647) }),
    output: channelInboxTopics },
  channelInboxTopicsSnapshot: { input: z.object({ id: chatId, inboxId: chatId, count: z.number().int().min(30).max(2147483647),
    selected: chatId.optional() }), output: channelInboxTopicsSnapshot },
  channelInboxHistory: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId,
    before: messageReference.shape.messageId.optional(), after: messageReference.shape.messageId.optional() })
    .refine(({ before, after }) => !before || !after),
    output: historyPage },
  channelInboxMessage: { input: messageReference.extend({ inboxId: chatId, topicId: chatId }), output: messageSchema.nullable() },
  editChannelInboxText: { input: textEditInput.extend({ inboxId: chatId, topicId: chatId }), output: sendResult },
  editChannelInboxCaption: { input: captionEditInput.extend({ inboxId: chatId, topicId: chatId }), output: sendResult },
  searchChannelInboxMessages: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId, query: z.string().trim().max(128),
    before: messageReference.shape.messageId.optional(), range: messageSearchDateRange.optional(), filter: channelInboxSearchFilter.optional() })
    .refine(({ query, filter }) => filter !== undefined || query.length >= 2, { path: ["query"] }), output: messageSearchPage },
  channelInboxMessageAtDate: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId, date: z.number().int().positive().max(2147483647) }),
    output: messageReference.shape.messageId.nullable() },
  channelInboxMessageContext: { input: messageReference.extend({ inboxId: chatId, topicId: chatId, direction: contextDirection.optional() }),
    output: z.array(messageSchema) },
  markChannelInboxTopic: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId, unread: z.boolean() }),
    output: channelInboxReadState.nullable() },
  markVisibleChannelInboxMessage: { input: messageReference.extend({ inboxId: chatId, topicId: chatId, clearUnreadMark: z.literal(true).optional() }),
    output: channelInboxReadState.nullable() },
  channelInboxBan: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId }), output: channelInboxBan.nullable() },
  changeChannelInboxBan: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId, expected: channelInboxBan }),
    output: z.enum(["updated", "changed", "unavailable", "unknown"]) },
  clearChannelInboxByDate: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId, range: clearChatDateRange }),
    output: z.enum(["deleted", "refused", "unknown"]) },
  clearChannelInboxConversation: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId }),
    output: z.enum(["deleted", "refused", "unknown"]) },
  channelInboxMessageDeletable: { input: messageReference.extend({ inboxId: chatId, topicId: chatId }), output: z.boolean() },
  channelInboxSelectionDeletable: { input: channelInboxMessageBatch, output: z.boolean() },
  channelInboxMessagePinStatus: { input: messageReference.extend({ inboxId: chatId, topicId: chatId }), output: z.boolean().nullable() },
  setChannelInboxMessagePinned: { input: messageReference.extend({ inboxId: chatId, topicId: chatId, pinned: z.boolean() }),
    output: z.enum(["updated", "refused", "unknown"]) },
  channelInboxBulkUnpinPreview: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId }),
    output: messageReference.shape.messageId.nullable() },
  unpinChannelInboxMessages: { input: messageReference.extend({ inboxId: chatId, topicId: chatId }),
    output: z.enum(["updated", "changed", "refused", "unknown"]) },
  deleteChannelInboxMessage: { input: messageReference.extend({ inboxId: chatId, topicId: chatId }),
    output: z.enum(["deleted", "refused", "unknown"]) },
  deleteChannelInboxSelection: { input: channelInboxMessageBatch, output: z.enum(["deleted", "refused", "unknown"]) },
  runChannelInboxRichBotCommand: { input: channelInboxMessageReference.extend({ command: richBotCommand }), output: sendResult },
  sendChannelInboxText: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId,
    text: z.string().trim().min(1).max(4096), replyTo: channelInboxReply.optional(),
    format: captionFormat.optional() }), output: sendResult },
  resumeConversation: { input: conversationLocation, output: resumedConversation.nullable() },
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
  notificationExceptions: {
    input: z.object({ scope: notificationScope, offset: z.number().int().min(0).max(9999) }),
    output: notificationExceptionPage,
  },
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
  pinnedChatOrder: { input: z.object({ list: markableChatList }), output: z.array(chatId).max(100).nullable() },
  movePinnedChat: { input: z.object({ list: markableChatList, id: chatId, direction: z.enum(["up", "down"]),
    expected: z.array(chatId).min(2).max(100) }), output: z.enum(["updated", "changed", "refused", "unknown"]) },
  archiveChat: { input: z.object({ id: chatId, archived: z.boolean() }), output: chatSchema },
  previewInvite: { input: z.object({ url: z.string().max(128) }), output: invitePreview.nullable() },
  previewWebLink: { input: z.object({ url: messageLinkPreview.shape.url.refine((url) => !!webLink(url)) }), output: linkPreviewMetadata.nullable() },
  joinInvite: { input: z.object({ url: z.string().max(128), expected: inviteTarget }), output: chatJoinResult },
  joinChat: { input: z.object({ id: chatId, name: z.string().min(1).max(256) }), output: chatJoinResult },
  chatLeaveOptions: { input: z.object({ id: chatId, name: z.string().min(1).max(256) }),
    output: z.object({ owner: z.boolean(), basic: z.boolean(), canDelete: z.literal(true).optional() }).nullable() },
  canReportChat: { input: z.object({ id: chatId }), output: z.boolean() },
  reportChat: { input: z.object({ id: chatId, name: z.string().min(1).max(256),
    messageIds: z.array(messageReference.shape.messageId).min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length).optional(),
    step: reportStep }), output: chatReportResult },
  reportStory: { input: storyReference.extend({ step: reportStep }), output: chatReportResult },
  leaveChat: { input: z.object({ id: chatId, name: z.string().min(1).max(256), expectedOwner: z.boolean() }),
    output: z.enum(["left", "refused", "unknown"]) },
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
  markHistoryRead: { input: messageReference.extend({ topicId: forumTopicId.optional(), clearUnreadMark: z.literal(true).optional() }), output: z.boolean() },
  markChatListRead: { input: z.object({ list: markableChatList }), output: markReadResult },
  avatar: { input: z.object({ id: chatId, fileId: z.number().int().positive(), user: z.boolean().optional() }), output: photoSchema },
  locationMap: { input: messageReference, output: mapPreview },
  photo: { input: messageReference.extend({ size: photoSize.optional(), attachment: richAttachmentReference.optional() }), output: photoSchema },
  recognizePhotoText: { input: messageReference.extend({
    size: photoSize, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }), output: photoTextResult.nullable() },
  drawPhotoReplyTarget: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: drawPhotoDestination.nullable() },
  pollPhoto: { input: messageReference.extend({ size: photoSize.optional(), reference: pollAttachmentReference }), output: photoSchema },
  pollDocument: { input: messageReference.extend({ reference: pollAttachmentReference }),
    output: z.object({ name: documentInfo.shape.name, url: z.string().startsWith("/api/v1/plugins/") }) },
  pollStickerArtwork: { input: messageReference.extend({ reference: pollAttachmentReference }), output: customEmojiMedia.nullable() },
  pollPlayback: { input: messageReference.extend({ reference: pollAttachmentReference }),
    output: z.string().startsWith("/api/v1/plugins/") },
  miniAppAgentGrant: { input: z.object({ session: z.uuid(), threadId: z.string().min(1).max(256),
    mode: miniAppAgentMode, snapshot: miniAppAgentSnapshot }), output: z.boolean() },
  miniAppAgentRevoke: { input: z.object({ session: z.uuid() }), output: z.boolean() },
  miniAppAgentPoll: { input: z.object({ session: z.uuid(), snapshot: miniAppAgentSnapshot,
    completed: z.object({ id: z.number().int().positive(), sent: z.boolean() }).optional() }), output: miniAppAgentState.nullable() },
  launchProfileMiniApp: { input: z.object({ id: chatId }), output: miniAppLaunchResult },
  launchMiniApp: { input: z.object({ url: z.string().max(1024) }), output: miniAppLaunchResult },
  launchAgeVerification: { input: z.strictObject({ expectedBot: miniAppPublicUsername }), output: miniAppLaunchResult },
  resolveBotStartLink: { input: z.object({ url: z.string().max(256) }), output: botStartTarget.nullable() },
  resolveGameLink: { input: z.object({ url: z.string().max(256) }), output: linkedGame.nullable() },
  gameLinkChats: { input: z.object({ query: z.string().trim().max(128) }),
    output: z.array(chatSchema.extend({ forum: z.literal(true).optional() })).max(40) },
  gameLinkTopics: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }),
    output: z.object({ topics: z.array(forumTopicTarget).max(40), next: forumTopicCursor.nullable() }).nullable() },
  sendGameLink: { input: z.object({ url: z.string().max(256), bot: chatId, target: forwardTarget }), output: botStartResult },
  resolveTemporaryContactLink: { input: z.object({ url: z.string().max(256) }), output: chatSchema.nullable() },
  resolveBusinessChatLink: { input: z.object({ url: businessChatLinkUrl }), output: linkedBusinessChat.nullable() },
  startLinkedBot: { input: z.object({ url: z.string().max(256), id: chatId, name: z.string().min(1).max(256) }),
    output: botStartResult },
  resolveCollectibleGift: { input: z.object({ url: z.string().max(160) }), output: linkedCollectibleGift.nullable() },
  resolveBoostLink: { input: z.object({ url: z.string().max(128) }), output: chatSchema.nullable() },
  resolveMessageLink: { input: z.object({ url: z.string().max(256) }), output: linkedTelegramMessage.nullable() },
  messageLink: { input: messageReference.extend({ target: messageLinkTarget.optional() }), output: z.string().max(256).nullable() },
  forumTopicLink: { input: z.object({ id: chatId, topic: forumTopicId }), output: z.string().max(256).nullable() },
  sendChannelComment: { input: messageReference.extend({ group: chatId, root: discussionPage.shape.root,
    text: z.string().trim().min(1).max(4096),
  }), output: sendResult },
  channelDiscussion: { input: messageReference.extend({ before: z.string().regex(/^[1-9]\d{0,15}$/).optional() }), output: discussionPage },
  firstUnreadMessage: { input: z.object({ id: chatId, topicId: forumTopicId.optional() }), output: messageReference.shape.messageId.nullable() },
  messageAtDate: { input: z.object({ id: chatId, date: z.number().int().positive().max(2147483647), topicId: forumTopicId.optional() }),
    output: messageReference.shape.messageId.nullable() },
  messageContextPage: { input: messageReference.extend({ topicId: forumTopicId.optional(), direction: contextDirection }),
    output: z.array(messageSchema).max(20) },
  historyMessage: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: messageSchema.nullable() },
  messageContext: { input: messageReference.extend({ topicId: forumTopicId.optional() }), output: z.array(messageSchema).max(initialMessageContextLimit) },
  translateMessage: { input: messageReference.extend({ language: translationLanguage }), output: messageTranslation.nullable() },
  instantView: { input: z.object({ url: messageLinkPreview.shape.url }), output: instantViewArticle.nullable() },
  instantViewDocument: { input: z.object({ url: messageLinkPreview.shape.url, fileId: instantViewPhoto.shape.fileId }),
    output: z.object({ name: documentInfo.shape.name, url: z.string().startsWith("/api/v1/plugins/") }) },
  instantViewMap: { input: z.object({ url: messageLinkPreview.shape.url, point: articleMapPoint }), output: mapPreview },
  instantViewIcon: { input: z.object({ url: messageLinkPreview.shape.url, fileId: instantViewIconRange.shape.fileId }), output: instantViewIconImage },
  instantViewMention: { input: z.object({ url: messageLinkPreview.shape.url, userId: instantViewMentionRange.shape.userId }), output: chatSchema.nullable() },
  instantViewJoinTarget: { input: instantViewChatLinkReference, output: instantViewJoinTarget.nullable() },
  joinInstantViewChat: { input: instantViewChatLinkReference.extend({ expected: instantViewJoinTarget }), output: chatJoinResult },
  instantViewPhoto: { input: z.object({ url: messageLinkPreview.shape.url, fileId: instantViewPhoto.shape.fileId,
    size: photoSize.optional() }), output: photoSchema },
  instantViewPlayback: { input: z.object({ url: messageLinkPreview.shape.url, fileId: z.number().int().positive() }),
    output: z.string().startsWith("/api/v1/plugins/") },
  prepareVoiceTranscription: { input: messageReference, output: z.uuid() },
  transcribeVoice: { input: messageReference.extend({ ticket: z.uuid().optional(), timed: z.literal(true).optional() }), output: voiceTranscriptResult },
  cancelVoiceTranscription: { input: z.object({ ticket: z.uuid() }), output: z.boolean() },
  markNotePlayed: { input: messageReference, output: z.boolean() },
  messageWidgetPreview: { input: messageReference,
    output: z.object({ html: z.string().min(1).max(32768) }).nullable() },
  messagePreviewCover: { input: messageReference.extend({ fileId: z.number().int().positive(), size: photoSize.optional() }), output: photoSchema },
  messagePreviewPlayback: { input: messageReference.extend({ fileId: z.number().int().positive() }),
    output: z.string().startsWith("/api/v1/plugins/") },
  videoStream: { input: messageReference.extend({ attachment: richAttachmentReference.optional(), motionFileId: pollFileId.optional(),
    qualityFileId: videoQuality.shape.fileId.optional(), playbackFileId: playbackFileId.optional() })
    .refine(({ attachment, motionFileId, qualityFileId, playbackFileId }) =>
      Number(!!attachment) + Number(!!motionFileId) + Number(!!qualityFileId) <= 1 && (!playbackFileId || (!attachment && !motionFileId))),
    output: z.string().startsWith("/api/v1/plugins/") },
  document: {
    input: messageReference.extend({ playback: z.boolean().optional(), oneView: z.literal(true).optional(), attachment: richAttachmentReference.optional(),
      playbackFileId: playbackFileId.optional()
    }).refine(({ playback, oneView, attachment, playbackFileId }) =>
      (!oneView || !attachment) && (!playbackFileId || (playback && !attachment && !oneView))),
    output: z.object({ name: documentInfo.shape.name, url: z.string().startsWith("/api/v1/plugins/") }),
  },
  preparePhotoDrag: {
    input: messageReference,
    output: photoDragTicket,
  },
  markdownDocument: { input: messageReference.extend({ attachment: richAttachmentReference.omit({ paid: true }).strict().optional(), format: z.literal("text").optional() }),
    output: z.string().max(maxMarkdownDocumentBytes) },
  tgsSticker: { input: messageReference, output: z.string().min(1).max(2 * 1024 * 1024) },
  messageEffect: { input: messageReference.extend({ effect: messageEffectId, animate: z.boolean() }), output: messageEffectView.nullable() },
  messageEffects: { input: z.object({ id: chatId }), output: z.array(messageEffectChoice).max(64) },
  queueDownload: { input: messageReference, output: z.boolean() },
  downloadQueue: { input: z.object({ filter: downloadQueueFilter, offset: z.string().max(1024), query: z.string().trim().max(128).optional() }),
    output: downloadQueuePage },
  downloadCounts: { input: z.null(), output: downloadQueueCounts.extend({ progress: downloadQueueProgress.optional() }).nullable() },
  downloadThumbnail: { input: messageReference.extend({ fileId: queueFileId }), output: photoSchema.nullable() },
  manageDownload: { input: z.object({ fileId: queueFileId, action: downloadQueueAction }), output: z.boolean() },
  pauseAllDownloads: { input: z.object({ paused: z.boolean() }), output: z.boolean() },
  clearCompletedDownloads: { input: z.null(), output: z.boolean() },
  customEmoji: { input: z.object({ id: customEmojiId }), output: customEmojiMedia.nullable() },
  customEmojiPack: { input: z.object({ id: customEmojiId, offset: z.number().int().nonnegative().max(2147483647), packId: stickerPackId.optional() })
    .refine(({ offset, packId }) => offset === 0 || packId !== undefined), output: stickerPackPreview.nullable() },
  globalSearch: { input: z.object({
    query: z.string().trim().max(128), mode: globalSearchMode, cursor: globalSearchCursor.optional(), filter: globalSearchMediaFilter.optional(),
    range: messageSearchDateRange.optional(), scope: globalSearchScope.optional(),
  }).refine(({ query, mode, filter }) => mode === "media" || (!filter && query.length >= 2), { path: ["query"] })
    .refine(({ mode, range, scope }) => mode !== "public" || (!range && !scope), { path: ["mode"] }),
    output: globalSearchPage },
  globalMediaThumbnail: { input: messageReference.extend({ fileId: z.number().int().positive().optional() }), output: photoSchema.nullable() },
  recentPublicTags: { input: z.object({ prefix: telegramSearchTagPrefix }), output: z.array(telegramSearchTag).max(24) },
  removeRecentPublicTag: { input: z.object({ tag: telegramSearchTag }), output: z.boolean() },
  clearRecentPublicTags: { input: z.object({ kind: telegramSearchTagKind }), output: z.boolean() },
  searchPublicDiscovery: {
    input: z.object({ query: z.string().trim().min(1).max(128), mode: publicDiscoveryMode }),
    output: z.array(chatSchema).max(50),
  },
  browsePublicDiscovery: {
    input: z.object({ mode: publicDiscoveryDirectoryMode, offset: publicDiscoveryOffset.optional() })
      .refine(({ mode, offset }) => mode === "apps" || offset === undefined),
    output: publicDiscoveryPage,
  },
  searchMessages: {
    input: z.object({ id: chatId, query: z.string().trim().max(128), filter: messageSearchFilter.optional(), topicId: forumTopicId.optional(), before: messageReference.shape.messageId.optional(), sender: messageSender.optional(), range: messageSearchDateRange.optional() })
      .refine(({ query, filter, sender }) => !!sender || filter !== undefined || query.length >= 2, { path: ["query"] })
      .refine(({ query, filter, sender, range }) => !searchRequiresEmptyQuery(filter) || !query && !sender && !range, { path: ["filter"] }),
    output: messageSearchPage,
  },
  sharedContentCounts: { input: z.object({ id: chatId }), output: sharedContentCounts },
  listReactions: { input: messageReference, output: z.array(selectableReaction).max(100) },
  channelInboxReactions: { input: channelInboxMessageReference, output: z.array(selectableReaction).max(100) },
  setChannelInboxReaction: { input: channelInboxMessageReference.extend({ reaction: selectableReaction, chosen: z.boolean() }), output: z.boolean() },
  channelInboxReactionPeople: { input: channelInboxMessageReference.extend({ reaction: selectableReaction.optional(), offset: z.string().max(1024) }),
    output: reactionPeoplePage.nullable() },
  channelInboxReactionPerson: { input: channelInboxMessageReference.extend({ target: reactionPersonReference }), output: chatSchema.nullable() },
  paidReactionPeople: { input: messageReference, output: z.array(z.object({
    name: z.string().min(1).max(256), stars: z.number().int().positive(), own: z.boolean(), anonymous: z.boolean(), top: z.boolean(),
  })).max(100) },
  paidReactionLimit: { input: messageReference, output: z.number().int().positive().nullable() },
  paidReactionSenders: { input: z.object({ id: chatId }), output: z.array(z.object({ id: chatId, name: z.string().min(1).max(256) })).max(100) },
  sendPaidReaction: { input: messageReference.extend({ stars: z.number().int().positive(), anonymous: z.boolean(), asChat: chatId.optional() }),
    output: z.enum(["sent", "failed", "unknown"]) },
  setPaidReactionAnonymity: { input: messageReference.extend({ expected: z.boolean(), anonymous: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  setReaction: { input: messageReference.extend({ reaction: selectableReaction, chosen: z.boolean() }), output: z.boolean() },
  quickReaction: { input: z.object({}), output: selectableReaction.nullable() },
  setQuickReaction: { input: z.object({ reaction: selectableReaction }), output: z.boolean() },
  chatReactionSettings: { input: z.object({ id: chatId }), output: chatReactionSettings.nullable() },
  setChatReactionPolicy: { input: z.object({ id: chatId, policy: chatReactionPolicy, expected: chatReactionPolicy }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  reactionPeople: { input: messageReference.extend({ reaction: selectableReaction.optional(), offset: z.string().max(1024) }),
    output: reactionPeoplePage.nullable() },
  reactionPerson: { input: messageReference.extend({ target: reactionPersonReference }), output: chatSchema.nullable() },
  copySelectedText: { input: z.object({ id: chatId, ids: copySelection, includeHtml: selectionHtml.optional() }),
    output: z.union([z.string().max(524288), selectedRichText]).nullable() },
  copyChannelInboxSelection: { input: channelInboxSelection.extend({ includeHtml: selectionHtml.optional() }),
    output: z.union([z.string().max(524288), selectedRichText]).nullable() },
  forwardSelectionOptions: { input: z.object({ id: chatId, ids: messageBatch }), output: z.boolean() },
  forwardSelectedMessages: { input: z.object({ id: chatId, ids: messageBatch,
    target: forwardTarget, presentation: forwardPresentation.optional(), delivery: forwardBatchDelivery.optional(),
    comment: forwardComment.optional() }).refine(({ target, delivery }) => !delivery?.whenOnline
      || (target.kind === "Direct message" && !target.topic)), output: forwardResult },
  forwardOptions: { input: messageReference.extend({ album: albumSelection.optional() }), output: z.boolean() },
  forwardMessage: { input: messageReference.extend({ target: forwardTarget, album: albumSelection.optional(), presentation: forwardPresentation.optional(),
    delivery: forwardDelivery.optional(), comment: forwardComment.optional() }).refine(({ target, album, delivery }) =>
      (!(delivery?.effect || delivery?.whenOnline) || (target.kind === "Direct message" && !target.topic))
      && (!(delivery?.effect || delivery?.repeatEvery) || !album)), output: forwardResult },
  channelInboxForwardOptions: { input: channelInboxMessageReference.extend({ album: albumSelection.optional() }), output: z.boolean() },
  forwardChannelInboxMessage: { input: channelInboxMessageReference.extend({ target: forwardTarget, album: albumSelection.optional(),
    presentation: forwardPresentation.optional(), delivery: forwardDelivery.optional(), comment: forwardComment.optional() })
      .refine(({ target, album, delivery }) => (!(delivery?.effect || delivery?.whenOnline) || (target.kind === "Direct message" && !target.topic))
        && (!(delivery?.effect || delivery?.repeatEvery) || !album)), output: forwardResult },
  channelInboxForwardSelectionOptions: { input: channelInboxMessageBatch, output: z.boolean() },
  forwardChannelInboxSelection: { input: channelInboxMessageBatch.extend({ target: forwardTarget,
    presentation: forwardPresentation.optional(), delivery: forwardBatchDelivery.optional(), comment: forwardComment.optional() })
      .refine(({ target, delivery }) => !delivery?.whenOnline || (target.kind === "Direct message" && !target.topic)), output: forwardResult },
  richMessageLimits: { input: z.object({}), output: richMessageAvailability },
  editRichMessage: { input: messageReference.extend({ draft: welcomeRichEditDraft, revision: richEdit.shape.revision }), output: sendResult },
  sendRichMessage: { input: z.object({ id: chatId, draft: richMessageDraft, topic: forumTopicTarget.optional(),
    reply: mediaReply.optional(), delivery: mediaDelivery.optional() }), output: sendResult },
  checklistAvailability: { input: z.object({ id: chatId }), output: checklistAvailability },
  sendChecklist: { input: z.object({ id: chatId, draft: checklistDraft, topic: forumTopicTarget.optional(),
    reply: mediaReply.optional(), delivery: mediaDelivery.optional() }),
    output: z.union([sendResult, z.object({ state: z.enum(["premium_required", "unavailable"]) })]) },
  sendContactCard: {
    input: z.object({ id: chatId, contact: contactDraft, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional() }),
    output: sendResult,
  },
  sendLocation: {
    input: z.object({ id: chatId, point: locationPoint, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional() }),
    output: sendResult,
  },
  channelPollLimits: { input: z.object({ id: chatId }), output: channelPollLimits.nullable() },
  preparePollUpload: { input: pollUpload, output: uploadPreparation },
  sendPoll: { input: z.object({ id: chatId, draft: pollDraft, topic: forumTopicTarget.optional(), reply: mediaReply.optional() }), output: pollSendResult },
  stopPoll: { input: messageReference, output: z.boolean() },
  addPollOption: { input: messageReference.extend({ text: pollOptionText }), output: pollOptionChangeResult },
  canRemovePollOption: { input: messageReference.extend(pollSuggestedOption.shape), output: z.boolean() },
  removePollOption: { input: messageReference.extend(pollSuggestedOption.shape), output: pollOptionChangeResult },
  voteInPoll: { input: messageReference.extend({ choices: z.array(pollChoice).max(100) }), output: z.boolean() },
  setChecklistTask: { input: messageReference.extend({ taskId: checklistTaskId, expected: z.boolean(), done: z.boolean() }),
    output: checklistChange },
  editChecklist: { input: messageReference.extend({ expected: checklist.shape.editRevision.unwrap(), draft: checklistEdit }),
    output: checklistChange },
  addChecklistTask: { input: messageReference.extend({ task: checklistLine, expected: z.array(checklistTaskId).min(1).max(100) }),
    output: checklistChange },
  pollVoteHistory: { input: messageReference.extend({ at: pollGraphTime.optional() }), output: pollVoteGraph.nullable() },
  pollVoters: { input: messageReference.extend({ choice: pollChoice, offset: z.number().int().min(0).max(2147483647) }),
    output: namedSenderPage.nullable() },
  pinStatus: { input: messageReference, output: z.boolean().nullable() },
  setMessagePinned: { input: messageReference.extend({ pinned: z.boolean(), mode: messagePinMode.optional() }), output: z.enum(["updated", "refused", "unknown"]) },
  unpinAllPreview: { input: z.object({ id: chatId, topic: forumTopicTarget.optional() }), output: messageReference.shape.messageId.nullable() },
  unpinAllMessages: { input: messageReference.extend({ topic: forumTopicTarget.optional() }), output: z.enum(["updated", "changed", "refused", "unknown"]) },
  pinnedMessage: { input: z.object({ id: chatId }), output: messageSchema.nullable() },
  manageForumTopic: { input: z.object({ id: chatId, action: forumTopicAction }), output: forumTopic },
  deleteForumTopic: { input: z.object({ id: chatId, topic: forumTopicId, name: z.string().min(1).max(256) }),
    output: z.enum(["deleted", "refused", "unknown"]) },
  markForumTopicRead: { input: z.object({ id: chatId, topic: forumTopicId }), output: z.boolean() },
  markForumRead: { input: z.object({ id: chatId }), output: markReadResult },
  forumTopicPage: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }), output: forumTopicPage.nullable() },
  pinnedForumTopicOrder: { input: z.object({ id: chatId }), output: z.array(forumTopicId).max(100).nullable() },
  movePinnedForumTopic: { input: z.object({ id: chatId, topic: forumTopicId, direction: z.enum(["up", "down"]),
    expected: z.array(forumTopicId).min(2).max(100) }), output: z.enum(["updated", "changed", "refused", "unknown"]) },
  forumTopics: { input: z.object({ id: chatId, query: z.string().trim().max(128) }), output: z.array(forumTopic).max(40).nullable() },
  savedSources: { input: z.object({ offset: z.number().int().nonnegative() }), output: savedSourcePage },
  savedSourceTags: { input: z.object({ sourceId: savedSourceId }), output: z.array(savedTag).max(100) },
  setSavedSourcePinned: { input: z.object({ sourceId: savedSourceId, pinned: z.boolean(), expected: z.boolean() }),
    output: z.enum(["updated", "changed", "refused"]) },
  reorderSavedSources: { input: z.object({ order: z.array(savedSourceId).min(2).max(40), expected: z.array(savedSourceId).min(2).max(40) }),
    output: z.enum(["updated", "changed", "refused"]) },
  savedSourceHistory: {
    input: z.object({
      sourceId: savedSourceId,
      before: messageReference.shape.messageId.optional(),
      query: z.string().trim().min(1).max(128).optional(),
      date: z.number().int().positive().max(2147483647).optional(),
      filter: savedSourceFilter.optional(),
      tag: savedTagType.optional(),
    }).refine(({ date, query, before, filter, tag }) =>
      (date === undefined || query === undefined && before === undefined && filter === undefined && tag === undefined)
      && (tag === undefined || filter === undefined)),
    output: historyPage,
  },
  history: { input: z.object({ id: chatId, before: chatId.optional(), topicId: forumTopicId.optional() }), output: historyPage },
  unreadHistory: { input: messageReference.omit({ messageId: true }).extend({ after: messageReference.shape.messageId.optional(), topicId: forumTopicId.optional() }), output: historyPage.nullable() },
  messageViewers: { input: messageReference, output: z.array(messageViewer).nullable() },
  messageViewerProfile: { input: messageReference.extend({ userId: messageViewer.shape.id }), output: chatSchema.nullable() },
  messageReadTime: { input: messageReference, output: messageReadTime },
  deletionOptions: { input: messageReference, output: z.array(deletionScope).max(2) },
  batchDeletionOptions: { input: z.object({ id: chatId, ids: z.array(messageReference.shape.messageId).min(2).max(100) }),
    output: z.array(deletionScope).max(2) },
  deleteSelectedMessages: { input: z.object({ id: chatId, ids: z.array(messageReference.shape.messageId).min(2).max(100), scope: deletionScope }),
    output: z.enum(["deleted", "refused", "unknown"]) },
  deleteMessage: { input: messageReference.extend({ scope: deletionScope }), output: z.enum(["deleted", "refused", "unknown"]) },
  replaceMessagePhoto: { input: messageReference.extend({ revision: messageSchema.shape.photoEditRevision.unwrap(), base64: photoSchema.shape.base64, scheduled: scheduledEdit.optional() }), output: sendResult },
  editCaption: { input: captionEditInput.extend({ scheduled: scheduledEdit.optional() }), output: sendResult },
  edit: { input: textEditInput.extend({ scheduled: scheduledEdit.optional() }), output: sendResult },
  prepareChannelInboxDocument: { input: z.object({ id: chatId, inboxId: chatId, topicId: chatId,
    name: z.string().min(1).max(255), caption: z.string().trim().max(1024),
    captionFormat: captionFormat.optional(),
    size: z.number().int().positive().max(maxDocumentBytes), replyTo: channelInboxReply.optional(),
    kind: channelInboxAttachmentKind.optional(),
  }).refine(({ kind, name, size }) => validChannelInboxAttachment(kind ?? "document", name, size)),
    output: uploadPreparation },
  prepareDocumentUpload: { input: z.object({
    id: chatId, name: z.string().min(1).max(255), caption: z.string().trim().max(1024),
    size: z.number().int().positive().max(maxDocumentBytes), topic: forumTopicTarget.optional(), video: z.literal(true).optional(), options: documentSendOptions.optional(), delivery: attachmentSendDelivery.optional(),
    replyTo: messageReference.shape.messageId.optional(), reply: mediaReply.optional(),
  }).refine(({ replyTo, reply }) => replyTo === undefined || reply === undefined)
    .refine(({ topic, delivery }) => !delivery?.whenOnline || topic === undefined)
    .refine(({ topic, video, reply, delivery }) => delivery?.effect === undefined
      || (video === true && topic === undefined && reply?.externalReplyChatId === undefined))
    .refine(({ options, video, delivery }) => !options?.originalVideo || video === true && delivery?.paidStars === undefined)
    .refine(({ options, video, delivery }) => !options?.videoEdit || video === true && !options.originalVideo && delivery?.paidStars === undefined)
    .refine(({ options }) => !options?.animationTrim || options.mediaKind === "animation")
    .refine(({ name, options, video, delivery }) => !options?.mediaKind || !video && delivery?.paidStars === undefined
      && (options.mediaKind === "audio" ? isAudioAttachmentName(name) : isChatAnimationAttachmentName(name)))
    .refine(({ options, video }) => video === true || options?.mediaKind === "animation"
      || (options?.spoiler === undefined && options?.captionAbove === undefined)), output: uploadPreparation },
  prepareLivePhotoUpload: { input: livePhotoUpload, output: uploadPreparation },
  prepareAttachmentReplacement: { input: messageReference.extend({
    edit: messageSchema.shape.attachmentEdit.unwrap(), scheduled: scheduledEdit.optional(),
    name: z.string().min(1).max(255), size: z.number().int().positive().max(maxDocumentBytes),
  }), output: uploadPreparation },
  prepareQuickReplyDocument: { input: quickReplyDocumentUpload, output: uploadPreparation },
  prepareWelcomeMedia: { input: welcomeMediaUpload, output: uploadPreparation },
  prepareWelcomeRichUpload: { input: welcomeRichUpload, output: uploadPreparation },
  prepareAlbumUpload: { input: albumUpload, output: uploadPreparation },
  prepareChannelInboxAlbum: { input: channelInboxAlbumUpload, output: uploadPreparation },
  prepareQuickReplyAlbumUpload: { input: quickReplyAlbumUpload, output: uploadPreparation },
  prepareRichMessageUpload: { input: richMessageUpload, output: uploadPreparation },
  prepareRichMessageEditUpload: { input: richMessageEditUpload, output: uploadPreparation },
  sendDocument: { input: z.object({
    id: chatId, name: z.string().min(1).max(255), caption: z.string().trim().max(1024), base64: photoSchema.shape.base64,
  }), output: sendResult },
  mediaCollectionState: { input: messageReference.extend({ kind: mediaCollectionKind }), output: z.boolean().nullable() },
  setMediaCollection: { input: messageReference.extend({ kind: mediaCollectionKind, saved: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  searchInlineBot: { input: z.object({ id: chatId, username: z.string().regex(/^[a-z0-9_]{1,64}$/i),
    query: z.string().max(256), offset: z.string().max(512).optional(), topic: forumTopicTarget.optional() }),
    output: inlineBotPage.nullable() },
  launchInlineResultMiniApp: {
    input: z.object({ id: chatId, token: z.uuid(), topic: forumTopicTarget.optional() }),
    output: z.object({ url: z.string().url().max(4096), session: z.uuid() }).nullable(),
  },
  inlineBotPreview: { input: z.object({ id: chatId, token: z.uuid() }), output: photoSchema.nullable() },
  sendInlineBotResult: { input: z.object({ id: chatId, token: z.uuid(), topic: forumTopicTarget.optional(), reply: mediaReply.optional() }),
    output: sendResult },
  searchGifs: { input: z.object({ id: chatId, query: z.string().trim().min(1).max(80), topic: forumTopicTarget.optional() }),
    output: z.array(z.object({ id: z.number().int().positive(), label: z.string().max(80), preview: photoSchema.optional(),
      gifToken: z.uuid(), editableGif: z.literal(true).optional() })).max(20) },
  sendFoundGif: { input: z.object({ id: chatId, token: z.uuid(), topic: forumTopicTarget.optional(), reply: mediaReply.optional(),
    delivery: mediaDelivery.optional(), gif: gifSendOptions.optional() }), output: sendResult },
  messageStickerPack: { input: messageReference.extend({ offset: z.number().int().nonnegative() }), output: stickerPackPreview.nullable() },
  installMessageStickerPack: { input: messageReference.extend({ packId: stickerPackId }), output: stickerPackInstallation },
  linkedStickerPack: { input: z.object({ url: z.string().max(128), offset: z.number().int().nonnegative(), refresh: z.literal(true).optional() }),
    output: stickerPackPreview.nullable() },
  installLinkedStickerPack: { input: z.object({ url: z.string().max(128), packId: stickerPackId }), output: stickerPackInstallation },
  installedStickerPacks: { input: z.null(), output: z.array(z.object({
    id: z.string().regex(/^-?[1-9]\d{0,18}$/), title: z.string().min(1).max(128),
  })) },
  discoverStickerPacks: {
    input: z.union([z.object({ query: z.string().trim().min(1).max(80), emoji: z.literal(true).optional() }).strict(),
      z.object({ offset: z.number().int().min(0).max(2147483647), emoji: z.literal(true).optional() }).strict()]),
    output: z.object({ packs: z.array(z.object({ id: stickerPackId, title: z.string().min(1).max(128),
      link: z.string().regex(/^https:\/\/t\.me\/(?:addstickers|addemoji)\/[A-Za-z0-9_]{1,64}$/) })), next: z.number().int().positive().nullable() }),
  },
  archivedStickerPacks: { input: z.object({ after: stickerPackId.optional(), emoji: z.literal(true).optional() }),
    output: z.object({ packs: z.array(z.object({ id: stickerPackId, title: z.string().min(1).max(128) })), next: stickerPackId.nullable() }) },
  ownedStickerPacks: { input: z.object({ after: stickerPackId.optional() }),
    output: z.object({ packs: z.array(ownedStickerPack.pick({ id: true, title: true })).max(30), next: stickerPackId.nullable() }) },
  ownedStickerPack: { input: z.object({ id: stickerPackId }), output: ownedStickerPack.nullable() },
  ownedStickerPreview: { input: z.object({ id: stickerPackId, fileId: ownedStickerFileId }), output: photoSchema.nullable() },
  renameOwnedStickerPack: { input: z.object({ id: stickerPackId, expected: ownedStickerPack.shape.title, title: ownedStickerTitle }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  moveOwnedSticker: { input: z.object({ id: stickerPackId, fileId: ownedStickerFileId, direction: z.enum(["up", "down"]),
    expected: z.array(ownedStickerFileId).min(2).max(200) }),
    output: ownedStickerEditResult },
  removeOwnedSticker: { input: z.object({ id: stickerPackId, fileId: ownedStickerFileId, title: ownedStickerPack.shape.title,
    expected: z.array(ownedStickerFileId).min(1).max(200) }), output: ownedStickerEditResult },
  setOwnedStickerEmojis: { input: z.object({ id: stickerPackId, fileId: ownedStickerFileId, expected: stickerEmojis,
    emojis: stickerEmojis.refine((items) => items.length > 0) }), output: ownedStickerEditResult },
  setOwnedEmojiPackCover: { input: z.object({ id: stickerPackId, expected: ownedStickerFileId.nullable(),
    fileId: ownedStickerFileId.nullable() }), output: ownedStickerEditResult },
  ownedStickerImageCover: { input: z.object({ id: stickerPackId, fileId: ownedStickerFileId }), output: photoSchema.nullable() },
  setOwnedStickerImageCover: { input: z.object({ id: stickerPackId, expected: ownedStickerFileId.nullable(),
    base64: z.string().min(1).max(Math.ceil(maxStickerCoverBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/).nullable() }),
    output: ownedStickerEditResult },
  deleteOwnedStickerPack: { input: ownedStickerPackSnapshot, output: z.enum(["deleted", "changed", "unavailable", "unknown"]) },
  ownedStickerDestinations: { input: messageReference.extend({ after: stickerPackId.optional() }),
    output: z.object({ sourceFileId: ownedStickerFileId, packs: z.array(ownedStickerPack.pick({ id: true, title: true })).max(30),
      next: stickerPackId.nullable() }).nullable() },
  addMessageStickerToOwnedPack: { input: messageReference.extend({ sourceFileId: ownedStickerFileId,
    packId: stickerPackId, title: ownedStickerPack.shape.title }), output: z.enum(["added", "already", "changed", "unavailable", "unknown"]) },
  createOwnedPackFromMessage: { input: messageReference.extend({ sourceFileId: ownedStickerFileId,
    name: ownedStickerPackName, title: newStickerPackTitle }), output: stickerPackCreationResult },
  inspectOwnedTgsSticker: { input: z.object({ base64: z.string().min(1).max(Math.ceil(maxTgsBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
    output: z.string().max(2 * 1024 * 1024).nullable() },
  inspectOwnedWebmSticker: { input: z.object({ base64: z.string().min(1).max(Math.ceil(maxWebmStickerBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/) }), output: z.enum(["valid", "invalid", "unavailable"]) },
  createOwnedPackFromImage: { input: localStickerUpload.extend({ name: ownedStickerPackName, title: newStickerPackTitle }),
    output: stickerPackCreationResult },
  addImageToOwnedStickerPack: { input: localStickerUpload.extend({ target: ownedStickerPackSnapshot }),
    output: ownedStickerEditResult },
  replaceImageInOwnedStickerPack: { input: localStickerUpload.extend({ target: ownedStickerPackSnapshot, fileId: ownedStickerFileId }),
    output: ownedStickerEditResult },
  changeStickerPack: { input: z.object({ id: stickerPackId, action: z.enum(["archive", "restore", "remove"]), emoji: z.literal(true).optional() }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  reorderStickerPacks: { input: z.object({ order: z.array(stickerPackId).min(2), expected: z.array(stickerPackId).min(2), emoji: z.literal(true).optional() }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  stickerPackPage: { input: z.object({ packId: z.string().regex(/^-?[1-9]\d{0,18}$/), offset: z.number().int().nonnegative() }),
    output: stickerChoicePage },
  groupStickerPage: { input: z.object({ id: chatId, packId: stickerPackId.optional(), offset: z.number().int().nonnegative() })
    .refine(({ offset, packId }) => offset === 0 || packId !== undefined), output: groupStickerChoicePage.nullable() },
  groupEmojiPage: { input: z.object({ id: chatId, packId: stickerPackId.optional(), offset: z.number().int().nonnegative() })
    .refine(({ offset, packId }) => offset === 0 || packId !== undefined), output: groupEmojiChoicePage.nullable() },
  installedEmojiPacks: { input: z.null(), output: z.array(groupEmojiChoicePage.pick({ id: true, title: true })) },
  installedEmojiPage: { input: z.object({ packId: stickerPackId, offset: z.number().int().nonnegative().max(2147483647) }),
    output: groupEmojiChoicePage.nullable() },
  clearRecentStickers: { input: z.null(), output: z.enum(["cleared", "unavailable", "unknown"]) },
  mediaChoices: { input: z.union([z.enum(["sticker", "gif"]),
    z.object({ stickerQuery: z.string().trim().min(1).max(80) })]), output: z.array(mediaChoice).max(20) },
  sendMediaChoice: { input: mediaChoiceSelection.safeExtend({ id: chatId, groupPack: z.literal(true).optional(),
    topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional() })
    .refine(({ groupPack, kind, packId }) => !groupPack || kind === "sticker" && !!packId), output: sendResult },
  sendChannelInboxMediaChoice: { input: mediaChoiceSelection.safeExtend({ id: chatId, inboxId: chatId, topicId: chatId,
    replyTo: channelInboxReply.optional() }), output: sendResult },
  sendVideoNote: { input: videoNoteRecording.extend({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(),
    delivery: mediaDelivery.optional() }), output: sendResult },
  sendChannelInboxVideoNote: { input: videoNoteRecording.extend({ id: chatId, inboxId: chatId, topicId: chatId,
    replyTo: channelInboxReply.optional() }), output: sendResult },
  sendVoice: { input: voiceRecording.extend({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: mediaDelivery.optional() }),
    output: sendResult },
  sendChannelInboxVoice: { input: voiceRecording.extend({ id: chatId, inboxId: chatId, topicId: chatId,
    replyTo: channelInboxReply.optional() }), output: sendResult },
  sendPhotoAlbum: { input: z.object({ id: chatId, topic: forumTopicTarget.optional(), reply: mediaReply.optional(), delivery: attachmentSendDelivery.optional(), caption: z.string().trim().max(1024),
    photos: z.array(photoSchema.shape.base64).min(1).max(10), options: albumSendOptions.optional(),
  }).refine(({ photos, options }) => photos.length >= 2 || options?.paidStars !== undefined)
    .refine(({ topic, delivery, options }) => !delivery?.whenOnline || (topic === undefined && options?.paidStars === undefined))
    .refine(({ topic, reply, options, delivery }) => delivery?.effect === undefined
      || (topic === undefined && reply?.externalReplyChatId === undefined && options?.paidStars === undefined))
    .refine(({ photos, caption, options, delivery }) => !options?.originalVideo
      && validAlbumItemCaptions(photos.length, caption, options, delivery?.paidStars)), output: z.enum(["sent", "failed", "unknown"]) },
  paidMediaLimit: { input: z.object({ id: chatId }), output: z.number().int().positive().nullable() },
  sendPhoto: { input: z.object({
    id: chatId, caption: z.string().trim().max(1024), base64: photoSchema.shape.base64, topic: forumTopicTarget.optional(),
    replyTo: messageReference.shape.messageId.optional(), reply: mediaReply.optional(), options: attachmentSendOptions.optional(), delivery: attachmentSendDelivery.optional(),
  }).refine(({ replyTo, reply }) => replyTo === undefined || reply === undefined)
    .refine(({ topic, delivery }) => !delivery?.whenOnline || topic === undefined), output: sendResult },
  sendTopicText: {
    input: z.object({ id: chatId, topic: forumTopicTarget, text: z.string().trim().min(1).max(4096),
      replyTo: messageReference.shape.messageId.optional(), styles: textDelivery.shape.styles, quote: textDelivery.shape.quote, delivery: topicDelivery.optional() }),
    output: sendResult,
  },
  externalReplyChats: { input: z.object({ query: z.string().trim().max(128) }),
    output: z.array(chatSchema.extend({ forum: z.literal(true).optional() })).max(40) },
  externalReplyTopics: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: forumTopicCursor.optional() }),
    output: z.object({ topics: z.array(forumTopicTarget).max(40), next: forumTopicCursor.nullable() }).nullable() },
  reviewExternalReply: { input: messageReference.extend({
    sourceTopicId: forumTopicId.optional(), quote: replyQuote.optional(), destination: chatId,
    expectedName: forwardTarget.shape.name, topic: forumTopicTarget.optional(),
  }), output: z.object({ chat: chatSchema, topic: forumTopic.optional() }).nullable() },
  externalReplyAllowed: { input: messageReference, output: z.boolean() },
  externalReplySource: { input: messageReference, output: linkedTelegramMessage.nullable() },
  chatEvents: { input: z.object({
    id: chatId, query: z.string().trim().max(128), cursor: chatEventId.optional(), filter: chatEventFilter.optional(),
    filters: z.array(chatEventFilter).min(1).max(chatEventFilter.options.length).optional(), actorId: chatEventActorId.optional(),
  }), output: chatEventPage.nullable() },
  chatEventActors: { input: z.object({ id: chatId }), output: z.array(chatEventActor).max(100) },
  reportAntiSpamFalsePositive: { input: z.object({ id: chatId, eventId: chatEventId }), output: antiSpamReportResult },
  channelSignatures: { input: z.object({ id: chatId }), output: channelSignatureView.nullable() },
  saveChannelSignatures: { input: z.object({ id: chatId, values: channelSignatures, expected: channelSignatures }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  saveChannelBoostSetting: { input: channelBoostSettingChange.extend({ id: chatId }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatBoostHistory: { input: z.object({ id: chatId, onlyGiftCodes: z.boolean(), offset: z.string().max(512).optional() }),
    output: chatBoostPage.nullable() },
  chatBoostSlots: { input: z.object({ id: chatId }), output: z.array(chatBoostSlot).max(100).nullable() },
  applyChatBoosts: { input: z.object({ id: chatId, title: z.string().min(1).max(256),
    slots: z.array(chatBoostSlotSnapshot).min(1).max(100) }), output: chatBoostResult },
  chatInfo: { input: z.object({ id: chatId }), output: chatInfo.nullable() },
  groupPacks: { input: z.object({ id: chatId }), output: groupPacksView.nullable() },
  previewGroupPack: { input: z.object({ id: chatId, kind: groupPackKind, reference: z.string().trim().min(1).max(160) }), output: groupPackChoice.nullable() },
  setGroupPack: { input: z.object({ id: chatId, kind: groupPackKind, expected: stickerPackId.nullable(), pack: groupPackChoice.nullable() }), output: groupPacksResult },
  discussionGroup: { input: z.object({ id: chatId }), output: discussionGroupView.nullable() },
  discussionGroupCandidates: { input: z.object({ id: chatId }), output: z.array(discussionGroupCandidate).max(100).nullable() },
  setDiscussionGroup: { input: z.object({ id: chatId, target: chatId.nullable(), expected: chatId.nullable() }), output: discussionGroupResult },
  enableDiscussionHistory: { input: z.object({ id: chatId, target: chatId, title: discussionGroupSummary.shape.title, expected: chatId.nullable() }), output: discussionGroupResult },
  upgradeDiscussionGroup: { input: z.object({ id: chatId, target: chatId, title: discussionGroupSummary.shape.title, expected: chatId.nullable() }), output: groupUpgradeResult },
  upgradeBasicGroup: { input: z.object({ id: chatId, title: discussionGroupSummary.shape.title }), output: groupUpgradeResult },
  chatWelcomeMessages: { input: z.object({ id: chatId }), output: z.array(z.object({
    id: z.number().int().positive().max(2147483647), text: z.string().max(4096),
    kind: z.string().min(1).max(80), editable: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    styles: textDelivery.shape.styles, links: messageLinks, photo: instantViewPhoto.omit({ fileId: true }).optional(),
    contact: sharedContact.optional(), location: messageLocation.optional(),
    sticker: z.object({ label: z.string().min(1).max(80) }).optional(),
    gif: z.literal(true).optional(),
    mediaCaption: z.enum(["Audio", "Document", "Video", "Voice note"]).optional(),
    replaceAttachmentKind: z.enum(["document", "video", "audio", "animation", "voice", "videoNote"]).optional(),
    rich: richMessageLayout.optional(), richDraft: welcomeRichEditView.optional(),
    document: documentInfo.optional(),
    playback: z.object({ mime: playbackMime, spoiler: z.boolean(), loop: z.boolean(), voiceNote: z.boolean(), videoNote: z.boolean() }).optional(),
  })).max(100).nullable() },
  chatWelcomePhoto: { input: z.object({ id: chatId, messageId: z.number().int().positive().max(2147483647),
    revision: z.string().regex(/^[a-f0-9]{64}$/), size: photoSize.optional(), attachment: welcomeAttachmentReference }), output: photoSchema },
  chatWelcomeSticker: { input: z.object({ id: chatId, messageId: z.number().int().positive().max(2147483647),
    revision: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.union([customEmojiMedia, z.object({ format: z.literal("webp"), base64: photoSchema.shape.base64 })]).nullable() },
  chatWelcomePlayback: { input: z.object({ id: chatId, messageId: z.number().int().positive().max(2147483647),
    revision: z.string().regex(/^[a-f0-9]{64}$/), attachment: welcomeAttachmentReference }), output: z.string().startsWith("/api/v1/plugins/") },
  chatWelcomeDocument: { input: z.object({ id: chatId, messageId: z.number().int().positive().max(2147483647),
    revision: z.string().regex(/^[a-f0-9]{64}$/), attachment: welcomeAttachmentReference }), output: z.object({ name: z.string(), url: z.string().startsWith("/api/v1/plugins/") }) },
  changeChatWelcomeMessage: { input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("add"), id: chatId, text: z.string().trim().max(4096),
      styles: textDelivery.shape.styles, links: textDelivery.shape.links, photoBase64: photoSchema.shape.base64.optional(),
      gifFileId: z.number().int().positive().optional() }),
    z.object({ action: z.literal("edit"), id: chatId, messageId: z.number().int().positive().max(2147483647),
      revision: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().trim().max(4096),
      styles: textDelivery.shape.styles, links: textDelivery.shape.links, photoBase64: photoSchema.shape.base64.optional(),
      gifFileId: z.number().int().positive().optional() }),
    z.object({ action: z.literal("addCard"), id: chatId, card: welcomeCardDraft }),
    z.object({ action: z.literal("editCard"), id: chatId, messageId: z.number().int().positive().max(2147483647),
      revision: z.string().regex(/^[a-f0-9]{64}$/), card: welcomeCardDraft }),
    z.object({ action: z.literal("addSticker"), id: chatId, packId: stickerPackId, fileId: z.number().int().positive() }),
    z.object({ action: z.literal("editSticker"), id: chatId, messageId: z.number().int().positive().max(2147483647),
      revision: z.string().regex(/^[a-f0-9]{64}$/), packId: stickerPackId, fileId: z.number().int().positive() }),
    z.object({ action: z.literal("addRich"), id: chatId, draft: editableRichDraft }),
    z.object({ action: z.literal("editRich"), id: chatId, messageId: z.number().int().positive().max(2147483647),
      revision: z.string().regex(/^[a-f0-9]{64}$/), draft: welcomeRichEditDraft }),
    z.object({ action: z.literal("delete"), id: chatId, messageId: z.number().int().positive().max(2147483647),
      revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]), output: z.enum(["saved", "changed", "invalid", "unavailable", "unknown"]) },
  chatPublicUsername: { input: z.object({ id: chatId }), output: z.object({
    username: z.string().max(32), activeUsernames: z.array(z.string().regex(/^[A-Za-z0-9_]{1,32}$/)).max(100).optional(),
    otherUsernames: z.array(z.string().min(1).max(32)).max(100), editable: z.boolean(),
  }).nullable() },
  saveChatPublicUsername: { input: z.object({
    id: chatId, username: z.string().regex(/^[A-Za-z0-9_]{0,32}$/), expected: z.string().max(32),
  }), output: z.enum(["saved", "changed", "invalid", "occupied", "purchasable", "limit", "unavailable"]) },
  removeChatPhoto: { input: z.object({ id: chatId, expected: existingAvatarVersion }), output: saveAvatarResult },
  saveChatPhoto: { input: avatarUpdate.extend({ id: chatId }), output: saveAvatarResult },
  saveChatVideo: { input: avatarVideoUpdate.extend({ id: chatId }), output: saveAvatarResult },
  saveChatInfo: { input: chatInfoChange.extend({ id: chatId }), output: z.enum(["saved", "changed", "unavailable"]) },
  groupSlowMode: { input: z.object({ id: chatId }), output: slowModeView.nullable() },
  groupMemberVisibility: { input: z.object({ id: chatId }),
    output: z.object({ hidden: z.boolean(), editable: z.boolean() }).nullable() },
  saveGroupMemberVisibility: { input: z.object({ id: chatId, hidden: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  saveGroupSlowMode: { input: z.object({ id: chatId, delay: slowModeDelay, expected: slowModeDelay }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  groupAntiSpam: { input: z.object({ id: chatId }), output: z.object({ enabled: z.boolean(), editable: z.boolean() }).nullable() },
  saveGroupAntiSpam: { input: z.object({ id: chatId, enabled: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  groupHistoryVisibility: { input: z.object({ id: chatId }), output: z.object({ enabled: z.boolean(), editable: z.boolean() }).nullable() },
  saveGroupHistoryVisibility: { input: z.object({ id: chatId, enabled: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatContentProtection: { input: z.object({ id: chatId }), output: z.object({ enabled: z.boolean(), editable: z.boolean() }).nullable() },
  saveChatContentProtection: { input: z.object({ id: chatId, enabled: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  groupEntrySetting: { input: z.object({ id: chatId, setting: groupEntrySetting }),
    output: z.object({ enabled: z.boolean(), editable: z.boolean() }).nullable() },
  saveGroupEntrySetting: { input: z.object({ id: chatId, setting: groupEntrySetting, enabled: z.boolean(), expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  groupPermissions: { input: z.object({ id: chatId }), output: groupPermissionsView.nullable() },
  saveGroupPermissions: { input: z.object({ id: chatId, changes: z.array(groupPermissionChange).min(1).max(20) }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  joinRequests: { input: z.object({ id: chatId, query: z.string().trim().max(128), cursor: joinRequestCursor.optional() }), output: joinRequestPage.nullable() },
  reviewJoinRequest: { input: z.object({ id: chatId, userId: joinRequestCursor.shape.userId, approve: z.boolean() }), output: z.boolean() },
  managedInvites: { input: z.object({ id: chatId, cursor: inviteCursor.optional(), revoked: z.literal(true).optional() }), output: invitePage.nullable() },
  managedInviteMembers: { input: z.object({ id: chatId, link: managedInvite.shape.link, cursor: inviteMembersCursor.optional(), expired: z.literal(true).optional() }),
    output: inviteMembersPage.nullable() },
  createManagedInvite: { input: z.object({ id: chatId, draft: inviteDraft }), output: managedInvite },
  subscriptionInviteLimit: { input: z.object({ id: chatId }), output: z.number().int().positive().nullable() },
  createSubscriptionInvite: { input: z.object({ id: chatId, name: z.string().trim().max(32), stars: z.number().int().positive() }), output: managedInvite },
  editManagedInvite: { input: z.object({ id: chatId, link: managedInvite.shape.link, expected: inviteEditExpected, draft: inviteDraft }), output: inviteEditResult },
  deleteRevokedManagedInvite: { input: z.object({ id: chatId, link: managedInvite.shape.link }), output: z.boolean() },
  revokeManagedInvite: { input: z.object({ id: chatId, link: managedInvite.shape.link }), output: z.boolean() },
  chatSendAs: { input: z.object({ id: chatId }), output: chatSendAs.nullable() },
  setChatSendAs: { input: z.object({ id: chatId, key: sendAsKey, expected: sendAsKey }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatBackground: { input: z.object({ id: chatId }), output: chatBackgroundView.nullable() },
  chatBackgroundPhoto: { input: z.object({ id: chatId, revision: chatBackgroundRevision }), output: photoSchema },
  chatBackgroundPattern: { input: z.object({ id: chatId, revision: chatBackgroundRevision }), output: wallpaperPatternAsset },
  previewChatBackgroundLink: { input: z.object({ id: chatId, link: z.string().max(512) }), output: wallpaperLinkPreview.nullable() },
  setChatBackgroundLink: { input: z.object({ id: chatId, expected: chatBackgroundRevision.nullable(),
    link: z.string().max(512), revision: chatBackgroundRevision }), output: z.enum(["saved", "changed", "unavailable"]) },
  setChatBackgroundPhoto: { input: z.object({ id: chatId, expected: chatBackgroundRevision.nullable(), base64: photoSchema.shape.base64 }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  setChatBackground: { input: z.object({ id: chatId, expected: chatBackgroundRevision.nullable(), color: themeAccent.nullable() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  chatTheme: { input: z.object({ id: chatId }), output: chatThemeView.nullable() },
  setChatTheme: { input: z.object({ id: chatId, expected: emojiThemeName.nullable(), name: emojiThemeName.nullable() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  reviewGiftResale: { input: z.object({ id: chatId, payment: giftResalePayment }), output: z.uuid().nullable() },
  confirmGiftResale: { input: z.object({ id: chatId, confirmation: z.uuid() }), output: giftSendResult },
  reviewGiftAuctionBid: { input: z.object({ id: chatId, bid: giftAuctionBid }), output: z.uuid().nullable() },
  confirmGiftAuctionBid: { input: z.object({ id: chatId, confirmation: z.uuid() }), output: giftSendResult },
  giftAuction: { input: z.object({ id: chatId, giftId: catalogGiftId, auctionId: giftAuctionId }),
    output: giftAuctionView.nullable() },
  searchGiftResale: { input: giftResaleQuery.extend({ id: chatId }), output: giftResalePage },
  confirmGiftSend: { input: z.object({ id: chatId, giftId: catalogGiftId, confirmation: z.uuid(), options: giftSendOptions.optional() }), output: giftSendResult },
  giftQuote: { input: z.object({ id: chatId, giftId: catalogGiftId }), output: giftQuote },
  chatGiftButton: { input: z.object({ id: chatId }), output: z.boolean() },
  giftCatalog: { input: z.object({ id: chatId }), output: giftCatalog },
  profileGiftAnimation: { input: z.object({ id: chatId, fileId: z.number().int().positive() }),
    output: z.string().min(1).max(2 * 1024 * 1024) },
  profileGiftArtwork: { input: z.object({ id: chatId, fileId: z.number().int().positive() }), output: photoSchema },
  setProfileGiftMembership: { input: z.object({ id: chatId, membership: giftMembership }),
    output: z.enum(["saved", "unavailable", "full"]) },
  editProfileGiftCollection: { input: z.object({ id: chatId, change: giftCollectionChange }),
    output: z.discriminatedUnion("state", [
      z.object({ state: z.literal("saved"), collection: profileGiftCollection }),
      z.object({ state: z.literal("applied"), collections: profileGiftCollections }),
      z.object({ state: z.enum(["changed", "unavailable"]) }),
    ]) },
  profileGiftCollections: { input: z.object({ id: chatId }), output: profileGiftCollections },
  profileGifts: { input: z.object({ id: chatId, collection: giftCollectionId.optional(),
    offset: z.string().max(1024).optional(), includeHidden: z.boolean().optional() }), output: profileGiftPage },
  setProfileGiftVisibility: { input: z.object({ id: chatId, gift: receivedProfileGiftId, expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  setProfileGiftPinned: { input: z.object({ id: chatId, gift: receivedProfileGiftId, expected: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable", "full"]) },
  setChannelGiftNotifications: { input: z.object({ id: chatId, expected: z.boolean(), enabled: z.boolean() }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  reviewGiftListing: { input: z.object({ id: chatId, gift: receivedProfileGiftId, price: giftResalePrice.nullable() }),
    output: z.object({ confirmation: z.uuid(), price: giftResalePrice.nullable(),
      earningsPerMille: z.number().int().min(0).max(1000).optional() }).nullable() },
  confirmGiftListing: { input: z.object({ id: chatId, gift: receivedProfileGiftId, confirmation: z.uuid() }),
    output: z.enum(["saved", "changed", "unavailable", "unknown"]) },
  reviewDropGiftDetails: { input: z.object({ id: chatId, gift: receivedProfileGiftId }),
    output: z.object({ stars: z.number().int().positive(), confirmation: z.uuid() }).nullable() },
  confirmDropGiftDetails: { input: z.object({ id: chatId, gift: receivedProfileGiftId, confirmation: z.uuid() }),
    output: z.enum(["removed", "changed", "unavailable", "unknown"]) },
  reviewProfileGiftTransfer: { input: z.object({ id: chatId, gift: receivedProfileGiftId, recipient: chatId }),
    output: z.object({ stars: z.number().int().nonnegative(), name: z.string().min(1).max(256), confirmation: z.uuid() }).nullable() },
  confirmProfileGiftTransfer: { input: z.object({ id: chatId, gift: receivedProfileGiftId, confirmation: z.uuid() }),
    output: z.enum(["transferred", "changed", "unavailable", "unknown"]) },
  reviewProfileGiftUpgrade: { input: z.object({ id: chatId, gift: receivedProfileGiftId }), output: z.object({
    stars: z.number().int().nonnegative(), confirmation: z.uuid(), examples: z.array(z.string().min(1).max(128)).max(8),
  }).nullable() },
  confirmProfileGiftUpgrade: { input: z.object({ id: chatId, gift: receivedProfileGiftId, confirmation: z.uuid(),
    keepOriginalDetails: z.boolean() }), output: z.enum(["upgraded", "changed", "unavailable", "unknown"]) },
  reviewProfileGiftConversion: { input: z.object({ id: chatId, gift: receivedProfileGiftId }),
    output: z.object({ stars: z.number().int().positive(), confirmation: z.uuid() }).nullable() },
  confirmProfileGiftConversion: { input: z.object({ id: chatId, gift: receivedProfileGiftId, confirmation: z.uuid() }),
    output: z.enum(["converted", "changed", "unavailable", "unknown"]) },
  profilePhotos: { input: z.object({ id: chatId, offset: profilePhotoOffset }), output: profilePhotoPage },
  profileAudio: { input: z.object({ id: chatId, offset: profileAudioOffset }), output: profileAudioPage.nullable() },
  profileAudioPlayback: { input: z.object({ id: chatId, index: profileAudioOffset, fileId: profileAudioTrack.shape.fileId }),
    output: z.string().startsWith("/api/v1/plugins/") },
  changeProfileAudio: { input: z.object({ id: chatId, change: profileAudioChange }),
    output: z.enum(["saved", "changed", "unavailable"]) },
  addMessageProfileAudio: { input: messageReference.extend({ fileId: profileAudioTrack.shape.fileId }),
    output: z.enum(["saved", "already", "changed", "unavailable"]) },
  profilePhoto: { input: z.object({ id: chatId, offset: profilePhotoOffset, photoId: galleryPhotoId }), output: photoSchema },
  profilePhotoVideo: { input: z.object({ id: chatId.optional(), offset: profilePhotoOffset, photoId: galleryPhotoId, fileId: pollFileId }),
    output: z.string().startsWith("/api/v1/plugins/") },
  revokeBotLocationAccess: { input: z.object({ id: chatId }), output: z.boolean() },
  revokeBotEmojiAccess: { input: z.object({ id: chatId }), output: z.boolean() },
  peerProfile: { input: z.object({ id: chatId }), output: peerProfile.nullable() },
  commonGroups: { input: z.object({ id: chatId, after: z.string().regex(/^-\d{1,16}$/).optional() }), output: commonGroupPage },
  chatMembers: { input: z.object({ id: chatId, query: z.string().trim().max(128), offset: z.number().int().nonnegative().max(2147483600).optional(),
    filter: chatMemberFilter.optional() }),
    output: chatMemberPage.nullable() },
  setChatMemberTag: { input: z.object({ id: chatId, userId: contactId, expected: z.string().max(64),
    tag: z.string().trim().refine((tag) => [...tag].length <= 16 && !/[\r\n]/.test(tag)) }),
    output: z.enum(["tagSaved", "changed", "unavailable"]) },
  canAddChatMember: { input: z.object({ id: chatId, title: z.string().min(1).max(256) }), output: z.boolean() },
  addChatMember: { input: z.object({ id: chatId, title: z.string().min(1).max(256), userId: contactId, name: z.string().min(1).max(256) }),
    output: chatMemberInviteOutcome },
  addChatMembers: { input: z.object({ id: chatId, title: z.string().min(1).max(256),
    contacts: z.array(namedContact).min(1).max(chatMemberInviteLimit)
      .refine((rows) => new Set(rows.map(({ id }) => id)).size === rows.length) }),
    output: z.array(z.object({ id: contactId, outcome: chatMemberInviteOutcome })).max(chatMemberInviteLimit) },
  saveChatAdministrator: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id,
    expected: administratorRights.optional(), available: administratorRights, selected: administratorRights }), output: z.enum(["administratorSaved", "changed", "unavailable"]) },
  demoteChatAdministrator: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id }),
    output: z.enum(["demoted", "changed", "unavailable"]) },
  restrictChatMember: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id, duration: memberBanDuration.optional(),
    previous: editableMemberRestriction.optional(), expected: groupPermissionValues, denied: z.array(groupPermission).min(1).max(groupPermission.options.length) }),
    output: z.enum(["restricted", "changed", "unavailable"]) },
  liftChatMemberRestrictions: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id,
    until: memberBanExpiry, isMember: z.boolean() }), output: z.enum(["lifted", "changed", "unavailable"]) },
  previewCommunityBan: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id }), output: communityBanImpact.nullable() },
  previewCommunityUnban: { input: communityUnbanTarget.omit({ communityId: true }), output: communityUnbanPreview.nullable() },
  unbanCommunityMember: { input: communityUnbanTarget, output: z.enum(["communityUnbanned", "changed", "unavailable"]) },
  banCommunityMember: { input: communityBanChange, output: z.enum(["communityBanned", "changed", "unavailable"]) },
  banChatMember: { input: z.object({ id: chatId, userId: messageSender.options[0].shape.id,
    role: z.enum(["member", "restricted"]), duration: memberBanDuration }), output: z.enum(["banned", "changed", "unavailable"]) },
  moderateChatMember: { input: chatMemberAction, output: z.enum(["removed", "messagesDeleted", "changed", "unavailable"]) },
  banMessageChatSender: { input: messageReference.extend({ senderChatId: messageSender.options[1].shape.id }),
    output: z.enum(["banned", "changed", "unavailable"]) },
  unbanChatMember: { input: z.union([
    z.strictObject({ id: chatId, userId: messageSender.options[0].shape.id, bannedUntil: memberBanExpiry }),
    z.strictObject({ id: chatId, senderChatId: messageSender.options[1].shape.id, bannedUntil: memberBanExpiry }),
  ]),
    output: z.enum(["unbanned", "changed", "unavailable"]) },
  canScheduleWhenOnline: { input: z.object({ id: chatId }), output: z.boolean() },
  scheduledMessages: { input: z.object({ id: chatId, topicId: forumTopicId.optional() }), output: z.array(scheduledMessage).max(100) },
  changeScheduledMessage: { input: z.object({ id: chatId, expected: scheduledMessage, at: scheduledTime.nullable(), topicId: forumTopicId.optional() }),
    output: z.enum(["updated", "changed", "unavailable"]) },
  cancelScheduledMessage: { input: messageReference.extend({ topicId: forumTopicId.optional(), album: albumSelection.optional() }), output: z.boolean() },
  chatDraft: { input: z.object({ id: chatId }), output: topicDraft },
  topicDraft: { input: z.object({ id: chatId, topicId: forumTopicId }), output: topicDraft },
  saveChatDraft: { input: z.object({ id: chatId, draft: syncedDraft.nullable(), expected: syncedDraft.nullable(), topicId: forumTopicId.optional() }),
    output: z.enum(["saved", "changed", "unsupported"]) },
  richBankCard: { input: messageReference.extend({ reference: richBankCardReference, mode: richBankCardMode }), output: richBankCardResult },
  runRichBotCommand: { input: messageReference.extend({ command: richBotCommand }), output: sendResult },
  send: { input: z.object({ id: chatId, text: z.string().trim().min(1).max(4096),
    replyTo: z.string().regex(/^[1-9]\d{0,15}$/).optional(), delivery: textDelivery.optional(),
  }), output: sendResult },
};

export type ChatReportStep = z.infer<typeof schemas.reportChat.input>["step"];
export type ChatWelcomeMessageChange = z.infer<typeof schemas.changeChatWelcomeMessage.input>;
