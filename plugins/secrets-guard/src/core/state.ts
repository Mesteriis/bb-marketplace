// The guard marker as pure data. Deadlines are unix seconds; "open" always
// means "deadline strictly in the future", and anything unreadable is closed.

export type Scope = "thread" | "tree" | "global";
export type Minutes = 10 | 30 | 60;

export interface ThreadEntry {
  until: number;
  /** The thread the button was pressed in. */
  root: string;
  /** Whether the root was opened together with its subthreads. */
  tree: boolean;
}

export interface GuardState {
  /** Global deadline. Absent or past: globally closed. */
  until?: number;
  threads: Record<string, ThreadEntry>;
}

export interface Effective {
  scope: Scope;
  until: number;
  rootThreadId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(raw: unknown): ThreadEntry | null {
  if (!isRecord(raw)) return null;
  const { until, root, tree } = raw;
  if (typeof until !== "number" || !Number.isFinite(until)) return null;
  if (typeof root !== "string" || root === "") return null;
  if (typeof tree !== "boolean") return null;
  return { until, root, tree };
}

/** Reads untrusted JSON. Garbage is a closed guard; broken entries are dropped. */
export function parseState(raw: unknown): GuardState {
  const state: GuardState = { threads: {} };
  if (!isRecord(raw)) return state;
  if (typeof raw.until === "number" && Number.isFinite(raw.until)) state.until = raw.until;
  if (!isRecord(raw.threads)) return state;
  for (const [id, value] of Object.entries(raw.threads)) {
    const entry = parseEntry(value);
    if (entry !== null) state.threads[id] = entry;
  }
  return state;
}

function withGlobal(until: number | undefined, threads: Record<string, ThreadEntry>): GuardState {
  return until === undefined ? { threads } : { until, threads };
}

function filterThreads(
  state: GuardState,
  keep: (id: string, entry: ThreadEntry) => boolean,
): Record<string, ThreadEntry> {
  return Object.fromEntries(Object.entries(state.threads).filter(([id, entry]) => keep(id, entry)));
}

/** Removes everything whose deadline is not in the future. */
export function prune(state: GuardState, now: number): GuardState {
  const until = state.until !== undefined && state.until > now ? state.until : undefined;
  return withGlobal(until, filterThreads(state, (_id, entry) => entry.until > now));
}

/** The deadline of an opening made now. */
export function deadline(now: number, minutes: Minutes): number {
  return now + minutes * 60;
}

export function openGlobal(state: GuardState, now: number, minutes: Minutes): GuardState {
  return { until: deadline(now, minutes), threads: { ...state.threads } };
}

/**
 * Writes the root's entry over a tree: former entries of this root go away,
 * and a descendant already open under another root keeps its entry when that
 * one lasts longer, so opening never shortens what was granted.
 */
function writeTree(
  state: GuardState,
  root: string,
  entry: ThreadEntry,
  descendants: readonly string[],
): GuardState {
  const threads = filterThreads(state, (_id, existing) => existing.root !== root);
  for (const id of descendants) {
    const other = threads[id];
    if (other === undefined || other.until <= entry.until) threads[id] = { ...entry };
  }
  threads[root] = { ...entry };
  return withGlobal(state.until, threads);
}

/** `descendants: null` opens the root alone (scope "thread"). */
export function openThreads(
  state: GuardState,
  now: number,
  minutes: Minutes,
  root: string,
  descendants: readonly string[] | null,
): GuardState {
  const entry: ThreadEntry = { until: deadline(now, minutes), root, tree: descendants !== null };
  return writeTree(state, root, entry, descendants ?? []);
}

/** What is open for a thread; of a global and a thread opening, the one that lasts longer. */
export function effective(state: GuardState, now: number, threadId: string): Effective | null {
  const global = state.until !== undefined && state.until > now ? state.until : null;
  const own = Object.hasOwn(state.threads, threadId) ? state.threads[threadId] : undefined;
  const entry = own !== undefined && own.until > now ? own : null;
  if (entry !== null && (global === null || entry.until > global)) {
    return { scope: entry.tree ? "tree" : "thread", until: entry.until, rootThreadId: entry.root };
  }
  if (global !== null) return { scope: "global", until: global, rootThreadId: null };
  return null;
}

/** Closes what `effective` reports for the thread, and nothing else. */
export function close(state: GuardState, now: number, threadId: string): GuardState {
  const current = effective(state, now, threadId);
  if (current === null) return state;
  if (current.scope === "global") return { threads: { ...state.threads } };
  if (current.scope === "tree") {
    return withGlobal(
      state.until,
      filterThreads(state, (_id, entry) => entry.root !== current.rootThreadId),
    );
  }
  return withGlobal(state.until, filterThreads(state, (id) => id !== threadId));
}

/** Roots opened with subthreads whose deadline is in the future. */
export function treeRoots(state: GuardState, now: number): string[] {
  return Object.entries(state.threads)
    .filter(([id, entry]) => entry.root === id && entry.tree && entry.until > now)
    .map(([id]) => id);
}

/** Rewrites a live tree's entries to match its current descendants; the same object when nothing changed. */
export function resyncTree(
  state: GuardState,
  now: number,
  root: string,
  descendants: readonly string[],
): GuardState {
  const entry = Object.hasOwn(state.threads, root) ? state.threads[root] : undefined;
  if (entry === undefined || entry.root !== root || !entry.tree || entry.until <= now) return state;
  const next = writeTree(state, root, entry, descendants);
  return sameThreads(state.threads, next.threads) ? state : next;
}

function sameThreads(left: Record<string, ThreadEntry>, right: Record<string, ThreadEntry>): boolean {
  const ids = Object.keys(left);
  if (ids.length !== Object.keys(right).length) return false;
  return ids.every((id) => {
    const a = left[id];
    const b = Object.hasOwn(right, id) ? right[id] : undefined;
    return a !== undefined && b !== undefined && a.until === b.until && a.root === b.root && a.tree === b.tree;
  });
}
