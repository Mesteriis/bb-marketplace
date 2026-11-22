// The tile surface of a Chertog workspace: tile chrome and dividers placed on
// whole pixels over the whole work area, pointer and keyboard gestures, and
// the rectangles where panel content goes.
//
// The surface draws no panel content. It reports the content rectangle of
// every visible active tab through `onContentRects`, and the layer that owns
// the live panels places them there. That layer may be passed as `children`:
// it is then drawn above the tile chrome and below the shield a gesture puts
// over the content areas.
//
// The state belongs to the parent. Every change is asked for through
// `onOperation` and shows once the parent passes the new state back.
import { containFileDrop } from "./file-drop.ts";
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { DragSource, LayoutOperation, LayoutOptions, Rect, WorkspaceState } from "../../core/layout/index.ts";
import {
  activateTab,
  closeGroup,
  closeTab,
  computeLayout,
  DEFAULT_LAYOUT_OPTIONS,
  findGroup,
  findSplit,
  focusGroup,
  listGroups,
  resizeDivider,
  toggleMaximize,
} from "../../core/layout/index.ts";
import { Divider } from "./divider.tsx";
import { applyTileCommand, tileCommandForKey, tileCommandOperation } from "./keymap.ts";
import { DEFAULT_TILE_TEXT, type PanelLabel, type TileSurfaceText } from "./labels.ts";
import { rectStyle, tileHeaderHeight } from "./styles.ts";
import { Tile, type PickerSlot } from "./tile.tsx";
import { useSurfaceSize, type SurfaceSize } from "./use-surface-size.ts";
import { useTileGestures } from "./use-tile-gestures.ts";

/**
 * A change the surface asks the parent to make. A drop is an `operation` for
 * the parent to apply; everything else (focus, tab switch, resize, maximize,
 * removal from the layout) comes as the resulting `state`.
 */
export type TileSurfaceChange =
  | { readonly kind: "operation"; readonly operation: LayoutOperation }
  /** `via`: for a keyboard move, the operation the state is the result of (after focusing its tile), so the parent can move linked tiles along. */
  | { readonly kind: "state"; readonly state: WorkspaceState; readonly via?: LayoutOperation };

/** Content rectangle of every visible active tab, by panel id, in surface pixels. */
export type ContentRects = Readonly<Record<string, Rect>>;

export interface TileSurfaceProps {
  readonly state: WorkspaceState;
  /** Labels of the panels by id. A panel without one shows its id. */
  readonly panels: Readonly<Record<string, PanelLabel>>;
  onOperation(change: TileSurfaceChange): void;
  /** The close button of a tab. The parent decides what closing means; the layout is not changed here. */
  onRequestClose(panelId: string): void;
  /** An empty tile, or the add button of a tile, asks for content. */
  onPickContent(groupId: string): void;
  /** The menu item "open beside" of a tile: a picker opens as a child of the tile's active panel. Without it the menu has no such item. */
  onOpenBeside?(panelId: string): void;
  /** Called when the content rectangles change, a dragged divider included. */
  onContentRects?(rects: ContentRects): void;
  /** Draws the body of an empty tile. Without it the tile shows one button that calls `onPickContent`. */
  readonly renderPicker?: (slot: PickerSlot) => ReactNode;
  /** The size of the surface when the parent knows it. Without it the surface measures its container. */
  readonly size?: SurfaceSize;
  readonly options?: LayoutOptions;
  readonly text?: Partial<TileSurfaceText>;
  /** The layer of live panel content. */
  readonly children?: ReactNode;
}

function contentRectsOf(state: WorkspaceState, groups: readonly { groupId: string; rect: Rect }[]): ContentRects {
  const rects: Record<string, Rect> = {};
  for (const { groupId, rect } of groups) {
    const panelId = findGroup(state.root, groupId)?.activeTab;
    if (panelId === null || panelId === undefined) continue;
    const header = Math.min(tileHeaderHeight(rect.width, true), rect.height);
    rects[panelId] = { x: rect.x, y: rect.y + header, width: rect.width, height: rect.height - header };
  }
  return rects;
}

function draggedIn(source: DragSource | null, groupId: string): "group" | { panelId: string } | null {
  if (source === null) return null;
  if (source.kind === "group") return source.groupId === groupId ? "group" : null;
  return { panelId: source.panelId };
}

export function TileSurface(props: TileSurfaceProps) {
  const { state, panels, onOperation, options = DEFAULT_LAYOUT_OPTIONS } = props;
  const text = useMemo(() => ({ ...DEFAULT_TILE_TEXT, ...props.text }), [props.text]);
  const surface = useRef<HTMLDivElement>(null);
  const size = useSurfaceSize(surface, props.size);
  const bounds = useMemo<Rect>(() => ({ x: 0, y: 0, width: size?.width ?? 0, height: size?.height ?? 0 }), [size?.width, size?.height]);

  const ask = (next: WorkspaceState): void => {
    if (next !== state) onOperation({ kind: "state", state: next });
  };

  const mode = computeLayout(state, bounds, options).mode;
  const gestures = useTileGestures({
    state,
    bounds,
    options,
    canDrag: mode === "tiled",
    surface,
    onResized: ask,
    onDropped: (resolution) => onOperation({ kind: "operation", operation: resolution.operation }),
    onClicked: (source) => ask(source.kind === "tab" ? activateTab(state, source.panelId) : focusGroup(state, source.groupId)),
  });

  const shown = gestures.shown;
  const geometry = useMemo(() => (size === null ? null : computeLayout(shown, bounds, options)), [size, shown, bounds, options]);
  const contentRects = useMemo(() => (geometry === null ? null : contentRectsOf(shown, geometry.groups)), [geometry, shown]);

  // The parent hears of content rectangles only when a number in them changes.
  const rectsKey = contentRects === null ? null : JSON.stringify(contentRects);
  const reportRects = props.onContentRects;
  useLayoutEffect(() => {
    if (contentRects !== null) reportRects?.(contentRects);
    // Keyed by the numbers: an equal set of rectangles in a new object is not a change.
  }, [rectsKey]);

  // After a keyboard command the DOM focus goes where the layout focus went:
  // a tab that moved to another tile is a new element there.
  const focusAfter = useRef<WorkspaceState | null>(null);
  useLayoutEffect(() => {
    if (focusAfter.current === null || focusAfter.current === state) return;
    focusAfter.current = null;
    const tiles = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-group-id]") ?? []);
    tiles.find((tile) => tile.dataset.groupId === state.focusedGroupId)?.querySelector<HTMLElement>("[data-tile-focus]")?.focus();
  });

  const onHeaderKeyDown = (event: KeyboardEvent<HTMLElement>, groupId: string): void => {
    const command = tileCommandForKey(event);
    if (command === null) return;
    // Plain arrows switch tabs only from a tab; in a control they keep their own meaning.
    const onTab = event.target instanceof Element && event.target.closest('[role="tab"]') !== null;
    if ((command.type === "previousTab" || command.type === "nextTab") && !onTab) return;
    event.preventDefault();
    const next = applyTileCommand(state, groupId, command);
    if (next === state) return;
    focusAfter.current = state;
    const via = tileCommandOperation(state, groupId, command);
    onOperation({ kind: "state", state: next, ...(via === undefined ? {} : { via }) });
  };

  const dragActive = gestures.dragging !== null;
  const allGroups = geometry?.mode === "compact" ? listGroups(shown.root) : undefined;

  return (
    <div
      ref={surface}
      data-chertog-surface={geometry?.mode ?? "unmeasured"}
      // Focusable from code only: a gesture parks the keyboard here when it was inside a frame.
      tabIndex={-1}
      style={{
        outline: "none",
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        // Menus must stack above live panels mounted outside this surface.
        ...(dragActive ? { cursor: gestures.drop === null ? "not-allowed" : "grabbing" } : {}),
      }}
      className="bg-background text-foreground"
      {...gestures.surfaceHandlers}
      onDragOver={containFileDrop}
      onDrop={containFileDrop}
    >
      {geometry?.groups.map(({ groupId, rect }) => {
        const group = findGroup(shown.root, groupId);
        if (group === undefined) return null;
        return (
          <Tile
            key={groupId}
            group={group}
            rect={rect}
            panels={panels}
            text={text}
            focused={shown.focusedGroupId === groupId}
            maximized={shown.maximizedGroupId === groupId}
            {...(allGroups === undefined ? {} : { switcher: allGroups })}
            dragging={draggedIn(gestures.dragging, groupId)}
            {...(props.renderPicker === undefined ? {} : { renderPicker: props.renderPicker })}
            onHeaderPointerDown={(event) => {
              const tab = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-panel-id]") : null;
              const panelId = tab?.dataset.panelId;
              gestures.beginDrag(event, panelId === undefined ? { kind: "group", groupId } : { kind: "tab", panelId });
            }}
            onHeaderKeyDown={(event) => onHeaderKeyDown(event, groupId)}
            onActivateTab={(panelId) => ask(activateTab(state, panelId))}
            onRequestClose={props.onRequestClose}
            onRemoveTab={(panelId) => ask(closeTab(state, panelId))}
            onRemoveTile={() => ask(closeGroup(state, groupId))}
            onToggleMaximize={() => ask(toggleMaximize(state, groupId))}
            onPick={() => props.onPickContent(groupId)}
            {...(props.onOpenBeside === undefined ? {} : { onOpenBeside: props.onOpenBeside })}
            onSwitch={(target) => ask(focusGroup(state, target))}
          />
        );
      })}
      {geometry?.dividers.map((divider) => {
        const sizes = findSplit(shown.root, divider.splitId)?.sizes;
        const before = sizes?.[divider.index] ?? 0;
        const pair = before + (sizes?.[divider.index + 1] ?? 0);
        return (
          <Divider
            key={divider.splitId + "#" + divider.index}
            divider={divider}
            position={pair > 0 ? Math.round((before / pair) * 100) : 0}
            label={text.resize}
            onPointerDown={(event) => gestures.beginResize(event, divider.splitId, divider.index, divider.direction)}
            onNudge={(delta) => ask(resizeDivider(state, divider.splitId, divider.index, delta, bounds, options))}
          />
        );
      })}
      {props.children}
      {gestures.engaged &&
        contentRects !== null &&
        // During a gesture nothing below may take the pointer: an iframe would swallow the moves.
        Object.entries(contentRects).map(([panelId, rect]) => <div key={panelId} data-chertog-shield aria-hidden="true" style={{ ...rectStyle(rect), zIndex: 30 }} />)}
      {gestures.drop !== null && (
        <div
          data-chertog-drop-preview
          aria-hidden="true"
          style={{ ...rectStyle(gestures.drop.preview), zIndex: 31, pointerEvents: "none" }}
          className="rounded-sm border-2 border-primary bg-primary/20"
        />
      )}
    </div>
  );
}
