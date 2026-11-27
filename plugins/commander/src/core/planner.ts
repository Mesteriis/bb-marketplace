import { z } from "zod";
import { CommanderError } from "./errors.ts";
import {
  assertNoSourceOverlap,
  assertNoTargetOverlap,
  assertNotIntoSelf,
  assertNotReplacingSource,
  assertRemovable,
  assertWritable,
  sameEntryRef,
  segmentKey,
} from "./guards.ts";
import {
  ConflictPolicy,
  Initiator,
  OperationKind,
  OperationPlan,
  ResourceRef,
  Verify,
  planDigest,
  type EndpointId,
  type Entry,
  type ExpectedTarget as ExpectedTargetValue,
  type PlanItem,
  type Route,
} from "./model.ts";
import { NameSegment, join, parent, samePath, type ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { LIST_PAGE_MAX } from "./provider.ts";
import { fromBig, toBig, type Size } from "./size.ts";
import { previewRename, RenamePattern, type RenameProblem } from "./rename-pattern.ts";

/** The schema limit of OperationPlan.items; a configured maxItems cannot exceed it. */
const SCHEMA_MAX_ITEMS = 100_000;
/** S12: a batch rename plan holds at most this many renames (the artboard's limit). */
export const BATCH_RENAME_MAX = 10_000;
/** Listing cap for the directory a batch rename reads to check names. */
const BATCH_LISTING_MAX = 200_000;
const SIZE_MAX = 99_999_999_999_999_999_999n;

export interface PlanRequest {
  kind: OperationKind;
  initiator: Initiator;
  /** For copy, move and delete the sources are expanded; for mkdir this is []. */
  sources: ResourceRef[];
  /** copy and move: destination directory; mkdir: the parent. Null for rename and delete. */
  targetDir: ResourceRef | null;
  /** rename: the new name; mkdir: the new directory name. */
  newName: NameSegment | null;
  conflictPolicy: ConflictPolicy;
  verify: Verify;
  /** S12: a batch rename of every source by a pattern. Replaces newName; null or absent otherwise. */
  pattern?: RenamePattern | null;
}

const PlanRequestInput = z.object({
  kind: OperationKind,
  initiator: Initiator,
  sources: z.array(ResourceRef).max(SCHEMA_MAX_ITEMS),
  targetDir: ResourceRef.nullable(),
  newName: NameSegment.nullable(),
  conflictPolicy: ConflictPolicy,
  verify: Verify,
  pattern: RenamePattern.nullable().optional(),
}).strict();

export interface PlannerDeps {
  provider(endpoint: EndpointId): FileProvider;
  now(): Date;
  uuid(): string;
  limits: { maxItems: number; maxDepth: number };
  /**
   * Protected paths of the endpoint's host (the home directory, for example).
   * The root, each protected path and each ancestor of one cannot be removed,
   * moved or renamed. Null means the host did not say: removal is refused.
   */
  protectedPathsFor(endpoint: EndpointId): ResourcePath[] | null;
}

function invalidRequest(message: string): CommanderError {
  return new CommanderError("invalid_path", message);
}

/**
 * Copies the caller's request and validates it. Runs before the first await, so
 * later changes by the caller cannot reach the plan or its digest.
 */
function snapshotRequest(raw: PlanRequest): PlanRequest {
  const parsed = PlanRequestInput.safeParse(raw);
  if (!parsed.success) {
    throw new CommanderError("internal", "The plan request does not match its schema");
  }
  return parsed.data;
}

function commonEndpoint(sources: ResourceRef[]): EndpointId | null {
  if (sources.length === 0) return null;
  const first = sources[0].endpoint;
  if (sources.some((source) => source.endpoint !== first)) {
    throw new CommanderError("unsupported", "Sources on several endpoints cannot share one plan");
  }
  return first;
}

function lastSegment(path: ResourcePath): NameSegment {
  const name = path.segments.at(-1);
  if (name === undefined) throw invalidRequest("The root cannot be the source of this operation");
  return name;
}

function sameNameExactly(a: NameSegment, b: NameSegment): boolean {
  if ("t" in a && "t" in b) return a.t === b.t;
  if ("b" in a && "b" in b) return a.b === b.b;
  return false;
}

/** A requested source that is missing is not_found; a child that vanished mid-walk is a change. */
async function statExisting(
  provider: FileProvider,
  path: ResourcePath,
  signal: AbortSignal,
  missing: "not_found" | "changed_since_plan",
): Promise<Entry> {
  const entry = await provider.stat(path, signal);
  if (entry === null) {
    throw missing === "not_found"
      ? new CommanderError("not_found", "The source does not exist")
      : new CommanderError("changed_since_plan", "An entry disappeared while the plan was built");
  }
  return entry;
}

/** The target directory must exist and be a real directory (not a symlink, not a file). */
async function assertDirectoryTarget(provider: FileProvider, path: ResourcePath, signal: AbortSignal): Promise<void> {
  const entry = await provider.stat(path, signal);
  if (entry === null) throw new CommanderError("not_found", "The target directory does not exist");
  if (entry.kind !== "dir") throw invalidRequest("The target must be a directory");
}

/** The target's state now, in the shape the plan records it. */
async function expectationAt(
  provider: FileProvider,
  path: ResourcePath,
  signal: AbortSignal,
): Promise<ExpectedTargetValue> {
  const entry = await provider.stat(path, signal);
  return entry === null ? "absent" : { size: entry.size, mtimeNs: entry.mtimeNs };
}

/** Shared by all sources of one plan: every listed page counts, not only one tree's. */
interface Budget {
  pages: number;
}

interface Walk {
  provider: FileProvider;
  kind: OperationKind;
  items: PlanItem[];
  targetProvider: FileProvider | null;
  targetEndpoint: EndpointId | null;
  maxItems: number;
  maxDepth: number;
  budget: Budget;
  signal: AbortSignal;
}

function pushItem(walk: Walk, item: PlanItem): void {
  walk.items.push(item);
  if (walk.items.length > walk.maxItems) {
    throw new CommanderError("limit_exceeded", "The operation has too many items");
  }
}

/**
 * Streams one source tree. Each page's children are stat-ed and planned as they
 * arrive, so the item budget stops the listing at the page where it runs out.
 * Copy and move add a directory before its children, so the target directory is
 * created first. Delete adds children before their directory, because a provider
 * removes only empty directories.
 */
async function walk(
  w: Walk,
  srcPath: ResourcePath,
  entry: Entry,
  tgtPath: ResourcePath | null,
  depth: number,
): Promise<void> {
  w.signal.throwIfAborted();
  if (depth > w.maxDepth) {
    throw new CommanderError("limit_exceeded", "The tree is nested too deeply");
  }
  const expectTarget = tgtPath === null || w.targetProvider === null
    ? null
    : await expectationAt(w.targetProvider, tgtPath, w.signal);
  const item: PlanItem = {
    source: { endpoint: w.provider.endpoint.id, path: srcPath },
    target: tgtPath === null || w.targetEndpoint === null
      ? null
      : { endpoint: w.targetEndpoint, path: tgtPath },
    kind: entry.kind,
    fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
    expectTarget,
  };
  const postOrder = w.kind === "delete";
  if (!postOrder) pushItem(w, item);
  // Only a real directory is descended into; a symlink stays one item.
  if (entry.kind === "dir") await walkChildren(w, srcPath, tgtPath, depth);
  if (postOrder) pushItem(w, item);
}

async function walkChildren(
  w: Walk,
  srcPath: ResourcePath,
  tgtPath: ResourcePath | null,
  depth: number,
): Promise<void> {
  const seenCursors = new Set<string>();
  const seenNames = new Set<string>();
  let cursor: string | null = null;
  do {
    w.signal.throwIfAborted();
    const page = await w.provider.list(srcPath, { cursor, limit: LIST_PAGE_MAX }, w.signal);
    // A page with no entries and a cursor makes no progress: the provider is broken.
    if (page.entries.length === 0 && page.cursor !== null) {
      throw new CommanderError("internal", "The provider returned an empty page with a cursor");
    }
    for (const child of page.entries) {
      // The same name twice in one listing means the directory changed under the plan.
      const key = segmentKey(child.name, w.provider.endpoint.caseSensitive);
      if (seenNames.has(key)) {
        throw new CommanderError("changed_since_plan", "The listing repeated a name");
      }
      seenNames.add(key);
      const childPath = join(srcPath, child.name);
      const childEntry = await statExisting(w.provider, childPath, w.signal, "changed_since_plan");
      await walk(w, childPath, childEntry, tgtPath === null ? null : join(tgtPath, child.name), depth + 1);
    }
    cursor = page.cursor;
    if (cursor !== null) {
      w.budget.pages++;
      if (w.budget.pages > 2 * w.maxItems + 1) {
        throw new CommanderError("limit_exceeded", "The listing used too many pages");
      }
      if (seenCursors.has(cursor)) {
        throw new CommanderError("internal", "The provider repeated a listing cursor");
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
}

/** The total must fit the 20-digit Size type; beyond it the plan cannot be represented. */
function totalBytesOf(items: PlanItem[]): Size {
  let total = 0n;
  for (const item of items) {
    if (item.kind === "file" && item.fingerprint !== null) total += toBig(item.fingerprint.size);
  }
  if (total > SIZE_MAX) {
    throw new CommanderError("limit_exceeded", "The total size exceeds the 20-digit limit");
  }
  return fromBig(total);
}

function routeFor(sourceEndpoint: EndpointId | null, targetEndpoint: EndpointId | null): Route {
  if (sourceEndpoint === null || targetEndpoint === null || sourceEndpoint === targetEndpoint) {
    return "same-endpoint";
  }
  return "relay-server";
}

/**
 * Builds the plan from a snapshot of the request. Guards run before any listing,
 * so a refused operation reads nothing it does not need. Symlinks are planned as
 * items and never followed.
 */
export async function buildPlan(
  rawRequest: PlanRequest,
  deps: PlannerDeps,
  signal: AbortSignal,
): Promise<OperationPlan> {
  // Checked before the schema so a huge selection is refused as a limit, not as a schema error.
  if (Array.isArray(rawRequest.sources) && rawRequest.sources.length > SCHEMA_MAX_ITEMS) {
    throw new CommanderError("limit_exceeded", "The selection has too many sources");
  }
  const req = snapshotRequest(rawRequest);
  signal.throwIfAborted();
  const caseOf = (id: EndpointId) => deps.provider(id).endpoint.caseSensitive;
  const sourceEndpoint = commonEndpoint(req.sources);
  const maxItems = Math.min(deps.limits.maxItems, SCHEMA_MAX_ITEMS);

  let targetEndpoint: EndpointId | null = null;
  switch (req.kind) {
    case "copy":
    case "move": {
      if (req.sources.length === 0 || req.targetDir === null) {
        throw invalidRequest("copy and move need sources and a target directory");
      }
      targetEndpoint = req.targetDir.endpoint;
      const targetEp = deps.provider(targetEndpoint).endpoint;
      assertNotIntoSelf(req.sources, req.targetDir, targetEp.caseSensitive);
      assertNotReplacingSource(req.sources, req.targetDir, targetEp.caseSensitive);
      assertWritable(targetEp);
      if (req.kind === "move") {
        assertWritable(deps.provider(sourceEndpoint!).endpoint);
        for (const source of req.sources) {
          assertRemovable(source, deps.protectedPathsFor(source.endpoint));
        }
      }
      break;
    }
    case "mkdir": {
      if (req.sources.length !== 0 || req.targetDir === null || req.newName === null) {
        throw invalidRequest("mkdir needs a target directory and a name, and no sources");
      }
      targetEndpoint = req.targetDir.endpoint;
      assertWritable(deps.provider(targetEndpoint).endpoint);
      break;
    }
    case "rename": {
      // S12 batch: every source is renamed by the pattern; the names are checked in renameBatchItems.
      if (req.pattern) {
        if (req.sources.length === 0 || req.newName !== null || req.targetDir !== null) {
          throw invalidRequest("a batch rename needs sources and a pattern, and no new name");
        }
        if (req.sources.length > BATCH_RENAME_MAX) {
          throw new CommanderError("limit_exceeded", "The batch rename has too many entries");
        }
        targetEndpoint = sourceEndpoint;
        assertWritable(deps.provider(sourceEndpoint!).endpoint);
        for (const source of req.sources) {
          assertRemovable(source, deps.protectedPathsFor(source.endpoint));
        }
        break;
      }
      if (req.sources.length !== 1 || req.newName === null || req.targetDir !== null) {
        throw invalidRequest("rename needs exactly one source and a new name");
      }
      if (sameNameExactly(lastSegment(req.sources[0].path), req.newName)) {
        throw new CommanderError("invalid_name", "The new name equals the current name");
      }
      // On a case-insensitive endpoint both Unicode forms name one entry, so a form-only change cannot be listed or checked.
      const current = lastSegment(req.sources[0].path);
      if (!deps.provider(req.sources[0].endpoint).endpoint.caseSensitive && "t" in current && "t" in req.newName
          && current.t.normalize("NFC") === req.newName.t.normalize("NFC")) {
        throw new CommanderError("invalid_name", "The new name differs from the current name only in Unicode form");
      }
      targetEndpoint = sourceEndpoint;
      assertWritable(deps.provider(sourceEndpoint!).endpoint);
      assertRemovable(req.sources[0], deps.protectedPathsFor(req.sources[0].endpoint));
      break;
    }
    case "delete": {
      if (req.sources.length === 0 || req.targetDir !== null) {
        throw invalidRequest("delete needs sources and no target");
      }
      targetEndpoint = null;
      assertWritable(deps.provider(sourceEndpoint!).endpoint);
      for (const source of req.sources) {
        assertRemovable(source, deps.protectedPathsFor(source.endpoint));
      }
      break;
    }
  }

  assertNoSourceOverlap(req.sources, caseOf);
  const recordsTargetDir = req.kind === "copy" || req.kind === "move" || req.kind === "mkdir";
  if (recordsTargetDir && req.targetDir !== null) {
    await assertDirectoryTarget(deps.provider(req.targetDir.endpoint), req.targetDir.path, signal);
  }

  const items: PlanItem[] = [];
  const budget: Budget = { pages: 0 };
  if (req.kind === "mkdir") {
    const path = join(req.targetDir!.path, req.newName!);
    const provider = deps.provider(targetEndpoint!);
    items.push({
      source: null,
      target: { endpoint: targetEndpoint!, path },
      kind: "dir",
      fingerprint: null,
      expectTarget: await expectationAt(provider, path, signal),
    });
  } else if (req.kind === "rename" && req.pattern) {
    items.push(...await renameBatchItems(req, deps, req.pattern, signal));
  } else if (req.kind === "rename") {
    const source = req.sources[0];
    const provider = deps.provider(source.endpoint);
    const sourceParent = parent(source.path);
    if (sourceParent === null) throw invalidRequest("The root cannot be renamed");
    const entry = await statExisting(provider, source.path, signal, "not_found");
    const target: ResourceRef = { endpoint: source.endpoint, path: join(sourceParent, req.newName!) };
    const targetIsSource = sameEntryRef(
      { endpoint: source.endpoint, path: source.path },
      target,
      caseOf,
    );
    items.push({
      source: { endpoint: source.endpoint, path: source.path },
      target,
      kind: entry.kind,
      fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
      expectTarget: targetIsSource ? "absent" : await expectationAt(provider, target.path, signal),
    });
  } else {
    const targetProvider = targetEndpoint === null ? null : deps.provider(targetEndpoint);
    for (const source of req.sources) {
      const provider = deps.provider(source.endpoint);
      const entry = await statExisting(provider, source.path, signal, "not_found");
      const target = req.kind === "delete" ? null : join(req.targetDir!.path, lastSegment(source.path));
      await walk(
        {
          provider,
          kind: req.kind,
          items,
          targetProvider,
          targetEndpoint,
          maxItems,
          maxDepth: deps.limits.maxDepth,
          budget,
          signal,
        },
        source.path,
        entry,
        target,
        0,
      );
    }
  }
  checkTargets(items, caseOf, req.kind);

  const unsigned = {
    id: deps.uuid(),
    kind: req.kind,
    createdAt: deps.now().toISOString(),
    initiator: req.initiator,
    sourceEndpoint,
    targetEndpoint,
    targetDir: recordsTargetDir ? req.targetDir : null,
    items,
    conflictPolicy: req.conflictPolicy,
    route: routeFor(sourceEndpoint, targetEndpoint),
    verify: req.verify,
    totalBytes: totalBytesOf(items),
  };
  const digest = await planDigest(unsigned);
  return OperationPlan.parse({ ...unsigned, digest });
}

/** Every listed name of one directory, read page by page within the listing cap. */
async function listAll(provider: FileProvider, dir: ResourcePath, signal: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor: string | null = null;
  do {
    const page = await provider.list(dir, { cursor, limit: LIST_PAGE_MAX }, signal);
    entries.push(...page.entries);
    if (entries.length > BATCH_LISTING_MAX) throw new CommanderError("limit_exceeded", "The directory is too large to rename in one batch");
    cursor = page.cursor;
  } while (cursor !== null);
  return entries;
}

/** The refusal for a name problem the preview found. The first problem refuses the whole plan. */
function refusalFor(problem: RenameProblem): CommanderError {
  switch (problem) {
    case "exists": return new CommanderError("already_exists", "A new name is already taken in this directory");
    case "duplicate": return new CommanderError("invalid_name", "Two entries would get the same new name");
    case "empty": return new CommanderError("invalid_name", "A new name would be empty");
    case "invalid_name": return new CommanderError("invalid_name", "A new name is not valid");
    case "invalid_regex": return new CommanderError("invalid_name", "The regular expression is not valid");
    case "unsafe_regex": return new CommanderError("invalid_name", "The regular expression is refused: only a flat expression with one repetition is allowed");
  }
}

/**
 * The renames of one batch: every source whose pattern result differs from its
 * name, each with the sibling target. Refuses the whole batch on any name problem.
 */
async function renameBatchItems(
  req: PlanRequest,
  deps: PlannerDeps,
  pattern: RenamePattern,
  signal: AbortSignal,
): Promise<PlanItem[]> {
  const caseOf = (id: EndpointId) => deps.provider(id).endpoint.caseSensitive;
  const dir = parent(req.sources[0].path);
  if (dir === null) throw invalidRequest("The root cannot be renamed");
  for (const source of req.sources) {
    const sourceDir = parent(source.path);
    if (sourceDir === null || !samePath(sourceDir, dir, caseOf(source.endpoint))) {
      throw invalidRequest("A batch rename needs entries from one directory");
    }
  }
  const provider = deps.provider(req.sources[0].endpoint);
  const selected: Entry[] = [];
  for (const source of req.sources) {
    selected.push(await statExisting(provider, source.path, signal, "not_found"));
  }
  const directory = await listAll(provider, dir, signal);
  const rows = previewRename(selected, pattern, { directory, caseSensitive: provider.endpoint.caseSensitive });
  const failed = rows.find((row) => row.problem !== null);
  if (failed?.problem) throw refusalFor(failed.problem);

  const changed = rows.flatMap((row, index) => (row.to !== null && !sameNameExactly(row.from, row.to) ? [{ row, index }] : []));
  if (changed.length === 0) throw new CommanderError("invalid_name", "The new names equal the current names");
  if (changed.length > Math.min(deps.limits.maxItems, BATCH_RENAME_MAX)) {
    throw new CommanderError("limit_exceeded", "The batch rename has too many entries");
  }

  const items: PlanItem[] = [];
  for (const { row, index } of changed) {
    const source: ResourceRef = { endpoint: req.sources[index].endpoint, path: req.sources[index].path };
    const target: ResourceRef = { endpoint: source.endpoint, path: join(dir, row.to!) };
    const entry = selected[index];
    items.push({
      source,
      target,
      kind: entry.kind,
      fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
      // A target that is another batch source records that source's current state; execution
      // checks it is absent once the batch has moved that source away.
      expectTarget: sameEntryRef(source, target, caseOf) ? "absent" : await expectationAt(provider, target.path, signal),
    });
  }
  return items;
}

/**
 * Target checks for a plan. A batch rename may hold a target that is another item's
 * source (a cycle such as a→b, b→a), because it moves through temporary names; only
 * duplicate targets are refused. Every other kind keeps the overlap guard.
 */
function checkTargets(items: PlanItem[], caseOf: (id: EndpointId) => boolean, kind: OperationKind): void {
  if (kind !== "rename" || items.length < 2) {
    assertNoTargetOverlap(items, caseOf, kind);
    return;
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (item.target === null) continue;
    const endpointCase = caseOf(item.target.endpoint);
    const key = item.target.endpoint + "\u0001" + item.target.path.segments.map((name) => segmentKey(name, endpointCase)).join("\u0000");
    if (seen.has(key)) throw new CommanderError("invalid_path", "Two items would write to the same target");
    seen.add(key);
  }
}

/** Every write, removal and target directory the plan needs must still be allowed. */
async function assertPlanStillAllowed(plan: OperationPlan, deps: PlannerDeps, signal: AbortSignal): Promise<void> {
  const removes = plan.kind === "delete" || plan.kind === "move" || plan.kind === "rename";
  if (plan.targetDir !== null) {
    await assertDirectoryTarget(deps.provider(plan.targetDir.endpoint), plan.targetDir.path, signal);
  }
  for (const item of plan.items) {
    if (item.target !== null) assertWritable(deps.provider(item.target.endpoint).endpoint);
    if (removes && item.source !== null) {
      assertWritable(deps.provider(item.source.endpoint).endpoint);
      assertRemovable(item.source, deps.protectedPathsFor(item.source.endpoint));
    }
  }
}

function sameFingerprint(current: Entry, expected: { size: string; mtimeNs: string | null }): boolean {
  return current.size === expected.size && current.mtimeNs === expected.mtimeNs;
}

/**
 * Checks the plan against the current state and returns the snapshot it checked.
 * The snapshot is taken synchronously, before the first await, so a caller's
 * later mutation of `plan` cannot reach the checks or the returned plan.
 *
 * Returns the indexes of items whose source (kind, size or mtime) changed or
 * vanished, or whose target no longer matches expectTarget.
 *
 * Known limit: a directory's mtimeNs can be null (the provider cannot report it).
 * A null matches null, so a change to such a directory's contents is not seen
 * unless its children are themselves planned items.
 */
export type ChangeReason = "source_changed" | "target_changed";
export interface ChangedItem {
  index: number;
  reason: ChangeReason;
}

export async function revalidate(
  plan: OperationPlan,
  deps: PlannerDeps,
  signal: AbortSignal,
): Promise<{ ok: true; plan: OperationPlan } | { ok: false; changed: ChangedItem[] }> {
  const parsed = OperationPlan.safeParse(structuredClone(plan));
  if (!parsed.success) throw new CommanderError("internal", "The plan does not match its schema");
  const snapshot = parsed.data;

  const { digest, ...unsigned } = snapshot;
  if ((await planDigest(unsigned)) !== digest) {
    throw new CommanderError("internal", "The plan does not match its digest");
  }
  await assertPlanStillAllowed(snapshot, deps, signal);

  // Targets were planned distinct under plan-time case rules. The endpoint may fold
  // them now, so the target overlap rules run again under the current rules.
  const caseOf = (id: EndpointId) => deps.provider(id).endpoint.caseSensitive;
  checkTargets(snapshot.items, caseOf, snapshot.kind);
  const changed: ChangedItem[] = [];
  for (const [index, item] of snapshot.items.entries()) {
    signal.throwIfAborted();
    const reason = await itemChange(item, snapshot.kind, deps, caseOf, signal);
    if (reason !== null) changed.push({ index, reason });
  }
  return changed.length === 0 ? { ok: true, plan: snapshot } : { ok: false, changed };
}

/** The first thing that changed for one item, or null. A target that is the item's own source is checked as a source only. */
async function itemChange(
  item: PlanItem,
  kind: OperationKind,
  deps: PlannerDeps,
  caseOf: (id: EndpointId) => boolean,
  signal: AbortSignal,
): Promise<ChangeReason | null> {
  if (item.source !== null && item.fingerprint !== null) {
    const entry = await deps.provider(item.source.endpoint).stat(item.source.path, signal);
    const unchanged = entry !== null && entry.kind === item.kind && sameFingerprint(entry, item.fingerprint);
    if (!unchanged) return "source_changed";
  }
  if (item.target !== null && item.expectTarget !== null) {
    if (item.source !== null && sameEntryRef(item.source, item.target, caseOf)) {
      // Only a rename may target its own source (a case-only change). For copy or move the
      // endpoint now folds the target onto the source: the plan cannot run, so stop with invalid_path.
      if (kind !== "rename") {
        throw new CommanderError("invalid_path", "The target now equals the item's own source");
      }
      return null;
    }
    const current = await deps.provider(item.target.endpoint).stat(item.target.path, signal);
    const unchanged = item.expectTarget === "absent"
      ? current === null
      : current !== null && sameFingerprint(current, item.expectTarget);
    if (!unchanged) return "target_changed";
  }
  return null;
}
