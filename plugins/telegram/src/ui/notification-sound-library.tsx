import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import { maxNotificationSoundBytes } from "../core/contract.ts";

type SavedSound = { id: string; title: string };
type SoundResult = "saved" | "unavailable" | "unknown";

export type NotificationSoundLibraryActions = {
  load: () => Promise<SavedSound[]>;
  preview: (id: string) => Promise<{ mime: "audio/mpeg" | "audio/ogg"; base64: string }>;
  add: (base64: string) => Promise<SoundResult>;
  remove: (id: string) => Promise<SoundResult>;
};

export function NotificationSoundLibrary({ actions }: { actions: NotificationSoundLibraryActions }) {
  const { t: tr } = useTelegramLocale();
  const details = useRef<HTMLDetailsElement>(null);
  const [sounds, setSounds] = useState<SavedSound[]>();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<{ id: string; src: string }>();
  const [removing, setRemoving] = useState<SavedSound>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try { setSounds(await actions.load()); }
    catch { setError("Could not load saved notification sounds."); }
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    await load();
    setBusy(false);
  }

  async function loadPreview(id: string) {
    if (busy) return;
    setPreview(undefined);
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { mime, base64 } = await actions.preview(id);
      if (details.current?.open) setPreview({ id, src: `data:${mime};base64,${base64}` });
    } catch { setError("Could not load the sound preview."); }
    finally { setBusy(false); }
  }

  async function change(run: () => Promise<SoundResult>, success: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await run();
      if (result === "saved") setNotice(success);
      else setError(result === "unavailable" ? "Telegram rejected the change." : "Telegram did not confirm the change.");
    } catch { setError("Could not verify the change."); }
    setRemoving(undefined);
    setPreview(undefined);
    await load();
    setBusy(false);
  }

  return <details ref={details} onToggle={(event) => { if (event.currentTarget.open) void refresh(); else setPreview(undefined); }}>
    <summary>{tr("Saved notification sounds")}</summary>
    <p>{tr("Use a short MP3 up to 300 KiB.")}</p>
    <label>{tr("Add MP3 ")}<input type="file" accept=".mp3,audio/mpeg" disabled={busy || !!removing} onChange={(event) => {
      const next = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (next && (!/\.mp3$/i.test(next.name) || !next.size || next.size > maxNotificationSoundBytes)) {
        setFile(undefined);
        setError("Choose an MP3 file up to 300 KiB.");
      } else {
        setError("");
        setFile(next);
      }
    }} /></label>
    {file && <p><bdi>{file.name}</bdi></p>}
    <button type="button" className="mtg-action" disabled={!file || busy || !!removing} onClick={() => {
      if (!file) return;
      void change(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await actions.add(btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")));
        if (result === "saved") setFile(undefined);
        return result;
      }, "Notification sound saved.");
    }}>{tr("Add notification sound")}</button>
    {sounds?.length === 0 && <p>{tr("No saved notification sounds.")}</p>}
    {!!sounds?.length && <ul>{sounds.map((sound) => <li key={sound.id}>
      <bdi>{sound.title}</bdi>{" "}
      <button type="button" className="mtg-action" disabled={busy || !!removing}
        onClick={() => preview?.id === sound.id ? setPreview(undefined) : void loadPreview(sound.id)}>
        {preview?.id === sound.id ? tr("Close preview") : tr("Preview sound")}
      </button>{" "}
      {preview?.id === sound.id && <audio aria-label={tr("Notification sound preview")} controls src={preview.src}
        onError={() => { setPreview(undefined); setError("This sound could not be played."); }} />}
      <button type="button" className="mtg-action" disabled={busy || !!removing}
        onClick={() => setRemoving(sound)}>{tr("Remove sound")}</button>
    </li>)}</ul>}
    {removing && <div role="group" aria-label={tr("Remove saved notification sound")}>
      <p>{tr("Remove ")}<bdi>{removing.title}</bdi>{tr(" from your Telegram account?")}</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setRemoving(undefined)}>{tr("Cancel")}</button>{" "}
      <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void change(() => actions.remove(removing.id), "Notification sound removed.")}>{tr("Remove from Telegram")}</button>
    </div>}
    {busy && <p role="status">{tr("Working…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button type="button" className="mtg-action" disabled={busy || !!removing} onClick={() => void refresh()}>{tr("Refresh saved sounds")}</button>
  </details>;
}
