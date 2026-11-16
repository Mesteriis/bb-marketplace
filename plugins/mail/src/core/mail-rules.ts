// Mail rules (slice 3g, #82): owner-made matches over new incremental Inbox
// mail that prepare (or, opted in per rule, start) a capped agent thread.
// Pure: validation, matching, the candidate set and the cap verdict; the
// store counts and inserts runs in one transaction, the server spawns.
import { DEV_KINDS, DEV_SOURCES, DEV_STATES, normalizeListId, type DevClass, type DevKind, type DevSource, type DevState } from "./dev-notify.ts";

export const RULES_MAX = 50;
export const RULE_NAME_MAX = 80;
export const RULE_TEMPLATE_MAX = 4_000;
export const RULE_FROM_MAX = 20;
export const RULE_DOMAINS_MAX = 20;
export const RULE_WORDS_MAX = 10;
export const RULE_ACCOUNTS_MAX = 50;
const ADDRESS_MAX = 254;
const DOMAIN_MAX = 253;
const WORD_MAX = 50;
const REPO_MAX = 200;

/** Starts per rule per hour and per day, and per day for all rules together (one per conversation per rule per day besides). */
export const RULE_CAPS = { perRuleHour: 3, perRuleDay: 10, allDay: 20 } as const;
/** Ready runs nobody acted on expire after this many days. */
export const RULE_READY_DAYS = 7;
/** Runs are kept (and counted) this many days, deleted rules' runs included. */
export const RULE_RUNS_KEEP_DAYS = 30;
/** A rule thread stays gated this long after it started (review C1), whatever happens to its mail. */
export const RULE_THREADS_KEEP_DAYS = 180;

export type RuleDevMatch = { source?: DevSource; repo?: string; kind?: DevKind; state?: DevState };

/** Every given field must match; `accounts` empty or absent means every account. */
export type RuleMatch = {
  from?: string[];
  domains?: string[];
  list?: string | null;
  subjectWords?: string[];
  dev?: RuleDevMatch | null;
  accounts?: string[];
};

export type RuleMode = "prepare" | "start";

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  projectId: string;
  template: string;
  mode: RuleMode;
};

/** A new message as rules see it. */
export type RuleRow = {
  accountId: string;
  fromAddress: string;
  listId: string | null;
  subject: string;
  dev: DevClass | null;
  bulk: boolean;
  /**
   * Slice 3i: the stored sender check is `failed`. Such a message never
   * matches, whatever the rule matches on (part A decision 5). Optional
   * until the server passes it (plan Task 7).
   */
  senderFailed?: boolean;
};

const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const WORD = /^[\p{L}\p{N}_]+$/u;

function hasDev(dev: RuleDevMatch | null | undefined): dev is RuleDevMatch {
  return dev !== null && dev !== undefined && (dev.source !== undefined || dev.repo !== undefined || dev.kind !== undefined || dev.state !== undefined);
}

function nonEmpty<T>(list: readonly T[] | undefined): list is readonly T[] {
  return list !== undefined && list.length > 0;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * Whether a rule may be saved: a name of 1 to 80 characters, a template of
 * at most 4 000, at least one of from, domains, list, subject words or dev,
 * each within its bounds, and the owner's confirmation for start mode.
 */
export function validateRule(input: {
  name: string;
  match: RuleMatch;
  template: string;
  mode: RuleMode;
  projectId: string;
  confirmedStart?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const name = input.name.trim();
  if (name === "" || Array.from(name).length > RULE_NAME_MAX) return fail("A rule needs a name of up to 80 characters");
  if (input.template.length > RULE_TEMPLATE_MAX) return fail("The instruction is longer than 4 000 characters");
  if (input.projectId.trim() === "") return fail("Choose a project");
  const match = input.match;
  const from = match.from ?? [];
  if (from.length > RULE_FROM_MAX) return fail("A rule takes up to 20 addresses");
  if (from.some((address) => address.length > ADDRESS_MAX || !ADDRESS.test(address.trim()))) return fail("An address is not valid");
  const domains = match.domains ?? [];
  if (domains.length > RULE_DOMAINS_MAX) return fail("A rule takes up to 20 domains");
  if (domains.some((domain) => domain.length > DOMAIN_MAX || !DOMAIN.test(domain.trim().toLowerCase()))) return fail("A domain is not valid");
  const words = match.subjectWords ?? [];
  if (words.length > RULE_WORDS_MAX) return fail("A rule takes up to 10 subject words");
  if (words.some((word) => word.length > WORD_MAX || !WORD.test(word))) return fail("Subject words are single words");
  if (match.list !== undefined && match.list !== null && normalizeListId(match.list) !== match.list.trim().toLowerCase()) {
    return fail("The list id is not valid");
  }
  if ((match.accounts ?? []).length > RULE_ACCOUNTS_MAX) return fail("Too many accounts");
  const dev = match.dev;
  if (dev !== null && dev !== undefined) {
    if (dev.source !== undefined && !DEV_SOURCES.includes(dev.source)) return fail("The notification source is not valid");
    if (dev.kind !== undefined && !DEV_KINDS.includes(dev.kind)) return fail("The notification kind is not valid");
    if (dev.state !== undefined && !DEV_STATES.includes(dev.state)) return fail("The notification state is not valid");
    if (dev.repo !== undefined && (dev.repo.trim() === "" || dev.repo.length > REPO_MAX)) return fail("The repository is not valid");
  }
  const list = match.list !== undefined && match.list !== null && match.list.trim() !== "";
  if (!nonEmpty(from) && !nonEmpty(domains) && !list && !nonEmpty(words) && !hasDev(dev)) {
    return fail("A rule needs a sender, domain, list, subject words or notification to match");
  }
  if (input.mode === "start" && input.confirmedStart !== true) {
    return fail("Starting threads by itself needs your confirmation");
  }
  return { ok: true };
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

function subjectWords(subject: string): Set<string> {
  return new Set([...subject.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0]));
}

function devMatches(want: RuleDevMatch, dev: DevClass | null): boolean {
  if (dev === null) return false;
  if (want.source !== undefined && want.source !== dev.source) return false;
  if (want.kind !== undefined && want.kind !== dev.kind) return false;
  if (want.state !== undefined && want.state !== dev.state) return false;
  if (want.repo !== undefined && want.repo.trim().toLowerCase() !== (dev.repo ?? "").toLowerCase()) return false;
  return true;
}

/**
 * Whether an enabled rule matches a new message: every given field, words
 * whole and case-folded, a domain equal or a parent; bulk mail only for a
 * rule that matches on dev or list; never a message whose sender check
 * failed (slice 3i).
 */
export function mailRuleMatches(rule: Rule, row: RuleRow): boolean {
  if (!rule.enabled || row.senderFailed === true) return false;
  const match = rule.match;
  const from = match.from ?? [];
  const domains = match.domains ?? [];
  const words = match.subjectWords ?? [];
  const list = match.list === undefined || match.list === null || match.list.trim() === "" ? null : match.list.trim().toLowerCase();
  const dev = hasDev(match.dev) ? match.dev : null;
  if (from.length === 0 && domains.length === 0 && words.length === 0 && list === null && dev === null) return false;
  if (row.bulk && dev === null && list === null) return false;
  if (nonEmpty(match.accounts) && !match.accounts.includes(row.accountId)) return false;
  const address = row.fromAddress.trim().toLowerCase();
  if (from.length > 0 && !from.some((entry) => entry.trim().toLowerCase() === address)) return false;
  if (domains.length > 0) {
    const domain = domainOf(address);
    const fits = domains.some((entry) => {
      const base = entry.trim().toLowerCase();
      return domain === base || domain.endsWith(`.${base}`);
    });
    if (!fits) return false;
  }
  if (list !== null && row.listId !== list) return false;
  if (words.length > 0) {
    const have = subjectWords(row.subject);
    if (!words.every((word) => have.has(word.toLowerCase()))) return false;
  }
  if (dev !== null && !devMatches(dev, row.dev)) return false;
  return true;
}

/**
 * The rows rules look at after an ok round: newInbox minus returning
 * (spec resolution 3). `inserted` is never read, so backfill, an initial
 * sync, a reset or a re-sync never prepare or start anything.
 */
export function ruleCandidates(outcome: { newInbox: readonly string[]; returning: readonly string[] }): string[] {
  const returning = new Set(outcome.returning);
  return outcome.newInbox.filter((id) => !returning.has(id));
}

/** Counts of starting and started runs before this one: the rule's in the last hour and day, all rules' in the day, this conversation's for this rule in 24 hours. */
export type RuleRunCounts = { ruleHour: number; ruleDay: number; allDay: number; conversationDay: number };

/** "ok" below every cap, else "capped". */
export function capVerdict(
  counts: RuleRunCounts,
  caps: { perRuleHour: number; perRuleDay: number; allDay: number } = RULE_CAPS,
): "ok" | "capped" {
  return counts.ruleHour < caps.perRuleHour &&
    counts.ruleDay < caps.perRuleDay &&
    counts.allDay < caps.allDay &&
    counts.conversationDay < 1
    ? "ok"
    : "capped";
}

/** A rule over alerts or monitoring mail: its runs go through the incident dedup (spec resolution 13). */
export function alertClass(rule: Pick<Rule, "match">): boolean {
  const dev = rule.match.dev;
  return dev !== null && dev !== undefined && (dev.kind === "alert" || dev.source === "monitoring");
}
