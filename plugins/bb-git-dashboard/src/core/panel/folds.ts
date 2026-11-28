/** The parts of the Git panel's summary. */
export type Part = "changes" | "pull" | "ci" | "review" | "history";
const parts: Part[] = ["changes", "pull", "ci", "review", "history"];

/** Which parts are folded, kept for the browser tab's life: the next panel opens as the last one was left. */
export function foldMemory(initiallyFolded: Part[]) {
  const folded = new Set<Part>(initiallyFolded);
  return {
    /** The parts a new panel opens with. */
    open: () => new Set(parts.filter(part => !folded.has(part))),
    /** Folds an open part or opens a folded one, remembers it, and gives the parts open now. */
    toggle(open: ReadonlySet<Part>, part: Part): Set<Part> {
      const next = new Set(open);
      if (next.has(part)) { next.delete(part); folded.add(part); } else { next.add(part); folded.delete(part); }
      return next;
    },
  };
}
