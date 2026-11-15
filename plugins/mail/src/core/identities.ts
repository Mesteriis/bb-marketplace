// Sending identities (slice 3d): an account's own address and the aliases
// the owner added by hand, which addresses count as the owner's, which one a
// reply starts from, the alias suggestions from inbound mail, and the send
// check's transitions. Pure; the store keeps the alias rows.
import { parseAddress } from "./compose-address.ts";
import type { SignatureDoc } from "./compose-signature.ts";
import type { ReplySource } from "./compose-reply.ts";
import type { AccountPreset, SentCopyPolicy, StoredAccount } from "./model.ts";

/** Active aliases one account may have. */
export const IDENTITIES_MAX_PER_ACCOUNT = 50;
/** Suggestions shown at most, and the messages one needs. */
const SUGGESTIONS_MAX = 10;
const SUGGESTION_MIN_MESSAGES = 2;

/**
 * What the plugin learned about sending from an alias: `accepted` (SMTP
 * took it and the plugin keeps the Sent copy), `pending` (the server keeps
 * the Sent copy; its From decides), `confirmed`, `rewritten` (the server
 * sent from another address) or `refused` (`sender_refused`).
 */
export type SendCheck = "unknown" | "accepted" | "pending" | "confirmed" | "rewritten" | "refused";

/** A stored alias of an account, or a suggestion the owner dismissed. Address lower case. */
export type AliasRow = {
  id: string;
  accountId: string;
  address: string;
  displayName: string | null;
  signature: SignatureDoc | null;
  state: "active" | "dismissed";
  sendCheck: SendCheck;
  checkMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One address the owner can send from. */
export type Identity = {
  accountId: string;
  /** Lower case. */
  address: string;
  /** Effective: the alias's name, else the account's. */
  displayName: string | null;
  primary: boolean;
  signature: SignatureDoc | null;
  /** Always "confirmed" for the primary address. */
  sendCheck: SendCheck;
};

/** What the identity rules read of an account; `signature` is the own address's. */
export type IdentityAccount = Pick<StoredAccount, "id" | "email" | "displayName" | "username"> & {
  signature?: SignatureDoc | null;
};

/** An inbound message's recipients, for alias suggestions. `deliveredTo` null: not known (synced before 3d). */
export type InboundRow = { to: string[]; cc: string[]; deliveredTo: string[] | null; date: string };

export type AliasSuggestion = { address: string; count: number; lastDate: string };

/** The provider's own mail domains, where an alias of the account may live. */
export const PROVIDER_DOMAINS: Record<AccountPreset, readonly string[]> = {
  icloud: ["icloud.com", "me.com", "mac.com"],
  gmail: ["gmail.com", "googlemail.com"],
  other: [],
};

const lower = (address: string) => address.trim().toLowerCase();

function activeAliasesOf(accountId: string, aliases: AliasRow[]): AliasRow[] {
  return aliases
    .filter((row) => row.accountId === accountId && row.state === "active")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** The account's identities: its own address first, then its active aliases in creation order. */
export function identitiesOf(account: IdentityAccount, aliases: AliasRow[]): Identity[] {
  const primary: Identity = {
    accountId: account.id,
    address: lower(account.email),
    displayName: account.displayName,
    primary: true,
    signature: account.signature ?? null,
    sendCheck: "confirmed",
  };
  return [
    primary,
    ...activeAliasesOf(account.id, aliases).map((row) => ({
      accountId: account.id,
      address: lower(row.address),
      displayName: row.displayName ?? account.displayName,
      primary: false,
      signature: row.signature,
      sendCheck: row.sendCheck,
    })),
  ];
}

/** One account's own addresses: its email, its username when it holds `@`, its active aliases; lower case, no repeats. */
function addressesOf(account: IdentityAccount, aliases: AliasRow[]): string[] {
  const out = [lower(account.email)];
  if (account.username.includes("@")) out.push(lower(account.username));
  for (const row of activeAliasesOf(account.id, aliases)) out.push(lower(row.address));
  return [...new Set(out)];
}

/** Every address that is the owner's (never a reply-all recipient, never "new"). */
export function ownIdentityAddresses(accounts: IdentityAccount[], aliases: AliasRow[]): string[] {
  return [...new Set(accounts.flatMap((account) => addressesOf(account, aliases)))];
}

/** The owner's addresses per account (spec resolution 11). */
export function ownerAddressSets(accounts: IdentityAccount[], aliases: AliasRow[]): { id: string; addresses: string[] }[] {
  return accounts.map((account) => ({ id: account.id, addresses: addressesOf(account, aliases) }));
}

/** The draft's identity: null `fromAddress` is the own address; an address that is not an active identity gives null. */
export function identityOf(identities: Identity[], fromAddress: string | null): Identity | null {
  if (fromAddress === null) return identities.find((identity) => identity.primary) ?? null;
  const wanted = lower(fromAddress);
  return identities.find((identity) => identity.address === wanted) ?? null;
}

/**
 * Where a reply or forward starts from, among the source account's
 * identities: the original's From when it is one of them (own sent mail);
 * else the first identity, in order, found in its To, then its Cc, then its
 * Delivered-To / X-Original-To; else the own address.
 */
export function replyIdentity(source: ReplySource & { deliveredTo: string[] }, identities: Identity[]): Identity {
  const primary = identities.find((identity) => identity.primary) ?? identities[0];
  if (primary === undefined) throw new Error("An account has at least its own address");
  const byAddress = (addresses: string[]) => {
    const set = new Set(addresses.map(lower));
    return identities.find((identity) => set.has(identity.address)) ?? null;
  };
  return (
    byAddress([source.from.address]) ??
    byAddress(source.to.map((a) => a.address)) ??
    byAddress(source.cc.map((a) => a.address)) ??
    byAddress(source.deliveredTo) ??
    primary
  );
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Addresses that look like the owner's other addresses (spec
 * "Suggestions"): from messages that reached the mailbox with none of the
 * known addresses in To or Cc, their Delivered-To / X-Original-To when known,
 * else their To and Cc; a To/Cc candidate must share a domain with the
 * account's addresses or the provider's, which keeps other people on the
 * message out. At least two messages; the top ten by count, then latest date.
 */
export function aliasSuggestions(
  rows: InboundRow[],
  known: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
  ownDomains: readonly string[],
  providerDomains: readonly string[],
): AliasSuggestion[] {
  const knownLower = new Set([...known].map(lower));
  const dismissedLower = new Set([...dismissed].map(lower));
  const domains = new Set([...ownDomains, ...providerDomains].map(lower));
  const tally = new Map<string, AliasSuggestion>();
  for (const row of rows) {
    if ([...row.to, ...row.cc].some((address) => knownLower.has(lower(address)))) continue;
    const fromDelivery = row.deliveredTo !== null;
    const candidates = fromDelivery ? (row.deliveredTo as string[]) : [...row.to, ...row.cc];
    const seen = new Set<string>();
    for (const raw of candidates) {
      const parsed = parseAddress(raw);
      if (!parsed.ok) continue;
      const address = lower(parsed.value.address);
      if (seen.has(address) || knownLower.has(address) || dismissedLower.has(address)) continue;
      if (!fromDelivery && !domains.has(domainOf(address))) continue;
      seen.add(address);
      const entry = tally.get(address);
      if (entry === undefined) {
        tally.set(address, { address, count: 1, lastDate: row.date });
      } else {
        entry.count += 1;
        if (row.date > entry.lastDate) entry.lastDate = row.date;
      }
    }
  }
  return [...tally.values()]
    .filter((entry) => entry.count >= SUGGESTION_MIN_MESSAGES)
    .sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
    .slice(0, SUGGESTIONS_MAX);
}

/** An alias's check after SMTP accepted its first send: the server's Sent copy decides later, else accepted. */
export function sendCheckOnAccepted(sentCopy: SentCopyPolicy): "pending" | "accepted" {
  return sentCopy === "server" ? "pending" : "accepted";
}

/** A pending check from the Sent copy's From; null while that copy is not synced. */
export function resolveSendCheck(aliasAddress: string, sentFrom: string | null): "confirmed" | "rewritten" | null {
  if (sentFrom === null) return null;
  return lower(sentFrom) === lower(aliasAddress) ? "confirmed" : "rewritten";
}
