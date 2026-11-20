import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useRef, useState } from "react";
import type { TelegramPhoto } from "../core/contract.ts";
import { photoSource } from "./photo-preview.tsx";
import { prepareStickerImage, stickerImageAccept } from "./prepare-sticker-image.ts";
import { useVisibleThumbnail } from "./visible-thumbnail.ts";

export function StickerImageCover({ id, cover, disabled, load, save }: {
  id: string;
  cover: number | null;
  disabled: boolean;
  load?: (id: string, fileId: number) => Promise<TelegramPhoto | null>;
  save: (expected: number | null, base64: string | null) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const target = useRef<HTMLSpanElement>(null);
  const [draft, setDraft] = useState<{ base64: string; expected: number | null }>();
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState("");
  const loadCover = useCallback((packId: string, fileId: string) => load?.(packId, Number(fileId)) ?? Promise.resolve(null), [load]);
  const { photo } = useVisibleThumbnail(target, id, String(cover), load && cover !== null ? loadCover : undefined);

  async function choose(file: File) {
    setPreparing(true);
    setDraft(undefined);
    setNotice("");
    try {
      setDraft({ base64: await prepareStickerImage(file, "cover"), expected: cover });
    } catch {
      setNotice("Could not prepare the cover. Choose a PNG, WebP or JPEG image up to 16 MiB.");
    } finally {
      setPreparing(false);
    }
  }

  return <div role="group" aria-label={tr("Sticker pack cover")}>
    <span>{cover === null ? tr("Using the default cover.") : tr("Custom pack cover.")}</span>
    {cover !== null && load && <span ref={target} className="mtg-owned-sticker-preview">
      {photo && <img src={photoSource(photo)} alt={tr("Current pack cover")} />}
    </span>}
    <label>{tr("Cover image ")}<input type="file" accept={stickerImageAccept} disabled={disabled || preparing}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void choose(file);
      }} /></label>
    {draft && <>
      <span className="mtg-owned-sticker-preview"><img src={`data:image/webp;base64,${draft.base64}`} alt={tr("New cover preview")} /></span>
      <button type="button" className="mtg-action" disabled={disabled} onClick={() => {
        save(draft.expected, draft.base64); setDraft(undefined);
      }}>{tr("Save pack cover")}</button>
      <button type="button" className="mtg-action" disabled={disabled} onClick={() => setDraft(undefined)}>{tr("Cancel cover change")}</button>
    </>}
    {cover !== null && !draft && <button type="button" className="mtg-action" disabled={disabled || preparing}
      onClick={() => save(cover, null)}>{tr("Reset pack cover")}</button>}
    {preparing && <span role="status">{tr("Preparing cover…")}</span>}
    {notice && <p role="alert">{tr(notice)}</p>}
  </div>;
}
