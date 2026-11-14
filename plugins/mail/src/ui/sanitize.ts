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

function urlArgument(call: string): string {
  return call
    .slice(call.indexOf("(") + 1, -1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/** The URLs an image-set() names: its url() arguments and bare strings. */
function imageSetUrls(inner: string): string[] {
  const refs = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)'/gi;
  return [...inner.matchAll(refs)].map(
    (match) => match.slice(1).find((group) => group !== undefined) ?? "",
  );
}

/** Removes @import and every url()/image-set() that is not a data: URL. */
export function cleanEmailCss(css: string): string {
  return decodeLetterEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""))
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\(((?:[^()]|\([^()]*\))*)\)/gi, (call, inner: string) =>
      imageSetUrls(inner).every(isDataUrl) ? call : "none",
    )
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (call) =>
      isDataUrl(urlArgument(call)) ? call : "none",
    );
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
    `<style>${BASE_STYLE}</style>` +
    `</head><body>${body}</body></html>`
  );
}
