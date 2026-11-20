// HTML character references in attacker-controlled mail. One replace with a
// bounded pattern keeps decoding linear: every alternative has a fixed maximum
// length, so a long run of "&" or "&#" cannot make it backtrack. Every
// non-ASCII character here is written as a \u escape, so none is invisible.

/** Named entities common in mail, keyed in lower case (lookups lower-case the name). */
const NAMED = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
  ["zwnj", "\u200c"],
  ["zwj", "\u200d"],
  ["zerowidthspace", "\u200b"],
  ["nobreak", "\u2060"],
  ["lrm", "\u200e"],
  ["rlm", "\u200f"],
  ["shy", "\u00ad"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["thinsp", "\u2009"],
  ["hairsp", "\u200a"],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["laquo", "\u00ab"],
  ["raquo", "\u00bb"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["bull", "\u2022"],
  ["middot", "\u00b7"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["euro", "\u20ac"],
  ["rarr", "\u2192"],
  ["larr", "\u2190"],
  ["times", "\u00d7"],
  ["deg", "\u00b0"],
]);

/**
 * Numeric references 0x80-0x9F mean windows-1252 characters, as browsers read
 * them (HTML numeric character reference end state). 0 marks the five that
 * stay as the C1 control.
 */
const WINDOWS_1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

const REFERENCE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi;
const REPLACEMENT = "\ufffd";

function fromCode(code: number): string {
  if (code >= 0x80 && code <= 0x9f) {
    const mapped = WINDOWS_1252[code - 0x80]!;
    return String.fromCodePoint(mapped === 0 ? code : mapped);
  }
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
    return NAMED.get(body.toLowerCase()) ?? whole;
  });
}

/**
 * Zero-width and formatting characters: U+200B-U+200F (zero-width space,
 * joiners, direction marks), U+202A-U+202E and U+2066-U+2069 (bidi controls),
 * U+2060-U+2064 (word joiner and invisible operators), U+FEFF, U+00AD (soft
 * hyphen), U+034F (combining grapheme joiner), U+061C (Arabic letter mark).
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad\u034f\u061c]/g;
/** Control characters other than tab, line feed and carriage return. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Everything a reader cannot see: format characters, tag characters,
 * variation selectors, line and paragraph separators and the fillers that
 * render as nothing. The same set the page strips before it shows model or
 * agent text (agent-send-card.tsx); text a model wrote is cleaned with it
 * before links are judged, so a hidden character cannot split a link in
 * two and let it through.
 */
const HIDDEN = /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u2028\u2029\u3164\u115F\u1160\uFFA0\u034F\u17B4\u17B5\u180B-\u180F]/gu;

/** Removes every character a reader cannot see (see HIDDEN). */
export function removeHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

/** Removes zero-width, bidi and other invisible formatting characters. */
export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** Removes control characters other than tab, line feed and carriage return (C0, DEL and C1). */
export function removeControls(text: string): string {
  return text.replace(CONTROLS, "");
}

/** One line for a list preview: invisible and control characters gone, whitespace (nbsp included) collapsed. */
export function collapseForSnippet(text: string): string {
  return removeInvisible(text).replace(CONTROLS, "").replace(/\s+/g, " ").trim();
}

/** The first maxLength UTF-16 units, without leaving half of a surrogate pair at the end. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const last = text.charCodeAt(maxLength - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength);
}
