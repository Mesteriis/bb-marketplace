import { CommanderError } from "./errors.ts";
import type { EndpointId, Endpoint, OperationKind, PlanItem, ResourceRef } from "./model.ts";
import { isAncestorOrSelf, parent, samePath, type NameSegment, type ResourcePath } from "./path.ts";

/**
 * Copy or move of a directory into itself or one of its descendants.
 *
 * Known limit: the comparison only covers one endpoint id. Two endpoints that
 * point at the same machine (two ids for one host) are not recognised yet; the
 * comparison should use Endpoint.machine once that is defined (later slice).
 */
export function assertNotIntoSelf(
  sources: ResourceRef[],
  targetDir: ResourceRef,
  caseSensitive: boolean,
): void {
  for (const source of sources) {
    if (source.endpoint !== targetDir.endpoint) continue;
    if (isAncestorOrSelf(source.path, targetDir.path, caseSensitive)) {
      throw new CommanderError("invalid_path", "An item cannot be copied or moved into itself");
    }
  }
}

/**
 * Copying an entry into its own directory would write the target over the
 * source. The target of a source is targetDir + its own name, so this is the
 * case where the source's parent is the target directory.
 */
export function assertNotReplacingSource(
  sources: ResourceRef[],
  targetDir: ResourceRef,
  caseSensitive: boolean,
): void {
  for (const source of sources) {
    if (source.endpoint !== targetDir.endpoint) continue;
    const sourceParent = parent(source.path);
    if (sourceParent !== null && samePath(sourceParent, targetDir.path, caseSensitive)) {
      throw new CommanderError("invalid_path", "An item cannot replace itself");
    }
  }
}

/**
 * Refuses the root, the protected paths, and every ancestor of them. The
 * comparison is case-insensitive so the refusal is as wide as possible.
 */
export function assertDeletable(ref: ResourceRef, protectedPaths: ResourcePath[]): void {
  const isRoot = ref.path.segments.length === 0;
  const protectsSomething = protectedPaths.some((protectedPath) =>
    isAncestorOrSelf(ref.path, protectedPath, false),
  );
  if (isRoot || protectsSomething) {
    throw new CommanderError("permission_denied", "This location cannot be deleted");
  }
}

/**
 * Removal (delete, and the source of move and rename) needs the host's protection
 * policy. A null policy means the host did not say what is protected, so removal
 * is refused: failing closed.
 */
export function assertRemovable(ref: ResourceRef, policy: ResourcePath[] | null): void {
  if (policy === null) {
    throw new CommanderError("permission_denied", "The host protection policy is unknown; removal is refused");
  }
  assertDeletable(ref, policy);
}

export function assertWritable(endpoint: Endpoint): void {
  if (endpoint.readOnly) {
    throw new CommanderError("read_only", "The endpoint is read-only");
  }
}

// ---- Overlaps ---------------------------------------------------------------

type CaseOf = (endpoint: EndpointId) => boolean;

/** Equal keys mean the same name on that endpoint (case folded when it is case-insensitive). */
export function segmentKey(name: NameSegment, caseSensitive: boolean): string {
  if ("b" in name) return "b" + name.b;
  return "t" + (caseSensitive ? name.t : name.t.normalize("NFC").toLowerCase());
}

/**
 * Keys of the endpoint root and of every prefix of the path, root first and the
 * path itself last. Two paths compare equal exactly when their keys are equal.
 */
function prefixKeys(ref: ResourceRef, caseSensitive: boolean): string[] {
  const root = ref.endpoint + "\u0001";
  const keys = [root];
  let acc = root;
  for (const name of ref.path.segments) {
    acc += segmentKey(name, caseSensitive) + "\u0000";
    keys.push(acc);
  }
  return keys;
}

/**
 * Rejects the same source listed twice, and a source that is an ancestor of
 * another source. Each would be expanded twice or move a subtree out from under
 * its own child.
 */
export function assertNoSourceOverlap(sources: ResourceRef[], caseOf: CaseOf): void {
  const keysOf = sources.map((source) => prefixKeys(source, caseOf(source.endpoint)));
  const selves = new Set<string>();
  for (const keys of keysOf) {
    const self = keys[keys.length - 1];
    if (selves.has(self)) {
      throw new CommanderError("invalid_path", "The same item is listed twice");
    }
    selves.add(self);
  }
  for (const keys of keysOf) {
    for (const ancestor of keys.slice(0, -1)) {
      if (selves.has(ancestor)) {
        throw new CommanderError("invalid_path", "One item is inside another selected item");
      }
    }
  }
}

/** The key of a path itself, the same one prefixKeys ends with. */
function selfKey(ref: ResourceRef, caseOf: CaseOf): string {
  const keys = prefixKeys(ref, caseOf(ref.endpoint));
  return keys[keys.length - 1];
}

/** Same endpoint and same path under that endpoint's case rules. */
export function sameEntryRef(a: ResourceRef, b: ResourceRef, caseOf: CaseOf): boolean {
  return a.endpoint === b.endpoint && selfKey(a, caseOf) === selfKey(b, caseOf);
}

/**
 * Rejects two items that write to the same target, and a target that lands on
 * another item's source on the same endpoint. Such a plan would overwrite material
 * it still has to read. Example: move [/src/a, /out/a/b] into /out lands /src/a at
 * /out/a, which contains the source /out/a/b.
 *
 * The one exemption is a rename whose target is its own source (the same path under
 * the endpoint's case rules, so /d/A -> /d/a on a case-insensitive endpoint). Every
 * other item whose target is its own source or an ancestor of it is refused, even
 * when it is the item's own: /d/a/a moved into /d lands on /d/a, which contains it.
 */
export function assertNoTargetOverlap(items: PlanItem[], caseOf: CaseOf, kind: OperationKind): void {
  const owners = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.target === null) return;
    const key = selfKey(item.target, caseOf);
    if (owners.has(key)) {
      throw new CommanderError("invalid_path", "Two items would write to the same target");
    }
    owners.set(key, index);
  });
  items.forEach((item, index) => {
    if (item.source === null) return;
    const ownSelf = selfKey(item.source, caseOf);
    for (const key of prefixKeys(item.source, caseOf(item.source.endpoint))) {
      const owner = owners.get(key);
      if (owner === undefined) continue;
      if (owner === index) {
        if (kind === "rename" && key === ownSelf) continue;
        throw new CommanderError("invalid_path", "An item cannot be placed on its own path or above it");
      }
      throw new CommanderError("invalid_path", "A target would land on another item's source");
    }
  });
}
