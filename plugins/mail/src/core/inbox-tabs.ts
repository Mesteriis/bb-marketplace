// Inbox tabs (Split Inbox): a tab is a named search condition applied to the
// conversations of the Inbox. This file holds what the search language needs
// for them; the tabs themselves follow.
import { isPublicMailDomain } from "./blocking.ts";
import type { SearchCondition } from "./model.ts";
import { parseQuery } from "./search.ts";

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

// ---- Tabs ----

export const TABS_MAX = 12;
export const TAB_NAME_MAX = 40;
export const TAB_QUERY_MAX = 500;
/** The condition of the "Other" tab: conversations no other tab holds. Valid only as a whole query. */
export const OTHER_QUERY = "is:other";

export type InboxTab = { id: string; name: string; query: string; position: number };

/** What the store matches a tab by: every condition on one Inbox message, or no message matching any of the other tabs. */
export type TabMatch = { kind: "all"; conditions: SearchCondition[] } | { kind: "none"; of: SearchCondition[][] };

export type TabQueryProblem = "empty" | "free_text" | "unknown_operator" | "bad_value" | "too_long";

/**
 * A tab's condition as search conditions. A tab narrows the Inbox, so `in:`
 * has no meaning in it; free text would need the full-text index on every
 * listing, so a tab takes operators only.
 */
export function tabConditions(query: string, now: Date): { ok: true; conditions: SearchCondition[] } | { ok: false; reason: TabQueryProblem } {
  const text = query.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (text.length > TAB_QUERY_MAX) return { ok: false, reason: "too_long" };
  const parsed = parseQuery(text, now);
  const note = parsed.notes[0];
  if (note !== undefined) return { ok: false, reason: note.kind };
  if (parsed.text.trim() !== "") return { ok: false, reason: "free_text" };
  if (parsed.conditions.some((condition) => condition.field === "in")) return { ok: false, reason: "unknown_operator" };
  if (parsed.conditions.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, conditions: parsed.conditions };
}

/** Whether a query can be saved as a tab. */
export function tabQueryProblem(query: string, now: Date): TabQueryProblem | null {
  if (query.trim() === OTHER_QUERY) return null;
  const read = tabConditions(query, now);
  return read.ok ? null : read.reason;
}

/** The match of one tab among all of them; null when its condition no longer parses (the tab is shown as broken, empty). */
export function tabMatch(tab: InboxTab, all: readonly InboxTab[], now: Date): TabMatch | null {
  if (tab.query.trim() === OTHER_QUERY) {
    const of: SearchCondition[][] = [];
    for (const other of all) {
      if (other.id === tab.id || other.query.trim() === OTHER_QUERY) continue;
      const read = tabConditions(other.query, now);
      if (read.ok) of.push(read.conditions);
    }
    return { kind: "none", of };
  }
  const read = tabConditions(tab.query, now);
  return read.ok ? { kind: "all", conditions: read.conditions } : null;
}

/** Ready tabs: a name (a tx key) and a condition. */
export const TAB_LIBRARY: readonly { id: string; name: string; query: string }[] = [
  { id: "vip", name: "VIP", query: "from:vip" },
  { id: "team", name: "Team", query: "from:team" },
  { id: "people", name: "People", query: "from:known" },
  { id: "dev", name: "Dev", query: "is:dev" },
  { id: "newsletters", name: "Newsletters", query: "category:newsletters" },
  { id: "notifications", name: "Notifications", query: "is:automated" },
  { id: "calendar", name: "Calendar", query: "has:invite" },
  { id: "attachments", name: "Attachments", query: "has:attachment" },
  { id: "github", name: "GitHub", query: "from:github.com" },
  { id: "gitlab", name: "GitLab", query: "from:gitlab.com" },
  { id: "jira", name: "Jira", query: "from:atlassian.net" },
  { id: "linear", name: "Linear", query: "from:linear.app" },
  { id: "notion", name: "Notion", query: "from:notion.so" },
  { id: "asana", name: "Asana", query: "from:asana.com" },
  { id: "figma", name: "Figma", query: "from:figma.com" },
  { id: "google-docs", name: "Google Docs", query: "from:docs.google.com" },
  { id: "slack", name: "Slack", query: "from:slack.com" },
  { id: "other", name: "Other", query: OTHER_QUERY },
];

export class TabsFullError extends Error {
  constructor() {
    super("tabs full");
    this.name = "TabsFullError";
  }
}
