import { z } from "zod";
import { CommanderError } from "./errors.ts";
import {
  assertNoSourceOverlap,
  assertNoTargetOverlap,
  assertNotIntoSelf,
  assertNotReplacingSource,
  assertRemovable,
  assertWritable,
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
  type PlanItem,
  type Route,
} from "./model.ts";
import { NameSegment, join, parent, type ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { LIST_PAGE_MAX } from "./provider.ts";
import { fromBig, toBig, type Size } from "./size.ts";

/** The schema limit of OperationPlan.items; a configured maxItems cannot exceed it. */
const SCHEMA_MAX_ITEMS = 100_000;
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
}

const PlanRequestInput = z.object({
  kind: OperationKind,
  initiator: Initiator,
  sources: z.array(ResourceRef).max(SCHEMA_MAX_ITEMS),
  targetDir: ResourceRef.nullable(),
  newName: NameSegment.nullable(),
  conflictPolicy: ConflictPolicy,
  verify: Verify,
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

interface Walk {
  provider: FileProvider;
  kind: OperationKind;
  items: PlanItem[];
  targetEndpoint: EndpointId | null;
  maxItems: number;
  maxDepth: number;
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
  const item: PlanItem = {
    source: { endpoint: w.provider.endpoint.id, path: srcPath },
    target: tgtPath === null || w.targetEndpoint === null
      ? null
      : { endpoint: w.targetEndpoint, path: tgtPath },
    kind: entry.kind,
    fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
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
  let cursor: string | null = null;
  do {
    w.signal.throwIfAborted();
    const page = await w.provider.list(srcPath, { cursor, limit: LIST_PAGE_MAX }, w.signal);
    for (const child of page.entries) {
      const childPath = join(srcPath, child.name);
      const childEntry = await statExisting(w.provider, childPath, w.signal, "changed_since_plan");
      await walk(w, childPath, childEntry, tgtPath === null ? null : join(tgtPath, child.name), depth + 1);
    }
    cursor = page.cursor;
    if (cursor !== null) {
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
      if (req.sources.length !== 1 || req.newName === null || req.targetDir !== null) {
        throw invalidRequest("rename needs exactly one source and a new name");
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
  if (req.targetDir !== null && req.kind !== "rename" && req.kind !== "delete") {
    await assertDirectoryTarget(deps.provider(req.targetDir.endpoint), req.targetDir.path, signal);
  }

  const items: PlanItem[] = [];
  if (req.kind === "mkdir") {
    items.push({
      source: null,
      target: { endpoint: targetEndpoint!, path: join(req.targetDir!.path, req.newName!) },
      kind: "dir",
      fingerprint: null,
    });
  } else if (req.kind === "rename") {
    const source = req.sources[0];
    const provider = deps.provider(source.endpoint);
    const sourceParent = parent(source.path);
    if (sourceParent === null) throw invalidRequest("The root cannot be renamed");
    const entry = await statExisting(provider, source.path, signal, "not_found");
    items.push({
      source: { endpoint: source.endpoint, path: source.path },
      target: { endpoint: source.endpoint, path: join(sourceParent, req.newName!) },
      kind: entry.kind,
      fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
    });
  } else {
    for (const source of req.sources) {
      const provider = deps.provider(source.endpoint);
      const entry = await statExisting(provider, source.path, signal, "not_found");
      const target = req.kind === "delete" ? null : join(req.targetDir!.path, lastSegment(source.path));
      await walk(
        { provider, kind: req.kind, items, targetEndpoint, maxItems, maxDepth: deps.limits.maxDepth, signal },
        source.path,
        entry,
        target,
        0,
      );
    }
  }
  assertNoTargetOverlap(items, caseOf);

  const unsigned = {
    id: deps.uuid(),
    kind: req.kind,
    createdAt: deps.now().toISOString(),
    initiator: req.initiator,
    sourceEndpoint,
    targetEndpoint,
    items,
    conflictPolicy: req.conflictPolicy,
    route: routeFor(sourceEndpoint, targetEndpoint),
    verify: req.verify,
    totalBytes: totalBytesOf(items),
  };
  const digest = await planDigest(unsigned);
  return OperationPlan.parse({ ...unsigned, digest });
}

/** Every removal and write the plan needs must still be allowed under current policy. */
async function assertPlanStillAllowed(plan: OperationPlan, deps: PlannerDeps): Promise<void> {
  const removes = plan.kind === "delete" || plan.kind === "move" || plan.kind === "rename";
  for (const item of plan.items) {
    if (item.target !== null) assertWritable(deps.provider(item.target.endpoint).endpoint);
    if (removes && item.source !== null) {
      assertWritable(deps.provider(item.source.endpoint).endpoint);
      assertRemovable(item.source, deps.protectedPathsFor(item.source.endpoint));
    }
  }
}

/**
 * Checks that the plan is intact and that its sources still match. Returns the
 * indexes of items whose kind, size or mtime changed, or that are gone.
 *
 * Known limit: a directory's mtimeNs can be null (the provider cannot report it).
 * A null matches null, so a change to such a directory's contents is not seen
 * unless its children are themselves planned items.
 */
export async function revalidate(
  plan: OperationPlan,
  deps: PlannerDeps,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; changed: number[] }> {
  const { digest, ...unsigned } = plan;
  if ((await planDigest(unsigned)) !== digest) {
    throw new CommanderError("internal", "The plan does not match its digest");
  }
  await assertPlanStillAllowed(plan, deps);

  const changed: number[] = [];
  for (const [index, item] of plan.items.entries()) {
    if (item.source === null || item.fingerprint === null) continue;
    signal.throwIfAborted();
    const entry = await deps.provider(item.source.endpoint).stat(item.source.path, signal);
    const unchanged = entry !== null
      && entry.kind === item.kind
      && entry.size === item.fingerprint.size
      && entry.mtimeNs === item.fingerprint.mtimeNs;
    if (!unchanged) changed.push(index);
  }
  return changed.length === 0 ? { ok: true } : { ok: false, changed };
}
