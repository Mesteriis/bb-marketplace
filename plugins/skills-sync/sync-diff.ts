import * as path from "node:path";
import { changedFiles, readFileOrNull } from "./sync-files";

/** Longest-common-subsequence table walk; inputs here are single files. */
function lcsOps(a: string[], b: string[]): Array<{ tag: " " | "-" | "+"; line: string }> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Array<{ tag: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ tag: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ tag: "+", line: b[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ tag: "-", line: a[i] });
  for (; j < m; j += 1) ops.push({ tag: "+", line: b[j] });
  return ops;
}

/** A unified diff of one file, or "" when the two texts match. */
export function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  fromText: string | null,
  toText: string | null,
  context = 3,
): string {
  if (fromText === toText) return "";
  const a = fromText === null ? [] : fromText.split("\n");
  const b = toText === null ? [] : toText.split("\n");
  const ops = lcsOps(a, b);

  const hunks: string[] = [];
  let index = 0;
  let aLine = 1;
  let bLine = 1;
  while (index < ops.length) {
    if (ops[index].tag === " ") {
      aLine += 1;
      bLine += 1;
      index += 1;
      continue;
    }
    // Walk back over up to `context` equal lines to open the hunk.
    let start = index;
    let lead = 0;
    while (start > 0 && ops[start - 1].tag === " " && lead < context) {
      start -= 1;
      lead += 1;
    }
    let end = index;
    let trailing = 0;
    while (end < ops.length && trailing <= context * 2) {
      if (ops[end].tag === " ") trailing += 1;
      else trailing = 0;
      end += 1;
    }
    end -= Math.max(0, trailing - context);

    const body = ops.slice(start, end);
    const aCount = body.filter((op) => op.tag !== "+").length;
    const bCount = body.filter((op) => op.tag !== "-").length;
    hunks.push(
      `@@ -${aLine - lead},${aCount} +${bLine - lead},${bCount} @@\n` +
        body.map((op) => `${op.tag}${op.line}`).join("\n"),
    );
    for (const op of ops.slice(index, end)) {
      if (op.tag !== "+") aLine += 1;
      if (op.tag !== "-") bLine += 1;
    }
    index = end;
  }
  if (hunks.length === 0) return "";
  return [`--- ${fromLabel}`, `+++ ${toLabel}`, ...hunks].join("\n") + "\n";
}

/** A multi-file unified diff between two skill folders. */
export function diffTrees(
  from: string | null,
  to: string | null,
  fromLabel: string,
  toLabel: string,
): string {
  const parts: string[] = [];
  for (const file of changedFiles(from, to)) {
    const left = from === null ? null : readFileOrNull(path.join(from, file));
    const right = to === null ? null : readFileOrNull(path.join(to, file));
    const patch = unifiedDiff(
      left === null ? "/dev/null" : `${fromLabel}/${file}`,
      right === null ? "/dev/null" : `${toLabel}/${file}`,
      left,
      right,
    );
    if (patch !== "") {
      // Keep these paths relative to the skill. The panel uses this standard
      // header to split a folder patch into one viewer per changed file.
      parts.push(`diff --git a/${file} b/${file}\n${patch}`);
    }
  }
  return parts.join("\n");
}
