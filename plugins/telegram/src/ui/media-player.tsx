import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { PlaybackMime } from "../core/contract.ts";

export type MediaLoader = (chatId: string, messageId: string, signal: AbortSignal, oneView?: true) => Promise<Blob>;

const playbackHistoryLimit = 128;
const PlaybackHistory = createContext<Map<string, number> | null>(null);

export function PlaybackHistoryProvider({ children }: { children: ReactNode }) {
  const [positions] = useState(() => new Map<string, number>());
  return <PlaybackHistory.Provider value={positions}>{children}</PlaybackHistory.Provider>;
}

export function MediaPlayer({ chatId, messageId, mime, oneView, saved, load, stream, loop, videoNote }: {
  chatId: string;
  messageId: string;
  mime?: PlaybackMime;
  oneView?: "photo" | "video";
  saved?: boolean;
  loop?: boolean;
  videoNote?: boolean;
  load: MediaLoader;
  stream?: (chatId: string, messageId: string) => Promise<string>;
}) {
  const [opened, setOpened] = useState(false);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const resumeAt = useRef(0);
  const playbackHistory = useContext(PlaybackHistory);
  const playbackKey = `${chatId}:${messageId}`;
  const player = useRef<HTMLMediaElement>(null);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const image = oneView === "photo" || mime?.startsWith("image/");
  const audio = mime?.startsWith("audio/");
  const adjustableSpeed = !image && !loop && !oneView;
  const attach = useCallback((element: HTMLMediaElement | null) => {
    const media = player.current;
    if (!element && adjustableSpeed && media && Number.isFinite(media.duration)) {
      const time = !media.ended && Number.isFinite(media.currentTime) && media.currentTime < media.duration
        ? media.currentTime : 0;
      resumeAt.current = time;
      if (playbackHistory) {
        playbackHistory.delete(playbackKey);
        if (time > 0) {
          playbackHistory.set(playbackKey, time);
          if (playbackHistory.size > playbackHistoryLimit) {
            playbackHistory.delete(playbackHistory.keys().next().value!);
          }
        }
      }
    }
    player.current = element;
  }, [adjustableSpeed, playbackHistory, playbackKey]);
  const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  if (!playbackRates.includes(speed)) playbackRates.push(speed);
  playbackRates.sort((a, b) => a - b);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    let url: string | undefined;
    if (mime?.startsWith("video/") && stream) {
      void stream(chatId, messageId).then((url) => {
        if (!controller.signal.aborted) setSrc(url);
      }).catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
      return () => controller.abort();
    }
    const pending = oneView ? load(chatId, messageId, controller.signal, true) : load(chatId, messageId, controller.signal);
    void pending.then((data) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(mime ? data.slice(0, data.size, mime) : data);
      setSrc(url);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [chatId, messageId, mime, oneView, load, opened, stream]);

  useEffect(() => {
    if (player.current) player.current.playbackRate = speed;
  }, [src, speed]);

  function syncPlaybackRate(event: SyntheticEvent<HTMLMediaElement>) {
    const rate = event.currentTarget.playbackRate;
    if (adjustableSpeed && Number.isFinite(rate) && rate > 0) setSpeed(rate);
  }

  function restorePosition(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    const time = playbackHistory ? playbackHistory.get(playbackKey) : resumeAt.current;
    if (!adjustableSpeed || !time || !Number.isFinite(media.duration) || time >= media.duration) return;
    media.currentTime = time;
    if (videoNote) setPosition(time);
  }

  function closePlayer() {
    setOpened(false);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setSrc(undefined);
    setFailed(false);
  }

  function toggleVideo() {
    const element = player.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setFailed(true));
    else element.pause();
  }

  return <div className="mtg-media-player">
    {opened ? <>
      {!src && !failed && <p role="status">Loading Telegram media…</p>}
      {failed && <p role="alert">{oneView ? "Could not open this media. Close and try again." : "Could not play this file here. Try downloading it."}</p>}
      {src && !failed && (image
        ? <img alt={oneView ? "Telegram one-view photo" : "Telegram image"} src={src} onError={() => setFailed(true)} />
        : audio
        ? <audio ref={attach} aria-label="Telegram audio" controls src={src} onRateChange={syncPlaybackRate} onLoadedMetadata={restorePosition} onError={() => setFailed(true)} />
        : <video ref={attach} aria-label={videoNote ? "Telegram video note" : "Telegram video"}
          className={videoNote ? "mtg-video-note-preview" : undefined}
          controls={!videoNote} playsInline loop={loop} muted={loop} autoPlay={loop}
          src={src} onRateChange={syncPlaybackRate} onLoadedMetadata={restorePosition} onError={() => setFailed(true)}
          onPlay={videoNote ? () => setPlaying(true) : undefined}
          onPause={videoNote ? () => setPlaying(false) : undefined}
          onEnded={videoNote ? () => setPlaying(false) : undefined}
          onDurationChange={videoNote ? (event) => {
            const next = event.currentTarget.duration;
            if (Number.isFinite(next) && next > 0) setDuration(next);
          } : undefined}
          onTimeUpdate={videoNote ? (event) => setPosition(event.currentTarget.currentTime) : undefined} />)}
      {src && !failed && videoNote && <div className="mtg-video-note-controls">
        <button type="button" className="mtg-action" onClick={toggleVideo}>{playing ? "Pause video note" : "Play video note"}</button>
        <input type="range" aria-label="Video note position" min={0} max={duration || 1} step={0.1}
          value={Math.min(position, duration)} disabled={!duration}
          onInput={(event) => {
            const time = Number(event.currentTarget.value);
            if (player.current) player.current.currentTime = time;
            setPosition(time);
          }} />
      </div>}
      {src && !failed && adjustableSpeed && <label>Playback speed <select value={speed}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          setSpeed(next);
        }}>
        {playbackRates.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </select></label>}
      <button type="button" className="mtg-action" onClick={closePlayer}>Close player</button>
    </> : <button type="button" className="mtg-action" onClick={() => setOpened(true)}>
      {oneView ? (saved ? `Open saved ${oneView}` : `View and save ${oneView}`) : audio ? "Load audio player" : image ? "View image" : videoNote ? "Open video note" : "Load video player"}
    </button>}
  </div>;
}
