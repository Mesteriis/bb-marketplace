import { useRef, useState, type FormEvent } from "react";
import { moveDraftStyles, sameDraftStyles, validDraftStyles } from "../core/draft-formatting.ts";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import type { CaptionPlacement, SendResult, StyledRange } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";

export type EditText = (chatId: string, messageId: string, text: string, original: string, originalStyles?: StyledRange[], styles?: StyledRange[], removeLinkPreview?: string) => Promise<SendResult>;
export type EditCaption = (chatId: string, messageId: string, text: string, original: string,
  originalStyles?: StyledRange[], styles?: StyledRange[], placement?: CaptionPlacement) => Promise<SendResult>;

export function editableMessageText(message: Message) {
  return message.editableCaption ? message.photoCaption ?? message.document?.caption ?? "" : message.text;
}

export function submitMessageEdit(chatId: string, message: Message, text: string, actions: { editText?: EditText; editCaption?: EditCaption },
  styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement) {
  const original = editableMessageText(message);
  if (message.editableCaption) {
    return placement
      ? actions.editCaption?.(chatId, message.id, text, original, message.styles, styles, placement)
      : actions.editCaption?.(chatId, message.id, text, original, message.styles, styles);
  }
  const edit = actions.editText;
  if (!edit) return;
  return removeLinkPreview ? edit(chatId, message.id, text, original, message.styles, styles, removeLinkPreview)
    : styles !== undefined ? edit(chatId, message.id, text, original, message.styles, styles)
    : message.styles?.length ? edit(chatId, message.id, text, original, message.styles)
    : edit(chatId, message.id, text, original);
}

export type EditDraft = { message: Message; text: string; busy: boolean; error?: string };

export function MessageEdit({ draft, change, cancel, save }: {
  draft: EditDraft;
  change: (text: string) => void;
  cancel: () => void;
  save: (event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement) => void;
}) {
  const originalAbove = draft.message.captionAboveMedia === true;
  const [above, setAbove] = useState(originalAbove);
  const [removePreview, setRemovePreview] = useState(false);
  const removeLinkPreview = removePreview ? draft.message.linkPreview?.url : undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const text = draft.text.trim();
  const original = draft.message.styles ?? [];
  const originalText = editableMessageText(draft.message);
  const caption = draft.message.editableCaption === true;
  const formatting = useDraftFormatting(draft.message.id, draft.text, input,
    moveDraftStyles(originalText, draft.text, original));
  const styles = formatting.deliveryStyles;
  const placement = caption && draft.message.canMoveCaption && text && above !== originalAbove
    ? { above, expected: originalAbove } : undefined;
  const changed = (caption || !!text) && (text !== originalText || !sameDraftStyles(styles, original) || !!removeLinkPreview || !!placement);
  const valid = changed && validDraftStyles(text, styles);

  return <form className="mtg-edit" onSubmit={(event) => {
    event.preventDefault();
    if (!valid || draft.busy) return;
    const retained = moveDraftStyles(originalText, text, original);
    const nextStyles = sameDraftStyles(styles, retained) ? undefined : styles;
    if (placement) save(event, nextStyles, undefined, placement);
    else if (removeLinkPreview) save(event, nextStyles, removeLinkPreview);
    else save(event, nextStyles);
  }}>
    <label>{caption ? "Edit caption" : "Edit message"} <textarea ref={input} autoFocus value={draft.text} maxLength={4096} disabled={draft.busy}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onChange={(event) => {
        formatting.change(event.target.value);
        change(event.target.value);
      }} /></label>
    {caption && draft.message.canMoveCaption && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={above} disabled={draft.busy || !text}
        onChange={(event) => setAbove(event.currentTarget.checked)} /> Show caption above media
    </label>}
    {draft.message.linkPreview && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={removePreview} disabled={draft.busy}
        onChange={(event) => setRemovePreview(event.currentTarget.checked)} /> Remove link preview
    </label>}
    <DraftFormatControls formatting={formatting} busy={draft.busy} previewLabel="Formatted edit preview" />
    {draft.error && <p role="alert">{draft.error}</p>}
    <div>
      <DraftFormatButton formatting={formatting} busy={draft.busy} />
      <button type="button" className="mtg-action" disabled={draft.busy} onClick={cancel}>Cancel edit</button>
      <button type="submit" className="mtg-action" disabled={draft.busy || !valid}>Save edit</button>
    </div>
  </form>;
}
