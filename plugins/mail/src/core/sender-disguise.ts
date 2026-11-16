// Disguised senders (slice 3i, #39): replies that go elsewhere, a domain that
// looks like one the owner writes to, a domain that mixes alphabets, and a
// display name that shows another address. Pure and computed when a thread
// is read, against a known-domain set the server caches; nothing is stored.
//
// Every value here is the sender's and untrusted. Warnings carry domains and
// addresses in ASCII (punycode) form only, to be shown as data.
import type { MailAddress } from "./model.ts";
import { decodePunycodeLabel } from "./punycode.ts";
import { addressDomain, asciiDomainOf, orgDomain, type SenderCheckBasis, type SenderCheckState } from "./sender-check.ts";

export type DisguiseWarning =
  | { kind: "reply_to_elsewhere"; addresses: string[] }
  | { kind: "lookalike"; domain: string; like: string }
  | { kind: "mixed_script"; domain: string }
  | { kind: "name_shows_address"; shown: string; actual: string };

export const DISGUISE_WARNING_KINDS = ["reply_to_elsewhere", "lookalike", "mixed_script", "name_shows_address"] as const;

/** Most known domains kept; the store's query asks for no more. */
export const KNOWN_DOMAINS_MAX = 5_000;
/** Reply-To addresses judged per message (resolution 20). */
const REPLY_TO_MAX = 10;
/** Shortest first label the one-edit rule applies to. */
const EDIT_MIN = 5;
const LABEL_MAX = 63;
const NAME_MAX = 300;

// Look-alike letters, written as escapes: Cyrillic, Greek and a few Latin
// letters that read as plain Latin ones in common fonts. Written for Mail
// from the shapes, not taken from a list. Inputs are lower-cased first.
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", // Cyrillic a
  "\u0435": "e", // Cyrillic ie
  "\u043e": "o", // Cyrillic o
  "\u0440": "p", // Cyrillic er
  "\u0441": "c", // Cyrillic es
  "\u0443": "y", // Cyrillic u
  "\u0445": "x", // Cyrillic ha
  "\u043a": "k", // Cyrillic ka
  "\u0456": "i", // Cyrillic byelorussian-ukrainian i
  "\u0458": "j", // Cyrillic je
  "\u0455": "s", // Cyrillic dze
  "\u0501": "d", // Cyrillic komi de
  "\u051b": "q", // Cyrillic qa
  "\u051d": "w", // Cyrillic we
  "\u04bb": "h", // Cyrillic shha
  "\u04cf": "l", // Cyrillic palochka
  "\u03bf": "o", // Greek omicron
  "\u03b1": "a", // Greek alpha
  "\u03bd": "v", // Greek nu
  "\u03b9": "i", // Greek iota
  "\u03ba": "k", // Greek kappa
  "\u03c1": "p", // Greek rho
  "\u03c5": "u", // Greek upsilon
  "\u03c7": "x", // Greek chi
  "\u0131": "i", // Latin dotless i
  "\u0251": "a", // Latin alpha
  "\u0261": "g", // Latin script g
  "0": "o",
  "1": "l",
};

/** A label's Unicode form: an `xn--` label decoded (null when it does not decode), else lower-cased. */
function unicodeLabel(label: string): string | null {
  const lower = label.toLowerCase();
  if (!lower.startsWith("xn--")) return lower;
  const decoded = decodePunycodeLabel(lower.slice(4));
  return decoded === null ? null : decoded.toLowerCase();
}

/**
 * The label as it reads: lower case, look-alike letters mapped, `rn` read as
 * `m` and `vv` as `w`, hyphens dropped.
 */
export function skeleton(label: string): string {
  let out = "";
  for (const ch of label.toLowerCase().slice(0, LABEL_MAX * 2)) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/-/g, "");
}

export type Script = "latin" | "cyrillic" | "greek" | "other";

/** The alphabets of the letters in a label (digits and hyphens have none). */
export function scriptsOf(label: string): Set<Script> {
  const scripts = new Set<Script>();
  for (const ch of label.slice(0, LABEL_MAX * 2)) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) scripts.add("latin");
    else if (code >= 0x30 && code <= 0x39) continue;
    else if (code === 0x2d || code === 0x5f) continue;
    else if ((code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7) || (code >= 0x1e00 && code <= 0x1eff)) scripts.add("latin");
    else if (code >= 0x400 && code <= 0x52f) scripts.add("cyrillic");
    else if ((code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff)) scripts.add("greek");
    else if (/\p{L}/u.test(ch)) scripts.add("other");
  }
  return scripts;
}

function mixesAlphabets(label: string): boolean {
  const scripts = scriptsOf(label);
  let count = 0;
  for (const script of ["latin", "cyrillic", "greek"] as const) if (scripts.has(script)) count += 1;
  return count > 1;
}

/** An organizational domain split into its first label and the rest ("example", "co.uk"). */
function splitOrg(org: string): { label: string; suffix: string } | null {
  const dot = org.indexOf(".");
  if (dot <= 0 || dot === org.length - 1) return null;
  return { label: org.slice(0, dot), suffix: org.slice(dot + 1) };
}

/**
 * The domains the owner writes to and owns, as organizational domains,
 * indexed for the lookalike rule: by skeleton and by suffix plus
 * first-label length.
 */
export type KnownDomains = {
  readonly size: number;
  has(org: string): boolean;
  /** Known organizational domains whose first label has this skeleton and this suffix. */
  bySkeleton(key: string): readonly string[];
  /** Known first labels (Unicode form) with this suffix and length, and their domains. */
  byLength(suffix: string, length: number): readonly { label: string; org: string }[];
};

/** The known set from a list of domains (any form); at most KNOWN_DOMAINS_MAX organizational domains. */
export function buildKnownDomains(domains: Iterable<string>): KnownDomains {
  const orgs = new Set<string>();
  const skeletons = new Map<string, string[]>();
  const lengths = new Map<string, { label: string; org: string }[]>();
  for (const domain of domains) {
    if (orgs.size >= KNOWN_DOMAINS_MAX) break;
    const ascii = asciiDomainOf(domain);
    if (ascii === null) continue;
    const org = orgDomain(ascii);
    if (orgs.has(org)) continue;
    const parts = splitOrg(org);
    if (parts === null || parts.label.length > LABEL_MAX) continue;
    const label = unicodeLabel(parts.label);
    if (label === null) continue;
    orgs.add(org);
    const skelKey = `${skeleton(label)}.${parts.suffix}`;
    skeletons.set(skelKey, [...(skeletons.get(skelKey) ?? []), org]);
    const lengthKey = `${parts.suffix}|${[...label].length}`;
    const list = lengths.get(lengthKey) ?? [];
    list.push({ label, org });
    lengths.set(lengthKey, list);
  }
  return {
    size: orgs.size,
    has: (org) => orgs.has(org),
    bySkeleton: (key) => skeletons.get(key) ?? [],
    byLength: (suffix, length) => lengths.get(`${suffix}|${length}`) ?? [],
  };
}

/** Whether two strings are one substitution, insertion, deletion or adjacent swap apart. */
function oneEditApart(a: readonly string[], b: readonly string[]): boolean {
  if (a.length > b.length) return oneEditApart(b, a);
  if (b.length - a.length > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  if (i === a.length) return b.length === a.length + 1;
  if (a.length === b.length) {
    const rest = (from: number) => a.slice(from).join("") === b.slice(from).join("");
    if (rest(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2); // swap
  }
  return a.slice(i).join("") === b.slice(i + 1).join(""); // insertion
}

/**
 * The known domain this host's organizational domain imitates, or null: not
 * itself known, the same suffix, and equal after `skeleton`, or one edit
 * away when both first labels have five or more characters.
 */
export function isLookalikeHost(host: string, known: KnownDomains): string | null {
  const ascii = asciiDomainOf(host);
  if (ascii === null) return null;
  const org = orgDomain(ascii);
  if (known.has(org)) return null;
  const parts = splitOrg(org);
  if (parts === null || parts.label.length > LABEL_MAX) return null;
  const label = unicodeLabel(parts.label);
  if (label === null) return null;
  const twin = known.bySkeleton(`${skeleton(label)}.${parts.suffix}`).find((candidate) => candidate !== org);
  if (twin !== undefined) return twin;
  const chars = [...label];
  if (chars.length < EDIT_MIN) return null;
  for (const length of [chars.length - 1, chars.length, chars.length + 1]) {
    if (length < EDIT_MIN) continue;
    for (const candidate of known.byLength(parts.suffix, length)) {
      if (oneEditApart(chars, [...candidate.label])) return candidate.org;
    }
  }
  return null;
}

/** Whether one of the labels of an ASCII domain mixes Latin, Cyrillic or Greek once decoded. */
export function hostMixesAlphabets(ascii: string): boolean {
  return ascii.split(".").some((label) => {
    const unicode = unicodeLabel(label);
    return unicode !== null && mixesAlphabets(unicode);
  });
}

const ADDRESS_IN_TEXT = /[^\s<>()[\]"',;:@]{1,64}@[^\s<>()[\]"',;:@]{1,253}\.[^\s<>()[\]"',;:@.]{2,63}/u;

/** An address written inside a display name, with its domain in ASCII; null without one. */
function addressInName(name: string | null): string | null {
  if (name === null) return null;
  const match = ADDRESS_IN_TEXT.exec(name.slice(0, NAME_MAX));
  if (match === null) return null;
  const text = match[0];
  const at = text.lastIndexOf("@");
  const domain = asciiDomainOf(text.slice(at + 1).replace(/[.]+$/, ""));
  return domain === null ? null : `${text.slice(0, at).toLowerCase()}@${domain}`;
}

function asciiAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = asciiDomainOf(address.slice(at + 1));
  return domain === null ? null : `${address.slice(0, at).trim().toLowerCase()}@${domain}`;
}

export type DisguiseInput = {
  from: MailAddress;
  replyTo: readonly MailAddress[];
  bulk: boolean;
  /** The List-Id's id (`news.example.org`), or null. */
  listId: string | null;
  check: { state: SenderCheckState; basis?: SenderCheckBasis | null } | null;
  known: KnownDomains;
  /** The owner's own addresses. */
  own: ReadonlySet<string>;
};

/**
 * The warnings of one message, at most one per kind, in the fixed order
 * Reply-To, lookalike, mixed alphabets, name. Own mail (a Sent or Drafts
 * copy) gets none.
 */
export function disguiseWarnings(input: DisguiseInput): DisguiseWarning[] {
  if (input.check?.basis === "own") return [];
  const warnings: DisguiseWarning[] = [];
  const own = new Set([...input.own].map((address) => address.trim().toLowerCase()));
  const fromDomain = addressDomain(input.from.address);
  const fromOrg = fromDomain === null ? null : orgDomain(fromDomain);
  const listOrg = input.listId === null ? null : orgDomain(input.listId.trim().toLowerCase());
  const failed = input.check?.state === "failed";

  const elsewhere: string[] = [];
  for (const entry of input.replyTo.slice(0, REPLY_TO_MAX)) {
    const address = asciiAddress(entry.address);
    if (address === null || own.has(address) || own.has(entry.address.trim().toLowerCase())) continue;
    const org = orgDomain(address.slice(address.lastIndexOf("@") + 1));
    if (org === fromOrg || input.known.has(org)) continue;
    if (input.bulk && !failed && listOrg !== null && org === listOrg) continue;
    if (!elsewhere.includes(address)) elsewhere.push(address);
  }
  if (elsewhere.length > 0) warnings.push({ kind: "reply_to_elsewhere", addresses: elsewhere });

  if (fromDomain !== null) {
    const like = isLookalikeHost(fromDomain, input.known);
    if (like !== null) warnings.push({ kind: "lookalike", domain: fromDomain, like });
    if (hostMixesAlphabets(fromDomain)) warnings.push({ kind: "mixed_script", domain: fromDomain });
  }

  const shown = addressInName(input.from.name);
  const actual = asciiAddress(input.from.address);
  if (shown !== null && actual !== null && shown !== actual) {
    warnings.push({ kind: "name_shows_address", shown, actual });
  }
  return warnings;
}
