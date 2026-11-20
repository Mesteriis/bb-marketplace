import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type Ref, type SetStateAction } from "react";
import { fitsRichMessageLimits, isStructuredRichTable, layoutRichTable, richButtonStyle, richCaptionDraft, richListNumbering, richMessageDraft, welcomeRichComposeDraft, type GroupEmojiChoice, type MediaDelivery, type RichButtonRow, type RichCaptionDraft, richListNumber, type RichDraftRange, type RichFormattedListItem, type RichMessageDraft,
  type RichMessageAvailability, type RichTableCell, type RichTableOptions, type WelcomeRichComposeDraft, type WelcomeRichEditView, isVideoAttachmentName, maxTelegramUploadBytes, videoAttachmentAccept } from "../core/contract.ts";
import { changeRichTableCells, richTableCellActions, type RichTableOperation } from "../core/rich-table-draft.ts";
import { webLink } from "../core/message-links.ts";
import { moveDraftRanges, moveRangesThroughEdit, sameDraftCustomEmoji, sameDraftLinks } from "../core/draft-formatting.ts";
import { outsidePastedText, readRichClipboardFormatting } from "./clipboard-formatting.ts";
import { isModifiedEnter, isPlainKey, isStashShortcut } from "./composer-keys.ts";
import { draftFormatFromShortcut, draftLinkShortcuts, inlineDraftFormattingShortcuts } from "./draft-formatting.tsx";
import { useDraftStashCheck, type RichComposerBlock as Block } from "./local-drafts.ts";
import { MessageText } from "./message-text.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparedPhotoBlob } from "./prepare-photo.ts";
import { EditDraftPhoto } from "./edit-draft-photo.tsx";
import { EditDraftVideo } from "./edit-draft-video.tsx";
import { ComposerEmojiPickers, type LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { inlineFormulaReplacements, MathFormula } from "./math-formula.tsx";
import type { DraftInlineButton } from "../core/contract.ts";
import { maxRichHtmlBytes, readRichHtmlFile } from "./rich-html-import.ts";
import { readRichHtmlArchive } from "./rich-html-archive.ts";

export type RichMessageComposerActions = {
  richMessageLimits: () => Promise<RichMessageAvailability>;
  sendRichMessage: (draft: RichMessageDraft, files: Blob[], signal: AbortSignal,
    progress: (uploaded: number, total: number, canCancel: boolean) => void, delivery?: MediaDelivery) => Promise<string>;
};

const blockTypes = {
  paragraph: "Paragraph", heading: "Heading", quote: "Quote", blockQuote: "Block quote", expandableQuote: "Expandable quote", code: "Code",
  bulletList: "Bulleted list", numberedList: "Numbered list", formattedList: "Formatted list", table: "Table",
  rule: "Divider", math: "Formula", buttons: "Button row", photo: "Photo", video: "Video", document: "File",
};
const blockTypeOptions = Object.entries(blockTypes) as [Block["kind"], string][];
const slashQuery = (text: string) => !/[\r\n]/.test(text) && /^\/[a-z -]{0,32}$/i.test(text)
  ? text.slice(1).trim().toLowerCase() : undefined;

const inlineStyles = {
  bold: "Bold", italic: "Italic", underline: "Underline", strike: "Strikethrough", code: "Monospace",
  spoiler: "Spoiler", marked: "Highlight", subscript: "Subscript", superscript: "Superscript",
} as const;
const inlineOptions = Object.entries(inlineStyles) as [RichDraftRange["style"], string][];
const tableToggles = [["bordered", "Show borders", true], ["striped", "Alternate row colors", false],
  ["compact", "Compact cells", false]] as const;
const styleable = (kind: Block["kind"]) => kind !== "rule" && kind !== "math" && kind !== "blockQuote"
  && kind !== "table" && kind !== "bulletList" && kind !== "numberedList" && kind !== "formattedList" && kind !== "buttons";
const isQuote = (kind: Block["kind"]) => kind === "quote" || kind === "expandableQuote" || kind === "blockQuote";
const isAttachment = (kind: Block["kind"]) => kind === "photo" || kind === "video" || kind === "document";
const hasTextEditor = (block: Block) => block.kind !== "rule" && block.kind !== "buttons" && !block.structuredTable
  && (!block.existingMedia || !!block.existingMedia.captionDraft);
const overlaps = (start: number, end: number) => ({ offset, length }: { offset: number; length: number }) =>
  offset < end && offset + length > start;

function validFile(kind: Block["kind"], file?: File) {
  if (!file || file.size <= 0 || file.size > maxTelegramUploadBytes) return false;
  if (kind === "photo") return isPhotoMimeType(file.type) && file.size <= maxOriginalPhotoBytes;
  return kind !== "video" || isVideoAttachmentName(file.name);
}

function expandInlineRange(block: Pick<RichCaptionDraft, "customEmoji" | "formulas">, start: number, end: number) {
  for (const { offset, length } of [...(block.customEmoji ?? []), ...(block.formulas ?? [])]) {
    if (offset < start && start < offset + length) start = offset;
    if (offset < end && end < offset + length) end = offset + length;
  }
  return { start, end };
}

function styledPaste(event: ClipboardEvent<HTMLTextAreaElement>, previous: RichCaptionDraft) {
  if (event.defaultPrevented) return;
  const editor = event.currentTarget;
  const pasted = readRichClipboardFormatting(event.clipboardData, editor.ownerDocument, editor.maxLength);
  if (!pasted) return;
  const { start, end } = expandInlineRange(previous, editor.selectionStart, editor.selectionEnd);
  const text = editor.value.slice(0, start) + pasted.text + editor.value.slice(end);
  if (text.length > editor.maxLength) return;
  const inserted: RichDraftRange[] = pasted.ranges.flatMap(({ style, offset, length }) =>
    style === "quote" || style === "expandableQuote" ? [] : [{ style, offset: offset + start, length }]);
  if (!inserted.length && !pasted.links.length) return;
  const length = pasted.text.length;
  const next = richCaptionDraft.safeParse({ text,
    styles: [...outsidePastedText(previous.styles ?? [], start, end, length), ...inserted],
    links: [...outsidePastedText(previous.links ?? [], start, end, length),
      ...pasted.links.map((link) => ({ ...link, offset: start + link.offset }))].sort((a, b) => a.offset - b.offset),
    customEmoji: moveRangesThroughEdit(previous.customEmoji ?? [], start, end, length, true),
    formulas: moveRangesThroughEdit(previous.formulas ?? [], start, end, length, true),
  });
  if (!next.success) return;
  event.preventDefault();
  const caret = start + length;
  requestAnimationFrame(() => {
    if (editor.isConnected && editor.value === text && editor.ownerDocument.activeElement === editor) {
      editor.setSelectionRange(caret, caret);
    }
  });
  return { draft: next.data, caret };
}

function hasInlineFormatting(draft: RichCaptionDraft) {
  return !!(draft.styles?.length || draft.links?.length || draft.customEmoji?.length || draft.formulas?.length);
}

function RichAnnotationField({ label, previewLabel, value, limit, change, editorRef, autoFocus, buttonLabel }: {
  label: string; previewLabel: string; value?: string | RichCaptionDraft; limit: number; change: (draft: RichCaptionDraft) => void;
  editorRef?: Ref<HTMLTextAreaElement>; autoFocus?: boolean; buttonLabel?: boolean;
}) {
  const previous = typeof value === "object" ? value : { text: value ?? "" };
  return <>
    <label>{label} <textarea rows={1} ref={editorRef} autoFocus={autoFocus} value={previous.text} maxLength={limit}
      aria-keyshortcuts={buttonLabel ? inlineDraftFormattingShortcuts : undefined}
      aria-invalid={buttonLabel && /[\r\n]/.test(previous.text) || undefined}
      onKeyDown={buttonLabel ? (event) => {
        const style = draftFormatFromShortcut(event);
        const { selectionStart, selectionEnd } = event.currentTarget;
        if (!style || style === "quote" || style === "expandableQuote" || selectionEnd <= selectionStart) return;
        event.preventDefault();
        if (event.repeat) return;
        const { start, end } = expandInlineRange(previous, selectionStart, selectionEnd);
        const styles = previous.styles ?? [];
        const matches = (range: RichDraftRange) => range.style === style && range.offset === start && range.length === end - start;
        const ranges = style === "clear" ? outsidePastedText(styles, start, end, end - start)
          : styles.some(matches) ? styles.filter((range) => !matches(range)) : [...styles, { style, offset: start, length: end - start }];
        const next = richCaptionDraft.safeParse({ ...previous, styles: ranges });
        if (next.success) change(next.data);
      } : undefined} onChange={(event) => {
      const { value: text, selectionStart: caret } = event.currentTarget;
      const before = previous.text;
      change({ text,
        ...(previous.styles?.length && { styles: moveDraftRanges(before, text, previous.styles, false, caret) }),
        ...(previous.links?.length && { links: moveDraftRanges(before, text, previous.links, false, caret) }),
        ...(previous.customEmoji?.length && { customEmoji: moveDraftRanges(before, text, previous.customEmoji, true, caret) }),
        ...(previous.formulas?.length && { formulas: moveDraftRanges(before, text, previous.formulas, false, caret) }),
      });
    }} onPaste={(event) => {
      const pasted = styledPaste(event, previous);
      if (pasted) change(buttonLabel ? { ...pasted.draft, links: undefined } : pasted.draft);
    }} /></label>
    {hasInlineFormatting(previous) && <div className="mtg-composer-format-preview" aria-label={previewLabel}>
      <MessageText {...previous} replacements={inlineFormulaReplacements(previous.text, previous.formulas)} />
    </div>}
  </>;
}

const listNumberingLabels = {
  "": "Bullet", "1": "Decimal", a: "Lowercase letters", A: "Uppercase letters",
  i: "Lowercase Roman numerals", I: "Uppercase Roman numerals",
} as const;

function FormattedListEditor({ index, entries, limit, update, firstEditor, autoFocus }: {
  index: number; entries: RichFormattedListItem[]; limit: number; autoFocus: boolean;
  update: (change: (entries: RichFormattedListItem[]) => RichFormattedListItem[]) => void;
  firstEditor: Ref<HTMLTextAreaElement>;
}) {
  const { t: tr } = useTelegramLocale();
  function edit(position: number, change: (item: RichFormattedListItem) => RichFormattedListItem) {
    update((before) => before.map((item, i) => i === position ? change(item) : item));
  }
  return <div role="group" aria-label={tr("Block {0} list items", [index])}>
    {entries.map(({ numbering, value, checked, paragraphs }, position) => <div key={position} role="group" aria-label={tr("List item {0}", [position + 1])}>
      <label>{tr("Marker ")}<select value={numbering} onChange={(event) => {
        const next = richListNumbering.parse(event.currentTarget.value);
        edit(position, (item) => ({ ...item, numbering: next, value: next ? (item.numbering ? item.value : position + 1) : 0 }));
      }}>
        {richListNumbering.options.map((key) => <option key={key} value={key}
          disabled={entries.length > 1 && !!key !== !!numbering}>{tr(listNumberingLabels[key])}</option>)}
      </select></label>
      {numbering && <label>{tr("Number ")}<input type="number" min={richListNumber.minValue ?? undefined} max={richListNumber.maxValue ?? undefined} value={Number.isNaN(value) ? "" : value}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          edit(position, (item) => ({ ...item, value: next }));
        }} /></label>}
      <label>{tr("Checkbox ")}<select value={checked === undefined ? "" : String(checked)} onChange={(event) => {
        const next = event.currentTarget.value;
        edit(position, (item) => ({ ...item, checked: next ? next === "true" : undefined }));
      }}><option value="">{tr("None")}</option><option value="false">{tr("Unchecked")}</option><option value="true">{tr("Checked")}</option></select></label>
      {paragraphs.map((paragraph, part) => {
        const label = tr("Item {0} paragraph {1}", [position + 1, part + 1]);
        const first = position === 0 && part === 0;
        return <div key={part}>
          <RichAnnotationField label={label} previewLabel={`${label} preview`} value={paragraph} limit={limit}
            editorRef={first ? firstEditor : undefined} autoFocus={first && autoFocus}
            change={(draft) => edit(position, (item) => ({ ...item,
              paragraphs: item.paragraphs.map((previous, i) => i === part ? draft : previous) }))} />
          {paragraphs.length > 1 && <button type="button" className="mtg-action" aria-label={tr("Remove {0}", [label.toLowerCase()])}
            onClick={() => edit(position, (item) => ({ ...item, paragraphs: item.paragraphs.filter((_, i) => i !== part) }))}>{tr("Remove")}</button>}
        </div>;
      })}
      <button type="button" className="mtg-action" disabled={paragraphs.length >= 16} onClick={() =>
        edit(position, (item) => ({ ...item, paragraphs: [...item.paragraphs, { text: "" }] }))}>{tr("Add item paragraph")}</button>
      {entries.length > 1 && <button type="button" className="mtg-action" aria-label={tr("Remove list item {0}", [position + 1])}
        onClick={() => update((before) => before.filter((_, i) => i !== position))}>{tr("Remove item")}</button>}
    </div>)}
    <button type="button" className="mtg-action" disabled={entries.length >= 64} onClick={() => update((before) => {
      const last = before.at(-1);
      const numbering = last?.numbering ?? "";
      const next = (last?.value ?? 0) + 1;
      const value = numbering ? richListNumber.safeParse(next).data ?? before.length + 1 : 0;
      return [...before, { numbering, value, paragraphs: [{ text: "" }] }];
    })}>{tr("Add list item")}</button>
  </div>;
}

function StructuredTableEditor({ index, rows, options, limit, update }: {
  index: number; rows: RichTableCell[][]; options?: RichTableOptions; limit: number;
  update: (change: (rows: RichTableCell[][]) => RichTableCell[][]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [selected, setSelected] = useState<{ row: number; column: number }>();
  const table = useRef<HTMLTableElement>(null);
  const layout = layoutRichTable(rows);
  if (!layout) return;
  const actions = selected && richTableCellActions(layout, selected.row, selected.column);
  function apply(operation: RichTableOperation) {
    if (!selected) return;
    const { row, column } = selected;
    update((before) => changeRichTableCells(before, row, column, operation) ?? before);
    requestAnimationFrame(() => table.current?.querySelector<HTMLTextAreaElement>(
      `[data-table-row="${row}"][data-table-column="${column}"] textarea`,
    )?.focus());
  }
  return <>
    <div className="mtg-rich-table mtg-rich-table-editor">
      <table ref={table} aria-label={tr("Block {0} table cells", [index])} data-bordered={options?.bordered !== false}
        data-striped={options?.striped || undefined} data-compact={options?.compact || undefined}>
        <tbody>{layout.rows.map((row, y) => <tr key={y}>{row.map(({ cell, column }, x) => {
          const Cell = cell.header ? "th" : "td";
          const label = tr("Row {0}, cell {1}", [y + 1, x + 1]);
          return <Cell key={column} colSpan={cell.colSpan} rowSpan={cell.rowSpan}
            data-table-row={y} data-table-column={column}
            aria-hidden={cell.content === null || undefined}
            onFocusCapture={() => setSelected({ row: y, column })}
            style={{ textAlign: cell.align, verticalAlign: cell.verticalAlign, visibility: cell.content === null ? "hidden" : undefined }}>
            {cell.content && <RichAnnotationField label={label} previewLabel={`${label} preview`}
              value={cell.content} limit={limit} change={(content) => update((current) => current.map((cells, row) => row === y
                ? cells.map((entry, cellIndex) => cellIndex === x && entry.content !== null ? { ...entry, content } : entry) : cells))} />}
          </Cell>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <div className="mtg-composer-media-buttons" role="group" aria-label={tr("Block {0} cell layout", [index])}>
      <button type="button" className="mtg-action" disabled={!actions?.right} onClick={() => apply("right")}>{tr("Merge right")}</button>
      <button type="button" className="mtg-action" disabled={!actions?.down} onClick={() => apply("down")}>{tr("Merge down")}</button>
      <button type="button" className="mtg-action" disabled={!actions?.split} onClick={() => apply("split")}>{tr("Split cell")}</button>
    </div>
  </>;
}

function selectedFormula(formulas: Block["formulas"], start: number, end: number) {
  return formulas?.find(({ offset, length }) => offset <= start && start < offset + length && end <= offset + length);
}

function nextInlineFormulas(block: Pick<Block, "text" | "formulas" | "styles" | "links" | "customEmoji">, start: number, end: number) {
  const existing = selectedFormula(block.formulas, start, end);
  if (!existing && start === end) return;
  const formulas = existing ? block.formulas?.filter((formula) => formula !== existing)
    : [...(block.formulas ?? []), { offset: start, length: end - start }].sort((a, b) => a.offset - b.offset);
  if (richCaptionDraft.safeParse({ ...block, formulas }).success) return formulas;
}

function ButtonFields({ button, change, previewLabel }: {
  button: RichButtonRow["buttons"][number];
  change: (button: RichButtonRow["buttons"][number]) => void;
  previewLabel: string;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
      <label>{tr("Action ")}<select value={button.kind} onChange={(event) => {
        const { label, style, labelFormat } = button;
        change(event.currentTarget.value === "copy"
          ? { kind: "copy", label, style, labelFormat, text: "" } : { kind: "url", label, style, labelFormat, url: "" });
      }}>
        <option value="url">{tr("Open link")}</option><option value="copy">{tr("Copy text")}</option>
      </select></label>
      <RichAnnotationField label={tr("Label")} previewLabel={previewLabel}
        value={{ text: button.label, ...button.labelFormat }} limit={256} buttonLabel
        change={({ text, styles, formulas, customEmoji }) => change({
          ...button, label: text, labelFormat: styles?.length || formulas?.length || customEmoji?.length ? { styles, formulas, customEmoji } : undefined,
        })} />
      {button.kind === "url" ? <label>URL <input type="url" required aria-invalid={!!button.url && !webLink(button.url)}
        maxLength={4096} value={button.url} onChange={(event) => change({ ...button, url: event.currentTarget.value })} /></label>
        : <label>{tr("Text to copy ")}<textarea required maxLength={256} value={button.text}
          onChange={(event) => change({ ...button, text: event.currentTarget.value })} /></label>}
      <label>{tr("Style ")}<select value={button.style ?? ""} onChange={(event) => {
        change({ ...button, style: richButtonStyle.safeParse(event.currentTarget.value).data });
      }}>
        <option value="">{tr("Default")}</option>
        {richButtonStyle.options.map((style) => <option key={style} value={style}>{style[0]!.toUpperCase() + style.slice(1)}</option>)}
      </select></label>
  </>;
}

function ButtonRowEditor({ row, onChange }: { row: RichButtonRow; onChange: (row: RichButtonRow) => void }) {
  const { t: tr } = useTelegramLocale();
  function update(index: number, button: RichButtonRow["buttons"][number]) {
    onChange({ ...row, buttons: row.buttons.map((current, position) => position === index ? button : current) });
  }
  return <fieldset>
    <legend>{tr("Button row")}</legend>
    <label>{tr("Alignment ")}<select value={row.align} onChange={(event) => {
      const align = event.currentTarget.value as RichButtonRow["align"];
      onChange({ ...row, align });
    }}>
      <option value="left">{tr("Left")}</option><option value="center">{tr("Center")}</option><option value="right">{tr("Right")}</option>
    </select></label>
    {row.buttons.map((button, index) => <fieldset key={index}>
      <legend>{tr("Button ")}{index + 1}</legend>
      <ButtonFields button={button} change={(value) => update(index, value)} previewLabel={`Button ${index + 1} label preview`} />
      <button type="button" className="mtg-action" disabled={row.buttons.length === 1}
        aria-label={tr("Remove button {0}", [index + 1])}
        onClick={() => onChange({ ...row, buttons: row.buttons.filter((_, position) => position !== index) })}>{tr("Remove button")}</button>
    </fieldset>)}
    <button type="button" className="mtg-action" disabled={row.buttons.length >= 20}
      onClick={() => onChange({ ...row, buttons: [...row.buttons, { kind: "url", label: "", url: "" }] })}>{tr("Add button")}</button>
  </fieldset>;
}

function draftBlock({ kind, text, file, editedPhoto, videoEdit, existingMedia, spoiler, styles, links, customEmoji, formulas, headingSize, language, tableOptions, structuredTable, quoteCredit, quoteParagraphs, listEntries, buttonRow, inlineButtons }: Block) {
  const size = editedPhoto?.blob.size ?? file?.size;
  const formatting = { ...(styles?.length ? { styles } : {}), ...(links?.length ? { links } : {}),
    ...(customEmoji?.length ? { customEmoji } : {}), ...(formulas?.length ? { formulas } : {}) };
  if (existingMedia) {
    const original = existingMedia.captionDraft;
    const changed = original && (text !== original.text || JSON.stringify(styles ?? []) !== JSON.stringify(original.styles ?? [])
      || !sameDraftLinks(links ?? [], original.links ?? [])
      || !sameDraftCustomEmoji(customEmoji ?? [], original.customEmoji ?? [])
      || JSON.stringify(formulas ?? []) !== JSON.stringify(original.formulas ?? []));
    const edit = changed ? { caption: text, captionEdit: { text, ...formatting } } : { caption: existingMedia.caption };
    return file && existingMedia.replaceKind ? {
      kind: existingMedia.replaceKind, name: file.name, size, ...edit,
      spoiler: false, replaces: existingMedia.index, ...(kind === "video" && videoEdit && { videoEdit }),
    } : { ...existingMedia, ...edit };
  }
  if (isAttachment(kind)) return {
    kind, name: file?.name, size, caption: text, spoiler: !!spoiler, ...formatting,
    ...(kind === "video" && videoEdit && { videoEdit }),
  };
  if (kind === "bulletList" || kind === "numberedList") {
    return { kind, items: text.split(/\r?\n/).filter((line) => line.trim()) };
  }
  if (kind === "formattedList") return { kind, entries: listEntries };
  if (kind === "buttons") return buttonRow;
  if (kind === "table") {
    return { kind, rows: structuredTable ?? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split("\t")),
      ...(tableOptions && { options: tableOptions }) };
  }
  if (kind === "rule") return { kind };
  if (kind === "math") return { kind, expression: text };
  if (kind === "blockQuote") return { kind, paragraphs: quoteParagraphs ?? [{ text, ...formatting }],
    ...(quoteCredit?.text && { credit: quoteCredit }) };
  return { kind, text, ...formatting,
    ...(kind === "paragraph" && inlineButtons?.length && { inlineButtons }),
    ...(kind === "heading" && headingSize !== undefined && headingSize !== 2 ? { headingSize } : {}),
    ...(kind === "code" && language?.trim() ? { language } : {}),
    ...(isQuote(kind) && quoteCredit?.text ? { credit: quoteCredit } : {}) };
}

function composerBlock(block: WelcomeRichEditView[number], id: number): Block {
  return block.kind === "existingMedia"
    ? { id, kind: block.replaceKind ?? "document", text: block.captionDraft?.text ?? "", styles: block.captionDraft?.styles,
      links: block.captionDraft?.links, customEmoji: block.captionDraft?.customEmoji, formulas: block.captionDraft?.formulas, existingMedia: block }
    : ({
    id, kind: block.kind, styles: "styles" in block ? block.styles : undefined,
    links: "links" in block ? block.links : undefined, customEmoji: "customEmoji" in block ? block.customEmoji : undefined,
    formulas: "formulas" in block ? block.formulas : undefined,
    headingSize: "headingSize" in block ? block.headingSize : undefined, language: "language" in block ? block.language : undefined,
    tableOptions: block.kind === "table" ? block.options : undefined,
    structuredTable: block.kind === "table" && isStructuredRichTable(block.rows) ? block.rows : undefined,
    quoteCredit: "credit" in block ? block.credit : undefined,
    listEntries: block.kind === "formattedList" ? block.entries : undefined,
    buttonRow: block.kind === "buttons" ? block : undefined,
    inlineButtons: "inlineButtons" in block ? block.inlineButtons : undefined,
    quoteParagraphs: block.kind === "blockQuote" ? block.paragraphs : undefined,
    text: "items" in block ? block.items.join("\n")
      : block.kind === "table" ? isStructuredRichTable(block.rows) ? "" : block.rows.map((row) => row.join("\t")).join("\n")
        : block.kind === "rule" || block.kind === "blockQuote" || block.kind === "formattedList" || block.kind === "buttons" ? "" : block.kind === "math" ? block.expression : block.text,
  });
}

export function RichMessageComposer({ load, send, disabled, scheduled, initial, existingDraft, saveExisting, cancel, savedDraft, textOnly, submitLabel, exchangeDraft, restoreRequest, focusOnOpen, groupEmoji }: {
  load: RichMessageComposerActions["richMessageLimits"];
  send?: (draft: RichMessageDraft, files: Blob[]) => void;
  disabled: boolean;
  scheduled: boolean;
  cancel?: () => void;
  textOnly?: boolean;
  submitLabel?: string;
  savedDraft?: { blocks?: Block[]; update: (change: (before: Block[] | undefined) => Block[]) => void };
  exchangeDraft?: (blocks: Block[], limits: Exclude<RichMessageAvailability, string | null>, restoreOnly: boolean, stillCurrent: () => boolean) => Block[] | undefined | Promise<Block[] | undefined>;
  restoreRequest?: number;
  focusOnOpen?: boolean;
  groupEmoji?: { id: string; load: LoadGroupEmoji };
  initial?: import("../core/contract.ts").RichEdit["draft"];
  existingDraft?: WelcomeRichEditView;
  saveExisting?: (draft: WelcomeRichComposeDraft, files: Blob[]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [limits, setLimits] = useState<RichMessageAvailability>();
  const startingDraft = existingDraft ?? initial;
  const [localBlocks, setLocalBlocks] = useState<Block[]>(() => startingDraft?.map(composerBlock)
    ?? [{ id: 0, kind: "paragraph", text: "" }]);
  const blocks = savedDraft?.blocks ?? localBlocks;
  const currentBlocks = useRef(blocks);
  currentBlocks.current = blocks;
  const htmlInput = useRef<HTMLInputElement>(null);
  const htmlLoad = useRef<AbortController>(undefined);
  const [htmlStatus, setHtmlStatus] = useState<"loading" | "imported" | "omitted" | "archive" | "archiveOmitted" | "unavailable" | "changed">();
  useEffect(() => () => htmlLoad.current?.abort(), []);
  function setBlocks(change: SetStateAction<Block[]>) {
    if (savedDraft) savedDraft.update((previous) => typeof change === "function" ? change(previous ?? localBlocks) : change);
    else setLocalBlocks(change);
  }
  const editors = useRef(new Map<number, HTMLTextAreaElement>());
  const slashMenuId = useId();
  const [slashMenu, setSlashMenu] = useState<{ blockId: number; active: number }>();
  const [selection, setSelection] = useState<{ id: number; start: number; end: number }>();
  const [linkDraft, setLinkDraft] = useState<{ id: number; start: number; end: number; text: string; url: string; existing: boolean; error?: string }>();
  const linkBlock = linkDraft && blocks.find((block) => block.id === linkDraft.id && block.text === linkDraft.text && styleable(block.kind));
  const editingLink = linkBlock ? linkDraft : undefined;
  const handledRestore = useRef(0);
  useEffect(() => {
    let active = true;
    void load().then((result) => { if (active) setLimits(result); }, () => { if (active) setLimits(null); });
    return () => { active = false; };
  }, [load]);

  const beginExchangeCheck = useDraftStashCheck(JSON.stringify([disabled, editingLink, limits]), blocks);
  function exchange(restoreOnly = false) {
    if (!exchangeDraft || disabled || editingLink || !limits || limits === "premium_required") return;
    const stillCurrent = beginExchangeCheck();
    const apply = (restored?: Block[]) => {
      if (!restored || !stillCurrent()) return;
      setSelection(undefined);
      setLinkDraft(undefined);
      setBlocks(restored);
      const first = restored.find(hasTextEditor);
      if (first) requestAnimationFrame(() => editors.current.get(first.id)?.focus());
    };
    const restored = exchangeDraft(blocks, limits, restoreOnly, stillCurrent);
    if (restored instanceof Promise) void restored.then(apply);
    else apply(restored);
  }

  useEffect(() => {
    if (!restoreRequest || restoreRequest === handledRestore.current || limits === undefined) return;
    handledRestore.current = restoreRequest;
    exchange(true);
  });

  function moveBlock(id: number, offset: number) {
    setBlocks((current) => {
      const from = current.findIndex((block) => block.id === id);
      const target = from + offset;
      if (from < 0 || target < 0 || target >= current.length) return current;
      const updated = [...current];
      const [block] = updated.splice(from, 1);
      updated.splice(target, 0, block!);
      return updated;
    });
  }

  function changeBlockType(id: number, type: Block["kind"], command?: string) {
    setBlocks((current) => current.map((block) => {
      if (block.id !== id || command !== undefined && (block.kind !== "paragraph" || block.text !== command)) return block;
      const inline: RichCaptionDraft = command === undefined ? block.quoteParagraphs?.[0] ?? block : { text: "" };
      return { ...block, kind: type, file: undefined, editedPhoto: undefined, videoEdit: undefined, spoiler: false, text: inline.text, inlineButtons: undefined,
        styles: styleable(type) ? inline.styles : undefined, links: styleable(type) ? inline.links : undefined,
        customEmoji: styleable(type) ? inline.customEmoji : undefined, formulas: styleable(type) ? inline.formulas : undefined,
        headingSize: type === "heading" ? block.headingSize : undefined, language: type === "code" ? block.language : undefined,
        tableOptions: type === "table" ? block.tableOptions : undefined,
        structuredTable: type === "table" ? block.structuredTable : undefined,
        buttonRow: type === "buttons" ? { kind: type, align: "left", buttons: [{ kind: "url", label: inline.text.slice(0, 256), url: "" }] } : undefined,
        listEntries: type === "formattedList" ? [{ numbering: "", value: 0, paragraphs: [{
          text: inline.text, styles: inline.styles, links: inline.links, customEmoji: inline.customEmoji, formulas: inline.formulas,
        }] }] : undefined,
        quoteCredit: isQuote(type) ? block.quoteCredit : undefined,
        quoteParagraphs: type === "blockQuote" ? [{ text: inline.text, styles: inline.styles, links: inline.links,
          customEmoji: inline.customEmoji, formulas: inline.formulas }] : undefined };
    }));
  }

  function chooseSlashBlock(block: Block, type: Block["kind"]) {
    const section = editors.current.get(block.id)?.closest("[data-rich-editor-block]");
    setSlashMenu(undefined);
    setSelection(undefined);
    changeBlockType(block.id, type, block.text);
    requestAnimationFrame(() => {
      const next = editors.current.get(block.id)
        ?? section?.querySelector<HTMLElement>('input[type="file"], textarea')
        ?? section?.querySelector<HTMLElement>("[data-block-type]");
      next?.focus({ preventScroll: true });
    });
  }

  function updateTableOptions(id: number, patch: RichTableOptions) {
    setBlocks((current) => current.map((block) => block.id === id && block.kind === "table"
      ? { ...block, tableOptions: { ...block.tableOptions, ...patch } } : block));
  }

  function updateQuoteParagraphs(id: number, change: (draft: RichCaptionDraft[]) => RichCaptionDraft[]) {
    setBlocks((current) => current.map((block) => block.id === id && block.kind === "blockQuote"
      ? { ...block, quoteParagraphs: change(block.quoteParagraphs ?? [{ text: block.text }]) } : block));
  }

  function updateStructuredTable(id: number, change: (rows: RichTableCell[][]) => RichTableCell[][]) {
    setBlocks((current) => current.map((block) => block.id === id && block.structuredTable
      ? { ...block, structuredTable: change(block.structuredTable) } : block));
  }

  function openCellEditor(id: number) {
    setBlocks((current) => current.map((block) => {
      if (block.id !== id || block.kind !== "table" || block.structuredTable) return block;
      const parsed = richMessageDraft.safeParse([draftBlock(block)]);
      const table = parsed.success ? parsed.data[0] : undefined;
      if (table?.kind !== "table" || isStructuredRichTable(table.rows)) return block;
      return { ...block, text: "", structuredTable: table.rows.map((row, index) => row.map((text) => ({
        content: { text }, header: index === 0, colSpan: 1, rowSpan: 1, align: "left", verticalAlign: "top",
      }))) };
    }));
  }

  function applyStyle(id: number, style: RichDraftRange["style"] | "clear", range = selection) {
    if (!range || range.id !== id || range.start === range.end) return;
    const selected = blocks.find((block) => block.id === id);
    if (!selected) return;
    const { start, end } = expandInlineRange(selected, range.start, range.end);
    if (selected.inlineButtons?.some(overlaps(start, end))) return;
    setBlocks((current) => current.map((block) => {
      if (block.id !== id) return block;
      const styles = block.styles ?? [];
      if (style === "clear") {
        const remaining = styles.flatMap((item) => {
          const right = item.offset + item.length;
          if (right <= start || item.offset >= end) return [item];
          return [
            ...(item.offset < start ? [{ ...item, length: start - item.offset }] : []),
            ...(right > end ? [{ ...item, offset: end, length: right - end }] : []),
          ];
        });
        return remaining.length <= 64 ? { ...block, styles: remaining } : block;
      }
      const exists = (range: RichDraftRange) => range.style === style && range.offset === start && range.length === end - start;
      return { ...block, styles: styles.some(exists) ? styles.filter((range) => !exists(range))
        : styles.length < 64 ? [...styles, { style, offset: start, length: end - start }] : styles };
    }));
    const editor = editors.current.get(id);
    editor?.focus();
    editor?.setSelectionRange(start, end);
  }

  function openLink(block: Block, start: number, end: number) {
    const existing = block.links?.find((link) => link.offset <= start && end <= link.offset + link.length
      && (start !== end || start < link.offset + link.length));
    if (!existing && end <= start) return false;
    const range = { id: block.id, ...expandInlineRange(block, existing?.offset ?? start, existing ? existing.offset + existing.length : end) };
    if (block.inlineButtons?.some(overlaps(range.start, range.end))) return false;
    setSelection(range);
    setLinkDraft({ ...range, text: block.text, url: existing?.url ?? "", existing: !!existing });
    return true;
  }

  function closeLink() {
    if (!editingLink) return;
    setLinkDraft(undefined);
    const editor = editors.current.get(editingLink.id);
    editor?.focus();
    editor?.setSelectionRange(editingLink.start, editingLink.end);
  }

  function saveLink(remove = false) {
    if (!editingLink || !linkBlock || disabled) return;
    const { start, end } = editingLink;
    const links = (linkBlock.links ?? []).filter((link) => link.offset !== start || link.offset + link.length !== end);
    if (!remove) {
      const url = webLink(editingLink.url.trim())?.href;
      if (!url || url.length > 4096) {
        setLinkDraft({ ...editingLink, error: "Enter a valid HTTP or HTTPS link." });
        return;
      }
      if (links.length >= 128 || links.some((link) => link.offset < end && link.offset + link.length > start)) {
        setLinkDraft({ ...editingLink, error: "This selection overlaps another link or exceeds the link limit." });
        return;
      }
      links.push({ offset: start, length: end - start, url, hidden: true });
      links.sort((a, b) => a.offset - b.offset);
    }
    setBlocks((current) => current.map((block) => block === linkBlock ? { ...block, links } : block));
    closeLink();
  }

  function pasteFormatting(event: ClipboardEvent<HTMLTextAreaElement>, block: Block) {
    if (disabled || !styleable(block.kind)) return;
    const pasted = styledPaste(event, block);
    if (!pasted) return;
    setBlocks((current) => current.map((item) => item.id === block.id ? { ...item, ...pasted.draft,
      inlineButtons: moveDraftRanges(item.text, pasted.draft.text, item.inlineButtons ?? [], true, pasted.caret),
    } : item));
    setSelection({ id: block.id, start: pasted.caret, end: pasted.caret });
  }

  function insertEmoji(id: number, choice: GroupEmojiChoice) {
    const editor = editors.current.get(id);
    const block = blocks.find((item) => item.id === id);
    if (!editor || !block || editor.value !== block.text || disabled) return false;
    const { start, end } = expandInlineRange(block, editor.selectionStart, editor.selectionEnd);
    const length = choice.emoji.length;
    const text = block.text.slice(0, start) + choice.emoji + block.text.slice(end);
    if (text.length > editor.maxLength) return false;
    const customEmoji = [...moveRangesThroughEdit(block.customEmoji ?? [], start, end, length, true),
      { id: choice.id, offset: start, length }];
    if (customEmoji.length > 128) return false;
    setBlocks((current) => current.map((item) => item === block ? { ...item, text, customEmoji,
      inlineButtons: moveRangesThroughEdit(item.inlineButtons ?? [], start, end, length, true),
      formulas: moveRangesThroughEdit(item.formulas ?? [], start, end, length, true),
      styles: moveRangesThroughEdit(item.styles ?? [], start, end, length),
      links: moveRangesThroughEdit(item.links ?? [], start, end, length) } : item));
    editor.focus();
    requestAnimationFrame(() => {
      if (editor.isConnected && editor.value === text) editor.setSelectionRange(start + length, start + length);
    });
    return true;
  }

  function toggleInlineFormula(id: number) {
    const block = blocks.find((item) => item.id === id);
    const editor = editors.current.get(id);
    if (!block || !editor || editor.value !== block.text || disabled) return;
    const { selectionStart: start, selectionEnd: end } = editor;
    if (block.inlineButtons?.some(overlaps(start, end))) return;
    const formulas = nextInlineFormulas(block, start, end);
    if (!formulas) return;
    setBlocks((current) => current.map((item) => item === block ? { ...item, formulas } : item));
    editor.focus();
    editor.setSelectionRange(start, end);
  }

  function inlineButtonSelection(block: Block) {
    if (block.kind !== "paragraph" || selection?.id !== block.id || editingLink || (block.inlineButtons?.length ?? 0) >= 32) return;
    const { start, end } = expandInlineRange(block, selection.start, selection.end);
    const label = block.text.slice(start, end);
    if (!label.trim() || label.length > 256 || /[\r\n]/.test(label)
      || block.links?.some(overlaps(start, end)) || block.inlineButtons?.some(overlaps(start, end))) return;
    return { start, end, label };
  }

  function addInlineButton(block: Block) {
    const range = inlineButtonSelection(block);
    if (!range) return;
    const { start, end, label } = range;
    const within = <T extends { offset: number; length: number }>(entries: readonly T[] = []) =>
      entries.filter(overlaps(start, end)).map((entry) => ({ ...entry, offset: Math.max(start, entry.offset) - start,
        length: Math.min(end, entry.offset + entry.length) - Math.max(start, entry.offset) }));
    const labelFormat = { styles: within(block.styles), formulas: within(block.formulas), customEmoji: within(block.customEmoji) };
    const button: DraftInlineButton = { offset: start, length: end - start, button: { kind: "url", label, url: "", labelFormat } };
    setBlocks((current) => current.map((item) => item === block ? { ...item,
      styles: outsidePastedText(item.styles ?? [], start, end, end - start),
      customEmoji: outsidePastedText(item.customEmoji ?? [], start, end, end - start),
      formulas: outsidePastedText(item.formulas ?? [], start, end, end - start),
      inlineButtons: [...(item.inlineButtons ?? []), button].sort((a, b) => a.offset - b.offset),
    } : item));
    setSelection(undefined);
  }

  function changeInlineButton(id: number, index: number, button: DraftInlineButton["button"]) {
    setBlocks((current) => current.map((item) => {
      const existing = item.inlineButtons?.[index];
      if (item.id !== id || !existing) return item;
      const start = existing.offset;
      const end = start + existing.length;
      const length = button.label.length;
      const text = item.text.slice(0, start) + button.label + item.text.slice(end);
      return { ...item, text,
        styles: moveRangesThroughEdit(item.styles ?? [], start, end, length),
        links: moveRangesThroughEdit(item.links ?? [], start, end, length),
        customEmoji: moveRangesThroughEdit(item.customEmoji ?? [], start, end, length, true),
        formulas: moveRangesThroughEdit(item.formulas ?? [], start, end, length, true),
        inlineButtons: item.inlineButtons!.map((part, position) => position < index ? part
          : position === index ? { offset: start, length, button } : { ...part, offset: part.offset + length - existing.length }),
      };
    }));
  }

  if (limits === undefined) return <p role="status">{tr("Checking formatted message availability…")}</p>;
  if (limits === "premium_required") return <p role="status">{tr("Telegram Premium is required to send formatted messages.")}</p>;
  if (!limits) return <p role="status">{tr("Formatted messages are unavailable with this TDLib connection.")}</p>;

  const typeOptions = blockTypeOptions.filter(([kind]) => !(initial || textOnly) || !isAttachment(kind));
  const typeDisabled = (kind: Block["kind"]) => kind === "table" && !limits.columns || isAttachment(kind) && !limits.media;
  const draftBlocks = blocks.map(draftBlock);
  const draft = richMessageDraft.safeParse(draftBlocks);
  const existing = existingDraft ? welcomeRichComposeDraft.safeParse(draftBlocks) : undefined;
  const mediaValid = blocks.every(({ kind, file, existingMedia }) => !isAttachment(kind) || (!!existingMedia && !file) || (!textOnly && validFile(kind, file)));
  const valid = existing ? existing.success && !!saveExisting && mediaValid && fitsRichMessageLimits(existing.data, limits)
    : draft.success && !!send && fitsRichMessageLimits(draft.data, limits) && mediaValid;
  const canExchangeDraft = !!exchangeDraft && !disabled && !editingLink;
  const firstTextId = startingDraft || focusOnOpen ? blocks.find(hasTextEditor)?.id : undefined;
  async function importHtml(file: File, document: Document) {
    if (disabled || htmlLoad.current) return;
    const archive = !textOnly && /\.tar$/i.test(file.name);
    if (!file.size || !archive && (file.size > maxRichHtmlBytes || !/\.html?$/i.test(file.name))) {
      setHtmlStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    htmlLoad.current = controller;
    setHtmlStatus("loading");
    try {
      const source = archive ? await readRichHtmlArchive(file, maxRichHtmlBytes, controller.signal) : { html: await file.text() };
      const parsed = source && readRichHtmlFile(source.html, document, "files" in source ? source.files : undefined);
      if (controller.signal.aborted) return;
      if (currentBlocks.current !== blocks) { setHtmlStatus("changed"); return; }
      const first = blocks[0];
      const base = blocks.length === 1 && first?.kind === "paragraph" && first.text === "" ? [] : blocks;
      if (!limits || limits === "premium_required" || !parsed || base.length + parsed.draft.length > limits.blocks) {
        setHtmlStatus("unavailable"); return;
      }
      const offset = base.length ? Math.max(...base.map(({ id }) => id)) + 1 : 0;
      const incoming = parsed.draft.map((block, index): Block => {
        const id = offset + index;
        if (!("file" in block)) return composerBlock(block, id);
        const { kind, file, caption } = block;
        return { id, kind, file, text: caption.text, styles: caption.styles, links: caption.links, formulas: caption.formulas };
      });
      const checkedImport = welcomeRichComposeDraft.safeParse(incoming.map(draftBlock));
      if (!checkedImport.success || !fitsRichMessageLimits(checkedImport.data, limits)
        || incoming.some(({ kind, file }) => isAttachment(kind) && !validFile(kind, file))) {
        setHtmlStatus("unavailable"); return;
      }
      const combined = [...base, ...incoming];
      const checked = welcomeRichComposeDraft.safeParse(combined.map(draftBlock));
      if (checked.success && !fitsRichMessageLimits(checked.data, limits)) { setHtmlStatus("unavailable"); return; }
      setSlashMenu(undefined);
      setSelection(undefined);
      setBlocks(combined);
      setHtmlStatus(archive ? parsed.omitted ? "archiveOmitted" : "archive" : parsed.omitted ? "omitted" : "imported");
      requestAnimationFrame(() => editors.current.get(offset)?.focus({ preventScroll: true }));
    } catch {
      if (!controller.signal.aborted) setHtmlStatus("unavailable");
    } finally {
      if (htmlLoad.current === controller) htmlLoad.current = undefined;
    }
  }
  function submit() {
    if (!valid || disabled || editingLink || htmlLoad.current) return;
    const files = blocks.flatMap(({ kind, file, editedPhoto }) => isAttachment(kind) && file ? [editedPhoto?.blob ?? file] : []);
    if (existing?.success) saveExisting?.(existing.data, files);
    else if (draft.success) send?.(draft.data, files);
  }

  return <fieldset aria-label={tr("Formatted message draft")} disabled={disabled} onKeyDown={(event) => {
    if (disabled || event.defaultPrevented) return;
    if (canExchangeDraft && isStashShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) exchange();
    } else if (isModifiedEnter(event)) {
      event.preventDefault();
      submit();
    } else if (cancel && isPlainKey(event, "Escape")) {
      event.preventDefault();
      cancel();
    }
  }}>
    {blocks.map((block, index) => {
      const { id, kind, text, file, editedPhoto, videoEdit, existingMedia, spoiler, styles, links, customEmoji, formulas, headingSize,
        language, tableOptions, structuredTable, quoteCredit, quoteParagraphs, listEntries, buttonRow, inlineButtons } = block;
      const selectionContainsButton = selection?.id === id && inlineButtons?.some(overlaps(selection.start, selection.end));
      const query = slashMenu?.blockId === id && !disabled && kind === "paragraph" ? slashQuery(text) : undefined;
      const slashOptions = query === undefined ? [] : typeOptions.filter(([type, label]) =>
        !typeDisabled(type) && label.toLowerCase().includes(query));
      const activeOption = Math.min(slashMenu?.active ?? 0, slashOptions.length - 1);
      return <div key={id} data-rich-editor-block>
      {existingMedia ? <>
        <p><bdi>{existingMedia.label}</bdi></p>
        {existingMedia.replaceKind && !textOnly && <>
          <label>{tr("Replace block ")}{index + 1}{tr(" file ")}<input type="file" key={file ? "replacement" : "original"}
            accept={kind === "photo" ? photoAccept : kind === "video" ? videoAttachmentAccept : undefined}
            onChange={(event) => {
              const replacement = event.currentTarget.files?.[0];
              setBlocks((current) => current.map((block) => block.id === id ? { ...block, file: replacement, editedPhoto: undefined, videoEdit: undefined } : block));
            }} /></label>
          {file && <><p><bdi>{file.name}</bdi></p>
            {!validFile(kind, file) && <p role="status">{tr("Choose a supported file within the upload limit.")}</p>}
            <button type="button" className="mtg-action" onClick={() => setBlocks((current) =>
              current.map((block) => block.id === id ? { ...block, file: undefined, editedPhoto: undefined, videoEdit: undefined } : block))}>{tr("Keep original file")}</button></>}
        </>}
      </> : <>
      <label>{tr("Block ")}{index + 1}{tr(" type ")}<select value={kind} disabled={!!structuredTable || !!inlineButtons?.length || !!listEntries?.some(({ paragraphs }) => paragraphs.some(({ text }) => !!text)) || (quoteParagraphs?.length ?? 0) > 1} data-block-type onChange={(event) => changeBlockType(id, event.currentTarget.value as Block["kind"])}>
        {typeOptions.map(([value, label]) => <option key={value} value={value} disabled={typeDisabled(value)}>{label}</option>)}
      </select></label>
      {kind === "heading" && <label>{tr("Block ")}{index + 1}{tr(" heading size ")}<select value={headingSize ?? 2} onChange={(event) => {
        const size = Number(event.currentTarget.value);
        setBlocks((current) => current.map((block) => block.id === id ? { ...block, headingSize: size } : block));
      }}>
        {[1, 2, 3, 4, 5, 6].map((size) => <option key={size} value={size}>{size === 1 ? tr("1 (largest)") : size === 6 ? tr("6 (smallest)") : size}</option>)}
      </select></label>}
      {kind === "code" && <label>{tr("Block ")}{index + 1}{tr(" code language ")}<input type="text" value={language ?? ""} maxLength={64}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setBlocks((current) => current.map((block) => block.id === id ? { ...block, language: value } : block));
        }} /></label>}
      {kind === "table" && <div role="group" aria-label={tr("Block {0} table options", [index + 1])}>
        <RichAnnotationField label={tr("Table caption")} previewLabel={`Block ${index + 1} table caption preview`}
          value={tableOptions?.caption} limit={limits.text}
          change={(draft) => updateTableOptions(id, { caption: hasInlineFormatting(draft) ? draft : draft.text })} />
        {tableToggles.map(([key, label, fallback]) => <label key={key}>
          <input type="checkbox" checked={tableOptions?.[key] ?? fallback}
            onChange={(event) => updateTableOptions(id, { [key]: event.currentTarget.checked })} /> {label}
        </label>)}
      </div>}
      {isAttachment(kind) && <>
        <label>{tr("Block ")}{index + 1}{tr(" file ")}<input key={kind} type="file"
          accept={kind === "photo" ? photoAccept : kind === "video" ? videoAttachmentAccept : undefined}
          onChange={(event) => {
            const value = event.currentTarget.files?.[0];
            setBlocks((current) => current.map((block) => block.id === id ? { ...block, file: value, editedPhoto: undefined, videoEdit: undefined } : block));
          }} /></label>
        {kind !== "document" && <label><input type="checkbox" checked={!!spoiler} onChange={(event) => {
          const value = event.currentTarget.checked;
          setBlocks((current) => current.map((block) => block.id === id ? { ...block, spoiler: value } : block));
        }} />{tr(" Hide with spoiler")}</label>}
        {file && <span className="mtg-document-size">{file.name}</span>}
        {file && !validFile(kind, file) && <p role="status">{tr("Choose a supported file within the upload limit.")}</p>}
      </>}
      </>}
      {kind === "photo" && file && validFile(kind, file) && <>
        {editedPhoto && <img className="mtg-attachment-preview" alt={tr("Edited photo for block {0}", [index + 1])}
          src={`data:image/jpeg;base64,${editedPhoto.data}`} />}
        <EditDraftPhoto source={editedPhoto?.data ?? file} label={tr("Edit photo in block {0}", [index + 1])} disabled={disabled} apply={(data) => {
          const blob = preparedPhotoBlob(data);
          setBlocks((current) => current.map((block) =>
            block.id === id && block.kind === "photo" && block.file === file && block.editedPhoto === editedPhoto
              ? { ...block, editedPhoto: { data, blob } } : block));
        }} />
        {editedPhoto && <button type="button" className="mtg-action" aria-label={tr("Reset photo edits in block {0}", [index + 1])}
          onClick={() => setBlocks((current) => current.map((block) => block.id === id ? { ...block, editedPhoto: undefined } : block))}>{tr("Reset edits")}</button>}
      </>}
      {kind === "video" && file && validFile(kind, file) && <EditDraftVideo file={file} value={videoEdit}
        itemLabel={`block ${index + 1}`} disabled={disabled} apply={(edit) => setBlocks((current) => current.map((block) =>
          block.id === id && block.kind === "video" && block.file === file && block.videoEdit === videoEdit
            ? { ...block, videoEdit: edit } : block))} />}
      {kind === "rule" && <hr />}
      {kind === "buttons" && buttonRow && <ButtonRowEditor row={buttonRow} onChange={(value) => {
        setBlocks((current) => current.map((block) => block.id === id && block.kind === "buttons" ? { ...block, buttonRow: value } : block));
      }} />}
      {kind === "blockQuote" && <div role="group" aria-label={tr("Block {0} quote paragraphs", [index + 1])}>
        {(quoteParagraphs ?? [{ text }]).map((paragraph, part) => <div key={part}>
          <RichAnnotationField label={tr("Quote paragraph {0}", [part + 1])} previewLabel={`Quote paragraph ${part + 1} preview`}
            value={paragraph} limit={limits.text} autoFocus={firstTextId === id && part === 0}
            editorRef={part === 0 ? (editor) => { if (editor) editors.current.set(id, editor); else editors.current.delete(id); } : undefined}
            change={(value) => updateQuoteParagraphs(id, (before) => before.map((item, position) => position === part ? value : item))} />
          {(quoteParagraphs?.length ?? 0) > 1 && <button type="button" className="mtg-action" aria-label={tr("Remove quote paragraph {0}", [part + 1])}
            onClick={() => updateQuoteParagraphs(id, (before) => before.filter((_, position) => position !== part))}>{tr("Remove")}</button>}
        </div>)}
        <button type="button" className="mtg-action" disabled={(quoteParagraphs?.length ?? 1) >= 16}
          onClick={() => updateQuoteParagraphs(id, (before) => before.length < 16 ? [...before, { text: "" }] : before)}>{tr("Add quote paragraph")}</button>
        <RichAnnotationField label={tr("Block {0} quote attribution", [index + 1])} previewLabel={`Block ${index + 1} attribution preview`}
          value={quoteCredit} limit={limits.text} change={(draft) => setBlocks((current) => current.map((block) =>
            block.id === id && block.kind === "blockQuote" ? { ...block, quoteCredit: draft } : block))} />
      </div>}
      {structuredTable && <StructuredTableEditor index={index + 1} rows={structuredTable} options={tableOptions} limit={limits.text}
        update={(change) => updateStructuredTable(id, change)} />}
      {kind === "formattedList" && listEntries && <FormattedListEditor index={index + 1} entries={listEntries} limit={limits.text}
        autoFocus={firstTextId === id} firstEditor={(editor) => { if (editor) editors.current.set(id, editor); else editors.current.delete(id); }}
        update={(change) => setBlocks((current) => current.map((block) => block.id === id && block.listEntries
          ? { ...block, listEntries: change(block.listEntries) } : block))} />}
      {kind !== "rule" && kind !== "blockQuote" && kind !== "formattedList" && kind !== "buttons" && !structuredTable && (!existingMedia || existingMedia.captionDraft) && <>
      <label>{tr("Block ")}{index + 1} {kind === "math" ? tr("LaTeX") : isAttachment(kind) ? tr("caption") : "text"}
        {kind === "table" && <span>{tr(" Paste cells from a spreadsheet. The first row becomes the header.")}</span>}
        {(kind === "bulletList" || kind === "numberedList") && <span>{tr(" Enter one item per line.")}</span>}
        <textarea autoFocus={firstTextId === id}
          onPaste={(event) => pasteFormatting(event, { id, kind, text, styles, links, customEmoji, formulas })}
          aria-controls={query === undefined ? undefined : slashMenuId}
          aria-activedescendant={activeOption < 0 ? undefined : `${slashMenuId}-${slashOptions[activeOption]?.[0]}`}
          onBlur={() => setSlashMenu((current) => current?.blockId === id ? undefined : current)}
          aria-keyshortcuts={`Meta+Enter Control+Enter${canExchangeDraft ? " Control+S" : ""}${cancel ? " Escape" : ""}${styleable(kind) ? ` ${inlineDraftFormattingShortcuts} ${draftLinkShortcuts}` : ""}`}
          onKeyDown={(event) => {
            if (query !== undefined) {
              if (isPlainKey(event, "Escape")) {
                event.preventDefault();
                setSlashMenu(undefined);
                return;
              }
              const down = isPlainKey(event, "ArrowDown");
              const up = isPlainKey(event, "ArrowUp");
              if (slashOptions.length && (down || up)) {
                event.preventDefault();
                const next = (activeOption + (down ? 1 : -1) + slashOptions.length) % slashOptions.length;
                setSlashMenu({ blockId: id, active: next });
                event.currentTarget.ownerDocument.getElementById(`${slashMenuId}-${slashOptions[next]?.[0]}`)
                  ?.scrollIntoView?.({ block: "nearest" });
                return;
              }
              const option = slashOptions[activeOption];
              if (option && isPlainKey(event, "Enter")) {
                event.preventDefault();
                chooseSlashBlock(block, option[0]);
                return;
              }
            }
            if (disabled || !styleable(kind)) return;
            const { selectionStart: start, selectionEnd: end } = event.currentTarget;
            if (!event.defaultPrevented && event.code === "KeyK" && event.metaKey !== event.ctrlKey
              && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
            && !event.repeat && openLink(block, start, end)) {
              event.preventDefault();
              return;
            }
            const style = draftFormatFromShortcut(event);
            if (!style || style === "quote" || style === "expandableQuote" || end <= start) return;
            event.preventDefault();
            if (event.repeat) return;
            const range = { id, start, end };
            setSelection(range);
            applyStyle(id, style, range);
          }}
          ref={(editor) => { if (editor) editors.current.set(id, editor); else editors.current.delete(id); }}
          onSelect={(event) => {
            const { selectionStart: start, selectionEnd: end } = event.currentTarget;
            setSelection({ id, start, end });
            if (start !== end || end !== text.length) setSlashMenu((current) => current?.blockId === id ? undefined : current);
          }}
          value={text} maxLength={kind === "table" ? limits.text + 32 * 16 : kind === "math" ? Math.min(limits.text, 4096) : limits.text} onChange={(event) => {
        const value = event.currentTarget.value;
        const caret = event.currentTarget.selectionStart;
        setSlashMenu(kind === "paragraph" && !existingMedia && !inlineButtons?.length && caret === value.length
          && slashQuery(value) !== undefined ? { blockId: id, active: 0 } : undefined);
        setSelection(undefined);
        setBlocks((current) => current.map((block) => block.id === id
          ? { ...block, text: value, styles: moveDraftRanges(block.text, value, block.styles ?? []),
            links: moveDraftRanges(block.text, value, block.links ?? []),
            inlineButtons: moveDraftRanges(block.text, value, block.inlineButtons ?? [], true, caret),
            customEmoji: moveDraftRanges(block.text, value, block.customEmoji ?? [], true, caret),
            formulas: moveDraftRanges(block.text, value, block.formulas ?? [], false, caret) } : block));
      }} /></label>
      {query !== undefined && <div className="mtg-rich-block-menu">
        <div id={slashMenuId} role="listbox" aria-label={tr("Insert block")}>
          {slashOptions.map(([type, label], position) => <button type="button" key={type} role="option"
            id={`${slashMenuId}-${type}`} tabIndex={-1} aria-selected={position === activeOption} className="mtg-action"
            onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlashBlock(block, type)}>{label}</button>)}
        </div>
        {!slashOptions.length && <p role="status">{tr("No matching blocks.")}</p>}
      </div>}
      {kind === "paragraph" && <button type="button" className="mtg-action" disabled={!inlineButtonSelection(block)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => addInlineButton(block)}>{tr("Turn selection into a button")}</button>}
      {inlineButtons?.map(({ button }, position) => <fieldset key={position}>
        <legend>{tr("Inline button ")}{position + 1}</legend>
        <ButtonFields button={button} previewLabel={`Inline button ${position + 1} label preview`}
          change={(value) => changeInlineButton(id, position, value)} />
        <button type="button" className="mtg-action" onClick={() => setBlocks((current) => current.map((item) =>
          item.id === id ? { ...item, inlineButtons: item.inlineButtons?.filter((_, index) => index !== position) } : item))}>{tr("Convert to plain text")}</button>
      </fieldset>)}
      {kind === "table" && <button type="button" className="mtg-action"
        disabled={!richMessageDraft.safeParse([draftBlock({ id, kind, text, tableOptions })]).success}
        onClick={(event) => {
          const container = event.currentTarget.parentElement;
          openCellEditor(id);
          requestAnimationFrame(() => container?.querySelector<HTMLTextAreaElement>(".mtg-rich-table-editor textarea")?.focus());
        }}>{tr("Edit individual cells")}</button>}
      {kind === "math" && text.trim() && text.length <= 4096 && <div className="mtg-rich-formula" aria-label={tr("Block {0} formula preview", [index + 1])}>
        <MathFormula expression={text} displayMode />
      </div>}
      {isQuote(kind) && <RichAnnotationField label={tr("Block {0} quote attribution", [index + 1])}
        previewLabel={`Block ${index + 1} attribution preview`} value={quoteCredit} limit={limits.text}
        change={(draft) => setBlocks((current) => current.map((block) => block.id === id && isQuote(block.kind)
          ? { ...block, quoteCredit: draft } : block))} />}
      {styleable(kind) && <ComposerEmojiPickers group={groupEmoji} disabled={disabled || !!editingLink}
        insert={(choice) => insertEmoji(id, choice)} />}
      {styleable(kind) && (selection?.id === id || !!styles?.length || !!links?.length || !!customEmoji?.length || !!formulas?.length) && <>
        <div className="mtg-composer-media-buttons" role="group" aria-label={tr("Format block {0}", [index + 1])}>
          {inlineOptions.map(([style, name]) => <button type="button" className="mtg-action" key={style}
            disabled={selection?.id !== id || selection.start === selection.end || selectionContainsButton}
            onMouseDown={(event) => event.preventDefault()} onClick={() => applyStyle(id, style)}>{name}</button>)}
          <button type="button" className="mtg-action" disabled={selection?.id !== id || selection.end <= selection.start || selectionContainsButton}
            onClick={() => { if (selection?.id === id) openLink(block, selection.start, selection.end); }}>{tr("Add or edit link")}</button>
          <button type="button" className="mtg-action" disabled={!!editingLink || selection?.id !== id || selectionContainsButton
            || !nextInlineFormulas({ text, styles, links, customEmoji, formulas }, selection.start, selection.end)}
            onMouseDown={(event) => event.preventDefault()} onClick={() => toggleInlineFormula(id)}>
            {selection?.id === id && selectedFormula(formulas, selection.start, selection.end) ? tr("Remove inline formula") : tr("Mark as inline formula")}
          </button>
          {!!styles?.length && <button type="button" className="mtg-action" onClick={() =>
            setBlocks((current) => current.map((block) => block.id === id ? { ...block, styles: undefined } : block))}>{tr("Clear formatting")}</button>}
        </div>
        {editingLink?.id === id && <div className="mtg-composer-format" role="group" aria-label={tr("Text link")}>
          <label>{tr("Link URL ")}<input type="url" value={editingLink.url} autoFocus maxLength={4096}
            onChange={(event) => setLinkDraft({ ...editingLink, url: event.currentTarget.value, error: undefined })}
            onKeyDown={(event) => {
              if (isPlainKey(event, "Escape")) {
                event.preventDefault();
                closeLink();
              } else if (isPlainKey(event, "Enter")) {
                event.preventDefault();
                saveLink();
              }
            }} /></label>
          <button type="button" className="mtg-action" onClick={() => saveLink()}>{tr("Apply link")}</button>
          {editingLink.existing && <button type="button" className="mtg-action" onClick={() => saveLink(true)}>{tr("Remove link")}</button>}
          <button type="button" className="mtg-action" onClick={closeLink}>{tr("Cancel link")}</button>
          {editingLink.error && <span role="alert">{editingLink.error}</span>}
        </div>}
        {!!(styles?.length || links?.length || customEmoji?.length || formulas?.length) && <div className="mtg-composer-format-preview" aria-label={tr("Block {0} formatting preview", [index + 1])}>
          <MessageText text={text} styles={styles} links={links} customEmoji={customEmoji} replacements={inlineFormulaReplacements(text, formulas)} />
        </div>}
      </>}
      </>}
      {blocks.length > 1 && <>
        <button type="button" className="mtg-action" disabled={index === 0} aria-label={tr("Move block {0} up", [index + 1])}
          onClick={() => moveBlock(id, -1)}>{tr("Move up")}</button>
        <button type="button" className="mtg-action" disabled={index === blocks.length - 1} aria-label={tr("Move block {0} down", [index + 1])}
          onClick={() => moveBlock(id, 1)}>{tr("Move down")}</button>
      </>}
      <button type="button" className="mtg-action" disabled={blocks.length === 1} aria-label={tr("Remove block {0}", [index + 1])}
        onClick={() => setBlocks((current) => current.filter((block) => block.id !== id))}>{tr("Remove")}</button>
    </div>;
    })}
    {!valid && blocks.every(({ existingMedia, structuredTable, quoteParagraphs, text, kind }) =>
      existingMedia || structuredTable || quoteParagraphs?.some((paragraph) => paragraph.text.trim()) || kind === "rule" || text.trim()) && <p role="status">{tr("Check the text and block limits. Table rows must have the same number of columns.")}</p>}
    <button type="button" className="mtg-action" disabled={blocks.length >= limits.blocks} onClick={() => {
      setBlocks((current) => [...current, { id: Math.max(...current.map((block) => block.id)) + 1, kind: "paragraph", text: "" }]);
    }}>{tr("Add block")}</button>
    <input type="file" ref={htmlInput} accept={textOnly ? ".html,.htm,text/html" : ".html,.htm,text/html,.tar,application/x-tar"} hidden onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void importHtml(file, event.currentTarget.ownerDocument);
    }} />
    <button type="button" className="mtg-action" disabled={htmlStatus === "loading" || !!editingLink}
      onClick={() => htmlInput.current?.click()}>{textOnly ? tr("Import HTML") : tr("Import HTML or TAR")}</button>
    {htmlStatus === "loading" && <p role="status">{tr("Reading file…")}</p>}
    {htmlStatus === "imported" && <p role="status">{tr("HTML added to draft.")}</p>}
    {htmlStatus === "omitted" && <p role="status">{tr("HTML added to draft. Unsupported content was skipped.")}</p>}
    {htmlStatus === "archive" && <p role="status">{tr("Archive added to draft.")}</p>}
    {htmlStatus === "archiveOmitted" && <p role="status">{tr("Archive added to draft. Unsupported content was skipped.")}</p>}
    {htmlStatus === "unavailable" && <p role="alert">{tr("Could not import the file. Check the file format and draft limits.")}</p>}
    {htmlStatus === "changed" && <p role="alert">{tr("The draft changed during import. Choose the file again to add it.")}</p>}
    {exchangeDraft && <button type="button" className="mtg-action" disabled={!canExchangeDraft} onClick={() => exchange()}>{tr("Exchange formatted draft")}</button>}
    <button type="button" className="mtg-action" disabled={!valid || !!editingLink || htmlStatus === "loading"}
      onClick={submit}>{submitLabel ?? (startingDraft ? tr("Save formatted message") : scheduled ? tr("Schedule formatted message") : tr("Send formatted message"))}</button>
  </fieldset>;
}
