import { createHash } from "node:crypto";
import { richBotCommand, customEmojiId, editableRichDraft, isStructuredRichTable, richCodeLanguage, richHeadingSize, richMathExpression, richListNumber, richListNumbering, welcomeRichEditView, type CustomEmojiRange, type EditableRichDraft, type ExistingWelcomeMedia, type RichCaptionDraft, type RichDraftRange, type RichEdit, type RichAttachmentReference, type RichFormulaRange, type RichFormattedListItem, type RichInline, type RichMessageBlock, type RichMessageLayout, type RichTableCell } from "../../core/contract.ts";
import { numberedMarker } from "../../core/rich-message-text.ts";
import { maskSpoilers } from "../../core/message-spoilers.ts";
import { tonAddress } from "../../core/ton-address.ts";
import { webLink, type MessageLink } from "../../core/message-links.ts";
import { articleButtonAction, articleButtons, tdRichButtonStyles } from "./instant-view.ts";
import type { TdObject } from "./tdjson.ts";
import { draftRichButton, type DraftInlineButton } from "../../core/contract.ts";

function object(value: unknown): TdObject | undefined {
  return value && typeof value === "object" && "@type" in value ? value as TdObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const styles = new Map<string, RichDraftRange["style"]>([
  ["richTextBold", "bold"], ["richTextItalic", "italic"], ["richTextUnderline", "underline"],
  ["richTextStrikethrough", "strike"], ["richTextFixed", "code"], ["richTextSpoiler", "spoiler"],
  ["richTextSubscript", "subscript"], ["richTextSuperscript", "superscript"], ["richTextMarked", "marked"],
]);
const inputStyles = new Map([...styles].map(([type, style]) => [style, type]));
const blockTypes = new Map<string, [Exclude<Extract<RichMessageBlock, { content: RichInline }>["kind"], "photo" | "document">, string]>([
  ["pageBlockTitle", ["title", "title"]], ["pageBlockSubtitle", ["heading", "subtitle"]],
  ["pageBlockHeader", ["heading", "header"]], ["pageBlockSubheader", ["heading", "subheader"]],
  ["pageBlockSectionHeading", ["heading", "text"]], ["pageBlockKicker", ["heading", "kicker"]],
  ["pageBlockParagraph", ["paragraph", "text"]], ["pageBlockFooter", ["paragraph", "footer"]],
  ["pageBlockPreformatted", ["code", "text"]], ["pageBlockPullQuote", ["quote", "text"]],
  ["pageBlockExpandableBlockQuote", ["quote", "text"]],
]);
const attachmentNames = new Map([
  ["pageBlockPhoto", "Photo"], ["pageBlockVideo", "Video"], ["pageBlockAnimation", "GIF"],
  ["pageBlockAudio", "Audio"], ["pageBlockDocument", "File"], ["pageBlockVoiceNote", "Voice message"],
]);
const quotableMediaCaptions = new Set(["pageBlockPhoto", "pageBlockVideo", "pageBlockAnimation", "pageBlockAudio", "pageBlockVoiceNote"]);

export function richPlain(text: string): TdObject {
  return { "@type": "richTextPlain", text };
}

type RichInlineAtom = CustomEmojiRange | RichFormulaRange;

export function richInputText({ text, styles: ranges = [], links = [], customEmoji = [], formulas = [] }: RichCaptionDraft,
  buttons: readonly DraftInlineButton[] = []): TdObject {
  const atoms = [...customEmoji, ...formulas];
  function styledSlice(from: number, to: number) {
    const relative = ranges.flatMap(({ style, offset, length }) => {
      const start = Math.max(from, offset);
      const end = Math.min(to, offset + length);
      return start < end ? [{ style, offset: start - from, length: end - start }] : [];
    });
    const relativeAtoms = atoms.filter(({ offset, length }) => offset >= from && offset + length <= to)
      .map((item) => ({ ...item, offset: item.offset - from }));
    return richStyledInput(text.slice(from, to), relative, relativeAtoms);
  }
  if (!links.length && !buttons.length) return richStyledInput(text, ranges, atoms);
  let cursor = 0;
  const texts: TdObject[] = [];
  for (const part of [...links, ...buttons].sort((a, b) => a.offset - b.offset)) {
    const { offset, length } = part;
    if (cursor < offset) texts.push(styledSlice(cursor, offset));
    const end = offset + length;
    texts.push("button" in part ? { "@type": "richTextButton", button: inputRichButton(part.button) }
      : { "@type": "richTextUrl", url: part.url, is_cached: false, text: styledSlice(offset, end) });
    cursor = end;
  }
  if (cursor < text.length) texts.push(styledSlice(cursor, text.length));
  return texts.length === 1 ? texts[0]! : { "@type": "richTexts", texts };
}

function inputRichButton(button: DraftInlineButton["button"]): TdObject {
  return { "@type": "inlineButton", text: richInputText({ text: button.label, ...button.labelFormat }),
    style: { "@type": inputRichButtonStyle.get(button.style ?? "") ?? "buttonStyleDefault" },
    type: button.kind === "url" ? { "@type": "inlineKeyboardButtonTypeUrl", url: webLink(button.url)!.href }
      : { "@type": "inlineKeyboardButtonTypeCopyText", text: button.text },
  };
}

function richStyledInput(text: string, ranges: readonly RichDraftRange[], atoms: readonly RichInlineAtom[]): TdObject {
  if (!ranges.length && !atoms.length) return richPlain(text);
  const atomAt = new Map(atoms.map((atom) => [atom.offset, atom]));
  const boundaries = [...new Set([0, text.length, ...[...ranges, ...atoms].flatMap(({ offset, length }) => [offset, offset + length])])]
    .sort((a, b) => a - b);
  const texts = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const active = new Set(ranges.filter(({ offset, length }) => offset <= start && offset + length >= end).map(({ style }) => style));
    const label = text.slice(start, end);
    const atom = atomAt.get(start);
    let value = !atom ? richPlain(label) : "id" in atom
      ? { "@type": "richTextCustomEmoji", custom_emoji_id: atom.id, alternative_text: label }
      : { "@type": "richTextMathematicalExpression", expression: label };
    for (const style of active) value = { "@type": inputStyles.get(style)!, text: value };
    return value;
  });
  return texts.length === 1 ? texts[0]! : { "@type": "richTexts", texts };
}

export function richInputTextBlock(block: EditableRichDraft[number]): TdObject {
  if (block.kind === "rule") return { "@type": "inputPageBlockDivider" };
  if (block.kind === "math") return { "@type": "inputPageBlockMathematicalExpression", expression: block.expression };
  if (block.kind === "buttons") return {
    "@type": "inputPageBlockButtonRow",
    align: { "@type": inputCellAlignment.get(block.align) },
    buttons: block.buttons.map(inputRichButton),
  };
  if (block.kind === "blockQuote") return {
    "@type": "inputPageBlockBlockQuote",
    blocks: block.paragraphs.map((paragraph) => ({ "@type": "inputPageBlockParagraph", text: richInputText(paragraph) })),
    credit: block.credit ? richInputText(block.credit) : richPlain(""),
  };
  if (block.kind === "formattedList") return {
    "@type": "inputPageBlockList",
    items: block.entries.map(({ numbering, value, checked, paragraphs }) => ({
      "@type": "inputPageBlockListItem", type: numbering, value, has_checkbox: checked !== undefined,
      is_checked: checked === true,
      blocks: paragraphs.map((paragraph) => ({ "@type": "inputPageBlockParagraph", text: richInputText(paragraph) })),
    })),
  };
  if ("items" in block) {
    const ordered = block.kind === "numberedList";
    return { "@type": "inputPageBlockList", items: block.items.map((text, index) => ({
      "@type": "inputPageBlockListItem", blocks: [richInputTextBlock({ kind: "paragraph", text })],
      value: ordered ? index + 1 : 0, type: ordered ? "1" : "", has_checkbox: false, is_checked: false,
    })) };
  }
  if (block.kind === "table") {
    const { caption, bordered, striped, compact } = block.options ?? {};
    const cells = isStructuredRichTable(block.rows)
      ? block.rows.map((row) => row.map(({ content, header, colSpan, rowSpan, align, verticalAlign }) => ({
        "@type": "pageBlockTableCell", text: content === null ? null : richInputText(content),
        is_header: header, colspan: colSpan, rowspan: rowSpan,
        align: { "@type": inputCellAlignment.get(align) }, valign: { "@type": inputCellVerticalAlignment.get(verticalAlign) },
      })))
      : block.rows.map((row, index) => row.map((text) => ({
        "@type": "pageBlockTableCell", text: richPlain(text), is_header: index === 0, colspan: 1, rowspan: 1,
        align: { "@type": "pageBlockHorizontalAlignmentLeft" }, valign: { "@type": "pageBlockVerticalAlignmentTop" },
      })));
    return {
      "@type": "inputPageBlockTable", caption: typeof caption === "object" ? richInputText(caption) : richPlain(caption ?? ""),
      is_bordered: bordered ?? true, is_striped: striped ?? false, is_compact: compact ?? false,
      cells,
    };
  }
  const content = richInputText(block, block.inlineButtons);
  switch (block.kind) {
    case "heading": return { "@type": "inputPageBlockSectionHeading", text: content, size: block.headingSize ?? 2 };
    case "quote":
    case "expandableQuote": {
      const credit = block.credit;
      return { "@type": block.kind === "quote" ? "inputPageBlockPullQuote" : "inputPageBlockExpandableBlockQuote", text: content,
        credit: credit ? richInputText(credit) : richPlain("") };
    }
    case "code": return { "@type": "inputPageBlockPreformatted", text: content, language: block.language ?? "" };
    case "paragraph": return { "@type": "inputPageBlockParagraph", text: content };
  }
}

export function richInputMessage(blocks: TdObject[], rtl = false, detect = true): TdObject {
  return { "@type": "inputMessageRichMessage", clear_draft: false, message: {
    "@type": "inputRichMessage", source: { "@type": "richMessageSourceBlocks", blocks },
    is_rtl: rtl, detect_automatic_blocks: detect,
  } };
}

type PrepareExistingMedia = (block: TdObject, index: number) => ExistingWelcomeMedia | undefined;

export function editableRichMessage(raw: TdObject): { draft: EditableRichDraft; revision: string; rtl: boolean } | undefined;
export function editableRichMessage(raw: TdObject, media: PrepareExistingMedia | undefined, retained: ReadonlyMap<number, TdObject>):
  (RichEdit & { rtl: boolean }) | undefined;
export function editableRichMessage(raw: TdObject, media?: PrepareExistingMedia, retained?: ReadonlyMap<number, TdObject>):
  (RichEdit & { rtl: boolean }) | undefined {
  if (raw.is_outgoing !== true || raw.can_be_edited === false || raw.sending_state || raw.scheduling_state
    || raw.self_destruct_type || raw.ttl || raw.reply_markup) return;
  const blocks = editableBlocks(object(raw.content), media);
  const parsed = (media ? welcomeRichEditView : editableRichDraft).safeParse(blocks?.draft);
  if (!blocks || !parsed.success) return;
  const identity = [raw.edit_date ?? 0, blocks.rtl, parsed.data, ...(retained?.size ? [[...retained]] : [])];
  const revision = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { draft: parsed.data, revision, rtl: blocks.rtl };
}

export function editableWelcomeRichContent(content: TdObject, media: (block: TdObject, index: number) => ExistingWelcomeMedia | undefined) {
  const blocks = editableBlocks(content, media);
  return welcomeRichEditView.safeParse(blocks?.draft).data;
}

function editableBlocks(content: TdObject | undefined, media?: (block: TdObject, index: number) => ExistingWelcomeMedia | undefined) {
  const rich = object(content?.message);
  if (content?.["@type"] !== "messageRichMessage" || content.is_secret || rich?.["@type"] !== "richMessage" || rich.is_full !== true
    || !Array.isArray(rich.blocks) || rich.blocks.length > 128) return;
  const draft = rich.blocks.map((value, index) => {
    const block = object(value);
    if (!block) return;
    const existing = media?.(block, index);
    if (existing) return existing;
    if (block["@type"] === "pageBlockList") return editableList(block);
    if (block["@type"] === "pageBlockTable") return editableTable(block);
    if (block["@type"] === "pageBlockDivider") return { kind: "rule" };
    if (block["@type"] === "pageBlockMathematicalExpression") return { kind: "math", expression: block.expression };
    if (block["@type"] === "pageBlockButtonRow") {
      const align = cellAlignment.get(object(block.align)?.["@type"] ?? "");
      const values = block.buttons;
      if (!align || !Array.isArray(values) || !values.length || values.length > 20) return;
      const buttons = values.map(readDraftButton);
      return { kind: "buttons", buttons, align };
    }
    if (block["@type"] === "pageBlockBlockQuote") {
      if (!Array.isArray(block.blocks) || block.blocks.length > 16) return;
      const paragraphs = block.blocks.map((value) => {
        const paragraph = object(value);
        return paragraph?.["@type"] === "pageBlockParagraph" ? editableInline(paragraph.text) : undefined;
      });
      const credit = block.credit == null ? { text: "" } : editableInline(block.credit);
      if (!credit) return;
      return { kind: "blockQuote", paragraphs, ...(credit.text && { credit }) };
    }
    const content = editableInline(block.text, block["@type"] === "pageBlockParagraph");
    if (!content) return;
    switch (block["@type"]) {
      case "pageBlockParagraph": return { kind: "paragraph", ...content };
      case "pageBlockSectionHeading": {
        const size = richHeadingSize.safeParse(block.size);
        return size.success ? { kind: "heading", ...content, ...(size.data === 2 ? {} : { headingSize: size.data }) } : undefined;
      }
      case "pageBlockPullQuote":
      case "pageBlockExpandableBlockQuote": {
        const credit = block.credit == null ? { text: "" } : editableInline(block.credit);
        if (!credit) return;
        return { kind: block["@type"] === "pageBlockExpandableBlockQuote" ? "expandableQuote" : "quote", ...content,
          ...(credit.text && { credit }) };
      }
      case "pageBlockPreformatted": {
        if (block.language == null || block.language === "") return { kind: "code", ...content };
        const language = richCodeLanguage.safeParse(block.language);
        return language.success ? { kind: "code", ...content, language: language.data } : undefined;
      }
    }
  });
  return { draft, rtl: rich.is_rtl === true };
}

function readDraftButton(value: unknown): DraftInlineButton["button"] | undefined {
  const button = object(value);
  const draft = editableInline(button?.text);
  const style = object(button?.style)?.["@type"];
  if (!draft || draft.links?.length || (button?.style != null
    && (!style || (style !== "buttonStyleDefault" && !Object.hasOwn(tdRichButtonStyles, style))))) return;
  const { text: label, styles, customEmoji, formulas } = draft;
  const action = articleButtonAction(button, label);
  if (!action || action.kind === "profile") return;
  return draftRichButton.safeParse({ ...action,
    ...(styles || customEmoji || formulas ? { labelFormat: { styles, customEmoji, formulas } } : {}),
  }).data;
}

export function editableInline(value: unknown, allowButtons = false) {
  let text = "";
  const ranges: RichDraftRange[] = [];
  const links: MessageLink[] = [];
  const customEmoji: CustomEmojiRange[] = [];
  const formulas: RichFormulaRange[] = [];
  const inlineButtons: DraftInlineButton[] = [];
  let nodes = 512;
  function read(value: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 16 || text.length > 32768) return false;
    const node = object(value);
    if (!node) return false;
    const plain = readPlain(node);
    if (plain !== undefined) {
      text += plain;
      return text.length <= 32768;
    }
    if (node["@type"] === "richTexts") return Array.isArray(node.texts) && node.texts.every((child) => read(child, depth + 1));
    const offset = text.length;
    if (node["@type"] === "richTextButton") {
      if (!allowButtons || inlineButtons.length >= 32) return false;
      const button = readDraftButton(node.button);
      if (!button || offset + button.label.length > 32768) return false;
      text += button.label;
      inlineButtons.push({ offset, length: button.label.length, button });
      return true;
    }
    if (node["@type"] === "richTextMathematicalExpression") {
      const expression = richMathExpression.safeParse(node.expression);
      if (!expression.success || offset + expression.data.length > 32768 || formulas.length >= 32) return false;
      text += expression.data;
      formulas.push({ offset, length: expression.data.length });
      return true;
    }
    if (node["@type"] === "richTextCustomEmoji") {
      const id = customEmojiId.safeParse(node.custom_emoji_id);
      const label = node.alternative_text;
      if (!id.success || typeof label !== "string" || !label.length || label.length > 32 || offset + label.length > 32768) return false;
      text += label;
      customEmoji.push({ id: id.data, offset, length: label.length });
      return true;
    }
    if (node["@type"] === "richTextUrl") {
      const url = typeof node.url === "string" ? webLink(node.url) : undefined;
      const before = links.length;
      if (!url || url.href.length > 4096 || !read(node.text, depth + 1) || links.length !== before || text.length <= offset) return false;
      links.push({ url: url.href, offset, length: text.length - offset, hidden: true });
      return true;
    }
    const style = styles.get(node["@type"]);
    if (!style || !read(node.text, depth + 1)) return false;
    if (text.length > offset) ranges.push({ offset, length: text.length - offset, style });
    return true;
  }
  if (!read(value, 0)) return;
  const byStyle = new Map<RichDraftRange["style"], RichDraftRange[]>();
  for (const range of ranges.sort((a, b) => a.offset - b.offset)) {
    const group = byStyle.get(range.style) ?? [];
    const previous = group.at(-1);
    if (previous && range.offset <= previous.offset + previous.length) {
      previous.length = Math.max(previous.offset + previous.length, range.offset + range.length) - previous.offset;
    } else group.push(range);
    byStyle.set(range.style, group);
  }
  const merged = [...byStyle.values()].flat();
  return { text, ...(merged.length ? { styles: merged } : {}), ...(links.length ? { links } : {}),
    ...(customEmoji.length ? { customEmoji } : {}), ...(formulas.length ? { formulas } : {}),
    ...(inlineButtons.length ? { inlineButtons } : {}) };
}

function readPlain(value: unknown): string | undefined {
  const node = object(value);
  if (node?.["@type"] === "richTextPlain" && typeof node.text === "string") return node.text;
}

function editableList(block: TdObject) {
  if (!Array.isArray(block.items) || !block.items.length || block.items.length > 64) return;
  const items: RichFormattedListItem[] = [];
  const simple: string[] = [];
  const ordered = object(block.items[0])?.type === "1";
  for (const [index, value] of block.items.entries()) {
    const item = object(value);
    if (item?.["@type"] !== "pageBlockListItem" || !Array.isArray(item.blocks)
      || !item.blocks.length || item.blocks.length > 16
      || (item.is_checked === true && item.has_checkbox !== true)) return;
    const numbering = richListNumbering.safeParse(item.type);
    const position = richListNumber.safeParse(item.value);
    if (!numbering.success || !position.success) return;
    const label = numbering.data ? numberedMarker(position.data, numbering.data) : "•";
    if (item.label !== label && !(numbering.data === "" && item.label === "")) return;
    const paragraphs: RichCaptionDraft[] = [];
    for (const value of item.blocks) {
      const paragraph = object(value);
      const content = paragraph?.["@type"] === "pageBlockParagraph" ? editableInline(paragraph.text) : undefined;
      if (!content) return;
      paragraphs.push(content);
    }
    items.push({
      numbering: numbering.data, value: position.data, paragraphs,
      ...(item.has_checkbox === true && { checked: item.is_checked === true }),
    });
    if (!item.has_checkbox && numbering.data === (ordered ? "1" : "") && position.data === (ordered ? index + 1 : 0)
      && paragraphs.length === 1) {
      const plain = readPlain(object(item.blocks[0])?.text);
      if (plain && !/[\r\n]/.test(plain)) simple.push(plain);
    }
  }
  return simple.length === items.length
    ? { kind: ordered ? "numberedList" : "bulletList", items: simple }
    : { kind: "formattedList", entries: items };
}

function editableTable(block: TdObject) {
  const caption = block.caption == null ? "" : readPlain(block.caption) ?? editableInline(block.caption);
  if (caption === undefined || typeof block.is_bordered !== "boolean"
    || (block.is_striped !== undefined && typeof block.is_striped !== "boolean")
    || (block.is_compact !== undefined && typeof block.is_compact !== "boolean")
    || !Array.isArray(block.cells) || !block.cells.length || block.cells.length > 32) return;
  const rows: RichTableCell[][] = [];
  let simple = true;
  for (const [index, row] of block.cells.entries()) {
    if (!Array.isArray(row) || row.length > 16) return;
    if (index > 0 && row.length !== rows[0]!.length) simple = false;
    const cells: RichTableCell[] = [];
    for (const value of row) {
      const cell = object(value);
      if (cell?.["@type"] !== "pageBlockTableCell") return;
      const align = cellAlignment.get(object(cell.align)?.["@type"] ?? "");
      const verticalAlign = cellVerticalAlignment.get(object(cell.valign)?.["@type"] ?? "");
      const plain = readPlain(cell.text);
      const content = cell.text == null ? null : plain === undefined ? editableInline(cell.text) : { text: plain };
      if (content === undefined || typeof cell.is_header !== "boolean" || typeof cell.colspan !== "number"
        || typeof cell.rowspan !== "number" || !align || !verticalAlign) return;
      if (plain === undefined || /[\t\r\n]/.test(plain) || cell.is_header !== (index === 0)
        || cell.colspan !== 1 || cell.rowspan !== 1 || align !== "left" || verticalAlign !== "top") simple = false;
      cells.push({ content, header: cell.is_header, colSpan: cell.colspan, rowSpan: cell.rowspan, align, verticalAlign });
    }
    if (!cells.some((cell) => cell.content?.text.trim())) simple = false;
    rows.push(cells);
  }
  const options = { ...(caption && { caption }), ...(block.is_bordered === false && { bordered: false }),
    ...(block.is_striped === true && { striped: true }), ...(block.is_compact === true && { compact: true }) };
  return { kind: "table", rows: simple ? rows.map((row) => row.map(({ content }) => content?.text ?? "")) : rows,
    ...(Object.keys(options).length && { options }) };
}

const cellAlignment = new Map<string, "left" | "center" | "right">([
  ["pageBlockHorizontalAlignmentLeft", "left"], ["pageBlockHorizontalAlignmentCenter", "center"],
  ["pageBlockHorizontalAlignmentRight", "right"],
] as const);
const cellVerticalAlignment = new Map<string, "top" | "middle" | "bottom">([
  ["pageBlockVerticalAlignmentTop", "top"], ["pageBlockVerticalAlignmentMiddle", "middle"],
  ["pageBlockVerticalAlignmentBottom", "bottom"],
] as const);
const inputCellAlignment = new Map([...cellAlignment].map(([type, value]) => [value, type]));
const inputRichButtonStyle = new Map<string, string>(Object.entries(tdRichButtonStyles).map(([type, style]) => [style, type]));
const inputCellVerticalAlignment = new Map([...cellVerticalAlignment].map(([type, value]) => [value, type]));

function boundedSpan(value: unknown, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 1 && max > 1 ? Math.min(value, max) : undefined;
}

type AttachmentBlock = Extract<RichMessageBlock, { kind: "photo" | "document" }>;
type ResolveAttachment = (block: TdObject, index: number, content: RichInline) => AttachmentBlock | undefined;

export function richBlockAt(value: unknown, { index }: RichAttachmentReference): TdObject | undefined {
  const raw = object(value);
  if (raw?.["@type"] === "richMessage") return object(array(raw.blocks)[index]);
}

export function parseRichMessage(value: unknown, resolveAttachment?: ResolveAttachment): {
  layout: RichMessageLayout; preview: string; bankCards?: ReadonlyMap<string, string>;
} | undefined {
  const raw = object(value);
  if (raw?.["@type"] !== "richMessage") return;
  let remaining = 32768;
  let nodes = 4096;
  let complete = raw.is_full === true;
  let quoteLayout = true;
  let missingAttachment = false;
  let bankCards: Map<string, string> | undefined;
  const simpleQuoteBlocks = ["pageBlockSectionHeading", "pageBlockParagraph", "pageBlockFooter", "pageBlockPreformatted"];

  function readInline(value: unknown): RichInline {
    const output: RichInline = { text: "" };
    function append(value: unknown, hide = false) {
      if (typeof value !== "string") return;
      const text = value.slice(0, remaining);
      remaining -= text.length;
      if (text.length < value.length) complete = false;
      output.text += hide ? "•".repeat(text.length) : text;
    }
    function visit(value: unknown, depth: number) {
      const child = object(value);
      if (!child) return;
      if (--nodes <= 0 || depth > 20) { complete = false; return; }
      switch (child["@type"]) {
        case "richTexts":
          if (array(child.texts).length > 512) quoteLayout = false;
          for (const node of array(child.texts).slice(0, 512)) visit(node, depth + 1);
          return;
        case "richTextPlain": append(child.text); return;
        case "richTextButton": {
          quoteLayout = false;
          const rawButton = object(child.button);
          const offset = output.text.length;
          const count = output.inlineButtons?.length ?? 0;
          visit(rawButton?.text, depth + 1);
          const label = output.text.slice(offset);
          const action = articleButtonAction(rawButton, label);
          const size = action?.kind === "url" ? action.url.length : action?.kind === "copy" ? action.text.length : 0;
          const hidden = output.styles?.some((range) => range.style === "spoiler" && range.offset + range.length > offset);
          if ((action?.kind === "url" || action?.kind === "copy") && count < 32 && count === (output.inlineButtons?.length ?? 0) && size <= remaining && !hidden) {
            remaining -= size;
            const formatted = readDraftButton(rawButton);
            (output.inlineButtons ??= []).push({ offset, length: label.length,
              button: formatted?.labelFormat && formatted.label === label ? formatted : action });
          } else complete = false;
          return;
        }
        case "richTextCustomEmoji": {
          const offset = output.text.length;
          append(child.alternative_text);
          const length = output.text.length - offset;
          const id = customEmojiId.safeParse(child.custom_emoji_id);
          if (id.success && typeof child.alternative_text === "string" && length === child.alternative_text.length
            && length > 0 && length <= 8192 && (output.customEmoji?.length ?? 0) < 128) {
            (output.customEmoji ??= []).push({ id: id.data, offset, length });
          } else quoteLayout = false;
          return;
        }
        case "richTextMathematicalExpression": {
          const offset = output.text.length;
          const expression = richMathExpression.safeParse(child.expression);
          append(child.expression);
          if (expression.success && output.text.length - offset === expression.data.length && (output.formulas?.length ?? 0) < 32) {
            (output.formulas ??= []).push({ offset, length: expression.data.length });
          } else quoteLayout = false;
          return;
        }
      }
      if (!styles.has(child["@type"]) && child["@type"] !== "richTextUrl") quoteLayout = false;
      const offset = output.text.length;
      if (child["@type"] === "richTextSpoiler" && (output.styles?.length ?? 0) >= 127) {
        quoteLayout = false;
        append("Spoiler", true);
        return;
      }
      visit(child.text, depth + 1);
      const length = output.text.length - offset;
      if (!length) return;
      const style = styles.get(child["@type"]);
      if (style) {
        const ranges = output.styles ??= [];
        if (ranges.length < 128) ranges.push({ offset, length, style });
        else if (style === "spoiler") {
          output.text = output.text.slice(0, offset) + "•".repeat(length);
          output.links = output.links?.filter((link) => link.offset < offset);
          output.customEmoji = output.customEmoji?.filter((emoji) => emoji.offset < offset);
          output.inlineButtons = output.inlineButtons?.filter((button) => button.offset < offset);
          output.botCommands = output.botCommands?.filter((command) => command.offset < offset);
          output.bankCards = output.bankCards?.filter((card) => card.offset < offset);
          output.tonAddresses = output.tonAddresses?.filter((address) => address.offset < offset);
        }
      }
      if (child["@type"] === "richTextBankCardNumber") {
        const number = typeof child.bank_card_number === "string" && child.bank_card_number.length <= 64
          ? child.bank_card_number.replace(/[ -]/g, "") : "";
        const ranges = output.bankCards ?? [];
        if (/^\d{12,19}$/.test(number) && length <= 4096 && ranges.length < 32 && remaining >= 64) {
          remaining -= 64;
          const reference = createHash("sha256").update(number).digest("hex");
          (bankCards ??= new Map()).set(reference, number);
          (output.bankCards ??= ranges).push({ offset, length, reference });
        } else complete = false;
      }
      if (child["@type"] === "richTextTonAddress") {
        const address = tonAddress(child.address);
        const ranges = output.tonAddresses ?? [];
        if (address && length <= 4096 && ranges.length < 32 && address.length <= remaining) {
          remaining -= address.length;
          (output.tonAddresses ??= ranges).push({ offset, length, address });
        } else complete = false;
      }
      if (child["@type"] === "richTextBotCommand") {
        const raw = child.bot_command;
        const command = richBotCommand.safeParse(typeof raw === "string" && !raw.startsWith("/") ? "/" + raw : raw);
        const ranges = output.botCommands ?? [];
        if (command.success && length <= 4096 && ranges.length < 32 && command.data.length <= remaining) {
          remaining -= command.data.length;
          (output.botCommands ??= ranges).push({ offset, length, command: command.data });
        } else complete = false;
      }
      if (child["@type"] === "richTextUrl" && typeof child.url === "string") {
        const url = webLink(child.url);
        const links = output.links ??= [];
        if (url && url.href.length <= 4096 && links.length < 128) links.push({ offset, length, url: url.href, hidden: true });
      }
    }
    visit(value, 0);
    return output;
  }

  function textParts(value: unknown) {
    const entries = array(value);
    if (entries.length > 16) complete = false;
    const parts = entries.slice(0, 16).flatMap((value) => {
      const block = object(value);
      const format = block && blockTypes.get(block["@type"]);
      if (!block || !format || remaining <= 0 || nodes <= 0) { complete = false; return []; }
      if (!simpleQuoteBlocks.includes(block["@type"])) quoteLayout = false;
      const content = readInline(block[format[1]]);
      return content.text ? [content] : [];
    });
    const [content = { text: "" }, ...continuation] = parts;
    return { content, ...(continuation.length ? { continuation } : {}) };
  }

  const blocks: RichMessageBlock[] = [];
  if (array(raw.blocks).length > 128) complete = false;
  for (const [index, value] of array(raw.blocks).slice(0, 128).entries()) {
    const block = object(value);
    if (!block || remaining <= 0 || nodes <= 0) { complete = false; continue; }
    const type = block["@type"];
    if (!attachmentNames.has(type) && !simpleQuoteBlocks.includes(type)
      && !["pageBlockDivider", "pageBlockMathematicalExpression", "pageBlockBlockQuote", "pageBlockPullQuote",
      "pageBlockExpandableBlockQuote", "pageBlockList", "pageBlockTable"].includes(type)) quoteLayout = false;
    const format = blockTypes.get(type);
    if (type === "pageBlockThinking") {
      complete = false;
      blocks.push({ kind: "thinking", content: readInline(block.text) });
    }
    else if (format?.[0] === "quote") blocks.push({ kind: "quote", content: readInline(block[format[1]]), credit: readInline(block.credit),
      ...(type === "pageBlockExpandableBlockQuote" ? { expandable: true as const } : {}) });
    else if (type === "pageBlockSectionHeading") {
      const size = richHeadingSize.safeParse(block.size);
      blocks.push({ kind: "heading", content: readInline(block.text), ...(size.success && { headingSize: size.data }) });
    }
    else if (type === "pageBlockPreformatted") {
      const language = richCodeLanguage.safeParse(block.language);
      blocks.push({ kind: "code", content: readInline(block.text), ...(language.success && { language: language.data }) });
    }
    else if (format) blocks.push({ kind: format[0], content: readInline(block[format[1]]) });
    else if (type === "pageBlockDivider") blocks.push({ kind: "rule" });
    else if (type === "pageBlockButtonRow") {
      const row = articleButtons(block.buttons);
      const buttons = row.buttons.flatMap((button) => {
        if (button.kind !== "url" && button.kind !== "copy") return [];
        const size = button.label.length + (button.kind === "url" ? button.url.length : button.text.length);
        if (size > remaining) return [];
        remaining -= size;
        return [button];
      });
      complete &&= !row.partial && buttons.length > 0 && buttons.length === row.buttons.length;
      const align = cellAlignment.get(object(block.align)?.["@type"] ?? "");
      if (buttons.length) blocks.push({ kind: "buttons", buttons, align });
    }
    else if (type === "pageBlockMathematicalExpression") {
      const expression = richMathExpression.safeParse(block.expression);
      if (expression.success && expression.data.length <= remaining) {
        remaining -= expression.data.length;
        blocks.push({ kind: "math", expression: expression.data });
      } else complete = false;
    }
    else if (type === "pageBlockBlockQuote") blocks.push({ kind: "quote", ...textParts(block.blocks), credit: readInline(block.credit) });
    else if (type === "pageBlockList") {
      const items = array(block.items);
      if (items.length > 64) complete = false;
      blocks.push({ kind: "list", items: items.slice(0, 64).flatMap((entry) => {
        const item = object(entry);
        if (!item || --nodes <= 0) { complete = false; return []; }
        const label = typeof item.label === "string" ? item.label.slice(0, 32) : "";
        const type = item.type;
        const numbering = type === "1" || type === "a" || type === "A" || type === "i" || type === "I" ? type : undefined;
        const value = item.value;
        const number = numbering && typeof value === "number" && Number.isInteger(value)
          && value >= -2147483648 && value <= 2147483647 ? value : undefined;
        return [{ label, ...textParts(item.blocks), numbering, number,
          ...(item.has_checkbox === true ? { checked: item.is_checked === true } : {}) }];
      }) });
    }
    else if (type === "pageBlockTable") {
      const rows = array(block.cells);
      if (rows.length > 32) complete = false;
      blocks.push({
        kind: "table", caption: readInline(block.caption), bordered: block.is_bordered !== false,
        striped: block.is_striped === true, compact: block.is_compact === true,
        rows: rows.slice(0, 32).map((row, index) => {
          const cells = array(row);
          if (cells.length > 16) complete = false;
          return cells.slice(0, 16).flatMap((entry) => {
            const cell = object(entry);
            if (!cell || --nodes <= 0) { complete = false; return []; }
            return [{
              content: readInline(cell.text), header: cell.is_header === true,
              colSpan: boundedSpan(cell.colspan, 16), rowSpan: boundedSpan(cell.rowspan, Math.min(32, rows.length) - index),
              align: cellAlignment.get(object(cell.align)?.["@type"] ?? ""),
              verticalAlign: cellVerticalAlignment.get(object(cell.valign)?.["@type"] ?? ""),
              ...(cell.text == null ? { invisible: true as const } : {}),
            }];
          });
        }),
      });
    }
    else {
      const name = attachmentNames.get(type);
      if (!name) {
        complete = false;
        continue;
      }
      const rawCaption = object(block.caption);
      const caption = readInline(rawCaption?.text);
      const quotable = quotableMediaCaptions.has(type);
      const credit = quotable ? readInline(rawCaption?.credit) : undefined;
      const quoteFields = {
        ...(quotable && caption.text && { quotableCaption: true as const }),
        ...(credit?.text && { credit }),
      };
      const attachment = resolveAttachment?.(block, index, caption);
      if (attachment) blocks.push({ ...attachment, ...quoteFields });
      else {
        missingAttachment = true;
        blocks.push({ kind: "attachment", content: caption.text ? caption : { text: name }, ...quoteFields });
      }
    }
  }
  if (!blocks.length) return;
  const preview = blocks.flatMap((block) => {
    if (block.kind === "photo" || block.kind === "document" || block.kind === "attachment") {
      const caption = block.content.text ? block.content
        : { text: block.kind !== "document" ? "Photo" : block.spoiler ? "Spoiler" : block.document.name };
      return block.credit ? [caption, block.credit] : [caption];
    }
    if (block.kind === "quote") return block.expandable ? [{ text: "Quote" }] : [block.content, ...(block.continuation ?? [])];
    if (block.kind === "math") return [{ text: block.expression }];
    if (block.kind === "buttons") return block.buttons.map(({ label }) => ({ text: label }));
    return "content" in block ? [block.content] : block.kind === "list"
    ? block.items.flatMap(({ content, continuation }) => [content, ...(continuation ?? [])]) : block.kind === "table" ? block.rows.flat().map(({ content }) => content) : [];
  })
    .map(({ text, styles }) => maskSpoilers(text, styles, "Spoiler")).filter(Boolean).join("\n").slice(0, 8192);
  return { ...(bankCards && { bankCards }), layout: { rtl: raw.is_rtl === true, complete: complete && !missingAttachment,
    ...(complete && quoteLayout && { quoteLayout: true as const }), blocks }, preview };
}


export function richMessageHasBotCommand(layout: RichMessageLayout, command: string) {
  const nodes: unknown[] = [layout.blocks];
  while (nodes.length) {
    const entry = nodes.pop();
    if (Array.isArray(entry)) nodes.push(...entry);
    else if (entry && typeof entry === "object") {
      const part = entry as Partial<RichInline>;
      if (part.botCommands?.some((range) => range.command === command)) return true;
      nodes.push(...Object.values(entry));
    }
  }
  return false;
}
