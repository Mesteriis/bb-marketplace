// The items of a tile's "…" menu come from one builder: the tile header and the
// title bar of the window show the same menu for the same tile.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TILE_TEXT } from "../../../src/ui/tiles/labels.ts";
import { tileMenuItems } from "../../../src/ui/tiles/tile-menu-items.ts";

function actions() {
  return { removeTab: vi.fn<(panelId: string) => void>(), removeTile: vi.fn<() => void>(), requestClose: vi.fn<(panelId: string) => void>() };
}

describe("tileMenuItems", () => {
  it("offers removing the tab and the tile, and routes them to the actions", () => {
    const calls = actions();
    const items = tileMenuItems("p1", { title: "Исполнитель" }, DEFAULT_TILE_TEXT, calls);

    expect(items.map((item) => item.label)).toEqual([DEFAULT_TILE_TEXT.removeTab, DEFAULT_TILE_TEXT.removeTile]);
    items[0].onSelect?.();
    items[1].onSelect?.();
    expect(calls.removeTab).toHaveBeenCalledWith("p1");
    expect(calls.removeTile).toHaveBeenCalledTimes(1);
  });

  it("adds «open beside» only when the host can open it", () => {
    const openBeside = vi.fn<(panelId: string) => void>();
    const items = tileMenuItems("p1", { title: "T" }, DEFAULT_TILE_TEXT, { ...actions(), openBeside });

    const item = items.find((entry) => entry.label === DEFAULT_TILE_TEXT.openBeside);
    item?.onSelect?.();
    expect(openBeside).toHaveBeenCalledWith("p1");
  });

  it("adds closing the whole block with its size when the panel has linked tiles", () => {
    const calls = actions();
    const items = tileMenuItems("p1", { title: "T", linkedCount: 2 }, DEFAULT_TILE_TEXT, calls);

    const item = items.find((entry) => entry.label === DEFAULT_TILE_TEXT.closeBlock(2));
    item?.onSelect?.();
    expect(calls.requestClose).toHaveBeenCalledWith("p1");
  });

  it("explains why handing over to another window is not possible, without an action", () => {
    const items = tileMenuItems("p1", { title: "T", handoffUnavailable: "Звонок живёт в этом окне." }, DEFAULT_TILE_TEXT, actions());

    const item = items.find((entry) => entry.label === "Передать в другое окно");
    expect(item?.onSelect).toBeUndefined();
    expect(item?.reason).toContain("Звонок живёт в этом окне.");
  });
});
