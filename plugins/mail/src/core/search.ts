// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/search/searchParser.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// Search query parsing. Operators: from:x, subject:x (values may be quoted,
// `subject:"weekly report"`), is:unread, after:YYYY-MM-DD, before:YYYY-MM-DD.
// Everything else, including unknown operators, empty values and invalid
// dates, stays in the free text. Unlike Velo, dates stay ISO date strings and
// tokens are read by a forward scan instead of a regular expression.
import type { ParsedQuery } from "./model.ts";

type Token = { raw: string; name: string | null; value: string };

const OPERATOR = /^([a-z]+):/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseQuery(raw: string): ParsedQuery {
  const result: ParsedQuery = { text: "" };
  const text: string[] = [];
  for (const token of tokenize(raw)) {
    if (!applyOperator(result, token)) text.push(token.raw);
  }
  result.text = text.join(" ");
  return result;
}

/** Splits on whitespace; an operator's quoted value may contain spaces. */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isSpace(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    const operator = OPERATOR.exec(raw.slice(i, i + 32));
    if (operator && raw[i + operator[0].length] === '"') {
      const open = i + operator[0].length;
      const close = raw.indexOf('"', open + 1);
      const end = close === -1 ? raw.length : close;
      i = close === -1 ? raw.length : close + 1;
      tokens.push({
        raw: raw.slice(start, i),
        name: operator[1]!.toLowerCase(),
        value: raw.slice(open + 1, end).trim(),
      });
      continue;
    }
    while (i < raw.length && !isSpace(raw[i]!)) i++;
    const word = raw.slice(start, i);
    tokens.push(
      operator
        ? { raw: word, name: operator[1]!.toLowerCase(), value: word.slice(operator[0].length) }
        : { raw: word, name: null, value: word },
    );
  }
  return tokens;
}

function applyOperator(result: ParsedQuery, token: Token): boolean {
  if (token.name === null || token.value === "") return false;
  switch (token.name) {
    case "from":
      result.from = token.value;
      return true;
    case "subject":
      result.subject = token.value;
      return true;
    case "is":
      if (token.value.toLowerCase() !== "unread") return false;
      result.unread = true;
      return true;
    case "after":
    case "before":
      if (!isValidDate(token.value)) return false;
      result[token.name] = token.value;
      return true;
    default:
      return false;
  }
}

function isValidDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
