const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export type DisplayRow = {kind: "hunk" | "addition" | "deletion" | "context"; text: string; oldLine: number | null; newLine: number | null};

/**
 * A file's unified patch as the review shows it: each hunk's header, then its lines with their old and new numbers.
 * File headers are skipped; a hunk ends when its header's counts are used up, as `patch-lines.ts` reads it, so a
 * removed line that itself starts with `--` is not taken for a header.
 */
export function displayRows(patch: string): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || (marker === undefined && line === "")) {
        rows.push({kind: "context", text, oldLine: oldLine++, newLine: newLine++}); oldLeft--; newLeft--; continue;
      }
      if (marker === "-") { rows.push({kind: "deletion", text, oldLine: oldLine++, newLine: null}); oldLeft--; continue; }
      if (marker === "+") { rows.push({kind: "addition", text, oldLine: null, newLine: newLine++}); newLeft--; continue; }
      if (marker === "\\") continue;
      oldLeft = 0; newLeft = 0;
    }
    const header = hunkHeader.exec(line);
    if (!header) continue;
    oldLine = Number(header[1]); oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    newLine = Number(header[3]); newLeft = header[4] === undefined ? 1 : Number(header[4]);
    rows.push({kind: "hunk", text: line, oldLine: null, newLine: null});
  }
  return rows;
}
