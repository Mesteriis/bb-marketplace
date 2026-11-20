import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { videoEdit, videoEditAudioKbps, videoEditQuality, type VideoEdit } from "../core/contract.ts";
import { formatSize } from "./format-size.ts";

export function EditDraftVideo({ file, value, disabled, itemLabel, apply }: {
  file: File;
  value?: VideoEdit;
  disabled?: boolean;
  itemLabel?: string;
  apply: (value?: VideoEdit) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [openedFile, setOpenedFile] = useState<File>();
  const editLabel = value ? tr("Change video edits") : tr("Edit video");
  return <div className="mtg-video-draft-actions">
    <button type="button" className="mtg-action" disabled={disabled}
      aria-label={itemLabel ? tr("{0} for {1}", [editLabel, itemLabel]) : undefined} onClick={() => setOpenedFile(file)}>
      {editLabel}
    </button>
    {value && <button type="button" className="mtg-action" disabled={disabled}
      aria-label={itemLabel ? tr("Reset video edits for {0}", [itemLabel]) : undefined}
      onClick={() => apply(undefined)}>{tr("Reset video edits")}</button>}
    {openedFile === file && !disabled && <VideoEditor file={file} value={value} close={() => setOpenedFile(undefined)}
      apply={(edit) => { apply(edit); setOpenedFile(undefined); }} />}
  </div>;
}

function VideoEditor({ file, value, close, apply }: {
  file: File;
  value?: VideoEdit;
  close: () => void;
  apply: (edit: VideoEdit) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const playingTrim = useRef(false);
  const [durationMs, setDurationMs] = useState(0);
  const [start, setStart] = useState(String((value?.startMs ?? 0) / 1000));
  const [end, setEnd] = useState(value ? String(value.endMs / 1000) : "");
  const [selectedQuality, setQuality] = useState<VideoEdit["quality"]>(value?.quality ?? "original");
  const [coverMs, setCoverMs] = useState(value?.coverMs);
  const [unavailable, setUnavailable] = useState(false);
  useLayoutEffect(() => {
    const panel = dialog.current;
    const video = preview.current;
    if (!panel || !video) return;
    const url = URL.createObjectURL(file);
    video.src = url;
    panel.showModal();
    return () => {
      panel.close();
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const startMs = Math.round(Number.parseFloat(start) * 1000);
  const endMs = Math.round(Number.parseFloat(end) * 1000);
  const fullRange = startMs === 0 && endMs === durationMs;
  const quality = selectedQuality === "original" && !fullRange ? "720" : selectedQuality;
  const trim = videoEdit.safeParse({ startMs, endMs, quality });
  const validTrim = durationMs > 0 && endMs <= durationMs && trim.success;
  const pending = videoEdit.safeParse({ startMs, endMs, quality, coverMs });
  const estimatedBytes = quality === "original" ? file.size
    : (endMs - startMs) * (videoEditQuality[quality].kbps + videoEditAudioKbps) / 8;

  return <dialog className="mtg-draft-video-editor" ref={dialog} aria-label={tr("Edit video")}
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); close(); }}>
    <h3>{tr("Edit video")}</h3>
    <video ref={preview} controls playsInline preload="metadata" aria-label={tr("Draft video preview")}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        const ms = Math.floor(video.duration * 1000);
        if (!Number.isSafeInteger(ms) || ms < 250 || ms > 2147483647) {
          setUnavailable(true);
          return;
        }
        setDurationMs(ms);
        if (value) video.currentTime = (value.coverMs ?? value.startMs) / 1000;
        else setEnd(String(ms / 1000));
      }}
      onError={() => setUnavailable(true)}
      onTimeUpdate={(event) => {
        if (playingTrim.current && event.currentTarget.currentTime >= endMs / 1000) {
          playingTrim.current = false;
          event.currentTarget.pause();
        }
      }} />
    {unavailable ? <p role="alert">{tr("BB could not preview this video. You can still attach the original file.")}</p>
      : !durationMs ? <p role="status">{tr("Loading video preview…")}</p> : <>
        <div className="mtg-video-draft-actions">
          <label>{tr("Start (seconds)")}<input type="number" min="0" max={durationMs / 1000} step="0.001" value={start}
            onChange={(event) => setStart(event.currentTarget.value)} /></label>
          <label>{tr("End (seconds)")}<input type="number" min="0" max={durationMs / 1000} step="0.001" value={end}
            onChange={(event) => setEnd(event.currentTarget.value)} /></label>
          <label>{tr("Quality")}<select value={quality} onChange={(event) => setQuality(event.currentTarget.value as VideoEdit["quality"])}>
            <option value="original" disabled={!fullRange}>{tr("Original")}</option>
            <option value="480">{tr("Up to 480 px")}</option><option value="720">{tr("Up to 720 px")}</option><option value="1080">{tr("Up to 1080 px")}</option>
          </select></label>
        </div>
        {validTrim ? <p>{tr("Estimated size ")}{formatSize(estimatedBytes)}</p> : <p role="status">{tr("Select at least 0.25 seconds within the video.")}</p>}
        <div className="mtg-video-draft-actions">
          <button type="button" className="mtg-action" disabled={!validTrim} onClick={() => {
            const video = preview.current;
            if (!video) return;
            playingTrim.current = true;
            video.currentTime = startMs / 1000;
            void video.play().catch(() => { playingTrim.current = false; });
          }}>{tr("Play selected range")}</button>
          <button type="button" className="mtg-action" disabled={!validTrim} onClick={() => {
            const video = preview.current;
            if (!video) return;
            playingTrim.current = false;
            video.pause();
            const frameMs = Math.max(startMs, Math.min(endMs - 1, Math.round(video.currentTime * 1000)));
            video.currentTime = frameMs / 1000;
            setCoverMs(frameMs);
          }}>{tr("Use current frame as cover")}</button>
          {coverMs !== undefined && <button type="button" className="mtg-action" onClick={() => setCoverMs(undefined)}>{tr("Clear cover")}</button>}
        </div>
        {coverMs !== undefined && <p role="status">{pending.success
          ? tr("Cover at {0} s", [coverMs / 1000]) : tr("Select a cover inside the trimmed range or clear it.")}</p>}
      </>}
    <div className="mtg-video-draft-actions">
      <button type="button" className="mtg-action" disabled={unavailable || !validTrim || !pending.success}
        onClick={() => { if (pending.success && validTrim) apply(pending.data); }}>{tr("Apply video edits")}</button>
      <button type="button" className="mtg-action" onClick={close}>{tr("Cancel")}</button>
    </div>
  </dialog>;
}
