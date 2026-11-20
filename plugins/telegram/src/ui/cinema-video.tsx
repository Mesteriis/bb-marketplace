import { FastForward, Maximize, Minimize, Pause, Play, Rewind, RotateCcw, RotateCw, Settings2, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { formatPlaybackTime, VideoSeekPreview } from "./video-seek-preview.tsx";

type Point = { x: number; y: number };
type Tap = Point & { side: -1 | 1; time: number };

export function CinemaVideo({ video, player, stage, source, duration, position, playing, seek, toggle, fullscreen, toggleFullscreen, preview, settings, shortcuts }: {
  video: ReactNode;
  player: RefObject<HTMLMediaElement | null>;
  stage?: RefObject<HTMLDivElement | null>;
  source: string;
  duration: number;
  position: number;
  playing: boolean;
  seek: (time: number) => void;
  toggle: () => void;
  fullscreen: boolean;
  toggleFullscreen?: () => void;
  preview: boolean;
  settings: ReactNode;
  shortcuts: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [rotation, setRotation] = useState(0);
  const [idle, setIdle] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [feedback, setFeedback] = useState<-1 | 1>();
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menu = useRef<HTMLDetailsElement>(null);
  const start = useRef<Point | undefined>(undefined);
  const recentTap = useRef<Tap | undefined>(undefined);
  const ready = duration > 0;

  const revealControls = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    if (playing) idleTimer.current = setTimeout(() => setIdle(true), 2500);
  }, [playing]);

  useEffect(() => {
    revealControls();
    return () => clearTimeout(idleTimer.current);
  }, [revealControls]);
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);

  useEffect(() => {
    const media = player.current;
    if (!media) return;
    function syncVolume() {
      if (!media) return;
      setVolume(media.volume);
      setMuted(media.muted);
    }
    function syncBuffer() {
      if (!media) return;
      const ranges = media.buffered;
      for (let index = 0; index < ranges.length; index++) {
        if (ranges.start(index) <= media.currentTime && media.currentTime <= ranges.end(index)) {
          setBuffered(ranges.end(index));
          return;
        }
      }
      setBuffered(0);
    }
    syncVolume();
    syncBuffer();
    media.addEventListener("volumechange", syncVolume);
    const bufferEvents = ["progress", "timeupdate", "loadedmetadata", "emptied"];
    for (const event of bufferEvents) media.addEventListener(event, syncBuffer);
    return () => {
      media.removeEventListener("volumechange", syncVolume);
      for (const event of bufferEvents) media.removeEventListener(event, syncBuffer);
    };
  }, [player, source]);

  function skip(side: -1 | 1) {
    const media = player.current;
    if (!ready || !media) return;
    seek(Math.min(duration, Math.max(0, media.currentTime + side * 10)));
    setFeedback(side);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(undefined), 650);
  }

  function finishTap(event: PointerEvent<HTMLDivElement>) {
    const point = start.current;
    start.current = undefined;
    if (!point || !event.isPrimary || Math.hypot(event.clientX - point.x, event.clientY - point.y) > 18) {
      recentTap.current = undefined;
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const media = player.current;
    const ratio = media instanceof HTMLVideoElement && media.videoWidth && media.videoHeight
      ? rotation % 180 === 0 ? media.videoWidth / media.videoHeight : media.videoHeight / media.videoWidth
      : bounds.width / bounds.height;
    const width = Math.min(bounds.width, bounds.height * ratio);
    const fraction = (event.clientX - bounds.left - (bounds.width - width) / 2) / width;
    if (fraction >= 0.35 && fraction <= 0.65) {
      recentTap.current = undefined;
      toggle();
      return;
    }
    const side = fraction < 0.35 ? -1 : 1;
    const time = performance.now();
    const previous = recentTap.current;
    if (previous?.side === side && time - previous.time <= 325
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 48) {
      recentTap.current = undefined;
      skip(side);
    } else recentTap.current = { side, time, x: event.clientX, y: event.clientY };
  }

  const quiet = muted || volume === 0;
  const elapsed = Math.min(position, duration);
  const backwardLabel = tr("Back 10 seconds");
  const forwardLabel = tr("Forward 10 seconds");
  const toggleLabel = tr(playing ? "Pause" : "Play");
  const volumeLabel = tr(quiet ? "Unmute" : "Mute");
  const fullscreenLabel = tr(fullscreen ? "Exit fullscreen" : "Fullscreen");
  return <div className="mtg-cinema-video" ref={stage} data-controls-idle={idle || undefined}
    onPointerMove={revealControls} onPointerDown={revealControls} onKeyDown={revealControls}>
    <div className="mtg-cinema-picture" data-quarter-turn={rotation % 180 !== 0 || undefined}
      style={{ "--mtg-video-rotation": `${rotation}deg` } as CSSProperties}
      onPointerDown={(event) => {
        if (menu.current?.open) {
          menu.current.open = false;
          start.current = recentTap.current = undefined;
          return;
        }
        if (event.isPrimary && event.button === 0) start.current = { x: event.clientX, y: event.clientY };
      }} onPointerUp={finishTap} onPointerCancel={() => { start.current = recentTap.current = undefined; }}>
      {video}
      {feedback && <span className="mtg-cinema-feedback" data-backward={feedback < 0 || undefined} aria-hidden="true">
        {feedback < 0 ? <Rewind size={22} /> : <FastForward size={22} />}
        {feedback < 0 ? "−" : "+"}{tr("10 s")}
      </span>}
    </div>
    <div className="mtg-cinema-controls" style={{ "--mtg-buffered": `${ready ? buffered / duration * 100 : 0}%` } as CSSProperties}>
      {preview && ready
        ? <VideoSeekPreview key={source} compact source={source} duration={duration} position={position} seek={seek} />
        : <input type="range" dir="ltr" aria-label={tr("Video position")} min={0} max={duration || 1} step={0.1}
          value={elapsed} disabled={!ready} style={{ "--mtg-played": `${ready ? elapsed / duration * 100 : 0}%` } as CSSProperties}
          aria-valuetext={`${formatPlaybackTime(elapsed)} / ${formatPlaybackTime(duration)}`}
          onChange={(event) => seek(Number(event.currentTarget.value))} />}
      <div className="mtg-cinema-transport">
        <button type="button" className="mtg-cinema-icon" onClick={toggle} aria-label={toggleLabel} title={toggleLabel}>
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <button type="button" className="mtg-cinema-skip" onClick={() => skip(-1)} aria-label={backwardLabel} title={backwardLabel} disabled={!ready}>
          <RotateCcw size={18} /> <span>{tr("10 s")}</span>
        </button>
        <button type="button" className="mtg-cinema-skip" onClick={() => skip(1)} aria-label={forwardLabel} title={forwardLabel} disabled={!ready}>
          <RotateCw size={18} /> <span>{tr("10 s")}</span>
        </button>
        <span className="mtg-cinema-time">{formatPlaybackTime(elapsed)} / {formatPlaybackTime(duration)}</span>
        <button type="button" className="mtg-cinema-icon mtg-cinema-mute" aria-label={volumeLabel} title={volumeLabel} onClick={() => {
          const media = player.current;
          if (!media) return;
          if (quiet && media.volume === 0) media.volume = 0.7;
          media.muted = !quiet;
        }}>{quiet ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
        <details ref={menu} className="mtg-cinema-menu" onKeyDown={(event) => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}>
          <summary className="mtg-cinema-icon" aria-label={tr("Video settings")} title={tr("Video settings")}><Settings2 size={19} /></summary>
          <div className="mtg-cinema-settings">
            <button type="button" className="mtg-viewer-detail-action" onClick={() => setRotation((value) => (value + 90) % 360)}>
              <RotateCw size={16} />{tr("Rotate 90°")}
            </button>
            {rotation !== 0 && <button type="button" className="mtg-viewer-detail-action" onClick={() => setRotation(0)}>
              <RotateCcw size={16} />{tr("Reset rotation")}
            </button>}
            <label>{tr("Volume")}<input type="range" min={0} max={1} step={0.05} value={quiet ? 0 : volume} onChange={(event) => {
              const media = player.current;
              if (!media) return;
              media.volume = Number(event.currentTarget.value);
              media.muted = false;
            }} /></label>
            {settings}
            {shortcuts && <div className="mtg-cinema-shortcuts" aria-label={tr("Keyboard shortcuts")}>
              <p><kbd>␣ / K</kbd>{tr("Play / pause")}</p>
              <p><kbd>← / →</kbd>{tr("Seek 5 seconds")}</p>
              <p><kbd>J / L</kbd>{tr("Seek 10 seconds")}</p>
            </div>}
          </div>
        </details>
        {toggleFullscreen && <button type="button" className="mtg-cinema-icon" onClick={toggleFullscreen}
          aria-label={fullscreenLabel} title={fullscreenLabel}>{fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}</button>}
      </div>
    </div>
  </div>;
}
