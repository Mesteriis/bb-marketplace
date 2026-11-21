// The surface as a whole: where its size comes from, what happens to a
// gesture when the layout changes under it, and the order of its layers.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeGroup, createWorkspace } from "../../../src/core/layout/index.ts";
import { TILE_HEADER_HEIGHT, TileSurface } from "../../../src/ui/tiles/index.ts";
import { divider, drawn, Harness, header, newCalls, OPTIONS, PANELS, preview, shields, SIZE, THREE_TILES_DRAWN, threeTiles } from "./support.tsx";

const noop = (): void => {};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("surface size", () => {
  it("measures its container and follows the resize observer", () => {
    const observers: { callback: ResizeObserverCallback; targets: Element[]; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly record: (typeof observers)[number];
        constructor(callback: ResizeObserverCallback) {
          this.record = { callback, targets: [], disconnected: false };
          observers.push(this.record);
        }
        observe(target: Element): void {
          this.record.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {
          this.record.disconnected = true;
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1204, height: 800 } as DOMRect);

    const rects: unknown[] = [];
    const view = render(
      <TileSurface
        state={threeTiles()}
        panels={PANELS}
        options={OPTIONS}
        onOperation={noop}
        onRequestClose={noop}
        onPickContent={noop}
        onContentRects={(next) => rects.push(next)}
      />,
    );
    expect(drawn(view.container)).toEqual(THREE_TILES_DRAWN);
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([view.container.firstElementChild]);

    // The sidebar got wider: 200 px less for the surface.
    act(() => observers[0].callback([{ contentRect: { width: 1004, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(drawn(view.container)).toEqual({
      "group-1": "0px 0px 500px 800px",
      "split-3#0": "500px 0px 4px 800px",
      "group-2": "504px 0px 500px 398px",
      "split-5#0": "504px 398px 500px 4px",
      "group-4": "504px 402px 500px 398px",
    });
    expect(rects).toHaveLength(2);

    // The same size again is not a change.
    act(() => observers[0].callback([{ contentRect: { width: 1004, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(rects).toHaveLength(2);

    view.unmount();
    expect(observers[0].disconnected).toBe(true);
  });

  it("does not observe when the parent gives the size", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    expect(observe).not.toHaveBeenCalled();
  });

  it("subtracts the surface's own position from pointer coordinates", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 280, top: 48, width: 1204, height: 800 } as DOMRect);
    const calls = newCalls(threeTiles());
    const { container } = render(<Harness calls={calls} size={SIZE} />);
    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 580, clientY: 58 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1184, clientY: 248 });
    expect(preview(container)).toBe("604px 0px 600px 398px");
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 1184, clientY: 248 });
    expect(calls.changes).toEqual([{ kind: "operation", operation: { type: "swapGroups", groupId: "group-1", targetGroupId: "group-2" } }]);
  });

  it("gives a tile lower than its header no negative content area", () => {
    const rects: unknown[] = [];
    render(
      <TileSurface
        state={createWorkspace(["a"])}
        panels={PANELS}
        size={{ width: 800, height: 20 }}
        onOperation={noop}
        onRequestClose={noop}
        onPickContent={noop}
        onContentRects={(next) => rects.push(next)}
      />,
    );
    expect(TILE_HEADER_HEIGHT).toBe(32);
    expect(rects).toEqual([{ a: { x: 0, y: 20, width: 800, height: 0 } }]);
  });
});

describe("a layout that changes under a gesture", () => {
  it("drops a held divider when the parent replaces the state", () => {
    const start = threeTiles();
    const changes: unknown[] = [];
    const surface = (state: typeof start) => (
      <TileSurface
        state={state}
        panels={PANELS}
        size={SIZE}
        options={OPTIONS}
        onOperation={(change) => changes.push(change)}
        onRequestClose={noop}
        onPickContent={noop}
      />
    );
    const view = render(surface(start));
    const bar = divider(view.container, "split-3#0");
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 602, clientY: 300 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 702, clientY: 300 });
    expect(drawn(view.container)["group-1"]).toBe("0px 0px 700px 800px");

    // The tile below on the right was closed from elsewhere.
    view.rerender(surface(closeGroup(start, "group-4")));
    expect(drawn(view.container)).toEqual({
      "group-1": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-2": "604px 0px 600px 800px",
    });
    expect(shields(view.container)).toEqual([]);
    expect(bar.hasPointerCapture(1)).toBe(false);

    fireEvent.pointerUp(bar, { pointerId: 1, button: 0, clientX: 702, clientY: 300 });
    expect(changes).toEqual([]);
  });

  it("drops a drag whose target disappeared", () => {
    const start = threeTiles();
    const changes: unknown[] = [];
    const surface = (state: typeof start) => (
      <TileSurface state={state} panels={PANELS} size={SIZE} options={OPTIONS} onOperation={(change) => changes.push(change)} onRequestClose={noop} onPickContent={noop} />
    );
    const view = render(surface(start));
    const handle = header(view.container, "group-1");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 904, clientY: 200 });
    expect(preview(view.container)).toBe("604px 0px 600px 398px");

    view.rerender(surface(closeGroup(start, "group-2")));
    expect(preview(view.container)).toBeNull();
    expect(shields(view.container)).toEqual([]);
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 904, clientY: 200 });
    expect(changes).toEqual([]);
  });
});

describe("layers", () => {
  it("draws the content layer above the tiles and below the gesture shield, and renders no panel content itself", () => {
    const calls = newCalls(threeTiles());
    const { container } = render(
      <Harness calls={calls} size={SIZE}>
        <div data-testid="live-layer" />
      </Harness>,
    );
    const surface = container.firstElementChild as HTMLElement;
    const kinds = (): string[] =>
      Array.from(surface.children).map((child) => {
        const element = child as HTMLElement;
        if (element.dataset.groupId !== undefined) return "tile";
        if (element.dataset.divider !== undefined) return "divider";
        if (element.dataset.testid === "live-layer") return "content";
        if (element.dataset.chertogShield !== undefined) return "shield";
        if (element.dataset.chertogDropPreview !== undefined) return "preview";
        return "unknown";
      });
    expect(kinds()).toEqual(["tile", "tile", "tile", "divider", "divider", "content"]);
    // A tile with content holds its header and nothing else.
    expect(container.querySelector('[data-group-id="group-1"]')?.childElementCount).toBe(1);

    const handle = header(container, "group-1");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 904, clientY: 200 });
    expect(kinds()).toEqual(["tile", "tile", "tile", "divider", "divider", "content", "shield", "shield", "shield", "preview"]);
    expect(container.querySelector('[data-group-id="group-1"]')?.getAttribute("data-dragging")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(kinds()).toEqual(["tile", "tile", "tile", "divider", "divider", "content"]);
  });

  it("lets the pointer through a tile's content area: only the header takes it", () => {
    const { container } = render(<Harness calls={newCalls(threeTiles())} size={SIZE} />);
    const tile = container.querySelector('[data-group-id="group-1"]') as HTMLElement;
    expect(tile.style.pointerEvents).toBe("none");
    expect(header(container, "group-1").style.pointerEvents).toBe("auto");
    expect(header(container, "group-1").style.height).toBe("32px");
  });
});
