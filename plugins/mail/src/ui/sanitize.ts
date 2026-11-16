// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/utils/sanitize.ts and src/components/email/EmailRenderer.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// Turns untrusted email HTML into a document for a sandboxed iframe: no
// scripts, forms, handlers or remote loads (images, CSS imports and CSS
// url()s are tracking pixels too), and a CSP that blocks anything missed.
// When the owner allows remote images, `https:` `<img src>` is the one
// remote load kept; everything else stays blocked.
import DOMPurify from "dompurify";
import { cleanLink } from "../core/link-clean.ts";
import { isAttribution } from "../core/quotes.ts";
import { isTrackerImage } from "./trackers.ts";

/** The policy inside every rendered message: only data: images, only inline styles. */
export const EMAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
/** The policy when the owner allowed remote images: https: images too, nothing else. */
export const EMAIL_CSP_REMOTE_IMAGES =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'";

export interface SanitizeOptions {
  /** Keep `https:` `<img src>` (the owner allowed remote images for this message). */
  remoteImages: boolean;
  /**
   * Slice 3h: BB is dark and the owner wants mail adapted. The document
   * takes a dark color scheme and, unless the mail declares dark support
   * (`darkSupported`, read from the raw HTML), an inverting filter that
   * puts media back. The CSP is the same.
   */
  dark?: boolean;
  /** Slice 3h: declaresDarkSupport() of the raw HTML. */
  darkSupported?: boolean;
  /**
   * Slice 3i: rewrite each kept link through core cleanLink (the cleanLinks
   * setting). A rewritten anchor carries Mail's own `data-mk-cleaned="n"`
   * (parameters removed) and `data-mk-unwrapped` marks. Absent or false:
   * links stay as the mail wrote them (reply and forward quoting).
   */
  cleanLinks?: boolean;
}

export interface SanitizedEmail {
  /** A complete document for `<iframe sandbox="allow-same-origin" srcDoc>`. */
  html: string;
  /**
   * Default mode only: an `<img>` whose src allowed mode would keep (https:)
   * was removed, so Show images would reveal something. Trackers never
   * count (slice 3i): a message whose only remote images are trackers has
   * nothing to show. Always false in allowed mode; srcset, CSS url(),
   * backgrounds and http: never count.
   */
  blockedRemoteImages: boolean;
  /** Slice 3i: remote tracking pixels removed, in both modes (ui/trackers.ts). */
  trackers: number;
  /** Slice 3h: quoted blocks marked with `data-mk-quote` (hidden until the parent shows them). */
  quotes: number;
}

const FORBID_TAGS = [
  "script",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "base",
  "meta",
  "link",
  "iframe",
  "object",
  "embed",
];

/** Attributes that only ever load something; a data: src is the one exception kept. */
const LOADING_ATTRIBUTES = [
  "srcset",
  "background",
  "poster",
  "lowsrc",
  "dynsrc",
  "action",
  "formaction",
  "ping",
  "longdesc",
  "data",
];

const LINK_ATTRIBUTES = ["href", "xlink:href"];

/** Removed only when remote images are allowed: they would load more than an <img src>. */
const REMOTE_MODE_FORBID_TAGS = ["picture", "source", "video", "audio", "track"];

/** Elements whose href is a link the owner can click; anywhere else (svg <image>, <use>) it loads. */
const LINK_ELEMENTS = new Set(["a", "area"]);

// Email is designed for a light page. System colors keep the frame free of
// hard-coded values while following the light scheme the email expects.
const BASE_STYLE = [
  ":root { color-scheme: light; }",
  "html, body { margin: 0; }",
  "body { padding: 16px; background: Canvas; color: CanvasText;",
  " font: 14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif;",
  " overflow-wrap: break-word; }",
  "img { max-width: 100%; height: auto; }",
  "table { max-width: 100%; }",
  "pre { white-space: pre-wrap; }",
  "blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid GrayText; }",
  // Slice 3h: Mail's own quote marks; the parent sets data-mk-quotes="shown" to show them.
  'html:not([data-mk-quotes="shown"]) [data-mk-quote] { display: none !important; }',
].join("");

/** Slice 3h: the dark scheme for a mail that declares dark support itself. */
const DARK_SCHEME_STYLE = ":root { color-scheme: dark; }";
/** Slice 3h: the adapted colors for a light-only mail; media is inverted back. */
const DARK_ADAPT_STYLE = [
  "html { filter: invert(0.9) hue-rotate(180deg); background: #fff; }",
  'img, video, picture, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }',
].join("");

/** Mail's own attribute prefix; incoming attributes with it are dropped (spec resolution 14). */
const OWN_DATA_PREFIX = "data-mk-";

/** Characters of raw HTML read for the dark-support check. */
export const DARK_SCAN_CHARS = 200_000;
/** Characters of one `<meta>` tag read by the dark-support check; longer tags are skipped. */
const META_TAG_CHARS = 1_000;

/**
 * Whether a mail says it has its own dark colors (spec resolution 14): a
 * `color-scheme` or `supported-color-schemes` meta naming dark, or a
 * `prefers-color-scheme: dark` query inside a style. Reads the raw HTML (the
 * sanitizer drops meta) and never renders it.
 */
export function declaresDarkSupport(rawHtml: string): boolean {
  const text = rawHtml.slice(0, DARK_SCAN_CHARS);
  const lower = text.toLowerCase();
  // indexOf and a bounded window per tag: a regex over unclosed `<meta` tags is quadratic.
  for (let at = lower.indexOf("<meta"); at !== -1; at = lower.indexOf("<meta", at + 5)) {
    if (/[\w-]/.test(lower[at + 5] ?? "")) continue;
    const tag = text.slice(at, at + META_TAG_CHARS);
    const end = tag.indexOf(">");
    if (end === -1) continue;
    const meta = tag.slice(0, end + 1);
    if (/name\s*=\s*["']?(?:color-scheme|supported-color-schemes)\b/i.test(meta) && /content\s*=\s*["'][^"']*\bdark\b/i.test(meta)) {
      return true;
    }
  }
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<style", from);
    if (open === -1) return false;
    const close = lower.indexOf("</style", open);
    const css = lower.slice(open, close === -1 ? lower.length : close);
    if (/prefers-color-scheme\s*:\s*dark/.test(css)) return true;
    if (close === -1) return false;
    from = close + 7;
  }
}

/** Gmail, Yahoo, Outlook and Apple quote containers. */
const QUOTE_SELECTORS = 'blockquote[type="cite"], div.gmail_quote, .yahoo_quoted';
/** Outlook's reply header and the "append on send" marker: they and everything after them are quoted. */
const QUOTE_FROM_HERE = ["divRplyFwdMsg", "appendonsend"];

function textOf(node: Node): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function hasText(node: Node): boolean {
  return /\S/.test(node.textContent ?? "");
}

/** Quote elements (blockquotes and quote containers) above which nothing is marked and everything shows. */
export const QUOTE_ELEMENTS_MAX = 300;

/**
 * Marks quoted blocks of a sanitized body with `data-mk-quote` (slice 3h,
 * #54). Nothing is marked when everything would be (a forwarded message)
 * or when the body has more than QUOTE_ELEMENTS_MAX quote elements.
 * Returns how many blocks were marked. Linear in the body (times its
 * depth): only the outermost candidates are kept, by a walk up from each.
 */
export function markQuotes(body: HTMLElement): number {
  const quoteElements = body.querySelectorAll(`${QUOTE_SELECTORS}, blockquote`).length;
  if (quoteElements > QUOTE_ELEMENTS_MAX) return 0;
  const candidates = new Set<Element>();
  for (const element of Array.from(body.querySelectorAll(QUOTE_SELECTORS))) candidates.add(element);
  for (const id of QUOTE_FROM_HERE) {
    const start = body.querySelector(`[id="${id}"]`);
    if (start === null) continue;
    for (let at: Element | null = start; at !== null; at = at.nextElementSibling) candidates.add(at);
  }
  // A blockquote after an attribution line: the nearest earlier sibling with
  // text, tracked in one pass over each parent's children.
  const parents = new Set<Element>();
  for (const quote of Array.from(body.querySelectorAll("blockquote"))) if (quote.parentElement !== null) parents.add(quote.parentElement);
  for (const parent of parents) {
    // Siblings are read for text only when a blockquote follows them, each at most once.
    let before: Element | null = null;
    let unread: Element[] = [];
    for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
      if (child.localName === "blockquote") {
        for (let i = unread.length - 1; i >= 0; i--) {
          if (hasText(unread[i]!)) {
            before = unread[i]!;
            break;
          }
        }
        unread = [];
        if (before !== null && isAttribution(textOf(before))) {
          candidates.add(child);
          candidates.add(before);
        }
      }
      unread.push(child);
    }
  }
  const marked = new Set<Element>();
  for (const element of candidates) {
    let inside = false;
    for (let up = element.parentElement; up !== null && up !== body; up = up.parentElement) {
      if (candidates.has(up)) {
        inside = true;
        break;
      }
    }
    if (!inside) marked.add(element);
  }
  if (marked.size === 0) return 0;
  // Nothing is hidden when the whole body would be.
  const clone = body.cloneNode(true) as HTMLElement;
  const all = Array.from(body.querySelectorAll("*"));
  const cloned = Array.from(clone.querySelectorAll("*"));
  all.forEach((element, index) => {
    if (marked.has(element)) cloned[index]?.remove();
  });
  if (textOf(clone) === "" && clone.querySelector("img") === null) return 0;
  for (const element of marked) element.setAttribute("data-mk-quote", "");
  return marked.size;
}

/** True for absolute http, https and mailto URLs, the only links a message may open. */
export function isAllowedLinkUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
}

function isDataUrl(value: string): boolean {
  return /^\s*data:/i.test(value);
}

/** A data: URL of a raster image; SVG is left out (it is a document, not a picture). */
function isRasterDataUrl(value: string): boolean {
  return /^\s*data:image\/(?:png|gif|jpe?g|pjpeg|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i.test(
    value,
  );
}

/**
 * True for an absolute `https://` URL, the only remote image source ever kept.
 * The prefix is required literally, so forms a URL parser would accept
 * (`https:host/x`) are refused the same way in both modes.
 */
function isHttpsUrl(value: string): boolean {
  if (!/^\s*https:\/\//i.test(value)) return false;
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Decodes the CSS escapes that can spell a letter, so `\75 rl(` or `@\69mport`
 * cannot hide from the checks below. Other escapes stay as written.
 */
function decodeLetterEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (escape, hex: string) => {
      const char = String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd);
      return /^[A-Za-z@(]$/.test(char) ? char : escape;
    })
    .replace(/\\([g-zG-Z])/g, "$1");
}

// The CSS below is scanned forward once, never by backtracking regexes over the
// whole text: crafted unterminated input (300 KB of `url("`) would otherwise
// cost the renderer seconds.

/** CSS kept per style element or attribute; the rest is dropped. */
const MAX_CSS_CHARS = 100_000;

/** Removes comments; an unterminated comment runs to the end, as in a browser. */
function stripComments(css: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = css.indexOf("/*", from);
    if (open === -1) return out + css.slice(from);
    out += css.slice(from, open);
    const close = css.indexOf("*/", open + 2);
    if (close === -1) return out;
    from = close + 2;
  }
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/**
 * Reads a url() call whose "(" ends at `start`: its end (after ")") and its
 * argument without quotes; null when it is never closed.
 */
function readUrlCall(text: string, start: number): { end: number; url: string } | null {
  const open = skipSpace(text, start);
  const quote = text[open];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, open + 1);
    if (close !== -1) {
      const after = skipSpace(text, close + 1);
      if (text[after] === ")") return { end: after + 1, url: text.slice(open + 1, close) };
    }
  }
  const paren = text.indexOf(")", start);
  if (paren === -1) return null;
  return { end: paren + 1, url: text.slice(start, paren).trim().replace(/^["']|["']$/g, "") };
}

/**
 * Reads an image-set() whose "(" ends at `start`: its end and every URL it
 * names (url() arguments and bare strings); null when it is never closed.
 */
function readImageSet(text: string, start: number): { end: number; urls: string[] } | null {
  const urls: string[] = [];
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return null;
      urls.push(text.slice(i + 1, close));
      i = close + 1;
    } else if (text.slice(i, i + 4).toLowerCase() === "url(") {
      const call = readUrlCall(text, i + 4);
      if (call === null) return null;
      urls.push(call.url);
      i = call.end;
    } else {
      if (ch === "(") depth++;
      if (ch === ")" && --depth === 0) return { end: i + 1, urls };
      i++;
    }
  }
  return null;
}

/**
 * Removes @import and every url()/image-set() that is not a data: URL. A
 * construct left unclosed is replaced together with the rest of the text.
 */
//
// In allowed mode this is the only barrier against remote images in CSS: the
// frame's CSP then permits https: images, so a url() left here would load.
// The escape and unterminated cases in sanitize.test.ts are permanent tests.
export function cleanEmailCss(css: string): string {
  const text = decodeLetterEscapes(stripComments(css.slice(0, MAX_CSS_CHARS)));
  const keyword = /@import|(?:-webkit-)?image-set\(|url\(/gi;
  let out = "";
  let from = 0;
  for (let match = keyword.exec(text); match !== null; match = keyword.exec(text)) {
    const word = match[0].toLowerCase();
    let end: number;
    let replacement: string;
    if (word === "@import") {
      const semicolon = text.indexOf(";", keyword.lastIndex);
      end = semicolon === -1 ? text.length : semicolon + 1;
      replacement = "";
    } else if (word === "url(") {
      const call = readUrlCall(text, keyword.lastIndex);
      end = call?.end ?? text.length;
      const kept = call !== null && isDataUrl(call.url);
      replacement = kept ? text.slice(match.index, end) : "none";
    } else {
      const set = readImageSet(text, keyword.lastIndex);
      end = set?.end ?? text.length;
      const kept = set !== null && set.urls.every(isDataUrl);
      replacement = kept ? text.slice(match.index, end) : "none";
    }
    out += text.slice(from, match.index) + replacement;
    from = end;
    keyword.lastIndex = end;
  }
  return out + text.slice(from);
}

/**
 * True when an attribute value has a url() that is not a same-document
 * reference (`url(#id)`, quotes and spaces allowed). SVG presentation
 * attributes (fill, mask, filter, clip-path, marker-*, …) load such URLs.
 */
function hasExternalUrl(value: string): boolean {
  const text = decodeLetterEscapes(value);
  const call = /url\(/gi;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    let i = call.lastIndex;
    while (i < text.length && /[\s"']/.test(text[i]!)) i++;
    if (text[i] !== "#") return true;
  }
  return false;
}

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

/**
 * The call in progress. DOMPurify runs its hooks synchronously inside
 * sanitize(), so the hooks read the mode and report what they blocked here.
 */
const run = { remoteImages: false, blockedRemoteImages: false, trackers: [] as Element[] };

function emailPurifier(): Purifier {
  if (purifier !== null) return purifier;
  const instance = DOMPurify(window);
  // Slice 3h: Mail's own data-mk-* marks never come from the mail itself.
  instance.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName.toLowerCase().startsWith(OWN_DATA_PREFIX)) data.keepAttr = false;
  });
  instance.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = cleanEmailCss(node.textContent ?? "");
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    for (const { name, value } of Array.from(node.attributes)) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) node.removeAttribute(name);
      // style is cleaned below; any other attribute naming a remote url() goes, in both modes.
      else if (lower !== "style" && hasExternalUrl(value)) node.removeAttribute(name);
    }
    for (const name of LOADING_ATTRIBUTES) node.removeAttribute(name);
    const src = node.getAttribute("src");
    if (src !== null && !isRasterDataUrl(src)) {
      // The one predicate for remote images: allowed mode keeps exactly what
      // default mode reports as blocked, trackers excepted (slice 3i: they
      // load in neither mode and are counted on their own).
      const remoteImage = node.nodeName.toLowerCase() === "img" && isHttpsUrl(src);
      if (remoteImage && isTrackerImage(node)) {
        // Slice 3i: a pixel never loads and is removed after the walk, so
        // quote marking decides as for the mail without it.
        run.trackers.push(node);
        node.removeAttribute("src");
      } else if (remoteImage && run.remoteImages) {
        node.setAttribute("referrerpolicy", "no-referrer");
      } else {
        if (remoteImage) run.blockedRemoteImages = true;
        node.removeAttribute("src");
      }
    }
    const isLink = LINK_ELEMENTS.has(node.nodeName.toLowerCase());
    for (const name of LINK_ATTRIBUTES) {
      const href = node.getAttribute(name);
      if (href !== null && (!isLink || !isAllowedLinkUrl(href))) node.removeAttribute(name);
    }
    const style = node.getAttribute("style");
    if (style !== null) node.setAttribute("style", cleanEmailCss(style));
  });
  purifier = instance;
  return instance;
}

/**
 * Sanitizes email HTML and wraps it in a complete document with the CSP meta,
 * ready for `<iframe sandbox="allow-same-origin" srcDoc>`.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizedEmail {
  run.remoteImages = options.remoteImages;
  run.blockedRemoteImages = false;
  run.trackers = [];
  let body: HTMLElement;
  try {
    // The body DOMPurify built (RETURN_DOM gives its <body>): quotes are
    // marked on it and it is serialized once, never parsed again.
    body = emailPurifier().sanitize(html, {
      FORBID_TAGS: options.remoteImages ? [...FORBID_TAGS, ...REMOTE_MODE_FORBID_TAGS] : FORBID_TAGS,
      FORCE_BODY: true,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      RETURN_DOM: true,
    }) as HTMLElement;
  } finally {
    run.remoteImages = false;
  }
  const trackers = run.trackers.length;
  for (const pixel of run.trackers) pixel.remove();
  run.trackers = [];
  if (options.cleanLinks === true) cleanAnchors(body);
  const quotes = markQuotes(body);
  const csp = options.remoteImages ? EMAIL_CSP_REMOTE_IMAGES : EMAIL_CSP;
  const darkStyle = options.dark === true ? DARK_SCHEME_STYLE + (options.darkSupported === true ? "" : DARK_ADAPT_STYLE) : "";
  return {
    html:
      "<!doctype html><html><head>" +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<meta http-equiv="x-dns-prefetch-control" content="off">` +
      `<meta name="referrer" content="no-referrer">` +
      `<style>${BASE_STYLE}${darkStyle}</style>` +
      `</head><body>${body.innerHTML}</body></html>`,
    blockedRemoteImages: run.blockedRemoteImages,
    trackers,
    quotes,
  };
}

/**
 * Slice 3i: every kept link through core cleanLink with its visible text.
 * A link cleanLink refuses loses its href; a changed one gets Mail's marks,
 * which the mail cannot bring (incoming data-mk-* attributes are dropped).
 */
function cleanAnchors(body: HTMLElement): void {
  for (const anchor of Array.from(body.querySelectorAll("a[href], area[href]"))) {
    const href = anchor.getAttribute("href") ?? "";
    const clean = cleanLink(href, textOf(anchor), { clean: true });
    if (clean === null) {
      anchor.removeAttribute("href");
      continue;
    }
    if (clean.url === href) continue;
    anchor.setAttribute("href", clean.url);
    anchor.setAttribute("data-mk-cleaned", String(clean.removedParams));
    if (clean.unwrapped) anchor.setAttribute("data-mk-unwrapped", "");
  }
}

/**
 * Slice 3h: a sanitized body as plain text for Show plain text when the mail
 * has no text part: block elements end lines and links read `text <url>`.
 * Slice 3i: with `cleanLinks` the `<url>`s are cleaned (core cleanLink).
 */
export function htmlToPlainText(html: string, options: { cleanLinks?: boolean } = {}): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  for (const element of Array.from(doc.querySelectorAll("script, style, head, title"))) element.remove();
  for (const link of Array.from(doc.querySelectorAll("a[href]"))) {
    const written = link.getAttribute("href") ?? "";
    const href = options.cleanLinks === true ? (cleanLink(written, textOf(link), { clean: true })?.url ?? written) : written;
    const text = textOf(link);
    if (isAllowedLinkUrl(href) && text !== href && !href.startsWith("mailto:")) link.append(` <${href}>`);
  }
  for (const br of Array.from(doc.querySelectorAll("br"))) br.replaceWith("\n");
  const blocks = "p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table, ul, ol, section, article";
  for (const block of Array.from(doc.querySelectorAll(blocks))) {
    block.prepend("\n");
    block.append("\n");
  }
  return (doc.body.textContent ?? "")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
