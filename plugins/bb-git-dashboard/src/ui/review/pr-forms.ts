import type { ReviewEvent } from "../../core/pulls/review.ts";

/**
 * What the pull request page's forms hold, kept by the page so a tab change does not drop it: the comment, the
 * description being edited, the reviewer to ask, the merge method, your review's summary and outcome, the threads shown.
 */
export type PrForms = {comment: string; description: string | null; reviewer: string; method: "merge" | "squash" | "rebase";
  summary: string; event: ReviewEvent; threads: "open" | "resolved" | "all" | null};
export const emptyForms: PrForms = {comment: "", description: null, reviewer: "", method: "merge", summary: "", event: "COMMENT", threads: null};

/** The forms after a write went through: only the form that made it starts again. */
export function afterWrite(forms: PrForms, kind: string): PrForms {
  switch (kind) {
    case "comment": return {...forms, comment: ""};
    case "editBody": return {...forms, description: null};
    case "requestReviewer": return {...forms, reviewer: ""};
    case "review": return {...forms, summary: "", event: "COMMENT"};
    default: return forms;
  }
}
