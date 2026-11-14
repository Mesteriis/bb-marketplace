// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/threading/threadBuilder.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// Groups an account's messages into conversation threads. The rebuild runs on
// every sync round, so the result depends only on the set of inputs (never on
// their order) and malformed headers never throw.
//
// Rules, in order:
//   1. Messages with a gmThreadId are grouped by it and by nothing else.
//   2. The rest are threaded JWZ-style over Message-ID / In-Reply-To / References
//      (container table with phantom parents, cycle-safe linking; ported).
//   3. A message with no usable reference joins messages with the same
//      normalized subject dated within 30 days of it.
// Thread id = "t_" + id of the group's earliest message (null dates last,
// ties broken by the smaller id).
import type { ThreadingInput } from "./model.ts";

const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SUBJECT_PREFIX = /^\s*(?:re|fwd|fw|ответ)\s*:\s*/iu;

/** Strips Re:/Fwd:/Fw:/Ответ: prefixes (any case, repeatedly), trims, lowercases. */
export function normalizeSubject(subject: string | null): string {
  let s = typeof subject === "string" ? subject.trim() : "";
  for (let match = SUBJECT_PREFIX.exec(s); match; match = SUBJECT_PREFIX.exec(s)) {
    s = s.slice(match[0].length);
  }
  return s.trim().toLowerCase();
}

/** Reduces "<id@host>" or "id@host" to a bare id; "" when nothing usable is left. */
function cleanId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

type Prepared = {
  input: ThreadingInput;
  time: number | null;
  messageId: string;
  refs: string[];
};

function parseTime(date: string | null): number | null {
  if (typeof date !== "string") return null;
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : null;
}

/** Earliest first: dated before undated, then by time, then by id (code-unit order). */
function compareEarliest(a: Prepared, b: Prepared): number {
  if (a.time !== b.time) {
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time - b.time;
  }
  return a.input.id < b.input.id ? -1 : a.input.id > b.input.id ? 1 : 0;
}

/** References kept per message; the newest are last, so the tail is kept. */
const MAX_REFERENCES = 500;

function prepare(input: ThreadingInput): Prepared {
  const references: unknown[] = Array.isArray(input.references) ? input.references : [];
  const unique = new Set<string>();
  for (const raw of references) {
    const id = cleanId(raw);
    if (id) unique.add(id);
  }
  // A crafted header can hold thousands of ids; linking costs grow with them.
  const refs = [...unique].slice(-MAX_REFERENCES);
  const parent = cleanId(input.inReplyTo);
  if (parent && !refs.includes(parent)) refs.push(parent);
  return { input, time: parseTime(input.date), messageId: cleanId(input.messageId), refs };
}

// ---------------------------------------------------------------------------
// Union-find over positions in the sorted input list. The smallest position in a
// set is its earliest message, so the root is always the thread-id owner.
// ---------------------------------------------------------------------------

function makeUnion(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) parent[rb] = ra;
    else if (rb < ra) parent[ra] = rb;
  };
  return { find, union };
}

// ---------------------------------------------------------------------------
// JWZ containers (ported from Velo).
// ---------------------------------------------------------------------------

type Container = {
  /** Position of the message in the sorted list; null for a phantom. */
  message: number | null;
  parent: Container | null;
  children: Container[];
};

function isAncestor(container: Container, ancestor: Container): boolean {
  for (let current: Container | null = container; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function linkParentChild(parent: Container, child: Container): void {
  if (isAncestor(parent, child) || child.parent === parent) return;
  if (child.parent) {
    child.parent.children = child.parent.children.filter((c) => c !== child);
  }
  child.parent = parent;
  parent.children.push(child);
}

/** Unions every message that shares a JWZ container tree. */
function threadByReferences(
  messages: Prepared[],
  positions: number[],
  union: (a: number, b: number) => void,
): void {
  const idTable = new Map<string, Container>();
  const all: Container[] = [];
  const container = (messageId: string | null): Container => {
    const existing = messageId === null ? undefined : idTable.get(messageId);
    if (existing) return existing;
    const created: Container = { message: null, parent: null, children: [] };
    if (messageId !== null) idTable.set(messageId, created);
    all.push(created);
    return created;
  };

  for (const position of positions) {
    const msg = messages[position]!;
    // The earliest claimant keeps a Message-ID; a later duplicate is a distinct
    // message, so it gets a container of its own instead of overwriting it.
    let own = msg.messageId ? container(msg.messageId) : container(null);
    if (own.message !== null) own = container(null);
    own.message = position;

    let previous: Container | null = null;
    for (const ref of msg.refs) {
      const refContainer = container(ref);
      if (previous && refContainer.parent === null) linkParentChild(previous, refContainer);
      previous = refContainer;
    }
    if (previous && previous !== own) linkParentChild(previous, own);
  }

  // Walk each root's tree iteratively: reply chains can be deeper than the stack.
  for (const root of all) {
    if (root.parent !== null) continue;
    let first: number | null = null;
    const stack: Container[] = [root];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.message !== null) {
        if (first === null) first = node.message;
        else union(first, node.message);
      }
      for (const child of node.children) stack.push(child);
    }
  }
}

/** Unions reference-less messages with same-subject messages within the window. */
function threadBySubject(
  messages: Prepared[],
  positions: number[],
  union: (a: number, b: number) => void,
): void {
  const bySubject = new Map<string, number[]>();
  for (const position of positions) {
    const msg = messages[position]!;
    const subject = normalizeSubject(msg.input.subject);
    if (!subject || msg.time === null) continue;
    const bucket = bySubject.get(subject);
    if (bucket) bucket.push(position);
    else bySubject.set(subject, [position]);
  }
  // Buckets are in time order (positions follow the sorted list), so each scan
  // stops at the first neighbour outside the window.
  const timeOf = (position: number): number => messages[position]!.time!;
  for (const bucket of bySubject.values()) {
    bucket.forEach((a, i) => {
      if (messages[a]!.refs.length > 0) return;
      for (let j = i - 1; j >= 0 && timeOf(a) - timeOf(bucket[j]!) <= SUBJECT_WINDOW_MS; j--) {
        union(a, bucket[j]!);
      }
      for (let j = i + 1; j < bucket.length && timeOf(bucket[j]!) - timeOf(a) <= SUBJECT_WINDOW_MS; j++) {
        union(a, bucket[j]!);
      }
    });
  }
}

/** Maps every input id to a deterministic thread id of the form "t_<earliest id>". */
export function buildThreads(inputs: ThreadingInput[]): Map<string, string> {
  const messages = (Array.isArray(inputs) ? inputs : []).map(prepare).sort(compareEarliest);
  const { find, union } = makeUnion(messages.length);

  const byGmThread = new Map<string, number>();
  const others: number[] = [];
  messages.forEach((msg, position) => {
    const gmThreadId = msg.input.gmThreadId;
    if (typeof gmThreadId === "string" && gmThreadId !== "") {
      const first = byGmThread.get(gmThreadId);
      if (first === undefined) byGmThread.set(gmThreadId, position);
      else union(first, position);
    } else {
      others.push(position);
    }
  });

  threadByReferences(messages, others, union);
  threadBySubject(messages, others, union);

  const threads = new Map<string, string>();
  messages.forEach((msg, position) => {
    threads.set(msg.input.id, `t_${messages[find(position)]!.input.id}`);
  });
  return threads;
}
