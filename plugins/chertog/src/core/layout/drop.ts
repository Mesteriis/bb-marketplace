// What a drag would do if it were dropped at a point.
import type { LayoutOptions, Point, Rect } from "./geometry.ts";
import { computeLayout, DEFAULT_LAYOUT_OPTIONS } from "./geometry.ts";
import type { Edge, WorkspaceState } from "./model.ts";
import { findGroupOfPanel } from "./model.ts";
import type { LayoutOperation } from "./operations.ts";
import { applyOperation } from "./operations.ts";

/** What is being dragged: one tab, or a whole group by its header. */
export type DragSource =
  | { readonly kind: "tab"; readonly panelId: string }
  | { readonly kind: "group"; readonly groupId: string };

export type DropZone = Edge | "center";

export interface DropResolution {
  readonly targetGroupId: string;
  readonly zone: DropZone;
  /** Where the dragged tab or group will be once the drop is applied. */
  readonly preview: Rect;
  readonly operation: LayoutOperation;
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

/** The nearest edge within the edge fraction, else the centre; in a corner left and right win over top and bottom. */
function zoneAt(rect: Rect, point: Point, edgeFraction: number): DropZone {
  const distances: readonly [Edge, number][] = [
    ["left", (point.x - rect.x) / rect.width],
    ["right", (rect.x + rect.width - point.x) / rect.width],
    ["top", (point.y - rect.y) / rect.height],
    ["bottom", (rect.y + rect.height - point.y) / rect.height],
  ];
  let zone: DropZone = "center";
  let nearest = edgeFraction;
  for (const [edge, distance] of distances) {
    if (distance < nearest) {
      zone = edge;
      nearest = distance;
    }
  }
  return zone;
}

function operationFor(source: DragSource, targetGroupId: string, zone: DropZone): LayoutOperation {
  if (source.kind === "tab") {
    return zone === "center"
      ? { type: "moveTab", panelId: source.panelId, targetGroupId }
      : { type: "moveTabToEdge", panelId: source.panelId, targetGroupId, edge: zone };
  }
  return zone === "center"
    ? { type: "swapGroups", groupId: source.groupId, targetGroupId }
    : { type: "moveGroup", groupId: source.groupId, targetGroupId, edge: zone };
}

/**
 * Resolves a drag held over `point`: the tile under it, the zone of that tile
 * (an edge or the centre), the operation a drop would apply, and the
 * rectangle the dragged thing would then occupy.
 *
 * An edge splits the target on that side. The centre swaps two groups for a
 * dragged header and joins the target's tabs for a dragged tab. Returns
 * `null` when a drop there would change nothing: outside the work area, on a
 * divider, on the dragged thing itself, or for a source that is not placed.
 * Resolving changes no state, so a cancelled drag needs no undo.
 */
export function resolveDrop(
  state: WorkspaceState,
  source: DragSource,
  point: Point,
  bounds: Rect,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): DropResolution | null {
  const target = computeLayout(state, bounds, options).groups.find((group) => contains(group.rect, point));
  if (target === undefined) return null;
  const zone = zoneAt(target.rect, point, options.dropEdgeFraction);
  const operation = operationFor(source, target.groupId, zone);
  const next = applyOperation(state, operation);
  if (next === state) return null;
  const landedIn = source.kind === "group" ? source.groupId : findGroupOfPanel(next.root, source.panelId)?.id;
  const landed = computeLayout(next, bounds, options).groups.find((group) => group.groupId === landedIn);
  return { targetGroupId: target.groupId, zone, preview: landed?.rect ?? target.rect, operation };
}
