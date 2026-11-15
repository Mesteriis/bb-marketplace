// Reply templates (slice 3d): named documents the owner writes in settings
// and inserts at the cursor; agents list them and name one in mail_propose.
// Owner-written, so trusted as the owner's own text, but only ever rendered
// through the document schema and renderDoc. Pure.
import { ComposeError } from "./compose.ts";
import {
  composeDocInputSchema,
  normalizeDoc,
  renderDoc,
  type ComposeBlock,
  type ComposeDoc,
  type ComposeInline,
  type ComposeListItem,
  type ComposeSignature,
} from "./compose-doc.ts";

export const TEMPLATES_MAX = 200;
export const TEMPLATE_MAX_BYTES = 32 * 1024;
export const TEMPLATE_MAX_CHARS = 10_000;
export const TEMPLATE_NAME_MAX = 80;
/** One template's text in the mail_templates answer, and the whole answer. */
export const MAIL_TEMPLATES_TEXT_MAX = 2_000;
export const MAIL_TEMPLATES_ANSWER_MAX_BYTES = 64 * 1024;

const LINE_BREAKS = /[\r\n\u0000\u0085\u2028\u2029]/;

/** The key names are unique by: NFKC, trimmed, inner whitespace collapsed, lower case. */
export function templateNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** A template's name as stored: trimmed, 1 to 80 characters, one line. Throws `ComposeError("invalid")`. */
export function templateName(input: string): string {
  if (typeof input !== "string") throw new ComposeError("invalid");
  const name = input.trim();
  const length = [...name].length;
  if (length < 1 || length > TEMPLATE_NAME_MAX || LINE_BREAKS.test(name)) throw new ComposeError("invalid");
  return name;
}

/**
 * The template's document: the document's bounds, `normalizeDoc`, then
 * refusals for a signature block and for a quote anywhere (spec resolution
 * 6: a template never looks like a quote), then the caps. Throws
 * `ComposeError("invalid")`.
 */
export function normalizeTemplate(input: unknown): ComposeDoc {
  const parsed = composeDocInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "doc") throw new ComposeError("invalid");
  const doc = normalizeDoc(parsed.data);
  if (doc.content.some((block) => block.type === "signature")) throw new ComposeError("invalid");
  if (holdsQuote(doc.content as ComposeBlock[])) throw new ComposeError("invalid", "Templates cannot hold quotes");
  if (visibleChars(doc) > TEMPLATE_MAX_CHARS) throw new ComposeError("invalid");
  if (new TextEncoder().encode(JSON.stringify(doc)).length > TEMPLATE_MAX_BYTES) throw new ComposeError("invalid");
  return doc;
}

function holdsQuote(list: (ComposeBlock | ComposeListItem)[]): boolean {
  return list.some(
    (block) =>
      block.type === "blockquote" ||
      (block.type !== "paragraph" && holdsQuote(block.content as (ComposeBlock | ComposeListItem)[])),
  );
}

function visibleChars(doc: ComposeDoc): number {
  let count = 0;
  const stack: (ComposeBlock | ComposeListItem | ComposeSignature | ComposeInline)[] = [...doc.content];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "text") count += [...node.text].length;
    else if (node.type !== "hardBreak") stack.push(...(node.content ?? []));
  }
  return count;
}

/** The text form agents and the card see. */
export function templateText(doc: ComposeDoc): string {
  return renderDoc(doc).text;
}

/** Copies of the template's blocks, to splice into a proposal's document. */
export function templateBlocks(doc: ComposeDoc): ComposeBlock[] {
  return doc.content
    .filter((block): block is ComposeBlock => block.type !== "signature")
    .map((block) => JSON.parse(JSON.stringify(block)) as ComposeBlock);
}

/** The mail_templates answer: at most 200 entries, each text cut to 2 000 characters with "…", the whole at most 64 KiB. */
export function templatesForAgent(rows: { name: string; doc: ComposeDoc }[]): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const encoder = new TextEncoder();
  let bytes = 2; // the array's brackets
  for (const row of rows.slice(0, TEMPLATES_MAX)) {
    const entry = { name: row.name, text: cut(templateText(row.doc)) };
    const size = encoder.encode(JSON.stringify(entry)).length + (out.length > 0 ? 1 : 0);
    if (bytes + size > MAIL_TEMPLATES_ANSWER_MAX_BYTES) break;
    bytes += size;
    out.push(entry);
  }
  return out;
}

function cut(text: string): string {
  const chars = [...text];
  return chars.length <= MAIL_TEMPLATES_TEXT_MAX ? text : `${chars.slice(0, MAIL_TEMPLATES_TEXT_MAX - 1).join("")}…`;
}
