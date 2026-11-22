// Pointer gestures of the tile surface on the acceptance layout of the spec,
// row "Полное покрытие и реальные жесты мышью": what is drawn before a
// gesture, while the pointer is held and after it, and how many changes the
// parent is asked for.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { divider, drawn, Harness, header, newCalls, preview, shields, SIZE, THREE_TILES_DRAWN, threeTiles } from "./support.tsx";

const POINTER = { pointerId: 1, button: 0 };

function setup() {
  const initial = threeTiles();
  const calls = newCalls(initial);
  const view = render(<Harness calls={calls} size={SIZE} />);
  return { calls, container: view.container, initial };
}

describe("drawing", () => {
  it("places tiles and dividers on whole pixels that cover the surface", () => {
    const { container } = setup();
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    const surface = container.firstElementChild as HTMLElement;
    expect(surface.style.overflow).toBe("hidden");
    expect(surface.style.position).toBe("relative");
  });

  it("reports the content area of every active tab, below the tile header", () => {
    const { calls } = setup();
    expect(calls.rects).toEqual([
      {
        a: { x: 0, y: 32, width: 600, height: 768 },
        b: { x: 604, y: 32, width: 600, height: 366 },
        c: { x: 604, y: 434, width: 600, height: 366 },
      },
    ]);
  });

  it("puts no layer over the content areas outside a gesture", () => {
    const { container } = setup();
    expect(shields(container)).toEqual([]);
    expect(preview(container)).toBeNull();
  });

  it("draws nothing until the surface has a size", () => {
    const calls = newCalls(threeTiles());
    const { container } = render(<Harness calls={calls} size={undefined} />);
    expect(drawn(container)).toEqual({});
    expect(calls.rects).toEqual([]);
  });
});

describe("dragging a divider", () => {
  it("moves the vertical divider in the frame and asks for one change on release", () => {
    const { calls, container } = setup();
    const bar = divider(container, "split-3#0");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");

    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    expect(bar.hasPointerCapture(1)).toBe(true);
    expect(shields(container)).toEqual(["0px 32px 600px 768px", "604px 32px 600px 366px", "604px 434px 600px 366px"]);

    fireEvent.pointerMove(bar, { ...POINTER, clientX: 702, clientY: 300 });
    const held = {
      "group-1": "0px 0px 700px 800px",
      "split-3#0": "700px 0px 4px 800px",
      "group-2": "704px 0px 500px 398px",
      "split-5#0": "704px 398px 500px 4px",
      "group-4": "704px 402px 500px 398px",
    };
    expect(drawn(container)).toEqual(held);
    expect(calls.changes).toEqual([]);
    expect(calls.rects.at(-1)).toEqual({
      a: { x: 0, y: 32, width: 700, height: 768 },
      b: { x: 704, y: 32, width: 500, height: 366 },
      c: { x: 704, y: 434, width: 500, height: 366 },
    });

    fireEvent.pointerUp(bar, { ...POINTER, clientX: 702, clientY: 300 });
    expect(drawn(container)).toEqual(held);
    expect(calls.changes).toHaveLength(1);
    expect(calls.changes[0].kind).toBe("state");
    expect(bar.hasPointerCapture(1)).toBe(false);
    expect(shields(container)).toEqual([]);
    expect(divider(container, "split-3#0").getAttribute("aria-valuenow")).toBe("58");
  });

  it("moves the nested horizontal divider and leaves the outer column alone", () => {
    const { calls, container } = setup();
    const bar = divider(container, "split-5#0");
    expect(bar.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.pointerDown(bar, { ...POINTER, clientX: 900, clientY: 400 });
    fireEvent.pointerMove(bar, { ...POINTER, clientX: 900, clientY: 302 });
    fireEvent.pointerUp(bar, { ...POINTER, clientX: 900, clientY: 302 });
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-2": "604px 0px 600px 300px",
      "split-5#0": "604px 300px 600px 4px",
      "group-4": "604px 304px 600px 496px",
    });
    expect(calls.changes).toHaveLength(1);
  });

  it("stops at the minimum tile size on both sides", () => {
    const { container } = setup();
    const bar = divider(container, "split-3#0");
    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    fireEvent.pointerMove(bar, { ...POINTER, clientX: 1602, clientY: 300 });
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 960px 800px",
      "split-3#0": "960px 0px 4px 800px",
      "group-2": "964px 0px 240px 398px",
      "split-5#0": "964px 398px 240px 4px",
      "group-4": "964px 402px 240px 398px",
    });
    fireEvent.pointerMove(bar, { ...POINTER, clientX: -400, clientY: 300 });
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 240px 800px",
      "split-3#0": "240px 0px 4px 800px",
      "group-2": "244px 0px 960px 398px",
      "split-5#0": "244px 398px 960px 4px",
      "group-4": "244px 402px 960px 398px",
    });
  });

  it("goes back on Escape and on a lost pointer capture without asking for a change", () => {
    const { calls, container } = setup();
    const bar = divider(container, "split-3#0");

    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    fireEvent.pointerMove(bar, { ...POINTER, clientX: 702, clientY: 300 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(shields(container)).toEqual([]);
    expect(bar.hasPointerCapture(1)).toBe(false);
    fireEvent.pointerUp(bar, { ...POINTER, clientX: 702, clientY: 300 });

    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    fireEvent.pointerMove(bar, { ...POINTER, clientX: 702, clientY: 300 });
    fireEvent.lostPointerCapture(bar, { pointerId: 1 });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(shields(container)).toEqual([]);
    fireEvent.pointerUp(bar, { ...POINTER, clientX: 702, clientY: 300 });

    expect(calls.changes).toEqual([]);
  });

  it("ignores a second pointer while one holds the divider", () => {
    const { calls, container } = setup();
    const bar = divider(container, "split-3#0");
    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    fireEvent.pointerMove(bar, { pointerId: 2, clientX: 900, clientY: 300 });
    fireEvent.pointerUp(bar, { pointerId: 2, button: 0, clientX: 900, clientY: 300 });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(shields(container)).toHaveLength(3);
    expect(calls.changes).toEqual([]);
  });

  it("asks for nothing when the divider is released where it was taken", () => {
    const { calls, container } = setup();
    const bar = divider(container, "split-3#0");
    fireEvent.pointerDown(bar, { ...POINTER, clientX: 602, clientY: 300 });
    fireEvent.pointerUp(bar, { ...POINTER, clientX: 602, clientY: 300 });
    expect(calls.changes).toEqual([]);
  });
});

describe("dragging a header", () => {
  it("previews the swap while held and asks for exactly one operation on drop", () => {
    const { calls, container } = setup();
    const handle = header(container, "group-1");

    fireEvent.pointerDown(handle, { ...POINTER, clientX: 300, clientY: 10 });
    expect(shields(container)).toEqual([]);

    fireEvent.pointerMove(handle, { ...POINTER, clientX: 904, clientY: 200 });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(preview(container)).toBe("604px 0px 600px 398px");
    expect(shields(container)).toHaveLength(3);
    expect(calls.changes).toEqual([]);

    fireEvent.pointerUp(handle, { ...POINTER, clientX: 904, clientY: 200 });
    expect(calls.changes).toEqual([{ kind: "operation", operation: { type: "swapGroups", groupId: "group-1", targetGroupId: "group-2" } }]);
    expect(drawn(container)).toEqual({
      "group-2": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-1": "604px 0px 600px 398px",
      "split-5#0": "604px 398px 600px 4px",
      "group-4": "604px 402px 600px 398px",
    });
    expect(preview(container)).toBeNull();
    expect(shields(container)).toEqual([]);
  });

  it("moves the whole group to an edge of another tile", () => {
    const { calls, container } = setup();
    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { ...POINTER, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { ...POINTER, clientX: 904, clientY: 790 });
    expect(preview(container)).toBe("0px 602px 1204px 198px");
    fireEvent.pointerUp(handle, { ...POINTER, clientX: 904, clientY: 790 });
    expect(calls.changes).toEqual([
      { kind: "operation", operation: { type: "moveGroup", groupId: "group-1", targetGroupId: "group-4", edge: "bottom" } },
    ]);
  });

  it.each([
    ["on itself", 300, 400],
    ["on a divider", 602, 400],
    ["outside the surface", 2000, 400],
    ["above the surface", 300, -50],
  ])("changes nothing when dropped %s", (_name, clientX, clientY) => {
    const { calls, container } = setup();
    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { ...POINTER, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { ...POINTER, clientX, clientY });
    expect(preview(container)).toBeNull();
    expect(shields(container)).toHaveLength(3);
    fireEvent.pointerUp(handle, { ...POINTER, clientX, clientY });
    expect(calls.changes).toEqual([]);
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(shields(container)).toEqual([]);
  });

  it("changes nothing on Escape, a lost capture or a cancelled pointer, and the source stays in place meanwhile", () => {
    const { calls, container } = setup();
    const handle = header(container, "group-1");
    const endings = [
      () => fireEvent.keyDown(document.body, { key: "Escape" }),
      () => fireEvent.lostPointerCapture(handle, { pointerId: 1 }),
      () => fireEvent.pointerCancel(handle, { pointerId: 1 }),
    ];
    for (const end of endings) {
      fireEvent.pointerDown(handle, { ...POINTER, clientX: 300, clientY: 10 });
      fireEvent.pointerMove(handle, { ...POINTER, clientX: 904, clientY: 200 });
      expect(preview(container)).toBe("604px 0px 600px 398px");
      expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
      end();
      expect(preview(container)).toBeNull();
      expect(shields(container)).toEqual([]);
      fireEvent.pointerUp(handle, { ...POINTER, clientX: 904, clientY: 200 });
    }
    expect(calls.changes).toEqual([]);
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
  });

  it("does not start from a press that moved less than four pixels: it is a click that focuses the tile", () => {
    const { calls, container, initial } = setup();
    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { ...POINTER, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { ...POINTER, clientX: 302, clientY: 11 });
    expect(shields(container)).toEqual([]);
    fireEvent.pointerUp(handle, { ...POINTER, clientX: 302, clientY: 11 });
    expect(calls.changes).toHaveLength(1);
    expect(calls.changes[0].kind).toBe("state");
    expect(calls.state.focusedGroupId).toBe("group-1");
    expect(calls.state.root).toBe(initial.root);
  });

  it("ignores the secondary mouse button", () => {
    const { calls, container } = setup();
    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 904, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, button: 2, clientX: 904, clientY: 200 });
    expect(shields(container)).toEqual([]);
    expect(calls.changes).toEqual([]);
  });
});

describe("dragging a tab", () => {
  it("moves only that tab: to a new tile at an edge, with one operation", () => {
    const { calls, container } = setup();
    const tab = container.querySelector('[data-panel-id="c"] [role="tab"]') as HTMLElement;

    fireEvent.pointerDown(tab, { ...POINTER, clientX: 650, clientY: 410 });
    fireEvent.pointerMove(tab, { ...POINTER, clientX: 10, clientY: 400 });
    expect(preview(container)).toBe("0px 0px 299px 800px");
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);

    fireEvent.pointerUp(tab, { ...POINTER, clientX: 10, clientY: 400 });
    expect(calls.changes).toEqual([
      { kind: "operation", operation: { type: "moveTabToEdge", panelId: "c", targetGroupId: "group-1", edge: "left" } },
    ]);
    expect(drawn(container)).toEqual({
      "group-6": "0px 0px 299px 800px",
      "split-3#0": "299px 0px 4px 800px",
      "group-1": "303px 0px 299px 800px",
      "split-3#1": "602px 0px 4px 800px",
      "group-2": "606px 0px 598px 800px",
    });
  });

  it("joins the tabs of the tile it is dropped into the centre of", () => {
    const { calls, container } = setup();
    const tab = container.querySelector('[data-panel-id="c"] [role="tab"]') as HTMLElement;
    fireEvent.pointerDown(tab, { ...POINTER, clientX: 650, clientY: 410 });
    fireEvent.pointerMove(tab, { ...POINTER, clientX: 904, clientY: 200 });
    expect(preview(container)).toBe("604px 0px 600px 800px");
    fireEvent.pointerUp(tab, { ...POINTER, clientX: 904, clientY: 200 });
    expect(calls.changes).toEqual([{ kind: "operation", operation: { type: "moveTab", panelId: "c", targetGroupId: "group-2" } }]);
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-2": "604px 0px 600px 800px",
    });
  });

  it("changes nothing when the only tab of a tile is dropped back on that tile", () => {
    const { calls, container } = setup();
    const tab = container.querySelector('[data-panel-id="c"] [role="tab"]') as HTMLElement;
    fireEvent.pointerDown(tab, { ...POINTER, clientX: 650, clientY: 410 });
    fireEvent.pointerMove(tab, { ...POINTER, clientX: 1190, clientY: 600 });
    expect(preview(container)).toBeNull();
    fireEvent.pointerUp(tab, { ...POINTER, clientX: 1190, clientY: 600 });
    expect(calls.changes).toEqual([]);
  });

  it("activates the tab on a plain click", () => {
    const { calls, container } = setup();
    const tab = container.querySelector('[data-panel-id="a"] [role="tab"]') as HTMLElement;
    fireEvent.pointerDown(tab, { ...POINTER, clientX: 30, clientY: 10 });
    fireEvent.pointerUp(tab, { ...POINTER, clientX: 30, clientY: 10 });
    expect(calls.changes).toHaveLength(1);
    expect(calls.state.focusedGroupId).toBe("group-1");
  });
});

it("consumes an OS file dropped on chrome without moving a tile or opening the file", () => {
  const { calls, container, initial } = setup();
  const dataTransfer = { types: ["Files"], files: [new File(["local"], "local.txt")] };
  expect(fireEvent.drop(header(container, "group-2"), { dataTransfer })).toBe(false);
  expect(calls.state).toBe(initial);
  expect(calls.changes).toEqual([]);
});
