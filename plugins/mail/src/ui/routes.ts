// Locations inside the Mail page, as the subPath of its nav panel route.
//
// A view is `v/all/<role>` (a role merged across accounts) or
// `v/<accountId>/<folder path>` (one account's folder); an Inbox tab adds
// `/s/<tabId>` (Split Inbox). A conversation is
// `t/<accountId>/<threadId>`. A draft to open in the composer (from an
// agent's card) is `d/<draftId>`. Each id and path is percent-encoded
// here, so an id holding `/` stays one segment. The host encodes every
// segment once more on the way into the URL and hands the panel that form,
// so parsing undoes both layers. Ids without reserved characters (the usual
// case) pass through both layers unchanged.

import { settingsSectionOf, type SettingsSectionId } from "./settings/sections.ts";
import type { MailView, RoleName } from "./folder-list.tsx";

export interface ThreadLink {
  accountId: string;
  threadId: string;
  messageId?: string;
}

/** The subPath, as unencoded segments for `toPluginPanel`, of a conversation. */
export function threadSubPath(accountId: string, threadId: string, messageId?: string): string {
  const path = `t/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}`;
  return messageId === undefined ? path : `${path}/m/${encodeURIComponent(messageId)}`;
}

function decodeTwice(segment: string): string | null {
  try {
    const value = decodeURIComponent(decodeURIComponent(segment));
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** The conversation a panel subPath (as the host passes it) names; null for anything else. */
export function parseThreadSubPath(subPath: string): ThreadLink | null {
  const segments = subPath.split("/");
  if (segments[0] !== "t" || (segments.length !== 3 && (segments.length !== 5 || segments[3] !== "m"))) return null;
  const accountId = decodeTwice(segments[1]!);
  const threadId = decodeTwice(segments[2]!);
  if (accountId === null || threadId === null) return null;
  if (segments.length === 3) return { accountId, threadId };
  const messageId = decodeTwice(segments[4]!);
  return messageId === null ? null : { accountId, threadId, messageId };
}

/** The account segment of a merged role's view; account ids are generated UUIDs. */
const ALL_SEGMENT = "all";

const ROLE_SEGMENTS: ReadonlySet<string> = new Set<RoleName>([
  "inbox",
  "sent",
  "drafts",
  "junk",
  "trash",
  "archive",
]);

/** The subPath, as unencoded segments for `toPluginPanel`, of a view. */
export function viewSubPath(view: MailView): string {
  return view.kind === "role"
    ? `v/${ALL_SEGMENT}/${view.role}`
    : `v/${encodeURIComponent(view.accountId)}/${encodeURIComponent(view.path)}`;
}

/** The word between a view and its Inbox tab: `v/all/inbox/s/<tabId>` (Split Inbox). */
const TAB_SEGMENT = "s";

/** The subPath of a view on one of its Inbox tabs; null is the Inbox tab, the view itself. */
export function viewTabSubPath(view: MailView, tabId: string | null): string {
  return tabId === null ? viewSubPath(view) : `${viewSubPath(view)}/${TAB_SEGMENT}/${encodeURIComponent(tabId)}`;
}

/** The segments of a view's subPath, with or without a tab; null for anything else. */
function viewSegments(subPath: string): { accountId: string; second: string; tabId: string | null } | null {
  const segments = subPath.split("/");
  if (segments[0] !== "v" || (segments.length !== 3 && segments.length !== 5)) return null;
  const accountId = decodeTwice(segments[1]!);
  const second = decodeTwice(segments[2]!);
  if (accountId === null || second === null) return null;
  if (segments.length === 3) return { accountId, second, tabId: null };
  const tabId = decodeTwice(segments[4]!);
  return segments[3] === TAB_SEGMENT && tabId !== null ? { accountId, second, tabId } : null;
}

/** The view a panel subPath (as the host passes it) names, with or without a tab; null for anything else. */
export function parseViewSubPath(subPath: string): MailView | null {
  const parts = viewSegments(subPath);
  if (parts === null) return null;
  if (parts.accountId === ALL_SEGMENT) {
    return ROLE_SEGMENTS.has(parts.second) ? { kind: "role", role: parts.second as RoleName } : null;
  }
  return { kind: "folder", accountId: parts.accountId, path: parts.second };
}

/** The Inbox tab a view's subPath names; null for the Inbox tab and for anything that is not a view. */
export function parseViewTab(subPath: string): string | null {
  return parseViewSubPath(subPath) === null ? null : (viewSegments(subPath)?.tabId ?? null);
}

/** The subPath, as an unencoded segment for `toPluginPanel`, of a draft to open in the composer. */
export function draftSubPath(draftId: string): string {
  return `d/${encodeURIComponent(draftId)}`;
}

/** The draft a panel subPath (as the host passes it) names; null for anything else. */
export function parseDraftSubPath(subPath: string): string | null {
  const segments = subPath.split("/");
  if (segments.length !== 2 || segments[0] !== "d") return null;
  return decodeTwice(segments[1]!);
}

/** The Today and Tasks pages of the rail (slice 3f), Dev and Projects (slice 3g), Files (slice 3h), Archive (slice 3p). */
export type MailPageName = "today" | "tasks" | "dev" | "projects" | "files" | "archive" | "settings";

/** The subPath of a rail page; Projects is `p` (one project is `p/<projectId>`). */
export function pageSubPath(page: MailPageName): string {
  return page === "projects" ? "p" : page;
}

/** The rail page a panel subPath names; null for anything else. */
export function parsePageSubPath(subPath: string): MailPageName | null {
  if (subPath === "today" || subPath === "tasks" || subPath === "dev" || subPath === "files" || subPath === "archive") return subPath;
  if (subPath === "p" || parseProjectSubPath(subPath) !== null) return "projects";
  if (parseSettingsSubPath(subPath) !== null) return "settings";
  return null;
}

/** The subPath of the settings page, or of one of its sections. */
export function settingsSubPath(section?: SettingsSectionId): string {
  return section === undefined ? "settings" : `settings/${section}`;
}

/**
 * The settings section a panel subPath names; null when it is not a settings
 * address. A missing or unknown section opens the first one, so an old or
 * mistyped link never shows a blank page.
 */
export function parseSettingsSubPath(subPath: string): SettingsSectionId | null {
  const segments = subPath.split("/");
  if (segments[0] !== "settings" || segments.length > 2) return null;
  return settingsSectionOf(segments[1]);
}

/** The subPath, as unencoded segments for `toPluginPanel`, of one project's mail (slice 3g). */
export function projectSubPath(projectId: string): string {
  return `p/${encodeURIComponent(projectId)}`;
}

/** The project a panel subPath (as the host passes it) names; null for anything else. */
export function parseProjectSubPath(subPath: string): string | null {
  const segments = subPath.split("/");
  if (segments.length !== 2 || segments[0] !== "p") return null;
  return decodeTwice(segments[1]!);
}

/** The subPath, as an unencoded segment for `toPluginPanel`, of a saved search (slice 3h). */
export function savedSearchSubPath(savedSearchId: string): string {
  return `s/${encodeURIComponent(savedSearchId)}`;
}

/** The saved search a panel subPath (as the host passes it) names; null for anything else. */
export function parseSavedSearchSubPath(subPath: string): string | null {
  const segments = subPath.split("/");
  if (segments.length !== 2 || segments[0] !== "s") return null;
  return decodeTwice(segments[1]!);
}
