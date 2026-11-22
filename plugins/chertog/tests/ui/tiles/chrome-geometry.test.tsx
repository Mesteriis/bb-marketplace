// The look of a tile: a 24 px bar, 6 px between tiles and to the edge, a
// rounded border, and a content area inside the border for the live layer.
// Every expected number is written out by hand.
import { render } from "@testing-library/react";
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
