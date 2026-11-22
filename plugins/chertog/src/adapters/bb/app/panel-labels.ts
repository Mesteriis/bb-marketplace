// The labels the tiles and the title bar draw: the session's own, plus the
// handover items of the thread panels this window owns. One function, so the
// tile and the title bar menus cannot differ.
import { useSyncExternalStore } from "react";
import type { PanelLabel } from "../../../ui/tiles/index.ts";
import { handoffMenuItems } from "./window-handoff.ts";
import type { WindowWorkspace } from "./window-workspace.ts";
import { refOfPanel } from "./workspace-controller.ts";

/** The labels of every panel of the open layout. Call after `useHandoffState`: the items follow this window's ownership. */
export function panelLabels(workspace: WindowWorkspace): Record<string, PanelLabel> {
  const { session, handoff } = workspace;
  const labels = session.labels();
  const document = session.document();
  if (document === null) return labels;
  for (const panelId of Object.keys(labels)) {
    const ref = refOfPanel(document, panelId);
    const threadId = ref?.provider === "bb-thread" ? ref.params.threadId : undefined;
    if (typeof threadId !== "string") continue;
    const handoffItems = handoffMenuItems(handoff, threadId);
    if (handoffItems.length > 0) labels[panelId] = { ...labels[panelId], handoffItems };
  }
  return labels;
}

/** Re-renders when this window's ownership of threads changes. */
export function useHandoffState(workspace: WindowWorkspace): void {
  useSyncExternalStore(workspace.handoff.subscribe, workspace.handoff.read);
}
