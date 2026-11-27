// The Branches list of a working copy, and the words of a merge or rebase preview. No I/O.

export type BranchRow = {ref: string; name: string; remote: boolean; target: string; worktree: string | null};
export type MergePreview = {incoming: number; outgoing: number; conflicts: string[]; fastForward: boolean; upToDate: boolean};

/** `for-each-ref --format=%(refname) %(objectname) %(worktreepath)` as rows; `refs/remotes/<remote>/HEAD` aliases are left out. */
export function branchRows(text: string): BranchRow[] {
  return text.split("\n").flatMap(line => {
    const match = /^(refs\/(heads|remotes)\/(\S+)) ([0-9a-f]{40,64}) ?(.*)$/.exec(line);
    if (!match || (match[2] === "remotes" && match[3]!.endsWith("/HEAD"))) return [];
    return [{ref: match[1]!, name: match[3]!, remote: match[2] === "remotes", target: match[4]!, worktree: match[5] || null}];
  });
}

const commits = (count: number) => count + (count === 1 ? " commit" : " commits");

/** What the confirmation says before a merge (`other` into `current`) or a rebase (`current` onto `other`). */
export function previewLines(kind: "merge" | "rebase", other: string, current: string, preview: MergePreview, fastForward: boolean): string[] {
  if (preview.upToDate) return [kind === "merge" ? current + " already contains " + other + ": nothing to merge." : current + " is already on " + other + ": nothing to rebase."];
  if (kind === "merge" && preview.fastForward && fastForward) return ["Fast-forward " + current + " to " + other + " (" + commits(preview.incoming) + ")"];
  const head = kind === "merge"
    ? "Merge " + other + " (" + commits(preview.incoming) + ") into " + current + (preview.fastForward ? " with a merge commit" : "")
    : "Rebase " + current + " (" + commits(preview.outgoing) + ") onto " + other + " (" + preview.incoming + " new " + (preview.incoming === 1 ? "commit" : "commits") + ")";
  // A rebase replays commit by commit; the preview merges the end results only, so for a rebase it is a likely outcome.
  const stops = kind === "merge" ? "The merge stops for you to resolve them." : "The rebase stops at each conflicting commit for you to resolve it.";
  if (kind === "rebase") return [head, preview.conflicts.length
    ? "Likely conflicts in " + preview.conflicts.length + (preview.conflicts.length === 1 ? " file: " : " files: ") + preview.conflicts.slice(0, 20).join(", ") +
      (preview.conflicts.length > 20 ? " and " + (preview.conflicts.length - 20) + " more" : "") + ". " + stops
    : "The branches merge without conflicts; a commit on the way may still stop the rebase."];
  return [head, preview.conflicts.length
    ? "Expected conflicts in " + preview.conflicts.length + (preview.conflicts.length === 1 ? " file: " : " files: ") + preview.conflicts.slice(0, 20).join(", ") +
      (preview.conflicts.length > 20 ? " and " + (preview.conflicts.length - 20) + " more" : "") + ". " + stops
    : "No conflicts expected."];
}
