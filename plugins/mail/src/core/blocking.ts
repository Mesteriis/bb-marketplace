// Block a sender or a domain (slice 3e): the global rules, which addresses a
// message offers to block, and whether a From matches. Pure; the store keeps
// the rules and the server moves matching Inbox mail to Spam (never deletes).
import { toAsciiDomain } from "./compose-address.ts";

export type BlockRule = {
  id: string;
  kind: "address" | "domain";
  /** Lower case, the domain in ASCII (punycode). */
  value: string;
  createdAt: string;
};

/** Most rules kept; `block_add` refuses more. */
export const BLOCK_RULES_MAX = 1_000;

/** Mail providers anyone can sign up at: never offered or accepted as a domain rule (spec resolution 24). */
export const PUBLIC_MAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "msn.com", "aol.com", "proton.me", "pm.me",
  "protonmail.com", "protonmail.ch", "qq.com", "163.com", "126.com", "mail.ru", "bk.ru", "list.ru", "inbox.ru",
  "internet.ru", "ya.ru", "rambler.ru", "web.de", "mail.com", "fastmail.com",
];

/** Providers public under many country domains: the first label, then one or two labels (yahoo.co.uk, gmx.de, outlook.com.br). */
export const PUBLIC_MAIL_PATTERNS: readonly string[] = [
  "yahoo", "hotmail", "outlook", "live", "yandex", "gmx", "zoho", "zohomail",
];

const PUBLIC_EXACT = new Set(PUBLIC_MAIL_DOMAINS);
/** Second-level labels of country domains that a pattern provider uses (co.uk, com.br). */
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ne", "or"]);
const TLD = /^[a-z]{2,24}$/;
const COUNTRY = /^[a-z]{2}$/;

/** Whether the domain is a public mail provider's, where a domain rule would block strangers. */
export function isPublicMailDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase().replace(/\.$/, "");
  if (PUBLIC_EXACT.has(value)) return true;
  const [first, ...rest] = value.split(".");
  if (first === undefined || !PUBLIC_MAIL_PATTERNS.includes(first)) return false;
  if (rest.length === 1) return TLD.test(rest[0] ?? "");
  if (rest.length === 2) return COUNTRY_SECOND_LEVEL.has(rest[0] ?? "") && COUNTRY.test(rest[1] ?? "");
  return false;
}

/** The stored form of a rule value: lower case, domain in ASCII. Throws when it is not an address or a domain. */
export function normalizeBlockValue(kind: BlockRule["kind"], value: string): string {
  const text = value.trim().toLowerCase();
  if (kind === "domain") {
    const domain = text.startsWith("@") ? text.slice(1) : text;
    if (domain === "" || !domain.includes(".")) throw new Error("Invalid domain");
    return toAsciiDomain(domain.replace(/\.$/, ""));
  }
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) throw new Error("Invalid address");
  const local = text.slice(0, at);
  if (/[\s<>()\[\]\\,;:"\u0000-\u001f\u007f]/.test(local)) throw new Error("Invalid address");
  return `${local}@${toAsciiDomain(text.slice(at + 1))}`;
}

function normalizedOrNull(kind: BlockRule["kind"], value: string): string | null {
  try {
    return normalizeBlockValue(kind, value);
  } catch {
    return null;
  }
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const sameOrSub = (parent: string, domain: string) => domain === parent || domain.endsWith(`.${parent}`);

/** What a message offers to block: its address, and its domain unless that is a public mail domain. */
export function blockCandidates(address: string): { address: string; domain: string | null } {
  const normalized = normalizedOrNull("address", address) ?? address.trim().toLowerCase();
  const domain = domainOf(normalized);
  return { address: normalized, domain: domain === "" || isPublicMailDomain(domain) ? null : domain };
}

/** The first rule a From matches: an address rule exactly, a domain rule for the domain or a subdomain. */
export function matchesBlock(fromAddress: string, rules: readonly BlockRule[]): BlockRule | null {
  if (rules.length === 0) return null;
  const from = normalizedOrNull("address", fromAddress);
  if (from === null) return null;
  const domain = domainOf(from);
  for (const rule of rules) {
    if (rule.kind === "address" ? rule.value === from : sameOrSub(rule.value, domain)) return rule;
  }
  return null;
}

/** Why a rule is refused, or null. Never blocks the owner's own address or a domain holding one, or a public domain. */
export function blockRefusal(kind: BlockRule["kind"], value: string, ownAddresses: readonly string[]): string | null {
  const normalized = normalizedOrNull(kind, value);
  if (normalized === null) return kind === "address" ? "Not a valid address" : "Not a valid domain";
  const own = ownAddresses.flatMap((address) => {
    const n = normalizedOrNull("address", address);
    return n === null ? [] : [n];
  });
  if (kind === "address") return own.includes(normalized) ? "You cannot block your own address" : null;
  if (own.some((address) => sameOrSub(normalized, domainOf(address)))) return "You cannot block your own address";
  if (isPublicMailDomain(normalized)) return "This is a public mail domain; block the address instead";
  return null;
}
