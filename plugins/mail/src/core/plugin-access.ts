// What the owner lets other plugins have (the plugin API): rights, grants,
// a plugin's request for them, and the daily limits. Pure; the store keeps
// the rows. A grant is one plugin, one right, one account: a new account is
// not covered by old grants.

export const PLUGIN_RIGHTS = [
  "mail.read",
  "contacts.read",
  "invites.read",
  "mail.propose",
  "google.calendar",
  "google.contacts",
] as const;
export type PluginRight = (typeof PLUGIN_RIGHTS)[number];

export type GoogleRight = "google.calendar" | "google.contacts";

/** The one Google scope a right stands for. None of them reads mail. */
export const GOOGLE_RIGHT_SCOPE = {
  "google.calendar": "https://www.googleapis.com/auth/calendar",
  "google.contacts": "https://www.googleapis.com/auth/contacts",
} as const satisfies Record<GoogleRight, string>;

/** The scopes a sign-in may add to mail for plugin keys. */
export const GOOGLE_EXTRA_SCOPES = [GOOGLE_RIGHT_SCOPE["google.calendar"], GOOGLE_RIGHT_SCOPE["google.contacts"]] as const;

export function isPluginRight(value: string): value is PluginRight {
  return (PLUGIN_RIGHTS as readonly string[]).includes(value);
}

export function isGoogleRight(right: string): right is GoogleRight {
  return right === "google.calendar" || right === "google.contacts";
}

export type PluginGrant = { pluginId: string; right: PluginRight; accountId: string; grantedAt: string };
export type PluginRequest = { pluginId: string; rights: PluginRight[]; reason: string; askedAt: string };

/** A plugin id is shown and stored as text; longer ones are refused. */
export const PLUGIN_ID_MAX = 128;
export const REQUEST_REASON_MAX = 200;
export const REQUESTS_PER_DAY = 5;
export const PROPOSALS_PER_DAY = 20;

export function hasRight(grants: readonly PluginGrant[], pluginId: string, right: PluginRight, accountId: string): boolean {
  return grants.some((grant) => grant.pluginId === pluginId && grant.right === right && grant.accountId === accountId);
}

/** The accounts a plugin holds a right for, in the grants' order. */
export function grantedAccounts(grants: readonly PluginGrant[], pluginId: string, right: PluginRight): string[] {
  return grants.filter((grant) => grant.pluginId === pluginId && grant.right === right).map((grant) => grant.accountId);
}

/** A request as it is kept: known rights once each, the reason as one bounded line. */
export function cleanRequest(input: {
  rights: readonly string[];
  reason: string;
}): { ok: true; rights: PluginRight[]; reason: string } | { ok: false } {
  const rights: PluginRight[] = [];
  for (const right of input.rights) {
    if (!isPluginRight(right)) return { ok: false };
    if (!rights.includes(right)) rights.push(right);
  }
  if (rights.length === 0) return { ok: false };
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, REQUEST_REASON_MAX);
  return { ok: true, rights, reason };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `limit` or more of the times fall in the 24 hours before `now`. */
export function overDailyLimit(timesIso: readonly string[], now: Date, limit: number): boolean {
  const from = now.getTime() - DAY_MS;
  return timesIso.filter((time) => Date.parse(time) > from).length >= limit;
}
