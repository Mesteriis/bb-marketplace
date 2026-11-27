/**
 * The diff of a view as the host reads it: one entry per file with its counts and patch. Ported from diff-review
 * shared/host-contract.ts (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

export const reviewDiffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum(["added", "copied", "deleted", "modified", "renamed", "type_changed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  untracked: z.boolean(),
  /** Null when the file's patch is too large to send or it is binary. */
  patch: z.string().nullable(),
  tooLarge: z.boolean(),
}).strict();
export type ReviewDiffFile = z.infer<typeof reviewDiffFileSchema>;

export const reviewDiffSchema = z.object({
  files: z.array(reviewDiffFileSchema),
  /** Files were left out: the diff has more than the host sends. */
  truncated: z.boolean(),
  /** The commits the two sides are, when they are commits. */
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
}).strict();
export type ReviewDiff = z.infer<typeof reviewDiffSchema>;
