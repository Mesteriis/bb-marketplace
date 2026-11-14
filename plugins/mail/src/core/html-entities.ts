// HTML character references in attacker-controlled mail. One replace with a
// bounded pattern keeps decoding linear: every alternative has a fixed maximum
// length, so a long run of "&" or "&#" cannot make it backtrack.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "‌",
  zwj: "‍",
  shy: "­",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  rarr: "→",
  larr: "←",
  times: "×",
  deg: "°",
};

const REFERENCE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi;
const REPLACEMENT = "�";

function fromCode(code: number): string {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : REPLACEMENT;
}

/**
 * Decodes numeric references and the named entities common in mail, once
 * (so "&amp;zwnj;" becomes "&zwnj;"). Unknown names are kept as written;
 * invalid code points become U+FFFD.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return fromCode(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

const INVISIBLE = /[​-‍⁠﻿­͏]/g;

/** Removes zero-width characters, the soft hyphen and the combining grapheme joiner. */
export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** One line for a list preview: invisible characters gone, whitespace (nbsp included) collapsed. */
export function collapseForSnippet(text: string): string {
  return removeInvisible(text).replace(/\s+/g, " ").trim();
}
