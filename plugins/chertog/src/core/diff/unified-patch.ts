// Keep the newline in the identity of a line, including the last one.
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

type Edit = readonly [prefix: " " | "-" | "+", line: string];

function middleEdits(old: string[], next: string[]): Edit[] {
  // Bound memory and time for an extensively rewritten file. Replacing the
  // changed middle is still an exact patch even when it isn't the shortest.
  const width = next.length + 1;
  const cells = (old.length + 1) * width;
  if (!old.length || !next.length || cells > 1_000_000) {
    return [...old.map(line => ["-", line] as const), ...next.map(line => ["+", line] as const)];
  }
  const lengths = new Uint32Array(cells);
  for (let a = old.length - 1; a >= 0; a--) {
    for (let b = next.length - 1; b >= 0; b--) {
      const i = a * width + b;
      lengths[i] = old[a] === next[b] ? 1 + lengths[i + width + 1] : Math.max(lengths[i + 1], lengths[i + width]);
    }
  }
  const edits: Edit[] = [];
  let a = 0, b = 0;
  while (a < old.length || b < next.length) {
    const i = a * width + b;
    if (a < old.length && old[a] === next[b]) {
      edits.push([" ", old[a++]]);
      b++;
    } else if (a < old.length && (b === next.length || lengths[i + width] >= lengths[i + 1])) {
      edits.push(["-", old[a++]]);
    } else {
      edits.push(["+", next[b++]]);
    }
  }
  return edits;
}

/** Unified hunks for BB's one-file renderer, which supplies the file headers. */
export function unifiedPatch(before: string, after: string): string {
  if (before === after) return "";
  const old = lines(before), next = lines(after);
  let start = 0, tail = 0;
  const shorter = Math.min(old.length, next.length);
  while (start < shorter && old[start] === next[start]) start++;
  while (tail < shorter - start && old[old.length - tail - 1] === next[next.length - tail - 1]) tail++;
  const begin = Math.max(0, start - 3);
  const edits: Edit[] = [
    ...old.slice(begin, start).map(line => [" ", line] as const),
    ...middleEdits(old.slice(start, old.length - tail), next.slice(start, next.length - tail)),
    ...old.slice(old.length - tail, old.length - tail + 3).map(line => [" ", line] as const),
  ];
  const hunks: { start: number; end: number }[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i][0] === " ") continue;
    const left = Math.max(0, i - 3), end = Math.min(edits.length, i + 4);
    const last = hunks.at(-1);
    if (last && left <= last.end) last.end = end;
    else hunks.push({ start: left, end });
  }
  let oldAt = begin, newAt = begin, cursor = 0;
  const output: string[] = [];
  for (const hunk of hunks) {
    oldAt += hunk.start - cursor;
    newAt += hunk.start - cursor;
    const body: string[] = [];
    let deleted = 0, added = 0;
    for (const [prefix, line] of edits.slice(hunk.start, hunk.end)) {
      if (prefix !== "+") deleted++;
      if (prefix !== "-") added++;
      body.push(prefix + line);
      if (!line.endsWith("\n")) body.push("\n\\ No newline at end of file\n");
    }
    output.push(`@@ -${oldAt + Number(deleted > 0)},${deleted} +${newAt + Number(added > 0)},${added} @@\n`, body.join(""));
    oldAt += deleted;
    newAt += added;
    cursor = hunk.end;
  }
  return output.join("");
}
