import type { CustomEmojiRange, ReplyQuote, RichInline, RichMessageBlock, RichMessageLayout } from "./contract.ts";
import { draftRichButton, richMathExpression } from "./contract.ts";
import { validDraftStyles } from "./draft-formatting.ts";
import { maskSpoilers, spoilerRanges } from "./message-spoilers.ts";
import { tabSeparatedTableText } from "./table-text.ts";
import { webLink } from "./message-links.ts";

type RichQuotePart = RichInline | Extract<RichMessageBlock, { kind: "math" }>;

export function richQuoteParts(layout: RichMessageLayout) {
  if (!layout.quoteLayout) return [];
  let offset = 0;
  return layout.blocks.flatMap((block): RichQuotePart[] => {
    switch (block.kind) {
      case "math": return [block];
      case "photo": case "document": case "attachment":
        return [...(block.quotableCaption ? [block.content] : []), ...(block.credit ? [block.credit] : [])];
      case "heading": case "paragraph": case "code": return [block.content];
      case "quote": return [block.content, ...(block.continuation ?? []), ...(block.credit ? [block.credit] : [])];
      case "list": return block.items.flatMap(({ content, continuation }) => [content, ...(continuation ?? [])]);
      case "table": return [block.caption, ...block.rows.flatMap((row) => row.filter(({ invisible }) => !invisible).map(({ content }) => content))];
      default: return [];
    }
  }).flatMap((part) => {
    const text = "expression" in part ? part.expression : part.text;
    if (!text) return [];
    const entry = { part, text, offset };
    offset += text.length + 1;
    return [entry];
  });
}

export function richQuoteText(layout: RichMessageLayout) {
  return richQuoteParts(layout).map(({ part, text }) => {
    if ("expression" in part) return text;
    let masked = text;
    for (const { start, end } of spoilerRanges(text, part.styles)) {
      masked = masked.slice(0, start) + "•".repeat(end - start) + masked.slice(end);
    }
    return masked;
  }).join("\n");
}

export function richQuoteRanges(layout: RichMessageLayout, quote: ReplyQuote, quotedEmoji?: readonly CustomEmojiRange[]) {
  if (!quote.rich || !quote.text.trim() || quote.text.length > 1024) return;
  const parts = richQuoteParts(layout);
  const text = parts.map((part) => part.text).join("\n");
  const end = quote.position + quote.text.length;
  if (text.slice(quote.position, end) !== quote.text
    || !validDraftStyles(text, [{ offset: quote.position, length: quote.text.length, style: "bold" }])) return;
  const ranges = new Map<RichQuotePart, { start: number; end: number }>();
  let emojiIndex = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const { part, text, offset } of parts) {
    const start = Math.max(0, quote.position - offset);
    const finish = Math.min(text.length, end - offset);
    if (start < finish) {
      if ("expression" in part) {
        if (start !== 0 || finish !== text.length) return;
      } else {
        if (spoilerRanges(text, part.styles).some((range) => range.start < finish && range.end > start)) return;
        const atoms = [...(part.formulas ?? []), ...(part.customEmoji ?? [])];
        if (atoms.some(({ offset, length }) =>
          (start > offset && start < offset + length) || (finish > offset && finish < offset + length))) return;
        for (const emoji of quotedEmoji ? part.customEmoji ?? [] : []) {
          if (emoji.offset < start || emoji.offset + emoji.length > finish) continue;
          const expected = quotedEmoji?.[emojiIndex++];
          if (!expected || expected.id !== emoji.id || expected.length !== emoji.length
            || expected.offset !== offset + emoji.offset - quote.position) return;
        }
      }
      ranges.set(part, { start, end: finish });
      first ??= offset + start;
      last = offset + finish;
    }
  }
  if (first === quote.position && last === end && (!quotedEmoji || emojiIndex === quotedEmoji.length) && ranges.size <= 32) return ranges;
}

const htmlEntities: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => htmlEntities[character]!);

function lineBreaks(text: string) {
  return escapeHtml(text).replace(/\r\n?|\n/g, "<br>");
}

export function plainMessageHtml(text: string) {
  return `<p>${lineBreaks(text)}</p>`;
}

function inlineText(content: RichInline | undefined) {
  return content ? maskSpoilers(content.text, content.styles) : "";
}

export function numberedMarker(number: number, numbering: "1" | "a" | "A" | "i" | "I") {
  if (numbering === "1" || number < 1) return `${number}.`;
  let text = "";
  if (numbering === "a" || numbering === "A") {
    for (let remaining = number; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
      text = String.fromCharCode(65 + (remaining - 1) % 26) + text;
    }
  } else if (number <= 3999) {
    const values = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"],
      [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const;
    for (const [value, marker] of values) {
      text += marker.repeat(Math.floor(number / value));
      number %= value;
    }
  } else return `${number}.`;
  return `${numbering === "A" || numbering === "I" ? text : text.toLowerCase()}.`;
}

type RichListItem = Extract<RichMessageLayout["blocks"][number], { kind: "list" }>["items"][number];
function listMarker(item: RichListItem, index: number) {
  const marker = item.label || (item.numbering ? numberedMarker(item.number ?? index + 1, item.numbering) : "•");
  const task = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
  return `${marker} ${task}`;
}

export function richMessageText(layout: RichMessageLayout) {
  const paragraphs = layout.blocks.map((block) => {
    switch (block.kind) {
      case "rule":
      case "thinking": return "";
      case "buttons": return block.buttons.map(({ label }) => label).join("\n");
      case "math": return block.expression;
      case "photo": case "document": case "attachment":
        return [inlineText(block.content), inlineText(block.credit)].filter(Boolean).join("\n");
      case "quote": return [inlineText(block.content), ...(block.continuation ?? []).map(inlineText), inlineText(block.credit)]
        .filter(Boolean).join("\n");
      case "list": return block.items.map((item, index) => {
        const lines = [inlineText(item.content), ...(item.continuation ?? []).map(inlineText)];
        return `${listMarker(item, index)}${lines.join("\n")}`.trimEnd();
      }).join("\n");
      case "table": {
        const cells = tabSeparatedTableText(block.rows.map((row) => row.map(({ content, rowSpan, colSpan, invisible }) => ({
          ...content, rowSpan, colSpan, invisible,
        }))));
        return [inlineText(block.caption), cells].filter(Boolean).join("\n");
      }
      default: return inlineText(block.content);
    }
  });
  return paragraphs.filter((paragraph) => paragraph.trim()).join("\n\n");
}

const styleTags = new Map([
  ["bold", "strong"], ["italic", "em"], ["underline", "u"], ["strike", "s"], ["code", "code"],
  ["marked", "mark"], ["subscript", "sub"], ["superscript", "sup"],
]);

function buttonHtml(value: unknown) {
  const button = draftRichButton.safeParse(value).data;
  if (!button || button.label.includes("[Spoiler]") || spoilerRanges(button.label, button.labelFormat?.styles).length) return;
  return `<span data-bb-button="${escapeHtml(JSON.stringify(button))}">${escapeHtml(button.label)}</span>`;
}

function inlineHtml(content: RichInline | undefined, preformatted: boolean, portable: boolean, includeLinks: boolean) {
  if (!content?.text) return "";
  const { text, styles = [], links = [] } = content;
  const spoilers = spoilerRanges(text, styles);
  const valid = ({ offset, length }: { offset: number; length: number }) =>
    Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length > 0 && offset + length <= text.length;
  const formatting = styles.filter((style) => valid(style) && styleTags.has(style.style));
  const anchors = (includeLinks ? links : []).flatMap((link) => {
    const url = webLink(link.url);
    return url && valid(link) && !spoilers.some(({ start, end }) => link.offset < end && start < link.offset + link.length)
      ? [{ ...link, href: url.href }] : [];
  });
  const visible = (range: { offset: number; length: number }) => valid(range)
    && !spoilers.some(({ start, end }) => range.offset < end && start < range.offset + range.length);
  const atoms = portable && !preformatted ? [
    ...(content.inlineButtons ?? []).flatMap((range) => {
      const html = visible(range) && text.slice(range.offset, range.offset + range.length) === range.button.label && buttonHtml(range.button);
      return html ? [{ offset: range.offset, length: range.length, html, button: true }] : [];
    }),
    ...(content.formulas ?? []).flatMap((range) => {
      const expression = text.slice(range.offset, range.offset + range.length);
      return visible(range) && richMathExpression.safeParse(expression).success
        ? [{ ...range, html: `<span data-bb-formula>${escapeHtml(expression)}</span>`, button: false }] : [];
    }),
  ].sort((a, b) => a.offset - b.offset) : [];
  const boundaries = [...new Set([0, text.length, ...spoilers.flatMap(({ start, end }) => [start, end]),
    ...[...formatting, ...anchors, ...atoms].flatMap(({ offset, length }) => [offset, offset + length])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const spoiler = spoilers.find((range) => range.start <= start && start < range.end);
    if (spoiler) return start === spoiler.start ? "[Spoiler]" : "";
    const atom = atoms.find(({ offset, length }) => offset <= start && start < offset + length);
    if (atom && start !== atom.offset) return "";
    if (atom?.button) return atom.html;
    const covers = ({ offset, length }: { offset: number; length: number }) => offset <= start && end <= offset + length;
    let body = atom?.html ?? (preformatted ? escapeHtml : lineBreaks)(text.slice(start, end));
    for (const { style } of formatting.filter(covers)) {
      const tag = styleTags.get(style)!;
      body = `<${tag}>${body}</${tag}>`;
    }
    const link = anchors.find(covers);
    return link ? `<a href="${escapeHtml(link.href)}">${body}</a>` : body;
  }).join("");
}

export type RichHtmlAttachment = { path: string; name: string };

export function richMessageHtml(layout: RichMessageLayout, portable = false, files?: ReadonlyMap<number, RichHtmlAttachment>) {
  return renderRichHtml(layout, portable, true, files);
}

export function richMessageSnapshotHtml(layout: RichMessageLayout) {
  return renderRichHtml(layout, false, false);
}

function renderRichHtml(layout: RichMessageLayout, portable: boolean, includeLinks: boolean, files?: ReadonlyMap<number, RichHtmlAttachment>) {
  const html = (content: RichInline | undefined, preformatted = false) => inlineHtml(content, preformatted, portable, includeLinks);
  return layout.blocks.map((block) => {
    switch (block.kind) {
      case "rule": return "<hr>";
      case "thinking": return "";
      case "buttons": {
        const buttons = portable ? block.buttons.map(buttonHtml) : [];
        if (buttons.length && buttons.every(Boolean)) return `<div data-bb-button-row="${block.align ?? "left"}">${buttons.join("")}</div>`;
        return block.buttons.map(({ label }) => `<p>${escapeHtml(label)}</p>`).join("");
      }
      case "math": return `<pre${portable ? " data-bb-formula" : ""}><code>${escapeHtml(block.expression)}</code></pre>`;
      case "photo": case "document": case "attachment": {
        const file = block.kind !== "attachment" && files?.get(block.reference.index);
        if (file && !block.spoiler) {
          const kind = block.kind === "photo" ? "photo" : block.media === "video" ? "video" : "document";
          const caption = html(block.content);
          const credit = html(block.credit);
          return `<figure data-bb-attachment="${kind}"><a download href="${escapeHtml(file.path)}">${escapeHtml(file.name)}</a>`
            + (caption || credit ? `<figcaption>${caption}${credit ? `<footer>${credit}</footer>` : ""}</figcaption>` : "") + "</figure>";
        }
        const caption = [block.content, block.credit].filter((part) => part?.text).map((part) => `<p>${html(part)}</p>`).join("");
        const unavailable = files && block.kind !== "attachment" && !block.spoiler && !block.reference.paid
          && (block.kind === "photo" || block.document.downloadable);
        return caption + (unavailable ? "<p>Attachment unavailable</p>" : "");
      }
      case "title": return `<h2>${html(block.content)}</h2>`;
      case "heading": {
        const level = Math.min(6, block.headingSize ?? 2);
        return `<h${level}>${html(block.content)}</h${level}>`;
      }
      case "code": return `<pre><code${portable && block.language ? ` data-language="${escapeHtml(block.language)}"` : ""}>${html(block.content, true)}</code></pre>`;
      case "quote": {
        const body = [block.content, ...(block.continuation ?? [])].map((content) => `<p>${html(content)}</p>`).join("");
        const credit = block.credit?.text ? `<footer>${html(block.credit)}</footer>` : "";
        return `<blockquote>${body}${credit}</blockquote>`;
      }
      case "list": return `<ul style="list-style-type:none">${block.items.map((item, index) =>
        `<li>${escapeHtml(listMarker(item, index))}${[item.content, ...(item.continuation ?? [])].map((content) =>
          html(content)).join("<br>")}</li>`).join("")}</ul>`;
      case "table": {
        const caption = block.caption.text ? `<caption>${html(block.caption)}</caption>` : "";
        const cells = block.rows.map((row) => `<tr>${row.map((cell) => {
          const tag = cell.header ? "th" : "td";
          const style = [
            ...(cell.align ? [`text-align:${cell.align}`] : []),
            ...(cell.verticalAlign ? [`vertical-align:${cell.verticalAlign}`] : []),
          ].join(";");
          return `<${tag} colspan="${cell.colSpan ?? 1}" rowspan="${cell.rowSpan ?? 1}"${style ? ` style="${style}"` : ""}>${cell.invisible ? "" : html(cell.content)}</${tag}>`;
        }).join("")}</tr>`).join("");
        return `<table>${caption}<tbody>${cells}</tbody></table>`;
      }
      default: return block.content.text ? `<p>${html(block.content)}</p>` : "";
    }
  }).join("");
}
