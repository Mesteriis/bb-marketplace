import type { GitAction, GitResult } from "../git.ts";

type File = NonNullable<GitResult["files"]>[number];

/** In the index: anything but unchanged or untracked there. */
export const inIndex = (file: File) => ![".", "?"].includes(file.index);
/** The same rule as the copy's Changes: unmerged, both added or both deleted. */
export const isConflict = (file: File) => file.index === "U" || file.worktree === "U" || ["AA", "DD"].includes(file.index + file.worktree);

/** A file's box in the panel's summary: puts it in the index, or takes it out of it. */
export function stageOfSummary(file: File): GitAction {
  return {kind: "stage", path: file.path, staged: inIndex(file)};
}

/**
 * The summary's Commit N: how many files are staged, and the commit of them against the status they were read with —
 * null while nothing is staged, the message is empty, the status has no snapshot or author, or a file is in conflict.
 */
export function commitOfSummary(state: GitResult, message: string): {staged: number; action: GitAction | null} {
  const files = state.files ?? [];
  const staged = files.filter(inIndex).length;
  const ready = staged > 0 && !!message.trim() && !!state.snapshot && !!state.author && !files.some(isConflict);
  return {staged, action: ready ? {kind: "commit", expected: state.snapshot!, message} : null};
}
