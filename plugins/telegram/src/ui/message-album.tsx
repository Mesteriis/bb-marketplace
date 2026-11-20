import { useTelegramLocale } from "./i18n/index.tsx";
import { useMemo, type ReactNode } from "react";
import type { Message } from "../core/demo.ts";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { MessageForward, type ForwardActions } from "./message-forward.tsx";
import { MessageSearchQuery, MessageText } from "./message-text.tsx";
import { AlbumMusicTracks } from "./music-playback.tsx";
import { OrderedPlaybackQueueProvider, isPlayableAlbumTrack } from "./note-playback-queue.tsx";

export function sharedAlbumCaption(messages: readonly Message[]) {
  if (messages.length < 2 || !messages[0]?.albumId) return;
  const captions = messages.flatMap((message) => {
    const text = message.photoCaption ?? message.document?.caption;
    return text?.trim() ? [{ message, text }] : [];
  });
  if (captions.length === 1) return captions[0];
}

export function sharedForwardedAlbum(messages: readonly Message[]) {
  const first = messages[0];
  if (messages.length < 2 || !first?.albumId || first.forwardedFrom === undefined) return;
  if (!sharedAlbumCaption(messages) && messages.some((message) => message.photoCaption?.trim() || message.document?.caption?.trim())) return;
  const compatible = messages.every((message) =>
    message.albumId === first.albumId && message.author === first.author && message.outgoing === first.outgoing &&
    message.forwardedFrom === first.forwardedFrom && message.forwardedPost?.chatId === first.forwardedPost?.chatId &&
    !message.photoSpoiler && !message.photoMotion && !message.videoSpoiler && !message.replyTo && !message.oneView &&
    !message.retained && !message.reactions && !message.pendingDelivery && !message.failedDelivery && !message.effectId &&
    (message.hasPhoto && !message.collectionKind || !message.animation && !message.videoNote &&
      !!message.document?.downloadable && !!message.document.posterSize && message.document.playbackMime?.startsWith("video/")));
  if (compatible) return first;
}

export function MediaAlbumBody({ caption, children, controls, searchQuery, audio, files, photoCount, mosaic, forwardedHeader }: {
  caption: ReturnType<typeof sharedAlbumCaption>;
  children: ReactNode;
  controls?: ReactNode;
  searchQuery?: string;
  audio?: boolean;
  files?: boolean;
  photoCount?: number;
  mosaic?: boolean;
  forwardedHeader?: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const text = caption && <div className="mtg-album-caption">
    <MessageSearchQuery.Provider value={searchQuery}>
      <MessageText text={caption.text} quoteSource={caption.message.canQuote ? caption.message.id : undefined} links={caption.message.links} styles={caption.message.styles} customEmoji={caption.message.customEmoji} />
    </MessageSearchQuery.Provider>
  </div>;
  return <div className="mtg-album-body" data-context-object={controls ? true : undefined}>
    {forwardedHeader && <header className="mtg-album-header">{forwardedHeader}</header>}
    {caption?.message.captionAboveMedia && text}
    <ol data-audio-album={audio || undefined} data-file-album={files || undefined} data-photo-album={photoCount}
      data-photo-mosaic={mosaic || undefined} data-media-mosaic={forwardedHeader ? true : undefined}
      aria-label={audio ? tr("Audio album") : tr("Media album")}>{children}</ol>
    {caption && !caption.message.captionAboveMedia && text}
    {controls && <div className="mtg-album-controls" data-context-commands>{controls}</div>}
  </div>;
}

export function MessageAlbum({ first, caption, children, messages, chatId, forward, loadMessageLink, searchQuery, forwardedHeader }: {
  first: Message;
  caption: ReturnType<typeof sharedAlbumCaption>;
  children: ReactNode;
  messages: readonly Message[];
  chatId: string;
  forward?: ForwardActions;
  loadMessageLink?: MessageLinkLoader;
  searchQuery?: string;
  forwardedHeader?: ReactNode;
}) {
  const album = first.albumId && messages.length >= 2 && messages.length <= 10
    && messages.every(({ id, pendingDelivery, retained }) => !pendingDelivery && !retained && /^[1-9]\d{0,15}$/.test(id))
    ? { id: first.albumId, members: messages.map(({ id }) => id) } : undefined;
  const audio = messages.length > 0 && messages.every(({ document, voiceNote }) => !voiceNote
    && (document?.audioTrack || document?.playbackMime?.startsWith("audio/")));
  const files = messages.length > 0 && messages.every(({ document, hasPhoto, voiceNote, videoNote, animation }) =>
    document && !hasPhoto && !voiceNote && !videoNote && !animation && !document.playbackMime?.startsWith("video/"));
  const photoCount = messages.length > 1 && messages.every(({ hasPhoto, oneView, collectionKind }) => hasPhoto && !oneView && !collectionKind)
    ? messages.length : undefined;
  const mosaic = !!photoCount && (!!forwardedHeader || !!(caption || messages.every(({ photoCaption }) => !photoCaption?.trim()))
    && messages.every((message) => !message.photoSpoiler && !message.photoMotion && !message.replyTo && !message.forwardedFrom &&
      !message.retained && !message.reactions && !message.pendingDelivery && !message.failedDelivery && !message.effectId));
  const tracks = useMemo(() => messages.filter(isPlayableAlbumTrack), [messages]);
  const trackIds = useMemo(() => tracks.map(({ id }) => id), [tracks]);
  const rows = audio
    ? <AlbumMusicTracks.Provider value={tracks}>
        <OrderedPlaybackQueueProvider ids={trackIds} enabled={trackIds.length > 1} kind="audioAlbum">{children}</OrderedPlaybackQueueProvider>
      </AlbumMusicTracks.Provider>
    : children;
  return <li className={`mtg-album${first.outgoing ? " mtg-outgoing" : ""}`}>
    <MediaAlbumBody caption={caption} searchQuery={searchQuery} audio={audio} files={files} photoCount={photoCount} mosaic={mosaic} forwardedHeader={forwardedHeader}
      controls={album && (loadMessageLink || forward) && <>
      {loadMessageLink && album && <CopyTelegramLink key={`${chatId}:${first.id}`} chatId={chatId} messageId={first.id}
        load={loadMessageLink} target={{ kind: "album", id: album.id }} />}
      {forward && album && <MessageForward key={`${chatId}:${album.members.join(",")}`} chatId={chatId}
        messageId={first.id} actions={forward} album={album}
        hasCaption={messages.some((item) => !!(item.photoCaption || item.document?.caption))} />}
    </>}>{rows}</MediaAlbumBody>
  </li>;
}
