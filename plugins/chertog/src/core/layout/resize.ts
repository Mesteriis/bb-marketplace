// Dragging the divider between two children of a split.
import type { LayoutOptions, Rect } from "./geometry.ts";
import { DEFAULT_LAYOUT_OPTIONS, isCompact, minExtent, pixelBounds, spansOf, walkLayout } from "./geometry.ts";
import type { SplitNode, WorkspaceState } from "./model.ts";
import { mapNodes } from "./tree.ts";

/**
 * Moves the divider after child `index` of a split by `delta` pixels (right
 * or down when positive) in the given work area.
 *
 * Only the two children beside the divider change: one gains exactly the
 * pixels the other loses, their common share stays the same, and every other
 * share in the tree is left as it is. The move stops where a tile on either
 * side would get smaller than its minimum. Returns the same state when the
 * divider cannot move or is not on screen (maximized or compact view).
 */
export function resizeDivider(
  state: WorkspaceState,
  splitId: string,
  index: number,
  delta: number,
  bounds: Rect,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): WorkspaceState {
  if (state.maximizedGroupId !== null || isCompact(bounds, options) || !Number.isFinite(delta)) return state;
  let found: { split: SplitNode; boundaries: readonly number[]; available: number } | undefined;
  walkLayout(state.root, pixelBounds(bounds), options.dividerSize, {
    split: (split, _rect, spans) => {
      if (split.id === splitId) found = { split, boundaries: spans.boundaries, available: spans.available };
    },
  });
  if (found === undefined) return state;
  const { split, boundaries, available } = found;
  if (!Number.isInteger(index) || index < 0 || index > split.children.length - 2 || available <= 0) return state;

  const start = index === 0 ? 0 : boundaries[index - 1];
  const before = boundaries[index] - start;
  const after = boundaries[index + 1] - boundaries[index];
  const room = {
    back: Math.max(0, before - minExtent(split.children[index], split.direction, options)),
    forward: Math.max(0, after - minExtent(split.children[index + 1], split.direction, options)),
  };
  const moved = Math.min(Math.max(Math.round(delta), -room.back), room.forward);
  if (moved === 0) return state;

  // The new boundary is stored as a whole number of pixels over the pixels
  // available now, so this work area shows it exactly where it was dropped.
  // The shares on both sides of the pair are summed the way `spansOf` sums
  // them, so the pair's outer boundaries do not move.
  let shareBefore = 0;
  for (let child = 0; child < index; child += 1) shareBefore += split.sizes[child];
  const shareAfter = shareBefore + split.sizes[index] + split.sizes[index + 1];
  const boundary = (boundaries[index] + moved) / available;
  const first = boundary - shareBefore;
  const second = shareAfter - boundary;
  if (!(first > 0) || !(second > 0)) return state;

  const sizes = [...split.sizes];
  sizes[index] = first;
  sizes[index + 1] = second;
  return { ...state, root: mapNodes(state.root, (node) => (node === split ? { ...split, sizes } : node)) };
}
