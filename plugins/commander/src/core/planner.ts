import { CommanderError } from "./errors.ts";
import {
  assertDeletable,
  assertNotIntoSelf,
  assertNotReplacingSource,
  assertWritable,
} from "./guards.ts";
import {
  OperationPlan,
  planDigest,
  type ConflictPolicy,
  type EndpointId,
  type Entry,
  type Initiator,
  type OperationKind,
  type PlanItem,
  type ResourceRef,
  type Route,
  type Verify,
} from "./model.ts";
import { join, parent, parsePosix, type NameSegment, type ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { LIST_PAGE_MAX } from "./provider.ts";
import { addSize, type Size } from "./size.ts";

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

export interface PlannerDeps {
  provider(endpoint: EndpointId): FileProvider;
  now(): Date;
  uuid(): string;
  limits: { maxItems: number; maxDepth: number };
  /**
   * Paths delete must refuse (the host home, for example). The root and every
   * ancestor of these paths are refused as well. Defaults to none.
   */
  protectedPaths?: ResourcePath[];
}

function invalidRequest(message: string): CommanderError {
  return new CommanderError("invalid_path", message);
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

function nameText(name: NameSegment): string {
  return "t" in name ? name.t : atob(name.b);
}

async function listAll(
  provider: FileProvider,
  path: ResourcePath,
  signal: AbortSignal,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await provider.list(path, { cursor, limit: LIST_PAGE_MAX }, signal);
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);
  return entries;
}

interface Expansion {
  items: PlanItem[];
  /** Target endpoint for target refs, or null when there are none (delete). */
  targetEndpoint: EndpointId | null;
}

/**
 * Walks one source tree. Copy and move list a directory before its children so
 * the target directory exists first; delete lists children before the directory
 * because a provider removes only empty directories.
 */
async function expand(
  provider: FileProvider,
  root: { path: ResourcePath; entry: Entry; target: ResourcePath | null },
  expansion: Expansion,
  deps: PlannerDeps,
  signal: AbortSignal,
  kind: OperationKind,
): Promise<void> {
  const postOrder = kind === "delete";
  const sourceEndpoint = provider.endpoint.id;

  async function visit(
    srcPath: ResourcePath,
    entry: Entry,
    tgtPath: ResourcePath | null,
    depth: number,
  ): Promise<void> {
    signal.throwIfAborted();
    if (depth > deps.limits.maxDepth) {
      throw new CommanderError("limit_exceeded", "The tree is nested too deeply");
    }

    const item: PlanItem = {
      source: { endpoint: sourceEndpoint, path: srcPath },
      target: tgtPath === null || expansion.targetEndpoint === null
        ? null
        : { endpoint: expansion.targetEndpoint, path: tgtPath },
      kind: entry.kind,
      fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
    };

    if (!postOrder) pushItem(item);
    if (entry.kind === "dir") {
      for (const child of await listAll(provider, srcPath, signal)) {
        await visit(
          join(srcPath, child.name),
          child,
          tgtPath === null ? null : join(tgtPath, child.name),
          depth + 1,
        );
      }
    }
    if (postOrder) pushItem(item);
  }

  function pushItem(item: PlanItem): void {
    expansion.items.push(item);
    if (expansion.items.length > deps.limits.maxItems) {
      throw new CommanderError("limit_exceeded", "The operation has too many items");
    }
  }

  await visit(root.path, root.entry, root.target, 0);
}

function sumFileBytes(items: PlanItem[]): Size {
  return items.reduce<Size>(
    (total, item) =>
      item.kind === "file" && item.fingerprint !== null ? addSize(total, item.fingerprint.size) : total,
    "0",
  );
}

function routeFor(sourceEndpoint: EndpointId | null, targetEndpoint: EndpointId | null): Route {
  if (sourceEndpoint === null || targetEndpoint === null || sourceEndpoint === targetEndpoint) {
    return "same-endpoint";
  }
  return "relay-server";
}

/**
 * Builds the plan. Guards run before any listing so a refused operation reads
 * nothing it does not need. Symlinks are planned as items and never followed.
 */
export async function buildPlan(
  req: PlanRequest,
  deps: PlannerDeps,
  signal: AbortSignal,
): Promise<OperationPlan> {
  signal.throwIfAborted();
  const sourceEndpoint = commonEndpoint(req.sources);
  const protectedPaths = deps.protectedPaths ?? [];

  let targetEndpoint: EndpointId | null;
  switch (req.kind) {
    case "copy":
    case "move": {
      if (req.sources.length === 0 || req.targetDir === null) {
        throw invalidRequest("copy and move need sources and a target directory");
      }
      targetEndpoint = req.targetDir.endpoint;
      const targetProvider = deps.provider(targetEndpoint);
      assertNotIntoSelf(req.sources, req.targetDir, targetProvider.endpoint.caseSensitive);
      assertNotReplacingSource(req.sources, req.targetDir, targetProvider.endpoint.caseSensitive);
      assertWritable(targetProvider.endpoint);
      if (req.kind === "move") assertWritable(deps.provider(sourceEndpoint!).endpoint);
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
      break;
    }
    case "delete": {
      if (req.sources.length === 0 || req.targetDir !== null) {
        throw invalidRequest("delete needs sources and no target");
      }
      targetEndpoint = null;
      for (const source of req.sources) {
        assertDeletable(source, protectedPaths);
      }
      assertWritable(deps.provider(sourceEndpoint!).endpoint);
      break;
    }
  }

  const items: PlanItem[] = [];
  const expansion: Expansion = { items, targetEndpoint };

  if (req.kind === "mkdir") {
    const target = join(req.targetDir!.path, req.newName!);
    items.push({
      source: null,
      target: { endpoint: targetEndpoint!, path: target },
      kind: "dir",
      fingerprint: null,
    });
  } else if (req.kind === "rename") {
    const source = req.sources[0];
    const sourceParent = parent(source.path);
    if (sourceParent === null) throw invalidRequest("The root cannot be renamed");
    const provider = deps.provider(source.endpoint);
    const entry = await provider.stat(source.path, signal);
    if (entry === null) throw new CommanderError("not_found", "The source does not exist");
    items.push({
      source: { endpoint: source.endpoint, path: source.path },
      target: { endpoint: source.endpoint, path: join(sourceParent, req.newName!) },
      kind: entry.kind,
      fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs },
    });
  } else {
    for (const source of req.sources) {
      const provider = deps.provider(source.endpoint);
      const entry = await provider.stat(source.path, signal);
      if (entry === null) throw new CommanderError("not_found", "A source does not exist");
      const target = req.kind === "delete"
        ? null
        : join(req.targetDir!.path, lastSegment(source.path));
      await expand(provider, { path: source.path, entry, target }, expansion, deps, signal, req.kind);
    }
  }

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
    totalBytes: sumFileBytes(items),
  };
  const digest = await planDigest(unsigned);
  return OperationPlan.parse({ ...unsigned, digest });
}

/**
 * Compares each source item's stat with the plan's fingerprint. Returns the
 * indexes of items whose kind, size or mtime changed, or that are gone.
 */
export async function revalidate(
  plan: OperationPlan,
  deps: PlannerDeps,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; changed: number[] }> {
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
