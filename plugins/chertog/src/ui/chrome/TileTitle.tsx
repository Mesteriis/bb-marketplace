// The left side of BB's title bar: what the focused tile shows (state dot,
// name, what it is bound to) and the tile's "…" menu. With no tile that has
// content it shows the product name.
import { StatusDot, TileMenu, type PanelLabel, type TileMenuItem } from "../tiles/index.ts";

export interface TileTitleProps {
  /** The active panel of the focused tile; `null` when that tile is empty or the workspace has none. */
  tile: Pick<PanelLabel, "title" | "context" | "status"> | null;
  /** Shown when there is no tile. */
  fallback: string;
  menuLabel: string;
  menuItems: readonly TileMenuItem[];
}

export function TileTitle({ tile, fallback, menuLabel, menuItems }: TileTitleProps) {
  if (tile === null) {
    return (
      <div data-chertog-header-title className="flex min-w-0 items-center text-sm font-medium text-foreground">
        <span className="truncate">{fallback}</span>
      </div>
    );
  }
  return (
    <div data-chertog-header-title className="flex min-w-0 items-center gap-2 text-sm text-foreground">
      {tile.status !== undefined && <StatusDot status={tile.status} />}
      <span title={tile.title} className="min-w-0 truncate font-medium">
        {tile.title}
      </span>
      {tile.context !== undefined && (
        <span title={tile.context} className="min-w-0 shrink truncate text-xs text-muted-foreground">
          {tile.context}
        </span>
      )}
      <TileMenu label={menuLabel} items={menuItems} />
    </div>
  );
}
