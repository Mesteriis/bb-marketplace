// Sizes the geometry depends on, and class lists shared by the tile chrome.
// Classes are BB's theme tokens (border-border, bg-accent, ring-ring), the
// same ones the other Makosh plugins use.
import type { CSSProperties } from "react";
import type { Rect } from "../../core/layout/index.ts";

/** Height of a tile header in pixels. The content area of a tile starts below it. */
export const TILE_HEADER_HEIGHT = 24;

/** The gap between two tiles and between a tile and the edge of the surface, in pixels. The divider lies in it. */
export const TILE_GAP = 6;

/** The radius of the curve inside a tile border: BB's radius less the border. */
export const INNER_RADIUS = "calc(var(--radius) - 1px)";

/** Thickness of a tile's border in pixels. */
export const TILE_BORDER = 1;

/** Narrower than this a tile has no padding or gap in its bar. */
export const TIGHT_WIDTH = 96;

/** Narrower than this a tile does not show the project beside the buttons, so the buttons are the only thing that can wrap. */
export const CONTEXT_MIN_WIDTH = 200;

const BAR_BUTTONS = 4;
const BUTTON_SIZE = 20;
const BAR_GAP = 4;
const BAR_PADDING = 4;

/**
 * Put the tab strip above its actions when a row would clip the active title,
 * and give the four buttons as many extra rows as their width needs, so none
 * of them is cut off.
 */
export function tileHeaderHeight(width: number, populated: boolean): number {
  if (!populated || width >= 220) return TILE_HEADER_HEIGHT;
  const tight = width < TIGHT_WIDTH;
  const inner = width - TILE_BORDER * 2 - (tight ? 0 : BAR_PADDING * 2);
  const step = BUTTON_SIZE + (tight ? 0 : BAR_GAP);
  const perRow = Math.max(1, Math.floor((inner + (tight ? 0 : BAR_GAP)) / step));
  return TILE_HEADER_HEIGHT * (1 + Math.ceil(BAR_BUTTONS / perRow));
}

/** The visible body of a tile: inside its border and below its bar. The live layer places panel content there. */
export function tileBody(rect: Rect, populated: boolean): Rect {
  const width = Math.max(0, rect.width - TILE_BORDER * 2);
  const height = Math.max(0, rect.height - TILE_BORDER * 2);
  const header = Math.min(tileHeaderHeight(rect.width, populated), height);
  return { x: rect.x + TILE_BORDER, y: rect.y + TILE_BORDER + header, width, height: height - header };
}

/** An absolutely placed box on whole pixels of the surface. */
export function rectStyle(rect: Rect): CSSProperties {
  return { position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** A small icon button in a tile header. */
export const CONTROL_CLASS =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";
