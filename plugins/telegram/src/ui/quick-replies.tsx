import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useContext, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { Slash } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { ComposerActionEntry } from "./composer-actions.tsx";
import type { z } from "zod";
import { contactDraft, isVideoAttachmentName, quickReplyMediaKind, quickReplyVideoNoteFormat, maxTelegramUploadBytes, maxVideoNoteBytes, videoAttachmentAccept, type ContactDraft, type CustomEmojiMedia, type PollAttachmentReference, type PollMediaAttachment, type PhotoSize, type TelegramPhoto, type QuickReplyDocumentUpload, type QuickReplyDocumentResult, type DocumentSender, type schemas } from "../core/contract.ts";
import { ContactCardFields } from "./contact-card-composer.tsx";
import { LocationCardFields, parseLocationCardFields, type LocationCardFieldsValue } from "./location-card-fields.tsx";
import { SharedContactCard } from "./shared-contact.tsx";
import { LocationCard } from "./location-card.tsx";
import { isPlainKey } from "./composer-keys.ts";
import { PollComposer, PollFileUpload } from "./poll-composer.tsx";
import { PollFile } from "./message-content.tsx";
import { StickerArtwork } from "./custom-emoji.tsx";
import { MessageText } from "./message-text.tsx";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import { PhotoPreview } from "./photo-preview.tsx";
import { PhotoMotionPlayer } from "./photo-motion.tsx";
import { InstalledStickerPicker, type StickerChoice, type StickerPacks, type StickerPage } from "./installed-sticker-picker.tsx";
import { TgsSticker } from "./tgs-sticker.tsx";
import { DocumentButton } from "./document-button.tsx";
import { MediaPlayer } from "./media-player.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { importMotionPhoto } from "./import-motion-photo.ts";

type QuickReplies = z.infer<typeof schemas.quickReplies.output>;
export type QuickReplyReference = Pick<QuickReplies[number], "id" | "name">;
type LoadMessages = (id: number) => Promise<z.infer<typeof schemas.quickReplyMessages.output>>;
type PollSlot = PollAttachmentReference["slot"];
type LoadPhoto = (id: number, messageId: number, fileId: number, size?: PhotoSize, pollSlot?: PollSlot) => Promise<TelegramPhoto>;
type LoadSticker = (id: number, messageId: number, fileId: number) => Promise<string>;
type LoadPlayback = (id: number, messageId: number, fileId: number, pollSlot?: PollSlot) => Promise<string>;
type SaveDocument = (id: number, messageId: number, fileId: number, pollSlot?: PollSlot) => Promise<boolean>;
type LoadPollSticker = (id: number, messageId: number, reference: PollAttachmentReference) => Promise<CustomEmojiMedia | null>;
type ShortcutMessage = Awaited<ReturnType<LoadMessages>>[number];
type Rename = (id: number, expected: string, name: string) => Promise<z.infer<typeof schemas.renameQuickReply.output>>;
type AddText = (input: z.input<typeof schemas.addQuickReplyText.input>) => Promise<z.infer<typeof schemas.addQuickReplyText.output>>;
type AddSticker = (input: z.input<typeof schemas.addQuickReplySticker.input>) => Promise<z.infer<typeof schemas.addQuickReplySticker.output>>;
type AddContact = (input: z.input<typeof schemas.addQuickReplyContact.input>) => Promise<z.infer<typeof schemas.addQuickReplyContact.output>>;
type AddPoll = (input: z.input<typeof schemas.addQuickReplyPoll.input>) => Promise<z.infer<typeof schemas.addQuickReplyPoll.output>>;
type AddLocation = (input: z.input<typeof schemas.addQuickReplyLocation.input>) => Promise<z.infer<typeof schemas.addQuickReplyLocation.output>>;
type AddPhoto = (input: z.input<typeof schemas.addQuickReplyPhoto.input>) => Promise<z.infer<typeof schemas.addQuickReplyPhoto.output>>;
type AddPhotoAlbum = (input: z.input<typeof schemas.addQuickReplyPhotoAlbum.input>) => Promise<QuickReplyDocumentResult>;
type QuickReplyAlbumItem = { kind: "photo"; base64: string } | { kind: "video"; file: File }
  | { kind: "livePhoto"; photo: string | File; file: File };
type ShortcutAlbumFile = { file: File; key: number; motion?: File };
export type AddQuickReplyMixedAlbum = (input: Omit<z.input<typeof schemas.prepareQuickReplyAlbumUpload.input>, "items">,
  items: QuickReplyAlbumItem[], progress: Parameters<DocumentSender>[3], signal: AbortSignal) =>
  Promise<QuickReplyDocumentResult | { state: "cancelled" | "unknown" }>;
export type AddQuickReplyDocument = (input: QuickReplyDocumentUpload, file: File, progress: Parameters<DocumentSender>[3],
  signal: AbortSignal) => Promise<QuickReplyDocumentResult | { state: "cancelled" | "unknown" }>;
type Delete = (input: z.input<typeof schemas.deleteQuickReply.input>) => Promise<z.infer<typeof schemas.deleteQuickReply.output>>;
type Reorder = (input: z.input<typeof schemas.reorderQuickReplies.input>) => Promise<z.infer<typeof schemas.reorderQuickReplies.output>>;
type EditText = (input: z.input<typeof schemas.editQuickReplyText.input>) => Promise<z.infer<typeof schemas.editQuickReplyText.output>>;
type DeleteMessage = (input: z.input<typeof schemas.deleteQuickReplyMessage.input>) => Promise<z.infer<typeof schemas.deleteQuickReplyMessage.output>>;
type RetryMessage = (input: z.input<typeof schemas.retryQuickReplyMessage.input>) => Promise<z.infer<typeof schemas.retryQuickReplyMessage.output>>;
export type SendQuickReply = (input: z.input<typeof schemas.sendQuickReply.input>) => Promise<z.infer<typeof schemas.sendQuickReply.output>>;

export type QuickReplyComposerControls = { handleDraftKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean };

export function QuickReplyComposer({ chatId, load, send, edit, draft, disabled, controls, focusDraft, onSubmitted }: {
  chatId: string; load: (chatId: string) => Promise<QuickReplies>; send: SendQuickReply; draft: string; disabled: boolean;
  edit?: (shortcut: QuickReplyReference) => void;
  controls: Ref<QuickReplyComposerControls>; focusDraft: () => void; onSubmitted: (command?: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const panelId = useId();
  const list = useRef<HTMLUListElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [replies, setReplies] = useState<QuickReplies | null>();
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const token = /^\/[\p{L}\p{Nd}_\u200c\u00b7\u0d80-\u0dff]{0,32}$/u.exec(draft);
  const command = token?.[0] === draft ? draft : undefined;
  const open = manual || (command !== undefined && dismissed !== command);
  const prefix = command?.slice(1).toLowerCase();
  const matches = replies?.filter(({ name }) => prefix === undefined || name.toLowerCase().startsWith(prefix));

  useEffect(() => {
    setDismissed((previous) => previous === draft ? previous : undefined);
  }, [draft]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setReplies(undefined);
    setError("");
    setSubmitted(false);
    void load(chatId).then(
      (result) => { if (current) setReplies(result.filter(({ messageCount }) => messageCount > 0)); },
      () => { if (current) setReplies(null); },
    );
    return () => { current = false; };
  }, [chatId, load, open]);

  function close() {
    setManual(false);
    setDismissed(command);
    setReplies(undefined);
  }

  useEffect(() => {
    if (!open || busy) return;
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Node) || picker.current?.contains(event.target)) return;
      if (!manual && event.target === picker.current?.closest("form")?.querySelector(".mtg-compose-field")) return;
      setManual(false);
      setDismissed(command);
      setReplies(undefined);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, busy, manual, command]);

  useImperativeHandle(controls, () => ({
    handleDraftKey(event) {
      if (!open || !command || disabled) return false;
      if (!busy && isPlainKey(event, "Escape")) {
        close();
        event.preventDefault();
        return true;
      }
      const enter = isPlainKey(event, "Enter");
      if (!enter && (busy || !isPlainKey(event, "ArrowDown"))) return false;
      if (!busy) {
        const first = list.current?.querySelector<HTMLButtonElement>("button");
        if (!first) return false;
        first.focus();
      }
      event.preventDefault();
      return true;
    },
  }));

  async function submit({ id, name, messageCount, preview }: QuickReplies[number]) {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    focusDraft();
    try {
      const result = await send({ chatId, id, name, messageCount, ...(preview !== undefined && { preview }) });
      close();
      if (result === "submitted") {
        setSubmitted(true);
        onSubmitted(command);
      } else if (result === "changed") setError("The shortcut changed. Open Quick replies to load it again.");
      else if (result === "incomplete") setError("Some messages are still pending or failed. Check this shortcut in Telegram settings.");
      else if (result === "unknown") setError("Could not confirm the quick reply. Check the chat before retrying.");
      else setError("Telegram did not accept this shortcut for this chat.");
    } catch {
      close();
      setError("Could not confirm the quick reply. Check the chat before retrying.");
    } finally { pending.current = false; setBusy(false); }
  }

  return <div ref={picker} className="mtg-quick-replies" onKeyDown={(event) => {
    if (!open || busy || !isPlainKey(event, "Escape")) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    focusDraft();
  }}>
    <ComposerActionEntry primary>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || busy} aria-expanded={open}
        aria-controls={panelId} onClick={() => {
          if (manual) close();
          else {
            setManual(true);
            requestAnimationFrame(focusDraft);
          }
        }}>
        <Slash size={15} aria-hidden="true" />{tr("Quick replies")}</Button>
    </ComposerActionEntry>
    <div className="mtg-quick-replies-panel" hidden={!manual && !busy && !(open && matches?.length) && !error && !submitted}>
    {error && <p role="alert">{tr(error)}</p>}
    {submitted && <p role="status">{tr("Quick reply submitted.")}</p>}
    <div id={panelId} hidden={!open}>
      {busy && <p role="status">{tr("Submitting quick reply…")}</p>}
      {manual && replies === undefined && !busy && <p role="status">{tr("Loading quick replies…")}</p>}
      {manual && replies === null && <p role="alert">{tr("Could not load quick replies.")}</p>}
      {matches?.length === 0 && (manual || !!replies?.length) && <p role="status">{prefix ? tr("No matching quick replies.") : tr("No quick replies available.")}</p>}
      {!!matches?.length && <ul ref={list} aria-label={tr("Quick replies to send")}>{matches.map((reply) =>
        <li key={reply.id}>
          <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => void submit(reply)}>{tr("Send ")}<bdi>/{reply.name}</bdi> ({reply.messageCount} {reply.messageCount === 1 ? tr("message") : tr("messages")})
          </button>
          {edit && <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => {
            close();
            focusDraft();
            edit({ id: reply.id, name: reply.name });
          }}>{tr("Edit ")}<bdi>/{reply.name}</bdi></button>}
          {reply.preview && <div><bdi>{reply.preview}</bdi></div>}
        </li>)}</ul>}
    </div>
    </div>
  </div>;
}

export function QuickReplySettings({ review, load, loadMessages, loadPhoto, loadPlayback, loadSticker, loadPollSticker, saveDocument, rename, addText, addPhoto, addPhotoAlbum, addMixedAlbum, addDocument, addContact, addPoll, addLocation, stickers, remove, reorder, editText, removeMessage, retryMessage }: {
  review?: QuickReplyReference;
  load: () => Promise<QuickReplies>; loadMessages: LoadMessages; rename: Rename; addText: AddText; remove: Delete; reorder: Reorder; editText: EditText;
  removeMessage: DeleteMessage;
  retryMessage?: RetryMessage;
  loadPhoto?: LoadPhoto;
  loadPlayback?: LoadPlayback;
  loadSticker?: LoadSticker;
  loadPollSticker?: LoadPollSticker;
  saveDocument?: SaveDocument;
  addPhoto?: AddPhoto;
  addPhotoAlbum?: AddPhotoAlbum;
  addMixedAlbum?: AddQuickReplyMixedAlbum;
  addDocument?: AddQuickReplyDocument;
  addContact?: AddContact;
  addPoll?: AddPoll;
  addLocation?: AddLocation;
  stickers?: { list: StickerPacks; load: StickerPage; add: AddSticker };
}) {
  const { t: tr } = useTelegramLocale();
  const pollFileUpload = useContext(PollFileUpload);
  const panelId = useId();
  const reviewedHeading = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [replies, setReplies] = useState<QuickReplies>();
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [editing, setEditing] = useState<{ id: number; name: string }>();
  const [renameError, setRenameError] = useState("");
  const [adding, setAdding] = useState<{ id?: number; name: string; text: string; albumFiles?: ShortcutAlbumFile[]; document?: File;
    mediaKind?: ReturnType<typeof quickReplyMediaKind> | "videoNote"; sticker?: StickerChoice; contact?: ContactDraft; poll?: boolean;
    location?: LocationCardFieldsValue; mediaSpoiler?: boolean; mediaCaptionAbove?: boolean }>();
  const [pickingSticker, setPickingSticker] = useState(false);
  const [draftNumber, setDraftNumber] = useState(0);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const formatting = useDraftFormatting(String(draftNumber), adding?.text ?? "", draftInput, [], true);
  const [uploadProgress, setUploadProgress] = useState<{ offset: number; total: number; canCancel: boolean }>();
  const documentUpload = useRef<AbortController>(undefined);
  useEffect(() => () => documentUpload.current?.abort(), []);
  const [addError, setAddError] = useState("");
  const [deleting, setDeleting] = useState<number>();
  const [deleteError, setDeleteError] = useState("");
  const [reordering, setReordering] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (target?: QuickReplyReference) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    setNotice("");
    setRenameError("");
    setOrderError("");
    try {
      const replies = await load();
      const current = target && replies.find(({ id, name }) => id === target.id && name === target.name);
      setReplies(replies);
      setSelected(current?.id);
      if (target && !current) setNotice("This shortcut changed in Telegram. Select a shortcut from the current list.");
      setEditing(undefined);
      setDeleting(undefined);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    if (review) void refresh(review);
  }, [review, refresh]);

  useEffect(() => {
    if (review && selected === review.id) reviewedHeading.current?.focus();
  }, [review, selected]);

  async function moveShortcut(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (!replies || !replies[index] || !replies[destination] || pending.current) return;
    const ordered = [...replies];
    [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!];
    pending.current = true;
    setBusy(true);
    setReordering(true);
    setNotice("");
    setOrderError("");
    try {
      const result = await reorder({ ids: ordered.map(({ id }) => id), expected: replies.map(({ id }) => id) });
      if (result === "updated") {
        setReplies(ordered);
        setNotice("Shortcut order saved.");
      } else setOrderError("The shortcut order changed or could not be saved. Refresh quick replies before trying again.");
    } catch {
      setOrderError("Could not confirm the shortcut order. Refresh quick replies before trying again.");
    } finally {
      pending.current = false;
      setBusy(false);
      setReordering(false);
    }
  }

  function startAdd(name = "", id?: number) {
    setPickingSticker(false);
    setEditing(undefined);
    setDeleting(undefined);
    setNotice("");
    setAddError("");
    setDraftNumber((previous) => previous + 1);
    setAdding({ id, name, text: "" });
  }

  async function deleteShortcut(id: number, name: string, messageCount: number) {
    if (deleting !== id || pending.current) return;
    pending.current = true;
    setBusy(true);
    setDeleteError("");
    try {
      const result = await remove({ id, name, messageCount });
      if (result === "changed") {
        setDeleteError("This shortcut changed in Telegram. Refresh quick replies before deleting it.");
        return;
      }
      setReplies((current) => current?.filter((reply) => reply.id !== id));
      setSelected((current) => current === id ? undefined : current);
      setDeleting(undefined);
      setNotice("Quick reply deleted.");
    } catch {
      setDeleteError("Could not confirm deletion. Refresh quick replies before trying again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const attachment = adding?.albumFiles ?? adding?.document;
  const albumSelected = (adding?.albumFiles?.length ?? 0) > 1;
  const hasMotion = adding?.albumFiles?.some(({ motion }) => !!motion);
  const mixedAlbum = albumSelected && adding?.albumFiles?.some(({ file, motion }) => !!motion || quickReplyMediaKind(file.name) === "video");
  const videoNote = adding?.mediaKind === "videoNote";
  const attachmentKind = albumSelected ? "album" : videoNote ? "video note" : adding?.mediaKind === "animation" ? "GIF" : adding?.mediaKind === "voice" ? "voice message"
    : adding?.mediaKind ?? "document";
  const visualMedia = adding?.mediaKind === "video" || adding?.mediaKind === "animation";
  const hasMediaOptions = !!adding?.albumFiles || visualMedia;
  const mediaLabel = adding?.albumFiles ? albumSelected ? tr("album") : tr("photo") : attachmentKind;
  const mediaOption = adding?.document && quickReplyMediaKind(adding.document.name);
  const canUseVideoNote = adding?.document && adding.document.size <= maxVideoNoteBytes
    && quickReplyVideoNoteFormat(adding.document.name);

  const contact = adding?.contact && contactDraft.safeParse(adding.contact).data;
  const location = adding?.location;
  const place = location && parseLocationCardFields(location);
  const canSaveMessage = !!adding?.name.trim() && (!hasMotion || albumSelected && !!addMixedAlbum) && (adding.contact ? !!contact : location ? !!place
    : videoNote ? !!canUseVideoNote : attachment ? adding.text.trim().length <= 1024 : !!adding.sticker || !!adding.text.trim());

  async function importAlbumPhotos(files: File[]) {
    if (!adding || !addMixedAlbum || pending.current || !files.length) return;
    const existing = adding.albumFiles ?? [];
    if (existing.length + files.length > 10) {
      setAddError("An album can contain up to 10 items.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setAddError("");
    try {
      const items: ShortcutAlbumFile[] = [];
      const firstKey = Math.max(-1, ...existing.map(({ key }) => key)) + 1;
      for (const file of files) {
        const pair = await importMotionPhoto(file);
        if (!pair) {
          setAddError("Each selected file must contain a valid Motion Photo.");
          return;
        }
        items.push({ file: pair.still, motion: pair.clip, key: firstKey + items.length });
      }
      setAdding((current) => current === adding ? { ...adding, albumFiles: [...existing, ...items] } : current);
    } catch {
      setAddError("Could not import the selected Motion Photos.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function saveMessage(event: FormEvent) {
    event.preventDefault();
    const name = adding?.name.trim();
    const text = adding?.text.trim();
    if (!adding || !name || !canSaveMessage || pending.current) return;
    pending.current = true;
    setBusy(true);
    setAddError("");
    setError(false);
    try {
      let result: Awaited<ReturnType<AddText>>;
      const entities = {
        ...(formatting.deliveryStyles.length && { styles: formatting.deliveryStyles }),
        ...(formatting.deliveryLinks.length && { links: formatting.deliveryLinks }),
      };
      const media = { ...(adding.mediaSpoiler && { spoiler: true }), ...(adding.mediaCaptionAbove && text && { captionAbove: true }) };
      if (contact && addContact) {
        result = await addContact({ id: adding.id, name, contact });
      } else if (place && addLocation) {
        result = await addLocation({ id: adding.id, name, ...place });
      } else if (adding.sticker && stickers) {
        result = await stickers.add({ id: adding.id, name, packId: adding.sticker.packId, fileId: adding.sticker.fileId });
      } else if (adding.albumFiles && addPhoto) {
        const items: QuickReplyAlbumItem[] = [];
        for (const { file, motion } of adding.albumFiles) {
          if (mixedAlbum && quickReplyMediaKind(file.name) === "video") {
            items.push({ kind: "video", file });
            continue;
          }
          if (motion && file.type === "image/heic") {
            items.push({ kind: "livePhoto", photo: file, file: motion });
            continue;
          }
          const base64 = await preparePhoto(file).catch(() => undefined);
          if (!base64) { setAddError("Could not prepare a selected photo."); return; }
          items.push(motion ? { kind: "livePhoto", photo: base64, file: motion } : { kind: "photo", base64 });
        }
        const input = { id: adding.id, name, caption: text ?? "", ...entities,
          ...(Object.keys(media).length && { media }) };
        if (albumSelected) {
          let delivery: QuickReplyDocumentResult | { state: "cancelled" | "unknown" } | undefined;
          if (mixedAlbum && addMixedAlbum) {
            const total = items.reduce((sum, item) => sum + (item.kind === "photo" ? 0 : item.file.size)
              + (item.kind === "livePhoto" && typeof item.photo !== "string" ? item.photo.size : 0), 0);
            const controller = new AbortController();
            documentUpload.current = controller;
            setUploadProgress({ offset: 0, total, canCancel: true });
            delivery = await addMixedAlbum(input, items,
              (offset, canCancel) => setUploadProgress({ offset, total, canCancel: canCancel ?? false }), controller.signal);
          } else if (!mixedAlbum && addPhotoAlbum) {
            delivery = await addPhotoAlbum({ ...input, photos: items.flatMap((item) => item.kind === "photo" ? [item.base64] : []) });
          }
          const state = delivery?.state ?? "failed";
          if (state === "cancelled") return;
          if (state === "unknown") { setAddError("Could not confirm the album. Refresh quick replies before retrying."); return; }
          if (state === "failed") { setAddError("Could not save the album."); return; }
          result = state;
        } else if (items[0]?.kind === "photo") result = await addPhoto({ ...input, base64: items[0].base64 });
        else return;
      } else if (adding.document && addDocument) {
        const file = adding.document;
        const controller = new AbortController();
        documentUpload.current = controller;
        setUploadProgress({ offset: 0, total: file.size, canCancel: true });
        const { state } = await addDocument({ id: adding.id, name, caption: videoNote ? "" : text ?? "", filename: file.name.slice(0, 255),
          size: file.size, ...(adding.mediaKind ? { [adding.mediaKind]: true } : {}), ...(!videoNote && entities),
          ...(visualMedia && Object.keys(media).length && { media }) },
        file, (offset, canCancel) => setUploadProgress({ offset, total: file.size, canCancel: canCancel ?? false }),
        controller.signal);
        if (state === "cancelled") return;
        if (state === "unknown") { setAddError("Could not confirm the attachment. Refresh quick replies before retrying."); return; }
        if (state === "failed") { setAddError(tr("Could not upload this {0} to Telegram.", [attachmentKind])); return; }
        result = state;
      } else {
        if (!text) return;
        result = await addText({ id: adding.id, name, text, ...entities });
      }
      if (result === "submitted") {
        formatting.clearSent(String(draftNumber), adding.text.trim());
        setNotice("Message submitted to the shortcut.");
        setAdding(undefined);
        setSelected(undefined);
        try { setReplies(await load()); }
        catch { setError(true); }
      } else if (result === "changed") setAddError("This shortcut changed or the name is already in use. Refresh quick replies and try again.");
      else setAddError("Telegram rejected this shortcut name or message.");
    } catch {
      setAddError("Could not confirm the message. Refresh quick replies before retrying.");
    } finally {
      documentUpload.current = undefined;
      setUploadProgress(undefined);
      pending.current = false;
      setBusy(false);
    }
  }

  async function savePoll(draft: Parameters<AddPoll>[0]["draft"], upload?: (
    target: { id?: number; name: string },
  ) => ReturnType<NonNullable<import("react").ContextType<typeof PollFileUpload>>>) {
    const name = adding?.name.trim();
    if (!adding || !name || !addPoll || pending.current) return { state: "failed" as const };
    pending.current = true;
    setBusy(true);
    setAddError("");
    setError(false);
    try {
      if (upload) {
        const result = await upload({ id: adding.id, name });
        if (result.state === "changed") {
          setAddError("This shortcut changed or the name is already in use. Refresh quick replies and try again.");
          return { state: "failed" as const };
        }
        if (result.state !== "submitted" && result.state !== "sent") return { state: result.state };
      } else {
        const result = await addPoll({ id: adding.id, name, draft });
        if (result === "unavailable") return { state: "unavailable" as const };
        if (result !== "submitted") {
          setAddError(result === "changed" ? "This shortcut changed or the name is already in use. Refresh quick replies and try again."
            : "Telegram rejected this shortcut name or poll.");
          return { state: "failed" as const };
        }
      }
      formatting.clearSent(String(draftNumber), adding.text.trim());
      setNotice("Poll submitted to the shortcut.");
      setAdding(undefined);
      setSelected(undefined);
      try { setReplies(await load()); }
      catch { setError(true); }
      return { state: "sent" as const };
    } catch {
      return { state: "unknown" as const };
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function saveName(event: FormEvent, expected: string) {
    event.preventDefault();
    const name = editing?.name.trim();
    if (!editing || !name || name === expected || pending.current) return;
    const { id } = editing;
    pending.current = true;
    setBusy(true);
    setRenameError("");
    setNotice("");
    try {
      const result = await rename(id, expected, name);
      if (result === "renamed") {
        setReplies((current) => current?.map((reply) => reply.id === id ? { ...reply, name } : reply));
        setNotice("Quick reply renamed.");
        setEditing(undefined);
      } else if (result === "changed") setRenameError("This shortcut changed in Telegram. Refresh quick replies and try again.");
      else setRenameError("Telegram rejected this shortcut name.");
    } catch {
      setRenameError("Could not rename this shortcut.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <>
    <h3>{tr("Quick replies")}</h3>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void refresh()}>
      {replies ? tr("Refresh quick replies") : tr("Load quick replies")}
    </button>
    {busy && <p role="status">{reordering ? tr("Saving shortcut order…") : deleting ? tr("Deleting shortcut…")
      : editing || adding ? tr("Saving shortcut…") : tr("Loading quick replies…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr("Could not load quick replies for this account.")}</p>}
    {orderError && <p role="alert">{tr(orderError)}</p>}
    {replies && !adding && <button type="button" className="mtg-action" disabled={busy} onClick={() => startAdd()}>{tr("New quick reply")}</button>}
    {adding?.poll ? <div>
      <p>{tr("Add a poll to ")}<bdi>/{adding.name.trim()}</bdi></p>
      <PollComposer saveToShortcut={(draft) => savePoll(draft)}
        uploadToShortcut={pollFileUpload && ((draft, files, signal, progress) =>
          savePoll(draft, (target) => pollFileUpload(target, draft, files, signal, progress)))}
        cancelShortcut={() => { setAddError(""); setAdding({ ...adding, poll: false }); }} />
      {addError && <p role="alert">{tr(addError)}</p>}
    </div> : adding && <form onSubmit={(event) => void saveMessage(event)}>
      {adding.id === undefined ? <label>{tr("New shortcut name ")}<input value={adding.name} maxLength={128} disabled={busy}
        onChange={(event) => setAdding({ ...adding, name: event.target.value })} /></label>
        : <p>{tr("Add a message to ")}<bdi>/{adding.name}</bdi></p>}
      {adding.contact ? <fieldset disabled={busy}>
        <legend>{tr("Shortcut contact")}</legend>
        <ContactCardFields draft={adding.contact} update={(contact) => setAdding({ ...adding, contact })} />
        <button type="button" className="mtg-action" onClick={() => setAdding({ ...adding, contact: undefined })}>{tr("Remove contact card")}</button>
      </fieldset> : location ? <fieldset disabled={busy}>
        <legend>{tr("Shortcut location")}</legend>
        <LocationCardFields draft={location} update={(location) => setAdding({ ...adding, location })} />
        <button type="button" className="mtg-action" onClick={() => setAdding({ ...adding, location: undefined })}>{tr("Remove location")}</button>
      </fieldset> : <>
      {addContact && !attachment && !adding.sticker && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => {
          setPickingSticker(false);
          setAddError("");
          setAdding({ ...adding, contact: { firstName: "", lastName: "", phone: "" } });
        }}>{tr("Add contact card")}</button>}
      {addPoll && !attachment && !adding.sticker && <button type="button" className="mtg-action" disabled={busy || !adding.name.trim()}
        onClick={() => { setPickingSticker(false); setAddError(""); setAdding({ ...adding, poll: true }); }}>{tr("Add poll")}</button>}
      {addLocation && !attachment && !adding.sticker && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => {
          setPickingSticker(false);
          setAddError("");
          setAdding({ ...adding, location: { latitude: "", longitude: "", title: "", address: "" } });
        }}>{tr("Add location")}</button>}
      {addPhoto && !adding.document && !adding.sticker && <label>{addMixedAlbum ? tr("Shortcut photo or album") : tr("Shortcut photo")} <input
        type="file" accept={addMixedAlbum ? photoAccept + ",.mp4,.mov" : photoAccept}
        multiple={!!addPhotoAlbum} disabled={busy} onChange={(event) => {
        const photos = Array.from(event.currentTarget.files ?? []);
        const existing = hasMotion ? adding.albumFiles ?? [] : [];
        if (existing.length + photos.length > (addPhotoAlbum ? 10 : 1)
          || photos.some((file) => {
            if (addMixedAlbum && existing.length + photos.length > 1 && quickReplyMediaKind(file.name) === "video") return !file.size || file.size > maxTelegramUploadBytes;
            return !isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes;
          })) {
          event.currentTarget.value = "";
          setAddError(addMixedAlbum ? "Choose one photo or an album of up to 10 photos and MP4 or MOV videos."
            : addPhotoAlbum ? "Choose up to 10 JPEG, PNG, or WebP photos, each up to 64 MiB." : "Choose a JPEG, PNG, or WebP photo up to 64 MiB.");
          if (!hasMotion) setAdding({ ...adding, albumFiles: undefined });
        } else {
          event.currentTarget.value = "";
          setAddError("");
          const key = Math.max(-1, ...existing.map(({ key }) => key)) + 1;
          const files = [...existing, ...photos.map((file, index) => ({ file, key: key + index }))];
          setAdding({ ...adding, albumFiles: files.length ? files : undefined });
        }
      }} /></label>}
      {addPhoto && addMixedAlbum && !adding.document && !adding.sticker && <label>{tr("Import Motion Photos into shortcut album")}<input type="file" multiple accept="image/jpeg,image/avif,image/heic,.jpg,.jpeg,.avif,.heic" disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void importAlbumPhotos(files);
          }} />
      </label>}
      {hasMotion && !albumSelected && <p role="status">{tr("Add another item to save the album.")}</p>}
      {adding.albumFiles && <ol aria-label={tr("Selected shortcut files")} role="list">
        {adding.albumFiles.map(({ file, key, motion }, index, files) => <li key={key}>
          <bdi>{file.name}</bdi>
          {motion && <bdi>{motion.name}</bdi>}
          {albumSelected && addMixedAlbum && quickReplyMediaKind(file.name) !== "video" && <label>{motion ? tr("Replace") : tr("Add")}{tr(" motion clip")}<input type="file" accept={videoAttachmentAccept} disabled={busy} onChange={(event) => {
              const clip = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!clip) return;
              if (!isVideoAttachmentName(clip.name) || !clip.size || clip.size > maxTelegramUploadBytes) {
                setAddError("Choose a non-empty MP4 or MOV clip within Telegram’s file size limit.");
                return;
              }
              setAdding({ ...adding, albumFiles: files.map((entry) => entry.key === key ? { ...entry, motion: clip } : entry) });
              setAddError("");
            }} />
          </label>}
          {motion && file.type !== "image/heic" && <button type="button" className="mtg-action" disabled={busy}
            onClick={() => setAdding({ ...adding, albumFiles: files.map((entry) => entry.key === key ? { ...entry, motion: undefined } : entry) })}>{tr("Remove motion clip")}</button>}
          {albumSelected && <>
            <button type="button" className="mtg-action" aria-label={tr("Move {0} up", [file.name])} disabled={busy || index === 0}
              onClick={() => {
                const next = files.slice();
                [next[index - 1], next[index]] = [files[index]!, files[index - 1]!];
                setAdding({ ...adding, albumFiles: next });
              }}>{tr("Move up")}</button>
            <button type="button" className="mtg-action" aria-label={tr("Move {0} down", [file.name])} disabled={busy || index === files.length - 1}
              onClick={() => {
                const next = files.slice();
                [next[index], next[index + 1]] = [files[index + 1]!, files[index]!];
                setAdding({ ...adding, albumFiles: next });
              }}>{tr("Move down")}</button>
            <button type="button" className="mtg-action" aria-label={tr("Remove {0}", [file.name])} disabled={busy}
              onClick={() => {
                const remaining = files.filter((entry) => entry.key !== key);
                const only = remaining.length === 1 ? remaining[0]?.file : undefined;
                if (only && quickReplyMediaKind(only.name) === "video") {
                  setAdding({ ...adding, albumFiles: undefined, document: only, mediaKind: "video" });
                } else setAdding({ ...adding, albumFiles: remaining });
              }}>{tr("Remove")}</button>
          </>}
        </li>)}
      </ol>}
      {addDocument && !adding.albumFiles && !adding.sticker && <label>{tr("Shortcut document ")}<input type="file" disabled={busy} onChange={(event) => {
        const document = event.currentTarget.files?.[0];
        if (document && (document.size < 1 || document.size > maxTelegramUploadBytes)) {
          event.currentTarget.value = "";
          setAddError("Choose a non-empty document within Telegram's file size limit.");
          setAdding({ ...adding, document: undefined, mediaKind: undefined });
        } else { setAddError(""); setAdding({ ...adding, document, mediaKind: undefined }); }
      }} /></label>}
      {mediaOption && <label>
        <input type="checkbox" checked={adding.mediaKind === mediaOption} disabled={busy} onChange={(event) =>
          setAdding({ ...adding, mediaKind: event.target.checked ? mediaOption : undefined })} />{tr(" Upload as ")}{mediaOption === "animation" ? "GIF" : mediaOption === "voice" ? tr("voice message") : mediaOption}
      </label>}
      {canUseVideoNote && <label>
        <input type="checkbox" checked={videoNote} disabled={busy} onChange={(event) =>
          setAdding({ ...adding, mediaKind: event.currentTarget.checked ? "videoNote" : undefined })} />{tr(" Upload as video note")}</label>}
      {attachment && <button type="button" className="mtg-action" disabled={busy}
        onClick={(event) => {
          const input = event.currentTarget.form?.querySelector<HTMLInputElement>(adding.albumFiles
            ? 'input[accept]' : 'input[type="file"]');
          if (input) input.value = "";
          setAdding({ ...adding, albumFiles: undefined, document: undefined, mediaKind: undefined });
        }}>{mixedAlbum ? tr("Remove selected files") : albumSelected ? tr("Remove selected photos")
          : adding.albumFiles ? tr("Remove selected photo") : tr("Remove selected document")}</button>}
      {stickers && !attachment && !adding.sticker && <button type="button" className="mtg-action"
        onClick={() => setPickingSticker((previous) => !previous)} disabled={busy}>{pickingSticker ? tr("Close sticker picker") : tr("Choose shortcut sticker")}</button>}
      {stickers && pickingSticker && !attachment && !adding.sticker &&
        <InstalledStickerPicker list={stickers.list} load={stickers.load} label={tr("Shortcut sticker pack")} busy={busy} choose={(sticker) => {
          setAdding({ ...adding, sticker });
          setPickingSticker(false);
          setAddError("");
        }} />}
      {adding.sticker && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setAdding({ ...adding, sticker: undefined })}>{tr("Remove sticker ")}<bdi>{adding.sticker.label}</bdi></button>}
      {!adding.sticker && !videoNote && <label>{albumSelected ? tr("Album caption") : adding.albumFiles ? tr("Photo caption") : adding.document ? tr("{0}{1} caption", [attachmentKind[0]!.toUpperCase(), attachmentKind.slice(1)]) : tr("Shortcut message")}
        <textarea ref={draftInput} value={adding.text} maxLength={attachment ? 1024 : 4096} disabled={busy}
          onChange={(event) => {
            formatting.change(event.currentTarget.value);
            setAdding({ ...adding, text: event.currentTarget.value });
          }}
          onSelect={(event) => formatting.select(event.currentTarget)}
          onKeyDown={formatting.shortcut} /></label>}
      {!adding.sticker && !videoNote && <>
        <DraftFormatButton formatting={formatting} busy={busy} />
        <DraftFormatControls formatting={formatting} busy={busy} />
      </>}
      {hasMediaOptions && <fieldset disabled={busy}>
        <legend>{mediaLabel === "GIF" ? tr("GIF options") : tr("{0}{1} options", [mediaLabel[0]!.toUpperCase(), mediaLabel.slice(1)])}</legend>
        <label><input type="checkbox" checked={!!adding.mediaSpoiler}
          onChange={(event) => setAdding({ ...adding, mediaSpoiler: event.currentTarget.checked })} /> {albumSelected ? tr("Hide album behind spoilers") : tr("Hide {0} behind a spoiler", [mediaLabel])}</label>
        <label><input type="checkbox" checked={!!adding.mediaCaptionAbove} disabled={!adding.text.trim()}
          onChange={(event) => setAdding({ ...adding, mediaCaptionAbove: event.currentTarget.checked })} />{tr(" Show caption above ")}{mediaLabel}</label>
      </fieldset>}
      {attachment && !videoNote && adding.text.trim().length > 1024 && <p role="alert">{tr("Captions can contain up to 1024 characters.")}</p>}
      </>}
      {uploadProgress && <>
        <progress aria-label={tr("Shortcut {0} upload", [attachmentKind])} value={uploadProgress.offset} max={uploadProgress.total} />
        <button type="button" className="mtg-action" disabled={!uploadProgress.canCancel}
          onClick={() => documentUpload.current?.abort()}>{tr("Cancel upload")}</button>
      </>}
      <button type="submit" className="mtg-action" disabled={busy || !canSaveMessage}>{tr("Save message")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => {
        formatting.clearSent(String(draftNumber), adding.text.trim());
        setAdding(undefined);
      }}>{tr("Cancel")}</button>
      {addError && <p role="alert">{tr(addError)}</p>}
    </form>}
    {replies?.length === 0 && <p>{tr("No quick replies.")}</p>}
    {!!replies?.length && <ol aria-label={tr("Quick reply shortcuts")}>{replies.map(({ id, name, messageCount, preview }, index) =>
      <li key={id}>
        <strong ref={review?.id === id && review.name === name ? reviewedHeading : undefined}
          tabIndex={review?.id === id && review.name === name ? -1 : undefined}><bdi>/{name}</bdi></strong> · {messageCount} {messageCount === 1 ? tr("message") : tr("messages")}
        {preview && <div><bdi>{preview}</bdi></div>}
        {replies.length > 1 && <>
          <button type="button" className="mtg-action" aria-label={tr("Move /{0} up", [name])}
            disabled={busy || !!orderError || index === 0} onClick={() => void moveShortcut(index, -1)}>{tr("Move up")}</button>
          <button type="button" className="mtg-action" aria-label={tr("Move /{0} down", [name])}
            disabled={busy || !!orderError || index === replies.length - 1} onClick={() => void moveShortcut(index, 1)}>{tr("Move down")}</button>
        </>}
        {editing?.id === id ? <form onSubmit={(event) => void saveName(event, name)}>
          <label>{tr("Shortcut name ")}<input value={editing.name} maxLength={128} disabled={busy}
            onChange={(event) => setEditing({ id, name: event.target.value })} /></label>
          <button type="submit" className="mtg-action" disabled={busy || !editing.name.trim() || editing.name.trim() === name}>{tr("Save name")}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setEditing(undefined)}>{tr("Cancel")}</button>
          {renameError && <p role="alert">{tr(renameError)}</p>}
        </form> : <button type="button" className="mtg-action" disabled={busy} onClick={() => {
          setAdding(undefined); setDeleting(undefined); setRenameError(""); setNotice(""); setEditing({ id, name });
        }}>{tr("Rename ")}<bdi>/{name}</bdi></button>}
        <button type="button" className="mtg-action" disabled={busy || !!adding} onClick={() => startAdd(name, id)}>{tr("Add message ")}<bdi>/{name}</bdi>
        </button>
        {deleting === id ? <div role="group" aria-label={tr("Delete /{0}", [name])}>
          <p>{tr("Delete ")}<bdi>/{name}</bdi>{tr(" and its ")}{messageCount} {messageCount === 1 ? tr("message") : tr("messages")}{tr(" from quick replies?")}</p>
          <button type="button" className="mtg-action" disabled={busy || !!deleteError}
            onClick={() => void deleteShortcut(id, name, messageCount)}>{tr("Delete shortcut")}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setDeleting(undefined)}>{tr("Cancel")}</button>
          {deleteError && <p role="alert">{tr(deleteError)}</p>}
        </div> : <button type="button" className="mtg-action" disabled={busy} onClick={() => {
          setAdding(undefined); setEditing(undefined); setNotice(""); setDeleteError(""); setDeleting(id);
        }}>{tr("Delete ")}<bdi>/{name}</bdi></button>}
        <button type="button" className="mtg-action" aria-expanded={selected === id}
          aria-controls={selected === id ? panelId : undefined} disabled={busy}
          onClick={() => setSelected(selected === id ? undefined : id)}>
          {selected === id ? tr("Hide messages") : tr("Show messages")} <bdi>/{name}</bdi>
        </button>
        {selected === id && <QuickReplyMessages key={id} id={id} panelId={panelId} load={loadMessages}
          retry={retryMessage && ((input) => retryMessage({ ...input, name }))}
          loadPhoto={loadPhoto} loadPlayback={loadPlayback} loadSticker={loadSticker} loadPollSticker={loadPollSticker} saveDocument={saveDocument} editText={editText} remove={removeMessage} onDeleted={(count, first) => {
            setReplies((current) => current?.flatMap((row) => row.id !== id ? [row] : count > 0
              ? [{ ...row, messageCount: count, ...(first ? { preview: undefined } : {}) }] : []));
            if (!count) setSelected(undefined);
            setNotice(count ? "Shortcut message deleted." : "Quick reply deleted with its last message.");
          }} />}
      </li>)}</ol>}
  </>;
}

function QuickReplyMessages({ id, panelId, load, loadPhoto, loadPlayback, loadSticker, loadPollSticker, saveDocument, editText, remove, retry, onDeleted }: {
  id: number; panelId: string; load: LoadMessages; loadPhoto?: LoadPhoto; loadPlayback?: LoadPlayback; loadSticker?: LoadSticker; loadPollSticker?: LoadPollSticker; saveDocument?: SaveDocument;
  editText: EditText; remove: DeleteMessage;
  retry?: (input: Omit<Parameters<RetryMessage>[0], "name">) => ReturnType<RetryMessage>;
  onDeleted: (remaining: number, first: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [messages, setMessages] = useState<Awaited<ReturnType<LoadMessages>> | null>();
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<number>();
  const [deleting, setDeleting] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [retryError, setRetryError] = useState(false);
  const pending = useRef(false);
  const hasPendingDelivery = messages?.some(({ delivery }) => delivery === "pending") === true;
  useEffect(() => {
    let active = true;
    void load(id).then((result) => { if (active) setMessages(result); }, () => { if (active) setMessages(null); });
    return () => { active = false; };
  }, [id, load, attempt]);
  useEffect(() => {
    if (busy || editing !== undefined || deleting !== undefined || retryError
      || !hasPendingDelivery) return;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      if (!active || attempts >= 12) return;
      timer = setTimeout(() => {
        if (pending.current) return;
        attempts++;
        void load(id).then((result) => {
          if (active && !pending.current) setMessages(result);
        }, () => {}).finally(schedule);
      }, 5_000);
    }
    schedule();
    return () => { active = false; clearTimeout(timer); };
  }, [id, load, hasPendingDelivery, busy, editing, deleting, retryError]);
  function reload() {
    setEditing(undefined);
    setDeleting(undefined);
    setRetryError(false);
    setMessages(undefined);
    setAttempt((value) => value + 1);
  }
  async function retryFailed(messageId: number, revision: string) {
    if (!retry || pending.current || retryError) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await retry({ id, messageId, revision });
      if (result === "submitted") reload();
      else setRetryError(true);
    } catch { setRetryError(true); }
    finally { pending.current = false; setBusy(false); }
  }
  async function deleteMessage(messageId: number, revision: string) {
    if (!messages || deleting !== messageId || pending.current) return;
    pending.current = true;
    setBusy(true);
    setDeleteError("");
    try {
      const result = await remove({ id, messageId, revision, messageCount: messages.length });
      if (result === "changed") {
        setDeleteError("This shortcut changed in Telegram.");
        return;
      }
      const remaining = messages.filter((message) => message.id !== messageId);
      setMessages(remaining);
      setDeleting(undefined);
      onDeleted(remaining.length, messages[0]?.id === messageId);
    } catch {
      setDeleteError("Could not confirm deletion.");
    } finally { pending.current = false; setBusy(false); }
  }
  const groups: { message: ShortcutMessage; index: number }[][] = [];
  messages?.forEach((message, index) => {
    const last = groups.at(-1);
    if (message.albumId && last?.[0]?.message.albumId === message.albumId) last.push({ message, index });
    else groups.push([{ message, index }]);
  });
  function renderText(message: ShortcutMessage) {
    return <MessageText text={message.text} styles={message.styles} links={message.links} customEmoji={message.customEmoji} />;
  }
  function renderMessage({ message, index }: { message: ShortcutMessage; index: number }, sharedCaptionId?: number) {
    const { document } = message;
    const fileId = document?.fileId;
    const text = message.id !== sharedCaptionId && renderText(message);
    return <li key={message.id}>
      {message.captionAboveMedia && text}
      {message.photo && loadPhoto ? <ShortcutPhoto key={message.photo.fileId} shortcutId={id} message={message}
        photo={message.photo} load={loadPhoto} play={message.delivery ? undefined : loadPlayback} />
        : message.playback && loadPlayback ? <ShortcutPlayback key={`${message.playback.fileId}:${message.playback.spoiler}`}
          shortcutId={id} messageId={message.id} media={message.playback} load={loadPlayback} />
        : message.tgsStickerFileId !== undefined && loadSticker ? <ShortcutSticker key={message.tgsStickerFileId}
          shortcutId={id} messageId={message.id} fileId={message.tgsStickerFileId} load={loadSticker} />
        : document ? <DocumentButton document={document}
          save={saveDocument && fileId !== undefined ? () => saveDocument(id, message.id, fileId) : undefined} />
        : message.contact ? <SharedContactCard contact={message.contact} chatId={String(id)}
          messageId={String(message.id)} actionable={false} />
        : message.location ? <LocationCard location={message.location} chatId={String(id)}
          messageId={String(message.id)} previewAllowed={false} />
        : message.poll ? <ShortcutPoll poll={message.poll} shortcutId={id} messageId={message.id}
          loadPhoto={message.delivery ? undefined : loadPhoto} play={message.delivery ? undefined : loadPlayback}
          save={message.delivery ? undefined : saveDocument} loadSticker={message.delivery ? undefined : loadPollSticker} />
        : message.mediaLabel && <small>{message.mediaLabel}</small>}
      {!message.captionAboveMedia && text}
      {message.delivery === "pending" && <small>{tr("Adding to shortcut…")}</small>}
      {message.delivery === "failed" && <small>{tr("Could not add this message.")}</small>}
      {retry && message.retryRevision && <button type="button" className="mtg-action"
        disabled={busy || retryError || editing !== undefined || deleting !== undefined}
        onClick={() => void retryFailed(message.id, message.retryRevision!)}>{tr("Retry adding message ")}{index + 1}</button>}
      {!message.text && !message.mediaLabel && <small>{tr("Message unavailable.")}</small>}
      {message.editRevision && (editing === message.id ? <ShortcutTextEditor shortcutId={id} message={message}
        revision={message.editRevision} save={editText} cancel={() => setEditing(undefined)} reload={reload}
        /> : <button type="button" className="mtg-action" disabled={busy || editing !== undefined || deleting !== undefined}
        onClick={() => setEditing(message.id)}>{message.photo ? tr("Edit photo caption") : message.mediaLabel ? tr("Edit caption") : tr("Edit message")} {index + 1}</button>)}
      {message.deleteRevision && (deleting === message.id ? <div role="group" aria-label={tr("Delete message {0}", [index + 1])}>
        <p>{messages?.length === 1 ? tr("Delete the last message and its shortcut?") : tr("Delete this message from the shortcut?")}</p>
        <button type="button" className="mtg-action" disabled={busy || !!deleteError}
          onClick={() => void deleteMessage(message.id, message.deleteRevision!)}>{tr("Delete message")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setDeleting(undefined)}>{tr("Cancel")}</button>
        {deleteError && <><p role="alert">{tr(deleteError)}</p>
          <button type="button" className="mtg-action" onClick={reload}>{tr("Reload shortcut messages")}</button></>}
      </div> : <button type="button" className="mtg-action" disabled={busy || editing !== undefined || deleting !== undefined}
        onClick={() => { setDeleteError(""); setDeleting(message.id); }}>{tr("Delete message ")}{index + 1}</button>)}
    </li>;
  }
  return <div id={panelId}>
    {retryError && <>
      <p role="alert">{tr("Could not confirm the retry. Reload the shortcut to check its current state.")}</p>
      <button type="button" className="mtg-action" onClick={reload}>{tr("Reload after retry")}</button>
    </>}
    {messages === undefined && <p role="status">{tr("Loading shortcut messages…")}</p>}
    {messages === null && <>
      <p role="alert">{tr("Could not load this shortcut.")}</p>
      <button type="button" className="mtg-action" onClick={() => { setMessages(undefined); setAttempt((value) => value + 1); }}>{tr("Retry shortcut")}</button>
    </>}
    {messages?.length === 0 && <p>{tr("No messages in this shortcut.")}</p>}
    {hasPendingDelivery && !retryError && <button type="button" className="mtg-action"
      disabled={busy || editing !== undefined || deleting !== undefined} onClick={reload}>{tr("Refresh message status")}</button>}
    {!!groups.length && <ol aria-label={tr("Shortcut messages")}>{groups.map((group) => {
      const first = group[0]!;
      if (group.length === 1) return renderMessage(first);
      const captions = group.map(({ message }) => message).filter(({ text }) => text.trim());
      const caption = captions.length === 1 ? captions[0] : undefined;
      return <li key={first.message.id}>
        {caption?.captionAboveMedia && renderText(caption)}
        <ol className="mtg-shortcut-album" role="list" aria-label={tr("Shortcut album")}>
          {group.map((item) => renderMessage(item, caption?.id))}
        </ol>
        {caption && !caption.captionAboveMedia && renderText(caption)}
      </li>;
    })}</ol>}
  </div>;
}

function ShortcutPoll({ poll, shortcutId, messageId, loadPhoto, play, save, loadSticker }: {
  poll: NonNullable<ShortcutMessage["poll"]>; shortcutId: number; messageId: number;
  loadPhoto?: LoadPhoto; play?: LoadPlayback; save?: SaveDocument; loadSticker?: LoadPollSticker;
}) {
  const { t: tr } = useTelegramLocale();
  const [explanationOpen, setExplanationOpen] = useState(false);
  const chatId = `shortcut:${shortcutId}`;
  const files = useMemo<Parameters<typeof PollFile>[0]["actions"]>(() => ({
    play: play && ((_id, _message, { fileId, slot }) => play(shortcutId, messageId, fileId, slot)),
    save: save && ((_id, _message, { fileId, slot }) => save(shortcutId, messageId, fileId, slot)),
  }), [play, save, shortcutId, messageId]);
  function renderMedia(media: PollMediaAttachment, slot: PollSlot) {
    if (media.kind === "location") return <LocationCard location={media.location} chatId={chatId}
      messageId={String(messageId)} previewAllowed={false} />;
    if (media.kind === "link") return <a className="mtg-poll-option-link" href={media.url}
      target="_blank" rel="noopener noreferrer">{media.title ?? media.url}</a>;
    if (media.kind === "file") return <PollFile key={`${slot}:${media.fileId}`} media={media} slot={slot}
      chatId={chatId} messageId={String(messageId)} actions={media.document.downloadable ? files : undefined} />;
    if (media.kind === "sticker") return loadSticker ? <StickerArtwork key={`${slot}:${media.fileId}`}
      id={String(media.fileId)} label={media.label}
      load={() => loadSticker(shortcutId, messageId, { slot, fileId: media.fileId })} /> : <bdi>{media.label}</bdi>;
    const motion = media.motion && play && <PhotoMotionPlayer key={`${slot}:${media.motion.fileId}`}
      chatId={chatId} messageId={`${messageId}:poll:${slot}`} motion={media.motion}
      play={(fileId) => play(shortcutId, messageId, fileId, slot)} />;
    return loadPhoto ? <PhotoPreview key={`${slot}:${media.fileId}:${media.previewId}`} dimensions={media.dimensions}
      chatId={chatId} messageId={`${messageId}:poll:${slot}:${media.fileId}`}
      load={(_id, _message, size) => loadPhoto(shortcutId, messageId, media.fileId, size, slot)} motion={motion} /> : motion;
  }
  return <div className="mtg-poll">
    <strong><bdi>{poll.question}</bdi></strong>
    {poll.media && renderMedia(poll.media, "question")}
    {poll.description && <p>{poll.description}</p>}
    <p>{poll.quiz ? tr("Quiz") : poll.multiple ? tr("Multiple answers") : tr("Poll")}</p>
    <ol>{poll.options.map((option) => <li key={option.index}><bdi>{option.text}</bdi>
      {option.media && renderMedia(option.media, option.index)}</li>)}</ol>
    {(poll.explanation || poll.explanationMedia) && <details onToggle={(event) => setExplanationOpen(event.currentTarget.open)}>
      <summary>{tr("Explanation")}</summary>
      {poll.explanation && <p>{poll.explanation}</p>}
      {explanationOpen && poll.explanationMedia && renderMedia(poll.explanationMedia, "explanation")}
    </details>}
  </div>;
}

function ShortcutSticker({ shortcutId, messageId, fileId, load }: {
  shortcutId: number; messageId: number; fileId: number; load: LoadSticker;
}) {
  const loadAnimation = useCallback(() => load(shortcutId, messageId, fileId), [load, shortcutId, messageId, fileId]);
  return <TgsSticker chatId={String(shortcutId)} messageId={String(messageId)} load={loadAnimation} />;
}

function ShortcutPhoto({ shortcutId, message, photo, load, play }: {
  shortcutId: number; message: ShortcutMessage; photo: NonNullable<ShortcutMessage["photo"]>; load: LoadPhoto; play?: LoadPlayback;
}) {
  const loadPreview = useCallback((_source: string, _messageId: string, size?: PhotoSize) =>
    load(shortcutId, message.id, photo.fileId, size), [load, shortcutId, message.id, photo.fileId]);
  return <PhotoPreview chatId={String(shortcutId)} messageId={String(message.id)} dimensions={photo.dimensions}
    spoiler={photo.spoiler} load={loadPreview}
    motion={photo.motion && play && <PhotoMotionPlayer key={photo.motion.fileId} chatId={`shortcut:${shortcutId}`}
      messageId={String(message.id)} motion={photo.motion} play={(fileId) => play(shortcutId, message.id, fileId)} />}
    caption={{ photoCaption: message.text, styles: message.styles, links: message.links, customEmoji: message.customEmoji }} />;
}

function ShortcutStaticSticker({ load }: { load: () => Promise<string> }) {
  const { t: tr } = useTelegramLocale();
  const frame = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void load().then((url) => { if (active) setSrc(url); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, load, visible]);

  return <span ref={frame} className="mtg-shortcut-static-sticker">
    {failed
      ? <button type="button" className="mtg-action" onClick={() => {
        setSrc(undefined);
        setFailed(false);
        setAttempt((previous) => previous + 1);
      }}>{tr("Retry sticker")}</button>
      : src ? <img alt={tr("Telegram sticker")} src={src} onError={() => setFailed(true)} />
      : <small role="status">{tr("Loading sticker…")}</small>}
  </span>;
}

function ShortcutPlayback({ shortcutId, messageId, media, load }: {
  shortcutId: number; messageId: number; media: NonNullable<ShortcutMessage["playback"]>; load: LoadPlayback;
}) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  const stream = useCallback(() => load(shortcutId, messageId, media.fileId), [load, shortcutId, messageId, media.fileId]);
  if (media.mime === "image/webp") return <ShortcutStaticSticker load={stream} />;
  if (media.spoiler && !revealed) return <button type="button" className="mtg-action" onClick={() => setRevealed(true)}>
    {media.loop ? tr("Show GIF spoiler") : tr("Show video spoiler")}
  </button>;
  return <MediaPlayer chatId={`shortcut:${shortcutId}`} messageId={String(messageId)} mime={media.mime} stream={stream}
    loop={media.loop} voiceNote={media.voiceNote} videoNote={media.videoNote} />;
}

function ShortcutTextEditor({ shortcutId, message, revision, save, cancel, reload }: {
  shortcutId: number; message: Awaited<ReturnType<LoadMessages>>[number]; revision: string;
  save: EditText; cancel: () => void; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const [text, setText] = useState(message.text);
  const [captionAbove, setCaptionAbove] = useState(!!message.captionAboveMedia);
  const originalSpoiler = message.mediaSpoiler ?? message.photo?.spoiler ?? message.playback?.spoiler ?? false;
  const [spoiler, setSpoiler] = useState(originalSpoiler);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const caption = !!message.mediaLabel || !!message.photo;
  const visualMedia = !!message.photo || message.mediaLabel === "Video" || message.mediaLabel === "Animation";
  const formatting = useDraftFormatting(String(message.id), text, input, message.styles, true, message.links?.filter((link) => link.hidden));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || stale || (!caption && !text.trim())) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await save({ id: shortcutId, messageId: message.id, revision, text: text.trim(),
        styles: formatting.deliveryStyles, links: formatting.deliveryLinks,
        ...(visualMedia && captionAbove !== !!message.captionAboveMedia && { captionAbove }),
        ...(visualMedia && spoiler !== originalSpoiler && { spoiler }) });
      if (result === "updated") reload();
      else if (result === "changed") {
        setStale(true);
        setError("This message changed in Telegram. Copy your draft before reloading.");
      } else setError("Telegram cannot use this text or formatting.");
    } catch {
      setError("Could not confirm the message update.");
    } finally { pending.current = false; setBusy(false); }
  }

  return <form onSubmit={(event) => void submit(event)}>
    <label>{message.photo ? tr("Shortcut photo caption") : caption ? tr("Shortcut caption") : tr("Shortcut message text")} <textarea ref={input} value={text}
      maxLength={caption ? 1024 : 4096} disabled={busy} readOnly={stale}
      onChange={(event) => { formatting.change(event.target.value); setText(event.target.value); }}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onKeyDown={stale ? undefined : formatting.shortcut} /></label>
    {visualMedia && <label><input type="checkbox" checked={spoiler} disabled={busy || stale}
      onChange={(event) => setSpoiler(event.currentTarget.checked)} />{tr(" Hide media behind a spoiler")}</label>}
    {visualMedia && <label><input type="checkbox" checked={captionAbove} disabled={busy || stale || !text.trim()}
      onChange={(event) => setCaptionAbove(event.currentTarget.checked)} />{tr(" Show caption above media")}</label>}
    <DraftFormatButton formatting={formatting} busy={busy || stale} />
    <DraftFormatControls formatting={formatting} busy={busy || stale} />
    <button type="submit" className="mtg-action" disabled={busy || stale || (!caption && !text.trim())}>{tr("Save changes")}</button>
    <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel")}</button>
    {error && <p role="alert">{tr(error)}</p>}
    {stale && <button type="button" className="mtg-action" onClick={reload}>{tr("Reload shortcut messages")}</button>}
  </form>;
}
