// Server search planning (slice 3h, #35): what one account's server is
// asked for a parsed query. Pure; the job adapter
// (src/adapters/bb/server-search-jobs.ts) runs the plan on read-only
// sessions and the gateway translates ServerCriteria into imapflow's
// SearchObject.
//
// Gmail is searched with X-GM-RAW on All Mail (`in:trash` and `in:spam` in
// those folders themselves, spec resolution 11). Other servers get IMAP
// criteria per folder. `has:` and `filename:` have no IMAP criterion and
// are applied to the fetched rows (`postFilter`); `list:`, `category:` and,
// off Gmail, `label:` are local only. Server criteria may be broader than
// the query: the rows are stored and the local search shows the exact hits.
import type { Folder, ParsedQuery, SearchCondition, SearchField, SpecialUse } from "./model.ts";

/** Mail's own search criteria; the gateway turns them into imapflow's. */
export type ServerCriteria = {
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** ISO date, INTERNALDATE on or after (one day of slack already applied). */
  since?: string;
  /** ISO date, INTERNALDATE before (one day of slack already applied). */
  before?: string;
  larger?: number;
  smaller?: number;
  seen?: boolean;
  flagged?: boolean;
  /** Each entry negated (`NOT`), ANDed with the rest. */
  not?: ServerCriteria[];
  /** Gmail's X-GM-RAW; used only when the session reports Gmail. */
  gmailRaw?: string;
  /** X-GM-THRID / THREADID (conversation loads on Gmail). */
  threadId?: string;
  /** Header matches, any of them (OR): conversation loads by References and Message-ID. */
  headers?: { name: string; value: string }[];
};

export type ServerSearchPlan =
  | { kind: "gmail"; runs: { folder: string; raw: string }[]; localOnly: SearchField[] }
  | { kind: "folders"; runs: { path: string; criteria: ServerCriteria }[]; skipped: number; localOnly: SearchField[] }
  | { kind: "refused"; refused: "nothing_to_search"; localOnly: SearchField[] };

/** Per account: folders searched, uids kept per folder, messages fetched per batch, time budget. */
export const SERVER_SEARCH_CAPS = { folders: 30, uidsPerFolder: 2000, batch: 50, accountMs: 60_000 } as const;

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const DAY_MS = 86_400_000;

/** What the list says about an operator the server did not use. */
export function localOnlyText(field: SearchField): string {
  // `is` and `has` are local only for the values Mail defines itself.
  if (field === "sender") return "from:vip, from:team and from:known are not used on the server";
  if (field === "is") return "is:dev, is:automated and is:newsletter are not used on the server";
  if (field === "has") return "has:invite is not used on the server";
  if (field === "ai") return "ai: labels live in Mail and are not used on the server";
  return `${field}: is not used on the server`;
}

/** A condition only Mail can judge: a sender set, the Dev and automated classes, an invitation. */
function mailOnly(condition: SearchCondition): boolean {
  return (
    condition.field === "sender" ||
    condition.field === "ai" ||
    (condition.field === "is" && (condition.value === "dev" || condition.value === "automated" || condition.value === "newsletter")) ||
    (condition.field === "has" && condition.value === "invite")
  );
}

function stripped(value: string): string {
  return value.replace(CONTROLS, "").replace(/"/g, "").trim();
}

function quoted(value: string): string {
  return `"${stripped(value)}"`;
}

const GMAIL_IN: Readonly<Record<string, string>> = {
  inbox: "in:inbox",
  sent: "in:sent",
  drafts: "in:drafts",
  junk: "in:spam",
  trash: "in:trash",
  snoozed: "in:snoozed",
};

/** One condition as a Gmail search term; null when it has none. */
function gmailTerm(condition: SearchCondition): string | null {
  if (mailOnly(condition)) return null;
  const sign = condition.negated ? "-" : "";
  const { field, value } = condition;
  switch (field) {
    case "from":
    case "to":
    case "cc":
    case "subject":
    case "filename":
    case "label":
      return stripped(value) === "" ? null : `${sign}${field}:${quoted(value)}`;
    case "has":
      return `${sign}has:attachment`;
    case "larger":
    case "smaller":
      return `${sign}${field}:${value}`;
    case "after":
    case "before":
      return `${sign}${field}:${value.replace(/-/g, "/")}`;
    case "is":
      return `${sign}${value === "unread" ? "is:unread" : "is:starred"}`;
    case "in": {
      if (value === "all") return null;
      // Gmail has no Archive folder: archived mail is mail not in the Inbox.
      if (value === "archive") return condition.negated ? "in:inbox" : "-in:inbox";
      const role = GMAIL_IN[value];
      if (role !== undefined) return `${sign}${role}`;
      return stripped(value) === "" ? null : `${sign}label:${quoted(value)}`;
    }
    default:
      // account (picks the accounts), list and category (local only).
      return null;
  }
}

/**
 * The X-GM-RAW query of the conditions and the free text: each value
 * stripped of `"` and control characters, then quoted; the free text as one
 * phrase. Several positive `in:` terms are ORed (`{a b}`).
 */
export function gmailRawOf(conditions: readonly SearchCondition[], text: string): string {
  const terms: string[] = [];
  const positiveIn: string[] = [];
  for (const condition of conditions) {
    const term = gmailTerm(condition);
    if (term === null) continue;
    if (condition.field === "in" && !condition.negated) positiveIn.push(term);
    else terms.push(term);
  }
  if (positiveIn.length === 1) terms.push(positiveIn[0]!);
  else if (positiveIn.length > 1) terms.push(`{${positiveIn.join(" ")}}`);
  const phrase = stripped(text);
  if (phrase !== "") terms.push(`"${phrase}"`);
  return terms.join(" ");
}

function localOnlyOf(conditions: readonly SearchCondition[], gmail: boolean): SearchField[] {
  const fields: SearchField[] = [];
  for (const condition of conditions) {
    const local =
      mailOnly(condition) || condition.field === "list" || condition.field === "category" || (!gmail && condition.field === "label");
    if (local && !fields.includes(condition.field)) fields.push(condition.field);
  }
  return fields;
}

function shiftDate(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** IMAP criteria for the conditions and text; `has:`, `filename:`, `in:` and the local-only fields add none. */
function criteriaOf(conditions: readonly SearchCondition[], text: string): ServerCriteria {
  const criteria: ServerCriteria = {};
  const not: ServerCriteria[] = [];
  const phrase = text.replace(CONTROLS, "").trim();
  if (phrase !== "") criteria.text = phrase;
  for (const condition of conditions) {
    if (mailOnly(condition)) continue;
    const { field, value, negated } = condition;
    switch (field) {
      case "from":
      case "to":
      case "cc":
      case "subject":
        if (negated) not.push({ [field]: value });
        else if (criteria[field] === undefined) criteria[field] = value;
        break;
      case "after":
        // Negated dates are left to the local search.
        if (!negated && criteria.since === undefined) criteria.since = shiftDate(value, -1);
        break;
      case "before":
        if (!negated && criteria.before === undefined) criteria.before = shiftDate(value, 1);
        break;
      case "larger":
      case "smaller":
        if (negated) not.push({ [field]: Number(value) });
        else if (criteria[field] === undefined) criteria[field] = Number(value);
        break;
      case "is":
        if (value === "unread") criteria.seen = negated;
        else criteria.flagged = !negated;
        break;
      default:
        break;
    }
  }
  if (not.length > 0) criteria.not = not;
  return criteria;
}

const DEFAULT_ROLES: readonly (SpecialUse | null)[] = ["inbox", "sent", "archive", null];

/** The folders an `in:` value names: a role's folders, else a path or name (case-insensitive). */
function foldersNamed(value: string, folders: readonly Folder[]): Folder[] {
  const role = value as SpecialUse;
  const byRole = folders.filter((f) => f.specialUse !== null && f.specialUse === role);
  if (byRole.length > 0) return byRole;
  const lower = value.toLowerCase();
  return folders.filter((f) => f.path.toLowerCase() === lower || f.name.toLowerCase() === lower);
}

/** The folders a non-Gmail search runs in, in order, before the cap. */
function searchFolders(conditions: readonly SearchCondition[], folders: readonly Folder[]): Folder[] {
  const selectable = folders.filter((f) => f.selectable);
  const named = conditions.filter((c) => c.field === "in" && !c.negated);
  let chosen: Folder[];
  if (named.length > 0) {
    chosen = [];
    for (const condition of named) {
      for (const f of foldersNamed(condition.value, selectable)) if (!chosen.includes(f)) chosen.push(f);
    }
  } else {
    chosen = DEFAULT_ROLES.flatMap((role) =>
      selectable
        .filter((f) => f.specialUse === role)
        .sort((a, b) => (role === null ? a.path.localeCompare(b.path) : 0)),
    );
  }
  const excluded = conditions
    .filter((c) => c.field === "in" && c.negated)
    .flatMap((c) => foldersNamed(c.value, selectable));
  return chosen.filter((f) => !excluded.includes(f));
}

const hasKeys = (criteria: ServerCriteria) => Object.keys(criteria).length > 0;

/**
 * The plan for one account. A query with nothing the server can use is
 * refused before any connection.
 */
export function planServerSearch(
  parsed: ParsedQuery,
  account: { gmail: boolean },
  folders: readonly Folder[],
): ServerSearchPlan {
  const localOnly = localOnlyOf(parsed.conditions, account.gmail);
  const refused: ServerSearchPlan = { kind: "refused", refused: "nothing_to_search", localOnly };
  const allMail = folders.find((f) => f.specialUse === "all" && f.selectable);

  if (account.gmail && allMail !== undefined) {
    const isSpecial = (c: SearchCondition) => c.field === "in" && !c.negated && (c.value === "trash" || c.value === "junk");
    const special = parsed.conditions.filter(isSpecial);
    const rest = parsed.conditions.filter((c) => !isSpecial(c));
    const base = gmailRawOf(rest.filter((c) => c.field !== "in" || c.negated), parsed.text);
    const otherIn = rest.filter((c) => c.field === "in" && !c.negated);
    const runs: { folder: string; raw: string }[] = [];
    for (const condition of special) {
      const target = folders.find((f) => f.specialUse === condition.value && f.selectable);
      if (target === undefined || runs.some((run) => run.folder === target.path)) continue;
      runs.push({ folder: target.path, raw: [gmailTerm(condition)!, base].filter((t) => t !== "").join(" ") });
    }
    if (special.length === 0 || otherIn.length > 0) {
      const raw = [gmailRawOf(otherIn, ""), base].filter((t) => t !== "").join(" ");
      if (raw !== "") runs.push({ folder: allMail.path, raw });
    }
    return runs.length === 0 ? refused : { kind: "gmail", runs, localOnly };
  }

  const criteria = criteriaOf(parsed.conditions, parsed.text);
  if (account.gmail) {
    // No All Mail in the listing (spec resolution 11): the folder list, with X-GM-RAW per folder.
    const raw = gmailRawOf(
      parsed.conditions.filter((c) => c.field !== "in"),
      parsed.text,
    );
    if (raw !== "") criteria.gmailRaw = raw;
  }
  if (!hasKeys(criteria)) return refused;
  const chosen = searchFolders(parsed.conditions, folders);
  if (chosen.length === 0) return refused;
  const kept = chosen.slice(0, SERVER_SEARCH_CAPS.folders);
  return {
    kind: "folders",
    runs: kept.map((f) => ({ path: f.path, criteria: structuredCopy(criteria) })),
    skipped: chosen.length - kept.length,
    localOnly,
  };
}

function structuredCopy(criteria: ServerCriteria): ServerCriteria {
  const copy: ServerCriteria = { ...criteria };
  if (criteria.not !== undefined) copy.not = criteria.not.map((entry) => ({ ...entry }));
  return copy;
}

/** `filename:`: an extension when the value has no dot, else a fragment (case-insensitive). */
export function filenameMatches(name: string, value: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerValue = value.toLowerCase();
  return lowerValue.includes(".") ? lowerName.includes(lowerValue) : lowerName.endsWith(`.${lowerValue}`);
}

/** What postFilter reads of a fetched row. */
export type PostFilterRow = { hasAttachments: boolean; filenames: readonly string[]; date: string | null };

/**
 * The conditions IMAP could not apply, on a fetched row: `has:`,
 * `filename:`, and the header date against `after` / `before` (the server
 * matched INTERNALDATE with a day of slack). A row without a date passes.
 */
export function postFilter(row: PostFilterRow, parsed: ParsedQuery): boolean {
  for (const condition of parsed.conditions) {
    if (mailOnly(condition)) continue;
    let match: boolean;
    switch (condition.field) {
      case "has":
        match = row.hasAttachments;
        break;
      case "filename":
        match = row.filenames.some((name) => filenameMatches(name, condition.value));
        break;
      case "after":
        if (row.date === null) continue;
        match = row.date.slice(0, 10) >= condition.value;
        break;
      case "before":
        if (row.date === null) continue;
        match = row.date.slice(0, 10) < condition.value;
        break;
      default:
        continue;
    }
    if (match === condition.negated) return false;
  }
  return true;
}
