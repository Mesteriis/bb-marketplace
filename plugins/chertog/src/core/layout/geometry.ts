// Pixel geometry of a workspace: the rectangles of the groups and of the
// dividers between them inside the work area.
//
// Rounding happens in one place, `spansOf`: the children of a split get
// boundaries on whole pixels, and both neighbours of a boundary use that same
// number. So the groups and dividers tile the work area exactly: nothing
// overlaps, nothing is left uncovered, nothing reaches outside.
import type { LayoutNode, SplitDirection, SplitNode, WorkspaceState } from "./model.ts";
import { findGroup } from "./model.ts";

/** A rectangle in pixels of the coordinate system the work area is given in. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface LayoutOptions {
  /** Thickness of the divider between two children of a split, in pixels. */
  readonly dividerSize: number;
  /** A divider drag stops when a tile would get narrower or lower than this. */
  readonly minTileWidth: number;
  readonly minTileHeight: number;
  /** A work area narrower than this shows one tile on the whole surface. */
  readonly compactWidth: number;
  /** How far the edge drop zones reach into a tile, as a share of its width or height. */
  readonly dropEdgeFraction: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  dividerSize: 4,
  minTileWidth: 240,
  minTileHeight: 160,
  compactWidth: 640,
  dropEdgeFraction: 0.25,
};

export interface GroupRect {
  readonly groupId: string;
  readonly rect: Rect;
}

/** The divider after child `index` of a split. `direction` is the split's: a `row` divider is a vertical bar. */
export interface DividerRect {
  readonly splitId: string;
  readonly index: number;
  readonly direction: SplitDirection;
  readonly rect: Rect;
}

/**
 * `tiled` shows the whole tree. `maximized` and `compact` show one group on
 * the whole work area and no dividers; the tree is not changed by either.
 */
export interface LayoutGeometry {
  readonly mode: "tiled" | "maximized" | "compact";
  readonly bounds: Rect;
  readonly groups: readonly GroupRect[];
  readonly dividers: readonly DividerRect[];
}

/** The place of one child along the axis of its split, relative to the split's start. */
interface Span {
  readonly start: number;
  readonly size: number;
}

interface Spans {
  readonly spans: readonly Span[];
  /** Divider thickness actually used; less than the option when the split is too short for its dividers. */
  readonly thickness: number;
  /** Pixels shared between the children: the length without the dividers. */
  readonly available: number;
  /** End of each child in the divider-free space; the last one equals `available`. */
  readonly boundaries: readonly number[];
}

/**
 * A boundary at half a pixel goes up. The nudge keeps that true for a value a
 * few ulps under the half, so the same shares never round two ways.
 */
function roundBoundary(value: number): number {
  return Math.floor(value + 0.5 + 1e-7);
}

/** The work area on whole pixels, never with a negative size. */
export function pixelBounds(bounds: Rect): Rect {
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  return {
    x,
    y,
    width: Math.max(0, Math.round(bounds.x + bounds.width) - x),
    height: Math.max(0, Math.round(bounds.y + bounds.height) - y),
  };
}

/** Whole-pixel places of the children of a split along a length of `length` pixels. */
export function spansOf(sizes: readonly number[], length: number, dividerSize: number): Spans {
  const gaps = sizes.length - 1;
  const thickness = Math.min(Math.max(0, Math.round(dividerSize)), Math.floor(length / gaps));
  const available = length - thickness * gaps;
  const spans: Span[] = [];
  const boundaries: number[] = [];
  let share = 0;
  let previous = 0;
  sizes.forEach((size, index) => {
    share += size;
    const boundary = index === gaps ? available : Math.min(Math.max(roundBoundary(available * share), previous), available);
    spans.push({ start: previous + thickness * index, size: boundary - previous });
    boundaries.push(boundary);
    previous = boundary;
  });
  return { spans, thickness, available, boundaries };
}

function lengthAlong(rect: Rect, direction: SplitDirection): number {
  return direction === "row" ? rect.width : rect.height;
}

function slice(rect: Rect, direction: SplitDirection, start: number, size: number): Rect {
  return direction === "row"
    ? { x: rect.x + start, y: rect.y, width: size, height: rect.height }
    : { x: rect.x, y: rect.y + start, width: rect.width, height: size };
}

interface Visitor {
  group?(groupId: string, rect: Rect): void;
  split?(split: SplitNode, rect: Rect, spans: Spans): void;
}

/** Walks the tree in reading order, giving every node its rectangle. */
export function walkLayout(node: LayoutNode, rect: Rect, dividerSize: number, visitor: Visitor): void {
  if (node.kind === "group") {
    visitor.group?.(node.id, rect);
    return;
  }
  const spans = spansOf(node.sizes, lengthAlong(rect, node.direction), dividerSize);
  visitor.split?.(node, rect, spans);
  node.children.forEach((child, index) => {
    const span = spans.spans[index];
    walkLayout(child, slice(rect, node.direction, span.start, span.size), dividerSize, visitor);
  });
}

/** Whether the work area is too narrow for the tiled view. */
export function isCompact(bounds: Rect, options: LayoutOptions): boolean {
  return pixelBounds(bounds).width < options.compactWidth;
}

/**
 * The rectangles to draw for a state in a work area.
 *
 * In the tiled view the groups and dividers cover the work area exactly and
 * do not overlap. With a maximized group, or in a work area narrower than
 * `compactWidth`, one group takes the whole area: the maximized one, else the
 * focused one.
 */
export function computeLayout(state: WorkspaceState, bounds: Rect, options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS): LayoutGeometry {
  const area = pixelBounds(bounds);
  const compact = area.width < options.compactWidth;
  const alone = state.maximizedGroupId ?? (compact ? state.focusedGroupId : null);
  if (alone !== null && findGroup(state.root, alone) !== undefined) {
    return { mode: compact ? "compact" : "maximized", bounds: area, groups: [{ groupId: alone, rect: area }], dividers: [] };
  }
  const groups: GroupRect[] = [];
  const dividers: DividerRect[] = [];
  walkLayout(state.root, area, options.dividerSize, {
    group: (groupId, rect) => groups.push({ groupId, rect }),
    split: (split, rect, spans) => {
      for (let index = 0; index < split.children.length - 1; index += 1) {
        const span = spans.spans[index];
        dividers.push({
          splitId: split.id,
          index,
          direction: split.direction,
          rect: slice(rect, split.direction, span.start + span.size, spans.thickness),
        });
      }
    },
  });
  return { mode: "tiled", bounds: area, groups, dividers };
}

/**
 * The least length a node needs along an axis so that every tile inside it
 * keeps its minimum size. Children of a split along that axis scale with
 * their shares, so the tightest of them sets the length.
 */
export function minExtent(node: LayoutNode, axis: SplitDirection, options: LayoutOptions): number {
  if (node.kind === "group") return axis === "row" ? options.minTileWidth : options.minTileHeight;
  const needs = node.children.map((child) => minExtent(child, axis, options));
  if (node.direction !== axis) return Math.max(...needs);
  const tightest = Math.max(...needs.map((need, index) => need / node.sizes[index]));
  return Math.ceil(tightest) + Math.max(0, Math.round(options.dividerSize)) * (node.children.length - 1);
}
