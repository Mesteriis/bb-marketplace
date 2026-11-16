import { useState } from "react";
import type { SaveAvatarResult } from "../core/contract.ts";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";

export function AvatarEditor({ label, version, disabled, save, remove, canRemove, reload }: {
  label: "chat photo" | "profile photo";
  version: string | null;
  disabled?: boolean;
  save: (base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  remove?: (expected: string) => Promise<SaveAvatarResult>;
  canRemove?: boolean;
  reload: () => Promise<{ version: string | null | undefined; canRemove: boolean }>;
}) {
  const [current, setCurrent] = useState<string | null | undefined>(version);
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removable, setRemovable] = useState(canRemove ?? false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const blocked = busy || disabled;

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
    if (!isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes) {
      setError("Choose a non-empty JPEG, PNG, or WebP photo up to 64 MiB.");
      return;
    }
    setBusy(true);
    try { setPending(await preparePhoto(file, true)); }
    catch { setError(`Could not prepare the ${label}.`); }
    finally { setBusy(false); }
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
        setNotice(success);
        await refresh();
      } else if (result === "changed" || result === "unknown") {
        setCurrent(undefined);
        setPending(undefined);
        setError(result === "changed" ? `The ${label} changed in Telegram. Reload before trying again.`
          : "Telegram did not confirm the photo update. Reload it before retrying.");
      } else setError(`Telegram could not update the ${label}.`);
    } catch {
      setCurrent(undefined);
      setPending(undefined);
      setError(`Could not confirm the ${label} update. Reload it before retrying.`);
    } finally { setBusy(false); }
  }

  return <form className="mtg-avatar-editor" onSubmit={(event) => {
    event.preventDefault();
    if (pending && current !== undefined) void submit(() => save(pending, current), "Photo saved.");
  }}>
    {current !== undefined && <label>Choose {label} <input type="file" accept={photoAccept} disabled={blocked}
      onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} /></label>}
    {pending && <>
      <img className="mtg-chat-photo-preview" alt={`New ${label} preview`} src={`data:image/jpeg;base64,${pending}`} />
      <button type="button" className="mtg-action" disabled={blocked} onClick={() => setPending(undefined)}>Discard photo</button>
      <button type="submit" className="mtg-action" disabled={blocked}>Save {label}</button>
    </>}
    {!pending && remove && removable && typeof current === "string" && (
      confirmRemove ? <div role="group" aria-label={`Remove ${label}`}>
        <button type="button" className="mtg-action" disabled={blocked}
          onClick={() => void submit(() => remove(current), "Photo removed.")}>Confirm photo removal</button>
        <button type="button" className="mtg-action" disabled={blocked}
          onClick={() => setConfirmRemove(false)}>Keep photo</button>
      </div> : <button type="button" className="mtg-action" disabled={blocked}
        onClick={() => setConfirmRemove(true)}>Remove {label}</button>
    )}
    {error && <p role="alert">{error}</p>}
    {current === undefined && <button type="button" className="mtg-action" disabled={blocked} onClick={async () => {
      setBusy(true);
      setError("");
      if (!await refresh()) setError(`Could not reload the ${label}.`);
      setBusy(false);
    }}>Reload {label}</button>}
    {notice && <p role="status">{notice}</p>}
  </form>;
}
