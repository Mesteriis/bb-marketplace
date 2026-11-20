import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ownedStickerTitle, stickerEmojis, type LocalStickerFormat, type OwnedStickerEditResult, type OwnedStickerPack, type OwnedStickerPackSnapshot, type TelegramPhoto } from "../core/contract.ts";
import { sameStickerEmojis, stickerEmojiInput } from "../core/sticker-emoji.ts";
import { photoSource } from "./photo-preview.tsx";
import type { StickerPackSummary } from "./sticker-pack-order.tsx";
import { useVisibleThumbnail } from "./visible-thumbnail.ts";
import { StickerPackFromImage, type CreatePackFromImage } from "./sticker-pack-from-image.tsx";
import { StickerImageCover } from "./sticker-image-cover.tsx";

type Page = { packs: StickerPackSummary[]; next: string | null };
export type OwnedStickerPackActions = {
  list: (after?: string) => Promise<Page>;
  load: (id: string) => Promise<OwnedStickerPack | null>;
  preview: (id: string, fileId: number) => Promise<TelegramPhoto | null>;
  rename?: (id: string, expected: string, title: string) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
  move: (id: string, fileId: number, direction: "up" | "down", expected: number[]) =>
    Promise<OwnedStickerEditResult>;
  remove?: (id: string, fileId: number, title: string, expected: number[]) => Promise<OwnedStickerEditResult>;
  setEmojis?: (id: string, fileId: number, expected: string[], emojis: string[]) => Promise<OwnedStickerEditResult>;
  setEmojiCover?: (id: string, expected: number | null, fileId: number | null) => Promise<OwnedStickerEditResult>;
  imageCover?: (id: string, fileId: number) => Promise<TelegramPhoto | null>;
  setImageCover?: (id: string, expected: number | null, base64: string | null) => Promise<OwnedStickerEditResult>;
  deletePack?: (target: OwnedStickerPackSnapshot) => Promise<"deleted" | "changed" | "unavailable" | "unknown">;
  createFromImage?: CreatePackFromImage;
  inspectTgs?: (base64: string) => Promise<string | null>;
  inspectWebm?: (base64: string) => Promise<"valid" | "invalid" | "unavailable">;
  addFromImage?: (target: OwnedStickerPackSnapshot, emojis: string[], base64: string, format: LocalStickerFormat) => Promise<OwnedStickerEditResult>;
  replaceFromImage?: (target: OwnedStickerPackSnapshot, fileId: number, emojis: string[], base64: string, format: LocalStickerFormat) => Promise<OwnedStickerEditResult>;
};

export function OwnedStickerPacks({ actions, onChanged }: { actions: OwnedStickerPackActions; onChanged: () => void }) {
  const { t: tr } = useTelegramLocale();
  const [selected, setSelected] = useState<string>();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { list } = actions;
  useEffect(() => {
    let active = true;
    void list().then((page) => { if (active) setPage(page); }, () => {
      if (active) setError("Could not load your sticker packs.");
    });
    return () => { active = false; };
  }, [list, attempt]);

  async function more(after: string) {
    setLoading(true);
    setError("");
    try {
      const next = await list(after);
      setPage((before) => {
        if (before?.next !== after) return before;
        const ids = new Set(before.packs.map(({ id }) => id));
        const added = next.packs.filter(({ id }) => !ids.has(id));
        return { packs: [...before.packs, ...added], next: next.next === after ? null : next.next };
      });
    } catch {
      setError("Could not load more of your sticker packs.");
    } finally { setLoading(false); }
  }

  const updateTitle = useCallback((id: string, title: string) => {
    setPage((page) => page && { ...page, packs: page.packs.map((pack) =>
      pack.id === id && pack.title !== title ? { ...pack, title } : pack) });
  }, []);

  function reloadPacks(message: string) {
    setSelected(undefined);
    setCreating(false);
    setPage(undefined);
    setError("");
    setNotice(message);
    setAttempt((value) => value + 1);
    onChanged();
  }

  if (creating && actions.createFromImage) return <StickerPackFromImage create={actions.createFromImage}
    inspectTgs={actions.inspectTgs} inspectWebm={actions.inspectWebm}
    close={() => setCreating(false)} saved={() => reloadPacks("Sticker pack created.")} />;
  return selected ? <OwnedStickerEditor key={selected} id={selected} actions={actions} updateTitle={updateTitle}
    close={() => setSelected(undefined)} packDeleted={() => reloadPacks("Sticker pack deleted.")} />
    : <div>
      {actions.createFromImage && <button type="button" className="mtg-action" disabled={loading}
        onClick={() => { setNotice(""); setCreating(true); }}>{tr("New pack from file")}</button>}
      {!page && !error && <p role="status">{tr("Loading your sticker packs…")}</p>}
      <ul>{page?.packs.map(({ id, title }) => <li key={id}>
        <button type="button" className="mtg-action" disabled={loading}
          onClick={() => { setNotice(""); setSelected(id); }}>{tr("Edit ")}<bdi>{title}</bdi></button>
      </li>)}</ul>
      {page && !page.packs.length && !page.next && <p>{tr("You don’t have any sticker packs.")}</p>}
      {page?.next && <button type="button" className="mtg-action" disabled={loading} onClick={() => void more(page.next!)}>{tr("More of my packs")}</button>}
      {error && <p role="alert">{tr(error)} {!page && <button type="button" onClick={() => {
        setError(""); setAttempt((value) => value + 1);
      }}>{tr("Retry")}</button>}</p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </div>;
}

function OwnedStickerEditor({ id, actions, updateTitle, close, packDeleted }: { id: string; actions: OwnedStickerPackActions;
  updateTitle: (id: string, title: string) => void; close: () => void; packDeleted: () => void }) {
  const { t: tr } = useTelegramLocale();
  const [pack, setPack] = useState<OwnedStickerPack>();
  const [selected, setSelected] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [requiresReload, setRequiresReload] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string>();
  const [emojiDraft, setEmojiDraft] = useState<{ fileId: number; expected: string[]; text: string }>();
  const [removeReview, setRemoveReview] = useState<{ fileId: number; label: string; index: number; title: string; order: number[] }>();
  const [deleteReview, setDeleteReview] = useState<OwnedStickerPackSnapshot>();
  const [imageTarget, setImageTarget] = useState<{ pack: OwnedStickerPackSnapshot;
    replacement?: { id: number; label: string; position: number; emojis?: string[]; photo?: TelegramPhoto } }>();
  const [attempt, setAttempt] = useState(0);
  const target = useRef<HTMLSpanElement>(null);
  const { load, preview } = actions;
  const previewSticker = useCallback((packId: string, fileId: string) => preview(packId, Number(fileId)), [preview]);
  const index = pack?.stickers.findIndex((item) => item.id === selected) ?? -1;
  const current = pack?.stickers[index];
  useEffect(() => {
    let active = true;
    void load(id).then((result) => {
      if (!active) return;
      if (result?.id !== id) { setNotice("This sticker pack is unavailable."); return; }
      setPack(result);
      updateTitle(id, result.title);
      setSelected((before) => result.stickers.some(({ id }) => id === before) ? before : result.stickers[0]?.id);
    }, () => { if (active) setNotice("Could not load this sticker pack."); });
    return () => { active = false; };
  }, [id, load, attempt, updateTitle]);
  const { photo, discard } = useVisibleThumbnail(target, id, String(selected), current?.preview ? previewSticker : undefined);
  const nextTitle = titleDraft === undefined ? undefined : ownedStickerTitle.safeParse(titleDraft);
  const proposedTitle = nextTitle?.success ? nextTitle.data : undefined;

  async function rename() {
    if (busy || requiresReload || removeReview || deleteReview || emojiDraft
      || !pack?.canRename || !actions.rename || !proposedTitle || proposedTitle === pack.title) return;
    setBusy(true);
    setNotice("");
    const result = await actions.rename(id, pack.title, proposedTitle).catch(() => "unknown" as const);
    if (result === "saved") {
      setPack({ ...pack, title: proposedTitle });
      updateTitle(id, proposedTitle);
      setTitleDraft(undefined);
      setNotice("Sticker pack renamed.");
    } else {
      setRequiresReload(true);
      setNotice(result === "changed" ? "The title changed in Telegram. Reload the pack."
        : "Telegram did not confirm the new title. Reload the pack.");
    }
    setBusy(false);
  }

  async function editSticker(apply: () => Promise<OwnedStickerEditResult>, change: "order" | "pack" | "emoji" | "cover", review?: typeof removeReview) {
    if (busy || requiresReload) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await apply();
      if (result.state === "saved" && result.pack.id === id) {
        setPack(result.pack);
        updateTitle(id, result.pack.title);
        if (review) {
          discard();
          const nextIndex = Math.min(review.index, result.pack.stickers.length - 1);
          setSelected(result.pack.stickers[nextIndex]?.id);
        }
        setNotice({ order: "Sticker order updated.", pack: "Sticker removed from the pack.", emoji: "Sticker emoji updated.",
          cover: "Pack cover updated." }[change]);
      } else {
        setRequiresReload(true);
        const detail = result.state === "changed" ? `The ${change} changed in Telegram.` : "Telegram did not confirm the change.";
        setNotice(tr("{0} Reload the pack.", [detail]));
      }
    } catch {
      setRequiresReload(true);
      setNotice("Could not verify the change. Reload the pack.");
    } finally { setBusy(false); setRemoveReview(undefined); setEmojiDraft(undefined); }
  }

  async function deletePack() {
    if (busy || requiresReload || !deleteReview || !actions.deletePack) return;
    setBusy(true);
    setNotice("");
    const result = await actions.deletePack(deleteReview).catch(() => "unknown" as const);
    if (result === "deleted") {
      packDeleted();
      return;
    }
    setRequiresReload(true);
    setNotice(result === "changed" ? "The pack changed in Telegram. Reload the pack."
      : "Telegram did not confirm deletion. Reload the pack.");
    setDeleteReview(undefined);
    setBusy(false);
  }

  const editingDisabled = busy || requiresReload || !!removeReview || !!deleteReview || !!emojiDraft;
  const remove = actions.remove;
  const setEmojis = actions.setEmojis;
  const setEmojiCover = actions.setEmojiCover;
  const setImageCover = actions.setImageCover;
  const coverId = pack?.emojiCoverFileId;
  const coverPosition = pack?.stickers.findIndex(({ id }) => id === coverId) ?? -1;
  const parsedEmojis = emojiDraft ? stickerEmojis.safeParse(stickerEmojiInput(emojiDraft.text)).data : undefined;
  const canSaveEmojis = !!emojiDraft && !!parsedEmojis?.length && !sameStickerEmojis(parsedEmojis, emojiDraft.expected);
  function move(direction: "up" | "down") {
    if (!pack || selected === undefined || editingDisabled) return;
    const order = pack.stickers.map(({ id }) => id);
    void editSticker(() => actions.move(id, selected, direction, order), "order");
  }
  const addFromImage = actions.addFromImage;
  const replaceFromImage = actions.replaceFromImage;
  const replacement = imageTarget?.replacement;
  const applyImage = replacement
    ? replaceFromImage && ((target: OwnedStickerPackSnapshot, tags: string[], base64: string, format: LocalStickerFormat) =>
      replaceFromImage(target, replacement.id, tags, base64, format))
    : addFromImage;
  if (imageTarget && applyImage) return <StickerPackFromImage inspectTgs={actions.inspectTgs} inspectWebm={actions.inspectWebm} add={{
    title: imageTarget.pack.title, replacement,
    apply: async (emojis, base64, format) => {
      const result = await applyImage(imageTarget.pack, emojis, base64, format).catch(() => ({ state: "unknown" as const }));
      if (result.state !== "saved" || result.pack.id !== id) {
        setRequiresReload(true);
        setNotice("Reload the pack to review the latest stickers.");
        return result.state === "saved" ? "unknown" : result.state;
      }
      setPack(result.pack);
      updateTitle(id, result.pack.title);
      discard();
      setSelected(result.pack.stickers.find(({ id }) => !imageTarget.pack.stickerIds.includes(id))?.id);
      return "saved";
    },
    reload: () => {
      setImageTarget(undefined); setRequiresReload(false); setNotice(""); setPack(undefined); discard(); setAttempt((value) => value + 1);
    },
  }} close={() => setImageTarget(undefined)} saved={() => {
    setImageTarget(undefined);
    setNotice(replacement ? "Sticker replaced in the pack." : "Sticker added to the pack.");
  }} />;
  return <fieldset aria-label={tr("Sticker pack editor")}>
    {pack && <legend>{pack.title}</legend>}
    {setImageCover && pack?.imageCoverFileId !== undefined && <StickerImageCover key={pack.imageCoverFileId ?? "default"}
      id={id} cover={pack.imageCoverFileId}
      disabled={editingDisabled} load={actions.imageCover} save={(expected, base64) => {
        void editSticker(() => setImageCover(id, expected, base64), "cover");
      }} />}
    {addFromImage && pack?.canAddImage && pack.name && <button type="button" className="mtg-action" disabled={editingDisabled}
      onClick={() => {
        if (!pack.name) return;
        setNotice("");
        setImageTarget({ pack: { id, name: pack.name, title: pack.title, stickerIds: pack.stickers.map(({ id }) => id) } });
      }}>{tr("Add sticker from file")}</button>}
    {pack?.canRename && actions.rename && (titleDraft === undefined
      ? <button type="button" className="mtg-action" disabled={editingDisabled}
        onClick={() => { setNotice(""); setTitleDraft(pack.title); }}>{tr("Rename pack")}</button>
      : <div role="group" aria-label={tr("Rename sticker pack")}>
        <label>{tr("Pack title ")}<input type="text" value={titleDraft} maxLength={100} disabled={editingDisabled}
          onChange={(event) => setTitleDraft(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void rename();
          }} /></label>
        <button type="button" className="mtg-action" disabled={editingDisabled || !proposedTitle || proposedTitle === pack.title}
          onClick={() => void rename()}>{tr("Save pack title")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setTitleDraft(undefined)}>{tr("Cancel rename")}</button>
        {titleDraft.trim() && !proposedTitle && <p>{tr("Use up to 50 characters without line breaks or control characters.")}</p>}
      </div>)}
    {pack?.stickers.length ? <>
      <label>{actions.remove ? tr("Sticker") : tr("Sticker to move")} <select value={selected ?? ""} disabled={editingDisabled}
        onChange={(event) => { discard(); setSelected(Number(event.currentTarget.value)); }}>
        {pack.stickers.map(({ id, label }, position) => <option key={id} value={id}>{position + 1}. {label}</option>)}
      </select></label>
      <span ref={target} className="mtg-owned-sticker-preview" aria-hidden="true">
        {current?.preview && photo ? <img src={photoSource(photo)} alt="" onError={discard} /> : current?.label}
      </span>
      {setEmojiCover && coverId !== undefined && <div role="group" aria-label={tr("Emoji pack cover")}>
        <span>{coverPosition < 0 ? tr("Using the default cover.") : <>{tr("Cover: emoji ")}{coverPosition + 1} <bdi>{pack.stickers[coverPosition]?.label}</bdi></>}</span>
        <button type="button" className="mtg-action" disabled={editingDisabled || !current || current.id === coverId}
          onClick={() => { if (current) void editSticker(() => setEmojiCover(id, coverId, current.id), "cover"); }}>{tr("Use selected emoji as cover")}</button>
        {coverId !== null && <button type="button" className="mtg-action" disabled={editingDisabled}
          onClick={() => void editSticker(() => setEmojiCover(id, coverId, null), "cover")}>{tr("Reset pack cover")}</button>}
      </div>}
      <button type="button" className="mtg-action" disabled={editingDisabled || index <= 0}
        onClick={() => move("up")}>{tr("Move sticker up")}</button>
      <button type="button" className="mtg-action" disabled={editingDisabled || index < 0 || index >= pack.stickers.length - 1}
        onClick={() => move("down")}>{tr("Move sticker down")}</button>
      {replaceFromImage && pack.canReplaceImage && pack.name && current && <button type="button" className="mtg-action" disabled={editingDisabled}
        onClick={() => {
          if (!pack.name) return;
          setNotice("");
          setImageTarget({ pack: { id, name: pack.name, title: pack.title, stickerIds: pack.stickers.map(({ id }) => id) },
            replacement: { id: current.id, label: current.label, position: index + 1, emojis: current.emojis, photo } });
        }}>{tr("Replace sticker from file")}</button>}
      {setEmojis && current?.emojis && !emojiDraft && <button type="button" className="mtg-action" disabled={editingDisabled}
        onClick={() => {
          const expected = current.emojis;
          if (!expected) return;
          setNotice("");
          setEmojiDraft({ fileId: current.id, expected, text: expected.join(" ") });
        }}>{tr("Edit sticker emoji")}</button>}
      {emojiDraft && setEmojis && <div role="group" aria-label={tr("Edit sticker emoji")}>
        <label>{tr("Sticker search emoji ")}<input type="text" autoFocus value={emojiDraft.text} maxLength={660} disabled={busy}
          onChange={(event) => setEmojiDraft({ ...emojiDraft, text: event.currentTarget.value })} /></label>
        <p>{tr("Enter 1 to 20 different emoji.")}</p>
        <button type="button" className="mtg-action" disabled={busy || !canSaveEmojis} onClick={() => {
          if (parsedEmojis?.length) void editSticker(() => setEmojis(id, emojiDraft.fileId, emojiDraft.expected, parsedEmojis), "emoji");
        }}>{tr("Save sticker emoji")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setEmojiDraft(undefined)}>{tr("Cancel emoji edit")}</button>
      </div>}
      {actions.remove && current && !removeReview && <button type="button" className="mtg-action" disabled={editingDisabled}
        onClick={() => {
          setNotice("");
          setTitleDraft(undefined);
          setRemoveReview({ fileId: current.id, label: current.label, index, title: pack.title, order: pack.stickers.map(({ id }) => id) });
        }}>{tr("Remove sticker from pack")}</button>}
      {removeReview && remove && <div role="group" aria-label={tr("Remove sticker from pack")}>
        <p>{tr("Remove sticker ")}{removeReview.index + 1} (<bdi>{removeReview.label}</bdi>{tr(") from ")}<bdi>{removeReview.title}</bdi>{tr(" for everyone?")}</p>
        <button type="button" className="mtg-action" disabled={busy} autoFocus onClick={() => setRemoveReview(undefined)}>{tr("Cancel removal")}</button>
        <button type="button" className="mtg-action" disabled={busy}
          onClick={() => void editSticker(() => remove(id, removeReview.fileId, removeReview.title, removeReview.order), "pack", removeReview)}>{tr("Confirm sticker removal")}</button>
      </div>}
    </> : pack ? <p>{tr("This pack is empty.")}</p> : !notice && <p role="status">{tr("Loading sticker pack…")}</p>}
    {pack?.name && actions.deletePack && !deleteReview && <button type="button" className="mtg-action" disabled={editingDisabled}
      onClick={() => {
        if (!pack.name) return;
        setNotice("");
        setDeleteReview({ id, name: pack.name, title: pack.title, stickerIds: pack.stickers.map(({ id }) => id) });
      }}>{tr("Delete entire pack")}</button>}
    {deleteReview && <div role="group" aria-label={tr("Delete entire sticker pack")}>
      <p>{tr("Permanently delete ")}<bdi>{deleteReview.title}</bdi> (<bdi>{deleteReview.name}</bdi>{tr(") and all ")}{deleteReview.stickerIds.length}{tr(" stickers for everyone?")}</p>
      <button type="button" className="mtg-action" autoFocus disabled={busy} onClick={() => setDeleteReview(undefined)}>{tr("Cancel pack deletion")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void deletePack()}>{tr("Confirm pack deletion")}</button>
    </div>}
    {(requiresReload || !pack && notice) && <button type="button" className="mtg-action" onClick={() => {
      setRequiresReload(false); setNotice(""); setPack(undefined); setTitleDraft(undefined); discard(); setAttempt((value) => value + 1);
    }}>{tr("Reload pack")}</button>}
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr("Back to my packs")}</button>
    {notice && <p role={requiresReload || !pack ? "alert" : "status"}>{tr(notice)}</p>}
  </fieldset>;
}
