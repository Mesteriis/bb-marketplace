/** A unified patch read as its hunks. No I/O. */

/**
 * The hunks of a patch, each from its "@@" line to the next one: git's header lines (diff --git, index, ---, +++)
 * are not part of any. A binary or empty patch has none. A new file's patch (against /dev/null) is read the same way.
 */
export function patchHunks(patch: string): string[] {
  const starts = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)].map(match => match.index!);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}
