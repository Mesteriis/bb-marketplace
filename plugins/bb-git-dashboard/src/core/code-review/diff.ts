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
  /** The patch was not read yet: the view reads it later, with the next batch of files. */
  deferred: z.boolean().optional(),
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

/** How many patches a view reads at once: the first ones with the list, the rest in batches of this many. */
export const PATCH_BATCH = 25;

/** The paths to ask the host for, to read these files' patches: a rename's old path too, or it reads as an addition. */
export const patchPaths = (files: readonly ReviewDiffFile[]) => [...new Set(files.flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]))];
/** `files` with the patches read for some of them in place. */
export function withPatches(files: readonly ReviewDiffFile[], read: readonly ReviewDiffFile[]): ReviewDiffFile[] {
  const byPath = new Map(read.map(file => [file.path, file]));
  return files.map(file => { const found = byPath.get(file.path); return found && file.deferred ? found : file; });
}
