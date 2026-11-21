// Sizes the geometry depends on, and class lists shared by the tile chrome.
// Classes are BB's theme tokens (border-border, bg-accent, ring-ring), the
// same ones the other Makosh plugins use.
import type { CSSProperties } from "react";
import type { Rect } from "../../core/layout/index.ts";

/** Height of a tile header in pixels. The content area of a tile starts below it. */
export const TILE_HEADER_HEIGHT = 32;

/** An absolutely placed box on whole pixels of the surface. */
export function rectStyle(rect: Rect): CSSProperties {
  return { position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** A small icon button in a tile header. */
export const CONTROL_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";
