// Older mail (slice 3h, #34): the date ranges "Load 30 more days" fetches,
// where loaded history ends after a step, the header searches that load a
// whole conversation, and which uids a job may insert (spec resolution 6:
// a job never inserts a uid above the folder's last_uid, and skips a folder
// that was never synced or whose UIDVALIDITY changed, so it never hides new
// mail from the next sync round). Pure.

/** At most this many new messages are fetched per history step. */
export const HISTORY_STEP_MAX = 500;
/** At most this many messages are fetched for one conversation. */
export const CONVERSATION_MAX = 100;
/** At most this many Message-IDs are searched for one conversation. */
export const CONVERSATION_IDS_MAX = 50;
/** Empty steps in a row before the list says there is no older mail. */
export const HISTORY_EMPTY_STEPS = 3;

const DAY_MS = 86_400_000;

export type HistoryRange = { from: string; before: string };

/** The next step: `stepDays` before the loaded history (or the window when none). */
export function historyRange(state: { historySince: string | null; syncedSince: string }, stepDays: number): HistoryRange {
  const before = state.historySince ?? state.syncedSince;
  return { from: new Date(Date.parse(before) - stepDays * DAY_MS).toISOString(), before };
}

/**
 * Where loaded history starts after a step: the range start when the step
 * fetched all of its new messages (or none), else the oldest fetched
 * message's date, so the next step continues from there.
 */
export function nextHistorySince(range: HistoryRange, fetchedOldest: string | null, newCount: number): string {
  if (newCount <= HISTORY_STEP_MAX || fetchedOldest === null) return range.from;
  return fetchedOldest;
}

/** The list's note after `count` empty steps in a row, or null. */
export function emptyStepsNote(count: number): string | null {
  return count >= HISTORY_EMPTY_STEPS ? "No older mail on the server in this folder" : null;
}

export type ConversationSearch =
  | { kind: "gmail"; threadId: string }
  | { kind: "headers"; searches: { header: "References" | "Message-ID"; value: string }[] };

/** How to find the rest of a conversation on the server. */
export function conversationSearches(thread: {
  messageIds: readonly string[];
  refs: readonly string[];
  gmThrid: string | null;
}): ConversationSearch {
  if (thread.gmThrid !== null && thread.gmThrid !== "") return { kind: "gmail", threadId: thread.gmThrid };
  const ids: string[] = [];
  for (const id of [...thread.messageIds, ...thread.refs]) {
    const value = id.trim();
    if (value !== "" && !ids.includes(value)) ids.push(value);
    if (ids.length === CONVERSATION_IDS_MAX) break;
  }
  return {
    kind: "headers",
    searches: ids.flatMap((value) => [
      { header: "References" as const, value },
      { header: "Message-ID" as const, value },
    ]),
  };
}

export type JobSkipReason = "not_synced" | "changed";

/** The uids a job may insert into a folder, and how many it skips. */
export function jobInsertable(
  uids: readonly number[],
  state: { uidValidity: number; lastUid: number } | null,
  sessionUidValidity: number,
): { uids: number[]; skipped: number; reason?: JobSkipReason } {
  if (state === null) return { uids: [], skipped: uids.length, reason: "not_synced" };
  if (state.uidValidity !== sessionUidValidity) return { uids: [], skipped: uids.length, reason: "changed" };
  const kept = uids.filter((uid) => uid <= state.lastUid);
  return { uids: kept, skipped: uids.length - kept.length };
}
