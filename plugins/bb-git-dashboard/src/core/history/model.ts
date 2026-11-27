import { z } from "zod";

export const ref = z.object({fullName: z.string(), name: z.string(), kind: z.enum(["local", "remote", "tag", "stash", "other"]), isHead: z.boolean()});
export type Ref = z.infer<typeof ref>;
export const commitSummary = z.object({
  hash: z.string(), parents: z.array(z.string()), authorName: z.string(), authorEmail: z.string(),
  authorDate: z.string(), committerDate: z.string(), subject: z.string(), refs: z.array(ref),
});
export type CommitSummary = z.infer<typeof commitSummary>;
export const fileChange = z.object({
  path: z.string(),
  status: z.enum(["added", "conflicted", "copied", "deleted", "modified", "renamed", "type-changed", "unknown"]),
  additions: z.number().int().nonnegative().nullable(), deletions: z.number().int().nonnegative().nullable(),
});
export type FileChange = z.infer<typeof fileChange>;
export const historyPage = z.object({
  currentBranch: z.string().nullable(), uncommitted: z.array(fileChange), commits: z.array(commitSummary),
  offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(), more: z.boolean(), revision: z.string(),
});
export type HistoryPage = z.infer<typeof historyPage>;
export const commitDetails = commitSummary.extend({body: z.string(), files: z.array(fileChange)});
export type CommitDetails = z.infer<typeof commitDetails>;
export const objectName = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
