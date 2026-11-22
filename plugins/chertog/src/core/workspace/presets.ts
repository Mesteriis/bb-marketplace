import { createWorkspace, focusGroup, splitGroup } from "../layout/index.ts";
import { CHOOSE_PROVIDER, type ChooseKind } from "../panels/choose.ts";
import type { CardType } from "../panels/entry-card.ts";
import type { PanelRef } from "../panels/ref.ts";
import type { WorkspaceDocument, WorkspacePanel } from "./document.ts";
import { addLayoutFromTemplate, switchLayout, type WorkspaceChange } from "./operations.ts";

function choose(kind: ChooseKind): PanelRef {
  return { provider: CHOOSE_PROVIDER, params: { kind } };
}

function card(provider: CardType): PanelRef {
  return { provider, params: {} };
}

/** Columns in reading order. Each entry occupies its own tile. */
export const workspacePresets = [
  { id: "agents", name: "Команда агентов", columns: [
    [choose("bb-thread"), choose("bb-diff")], [choose("bb-thread"), choose("bb-file-preview")],
  ] },
  { id: "administration", name: "Администрирование", columns: [
    [card("remote-ssh"), card("remote-rdp")], [card("remote-vnc"), choose("bb-terminal")],
  ] },
  { id: "call", name: "Созвон", columns: [[card("zoom")], [choose("bb-thread"), card("telegram")]] },
] as const;

/** Create fresh placements and activate the new layout. All operations here are document-only. */
export function applyPreset(document: WorkspaceDocument, layoutId: string, presetId: string): WorkspaceChange {
  const preset = workspacePresets.find(item => item.id === presetId);
  if (!preset) return { ok: false, reason: "invalid-layout" };
  const names = new Set(document.layouts.map(layout => layout.name.toLocaleLowerCase()));
  let name: string = preset.name;
  for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix++) name = preset.name + " " + suffix;

  const panels: Record<string, WorkspacePanel> = {};
  let next = 1;
  function place(ref: PanelRef): string {
    let id: string;
    do { id = "preset-" + next++; } while (Object.hasOwn(document.panels, id));
    panels[id] = { ref };
    return id;
  }

  const [left, right] = preset.columns;
  let workspace = createWorkspace([place(left[0])]);
  const leftId = workspace.focusedGroupId;
  workspace = splitGroup(workspace, leftId, "right", place(right[0]));
  const rightId = workspace.focusedGroupId;
  if (left[1]) workspace = splitGroup(workspace, leftId, "bottom", place(left[1]));
  workspace = splitGroup(workspace, rightId, "bottom", place(right[1]));
  workspace = focusGroup(workspace, leftId);
  const added = addLayoutFromTemplate(document, layoutId, { name, panels, workspace });
  return added.ok ? switchLayout(added.document, layoutId) : added;
}
