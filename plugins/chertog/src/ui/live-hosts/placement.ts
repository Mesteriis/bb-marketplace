// Whole-pixel placement of a live host inside the layer.
import type { Rect } from "../../core/layout/index.ts";

/** Where a host container sits, in whole CSS pixels of the layer. */
export interface HostBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The box of a host that has never been shown. */
export const EMPTY_HOST_BOX: HostBox = { left: 0, top: 0, width: 0, height: 0 };

/**
 * The whole-pixel box of a content rectangle, or null when the rectangle
 * cannot be drawn (a coordinate that is not a finite number).
 *
 * Edges are rounded, not sizes: the right edge of one rectangle and the left
 * edge of its neighbour are the same number, so they land on the same pixel.
 * A negative size becomes zero.
 */
export function hostBox(rect: Rect): HostBox | null {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const left = Math.round(x);
  const top = Math.round(y);
  return {
    left,
    top,
    width: Math.max(0, Math.round(x + width) - left),
    height: Math.max(0, Math.round(y + height) - top),
  };
}

export function sameHostBox(a: HostBox, b: HostBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
