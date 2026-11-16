// Unsubscribe (slice 3e): what a message's List-Unsubscribe offers, and
// whether the provider's Authentication-Results vouch that a DKIM signature
// covering both list headers verified, which is what RFC 8058 asks before a
// one-click POST. Pure: the gateway hands the parsed header lines in message
// order; the server stores the result as `messages.unsubscribe_json`.
//
// Every header value here comes from the sender and is untrusted. Nothing is
// decoded beyond percent-escapes of the mailto, and only what passes the
// checks below is kept.
import { parseAddress, toAsciiDomain } from "./compose-address.ts";
import { revealHidden } from "./agent-propose.ts";
import type { AccountPreset } from "./model.ts";
import { RECEIPT_HEADERS } from "./receipts.ts";

/** One header of a message: lower-case key, unfolded value, in message order. */
export type HeaderLine = { key: string; value: string };

export type UnsubscribeTrust = "covered" | "not_covered" | "no_dkim" | "untrusted_provider";

export type UnsubscribeInfo = {
  /** List-Id's id lower-cased, else the From address lower-cased. Never shown or returned to the page. */
  listKey: string;
  listName: string | null;
  https: string | null;
  oneClick: boolean;
  mailto: { address: string; subject: string; body: string } | null;
  trust: UnsubscribeTrust;
};

/** Largest serialized info stored; a larger one is not stored (null). */
export const UNSUBSCRIBE_INFO_MAX_BYTES = 4 * 1024;

const MAX_ENTRIES = 5;
const MAX_ENTRY = 2_048;
const SUBJECT_MAX = 200;
const BODY_MAX = 1_000;
const LIST_NAME_MAX = 80;
const DEFAULT_SUBJECT = "unsubscribe";
const ONE_CLICK_VALUE = "List-Unsubscribe=One-Click";

/** Trace headers a provider writes above the message on receipt (spec resolution 12). */
const COMMON_TRACE_HEADERS = [
  "Received",
  "Authentication-Results",
  "ARC-Seal",
  "ARC-Message-Signature",
  "ARC-Authentication-Results",
  "Received-SPF",
  "Return-Path",
  "Delivered-To",
  "X-Received",
] as const;

/**
 * The header names of each preset's top block. A trailing `*` matches any
 * name with that prefix. iCloud's own names are pinned at the live check.
 */
export const PROVIDER_TRACE_HEADERS: Record<AccountPreset, readonly string[]> = {
  gmail: [...COMMON_TRACE_HEADERS, "X-Google-*", "X-Gm-*"],
  icloud: [...COMMON_TRACE_HEADERS],
  other: [...COMMON_TRACE_HEADERS],
};

/**
 * The authserv-ids whose Authentication-Results count, per preset. Empty
 * means one-click is never offered there (spec resolutions 3 and 4): iCloud
 * stays empty until its ids are pinned after the owner's live check.
 */
export const TRUSTED_AUTHSERV: Record<AccountPreset, readonly string[]> = {
  gmail: ["mx.google.com"],
  icloud: [],
  other: [],
};

/**
 * The fields a header fetch asks for (BODY.PEEK[HEADER.FIELDS (...)]).
 * IMAP cannot ask by prefix, so the `*` trace names are left out; a fetch
 * without them only shortens nothing, since the fields it does return keep
 * their message order.
 */
export const UNSUBSCRIBE_HEADER_FIELDS: readonly string[] = (() => {
  const names = [
    "From",
    "List-Id",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "Authentication-Results",
    "DKIM-Signature",
    ...Object.values(PROVIDER_TRACE_HEADERS).flat().filter((name) => !name.endsWith("*")),
  ];
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})();

/**
 * Slice 3i: the fields the old-row sender check fetches (BODY.PEEK). The
 * judged block is filtered back to the unsubscribe names first
 * (resolution 16), so sync-time and open-time verdicts agree; Reply-To,
 * Content-Type and the receipt headers fill the other stored columns.
 */
export const SECURITY_HEADER_FIELDS: readonly string[] = [
  ...UNSUBSCRIBE_HEADER_FIELDS,
  "Reply-To",
  "Content-Type",
  ...RECEIPT_HEADERS,
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const keyOf = (line: HeaderLine) => line.key.toLowerCase();
const linesNamed = (headers: HeaderLine[], name: string) => headers.filter((line) => keyOf(line) === name);

export type ParsedListUnsubscribe = {
  https: string | null;
  mailto: UnsubscribeInfo["mailto"];
  oneClick: boolean;
  /** Either list header occurs more than once (spec resolution 11). */
  repeated: boolean;
};

/** The methods of List-Unsubscribe and List-Unsubscribe-Post (spec "Parsing at sync"). */
/** Header lines unsubscribe parsing judges; the rest are only counted. */
export const HEADER_LINES_MAX = 64;
/**
 * The line capHeaderLines appends when it cut lines. Its key has a colon,
 * which no header name can hold, so no message can forge or hide it.
 */
export const HEADER_LINES_TRUNCATED: HeaderLine = Object.freeze({ key: ":truncated", value: "" });
/** List lines carried past the cap per name: enough to see a repeat. */
const LIST_LINES_PAST_CAP = 2;

/**
 * The first HEADER_LINES_MAX lines in order (review item 2). When there are
 * more, the List-Unsubscribe and List-Unsubscribe-Post lines past the cap
 * (at most two of each) and HEADER_LINES_TRUNCATED follow, so the
 * repeated-header rule counts every instance and a long header section is
 * never trusted for one-click. A list already capped is returned as it is.
 */
export function capHeaderLines(lines: readonly HeaderLine[]): HeaderLine[] {
  if (lines.length <= HEADER_LINES_MAX || lines.includes(HEADER_LINES_TRUNCATED)) return [...lines];
  const out = lines.slice(0, HEADER_LINES_MAX);
  const carried = new Map<string, number>();
  for (const line of lines.slice(HEADER_LINES_MAX)) {
    if (line.key !== "list-unsubscribe" && line.key !== "list-unsubscribe-post") continue;
    const count = carried.get(line.key) ?? 0;
    if (count >= LIST_LINES_PAST_CAP) continue;
    carried.set(line.key, count + 1);
    out.push(line);
  }
  out.push(HEADER_LINES_TRUNCATED);
  return out;
}

export function parseListUnsubscribe(headers: HeaderLine[]): ParsedListUnsubscribe {
  const lists = linesNamed(headers, "list-unsubscribe");
  const posts = linesNamed(headers, "list-unsubscribe-post");
  const repeated = lists.length > 1 || posts.length > 1;
  const list = lists.length === 1 ? lists[0] : undefined;
  if (list === undefined) return { https: null, mailto: null, oneClick: false, repeated };

  const entries = [...list.value.matchAll(/<([^<>]*)>/g)]
    .slice(0, MAX_ENTRIES)
    .map((match) => (match[1] ?? "").replace(/\s+/g, ""))
    .filter((entry) => entry.length > 0 && entry.length <= MAX_ENTRY);
  const httpsEntry = entries.find((entry) => /^https:/i.test(entry));
  const mailtoEntry = entries.find((entry) => /^mailto:/i.test(entry));
  const https = httpsEntry === undefined ? null : validHttps(httpsEntry);
  const mailto = mailtoEntry === undefined ? null : parseMailto(mailtoEntry);
  const post = posts.length === 1 ? posts[0] : undefined;
  const oneClick = https !== null && post !== undefined && post.value.trim() === ONE_CLICK_VALUE;
  return { https, mailto, oneClick, repeated };
}

const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A DNS host name of at least two labels, ASCII, not all-numeric at the top. */
function isDnsHost(host: string): boolean {
  if (host.length === 0 || host.length > 253 || IPV4_HOST.test(host) || host.startsWith("[")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

/** The https URL when it has no userinfo, a DNS host and no port other than 443; else null. */
export function validHttps(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (!isDnsHost(url.hostname)) return null;
  return url.href;
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

function parseMailto(entry: string): UnsubscribeInfo["mailto"] {
  const rest = entry.slice("mailto:".length);
  const query = rest.indexOf("?");
  const to = decode(query === -1 ? rest : rest.slice(0, query));
  if (to === null || !VISIBLE_ASCII.test(to) || to.includes(",")) return null;
  const parsed = parseAddress(to);
  if (!parsed.ok || parsed.value.name !== null || parsed.value.address.toLowerCase() !== to.toLowerCase()) return null;

  let subject: string | null = null;
  let body: string | null = null;
  if (query !== -1) {
    for (const pair of rest.slice(query + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).toLowerCase();
      if (name === "subject" && subject === null) subject = decode(pair.slice(eq + 1)) ?? "";
      else if (name === "body" && body === null) body = decode(pair.slice(eq + 1)) ?? "";
    }
  }
  const line = (subject ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
  const text = (body ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  return {
    address: parsed.value.address,
    subject: line === "" ? DEFAULT_SUBJECT : line.slice(0, SUBJECT_MAX),
    body: text.slice(0, BODY_MAX),
  };
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** The domain in ASCII lower case; null when it is not a usable name. */
function asciiDomain(domain: string | null): string | null {
  if (domain === null) return null;
  const trimmed = domain.trim().replace(/\.$/, "");
  if (trimmed === "") return null;
  try {
    return toAsciiDomain(trimmed);
  } catch {
    return null;
  }
}

/** `parent` equals `child` or is a parent domain of it, label-wise. */
function isSameOrParent(parent: string, child: string): boolean {
  return child === parent || child.endsWith(`.${parent}`);
}

function matchesTrace(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p;
  });
}

/**
 * Removes RFC 5322 comments (nested parentheses) outside quoted strings.
 * Quoted strings are tracked inside comments too (part A resolution 4.4),
 * so a quoted local part holding `)` cannot close a comment early and smuggle
 * text out of it. `balanced` is false when the text ends inside a quote or a
 * comment.
 */
function stripComments(text: string): { text: string; balanced: boolean } {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += ch + (text[i + 1] ?? "");
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
      if (depth === 0) out += ch;
    } else if (!quoted && ch === "(") {
      depth += 1;
    } else if (!quoted && ch === ")" && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return { text: out, balanced: !quoted && depth === 0 };
}

/** Splits at `;` outside quoted strings (part A resolution 4.4). */
function splitEntries(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quoted && ch === "\\") {
      current += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const unquote = (value: string) => (value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value);

/** Longest Authentication-Results value read; the rest is cut and the result marked malformed (slice 3i). */
export const AUTH_RESULTS_VALUE_MAX = 4 * 1024;
/** Most method entries read from one Authentication-Results value. */
export const AUTH_RESULTS_ENTRIES_MAX = 20;

/** One `spf`, `dkim` or `dmarc` entry of an Authentication-Results header, property values as written. */
export type AuthEntry = {
  method: "spf" | "dkim" | "dmarc";
  /** Lower case. */
  result: string;
  smtpMailfrom: string | null;
  headerFrom: string | null;
  headerD: string | null;
  headerI: string | null;
  headerS: string | null;
  headerB: string | null;
};

export type AuthResults = {
  /** Lower case. */
  authservId: string;
  entries: AuthEntry[];
  /** Cut at a bound, or a quote or comment left open: never enough to claim a sender is fine. */
  malformed: boolean;
};

const AUTH_METHODS = new Set<AuthEntry["method"]>(["spf", "dkim", "dmarc"]);

/**
 * The method entries of one Authentication-Results value (RFC 8601), bounded
 * before any regular expression runs. Unknown methods are skipped; null
 * without an authserv-id.
 */
export function parseAuthResults(value: string): AuthResults | null {
  let malformed = value.length > AUTH_RESULTS_VALUE_MAX;
  const stripped = stripComments(value.slice(0, AUTH_RESULTS_VALUE_MAX));
  if (!stripped.balanced) malformed = true;
  const parts = splitEntries(stripped.text);
  const authservId = (parts[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (authservId === "") return null;
  const entries: AuthEntry[] = [];
  for (const part of parts.slice(1)) {
    if (entries.length >= AUTH_RESULTS_ENTRIES_MAX) {
      malformed = true;
      break;
    }
    const pairs = [...part.matchAll(/([A-Za-z0-9._-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s;]+)/g)].map((m) => ({
      name: (m[1] ?? "").toLowerCase(),
      value: unquote(m[2] ?? ""),
    }));
    const first = pairs[0];
    if (first === undefined || !AUTH_METHODS.has(first.name as AuthEntry["method"])) continue;
    const prop = (name: string) => pairs.slice(1).find((p) => p.name === name)?.value ?? null;
    entries.push({
      method: first.name as AuthEntry["method"],
      result: first.value.toLowerCase(),
      smtpMailfrom: prop("smtp.mailfrom"),
      headerFrom: prop("header.from"),
      headerD: prop("header.d"),
      headerI: prop("header.i"),
      headerS: prop("header.s"),
      headerB: prop("header.b"),
    });
  }
  return { authservId, entries, malformed };
}

type DkimResult = {
  result: string;
  /** The signer domain: header.d, else the domain of header.i. */
  signer: string | null;
  selector: string | null;
  b: string | null;
};

/** The DKIM view 3e's one-click trust reads. */
function dkimResults(results: AuthResults): DkimResult[] {
  return results.entries
    .filter((entry) => entry.method === "dkim")
    .map((entry) => {
      const i = entry.headerI;
      const iDomain = i !== null && i.includes("@") ? i.slice(i.lastIndexOf("@") + 1) : null;
      return {
        result: entry.result,
        signer: asciiDomain(entry.headerD ?? iDomain),
        selector: entry.headerS?.toLowerCase() ?? null,
        b: entry.headerB?.replace(/\s+/g, "") ?? null,
      };
    });
}

/**
 * The Authentication-Results headers that count for a preset (3e's rule,
 * shared with the slice-3i sender check): only trusted authserv-ids, only
 * inside the provider's top trace block and above the topmost
 * DKIM-Signature, in message order (the provider's own comes first).
 * `elsewhere`: a trusted id also appears further down. Null when the preset
 * trusts no id.
 */
export function trustedAuthResults(
  headers: HeaderLine[],
  preset: AccountPreset,
): { counted: AuthResults[]; elsewhere: boolean } | null {
  const trusted = TRUSTED_AUTHSERV[preset].map((id) => id.toLowerCase());
  if (trusted.length === 0) return null;

  const patterns = PROVIDER_TRACE_HEADERS[preset];
  let blockEnd = headers.findIndex((line) => !matchesTrace(keyOf(line), patterns));
  if (blockEnd === -1) blockEnd = headers.length;
  let dkimTop = headers.findIndex((line) => keyOf(line) === "dkim-signature");
  if (dkimTop === -1) dkimTop = headers.length;
  const limit = Math.min(blockEnd, dkimTop);

  const counted: AuthResults[] = [];
  let elsewhere = false;
  headers.forEach((line, index) => {
    if (keyOf(line) !== "authentication-results") return;
    const parsed = parseAuthResults(line.value);
    if (parsed === null || !trusted.includes(parsed.authservId)) return;
    if (index < limit) counted.push(parsed);
    else elsewhere = true;
  });
  return { counted, elsewhere };
}

type Signature = { d: string | null; s: string | null; b: string; h: string[] };

function parseSignature(value: string): Signature {
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).replace(/\s+/g, "").toLowerCase();
    if (!tags.has(name)) tags.set(name, part.slice(eq + 1));
  }
  const noSpace = (text: string | undefined) => (text ?? "").replace(/[\r\n \t]+/g, "");
  return {
    d: asciiDomain(tags.get("d")?.trim() ?? null),
    s: tags.get("s")?.trim().toLowerCase() ?? null,
    b: noSpace(tags.get("b")),
    h: noSpace(tags.get("h")).split(":").map((name) => name.toLowerCase()).filter((name) => name !== ""),
  };
}

/** The indexes of the signatures a result may name (spec resolution 10). */
function candidatesOf(result: DkimResult, signatures: Signature[]): number[] {
  const signer = result.signer;
  if (signer === null) return [];
  return signatures.flatMap((sig, index) => {
    if (sig.d === null || !isSameOrParent(sig.d, signer)) return [];
    if (result.selector !== null && sig.s !== result.selector) return [];
    if (result.b !== null && (result.b === "" || !sig.b.startsWith(result.b))) return [];
    return [index];
  });
}

/**
 * Whether the provider vouches that a signature covering both list headers
 * verified (spec "Trust rules" items 3–5 as changed by resolutions 10–12).
 */
export function trustOf(
  headers: HeaderLine[],
  preset: AccountPreset,
  fromDomain: string | null,
  httpsHost: string | null,
): UnsubscribeTrust {
  const found = trustedAuthResults(headers, preset);
  if (found === null) return "untrusted_provider";
  const counted = found.counted;
  if (counted.length === 0) return found.elsewhere ? "untrusted_provider" : "no_dkim";

  const signatures = linesNamed(headers, "dkim-signature").map((line) => parseSignature(line.value));
  const results = counted.flatMap(dkimResults);
  const passes = results.filter((r) => r.result === "pass");
  // Any other answer (fail, neutral, temperror, permerror, policy, none) is a
  // conflict for the signature it names; one naming none contradicts every
  // pass (review item 4).
  const others = results.filter((r) => r.result !== "pass");
  if (passes.length === 0) return "no_dkim";

  const from = asciiDomain(fromDomain);
  const host = asciiDomain(httpsHost);
  let best: UnsubscribeTrust = "no_dkim";
  for (const pass of passes) {
    const candidates = candidatesOf(pass, signatures);
    if (candidates.length !== 1) {
      best = "not_covered";
      continue;
    }
    const chosen = candidates[0] as number;
    if (others.some((other) => other.signer === null || candidatesOf(other, signatures).includes(chosen))) {
      best = "not_covered";
      continue;
    }
    const signature = signatures[chosen] as Signature;
    const covers = signature.h.includes("list-unsubscribe") && signature.h.includes("list-unsubscribe-post");
    const d = signature.d as string;
    const sense = (from !== null && isSameOrParent(d, from)) || (host !== null && isSameOrParent(d, host));
    if (covers && sense) return "covered";
    best = "not_covered";
  }
  return best;
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

function oneLine(text: string, max: number): string | null {
  const shown = revealHidden(text).shown.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return shown === "" ? null : [...shown].slice(0, max).join("");
}

function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : address.slice(at + 1);
}

/** What `messages.unsubscribe_json` holds for a message; null without List-Unsubscribe, headers or over the cap. */
export function unsubscribeInfoOf(
  lines: HeaderLine[],
  preset: AccountPreset,
  from: { name: string | null; address: string },
): UnsubscribeInfo | null {
  const headers = capHeaderLines(lines);
  if (headers.length === 0 || linesNamed(headers, "list-unsubscribe").length === 0) return null;
  // Lines past the cap were not judged: one-click is never offered (review item 2).
  const truncated = headers.includes(HEADER_LINES_TRUNCATED);
  const parsed = parseListUnsubscribe(headers);
  const listId = linesNamed(headers, "list-id")[0]?.value ?? null;
  const id = listId?.match(/<([^<>]+)>/)?.[1]?.trim().toLowerCase() ?? null;
  const phrase = listId === null ? null : unquote(listId.replace(/<[^<>]*>/g, "").trim());
  const listName = oneLine(phrase !== null && phrase !== "" ? phrase : (from.name ?? ""), LIST_NAME_MAX);
  let httpsHost: string | null = null;
  if (parsed.https !== null) httpsHost = new URL(parsed.https).hostname;
  const trust: UnsubscribeTrust = parsed.repeated || truncated
    ? "not_covered"
    : trustOf(headers, preset, domainOfAddress(from.address), httpsHost);
  const info: UnsubscribeInfo = {
    // Namespaced (review item 8): a List-Id never names a From-fallback list.
    listKey: id !== null && id !== "" ? `${LIST_KEY_ID}${id}` : `${LIST_KEY_FROM}${from.address.trim().toLowerCase()}`,
    listName,
    https: parsed.https,
    oneClick: parsed.oneClick && !parsed.repeated && !truncated,
    mailto: parsed.mailto,
    trust,
  };
  if (new TextEncoder().encode(JSON.stringify(info)).length > UNSUBSCRIBE_INFO_MAX_BYTES) return null;
  return info;
}

/** A list key from List-Id; the other kind is the From fallback. */
export const LIST_KEY_ID = "id:";
export const LIST_KEY_FROM = "from:";

/**
 * Whether two stored messages belong to the same list for "Archive all from
 * this list" (review item 8): the same key, and for anything but a List-Id
 * key (a From fallback, or a key stored before the namespaces) the same From
 * address too, so a list named after an address covers only mail from it.
 */
export function sameList(
  a: { listKey: string; fromAddress: string },
  b: { listKey: string; fromAddress: string },
): boolean {
  if (a.listKey !== b.listKey) return false;
  if (a.listKey.startsWith(LIST_KEY_ID)) return true;
  return a.fromAddress.trim().toLowerCase() === b.fromAddress.trim().toLowerCase();
}

export type OfferedMethods = {
  oneClick: { host: string } | null;
  mailto: { address: string; subject: string; body: string; hiddenChars: number; foreignDomain: boolean } | null;
};

/**
 * The subject and body a mailto unsubscribe sends, exactly as the dialog
 * and the triage card show them (review item 5): plain text with invisible
 * characters taken out (revealHidden), and how many were taken out. A
 * subject left empty is the default the email would carry.
 */
export function mailtoText(mailto: NonNullable<UnsubscribeInfo["mailto"]>): { subject: string; body: string; hiddenChars: number } {
  const subject = revealHidden(mailto.subject);
  const body = revealHidden(mailto.body);
  const shownSubject = subject.shown.trim();
  return {
    subject: shownSubject === "" ? DEFAULT_SUBJECT : shownSubject,
    body: body.shown,
    hiddenChars: subject.hidden + body.hidden,
  };
}

/**
 * What the page may offer. One-click only when it is covered; the mailto is
 * `foreignDomain` when its domain is neither the From domain nor a parent of
 * it. `fromAddress` is the stored message's From.
 */
export function offeredMethods(info: UnsubscribeInfo, fromAddress: string): OfferedMethods {
  const oneClick =
    info.oneClick && info.trust === "covered" && info.https !== null ? { host: new URL(info.https).hostname } : null;
  let mailto: OfferedMethods["mailto"] = null;
  if (info.mailto !== null) {
    const to = asciiDomain(domainOfAddress(info.mailto.address));
    const from = asciiDomain(domainOfAddress(fromAddress));
    const foreignDomain = to === null || from === null || !isSameOrParent(to, from);
    mailto = { address: info.mailto.address, ...mailtoText(info.mailto), foreignDomain };
  }
  return { oneClick, mailto };
}
