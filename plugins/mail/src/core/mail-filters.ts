// Filters (slice 3m, #65): owner-made matches over new incremental Inbox
// mail that sort it without an agent: move it to a folder, to the archive
// or to Trash, mark it read, flag it. Pure: validation, matching and the
// choice of the one filter that applies. The server queues the actions.
//
// A filter matches like a mail rule (every given field: sender addresses,
// sender domains, a mailing list id, whole subject words, accounts), but
// newsletters and other bulk mail match too: sorting them is what filters
// are for. The first matching filter in the list applies; the rest are not
// looked at. A message whose sender check failed is never sorted, so a
// forged sender cannot have mail filed away or marked read.
import { mailRuleMatches, validateRule, type RuleMatch } from "./mail-rules.ts";

export const FILTERS_MAX = 50;
export const FILTER_FOLDER_MAX = 1_000;

/** What a filter matches on: a mail rule's fields without the dev notification. */
export type FilterMatch = Omit<RuleMatch, "dev">;

export type FilterMove = "none" | "archive" | "trash" | "folder";

export type FilterActions = {
  move: FilterMove;
  /** The folder's path for `move: "folder"`; null otherwise. */
  folder: string | null;
  markRead: boolean;
  flag: boolean;
};

export type MailFilter = {
  id: string;
  name: string;
  enabled: boolean;
  match: FilterMatch;
  actions: FilterActions;
};

/** A new message as filters see it. */
export type FilterRow = {
  accountId: string;
  fromAddress: string;
  listId: string | null;
  subject: string;
  /** The stored sender check is `failed`: never sorted. */
  senderFailed?: boolean;
};

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * Whether a filter may be saved: a mail rule's name and match bounds, at
 * least one action, and for a move to a folder exactly one account (folder
 * paths belong to an account) and a path.
 */
export function validateFilter(input: {
  name: string;
  match: FilterMatch;
  actions: FilterActions;
}): { ok: true } | { ok: false; reason: string } {
  const match = input.match;
  const given = (list: readonly string[] | undefined) => list !== undefined && list.length > 0;
  const list = match.list !== undefined && match.list !== null && match.list.trim() !== "";
  if (!given(match.from) && !given(match.domains) && !list && !given(match.subjectWords)) {
    return fail("A filter needs a sender, domain, list or subject words to match");
  }
  const checked = validateRule({ name: input.name, match, template: "", mode: "prepare", projectId: "-" });
  // The bounds and their texts are a mail rule's, said about a filter.
  if (!checked.ok) return fail(checked.reason.replace(/\brule\b/g, "filter"));
  const { move, folder, markRead, flag } = input.actions;
  if (move === "none" && !markRead && !flag) return fail("A filter needs something to do");
  if (move === "folder") {
    if (folder === null || folder.trim() === "" || folder.length > FILTER_FOLDER_MAX || /[\r\n\u0000]/.test(folder)) {
      return fail("Choose a folder to move to");
    }
    if ((input.match.accounts ?? []).length !== 1) return fail("Moving to a folder needs one account chosen");
  } else if (folder !== null) {
    return fail("A folder goes with a move to a folder only");
  }
  return { ok: true };
}

export function filterMatches(filter: MailFilter, row: FilterRow): boolean {
  return mailRuleMatches(
    { id: filter.id, name: filter.name, enabled: filter.enabled, match: filter.match, projectId: "-", template: "", mode: "prepare" },
    { ...row, dev: null, bulk: false },
  );
}

/** The first enabled filter, in list order, that matches the message; null when none does. */
export function filterFor(filters: readonly MailFilter[], row: FilterRow): MailFilter | null {
  return filters.find((filter) => filterMatches(filter, row)) ?? null;
}

/** What a filter does, in words, for the list of filters. */
export function filterActionParts(actions: FilterActions): ("archive" | "trash" | "folder" | "read" | "flag")[] {
  return [
    ...(actions.move === "none" ? [] : [actions.move]),
    ...(actions.markRead ? (["read"] as const) : []),
    ...(actions.flag ? (["flag"] as const) : []),
  ];
}
