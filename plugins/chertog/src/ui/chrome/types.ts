// Props-level data of the workspace chrome. These are plain view types: the
// adapter that owns the workspace document maps its state onto them.

/** A named layout as the switcher lists it. */
export interface LayoutEntry {
  readonly id: string;
  readonly name: string;
}

/** A preset a new layout can be created from. */
export interface LayoutPresetEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export type SaveStatus = "saved" | "saving" | "conflict" | "failed" | "off";

/** One thing a provider can open: a thread, a chat, a machine. */
export interface ContentItem {
  readonly id: string;
  readonly title: string;
  /** The context that tells two items apart: the project of a thread, the account of a chat. */
  readonly context?: string;
  readonly status?: string;
  /** The tile that already shows this item in the current layout, when there is one. */
  readonly openInTileId?: string;
}

/** What a provider answered: its items, or why there are none to show. */
export type ContentSectionState = "ready" | "loading" | "missing" | "denied";

export interface ContentSection {
  readonly providerId: string;
  readonly title: string;
  readonly state: ContentSectionState;
  readonly items: readonly ContentItem[];
}

/**
 * Where the picked content goes. `empty-tile` fills the tile the picker is
 * shown in and `tab` joins an existing group; neither adds a tile. `new-tile`
 * adds one, so it is the only target the tile limit applies to.
 */
export type ContentTarget = "empty-tile" | "tab" | "new-tile";

/**
 * How to place the picked content. `default` follows the target. At the tile
 * limit the user chooses between `tab` (a tab in the focused group) and
 * `pick-place` (the user points at the tile to take).
 */
export type ContentPlacement = "default" | "tab" | "pick-place";

export interface ContentChoice {
  readonly providerId: string;
  readonly itemId: string;
  readonly placement: ContentPlacement;
}

/** A live panel that is in no tile of the current layout. */
export interface HiddenPanelEntry {
  readonly instanceId: string;
  readonly title: string;
  readonly context?: string;
}
