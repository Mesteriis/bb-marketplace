// What My PRs shows of a row: the filter chips above the list and a row's states in words. No I/O.
import { isReady } from "../overview/items.ts";
import type { InboxPr } from "./model.ts";

export type InboxFilter = "ci-failed" | "conflict" | "changes" | "unanswered" | "ready";
export const inboxFilters: InboxFilter[] = ["ci-failed", "conflict", "changes", "unanswered", "ready"];
type Row = Pick<InboxPr, "ci" | "conflicts" | "reviewDecision" | "unresolvedThreads" | "isDraft" | "blockers" | "stackedOn" | "mergedAt" | "closedAt" | "notes">;
/** `note`: a forge's own reason with no common field (GitLab's "Needs rebase"), shown as the forge wrote it. */
export type RowState = {key: InboxFilter | "draft" | "stacked" | "ci-running" | "review" | "note"; n?: number; text?: string; tone: "bad" | "warn" | "good" | "line"};

const tests: Record<InboxFilter, (row: Row) => boolean> = {
  "ci-failed": row => row.ci === "failing",
  conflict: row => row.conflicts,
  changes: row => row.reviewDecision === "CHANGES_REQUESTED",
  unanswered: row => row.unresolvedThreads > 0,
  ready: row => isReady(row as InboxPr),
};

/** How many rows each chip would show. */
export const filterCounts = (rows: readonly Row[]) =>
  Object.fromEntries(inboxFilters.map(filter => [filter, rows.filter(tests[filter]).length])) as Record<InboxFilter, number>;
/** Whether a row shows under the chosen chip; every row without one. */
export const matchesFilter = (row: Row, filter: InboxFilter | null) => filter === null || tests[filter](row);

/** A row's states, the worst first: what failed, what someone must do, what it waits on; ready when nothing is in the way. */
export function rowStates(row: Row): RowState[] {
  if (row.mergedAt || row.closedAt) return [];
  const out: RowState[] = [];
  if (row.ci === "failing") out.push({key: "ci-failed", tone: "bad"});
  if (row.conflicts) out.push({key: "conflict", tone: "warn"});
  if (row.reviewDecision === "CHANGES_REQUESTED") out.push({key: "changes", tone: "warn"});
  if (row.isDraft) out.push({key: "draft", tone: "line"});
  if (row.stackedOn) out.push({key: "stacked", n: row.stackedOn.number, tone: "line"});
  if (row.ci === "pending") out.push({key: "ci-running", tone: "line"});
  if (row.unresolvedThreads > 0) out.push({key: "unanswered", n: row.unresolvedThreads, tone: "line"});
  for (const text of row.notes) out.push({key: "note", text, tone: "warn"});
  if (row.reviewDecision === "REVIEW_REQUIRED") out.push({key: "review", tone: "line"});
  if (!out.length && tests.ready(row)) out.push({key: "ready", tone: "good"});
  return out;
}
