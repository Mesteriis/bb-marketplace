import type { Account } from "../providers.ts";
import type { Detection } from "./resolve.ts";

export type GithubFacts = {
  orgs(accountId: string): Promise<string[]>;
  canSee(accountId: string, path: string): Promise<boolean>;
};
export type AccountChoice = {
  chosen: string | null;
  candidates: string[];
  reason: "owner" | "organization" | "visible" | "host" | "ambiguous" | "none";
};

function serverOf(origin: string) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "api.github.com" ? "github.com" : host;
  } catch { return ""; }
}

async function holds(rule: (account: Account) => Promise<boolean>, account: Account) {
  try { return await rule(account); } catch { return false; }
}

/** Chooses the account for a repository; never guesses between equally fitting accounts. */
export async function pickAccount(detection: Detection, path: string, accounts: Account[], facts: GithubFacts): Promise<AccountChoice> {
  if (!detection.kind || !detection.origin) return {chosen: null, candidates: [], reason: "none"};
  const server = serverOf(detection.origin);
  const pool = accounts.filter(account => account.kind === detection.kind && serverOf(account.origin) === server);
  const candidates = pool.map(account => account.id);
  if (!pool.length) return {chosen: null, candidates, reason: "none"};
  if (detection.kind !== "github") {
    return pool.length === 1 ? {chosen: pool[0].id, candidates, reason: "host"} : {chosen: null, candidates, reason: "ambiguous"};
  }

  const owner = path.split("/")[0].toLowerCase();
  const rules: [AccountChoice["reason"], (account: Account) => Promise<boolean>][] = [
    ["owner", async account => account.username.toLowerCase() === owner],
    ["organization", async account => (await facts.orgs(account.id)).some(org => org.toLowerCase() === owner)],
    ["visible", account => facts.canSee(account.id, path)],
  ];
  let remaining = pool;
  for (const [reason, rule] of rules) {
    const matches: Account[] = [];
    for (const account of remaining) if (await holds(rule, account)) matches.push(account);
    if (matches.length === 1) return {chosen: matches[0].id, candidates, reason};
    if (matches.length > 1) remaining = matches;
  }
  return remaining.length === 1 ? {chosen: remaining[0].id, candidates, reason: "host"} : {chosen: null, candidates, reason: "ambiguous"};
}
