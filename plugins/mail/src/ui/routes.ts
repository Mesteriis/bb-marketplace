// Locations inside the Mail page, as the subPath of its nav panel route.
//
// A view is `v/all/<role>` (a role merged across accounts) or
// `v/<accountId>/<folder path>` (one account's folder). A conversation is
// `t/<accountId>/<threadId>`. A draft to open in the composer (from an
// agent's card) is `d/<draftId>`. Each id and path is percent-encoded
// here, so an id holding `/` stays one segment. The host encodes every
// segment once more on the way into the URL and hands the panel that form,
// so parsing undoes both layers. Ids without reserved characters (the usual
// case) pass through both layers unchanged.

import type { MailView, RoleName } from "./folder-list.tsx";

export interface ThreadLink {
  accountId: string;
  threadId: string;
}

/** The subPath, as unencoded segments for `toPluginPanel`, of a conversation. */
export function threadSubPath(accountId: string, threadId: string): string {
  return `t/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}`;
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
  if (segments.length !== 3 || segments[0] !== "t") return null;
  const accountId = decodeTwice(segments[1]!);
  const threadId = decodeTwice(segments[2]!);
  if (accountId === null || threadId === null) return null;
  return { accountId, threadId };
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

/** The view a panel subPath (as the host passes it) names; null for anything else. */
export function parseViewSubPath(subPath: string): MailView | null {
  const segments = subPath.split("/");
  if (segments.length !== 3 || segments[0] !== "v") return null;
  const accountId = decodeTwice(segments[1]!);
  const second = decodeTwice(segments[2]!);
  if (accountId === null || second === null) return null;
  if (accountId === ALL_SEGMENT) {
    return ROLE_SEGMENTS.has(second) ? { kind: "role", role: second as RoleName } : null;
  }
  return { kind: "folder", accountId, path: second };
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

/** The Today and Tasks pages of the rail (slice 3f). */
export type MailPageName = "today" | "tasks";

/** The subPath of the Today or Tasks page. */
export function pageSubPath(page: MailPageName): string {
  return page;
}

/** The Today or Tasks page a panel subPath names; null for anything else. */
export function parsePageSubPath(subPath: string): MailPageName | null {
  return subPath === "today" || subPath === "tasks" ? subPath : null;
}
