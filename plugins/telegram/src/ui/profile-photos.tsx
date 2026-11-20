import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { ProfilePhotoPage, SaveAvatarResult, TelegramPhoto } from "../core/contract.ts";
import { MediaPlayer } from "./media-player.tsx";

export type ProfilePhotoActions = {
  list: (id: string, offset: number) => Promise<ProfilePhotoPage>;
  load: (id: string, offset: number, photoId: string) => Promise<TelegramPhoto>;
  video?: (id: string, offset: number, photoId: string, fileId: number) => Promise<string>;
  restore?: (offset: number, photoId: string, expected: string | null) => Promise<SaveAvatarResult>;
  remove?: ProfilePhotoActions["restore"];
};

export function ProfilePhotos({ id, actions, group = false, updated }: { id: string; actions: ProfilePhotoActions; group?: boolean; updated?: () => Promise<void> }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ProfilePhotoPage>();
  const [offsets, setOffsets] = useState([0]);
  const [index, setIndex] = useState(0);
  const [photo, setPhoto] = useState<TelegramPhoto>();
  const [listError, setListError] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const [listRetry, setListRetry] = useState(0);
  const [photoRetry, setPhotoRetry] = useState(0);
  const [confirm, setConfirm] = useState<"restore" | "remove">();
  const [changingPhoto, setChangingPhoto] = useState(false);
  const [notice, setNotice] = useState("");
  const offset = offsets.at(-1) ?? 0;
  const selected = page?.photos[index];
  const loadVideo = actions.video;
  const videoFileId = selected?.videoFileId;
  const photoSource = photo && !photoError ? `data:${photo.mime};base64,${photo.base64}` : undefined;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPage(undefined);
    setIndex(0);
    setListError(false);
    void actions.list(id, offset).then((result) => {
      if (active) setPage(result);
    }, () => { if (active) setListError(true); });
    return () => { active = false; };
  }, [actions, id, open, offset, listRetry]);

  useEffect(() => {
    if (!open || !selected) return;
    let active = true;
    setPhoto(undefined);
    setPhotoError(false);
    void actions.load(id, offset, selected.id).then((result) => {
      if (active) setPhoto(result);
    }, () => { if (active) setPhotoError(true); });
    return () => { active = false; };
  }, [actions, id, open, offset, selected, photoRetry]);

  async function changeSelectedPhoto() {
    const action = confirm === "remove" ? actions.remove : confirm === "restore" ? actions.restore : undefined;
    if (!action || !selected || !page?.current || changingPhoto) return;
    setChangingPhoto(true);
    setNotice("");
    try {
      const result = await action(offset, selected.id, page.current.version);
      setNotice(result === "saved" ? confirm === "remove" ? "Profile photo deleted." : "Main profile photo updated."
        : result === "changed" ? "Profile photos changed in Telegram. Choose a photo again."
          : result === "unavailable" ? "Telegram could not change this photo."
            : "Telegram did not confirm the change. Check the refreshed photos.");
      if (result === "saved") await updated?.().catch(() => {});
    } catch {
      setNotice("Telegram did not confirm the change. Check the refreshed photos.");
    } finally {
      setConfirm(undefined);
      setChangingPhoto(false);
      setOffsets([0]);
      setListRetry((attempt) => attempt + 1);
    }
  }

  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) {
      setPage(undefined);
      setPhoto(undefined);
      setOffsets([0]);
      setConfirm(undefined);
      setNotice("");
    }
  }}>
    <summary>{group ? tr("Chat photos") : tr("Profile photos")}</summary>
    {open && <>
      {notice && <p role="status">{tr(notice)}</p>}
      {!page && !listError && <p role="status">{tr("Loading profile photos…")}</p>}
      {listError && <p role="alert">{tr("Could not load profile photos. ")}<button type="button" className="mtg-action"
        onClick={() => { setListError(false); setListRetry((attempt) => attempt + 1); }}>{tr("Retry")}</button></p>}
      {page && !selected && <p>{page.next === null ? tr("No more profile photos.") : tr("No displayable photos on this page.")}</p>}
      {selected && <>
        {group && selected.id.startsWith("current:") && <p>{tr("Current chat photo")}</p>}
        {selected.date > 0 && <time dateTime={new Date(selected.date * 1000).toISOString()}>
          {new Date(selected.date * 1000).toLocaleDateString(uiLocale)}</time>}
        {loadVideo && videoFileId !== undefined
          ? <MediaPlayer key={JSON.stringify([id, offset, selected.id, videoFileId])}
            chatId={id} messageId={selected.id} mime="video/mp4" loop
            poster={photoSource} posterSize={{ width: 320, height: 320 }}
            stream={() => loadVideo(id, offset, selected.id, videoFileId)}
            loadLabel={group ? "Play chat profile video" : "Play profile video"} />
          : photoSource && <img className="mtg-photo" alt={group ? tr("Telegram chat photo") : tr("Telegram profile photo")}
            src={photoSource} onError={() => setPhotoError(true)} />}
        {!photo && !photoError && <p role="status">{tr("Loading photo…")}</p>}
        {photoError && <p role="alert">{tr("Could not open this photo. ")}<button type="button" className="mtg-action"
          onClick={() => { setPhoto(undefined); setPhotoError(false); setPhotoRetry((attempt) => attempt + 1); }}>{tr("Retry photo")}</button></p>}
        {(actions.restore || actions.remove) && page?.current && (selected.id === page.current.photoId ? <p>{tr("Current profile photo")}</p>
          : photo && !photoError && (confirm ? <>
            <p>{confirm === "remove" ? tr("Permanently delete this photo from your Telegram profile?") : tr("Make this your main Telegram profile photo?")}</p>
            <button type="button" className="mtg-action" disabled={changingPhoto} onClick={() => void changeSelectedPhoto()}>
              {confirm === "remove" ? tr("Confirm photo deletion") : tr("Confirm profile photo")}
            </button>
            <button type="button" className="mtg-action" disabled={changingPhoto} onClick={() => setConfirm(undefined)}>{tr("Cancel")}</button>
          </> : <>
            {actions.restore && <button type="button" className="mtg-action" onClick={() => setConfirm("restore")}>{tr("Set as main profile photo")}</button>}
            {actions.remove && <button type="button" className="mtg-action" onClick={() => setConfirm("remove")}>{tr("Delete previous photo")}</button>}
          </>))}
      </>}
      {index > 0 && <button type="button" className="mtg-action" disabled={!!confirm || changingPhoto} onClick={() => { setPhoto(undefined); setIndex(index - 1); }}>{tr("Previous photo")}</button>}
      {page && index + 1 < page.photos.length && <button type="button" className="mtg-action" disabled={!!confirm || changingPhoto}
        onClick={() => { setPhoto(undefined); setIndex(index + 1); }}>{tr("Next photo")}</button>}
      {offsets.length > 1 && <button type="button" className="mtg-action" disabled={!!confirm || changingPhoto}
        onClick={() => { setPage(undefined); setPhoto(undefined); setOffsets(offsets.slice(0, -1)); }}>{tr("Newer photos")}</button>}
      {page && page.next !== null && <button type="button" className="mtg-action" disabled={!!confirm || changingPhoto} onClick={() => {
        if (page.next === null) return;
        setPage(undefined);
        setPhoto(undefined);
        setOffsets([...offsets, page.next]);
      }}>{tr("Older photos")}</button>}
    </>}
  </details>;
}
