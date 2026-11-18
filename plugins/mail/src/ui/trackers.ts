// Open-tracking pixels (slice 3i, #40): an image the reader is not meant to
// see whose only purpose is to report that the mail was opened. Judged from
// the element's own attributes and its src host, never from layout: an image
// hidden by a class or a hidden parent is not found (README states it).
import { isTrackerHost } from "../core/trackers.ts";

/** Largest width or height, in pixels, that still reads as a pixel. */
const PIXEL_MAX = 2;

function tiny(value: string | null): boolean {
  if (value === null) return false;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  return match !== null && Number(match[1]) <= PIXEL_MAX;
}

/** One declaration's value from an inline style, lower-cased; null when absent. */
function declaration(style: string, name: string): string | null {
  let found: string | null = null;
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    if (part.slice(0, colon).trim().toLowerCase() === name) found = part.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
  }
  return found;
}

function hostOf(src: string): string | null {
  try {
    return new URL(src.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether an `<img>` is a tracking pixel: a width or height attribute of at
 * most 2, an inline style of at most 2px, `display:none`,
 * `visibility:hidden` or `opacity:0`, or a src on a listed open-tracking
 * host. A data: image is never a tracker.
 */
export function isTrackerImage(img: Element): boolean {
  const src = img.getAttribute("src");
  if (src === null || /^\s*data:/i.test(src)) return false;
  if (tiny(img.getAttribute("width")) || tiny(img.getAttribute("height"))) return true;
  const style = img.getAttribute("style") ?? "";
  if (style !== "") {
    if (tiny(declaration(style, "width")) || tiny(declaration(style, "height"))) return true;
    if (declaration(style, "display") === "none") return true;
    if (declaration(style, "visibility") === "hidden") return true;
    const opacity = declaration(style, "opacity");
    if (opacity !== null && /^(?:0+(?:\.0*)?|\.0+)%?$/.test(opacity)) return true;
  }
  const host = hostOf(src);
  return host !== null && isTrackerHost(host);
}
