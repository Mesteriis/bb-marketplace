// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/search/searchParser.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// Search query parsing. Operators (slice 3h): from, to, cc, subject, has,
// filename, in, account, is, larger, smaller, after, before, newer_than,
// older_than, list, category and label, each negated with a leading `-`
// (values may be quoted, `subject:"weekly report"`). Everything else, an
// unknown operator, an empty or bad value, stays in the free text; unknown
// operators and bad values get a note. Unlike Velo, dates stay ISO date
// strings and tokens are read by a forward scan instead of a regular
// expression.
import type { ParsedQuery, SearchCondition, SearchField, SearchNote } from "./model.ts";

type Token = { raw: string; negated: boolean; name: string | null; value: string };

/** The sign and the name are read apart (spec resolution 12). */
const OPERATOR = /^(-?)([a-z][a-z_]*):/i;
const ISO_DATE = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
const SIZE = /^(\d{1,9}(?:\.\d+)?)([KM]?)$/i;
const RELATIVE = /^(\d{1,4})([dwmy])$/i;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Each operator value is cut to this many characters. */
export const SEARCH_VALUE_MAX = 200;
/** Sizes are capped at 2 GB. */
export const SEARCH_SIZE_MAX = 2 * 1024 ** 3;

const PLAIN_FIELDS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "filename",
  "account",
  "list",
  "category",
  "label",
]);

/** `from:` values that name a set of senders (Inbox tabs): important senders, the owner's own domains, people written to. */
export const SENDER_SETS: ReadonlySet<string> = new Set(["vip", "team", "known"]);

/** `in:` role names; `spam` is read as `junk`. */
const IN_ROLES: Readonly<Record<string, string>> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  spam: "junk",
  junk: "junk",
  trash: "trash",
  archive: "archive",
  all: "all",
  snoozed: "snoozed",
};

/**
 * Parses a query. `now` turns `newer_than` / `older_than` into dates;
 * without it they stay free text, as before slice 3h.
 */
export function parseQuery(raw: string, now?: Date): ParsedQuery {
  const result: ParsedQuery = { text: "", conditions: [], notes: [] };
  const text: string[] = [];
  for (const token of tokenize(raw)) {
    const read = readOperator(token, now);
    if ("condition" in read) {
      result.conditions.push(read.condition);
      continue;
    }
    if (read.note !== null) result.notes.push({ kind: read.note, term: clean(token.raw) });
    text.push(token.raw);
  }
  result.text = text.join(" ");
  deriveLegacy(result);
  return result;
}

/** The pre-3h fields from the positive conditions (the last one wins). */
function deriveLegacy(result: ParsedQuery): void {
  for (const condition of result.conditions) {
    if (condition.negated) continue;
    switch (condition.field) {
      case "from":
        result.from = condition.value;
        break;
      case "subject":
        result.subject = condition.value;
        break;
      case "after":
        result.after = condition.value;
        break;
      case "before":
        result.before = condition.value;
        break;
      default:
        break;
    }
  }
  // is:read is read as -is:unread, so the last is:unread decides.
  const unread = result.conditions.filter((c) => c.field === "is" && c.value === "unread");
  if (unread.length > 0) result.unread = !unread[unread.length - 1]!.negated;
}

/** Splits on whitespace; an operator's quoted value may contain spaces. */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isSpace(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    const operator = OPERATOR.exec(raw.slice(i, i + 40));
    if (operator && raw[i + operator[0].length] === '"') {
      const open = i + operator[0].length;
      const close = raw.indexOf('"', open + 1);
      const end = close === -1 ? raw.length : close;
      i = close === -1 ? raw.length : close + 1;
      tokens.push({
        raw: raw.slice(start, i),
        negated: operator[1] === "-",
        name: operator[2]!.toLowerCase(),
        value: raw.slice(open + 1, end).trim(),
      });
      continue;
    }
    while (i < raw.length && !isSpace(raw[i]!)) i++;
    const word = raw.slice(start, i);
    tokens.push(
      operator
        ? {
            raw: word,
            negated: operator[1] === "-",
            name: operator[2]!.toLowerCase(),
            value: word.slice(operator[0].length),
          }
        : { raw: word, negated: false, name: null, value: word },
    );
  }
  return tokens;
}

type Read = { condition: SearchCondition } | { note: SearchNote["kind"] | null };

function readOperator(token: Token, now: Date | undefined): Read {
  if (token.name === null) return { note: null };
  // A link (`https://...`) is text, not an unknown operator.
  if (token.value.startsWith("//")) return { note: null };
  const value = clean(token.value);
  if (value === "") return { note: null };
  const make = (field: SearchField, v: string, negated = token.negated): Read => ({
    condition: { field, value: v, negated },
  });
  const name = token.name;
  // A sender set is the whole word; an address that only contains it stays a fragment.
  if (name === "from" && SENDER_SETS.has(value.toLowerCase())) return make("sender", value.toLowerCase());
  if (PLAIN_FIELDS.has(name)) return make(name as SearchField, value);
  switch (name) {
    case "has": {
      const lower = value.toLowerCase();
      if (lower === "invite" || lower === "invitation") return make("has", "invite");
      return lower === "attachment" || lower === "attachments" ? make("has", "attachment") : { note: "bad_value" };
    }
    case "is":
      switch (value.toLowerCase()) {
        case "unread":
          return make("is", "unread");
        case "read":
          return make("is", "unread", !token.negated);
        case "flagged":
        case "starred":
          return make("is", "flagged");
        case "unflagged":
          return make("is", "flagged", !token.negated);
        case "dev":
          return make("is", "dev");
        case "automated":
          return make("is", "automated");
        case "newsletter":
        case "newsletters":
          return make("is", "newsletter");
        default:
          return { note: "bad_value" };
      }
    case "in":
      return make("in", IN_ROLES[value.toLowerCase()] ?? value);
    case "larger":
    case "smaller": {
      const bytes = parseSize(value);
      return bytes === null ? { note: "bad_value" } : make(name, String(bytes));
    }
    case "after":
    case "before": {
      const date = isoDate(value);
      return date === null ? { note: "bad_value" } : make(name, date);
    }
    case "newer_than":
    case "older_than": {
      if (now === undefined) return { note: null };
      const date = relativeDate(value, now);
      if (date === null) return { note: "bad_value" };
      return make(name === "newer_than" ? "after" : "before", date);
    }
    default:
      return { note: "unknown_operator" };
  }
}

function clean(value: string): string {
  return value.replace(CONTROLS, "").slice(0, SEARCH_VALUE_MAX).trim();
}

function parseSize(value: string): number | null {
  const match = SIZE.exec(value);
  if (!match) return null;
  const unit = match[2]!.toUpperCase();
  const factor = unit === "M" ? 1024 * 1024 : unit === "K" ? 1024 : 1;
  const bytes = Math.round(Number(match[1]) * factor);
  return Number.isFinite(bytes) ? Math.min(bytes, SEARCH_SIZE_MAX) : null;
}

function isoDate(value: string): string | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * `3d`, `2w`, `3m`, `1y` back from `now`, as an ISO date (UTC). Months and
 * years keep the day when the target month has it, else take its last day
 * (31 March less a month is 28 or 29 February). Null before 1970.
 */
function relativeDate(value: string, now: Date): string | null {
  const match = RELATIVE.exec(value);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  let date: Date;
  if (unit === "d" || unit === "w") {
    date = new Date(now.getTime() - count * (unit === "w" ? 7 : 1) * 86_400_000);
  } else {
    const months = now.getUTCFullYear() * 12 + now.getUTCMonth() - (unit === "m" ? count : count * 12);
    const year = Math.floor(months / 12);
    const month = months - year * 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    date = new Date(now.getTime());
    date.setUTCFullYear(year, month, Math.min(now.getUTCDate(), lastDay));
  }
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1970) return null;
  return date.toISOString().slice(0, 10);
}

const SPACE = /^\s$/u;

/** Any Unicode whitespace, including NBSP and the ideographic space. */
function isSpace(char: string): boolean {
  return SPACE.test(char);
}

/**
 * How a `from:` value is matched: a whole address matches that address, a
 * domain matches its addresses and those of its subdomains (or the words in
 * a display name), anything else is a fragment of the address or the name.
 */
export function fromShape(value: string): "address" | "domain" | "fragment" {
  const text = value.trim();
  if (/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text)) return "address";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text)) return "domain";
  return "fragment";
}
