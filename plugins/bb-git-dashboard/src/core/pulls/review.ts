// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// What a review may be submitted as. No I/O.

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** GitHub refuses Approve and Request changes on your own pull request. */
export function reviewEvents(viewer: string, author: string): ReviewEvent[] {
  return viewer === author ? ["COMMENT"] : ["COMMENT", "APPROVE", "REQUEST_CHANGES"];
}

/** Mirrors GitHub: changes need a reason, a comment review needs a body or line comments. */
export function canSubmitReview(event: ReviewEvent, body: string, pendingComments: number): boolean {
  if (event === "APPROVE") return true;
  if (event === "REQUEST_CHANGES") return body.trim() !== "";
  return body.trim() !== "" || pendingComments > 0;
}


