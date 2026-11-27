import { CommanderError } from "./errors.ts";
import type { Endpoint, ResourceRef } from "./model.ts";
import { isAncestorOrSelf, parent, samePath, type ResourcePath } from "./path.ts";

/** Copy or move of a directory into itself or one of its descendants. */
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
 * Refuses the root, the protected paths (the host home), and every ancestor of
 * them. Comparison is case-insensitive so the refusal is as wide as possible.
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

export function assertWritable(endpoint: Endpoint): void {
  if (endpoint.readOnly) {
    throw new CommanderError("read_only", "The endpoint is read-only");
  }
}
