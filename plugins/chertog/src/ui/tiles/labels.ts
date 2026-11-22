// What the tile chrome shows about a panel, and the surface's own texts.
// The surface knows panels only by id; the parent supplies these labels.

import type { TileMenuItem } from "./tile-menu.tsx";

export type PanelStatusTone = "idle" | "busy" | "attention" | "error";

export interface PanelLabel {
  readonly handoffUnavailable?: string;
  /** Items for handing the panel over to another window: one per target, or the reason there is none. */
  readonly handoffItems?: readonly TileMenuItem[];
  /** Tab text. */
  readonly title: string;
  /** What the panel is bound to: thread and project, branch, machine or environment. */
  readonly context?: string;
  /** A short state shown as a dot beside the tab; `label` is read out and shown on hover. */
  readonly status?: { readonly tone: PanelStatusTone; readonly label: string };
  /** How many linked tiles (children) the panel has in the open layout; closing the panel closes them too. */
  readonly linkedCount?: number;
}

export interface TileSurfaceText {
  readonly tabs: string;
  readonly emptyTile: string;
  readonly pickContent: string;
  readonly addTab: string;
  readonly closeTab: (title: string) => string;
  /** The close button of the bar: closes the active panel. */
  readonly closePanel: string;
  readonly tileMenu: string;
  readonly removeTab: string;
  readonly removeTile: string;
  readonly closeBlock: (count: number) => string;
  readonly openBeside: string;
  readonly maximize: string;
  readonly restore: string;
  readonly resize: string;
  readonly switchTile: string;
}

export const DEFAULT_TILE_TEXT: TileSurfaceText = {
  tabs: "Вкладки",
  emptyTile: "Новый тайл",
  pickContent: "Выбрать содержимое",
  addTab: "Добавить вкладку",
  closeTab: (title) => "Закрыть: " + title,
  closePanel: "Закрыть панель",
  tileMenu: "Действия тайла",
  removeTab: "Убрать вкладку из раскладки",
  removeTile: "Убрать тайл из раскладки",
  closeBlock: (count) => `Закрыть вместе с подчинёнными (${count})`,
  openBeside: "Открыть рядом…",
  maximize: "Развернуть",
  restore: "Восстановить",
  resize: "Изменить размер",
  switchTile: "Тайл",
};

/** The label of a panel; a panel the parent gave no label for shows its id. */
export function labelOf(panels: Readonly<Record<string, PanelLabel>>, panelId: string): PanelLabel {
  return panels[panelId] ?? { title: panelId };
}
