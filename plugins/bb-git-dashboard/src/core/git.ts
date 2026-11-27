import { z } from "zod";

export const path = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const branch = z.string().min(1).max(250).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/);
const safeIdentity = z.string().trim().min(1).max(250).refine(value => !/[<>\u0000-\u001f\u007f]/.test(value));
export const author = z.object({name:safeIdentity,email:z.email().max(250)});
/** A local or remote-tracking branch a merge or rebase takes, with the commit it was shown at. */
const mergeRef = z.string().regex(/^refs\/(?:heads|remotes)\/[A-Za-z0-9_][A-Za-z0-9_./-]{0,249}$/);
const conflictState = z.enum(["both modified", "both added", "both deleted", "added by us", "added by them", "deleted by us", "deleted by them"]);
/** A merge, rebase, cherry-pick or revert left in progress; null when none is. */
export const sequence = z.object({
  kind: z.enum(["merge", "rebase", "cherry-pick", "revert"]),
  /** The head before it started (ORIG_HEAD of a rebase, HEAD of a merge). */
  head: z.string().nullable(),
  /** What a rebase replays onto; null otherwise. */
  onto: z.string().nullable(),
  /** The commit a rebase is at, of how many; null otherwise. */
  step: z.object({done: z.number().int(), total: z.number().int()}).nullable(),
  conflicts: z.array(z.object({path, state: conflictState})),
}).nullable();
export const gitAction = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("status")}),
  z.object({kind: z.literal("history")}),
  z.object({kind: z.literal("worktrees")}),
  z.object({kind: z.literal("branches")}),
  z.object({kind: z.literal("diff"), path, staged: z.boolean()}),
  z.object({kind: z.literal("hunk"), path, staged: z.boolean(), token}),
  z.object({kind: z.literal("stage"), path, staged: z.boolean()}),
  z.object({kind: z.literal("commit"), message: z.string().trim().min(1).max(8000), expected: token, author: author.optional()}),
  z.object({kind: z.literal("compare"), base: revision, head: revision}),
  z.object({kind: z.literal("switch"), branch}),
  z.object({kind: z.literal("branch"), branch, base: revision}),
  z.object({kind: z.literal("worktree"), destination: path, branch, base: revision.optional()}),
  z.object({kind: z.literal("fetch")}),
  z.object({kind: z.literal("fastForward")}),
  z.object({kind: z.literal("outgoing")}),
  z.object({kind: z.literal("localOrigin")}),
  z.object({kind: z.literal("push"), expected: revision, branch, destination: path}),
  // Merge, rebase and their conflicts (0.10).
  z.object({kind: z.literal("sequence")}),
  z.object({kind: z.literal("mergePreview"), ref: mergeRef, target: revision}),
  z.object({kind: z.literal("conflict"), path}),
  z.object({kind: z.literal("merge"), ref: mergeRef, target: revision, expected: revision, fastForward: z.boolean(), author: author.optional()}),
  z.object({kind: z.literal("rebase"), ref: mergeRef, target: revision, expected: revision, author: author.optional()}),
  z.object({kind: z.literal("abort")}),
  z.object({kind: z.literal("continue"), author: author.optional()}),
  z.object({kind: z.literal("skip")}),
  z.object({kind: z.literal("resolve"), path, expected: token, text: z.string().max(4 * 1024 * 1024)}),
  z.object({kind: z.literal("take"), path, side: z.enum(["ours", "theirs", "delete"])}),
]);
export type GitAction = z.infer<typeof gitAction>;
export const gitResult = z.object({
  root: path,
  head: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  upstream: z.string().nullable().optional(),
  author: author.nullable().optional(),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  snapshot: token.optional(),
  files: z.array(z.object({path, index: z.string(), worktree: z.string()})).optional(),
  text: z.string().optional(),
  hunks: z.array(z.object({token, text: z.string()})).optional(),
  worktrees: z.array(z.object({path, head: z.string().optional(), branch: z.string().optional()})).optional(),
  sequence: sequence.optional(),
  /** What a merge would bring: commits in and out, and the files it would leave in conflict. */
  preview: z.object({incoming: z.number().int(), outgoing: z.number().int(), conflicts: z.array(path), fastForward: z.boolean(), upToDate: z.boolean()}).optional(),
  /** One conflicted file: each side whole (null where it has none), Git's merged text with zdiff3 markers, and the file as it is. */
  conflict: z.object({path, ours: z.string().nullable(), base: z.string().nullable(), theirs: z.string().nullable(), merged: z.string().nullable(),
    binary: z.boolean(), current: z.string().nullable(), sha256: token.nullable()}).optional(),
});
export type GitResult = z.infer<typeof gitResult>;
export const reads = new Set<GitAction["kind"]>(["status", "history", "worktrees", "branches", "diff", "compare", "outgoing", "sequence", "mergePreview", "conflict"]);
