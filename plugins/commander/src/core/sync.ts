import { compareDirs, type DirDiff } from "./compare.ts";
import { CommanderError } from "./errors.ts";
import { OperationPlan, planDigest, type Entry, type Initiator, type ResourceRef } from "./model.ts";
import { displayPath, isAncestorOrSelf, join, samePath } from "./path.ts";
import { buildPlan, type PlannerDeps } from "./planner.ts";
import { LIST_PAGE_MAX } from "./provider.ts";

export interface SyncRequest {
  left: ResourceRef;
  right: ResourceRef;
  direction: "left-to-right" | "right-to-left" | "both";
  by: "size+mtime" | "sha256";
  includeDeletes: boolean;
  /** Exact names of immediate children to exclude on either side. */
  filters?: { exclude: string[] };
}

export interface SyncPlan {
  id: string;
  copies: OperationPlan[];
  deletes: OperationPlan | null;
  conflicts: { left: Entry; right: Entry; reason: "target_newer" | "differs" }[];
}

export async function buildSyncPlan(
  req: SyncRequest,
  deps: PlannerDeps & { initiator: Initiator; compared?: DirDiff },
  signal = new AbortController().signal,
): Promise<SyncPlan> {
  const { left, right, direction, by, includeDeletes, filters } = structuredClone(req);
  const leftProvider = deps.provider(left.endpoint);
  const rightProvider = deps.provider(right.endpoint);
  const caseSensitive = leftProvider.endpoint.caseSensitive && rightProvider.endpoint.caseSensitive;
  if (left.endpoint === right.endpoint && (
    isAncestorOrSelf(left.path, right.path, caseSensitive) || isAncestorOrSelf(right.path, left.path, caseSensitive)
  )) {
    throw new CommanderError("invalid_path", "Synchronization requires disjoint directories");
  }
  if (direction === "both" && includeDeletes) {
    throw new CommanderError("unsupported", "Choose one destination before planning deletions");
  }

  const diff = deps.compared ?? await compareDirs(
    { provider: leftProvider, path: left.path }, { provider: rightProvider, path: right.path },
    { by, limit: LIST_PAGE_MAX, mtimeToleranceMs: 0 }, signal,
  );
  if (diff.partial) throw new CommanderError("limit_exceeded", "Synchronization requires a complete directory comparison");

  const key = (name: string) => caseSensitive ? name : name.normalize("NFC").toLowerCase();
  const excluded = new Set((filters?.exclude ?? []).map(key));
  const wanted = (entry: Entry) => !excluded.has(key("t" in entry.name
    ? entry.name.t : displayPath({ segments: [entry.name] }).slice(1)));
  const id = deps.uuid();
  const copies: OperationPlan[] = [];
  const conflicts: SyncPlan["conflicts"] = [];
  const onlyLeft = diff.onlyLeft.filter(wanted);
  const onlyRight = diff.onlyRight.filter(wanted);
  const updates: [Entry, Entry][] = [];

  for (const [a, b] of diff.differ) {
    if (!wanted(a) || !wanted(b)) continue;
    const [source, target] = direction === "right-to-left" ? [b, a] : [a, b];
    const order = direction !== "both" && source.kind === "file" && target.kind === "file"
      && source.mtimeNs !== null && target.mtimeNs !== null
      ? BigInt(source.mtimeNs) - BigInt(target.mtimeNs) : 0n;
    if (order > 0n) updates.push([source, target]);
    else conflicts.push({ left: a, right: b, reason: order < 0n ? "target_newer" : "differs" });
  }

  async function make(
    from: ResourceRef, entries: [Entry, Entry | null][], targetDir: ResourceRef | null,
    absenceRoot?: ResourceRef,
  ): Promise<OperationPlan | null> {
    if (!entries.length) return null;
    const sources = entries.map(([entry]) => ({ endpoint: from.endpoint, path: join(from.path, entry.name) }));
    const { digest: _digest, ...plan } = await buildPlan({
      kind: targetDir ? "copy" : "delete", initiator: deps.initiator, sources, targetDir, newName: null,
      conflictPolicy: entries.some(([, target]) => target !== null) ? "overwriteIfNewer" : "ask", verify: by === "sha256" ? "sha256" : "size",
    }, deps, signal);

    // buildPlan takes fresh stats. A newer snapshot cannot silently replace the comparison
    // the user is about to confirm (including a case-folded collision at the destination).
    const compared = new Map(entries.map((pair, index) => [JSON.stringify(sources[index].path), pair]));
    for (const item of plan.items) {
      const pair = item.source && compared.get(JSON.stringify(item.source.path));
      if (!pair) continue;
      const [source, target] = pair;
      const expected = item.expectTarget;
      if (item.kind !== source.kind || item.fingerprint?.size !== source.size || item.fingerprint.mtimeNs !== source.mtimeNs
        || (target === null ? targetDir !== null && expected !== "absent"
          : !expected || expected === "absent" || expected.size !== target.size || expected.mtimeNs !== target.mtimeNs
            || !item.target || !samePath(item.target.path, join(targetDir!.path, target.name), caseSensitive))) {
        throw new CommanderError("changed_since_plan", "Directory entries changed during synchronization planning");
      }
    }
    const items = absenceRoot ? plan.items.map((item) => {
      const relative = item.source!.path.segments.slice(from.path.segments.length);
      return { ...item, requireAbsent: {
        endpoint: absenceRoot.endpoint,
        path: relative.reduce(join, absenceRoot.path),
      } };
    }) : plan.items;
    const unsigned = { ...plan, syncId: id, items };
    return OperationPlan.parse({ ...unsigned, digest: await planDigest(unsigned) });
  }

  const absent = (entries: DirDiff["onlyLeft"]): [Entry, null][] => entries.map((entry) => [entry, null]);
  async function copy(from: ResourceRef, into: ResourceRef, entries: Entry[]) {
    const plan = await make(from, absent(entries), into);
    if (plan) copies.push(plan);
  }
  if (direction !== "right-to-left") await copy(left, right, onlyLeft);
  if (direction !== "left-to-right") await copy(right, left, onlyRight);

  if (direction !== "both") {
    const [from, into] = direction === "left-to-right" ? [left, right] : [right, left];
    const plan = await make(from, updates, into);
    if (plan) copies.push(plan);
  }

  const deletes = !includeDeletes ? null : direction === "right-to-left"
    ? await make(left, absent(onlyLeft), null, right)
    : await make(right, absent(onlyRight), null, left);
  return { id, copies, deletes, conflicts };
}
