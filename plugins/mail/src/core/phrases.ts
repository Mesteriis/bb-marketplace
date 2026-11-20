// Autocomplete for the composer: the phrases the owner writes often, taken
// from their own sent mail and templates, and the rest of a phrase for what
// is typed so far. Everything is computed on this computer; a phrase is the
// owner's own words, never someone's quoted text.

export const PHRASES_MAX = 500;
/** A phrase is written at least this often; a template's sentence counts as this many. */
export const PHRASE_MIN_COUNT = 3;
/** The longest phrase offered (the list's contract allows this much). */
export const PHRASE_MAX_CHARS = 400;
const WORDS_MIN = 3;
const WORDS_MAX = 12;
/** The grey text needs this much typed. */
const TYPED_MIN_WORDS = 2;
const TYPED_MIN_CHARS = 8;

/** Lines that start someone else's text or the signature. */
const ENDS_OWN_TEXT: readonly RegExp[] = [
  /^>/,
  /^-- ?$/,
  /^On .{1,200} wrote:$/i,
  /.{1,200}\s(пишет|написал|написала|писал|писала)(\(а\))?:$/i,
  // French, German, Spanish and Italian mail programs, and Gmail's Russian date form ("пн, 2 нояб. 2026 г. в 10:00, Ada <...>:").
  /^Le .{1,200}\sa écrit\s?:$/i,
  /^Am .{1,200}\sschrieb\s.{1,200}:$/i,
  /^El .{1,200}\sescribió\s?:$/i,
  /^Il .{1,200}\sha scritto\s?:$/i,
  /^.{1,80}\d{4}\s?г\.\s?в\s\d{1,2}:\d{2},\s.{1,200}:$/i,
  /^-{2,}\s*(Original Message|Forwarded message|Пересылаемое сообщение|Исходное сообщение)/i,
  /^Begin forwarded message:/i,
  /^(From|От|Sent|Отправлено|De|Von|Envoyé|Gesendet):\s/i,
];

/** The owner's own text of a sent message: everything above the first quote, forwarded header or signature mark. */
export function ownText(body: string): string {
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (ENDS_OWN_TEXT.some((pattern) => pattern.test(trimmed))) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** The sentences of a text: lines, cut after `.`, `!`, `?` or `…` followed by a space. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?…])\s+/u)) {
      const sentence = part.replace(/\s+/g, " ").trim();
      if (sentence !== "") out.push(sentence);
    }
  }
  return out;
}

function isPhrase(sentence: string): boolean {
  // No numbers, addresses, links or template placeholders; nothing the list's contract would refuse.
  if (/[\d@{}]|:\/\//.test(sentence) || sentence.length > PHRASE_MAX_CHARS) return false;
  const words = sentence.split(" ").length;
  return words >= WORDS_MIN && words <= WORDS_MAX;
}

/**
 * The owner's phrases, most frequent first: sentences of 3 to 12 words that
 * at least 3 of the sent texts hold (a text counts once), plus every such
 * sentence of a template. Each in the spelling written most often.
 */
export function buildPhrases(texts: readonly string[], templates: readonly string[], signatures: readonly string[] = []): string[] {
  // A reply carries the signature above the quote with no mark before it: its lines are known, so they are left out.
  const signed = new Set(signatures.flatMap((signature) => sentencesOf(signature)).map((line) => line.toLocaleLowerCase()));
  const found = new Map<string, { count: number; spellings: Map<string, number>; order: number }>();
  const add = (sentence: string, weight: number) => {
    const key = sentence.toLocaleLowerCase();
    const entry = found.get(key) ?? { count: 0, spellings: new Map<string, number>(), order: found.size };
    entry.count += weight;
    entry.spellings.set(sentence, (entry.spellings.get(sentence) ?? 0) + weight);
    found.set(key, entry);
  };
  for (const text of texts) {
    const seen = new Set<string>();
    for (const sentence of sentencesOf(ownText(text))) {
      const key = sentence.toLocaleLowerCase();
      if (!isPhrase(sentence) || seen.has(key) || signed.has(key)) continue;
      seen.add(key);
      add(sentence, 1);
    }
  }
  for (const template of templates) {
    const seen = new Set<string>();
    for (const sentence of sentencesOf(template)) {
      const key = sentence.toLocaleLowerCase();
      if (!isPhrase(sentence) || seen.has(key)) continue;
      seen.add(key);
      add(sentence, PHRASE_MIN_COUNT);
    }
  }
  return [...found.values()]
    .filter((entry) => entry.count >= PHRASE_MIN_COUNT)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, PHRASES_MAX)
    .map((entry) => [...entry.spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
}

/**
 * The rest of the first phrase that `sentence` (the text from the sentence's
 * start to the cursor) begins, case ignored. Null under 2 words or 8
 * characters, when nothing is left to add, or when no phrase begins so.
 */
export function completion(phrases: readonly string[], sentence: string): string | null {
  const typed = sentence.trimStart();
  if (typed.length < TYPED_MIN_CHARS || typed.trim().split(/\s+/).length < TYPED_MIN_WORDS) return null;
  const lower = typed.toLocaleLowerCase();
  for (const phrase of phrases) {
    if (phrase.length > typed.length && phrase.toLocaleLowerCase().startsWith(lower)) return phrase.slice(typed.length);
  }
  return null;
}
