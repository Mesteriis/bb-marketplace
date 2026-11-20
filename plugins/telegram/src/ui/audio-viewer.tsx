import { Info, Maximize2, Music2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { formatPlaybackTime } from "./video-seek-preview.tsx";

export type AudioOverlay = {
  title: string;
  artist?: string;
  actions?: ReactNode;
  details?: ReactNode;
  notice?: ReactNode;
  close: () => void;
};

const time = (seconds: number) => formatPlaybackTime(Math.floor(seconds));

export type CompactAudio = Pick<AudioOverlay, "title" | "artist"> & {
  expand: (opener: HTMLButtonElement) => void;
};

export function AudioMiniPlayer({ track, duration, position, playing, ready, toggle, seek, seekReady, close, status }: {
  track: CompactAudio;
  duration: number;
  position: number;
  playing: boolean;
  ready: boolean;
  toggle: () => void;
  seek: (time: number) => void;
  seekReady: boolean;
  close: () => void;
  status: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const label = tr(playing ? "Pause audio" : "Play audio");
  return <div className="mtg-audio-mini">
    <button type="button" className="mtg-audio-icon mtg-audio-play" disabled={!ready} onClick={toggle} aria-label={label} title={label}>
      {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
    </button>
    <button type="button" className="mtg-audio-mini-title" title={tr("Open audio player")}
      onClick={(event) => track.expand(event.currentTarget)}>
      <bdi>{track.title}</bdi>{track.artist && <small><bdi>{track.artist}</bdi></small>}
    </button>
    <AudioSeek duration={duration} position={position} ready={seekReady} seek={seek} />
    <span className="mtg-audio-clock">{time(position)} / {time(duration)}</span>
    <button type="button" className="mtg-audio-icon" title={tr("Open audio player")} aria-label={tr("Open audio player")}
      onClick={(event) => track.expand(event.currentTarget)}><Maximize2 size={16} /></button>
    <button type="button" className="mtg-audio-icon" title={tr("Close player")} aria-label={tr("Close player")}
      onClick={close}><X size={18} /></button>
    {status && <div className="mtg-audio-mini-status">{status}</div>}
  </div>;
}

function AudioSeek({ duration, position, ready, seek, peaks }: {
  duration: number; position: number; ready: boolean; seek: (time: number) => void; peaks?: readonly number[];
}) {
  const { t: tr } = useTelegramLocale();
  const current = Math.min(position, duration);
  const progress = duration ? current / duration : 0;
  const scale = peaks?.length ? Math.max(.04, ...peaks) : 1;
  return <div className="mtg-audio-timeline" data-waveform={!!peaks?.length || undefined}
    style={{ "--audio-progress": `${progress * 100}%` } as CSSProperties}>
    {peaks?.length ? <>
      <span className="mtg-audio-peaks" aria-hidden="true">
        {peaks.map((peak, index) => <span key={index} data-played={(index + 0.5) / peaks.length <= progress || undefined}
          style={{ height: `${Math.max(3, peak / scale * 86)}%` }} />)}
      </span>
      <span className="mtg-audio-playhead" aria-hidden="true" />
    </> : <span className="mtg-audio-rail" aria-hidden="true" />}
    <input type="range" aria-label={tr("Audio position")} aria-valuetext={tr("{0} of {1}", [time(current), time(duration)])}
      min={0} max={duration || 1} step={0.1} disabled={!ready} value={current}
      onInput={(event) => seek(Number(event.currentTarget.value))} />
  </div>;
}

export function AudioViewer({ overlay, status, peaks, duration, position, playing, ready, seekReady, seek, toggle, settings, keys, volume, changeVolume }: {
  overlay: AudioOverlay;
  status: ReactNode;
  peaks?: readonly number[];
  duration: number;
  seekReady: boolean;
  position: number;
  playing: boolean;
  ready: boolean;
  seek: (time: number) => void;
  toggle: () => void;
  settings: ReactNode;
  keys: (event: KeyboardEvent) => void;
  volume: number;
  changeVolume: (volume: number) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const detailsId = useId();
  const [showDetails, setShowDetails] = useState(false);
  const lastVolume = useRef(1);
  const current = Math.min(position, duration);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => { if (element.open) element.close(); };
  }, []);

  return <dialog ref={dialog} className="mtg-audio-viewer" data-linear={!peaks?.length || undefined} aria-labelledby={titleId}
    aria-keyshortcuts="Space ArrowLeft ArrowRight" onCancel={(event) => { event.preventDefault(); overlay.close(); }}
    onKeyDown={(event) => {
      if (!(event.target instanceof Element) || event.target.closest("input, select, textarea, [contenteditable]")
        || event.key === " " && event.target.closest("button, summary, a")) return;
      keys(event);
    }}>
    <header>
      <span className="mtg-audio-identity" aria-hidden="true"><Music2 size={25} /></span>
      <div className="mtg-audio-heading">
        <h2 id={titleId}><bdi>{overlay.title}</bdi></h2>
        {overlay.artist && <p><bdi>{overlay.artist}</bdi></p>}
      </div>
      <div className="mtg-audio-tools">
        {overlay.actions}
        {overlay.details && <button type="button" className="mtg-audio-icon" aria-label={tr("Track details")} title={tr("Track details")}
          aria-expanded={showDetails} aria-controls={detailsId} onClick={() => setShowDetails((visible) => !visible)}><Info size={19} /></button>}
        <button type="button" ref={closeButton} className="mtg-audio-icon" title={tr("Close player")} aria-label={tr("Close player")}
          onClick={overlay.close}><X size={21} /></button>
      </div>
    </header>
    <AudioSeek duration={duration} position={current} ready={seekReady} seek={seek} peaks={peaks} />
    {!!peaks?.length && <div className="mtg-audio-markers" aria-hidden="true">
      <span>0:00</span><span>{time(duration / 2)}</span><span>{time(duration)}</span>
    </div>}
    {(status || overlay.notice) && <div className="mtg-audio-status">{status}{overlay.notice}</div>}
    <div className="mtg-audio-transport">
      <button type="button" className="mtg-audio-icon mtg-audio-play" disabled={!ready} onClick={toggle}
        aria-label={tr(playing ? "Pause audio" : "Play audio")} title={tr(playing ? "Pause audio" : "Play audio")}>
        {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
      </button>
      <button type="button" className="mtg-audio-icon mtg-audio-skip" disabled={!seekReady}
        aria-label={tr("Back 10 seconds")} title={tr("Back 10 seconds")} onClick={() => seek(Math.max(0, current - 10))}>
        <RotateCcw size={21} /><span>10</span>
      </button>
      <button type="button" className="mtg-audio-icon mtg-audio-skip" disabled={!seekReady}
        aria-label={tr("Forward 10 seconds")} title={tr("Forward 10 seconds")} onClick={() => seek(Math.min(duration, current + 10))}>
        <RotateCw size={21} /><span>10</span>
      </button>
      <span className="mtg-audio-clock">{time(current)} / {time(duration)}</span>
      <div className="mtg-audio-settings">
        <button type="button" className="mtg-audio-icon" disabled={!ready} aria-label={tr(volume ? "Mute" : "Unmute")}
          onClick={() => { if (volume) lastVolume.current = volume; changeVolume(volume ? 0 : lastVolume.current); }}>
          {volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
        <input type="range" aria-label={tr("Volume")} min={0} max={1} step={0.02} value={volume} disabled={!ready}
          onInput={(event) => changeVolume(Number(event.currentTarget.value))} />
        {settings}
      </div>
    </div>
    {overlay.details && <div id={detailsId} className="mtg-audio-details" hidden={!showDetails}>{overlay.details}</div>}
  </dialog>;
}
