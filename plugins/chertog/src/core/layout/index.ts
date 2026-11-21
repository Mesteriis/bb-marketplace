// Chertog layout core: the tree of tiles, the operations on it, its pixel
// geometry and drop resolution. Pure TypeScript with no host, React or DOM.
export type { Direction, Edge, GroupNode, LayoutNode, SplitDirection, SplitNode, WorkspaceState } from "./model.ts";
export { createWorkspace, findGroup, findGroupOfPanel, findSplit, listGroups } from "./model.ts";

export type { LayoutOperation } from "./operations.ts";
export {
  activateTab,
  addTab,
  applyOperation,
  closeGroup,
  closeTab,
  focusGroup,
  maximizeGroup,
  moveGroup,
  moveTab,
  moveTabToEdge,
  restoreMaximized,
  splitGroup,
  swapGroups,
  toggleMaximize,
} from "./operations.ts";

export type { DividerRect, GroupRect, LayoutGeometry, LayoutOptions, Point, Rect } from "./geometry.ts";
export { computeLayout, DEFAULT_LAYOUT_OPTIONS } from "./geometry.ts";

export { resizeDivider } from "./resize.ts";

export { focusInDirection, moveGroupInDirection, moveTabInDirection, neighborInDirection } from "./navigation.ts";

export type { DragSource, DropResolution, DropZone } from "./drop.ts";
export { resolveDrop } from "./drop.ts";
