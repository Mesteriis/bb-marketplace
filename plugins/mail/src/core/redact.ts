// Secret redaction (slice 3f). Every text that reaches an agent or a model
// passes redactSecrets: one-time codes, passwords, tokens and card numbers
// become "[hidden \u2026]" placeholders. The input is untrusted mail, so each
// detector is a forward scan: literal searches, fixed-length patterns and
// single-class runs only, never a regular expression that can backtrack over
// attacker text. False positives are accepted (a hidden order number costs
// little); false negatives are the stated limit.
//
// Pure: no host code, no I/O. The restore map (placeholder -> original) lives
// only in the caller's job memory; it is never sent, logged or stored.

export type SecretKind = "code" | "credential" | "token" | "card";

export type Redaction = {
  text: string;
  counts: Record<SecretKind, number>;
  /** Only with { restore: true }: placeholder -> original, kept in server memory. */
  restore: Map<string, string> | null;
};

export type RedactOptions = {
  /** Number the placeholders (tagged with `tag`) and return the map back. */
  restore?: boolean;
  /** Extra text that decides keyword proximity but is not rewritten (the subject, for a body). */
  context?: string;
  /** The per-job tag numbered placeholders carry (newRestoreTag). */
  tag?: string;
};

export const SECRET_KINDS: readonly SecretKind[] = ["code", "credential", "token", "card"];

const KIND_NAME: Record<SecretKind, string> = {
  code: "one-time code",
  credential: "password",
  token: "token",
  card: "card number",
};
const KIND_PLURAL: Record<SecretKind, string> = {
  code: "one-time codes",
  credential: "passwords",
  token: "tokens",
  card: "card numbers",
};

export const PLACEHOLDER: Record<SecretKind, string> = {
  code: "[hidden one-time code]",
  credential: "[hidden password]",
  token: "[hidden token]",
  card: "[hidden card number]",
};

/** How close (in characters) a value must be to its keyword. */
const WINDOW = 80;
/** The subject-context rule looks at the start of the body only. */
const CONTEXT_SCAN = 2_000;

type Span = { start: number; end: number; kind: SecretKind };
type Range = { start: number; end: number };

const PRIORITY: Record<SecretKind, number> = { token: 4, card: 3, credential: 2, code: 1 };

// ---------------------------------------------------------------------------
// Character classes (UTF-16 units)
// ---------------------------------------------------------------------------

const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isAsciiAlnum = (c: number) => isDigit(c) || isUpper(c) || isLower(c);
const isHex = (c: number) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
/** [A-Za-z0-9_-]: base64url. */
const isB64Url = (c: number) => isAsciiAlnum(c) || c === 95 || c === 45;
const isSpace = (c: number) => c === 32 || c === 9;
const isWhite = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const LETTER = /\p{L}/u;
/** A letter or digit of any script: what a word boundary looks at. */
function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const c = text.charCodeAt(index);
  if (c < 128) return isAsciiAlnum(c);
  return LETTER.test(text[index]!);
}

/** Lower-cases unit by unit, keeping every index where it was. */
function lowerSameLength(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const low = ch.toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

class Lines {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
  }
  /** The 0-based line of an index. */
  of(index: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  start(line: number): number {
    return this.starts[line] ?? Infinity;
  }
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/** Code words; `whole` ones must end at a word boundary too (resolution 11). */
const CODE_WORDS: { word: string; whole: boolean }[] = [
  { word: "security code", whole: false },
  { word: "login code", whole: false },
  { word: "passcode", whole: false },
  { word: "one-time", whole: false },
  { word: "verification", whole: false },
  { word: "verify", whole: false },
  { word: "confirm", whole: false },
  { word: "sign-in", whole: false },
  { word: "otp", whole: false },
  { word: "2fa", whole: false },
  { word: "code", whole: true },
  { word: "pin", whole: true },
  { word: "\u043a\u043e\u0434", whole: true },
  { word: "\u043f\u0438\u043d", whole: true },
  { word: "\u043f\u0430\u0440\u043e\u043b\u044c", whole: false },
  { word: "\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434", whole: false },
  { word: "\u043e\u0434\u043d\u043e\u0440\u0430\u0437\u043e\u0432", whole: false },
  { word: "\u043f\u0440\u043e\u0432\u0435\u0440\u043e\u0447\u043d", whole: false },
];

/** Credential labels (whole words); `token` ones hide as a token. */
const CREDENTIAL_LABELS: { word: string; kind: SecretKind }[] = [
  { word: "passphrase", kind: "credential" },
  { word: "password", kind: "credential" },
  { word: "passwd", kind: "credential" },
  { word: "pwd", kind: "credential" },
  { word: "\u043f\u0430\u0440\u043e\u043b\u044c", kind: "credential" },
  { word: "pin", kind: "credential" },
  { word: "secret", kind: "credential" },
  { word: "\u0441\u0435\u043a\u0440\u0435\u0442", kind: "credential" },
  { word: "key", kind: "token" },
  { word: "token", kind: "token" },
  { word: "\u043a\u043b\u044e\u0447", kind: "token" },
  { word: "\u0442\u043e\u043a\u0435\u043d", kind: "token" },
];

/** Card labels: their window lets any grouping of 13-19 digits take the Luhn check. */
const CARD_WORDS: { word: string; whole: boolean }[] = [
  { word: "mastercard", whole: false },
  { word: "card", whole: false },
  { word: "visa", whole: true },
  { word: "\u043a\u0430\u0440\u0442", whole: false },
  { word: "\u043c\u0438\u0440", whole: true },
];

const CVV_WORDS: { word: string; whole: boolean }[] = [
  { word: "cvv2", whole: true },
  { word: "cvv", whole: true },
  { word: "cvc", whole: true },
];

type Hit = Range & { word: string };

/** Occurrences of the words in lower-cased text, at a word start (and end, for whole words). */
function findWords(lower: string, words: { word: string; whole: boolean }[]): Hit[] {
  const sorted = [...words].sort((a, b) => b.word.length - a.word.length);
  const whole = new Map(sorted.map((w) => [w.word, w.whole]));
  const pattern = new RegExp(sorted.map((w) => escapeRegExp(w.word)).join("|"), "g");
  const hits: Hit[] = [];
  for (let m = pattern.exec(lower); m !== null; m = pattern.exec(lower)) {
    const start = m.index;
    const end = start + m[0].length;
    if (isWordChar(lower, start - 1)) continue;
    if (whole.get(m[0]) === true && isWordChar(lower, end)) continue;
    hits.push({ start, end, word: m[0] });
  }
  return hits;
}

/** Keyword hits sorted by start, answering "is there one near this span". */
class Near {
  constructor(
    private readonly hits: Hit[],
    private readonly lines: Lines,
  ) {}

  get any(): boolean {
    return this.hits.length > 0;
  }

  /**
   * A hit within WINDOW characters of [start, end), on the same line, or on
   * the line just above the span (a value under its label).
   */
  has(start: number, end: number, window = WINDOW): boolean {
    if (this.hits.length === 0) return false;
    const line = this.lines.of(start);
    // The last hit starting at or before `start`, then a few on each side.
    let lo = 0;
    let hi = this.hits.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.hits[mid]!.start <= start) lo = mid;
      else hi = mid - 1;
    }
    for (let i = Math.max(0, lo - 2); i <= Math.min(this.hits.length - 1, lo + 2); i++) {
      const hit = this.hits[i]!;
      const gap = hit.end <= start ? start - hit.end : hit.start >= end ? hit.start - end : 0;
      if (gap > window) continue;
      const hitLine = this.lines.of(hit.start);
      if (hitLine === line) return true;
      if (hit.end <= start && hitLine === line - 1) return true;
    }
    return false;
  }

  onLine(line: number): boolean {
    let lo = 0;
    let hi = this.hits.length;
    const from = this.lines.start(line);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.hits[mid]!.start < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.hits.length && this.lines.of(this.hits[lo]!.start) === line;
  }
}

/** Whether a span lies inside one of the sorted, disjoint ranges. */
function insideAny(ranges: Range[], index: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (index < r.start) hi = mid - 1;
    else if (index >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A PEM private key block, from its BEGIN line to the end of its END line (or the text). */
function pemBlocks(text: string, spans: Span[]): void {
  let from = 0;
  let privateAt = -2;
  for (;;) {
    const begin = text.indexOf("-----BEGIN ", from);
    if (begin < 0) return;
    let lineEnd = text.indexOf("\n", begin);
    if (lineEnd < 0) lineEnd = text.length;
    if (privateAt !== -1 && privateAt < begin) privateAt = text.indexOf("PRIVATE KEY-----", begin);
    if (privateAt < 0 || privateAt >= lineEnd) {
      if (privateAt < 0) return;
      from = begin + 11;
      continue;
    }
    const endMark = text.indexOf("-----END ", lineEnd);
    if (endMark < 0) {
      spans.push({ start: begin, end: text.length, kind: "token" });
      return;
    }
    let end = text.indexOf("\n", endMark);
    if (end < 0) end = text.length;
    if (text.charCodeAt(end - 1) === 13) end -= 1;
    spans.push({ start: begin, end, kind: "token" });
    from = end;
  }
}

/** JWTs: `eyJ` and three base64url parts joined by dots. */
function jwts(text: string, spans: Span[]): void {
  let from = 0;
  for (;;) {
    const at = text.indexOf("eyJ", from);
    if (at < 0) return;
    let i = at;
    while (i < text.length && isB64Url(text.charCodeAt(i))) i++;
    const firstEnd = i;
    from = Math.max(at + 3, firstEnd);
    if (at > 0 && isB64Url(text.charCodeAt(at - 1))) continue;
    if (firstEnd - at < 10 || text.charCodeAt(i) !== 46) continue;
    i++;
    const second = i;
    while (i < text.length && isB64Url(text.charCodeAt(i))) i++;
    if (i === second || text.charCodeAt(i) !== 46) continue;
    i++;
    while (i < text.length && isB64Url(text.charCodeAt(i))) i++;
    spans.push({ start: at, end: i, kind: "token" });
    from = i;
  }
}

/** Known token prefixes; `min` counts the token characters after the prefix. */
const TOKEN_PREFIXES: { prefix: string; min: number; exact?: number; upper?: boolean }[] = [
  { prefix: "github_pat_", min: 16 },
  { prefix: "ghp_", min: 16 },
  { prefix: "gho_", min: 16 },
  { prefix: "ghu_", min: 16 },
  { prefix: "ghs_", min: 16 },
  { prefix: "ghr_", min: 16 },
  { prefix: "glpat-", min: 16 },
  { prefix: "sk_live_", min: 16 },
  { prefix: "rk_live_", min: 16 },
  { prefix: "sk-", min: 20 },
  { prefix: "xoxa-", min: 10 },
  { prefix: "xoxb-", min: 10 },
  { prefix: "xoxp-", min: 10 },
  { prefix: "xoxs-", min: 10 },
  { prefix: "AKIA", min: 16, exact: 16, upper: true },
  { prefix: "ASIA", min: 16, exact: 16, upper: true },
  { prefix: "AIza", min: 35, exact: 35 },
];

/** A known prefix at `at` (a boundary already checked); the token's end, or -1. */
function prefixedToken(text: string, at: number): number {
  for (const { prefix, min, exact, upper } of TOKEN_PREFIXES) {
    if (!text.startsWith(prefix, at)) continue;
    let i = at + prefix.length;
    const limit = exact === undefined ? text.length : Math.min(text.length, i + exact);
    while (i < limit) {
      const c = text.charCodeAt(i);
      if (upper ? !(isUpper(c) || isDigit(c)) : !isB64Url(c)) break;
      i++;
    }
    if (i - at - prefix.length < min) continue;
    if (exact !== undefined && isAsciiAlnum(text.charCodeAt(i))) continue;
    return i;
  }
  return -1;
}

/** `ya29.` OAuth access tokens (the dot keeps them out of the run scan). */
function googleAccessTokens(text: string, spans: Span[]): void {
  let from = 0;
  for (;;) {
    const at = text.indexOf("ya29.", from);
    if (at < 0) return;
    let i = at + 5;
    while (i < text.length && (isB64Url(text.charCodeAt(i)) || text.charCodeAt(i) === 46)) i++;
    from = i;
    if (at > 0 && isAsciiAlnum(text.charCodeAt(at - 1))) continue;
    if (i - at - 5 >= 20) spans.push({ start: at, end: i, kind: "token" });
  }
}

/** [A-Za-z0-9+/_=-]: the generic rule's characters. */
const isTokenChar = (c: number) => isB64Url(c) || c === 43 || c === 47 || c === 61;

function mixedCase(text: string, start: number, end: number): boolean {
  let digit = false;
  let lower = false;
  let upper = false;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) digit = true;
    else if (isLower(c)) lower = true;
    else if (isUpper(c)) upper = true;
  }
  return digit && lower && upper;
}

function allHex(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!isHex(text.charCodeAt(i))) return false;
  return true;
}

/** The generic rule over one piece: 32+ mixed characters, or 32+ hexadecimal ones. */
function genericSecret(text: string, start: number, end: number, minMixed = 32): boolean {
  const length = end - start;
  if (length >= 32 && allHex(text, start, end)) return true;
  return length >= minMixed && mixedCase(text, start, end);
}

/**
 * Whitespace-delimited words holding an '@' and no "://": e-mail addresses,
 * whose parts the generic rule leaves.
 */
function emailWords(text: string): Range[] {
  const out: Range[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("@", from);
    if (at < 0) return out;
    let start = at;
    while (start > 0 && !isWhite(text.charCodeAt(start - 1)) && start > from) start--;
    let end = at + 1;
    while (end < text.length && !isWhite(text.charCodeAt(end))) end++;
    if (!text.slice(start, end).includes("://")) out.push({ start, end });
    from = end;
  }
}

/** Runs of token characters outside URLs: known prefixes and the generic rule. */
function tokenRuns(text: string, urls: Range[], emails: Range[], spans: Span[]): void {
  const run = /[A-Za-z0-9+/_=-]+/g;
  for (let m = run.exec(text); m !== null; m = run.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (insideAny(urls, start) || insideAny(emails, start)) continue;
    // Known prefixes, at the run's start or after a non-alphanumeric character inside it.
    let covered = start;
    for (let i = start; i < end; i++) {
      if (i < covered) continue;
      if (i > start && isAsciiAlnum(text.charCodeAt(i - 1))) continue;
      const tokenEnd = prefixedToken(text, i);
      if (tokenEnd > 0) {
        spans.push({ start: i, end: tokenEnd, kind: "token" });
        covered = tokenEnd;
      }
    }
    // The generic rule per piece between '=' signs (base64 padding stays with its piece).
    let pieceStart = start;
    for (let i = start; i <= end; i++) {
      const atEnd = i === end;
      if (!atEnd && !(text.charCodeAt(i) === 61 && i + 1 < end && text.charCodeAt(i + 1) !== 61)) continue;
      const pieceEnd = atEnd ? end : i + 1;
      let core = pieceEnd;
      while (core > pieceStart && text.charCodeAt(core - 1) === 61) core--;
      if (genericSecret(text, pieceStart, core)) spans.push({ start: pieceStart, end: pieceEnd, kind: "token" });
      pieceStart = i + 1;
    }
  }
}

/** Lower-case UUIDs (8-4-4-4-12), anywhere, URLs included. */
function uuids(text: string, spans: Span[]): void {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  for (let m = uuid.exec(text); m !== null; m = uuid.exec(text)) {
    const end = m.index + 36;
    if (isAsciiAlnum(text.charCodeAt(m.index - 1)) || isAsciiAlnum(text.charCodeAt(end))) continue;
    spans.push({ start: m.index, end, kind: "token" });
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const URL_PARAM_NAMES = new Set([
  "token", "access_token", "id_token", "refresh_token", "code", "otp", "key", "apikey", "api_key", "secret",
  "sig", "signature", "auth", "password", "pass", "ticket", "session", "sid", "reset", "magic", "login", "hash",
  "jwt", "oobcode", "confirmation_token", "reset_password_token",
]);

function secretParam(name: string, valueLength: number): boolean {
  const lower = name.toLowerCase();
  if (URL_PARAM_NAMES.has(lower)) return true;
  if (lower.includes("token") || lower.includes("code") || lower.includes("key")) return true;
  return (lower === "t" || lower === "k") && valueLength >= 16;
}

/** A path segment that looks like a secret: 24+ generic, 32+ hexadecimal (UUIDs are found anywhere). */
function secretSegment(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (!(isB64Url(c) || c === 43 || c === 61)) return false;
  }
  return genericSecret(text, start, end, 24);
}

const URL_STOP = new Set([32, 9, 10, 13, 12, 11, 60, 62, 34, 39, 96]);
const URL_TRAILING = new Set([46, 44, 59, 58, 33, 63, 41, 93, 125]);

/** http(s) URLs; their path segments and parameter values that look secret. */
function urls(text: string, spans: Span[]): Range[] {
  const ranges: Range[] = [];
  const scheme = /https?:\/\//gi;
  for (let m = scheme.exec(text); m !== null; m = scheme.exec(text)) {
    const start = m.index;
    let end = start + m[0].length;
    while (end < text.length && !URL_STOP.has(text.charCodeAt(end))) end++;
    while (end > start + m[0].length && URL_TRAILING.has(text.charCodeAt(end - 1))) end--;
    scheme.lastIndex = Math.max(end, start + m[0].length);
    ranges.push({ start, end });
    let i = start + m[0].length;
    // Host: up to '/', '?' or '#'.
    while (i < end && !"/?#".includes(text[i]!)) i++;
    // Path segments.
    while (i < end && text.charCodeAt(i) === 47) {
      const segStart = i + 1;
      let j = segStart;
      while (j < end && !"/?#".includes(text[j]!)) j++;
      if (j - segStart >= 24 && secretSegment(text, segStart, j)) spans.push({ start: segStart, end: j, kind: "token" });
      i = j;
    }
    // Query and fragment parameters.
    while (i < end) {
      const paramStart = i + 1;
      let j = paramStart;
      while (j < end && !"&;#?".includes(text[j]!)) j++;
      const eq = text.indexOf("=", paramStart);
      if (eq >= 0 && eq < j) {
        const name = text.slice(paramStart, eq);
        if (j > eq + 1 && secretParam(name, j - eq - 1)) spans.push({ start: eq + 1, end: j, kind: "token" });
      }
      i = j;
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Digits: cards, CVVs, one-time codes
// ---------------------------------------------------------------------------

type DigitSequence = { groups: Range[]; start: number; end: number; digits: number };

/** Digit runs joined by one space or hyphen into sequences. */
function digitSequences(text: string): DigitSequence[] {
  const out: DigitSequence[] = [];
  const digits = /[0-9]+/g;
  let current: DigitSequence | null = null;
  for (let m = digits.exec(text); m !== null; m = digits.exec(text)) {
    const group = { start: m.index, end: m.index + m[0].length };
    const gapChar = text.charCodeAt(group.start - 1);
    if (current !== null && current.end === group.start - 1 && (gapChar === 32 || gapChar === 45)) {
      current.groups.push(group);
      current.end = group.end;
      current.digits += group.end - group.start;
    } else {
      current = { groups: [group], start: group.start, end: group.end, digits: group.end - group.start };
      out.push(current);
    }
  }
  return out;
}

function luhn(text: string, sequence: DigitSequence): boolean {
  let sum = 0;
  let double = false;
  for (let i = sequence.end - 1; i >= sequence.start; i--) {
    const c = text.charCodeAt(i);
    if (!isDigit(c)) continue;
    let d = c - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD_GROUPINGS = ["16", "4-4-4-4", "4-6-5", "4-4-4-4-3"];

function grouping(sequence: DigitSequence): string {
  return sequence.groups.map((g) => g.end - g.start).join("-");
}

const CURRENCY = new Set(["$", "\u20ac", "\u00a3", "\u00a5", "\u20bd"]);

/** Part of a date, time, decimal or amount: a separator joining it to more digits, or a currency sign. */
function inNumberContext(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before !== undefined && ".,:/".includes(before) && isDigit(text.charCodeAt(start - 2))) return true;
  if (after !== undefined && ".,:/".includes(after) && isDigit(text.charCodeAt(end + 1))) return true;
  if (before === "+" || before === "(" || before === ")") return true;
  if (text[start - 2] === ")" && before === " ") return true;
  if (before !== undefined && CURRENCY.has(before)) return true;
  if (before === " " && CURRENCY.has(text[start - 2] ?? "")) return true;
  if (after !== undefined && CURRENCY.has(after)) return true;
  if (after === " " && CURRENCY.has(text[end + 1] ?? "")) return true;
  if (after === "%") return true;
  return false;
}

function isYear(text: string, start: number, end: number): boolean {
  if (end - start !== 4) return false;
  const year = Number(text.slice(start, end));
  return year >= 1900 && year <= 2099;
}

/** Up to three upper-case letters and a hyphen right before a code ("G-123456"). */
function letterPrefix(text: string, start: number): number {
  if (text.charCodeAt(start - 1) !== 45) return start;
  let i = start - 1;
  while (i > 0 && start - 1 - (i - 1) <= 3 && isUpper(text.charCodeAt(i - 1))) i--;
  if (i === start - 1 || isWordChar(text, i - 1)) return start;
  return i;
}

/** A line holding only this span (and spaces). */
function aloneOnLine(text: string, start: number, end: number): boolean {
  for (let i = start - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 10) break;
    if (!isWhite(c)) return false;
  }
  for (let i = end; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) break;
    if (!isWhite(c)) return false;
  }
  return true;
}

function digitSecrets(
  text: string,
  lower: string,
  lines: Lines,
  urlRanges: Range[],
  contextHasCodeWord: boolean,
  spans: Span[],
): void {
  const sequences = digitSequences(text);
  const cardWords = new Near(findWords(lower, CARD_WORDS), lines);
  const codeWords = new Near(findWords(lower, CODE_WORDS), lines);
  const cvvWords = new Near(findWords(lower, CVV_WORDS), lines);
  const cards: Span[] = [];

  for (const sequence of sequences) {
    if (sequence.digits < 13 || sequence.digits > 19) continue;
    if (isWordChar(text, sequence.start - 1) || isWordChar(text, sequence.end)) continue;
    const shaped = CARD_GROUPINGS.includes(grouping(sequence));
    if (!shaped && !cardWords.has(sequence.start, sequence.end)) continue;
    if (!luhn(text, sequence)) continue;
    cards.push({ start: sequence.start, end: sequence.end, kind: "card" });
  }
  spans.push(...cards);
  const cardStarts = new Set(cards.map((c) => c.start));
  const nearCard = new Near(cards.map((c) => ({ ...c, word: "" })), lines);

  for (const sequence of sequences) {
    if (cardStarts.has(sequence.start)) continue;
    const { start, end } = sequence;
    if (insideAny(urlRanges, start)) continue;
    if (isWordChar(text, start - 1) || isWordChar(text, end)) continue;
    if (inNumberContext(text, start, end)) continue;
    const phone = sequence.digits >= 9 || text[start - 1] === "+";
    if (phone) continue;
    const length = sequence.digits;
    const groups = sequence.groups.length;

    // CVV / CVC: 3-4 digits near a hidden card or a CVV word.
    if (groups === 1 && length >= 3 && length <= 4 && (nearCard.has(start, end) || cvvWords.has(start, end))) {
      spans.push({ start, end, kind: "card" });
      continue;
    }

    const single = groups === 1 && length >= 4 && length <= 8;
    const split =
      groups === 2 &&
      sequence.groups.every((g) => g.end - g.start >= 3 && g.end - g.start <= 4) &&
      length >= 6 &&
      length <= 8;
    if (!single && !split) continue;
    const codeStart = single ? letterPrefix(text, start) : start;
    const line = lines.of(start);
    if (single && isYear(text, start, end) && !codeWords.onLine(line)) continue;
    const near = codeWords.has(codeStart, end);
    const byContext =
      single && contextHasCodeWord && start < CONTEXT_SCAN && aloneOnLine(text, start, end);
    if (near || byContext) spans.push({ start: codeStart, end, kind: "code" });
  }
}

/** 6-8 upper-case letters and digits with a digit and a letter, near a code word. */
function alphanumericCodes(text: string, lower: string, lines: Lines, urlRanges: Range[], spans: Span[]): void {
  const codeWords = new Near(findWords(lower, CODE_WORDS), lines);
  if (!codeWords.any) return;
  const word = /[A-Za-z0-9]+/g;
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (end - start < 6 || end - start > 8) continue;
    if (isWordChar(text, start - 1) || isWordChar(text, end)) continue;
    let digit = false;
    let letter = false;
    let ok = true;
    for (let i = start; i < end; i++) {
      const c = text.charCodeAt(i);
      if (isDigit(c)) digit = true;
      else if (isUpper(c)) letter = true;
      else ok = false;
    }
    if (!ok || !digit || !letter || insideAny(urlRanges, start)) continue;
    if (codeWords.has(start, end)) spans.push({ start, end, kind: "code" });
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const TRAILING_PUNCTUATION = new Set([46, 44, 59, 33, 63, 41]);

/** After a label and `:`, `=`, a dash or `is`: the next non-space run, on the same line or the next. */
function labelledValues(text: string, lower: string, urlRanges: Range[], spans: Span[]): void {
  const kinds = new Map(CREDENTIAL_LABELS.map((l) => [l.word, l.kind]));
  const hits = findWords(
    lower,
    CREDENTIAL_LABELS.map((l) => ({ word: l.word, whole: true })),
  );
  for (const hit of hits) {
    if (insideAny(urlRanges, hit.start)) continue;
    let i = hit.end;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    const c = text[i];
    if (c === ":" || c === "=" || c === "-" || c === "\u2014" || c === "\u2013") {
      i++;
    } else if (lower.startsWith("is", i) && !isWordChar(lower, i + 2)) {
      i += 2;
      if (text[i] === ":") i++;
    } else {
      continue;
    }
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (i < text.length && (text.charCodeAt(i) === 13 || text.charCodeAt(i) === 10)) {
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    }
    const start = i;
    while (i < text.length && !isWhite(text.charCodeAt(i))) i++;
    let end = i;
    while (end > start && TRAILING_PUNCTUATION.has(text.charCodeAt(end - 1))) end--;
    if (end > start) spans.push({ start, end, kind: kinds.get(hit.word) ?? "credential" });
  }
}

/** Four groups of four lower-case letters after a credential or code word, or under such a label. */
function appPasswords(text: string, lower: string, lines: Lines, spans: Span[]): void {
  const shape = /[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}/g;
  let labels: Near | null = null;
  for (let m = shape.exec(text); m !== null; m = shape.exec(text)) {
    const start = m.index;
    const end = start + 19;
    if (isWordChar(text, start - 1) || isWordChar(text, end)) {
      shape.lastIndex = start + 1;
      continue;
    }
    labels ??= new Near(
      findWords(lower, [...CODE_WORDS, ...CREDENTIAL_LABELS.map((l) => ({ word: l.word, whole: true }))]),
      lines,
    );
    if (labels.has(start, end)) spans.push({ start, end, kind: "credential" });
  }
}

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

function emptyCounts(): Record<SecretKind, number> {
  return { code: 0, credential: 0, token: 0, card: 0 };
}

/** Overlapping or touching spans become one, of the strongest kind. */
function merge(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (PRIORITY[span.kind] > PRIORITY[last.kind]) last.kind = span.kind;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** All secret spans of a text, merged. */
function detect(text: string, context: string): Span[] {
  const lower = lowerSameLength(text);
  const lines = new Lines(text);
  const spans: Span[] = [];
  pemBlocks(text, spans);
  jwts(text, spans);
  googleAccessTokens(text, spans);
  const urlRanges = urls(text, spans);
  tokenRuns(text, urlRanges, emailWords(text), spans);
  uuids(text, spans);
  labelledValues(text, lower, urlRanges, spans);
  appPasswords(text, lower, lines, spans);
  const contextHasCodeWord = context !== "" && findWords(lowerSameLength(context), CODE_WORDS).length > 0;
  digitSecrets(text, lower, lines, urlRanges, contextHasCodeWord, spans);
  alphanumericCodes(text, lower, lines, urlRanges, spans);
  return merge(spans);
}

/**
 * Hides one-time codes, passwords, tokens and card numbers. With `restore`,
 * placeholders are numbered per kind and tagged (`[hidden token 1 k3f9]`), a
 * repeated value keeps its placeholder, and the map back is returned.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): Redaction {
  const counts = emptyCounts();
  const spans = text === "" ? [] : detect(text, options.context ?? "");
  if (spans.length === 0) return { text, counts, restore: options.restore === true ? new Map() : null };
  const restore = options.restore === true ? new Map<string, string>() : null;
  const byValue = new Map<string, string>();
  const numbers = emptyCounts();
  const tag = options.tag !== undefined && options.tag !== "" ? ` ${options.tag}` : "";
  let out = "";
  let at = 0;
  for (const span of spans) {
    counts[span.kind] += 1;
    out += text.slice(at, span.start);
    const original = text.slice(span.start, span.end);
    if (restore === null) {
      out += PLACEHOLDER[span.kind];
    } else {
      const key = `${span.kind}\u0000${original}`;
      let placeholder = byValue.get(key);
      if (placeholder === undefined) {
        numbers[span.kind] += 1;
        placeholder = `[hidden ${KIND_NAME[span.kind]} ${numbers[span.kind]}${tag}]`;
        byValue.set(key, placeholder);
        restore.set(placeholder, original);
      }
      out += placeholder;
    }
    at = span.end;
  }
  out += text.slice(at);
  return { text: out, counts, restore };
}

const PLACEHOLDER_LIKE = /\[hidden (?:one-time code|password|token|card number)(?: [0-9]{1,6})?(?: [a-z0-9]{4})?\]/g;

/**
 * Puts the originals back for this job's tagged placeholders only. `unknown`
 * counts placeholder-like strings that are not in the map (an untagged one,
 * a literal the owner typed, one the model invented): they stay as written.
 * `missing` counts map entries that no longer appear.
 */
export function restoreSecrets(
  text: string,
  restore: ReadonlyMap<string, string>,
  tag: string,
): { text: string; unknown: number; missing: number } {
  let unknown = 0;
  const seen = new Set<string>();
  const suffix = ` ${tag}]`;
  const out = text.replace(PLACEHOLDER_LIKE, (match) => {
    const original = tag !== "" && match.endsWith(suffix) ? restore.get(match) : undefined;
    if (original === undefined) {
      unknown += 1;
      return match;
    }
    seen.add(match);
    return original;
  });
  let missing = 0;
  for (const placeholder of restore.keys()) if (!seen.has(placeholder)) missing += 1;
  return { text: out, unknown, missing };
}

/** "Hidden by Makosh Mail: 2 one-time codes, 1 token." or null when nothing was hidden. */
export function hiddenNote(counts: Record<SecretKind, number>): string | null {
  const parts = SECRET_KINDS.filter((kind) => counts[kind] > 0).map(
    (kind) => `${counts[kind]} ${counts[kind] === 1 ? KIND_NAME[kind] : KIND_PLURAL[kind]}`,
  );
  return parts.length === 0 ? null : `Hidden by Makosh Mail: ${parts.join(", ")}.`;
}

/** Total hidden values. */
export function hiddenTotal(counts: Record<SecretKind, number>): number {
  return counts.code + counts.credential + counts.token + counts.card;
}

const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TAG_ATTEMPTS = 1_000;

/** A 4-character tag for one job's placeholders, re-drawn until absent from every part (resolution 8). */
export function newRestoreTag(
  random: (size: number) => Uint8Array = (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  parts: string[] = [],
): string {
  for (let attempt = 0; attempt < TAG_ATTEMPTS; attempt++) {
    const tag = [...random(4)].map((b) => TAG_ALPHABET[b % TAG_ALPHABET.length]).join("");
    if (!parts.some((part) => part.includes(tag))) return tag;
  }
  throw new Error("Could not draw a restore tag");
}

/**
 * A stored snippet (cut at sync, so it can end inside a secret): redaction
 * with the subject as context, then a trailing run of 4+ digits or 16+ token
 * characters touching the end becomes a placeholder (digits: a code).
 */
export function maskSnippetTail(snippet: string, subject: string): Redaction {
  const redacted = redactSecrets(snippet, { context: subject });
  const text = redacted.text;
  let i = text.length;
  while (i > 0 && isDigit(text.charCodeAt(i - 1))) i--;
  if (text.length - i >= 4) {
    redacted.counts.code += 1;
    return { ...redacted, text: text.slice(0, i) + PLACEHOLDER.code };
  }
  i = text.length;
  while (i > 0 && isTokenChar(text.charCodeAt(i - 1))) i--;
  if (text.length - i >= 16) {
    redacted.counts.token += 1;
    return { ...redacted, text: text.slice(0, i) + PLACEHOLDER.token };
  }
  return redacted;
}

export const AGENT_SEARCH_REFUSAL = "Agents cannot search for codes, numbers or tokens; search by sender, subject or date.";

/** Agent search text that would match a secret: redactable text, or a run of 6+ digits. */
export function agentSearchRefusal(freeText: string): string | null {
  if (freeText === "") return null;
  if (/[0-9]{6}/.test(freeText)) return AGENT_SEARCH_REFUSAL;
  return redactSecrets(freeText).text === freeText ? null : AGENT_SEARCH_REFUSAL;
}
