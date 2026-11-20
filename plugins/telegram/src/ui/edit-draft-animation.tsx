import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { animationTrim, type AnimationTrim } from "../core/contract.ts";

export function EditDraftAnimation({ file, value, disabled, apply }: {
  file: File; value?: AnimationTrim; disabled?: boolean; apply: (value?: AnimationTrim) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [opened, setOpened] = useState<File>();
  return <div className="mtg-video-draft-actions">
    <button type="button" className="mtg-action" disabled={disabled} onClick={() => setOpened(file)}>
      {value ? tr("Change GIF trim") : tr("Trim GIF")}
    </button>
    {value && <button type="button" className="mtg-action" disabled={disabled} onClick={() => apply(undefined)}>{tr("Reset GIF trim")}</button>}
    {opened === file && !disabled && <AnimationEditor file={file} value={value} close={() => setOpened(undefined)}
      apply={(trim) => { apply(trim); setOpened(undefined); }} />}
  </div>;
}

function AnimationEditor({ file, value, apply, close }: {
  file: File; value?: AnimationTrim; apply: (value: AnimationTrim) => void; close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gif = useRef<{ decoder: ImageDecoder; frames: number[] }>(undefined);
  const play = useRef<AbortController>(undefined);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(String((value?.startMs ?? 0) / 1000));
  const [end, setEnd] = useState(value ? String(value.endMs / 1000) : "");
  const [failed, setFailed] = useState(false);
  const isGif = /\.gif$/i.test(file.name);

  function loadDuration(milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 250 || milliseconds > 2147483647) {
      setFailed(true);
      return;
    }
    setDuration(milliseconds);
    setEnd((current) => current || String(milliseconds / 1000));
  }

  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    panel.showModal();
    const video = preview.current;
    let decoder: ImageDecoder | undefined;
    let closed = false;
    if (video) video.src = URL.createObjectURL(file);
    else void (async () => {
      if (typeof ImageDecoder !== "function" || file.size > 32 * 1024 * 1024) throw new Error("Local GIF preview unavailable.");
      const data = await file.arrayBuffer();
      if (closed) return;
      const header = new DataView(data);
      if (header.byteLength < 10 || header.getUint16(6, true) * header.getUint16(8, true) > 16_777_216) {
        throw new Error("GIF dimensions exceed the preview limit.");
      }
      decoder = new ImageDecoder({ type: "image/gif", data, preferAnimation: true });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (count < 1 || count > 600) throw new Error("GIF preview frame limit.");
      const frames: number[] = [];
      let total = 0;
      for (let index = 0; index < count && !closed; index++) {
        const { image } = await decoder.decode({ frameIndex: index });
        try {
          frames.push(total);
          total += Math.max(20, Math.round((image.duration ?? 100000) / 1000));
          if (index === 0 && !closed) drawGifFrame(canvas.current, image);
        } finally { image.close(); }
      }
      if (closed) return;
      frames.push(total);
      gif.current = { decoder, frames };
      loadDuration(total);
    })().catch(() => { if (!closed) setFailed(true); });
    return () => {
      closed = true;
      play.current?.abort();
      gif.current = undefined;
      decoder?.close();
      if (video) {
        URL.revokeObjectURL(video.src);
        video.removeAttribute("src");
        video.load();
      }
      panel.close();
    };
  }, [file]);

  const pending = animationTrim.safeParse({ startMs: Math.round(Number(start) * 1000), endMs: Math.round(Number(end) * 1000) });
  const range = pending.success && pending.data.endMs <= duration ? pending.data : undefined;

  function playSelection() {
    if (!range) return;
    play.current?.abort();
    const controller = new AbortController();
    play.current = controller;
    const { signal } = controller;
    const video = preview.current;
    if (video) {
      video.currentTime = range.startMs / 1000;
      void video.play().catch(() => { if (!signal.aborted) setFailed(true); });
      return;
    }
    const timeline = gif.current;
    if (!timeline) return;
    let index = Math.max(0, timeline.frames.findIndex((time) => time > range.startMs) - 1);
    let timer: number | undefined;
    signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
    const next = async () => {
      if (signal.aborted || timeline.frames[index]! >= range.endMs) return;
      try {
        const { image } = await timeline.decoder.decode({ frameIndex: index });
        try { if (!signal.aborted) drawGifFrame(canvas.current, image); }
        finally { image.close(); }
        if (signal.aborted) return;
        const nextTime = timeline.frames[index + 1]!;
        const delay = Math.min(nextTime, range.endMs) - Math.max(timeline.frames[index]!, range.startMs);
        index++;
        timer = window.setTimeout(() => void next(), delay);
      } catch { if (!signal.aborted) setFailed(true); }
    };
    void next();
  }

  return <dialog ref={dialog} className="mtg-draft-video-editor" aria-label={tr("Trim GIF")}
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); close(); }}>
    <h3>{tr("Trim GIF")}</h3>
    {isGif ? <canvas ref={canvas} className="mtg-gif-trim-preview" aria-label={tr("GIF frame preview")} />
      : <video ref={preview} aria-label={tr("GIF video preview")} controls muted playsInline preload="metadata"
        onLoadedMetadata={({ currentTarget }) => loadDuration(Math.floor(currentTarget.duration * 1000))}
        onError={() => setFailed(true)} onTimeUpdate={({ currentTarget }) => {
          if (play.current && range && currentTarget.currentTime * 1000 >= range.endMs) {
            play.current = undefined;
            currentTarget.pause();
          }
        }} />}
    {failed ? <p role="alert">{tr("BB could not preview this GIF for trimming. You can still send the original.")}</p>
      : !duration ? <p role="status">{tr("Loading GIF preview…")}</p> : <>
        <div className="mtg-video-draft-actions">
          <label>{tr("Start (seconds)")}<input type="number" min="0" max={duration / 1000} step="0.001" value={start}
            onChange={(event) => setStart(event.currentTarget.value)} /></label>
          <label>{tr("End (seconds)")}<input type="number" min="0" max={duration / 1000} step="0.001" value={end}
            onChange={(event) => setEnd(event.currentTarget.value)} /></label>
        </div>
        {!range && <p role="status">{tr("Select at least 0.25 seconds within the animation.")}</p>}
        <button type="button" className="mtg-action" disabled={!range} onClick={playSelection}>{tr("Play selected range")}</button>
      </>}
    <div className="mtg-video-draft-actions">
      <button type="button" className="mtg-action" disabled={!range || failed} onClick={() => { if (range) apply(range); }}>{tr("Apply GIF trim")}</button>
      <button type="button" className="mtg-action" onClick={close}>{tr("Cancel")}</button>
    </div>
  </dialog>;
}

function drawGifFrame(canvas: HTMLCanvasElement | null, frame: VideoFrame) {
  if (!canvas) return;
  const scale = Math.min(1, 640 / Math.max(frame.displayWidth, frame.displayHeight));
  const width = Math.max(1, Math.round(frame.displayWidth * scale));
  const height = Math.max(1, Math.round(frame.displayHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, width, height);
  context?.drawImage(frame, 0, 0, width, height);
}
