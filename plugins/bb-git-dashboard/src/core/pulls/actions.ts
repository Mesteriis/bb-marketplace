import { z } from "zod";

const text = z.string().trim().min(1).max(8000);
/** A repository-relative path, never escaping the repository. */
const filePath = z.string().min(1).max(1000).refine(value => !value.startsWith("/") && !value.split("/").some(part => part === ".." || part === ""), "INVALID_PATH");
const line = z.number().int().min(1).max(10_000_000);
const anchorShape = {path: filePath, line, side: z.enum(["LEFT", "RIGHT"]), startLine: line.nullable(), body: text,
  /** For an unchanged row: its line number on the other side (GitLab anchors such a row on both). */
  contextLine: line.nullable().optional(),
  /** A renamed file's old path, for a comment on its old side (GitLab names both paths). */
  oldPath: filePath.nullable().optional()};
const inRange = (value: {line: number; startLine: number | null}) => value.startLine === null || value.startLine <= value.line;
const anchor = z.object(anchorShape).refine(inRange, "INVALID_RANGE");

/** Every write on a pull request; each is previewed and confirmed against the head it was read with. */
export const prAction = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("comment"), body: text}),
  z.object({kind: z.literal("reply"), threadId: z.string().min(1).max(200), body: text}),
  z.object({kind: z.literal("resolve"), threadId: z.string().min(1).max(200), resolved: z.boolean()}),
  z.object({kind: z.literal("lineComment"), ...anchorShape}).refine(inRange, "INVALID_RANGE"),
  z.object({kind: z.literal("review"), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().max(8000), comments: z.array(anchor).max(50)}),
  z.object({kind: z.literal("requestReviewer"), reviewer: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/)}),
  z.object({kind: z.literal("editTitle"), title: z.string().trim().min(1).max(250)}),
  z.object({kind: z.literal("editBody"), body: z.string().max(60_000)}),
  z.object({kind: z.literal("draft"), draft: z.boolean()}),
  z.object({kind: z.literal("state"), open: z.boolean()}),
  z.object({kind: z.literal("merge"), method: z.enum(["merge", "squash", "rebase"])}),
  /** One of the viewer's own comments: on the discussion (`threadId` null) or in a review thread. */
  z.object({kind: z.literal("deleteComment"), commentId: z.string().min(1).max(200), threadId: z.string().min(1).max(200).nullable(), body: z.string().max(8000)}),
]);
export type PrAction = z.infer<typeof prAction>;
type About = {number: number; repo: string; headRefName: string; baseRefName: string};

const where = (value: {path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"}) =>
  value.path + (value.startLine !== null && value.startLine !== value.line ? " lines " + value.startLine + "–" + value.line : " line " + value.line) +
  (value.side === "LEFT" ? " (old)" : "");
const events = {COMMENT: "Review with comments", APPROVE: "Approve", REQUEST_CHANGES: "Request changes"} as const;
const methods = {merge: "Merge", squash: "Squash and merge", rebase: "Rebase and merge"} as const;

/** Preview lines of a write: what it does, then the text it sends. */
export function describePrAction(pr: About, action: PrAction): string[] {
  const name = pr.repo + " #" + pr.number;
  switch (action.kind) {
    case "comment": return ["Comment on " + name, action.body];
    case "reply": return ["Reply in a review thread on " + name, action.body];
    case "resolve": return [(action.resolved ? "Resolve" : "Unresolve") + " a review thread on " + name];
    case "lineComment": return ["Comment on " + where(action) + " of " + name, action.body];
    case "review": return [events[action.event] + " on " + name, ...(action.body.trim() ? [action.body] : []),
      ...action.comments.map(comment => where(comment) + ": " + comment.body)];
    case "requestReviewer": return ["Ask " + action.reviewer + " to review " + name];
    case "editTitle": return ["Rename " + name + " to “" + action.title + "”"];
    case "editBody": return ["Replace the description of " + name, action.body];
    case "draft": return [action.draft ? "Convert " + name + " to a draft" : "Mark " + name + " ready for review"];
    case "state": return [(action.open ? "Reopen " : "Close ") + name];
    case "merge": return [methods[action.method] + " " + name + ": " + pr.headRefName + " into " + pr.baseRefName];
    case "deleteComment": return ["Delete your comment" + (action.threadId ? " in a review thread" : "") + " on " + name, action.body];
  }
}
