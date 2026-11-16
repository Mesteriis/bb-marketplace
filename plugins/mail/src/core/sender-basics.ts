// Sender helpers with no import chain to zod (slice 3i): the page bundles
// them (link cleaning, the images gate) and the core re-exports them from
// sender-check.ts. Pure.
import { toAsciiDomain } from "./compose-address.ts";

export const SENDER_CHECK_STATES = ["ok", "failed", "unchecked", "unknown"] as const;
/** `unknown`: not judged yet (a row synced before 3i, or one whose basis changed). */
export type SenderCheckState = (typeof SENDER_CHECK_STATES)[number];

/** Second-level labels under which a registrable name takes three labels (`example.co.uk`). */
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);

/** The domain in ASCII lower case without a trailing dot; null when it is not a usable name. */
export function asciiDomainOf(domain: string | null | undefined): string | null {
  if (domain === null || domain === undefined) return null;
  const trimmed = domain.trim().replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253) return null;
  try {
    return toAsciiDomain(trimmed);
  } catch {
    return null;
  }
}

/** The domain part of an address, ASCII lower case; null without one. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : asciiDomainOf(address.slice(at + 1));
}

/**
 * The registrable ("organizational") domain by a heuristic without the
 * public suffix list (no dependency): the last two labels, or the last three
 * when the second-to-last is a common country second level and the last is
 * two letters (`a.b.example.co.uk` gives `example.co.uk`). ASCII (punycode) form.
 * It can be wrong; a wrong answer shows or hides a warning, never blocks mail.
 */
export function orgDomain(domain: string): string {
  const ascii = asciiDomainOf(domain) ?? domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = ascii.split(".");
  if (labels.length <= 2) return ascii;
  const last = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const take = /^[a-z]{2}$/.test(last) && COUNTRY_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Whether an always-show sender's images may load by themselves (part A
 * resolution 5): only for `ok` or `unchecked` and no lookalike or
 * name-shows-address warning. `unknown` waits for the refresh.
 */
export function autoImagesAllowed(
  check: { state: SenderCheckState } | null,
  warnings: readonly { kind: string }[],
): boolean {
  if (check === null || (check.state !== "ok" && check.state !== "unchecked")) return false;
  return !warnings.some((warning) => warning.kind === "lookalike" || warning.kind === "name_shows_address");
}

