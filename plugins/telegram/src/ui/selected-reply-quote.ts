import type { ReplyQuote, RichMessageLayout } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { richQuoteParts, richQuoteRanges } from "../core/rich-message-text.ts";

const richPart = "[data-reply-rich-part]";
const richAtom = "[data-reply-rich-atom]";

function parentElement(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

function prefixLength(fragment: DocumentFragment, text: string) {
  let length = 0;
  function read(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (!text.startsWith(value, length)) return false;
      length += value.length;
      return true;
    }
    if (node instanceof HTMLElement && node.matches(richAtom)) {
      const units = Number(node.dataset.replyRichAtom);
      if (!Number.isSafeInteger(units) || units <= 0 || length + units > text.length) return false;
      length += units;
      return true;
    }
    return Array.from(node.childNodes).every(read);
  }
  if (read(fragment)) return length;
}

function richSelection(article: HTMLElement, range: Range, layout: RichMessageLayout): ReplyQuote | undefined {
  if (!article.contains(range.endContainer)) return;
  const parts = richQuoteParts(layout);
  const textByOffset = new Map(parts.map(({ offset, text }) => [offset, text] as const));
  const nodes = Array.from(article.querySelectorAll<HTMLElement>(richPart));
  function boundary(end: boolean) {
    const container = end ? range.endContainer : range.startContainer;
    const offset = end ? range.endOffset : range.startOffset;
    const element = parentElement(container);
    const closest = element?.closest<HTMLElement>(richPart);
    const part = closest ?? nodes.filter((node) => range.intersectsNode(node)).at(end ? -1 : 0);
    if (!part || !article.contains(part)) return;
    const partOffset = Number(part.dataset.replyRichPart);
    const text = textByOffset.get(partOffset);
    if (text === undefined) return;
    const prefix = article.ownerDocument.createRange();
    prefix.selectNodeContents(part);
    if (prefixLength(prefix.cloneContents(), text) !== text.length) return;
    if (!closest) return partOffset + (end ? text.length : 0);
    const atom = element?.closest<HTMLElement>(richAtom);
    if (atom && part.contains(atom)) {
      if (end) prefix.setEndAfter(atom);
      else prefix.setEndBefore(atom);
    } else {
      prefix.setEnd(container, offset);
    }
    const length = prefixLength(prefix.cloneContents(), text);
    return length === undefined ? undefined : partOffset + length;
  }
  const start = boundary(false);
  const end = boundary(true);
  if (start === undefined || end === undefined || end <= start) return;
  const text = parts.map((part) => part.text).join("\n").slice(start, end);
  const quote = { text, position: start, rich: true as const };
  const ranges = richQuoteRanges(layout, quote);
  if (!ranges) return;
  const selected = new Set(nodes.filter((node) => range.intersectsNode(node)).map((node) => Number(node.dataset.replyRichPart)));
  if (parts.every(({ part, offset }) => !ranges.has(part) || selected.has(offset))) return quote;
}

export function selectedReplyQuote(history: HTMLElement | null, message: Message): ReplyQuote | undefined {
  if (!history || history.hidden || !message.canQuote || message.pendingDelivery || message.failedDelivery || message.retained) return;
  const selection = history.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const element = parentElement(start);
  if (message.richMessage) {
    const article = element?.closest<HTMLElement>("[data-reply-rich-message]");
    if (article && history.contains(article) && article.dataset.replyRichMessage === message.id) {
      return richSelection(article, range, message.richMessage);
    }
    return;
  }
  const source = element?.closest<HTMLElement>("[data-reply-quote-source]");
  if (!source || !history.contains(source) || source.dataset.replyQuoteSource !== message.id
    || !source.contains(range.endContainer) || source.textContent !== message.text) return;
  const text = range.toString();
  if (!text.trim() || text.length > 1024) return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(source);
  prefix.setEnd(range.startContainer, range.startOffset);
  const position = prefix.toString().length;
  if (position <= 4095 && message.text.slice(position, position + text.length) === text) return { text, position };
}
