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
import { removeInvisible, truncateText } from "./html-entities.ts";
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

/** A scheme link, a www link, or a domain followed by a path. Addresses (a@b) are not links. */
const LINK = /(?<![@\w.-])(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`]*/giu;
const TRAILING = /[.,;:!?)\]}»”]+$/u;

/** A link as compared: no scheme, no www, host in lower case, no trailing slash or sentence punctuation. */
function normalizeLink(raw: string): string {
  const bare = raw.replace(TRAILING, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const slash = bare.search(/[/?#]/);
  const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase();
  const rest = slash < 0 ? "" : bare.slice(slash);
  return `${host}${rest}`.replace(/\/$/, "");
}

/** The links of a text, normalized, in order, without repeats. */
export function linksOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const link = normalizeLink(match[0]);
    if (link !== "" && !out.includes(link)) out.push(link);
  }
  return out;
}

/** The text with every link outside `allowed` replaced; `removed` counts them. */
function keepAllowedLinks(text: string, allowed: ReadonlySet<string>): { text: string; removed: number } {
  let removed = 0;
  const kept = text.replace(LINK, (raw) => {
    if (allowed.has(normalizeLink(raw))) return raw;
    removed += 1;
    // The sentence punctuation after the link stays.
    return `${LINK_REMOVED}${TRAILING.exec(raw)?.[0] ?? ""}`;
  });
  return { text: kept, removed };
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
 * is dropped and counted), links outside `allowedLinks` replaced. `reply`
 * false (auto drafts) keeps nothing. Unreadable without any text.
 */
export function parseWrite(
  output: string,
  allowedLinks: readonly string[],
): AiParse<{ reply: boolean; paragraphs: string[]; linksRemoved: number }> {
  const allowed = new Set(allowedLinks);
  let linksRemoved = 0;
  const parsed = aiParseWith(output, (object, tally) => {
    if (object.reply === false) return { reply: false, paragraphs: [] as string[] };
    let room = WRITE_ANSWER_CHARS;
    const paragraphs = aiItems(object.paragraphs, 1_000, (raw) => {
      const value = aiText(raw, Number.MAX_SAFE_INTEGER, true);
      if (value === null || room <= 0) return null;
      const kept = truncateText(value, room);
      room -= kept.length;
      const { text, removed } = keepAllowedLinks(kept, allowed);
      linksRemoved += removed;
      return text;
    }, tally);
    return { reply: true, paragraphs };
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.reply && parsed.value.paragraphs.every((paragraph) => paragraph.trim() === "")) return { ok: false, error: "unreadable" };
  return { ok: true, value: { ...parsed.value, linksRemoved }, dropped: parsed.dropped };
}
