// Locations inside the Mail page, as the subPath of its nav panel route.
//
// A conversation is `t/<accountId>/<threadId>`. Each id is percent-encoded
// here, so an id holding `/` stays one segment. The host encodes every
// segment once more on the way into the URL and hands the panel that form,
// so parsing undoes both layers. Ids without reserved characters (the usual
// case) pass through both layers unchanged.

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
