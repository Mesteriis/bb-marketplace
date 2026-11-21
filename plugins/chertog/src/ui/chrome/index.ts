// Workspace chrome: the controls around the tiled surface. Every component
// takes its data and reports the user's intent through props.
export { ClosePanelDialog, type ClosePanelDialogProps } from "./ClosePanelDialog.tsx";
export { ContentPicker, type ContentPickerProps } from "./ContentPicker.tsx";
export { HiddenPanelsList, type HiddenPanelsListProps } from "./HiddenPanelsList.tsx";
export { LayoutSwitcher, type LayoutSwitcherProps } from "./LayoutSwitcher.tsx";
export { WorkspaceToolbar, type WorkspaceToolbarProps } from "./WorkspaceToolbar.tsx";
export { chromeStrings } from "./strings.ts";
export type {
  ContentChoice,
  ContentItem,
  ContentPlacement,
  ContentSection,
  ContentSectionState,
  ContentTarget,
  HiddenPanelEntry,
  LayoutEntry,
  LayoutPresetEntry,
  SaveStatus,
} from "./types.ts";
