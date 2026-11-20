import { Captions, Copy, MessageSquare, Pause, Play, Video, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { VoiceTranscriptData } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";
import { transcriptionLimit } from "../core/transcription-limits.ts";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import { DocumentButton } from "./document-button.tsx";
import { QueueDownloadButton } from "./download-queue.tsx";
import { useTelegramLocale } from "./i18n/index.tsx";
import { LoadMessagePoster, NotePlaybackReceipt, type MessageContent } from "./message-content.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { MediaPlayer, type MediaLoader, type SpeechPlayback, type VideoStreamLoader } from "./media-player.tsx";
import { photoSource } from "./photo-preview.tsx";
import { formatPlaybackTime as time } from "./video-seek-preview.tsx";
import { useVisibleThumbnail } from "./visible-thumbnail.ts";

export function isSharedSpeechNote(message: Message) {
  return !!(message.voiceNote || message.videoNote) && !!message.document?.downloadable
    && !!message.document.playbackMime && /^[1-9]\d{0,15}$/.test(message.id)
    && !message.oneView && !message.retained && !message.pendingDelivery && !message.videoSpoiler;
}

type Transcribe = NonNullable<Parameters<typeof MessageContent>[0]["transcribeVoice"]>;

export function SharedSpeechNote({ chatId, chat, message, loadAvatar, loadMedia, stream, transcribe, save, inspect, close, source, selected, checkbox, reader }: {
  chatId: string;
  chat?: Chat;
  message: Message;
  loadAvatar?: AvatarLoader;
  loadMedia?: MediaLoader;
  stream?: VideoStreamLoader;
  transcribe?: Transcribe;
  save?: (chatId: string, messageId: string) => Promise<boolean>;
  inspect: () => void;
  close: () => void;
  source?: () => void;
  selected: boolean;
  checkbox: ReactNode;
  reader: HTMLElement | null;
}) {
  const { t: tr } = useTelegramLocale();
  const receipt = useContext(NotePlaybackReceipt);
  const loadPoster = useContext(LoadMessagePoster);
  const portrait = useRef<HTMLSpanElement>(null);
  const reporting = useRef(false);
  const [played, setPlayed] = useState(false);
  const doc = message.document!;
  const video = !!message.videoNote;
  const { photo, discard } = useVisibleThumbnail(portrait, chatId, message.id, video && doc.posterSize ? loadPoster : undefined);
  const waveform = video ? undefined : doc.waveform;
  const unread = !message.outgoing && message.notePlayed === false && !played;
  const eligible = !message.restricted && !!transcribe && !transcriptionLimit(video ? "video" : "voice", doc.durationSeconds, doc.sizeBytes);
  const kind = tr(video ? "Video message" : "Voice message");
  return <li className="mtg-speech-row" data-selected={selected || undefined} data-video-note={video || undefined} data-context-object>
    {checkbox}
    <div className="mtg-speech-row-heading">
      <MessageAuthor chat={chat} message={message} load={loadAvatar} />
      <span className="mtg-speech-date"><MessageTimestamp message={message} /></span>
      {unread && <span className="mtg-speech-unplayed" role="img" aria-label={tr("Unplayed note")} />}
      <button type="button" className="mtg-speech-icon" data-note-inspect data-search-result={message.id}
        title={tr("Open note details")} aria-label={tr("Open note details for {0}", [message.author])}
        aria-expanded={selected} onClick={inspect}><Captions size={17} /></button>
    </div>
    <MediaPlayer chatId={chatId} messageId={message.id} playbackFileId={doc.playbackFileId}
      mime={doc.playbackMime} voiceNote={!video} videoNote={video} durationSeconds={doc.durationSeconds}
      load={loadMedia} stream={video && !doc.approximateSize ? stream : undefined}
      onNotePlaying={unread && receipt ? () => {
        if (reporting.current) return;
        reporting.current = true;
        void receipt(chatId, message.id).then((ok) => { if (ok) setPlayed(true); }, () => {}).finally(() => { reporting.current = false; });
      } : undefined}
      speechControls={(playback) => <>
        <div className="mtg-speech-row-transport">
          {video && !playback.ready && <span className="mtg-speech-poster" ref={portrait}>
            {photo ? <img src={photoSource(photo)} alt="" onError={discard} /> : <Video size={19} aria-hidden="true" />}
          </span>}
          <SpeechTransport playback={playback} waveform={waveform} kind={kind} />
        </div>
        {playback.status && <div className="mtg-speech-status">{playback.status}</div>}
        {selected && reader && createPortal(<SpeechReader key={message.id} playback={playback} waveform={waveform}
          message={message} chat={chat} loadAvatar={loadAvatar} kind={kind} close={close} source={source}
          load={eligible ? (signal) => transcribe!(chatId, message.id, signal, true) : undefined}
          fileActions={!message.restricted && <>
            {save && <DocumentButton document={doc} compactVideo save={() => save(chatId, message.id)} />}
            <QueueDownloadButton chatId={chatId} messageId={message.id} />
          </>} />, reader)}
      </>} />
  </li>;
}

function SpeechTransport({ playback, waveform, kind, reader }: {
  playback: SpeechPlayback; waveform?: readonly number[]; kind: string; reader?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const { position, duration } = playback;
  const fraction = duration ? Math.min(1, position / duration) : 0;
  const label = tr(playback.playing ? "Pause audio" : kind === tr("Video message") ? "Play video message" : "Play voice message");
  return <div className="mtg-speech-transport">
    <button type="button" className="mtg-speech-icon mtg-speech-play" aria-label={label} title={label} onClick={playback.toggle}>
      {playback.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
    </button>
    {waveform?.length ? <label className="mtg-speech-wave">
      <span aria-hidden="true">{waveform.map((peak, index) =>
        <i key={index} data-played={(index + .5) / waveform.length <= fraction || undefined}
          style={{ height: `${Math.max(12, peak * 100 / 31)}%` }} />)}</span>
      <input type="range" aria-label={tr("Voice note position")} min={0} max={duration || 1} step={.1}
        disabled={!duration} value={Math.min(position, duration)} onInput={(event) => playback.seek(Number(event.currentTarget.value))} />
    </label> : playback.ready ? <input className="mtg-speech-linear" type="range" aria-label={tr("Voice note position")}
      min={0} max={duration || 1} step={.1} value={Math.min(position, duration)}
      onInput={(event) => playback.seek(Number(event.currentTarget.value))} />
      : <span className="mtg-speech-kind">{kind}</span>}
    <span className="mtg-speech-clock">{(position > 0 || playback.playing) && `${time(position)} / `}{time(duration)}</span>
    {reader && <select aria-label={tr("Playback speed")} value={playback.speed} disabled={!playback.ready}
      onChange={(event) => playback.rate(Number(event.currentTarget.value))}>
      {[.5,.75,1,1.25,1.5,1.75,2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
    </select>}
  </div>;
}

function SpeechReader({ playback, waveform, message, chat, loadAvatar, kind, close, source, load, fileActions }: {
  playback: SpeechPlayback; waveform?: readonly number[]; message: Message; chat?: Chat; loadAvatar?: AvatarLoader;
  kind: string; close: () => void; source?: () => void; load?: (signal: AbortSignal) => Promise<string | VoiceTranscriptData>;
  fileActions: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const header = useRef<HTMLElement>(null);
  const request = useRef<AbortController>(undefined);
  const [status, setStatus] = useState<"loading" | "failed">();
  const [result, setResult] = useState<VoiceTranscriptData>();
  const [copied, setCopied] = useState<boolean>();
  useEffect(() => {
    header.current?.focus({ preventScroll: true });
    return () => { request.current?.abort(); };
  }, []);

  async function transcribe() {
    if (!load || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    try {
      const data = await load(controller.signal);
      if (controller.signal.aborted) return;
      setResult(typeof data === "string" ? { text: data, segments: [] } : data);
      setStatus(undefined);
    } catch {
      if (!controller.signal.aborted) setStatus("failed");
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }
  const next = result?.segments.findIndex(({ start }) => start > playback.position);
  const active = result && (next === -1 ? result.segments.length - 1 : (next ?? 0) - 1);
  return <>
    <header ref={header} tabIndex={-1} className="mtg-speech-reader-header">
      <div><MessageAuthor chat={chat} message={message} load={loadAvatar} /><span className="mtg-speech-date"><MessageTimestamp message={message} /></span></div>
      {result?.text && navigator.clipboard?.writeText && <button type="button" className="mtg-speech-icon"
        title={tr("Copy transcript")} aria-label={tr("Copy transcript")} onClick={async () => {
          try { await navigator.clipboard.writeText(result.text); setCopied(true); }
          catch { setCopied(false); }
        }}><Copy size={17} /></button>}
      {source && <button type="button" className="mtg-speech-icon" title={tr("Open source message")}
        aria-label={tr("Open source message")} onClick={source}><MessageSquare size={17} /></button>}
      <button type="button" className="mtg-speech-icon" title={tr("Close note details")} aria-label={tr("Close note details")}
        onClick={close}><X size={19} /></button>
    </header>
    <SpeechTransport playback={playback} waveform={waveform} kind={kind} reader />
    <div className="mtg-speech-transcript">
      <h3>{tr("Transcript")}</h3>
      {status === "loading" && <p role="status">{tr("Transcribing on this Mac…")}</p>}
      {status === "loading" && <button type="button" className="mtg-action" onClick={() => {
        request.current?.abort();
        request.current = undefined;
        setStatus(undefined);
      }}>{tr("Cancel transcription")}</button>}
      {status === "failed" && <p role="alert">{tr("Could not transcribe this note on this Mac.")}</p>}
      {load && !result && status !== "loading" && <button type="button" className="mtg-action"
        onClick={() => void transcribe()}>{tr("Transcribe locally")}</button>}
      {!load && <p>{tr("Transcription is unavailable for this note.")}</p>}
      {copied !== undefined && <p role="status">{tr(copied ? "Transcript copied." : "Could not copy the transcript.")}</p>}
      {result && (result.segments.length ? <ol>{result.segments.map(({ start, text }, index) =>
        <li key={index} data-active={active === index && (playback.playing || playback.position > 0) || undefined}>
          <button type="button" onClick={() => playback.seek(start)} aria-label={tr("Jump to {0}", [time(start)])}>{time(start)}</button>
          <span>{text}</span>
        </li>)}</ol> : <p>{result.text || tr("No speech detected.")}</p>)}
    </div>
    {fileActions && <details className="mtg-speech-file-actions">
      <summary>{tr("File actions")}</summary>{fileActions}
    </details>}
  </>;
}
