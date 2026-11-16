// A BB thread's Markdown answer as a Mail draft body (slice 3g, #67): a small
// subset becomes the composer's document (paragraphs, hard breaks, lists,
// quotes, fenced code, https links; headings become bold paragraphs) and
// everything else stays literal text. The result goes through normalizeDoc,
// so only the composer's schema comes out. Line by line; no regular
// expression runs over more than one line. Pure.
import { normalizeDoc, type ComposeDoc, type DocNodeInput } from "./compose-doc.ts";

export const MARKDOWN_INPUT_MAX = 100_000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]{0,32})[ \t]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;
const CONTINUATION = /^ {2,}\S/;

/** `[text](https://...)`, on one line. */
const MD_LINK = /\[([^\[\]\n]{1,500})\]\((https:\/\/[^\s()<>]{1,2000})\)/g;
/** A bare https URL: one character class, so no backtracking. */
const BARE_URL = /https:\/\/[^\s<>()[\]"'`]{1,2000}/g;

function linkNode(text: string, href: string): DocNodeInput {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?".includes(url[end - 1]!)) end--;
  return url.slice(0, end);
}

/** One line's text with [text](https://...) and bare https URLs as links. */
function inline(line: string): DocNodeInput[] {
  const out: DocNodeInput[] = [];
  let at = 0;
  const pushText = (text: string) => {
    if (text !== "") out.push({ type: "text", text });
  };
  while (at < line.length) {
    MD_LINK.lastIndex = at;
    BARE_URL.lastIndex = at;
    const md = MD_LINK.exec(line);
    const bare = BARE_URL.exec(line);
    if (md === null && bare === null) break;
    if (md !== null && (bare === null || md.index <= bare.index)) {
      pushText(line.slice(at, md.index));
      out.push(linkNode(md[1]!, md[2]!));
      at = md.index + md[0].length;
    } else {
      const url = trimUrl(bare![0]);
      pushText(line.slice(at, bare!.index));
      if (url.length > "https://".length) out.push(linkNode(url, url));
      else pushText(url);
      at = bare!.index + url.length;
    }
  }
  pushText(line.slice(at));
  return out;
}

/** Lines of one paragraph, joined by hard breaks. */
function paragraphOf(lines: readonly string[], bold = false): DocNodeInput {
  const content: DocNodeInput[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    for (const node of inline(line)) {
      content.push(bold && node.type === "text" ? { ...node, marks: [...(node.marks ?? []), { type: "bold" }] } : node);
    }
  });
  return { type: "paragraph", content };
}

function listOf(lines: readonly string[], start: number, marker: RegExp): { node: DocNodeInput; next: number } {
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = marker.exec(line);
    if (item !== null) {
      items.push([item[1]!]);
    } else if (items.length > 0 && CONTINUATION.test(line)) {
      items[items.length - 1]!.push(line.trim());
    } else {
      break;
    }
    i++;
  }
  const type = marker === BULLET ? "bulletList" : "orderedList";
  return { node: { type, content: items.map((item) => ({ type: "listItem", content: [paragraphOf(item)] })) }, next: i };
}

function blocks(lines: readonly string[]): DocNodeInput[] {
  const out: DocNodeInput[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(paragraphOf(paragraph));
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      flush();
      const marker = fence[1]!;
      let end = i + 1;
      while (end < lines.length) {
        const close = FENCE_CLOSE.exec(lines[end]!);
        if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        end++;
      }
      const code = lines.slice(i + 1, end).join("\n");
      const language = fence[2]! === "" ? null : fence[2]!;
      out.push({ type: "codeBlock", attrs: { language }, content: code === "" ? [] : [{ type: "text", text: code }] });
      i = end + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      if (heading[1]! !== "") out.push(paragraphOf([heading[1]!], true));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(QUOTE, ""));
        i++;
      }
      out.push({ type: "blockquote", content: blocks(inner) });
      continue;
    }
    const marker = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
    if (marker !== null) {
      flush();
      const list = listOf(lines, i, marker);
      out.push(list.node);
      i = list.next;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return out;
}

/** The composer's document for Markdown text (at most 100 000 characters read). */
export function markdownToDoc(text: string): ComposeDoc {
  const input = text.length > MARKDOWN_INPUT_MAX ? text.slice(0, MARKDOWN_INPUT_MAX) : text;
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  return normalizeDoc({ type: "doc", content: blocks(lines) });
}
