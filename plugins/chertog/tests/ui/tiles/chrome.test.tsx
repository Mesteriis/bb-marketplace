// Tile chrome: keyboard commands, maximize, closing, the layout menu, the
// content picker of an empty tile and the compact view.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { addTab, createWorkspace } from "../../../src/core/layout/index.ts";
import { applyTileCommand, TILE_KEYMAP, tileCommandForKey, tileCommandOperation } from "../../../src/ui/tiles/index.ts";
import { drawn, Harness, header, newCalls, shields, SIZE, THREE_TILES_DRAWN, threeTiles } from "./support.tsx";

function setup(initial = threeTiles(), size = SIZE) {
  const calls = newCalls(initial);
  const view = render(<Harness calls={calls} size={size} />);
  return { calls, container: view.container, initial };
}

function tab(name: string): HTMLElement {
  return screen.getByRole("tab", { name });
}

/** Tab ids of every tile, in reading order of the tree. */
function tabsOf(container: HTMLElement): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const tile of Array.from(container.querySelectorAll<HTMLElement>("[data-group-id]"))) {
    result[tile.dataset.groupId as string] = Array.from(tile.querySelectorAll<HTMLElement>("[data-panel-id]")).map((el) => el.dataset.panelId as string);
  }
  return result;
}

describe("key map", () => {
  it("lists every command with its chord", () => {
    expect(TILE_KEYMAP).toEqual([
      { key: "ArrowLeft", alt: true, shift: false, ctrl: false, command: { type: "focus", direction: "left" } },
      { key: "ArrowRight", alt: true, shift: false, ctrl: false, command: { type: "focus", direction: "right" } },
      { key: "ArrowUp", alt: true, shift: false, ctrl: false, command: { type: "focus", direction: "up" } },
      { key: "ArrowDown", alt: true, shift: false, ctrl: false, command: { type: "focus", direction: "down" } },
      { key: "ArrowLeft", alt: true, shift: true, ctrl: false, command: { type: "moveTab", direction: "left" } },
      { key: "ArrowRight", alt: true, shift: true, ctrl: false, command: { type: "moveTab", direction: "right" } },
      { key: "ArrowUp", alt: true, shift: true, ctrl: false, command: { type: "moveTab", direction: "up" } },
      { key: "ArrowDown", alt: true, shift: true, ctrl: false, command: { type: "moveTab", direction: "down" } },
      { key: "ArrowLeft", alt: true, shift: false, ctrl: true, command: { type: "moveGroup", direction: "left" } },
      { key: "ArrowRight", alt: true, shift: false, ctrl: true, command: { type: "moveGroup", direction: "right" } },
      { key: "ArrowUp", alt: true, shift: false, ctrl: true, command: { type: "moveGroup", direction: "up" } },
      { key: "ArrowDown", alt: true, shift: false, ctrl: true, command: { type: "moveGroup", direction: "down" } },
      { key: "ArrowLeft", alt: false, shift: false, ctrl: false, command: { type: "previousTab" } },
      { key: "ArrowRight", alt: false, shift: false, ctrl: false, command: { type: "nextTab" } },
      { key: "Enter", alt: true, shift: false, ctrl: false, command: { type: "toggleMaximize" } },
    ]);
  });

  it("matches a chord exactly and nothing else", () => {
    const chord = { key: "ArrowUp", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false };
    expect(tileCommandForKey(chord)).toEqual({ type: "moveTab", direction: "up" });
    expect(tileCommandForKey({ ...chord, metaKey: true })).toBeNull();
    expect(tileCommandForKey({ ...chord, ctrlKey: true })).toBeNull();
    expect(tileCommandForKey({ ...chord, key: "a" })).toBeNull();
    expect(tileCommandForKey({ key: "Enter", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false })).toBeNull();
  });

  it("names the operation of a move command and of nothing else", () => {
    const state = threeTiles();
    expect(tileCommandOperation(state, "group-4", { type: "moveGroup", direction: "left" })).toEqual({ type: "swapGroups", groupId: "group-4", targetGroupId: "group-1" });
    expect(tileCommandOperation(state, "group-4", { type: "moveTab", direction: "up" })).toEqual({ type: "moveTab", panelId: "c", targetGroupId: "group-2" });
    expect(tileCommandOperation(state, "group-4", { type: "moveTab", direction: "down" })).toEqual({ type: "moveTabToEdge", panelId: "c", targetGroupId: "group-4", edge: "bottom" });
    expect(tileCommandOperation(state, "group-4", { type: "focus", direction: "left" })).toBeUndefined();
    expect(tileCommandOperation(createWorkspace(["a"]), "group-1", { type: "moveGroup", direction: "up" })).toBeUndefined();
  });

  it("returns the same state for a command that has nowhere to go", () => {
    const state = createWorkspace(["a"]);
    expect(applyTileCommand(state, "group-1", { type: "focus", direction: "left" })).toBe(state);
    expect(applyTileCommand(state, "group-1", { type: "moveGroup", direction: "up" })).toBe(state);
    expect(applyTileCommand(state, "group-1", { type: "moveTab", direction: "up" })).toBe(state);
    expect(applyTileCommand(state, "group-1", { type: "nextTab" })).toBe(state);
    expect(applyTileCommand(state, "missing", { type: "toggleMaximize" })).toBe(state);
  });
});

describe("keyboard on a tile header", () => {
  it("moves the focus by direction, and the DOM focus follows to the active tab there", () => {
    const { calls, container } = setup();
    tab("Предпросмотр").focus();

    fireEvent.keyDown(tab("Предпросмотр"), { key: "ArrowUp", altKey: true });
    expect(calls.state.focusedGroupId).toBe("group-2");
    expect(document.activeElement).toBe(tab("Ревьюер"));

    fireEvent.keyDown(tab("Ревьюер"), { key: "ArrowLeft", altKey: true });
    expect(calls.state.focusedGroupId).toBe("group-1");
    expect(document.activeElement).toBe(tab("Исполнитель"));

    fireEvent.keyDown(tab("Исполнитель"), { key: "ArrowLeft", altKey: true });
    expect(calls.changes).toHaveLength(2);
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
  });

  it("marks the focused tile and keeps one tab stop per tab list", () => {
    const { container } = setup(addTab(threeTiles(), "group-4", "d"));
    expect(container.querySelector('[data-group-id="group-4"]')?.getAttribute("data-focused")).toBe("true");
    expect(container.querySelector('[data-group-id="group-1"]')?.getAttribute("data-focused")).toBeNull();
    const list = within(container.querySelector('[data-group-id="group-4"]') as HTMLElement).getByRole("tablist");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((el) => [el.getAttribute("aria-selected"), el.tabIndex])).toEqual([
      ["false", -1],
      ["true", 0],
    ]);
  });

  it("moves the tab into the neighbouring tile and keeps the focus on it", () => {
    const { calls, container } = setup();
    tab("Предпросмотр").focus();
    fireEvent.keyDown(tab("Предпросмотр"), { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(tabsOf(container)).toEqual({ "group-1": ["a"], "group-2": ["b", "c"] });
    expect(calls.changes[0]).toMatchObject({ kind: "state", via: { type: "moveTab", panelId: "c", targetGroupId: "group-2" } });
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-2": "604px 0px 600px 800px",
    });
    expect(calls.changes).toHaveLength(1);
    expect(document.activeElement).toBe(tab("Предпросмотр"));
  });

  it("moves the whole group by swapping it with its neighbour", () => {
    const { calls, container } = setup();
    fireEvent.keyDown(tab("Предпросмотр"), { key: "ArrowLeft", altKey: true, ctrlKey: true });
    expect(calls.changes[0]).toMatchObject({ kind: "state", via: { type: "swapGroups", groupId: "group-4", targetGroupId: "group-1" } });
    expect(drawn(container)).toEqual({
      "group-4": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-2": "604px 0px 600px 398px",
      "split-5#0": "604px 398px 600px 4px",
      "group-1": "604px 402px 600px 398px",
    });
    expect(calls.changes).toHaveLength(1);
  });

  it("switches tabs with the arrows, wrapping at the ends", () => {
    const { calls } = setup(addTab(threeTiles(), "group-4", "d"));
    const active = () => screen.getAllByRole("tab", { selected: true }).map((el) => el.textContent);
    expect(active()).toEqual(["Исполнитель", "Ревьюер", "d"]);
    tab("d").focus();

    fireEvent.keyDown(tab("d"), { key: "ArrowLeft" });
    expect(active()).toEqual(["Исполнитель", "Ревьюер", "Предпросмотр"]);
    expect(document.activeElement).toBe(tab("Предпросмотр"));

    fireEvent.keyDown(tab("Предпросмотр"), { key: "ArrowLeft" });
    expect(active()).toEqual(["Исполнитель", "Ревьюер", "d"]);

    fireEvent.keyDown(tab("d"), { key: "ArrowRight" });
    expect(active()).toEqual(["Исполнитель", "Ревьюер", "Предпросмотр"]);
    expect(calls.changes).toHaveLength(3);
  });

  it("maximizes and restores with Alt+Enter", () => {
    const { calls, container } = setup();
    fireEvent.keyDown(tab("Ревьюер"), { key: "Enter", altKey: true });
    expect(drawn(container)).toEqual({ "group-2": "0px 0px 1204px 800px" });
    expect(calls.rects.at(-1)).toEqual({ b: { x: 0, y: 32, width: 1204, height: 768 } });
    expect(document.activeElement).toBe(tab("Ревьюер"));

    fireEvent.keyDown(tab("Ревьюер"), { key: "Enter", altKey: true });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(calls.changes).toHaveLength(2);
  });

  it("leaves keys it does not own to the browser", () => {
    const { calls } = setup();
    const event = fireEvent.keyDown(tab("Ревьюер"), { key: "Enter" });
    expect(event).toBe(true);
    expect(calls.changes).toEqual([]);
  });

  it("resizes a focused divider with the arrow keys along its axis", () => {
    const { calls, container } = setup();
    const bar = screen.getAllByRole("separator")[0];
    expect(bar.tabIndex).toBe(0);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(drawn(container)["group-1"]).toBe("0px 0px 616px 800px");
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(calls.changes).toHaveLength(2);
  });
});

describe("maximize, close and the layout menu", () => {
  it("maximizes with the button and restores with a double click on the header", async () => {
    const user = userEvent.setup();
    const { calls, container, initial } = setup();
    const tile = within(container.querySelector('[data-group-id="group-1"]') as HTMLElement);

    await user.click(tile.getByRole("button", { name: "Развернуть" }));
    expect(drawn(container)).toEqual({ "group-1": "0px 0px 1204px 800px" });
    expect(screen.queryAllByRole("separator")).toEqual([]);
    expect(calls.changes).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Восстановить" })).toBeTruthy();

    fireEvent.doubleClick(header(container, "group-1"));
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
    expect(calls.changes).toHaveLength(2);
    expect(calls.state.root).toBe(initial.root);
  });

  it("does not start a drag while one tile is maximized", () => {
    const { calls, container } = setup({ ...threeTiles(), maximizedGroupId: "group-4" });
    const handle = header(container, "group-4");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 400 });
    expect(shields(container)).toEqual([]);
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 20, clientY: 400 });
    expect(calls.changes).toEqual([]);
  });

  it("asks the parent to close a tab and changes nothing itself", async () => {
    const user = userEvent.setup();
    const { calls, container } = setup();
    await user.click(screen.getByRole("button", { name: "Закрыть: Ревьюер" }));
    expect(calls.closes).toEqual(["b"]);
    expect(calls.changes).toEqual([]);
    expect(drawn(container)).toEqual(THREE_TILES_DRAWN);
  });

  it.each([
    [0, 640, 108, 0],
    [320, 960, 428, 0],
    [0, 320, 136, -136],
    [0, 640, 588, -176],
  ])("keeps a 200px menu within surface [%i, %i] for a trigger at %i", async (left, right, x, offset) => {
    const { container } = setup();
    const trigger = within(container.querySelector<HTMLElement>("[data-group-id]")!).getByRole("button", { name: "Действия тайла" });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-chertog-surface")) return new DOMRect(left, 0, right - left, 400);
      if (this.getAttribute("role") === "menu") return new DOMRect(0, 0, 200, 58);
      return new DOMRect(x, 0, 24, 24);
    });
    try {
      await userEvent.click(trigger);
      expect(screen.getByRole("menu").style.left).toBe(offset + "px");
    } finally {
      geometry.mockRestore();
    }
  });

  it("removes a tab from the layout through the menu without closing it", async () => {
    const user = userEvent.setup();
    const { calls, container } = setup();
    const tile = within(container.querySelector('[data-group-id="group-2"]') as HTMLElement);
    const menuButton = tile.getByRole("button", { name: "Действия тайла" });
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");

    await user.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Убрать вкладку из раскладки",
      "Убрать тайл из раскладки",
    ]);

    await user.click(screen.getByRole("menuitem", { name: "Убрать вкладку из раскладки" }));
    expect(calls.closes).toEqual([]);
    expect(calls.changes).toHaveLength(1);
    expect(drawn(container)).toEqual({
      "group-1": "0px 0px 600px 800px",
      "split-3#0": "600px 0px 4px 800px",
      "group-4": "604px 0px 600px 800px",
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers closing a parent together with its linked tiles, and only for a tile that has some", async () => {
    const user = userEvent.setup();
    const calls = newCalls(threeTiles());
    const panels = { a: { title: "Исполнитель", linkedCount: 2 }, b: { title: "Ревьюер" }, c: { title: "Предпросмотр" } };
    const { container } = render(<Harness calls={calls} size={SIZE} panels={panels} />);

    await user.click(within(container.querySelector('[data-group-id="group-2"]') as HTMLElement).getByRole("button", { name: "Действия тайла" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Убрать вкладку из раскладки", "Убрать тайл из раскладки"]);
    await user.keyboard("{Escape}");

    await user.click(within(container.querySelector('[data-group-id="group-1"]') as HTMLElement).getByRole("button", { name: "Действия тайла" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Убрать вкладку из раскладки",
      "Убрать тайл из раскладки",
      "Закрыть вместе с подчинёнными (2)",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Закрыть вместе с подчинёнными (2)" }));
    expect(calls.closes).toEqual(["a"]);
  });

  it("offers opening something next to a tile, for the tile's active panel, when the parent can do it", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    const calls = newCalls(threeTiles());
    const { container } = render(<Harness calls={calls} size={SIZE} onOpenBeside={(panelId) => opened.push(panelId)} />);
    await user.click(within(container.querySelector('[data-group-id="group-2"]') as HTMLElement).getByRole("button", { name: "Действия тайла" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Убрать вкладку из раскладки",
      "Убрать тайл из раскладки",
      "Открыть рядом…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Открыть рядом…" }));
    expect(opened).toEqual(["b"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Escape and returns the focus to its button", async () => {
    const user = userEvent.setup();
    const { calls, container } = setup();
    const menuButton = within(container.querySelector('[data-group-id="group-2"]') as HTMLElement).getByRole("button", { name: "Действия тайла" });
    await user.click(menuButton);
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuButton);
    expect(calls.changes).toEqual([]);
  });

  it("closes the menu on a press outside it", async () => {
    const user = userEvent.setup();
    const { container } = setup();
    await user.click(within(container.querySelector('[data-group-id="group-2"]') as HTMLElement).getByRole("button", { name: "Действия тайла" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerId: 1, button: 0 });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the panel context of the active tab and the status of a tab", () => {
    const { container } = setup();
    const tile = container.querySelector('[data-group-id="group-2"]') as HTMLElement;
    expect(tile.querySelector("[data-tile-context]")?.textContent).toBe("thr_b · bb-main");
    expect(within(tile).getByRole("img", { name: "Работает" })).toBeTruthy();
    expect(tile.getAttribute("aria-label")).toBe("Ревьюер");
  });

  it("shows a panel without a label under its id rather than hiding it", () => {
    const calls = newCalls(createWorkspace(["ghost"]));
    render(<Harness calls={calls} size={SIZE} />);
    expect(tab("ghost")).toBeTruthy();
  });
});

describe("empty tile", () => {
  it("offers the content picker on the whole surface and reports no content area", async () => {
    const user = userEvent.setup();
    const { calls, container } = setup(createWorkspace());
    expect(drawn(container)).toEqual({ "group-1": "0px 0px 1204px 800px" });
    expect(calls.rects).toEqual([{}]);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Развернуть" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Действия тайла" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Выбрать содержимое" }));
    expect(calls.picks).toEqual(["group-1"]);
    expect(calls.changes).toEqual([]);
  });

  it("draws the picker through the render prop", async () => {
    const user = userEvent.setup();
    const calls = newCalls(createWorkspace());
    render(
      <Harness
        calls={calls}
        size={SIZE}
        renderPicker={({ groupId, pick }) => (
          <button type="button" onClick={pick}>
            Открыть тред в {groupId}
          </button>
        )}
      />,
    );
    expect(screen.queryByRole("button", { name: "Выбрать содержимое" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Открыть тред в group-1" }));
    expect(calls.picks).toEqual(["group-1"]);
  });

  it("offers to add a tab to a tile that has content", async () => {
    const user = userEvent.setup();
    const { calls, container } = setup();
    await user.click(within(container.querySelector('[data-group-id="group-2"]') as HTMLElement).getByRole("button", { name: "Добавить вкладку" }));
    expect(calls.picks).toEqual(["group-2"]);
  });
});

describe("compact view", () => {
  const NARROW = { width: 500, height: 800 };

  it("shows the focused tile alone on the whole surface, without dividers", () => {
    const { calls, container } = setup(threeTiles(), NARROW);
    expect(drawn(container)).toEqual({ "group-4": "0px 0px 500px 800px" });
    expect(screen.queryAllByRole("separator")).toEqual([]);
    expect(calls.rects).toEqual([{ c: { x: 0, y: 32, width: 500, height: 768 } }]);
    expect(screen.queryByRole("button", { name: "Развернуть" })).toBeNull();
  });

  it("switches tiles with the switcher and leaves the tree as it was", async () => {
    const user = userEvent.setup();
    const { calls, container, initial } = setup(threeTiles(), NARROW);
    const switcher = screen.getByRole("combobox", { name: "Тайл" }) as HTMLSelectElement;
    expect(Array.from(switcher.options).map((option) => [option.value, option.textContent])).toEqual([
      ["group-1", "Исполнитель"],
      ["group-2", "Ревьюер"],
      ["group-4", "Предпросмотр"],
    ]);
    expect(switcher.value).toBe("group-4");

    await user.selectOptions(switcher, "group-1");
    expect(drawn(container)).toEqual({ "group-1": "0px 0px 500px 800px" });
    expect(calls.changes).toHaveLength(1);
    expect(calls.state.root).toBe(initial.root);
    expect(calls.state.maximizedGroupId).toBeNull();
  });

  it("has no switcher in the tiled view", () => {
    setup();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not start a drag", () => {
    const { calls, container } = setup(threeTiles(), NARROW);
    const handle = header(container, "group-4");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 400 });
    expect(shields(container)).toEqual([]);
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 20, clientY: 400 });
    expect(calls.changes).toEqual([]);
  });
});

it("explains why a preview cannot be transferred and how to move the whole window", () => {
  const { container } = setup();
  const tile = within(container.querySelector('[data-group-id="group-4"]') as HTMLElement);
  fireEvent.click(tile.getByRole("button", { name: "Действия тайла" }));
  const item = tile.getByRole("menuitem", { name: /Передать в другое окно/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toMatch(/New Window/);
  fireEvent.click(item);
  expect(tile.getByRole("menu")).toBeTruthy();
});
