// Which row comes next after rows leave the list (slice 3i, part B): the
// conversation that opens after a removing action, the cursor after a
// selection went, and the selection Shift+Down/Up grows. Pure: no React, no host.

/**
 * The first row after `current` that is not removed, else the nearest one
 * before it, else null. Null too when `current` is not in `rows`.
 */
export function successorRow(
  rows: readonly string[],
  isRemoved: (id: string) => boolean,
  current: string,
): string | null {
  const at = rows.indexOf(current);
  if (at < 0) return null;
  for (let index = at + 1; index < rows.length; index++) {
    if (!isRemoved(rows[index]!)) return rows[index]!;
  }
  for (let index = at - 1; index >= 0; index--) {
    if (!isRemoved(rows[index]!)) return rows[index]!;
  }
  return null;
}

/**
 * The selection during a run of Shift+Down/Up: `base` (what was selected when
 * the run started) plus every row from `anchor` (the cursor row then) to `to`
 * (the cursor row now). Turning back shrinks the range; `base` stays.
 */
export function extendSelection({
  order,
  base,
  anchor,
  to,
}: {
  order: readonly string[];
  base: ReadonlySet<string>;
  anchor: string;
  to: string;
}): Set<string> {
  const next = new Set(base);
  const from = order.indexOf(anchor);
  const end = order.indexOf(to);
  if (from < 0 || end < 0) return next;
  for (const id of order.slice(Math.min(from, end), Math.max(from, end) + 1)) next.add(id);
  return next;
}
