/** A unified patch read as its hunks. No I/O. */

/**
 * The hunks of a patch, each from its "@@" line to the next one or the next file section: git's header lines (diff --git, index, ---, +++)
 * are not part of any. A binary or empty patch has none. A new file's patch (against /dev/null) is read the same way.
 */
export function patchHunks(patch: string): string[] {
  const starts = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)].map(match => match.index!);
  // A hunk also ends where the next file section's "diff --git" header begins (a patch of two sections).
  const sections = [...patch.matchAll(/^diff --git /gm)].map(match => match.index!);
  return starts.map((start, index) => {
    const next = starts[index + 1] ?? patch.length;
    return patch.slice(start, Math.min(next, sections.find(at => at > start) ?? next));
  });
}
