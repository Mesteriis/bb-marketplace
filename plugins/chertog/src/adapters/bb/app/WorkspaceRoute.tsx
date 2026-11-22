// The Chertog route: the workspace toolbar over the tile surface, on the
// whole area BB gives the nav panel. It draws tile chrome only. Live panel
// content belongs to the window's live layer; the route tells it where the
// surface is and where each content area lies.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { findGroup, listGroups, type Rect } from "../../../core/layout/index.ts";
import { workspacePresets } from "../../../core/workspace/presets.ts";
import { activeLayout } from "../../../core/workspace/index.ts";
import { ClosePanelDialog, ContentPicker, WorkspaceToolbar, type ContentChoice } from "../../../ui/chrome/index.ts";
import { classes, Modal } from "../../../ui/chrome/primitives.tsx";
import { TileSurface, type ContentRects, type SurfaceSize } from "../../../ui/tiles/index.ts";
import { appStrings } from "./strings.ts";
import type { WindowWorkspace } from "./window-workspace.ts";
import type { WorkspaceSnapshot } from "./workspace-controller.ts";
import { TILE_LIMIT, type ContentDestination } from "./workspace-session.ts";

/** A press on a header becomes a drag after this many pixels, as in the tile surface. */
const DRAG_THRESHOLD = 4;

export interface WorkspaceRouteProps {
  readonly workspace: WindowWorkspace;
  /** Opens BB's new thread screen. */
  onNewThread(): void;
  /** The size of the tile surface when the caller knows it; tests pass it, the app measures. */
  readonly surfaceSize?: SurfaceSize;
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

interface ClosingPanel {
  readonly panelId: string;
  readonly title: string;
  /** Whether the open layout places the panel: only then can it be hidden instead. */
  readonly placed: boolean;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

export function WorkspaceRoute({ workspace, onNewThread, surfaceSize }: WorkspaceRouteProps) {
  const { session, bridge } = workspace;
  useSyncExternalStore(session.subscribe, session.getVersion);
  const snapshot = session.controller.getSnapshot();
  const document = snapshot.document;

  // One surface per window: a second Chertog pane says so instead of doubling the panels.
  const [owner] = useState(() => ({}));
  const [owns, setOwns] = useState<boolean | null>(null);
  // The tile surface is a child, so it reports its rectangles before this
  // route has claimed the bridge: they are kept here and handed over then.
  const contentRects = useRef<ReadonlyMap<string, Rect>>(new Map());
  useLayoutEffect(() => {
    const claimed = bridge.claim(owner);
    setOwns(claimed);
    if (claimed) bridge.update(owner, { rects: contentRects.current });
    return () => bridge.release(owner);
  }, [bridge, owner]);
  useEffect(() => {
    if (owns === true) void session.controller.enter();
  }, [owns, session]);

  const surfaceHost = useRef<HTMLDivElement>(null);
  const measure = (): void => {
    const element = surfaceHost.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    bridge.update(owner, { box: { left: box.left, top: box.top, width: box.width, height: box.height } });
  };
  // After every render: a notice above the surface moves it without resizing the window.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = surfaceHost.current;
    if (element === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const view = element.ownerDocument.defaultView;
    view?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      view?.removeEventListener("resize", measure);
    };
  }, [owns, document === null]);

  // A tile menu opens over the content area, where the live layer is drawn:
  // the panel of that tile steps aside while the menu is open.
  const workspaceState = document === null ? null : activeLayout(document).workspace;
  const stateRef = useRef(workspaceState);
  stateRef.current = workspaceState;
  const covered = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const element = surfaceHost.current;
    if (element === null) return;
    const read = (): void => {
      const open = new Set<string>();
      for (const trigger of Array.from(element.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]'))) {
        const groupId = trigger.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
        const state = stateRef.current;
        const panelId = groupId === undefined || state === null ? null : (findGroup(state.root, groupId)?.activeTab ?? null);
        if (panelId !== null) open.add(panelId);
      }
      if (sameSet(open, covered.current)) return;
      covered.current = open;
      bridge.update(owner, { covered: open });
    };
    const observer = new MutationObserver(read);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-expanded"] });
    return () => observer.disconnect();
  }, [bridge, owner, owns, document === null]);

  // While a divider or a tile is dragged, the live layer lets the pointer
  // through; for a drag it also thins out, so the drop preview shows.
  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest("[data-divider]") !== null) {
      bridge.update(owner, { gesture: "resize" });
    } else if (event.target.closest("[data-tile-header]") !== null && event.target.closest("[data-tile-control]") === null) {
      press.current = { x: event.clientX, y: event.clientY };
    }
  };
  const onPointerMoveCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = press.current;
    if (start === null || Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
    press.current = null;
    bridge.update(owner, { gesture: "drag" });
  };
  const endGesture = (): void => {
    press.current = null;
    bridge.update(owner, { gesture: "none" });
  };

  const [closing, setClosing] = useState<ClosingPanel | null>(null);
  const [tabFor, setTabFor] = useState<string | null>(null);
  const [placing, setPlacing] = useState<ContentChoice | null>(null);
  const tabHeadingId = useId();
  const placeHeadingId = useId();

  if (owns === false) {
    return (
      <div role="status" className="flex h-full min-h-0 w-full flex-1 items-center justify-center bg-background p-4 text-sm text-muted-foreground">
        {appStrings.secondPlace}
      </div>
    );
  }
  if (document === null || workspaceState === null) {
    return (
      <div className="flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 bg-background p-4 text-sm text-muted-foreground">
        {snapshot.phase === "failed" ? (
          <>
            <p role="alert" className="text-destructive">
              {appStrings.loadFailed(snapshot.loadError ?? "")}
            </p>
            <button type="button" className={classes.button} onClick={() => void session.controller.enter()}>
              {appStrings.retry}
            </button>
          </>
        ) : (
          <p role="status">{appStrings.loading}</p>
        )}
      </div>
    );
  }

  const groups = listGroups(workspaceState.root);
  const labels = session.labels();
  const sections = session.contentSections();
  const placedPanels = new Set(groups.flatMap((group) => group.tabs));

  const open = (choice: ContentChoice, destination: ContentDestination): void => {
    if (choice.placement === "pick-place") setPlacing(choice);
    else session.openContent(choice, destination);
  };
  const requestClose = async (panelId: string): Promise<void> => {
    if ((await session.closePanel(panelId)) === "needs-confirmation") {
      setClosing({ panelId, title: session.labelOf(panelId).title, placed: placedPanels.has(panelId) });
    }
  };
  const requestCloseInstance = (instanceId: string): void => {
    const panelId = session.panelOfInstance(instanceId);
    if (panelId !== null) void requestClose(panelId);
  };
  const itemTitle = (choice: ContentChoice): string =>
    sections.find((section) => section.providerId === choice.providerId)?.items.find((item) => item.id === choice.itemId)?.title ?? appStrings.panelNeutral;

  const save = snapshot.save;
  return (
    <div data-chertog-route aria-label={appStrings.routeLabel} className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex w-full shrink-0 items-stretch">
        <div className="min-w-0 flex-1">
          <WorkspaceToolbar
            layouts={{
              layouts: document.layouts.map((layout) => ({ id: layout.id, name: layout.name })),
              activeLayoutId: document.activeLayoutId,
              presets: workspacePresets,
              saveStatus: save.status,
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
              sections,
              tileCount: groups.length,
              tileLimit: TILE_LIMIT,
              onOpen: (choice) => open(choice, { kind: "new-tile" }),
              onFocusExisting: (panelId) => session.focusPanel(panelId),
            }}
            hiddenPanels={{
              panels: session.hiddenPanels(),
              onShow: (instanceId) => session.showHidden(instanceId),
              onClose: requestCloseInstance,
            }}
          />
        </div>
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-background pr-2">
          <button type="button" className={classes.ghostButton} onClick={onNewThread}>
            {appStrings.newThread}
          </button>
        </div>
      </div>

      <Notices workspace={workspace} />

      <div
        ref={surfaceHost}
        data-chertog-surface-host
        className="relative min-h-0 w-full flex-1"
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={endGesture}
        onPointerCancelCapture={endGesture}
        onLostPointerCaptureCapture={endGesture}
      >
        <TileSurface
          state={workspaceState}
          panels={labels}
          {...(surfaceSize === undefined ? {} : { size: surfaceSize })}
          onOperation={(change) => session.applySurfaceChange(change)}
          onRequestClose={(panelId) => void requestClose(panelId)}
          onPickContent={(groupId) => setTabFor(groupId)}
          onContentRects={(rects: ContentRects) => {
            contentRects.current = new Map(Object.entries(rects));
            bridge.update(owner, { rects: contentRects.current });
          }}
          renderPicker={(slot) => (
            <div className="flex h-full w-full max-w-lg flex-col">
              <ContentPicker
                target="empty-tile"
                sections={sections}
                tileCount={groups.length}
                tileLimit={TILE_LIMIT}
                onOpen={(choice) => open(choice, { kind: "group", groupId: slot.groupId })}
                onFocusExisting={(panelId) => session.focusPanel(panelId)}
              />
            </div>
          )}
        />
      </div>

      {tabFor !== null && (
        <Modal labelledBy={tabHeadingId} onDismiss={() => setTabFor(null)} className="h-[min(32rem,100%)] max-w-lg">
          <ContentPicker
            target="tab"
            headingId={tabHeadingId}
            sections={sections}
            tileCount={groups.length}
            tileLimit={TILE_LIMIT}
            onOpen={(choice) => {
              setTabFor(null);
              open(choice, { kind: "group", groupId: tabFor });
            }}
            onFocusExisting={(panelId) => {
              setTabFor(null);
              session.focusPanel(panelId);
            }}
          />
        </Modal>
      )}

      {placing !== null && (
        <Modal labelledBy={placeHeadingId} onDismiss={() => setPlacing(null)}>
          <h2 id={placeHeadingId} className="text-sm font-medium">
            {appStrings.pickPlaceHeading(itemTitle(placing))}
          </h2>
          <p className={classes.muted}>{appStrings.pickPlaceHint}</p>
          <ul className="flex flex-col gap-1">
            {groups.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className={`${classes.button} w-full justify-start`}
                  onClick={() => {
                    setPlacing(null);
                    session.openContent({ ...placing, placement: "default" }, { kind: "group", groupId: group.id });
                  }}
                >
                  {appStrings.pickPlaceTile(group.activeTab === null ? appStrings.emptyTile : (labels[group.activeTab]?.title ?? appStrings.panelNeutral))}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button type="button" data-autofocus className={classes.button} onClick={() => setPlacing(null)}>
              {appStrings.pickPlaceCancel}
            </button>
          </div>
        </Modal>
      )}

      <ClosePanelDialog
        open={closing !== null}
        panelTitle={closing?.title ?? ""}
        onHide={() => {
          // A panel that is already out of the layout is hidden as it is.
          if (closing !== null && closing.placed) session.removeFromLayout(closing.panelId);
          setClosing(null);
        }}
        onCloseAndEnd={() => {
          if (closing !== null) void session.closePanel(closing.panelId, { confirmEndsSession: true });
          setClosing(null);
        }}
        onCancel={() => setClosing(null)}
      />
    </div>
  );
}

/** What the user must know about saving: a failure, a merge with another window, a refused change, an unreadable store. */
function Notices({ workspace }: { workspace: WindowWorkspace }) {
  const controller = workspace.session.controller;
  const { merge, refusal, dropped } = controller.getSnapshot();
  const rows: { key: string; tone: "error" | "info"; text: string; action?: { label: string; run(): void } }[] = [];
  if (dropped.length > 0) rows.push({ key: "dropped", tone: "info", text: appStrings.dropped(dropped.length) });
  if (merge !== null) {
    const parts = [
      appStrings.merged,
      ...merge.renamedLayouts.map((rename) => appStrings.mergedLayout(rename.name)),
      ...(merge.renamedPanels.length > 0 ? [appStrings.mergedPanels(merge.renamedPanels.length)] : []),
    ];
    rows.push({ key: "merge", tone: "info", text: parts.join(" "), action: { label: appStrings.dismiss, run: () => controller.dismissMerge() } });
  }
  if (refusal !== null) {
    rows.push({ key: "refusal", tone: "error", text: appStrings.refusal(refusal), action: { label: appStrings.dismiss, run: () => controller.dismissRefusal() } });
  }
  if (rows.length === 0) return null;
  return (
    <div data-chertog-notices className="flex w-full shrink-0 flex-col border-b border-border bg-background">
      {rows.map((row) => (
        <div key={row.key} className="flex min-h-7 items-center gap-2 px-2 py-1 text-xs">
          <span role={row.tone === "error" ? "alert" : "status"} className={`min-w-0 flex-1 ${row.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {row.text}
          </span>
          {row.action !== undefined && (
            <button type="button" className={classes.button} onClick={row.action.run}>
              {row.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
