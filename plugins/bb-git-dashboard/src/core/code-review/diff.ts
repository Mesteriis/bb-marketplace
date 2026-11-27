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
  /** The whole file as it reads now (the Any file view), not a change. */
  whole: z.boolean().optional(),
  /** The new side's content as git names it, for a file shown without a patch (binary, too large): what tells its changes apart. */
  blob: z.string().max(64).optional(),
  /** Marked Viewed at this very change; a file whose change moved on since is not. */
  viewed: z.boolean().optional(),
}).strict();
export type ReviewDiffFile = z.infer<typeof reviewDiffFileSchema>;

export const reviewDiffSchema = z.object({
  files: z.array(reviewDiffFileSchema),
  /** Files were left out: the diff has more than the host sends. */
  truncated: z.boolean(),
  /** How many changed files the ignore patterns left out. */
  ignored: z.number().int().nonnegative().optional(),
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

/** One short hash of a file's change: it differs whenever the change does. A Viewed mark holds the one it was made at. */
export function changeRevision(file: Pick<ReviewDiffFile, "changeKind" | "previousPath" | "additions" | "deletions" | "binary" | "patch" | "blob">): string {
  return hash([file.changeKind, file.previousPath ?? "", file.additions, file.deletions, file.binary, file.patch ?? "", file.blob ?? ""].join("\u0000"));
}

/** FNV-1a, 64 bits as hex: enough to tell two versions of a file's change apart. */
function hash(text: string): string {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, "0");
}

/** A whole file as a patch of context lines only, so the Review shows it, and comments on it, like any diff. */
export function wholeFileEntry(path: string, text: string): ReviewDiffFile {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const patch = lines.length ? "@@ -1," + lines.length + " +1," + lines.length + " @@\n" + lines.map(line => " " + line).join("\n") + "\n" : null;
  return {path, previousPath: null, changeKind: "modified", additions: 0, deletions: 0, binary: false, untracked: false, patch, tooLarge: false, whole: true};
}
