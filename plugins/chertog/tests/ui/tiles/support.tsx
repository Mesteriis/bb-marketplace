// Shared fixture of the tile surface tests: the acceptance layout "one tile on
// the left, two on the right" in a 1204 x 800 surface, and a parent that owns
// the state the way the real one will. Every expected number in the tests is
// written out by hand; nothing here computes geometry.
import { useState } from "react";
import { applyOperation, createWorkspace, splitGroup } from "../../../src/core/layout/index.ts";
import type { LayoutOptions, WorkspaceState } from "../../../src/core/layout/index.ts";
import { TileSurface } from "../../../src/ui/tiles/index.ts";
import type { ContentRects, PanelLabel, TileSurfaceChange, TileSurfaceProps } from "../../../src/ui/tiles/index.ts";

export const OPTIONS: LayoutOptions = {
  dividerSize: 4,
  minTileWidth: 240,
  minTileHeight: 120,
  compactWidth: 640,
  dropEdgeFraction: 0.25,
};

export const SIZE = { width: 1204, height: 800 };

export const PANELS: Record<string, PanelLabel> = {
  a: { title: "Исполнитель", context: "thr_a · bb-main" },
  b: { title: "Ревьюер", context: "thr_b · bb-main", status: { tone: "busy", label: "Работает" } },
  c: { handoffUnavailable: "Передача недоступна.", title: "Предпросмотр", context: "MacBook" },
};

/** a | (b / c): group-1 on the left, group-2 over group-4 on the right, group-4 focused. */
export function threeTiles(): WorkspaceState {
  const one = createWorkspace(["a"]);
  const two = splitGroup(one, "group-1", "right", "b");
  return splitGroup(two, "group-2", "bottom", "c");
}

export interface Calls {
  changes: TileSurfaceChange[];
  closes: string[];
  picks: string[];
  rects: ContentRects[];
  /** The state the parent holds now. */
  state: WorkspaceState;
}

export function newCalls(initial: WorkspaceState): Calls {
  return { changes: [], closes: [], picks: [], rects: [], state: initial };
}

/** A parent that applies what the surface asks for, as the real one does, and records every call. */
export function Harness({
  calls,
  size,
  ...rest
}: { calls: Calls; size: TileSurfaceProps["size"] } & Partial<Pick<TileSurfaceProps, "renderPicker" | "children" | "panels" | "onOpenBeside">>) {
  const [state, setState] = useState(calls.state);
  calls.state = state;
  return (
    <TileSurface
      state={state}
      panels={PANELS}
      {...(size === undefined ? {} : { size })}
      options={OPTIONS}
      onOperation={(change) => {
        calls.changes.push(change);
        setState((current) => (change.kind === "state" ? change.state : applyOperation(current, change.operation)));
      }}
      onRequestClose={(panelId) => calls.closes.push(panelId)}
      onPickContent={(groupId) => calls.picks.push(groupId)}
      onContentRects={(rects) => calls.rects.push(rects)}
      {...rest}
    />
  );
}

function styleBox(element: HTMLElement): string {
  const { left, top, width, height } = element.style;
  return [left, top, width, height].join(" ");
}

/** The inline `left top width height` of every tile and divider on the surface, as the browser was told. */
export function drawn(container: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tile of Array.from(container.querySelectorAll<HTMLElement>("[data-group-id]"))) result[tile.dataset.groupId as string] = styleBox(tile);
  for (const divider of Array.from(container.querySelectorAll<HTMLElement>("[data-divider]"))) result[divider.dataset.divider as string] = styleBox(divider);
  return result;
}

export const THREE_TILES_DRAWN = {
  "group-1": "0px 0px 600px 800px",
  "split-3#0": "600px 0px 4px 800px",
  "group-2": "604px 0px 600px 398px",
  "split-5#0": "604px 398px 600px 4px",
  "group-4": "604px 402px 600px 398px",
};

export function header(container: HTMLElement, groupId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-group-id="${groupId}"] [data-tile-header]`);
  if (found === null) throw new Error("no header for " + groupId);
  return found;
}

export function divider(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-divider="${id}"]`);
  if (found === null) throw new Error("no divider " + id);
  return found;
}

export function shields(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-chertog-shield]")).map(styleBox);
}

export function preview(container: HTMLElement): string | null {
  const found = container.querySelector<HTMLElement>("[data-chertog-drop-preview]");
  return found === null ? null : styleBox(found);
}
