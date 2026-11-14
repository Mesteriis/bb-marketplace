// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/utils/sanitize.ts and src/components/email/EmailRenderer.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// Turns untrusted email HTML into a document for a sandboxed iframe: no
// scripts, forms, handlers or remote loads (images, CSS imports and CSS
// url()s are tracking pixels too), and a CSP that blocks anything missed.
import DOMPurify from "dompurify";

/** The policy inside every rendered message: only data: images, only inline styles. */
export const EMAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

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
].join("");

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
      replacement = call !== null && isDataUrl(call.url) ? text.slice(match.index, end) : "none";
    } else {
      const set = readImageSet(text, keyword.lastIndex);
      end = set?.end ?? text.length;
      replacement =
        set !== null && set.urls.every(isDataUrl) ? text.slice(match.index, end) : "none";
    }
    out += text.slice(from, match.index) + replacement;
    from = end;
    keyword.lastIndex = end;
  }
  return out + text.slice(from);
}

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

function emailPurifier(): Purifier {
  if (purifier !== null) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = cleanEmailCss(node.textContent ?? "");
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    for (const { name } of Array.from(node.attributes)) {
      if (name.toLowerCase().startsWith("on")) node.removeAttribute(name);
    }
    for (const name of LOADING_ATTRIBUTES) node.removeAttribute(name);
    const src = node.getAttribute("src");
    if (src !== null && !isDataUrl(src)) node.removeAttribute("src");
    for (const name of LINK_ATTRIBUTES) {
      const href = node.getAttribute(name);
      if (href !== null && !isAllowedLinkUrl(href)) node.removeAttribute(name);
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
export function sanitizeEmailHtml(html: string): string {
  const body = emailPurifier().sanitize(html, {
    FORBID_TAGS,
    FORCE_BODY: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    `<style>${BASE_STYLE}</style>` +
    `</head><body>${body}</body></html>`
  );
}
