import { useTelegramLocale } from "./i18n/index.tsx";
import { MediaViewerFrame, MediaViewerLoading } from "./media-viewer-frame.tsx";
import { AudioMiniPlayer, AudioViewer, type AudioOverlay, type CompactAudio } from "./audio-viewer.tsx";
import { decodeAudioWaveform } from "./audio-waveform.ts";
import { CinemaVideo } from "./cinema-video.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { Play } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { VideoPictureInPicture } from "./video-picture-in-picture.tsx";
import { photoSource } from "./photo-preview.tsx";
import { useVisibleThumbnail, type VisibleThumbnailLoader } from "./visible-thumbnail.ts";
import { PlaybackQueue } from "./note-playback-queue.tsx";
import { bindMediaSession } from "./media-session.ts";
import { chooseAutoplayVideoQuality } from "./automatic-playback.tsx";
import { formatPlaybackTime as formatDuration, VideoSeekPreview } from "./video-seek-preview.tsx";
import type { PlaybackMime, RichAttachmentReference, VideoQuality } from "../core/contract.ts";

export type MediaLoader = (chatId: string, messageId: string, signal: AbortSignal, oneView?: true, attachment?: RichAttachmentReference, playbackFileId?: number) => Promise<Blob>;
export type VideoStreamLoader = (chatId: string, messageId: string, attachment?: RichAttachmentReference,
  motionFileId?: number, qualityFileId?: number, playbackFileId?: number) => Promise<string>;

function requestVideoStream(load: VideoStreamLoader, chatId: string, messageId: string, fileId?: number, quality?: number) {
  if (fileId !== undefined) return load(chatId, messageId, undefined, undefined, quality, fileId);
  if (quality !== undefined) return load(chatId, messageId, undefined, undefined, quality);
  return load(chatId, messageId);
}

const playbackHistoryLimit = 128;
const playbackShortcuts = "Space ArrowLeft ArrowRight";
const videoShortcuts = `${playbackShortcuts} J K L , .`;
const fullscreenToggleShortcuts = " Alt+Enter Control+Enter Meta+Enter";
const fullscreenSeekShortcuts = " 0 1 2 3 4 5 6 7 8 9";
const chapterShortcuts = " Alt+ArrowLeft Alt+ArrowRight";
const videoBoostDelay = 300;
const videoBoostRate = 2;
const fallbackVideoFrameLength = 1 / 30;
type VideoHold = { video: HTMLMediaElement; boosting: boolean; cancel: () => void };
type PlaybackKind = "voice" | "videoNote" | "audio" | "video";
type PlaybackPosition = { time: number; playing: boolean; rate: number; volume: number; muted: boolean; activity?: number };
type QualityPosition = PlaybackPosition & { url: string };
type PlaybackSession = {
  positions: Map<string, number>;
  rates: Map<PlaybackKind, number>;
  activity: number;
  active?: HTMLMediaElement;
  queuedNote?: symbol;
};
export const PlaybackHistory = createContext<PlaybackSession | null>(null);

export function PlaybackHistoryProvider({ children }: { children: ReactNode }) {
  const [history] = useState<PlaybackSession>(() => ({ positions: new Map<string, number>(), rates: new Map<PlaybackKind, number>(), activity: 0 }));
  return <PlaybackHistory.Provider value={history}>{children}</PlaybackHistory.Provider>;
}

export type SpeechPlayback = {
  ready: boolean;
  playing: boolean;
  position: number;
  duration: number;
  speed: number;
  rate: (speed: number) => void;
  toggle: () => void;
  seek: (time: number) => void;
  status: ReactNode;
};

export function MediaPlayer({ chatId, messageId, playbackFileId, playbackRevision, mime, oneView, saved, load, stream, videoQualities, streamQuality, autoplayVideoBudget, seekPreview, loop, autoplay, playWhenVisible, videoNote, voiceNote, startTime, loadMessageLink, poster, posterSize, loadPoster, durationSeconds, waveform, chapters, seekRequest, onNotePlaying, queuePlayback, playlistControls, loadLabel, audioMetadata, repeatTrack, playRequest, onClose, playbackDialog, viewerActions, viewerDetails, audioOverlay, compactAudio, decodeWaveform, speechControls }: {
  chatId: string;
  messageId: string;
  playbackFileId?: number;
  playbackRevision?: string | number;
  mime?: PlaybackMime;
  oneView?: "photo" | "video";
  saved?: boolean;
  loop?: boolean;
  autoplay?: boolean;
  playWhenVisible?: boolean;
  videoNote?: boolean;
  voiceNote?: boolean;
  startTime?: number;
  chapters?: readonly number[];
  seekRequest?: { time: number };
  onNotePlaying?: () => void;
  queuePlayback?: boolean;
  playlistControls?: boolean;
  loadLabel?: string;
  audioOverlay?: AudioOverlay;
  compactAudio?: CompactAudio;
  decodeWaveform?: boolean;
  speechControls?: (playback: SpeechPlayback) => ReactNode;
  audioMetadata?: { title: string; artist?: string };
  repeatTrack?: boolean;
  playRequest?: { restart: boolean };
  onClose?: () => void;
  playbackDialog?: boolean;
  viewerActions?: ReactNode;
  viewerDetails?: (close: () => void) => ReactNode;
  poster?: string;
  posterSize?: { width: number; height: number };
  loadPoster?: VisibleThumbnailLoader;
  durationSeconds?: number;
  waveform?: readonly number[];
  loadMessageLink?: MessageLinkLoader;
  load?: MediaLoader;
  stream?: VideoStreamLoader;
  videoQualities?: readonly VideoQuality[];
  streamQuality?: VideoStreamLoader;
  autoplayVideoBudget?: { originalBytes: number; limitBytes: number };
  seekPreview?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [opened, setOpened] = useState(false);
  const queue = useContext(PlaybackQueue);
  const [queuedStart, setQueuedStart] = useState<symbol>();
  const durationDescription = useId();
  const durationLabel = !oneView && durationSeconds !== undefined ? formatDuration(durationSeconds) : undefined;
  const posterTarget = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cinemaStage = useRef<HTMLDivElement>(null);
  const restoreOpenerFocus = useRef(false);
  const thumbnail = useVisibleThumbnail(posterTarget, chatId, messageId, posterSize && !oneView ? loadPoster : undefined);
  const posterSource = thumbnail.photo ? photoSource(thumbnail.photo) : poster;
  const hasPosterSlot = (!!posterSize || playbackDialog) && !oneView;
  const posterOnly = hasPosterSlot && mime?.startsWith("video/") && !videoNote;
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [videoQuality, setVideoQuality] = useState<number>();
  const [switchingQuality, setSwitchingQuality] = useState(false);
  const [qualityFailed, setQualityFailed] = useState(false);
  const selectedQuality = useRef<number | undefined>(undefined);
  const automaticQuality = useRef(false);
  const qualityRequest = useRef<AbortController | undefined>(undefined);
  const qualityPosition = useRef<QualityPosition | undefined>(undefined);
  const failedQualityPosition = useRef<PlaybackPosition | undefined>(undefined);
  const videoPosition = useRef<QualityPosition | undefined>(undefined);
  const changedVideoQuality = useRef(false);
  const canRetry = !oneView && (!!load || (!!stream && !!mime));
  const resumeAt = useRef<number | undefined>(undefined);
  const handledSeek = useRef<typeof seekRequest>(undefined);
  const pendingSeek = useRef<number | undefined>(undefined);
  const restoredMedia = useRef<HTMLMediaElement | null>(null);
  const resumeInViewer = useRef(false);
  const playback = useContext(PlaybackHistory);
  const playbackHistory = playback?.positions;
  const playbackKey = JSON.stringify([chatId, messageId, playbackFileId, playbackFileId ? null : playbackRevision]);
  const player = useRef<HTMLMediaElement>(null);
  const systemControls = useRef<ReturnType<typeof bindMediaSession>>(undefined);
  const manuallyOpened = useRef(false);
  const previewOnly = useRef(false);
  const pausedForVisibility = useRef<HTMLMediaElement | null>(null);
  const automaticAttempt = useRef<HTMLMediaElement | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const modalPlayback = playbackDialog && opened && !autoOpened;
  useLayoutEffect(() => {
    const window = dialog.current;
    if (modalPlayback && window && !window.open) {
      window.showModal();
      closer.current?.focus({ preventScroll: true });
    }
  }, [modalPlayback]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const originalBytes = autoplayVideoBudget?.originalBytes;
  const limitBytes = autoplayVideoBudget?.limitBytes;
  const activeBytes = videoQuality === undefined ? originalBytes : videoQualities?.find(({ fileId }) => fileId === videoQuality)?.sizeBytes;
  const automaticStreamFits = !autoOpened || limitBytes === undefined || (activeBytes !== undefined && activeBytes <= limitBytes);
  const autoPlaying = !!autoplay || !!playWhenVisible && previewVisible && automaticStreamFits;
  const imageHeight = useRef(0);
  const lastRate = useRef(1);
  const videoHold = useRef<VideoHold>(undefined);
  const videoFrameLength = useRef(fallbackVideoFrameLength);
  const [boostingVideo, setBoostingVideo] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audioVolume, setAudioVolume] = useState(1);
  const [audioWaveform, setAudioWaveform] = useState<readonly number[]>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewportFullscreen, setViewportFullscreen] = useState(false);
  const image = oneView === "photo" || mime?.startsWith("image/");
  const audio = mime?.startsWith("audio/");
  const playbackKind: PlaybackKind = voiceNote ? "voice" : videoNote ? "videoNote" : audio ? "audio" : "video";
  const adjustableSpeed = !image && !loop && !oneView;
  const showWaveform = adjustableSpeed && !!(voiceNote || videoNote) && !!waveform?.length;
  const videoKeyboardControls = adjustableSpeed && playbackKind === "video";
  const showSeekPreview = !!seekPreview && !!stream && videoKeyboardControls && !autoOpened;
  const trackPosition = videoNote || showWaveform || showSeekPreview || modalPlayback || !!compactAudio || !!speechControls;
  const chapterTimes = (videoKeyboardControls && chapters?.filter((time) => time < duration)) || [];
  const hasChapters = chapterTimes.length > 0;
  const fullscreenEnabled = videoKeyboardControls && (modalPlayback || (typeof document !== "undefined" && document.fullscreenEnabled));
  const canFloat = adjustableSpeed && !audio && !videoNote
    && typeof document !== "undefined" && document.pictureInPictureEnabled
    && typeof HTMLVideoElement.prototype.requestPictureInPicture === "function";
  useLayoutEffect(() => {
    const region = posterTarget.current;
    if (playbackDialog && !opened && restoreOpenerFocus.current) {
      restoreOpenerFocus.current = false;
      opener.current?.focus({ preventScroll: true });
      return;
    }
    if (modalPlayback && src && !failed && region?.ownerDocument.activeElement === closer.current) {
      player.current?.focus({ preventScroll: true });
      return;
    }
    if (!region || region.ownerDocument.activeElement !== region) return;
    if (!opened && restoreOpenerFocus.current) opener.current?.focus({ preventScroll: true });
    else if (opened && src && !failed) (player.current ?? closer.current)?.focus({ preventScroll: true });
    else if (failed) closer.current?.focus({ preventScroll: true });
  }, [opened, src, failed, playbackDialog, modalPlayback]);
  const stopVideoHold = useCallback(() => {
    const hold = videoHold.current;
    if (!hold) return;
    videoHold.current = undefined;
    hold.cancel();
    if (hold.boosting) {
      hold.video.playbackRate = lastRate.current;
      setBoostingVideo(false);
    }
  }, []);
  const attach = useCallback((element: HTMLMediaElement | null) => {
    const media = player.current;
    if (!element && media) stopVideoHold();
    if (!element && media) {
      systemControls.current?.release();
      systemControls.current = undefined;
    }
    if (!element && media && playback?.active === media) {
      playback.active = undefined;
      if (!media.paused) media.pause();
    }
    if (!element && adjustableSpeed && !previewOnly.current && media
      && (Number.isFinite(media.duration) || failedQualityPosition.current)) {
      const time = failedQualityPosition.current?.time
        ?? (!media.ended && Number.isFinite(media.currentTime) && media.currentTime < media.duration ? media.currentTime : 0);
      resumeAt.current = media.ended ? undefined : time;
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
    if (element && adjustableSpeed) {
      const rate = lastRate.current;
      if (element.playbackRate !== rate) element.playbackRate = rate;
      if (element.defaultPlaybackRate !== rate) element.defaultPlaybackRate = rate;
    }
  }, [adjustableSpeed, playback, playbackHistory, playbackKey, stopVideoHold]);
  const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  if (!playbackRates.includes(speed)) playbackRates.push(speed);
  playbackRates.sort((a, b) => a - b);
  useEffect(() => {
    const target = posterTarget.current;
    if (!playWhenVisible || !target || typeof IntersectionObserver !== "function") return;
    let active = true;
    let visible = false;
    const update = () => { if (active) setPreviewVisible(visible && document.visibilityState === "visible"); };
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry && entry.isIntersecting && entry.intersectionRatio >= 0.25;
      update();
    }, { threshold: 0.25 });
    observer.observe(target);
    document.addEventListener("visibilitychange", update);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      setPreviewVisible(false);
    };
  }, [playWhenVisible]);
  useEffect(() => {
    if (!autoPlaying || manuallyOpened.current || opened || oneView) return;
    if (playWhenVisible && stream && streamQuality && videoQualities?.length && originalBytes && limitBytes) {
      const rowWidth = posterTarget.current?.closest<HTMLElement>(".mtg-bubble")?.parentElement?.clientWidth;
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      // Match the caps of the chat bubble and inline video in telegram.css.
      const fileId = chooseAutoplayVideoQuality(videoQualities, { originalBytes, limitBytes }, {
        width: Math.max(1, Math.min(536, (rowWidth || window.innerWidth) * 0.87 - 24)) * ratio,
        height: Math.max(1, Math.min(320, window.innerHeight * 0.45)) * ratio,
      });
      if (fileId === undefined && originalBytes > limitBytes) return;
      automaticQuality.current = fileId !== undefined;
      selectedQuality.current = fileId;
      setVideoQuality(fileId);
    }
    previewOnly.current = true;
    setAutoOpened(true);
    setOpened(true);
  }, [autoPlaying, limitBytes, oneView, opened, originalBytes, playWhenVisible, stream, streamQuality, videoQualities]);
  useEffect(() => {
    const media = player.current;
    if (!autoOpened || !media) return;
    if (!autoPlaying) {
      if (!media.paused) {
        pausedForVisibility.current = media;
        media.pause();
      }
    } else if (pausedForVisibility.current === media || (playWhenVisible && automaticAttempt.current !== media)) {
      automaticAttempt.current = media;
      pausedForVisibility.current = null;
      void media.play().catch(() => {});
    }
  }, [autoOpened, autoPlaying, playWhenVisible, src]);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    let url: string | undefined;
    if (stream && mime) {
      const fileId = selectedQuality.current;
      const pending = fileId === undefined || !streamQuality
        ? requestVideoStream(stream, chatId, messageId, playbackFileId)
        : requestVideoStream(streamQuality, chatId, messageId, playbackFileId, fileId);
      void pending.then((url) => {
        if (controller.signal.aborted) return;
        if (failedQualityPosition.current) qualityPosition.current = { ...failedQualityPosition.current, url };
        setSrc(url);
      }).catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
      return () => controller.abort();
    }
    if (!load) {
      setFailed(true);
      return;
    }
    const pending = oneView ? load(chatId, messageId, controller.signal, true)
      : playbackFileId === undefined ? load(chatId, messageId, controller.signal)
        : load(chatId, messageId, controller.signal, undefined, undefined, playbackFileId);
    void pending.then((data) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(mime ? data.slice(0, data.size, mime) : data);
      setSrc(url);
      if (decodeWaveform) void decodeAudioWaveform(data, controller.signal).then((peaks) => {
        if (!controller.signal.aborted) setAudioWaveform(peaks);
      }).catch(() => {});
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [chatId, messageId, playbackFileId, mime, oneView, load, opened, stream, streamQuality, loadAttempt, decodeWaveform]);
  useEffect(() => () => { qualityRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!opened || !videoKeyboardControls) return;
    function syncFullscreen() {
      setFullscreen(!!document.fullscreenElement && document.fullscreenElement === (cinemaStage.current ?? player.current));
    }
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [opened, videoKeyboardControls, src, failed]);

  function changePlaybackRate(rate: number, element: HTMLMediaElement) {
    if (!adjustableSpeed || !Number.isFinite(rate) || rate <= 0) return;
    if (lastRate.current !== rate) playback?.rates.set(playbackKind, rate);
    lastRate.current = rate;
    if (element.playbackRate !== rate) element.playbackRate = rate;
    if (element.defaultPlaybackRate !== rate) element.defaultPlaybackRate = rate;
    setSpeed(rate);
  }

  function syncPlaybackRate(event: SyntheticEvent<HTMLMediaElement>) {
    const element = event.currentTarget;
    if (videoHold.current?.video === element && videoHold.current.boosting) return;
    changePlaybackRate(element.playbackRate, element);
    rememberVideoPosition(element);
  }

  function holdVideoSpace(video: HTMLMediaElement) {
    if (videoHold.current) return;
    const doc = video.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    let held = false;
    const timer = setTimeout(() => {
      held = true;
      if (videoHold.current !== hold || video.paused || video.ended || lastRate.current >= videoBoostRate) return;
      hold.boosting = true;
      video.playbackRate = videoBoostRate;
      setBoostingVideo(true);
    }, videoBoostDelay);
    function release(event: globalThis.KeyboardEvent) {
      if (event.key !== " " && event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      stopVideoHold();
      if (!held && player.current === video) togglePlayback(video);
    }
    function visibilityChanged() {
      if (doc.hidden) stopVideoHold();
    }
    const hold: VideoHold = { video, boosting: false, cancel() {
      clearTimeout(timer);
      view?.removeEventListener("keyup", release, true);
      view?.removeEventListener("blur", stopVideoHold);
      video.removeEventListener("blur", stopVideoHold);
      doc.removeEventListener("visibilitychange", visibilityChanged);
    } };
    videoHold.current = hold;
    view.addEventListener("keyup", release, true);
    view.addEventListener("blur", stopVideoHold);
    video.addEventListener("blur", stopVideoHold);
    doc.addEventListener("visibilitychange", visibilityChanged);
  }

  function restorePosition(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    if (trackPosition || chapters?.length) syncDuration(event);
    const replacement = qualityPosition.current;
    if (replacement) {
      if (event.type !== "loadedmetadata" || media.getAttribute("src") !== replacement.url) return;
      qualityPosition.current = undefined;
      failedQualityPosition.current = undefined;
      restoredMedia.current = media;
      const duration = media.duration;
      const time = pendingSeek.current ?? replacement.time;
      pendingSeek.current = undefined;
      if (Number.isFinite(duration) && duration > 0) {
        media.currentTime = Math.min(time, Math.max(0, duration - 0.05));
        if (trackPosition) setPosition(media.currentTime);
      }
      media.volume = replacement.volume;
      media.muted = replacement.muted;
      changePlaybackRate(replacement.rate, media);
      setSwitchingQuality(false);
      const resume = replacement.playing && replacement.activity === playback?.activity;
      rememberVideoPosition(media, resume);
      if (resume) void media.play().catch(() => {});
      return;
    }
    if (!Number.isFinite(media.duration) || media.duration <= 0 || restoredMedia.current === media) return;
    restoredMedia.current = media;
    const requested = pendingSeek.current ?? startTime;
    pendingSeek.current = undefined;
    const time = requested ?? (playbackHistory ? playbackHistory.get(playbackKey) : resumeAt.current);
    if ((requested !== undefined || (adjustableSpeed && time)) && time !== undefined && time < media.duration) {
      media.currentTime = time;
      if (trackPosition) setPosition(time);
    }
    if (resumeInViewer.current) {
      resumeInViewer.current = false;
      void media.play().catch(() => {});
    }
    rememberVideoPosition(media);
  }

  function toggleFullscreen(media: HTMLMediaElement) {
    const target = cinemaStage.current ?? media;
    const owner = media.ownerDocument;
    if (viewportFullscreen) { setViewportFullscreen(false); return; }
    if (owner.fullscreenElement === target) {
      void owner.exitFullscreen().catch(() => undefined);
      return;
    }
    const fitViewport = () => {
      if (cinemaStage.current === target) setViewportFullscreen(true);
    };
    if (!owner.fullscreenEnabled || typeof target.requestFullscreen !== "function") { fitViewport(); return; }
    void target.requestFullscreen().then(() => {
      if (owner.fullscreenElement !== target) fitViewport();
    }, fitViewport);
  }

  function mediaKeys(event: KeyboardEvent, media: HTMLMediaElement) {
    if (event.defaultPrevented || event.shiftKey
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const modifiers = Number(event.altKey) + Number(event.ctrlKey) + Number(event.metaKey);
    if (fullscreenEnabled && event.key === "Enter" && modifiers === 1) {
      event.preventDefault();
      if (!event.repeat) toggleFullscreen(media);
      return;
    }
    if (modifiers) {
      if (!hasChapters || media.readyState < media.HAVE_METADATA || !event.altKey || modifiers !== 1
        || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      const current = media.currentTime;
      const target = event.key === "ArrowLeft"
        ? chapterTimes.filter((time) => time < current - 0.25).at(-1) ?? 0
        : chapterTimes.find((time) => time > current);
      if (target !== undefined) media.currentTime = target;
      return;
    }
    const key = videoKeyboardControls && /^\p{Script=Cyrillic}$/u.test(event.key) && /^Key[JKL]$/.test(event.code)
      ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (key === " " || (videoKeyboardControls && key === "k")) {
      event.preventDefault();
      if (!event.repeat) {
        if (videoKeyboardControls && key === " ") holdVideoSpace(media);
        else {
          stopVideoHold();
          togglePlayback(media);
        }
      }
      return;
    }
    if (media.readyState < media.HAVE_METADATA || !Number.isFinite(media.duration) || media.duration <= 0) return;
    const frame = videoKeyboardControls && media.paused && (key === "," || key === ".")
      ? (key === "," ? -1 : 1) * videoFrameLength.current : 0;
    const step = compactAudio ? 10 : 5;
    const amount = frame || (key === "arrowleft" ? -step : key === "arrowright" ? step
      : videoKeyboardControls && key === "j" ? -10 : videoKeyboardControls && key === "l" ? 10 : 0);
    const fraction = videoKeyboardControls && (viewportFullscreen || document.fullscreenElement === (cinemaStage.current ?? media)) && /^[0-9]$/.test(key)
      ? Number(key) / 10 : undefined;
    if (!amount && fraction === undefined) return;
    event.preventDefault();
    const time = fraction === undefined ? Math.max(0, Math.min(media.duration, media.currentTime + amount)) : media.duration * fraction;
    media.currentTime = time;
    if (trackPosition) setPosition(time);
  }

  const movePlaylist = useCallback((offset: -1 | 1) => {
    const media = player.current;
    if (queue?.move(messageId, offset) && media && !media.paused) media.pause();
  }, [messageId, queue]);
  const mediaSessionTracks = useMemo(() => queuePlayback && queue ? {
    previous: queue.hasNeighbor(messageId, -1) ? () => movePlaylist(-1) : undefined,
    next: queue.hasNeighbor(messageId, 1) ? () => movePlaylist(1) : undefined,
  } : undefined, [messageId, movePlaylist, queue, queuePlayback]);
  useEffect(() => { systemControls.current?.setTracks(mediaSessionTracks); }, [mediaSessionTracks]);

  function onPlay(event: SyntheticEvent<HTMLMediaElement>) {
    if (videoNote || modalPlayback || compactAudio || speechControls) setPlaying(true);
    const media = event.currentTarget;
    if (!loop && !media.muted && adjustableSpeed) {
      systemControls.current = bindMediaSession(media, mediaSessionTracks, audioMetadata);
    }
    if (!loop && !media.muted && playback) {
      playback.activity += 1;
      playback.queuedNote = undefined;
      if (playback.active !== media) {
        const previous = playback.active;
        playback.active = media;
        if (previous && !previous.paused) previous.pause();
      }
    }
    rememberVideoPosition(media, true);
  }

  function onPlaybackStopped(event: SyntheticEvent<HTMLMediaElement>) {
    if (videoHold.current?.video === event.currentTarget) stopVideoHold();
    if (videoNote || modalPlayback || compactAudio || speechControls) setPlaying(false);
    systemControls.current?.pause();
    if (playback?.active === event.currentTarget && !event.currentTarget.ended) playback.active = undefined;
    rememberVideoPosition(event.currentTarget, false);
  }

  function onPlaybackEnded(event: SyntheticEvent<HTMLMediaElement>) {
    const current = !playback || playback.active === event.currentTarget;
    onPlaybackStopped(event);
    systemControls.current?.release();
    systemControls.current = undefined;
    if (playback && current) playback.active = undefined;
    if (current && !previewOnly.current && event.currentTarget.ended && queuePlayback) queue?.move(messageId, 1);
  }

  useEffect(() => {
    videoFrameLength.current = fallbackVideoFrameLength;
    const media = player.current;
    if (!videoKeyboardControls || !src || failed || !(media instanceof HTMLVideoElement)
      || typeof media.requestVideoFrameCallback !== "function") return;
    const video: HTMLVideoElement = media;
    let previous: VideoFrameCallbackMetadata | undefined;
    let next: number;
    const samples: number[] = [];
    function resetPair() { previous = undefined; }
    function sample(_now: number, frame: VideoFrameCallbackMetadata) {
      const current = !video.paused && !video.seeking ? frame : undefined;
      if (current && previous && frame.presentedFrames > previous.presentedFrames) {
        const seconds = (frame.mediaTime - previous.mediaTime) / (frame.presentedFrames - previous.presentedFrames);
        if (seconds >= 1 / 240 - 1e-6 && seconds <= 1) {
          samples.push(seconds);
          if (samples.length > 7) samples.shift();
          videoFrameLength.current = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
        }
      }
      previous = current;
      next = video.requestVideoFrameCallback(sample);
    }
    next = video.requestVideoFrameCallback(sample);
    video.addEventListener("seeking", resetPair);
    video.addEventListener("pause", resetPair);
    return () => {
      video.cancelVideoFrameCallback(next);
      video.removeEventListener("seeking", resetPair);
      video.removeEventListener("pause", resetPair);
    };
  }, [videoKeyboardControls, src, failed]);

  const openPlayer = useCallback(() => {
    manuallyOpened.current = true;
    previewOnly.current = false;
    setAutoOpened(false);
    if (playback) playback.queuedNote = undefined;
    if (adjustableSpeed) {
      lastRate.current = playback?.rates.get(playbackKind) ?? lastRate.current;
      setSpeed(lastRate.current);
    }
    setOpened(true);
  }, [adjustableSpeed, playback, playbackKind]);

  const startQueued = useCallback((restart: boolean) => {
    if (restart) {
      const media = player.current;
      if (media && media.readyState >= media.HAVE_METADATA) {
        media.currentTime = 0;
        setPosition(0);
      } else pendingSeek.current = 0;
    }
    openPlayer();
    const token = Symbol();
    if (playback) playback.queuedNote = token;
    setQueuedStart(token);
  }, [openPlayer, playback]);

  useEffect(() => {
    if (!queue?.register || !queuePlayback || !adjustableSpeed) return;
    return queue.register(messageId, () => startQueued(true));
  }, [adjustableSpeed, messageId, queue, queuePlayback, startQueued]);

  useEffect(() => {
    if (playRequest && adjustableSpeed) startQueued(playRequest.restart);
  }, [adjustableSpeed, playRequest, startQueued]);

  useEffect(() => {
    if (!queuedStart) return;
    if ((!queue && !speechControls) || failed || (playback && playback.queuedNote !== queuedStart)) {
      setQueuedStart(undefined);
      pendingSeek.current = undefined;
      return;
    }
    const media = player.current;
    if (!media || !src) return;
    setQueuedStart(undefined);
    if (playback) playback.queuedNote = undefined;
    void media.play().catch(() => {
      // The player stays open if browser autoplay is unavailable.
    });
  }, [failed, queue, playback, queuedStart, src, speechControls]);

  useEffect(() => {
    if (!adjustableSpeed || !seekRequest || handledSeek.current === seekRequest) return;
    handledSeek.current = seekRequest;
    const media = player.current;
    if (media && media.readyState >= media.HAVE_METADATA && Number.isFinite(media.duration)) {
      if (seekRequest.time < media.duration) {
        media.currentTime = seekRequest.time;
        if (trackPosition) setPosition(seekRequest.time);
      }
      return;
    }
    pendingSeek.current = seekRequest.time;
    if (!opened) openPlayer();
  }, [adjustableSpeed, openPlayer, opened, seekRequest, trackPosition]);

  function syncDuration(event: SyntheticEvent<HTMLMediaElement>) {
    const next = event.currentTarget.duration;
    setDuration(Number.isFinite(next) && next > 0 ? next : 0);
  }

  function syncPosition(event: SyntheticEvent<HTMLMediaElement>) {
    setPosition(event.currentTarget.currentTime);
  }

  function rememberVideoPosition(media: HTMLMediaElement, playing = !media.paused && !media.ended) {
    if (!stream || !videoKeyboardControls || previewOnly.current || media.error || qualityPosition.current
      || restoredMedia.current !== media || !Number.isFinite(media.duration) || !Number.isFinite(media.currentTime)) return;
    const url = media.getAttribute("src");
    if (!url) return;
    videoPosition.current = { url, playing, time: media.ended ? 0 : media.currentTime,
      rate: lastRate.current, volume: media.volume, muted: media.muted, activity: playback?.activity };
  }
  const seekVideo = useCallback((time: number) => {
    if (player.current) player.current.currentTime = time;
    setPosition(time);
  }, []);

  function positionControl(label: string) {
    const current = Math.min(position, duration);
    const input = <input type="range" aria-label={label} min={0} max={duration || 1} step={0.1}
      aria-valuetext={duration ? `${formatDuration(Math.floor(current))} of ${formatDuration(Math.floor(duration))}` : undefined}
      value={current} disabled={!duration} onInput={(event) => {
        const time = Number(event.currentTarget.value);
        if (player.current) player.current.currentTime = time;
        setPosition(time);
      }} />;
    if (!showWaveform || !waveform) return input;
    const fraction = duration ? current / duration : 0;
    return <span className="mtg-playback-waveform">
      <span className="mtg-waveform-bars" aria-hidden="true">
        {waveform.map((sample, index) => <span key={index} data-played={(index + 0.5) / waveform.length <= fraction || undefined}
          style={{ height: `${12 + sample * 88 / 31}%` }} />)}
      </span>
      {input}
    </span>;
  }

  function closePlayer(restoreFocus = true) {
    if (onClose) { onClose(); return; }
    const region = posterTarget.current;
    if (modalPlayback) {
      restoreOpenerFocus.current = restoreFocus;
      dialog.current?.close();
    } else if (region?.contains(region.ownerDocument.activeElement)) {
      restoreOpenerFocus.current = true;
      region.focus({ preventScroll: true });
    }
    manuallyOpened.current = true;
    qualityRequest.current?.abort();
    qualityRequest.current = undefined;
    qualityPosition.current = undefined;
    failedQualityPosition.current = undefined;
    videoPosition.current = undefined;
    changedVideoQuality.current = false;
    if (automaticQuality.current) {
      automaticQuality.current = false;
      selectedQuality.current = undefined;
      setVideoQuality(undefined);
    }
    setSwitchingQuality(false);
    setQualityFailed(false);
    if (playback?.queuedNote === queuedStart && playback) playback.queuedNote = undefined;
    setQueuedStart(undefined);
    resumeInViewer.current = false;
    pendingSeek.current = undefined;
    pausedForVisibility.current = null;
    imageHeight.current = 0;
    setAutoOpened(false);
    setOpened(false);
    setFullscreen(false);
    setViewportFullscreen(false);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setSrc(undefined);
    setFailed(false);
  }

  function retryPlayback() {
    pendingSeek.current ??= failedQualityPosition.current?.time ?? resumeAt.current;
    pausedForVisibility.current = null;
    setPlaying(false);
    setDuration(0);
    setSrc(undefined);
    setFailed(false);
    setQualityFailed(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  function resetToOriginalQuality() {
    if (autoOpened) openPlayer();
    automaticQuality.current = false;
    selectedQuality.current = undefined;
    setVideoQuality(undefined);
    retryPlayback();
  }

  async function changeVideoQuality(fileId?: number) {
    const media = player.current;
    if (!stream || !streamQuality || qualityRequest.current || qualityPosition.current
      || selectedQuality.current === fileId) return;
    if (fileId !== undefined && !videoQualities?.some((quality) => quality.fileId === fileId)) return;
    if (failed) {
      if (autoOpened) openPlayer();
      automaticQuality.current = false;
      selectedQuality.current = fileId;
      setVideoQuality(fileId);
      retryPlayback();
      return;
    }
    if (!media) return;
    const request = new AbortController();
    qualityRequest.current = request;
    setSwitchingQuality(true);
    setQualityFailed(false);
    try {
      const url = fileId === undefined
        ? await requestVideoStream(stream, chatId, messageId, playbackFileId)
        : await requestVideoStream(streamQuality, chatId, messageId, playbackFileId, fileId);
      if (request.signal.aborted || media !== player.current) return;
      stopVideoHold();
      qualityPosition.current = { url, time: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
        playing: !media.paused && !media.ended, rate: lastRate.current, volume: media.volume, muted: media.muted,
        activity: playback?.activity };
      if (qualityPosition.current.playing) media.pause();
      if (autoOpened) openPlayer();
      changedVideoQuality.current = true;
      automaticQuality.current = false;
      selectedQuality.current = fileId;
      setVideoQuality(fileId);
      setSrc(url);
    } catch {
      if (!request.signal.aborted) setQualityFailed(true);
    } finally {
      if (qualityRequest.current === request) {
        qualityRequest.current = undefined;
        if (!qualityPosition.current) setSwitchingQuality(false);
      }
    }
  }

  function videoFailed() {
    const replacement = qualityPosition.current;
    const last = videoPosition.current;
    const media = player.current;
    if (replacement) failedQualityPosition.current = replacement;
    else if (last && media && last.url === media.getAttribute("src")) {
      const time = media.currentTime;
      const resetClock = time === 0 && media.error && media.readyState < media.HAVE_METADATA;
      failedQualityPosition.current = { ...last, time: !resetClock && time >= 0 && time < media.duration ? time : last.time };
    }
    qualityPosition.current = undefined;
    setSwitchingQuality(false);
    setFailed(true);
  }

  function togglePlayback(element: HTMLMediaElement | null) {
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    const source = element.getAttribute("src");
    void element.play().catch((error: unknown) => {
      if (player.current !== element || source !== element.getAttribute("src")) return;
      if (error instanceof DOMException && ["AbortError", "NotAllowedError"].includes(error.name)) return;
      if (element instanceof HTMLVideoElement) videoFailed();
      else setFailed(true);
    });
  }

  function playWithSound() {
    const media = player.current;
    if (!media) return;
    if (playbackDialog && autoOpened) {
      pendingSeek.current = media.currentTime;
      media.pause();
      resumeInViewer.current = true;
      openPlayer();
      return;
    }
    openPlayer();
    media.pause();
    media.muted = false;
    media.focus({ preventScroll: true });
    void media.play().catch(() => {});
  }

  function loadPlaybackLink(id: string, message: string) {
    const position = player.current?.currentTime;
    if (!loadMessageLink || position === undefined || !Number.isFinite(position) || position < 0 || position > 2147483647) {
      return Promise.resolve(null);
    }
    const seconds = Math.floor(position);
    return seconds === 0 ? loadMessageLink(id, message) : loadMessageLink(id, message, { kind: "playback position", seconds });
  }

  const linkedPosition = startTime === undefined ? undefined : `${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, "0")}`;
  const openerLabel = loadLabel ?? (oneView ? (saved ? tr("Open saved {0}", [tr(oneView)]) : tr("View and save {0}", [tr(oneView)]))
    : linkedPosition !== undefined && !image ? tr("Load player from {0}", [linkedPosition]) : audio ? tr("Load audio player")
    : image ? tr("View image") : videoNote ? tr("Open video note") : tr("Load video player"));
  const loadStatus = (!src || failed) && <>
      {!src && !failed && <p role="status">{tr("Loading Telegram media…")}</p>}
      {failed && <>
        <p role="alert">{canRetry ? tr("Could not play this media.") : tr("Could not open this media. Close and try again.")}</p>
        {canRetry && <button type="button" className="mtg-action" onClick={retryPlayback}>{tr("Retry playback")}</button>}
        {videoQuality !== undefined && <button type="button" className="mtg-action" onClick={resetToOriginalQuality}>{tr("Play original quality")}</button>}
      </>}
  </>;
  const media = opened && <>
      {!compactAudio && !speechControls && loadStatus}
      {src && !failed && (image
        ? autoOpened && !autoPlaying
          ? <div aria-hidden="true" style={{ height: imageHeight.current, maxHeight: "min(320px, 45vh)" }} />
          : <img alt={oneView ? tr("Telegram one-view photo") : tr("Telegram image")} src={src} draggable={oneView ? false : undefined} onError={() => setFailed(true)}
            onLoad={autoOpened ? (event) => { imageHeight.current = event.currentTarget.getBoundingClientRect().height; } : undefined} />
        : audio
        ? <audio ref={attach} aria-label={tr("Telegram audio")}
          preload={stream ? "metadata" : undefined}
          tabIndex={adjustableSpeed && !compactAudio && !speechControls ? 0 : undefined} aria-keyshortcuts={adjustableSpeed && !compactAudio && !speechControls ? playbackShortcuts : undefined}
          onKeyDown={adjustableSpeed ? (event) => { if (event.target === event.currentTarget) mediaKeys(event, event.currentTarget); } : undefined}
          controls={!compactAudio && !speechControls} loop={repeatTrack} src={src} onPlay={onPlay} onPause={onPlaybackStopped} onEnded={onPlaybackEnded}
          onPlaying={voiceNote && !oneView ? onNotePlaying : undefined}
          onRateChange={syncPlaybackRate} onLoadedMetadata={restorePosition} onError={() => setFailed(true)}
          onDurationChange={restorePosition} onTimeUpdate={trackPosition ? syncPosition : undefined}
          onVolumeChange={(event) => setAudioVolume(event.currentTarget.muted ? 0 : event.currentTarget.volume)} />
        : <video ref={attach} aria-label={videoNote ? tr("Telegram video note") : tr("Telegram video")}
          tabIndex={adjustableSpeed ? 0 : undefined} aria-keyshortcuts={adjustableSpeed
            ? videoKeyboardControls
              ? videoShortcuts + (fullscreenEnabled ? fullscreenToggleShortcuts : "") + (fullscreen || viewportFullscreen ? fullscreenSeekShortcuts : "")
                + (hasChapters ? chapterShortcuts : "")
              : playbackShortcuts : undefined}
          onKeyDown={adjustableSpeed && !modalPlayback ? (event) => { if (event.target === event.currentTarget) mediaKeys(event, event.currentTarget); } : undefined}
          className={videoNote ? "mtg-video-note-preview" : undefined}
          controls={!videoNote && !modalPlayback} playsInline loop={loop} muted={loop || autoOpened}
          autoPlay={autoOpened ? autoPlaying && !changedVideoQuality.current : loop} disablePictureInPicture={!!oneView || !!loop || !!videoNote}
          src={src} poster={posterSource} onRateChange={syncPlaybackRate} onLoadedMetadata={restorePosition} onError={videoFailed}
          onPlay={onPlay} onPause={onPlaybackStopped} onEnded={onPlaybackEnded}
          onPlaying={videoNote && !oneView && !autoOpened ? onNotePlaying : undefined}
          onDurationChange={restorePosition}
          onTimeUpdate={trackPosition || videoKeyboardControls ? (event) => {
            if (trackPosition) syncPosition(event);
            rememberVideoPosition(event.currentTarget);
          } : undefined}
          onSeeked={videoKeyboardControls ? (event) => rememberVideoPosition(event.currentTarget) : undefined}
          onVolumeChange={videoKeyboardControls ? (event) => rememberVideoPosition(event.currentTarget) : undefined} />)}
    </>;
  const speedControl = src && !failed && adjustableSpeed && <label><span>{tr("Playback speed")}</span><select aria-label={tr("Playback speed")} value={speed}
    onChange={(event) => {
      if (player.current) {
        stopVideoHold();
        changePlaybackRate(Number(event.currentTarget.value), player.current);
      }
    }}>
    {playbackRates.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
  </select></label>;
  const playlistTransport = playlistControls && queue && <div role="group" aria-label={tr("Audio playlist")}>
        <button type="button" className="mtg-action" disabled={!queue.hasNeighbor(messageId, -1)}
          onClick={() => movePlaylist(-1)}>{tr("Previous track")}</button>
        <button type="button" className="mtg-action" disabled={!queue.hasNeighbor(messageId, 1)}
          onClick={() => movePlaylist(1)}>{tr("Next track")}</button>
      </div>;
  const controls = opened && <>
      {!modalPlayback && src && !failed && !switchingQuality && showSeekPreview && duration > 0 && <VideoSeekPreview key={`seek-preview:${src}`}
        source={src} duration={duration} position={position} seek={seekVideo} />}
      {(failed || src) && videoKeyboardControls && stream && streamQuality && !!videoQualities?.length && <label>{tr("Video quality")}<select value={videoQuality ?? ""} disabled={switchingQuality} onChange={(event) => {
          const value = event.currentTarget.value;
          void changeVideoQuality(value ? Number(value) : undefined);
        }}>
          <option value="">{tr("Original")}</option>
          {videoQualities.map(({ fileId, width, height }) => <option key={fileId} value={fileId}>{width} × {height}</option>)}
        </select>
        {switchingQuality && <span role="status">{tr(" Switching quality…")}</span>}
        {qualityFailed && <span role="alert">{tr(" Could not switch video quality.")}</span>}
      </label>}
      {src && !failed && autoOpened && !image && !audio && !loop &&
        <button type="button" className="mtg-action" onClick={playWithSound}>{tr("Play with sound")}</button>}
      {src && !failed && videoNote && !autoOpened && <div className="mtg-video-note-controls">
        <button type="button" className="mtg-action" onClick={() => togglePlayback(player.current)}>{playing ? tr("Pause video note") : tr("Play video note")}</button>
        {positionControl("Video note position")}
      </div>}
      {src && !failed && audio && showWaveform && positionControl("Voice note position")}
      {playlistTransport}
      {src && !failed && hasChapters && <label>{tr("Video chapters ")}<select value="" onChange={(event) => {
        if (player.current && event.currentTarget.value !== "") player.current.currentTime = Number(event.currentTarget.value);
      }}>
        <option value="" disabled>{tr("Jump to time")}</option>
        {chapterTimes.map((time) => <option key={time} value={time}>
          {Math.floor(time / 60)}:{String(time % 60).padStart(2, "0")}
        </option>)}
      </select></label>}
      {speedControl}
      {boostingVideo && <span role="status">{tr("2× while holding Space")}</span>}
      {!modalPlayback && src && !failed && fullscreenEnabled && <button type="button" className="mtg-action"
        aria-pressed={fullscreen} onClick={() => {
          player.current?.focus({ preventScroll: true });
          if (player.current) toggleFullscreen(player.current);
        }}>{fullscreen ? tr("Exit fullscreen") : tr("Fullscreen")}</button>}
      {src && !failed && canFloat && <VideoPictureInPicture key={`picture-in-picture:${src}`} player={player} />}
      {src && !failed && loadMessageLink && !image && !oneView && !loop &&
        <CopyTelegramLink chatId={chatId} messageId={messageId} load={loadPlaybackLink} kind="playback position" />}
      {!modalPlayback && <button ref={closer} type="button" className="mtg-action" aria-keyshortcuts="Escape" onClick={() => closePlayer()}>{tr("Close player")}</button>}
    </>;
  const preview = <button ref={opener} type="button" className={hasPosterSlot ? "mtg-action mtg-video-open" : "mtg-action"}
      data-poster-only={posterOnly || undefined} aria-label={posterOnly ? openerLabel : undefined}
      aria-describedby={durationLabel ? durationDescription : undefined} onClick={(event) => {
        if (!playbackDialog && event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget) {
          restoreOpenerFocus.current = false;
          posterTarget.current?.focus({ preventScroll: true });
        }
        openPlayer();
      }}>
      {hasPosterSlot && <span className={videoNote ? "mtg-video-poster mtg-video-note-poster" : "mtg-video-poster"} aria-hidden="true"
        style={posterSize && {
          width: videoNote ? 192 : `min(${posterSize.width}px, ${320 * posterSize.width / posterSize.height}px, ${45 * posterSize.width / posterSize.height}vh)`,
          aspectRatio: videoNote ? "1" : `${posterSize.width} / ${posterSize.height}`,
        }}>
        {posterSource && <img src={posterSource} alt="" onLoad={(event) => { event.currentTarget.style.visibility = ""; }}
          onError={(event) => {
            if (thumbnail.photo) thumbnail.discard();
            else event.currentTarget.style.visibility = "hidden";
          }} />}
        {durationLabel && <span className="mtg-media-duration">{durationLabel}</span>}
        {posterOnly && <span className="mtg-video-play"><Play size={20} fill="currentColor" /></span>}
      </span>}
      {!hasPosterSlot && poster && <img src={poster} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
      {!posterOnly && openerLabel}
      {!hasPosterSlot && durationLabel && <span className="mtg-media-duration" aria-hidden="true">{durationLabel}</span>}
      {durationLabel && <span id={durationDescription} hidden>{tr("Duration ")}{durationLabel}</span>}
    </button>;
  if (speechControls) return <div className="mtg-speech-player">
    {media}
    {speechControls({
      ready: !!duration && !!src && !failed,
      playing, position, duration: duration || durationSeconds || 0, speed,
      rate: (rate) => { if (player.current) changePlaybackRate(rate, player.current); },
      toggle: () => {
        if (failed) { retryPlayback(); startQueued(false); }
        else if (player.current) togglePlayback(player.current);
        else if (!opened) startQueued(false);
      },
      seek: (time) => {
        if (player.current && duration) seekVideo(Math.min(time, duration));
        else {
          pendingSeek.current = time;
          if (!opened) startQueued(false);
        }
      },
      status: opened && loadStatus,
    })}
  </div>;
  return <div className="mtg-media-player" ref={posterTarget} tabIndex={-1} onKeyDown={(event) => {
    const target = event.target;
    const media = player.current;
    if (modalPlayback || audioOverlay || !opened || event.defaultPrevented || event.key !== "Escape" || event.repeat
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      || (target !== event.currentTarget && target !== media && target !== closer.current)
      || (media && event.currentTarget.ownerDocument.fullscreenElement === media)) return;
    event.preventDefault();
    event.stopPropagation();
    closePlayer();
  }}>
    {(!opened || modalPlayback) && !compactAudio && preview}
    {modalPlayback ? <dialog ref={dialog} className="mtg-media-viewer mtg-library-video-dialog" aria-label={tr("Telegram video")}
      data-viewport-fullscreen={viewportFullscreen || undefined}
      onKeyDown={(event) => {
        const target = event.target;
        if (!adjustableSpeed || !player.current || !(target instanceof Element)
          || target.closest("input, textarea, select, [contenteditable]")
          || (event.key === " " && target.closest("button, summary, a"))) return;
        mediaKeys(event, player.current);
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (viewportFullscreen) setViewportFullscreen(false);
        else closePlayer();
      }}>
      <MediaViewerFrame closeRef={closer} close={() => closePlayer()} closeLabel={tr("Close player")}
        actions={viewerActions} details={viewerDetails?.(() => closePlayer(false))} detailsInitiallyOpen={false}>
        {src && !failed ? <CinemaVideo video={media} player={player} stage={cinemaStage} source={src} duration={duration} position={position}
          playing={playing} seek={seekVideo} toggle={() => togglePlayback(player.current)} fullscreen={fullscreen || viewportFullscreen}
          toggleFullscreen={fullscreenEnabled ? () => { if (player.current) toggleFullscreen(player.current); } : undefined}
          preview={showSeekPreview && !switchingQuality} settings={controls} shortcuts={videoKeyboardControls} />
          : opened && !failed ? <MediaViewerLoading label={tr("Loading Telegram media…")} poster={posterSource} />
          : <div className="mtg-cinema-status">{media}{controls}</div>}
      </MediaViewerFrame>
    </dialog> : <>
      {media}
      {audioOverlay ? <AudioViewer overlay={{ ...audioOverlay, details: <>{audioOverlay.details}{playlistTransport}</> }} status={loadStatus} duration={duration || durationSeconds || 0}
        peaks={audioWaveform} seekReady={!!duration && !!src && !failed} position={position} playing={playing} ready={!!src && !failed}
        seek={seekVideo} toggle={() => togglePlayback(player.current)} settings={speedControl}
        keys={(event) => { if (player.current) mediaKeys(event, player.current); }}
        volume={audioVolume} changeVolume={(volume) => {
          if (!player.current) return;
          player.current.muted = false;
          player.current.volume = volume;
          setAudioVolume(volume);
        }} /> : compactAudio ? <AudioMiniPlayer track={compactAudio} status={loadStatus}
          duration={duration || durationSeconds || 0} position={position} playing={playing} ready={!!src && !failed}
          seekReady={!!duration && !!src && !failed} seek={seekVideo} toggle={() => togglePlayback(player.current)}
          close={() => closePlayer()} /> : controls}
    </>}
  </div>;
}
