// Inbox tabs (Split Inbox): a tab is a named search condition applied to the
// conversations of the Inbox. This file holds what the search language needs
// for them; the tabs themselves follow.
import { isPublicMailDomain } from "./blocking.ts";

/** The sender sets `from:vip` and `from:team` read; `from:known` needs none (the people the owner wrote to). */
export type SenderSets = {
  /** The owner's important senders (the setting): lower case; domains in ASCII. */
  vip: { addresses: ReadonlySet<string>; domains: ReadonlySet<string> };
  /** The domains of the owner's own addresses, public mail domains left out. */
  team: ReadonlySet<string>;
};

export const NO_SENDER_SETS: SenderSets = { vip: { addresses: new Set(), domains: new Set() }, team: new Set() };

/** The owner's "team": whoever writes from a domain the owner has an address on, unless everybody has one there. */
export function teamDomains(ownAddresses: readonly string[]): Set<string> {
  const domains = new Set<string>();
  for (const address of ownAddresses) {
    const at = address.lastIndexOf("@");
    if (at < 0) continue;
    const domain = address.slice(at + 1).trim().toLowerCase();
    if (domain !== "" && !isPublicMailDomain(domain)) domains.add(domain);
  }
  return domains;
}

/** Whether a From address is in a sender set. */
export function inSenderSet(sets: SenderSets, kind: "vip" | "team", fromAddress: string): boolean {
  const address = fromAddress.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (kind === "team") return sets.team.has(domain);
  if (sets.vip.addresses.has(address)) return true;
  // A listed domain covers its subdomains, as in notifications.
  for (const listed of sets.vip.domains) if (domain === listed || domain.endsWith(`.${listed}`)) return true;
  return false;
}
