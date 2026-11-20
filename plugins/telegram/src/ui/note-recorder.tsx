import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { maxVideoNoteBytes, maxVoiceBytes, type VideoNoteRecording, type VoiceRecording, type VoiceTrim } from "../core/contract.ts";
import { announceRecording, type DispatchRecordingActivity } from "./recording-activity.ts";
import { VoiceTrimPreview } from "./voice-trim-preview.tsx";

type Format = VoiceRecording["format"];
export type VoiceNoteDraft = { blob: Blob; seconds: number; format: Format; decoded?: AudioBuffer; trim?: VoiceTrim };
export type VideoNoteDraft = { blob: Blob; format: VideoNoteRecording["format"] };
export type CapturedNote = { kind: "voice"; note: VoiceNoteDraft } | { kind: "video"; note: VideoNoteDraft };

const voiceFormats: readonly { format: Format; mime: string }[] = [
  { format: "ogg", mime: "audio/ogg;codecs=opus" },
  { format: "webm", mime: "audio/webm;codecs=opus" },
  { format: "mp4", mime: "audio/mp4" },
];
const videoFormats: readonly { format: VideoNoteDraft["format"]; mime: string }[] = [
  { format: "webm", mime: "video/webm;codecs=vp8,opus" },
  { format: "mp4", mime: "video/mp4" },
];

export function useNoteCapture() {
  const [preparing, setPreparing] = useState(false);
  const [recording, setRecording] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);
  const current = useRef<{ recorder: MediaRecorder; release: () => void }>(undefined);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const capture = current.current;
      if (!capture) return;
      capture.recorder.onstop = null;
      capture.recorder.onerror = null;
      try {
        if (capture.recorder.state !== "inactive") capture.recorder.stop();
      } finally {
        capture.release();
      }
    };
  }, []);

  async function record(kind: "voice" | "video", complete: (result: CapturedNote) => void, fail: (message: string) => void,
    activity?: DispatchRecordingActivity) {
    if (!active.current || pending.current || current.current) return;
    const video = kind === "video";
    const encoding = typeof MediaRecorder !== "undefined" && (video ? videoFormats : voiceFormats)
      .find(({ mime }) => MediaRecorder.isTypeSupported(mime));
    if (!encoding || !navigator.mediaDevices?.getUserMedia) {
      fail(video ? "Camera recording is unavailable in this browser. Choose a video file."
        : "Microphone recording is unavailable in this browser. Choose a voice file.");
      return;
    }
    pending.current = true;
    setPreparing(true);
    let input: MediaStream | undefined;
    try {
      input = await navigator.mediaDevices.getUserMedia({ audio: true,
        ...(video ? { video: { width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } } : {}) });
      const stream = input;
      if (!active.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: encoding.mime, audioBitsPerSecond: 32_000,
        ...(video ? { videoBitsPerSecond: 650_000 } : {}) });
      const chunks: Blob[] = [];
      const started = performance.now();
      const secondsLimit = video ? 60 : 120;
      const sizeLimit = video ? maxVideoNoteBytes : maxVoiceBytes;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let endActivity: (() => void) | undefined;
      function release() {
        clearTimeout(timer);
        endActivity?.();
        stream.getTracks().forEach((track) => track.stop());
        current.current = undefined;
      }
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onstop = () => {
        release();
        if (!active.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: encoding.mime });
        if (!blob.size || blob.size > sizeLimit) {
          fail(video ? "Could not capture a video note up to 8 MiB." : "Could not capture a voice note up to 4 MiB.");
          return;
        }
        const format = encoding.format;
        if (video && format !== "ogg") complete({ kind, note: { blob, format } });
        else complete({ kind: "voice", note: { blob, format,
          seconds: Math.min(secondsLimit, Math.max(1, Math.round((performance.now() - started) / 1000))) } });
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        release();
        if (!active.current) return;
        setRecording(false);
        fail(video ? "Could not record video." : "Could not record audio.");
      };
      recorder.start();
      current.current = { recorder, release };
      endActivity = activity && announceRecording(activity, kind);
      timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, secondsLimit * 1000);
      setRecording(true);
    } catch {
      input?.getTracks().forEach((track) => track.stop());
      if (active.current) fail(video ? "Could not start camera recording." : "Could not start microphone recording.");
    } finally {
      pending.current = false;
      if (active.current) setPreparing(false);
    }
  }

  return { preparing, recording, record, stop: () => {
    if (current.current?.recorder.state === "recording") current.current.recorder.stop();
  } };
}

export async function encodeRecording(blob: Blob, limit: number): Promise<string> {
  if (!blob.size || blob.size > limit) throw new Error("Invalid recording size.");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const data = typeof reader.result === "string" && /;base64,([A-Za-z0-9+/]+={0,2})$/.exec(reader.result)?.[1];
      if (data) resolve(data);
      else reject(new Error("Could not encode the recording."));
    };
    reader.readAsDataURL(blob);
  });
}

export async function readVoiceFile(file: File): Promise<VoiceNoteDraft> {
  if (!/\.(ogg|webm|m4a|mp4)$/i.test(file.name) || !file.size || file.size > maxVoiceBytes) {
    throw new Error("Choose a playable voice file up to 4 MiB.");
  }
  const format = /\.ogg$/i.test(file.name) ? "ogg" : /\.webm$/i.test(file.name) ? "webm" : "mp4";
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 120) {
      throw new Error("Voice file exceeds 120 seconds.");
    }
    return { blob: file, format, seconds: Math.max(1, Math.round(decoded.duration)), decoded };
  } finally {
    await context.close();
  }
}

export function VoiceNoteControls({ note, capture, disabled, scheduled, record, choose, change, send }: {
  note: VoiceNoteDraft | undefined;
  capture: Pick<ReturnType<typeof useNoteCapture>, "recording" | "stop">;
  disabled: boolean;
  scheduled?: boolean;
  record: () => void;
  choose: (file: File) => void;
  change: (trim: VoiceTrim | undefined) => void;
  send: (note: VoiceNoteDraft) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
    {capture.recording ? <button type="button" className="mtg-action" onClick={capture.stop}>{tr("Stop recording")}</button>
      : <>
        <button type="button" className="mtg-action" disabled={disabled} onClick={record}>{tr("Record voice")}</button>
        <input type="file" accept=".ogg,.webm,.m4a,.mp4" aria-label={tr("Choose voice file")} disabled={disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) choose(file);
          }} />
      </>}
    {note && <>
      <VoiceTrimPreview blob={note.blob} decoded={note.decoded} trim={note.trim} disabled={disabled} change={change} />
      <button type="button" className="mtg-action" disabled={disabled} onClick={() => send(note)}>
        {scheduled ? tr("Schedule voice note") : tr("Send voice note")}</button>
    </>}
  </>;
}

export function VideoNoteControls({ note, capture, disabled, scheduled, record, change, send, status }: {
  note: VideoNoteDraft | undefined;
  capture: Pick<ReturnType<typeof useNoteCapture>, "recording" | "stop">;
  disabled: boolean;
  scheduled?: boolean;
  record: () => void;
  change: (note?: VideoNoteDraft) => void;
  send: (note: VideoNoteDraft) => void;
  status: (text: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  const blob = note?.blob;
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(blob);
    setPreview({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  return <>
    {capture.recording ? <button type="button" className="mtg-action" onClick={capture.stop}>{tr("Stop video recording")}</button>
      : <>
        <button type="button" className="mtg-action" disabled={disabled} onClick={record}>{tr("Record video note")}</button>
        <input type="file" accept=".webm,.mp4,video/webm,video/mp4" aria-label={tr("Choose video note file")} disabled={disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            if (!/\.(webm|mp4)$/i.test(file.name) || !file.size || file.size > maxVideoNoteBytes) {
              change(undefined);
              status("Choose a WebM or MP4 video up to 8 MiB.");
              return;
            }
            status("");
            change({ blob: file, format: /\.webm$/i.test(file.name) ? "webm" : "mp4" });
          }} />
      </>}
    {preview && preview.blob === blob && <video className="mtg-video-note-preview" src={preview.url} aria-label={tr("Video note preview")} controls playsInline
      onLoadedMetadata={(event) => {
        if (event.currentTarget.duration > 60.5) status("Telegram will receive the first 60 seconds.");
      }} onError={() => { change(undefined); status("Could not read this video file."); }} />}
    {note && <button type="button" className="mtg-action" disabled={disabled} onClick={() => send(note)}>
      {scheduled ? tr("Schedule video note") : tr("Send video note")}
    </button>}
  </>;
}
