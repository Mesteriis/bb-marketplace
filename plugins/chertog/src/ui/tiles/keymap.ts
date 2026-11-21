// Keyboard equivalents of the pointer gestures. The map is data, so a help
// screen or a command palette can list the same chords the header handles.
import type { Direction, WorkspaceState } from "../../core/layout/index.ts";
import {
  activateTab,
  findGroup,
  focusGroup,
  focusInDirection,
  moveGroupInDirection,
  moveTabInDirection,
  toggleMaximize,
} from "../../core/layout/index.ts";

export type TileCommand =
  | { readonly type: "focus"; readonly direction: Direction }
  | { readonly type: "moveTab"; readonly direction: Direction }
  | { readonly type: "moveGroup"; readonly direction: Direction }
  | { readonly type: "previousTab" }
  | { readonly type: "nextTab" }
  | { readonly type: "toggleMaximize" };

export interface TileKeyBinding {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly command: TileCommand;
}

const ARROWS: readonly [string, Direction][] = [
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
];

/**
 * Alt+arrow moves the focus to the tile on that side, Alt+Shift+arrow moves
 * the active tab there, Ctrl+Alt+arrow moves the whole tile. Plain left and
 * right switch tabs, Alt+Enter maximizes or restores. The Meta key is never
 * part of a chord.
 */
export const TILE_KEYMAP: readonly TileKeyBinding[] = [
  ...ARROWS.map(([key, direction]): TileKeyBinding => ({ key, alt: true, shift: false, ctrl: false, command: { type: "focus", direction } })),
  ...ARROWS.map(([key, direction]): TileKeyBinding => ({ key, alt: true, shift: true, ctrl: false, command: { type: "moveTab", direction } })),
  ...ARROWS.map(([key, direction]): TileKeyBinding => ({ key, alt: true, shift: false, ctrl: true, command: { type: "moveGroup", direction } })),
  { key: "ArrowLeft", alt: false, shift: false, ctrl: false, command: { type: "previousTab" } },
  { key: "ArrowRight", alt: false, shift: false, ctrl: false, command: { type: "nextTab" } },
  { key: "Enter", alt: true, shift: false, ctrl: false, command: { type: "toggleMaximize" } },
];

/** The part of a keyboard event a chord is matched on. */
export interface KeyChord {
  readonly key: string;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export function tileCommandForKey(event: KeyChord): TileCommand | null {
  if (event.metaKey) return null;
  const binding = TILE_KEYMAP.find(
    (candidate) =>
      candidate.key === event.key && candidate.alt === event.altKey && candidate.shift === event.shiftKey && candidate.ctrl === event.ctrlKey,
  );
  return binding?.command ?? null;
}

/**
 * The state after a command given on the header of `groupId`. The command
 * acts on that tile, so the tile is focused first. Returns the same state
 * object when the tile is unknown or the command has nowhere to go.
 */
export function applyTileCommand(state: WorkspaceState, groupId: string, command: TileCommand): WorkspaceState {
  const group = findGroup(state.root, groupId);
  if (group === undefined) return state;
  const from = focusGroup(state, groupId);
  switch (command.type) {
    case "focus":
      return focusInDirection(from, command.direction);
    case "moveGroup":
      return moveGroupInDirection(from, groupId, command.direction);
    case "moveTab":
      return group.activeTab === null ? from : moveTabInDirection(from, group.activeTab, command.direction);
    case "previousTab":
    case "nextTab": {
      if (group.activeTab === null || group.tabs.length < 2) return from;
      const step = command.type === "nextTab" ? 1 : group.tabs.length - 1;
      return activateTab(from, group.tabs[(group.tabs.indexOf(group.activeTab) + step) % group.tabs.length]);
    }
    case "toggleMaximize":
      return toggleMaximize(from, groupId);
  }
}
