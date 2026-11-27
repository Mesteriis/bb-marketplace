import { z } from "zod";
import { partial } from "../partial.ts";

export type IssueComment = {author: string; body: string; createdAt: string; url: string};
export type IssueDetail = {number: number; title: string; body: string; open: boolean; author: string; labels: string[]; url: string;
  createdAt: string; comments: IssueComment[];
  /** Set when a part of the issue (its comments) could not be read; the rest is shown. */
  notice: string | null};

/** A part of an issue read on its own: its failure leaves the issue readable with a notice. */
export const optional = <T>(read: Promise<T>, fallback: T) => partial(read, fallback, code => "Comments could not be read (" + code + ").");

const text = z.string().trim().min(1).max(60_000);
/** Every write on an issue; previewed and confirmed like pull request writes. */
export const issueAction = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("create"), title: z.string().trim().min(1).max(250), body: z.string().max(60_000)}),
  z.object({kind: z.literal("comment"), number: z.number().int().positive(), body: text}),
  z.object({kind: z.literal("state"), number: z.number().int().positive(), open: z.boolean()}),
]);
export type IssueAction = z.infer<typeof issueAction>;

export function describeIssueAction(repo: string, action: IssueAction): string[] {
  if (action.kind === "create") return ["Open an issue in " + repo + ": “" + action.title + "”", ...(action.body.trim() ? [action.body] : [])];
  if (action.kind === "comment") return ["Comment on " + repo + " issue #" + action.number, action.body];
  return [(action.open ? "Reopen " : "Close ") + repo + " issue #" + action.number];
}

/** Issues of one repository on one forge. */
export interface Issues {
  detail(number: number): Promise<IssueDetail>;
  /** The created issue's number for `create`, else the issue acted on. */
  act(action: IssueAction): Promise<{number: number}>;
}
