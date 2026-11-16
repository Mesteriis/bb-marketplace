// A word diff for the Improve dialog (slice 3f): the owner's text before and
// after an AI edit. Pure, no dependency: the longest common subsequence over
// word tokens (a word with the whitespace after it), the common prefix and
// suffix trimmed first. Over WORD_DIFF_MAX words on either side the diff is
// one replacement of the whole text.

export type DiffOp = { kind: "same" | "insert" | "delete"; text: string };

/** Most words per side the LCS runs over. */
export const WORD_DIFF_MAX = 4_000;

/** Tokens: leading whitespace alone, then each word with the whitespace after it. */
function tokens(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

function countWords(list: readonly string[]): number {
  let count = 0;
  for (const token of list) if (/\S/.test(token)) count++;
  return count;
}

function push(ops: DiffOp[], kind: DiffOp["kind"], text: string): void {
  if (text === "") return;
  const last = ops[ops.length - 1];
  if (last !== undefined && last.kind === kind) last.text += text;
  else ops.push({ kind, text });
}

export function wordDiff(before: string, after: string): DiffOp[] {
  const a = tokens(before);
  const b = tokens(after);
  const ops: DiffOp[] = [];
  if (countWords(a) > WORD_DIFF_MAX || countWords(b) > WORD_DIFF_MAX) {
    if (before === after) {
      push(ops, "same", before);
    } else {
      push(ops, "delete", before);
      push(ops, "insert", after);
    }
    return ops;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  push(ops, "same", a.slice(0, start).join(""));
  const n = endA - start;
  const m = endB - start;
  // lengths[i * (m + 1) + j] = LCS of a[start + i ..] and b[start + j ..]
  const lengths = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] = a[start + i] === b[start + j]
        ? lengths[(i + 1) * (m + 1) + j + 1]! + 1
        : Math.max(lengths[(i + 1) * (m + 1) + j]!, lengths[i * (m + 1) + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      push(ops, "same", a[start + i]!);
      i++;
      j++;
    } else if (lengths[(i + 1) * (m + 1) + j]! >= lengths[i * (m + 1) + j + 1]!) {
      push(ops, "delete", a[start + i]!);
      i++;
    } else {
      push(ops, "insert", b[start + j]!);
      j++;
    }
  }
  for (; i < n; i++) push(ops, "delete", a[start + i]!);
  for (; j < m; j++) push(ops, "insert", b[start + j]!);
  push(ops, "same", a.slice(endA).join(""));
  return ops;
}
