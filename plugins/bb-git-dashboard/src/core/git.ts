import { z } from "zod";

export const path = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const branch = z.string().min(1).max(250).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/);
const safeIdentity = z.string().trim().min(1).max(250).refine(value => !/[<>\u0000-\u001f\u007f]/.test(value));
export const author = z.object({name:safeIdentity,email:z.email().max(250)});
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
});
export type GitResult = z.infer<typeof gitResult>;
export const reads = new Set<GitAction["kind"]>(["status", "history", "worktrees", "branches", "diff", "compare", "outgoing"]);
