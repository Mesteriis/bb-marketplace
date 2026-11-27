/**
 * Moving around a Review: Find in the diff's lines, the order comments are stepped through, and what Go to offers.
 * Follows diff-review app/find.ts, app/comment-nav.tsx and app/goto-dialog.tsx (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md.
 */
import type { ReviewDiffFile } from "../../core/code-review/diff.ts";
import { describeLocation, GENERAL_PATH, type ReviewThread } from "../../core/code-review/model.ts";
import { displayRows } from "../../core/code-review/rows.ts";

/** A line of the diff that matches: its file and its index among that file's rows. */
export type Match = {path: string; row: number};
/** Most matches Find counts; it says "1000+" beyond. */
export const MAX_MATCHES = 1_000;

/** Every diff line (not hunk header) containing `query`, file by file in the view's order. */
export function findMatches(files: readonly ReviewDiffFile[], query: string, matchCase: boolean): Match[] {
  if (!query) return [];
  const wanted = matchCase ? query : query.toLowerCase();
  const matches: Match[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const rows = displayRows(file.patch);
    for (let row = 0; row < rows.length; row++) {
      if (rows[row].kind === "hunk") continue;
      const text = matchCase ? rows[row].text : rows[row].text.toLowerCase();
      if (text.includes(wanted)) { matches.push({path: file.path, row}); if (matches.length >= MAX_MATCHES) return matches; }
    }
  }
  return matches;
}

/** The step from `current` by `delta`, going round; -1 when there is nothing to step to. */
export function step(count: number, current: number, delta: 1 | -1): number {
  if (!count) return -1;
  return current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count;
}

/** The open threads in the order the Review shows them: the whole diff's first, then file by file, line by line. */
export function commentOrder(files: readonly ReviewDiffFile[], threads: readonly ReviewThread[]): string[] {
  const rank = new Map(files.map((file, index) => [file.path, index]));
  return threads.filter(thread => thread.status === "open")
    .map(thread => ({thread, file: thread.filePath === GENERAL_PATH ? -1 : rank.get(thread.filePath) ?? files.length}))
    .sort((a, b) => a.file - b.file || a.thread.startLine - b.thread.startLine || a.thread.createdAt - b.thread.createdAt)
    .map(entry => entry.thread.id);
}

export type GoToItem = {kind: "file"; path: string; label: string} | {kind: "comment"; id: string; label: string} | {kind: "view"; view: string; label: string};

/** What Go to offers for `query` (words in any order, any case): files, then comments, then views. */
export function goToItems(files: readonly ReviewDiffFile[], threads: readonly ReviewThread[], views: readonly {kind: string; label: string}[], query: string): GoToItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const fits = (text: string) => words.every(word => text.toLowerCase().includes(word));
  return [
    ...files.map(file => ({kind: "file" as const, path: file.path, label: file.path})),
    ...threads.map(thread => ({kind: "comment" as const, id: thread.id,
      label: describeLocation(thread) + " — " + (thread.comments[0]?.body.split("\n")[0].slice(0, 80) ?? "")})),
    ...views.map(view => ({kind: "view" as const, view: view.kind, label: "View: " + view.label})),
  ].filter(item => fits(item.label)).slice(0, 200);
}
