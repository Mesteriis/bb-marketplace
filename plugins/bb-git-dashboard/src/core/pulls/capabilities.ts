import type { Forge } from "./model.ts";

/** Pull request operations a forge may lack. Checked against each forge's API documentation on 2026-11-27. */
export type PullOperation = "comment" | "reply" | "resolve" | "lineComment" | "approve" | "requestChanges" | "requestReviewer" |
  "editTitle" | "editBody" | "draft" | "state" | "merge" | "patch";
export const pullOperations: PullOperation[] = ["comment", "reply", "resolve", "lineComment", "approve", "requestChanges", "requestReviewer",
  "editTitle", "editBody", "draft", "state", "merge", "patch"];

const limitations: Record<Forge, Partial<Record<PullOperation, string>>> = {
  github: {},
  gitlab: {requestChanges: "GitLab's API has no request-changes review; leave a comment or withhold approval."},
  gitea: {},
  azure: {
    lineComment: "Azure DevOps returns no line diff, so line comments are not offered; comment on the pull request instead.",
    patch: "Azure DevOps returns the changed files but no line diff.",
    draft: "Azure DevOps does not change the draft state through its update API.",
  },
};

export function pullLimitation(forge: Forge, operation: PullOperation): string | null {
  return limitations[forge][operation] ?? null;
}
export function pullCapabilities(forge: Forge): Record<PullOperation, boolean> {
  return Object.fromEntries(pullOperations.map(operation => [operation, pullLimitation(forge, operation) === null])) as Record<PullOperation, boolean>;
}

/** Merge methods a forge performs in one request. GitLab rebases as a separate step, so it offers merge and squash. */
export function mergeMethods(forge: Forge): ("merge" | "squash" | "rebase")[] {
  return forge === "gitlab" ? ["merge", "squash"] : ["merge", "squash", "rebase"];
}
