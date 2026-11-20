// The composer's document: the TipTap (ProseMirror) JSON the page sends, the
// subset the server keeps, and the renderer to message HTML and text. The
// server never takes HTML from the page; it renders HTML itself from the
// normalized document, so only the whitelisted tags below can come out.
import { z } from "zod";
import { isAttribution } from "./quotes.ts";

/** A node as the page sends it: generic, checked for shape, size and depth only. */
export type DocNodeInput = {
  type: string;
  content?: DocNodeInput[];
  text?: string;
  marks?: DocMarkInput[];
  attrs?: Record<string, unknown> | null;
};
export type DocMarkInput = { type: string; attrs?: Record<string, unknown> | null };

export type ComposeMark =
  | { type: "bold" | "italic" | "underline" | "code" }
  | { type: "link"; attrs: { href: string } };
export type ComposeInline =
  | { type: "text"; text: string; marks?: ComposeMark[] }
  | { type: "hardBreak" };
export type ComposeParagraph = { type: "paragraph"; content?: ComposeInline[] };
export type ComposeListItem = { type: "listItem"; content: ComposeBlock[] };
/**
 * A code block (slice 3g): its text verbatim (line breaks and tabs kept, no
 * marks), the language a short lower-case word or null.
 */
export type ComposeCodeBlock = {
  type: "codeBlock";
  attrs: { language: string | null };
  content?: { type: "text"; text: string }[];
};
export type ComposeBlock =
  | ComposeParagraph
  | ComposeCodeBlock
  | { type: "bulletList" | "orderedList"; content: ComposeListItem[] }
  | { type: "blockquote"; content: ComposeBlock[] };
/**
 * The sending identity's signature (slice 3d): top level only, at most one,
 * paragraphs only. Empty, it is the placeholder a From change fills.
 */
export type ComposeSignature = { type: "signature"; content: ComposeParagraph[] };
/** A normalized document: only the nodes and marks the renderer knows. */
export type ComposeDoc = { type: "doc"; content: (ComposeBlock | ComposeSignature)[] };

export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_MAX_DEPTH = 32;
/** Nesting of JSON objects and arrays: two per node level, plus marks and attributes. */
const MAX_CONTAINER_DEPTH = DOC_MAX_DEPTH * 2 + 8;
const TEXT_WIDTH = 76;
const MIN_WIDTH = 20;
const HREF_MAX = 2048;
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const BLOCK_TYPES = new Set(["paragraph", "bulletList", "orderedList", "listItem", "blockquote", "signature", "codeBlock"]);
/** A code block's language: a short word of lower-case letters, digits, +, # and -. */
const LANGUAGE = /^[a-z0-9+#-]{1,32}$/;
/** The fixed class of the signature's `div`; the page never supplies attributes. */
export const SIGNATURE_CLASS = "makosh-signature";

const attrsSchema = z.record(z.string(), z.unknown()).nullable().optional();
const docMarkSchema = z.object({ type: z.string().min(1).max(64), attrs: attrsSchema });
const docNodeSchema: z.ZodType<DocNodeInput> = z.lazy(() =>
  z.object({
    type: z.string().min(1).max(64),
    content: z.array(docNodeSchema).optional(),
    text: z.string().optional(),
    marks: z.array(docMarkSchema).optional(),
    attrs: attrsSchema,
  }),
);

/**
 * The document as the page may send it. Depth and size are checked first,
 * without recursion, so a hostile document cannot overflow the stack.
 */
export const composeDocInputSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = boundsProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  })
  .pipe(docNodeSchema);

function boundsProblem(value: unknown): string | null {
  const stack: { value: unknown; containers: number; nodes: number }[] = [
    { value, containers: 0, nodes: 1 },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as { value: unknown; containers: number; nodes: number };
    if (item.value === null || typeof item.value !== "object") continue;
    const containers = item.containers + 1;
    if (containers > MAX_CONTAINER_DEPTH) return "The document is nested too deeply";
    if (item.nodes > DOC_MAX_DEPTH) return "The document is nested too deeply";
    if (Array.isArray(item.value)) {
      for (const child of item.value) stack.push({ value: child, containers, nodes: item.nodes });
      continue;
    }
    for (const [key, child] of Object.entries(item.value)) {
      if (key === "content" && Array.isArray(child)) {
        stack.push({ value: child, containers, nodes: item.nodes + 1 });
      } else {
        stack.push({ value: child, containers, nodes: item.nodes });
      }
    }
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "The document cannot be read";
  }
  if (json === undefined) return "The document cannot be read";
  if (json.length > DOC_MAX_BYTES || new TextEncoder().encode(json).length > DOC_MAX_BYTES) {
    return "The document is too large";
  }
  return null;
}

/**
 * Keeps doc, paragraph, text, hardBreak, bulletList, orderedList, listItem,
 * blockquote, codeBlock and the bold, italic, underline, code and link marks. Unknown nodes
 * and marks are stripped and their text kept; a link keeps its href only
 * for http, https and mailto; the structure is repaired so TipTap can load
 * the result again. At most one top-level `signature` is kept, holding
 * paragraphs only; a second one, or one nested in a list or quote, becomes
 * ordinary paragraphs with its text kept.
 */
export function normalizeDoc(input: DocNodeInput): ComposeDoc {
  const content: (ComposeBlock | ComposeSignature)[] = [];
  let signatureSeen = false;
  const nodes = input.type === "doc" ? (input.content ?? []) : [input];
  let run: DocNodeInput[] = [];
  const flushRun = () => {
    if (run.length > 0) content.push(...blocks(run));
    run = [];
  };
  for (const node of nodes) {
    if (node.type !== "signature") {
      run.push(node);
      continue;
    }
    flushRun();
    const paragraphs = flattenParagraphs(blocks(node.content ?? []));
    if (signatureSeen) {
      content.push(...paragraphs);
    } else {
      signatureSeen = true;
      content.push({ type: "signature", content: paragraphs });
    }
  }
  flushRun();
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

const FORWARDED_MARK = /^-{5,}\s*Forwarded message\s*-{5,}$/i;
const FORWARDED_FIELD = /^(?:From|Date|Subject|To|Cc):\s/;

/**
 * How many leading blocks are the owner's own: those before the first
 * blockquote or signature, without the lines Mail wrote above the quote
 * (a reply's "On ..., X wrote:" line, a forward's header block). Those
 * lines carry the other side's name, address and subject: they are never
 * sent as the owner's text and never replaced.
 */
export function ownerBlocksEnd(blocks: readonly { type: string; text: string }[]): number {
  let end = blocks.findIndex((block) => block.type === "blockquote" || block.type === "signature");
  if (end < 0) end = blocks.length;
  const paragraph = (index: number) => (blocks[index]?.type === "paragraph" ? blocks[index]!.text.trim() : null);
  const last = paragraph(end - 1);
  if (last === null) return end;
  if (isAttribution(last)) return end - 1;
  // A forward: the mark, then header fields only, right up to the quote.
  let at = end - 1;
  while (at >= 0 && FORWARDED_FIELD.test(paragraph(at) ?? "")) at--;
  return at >= 0 && at < end - 1 && FORWARDED_MARK.test(paragraph(at) ?? "") ? at : end;
}

/**
 * The owner's own text as Improve sends it (slice 3f, spec resolution 8):
 * the blocks before the first blockquote or signature node, one string per
 * paragraph with hardBreak lines joined by "\n", a list as one paragraph
 * with its items as lines. `marks` says whether that range holds any inline
 * mark (bold, italic, underline, link), which Apply drops.
 */
export function ownerParagraphs(doc: ComposeDoc): { paragraphs: string[]; marks: boolean } {
  const paragraphs: string[] = [];
  let marks = false;
  const text = (paragraph: ComposeParagraph) =>
    (paragraph.content ?? [])
      .map((inline) => {
        if (inline.type === "hardBreak") return "\n";
        if ((inline.marks ?? []).length > 0) marks = true;
        return inline.text;
      })
      .join("");
  const plain = (paragraph: ComposeParagraph) => (paragraph.content ?? []).map((inline) => (inline.type === "hardBreak" ? "\n" : inline.text)).join("");
  const end = ownerBlocksEnd(doc.content.map((block) => ({ type: block.type, text: block.type === "paragraph" ? plain(block) : "" })));
  for (const block of doc.content.slice(0, end)) {
    if (block.type === "blockquote" || block.type === "signature") break;
    if (block.type === "paragraph") paragraphs.push(text(block));
    else if (block.type === "codeBlock") {
      // Apply writes paragraphs: the code formatting is lost, so it counts as a mark.
      marks = true;
      paragraphs.push(codeText(block));
    } else paragraphs.push(flattenParagraphs(block.content).map(text).join("\n"));
  }
  return { paragraphs, marks };
}

/** Every paragraph of the blocks, in order: lists and quotes are opened up, a code block becomes one paragraph. */
export function flattenParagraphs(list: (ComposeBlock | ComposeListItem | ComposeSignature)[]): ComposeParagraph[] {
  return list.flatMap((block) =>
    block.type === "paragraph"
      ? [block]
      : block.type === "codeBlock"
        ? [codeParagraph(block)]
        : flattenParagraphs(block.content as (ComposeBlock | ComposeListItem)[]),
  );
}

/** A code block's whole text. */
export function codeText(block: ComposeCodeBlock): string {
  return (block.content ?? []).map((node) => node.text).join("");
}

function codeParagraph(block: ComposeCodeBlock): ComposeParagraph {
  return paragraph(inlines([{ type: "text", text: codeText(block) }]));
}

function blocks(nodes: DocNodeInput[]): ComposeBlock[] {
  const out: ComposeBlock[] = [];
  let pending: ComposeInline[] = [];
  const flush = () => {
    if (pending.length > 0) out.push(paragraph(pending));
    pending = [];
  };
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        flush();
        out.push(paragraph(inlines(node.content ?? [])));
        break;
      case "bulletList":
      case "orderedList": {
        flush();
        const items = listItems(node.content ?? []);
        if (items.length > 0) out.push({ type: node.type, content: items });
        break;
      }
      case "blockquote": {
        flush();
        const inner = blocks(node.content ?? []);
        if (inner.length > 0) out.push({ type: "blockquote", content: inner });
        break;
      }
      case "listItem":
        flush();
        out.push(...blocks(node.content ?? []));
        break;
      case "codeBlock":
        flush();
        out.push(codeBlock(node));
        break;
      case "text":
      case "hardBreak":
        pending.push(...inlines([node]));
        break;
      default: {
        const children = node.content ?? [];
        if (children.length === 0) break;
        flush();
        if (inlineOnly(children)) {
          const content = inlines(children);
          if (content.length > 0) out.push(paragraph(content));
        } else {
          out.push(...blocks(children));
        }
      }
    }
  }
  flush();
  return out;
}

function inlineOnly(nodes: DocNodeInput[]): boolean {
  return nodes.every(
    (node) =>
      node.type === "text" ||
      node.type === "hardBreak" ||
      (!BLOCK_TYPES.has(node.type) && inlineOnly(node.content ?? [])),
  );
}

function listItems(nodes: DocNodeInput[]): ComposeListItem[] {
  const items: ComposeListItem[] = [];
  for (const node of nodes) {
    const inner = node.type === "listItem" ? blocks(node.content ?? []) : blocks([node]);
    if (node.type !== "listItem" && inner.length === 0) continue;
    if (inner[0]?.type !== "paragraph") inner.unshift({ type: "paragraph" });
    items.push({ type: "listItem", content: inner });
  }
  return items;
}

/** The text of every text and hardBreak node below, marks dropped. */
function plainOf(nodes: DocNodeInput[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? (node.text ?? "") : node.type === "hardBreak" ? "\n" : plainOf(node.content ?? []),
    )
    .join("");
}

function codeBlock(node: DocNodeInput): ComposeCodeBlock {
  const raw = node.attrs?.language;
  const lower = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const language = LANGUAGE.test(lower) ? lower : null;
  // Code keeps tabs and line breaks; other control characters go.
  const text = plainOf(node.content ?? [])
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return text === ""
    ? { type: "codeBlock", attrs: { language } }
    : { type: "codeBlock", attrs: { language }, content: [{ type: "text", text }] };
}

function paragraph(content: ComposeInline[]): ComposeParagraph {
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

function inlines(nodes: DocNodeInput[]): ComposeInline[] {
  const out: ComposeInline[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out.push({ type: "hardBreak" });
    } else if (node.type === "text") {
      const marks = normalizeMarks(node.marks ?? []);
      cleanText(node.text ?? "")
        .split("\n")
        .forEach((piece, index) => {
          if (index > 0) out.push({ type: "hardBreak" });
          if (piece === "") return;
          out.push(marks.length > 0 ? { type: "text", text: piece, marks } : { type: "text", text: piece });
        });
    } else {
      out.push(...inlines(node.content ?? []));
    }
  }
  return out;
}

/** Line breaks become "\n", tabs spaces; every other control character goes. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function normalizeMarks(marks: DocMarkInput[]): ComposeMark[] {
  const out: ComposeMark[] = [];
  for (const mark of marks) {
    if (out.some((kept) => kept.type === mark.type)) continue;
    if (mark.type === "bold" || mark.type === "italic" || mark.type === "underline" || mark.type === "code") {
      out.push({ type: mark.type });
    } else if (mark.type === "link") {
      const href = safeHref(mark.attrs?.href);
      if (href !== null) out.push({ type: "link", attrs: { href } });
    }
  }
  return out;
}

function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > HREF_MAX) return null;
  // The URL parser silently drops tabs and line breaks; refuse them instead.
  if (/[\u0000- \u007f-\u009f]/.test(raw.trim()) || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) return null;
  return url.href.length > HREF_MAX ? null : url.href;
}

const KEPT_NODES = new Set(["doc", "text", "hardBreak", ...BLOCK_TYPES]);
const KEPT_MARKS = new Set(["bold", "italic", "underline", "code", "link"]);

/**
 * True when normalizeDoc would drop something of this document: a node or
 * mark outside the schema, or a link whose href it refuses. Attributes the
 * renderer ignores (TipTap's list start, link target) do not count.
 */
export function docLosesContent(input: DocNodeInput): boolean {
  const stack: DocNodeInput[] = [input];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!KEPT_NODES.has(node.type)) return true;
    for (const mark of node.marks ?? []) {
      if (!KEPT_MARKS.has(mark.type)) return true;
      if (mark.type === "link" && safeHref(mark.attrs?.href) === null) return true;
    }
    stack.push(...(node.content ?? []));
  }
  return false;
}

/** Elements whose content the editor keeps as it is (or, for div and span, as a paragraph or plain text). */
const FITTING_TAGS = new Set([
  "html", "head", "body", "meta", "title", "p", "br", "div", "span",
  "ul", "ol", "li", "blockquote", "b", "strong", "i", "em", "u", "a",
  // Slice 3g: the editor keeps code blocks and inline code.
  "pre", "code",
]);
/** Attributes that carry no formatting or content. */
const FITTING_ATTRS = new Set(["href", "target", "rel", "class", "id", "dir", "lang", "name", "title", "charset", "content", "http-equiv", "type", "start"]);

/**
 * True when HTML (a foreign draft's body) fits the editor's schema, so
 * loading it into the composer loses nothing: only the tags and attributes
 * above, and links the editor keeps. Anything else (an image, a table, a
 * heading, inline styles, a font) means the editor would drop it. A plain
 * scan, no DOM: false on any doubt.
 */
export function htmlFitsDoc(html: string): boolean {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/gi, "");
  if (/<!--|<!\[|<\?/.test(source)) return false;
  const tag = /<\/?\s*([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g;
  for (const match of source.matchAll(tag)) {
    const name = match[1]!.toLowerCase();
    if (!FITTING_TAGS.has(name)) return false;
    const attrs = match[2] ?? "";
    const attr = /([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    for (const a of attrs.matchAll(attr)) {
      const key = a[1]!.toLowerCase();
      if (!FITTING_ATTRS.has(key)) return false;
      if (key === "href" && name === "a") {
        const value = decodeBasicEntities(a[2] ?? a[3] ?? a[4] ?? "");
        if (safeHref(value) === null) return false;
      }
    }
  }
  return true;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The server-built document: one paragraph per line, then the quote (if any) as a blockquote. */
export function docFromLines(lines: string[], quote?: string[]): ComposeDoc {
  const content: ComposeBlock[] = lines.map(lineParagraph);
  if (quote !== undefined && quote.length > 0) {
    content.push({ type: "blockquote", content: quote.map(lineParagraph) });
  }
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

function lineParagraph(line: string): ComposeParagraph {
  return paragraph(inlines([{ type: "text", text: line }]));
}

/** True when the document holds no visible text. */
export function isDocEmpty(doc: ComposeDoc): boolean {
  type Node = ComposeBlock | ComposeListItem | ComposeInline | { type: "text"; text: string };
  const stack: Node[] = doc.content.filter((block): block is ComposeBlock => block.type !== "signature");
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.type === "text") {
      if (node.text.trim() !== "") return false;
    } else if (node.type !== "hardBreak") {
      stack.push(...(node.content ?? []));
    }
  }
  return true;
}

/** Message HTML (fixed skeleton, whitelisted tags, only `href` attributes) and the text alternative. */
export function renderDoc(doc: ComposeDoc): { html: string; text: string } {
  // An empty signature renders nothing, not even the blank line around it.
  const content = doc.content.filter((block) => block.type !== "signature" || !isSignatureEmpty(block));
  const last = content.length - 1;
  const body = content
    .map((block, index) => (block.type === "signature" ? signatureHtml(block, index === last) : blockHtml(block)))
    .join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  const lines: string[] = [];
  content.forEach((block, index) => {
    if (index > 0) lines.push("");
    lines.push(...(block.type === "signature" ? signatureLines(block, index === last) : blockText(block, TEXT_WIDTH)));
  });
  return { html, text: lines.join("\n") };
}

/** True when the signature holds no visible text. */
export function isSignatureEmpty(signature: ComposeSignature): boolean {
  return isDocEmpty({ type: "doc", content: signature.content });
}

/**
 * The `-- ` delimiter only when the signature is the last block (a new
 * message): RFC 3676 clients hide what follows it, so a reply's quote below
 * the signature must not follow a delimiter.
 */
function signatureHtml(signature: ComposeSignature, last: boolean): string {
  const delimiter = last ? "<p>-- </p>" : "";
  return `<div class="${SIGNATURE_CLASS}">${delimiter}${signature.content.map(blockHtml).join("")}</div>`;
}

/** The signature's lines with no blank line inside, after `-- ` when it is last. */
export function signatureLines(signature: ComposeSignature, last: boolean): string[] {
  const lines = signature.content
    .flatMap((paragraph) => blockText(paragraph, TEXT_WIDTH))
    .filter((line) => line.trim() !== "");
  return last ? ["-- ", ...lines] : lines;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MARK_TAGS = { bold: "strong", italic: "em", underline: "u" } as const;

function blockHtml(block: ComposeBlock | ComposeListItem): string {
  switch (block.type) {
    case "paragraph": {
      const content = block.content ?? [];
      return `<p>${content.length > 0 ? content.map(inlineHtml).join("") : "<br>"}</p>`;
    }
    case "bulletList":
      return `<ul>${block.content.map(blockHtml).join("")}</ul>`;
    case "orderedList":
      return `<ol>${block.content.map(blockHtml).join("")}</ol>`;
    case "listItem":
      return `<li>${block.content.map(blockHtml).join("")}</li>`;
    case "blockquote":
      return `<blockquote>${block.content.map(blockHtml).join("")}</blockquote>`;
    case "codeBlock": {
      const language = block.attrs.language;
      const open = language === null ? "<code>" : `<code class="language-${escapeHtml(language)}">`;
      return `<pre>${open}${escapeHtml(codeText(block))}</code></pre>`;
    }
  }
}

function inlineHtml(node: ComposeInline): string {
  if (node.type === "hardBreak") return "<br>";
  let html = escapeHtml(node.text);
  const marks = node.marks ?? [];
  if (marks.some((mark) => mark.type === "code")) html = `<code>${html}</code>`;
  for (const type of ["underline", "italic", "bold"] as const) {
    if (marks.some((mark) => mark.type === type)) {
      html = `<${MARK_TAGS[type]}>${html}</${MARK_TAGS[type]}>`;
    }
  }
  const link = linkOf(node);
  return link === null ? html : `<a href="${escapeHtml(link)}">${html}</a>`;
}

function linkOf(node: ComposeInline): string | null {
  if (node.type !== "text") return null;
  for (const mark of node.marks ?? []) if (mark.type === "link") return mark.attrs.href;
  return null;
}

/** Lines of the blocks, each block's lines separated by `separator` ("\n\n" or "\n"). */
function blocksText(list: ComposeBlock[], width: number, separator: "\n\n" | "\n"): string[] {
  const lines: string[] = [];
  list.forEach((block, index) => {
    if (index > 0 && separator === "\n\n") lines.push("");
    lines.push(...blockText(block, width));
  });
  return lines;
}

function blockText(block: ComposeBlock, width: number): string[] {
  switch (block.type) {
    case "paragraph":
      return paragraphText(block.content ?? []).flatMap((line) => wrap(line, width));
    case "bulletList":
    case "orderedList":
      return block.content.flatMap((item, index) => {
        const marker = block.type === "bulletList" ? "- " : `${index + 1}. `;
        const inner = blocksText(item.content, Math.max(MIN_WIDTH, width - marker.length), "\n");
        const indent = " ".repeat(marker.length);
        return inner.map((line, i) => (i === 0 ? marker : line === "" ? "" : indent) + line);
      });
    case "blockquote":
      return blocksText(block.content, Math.max(MIN_WIDTH, width - 2), "\n\n").map((line) =>
        line === "" ? ">" : `> ${line}`,
      );
    case "codeBlock":
      // Verbatim: never wrapped, so the code still runs after a copy.
      return codeText(block).split("\n");
  }
}

/** The paragraph's lines (split at hard breaks), links written as `text <url>`. */
function paragraphText(content: ComposeInline[]): string[] {
  const lines: string[] = [""];
  let runText = "";
  let runHref: string | null = null;
  const closeRun = () => {
    if (runHref !== null && runText !== runHref && `mailto:${runText}` !== runHref) {
      lines[lines.length - 1] += ` <${runHref}>`;
    }
    runText = "";
    runHref = null;
  };
  for (const node of content) {
    if (node.type === "hardBreak") {
      closeRun();
      lines.push("");
      continue;
    }
    const href = linkOf(node);
    if (href !== runHref) closeRun();
    runHref = href;
    const shown = (node.marks ?? []).some((mark) => mark.type === "code") ? `\`${node.text}\`` : node.text;
    runText += node.text;
    lines[lines.length - 1] += shown;
  }
  closeRun();
  return lines;
}

/** Greedy word wrap; a word longer than the width stays whole on its own line. */
function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  out.push(current);
  return out;
}
