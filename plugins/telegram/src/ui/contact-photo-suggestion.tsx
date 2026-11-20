import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useState } from "react";
import type { SaveAvatarResult, TelegramPhoto } from "../core/contract.ts";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";

export type SuggestContactPhoto = (id: string, userId: string, base64: string) => Promise<"sent" | "unavailable" | "unknown">;
type SuggestedPhotoPreview = { photo: TelegramPhoto; currentVersion?: string | null };
export const ContactPhotoSuggestionActions = createContext<{
  load: (id: string, messageId: string, photoId: string) => Promise<SuggestedPhotoPreview | null>;
  accept: (id: string, messageId: string, photoId: string, expected: string | null) => Promise<SaveAvatarResult>;
} | undefined>(undefined);

export function SuggestProfilePhoto({ id, userId, name, send }: { id: string; userId: string; name: string; send: SuggestContactPhoto }) {
  const { t: tr } = useTelegramLocale();
  const [photo, setPhoto] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"invalid" | "sent" | "unavailable" | "unknown">();

  async function choose(file?: File) {
    if (!file || busy || status === "unknown") return;
    setStatus(undefined);
    setPhoto(undefined);
    if (!isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes) {
      setStatus("invalid");
      return;
    }
    setBusy(true);
    try { setPhoto(await preparePhoto(file, true)); }
    catch { setStatus("invalid"); }
    finally { setBusy(false); }
  }

  async function sendPhoto() {
    if (!photo || busy || status === "unknown") return;
    setBusy(true);
    const result = await send(id, userId, photo).catch(() => "unknown" as const);
    setStatus(result);
    if (result !== "unavailable") setPhoto(undefined);
    setBusy(false);
  }

  return <details>
    <summary>{tr("Suggest a profile photo")}</summary>
    {status !== "unknown" && <label>{tr("Choose a photo to suggest ")}<input type="file" accept={photoAccept} disabled={busy}
      onChange={(event) => { void choose(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>}
    {photo && <>
      <img className="mtg-chat-photo-preview" alt={tr("Photo to suggest")} src={`data:image/jpeg;base64,${photo}`} />
      <p>{tr("Send this profile photo suggestion to ")}<bdi>{name}</bdi>?</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void sendPhoto()}>{tr("Send photo suggestion")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => { setPhoto(undefined); setStatus(undefined); }}>{tr("Discard photo")}</button>
    </>}
    {status === "invalid" && <p role="alert">{tr("Choose a supported photo up to 64 MiB.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("Telegram could not send the photo suggestion.")}</p>}
    {status === "unknown" && <p role="alert">{tr("Telegram did not confirm delivery. Check the conversation before sending it again.")}</p>}
    {status === "sent" && <p role="status">{tr("Photo suggestion sent.")}</p>}
  </details>;
}

export function SuggestedProfilePhotoMessage({ chatId, messageId, photoId, canAccept }: {
  chatId: string; messageId: string; photoId: string; canAccept: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const actions = useContext(ContactPhotoSuggestionActions);
  const [preview, setPreview] = useState<SuggestedPhotoPreview>();
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveAvatarResult | "loadFailed">();

  async function load() {
    if (!actions || busy) return;
    setBusy(true);
    setStatus(undefined);
    const result = await actions.load(chatId, messageId, photoId).catch(() => null);
    setBusy(false);
    if (result) setPreview(result);
    else { setPreview(undefined); setStatus("loadFailed"); }
  }

  async function accept() {
    if (!actions || !canAccept || !review || !preview || preview.currentVersion === undefined || busy) return;
    setBusy(true);
    const result = await actions.accept(chatId, messageId, photoId, preview.currentVersion).catch(() => "unknown" as const);
    setBusy(false);
    setReview(false);
    setStatus(result);
  }

  return <section aria-label={tr("Suggested profile photo")}>
    <p>{tr("Suggested profile photo")}</p>
    {actions && !preview && <button type="button" className="mtg-action" disabled={busy} onClick={() => void load()}>{tr("Preview suggested photo")}</button>}
    {preview && <img className="mtg-chat-photo-preview" alt={tr("Suggested profile photo")}
      src={`data:${preview.photo.mime};base64,${preview.photo.base64}`} />}
    {canAccept && preview && preview.currentVersion !== undefined && status !== "saved" &&
      (status === "changed" || status === "unknown" ? <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void load()}>{tr("Reload photo suggestion")}</button> : review ? <>
        <p>{tr("Set this as your Telegram profile photo?")}</p>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void accept()}>{tr("Set suggested profile photo")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(false)}>{tr("Cancel")}</button>
      </> : <button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setReview(true); }}>{tr("Use as profile photo")}</button>)}
    {status === "saved" && <p role="status">{tr("Profile photo saved.")}</p>}
    {status === "changed" && <p role="alert">{tr("The profile photo changed in Telegram. Review it before applying the suggestion.")}</p>}
    {status === "unknown" && <p role="alert">{tr("Telegram did not confirm the change. Check your profile before retrying.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("This suggestion is no longer available.")}</p>}
    {status === "loadFailed" && <p role="alert">{tr("Could not load the suggested photo.")}</p>}
  </section>;
}
