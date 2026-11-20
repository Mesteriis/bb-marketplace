// AI writes mail, the pure part: what a model gets to write a message from
// a few words (Write) or to draft a reply to a new message (auto draft),
// and how its answer is read. The owner's request, personal instructions
// and facts are the owner's text (redacted with restore, as Improve does);
// voice samples and the conversation are data. A link the owner did not
// write never survives into the answer.
import {
  AI_INPUT_CAPS,
  AI_JSON_ONLY,
  AI_PREAMBLE,
  AiError,
  NonceCollision,
  aiItems,
  aiParseWith,
  aiText,
  conversationFrame,
  type AiBuild,
  type AiParse,
  type AiSourceMessage,
} from "./ai-input.ts";
import { removeHidden, removeInvisible, truncateText } from "./html-entities.ts";
import { ownText } from "./phrases.ts";
import { hiddenTotal, redactSecrets } from "./redact.ts";

export const WRITE_REQUEST_CHARS = 500;
export const WRITE_PERSONAL_CHARS = 2_000;
export const WRITE_FACTS_CHARS = 6_000;
export const WRITE_OWN_CHARS = 8_000;
export const WRITE_ANSWER_CHARS = 8_000;
export const VOICE_SAMPLES = 5;
export const VOICE_SAMPLE_CHARS = 600;
/** How many of the newest sent messages are looked through for those sent to one recipient. */
export const VOICE_SCAN = 1_000;
/** What stands in for a link the owner did not write. */
export const LINK_REMOVED = "[link removed]";

export type WriteRequest = {
  mode: "write" | "autodraft";
  /** Write only: what the message should say. */
  instruction?: string | undefined;
  /** What the owner wrote so far (the draft's own paragraphs). */
  own: readonly string[];
  /** The owner's standing instructions (setting aiInstructions). */
  personal: string;
  /** The owner's facts (setting aiKnowledge). */
  facts: string;
  /** Own text of sent messages, from voiceSamples; empty with aiVoice off. */
  voice: readonly string[];
  /** The conversation being answered, in scope, oldest first. */
  conversation: readonly AiSourceMessage[];
};

/** A build that also knows which links the answer may hold. */
export type WriteBuild = AiBuild & { allowedLinks: string[] };

/**
 * The owner's own text of sent messages for the voice: those sent to the
 * same recipient first, then the newest; empty ones and repeats dropped; at
 * most five. Not cut here: each is redacted whole before its cut.
 */
export function voiceSamples(toRecipient: readonly string[], newest: readonly string[]): string[] {
  const out: string[] = [];
  for (const body of [...toRecipient, ...newest]) {
    if (out.length === VOICE_SAMPLES) break;
    const own = ownText(body);
    if (own !== "" && !out.includes(own)) out.push(own);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

// What mail programs turn into something to click: a link with a scheme
// (also a broken one, "https:/host"), "//host", an address, a host name
// with or without a port, path, query or fragment (Latin, any other script
// or punycode; a full-width dot counts as a dot), and an IP address with a
// port or path. A name that ends like a file ("report.pdf") is not a link.
const DOT = "[.。．｡]";
const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
const HOST = `(?:${LABEL}${DOT})+(?:xn--[a-z0-9-]+|\\p{L}{2,})`;
const REST = "[^\\s<>\"'`]*";
const LINK = new RegExp(
  "(?<![\\p{L}\\p{N}@._%+-])(?:" +
    `(?:https?|ftp|file|data|javascript|tel|sms|mailto):[^\\s<>"'\`]+` +
    `|//${HOST}${REST}` +
    `|[\\p{L}\\p{N}._%+-]+@${HOST}` +
    `|${HOST}(?::\\d{1,5})?(?:[/?#]${REST})?` +
    `|\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5}${REST}|[/?#]${REST})` +
    ")",
  "giu",
);
const TRAILING = /[.,;:!?)\]}»”。]+$/u;
/** Endings of file names: "report.pdf" and "Node.js" are words, not links. */
const FILE_ENDINGS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "json", "xml", "html", "htm", "md", "js", "ts", "tsx", "jsx", "py", "rb",
  "go", "rs", "java", "css", "zip", "rar", "gz", "png", "jpg", "jpeg", "gif", "svg", "webp", "mp3", "mp4", "mov", "eml", "ics", "exe", "dmg", "log",
]);

/** A bare name that ends like a file, with nothing after it: not a link. */
function looksLikeFile(raw: string): boolean {
  const bare = raw.replace(TRAILING, "");
  if (/[/?#:@]/.test(bare)) return false;
  return FILE_ENDINGS.has(bare.slice(bare.lastIndexOf(".") + 1).toLowerCase());
}

/**
 * A link as compared: no scheme, no slashes before the host, no www, the
 * host (and an address) in lower case with plain dots, no trailing slash
 * or sentence punctuation. A different host, port, path, query or
 * fragment is a different link.
 */
function normalizeLink(raw: string): string {
  const bare = raw
    .replace(TRAILING, "")
    .replace(/^[a-z][a-z0-9+.-]*:(?!\d)\/*/i, "")
    .replace(/^\/+/, "")
    .replace(/^www\./i, "");
  const slash = bare.search(/[/?#]/);
  const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase().replace(/[。．｡]/g, ".");
  const rest = slash < 0 ? "" : bare.slice(slash);
  return `${host}${rest}`.replace(/\/$/, "");
}

/** The links and addresses of a text, normalized, in order, without repeats. */
export function linksOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LINK)) {
    if (looksLikeFile(match[0])) continue;
    const link = normalizeLink(match[0]);
    if (link !== "" && !out.includes(link)) out.push(link);
  }
  return out;
}

/**
 * The paragraphs with every link and address outside `allowedLinks`
 * replaced by LINK_REMOVED; `removed` counts them. Run over the final
 * text, after hidden values are put back, so a link of the owner's that
 * held one compares as the owner wrote it.
 */
export function removeForeignLinks(paragraphs: readonly string[], allowedLinks: readonly string[]): { paragraphs: string[]; removed: number } {
  const allowed = new Set(allowedLinks);
  let removed = 0;
  const kept = paragraphs.map((paragraph) =>
    // Hidden characters go first: one inside a host would split the link and let it through, to be joined again later.
    removeHidden(paragraph).replace(LINK, (raw) => {
      if (looksLikeFile(raw) || allowed.has(normalizeLink(raw))) return raw;
      removed += 1;
      // The sentence punctuation after the link stays.
      return `${LINK_REMOVED}${TRAILING.exec(raw)?.[0] ?? ""}`;
    }),
  );
  return { paragraphs: kept, removed };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Field separator for one redaction over the owner's fields (one numbering, one map). */
const FIELD_MARK = "\u2029";
/** Line breaks around the mark, so a secret at a field's end stops before it. */
const FIELD_JOIN = `\n${FIELD_MARK}\n`;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const clean = (text: string) => removeInvisible(text.replace(/\r\n?/g, "\n").replace(CONTROLS, "")).replaceAll(FIELD_MARK, " ");
const cleanLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();

const TASK = {
  write:
    'Write the body of an email for the owner. "request" says what it should say; "written" is what the owner ' +
    "wrote so far (continue or replace it); when emails follow, the message answers the last of them.",
  autodraft:
    "The emails are a conversation; the last one is new and addressed to the owner. Draft the owner's reply to it. " +
    'When it needs no reply (a notification, a thank-you, nothing asked), return {"reply":false}.',
} as const;

/**
 * The model's input for Write or an auto draft. Throws AiError `failed`
 * for a Write without a request or an auto draft without a conversation,
 * and NonceCollision when the owner's text holds the nonce.
 */
export function writeInput(request: WriteRequest, options: { nonce: string; tag: string; leftOut?: number }): WriteBuild {
  const instruction = request.mode === "write" ? cleanLine(request.instruction ?? "") : null;
  if (instruction === "") throw new AiError("failed");
  if (request.mode === "autodraft" && request.conversation.length === 0) throw new AiError("failed");

  const own = request.own.map(clean);
  const personal = clean(request.personal).trim();
  const facts = clean(request.facts).trim();
  const allowedLinks = linksOf([instruction ?? "", personal, facts, ...own].join("\n"));

  // One redaction over the owner's fields; each is cut after it.
  const fields = [instruction ?? "", personal, facts, ...own];
  const redaction = redactSecrets(fields.join(FIELD_JOIN), { restore: true, tag: options.tag });
  const redacted = redaction.text.split(FIELD_JOIN);
  if (redacted.length !== fields.length) throw new AiError("failed");
  let hidden = hiddenTotal(redaction.counts);
  let room = WRITE_OWN_CHARS;
  const written = redacted.slice(3).map((paragraph) => {
    const kept = truncateText(paragraph, room);
    room -= kept.length;
    return kept;
  });
  const owner = {
    ...(instruction === null ? {} : { request: truncateText(redacted[0]!, WRITE_REQUEST_CHARS) }),
    written,
    instructions: truncateText(redacted[1]!, WRITE_PERSONAL_CHARS),
    facts: truncateText(redacted[2]!, WRITE_FACTS_CHARS),
  };

  const samples = request.voice.slice(0, VOICE_SAMPLES).map((sample) => {
    const one = redactSecrets(clean(sample));
    hidden += hiddenTotal(one.counts);
    return truncateText(one.text, VOICE_SAMPLE_CHARS);
  });

  const nonce = options.nonce;
  const blocks = [`<<<OWNER ${nonce}>>>\n${JSON.stringify(owner)}\n<<<END OWNER ${nonce}>>>`];
  if (samples.length > 0) blocks.push(`<<<VOICE ${nonce}>>>\n${JSON.stringify({ samples })}\n<<<END VOICE ${nonce}>>>`);
  if (nonce === "" || blocks.some((block) => block.split("\n")[1]!.includes(nonce))) throw new NonceCollision();
  const frame = conversationFrame(request.conversation, AI_INPUT_CAPS[request.mode], nonce);
  if (frame.framed !== "") blocks.push(frame.framed);

  return {
    instructions:
      `${AI_PREAMBLE}\n\n${TASK[request.mode]} The OWNER block is the owner's own text: ` +
      '"instructions" are standing instructions to follow, "facts" are the only facts you may add beyond the ' +
      "emails; never invent prices, dates, names, addresses or links. " +
      (samples.length > 0 ? "The VOICE block holds the owner's earlier messages: match their tone, length, greeting and sign-off; do not copy their content. " : "") +
      "Write in the language of the email being answered, or of the request when there is none. No subject line, no quoted text. " +
      'Return {"reply":true,"paragraphs":["..."]}: plain text paragraphs, no HTML or Markdown; a line break inside ' +
      `a paragraph is \\n. ${AI_JSON_ONLY}`,
    input: blocks.join("\n\n"),
    parts: frame.parts,
    notes: { hidden: hidden + frame.hidden, leftOut: options.leftOut ?? 0, truncated: frame.truncated },
    restore: redaction.restore ?? new Map(),
    allowedLinks,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * The written paragraphs: at most WRITE_ANSWER_CHARS in all (what goes past
 * is dropped and counted). `reply` false (auto drafts) keeps nothing.
 * Unreadable without any text. Links are checked by removeForeignLinks,
 * after the hidden values are put back.
 */
export function parseWrite(output: string): AiParse<{ reply: boolean; paragraphs: string[] }> {
  const parsed = aiParseWith(output, (object, tally) => {
    if (object.reply === false) return { reply: false, paragraphs: [] as string[] };
    let room = WRITE_ANSWER_CHARS;
    const paragraphs = aiItems(object.paragraphs, 1_000, (raw) => {
      const value = aiText(raw, Number.MAX_SAFE_INTEGER, true);
      if (value === null || room <= 0) return null;
      const kept = truncateText(value, room);
      room -= kept.length;
      return kept;
    }, tally);
    return { reply: true, paragraphs };
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.reply && parsed.value.paragraphs.every((paragraph) => paragraph.trim() === "")) return { ok: false, error: "unreadable" };
  return parsed;
}
