// Link cleaning (slice 3i, #40): one pure function every link Mail opens or
// hands on goes through. It removes known tracking parameters at string
// level (the rest of the URL stays byte for byte), unwraps one level of a
// known redirect wrapper whose target is written in the URL itself, and
// judges the final target: text that names another site, a host that mixes
// alphabets or imitates a known domain, a listed click-tracking redirect.
// Nothing is fetched; a redirect that hides its target is only named.
import { asciiDomainOf, orgDomain } from "./sender-basics.ts";
import { hostMixesAlphabets, isLookalikeHost, type KnownDomains } from "./sender-disguise.ts";
import { isTrackingRedirectHost } from "./trackers.ts";

export type CleanLink = {
  /** What Mail opens. */
  url: string;
  original: string;
  removedParams: number;
  unwrapped: boolean;
  /** An opaque click-tracking redirect host (listed), shown in the status line. */
  trackingHost: string | null;
  /** The final target's host in ASCII; empty for mailto. */
  host: string;
  /** The visible text looks like a URL or host of another organization. */
  deceptive: { says: string } | null;
  unusualHost: "punycode" | "mixed_script" | null;
  /** The known domain the target imitates. */
  lookalike: string | null;
  /** Deceptive text, mixed alphabets or a lookalike: open only after the dialog. Punycode alone never. */
  needsDialog: boolean;
};

/** Tracking parameter names removed (compared lower-case); every `utm_` name besides. */
export const TRACKING_PARAMS: readonly string[] = [
  "fbclid", "gclid", "gbraid", "wbraid", "dclid", "msclkid", "yclid", "ysclid", "igshid", "mc_cid", "mc_eid",
  "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "mkt_tok", "oly_anon_id", "oly_enc_id",
  "vero_id", "_kx", "trk", "trkcampaign", "sc_cid", "s_cid", "ref_src",
];
const TRACKING = new Set(TRACKING_PARAMS);

/** Longest href or visible text judged. */
const HREF_MAX = 8_192;
const TEXT_MAX = 300;
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

const isHttp = (url: URL | null): url is URL => url !== null && (url.protocol === "http:" || url.protocol === "https:");

function isTrackingParam(segment: string): boolean {
  const eq = segment.indexOf("=");
  const name = (decode(eq === -1 ? segment : segment.slice(0, eq)) ?? "").toLowerCase();
  return name.startsWith("utm_") || TRACKING.has(name);
}

function splitUrl(href: string): { base: string; query: string | null; fragment: string } {
  const hash = href.indexOf("#");
  const beforeHash = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? "" : href.slice(hash);
  const q = beforeHash.indexOf("?");
  return q === -1
    ? { base: beforeHash, query: null, fragment }
    : { base: beforeHash.slice(0, q), query: beforeHash.slice(q + 1), fragment };
}

/** The href without tracking parameters; every other byte kept. */
function removeParams(href: string): { url: string; removed: number } {
  const { base, query, fragment } = splitUrl(href);
  if (query === null) return { url: href, removed: 0 };
  const segments = query.split("&");
  const kept = segments.filter((segment) => !isTrackingParam(segment));
  const removed = segments.length - kept.length;
  if (removed === 0) return { url: href, removed: 0 };
  const rest = kept.join("&");
  return { url: `${base}${rest === "" ? "" : `?${rest}`}${fragment}`, removed };
}

/** The raw value of the first query parameter with this name. */
function param(href: string, name: string): string | null {
  const { query } = splitUrl(href);
  if (query === null) return null;
  for (const segment of query.split("&")) {
    const eq = segment.indexOf("=");
    if (eq !== -1 && segment.slice(0, eq) === name) return segment.slice(eq + 1);
  }
  return null;
}

function isGoogleHost(host: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const labels = bare.split(".");
  if (labels[0] !== "google") return false;
  if (labels.length === 2) return /^[a-z]{2,24}$/.test(labels[1] ?? "");
  if (labels.length === 3) return COUNTRY_SECOND_LEVEL.has(labels[1] ?? "") && /^[a-z]{2}$/.test(labels[2] ?? "");
  return false;
}

/** The target a known wrapper carries, when it is http(s); exact wrapper hosts only (resolution 12). */
function wrappedTarget(href: string, url: URL): string | null {
  const host = url.hostname;
  let raw: string | null = null;
  if (isGoogleHost(host) && url.pathname === "/url") raw = param(href, "q") ?? param(href, "url");
  else if (host.endsWith(".safelinks.protection.outlook.com")) raw = param(href, "url");
  else if ((host === "l.facebook.com" || host === "lm.facebook.com") && url.pathname === "/l.php") raw = param(href, "u");
  if (raw === null) return null;
  const target = decode(raw);
  if (target === null || target.length > HREF_MAX) return null;
  return isHttp(parseUrl(target)) ? target.trim() : null;
}

function unusualHostOf(host: string): CleanLink["unusualHost"] {
  if (hostMixesAlphabets(host)) return "mixed_script";
  const labels = host.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) return "punycode";
  return null;
}

// The whole text must be a URL or a bare host, not a sentence holding one.
const URL_LIKE = /^(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})?\.)+\p{L}[\p{L}\p{N}-]{1,62})\.?(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

/** The host the visible text names, in ASCII; null when the text is not a URL or bare host. */
function hostInText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > TEXT_MAX) return null;
  const match = URL_LIKE.exec(trimmed);
  if (match === null) return null;
  return asciiDomainOf(match[1] ?? null);
}

/**
 * The link Mail opens for `href` with this visible text (null for none):
 * null for anything but http, https and mailto (mailto comes back as it is).
 * With `clean` off nothing is removed or unwrapped, but the checks still
 * judge the wrapper's own target, so the dialog and status line stay.
 */
export function cleanLink(
  href: string,
  visibleText: string | null,
  options: { clean: boolean; known?: KnownDomains },
): CleanLink | null {
  const original = href.trim();
  if (original === "" || original.length > HREF_MAX) return null;
  const parsed = parseUrl(original);
  if (parsed === null) return null;
  if (parsed.protocol === "mailto:") {
    return {
      url: original,
      original,
      removedParams: 0,
      unwrapped: false,
      trackingHost: null,
      host: "",
      deceptive: null,
      unusualHost: null,
      lookalike: null,
      needsDialog: false,
    };
  }
  if (!isHttp(parsed)) return null;

  const target = wrappedTarget(original, parsed);
  let url = original;
  let unwrapped = false;
  let removedParams = 0;
  if (options.clean) {
    if (target !== null) {
      url = target;
      unwrapped = true;
    }
    const cleaned = removeParams(url);
    url = cleaned.url;
    removedParams = cleaned.removed;
  }

  const final = parseUrl(target ?? url);
  const host = final?.hostname ?? parsed.hostname;
  const trackingHost = isTrackingRedirectHost(host) ? host : null;
  const says = hostInText(visibleText);
  const deceptive = says !== null && trackingHost === null && orgDomain(says) !== orgDomain(host) ? { says } : null;
  const unusualHost = unusualHostOf(host);
  const lookalike = options.known === undefined ? null : isLookalikeHost(host, options.known);
  return {
    url,
    original,
    removedParams,
    unwrapped,
    trackingHost,
    host,
    deceptive,
    unusualHost,
    lookalike,
    needsDialog: deceptive !== null || unusualHost === "mixed_script" || lookalike !== null,
  };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]{1,8192}/gi;

/**
 * Plain text with every http(s) URL cleaned (`{ clean: true }`), for agent
 * and BB text: an agent that fetches a link must not confirm a tracked open.
 * Trailing sentence punctuation, and a `)` without its `(`, stay outside.
 */
export function cleanUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    let end = match.length;
    while (end > 0) {
      const ch = match[end - 1] ?? "";
      if (".,;:!?".includes(ch) || (ch === ")" && !match.slice(0, end - 1).includes("("))) end -= 1;
      else break;
    }
    const found = match.slice(0, end);
    const cleaned = cleanLink(found, null, { clean: true });
    return (cleaned?.url ?? found) + match.slice(end);
  });
}

