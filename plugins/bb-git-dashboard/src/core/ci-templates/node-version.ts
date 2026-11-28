/**
 * The Node.js major a project's CI runs, from its `engines.node` range: 24, the current LTS line, whenever the range
 * admits it, so a project's CI and a web UI beside another application run the same Node.js; otherwise the newest even
 * (LTS) major the range admits, else its lowest major. A range it cannot read, or one nothing satisfies, gets 24.
 * Ranges are npm's: `||` between sets, comparators (`>=`, `>`, `<=`, `<`, `=`), `^`, `~`, `x` wildcards and `a - b`.
 */
export const CI_NODE = "24";

type Version = [number, number, number];
/** [from, to): the versions from `from` up to, not including, `to`. */
type Interval = [Version, Version];

const MAX: Version = [Number.MAX_SAFE_INTEGER, 0, 0];
const ZERO: Version = [0, 0, 0];
const less = (a: Version, b: Version) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

/** A version as written, its parts, missing or wildcard ones as null: "22.x" is [22, null, null]. */
function parts(text: string): [number, number | null, number | null] | null {
  const match = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(text);
  if (!match) return null;
  const part = (value: string | undefined) => value === undefined || /^[xX*]$/.test(value) ? null : Number(value);
  const minor = part(match[2]);
  return [Number(match[1]), minor, minor === null ? null : part(match[3])];
}
const floor = ([a, b, c]: [number, number | null, number | null]): Version => [a, b ?? 0, c ?? 0];
/** The first version after everything the written version covers: 22 → 23.0.0, 22.4 → 22.5.0, 22.4.1 → 22.4.2. */
const after = ([a, b, c]: [number, number | null, number | null]): Version => b === null ? [a + 1, 0, 0] : c === null ? [a, b + 1, 0] : [a, b, c + 1];

/** The interval one comparator allows, or null when it cannot be read. */
function comparator(token: string): Interval | null {
  if (token === "*" || /^[xX]$/.test(token)) return [ZERO, MAX];
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  const version = match && parts(match[2]!);
  if (!match || !version) return null;
  const [major, minor, patch] = version;
  switch (match[1]) {
    case ">=": return [floor(version), MAX];
    case ">": return [after(version), MAX];
    case "<=": return [ZERO, after(version)];
    case "<": return [ZERO, floor(version)];
    case "^": return [floor(version), major > 0 || minor === null ? [major + 1, 0, 0] : minor > 0 || patch === null ? [0, minor + 1, 0] : [0, 0, patch + 1]];
    case "~": return [floor(version), minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0]];
    default: return [floor(version), after(version)];
  }
}

/** The interval a comparator set allows (all of its comparators), or null when a part cannot be read. */
function set(text: string): Interval | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  const tokens = hyphen ? [">=" + hyphen[1], "<=" + hyphen[2]] : text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
  let from = ZERO, to = MAX;
  for (const token of tokens.length ? tokens : ["*"]) {
    const interval = comparator(token);
    if (!interval) return null;
    if (less(from, interval[0])) from = interval[0];
    if (less(interval[1], to)) to = interval[1];
  }
  return [from, to];
}

const admits = (intervals: Interval[], major: number) =>
  intervals.some(([from, to]) => less(from, to) && less(from, [major + 1, 0, 0]) && less([major, 0, 0], to));

export function ciNode(range: string | undefined): string {
  if (range === undefined || !range.trim()) return CI_NODE;
  const intervals = range.split("||").map(part => set(part.trim()));
  if (intervals.some(interval => interval === null)) return CI_NODE;
  const readable = (intervals as Interval[]).filter(([from, to]) => less(from, to));
  if (!readable.length) return CI_NODE;
  for (let major = Number(CI_NODE); major >= 0; major -= 2) if (admits(readable, major)) return String(major);
  return String(Math.min(...readable.map(([from]) => from[0])));
}
