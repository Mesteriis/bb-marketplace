import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { moveDraftRanges, sameDraftCustomEmoji, sameDraftLinks, sameDraftStyles, validDraftCustomEmoji, validDraftLinks, validDraftStyles } from "../core/draft-formatting.ts";
import { ComposerEmojiPickers, type LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { DraftFormatButton, DraftFormatControls, draftFormattingShortcuts, draftLinkShortcuts, useDraftFormatting } from "./draft-formatting.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { isPlainKey } from "./composer-keys.ts";
import { maxTelegramUploadBytes, isVideoAttachmentName, videoAttachmentAccept, type CaptionPlacement, type DocumentSender, type EditCustomEmoji, type EditLinks, type ScheduledEdit, type SendResult, type StyledRange } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";

export type EditText = (chatId: string, messageId: string, text: string, original: string, originalStyles?: StyledRange[], styles?: StyledRange[], removeLinkPreview?: string, links?: EditLinks, scheduled?: ScheduledEdit, customEmoji?: EditCustomEmoji) => Promise<SendResult>;
export type EditCaption = (chatId: string, messageId: string, text: string, original: string,
  originalStyles?: StyledRange[], styles?: StyledRange[], placement?: CaptionPlacement, links?: EditLinks, scheduled?: ScheduledEdit, customEmoji?: EditCustomEmoji) => Promise<SendResult>;

export function lastEditableMessage(messages: readonly Message[], actions: { editText?: EditText; editCaption?: EditCaption }) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.outgoing && !message.retained && !message.pendingDelivery
      && (message.editableCaption ? actions.editCaption : message.editable && actions.editText)) return message;
  }
}

export function editableMessageText(message: Message) {
  return message.editableCaption ? message.photoCaption ?? message.document?.caption ?? "" : message.text;
}

export function submitMessageEdit(chatId: string, message: Message, text: string, actions: { editText?: EditText; editCaption?: EditCaption },
  styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement, links?: EditLinks, scheduled?: ScheduledEdit, customEmoji?: EditCustomEmoji) {
  const original = editableMessageText(message);
  if (message.editableCaption) {
    if (customEmoji) return actions.editCaption?.(chatId, message.id, text, original, message.styles, styles, placement, links, scheduled, customEmoji);
    if (scheduled) return actions.editCaption?.(chatId, message.id, text, original, message.styles, styles, placement, links, scheduled);
    return placement || links
      ? actions.editCaption?.(chatId, message.id, text, original, message.styles, styles, placement, ...(links ? [links] : []))
      : actions.editCaption?.(chatId, message.id, text, original, message.styles, styles);
  }
  const edit = actions.editText;
  if (!edit) return;
  if (customEmoji) return edit(chatId, message.id, text, original, message.styles, styles, removeLinkPreview, links, scheduled, customEmoji);
  if (scheduled) return edit(chatId, message.id, text, original, message.styles, styles, removeLinkPreview, links, scheduled);
  if (links) return edit(chatId, message.id, text, original, message.styles, styles, removeLinkPreview, links);
  return removeLinkPreview ? edit(chatId, message.id, text, original, message.styles, styles, removeLinkPreview)
    : styles !== undefined ? edit(chatId, message.id, text, original, message.styles, styles)
    : message.styles?.length ? edit(chatId, message.id, text, original, message.styles)
    : edit(chatId, message.id, text, original);
}

export type ReplacementProgress = Parameters<DocumentSender>[3];
export type AttachmentEditResult = Awaited<ReturnType<DocumentSender>>;
export type ReplaceAttachment = (id: string, messageId: string, edit: NonNullable<Message["attachmentEdit"]>, file: File,
  progress: ReplacementProgress, signal: AbortSignal, scheduled?: ScheduledEdit) => Promise<AttachmentEditResult>;
export type ReplacePhoto = (id: string, messageId: string, revision: string, base64: string, scheduled?: ScheduledEdit) => Promise<SendResult>;

export async function replacePreparedPhoto(replace: ReplacePhoto, chatId: string, message: Message, file: File, scheduled?: ScheduledEdit): Promise<SendResult> {
  if (!message.photoEditRevision) return { state: "failed" };
  let base64: string;
  try { base64 = await preparePhoto(file); }
  catch { return { state: "failed" }; }
  return replace(chatId, message.id, message.photoEditRevision, base64, scheduled);
}

export type EditDraft = { message: Message; text: string; busy: boolean; error?: string };

export function MessageEdit({ draft, change, cancel, save, replacePhoto, replaceAttachment, groupEmoji }: {
  draft: EditDraft;
  replacePhoto?: (file: File) => void;
  groupEmoji?: { id: string; load: LoadGroupEmoji };
  replaceAttachment?: (file: File, progress: ReplacementProgress, signal: AbortSignal) => Promise<void>;
  change: (text: string) => void;
  cancel: () => void;
  save: (event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement, links?: EditLinks, customEmoji?: EditCustomEmoji) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const originalAbove = draft.message.captionAboveMedia === true;
  const [above, setAbove] = useState(originalAbove);
  const [replacement, setReplacement] = useState<File>();
  const [invalidReplacement, setInvalidReplacement] = useState(false);
  const upload = useRef<AbortController | undefined>(undefined);
  const [uploadStatus, setUploadStatus] = useState<{ bytes: number; total: number; canCancel: boolean; cancelling?: true }>();
  useEffect(() => () => upload.current?.abort(), []);

  async function startReplacement(file: File) {
    if (replacePhoto) {
      replacePhoto(file);
      return;
    }
    if (!replaceAttachment || upload.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setUploadStatus({ bytes: 0, total: file.size, canCancel: true });
    try {
      await replaceAttachment(file, (bytes, canCancel = true) => {
        if (upload.current === controller && !controller.signal.aborted) setUploadStatus({ bytes, total: file.size, canCancel });
      }, controller.signal);
    } finally {
      if (upload.current === controller) {
        upload.current = undefined;
        setUploadStatus(undefined);
      }
    }
  }

  const [removePreview, setRemovePreview] = useState(false);
  const removeLinkPreview = removePreview ? draft.message.linkPreview?.url : undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const text = draft.text.trim();
  const original = draft.message.styles ?? [];
  const originalText = editableMessageText(draft.message);
  const caption = draft.message.editableCaption === true;
  const originalLinks = (draft.message.links ?? []).filter(({ hidden }) => hidden === true);
  const originalEmoji = draft.message.customEmoji ?? [];
  const formatting = useDraftFormatting(draft.message.id, draft.text, input,
    moveDraftRanges(originalText, draft.text, original), true, moveDraftRanges(originalText, draft.text, originalLinks),
    undefined, moveDraftRanges(originalText, draft.text, originalEmoji, true));
  const styles = formatting.deliveryStyles;
  const links = formatting.deliveryLinks;
  const customEmoji = formatting.deliveryCustomEmoji;
  const placement = caption && draft.message.canMoveCaption && text && above !== originalAbove
    ? { above, expected: originalAbove } : undefined;
  const replace = replacePhoto ?? replaceAttachment;
  const kind = replacePhoto ? "photo" : draft.message.attachmentEdit?.kind === "video" ? "video" : "file";
  const accept = kind === "photo" ? photoAccept : kind === "video" ? videoAttachmentAccept : undefined;
  const changed = (caption || !!text) && (text !== originalText || !sameDraftStyles(styles, original) || !sameDraftLinks(links, originalLinks) || !sameDraftCustomEmoji(customEmoji, originalEmoji) || !!removeLinkPreview || !!placement);
  const valid = changed && validDraftStyles(text, styles) && validDraftLinks(text, links, styles)
    && validDraftCustomEmoji(text, customEmoji, styles, links);

  return <form className="mtg-edit" onSubmit={(event) => {
    event.preventDefault();
    if (!valid || draft.busy) return;
    const retained = moveDraftRanges(originalText, text, original);
    const nextStyles = sameDraftStyles(styles, retained) ? undefined : styles;
    const linkEdit = originalLinks.length || links.length
      ? { original: originalLinks.map(({ offset, length, url }) => ({ offset, length, url })), replacement: links } : undefined;
    if (originalEmoji.length || customEmoji.length) save(event, nextStyles, removeLinkPreview, placement, linkEdit,
      { original: originalEmoji, replacement: customEmoji });
    else if (linkEdit) save(event, nextStyles, removeLinkPreview, placement, linkEdit);
    else if (placement) save(event, nextStyles, undefined, placement);
    else if (removeLinkPreview) save(event, nextStyles, removeLinkPreview);
    else save(event, nextStyles);
  }}>
    <label>{caption ? tr("Edit caption") : tr("Edit message")} <textarea ref={input} autoFocus value={draft.text} maxLength={4096} disabled={draft.busy}
      aria-keyshortcuts={`Escape Meta+Enter Control+Enter ${draftFormattingShortcuts} ${draftLinkShortcuts}`}
      onKeyDown={(event) => {
        if (draft.busy) return;
        if (isPlainKey(event, "Escape")) {
          event.preventDefault();
          cancel();
          return;
        }
        if (!event.defaultPrevented && event.key === "Enter" && event.metaKey !== event.ctrlKey
          && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
          event.preventDefault();
          if (valid && !event.repeat) event.currentTarget.form?.requestSubmit();
          return;
        }
        formatting.shortcut(event);
      }}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onPaste={(event) => { if (!draft.busy) formatting.paste(event, change); }}
      onChange={(event) => {
        formatting.change(event.currentTarget.value, event.currentTarget.selectionEnd);
        change(event.target.value);
      }} /></label>
    {caption && draft.message.canMoveCaption && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={above} disabled={draft.busy || !text}
        onChange={(event) => setAbove(event.currentTarget.checked)} />{tr(" Show caption above media")}</label>}
    {draft.message.linkPreview && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={removePreview} disabled={draft.busy}
        onChange={(event) => setRemovePreview(event.currentTarget.checked)} />{tr(" Remove link preview")}</label>}
    <ComposerEmojiPickers group={groupEmoji} disabled={draft.busy}
      insert={(choice) => formatting.insertCustomEmoji(choice, change)} />
    <DraftFormatControls formatting={formatting} busy={draft.busy} previewLabel="Formatted edit preview" />
    {replace && <>
      <label>{tr("Choose replacement ")}{kind} <input type="file" accept={accept} disabled={draft.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const invalid = !!file && (!file.size || (kind === "photo"
            ? !isPhotoMimeType(file.type) || file.size > maxOriginalPhotoBytes
            : file.size > maxTelegramUploadBytes || (kind === "video" && !isVideoAttachmentName(file.name))));
          setReplacement(invalid ? undefined : file);
          setInvalidReplacement(invalid);
        }} /></label>
      {invalidReplacement && <p role="alert">{kind === "photo" ? tr("Choose a JPEG, PNG, or WebP up to 64 MiB.")
        : kind === "video" ? tr("Choose a nonempty MP4 or MOV within Telegram’s upload limit.") : tr("Choose a nonempty file within Telegram’s upload limit.")}</p>}
      {replacement && <button type="button" className="mtg-action" disabled={draft.busy || changed || !!uploadStatus}
        onClick={() => void startReplacement(replacement)}>{tr("Replace ")}{kind}{tr(" and keep caption")}</button>}
    </>}
    {uploadStatus && <div>
      <progress aria-label={tr("Uploading replacement to BB")} max={uploadStatus.total} value={uploadStatus.bytes} />
      <p role="status">{uploadStatus.cancelling ? tr("Cancelling replacement…")
        : uploadStatus.bytes === uploadStatus.total ? tr("Waiting for Telegram to confirm the replacement…") : tr("Uploading replacement to BB…")}</p>
      {uploadStatus.canCancel && <button type="button" className="mtg-action" onClick={() => {
        upload.current?.abort();
        setUploadStatus({ ...uploadStatus, canCancel: false, cancelling: true });
      }}>{tr("Cancel replacement upload")}</button>}
    </div>}
    {draft.error && <p role="alert">{draft.error}</p>}
    <div>
      <DraftFormatButton formatting={formatting} busy={draft.busy} />
      <button type="button" className="mtg-action" disabled={draft.busy} onClick={cancel}>{tr("Cancel edit")}</button>
      <button type="submit" className="mtg-action" disabled={draft.busy || !valid}>{tr("Save edit")}</button>
    </div>
  </form>;
}
