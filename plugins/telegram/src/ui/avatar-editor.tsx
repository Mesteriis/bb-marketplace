import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { avatarVideoTrim, maxAvatarVideoSourceBytes, type AvatarVideoTrim, type SaveAvatarResult } from "../core/contract.ts";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";

export function AvatarEditor({ label, version, disabled, save, saveVideo, remove, canRemove, reload }: {
  label: "chat photo" | "profile photo" | "community photo" | "personal contact photo" | "public profile photo";
  version: string | null;
  disabled?: boolean;
  save: (base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  saveVideo?: (base64: string, expected: string | null, coverSeconds: number, trim?: AvatarVideoTrim) => Promise<SaveAvatarResult>;
  remove?: (expected: string) => Promise<SaveAvatarResult>;
  canRemove?: boolean;
  reload: () => Promise<{ version: string | null | undefined; canRemove: boolean }>;
}) {
  const { t: tr } = useTelegramLocale();
  const [current, setCurrent] = useState<string | null | undefined>(version);
  const [pending, setPending] = useState<string>();
  const [video, setVideo] = useState<{ file: File; url: string }>();
  const [videoReady, setVideoReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState("0");
  const [trimEnd, setTrimEnd] = useState("");
  const [coverSeconds, setCoverSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removable, setRemovable] = useState(canRemove ?? false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const blocked = busy || disabled;
  const range = avatarVideoTrim.safeParse({
    start: trimStart === "" ? NaN : Number(trimStart), end: trimEnd === "" ? NaN : Number(trimEnd),
  }).data;
  const validRange = range !== undefined && range.end <= duration;
  const selectedCover = range && coverSeconds >= range.start && coverSeconds < range.end ? coverSeconds : range?.start ?? 0;
  useEffect(() => () => { if (video) URL.revokeObjectURL(video.url); }, [video]);

  async function refresh() {
    const next = await reload().catch(() => undefined);
    setCurrent(next?.version);
    setRemovable(next?.canRemove ?? false);
    return next?.version !== undefined;
  }

  async function choose(file?: File) {
    if (!file || blocked) return;
    setError("");
    setNotice("");
    setConfirmRemove(false);
    setPending(undefined);
    setVideo(undefined);
    if (!isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes) {
      setError("Choose a non-empty JPEG, PNG, or WebP photo up to 64 MiB.");
      return;
    }
    setBusy(true);
    try { setPending(await preparePhoto(file, true)); }
    catch { setError(tr("Could not prepare the {0}.", [tr(label)])); }
    finally { setBusy(false); }
  }

  function chooseVideo(file?: File) {
    if (!file || blocked) return;
    setNotice("");
    setError("");
    setConfirmRemove(false);
    setPending(undefined);
    setVideo(undefined);
    setVideoReady(false);
    setCoverSeconds(0);
    if (!/\.(mp4|mov)$/i.test(file.name) || !file.size || file.size > maxAvatarVideoSourceBytes) {
      setError("Choose an MP4 or MOV video up to 4 MB.");
      return;
    }
    setVideo({ file, url: URL.createObjectURL(file) });
  }

  async function sendVideo() {
    if (!video || !videoReady || !validRange || !saveVideo || current === undefined) return "unavailable" as const;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the avatar video."));
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
        if (value) resolve(value);
        else reject(new Error("Invalid avatar video."));
      };
      reader.readAsDataURL(video.file);
    });
    return range.start === 0 && range.end === duration
      ? saveVideo(data, current, selectedCover)
      : saveVideo(data, current, selectedCover, range);
  }

  async function submit(action: () => Promise<SaveAvatarResult>, success: string) {
    if (blocked) return;
    setBusy(true);
    setError("");
    setNotice("");
    setConfirmRemove(false);
    try {
      const result = await action();
      if (result === "saved") {
        setPending(undefined);
        setVideo(undefined);
        setNotice(success);
        await refresh();
      } else if (result === "changed" || result === "unknown") {
        setCurrent(undefined);
        setPending(undefined);
        setVideo(undefined);
        setError(result === "changed" ? tr("The {0} changed in Telegram. Reload before trying again.", [tr(label)])
          : "Telegram did not confirm the photo update. Reload it before retrying.");
      } else setError(tr("Telegram could not update the {0}.", [tr(label)]));
    } catch {
      setCurrent(undefined);
      setPending(undefined);
      setVideo(undefined);
      setError(tr("Could not confirm the {0} update. Reload it before retrying.", [tr(label)]));
    } finally { setBusy(false); }
  }

  return <form className="mtg-avatar-editor" onSubmit={(event) => {
    event.preventDefault();
    if (pending && current !== undefined) void submit(() => save(pending, current), "Photo saved.");
    else if (video && videoReady) void submit(sendVideo, "Video avatar saved.");
  }}>
    {current !== undefined && <label>{tr("Choose ")}{label} <input type="file" accept={photoAccept} disabled={blocked}
      onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} /></label>}
    {current !== undefined && saveVideo && <label>{tr("Choose video avatar ")}<input type="file" accept=".mp4,.mov,video/mp4,video/quicktime" disabled={blocked}
      onChange={(event) => { chooseVideo(event.target.files?.[0]); event.target.value = ""; }} /></label>}
    {video && <>
      <video key={video.url} className="mtg-avatar-video-preview" aria-label={tr("Video avatar preview")} controls muted playsInline preload="metadata"
        src={video.url} onLoadedMetadata={({ currentTarget }) => {
          const { duration, videoWidth, videoHeight } = currentTarget;
          const valid = Number.isFinite(duration) && duration > 0 && duration <= 120
            && Math.min(videoWidth, videoHeight) >= 160 && Math.max(videoWidth, videoHeight) <= 4096;
          setVideoReady(valid);
          if (valid) {
            setDuration(duration);
            setTrimStart("0");
            setTrimEnd(String(Math.min(duration, 10)));
          } else setError("Choose a video up to 120 seconds long, with sides from 160 to 4096 pixels.");
        }} onSeeked={({ currentTarget }) => {
          if (Number.isFinite(currentTarget.duration)) setCoverSeconds(Math.max(0, Math.min(currentTarget.currentTime, currentTarget.duration - 0.01)));
        }}
        onError={() => { setVideoReady(false); setError("Could not preview this video."); }} />
      {videoReady && <>
        <label>{tr("Start (seconds) ")}<input type="number" min={0} max={duration} step="any" value={trimStart}
          disabled={blocked} onChange={(event) => setTrimStart(event.target.value)} /></label>
        <label>{tr("End (seconds) ")}<input type="number" min={0} max={duration} step="any" value={trimEnd}
          disabled={blocked} onChange={(event) => setTrimEnd(event.target.value)} /></label>
        <p>{tr("BB crops to the center square and removes audio. Seek within the selected range to pick the cover.")}</p>
        {validRange ? <p>{tr("Selected frame at ")}{selectedCover.toFixed(2)}{tr(" seconds.")}</p>
          : <p role="status">{tr("Select a range of up to 10 seconds within the video.")}</p>}
      </>}
      <button type="button" className="mtg-action" disabled={blocked} onClick={() => { setVideo(undefined); setError(""); }}>{tr("Discard video")}</button>
      <button type="submit" className="mtg-action" disabled={blocked || !videoReady || !validRange}>{tr("Save video avatar")}</button>
    </>}
    {pending && <>
      <img className="mtg-chat-photo-preview" alt={tr("New {0} preview", [tr(label)])} src={`data:image/jpeg;base64,${pending}`} />
      <button type="button" className="mtg-action" disabled={blocked} onClick={() => setPending(undefined)}>{tr("Discard photo")}</button>
      <button type="submit" className="mtg-action" disabled={blocked}>{tr("Save ")}{label}</button>
    </>}
    {!pending && !video && remove && removable && typeof current === "string" && (
      confirmRemove ? <div role="group" aria-label={tr("Remove {0}", [tr(label)])}>
        <button type="button" className="mtg-action" disabled={blocked}
          onClick={() => void submit(() => remove(current), "Photo removed.")}>{tr("Confirm photo removal")}</button>
        <button type="button" className="mtg-action" disabled={blocked}
          onClick={() => setConfirmRemove(false)}>{tr("Keep photo")}</button>
      </div> : <button type="button" className="mtg-action" disabled={blocked}
        onClick={() => setConfirmRemove(true)}>{tr("Remove ")}{label}</button>
    )}
    {error && <p role="alert">{tr(error)}</p>}
    {current === undefined && <button type="button" className="mtg-action" disabled={blocked} onClick={async () => {
      setBusy(true);
      setError("");
      if (!await refresh()) setError(tr("Could not reload the {0}.", [tr(label)]));
      setBusy(false);
    }}>{tr("Reload ")}{label}</button>}
    {notice && <p role="status">{tr(notice)}</p>}
  </form>;
}
