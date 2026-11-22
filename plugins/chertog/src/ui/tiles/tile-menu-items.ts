// The items of the "…" menu of a tile, built once. The header of a tile and the
// title bar of the window both show this menu, so they cannot drift apart.
import type { PanelLabel, TileSurfaceText } from "./labels.ts";
import type { TileMenuItem } from "./tile-menu.tsx";

export interface TileMenuActions {
  removeTab(panelId: string): void;
  removeTile(): void;
  /** Without it the menu has no «open beside» item. */
  openBeside?(panelId: string): void;
  /** Asks to close the panel together with its linked tiles. */
  requestClose(panelId: string): void;
}

/** The menu of the active panel of a tile. An item that cannot run (handing over to another window) carries its reason and no action. */
export function tileMenuItems(panelId: string, label: PanelLabel | undefined, text: TileSurfaceText, actions: TileMenuActions): TileMenuItem[] {
  const { openBeside } = actions;
  return [
    { label: text.removeTab, onSelect: () => actions.removeTab(panelId) },
    { label: text.removeTile, onSelect: () => actions.removeTile() },
    ...(openBeside === undefined ? [] : [{ label: text.openBeside, onSelect: () => openBeside(panelId) }]),
    ...(label?.linkedCount ? [{ label: text.closeBlock(label.linkedCount), onSelect: () => actions.requestClose(panelId) }] : []),
    ...(label?.handoffItems ?? []),
    ...(label?.handoffUnavailable
      ? [
          {
            label: "Передать в другое окно",
            reason: label.handoffUnavailable + " Переместите целое окно BB средствами системы. Чтобы открыть второе окно, выберите New Window.",
          },
        ]
      : []),
  ];
}
