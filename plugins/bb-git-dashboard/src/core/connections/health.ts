/** How the Connections page says what a connected account can do, and which servers the projects folder's remotes use. */

type Kind = "github" | "gitlab" | "gitea" | "azure";
/** What a check of a stored account found: its login, how many repositories it sees, and what the server says of the token. */
export type AccountCheck =
  | {ok: true; login: string; repositories: number; more: boolean; scopes: string[] | null; expiresAt: string | null; version: string | null; checkedAt: string}
  | {ok: false; code: string};
export type Health =
  | {tone: "good"; state: "ok"}
  | {tone: "warn"; state: "limited"; missing: string}
  | {tone: "warn"; state: "expiring"; days: number}
  | {tone: "bad"; state: "expired"}
  | {tone: "bad"; state: "other-login"; login: string}
  | {tone: "bad"; state: "failed"; code: string};

const day = 86_400_000;
/** A token that ends within this many days is said to expire soon. */
const soon = 7;
/** The scope each forge needs for everything the plugin does; a token listing scopes without it works with a limit. */
const needed: Partial<Record<Kind, string>> = {github: "workflow", gitlab: "api"};

export function accountHealth(account: {kind: Kind; username: string}, check: AccountCheck, now: number): Health {
  if (!check.ok) return {tone: "bad", state: "failed", code: check.code};
  if (account.kind !== "azure" && check.login.toLowerCase() !== account.username.toLowerCase()) return {tone: "bad", state: "other-login", login: check.login};
  const ends = check.expiresAt ? Date.parse(check.expiresAt) : NaN;
  if (!Number.isNaN(ends) && ends <= now) return {tone: "bad", state: "expired"};
  if (!Number.isNaN(ends) && ends - now < soon * day) return {tone: "warn", state: "expiring", days: Math.max(1, Math.ceil((ends - now) / day))};
  const scope = needed[account.kind];
  if (scope && check.scopes && !check.scopes.includes(scope)) return {tone: "warn", state: "limited", missing: scope};
  return {tone: "good", state: "ok"};
}

export type RemoteHost = {host: string; repositories: number; kind: Kind | null; accounts: string[]};

/**
 * The servers of the projects folder's remotes (keys are host/path), with how many projects use each and the accounts
 * connected to that host. A host no account is on — an SSH alias among them — has no kind.
 */
export function remoteHosts(keys: readonly (string | null)[], accounts: readonly {id: string; kind: Kind; origin: string}[]): RemoteHost[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const host = key?.split("/")[0];
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const hostOf = (origin: string) => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ""; } };
  return [...counts].map(([host, repositories]) => {
    const own = accounts.filter(account => hostOf(account.origin) === host);
    return {host, repositories, kind: own[0]?.kind ?? null, accounts: own.map(account => account.id)};
  }).sort((left, right) => right.repositories - left.repositories || left.host.localeCompare(right.host));
}
