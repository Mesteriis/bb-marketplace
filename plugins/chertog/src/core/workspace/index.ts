// Chertog workspace document: the versioned schema of what is stored, reading
// with migration, the operations on named layouts and panels, and the store
// port with the rule for two windows. Pure TypeScript and zod.
export type { NamedLayout, WorkspaceDocument, WorkspacePanel } from "./document.ts";
export {
  activeLayout,
  captionFrom,
  initialDocument,
  namedLayoutSchema,
  placedPanelIds,
  SCHEMA_VERSION,
  workspaceDocumentSchema,
  workspacePanelSchema,
  workspaceStateSchema,
} from "./document.ts";

export type { DroppedPart, MigrationChain, MigrationResult, WorkspaceReadResult } from "./read.ts";
export { migrateToVersion, readWorkspaceDocument, WORKSPACE_MIGRATIONS } from "./read.ts";

export type { LayoutTemplate, ListedPanel, WorkspaceChange, WorkspaceChangeRefusal } from "./operations.ts";
export {
  addLayoutFromTemplate,
  addPanelToGroup,
  applyLayoutOperation,
  changeActiveLayout,
  createLayout,
  deleteLayout,
  dropUnusedPanels,
  duplicateLayout,
  hiddenPanels,
  panelIdOfRef,
  registerPanel,
  removePanelFromLayout,
  renameLayout,
  setPanelTitle,
  switchLayout,
} from "./operations.ts";

export type { IdRename, WorkspaceEntry, WorkspaceMerge, WorkspaceSaveResult, WorkspaceStore } from "./store.ts";
export { decideSave, enterWorkspace, mergeDocuments } from "./store.ts";
