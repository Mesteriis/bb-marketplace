// One tile: its header with the tab strip and controls, and the content
// picker when it has no tabs. The content of a panel is not drawn here: the
// area below the header is left clear for the layer that owns live panels.
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import type { GroupNode, Rect } from "../../core/layout/index.ts";
import { CloseIcon, MaximizeIcon, PlusIcon, RestoreIcon } from "./icons.tsx";
import { labelOf, type PanelLabel, type PanelStatusTone, type TileSurfaceText } from "./labels.ts";
import { CONTROL_CLASS, rectStyle, tileHeaderHeight, TILE_HEADER_HEIGHT } from "./styles.ts";
import { TileMenu } from "./tile-menu.tsx";

const STATUS_CLASS: Record<PanelStatusTone, string> = {
  idle: "bg-muted-foreground/50",
  busy: "bg-primary",
  attention: "bg-amber-500",
  error: "bg-destructive",
};

export interface PickerSlot {
  readonly groupId: string;
  /** Ask the parent to choose content for this tile. */
  pick(): void;
}

export interface TileProps {
  readonly group: GroupNode;
  readonly rect: Rect;
  readonly panels: Readonly<Record<string, PanelLabel>>;
  readonly text: TileSurfaceText;
  readonly focused: boolean;
  readonly maximized: boolean;
  /** Every tile of the layout, for the switcher of the compact view; absent in the other views. */
  readonly switcher?: readonly GroupNode[];
  /** The tile itself is being dragged, or the id of its tab that is. */
  readonly dragging: "group" | { readonly panelId: string } | null;
  readonly renderPicker?: (slot: PickerSlot) => ReactNode;
  onHeaderPointerDown(event: PointerEvent<HTMLElement>): void;
  onHeaderKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onActivateTab(panelId: string): void;
  onRequestClose(panelId: string): void;
  onRemoveTab(panelId: string): void;
  onRemoveTile(): void;
  onToggleMaximize(): void;
  onPick(): void;
  onSwitch(groupId: string): void;
}

/** A press on one of these is not a drag and not a header click. */
function onControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-tile-control]") !== null;
}

export function Tile(props: TileProps) {
  const { group, panels, text, focused, maximized, switcher, dragging } = props;
  const empty = group.activeTab === null;
  const headerHeight = tileHeaderHeight(props.rect.width, !empty);
  const tight = props.rect.width < 96;
  const narrow = headerHeight > TILE_HEADER_HEIGHT;
  const active = group.activeTab === null ? undefined : labelOf(panels, group.activeTab);
  const titleOf = (member: GroupNode): string => (member.activeTab === null ? text.emptyTile : labelOf(panels, member.activeTab).title);

  const onDoubleClick = (event: MouseEvent<HTMLElement>): void => {
    if (!empty && !onControl(event.target)) props.onToggleMaximize();
  };

  return (
    <section
      aria-label={active?.title ?? text.emptyTile}
      data-group-id={group.id}
      data-focused={focused ? "true" : undefined}
      data-dragging={dragging === "group" ? "true" : undefined}
      // Only the chrome takes the pointer; the content area below is left to the panel.
      style={{ ...rectStyle(props.rect), pointerEvents: "none" }}
      className={"text-xs " + (dragging === "group" ? "opacity-60" : "")}
    >
      <div
        data-tile-header
        data-tile-focus={empty ? "true" : undefined}
        tabIndex={empty ? 0 : undefined}
        style={{ height: headerHeight, boxSizing: "border-box", pointerEvents: "auto", touchAction: "none", userSelect: "none" }}
        className={
          "flex items-center border-b focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " +
          (tight ? "" : "gap-1 px-1 ") +
          (narrow ? "flex-wrap justify-end gap-y-0 " : "") +
          (focused ? "border-primary bg-accent text-accent-foreground" : "border-border bg-muted text-muted-foreground")
        }
        onPointerDown={(event) => {
          if (!onControl(event.target)) props.onHeaderPointerDown(event);
        }}
        onKeyDown={props.onHeaderKeyDown}
        onDoubleClick={onDoubleClick}
      >
        {switcher !== undefined && (
          <select
            data-tile-control
            aria-label={text.switchTile}
            title={titleOf(group)}
            value={group.id}
            onChange={(event) => props.onSwitch(event.target.value)}
            className="h-6 max-w-[40%] shrink-0 rounded border border-input bg-transparent px-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {switcher.map((member) => (
              <option key={member.id} value={member.id}>
                {titleOf(member)}
              </option>
            ))}
          </select>
        )}
        {empty ? (
          <span className="min-w-0 flex-1 truncate px-1">{text.emptyTile}</span>
        ) : (
          <div
            role="tablist"
            aria-label={text.tabs}
            className={"flex min-w-0 items-stretch overflow-x-auto " + (narrow ? "order-first h-7 w-full" : "h-full flex-1")}
          >
            {group.tabs.map((panelId) => {
              const label = labelOf(panels, panelId);
              const selected = panelId === group.activeTab;
              const dragged = dragging !== null && dragging !== "group" && dragging.panelId === panelId;
              return (
                <div
                  key={panelId}
                  role="presentation"
                  data-panel-id={panelId}
                  title={label.context === undefined ? label.title : label.title + " — " + label.context}
                  className={
                    "flex max-w-48 items-center border-r border-border transition-colors motion-reduce:transition-none " +
                    (tight ? "min-w-16 gap-0.5 " : "min-w-20 gap-1 pl-2 pr-1 ") +
                    (selected ? "bg-background text-foreground " : "hover:bg-background/60 ") +
                    (dragged ? "opacity-60" : "")
                  }
                >
                  {label.status !== undefined && (
                    <span role="img" aria-label={label.status.label} title={label.status.label} className={"h-1.5 w-1.5 shrink-0 rounded-full " + STATUS_CLASS[label.status.tone]} />
                  )}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    data-tile-focus={selected ? "true" : undefined}
                    className="h-full min-w-6 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    // A pointer click is handled on release by the surface, which tells it from a drag; this is Enter and Space.
                    onClick={(event) => {
                      if (event.detail === 0) props.onActivateTab(panelId);
                    }}
                  >
                    {label.title}
                  </button>
                  <button
                    type="button"
                    data-tile-control
                    tabIndex={-1}
                    aria-label={text.closeTab(label.title)}
                    title={text.closeTab(label.title)}
                    className={CONTROL_CLASS}
                    onClick={() => props.onRequestClose(panelId)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {active?.context !== undefined && (
          <span data-tile-context title={active.context} className="min-w-0 max-w-[40%] shrink truncate px-1 text-muted-foreground">
            {active.context}
          </span>
        )}
        {group.activeTab !== null && (
          <>
            <button type="button" data-tile-control aria-label={text.addTab} title={text.addTab} className={CONTROL_CLASS} onClick={props.onPick}>
              <PlusIcon />
            </button>
            <TileMenu
              label={text.tileMenu}
              items={[
                { label: text.removeTab, onSelect: () => props.onRemoveTab(group.activeTab as string) },
                { label: text.removeTile, onSelect: props.onRemoveTile },
              ]}
            />
            {switcher === undefined && (
              <button
                type="button"
                data-tile-control
                aria-label={maximized ? text.restore : text.maximize}
                title={maximized ? text.restore : text.maximize}
                aria-pressed={maximized}
                className={CONTROL_CLASS}
                onClick={props.onToggleMaximize}
              >
                {maximized ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
            )}
          </>
        )}
      </div>
      {empty && (
        <div
          style={{ position: "absolute", top: headerHeight, left: 0, right: 0, bottom: 0, pointerEvents: "auto" }}
          className="flex items-center justify-center overflow-auto bg-background p-4 text-sm text-muted-foreground"
        >
          {props.renderPicker !== undefined ? (
            props.renderPicker({ groupId: group.id, pick: props.onPick })
          ) : (
            <button
              type="button"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
              onClick={props.onPick}
            >
              {text.pickContent}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
