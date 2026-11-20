import type { VoiceTranscriptData } from "../core/contract.ts";
import { MessageSquare } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { displayMessageText } from "./i18n/message-labels.ts";
import { MessageActionEntry } from "./message-action-slot.tsx";
import { SuggestedProfilePhotoMessage } from "./contact-photo-suggestion.tsx";
import { BirthdaySuggestionMessage } from "./contact-birthday-suggestion.tsx";
import { mayAutoplayMessage } from "./automatic-playback.tsx";
import type { AutoPlaybackLimits } from "../core/contract.ts";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { DocumentButton } from "./document-button.tsx";
import { MarkdownDocumentPreview } from "./markdown-document.tsx";
import { embeddedPlaybackId, isRichAudioTrack, RichMessage, type RichDocumentBlock, type RichPhotoLoader } from "./rich-message.tsx";
import { UseInlineBotDraft } from "./inline-bot-search.tsx";
import { MessageDelivery } from "./message-delivery.tsx";
import { MessageChatSenderBan } from "./message-chat-sender-ban.tsx";
import { InlineBotKeyboard } from "./inline-bot-keyboard.tsx";
import { transcriptionLimit } from "../core/transcription-limits.ts";
import { MessageChecklist } from "./checklist.tsx";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ContextType, type ReactNode } from "react";
import { StickerPackPreview } from "./sticker-pack-preview.tsx";
import type { StickerPackPreviewData, MediaCollectionKind, MediaTimestampRange, PaidMedia, RichAttachmentReference, PollChoice, PollInfo, PollMediaAttachment, PollAttachmentReference, PollVoterPage, PhotoSize, TelegramPhoto } from "../core/contract.ts";
import { AddStickerToOwnedPack, type OwnedStickerDestinations } from "./add-sticker-to-owned-pack.tsx";
import { webLink } from "../core/message-links.ts";
import type { Message } from "../core/demo.ts";
import { MessageForward, type ForwardActions } from "./message-forward.tsx";
import { MessageReactions, type ReactionActions } from "./message-reactions.tsx";
import { MediaPlayer, type MediaLoader, type VideoStreamLoader } from "./media-player.tsx";
import { AlbumMusicTracks, musicTrack, PlayMusic, PlaySharedMusic } from "./music-playback.tsx";
import { PlaybackQueue, isPlayableAlbumTrack } from "./note-playback-queue.tsx";
import type { VisibleThumbnailLoader } from "./visible-thumbnail.ts";
import { SharedContactCard } from "./shared-contact.tsx";
import { LocationCard } from "./location-card.tsx";
import { OpenMessageStory } from "./stories.tsx";
import { InstantViewButton, MediaSlideshow } from "./instant-view.tsx";
import { MessageTranslationControl } from "./message-translation.tsx";
import { BotWidgetPreview } from "./bot-widget-preview.tsx";
import { MessageText } from "./message-text.tsx";
import { MessageEffect, type AutomaticMessageEffect } from "./message-effect.tsx";

import { ExternalReplyReference } from "./external-reply-reference.tsx";
import { ForwardedFrom } from "./forwarded-from.tsx";
import { PhotoPreview, type AlbumPhoto, type DrawPhotoReply, type MorePhotos } from "./photo-preview.tsx";
import type { LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { PhotoMotionPlayer } from "./photo-motion.tsx";
import { PollSticker } from "./poll-stickers.tsx";
import { AddPollOption, PollOptionActions, RemovePollOption } from "./poll-options.tsx";
import { LoadPollVoteHistory, PollVoteHistory } from "./poll-vote-history.tsx";
import { LoadPollVoters, PollVoters } from "./poll-voters.tsx";
import { LoadTgsSticker, TgsSticker } from "./tgs-sticker.tsx";
import { QueueDownloadButton } from "./download-queue.tsx";
import { AddProfileAudioButton } from "./profile-audio.tsx";

export const PollFileActions = createContext<{
  save: (id: string, messageId: string, reference: PollAttachmentReference) => Promise<boolean>;
  play: (id: string, messageId: string, reference: PollAttachmentReference) => Promise<string>;
} | undefined>(undefined);

export const LoadPollPhoto = createContext<((id: string, messageId: string, reference: PollAttachmentReference,
  size?: PhotoSize) => Promise<TelegramPhoto>) | undefined>(undefined);

export const PurchasePaidMedia = createContext<((chatId: string, messageId: string, stars: number) =>
  Promise<"paid" | "changed" | "failed" | "pending">) | undefined>(undefined);

function PaidMediaPurchase({ chatId, messageId, stars }: { chatId: string; messageId: string; stars: number }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const purchase = useContext(PurchasePaidMedia);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"paid" | "changed" | "failed" | "pending">();
  const working = useRef(false);
  if (!purchase) return null;
  async function confirm() {
    if (!purchase || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      setResult(await purchase(chatId, messageId, stars).catch(() => "pending" as const));
      setReview(false);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return <>
    {review ? <div role="group" aria-label={tr("Review paid media purchase")}>
      <p>{tr("Spend ")}{stars.toLocaleString(uiLocale)}{tr(" Stars to unlock this media?")}</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{tr("Confirm media purchase")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(false)}>{tr("Cancel media purchase")}</button>
    </div> : result !== "paid" && result !== "pending" && <button type="button" className="mtg-action"
      onClick={() => { setResult(undefined); setReview(true); }}>{tr("Review purchase")}</button>}
    {result && <p role="status">{result === "paid" ? tr("Payment confirmed. Waiting for Telegram to unlock the media.")
      : result === "changed" ? tr("The price or media changed. Refresh the chat before trying again.")
      : result === "failed" ? tr("Telegram could not complete the purchase.")
      : tr("Payment status is unconfirmed. Check Stars transactions before trying again.")}</p>}
  </>;
}

function PaidAttachment({ item, chatId, messageId, loadPhoto, loadVideoStream }: {
  item: PaidMedia["items"][number]; chatId: string; messageId: string; loadPhoto?: RichPhotoLoader;
  loadVideoStream?: Parameters<typeof MessageBody>[0]["loadVideoStream"];
}) {
  const { t: tr } = useTelegramLocale();
  const { kind, preview, reference, mime, cover, motion } = item;
  const image = kind === "video" ? cover : reference;
  const imageIndex = image?.index, imageFile = image?.fileId;
  const videoReference = kind === "photo" ? motion?.reference : reference;
  const index = videoReference?.index, fileId = videoReference?.fileId;
  const photo = useCallback((_chat: string, _message: string, size?: PhotoSize) =>
    loadPhoto!(chatId, messageId, size, { index: imageIndex!, fileId: imageFile!, paid: true }), [chatId, messageId, imageIndex, imageFile, loadPhoto]);
  const video = useCallback(() =>
    loadVideoStream!(chatId, messageId, { index: index!, fileId: fileId!, paid: true }), [chatId, messageId, index, fileId, loadVideoStream]);
  const identity = `${messageId}:paid:${index}:${fileId}`;
  if (kind === "photo") return <>
    {reference && loadPhoto
      ? <PhotoPreview chatId={chatId} messageId={`${messageId}:paid-photo:${imageIndex}:${imageFile}`} load={photo} dimensions={item.dimensions} />
      : tr("Paid photo unavailable")}
    {motion && loadVideoStream && <MediaPlayer key={identity} chatId={chatId} messageId={identity} mime={motion.mime} stream={video} />}
  </>;
  if (kind === "video") return <>
    {cover && loadPhoto && <PhotoPreview key={cover.fileId} chatId={chatId} messageId={`${messageId}:paid-cover:${cover.index}:${cover.fileId}`}
      load={photo} dimensions={item.dimensions} />}
    {reference && mime && loadVideoStream
      ? <MediaPlayer chatId={chatId} messageId={identity} mime={mime} stream={video} startTime={item.startTime} />
      : tr("Paid video unavailable")}
  </>;
  return <>
    {preview && <img src={`data:image/jpeg;base64,${preview}`} alt="" width={48} height={48} loading="lazy" />}
    {kind === "locked" ? tr("Locked attachment") : tr("Unsupported attachment")}
  </>;
}

type StickerPack = StickerPackPreviewData;

export type MediaCollectionActions = {
  ownedSticker?: OwnedStickerDestinations;
  loadPack?: (chatId: string, messageId: string, offset: number) => Promise<StickerPack | null>;
  installPack?: (chatId: string, messageId: string, packId: string) => Promise<"installed" | "unavailable" | "unknown">;
  load: (chatId: string, messageId: string, kind: MediaCollectionKind) => Promise<boolean | null>;
  save: (chatId: string, messageId: string, kind: MediaCollectionKind, saved: boolean, expected: boolean) =>
    Promise<"saved" | "changed" | "unavailable" | "unknown">;
};

export const LoadMessagePreviewCover = createContext<((chatId: string, messageId: string, fileId: number, size?: PhotoSize) => Promise<TelegramPhoto>) | undefined>(undefined);
export const LoadMessagePreviewPlayback = createContext<((chatId: string, messageId: string, fileId: number) => Promise<string>) | undefined>(undefined);
export const LoadMessagePoster = createContext<VisibleThumbnailLoader | undefined>(undefined);
export type MarkNotePlayed = (chatId: string, messageId: string) => Promise<boolean>;
export const NotePlaybackReceipt = createContext<MarkNotePlayed | undefined>(undefined);

export function MessageContent(props: Parameters<typeof MessageBody>[0] & { automaticEffect?: AutomaticMessageEffect }) {
  const { t: tr } = useTelegramLocale();
  const useInlineBot = useContext(UseInlineBotDraft);
  const { chatId, message } = props;
  if (message.restricted) return <p>{message.text}</p>;
  if (props.libraryTile) return <MessageBody {...props} />;
  const bot = !message.retained && message.viaBot;
  return <>
    {bot && <span className="mtg-via-bot">{tr("via ")}{useInlineBot
      ? <button type="button" className="mtg-hidden-link" onClick={() => useInlineBot(chatId, bot)}>@{bot}</button>
      : <bdi>@{bot}</bdi>}</span>}
    <MessageBody {...props} />
    {message.effectId && !message.retained && !message.pendingDelivery && !message.oneView &&
      <MessageEffect key={`effect:${chatId}:${message.id}:${message.effectId}`} chatId={chatId} messageId={message.id}
        effectId={message.effectId} automatic={props.automaticEffect} />}
    {message.sender?.kind === "chat" && <MessageChatSenderBan chatId={chatId} message={message} />}
    {message.pendingDelivery && !message.retained && <MessageDelivery key={`delivery:${chatId}:${message.id}`} chatId={chatId} message={message} />}
    {message.inlineBotKeyboard && !message.retained && !message.pendingDelivery && !message.oneView &&
      <InlineBotKeyboard key={`inline-keyboard:${chatId}:${message.id}`} chatId={chatId} messageId={message.id}
        rows={message.inlineBotKeyboard} gameForward={props.forwardActions} />}
  </>;
}

function MessagePhotoMotion({ chatId, messageId, motion, load }: {
  chatId: string;
  messageId: string;
  motion: NonNullable<Message["photoMotion"]>;
  load: NonNullable<Parameters<typeof MessageBody>[0]["loadVideoStream"]>;
}) {
  const play = useCallback((fileId: number) => load(chatId, messageId, undefined, fileId), [load, chatId, messageId]);
  return <PhotoMotionPlayer chatId={chatId} messageId={messageId} motion={motion} play={play} />;
}

function MessageBody({ chatId, message, autoplayLimits, mediaTimestamp, replyPlayback, openReplyTimestamp, checklistTaskId, pollOptionId, loadMessageLink, loadGroupEmoji, hideCaption, libraryTile, documentInInspector, forwardedInAlbum, albumPhotos, morePhotos, openPhotoMessage, openVideoMessage, drawPhotoReply, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, mediaCollection, conversationPhotos }: {
  chatId: string;
  message: Message;
  conversationPhotos?: boolean;
  forwardedInAlbum?: boolean;
  autoplayLimits?: AutoPlaybackLimits;
  mediaTimestamp?: number;
  replyPlayback?: { time: number };
  openReplyTimestamp?: (id: string, time: number, trigger: HTMLElement) => void;
  checklistTaskId?: number;
  pollOptionId?: string;
  loadMessageLink?: MessageLinkLoader;
  loadGroupEmoji?: LoadGroupEmoji;
  hideCaption?: boolean;
  libraryTile?: boolean;
  documentInInspector?: boolean;
  albumPhotos?: readonly AlbumPhoto[];
  morePhotos?: MorePhotos;
  openPhotoMessage?: (id: string) => void;
  openVideoMessage?: () => void;
  drawPhotoReply?: DrawPhotoReply;
  mediaCollection?: MediaCollectionActions;
  forwardActions?: ForwardActions;
  reactionActions?: ReactionActions;
  stopPoll?: (chatId: string, messageId: string) => Promise<boolean>;
  voteInPoll?: (chatId: string, messageId: string, choices: PollChoice[]) => Promise<boolean>;
  loadMedia?: MediaLoader;
  transcribeVoice?: (chatId: string, messageId: string, signal: AbortSignal, timed?: true) => Promise<string | VoiceTranscriptData>;
  loadVideoStream?: VideoStreamLoader;
  saveDocument?: (chatId: string, messageId: string, attachment?: RichAttachmentReference) => Promise<boolean>;
  loadPhoto?: RichPhotoLoader;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const loadPreviewCover = useContext(LoadMessagePreviewCover);
  const loadPreviewPlayback = useContext(LoadMessagePreviewPlayback);
  const loadPoster = useContext(LoadMessagePoster);
  const markNotePlayed = useContext(NotePlaybackReceipt);
  const openStory = useContext(OpenMessageStory);
  const pollFiles = useContext(PollFileActions);
  const loadPollPhoto = useContext(LoadPollPhoto);
  const pollOptionActions = useContext(PollOptionActions);
  const loadPollVoteHistory = useContext(LoadPollVoteHistory);
  const loadPollVoters = useContext(LoadPollVoters);
  const loadTgsSticker = useContext(LoadTgsSticker);
  const queue = useContext(PlaybackQueue);
  const playMusic = useContext(PlayMusic);
  const playSharedMusic = useContext(PlaySharedMusic);
  const musicTracks = useContext(AlbumMusicTracks);
  const [revealedVideo, setRevealedVideo] = useState<string>();
  const [captionSeek, setCaptionSeek] = useState<{ identity: string; time: number }>();
  const [playedNote, setPlayedNote] = useState<string>();
  const pendingNote = useRef<string | undefined>(undefined);
  const story = message.replyToStory ?? message.sharedStory;
  const storyLabel = message.replyToStory ? tr("Reply to a story") : tr("Shared story");
  const storyReference = story && (openStory && !message.retained
    ? <button type="button" className="mtg-open-reply" aria-haspopup="dialog" onClick={() => openStory(story)}>{storyLabel}</button>
    : <p className="mtg-reply-quote">{storyLabel}</p>);
  const forwarded = message.forwardedFrom !== undefined && <ForwardedFrom name={message.forwardedFrom} source={message.forwardedPost}
    from={{ chatId, messageId: message.id, topicId: message.forumTopicId }} action={forwardedInAlbum} />;
  const actionable = !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id);
  const albumPlaylist = queue?.kind === "audioAlbum" && isPlayableAlbumTrack(message);
  const actions = actionable ? reactionActions : undefined;
  const identity = `${chatId}:${message.id}`;
  function timestampButtons(timestamps: readonly MediaTimestampRange[], select: (time: number, trigger: HTMLElement) => void) {
    return timestamps.filter(({ offset, length }) => !message.links?.some((link) =>
      offset < link.offset + link.length && link.offset < offset + length)).map(({ offset, length, time }) => ({
      offset, length, content: (label: ReactNode) => <button type="button" className="mtg-video-timestamp"
        onClick={(event) => select(time, event.currentTarget)}>{label}</button>,
    }));
  }
  const replyTo = message.replyTo;
  const replyButtons = actionable && !hideCaption && replyTo && openReplyTimestamp && message.replyTimestamps
    ? timestampButtons(message.replyTimestamps, (time, trigger) => openReplyTimestamp(replyTo, time, trigger))
    : [];
  function timestampControls(target: string, timestamps: readonly MediaTimestampRange[] = [], enabled = true) {
    return {
      chapters: [...new Set(timestamps.map(({ time }) => time))].sort((a, b) => a - b),
      seekRequest: captionSeek?.identity === target ? captionSeek : replyPlayback,
      replacements: replyButtons.length ? replyButtons : enabled
        ? timestampButtons(timestamps, (time) => setCaptionSeek({ identity: target, time })) : [],
    };
  }
  const translation = actionable && !hideCaption && message.canTranslate
    && <MessageTranslationControl key={`${identity}:${message.editedAt ?? ""}:${message.photoCaption ?? message.document?.caption ?? message.text}`}
      chatId={chatId} messageId={message.id} />;
  const forward = actionable && forwardActions && <MessageActionEntry key={`forward:${identity}`}><MessageForward
    chatId={chatId} messageId={message.id} actions={forwardActions} hasCaption={!!(message.photoCaption || message.document?.caption)} /></MessageActionEntry>;
  const reactions = (message.reactions || actions) && <MessageReactions key={`reactions:${identity}`}
    chatId={chatId} messageId={message.id} reactions={message.reactions} actions={actions} />;
  const preamble = !libraryTile && <>{storyReference}{forwardedInAlbum ? <MessageActionEntry>{forwarded}</MessageActionEntry> : forwarded}{message.replyFromChat &&
    <ExternalReplyReference key={`${identity}:${message.replyFromChat.chatId}:${message.replyFromChat.messageId}`} chatId={chatId} message={message} />}</>;
  if (message.sharedStory) return <>{preamble}{reactions}{forward}</>;
  if (message.paidMedia) {
    const { stars, items, caption: paidCaption } = message.paidMedia;
    const locked = items.some(({ kind }) => kind === "locked");
    const caption = !hideCaption && paidCaption && <MessageText text={paidCaption} links={message.links}
      styles={message.styles} customEmoji={message.customEmoji} />;
    return <>{preamble}{message.captionAboveMedia && caption}
      <section aria-label={tr("Paid media")}>
        {locked && <p>{tr("Locked · ")}{stars.toLocaleString(uiLocale)}{tr(" Stars")}</p>}
        <ul>{items.map((item, index) => <li key={`${index}:${item.reference?.fileId ?? item.kind}`}>
          <PaidAttachment item={item} chatId={chatId} messageId={message.id}
            loadPhoto={actionable ? loadPhoto : undefined} loadVideoStream={actionable ? loadVideoStream : undefined} />
        </li>)}</ul>
        {locked && actionable && !message.outgoing && chatId && <PaidMediaPurchase key={`${identity}:${stars}`}
          chatId={chatId} messageId={message.id} stars={stars} />}
      </section>
      {!message.captionAboveMedia && caption}{reactions}{forward}</>;
  }
  if (message.richMessage) return <>{preamble}<RichMessage key={identity} layout={message.richMessage} chatId={chatId} messageId={message.id}
    loadPhoto={actionable ? loadPhoto : undefined} edit={actionable ? message.richEdit : undefined} audioPlaylist={actionable && !!loadMedia}
    canQuote={actionable && message.canQuote} emojiActions={actionable}
    sourceActions={actionable && !!chatId && !message.failedDelivery}
    loadGroupEmoji={loadGroupEmoji}
    renderDocument={(block) => <EmbeddedDocument key={`${block.reference.index}:${block.reference.fileId}:${block.spoiler}`}
      block={block} chatId={chatId} messageId={message.id}
      load={actionable ? loadMedia : undefined} stream={actionable ? loadVideoStream : undefined}
      save={actionable ? saveDocument : undefined} />} />{translation}{reactions}{forward}</>;
  const loadStickerPack = mediaCollection?.loadPack;
  const installStickerPack = mediaCollection?.installPack;
  const collection = actionable && message.collectionKind && mediaCollection &&
    <MessageActionEntry><div>
      <MediaCollection key={`collection:${identity}`} chatId={chatId} messageId={message.id} kind={message.collectionKind} actions={mediaCollection} />
      {message.canAddToStickerPack && mediaCollection.ownedSticker && <AddStickerToOwnedPack key={`owned-sticker:${identity}`}
        chatId={chatId} messageId={message.id} actions={mediaCollection.ownedSticker} />}
      {message.hasStickerPack && loadStickerPack && <StickerPackPreview key={`pack:${identity}`}
        load={(offset) => loadStickerPack(chatId, message.id, offset)}
        install={installStickerPack && ((id) => installStickerPack(chatId, message.id, id))} />}
    </div></MessageActionEntry>;
  if (message.oneView && loadMedia) {
    return <MediaPlayer key={`one-view:${identity}`} chatId={chatId} messageId={message.id}
      oneView={message.oneView} saved={!!message.retained} load={loadMedia} />;
  }
  if (message.contact) {
    return <>{preamble}<SharedContactCard key={identity} contact={message.contact} chatId={chatId}
      messageId={message.id} actionable={actionable} />{reactions}{forward}</>;
  }
  if (message.location) {
    return <>{preamble}<LocationCard key={identity} location={message.location} chatId={chatId} messageId={message.id} previewAllowed={actionable} />{reactions}{forward}</>;
  }
  const loadItemLink = actionable ? loadMessageLink : undefined;
  if (message.checklist) {
    return <>{preamble}<MessageChecklist key={identity} chatId={chatId} messageId={message.id}
      checklist={message.checklist} actionable={actionable} highlightedTask={checklistTaskId} loadLink={loadItemLink} />{reactions}{forward}</>;
  }
  if (message.poll) {
    return <>{preamble}<Poll key={`poll:${identity}`} poll={message.poll} highlightedOption={pollOptionId}
      copyLink={loadItemLink && ((id, text) => <CopyTelegramLink chatId={chatId} messageId={message.id} load={loadItemLink}
        target={{ kind: "poll option", id }} itemLabel={text} />)}
      renderMedia={(media, slot) => {
        if (media.kind === "location") return <LocationCard location={media.location} chatId={chatId} messageId={message.id} previewAllowed={false} />;
        if (media.kind === "link") return <a className="mtg-poll-option-link" href={media.url}
          target="_blank" rel="noopener noreferrer">{media.title ?? media.url}</a>;
        if (media.kind === "file") return <PollFile key={JSON.stringify([slot, media.fileId])}
          media={media} slot={slot} chatId={chatId} messageId={message.id}
          actions={media.document.downloadable && actionable && !message.failedDelivery ? pollFiles : undefined} />;
        if (media.kind === "sticker") return typeof slot === "number" && actionable && !message.failedDelivery
          ? <PollSticker key={JSON.stringify([slot, media.fileId])} chatId={chatId} messageId={message.id} slot={slot} media={media} />
          : <bdi>{media.label}</bdi>;
        if (actionable && !message.failedDelivery) {
          const motion = media.motion && pollFiles && <PhotoMotionPlayer key={`${slot}:${media.motion.fileId}`}
            chatId={chatId} messageId={`${message.id}:poll:${slot}`} motion={media.motion}
            play={(fileId) => pollFiles.play(chatId, message.id, { slot, fileId })} />;
          return loadPollPhoto ? <PhotoPreview
            key={JSON.stringify([slot, media.fileId, media.previewId])} chatId={chatId} messageId={message.id} dimensions={media.dimensions}
            load={(id, messageId, size) => loadPollPhoto(id, messageId, { slot, fileId: media.fileId }, size)}
            motion={motion} /> : motion;
        }
      }}
      addOption={actionable && !message.failedDelivery && pollOptionActions ? (text) => pollOptionActions.add(chatId, message.id, text) : undefined}
      removeOption={actionable && !message.failedDelivery && pollOptionActions ? (option, text) => <RemovePollOption key={JSON.stringify([option, text])}
        text={text} check={() => pollOptionActions.canRemove(chatId, message.id, option, text)}
        remove={() => pollOptionActions.remove(chatId, message.id, option, text)} /> : undefined}
      history={actionable && !message.failedDelivery && loadPollVoteHistory
        ? <PollVoteHistory question={message.poll.question} load={(at) => loadPollVoteHistory(chatId, message.id, at)} /> : undefined}
      loadVoters={loadPollVoters ? (choice, offset) => loadPollVoters(chatId, message.id, choice, offset) : undefined}
      stop={actionable && message.canStopPoll && stopPoll ? () => stopPoll(chatId, message.id) : undefined}
      vote={voteInPoll ? (choices) => voteInPoll(chatId, message.id, choices) : undefined} />{reactions}{forward}</>;
  }
  if (message.tgsSticker && loadTgsSticker) {
    return <>{preamble}<TgsSticker key={identity} chatId={chatId} messageId={message.id} load={loadTgsSticker}
      fallback={message.hasPhoto && loadPhoto
        ? <PhotoPreview chatId={chatId} messageId={message.id} load={loadPhoto} dimensions={{ width: 144, height: 144 }} />
        : undefined} />{collection}{reactions}{forward}</>;
  }
  if (chatId && message.hasPhoto && loadPhoto) {
    const renderMotion = actionable && !message.failedDelivery && loadVideoStream
      ? (id: string, motion: NonNullable<Message["photoMotion"]>) => <MessagePhotoMotion key={`${id}:${motion.fileId}`}
        chatId={chatId} messageId={id} motion={motion} load={loadVideoStream} />
      : undefined;
    const caption = !hideCaption && <MessageText text={message.photoCaption} links={message.links} styles={message.styles} quoteSource={message.canQuote ? message.id : undefined}
      customEmoji={message.customEmoji} replacements={replyButtons} emojiStatusActions={actionable} />;
    return <>
      {preamble}
      {message.captionAboveMedia && caption}
      <PhotoPreview key={`photo:${identity}:${message.photoSpoiler === true}:${message.photoEditRevision ?? message.editedAt ?? ""}`}
        chatId={chatId} messageId={message.id} load={loadPhoto} inConversation={conversationPhotos && message.collectionKind !== "sticker"} spoiler={message.photoSpoiler} album={albumPhotos} morePhotos={morePhotos} caption={message} openMessage={openPhotoMessage} canSave={message.canSavePhoto} save={saveDocument} dimensions={message.photoDimensions}
        drawReply={actionable && !message.failedDelivery ? drawPhotoReply : undefined}
        motion={message.photoMotion && renderMotion?.(message.id, message.photoMotion)} renderAlbumMotion={renderMotion} />
      {actionable && message.canSavePhoto && !message.photoSpoiler && <MessageActionEntry key={`queue:${identity}`}><QueueDownloadButton chatId={chatId} messageId={message.id} /></MessageActionEntry>}
      {!message.captionAboveMedia && caption}
      {translation}{collection}{reactions}{forward}
    </>;
  }
  if (message.document) {
    const playbackRevision = message.attachmentEdit?.revision ?? message.editedAt;
    const attachmentIdentity = `${identity}:${playbackRevision ?? ""}`;
    const playbackFileId = message.document.playbackFileId;
    const playerIdentity = playbackFileId === undefined ? attachmentIdentity : `${identity}:file:${playbackFileId}`;
    const canPlay = message.document.downloadable && message.document.playbackMime && loadMedia;
    const isNote = !!(message.voiceNote || message.videoNote);
    const viewContent = !isNote && message.document.playbackMime?.startsWith("video/")
      && !!(libraryTile || conversationPhotos || openVideoMessage);
    const viewerCaption = message.document.caption;
    const download = message.document.downloadable && saveDocument ? () => saveDocument(chatId, message.id) : undefined;
    const notePlayed = actionable && canPlay && isNote && message.notePlayed !== undefined
      ? message.notePlayed || playedNote === attachmentIdentity : undefined;
    const noteStatus = message.outgoing
      ? notePlayed ? "Played by a recipient" : "Not yet played by a recipient"
      : notePlayed ? "Played note" : "Unplayed note";
    async function markPlaying() {
      if (notePlayed !== false || !markNotePlayed || message.outgoing || pendingNote.current === attachmentIdentity) return;
      pendingNote.current = attachmentIdentity;
      try {
        if (await markNotePlayed(chatId, message.id) && pendingNote.current === attachmentIdentity) {
          setPlayedNote(attachmentIdentity);
        }
      } catch {
        // A later playback can retry while the note is still unplayed.
      } finally {
        if (pendingNote.current === attachmentIdentity) pendingNote.current = undefined;
      }
    }
    const { chapters, seekRequest, replacements } = timestampControls(attachmentIdentity,
      !hideCaption && canPlay ? message.document.timestamps : undefined,
      !message.videoSpoiler || revealedVideo === playerIdentity);
    const caption = !hideCaption && <MessageText text={message.document.caption} links={message.links} styles={message.styles} quoteSource={message.canQuote ? message.id : undefined}
      customEmoji={message.customEmoji} replacements={replacements} emojiStatusActions={actionable} />;
    const persistentMusic = playMusic && loadMedia && isPlayableAlbumTrack(message);
    const player = persistentMusic
      ? <button type="button" className="mtg-action" onClick={() => {
        if (playSharedMusic) {
          playSharedMusic(message.id);
          return;
        }
        const tracks = (musicTracks ?? [message]).flatMap((track) =>
          musicTrack(track, chatId, loadMedia, loadVideoStream, track.id === message.id ? mediaTimestamp : undefined) ?? []);
        playMusic(tracks, tracks.findIndex(({ messageId }) => messageId === message.id));
      }}>{tr("Play audio")}</button>
      : message.document.downloadable && message.document.playbackMime && loadMedia
      ? (
        <MediaPlayer key={`player:${playerIdentity}:${message.document.playbackMime}`}
          chatId={chatId} messageId={message.id} playbackFileId={playbackFileId} playbackRevision={playbackRevision} mime={message.document.playbackMime} load={loadMedia} loop={message.animation}
          playbackDialog={viewContent}
          viewerActions={viewContent && download && <DocumentButton document={message.document} compactVideo save={download} />}
          viewerDetails={viewContent && (viewerCaption || openVideoMessage) ? (close) => <>
            {viewerCaption && <section className="mtg-photo-caption">
              <h2>{tr("Photo caption")}</h2>
              <MessageText text={viewerCaption} links={message.links} styles={message.styles} customEmoji={message.customEmoji} />
            </section>}
            {openVideoMessage && <div className="mtg-viewer-detail-actions">
              <button type="button" className="mtg-viewer-detail-action" onClick={() => { close(); openVideoMessage(); }}>
                <MessageSquare size={16} aria-hidden="true" />{tr("Go to message")}
              </button>
            </div>}
          </> : undefined}
          playWhenVisible={!libraryTile && mayAutoplayMessage(message, autoplayLimits, !!loadVideoStream)}
          videoNote={message.videoNote} voiceNote={message.voiceNote} startTime={mediaTimestamp} loadMessageLink={loadItemLink}
          chapters={chapters} seekRequest={seekRequest}
          posterSize={actionable && !message.videoSpoiler ? message.document.posterSize : undefined} loadPoster={loadPoster}
          durationSeconds={message.document.durationSeconds}
          seekPreview={!message.animation && !isNote && message.document.playbackMime.startsWith("video/")}
          videoQualities={message.document.videoQualities}
          streamQuality={loadVideoStream}
          autoplayVideoBudget={autoplayLimits?.video && message.document.videoQualities && message.document.sizeBytes
            ? { originalBytes: message.document.sizeBytes, limitBytes: autoplayLimits.video * 1024 * 1024 } : undefined}
          waveform={message.document.waveform}
          onNotePlaying={notePlayed === false && !message.outgoing && markNotePlayed ? markPlaying : undefined}
          audioMetadata={message.document.audioTrack && { title: message.document.audioTrack.title ?? message.document.name,
            artist: message.document.audioTrack.artist }}
          queuePlayback={albumPlaylist || (actionable && isNote && !message.videoSpoiler)}
          playlistControls={albumPlaylist}
          stream={!message.document.approximateSize && (message.document.playbackMime.startsWith("video/")
            || (!message.voiceNote && message.document.playbackMime.startsWith("audio/")))
            ? loadVideoStream : undefined} />
      ) : undefined;
    const limit = isNote && transcriptionLimit(message.videoNote ? "video" : "voice", message.document.durationSeconds, message.document.sizeBytes);
    const transcript = actionable && message.document.downloadable && isNote && transcribeVoice
      && (limit ? <p>{limit === "size" ? tr("Local transcription supports files up to 16 MiB.")
        : message.videoNote ? tr("Local transcription supports video notes up to one minute.")
          : tr("Local transcription supports voice notes up to ten minutes.")}</p>
        : <VoiceTranscript key={`transcript:${attachmentIdentity}`} load={async (signal) => {
          const result = await transcribeVoice(chatId, message.id, signal);
          return typeof result === "string" ? result : result.text;
        }} />);
    const media = <>
      {notePlayed !== undefined && <span className="mtg-note-playback" data-unplayed={!notePlayed || undefined}
        role="img" aria-label={tr(noteStatus)} title={tr(noteStatus)} />}
      {!player && transcript}
      {(!documentInInspector || message.document.playbackMime) && <DocumentButton key={`download:${playerIdentity}`} document={message.document}
        compactVideo={!!player && (libraryTile || !!message.document.posterSize) && actionable && !isNote && !message.videoSpoiler &&
          !!message.document.playbackMime?.startsWith("video/")}
        player={player && <>{player}{transcript}</>}
        save={download} />}
      {actionable && !documentInInspector && <MarkdownDocumentPreview key={`document-preview:${attachmentIdentity}`} document={message.document}
        chatId={chatId} messageId={message.id} save={download} />}
      {actionable && message.document.downloadable && <MessageActionEntry key={`queue:${identity}`}><QueueDownloadButton chatId={chatId} messageId={message.id} /></MessageActionEntry>}
      {actionable && message.document.downloadable && message.profileAudioFileId !== undefined &&
        <AddProfileAudioButton key={`profile-audio:${identity}:${message.profileAudioFileId}`} id={chatId}
          messageId={message.id} fileId={message.profileAudioFileId} name={message.document.name} />}
    </>;
    return <>
      {preamble}
      {message.captionAboveMedia && caption}
      {message.videoSpoiler ? <VideoSpoiler key={`spoiler:${playerIdentity}`} animation={message.animation}
        onReveal={() => setRevealedVideo(playerIdentity)}>
        {media}
      </VideoSpoiler> : media}
      {!message.captionAboveMedia && caption}
      {translation}{collection}{reactions}{forward}
    </>;
  }
  const preview = message.linkPreview;
  const link = preview && !message.styles?.some(({ style }) => style === "spoiler") && webLink(preview.url);
  const previewCover = actionable && loadPreviewCover && preview?.cover;
  const previewMedia = actionable && loadPreviewPlayback && preview?.media;
  const previewIdentity = `preview:${identity}:${previewMedia ? previewMedia.fileId : ""}:${link ? link.href : ""}`;
  const { chapters, seekRequest, replacements } = timestampControls(previewIdentity,
    !hideCaption && link && previewMedia && previewMedia.mime.startsWith("video/") && !previewMedia.loop && !previewMedia.videoNote
      ? preview?.timestamps : undefined);
  const card = preview && link && <><a className="mtg-link-preview" href={link.href} target="_blank" rel="noopener noreferrer">
    <span><bdi>{preview.site || link.hostname}</bdi></span>
    {preview.title && <strong><bdi>{preview.title}</bdi></strong>}
    {preview.description && <span><bdi>{preview.description}</bdi></span>}
    {!!preview.site && <small><bdi>{link.hostname}</bdi></small>}
  </a>{previewCover && <PreviewCover key={previewCover.fileId} chatId={chatId} messageId={message.id} cover={previewCover} loadCover={loadPreviewCover!} />}
    {actionable && preview.album && (loadPreviewCover || loadPreviewPlayback) &&
      <PreviewAlbum key={`preview-album:${link.href}:${mediaTimestamp ?? ""}`} chatId={chatId} messageId={message.id} album={preview.album}
        startTime={mediaTimestamp} loadCover={loadPreviewCover} loadPlayback={loadPreviewPlayback} loadMessageLink={loadItemLink} />}
    {preview.instantView && <InstantViewButton key={`instant-view:${link.href}`} url={link.href} />}
    {previewMedia && <PreviewPlayer key={previewIdentity} chatId={chatId} messageId={message.id} media={previewMedia}
      startTime={mediaTimestamp} chapters={chapters} seekRequest={seekRequest}
      loadPreview={loadPreviewPlayback!} loadMessageLink={loadItemLink} />}</>;
  const widget = message.widget && actionable && !hideCaption && <BotWidgetPreview key={identity} chatId={chatId} messageId={message.id} />;
  return <>{preamble}{preview?.above && card}{!message.captionAboveMedia && widget}
    {!hideCaption && actionable && message.suggestedProfilePhotoId && message.forwardedFrom === undefined &&
      <SuggestedProfilePhotoMessage key={`${identity}:${message.suggestedProfilePhotoId}`} chatId={chatId} messageId={message.id}
        photoId={message.suggestedProfilePhotoId} canAccept={!message.outgoing && !message.failedDelivery} />}
    {!hideCaption && message.suggestedBirthday && <BirthdaySuggestionMessage key={identity} chatId={chatId} messageId={message.id}
      birthdate={message.suggestedBirthday} actionable={actionable && !message.outgoing && message.forwardedFrom === undefined && !message.failedDelivery} />}
    {message.gameTitle && <strong><bdi>{message.gameTitle}</bdi></strong>}
    {!hideCaption && actionable && message.gameArtwork?.cover && loadPreviewCover && <PreviewCover
      key={`game-cover:${identity}:${message.gameArtwork.cover.fileId}`} chatId={chatId} messageId={message.id}
      cover={message.gameArtwork.cover} loadCover={loadPreviewCover} />}
    {!hideCaption && actionable && message.gameArtwork?.animation && loadPreviewPlayback && <PreviewPlayer
      key={`game-animation:${identity}:${message.gameArtwork.animation.fileId}`} chatId={chatId} messageId={message.id}
      media={message.gameArtwork.animation} loadPreview={loadPreviewPlayback} />}
    {!hideCaption && !message.suggestedBirthday
      && !(actionable && message.suggestedProfilePhotoId && message.forwardedFrom === undefined) && (!message.gameTitle || message.text !== message.gameTitle || message.styles?.length || message.links?.length) &&
      <MessageText text={displayMessageText(message, tr)} links={message.links} styles={message.styles} quoteSource={message.canQuote ? message.id : undefined}
      customEmoji={message.customEmoji} replacements={replacements} emojiStatusActions={actionable} />}
    {message.captionAboveMedia && widget}{!preview?.above && card}{translation}{collection}{reactions}{forward}</>;
}

function PreviewAlbum({ chatId, messageId, album, startTime, loadCover, loadPlayback, loadMessageLink }: {
  chatId: string; messageId: string; album: NonNullable<NonNullable<Message["linkPreview"]>["album"]>;
  startTime?: number; loadMessageLink?: MessageLinkLoader;
  loadCover: ContextType<typeof LoadMessagePreviewCover>; loadPlayback: ContextType<typeof LoadMessagePreviewPlayback>;
}) {
  const { t: tr } = useTelegramLocale();
  const [index, setIndex] = useState<number>();
  const items = album.items.filter((item) => "mime" in item ? !!loadPlayback : !!loadCover);
  const videos = items.filter((item) => "mime" in item && item.mime.startsWith("video/"));
  // A Telegram timestamp identifies the message, so only a sole video can be targeted.
  const timestampSlide = videos.length === 1 ? items.indexOf(videos[0]!) : -1;
  const initialSlide = startTime !== undefined && timestampSlide >= 0 ? timestampSlide : 0;
  if (!items.length) return null;
  return <>
    <MediaSlideshow label={tr("Link preview album")} count={items.length} rtl={false} index={Math.min(index ?? initialSlide, items.length - 1)}
      select={setIndex} renderSlide={(slide) => {
        const item = items[slide]!;
        return "mime" in item
          ? <PreviewPlayer key={item.fileId} chatId={chatId} messageId={messageId} media={item} loadPreview={loadPlayback!}
              startTime={slide === timestampSlide ? startTime : undefined}
              loadMessageLink={slide === timestampSlide ? loadMessageLink : undefined} />
          : <PreviewCover key={item.fileId} chatId={chatId} messageId={messageId} cover={item} loadCover={loadCover!} />;
      }} />
    {album.caption && <p><bdi>{album.caption}</bdi></p>}
  </>;
}

export function PreviewCover({ chatId, messageId, cover, loadCover }: {
  chatId: string; messageId: string; cover: NonNullable<NonNullable<Message["linkPreview"]>["cover"]>;
  loadCover: NonNullable<ContextType<typeof LoadMessagePreviewCover>>;
}) {
  const load = useCallback((id: string, message: string, size?: PhotoSize) => size === "large"
    ? loadCover(id, message, cover.fileId, size) : loadCover(id, message, cover.fileId), [loadCover, cover.fileId]);
  return <PhotoPreview chatId={chatId} messageId={messageId} dimensions={cover} load={load} />;
}

function PreviewPlayer({ chatId, messageId, media, startTime, loadPreview, loadMessageLink, chapters, seekRequest }: {
  chatId: string; messageId: string; media: NonNullable<NonNullable<Message["linkPreview"]>["media"]>;
  startTime?: number; loadPreview: NonNullable<ContextType<typeof LoadMessagePreviewPlayback>>; loadMessageLink?: MessageLinkLoader;
  chapters?: readonly number[];
  seekRequest?: { time: number };
}) {
  const stream = useCallback((id: string, message: string) => loadPreview(id, message, media.fileId), [loadPreview, media.fileId]);
  return <MediaPlayer chatId={chatId} messageId={messageId} mime={media.mime} stream={stream}
    startTime={startTime ?? media.startTime} loop={media.loop} videoNote={media.videoNote} voiceNote={media.voiceNote}
    loadMessageLink={loadMessageLink} chapters={chapters} seekRequest={seekRequest} />;
}

function EmbeddedDocument({ block, chatId, messageId, load, stream, save }: {
  block: RichDocumentBlock;
  chatId: string;
  messageId: string;
  load?: MediaLoader;
  stream?: Parameters<typeof MessageBody>[0]["loadVideoStream"];
  save?: Parameters<typeof MessageBody>[0]["saveDocument"];
}) {
  const { document, reference: { index, fileId }, media } = block;
  const playlist = isRichAudioTrack(block);
  const playback = useCallback((_chat: string, _message: string, signal: AbortSignal) => {
    if (!load) return Promise.reject(new Error("Embedded media is unavailable."));
    return load(chatId, messageId, signal, undefined, { index, fileId });
  }, [chatId, messageId, load, index, fileId]);
  const openStream = useCallback(() => {
    if (!stream) return Promise.reject(new Error("Embedded media is unavailable."));
    return stream(chatId, messageId, { index, fileId });
  }, [chatId, messageId, stream, index, fileId]);

  const player = document.downloadable && document.playbackMime && load
    ? (
      <MediaPlayer chatId={chatId} messageId={embeddedPlaybackId(messageId, block.reference)} mime={document.playbackMime}
        load={playback} stream={stream && (media === "video" || media === "audio") && !document.approximateSize ? openStream : undefined}
        loop={block.loop} voiceNote={media === "voice"} queuePlayback={playlist} playlistControls={playlist} />
    ) : undefined;
  const controls = <>
    <DocumentButton document={document} player={player} save={document.downloadable && save
      ? () => save(chatId, messageId, { index, fileId }) : undefined} />
    {!block.reference.paid && <MarkdownDocumentPreview document={document} chatId={chatId} messageId={messageId} attachment={block.reference}
      save={document.downloadable && save ? () => save(chatId, messageId, { index, fileId }) : undefined} />}
  </>;
  return block.spoiler ? <VideoSpoiler animation={media === "gif"}>{controls}</VideoSpoiler> : controls;
}

function VideoSpoiler({ animation, children, onReveal }: { animation?: boolean; children: ReactNode; onReveal?: () => void }) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  return revealed ? <>{children}</> : <button type="button" className="mtg-action"
    onClick={() => { setRevealed(true); onReveal?.(); }}>{animation ? tr("Show GIF spoiler") : tr("Show video spoiler")}</button>;
}

function MediaCollection({ chatId, messageId, kind, actions }: {
  chatId: string; messageId: string; kind: MediaCollectionKind; actions: MediaCollectionActions;
}) {
  const { t: tr } = useTelegramLocale();
  const [saved, setSaved] = useState<boolean | null>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const sticker = kind === "sticker";

  async function read() {
    setBusy(true);
    setNotice("");
    try { setSaved(await actions.load(chatId, messageId, kind)); }
    catch { setNotice("Could not check the Telegram collection."); }
    finally { setBusy(false); }
  }

  async function change(expected: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const result = await actions.save(chatId, messageId, kind, !expected, expected);
      if (result === "saved") setSaved(!expected);
      else {
        setSaved(undefined);
        setNotice(result === "changed" ? "The Telegram collection changed. Check it again."
          : "Telegram did not confirm the collection change.");
      }
    } catch {
      setSaved(undefined);
      setNotice("Could not verify the collection change.");
    } finally { setBusy(false); }
  }

  return <div>
    {saved === undefined ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void read()}>
      {sticker ? tr("Sticker favorites") : tr("Saved GIFs collection")}
    </button> : saved === null ? <span>{tr("Collection action unavailable")}</span>
      : <button type="button" className="mtg-action" disabled={busy} onClick={() => void change(saved)}>
        {sticker ? saved ? tr("Remove from favorite stickers") : tr("Add to favorite stickers") : saved ? tr("Remove from saved GIFs") : tr("Save GIF")}
      </button>}
    {notice && <p role="alert">{tr(notice)}</p>}
  </div>;
}

function VoiceTranscript({ load }: { load: (signal: AbortSignal) => Promise<string> }) {
  const { t: tr } = useTelegramLocale();
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController>(undefined);
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = undefined;
  }, []);

  async function transcribe() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const result = await load(controller.signal);
      if (pending.current === controller) setText(result);
    } catch {
      if (pending.current === controller) setFailed(true);
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setLoading(false);
      }
    }
  }

  return <div className="mtg-voice-transcript">
    {loading ? <><p role="status">{tr("Transcribing on this Mac…")}</p>
      <button type="button" className="mtg-action" onClick={() => {
        pending.current?.abort();
        pending.current = undefined;
        setLoading(false);
      }}>{tr("Cancel transcription")}</button></> : text === undefined &&
      <button type="button" className="mtg-action" onClick={() => void transcribe()}>{tr("Transcribe locally")}</button>}
    {failed && <p role="alert">{tr("Could not transcribe this note on this Mac.")}</p>}
    {text !== undefined && <p>{text || tr("No speech detected.")}</p>}
  </div>;
}

export function PollFile({ media, slot, chatId, messageId, actions }: {
  media: Extract<PollMediaAttachment, { kind: "file" }>;
  slot: PollAttachmentReference["slot"];
  chatId: string;
  messageId: string;
  actions?: Partial<NonNullable<ContextType<typeof PollFileActions>>>;
}) {
  const { fileId, document, animation, startTime } = media;
  const play = actions?.play;
  const save = actions?.save;
  const stream = useCallback(() => play!(chatId, messageId, { slot, fileId }), [play, chatId, messageId, slot, fileId]);
  const mime = document.playbackMime;
  const player = play && mime && !document.approximateSize && <MediaPlayer chatId={chatId}
    messageId={`${messageId}:poll:${slot}:${fileId}`} mime={mime} loop={animation}
    startTime={startTime} durationSeconds={document.durationSeconds} stream={stream} />;
  return <DocumentButton document={document} player={player}
    save={save && (() => save(chatId, messageId, { slot, fileId }))} />;
}

const pollCountryNames = new Intl.DisplayNames(undefined, { type: "region" });
const pollRestrictionLabels = {
  country: "Voting is unavailable from your country.",
  membership: "Subscribe to this channel for at least 24 hours to vote.",
  scheduled: "Voting opens after the poll is published.",
  unavailable: "Telegram does not allow you to vote in this poll.",
};
const pollVoteCountFormat = new Intl.NumberFormat();
const pollCloseTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Poll({ poll, vote, stop, loadVoters, highlightedOption, copyLink, history, addOption, removeOption, renderMedia }: {
  renderMedia: (media: PollMediaAttachment, slot: PollAttachmentReference["slot"]) => ReactNode;
  history?: ReactNode;
  addOption?: Parameters<typeof AddPollOption>[0]["add"];
  removeOption?: (id: string, text: string) => ReactNode;
  highlightedOption?: string;
  copyLink?: (id: string, text: string) => ReactNode;
  poll: PollInfo; vote?: (choices: PollChoice[]) => Promise<boolean>; stop?: () => Promise<boolean>;
  loadVoters?: (choice: PollChoice, offset: number) => Promise<PollVoterPage | null>;
}) {
  const { t: tr } = useTelegramLocale();
  const { question, options, voters, multiple, quiz, canVote } = poll;
  const name = useId();
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [draft, setDraft] = useState<PollChoice[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [stopState, setStopState] = useState<"confirm" | "closed" | "error">();
  const closed = poll.closed || stopState === "closed";
  const chosen = options.filter((option) => option.chosen);
  const selection = draft ?? chosen;
  const interactive = vote && canVote && !closed;

  async function submit(choices: PollChoice[]) {
    if (!vote || busy || !canVote || closed) return;
    setBusy(true);
    setError(false);
    try {
      if (await vote(choices.map(({ index, id, text }) => ({ index, id, text })))) setDraft(undefined);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function endPoll() {
    if (!stop || closed || busy) return;
    setBusy(true);
    const confirmed = await stop().catch(() => false);
    setStopState(confirmed ? "closed" : "error");
    if (confirmed) setError(false);
    setBusy(false);
  }

  return <fieldset className="mtg-poll" disabled={busy}>
    <legend>{question}</legend>
    {poll.description && <p className="mtg-poll-description">{poll.description}</p>}
    {poll.media && renderMedia(poll.media, "question")}
    <p>{closed ? tr("Closed poll") : quiz ? tr("Quiz") : multiple ? tr("Multiple answers") : tr("Poll")}</p>
    {poll.closesAt !== undefined && !closed && <p>{tr("Closes ")}{pollCloseTime.format(poll.closesAt * 1000)}</p>}
    {poll.anonymous === false && <small>{tr("Votes are visible to participants")}</small>}
    {poll.membersOnly && <p>{tr("Only subscribers of at least 24 hours can vote.")}</p>}
    {poll.countryCodes && <p>{tr("Eligible countries: ")}{poll.countryCodes.map((code) => pollCountryNames.of(code) ?? code).join(", ")}</p>}
    {!closed && poll.voteRestriction && <p>{tr(pollRestrictionLabels[poll.voteRestriction])}</p>}
    <ul>{options.map((option) => {
      const { index, text, percentage, voterCount } = option;
      const media = option.media && renderMedia(option.media, index);
      const checked = selection.some((choice) => choice.index === index && choice.id === option.id && choice.text === text);
      const label = <>{text}{option.chosen && <small>{tr(" · Your choice")}</small>}{option.correct && <small>{tr(" · Correct answer")}</small>}</>;
      const highlighted = highlightedOption !== undefined && option.id === highlightedOption;
      return <li key={index} aria-current={highlighted ? "location" : undefined} tabIndex={highlighted ? -1 : undefined}>
        {interactive ? <label><input type={multiple ? "checkbox" : "radio"} name={name} checked={checked}
          onChange={() => setDraft(multiple ? checked ? selection.filter((choice) => choice.index !== index) : [...selection, option] : [option])} /> {label}</label> : <span>{label}</span>}
        {(percentage !== undefined || voterCount !== undefined) && <span className="mtg-poll-option-result">
          {percentage !== undefined && <span>{percentage}%</span>}
          {voterCount !== undefined && <span>{pollVoteCountFormat.format(voterCount)} {voterCount === 1 ? tr("vote") : tr("votes")}</span>}
        </span>}
        {percentage !== undefined && <div className="mtg-poll-result-track" aria-hidden="true">
          <span style={{ width: `${percentage}%` }} />
        </div>}
        {media && <div className="mtg-poll-option-media">{media}</div>}
        {option.id && copyLink?.(option.id, text)}
        {!closed && option.suggested && option.id && removeOption?.(option.id, text)}
        {poll.anonymous === false && poll.canGetVoters !== false && percentage !== undefined && loadVoters
          && <PollVoters key={JSON.stringify([option.id, text])} option={text}
            load={(offset) => loadVoters({ index, id: option.id, text }, offset)} />}
      </li>;
    })}</ul>
    {(poll.explanation || poll.explanationMedia) && <details onToggle={(event) => setExplanationOpen(event.currentTarget.open)}>
      <summary>{tr("Quiz explanation")}</summary>
      {poll.explanation && <p>{poll.explanation}</p>}
      {explanationOpen && poll.explanationMedia && renderMedia(poll.explanationMedia, "explanation")}
    </details>}
    {voters !== undefined && <small>{voters} {voters === 1 ? tr("voter") : tr("voters")}</small>}
    {interactive && <p>
      <button type="button" disabled={!draft?.length} onClick={() => void submit(selection)}>{tr("Vote")}</button>
      {chosen.length > 0 && <button type="button" onClick={() => void submit([])}>{tr("Retract vote")}</button>}
    </p>}
    {stop && !closed && (stopState === "confirm" ? <div>
      <p>{tr("End voting for everyone?")}</p>
      <button type="button" className="mtg-action" onClick={() => void endPoll()}>{tr("Confirm end poll")}</button>
      <button type="button" className="mtg-action" onClick={() => setStopState(undefined)}>{tr("Cancel")}</button>
    </div> : <button type="button" className="mtg-action" onClick={() => setStopState("confirm")}>{tr("End poll")}</button>)}
    {!closed && poll.canAddOption && addOption && <AddPollOption add={addOption} />}
    {history}
    {stopState === "error" && !closed && <p role="alert">{tr("Telegram did not confirm that the poll ended.")}</p>}
    {error && <p role="alert">{tr("Could not confirm the vote. Check the poll before trying again.")}</p>}
  </fieldset>;
}
