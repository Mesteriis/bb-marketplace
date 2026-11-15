// Signatures (slice 3d): the stored form, where a new draft gets its block,
// the swap when From changes, and the own signature left out of a text
// quote. Pure; the block itself lives in compose-doc.ts.
import { ComposeError } from "./compose.ts";
import {
  composeDocInputSchema,
  flattenParagraphs,
  isSignatureEmpty,
  normalizeDoc,
  signatureLines,
  type ComposeDoc,
  type ComposeInline,
  type ComposeParagraph,
  type ComposeSignature,
} from "./compose-doc.ts";
import type { ComposeKind } from "./model.ts";

export const SIGNATURE_MAX_BYTES = 16 * 1024;
export const SIGNATURE_MAX_CHARS = 2_000;

/** A stored signature: paragraphs only (marks and links kept). */
export type SignatureDoc = { type: "doc"; content: ComposeParagraph[] };

/** Where a signature goes: the owner's draft kinds, and an agent's new message or reply / forward. */
export type SignaturePlacement = ComposeKind | "agent_new" | "agent_reply";

const DELIMITERS = new Set(["--", "-- "]);

/**
 * The signature as the settings dialog may store it: the document's bounds,
 * `normalizeDoc` (so only http, https and mailto links), every list, quote
 * and signature opened up into paragraphs, a first line `--` / `-- `
 * dropped (the renderer writes the delimiter), then the caps. Throws
 * `ComposeError("invalid")`.
 */
export function normalizeSignature(input: unknown): SignatureDoc {
  const parsed = composeDocInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "doc") throw new ComposeError("invalid");
  const paragraphs = flattenParagraphs(normalizeDoc(parsed.data).content);
  const content = dropLeadingDelimiter(paragraphs);
  // normalizeDoc gives one empty paragraph for an empty document; a stored signature keeps none.
  const kept = content.length === 1 && (content[0]!.content ?? []).length === 0 ? [] : content;
  const signature: SignatureDoc = { type: "doc", content: kept };
  if (visibleChars(kept) > SIGNATURE_MAX_CHARS) throw new ComposeError("invalid");
  if (new TextEncoder().encode(JSON.stringify(signature)).length > SIGNATURE_MAX_BYTES) {
    throw new ComposeError("invalid");
  }
  return signature;
}

function dropLeadingDelimiter(paragraphs: ComposeParagraph[]): ComposeParagraph[] {
  const first = paragraphs[0];
  if (first === undefined) return paragraphs;
  const inlines = first.content ?? [];
  const breakAt = inlines.findIndex((node) => node.type === "hardBreak");
  const line = breakAt === -1 ? inlines : inlines.slice(0, breakAt);
  const lineText = line.map((node) => (node.type === "text" ? node.text : "")).join("");
  if (!DELIMITERS.has(lineText)) return paragraphs;
  if (breakAt === -1) return paragraphs.slice(1);
  const rest: ComposeInline[] = inlines.slice(breakAt + 1);
  const head: ComposeParagraph = rest.length > 0 ? { type: "paragraph", content: rest } : { type: "paragraph" };
  return [head, ...paragraphs.slice(1)];
}

function visibleChars(paragraphs: ComposeParagraph[]): number {
  let count = 0;
  for (const paragraph of paragraphs) {
    for (const node of paragraph.content ?? []) if (node.type === "text") count += [...node.text].length;
  }
  return count;
}

/** The document block of a signature; empty for none. */
export function signatureBlock(signature: SignatureDoc | null): ComposeSignature {
  return { type: "signature", content: signature === null ? [] : signature.content.map(cloneParagraph) };
}

function cloneParagraph(paragraph: ComposeParagraph): ComposeParagraph {
  return JSON.parse(JSON.stringify(paragraph)) as ComposeParagraph;
}

/**
 * The draft with its signature block (spec "Placement"): a new message at
 * the end (`[p(""), signature]`); an owner's reply, reply all or forward
 * after the first paragraph, above the attribution and the quote; an
 * agent's message before the trailing quote, else at the end. A document
 * that already has a top-level signature is returned unchanged.
 */
export function withSignature(doc: ComposeDoc, signature: SignatureDoc | null, kind: SignaturePlacement): ComposeDoc {
  if (doc.content.some((block) => block.type === "signature")) return doc;
  const block = signatureBlock(signature);
  const content = [...doc.content];
  let at: number;
  switch (kind) {
    case "new":
    case "agent_new":
      at = content.length;
      break;
    case "reply":
    case "reply_all":
    case "forward":
      at = Math.min(1, content.length);
      break;
    case "agent_reply":
      at = content.length > 0 && content[content.length - 1]!.type === "blockquote" ? content.length - 1 : content.length;
      break;
  }
  content.splice(at, 0, block);
  return { type: "doc", content };
}

/**
 * From changed (spec "Swap on From change"): an empty block, or one equal
 * to the previous identity's signature, becomes the next identity's (empty
 * for none); a block the owner edited stays and `kept` is true. A document
 * without a top-level signature is unchanged.
 */
export function swapSignature(
  doc: ComposeDoc,
  previous: SignatureDoc | null,
  next: SignatureDoc | null,
): { doc: ComposeDoc; kept: boolean } {
  const index = doc.content.findIndex((block) => block.type === "signature");
  if (index === -1) return { doc, kept: false };
  const current = doc.content[index] as ComposeSignature;
  const replaceable =
    isSignatureEmpty(current) ||
    (previous !== null && JSON.stringify(current.content) === JSON.stringify(previous.content));
  if (!replaceable) return { doc, kept: true };
  const content = [...doc.content];
  content[index] = signatureBlock(next);
  return { doc: { type: "doc", content }, kept: false };
}

/**
 * The text quote of the owner's own mail without its signature (spec
 * resolution 9): the last line equal to `-- ` and the lines after it up to,
 * not including, the first blank line; with none, to the end.
 */
export function stripOwnSignature(lines: string[]): string[] {
  const start = lines.lastIndexOf("-- ");
  if (start === -1) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

/** The text of the document's signature (its lines, without `-- `), or null when it has none or it is empty. */
export function signatureText(doc: ComposeDoc): string | null {
  const block = doc.content.find((b): b is ComposeSignature => b.type === "signature");
  if (block === undefined || isSignatureEmpty(block)) return null;
  return signatureLines(block, false).join("\n");
}
