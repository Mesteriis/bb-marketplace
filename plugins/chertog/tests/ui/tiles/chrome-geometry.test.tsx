// The look of a tile: a 24 px bar, 6 px between tiles and to the edge, a
// rounded border, and a content area inside the border for the live layer.
// Every expected number is written out by hand.
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createWorkspace, toggleMaximize } from "../../../src/core/layout/index.ts";
import { CONTROL_CLASS, TILE_HEADER_HEIGHT, tileBody, tileHeaderHeight } from "../../../src/ui/tiles/index.ts";
import { divider, drawn, Harness, header, newCalls, SIZE, threeTiles } from "./support.tsx";

function section(container: HTMLElement, groupId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-group-id="${groupId}"]`);
  if (found === null) throw new Error("no tile " + groupId);
  return found;
}

describe("tile bar", () => {
  it("is 24 px high with 20 px buttons", () => {
    expect(TILE_HEADER_HEIGHT).toBe(24);
    expect(CONTROL_CLASS).toContain("h-5 w-5");
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    expect(header(container, "group-1").style.height).toBe("24px");
  });

  it("takes two rows in a tile narrower than 220 px, and one row for an empty tile", () => {
    expect(tileHeaderHeight(219, true)).toBe(48);
    expect(tileHeaderHeight(220, true)).toBe(24);
    expect(tileHeaderHeight(100, false)).toBe(24);
  });

  it("adds rows for the four buttons when they do not fit in one: 110 px takes two rows, 79 px three, 30 px five", () => {
    // 4 buttons of 20 px with 4 px gaps need 92 px plus 8 px of padding and 2 px of border.
    expect(tileHeaderHeight(110, true)).toBe(48);
    expect(tileHeaderHeight(102, true)).toBe(48);
    expect(tileHeaderHeight(101, true)).toBe(72);
    // Under 96 px the bar has no padding or gap, so a row holds floor((width - 2) / 20) buttons.
    expect(tileHeaderHeight(79, true)).toBe(72);
    expect(tileHeaderHeight(50, true)).toBe(72);
    expect(tileHeaderHeight(30, true)).toBe(120);
  });

  it("leaves no button outside a 110 px tile: the project label is dropped under 200 px, and every control is inside the tile", () => {
    const calls = newCalls(createWorkspace(["a"]));
    const { container } = render(<Harness calls={calls} size={{ width: 122, height: 300 }} />);
    // 122 px of surface, 6 px of edge on both sides: the tile is 110 px wide.
    const tile = section(container, "group-1");
    expect(tile.style.width).toBe("110px");
    expect(tile.querySelector("[data-tile-context]")).toBeNull();
    expect(header(container, "group-1").style.height).toBe("48px");
    expect(within(tile).getAllByRole("button").filter((b) => b.hasAttribute("data-tile-control")).map((b) => b.getAttribute("aria-label"))).toContain("Закрыть панель");
  });

  it("keeps the project label from 200 px up", () => {
    const { container } = render(<Harness calls={newCalls(createWorkspace(["a"]))} size={{ width: 212, height: 300 }} />);
    expect(section(container, "group-1").querySelector("[data-tile-context]")?.textContent).toBe("thr_a · bb-main");
  });
});

describe("tile geometry", () => {
  it("leaves 6 px between tiles and to the edge of the surface", () => {
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    expect(drawn(container)).toEqual({
      "group-1": "6px 6px 593px 788px",
      "split-3#0": "599px 6px 6px 788px",
      "group-2": "605px 6px 593px 391px",
      "split-5#0": "605px 397px 593px 6px",
      "group-4": "605px 403px 593px 391px",
    });
  });

  it("puts a divider in the gap and makes it at least as thick as before (4 px)", () => {
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    expect(divider(container, "split-3#0").style.width).toBe("6px");
    expect(divider(container, "split-5#0").style.height).toBe("6px");
    // The gap itself has no fill or border of its own.
    expect(divider(container, "split-3#0").className).not.toMatch(/\bbg-border\b/);
  });

  it("reports the content area inside the border and below the bar", () => {
    const calls = newCalls(threeTiles());
    render(<Harness calls={calls} size={SIZE} />);
    expect(calls.rects.at(-1)).toEqual({
      a: { x: 7, y: 31, width: 591, height: 762 },
      b: { x: 606, y: 31, width: 591, height: 365 },
      c: { x: 606, y: 428, width: 591, height: 365 },
    });
  });

  it("insets a narrow tile's content below both header rows", () => {
    const calls = newCalls(createWorkspace(["a"]));
    const { container } = render(<Harness calls={calls} size={{ width: 160, height: 300 }} />);
    expect(header(container, "group-1").style.height).toBe("48px");
    expect(calls.rects.at(-1)).toEqual({ a: { x: 7, y: 55, width: 146, height: 238 } });
  });

  it("insets a maximized tile from the edge too", () => {
    const calls = newCalls(toggleMaximize(threeTiles(), "group-1"));
    const { container } = render(<Harness calls={calls} size={SIZE} />);
    expect(drawn(container)).toEqual({ "group-1": "6px 6px 1192px 788px" });
    expect(calls.rects.at(-1)).toEqual({ a: { x: 7, y: 31, width: 1190, height: 762 } });
  });

  it("computes the body once for the tile and the live layer", () => {
    expect(tileBody({ x: 6, y: 6, width: 593, height: 788 }, true)).toEqual({ x: 7, y: 31, width: 591, height: 762 });
  });
});

describe("tile frame", () => {
  it("has a rounded theme border, a card body, and a primary border when focused", () => {
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    const focused = section(container, "group-4");
    const other = section(container, "group-1");
    for (const tile of [focused, other]) expect(tile.className).toMatch(/\bborder\b[\s\S]*\brounded-lg\b|\brounded-lg\b[\s\S]*\bborder\b/);
    expect(focused.className).toContain("border-primary");
    expect(other.className).toContain("border-border");
    expect(other.className).not.toContain("border-primary");
  });

  it("draws the surface itself without background", () => {
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    expect(container.querySelector<HTMLElement>("[data-chertog-surface]")!.className).not.toMatch(/\bbg-/);
  });
});

describe("tile bar close button", () => {
  it("sits last on the right, outside the tab strip, 20 px, and asks to close the active panel", () => {
    const calls = newCalls(threeTiles());
    const { container } = render(<Harness calls={calls} size={SIZE} />);
    const bar = header(container, "group-4");
    const button = within(bar).getByRole("button", { name: "Закрыть панель" });
    expect(button.closest('[role="tablist"]')).toBeNull();
    expect(button.className).toContain("h-5 w-5");
    const controls = Array.from(bar.querySelectorAll("button")).filter((b) => b.closest('[role="tablist"]') === null);
    expect(controls.at(-1)).toBe(button);
    fireEvent.click(button);
    expect(calls.closes).toEqual(["c"]);
    expect(calls.changes).toEqual([]);
  });

  it("is absent from an empty tile", () => {
    const { container } = render(<Harness calls={newCalls(createWorkspace([]))} size={SIZE} />);
    expect(container.querySelector('[aria-label="Закрыть панель"]')).toBeNull();
  });
});
