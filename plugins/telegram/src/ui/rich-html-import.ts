import { draftRichButton, editableRichDraft, isVideoAttachmentName, richButtonRow, richCodeLanguage, richListNumbering, richMathExpression,
  type DraftInlineButton, type EditableRichDraft, type RichCaptionDraft, type RichFormattedListItem, type RichFormulaRange,
  type RichTableCell } from "../core/contract.ts";
import { readRichHtmlInline } from "./clipboard-formatting.ts";

export const maxRichHtmlBytes = 512 * 1024;
const excluded = "script, template, iframe, frame, embed, object, noscript, svg, math,"
  + " form, audio, video, img, picture, source, canvas, input, button";
const wrappers = new Set(["ARTICLE", "MAIN", "SECTION", "DIV", "HEADER", "FOOTER", "ASIDE"]);
type ImportedAttachment = { kind: "photo" | "video" | "document"; file: File; caption: RichCaptionDraft };

function parseButton(element: Element, label: string) {
  const value = element.tagName === "SPAN" && element.getAttribute("data-bb-button");
  if (!value || value.length > 32768 || element.childElementCount) return;
  try {
    const parsed = draftRichButton.safeParse(JSON.parse(value)).data;
    if (parsed?.label === label) return parsed;
  } catch {
    return;
  }
}

export function readRichHtmlFile(html: string, document: Document, files?: ReadonlyMap<string, Blob>) {
  if (html.length > maxRichHtmlBytes) return;
  const source = document.createElement("template");
  source.innerHTML = html;
  for (const element of Array.from(source.content.querySelectorAll("title, meta, base, link, style"))) element.remove();
  const omitted = Array.from(source.content.querySelectorAll(excluded));
  for (const element of omitted) element.remove();
  const draft: (EditableRichDraft[number] | ImportedAttachment)[] = [];
  let valid = true;
  let omittedMetadata = false;

  function inline(nodes: ArrayLike<Node>, allowButtons = false): Pick<RichCaptionDraft, "text" | "styles" | "links" | "formulas">
    & { inlineButtons?: DraftInlineButton[] } {
    const formulas: RichFormulaRange[] = [];
    const inlineButtons: DraftInlineButton[] = [];
    const parsed = readRichHtmlInline(nodes, 32768, (element, offset, text) => {
      if (element.hasAttribute("data-bb-button")) {
        const button = allowButtons && parseButton(element, text);
        if (button && inlineButtons.length < 32) inlineButtons.push({ offset, length: text.length, button });
        else omittedMetadata = true;
      } else if (element.tagName === "SPAN" && element.hasAttribute("data-bb-formula")) {
        if (!element.childElementCount && formulas.length < 32 && richMathExpression.safeParse(text).success) {
          formulas.push({ offset, length: text.length });
        } else omittedMetadata = true;
      }
    });
    if (!parsed) { valid = false; return { text: "" }; }
    const { text, ranges, links } = parsed;
    const styles = ranges.flatMap(({ style, offset, length }) => style === "quote" || style === "expandableQuote"
      ? [] : [{ style, offset, length }]);
    const occupied = [...styles, ...links, ...formulas];
    const overlap = (first: RichFormulaRange, second: RichFormulaRange) =>
      first.offset < second.offset + second.length && second.offset < first.offset + first.length;
    const buttons = inlineButtons.filter((button, index) => !occupied.some((range) => overlap(range, button))
      && (index === 0 || inlineButtons[index - 1]!.offset + inlineButtons[index - 1]!.length <= button.offset));
    omittedMetadata ||= buttons.length !== inlineButtons.length;
    return { text, ...(styles.length && { styles }), ...(links.length && { links }), ...(formulas.length && { formulas }),
      ...(buttons.length && { inlineButtons: buttons }) };
  }

  function paragraph(nodes: ArrayLike<Node>) {
    const content = inline(nodes, true);
    if (content.text.trim()) draft.push({ kind: "paragraph", ...content });
  }

  function readList(element: Element, ordered: boolean) {
    const items = Array.from(element.children).filter((child) => child.tagName === "LI");
    if (items.length > 64 || items.some((item) => item.querySelector("ul, ol"))) { valid = false; return; }
    const numbering = ordered ? richListNumbering.safeParse(element.getAttribute("type")).data || "1" : "";
    let value = Number(element.getAttribute("start") ?? 1);
    const entries: RichFormattedListItem[] = [];
    for (const item of items) {
      if (item.hasAttribute("value")) value = Number(item.getAttribute("value"));
      const content = inline(item.childNodes);
      if (content.text.trim()) entries.push({ numbering, value: ordered ? value : 0, paragraphs: [content] });
      value++;
    }
    if (entries.length) draft.push({ kind: "formattedList", entries });
  }

  function readTable(table: HTMLTableElement) {
    if (table.rows.length > 32 || Array.from(table.rows).some((row) => row.cells.length > 16)
      || table.querySelector("table")) { valid = false; return; }
    const rows: RichTableCell[][] = Array.from(table.rows, (row) => Array.from(row.cells, (cell) => {
      const align = cell.style.textAlign || cell.getAttribute("align");
      const vertical = cell.style.verticalAlign || cell.getAttribute("valign");
      return { content: inline(cell.childNodes), header: cell.tagName === "TH", colSpan: cell.colSpan, rowSpan: cell.rowSpan,
        align: align === "center" || align === "right" ? align : "left",
        verticalAlign: vertical === "top" || vertical === "bottom" ? vertical : "middle",
      };
    }));
    if (rows.length) draft.push({ kind: "table", rows, ...(table.caption && { options: { caption: inline(table.caption.childNodes) } }) });
  }

  function readAttachment(figure: Element) {
    const kind = figure.getAttribute("data-bb-attachment");
    const children = Array.from(figure.children);
    const link = children.find((child) => child.tagName === "A");
    const captionNode = children.find((child) => child.tagName === "FIGCAPTION");
    const footer = captionNode && Array.from(captionNode.children).find((child) => child.tagName === "FOOTER");
    const caption = inline(Array.from(captionNode?.childNodes ?? []).filter((child) => child !== footer));
    const credit = inline(Array.from(footer?.childNodes ?? []));
    const path = link?.getAttribute("href") ?? "";
    const name = link?.textContent?.trim() ?? "";
    const member = files?.get(path);
    if ((kind !== "photo" && kind !== "video" && kind !== "document") || !member?.size || !name
      || name.length > 255 || /[\/\\\p{Cc}\p{Cf}]/u.test(name) || name === "." || name === ".."
      || kind === "video" && !isVideoAttachmentName(name)) {
      omittedMetadata = true;
      if (caption.text.trim()) draft.push({ kind: "paragraph", ...caption });
      else if (name) draft.push({ kind: "paragraph", text: name });
      if (credit.text.trim()) draft.push({ kind: "paragraph", ...credit });
      return;
    }
    const type = kind === "photo" ? "image/jpeg" : kind === "video" ? (/\.mov$/i.test(name) ? "video/quicktime" : "video/mp4")
      : "application/octet-stream";
    draft.push({ kind, file: new File([member], name, { type }), caption });
    if (credit.text.trim()) draft.push({ kind: "paragraph", ...credit });
  }

  function readBlocks(nodes: ArrayLike<Node>, depth: number) {
    const pending: Node[] = [];
    function flush() {
      if (pending.length) paragraph(pending.splice(0));
    }
    for (const node of Array.from(nodes)) {
      if (!valid || depth > 16 || draft.length >= 128) { valid = false; return; }
      if (node.nodeType === 3) {
        if (pending.length || node.textContent?.trim()) pending.push(node);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as HTMLElement;
      const tag = element.tagName.toUpperCase();
      if (tag === "FIGURE" && element.hasAttribute("data-bb-attachment")) {
        flush();
        readAttachment(element);
      } else if (tag === "DIV" && element.hasAttribute("data-bb-button-row")) {
        flush();
        const buttons = Array.from(element.children, (child) => parseButton(child, child.textContent ?? ""));
        const row = richButtonRow.safeParse({ kind: "buttons", align: element.getAttribute("data-bb-button-row"), buttons });
        if (row.success && !Array.from(element.childNodes).some((child) => child.nodeType === 3 && child.textContent?.trim())) draft.push(row.data);
        else {
          omittedMetadata = true;
          paragraph([element.ownerDocument.createTextNode(element.textContent ?? "")]);
        }
      } else if (wrappers.has(tag)) {
        flush();
        readBlocks(element.childNodes, depth + 1);
      } else if (tag === "P" || /^H[1-6]$/.test(tag)) {
        flush();
        const content = inline(element.childNodes, tag === "P");
        if (content.text.trim()) draft.push(tag === "P" ? { kind: "paragraph", ...content }
          : { kind: "heading", headingSize: Number(tag[1]), ...content });
      } else if (tag === "PRE") {
        flush();
        const code = element.querySelector("code");
        const languageClass = Array.from(code?.classList ?? []).find((name) => name.startsWith("language-"));
        const language = richCodeLanguage.safeParse(code?.getAttribute("data-language") ?? languageClass?.slice(9)).data;
        const text = element.textContent ?? "";
        const formula = element.hasAttribute("data-bb-formula") && richMathExpression.safeParse(text).data;
        if (formula) draft.push({ kind: "math", expression: formula });
        else if (text.trim()) draft.push({ kind: "code", text, ...(language && { language }) });
      } else if (tag === "BLOCKQUOTE") {
        flush();
        const footer = Array.from(element.children).find((child) => child.tagName === "FOOTER");
        const parts = Array.from(element.childNodes).filter((child) => child !== footer);
        const paragraphs = parts.some((child) => child.nodeType === 1 && ["P", "DIV"].includes((child as Element).tagName))
          ? parts.map((child) => inline([child])).filter(({ text }) => !!text.trim())
          : [inline(parts)].filter(({ text }) => !!text.trim());
        if (paragraphs.length) draft.push({ kind: "blockQuote", paragraphs,
          ...(footer && { credit: inline(footer.childNodes) }) });
      } else if (tag === "HR") {
        flush();
        draft.push({ kind: "rule" });
      } else if (tag === "UL" || tag === "OL") {
        flush();
        readList(element, tag === "OL");
      } else if (tag === "TABLE") {
        flush();
        readTable(element as HTMLTableElement);
      } else pending.push(element);
    }
    flush();
  }

  readBlocks(source.content.childNodes, 0);
  if (!valid || !draft.length || draft.length > 128) return;
  const text = draft.filter((block) => !("file" in block));
  const parsed = text.length ? editableRichDraft.safeParse(text).data : [];
  if (!parsed) return;
  let index = 0;
  return { draft: draft.map((block) => "file" in block ? block : parsed[index++]!), omitted: omitted.length > 0 || omittedMetadata };
}
