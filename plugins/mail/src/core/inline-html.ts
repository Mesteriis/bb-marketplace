// Inline images for message_body: `cid:` references in a message's HTML
// become `data:` URLs built from the stored inline parts, so the page never
// fetches anything. The HTML is attacker-controlled: one replace with a
// pattern whose whitespace runs cannot be split two ways, so it stays linear.
import type { InlinePart } from "./model.ts";
import { INLINE_MESSAGE_MAX_BYTES } from "./store-rules.ts";

/** Raster types a browser shows as an image and nothing more (no SVG: it can carry script and links). */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/**
 * Most characters of data: URLs added to one message's HTML. The store keeps
 * at most INLINE_MESSAGE_MAX_BYTES per message (a third more in base64); the
 * same part referenced over and over stops being inlined here.
 */
export const INLINE_HTML_DATA_BUDGET = Math.ceil((INLINE_MESSAGE_MAX_BYTES * 4) / 3) + 64 * 1024;

/** An opening quote as written in HTML or inside an attribute (&quot; / &#39; / &apos;). */
const QUOTE = `(?:["']|&quot;|&#0*3[49];|&apos;)`;
/** `src=` or CSS `url(`, an optional quote, then `cid:` and the content id. */
const CID_REFERENCE = new RegExp(
  `(\\bsrc\\s*=\\s*(?:${QUOTE}\\s*)?|\\burl\\(\\s*(?:${QUOTE}\\s*)?)cid:([^\\s"'()<>&\\\\]{1,998})`,
  "gi",
);

/**
 * The HTML with each `cid:` reference in a src attribute or CSS url() that
 * names an inline part of an allowed raster type replaced by a data: URL.
 * Other references stay as written (the sanitizer blocks them).
 */
export function inlineCidImages(
  html: string,
  parts: InlinePart[],
  budget: number = INLINE_HTML_DATA_BUDGET,
): string {
  const byId = new Map<string, InlinePart>();
  for (const part of parts) {
    if (mimeOf(part) === null) continue;
    for (const key of [part.contentId, part.contentId.toLowerCase()]) {
      if (!byId.has(key)) byId.set(key, part);
    }
  }
  if (byId.size === 0 || !/cid:/i.test(html)) return html;
  const urls = new Map<InlinePart, string>();
  let spent = 0;
  return html.replace(CID_REFERENCE, (whole, prefix: string, reference: string) => {
    const part = lookup(byId, reference);
    if (part === undefined) return whole;
    let url = urls.get(part);
    if (url === undefined) {
      url = `data:${mimeOf(part)};base64,${base64Encode(part.data)}`;
      urls.set(part, url);
    }
    if (spent + url.length > budget) return whole;
    spent += url.length;
    return prefix + url;
  });
}

function lookup(byId: Map<string, InlinePart>, reference: string): InlinePart | undefined {
  let decoded = reference;
  try {
    decoded = decodeURIComponent(reference); // RFC 2392: a cid URL is URL-encoded.
  } catch {
    // Malformed escapes: match as written.
  }
  for (const key of [reference, decoded, reference.toLowerCase(), decoded.toLowerCase()]) {
    const part = byId.get(key);
    if (part !== undefined) return part;
  }
  return undefined;
}

function mimeOf(part: InlinePart): string | null {
  const type = part.mimeType.split(";")[0]!.trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(type) ? type : null;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding (core has no Buffer or btoa dependency). */
export function base64Encode(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out.push(ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out.push(`${ALPHABET[n >> 18]!}${ALPHABET[(n >> 12) & 63]!}==`);
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out.push(`${ALPHABET[n >> 18]!}${ALPHABET[(n >> 12) & 63]!}${ALPHABET[(n >> 6) & 63]!}=`);
  }
  return out.join("");
}
