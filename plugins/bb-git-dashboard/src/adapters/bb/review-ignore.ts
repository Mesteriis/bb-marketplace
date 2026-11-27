/**
 * Which changed files a Review leaves out: generated files, lockfiles and the like, in gitignore syntax, from the
 * plugin's setting and from the copy's `.diffityignore` and the repository's `info/diffityignore` (the files diffity
 * reads, so a repository set up for diffity or diff-review works unchanged). Ported from diff-review
 * server/ignore.ts (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. Changed: read on the copy's host, the `info/`
 * file found by `git rev-parse --git-path`.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import ignore from "ignore";
import type { RunGit } from "./review-git.ts";

export const WORKSPACE_IGNORE_FILE = ".diffityignore";
export const INFO_IGNORE_FILE = "info/diffityignore";
/** Most patterns a view takes, all sources together. */
export const MAX_PATTERNS = 1_000;

/** Splits a setting or a file into patterns: one per line, blank lines and `#` comments dropped. */
export function patternLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** A test for paths relative to the copy's root; with no patterns, nothing is ignored. */
export function ignoreMatcher(patterns: readonly string[]): ((path: string) => boolean) | null {
  if (!patterns.length) return null;
  const matcher = ignore().add(patterns.slice(0, MAX_PATTERNS));
  return path => {
    const relative = path.replace(/^\.\//, "");
    // `ignore` throws on a path it cannot judge (absolute, `..`); such a path is shown.
    if (relative === "" || relative.startsWith("/") || relative.startsWith("../")) return false;
    return matcher.ignores(relative);
  };
}

/** The setting's patterns, then the copy's ignore files when `readFiles`; a file that cannot be read counts as absent. */
export async function ignoreFor(run: RunGit, root: string, setting: readonly string[], readFiles: boolean) {
  const patterns = [...setting];
  if (readFiles) {
    // A linked worktree shares the main repository's `info/`: git names where it is.
    const info = await run(root, ["rev-parse", "--git-path", INFO_IGNORE_FILE]).then(result => result.stdout.trim(), () => null);
    for (const path of [join(root, WORKSPACE_IGNORE_FILE), ...info ? [isAbsolute(info) ? info : join(root, info)] : []]) {
      patterns.push(...await readFile(path, "utf8").then(patternLines, () => []));
    }
  }
  return ignoreMatcher(patterns);
}
