// Chertog in BB's title bar: the focused tile on the left, the workspace
// actions on the right, and the page title. They are thin adapters over the
// window's session, the same one the route draws from; BB mounts them apart
// from the route, so what they share lives in the workspace (see
// `chrome-actions.ts`).
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { closeGroup, closeTab, findGroup, listGroups } from "../../../core/layout/index.ts";
import { workspacePresets } from "../../../core/workspace/presets.ts";
import { HeaderActions, TileTitle } from "../../../ui/chrome/index.ts";
import { DEFAULT_TILE_TEXT, tileMenuItems, type PanelLabel } from "../../../ui/tiles/index.ts";
import { chromeActions } from "./chrome-actions.ts";
import { appStrings } from "./strings.ts";
import type { WindowWorkspace } from "./window-workspace.ts";
import type { WorkspaceSnapshot } from "./workspace-controller.ts";
import type { WorkspaceSession } from "./workspace-session.ts";
import { TILE_LIMIT } from "./workspace-session.ts";

/** Below this width of the title bar the actions fold into one menu. */
const NARROW_BELOW = 880;

interface ActiveTile {
  readonly panelId: string;
  readonly groupId: string;
  readonly label: PanelLabel;
}

/** Re-renders with the session, as the route does: there is one source of truth. */
function useSession(workspace: WindowWorkspace): WorkspaceSession {
  const { session } = workspace;
  useSyncExternalStore(session.subscribe, session.getVersion);
  return session;
}

/** The active panel of the focused tile, or `null` when the workspace is not loaded or that tile is empty. */
function activeTile(session: WorkspaceSession): ActiveTile | null {
  const state = session.surfaceState();
  if (state === null) return null;
  const group = findGroup(state.root, state.focusedGroupId);
  if (group === undefined || group.activeTab === null) return null;
  const panelId = group.activeTab;
  return { panelId, groupId: group.id, label: session.labels()[panelId] ?? { title: panelId } };
}

function saveDetail({ save, origin }: WorkspaceSnapshot): string | undefined {
  if (save.status === "failed") {
    return save.kind === "rejected" ? appStrings.saveRejected(save.reason) : appStrings.saveFailed(save.reason);
  }
  if (save.status === "conflict") return appStrings.conflictGaveUp;
  if (origin === "newer-version") return appStrings.newerVersion;
  if (origin === "corrupt") return appStrings.corrupt;
  return undefined;
}

export function ChertogHeaderTitle({ workspace }: { workspace: WindowWorkspace }) {
  const session = useSession(workspace);
  const tile = activeTile(session);
  const actions = chromeActions(session, workspace.dialogs);
  const menuItems =
    tile === null
      ? []
      : tileMenuItems(tile.panelId, tile.label, DEFAULT_TILE_TEXT, {
          removeTab: (panelId) => session.changeLayout((state) => closeTab(state, panelId)),
          removeTile: () => session.changeLayout((state) => closeGroup(state, tile.groupId)),
          openBeside: (panelId) => void session.openBeside(panelId),
          requestClose: (panelId) => void actions.requestClose(panelId),
        });
  return <TileTitle tile={tile?.label ?? null} fallback={appStrings.panelTitle} menuLabel={DEFAULT_TILE_TEXT.tileMenu} menuItems={menuItems} />;
}

/** Whether the title bar this component sits in is narrower than `NARROW_BELOW`. An unmeasured bar counts as wide. */
function useNarrowBar() {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const bar = element.closest("header") ?? element.ownerDocument.documentElement;
    const view = element.ownerDocument.defaultView;
    const measure = (): void => {
      const width = bar.getBoundingClientRect().width;
      setNarrow(width > 0 && width < NARROW_BELOW);
    };
    measure();
    const observer = view?.ResizeObserver ? new view.ResizeObserver(measure) : null;
    observer?.observe(bar);
    view?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", measure);
    };
  }, []);
  return { ref, narrow };
}

export function ChertogHeaderActions({ workspace, onNewThread }: { workspace: WindowWorkspace; onNewThread(): void }) {
  const session = useSession(workspace);
  const { ref, narrow } = useNarrowBar();
  const snapshot = session.controller.getSnapshot();
  const document = snapshot.document;
  const state = session.surfaceState();
  const actions = chromeActions(session, workspace.dialogs);
  return (
    <div ref={ref} className="flex shrink-0 items-center">
      {document !== null && state !== null && (
        <HeaderActions
          narrow={narrow}
          onNewThread={onNewThread}
          layouts={{
            layouts: document.layouts.map((layout) => ({ id: layout.id, name: layout.name })),
            activeLayoutId: document.activeLayoutId,
            presets: workspacePresets,
            saveStatus: snapshot.save.status,
            saveDetail: saveDetail(snapshot),
            onRetrySave: () => session.controller.retrySave(),
            onSwitch: (layoutId) => session.switchLayout(layoutId),
            onCreateFromCurrent: (name) => session.createLayoutFromCurrent(name),
            onCreateFromPreset: (id, name) => session.createFromPreset(id, name),
            onRename: (layoutId, name) => session.renameLayout(layoutId, name),
            onDuplicate: (layoutId, name) => session.duplicateLayout(layoutId, name),
            onDelete: (layoutId) => session.deleteLayout(layoutId),
            onReload: () => void session.controller.reload(),
          }}
          content={{
            sections: session.contentSections(),
            tileCount: listGroups(state.root).length,
            tileLimit: TILE_LIMIT,
            onOpen: (choice) => actions.open(choice, { kind: "new-tile" }),
            onFocusExisting: (panelId) => session.focusPanel(panelId),
          }}
          hiddenPanels={{
            panels: session.hiddenPanels(),
            onShow: (instanceId) => session.showHidden(instanceId),
            onClose: actions.requestCloseInstance,
          }}
        />
      )}
    </div>
  );
}

/** The page title of the pane: the focused tile; `null` leaves BB's default panel title. */
export function useChertogPageTitle(workspace: WindowWorkspace): { title: string; windowTitle: string } | null {
  const session = useSession(workspace);
  const title = activeTile(session)?.label.title ?? null;
  return useMemo(() => (title === null ? null : { title, windowTitle: `${title} — ${appStrings.panelTitle}` }), [title]);
}
