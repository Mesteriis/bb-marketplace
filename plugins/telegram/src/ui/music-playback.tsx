import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ContextType, type ReactNode, type Dispatch, type SetStateAction } from "react";
import type { DocumentInfo } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { MediaPlayer, PlaybackHistory, type MediaLoader, type VideoStreamLoader } from "./media-player.tsx";
import { isPlayableAlbumTrack, PlaybackQueue } from "./note-playback-queue.tsx";
import { canDecodeAudioWaveform } from "./audio-waveform.ts";
import { QueueDownloadButton } from "./download-queue.tsx";
import { AddProfileAudioButton } from "./profile-audio.tsx";
import { Download } from "lucide-react";
import { isPlainKey } from "./composer-keys.ts";

type MusicTrack = {
  chatId: string;
  messageId: string;
  topicId?: number;
  document: DocumentInfo;
  load: MediaLoader;
  stream?: VideoStreamLoader;
  startTime?: number;
  profileAudioFileId?: number;
};

type MusicSource = Pick<MusicTrack, "chatId" | "messageId" | "topicId">;
type OpenMusicSource = (track: MusicSource, signal: AbortSignal) => Promise<boolean>;
type MusicPageSource = {
  cursor: string;
  load: (cursor: string) => Promise<{ tracks: MusicTrack[]; before: string | null }>;
};

type SharedMusicViewer = {
  opener: HTMLButtonElement;
  save?: (chatId: string, messageId: string) => Promise<boolean>;
  openSource?: OpenMusicSource;
};

type Selection = {
  queueId: symbol;
  tracks: readonly MusicTrack[];
  index: number;
  playRequest: { restart: boolean };
  shuffledOrder?: readonly number[];
  repeat?: "track" | "album";
  shared?: true;
  viewer?: SharedMusicViewer;
  viewerOpen?: boolean;
  more?: MusicPageSource;
};

function shuffle(positions: number[]) {
  for (let position = positions.length - 1; position > 0; position -= 1) {
    const swap = Math.floor(Math.random() * (position + 1));
    [positions[position], positions[swap]] = [positions[swap]!, positions[position]!];
  }
  return positions;
}

export function musicTrack(message: Message, chatId: string, load: MediaLoader, stream?: MusicTrack["stream"], startTime?: number) {
  if (!message.document || !isPlayableAlbumTrack(message)) return;
  return { chatId, messageId: message.id, topicId: message.forumTopicId, document: message.document, load, startTime, profileAudioFileId: message.profileAudioFileId,
    stream: message.document.approximateSize ? undefined : stream };
}

export const AlbumMusicTracks = createContext<readonly Message[] | undefined>(undefined);
export const PlayMusic = createContext<((tracks: readonly MusicTrack[], index: number,
  shared?: { more?: MusicPageSource; viewer?: SharedMusicViewer }) => void) | undefined>(undefined);
export const PlaySharedMusic = createContext<((id: string) => void) | undefined>(undefined);
const MusicSelection = createContext<{
  selection?: Selection;
  select: Dispatch<SetStateAction<Selection | undefined>>;
} | undefined>(undefined);

export function MusicPlaybackProvider({ children }: { children: ReactNode }) {
  const [selection, select] = useState<Selection>();
  const play = useCallback<NonNullable<ContextType<typeof PlayMusic>>>((tracks, index, shared) => {
    const track = tracks[index];
    if (!track) return;
    select((current) => {
      const active = current?.tracks[current.index];
      if (shared?.viewer && current?.viewer && active?.chatId === track.chatId && active.messageId === track.messageId
        && active.document.playbackFileId === track.document.playbackFileId) {
        return { ...current, viewer: shared.viewer, viewerOpen: true };
      }
      return { queueId: Symbol(), tracks, index, playRequest: { restart: false },
      ...(shared && { shared: true, more: shared.more, viewer: shared.viewer, viewerOpen: !!shared.viewer }) };
    });
  }, []);
  const value = useMemo(() => ({ selection, select }), [selection]);
  return <PlayMusic.Provider value={play}>
    <MusicSelection.Provider value={value}>{children}</MusicSelection.Provider>
  </PlayMusic.Provider>;
}

export function MusicPlayerPanel({ openSource }: { openSource?: OpenMusicSource }) {
  const { t: tr } = useTelegramLocale();
  const panel = useRef<HTMLElement>(null);
  const playback = useContext(PlaybackHistory);
  const player = useContext(MusicSelection);
  const selection = player?.selection;
  const track = selection?.tracks[selection.index];
  const select = player?.select;
  const queueId = selection?.queueId;
  const request = useRef<{ queueId: symbol; controller: AbortController;
    resume?: { playRequest: Selection["playRequest"]; activity?: number } }>(undefined);
  const [paging, setPaging] = useState<{ queueId: symbol; state: "loading" | "failed"; playNext: boolean }>();
  useEffect(() => () => {
    if (request.current?.queueId === queueId) request.current?.controller.abort();
  }, [queueId]);
  const loadPage = useCallback(async (current: Selection, source: MusicPageSource, playNext: boolean) => {
    if (!select) return;
    const resume = playNext ? { playRequest: current.playRequest, activity: playback?.activity } : undefined;
    if (request.current && !request.current.controller.signal.aborted) {
      if (request.current.queueId === current.queueId) {
        if (resume) request.current.resume = resume;
        return;
      }
      request.current.controller.abort();
    }
    const pending = { queueId: current.queueId, controller: new AbortController(), resume };
    request.current = pending;
    setPaging({ queueId: current.queueId, state: "loading", playNext });
    const ids = new Set(current.tracks.map(({ messageId }) => messageId));
    let cursor: string | null = source.cursor;
    try {
      while (cursor !== null && !pending.controller.signal.aborted) {
        const page = await source.load(cursor);
        if (pending.controller.signal.aborted) return;
        const added = page.tracks.filter(({ messageId }) => {
          if (ids.has(messageId)) return false;
          ids.add(messageId);
          return true;
        });
        // Chat search cursors are positive message IDs and always move toward older results.
        cursor = page.before !== null && Number(page.before) < Number(cursor) ? page.before : null;
        if (!added.length && cursor !== null) continue;
        const more = cursor === null ? undefined : { load: source.load, cursor };
        const tracks = [...current.tracks, ...added];
        const appended = shuffle(added.map((_, offset) => current.tracks.length + offset));
        const resume = pending.resume?.activity === playback?.activity ? pending.resume : undefined;
        select((latest) => {
          if (!latest || latest.queueId !== current.queueId || latest.more !== source) return latest;
          const order = latest.shuffledOrder && [...latest.shuffledOrder, ...appended];
          const next = added.length ? order?.[current.tracks.length] ?? current.tracks.length
            : latest.repeat === "album" ? order?.[0] ?? 0 : undefined;
          const advancePlayback = next !== undefined && resume?.playRequest === latest.playRequest;
          return { ...latest, tracks, more, shuffledOrder: order,
            ...(advancePlayback && { index: next, playRequest: { restart: true } }) };
        });
        break;
      }
    } catch {
      if (!pending.controller.signal.aborted) setPaging({ queueId: current.queueId, state: "failed", playNext: !!pending.resume });
    } finally {
      if (request.current === pending) request.current = undefined;
      setPaging((status) => status?.queueId === current.queueId && status.state === "loading" ? undefined : status);
    }
  }, [playback, select]);
  const ordinal = selection?.shuffledOrder?.indexOf(selection.index) ?? selection?.index ?? 0;
  const playIndex = useCallback((index: number) => {
    if (!select || !selection || !selection.tracks[index] || index === selection.index) return false;
    select((current) => current === selection ? { ...current, index, playRequest: { restart: true } } : current);
    return true;
  }, [selection, select]);
  const queue = useMemo(() => {
    if (!selection || !track) return;
    const { tracks, repeat, shuffledOrder, more } = selection;
    const { messageId } = track;
    const length = tracks.length;
    function neighbor(id: string, offset: -1 | 1) {
      if (id !== messageId || length < 2) return;
      const position = ordinal + offset;
      const next = repeat === "album" && !more ? (position + length) % length : position;
      if (next < 0 || next >= length) return;
      return shuffledOrder?.[next] ?? next;
    }
    const atPageEdge = (id: string, offset: -1 | 1) => id === messageId && offset === 1 && ordinal === length - 1;
    return {
      kind: "music" as const,
      hasNeighbor: (id: string, offset: -1 | 1) => neighbor(id, offset) !== undefined || !!more && atPageEdge(id, offset),
      move(id: string, offset: -1 | 1) {
        const index = neighbor(id, offset);
        if (index === undefined) {
          if (more && atPageEdge(id, offset)) void loadPage(selection, more, true);
          return false;
        }
        return playIndex(index);
      },
    };
  }, [selection, track, ordinal, loadPage, playIndex]);
  if (!track || !selection || !select || !queue) return null;
  const album = selection.tracks.length > 1 || !!selection.more;
  const pageStatus = paging?.queueId === selection.queueId ? paging : undefined;
  const loading = pageStatus?.state === "loading";
  const more = selection.more;
  function closeViewer(restoreFocus = true) {
    select?.((current) => current && current.queueId === queueId ? { ...current, viewerOpen: false } : current);
    if (restoreFocus) requestAnimationFrame(() => {
      const opener = selection?.viewer?.opener;
      (opener?.isConnected ? opener : panel.current?.querySelector<HTMLButtonElement>(".mtg-audio-mini-title"))
        ?.focus({ preventScroll: true });
    });
  }
  const queueSettings = <>
    <div className="mtg-music-modes">
      {album && <button type="button" className="mtg-action" disabled={loading} aria-pressed={!!selection.shuffledOrder} onClick={() => {
        const remaining = selection.tracks.map((_, index) => index).filter((index) => index !== selection.index);
        const shuffledOrder = selection.shuffledOrder ? undefined : [selection.index, ...shuffle(remaining)];
        select((current) => current === selection ? { ...selection, shuffledOrder } : current);
      }}>{tr("Shuffle")}</button>}
      <label>{tr("Repeat ")}<select value={selection.repeat ?? "off"} disabled={loading} onChange={(event) => {
        const value = event.currentTarget.value;
        const repeat = value === "track" || (album && value === "album") ? value : undefined;
        select((current) => current === selection ? { ...selection, repeat } : current);
      }}>
        <option value="off">{tr("Off")}</option>
        <option value="track">{tr("Track")}</option>
        {(album || selection.repeat === "album") && <option value="album">{selection.shared ? tr("Queue") : tr("Album")}</option>}
      </select></label>
    </div>
    {(album || selection.shared) && <MusicQueueList selection={selection} playIndex={playIndex}
      loading={loading} loadMore={more && (() => void loadPage(selection, more, false))} />}
    {loading && <span role="status">{pageStatus.playNext ? tr("Finding the next track…") : tr("Loading older tracks…")}</span>}
    {pageStatus?.state === "failed" && <span role="alert">{pageStatus.playNext
      ? tr("Could not find the next track. Use Next track to retry.")
      : tr("Could not load older tracks. Try again.")}</span>}
  </>;
  return <section ref={panel} className="mtg-music-panel" data-audio-compact={!!selection.viewer || undefined}
    data-audio-viewer-open={selection.viewerOpen || undefined} aria-label={tr("Telegram music player")}>
    <MusicTrackPanel key={`${track.chatId}:${track.messageId}:${track.document.playbackFileId ?? ""}`} track={track} selection={selection} queue={queue}
      ordinal={ordinal} playlistControls={album} close={() => select(undefined)} closeViewer={closeViewer}
      reopen={(opener) => select((current) => current?.viewer && { ...current, viewer: { ...current.viewer, opener }, viewerOpen: true })}
      openSource={openSource ?? selection.viewer?.openSource} queueSettings={selection.viewer && queueSettings} />
    {!selection.viewer && queueSettings}
  </section>;
}

function MusicQueueList({ selection, playIndex, loading, loadMore }: {
  selection: Selection;
  playIndex: (index: number) => boolean;
  loading: boolean;
  loadMore?: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const order = selection.shuffledOrder ?? selection.tracks.map((_, index) => index);
  return <details className="mtg-music-queue" onToggle={(event) => setOpen(event.currentTarget.open)}
    onKeyDown={(event) => {
      if (!event.currentTarget.open || !isPlainKey(event, "Escape")) return;
      event.preventDefault();
      event.currentTarget.open = false;
      summary.current?.focus();
    }}>
    <summary ref={summary}>{tr("Queue")}</summary>
    {open && <>
      <ol aria-label={tr("Music queue")}>
        {order.map((index) => {
          const { chatId, messageId, document } = selection.tracks[index]!;
          return <li key={`${chatId}:${messageId}`}>
            <button type="button" className="mtg-action" aria-current={index === selection.index ? "true" : undefined}
              onClick={() => playIndex(index)}>
              <bdi>{document.audioTrack?.title ?? document.name}</bdi>
              {document.audioTrack?.artist && <small><bdi>{document.audioTrack.artist}</bdi></small>}
            </button>
          </li>;
        })}
      </ol>
      {selection.shared && <button type="button" className="mtg-action" aria-disabled={!loadMore || loading}
        onClick={() => { if (!loading) loadMore?.(); }}>{loadMore ? tr("Load older tracks") : tr("All tracks loaded")}</button>}
    </>}
  </details>;
}

function MusicTrackPanel({ track, selection, queue, ordinal, playlistControls, close, closeViewer, reopen, openSource, queueSettings }: {
  track: MusicTrack;
  selection: Selection;
  queue: NonNullable<ContextType<typeof PlaybackQueue>>;
  ordinal: number;
  playlistControls: boolean;
  close: () => void;
  closeViewer: (restoreFocus?: boolean) => void;
  reopen: (opener: HTMLButtonElement) => void;
  openSource?: OpenMusicSource;
  queueSettings?: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [source, setSource] = useState<"opening" | "unavailable">();
  const sourceRequest = useRef<AbortController>(undefined);
  useEffect(() => () => sourceRequest.current?.abort(), []);
  const { document } = track;
  const title = document.audioTrack?.title ?? document.name;
  const artist = document.audioTrack?.artist;
  const [download, setDownload] = useState<"busy" | "failed">();
  const save = selection.viewer?.save;
  const viewerOpen = selection.viewerOpen;
  const decodeWaveform = !!selection.viewer && !document.approximateSize &&
    canDecodeAudioWaveform(document.sizeBytes, document.durationSeconds);
  const sourceAction = openSource && <>
    <button type="button" className="mtg-action" disabled={source === "opening"} onClick={() => {
      sourceRequest.current?.abort();
      const controller = new AbortController();
      sourceRequest.current = controller;
      setSource("opening");
      void openSource(track, controller.signal).catch(() => false).then((found) => {
        if (controller.signal.aborted) return;
        setSource(found ? undefined : "unavailable");
        if (found && viewerOpen) closeViewer(false);
      });
    }}>{tr("Open source message")}</button>
    {source === "unavailable" && <p role="status">{tr("The source message is unavailable.")}</p>}
  </>;
  return <>
    {!selection.viewer && <div className="mtg-music-track-info">
      <strong><bdi>{title}</bdi></strong>{artist && <p><bdi>{artist}</bdi></p>}
      {selection.tracks.length > 1 && <small>{ordinal + 1} / {selection.tracks.length}{selection.more ? "+" : ""}</small>}
      {sourceAction}
    </div>}
    <PlaybackQueue.Provider value={queue}>
      <MediaPlayer chatId={track.chatId} messageId={track.messageId} playbackFileId={document.playbackFileId} mime={document.playbackMime}
        load={track.load} stream={decodeWaveform ? undefined : track.stream} decodeWaveform={decodeWaveform} compactAudio={selection.viewer && { title, artist, expand: reopen }} startTime={track.startTime} durationSeconds={document.durationSeconds}
        audioMetadata={{ title, artist }} queuePlayback playlistControls={playlistControls}
        repeatTrack={selection.repeat === "track" || selection.repeat === "album" && !playlistControls}
        playRequest={selection.playRequest} onClose={close}
        audioOverlay={viewerOpen ? {
          title, artist, close: closeViewer,
          actions: save && <button type="button" className="mtg-audio-icon" title={tr("Download")} aria-label={tr("Download")}
            disabled={download === "busy"} onClick={async () => {
              setDownload("busy");
              try { setDownload(await save(track.chatId, track.messageId) ? undefined : "failed"); }
              catch { setDownload("failed"); }
            }}><Download size={19} /></button>,
          notice: download === "busy" ? <span role="status">{tr("Downloading")}</span>
            : download === "failed" ? <span role="alert">{tr("Could not download this document.")}</span> : undefined,
          details: <>
            <p><bdi>{document.name}</bdi></p>
            {sourceAction}
            {queueSettings}
            <QueueDownloadButton chatId={track.chatId} messageId={track.messageId} />
            {track.profileAudioFileId !== undefined && <AddProfileAudioButton id={track.chatId}
              messageId={track.messageId} fileId={track.profileAudioFileId} name={document.name} />}
          </>,
        } : undefined} />
    </PlaybackQueue.Provider>
  </>;
}
