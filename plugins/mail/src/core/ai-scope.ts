// AI access scope (slice 3f): which mail agents and model calls may see.
// Per account all folders, chosen folders or none; Spam and Trash never;
// excluded senders and domains over their whole correspondence (From, To,
// Cc and every conversation holding such a message, spec resolution 1).
// Pure: the store computes the excluded conversations and applies the same
// rule in SQL (resolution 12).
import { toAsciiDomain } from "./compose-address.ts";
import type { SpecialUse } from "./model.ts";

export type AccountScope = { mode: "all" } | { mode: "folders"; folders: string[] } | { mode: "none" };

export type AiScope = {
  /** Absent account = { mode: "all" }. */
  accounts: ReadonlyMap<string, AccountScope>;
  /** Lower case; domains in ASCII. */
  senders: { addresses: ReadonlySet<string>; domains: ReadonlySet<string> };
};

/** One stored message row as the scope reads it. */
export type ScopeRow = {
  accountId: string;
  folder: string;
  folderRole: SpecialUse | null;
  fromAddress: string;
  to: string[];
  cc: string[];
  threadId: string | null;
};

/** Most excluded senders and domains together. */
export const AI_SCOPE_SENDERS_MAX = 1_000;

/** Everything shared: no account rule and no excluded sender. */
export const OPEN_AI_SCOPE: AiScope = { accounts: new Map(), senders: { addresses: new Set(), domains: new Set() } };

/** Roles never in scope, whatever the account mode. */
const NEVER_ROLES: ReadonlySet<SpecialUse> = new Set(["junk", "trash"]);

/** An address in the stored form (lower case, ASCII domain), or null when it is not one. */
function normalizeAddress(address: string): { address: string; domain: string } | null {
  const text = address.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return null;
  let domain: string;
  try {
    domain = toAsciiDomain(text.slice(at + 1).replace(/\.$/, ""));
  } catch {
    return null;
  }
  return { address: `${text.slice(0, at)}@${domain}`, domain };
}

/** Whether any address is excluded: the address exactly, or its domain or a parent domain, label by label. */
export function senderExcluded(addresses: readonly string[], scope: AiScope): boolean {
  const { addresses: excludedAddresses, domains } = scope.senders;
  if (excludedAddresses.size === 0 && domains.size === 0) return false;
  for (const raw of addresses) {
    const normalized = normalizeAddress(raw);
    if (normalized === null) continue;
    if (excludedAddresses.has(normalized.address)) return true;
    if (domains.size === 0) continue;
    const labels = normalized.domain.split(".");
    for (let i = 0; i < labels.length; i++) {
      if (domains.has(labels.slice(i).join("."))) return true;
    }
  }
  return false;
}

/**
 * Whether agents and model calls may see this row. `excludedThreads` holds
 * the conversations that contain mail of an excluded sender (computed by the
 * store from the sender rules).
 */
export function inAiScope(row: ScopeRow, scope: AiScope, excludedThreads: ReadonlySet<string>): boolean {
  if (row.folderRole !== null && NEVER_ROLES.has(row.folderRole)) return false;
  const account = scope.accounts.get(row.accountId) ?? { mode: "all" };
  if (account.mode === "none") return false;
  if (account.mode === "folders" && !account.folders.includes(row.folder)) return false;
  if (row.threadId !== null && excludedThreads.has(row.threadId)) return false;
  return !senderExcluded([row.fromAddress, ...row.to, ...row.cc], scope);
}

/**
 * Chosen folder paths a current listing no longer holds (renamed or gone on
 * the server): they match nothing, so the scope fails closed; the settings
 * view shows them as "not found". An account without a listing is all stale.
 */
export function staleScopeFolders(
  scope: AiScope,
  listings: ReadonlyMap<string, readonly string[]>,
): { accountId: string; path: string }[] {
  const out: { accountId: string; path: string }[] = [];
  for (const [accountId, account] of scope.accounts) {
    if (account.mode !== "folders") continue;
    const listed = new Set(listings.get(accountId) ?? []);
    for (const path of account.folders) if (!listed.has(path)) out.push({ accountId, path });
  }
  return out;
}
