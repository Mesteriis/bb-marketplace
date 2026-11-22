// Chertog tile surface: tile chrome, dividers and gestures over a workspace
// state. Host-agnostic React; panel content is drawn by another layer.
export type { ContentRects, TileSurfaceChange, TileSurfaceProps } from "./tile-surface.tsx";
export { TileSurface } from "./tile-surface.tsx";

export type { PickerSlot } from "./tile.tsx";
export type { SurfaceSize } from "./use-surface-size.ts";
export { TILE_HEADER_HEIGHT } from "./styles.ts";

export type { PanelLabel, PanelStatusTone, TileSurfaceText } from "./labels.ts";
export { DEFAULT_TILE_TEXT } from "./labels.ts";

export type { KeyChord, TileCommand, TileKeyBinding } from "./keymap.ts";
export { applyTileCommand, TILE_KEYMAP, tileCommandForKey, tileCommandOperation } from "./keymap.ts";

export type { TileMenuItem } from "./tile-menu.tsx";
export { TileMenu } from "./tile-menu.tsx";
export type { TileMenuActions } from "./tile-menu-items.ts";
export { tileMenuItems } from "./tile-menu-items.ts";
export { StatusDot } from "./status-dot.tsx";
