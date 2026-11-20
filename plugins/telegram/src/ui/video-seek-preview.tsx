import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef } from "react";

export function formatPlaybackTime(seconds: number) {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const short = `${minutes % 60}:${String(whole % 60).padStart(2, "0")}`;
  return minutes < 60 ? short : `${Math.floor(minutes / 60)}:${short.padStart(5, "0")}`;
}

function setSliderPosition(slider: HTMLInputElement, time: number, duration: number) {
  const value = Math.min(duration, Math.max(0, time));
  slider.value = String(value);
  slider.style.setProperty("--mtg-played", `${value / duration * 100}%`);
  slider.setAttribute("aria-valuetext", `${formatPlaybackTime(value)} of ${formatPlaybackTime(duration)}`);
}

export function VideoSeekPreview({ source, duration, position, seek, compact }: {
  source: string;
  duration: number;
  position: number;
  seek: (time: number) => void;
  compact?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const slider = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const pointer = useRef<number | undefined>(undefined);
  const lastPosition = useRef(position);

  useEffect(() => {
    lastPosition.current = position;
    if (slider.current && pointer.current === undefined) setSliderPosition(slider.current, position, duration);
  }, [position, duration]);

  useEffect(() => {
    const input = slider.current;
    const bubble = card.current;
    const video = preview.current;
    const timestamp = label.current;
    if (!input || !bubble || !video || !timestamp) return;
    const events = new AbortController();
    const { signal } = events;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pointedSecond: number | undefined;
    let requestedSecond: number | undefined;

    const seekFrame = () => {
      if (requestedSecond === undefined || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const time = Math.min(requestedSecond, Math.max(0, video.duration - 0.05));
      if (Math.abs(video.currentTime - time) > 0.05) video.currentTime = time;
      else if (requestedSecond === pointedSecond && !video.seeking && video.readyState >= video.HAVE_CURRENT_DATA) {
        video.dataset.frameReady = "true";
      }
    };
    const show = (time: number) => {
      const second = Math.floor(time);
      if (pointedSecond === second) return;
      pointedSecond = second;
      timestamp.textContent = formatPlaybackTime(second);
      bubble.hidden = false;
      video.dataset.frameReady = "false";
      clearTimeout(timer);
      timer = setTimeout(() => {
        requestedSecond = second;
        if (!video.hasAttribute("src")) video.setAttribute("src", source);
        seekFrame();
      }, 180);
    };
    const hide = () => {
      clearTimeout(timer);
      pointedSecond = requestedSecond = undefined;
      bubble.hidden = true;
      video.dataset.frameReady = "false";
      if (video.hasAttribute("src")) {
        video.removeAttribute("src");
        video.load();
      }
    };
    const pointerTime = (event: PointerEvent) => {
      const bounds = input.getBoundingClientRect();
      return bounds.width && Number.isFinite(event.clientX)
        ? duration * Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) : undefined;
    };
    input.addEventListener("pointermove", (event) => {
      const dragging = pointer.current === event.pointerId;
      if (!dragging && (pointer.current !== undefined || event.pointerType === "touch")) return;
      const time = pointerTime(event);
      if (time === undefined) return;
      if (dragging) setSliderPosition(input, time, duration);
      show(time);
    }, { signal });
    input.addEventListener("pointerleave", () => { if (pointer.current === undefined) hide(); }, { signal });
    input.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      const time = pointerTime(event);
      if (time === undefined) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      pointer.current = event.pointerId;
      input.setPointerCapture?.(event.pointerId);
      setSliderPosition(input, time, duration);
      show(time);
    }, { signal });
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      pointer.current = undefined;
      if (event.type === "pointerup") {
        const time = pointerTime(event) ?? Number(input.value);
        setSliderPosition(input, time, duration);
        seek(time);
      }
      else setSliderPosition(input, lastPosition.current, duration);
      hide();
    };
    input.addEventListener("pointerup", finish, { signal });
    input.addEventListener("pointercancel", finish, { signal });
    input.addEventListener("lostpointercapture", finish, { signal });
    input.addEventListener("blur", () => {
      pointer.current = undefined;
      setSliderPosition(input, lastPosition.current, duration);
      hide();
    }, { signal });
    input.addEventListener("input", () => {
      const time = Number(input.value);
      setSliderPosition(input, time, duration);
      if (pointer.current === undefined) seek(time);
      else show(time);
    }, { signal });
    video.addEventListener("loadedmetadata", seekFrame, { signal });
    video.addEventListener("loadeddata", seekFrame, { signal });
    video.addEventListener("seeked", seekFrame, { signal });
    video.addEventListener("error", () => { video.dataset.frameReady = "false"; }, { signal });
    return () => {
      events.abort();
      pointer.current = undefined;
      hide();
    };
  }, [source, duration, seek]);

  return <div className="mtg-video-seek">
    <label>{!compact && tr("Video seek preview ")}<input ref={slider} type="range" dir="ltr" min={0} max={duration} step="any"
      aria-label={compact ? tr("Video position") : undefined} /></label>
    <div ref={card} className="mtg-video-seek-frame" aria-hidden="true" hidden>
      <video ref={preview} muted playsInline preload="metadata" data-frame-ready="false" />
      <span ref={label} />
    </div>
  </div>;
}
