// Related mail (slice 3h, #83, partial): the distinctive words of the open
// message and the ranking of local candidates. No model, no network: the
// store finds at most 200 candidates by full-text match, shared
// participants and shared references, and this module scores them. Pure.
import type { RelatedReason } from "./model.ts";

/** Terms read from one message. */
export const RELATED_TERMS_MAX = 8;
/** Characters of body text read for terms. */
export const RELATED_BODY_CHARS = 2000;
/** Candidates scored at most. */
export const RELATED_CANDIDATES_MAX = 200;
/** Related messages shown. */
export const RELATED_TOP = 10;
const TERM_MIN = 4;

/** English stop words of four letters or more (shorter words are never terms). */
const STOP_EN: ReadonlySet<string> = new Set([
  "able", "about", "after", "also", "back", "because", "been", "before", "being", "best", "both", "could",
  "dear", "does", "doing", "done", "each", "email", "even", "every", "forwarded", "from", "have", "hello",
  "here", "into", "just", "know", "like", "made", "mail", "make", "many", "message", "more", "most", "much",
  "need", "only", "original", "other", "over", "please", "regards", "reply", "same", "sent", "should",
  "some", "still", "subject", "such", "than", "thank", "thanks", "that", "their", "them", "then", "there",
  "these", "they", "this", "those", "time", "today", "tomorrow", "very", "want", "week", "well", "were",
  "what", "when", "where", "which", "while", "will", "with", "would", "wrote", "year", "yesterday", "your",
]);

/** Russian stop words of four letters or more, written as escapes. */
const STOP_RU: ReadonlySet<string> = new Set([
  "\u0431\u043e\u043b\u0435\u0435", "\u0431\u0443\u0434\u0435\u0442", "\u0431\u0443\u0434\u0443\u0442",
  "\u0431\u044b\u043b\u0438", "\u0431\u044b\u043b\u043e", "\u0431\u044b\u0442\u044c",
  "\u0432\u043e\u043f\u0440\u043e\u0441", "\u0432\u0441\u0435\u0433\u043e", "\u0432\u0441\u0435\u043c",
  "\u0432\u0441\u0435\u0445", "\u0432\u0447\u0435\u0440\u0430", "\u0434\u0430\u0436\u0435",
  "\u0435\u0441\u043b\u0438", "\u0435\u0441\u0442\u044c", "\u0437\u0430\u0432\u0442\u0440\u0430",
  "\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435",
  "\u043a\u043e\u0433\u0434\u0430", "\u043a\u043e\u0442\u043e\u0440\u0430\u044f",
  "\u043a\u043e\u0442\u043e\u0440\u043e\u0435", "\u043a\u043e\u0442\u043e\u0440\u044b\u0435",
  "\u043a\u043e\u0442\u043e\u0440\u044b\u0439", "\u043c\u0435\u0436\u0434\u0443",
  "\u043c\u0435\u043d\u0435\u0435", "\u043c\u043e\u0436\u0435\u0442", "\u043c\u043e\u0436\u043d\u043e",
  "\u043d\u0435\u0433\u043e", "\u043d\u0435\u043c\u0443", "\u043d\u0438\u043c\u0438",
  "\u043d\u0443\u0436\u043d\u043e", "\u043e\u0442\u0432\u0435\u0442", "\u043e\u0447\u0435\u043d\u044c",
  "\u043f\u0435\u0440\u0435\u0434", "\u043f\u0438\u0441\u044c\u043c\u0430",
  "\u043f\u0438\u0441\u044c\u043c\u043e", "\u043f\u0438\u0448\u0443",
  "\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430", "\u043f\u043e\u0441\u043b\u0435",
  "\u043f\u0440\u0438\u0432\u0435\u0442", "\u0441\u0432\u043e\u0435\u0439", "\u0441\u0432\u043e\u0438\u0445",
  "\u0441\u0432\u043e\u0439", "\u0441\u0435\u0433\u043e\u0434\u043d\u044f",
  "\u0441\u0435\u0439\u0447\u0430\u0441", "\u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435",
  "\u0441\u043f\u0430\u0441\u0438\u0431\u043e", "\u0442\u0430\u043a\u0436\u0435", "\u0442\u043e\u0433\u043e",
  "\u0442\u043e\u0436\u0435", "\u0442\u043e\u043b\u044c\u043a\u043e", "\u0442\u043e\u043c\u0443",
  "\u0443\u0432\u0430\u0436\u0435\u043d\u0438\u0435\u043c", "\u0447\u0435\u0440\u0435\u0437",
  "\u0447\u0442\u043e\u0431\u044b", "\u044d\u0442\u0438\u0445", "\u044d\u0442\u043e\u0433\u043e",
  "\u044d\u0442\u043e\u0439", "\u044d\u0442\u043e\u043c", "\u044d\u0442\u043e\u0442",
]);

const WORD = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu;
/** Ticket-like tokens such as INV-2041. */
const TICKET = /^[A-Za-z]{2,10}-\d{1,10}$/;

function isStop(word: string): boolean {
  return STOP_EN.has(word) || STOP_RU.has(word);
}

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * Up to 8 distinctive terms: ticket-like tokens first (kept as written,
 * upper case), then words of the subject, then the most frequent words of
 * the first 2 000 characters of the body. Each term has at least four
 * characters and is not a stop word (English or Russian).
 */
export function relatedTerms(subject: string, text: string): string[] {
  const subjectWords = words(subject);
  const bodyWords = words(text.slice(0, RELATED_BODY_CHARS));
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const key = term.toLowerCase();
    if (terms.length >= RELATED_TERMS_MAX || seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };
  for (const word of [...subjectWords, ...bodyWords]) if (TICKET.test(word)) add(word.toUpperCase());
  const usable = (word: string) => {
    const lower = word.toLowerCase();
    return lower.length >= TERM_MIN && !isStop(lower) && !TICKET.test(word);
  };
  for (const word of subjectWords) if (usable(word)) add(word.toLowerCase());
  const counts = new Map<string, { count: number; first: number }>();
  bodyWords.forEach((word, index) => {
    if (!usable(word)) return;
    const lower = word.toLowerCase();
    const entry = counts.get(lower);
    if (entry === undefined) counts.set(lower, { count: 1, first: index });
    else entry.count += 1;
  });
  const byFrequency = [...counts].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first);
  for (const [word] of byFrequency) add(word);
  return terms;
}

/** One candidate as the store found it. */
export type RelatedCandidate = {
  messageId: string;
  threadId: string;
  date: string | null;
  /** The terms the candidate matched. */
  terms: string[];
  /** Participants (From/To/Cc addresses) shared with the open message. */
  participants: number;
  /** It shares a Message-ID reference with the open message. */
  reference: boolean;
  /** bm25 of the trigram index (lower is better), the tie-break; null when no term matched. */
  rank: number | null;
};

export type RelatedScore = { messageId: string; threadId: string; score: number; reasons: RelatedReason[] };

/**
 * The top 10 candidates outside the open conversation: matched terms
 * weighted by rarity among the candidates (1 + log2(n / matches)), plus 2
 * per shared participant and 5 for a shared reference; ties by bm25, then
 * newest. Each with its reasons.
 */
export function scoreRelated(
  candidates: readonly RelatedCandidate[],
  options: { excludeThreadId: string | null },
): RelatedScore[] {
  const pool = candidates.filter((c) => c.threadId !== options.excludeThreadId).slice(0, RELATED_CANDIDATES_MAX);
  const matches = new Map<string, number>();
  for (const candidate of pool) {
    for (const term of new Set(candidate.terms)) matches.set(term, (matches.get(term) ?? 0) + 1);
  }
  const weight = (term: string) => 1 + Math.log2(pool.length / (matches.get(term) ?? pool.length));
  const scored = pool.map((candidate) => {
    const terms = [...new Set(candidate.terms)];
    const reasons: RelatedReason[] = [];
    if (terms.length > 0) reasons.push({ kind: "terms", terms });
    if (candidate.participants > 0) reasons.push({ kind: "participants", count: candidate.participants });
    if (candidate.reference) reasons.push({ kind: "reference" });
    const score =
      terms.reduce((sum, term) => sum + weight(term), 0) + 2 * candidate.participants + (candidate.reference ? 5 : 0);
    return { candidate, score, reasons };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ar = a.candidate.rank ?? Number.POSITIVE_INFINITY;
      const br = b.candidate.rank ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      const ad = a.candidate.date ?? "";
      const bd = b.candidate.date ?? "";
      if (ad !== bd) return ad < bd ? 1 : -1;
      return a.candidate.messageId < b.candidate.messageId ? -1 : 1;
    })
    .slice(0, RELATED_TOP)
    .map((entry) => ({
      messageId: entry.candidate.messageId,
      threadId: entry.candidate.threadId,
      score: entry.score,
      reasons: entry.reasons,
    }));
}
