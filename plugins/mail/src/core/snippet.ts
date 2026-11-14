// The one-line preview stored with each message. HTML-only mail is turned
// into text here; the input is untrusted, so the work is a capped forward scan.
import { collapseForSnippet, decodeHtmlEntities, truncateText } from "./html-entities.ts";

export const SNIPPET_LENGTH = 200;
/** Only the start of an HTML body feeds the snippet; this bounds the work. */
const SNIPPET_HTML_SCAN = 20_000;
const SKIPPED_ELEMENTS = new Set(["script", "style", "head"]);

/**
 * Strips tags in one forward pass (untrusted input: no backtracking regex).
 * script/style/head contents are dropped; an unclosed tag or element drops the
 * rest of the input.
 */
function stripTags(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open < 0) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, open) + " ";
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    const name = /^[a-z]+/.exec(lower.slice(open + 1, Math.min(close, open + 9)))?.[0] ?? "";
    pos = close + 1;
    if (SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      if (end < 0) break;
      const endClose = html.indexOf(">", end);
      if (endClose < 0) break;
      pos = endClose + 1;
    }
  }
  return out;
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(stripTags(html.slice(0, SNIPPET_HTML_SCAN)));
}

/** The preview of a body: the text part when there is one, else the HTML as text. */
export function snippetOf(bodyText: string | null, bodyHtml: string | null): string {
  const source = bodyText !== null ? bodyText : bodyHtml !== null ? htmlToText(bodyHtml) : "";
  return truncateText(collapseForSnippet(source), SNIPPET_LENGTH);
}

/** A reference the old decoder left behind, as in "&zwnj;" or "&#8204;". */
const ENTITY_LIKE = /&[#a-z0-9]{1,32};/i;

/**
 * Whether a stored snippet predates full decoding: it still holds an
 * entity-looking sequence, an invisible or control character, or uncollapsed
 * whitespace.
 */
export function needsSnippetRepair(snippet: string): boolean {
  return ENTITY_LIKE.test(snippet) || collapseForSnippet(snippet) !== snippet.trim();
}

/** A stored snippet cleaned on its own, for a row whose body is no longer kept. */
export function cleanSnippet(snippet: string): string {
  return truncateText(collapseForSnippet(decodeHtmlEntities(snippet)), SNIPPET_LENGTH);
}
