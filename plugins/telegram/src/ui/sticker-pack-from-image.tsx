import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useState } from "react";
import { maxTgsBytes, maxWebmStickerBytes, newStickerPackTitle, ownedStickerPackName, stickerEmojis, type LocalStickerFormat, type StickerPackCreationResult, type TelegramPhoto } from "../core/contract.ts";
import { stickerEmojiInput } from "../core/sticker-emoji.ts";
import { prepareStickerImage, stickerImageAccept } from "./prepare-sticker-image.ts";
import { photoSource } from "./photo-preview.tsx";
import { TgsSticker } from "./tgs-sticker.tsx";

export type CreatePackFromImage = (name: string, title: string, emojis: string[], base64: string, format: LocalStickerFormat) => Promise<StickerPackCreationResult>;
type PreparedSticker = { format: "webp" | "webm"; base64: string } | { format: "tgs"; base64: string; json: string };

type ImageStickerAction = { create: CreatePackFromImage; add?: never } | {
  create?: never;
  add: { title: string; replacement?: { label: string; position: number; emojis?: string[]; photo?: TelegramPhoto };
    apply: (emojis: string[], base64: string, format: LocalStickerFormat) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
    reload: () => void };
};

export function StickerPackFromImage({ create, add, inspectTgs, inspectWebm, close, saved }: ImageStickerAction & {
  inspectTgs?: (base64: string) => Promise<string | null>;
  inspectWebm?: (base64: string) => Promise<"valid" | "invalid" | "unavailable">;
  close: () => void; saved: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [image, setImage] = useState<PreparedSticker>();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState(() => add?.replacement?.emojis?.join(" ") ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const packName = ownedStickerPackName.safeParse(name).data;
  const packTitle = newStickerPackTitle.safeParse(title).data;
  const tags = stickerEmojis.safeParse(stickerEmojiInput(emoji)).data;
  const replacement = add?.replacement;
  const tgs = image?.format === "tgs" ? image.json : undefined;
  const loadTgs = useCallback(async () => tgs ?? "", [tgs]);

  async function selectImage(file: File) {
    setBusy(true);
    setImage(undefined);
    setNotice("");
    const isTgs = inspectTgs && (/\.tgs$/i.test(file.name) || file.type === "application/x-tgsticker");
    const isWebm = inspectWebm && (/\.webm$/i.test(file.name) || file.type === "video/webm");
    try {
      if (!isTgs && !isWebm) {
        setImage({ format: "webp", base64: await prepareStickerImage(file) });
      } else {
        if (!file.size || file.size > (isTgs ? maxTgsBytes : maxWebmStickerBytes)) throw new Error("Invalid sticker file size.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
        if (isTgs) {
          const json = await inspectTgs(base64);
          if (!json) throw new Error("Invalid TGS sticker.");
          setImage({ format: "tgs", base64, json });
        } else if (isWebm) {
          const result = await inspectWebm(base64);
          if (result === "unavailable") { setNotice("Video sticker validation requires FFprobe on the BB server."); return; }
          if (result !== "valid") throw new Error("Invalid WebM sticker.");
          setImage({ format: "webm", base64 });
        }
      }
    } catch {
      setNotice(isTgs ? "Choose a valid Telegram TGS sticker up to 64 KiB."
        : isWebm ? "Choose a VP9 WebM up to 256 KiB and three seconds, without audio."
        : "Could not prepare the sticker. Choose a PNG, WebP or JPEG image up to 16 MiB.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !image || !tags?.length || needsReload) return;
    setBusy(true);
    setNotice("");
    if (add) {
      const result = await add.apply(tags, image.base64, image.format).catch(() => "unknown" as const);
      if (result === "saved") { saved(); return; }
      setNeedsReload(true);
      setNotice(result === "changed" ? "The pack changed in Telegram. Reload it before trying again."
        : "Telegram did not confirm the change. Reload the pack to check its stickers.");
      setBusy(false);
      return;
    }
    const result = packName && packTitle
      ? await create(packName, packTitle, tags, image.base64, image.format).catch(() => "unknown" as const) : "unavailable";
    if (result === "created") { saved(); return; }
    setNotice(result === "nameTaken" ? "This Telegram short name is already in use."
      : result === "nameInvalid" ? "Telegram rejected this short name."
      : result === "unavailable" ? "Could not use this sticker file."
      : result === "changed" ? "A pack is being changed. Try again."
      : "Telegram did not confirm creation. Check My packs for this short name before trying again.");
    setBusy(false);
  }

  const titleLabel = replacement ? tr("Replace sticker from image") : add ? tr("Add image to sticker pack") : tr("Create sticker pack from image");
  return <fieldset aria-label={titleLabel} disabled={busy}>
    <legend>{replacement ? <>{tr("Replace sticker ")}{replacement.position}{tr(" in ")}<bdi>{add?.title}</bdi></>
      : add ? <>{tr("Add a sticker to ")}<bdi>{add.title}</bdi></> : tr("New sticker pack")}</legend>
    {replacement && <p>{tr("Replace ")}<bdi>{replacement.label}</bdi>{tr(" for everyone who uses this pack.")}</p>}
    {replacement?.photo && <span className="mtg-owned-sticker-preview"><img src={photoSource(replacement.photo)} alt={tr("Current sticker")} /></span>}
    <label>{inspectTgs || inspectWebm ? tr("Sticker file") : tr("Sticker image")} <input type="file"
      accept={stickerImageAccept + (inspectTgs ? ",.tgs,application/x-tgsticker" : "") + (inspectWebm ? ",.webm,video/webm" : "")}
      onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void selectImage(file);
    }} /></label>
    {image?.format === "webp" && <span className="mtg-owned-sticker-preview">
      <img src={`data:image/webp;base64,${image.base64}`} alt={tr("Sticker preview")} />
    </span>}
    {tgs && <TgsSticker chatId="" messageId="preview" load={loadTgs} label={tr("Animated sticker preview")} />}
    {image?.format === "webm" && <span className="mtg-owned-sticker-preview">
      <video src={`data:video/webm;base64,${image.base64}`} aria-label={tr("Video sticker preview")} controls muted loop playsInline
        onError={() => { setImage(undefined); setNotice("Could not play this video sticker in BB."); }} />
    </span>}
    {!add && <>
      <label>{tr("Pack title ")}<input value={title} maxLength={128} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>{tr("Telegram short name ")}<input value={name} maxLength={64} onChange={(event) => setName(event.currentTarget.value)} /></label>
      <p>{tr("Use A–Z, numbers and underscores in the pack’s link name.")}</p>
    </>}
    <label>{tr("Sticker search emoji ")}<input value={emoji} maxLength={660} onChange={(event) => setEmoji(event.currentTarget.value)} /></label>
    <p>{tr("Enter 1 to 20 different emoji for the sticker.")}</p>
    <button type="button" className="mtg-action" disabled={!image || !tags?.length || needsReload || (!add && (!packName || !packTitle))}
      onClick={() => void save()}>{replacement ? tr("Replace sticker") : add ? tr("Add sticker") : tr("Create pack")}</button>
    {add && needsReload && <button type="button" className="mtg-action" onClick={add.reload}>{tr("Reload pack")}</button>}
    <button type="button" className="mtg-action" onClick={close}>{replacement ? tr("Cancel replacement")
      : add ? tr("Cancel adding image") : tr("Cancel creating pack")}</button>
    {busy && <p role="status">{tr("Working on the sticker pack…")}</p>}
    {notice && <p role="alert">{tr(notice)}</p>}
  </fieldset>;
}
