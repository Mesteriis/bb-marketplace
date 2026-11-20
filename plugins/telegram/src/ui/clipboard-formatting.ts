import type { MessageStyle, RichDraftRange } from "../core/contract.ts";
import { webLink, type MessageLink } from "../core/message-links.ts";

const stylesByTag: ReadonlyMap<string, MessageStyle> = new Map([
  ["B", "bold"], ["STRONG", "bold"], ["I", "italic"], ["EM", "italic"], ["U", "underline"],
  ["S", "strike"], ["STRIKE", "strike"], ["DEL", "strike"], ["CODE", "code"], ["BLOCKQUOTE", "quote"],
]);
const blocks = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"]);
const ignored = new Set(["SCRIPT", "STYLE", "TEMPLATE", "OBJECT", "IFRAME", "SVG", "MATH"]);
const maxClipboardHtmlLength = 131072;

const richStylesByTag: ReadonlyMap<string, RichDraftRange["style"] | MessageStyle> = new Map([
  ...stylesByTag, ["SUB", "subscript"], ["SUP", "superscript"], ["MARK", "marked"],
]);

export function readClipboardFormatting(data: DataTransfer, document: Document, draftLimit: number) {
  return readFormatting(data, document, stylesByTag, draftLimit < 0 ? maxClipboardHtmlLength : draftLimit);
}

export function readRichClipboardFormatting(data: DataTransfer, document: Document, maxLength: number) {
  return readFormatting(data, document, richStylesByTag, maxLength);
}

function readFormatting<Style>(data: DataTransfer, document: Document, supported: ReadonlyMap<string, Style>, maxLength: number) {
  if (data.files?.length || typeof data.getData !== "function") return;
  const plain = data.getData("text/plain").replace(/\r\n?/g, "\n");
  const html = data.getData("text/html");
  if (!plain || plain.length > maxLength || !html || html.length > maxClipboardHtmlLength) return;

  // Parse in an inert template and use only text and explicitly supported attributes.
  const source = document.createElement("template");
  source.innerHTML = html;
  const result = readInline(source.content.childNodes, supported, maxLength);
  if (!result || !(result.ranges.length || result.links.length)) return;
  const text = result.text + (result.pendingBreak && result.text + "\n" === plain ? "\n" : "");
  if (text !== plain) return;
  return { text, ranges: result.ranges, links: result.links };
}

type InlineElementReader = (element: Element, offset: number, text: string) => void;

export function readRichHtmlInline(nodes: ArrayLike<Node>, maxLength: number, readElement?: InlineElementReader) {
  return readInline(nodes, richStylesByTag, maxLength, readElement);
}

function readInline<Style>(nodes: ArrayLike<Node>, supported: ReadonlyMap<string, Style>, maxLength: number, readElement?: InlineElementReader) {
  const ranges: { style: Style; offset: number; length: number }[] = [];
  const links: MessageLink[] = [];
  let text = "";
  let valid = true;
  let pendingBreak = false;

  function lineBreak() {
    if (text && !text.endsWith("\n")) pendingBreak = true;
  }

  function emit(value: string) {
    if (!value) return;
    if (pendingBreak && !value.startsWith("\n")) text += "\n";
    pendingBreak = false;
    text += value;
  }

  function visit(node: Node, depth: number) {
    if (!valid || depth > 32 || text.length > maxLength || ranges.length + links.length > 128) {
      valid = false;
      return;
    }
    if (node.nodeType === 3) {
      emit(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (ignored.has(tag)) return;
    if (tag === "BR") {
      emit("\n");
      return;
    }
    if (blocks.has(tag)) lineBreak();
    const offset = text.length + (pendingBreak ? 1 : 0);
    for (let child = element.firstChild; child; child = child.nextSibling) visit(child, depth + 1);
    const length = text.length - offset;
    const style = supported.get(tag);
    if (length > 0 && style !== undefined) ranges.push({ offset, length, style });
    const url = tag === "A" && webLink(element.getAttribute("href") ?? "");
    if (length > 0 && url) links.push({ offset, length, url: url.href, hidden: true });
    if (length > 0 && readElement) readElement(element, offset, text.slice(offset));
    if (blocks.has(tag)) lineBreak();
  }

  for (const node of Array.from(nodes)) visit(node, 0);
  if (valid && text.length <= maxLength && ranges.length + links.length <= 128) return { text, ranges, links, pendingBreak };
}

export function outsidePastedText<T extends { offset: number; length: number }>(
  ranges: readonly T[], start: number, end: number, insertedLength: number,
): T[] {
  return ranges.flatMap((range) => {
    const right = range.offset + range.length;
    if (right <= start) return [range];
    if (range.offset >= end) return [{ ...range, offset: range.offset + insertedLength - (end - start) }];
    return [
      ...(range.offset < start ? [{ ...range, length: start - range.offset }] : []),
      ...(right > end ? [{ ...range, offset: start + insertedLength, length: right - end }] : []),
    ];
  });
}
