import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { maxVideoNoteBytes, maxVoiceBytes, type SendResult, type VideoNoteRecording, type VoiceRecording } from "../core/contract.ts";
import { encodeRecording, readVoiceFile, useNoteCapture, VideoNoteControls, VoiceNoteControls, type CapturedNote } from "./note-recorder.tsx";

export type InboxNoteRecording = ({ kind: "voice" } & VoiceRecording) | ({ kind: "video" } & VideoNoteRecording);

export function ChannelInboxNote({ kind, reply, disabled, close, send }: {
  kind: InboxNoteRecording["kind"];
  reply: ReactNode;
  disabled: boolean;
  close: () => void;
  send: (recording: InboxNoteRecording) => Promise<SendResult>;
}) {
  const { t: tr } = useTelegramLocale();
  const capture = useNoteCapture();
  const [note, setNote] = useState<CapturedNote>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function choose(file: File) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    try {
      const chosen = await readVoiceFile(file);
      if (active.current) setNote({ kind: "voice", note: chosen });
    } catch {
      if (active.current) setStatus("Choose a playable voice file up to two minutes and 4 MiB.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const label = kind === "voice" ? tr("Voice note") : tr("Video note");
  async function submit(recording: CapturedNote) {
    if (disabled || uncertain || pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    try {
      const base64 = await encodeRecording(recording.note.blob, recording.kind === "voice" ? maxVoiceBytes : maxVideoNoteBytes);
      if (!active.current) return;
      const result = await send(recording.kind === "voice"
        ? { kind: "voice", base64, duration: recording.note.seconds, format: recording.note.format, trim: recording.note.trim }
        : { kind: "video", base64, format: recording.note.format })
        .catch(() => ({ state: "unknown" as const }));
      if (!active.current) return;
      if (result.state === "sent") close();
      else if (result.state === "failed") setStatus(tr("Could not send the {0}. Your recording is still here.", [label.toLowerCase()]));
      else {
        setUncertain(true);
        setStatus("Telegram did not confirm delivery. Check the conversation before retrying.");
      }
    } catch {
      if (active.current) setStatus("Could not read the recording.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const controls = { capture, disabled: disabled || busy || uncertain || capture.preparing, record: () => {
    setStatus("");
    setNote(undefined);
    void capture.record(kind, setNote, setStatus);
  } };
  return <fieldset className="mtg-channel-inbox-composer">
    <legend>{label}</legend>
    {reply}
    {kind === "voice" ? <VoiceNoteControls {...controls} note={note?.kind === "voice" ? note.note : undefined}
      choose={(file) => void choose(file)}
      change={(trim) => setNote((current) => current?.kind === "voice" ? { kind: "voice", note: { ...current.note, trim } } : current)}
      send={(note) => void submit({ kind: "voice", note })} />
      : <VideoNoteControls {...controls} note={note?.kind === "video" ? note.note : undefined} status={setStatus}
        change={(note) => setNote(note && { kind: "video", note })} send={(note) => void submit({ kind: "video", note })} />}
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr("Discard ")}{label.toLowerCase()}</button>
    {status && <p role="status">{tr(status)}</p>}
    {uncertain && <button type="button" className="mtg-action" onClick={() => {
      setUncertain(false);
      setStatus("");
    }}>{tr("Allow retry")}</button>}
  </fieldset>;
}
