// The strip above the surface: the switcher, "add panel" and the hidden
// panels in one toolbar.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceToolbar, type ContentChoice, type ContentSection } from "../../../src/ui/chrome/index.ts";

const SECTIONS: ContentSection[] = [
  {
    providerId: "threads",
    title: "Треды",
    state: "ready",
    items: [
      { id: "t1", title: "Исполнитель", context: "bb-main", status: "Работает" },
      { id: "t2", title: "Ревьюер", context: "bb-main", status: "Ждёт ответа", openInTileId: "tile-2" },
    ],
  },
];

function setup(tileCount = 3) {
  const calls = {
    onSwitch: vi.fn<(layoutId: string) => void>(),
    onOpen: vi.fn<(choice: ContentChoice) => void>(),
    onFocusExisting: vi.fn<(tileId: string) => void>(),
    onShow: vi.fn<(instanceId: string) => void>(),
    onClose: vi.fn<(instanceId: string) => void>(),
  };
  const unused = () => {
    throw new Error("This callback is not part of the test");
  };
  render(
    <WorkspaceToolbar
      layouts={{
        layouts: [
          { id: "l1", name: "Разработка" },
          { id: "l2", name: "Ревью" },
        ],
        activeLayoutId: "l1",
        presets: [],
        saveStatus: "saved",
        onSwitch: calls.onSwitch,
        onCreateFromCurrent: unused,
        onCreateFromPreset: unused,
        onRename: unused,
        onDuplicate: unused,
        onDelete: unused,
        onReload: unused,
      }}
      content={{
        sections: SECTIONS,
        tileCount,
        tileLimit: 8,
        onOpen: calls.onOpen,
        onFocusExisting: calls.onFocusExisting,
      }}
      hiddenPanels={{
        panels: [{ instanceId: "p1", title: "Zoom: Планёрка" }],
        onShow: calls.onShow,
        onClose: calls.onClose,
      }}
    />,
  );
  return { user: userEvent.setup(), calls };
}

const pickerDialog = () => screen.queryByRole("dialog", { name: "Добавить панель" });

describe("WorkspaceToolbar", () => {
  it("is one toolbar with the switcher, the save status, «Добавить панель» and the hidden panels", () => {
    setup();

    const toolbar = within(screen.getByRole("toolbar", { name: "Рабочее место" }));
    expect(toolbar.getByRole("button", { name: "Раскладка: Разработка" })).toBeTruthy();
    expect(toolbar.getByRole("status").textContent).toBe("Сохранено");
    expect(toolbar.getByRole("button", { name: "Добавить панель" })).toBeTruthy();
    expect(toolbar.getByRole("button", { name: "Скрытые панели: 1" })).toBeTruthy();
    // The strip adds no navigation of its own.
    expect(toolbar.queryByRole("navigation")).toBeNull();
    expect(toolbar.queryByRole("link")).toBeNull();
  });

  it("switches the layout through the switcher", async () => {
    const { user, calls } = setup();

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Ревью" }));

    expect(calls.onSwitch).toHaveBeenCalledTimes(1);
    expect(calls.onSwitch).toHaveBeenLastCalledWith("l2");
  });

  it("adds a panel through the picker and returns focus to the button", async () => {
    const { user, calls } = setup();
    const add = screen.getByRole("button", { name: "Добавить панель" });

    await user.click(add);
    expect(pickerDialog()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Поиск" }));

    await user.click(screen.getByRole("button", { name: /Исполнитель/ }));

    expect(calls.onOpen).toHaveBeenCalledTimes(1);
    expect(calls.onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "default" });
    expect(pickerDialog()).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("focuses the tile of a panel that is already open and closes the picker", async () => {
    const { user, calls } = setup();

    await user.click(screen.getByRole("button", { name: "Добавить панель" }));
    await user.click(screen.getByRole("button", { name: /Ревьюер/ }));

    expect(calls.onFocusExisting).toHaveBeenCalledTimes(1);
    expect(calls.onFocusExisting).toHaveBeenLastCalledWith("tile-2");
    expect(calls.onOpen).not.toHaveBeenCalled();
    expect(pickerDialog()).toBeNull();
  });

  it("leaves the focus on the tile that onFocusExisting focused", async () => {
    const user = userEvent.setup();
    const unused = () => {
      throw new Error("This callback is not part of the test");
    };
    render(
      <>
        <WorkspaceToolbar
          layouts={{
            layouts: [{ id: "l1", name: "Разработка" }],
            activeLayoutId: "l1",
            presets: [],
            saveStatus: "saved",
            onSwitch: unused,
            onCreateFromCurrent: unused,
            onCreateFromPreset: unused,
            onRename: unused,
            onDuplicate: unused,
            onDelete: unused,
            onReload: unused,
          }}
          content={{
            sections: SECTIONS,
            tileCount: 3,
            tileLimit: 8,
            onOpen: unused,
            onFocusExisting: () => screen.getByRole("textbox", { name: "Тайл Ревьюер" }).focus(),
          }}
          hiddenPanels={{ panels: [], onShow: unused, onClose: unused }}
        />
        <input aria-label="Тайл Ревьюер" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Добавить панель" }));
    await user.click(screen.getByRole("button", { name: /Ревьюер/ }));

    expect(pickerDialog()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Тайл Ревьюер" }));
  });

  it("at the limit asks where to put the panel; cancelling twice leaves everything as it was", async () => {
    const { user, calls } = setup(8);
    const add = screen.getByRole("button", { name: "Добавить панель" });

    await user.click(add);
    await user.click(screen.getByRole("button", { name: /Исполнитель/ }));
    expect(screen.getByRole("group", { name: "Свободных мест нет" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(pickerDialog()).not.toBeNull();
    expect(screen.queryByRole("group", { name: "Свободных мест нет" })).toBeNull();

    await user.keyboard("{Escape}");
    expect(pickerDialog()).toBeNull();
    expect(document.activeElement).toBe(add);
    expect(calls.onOpen).not.toHaveBeenCalled();
    expect(calls.onFocusExisting).not.toHaveBeenCalled();
  });

  it("at the limit opens the panel as a tab when the user chooses so", async () => {
    const { user, calls } = setup(8);

    await user.click(screen.getByRole("button", { name: "Добавить панель" }));
    await user.click(screen.getByRole("button", { name: /Исполнитель/ }));
    await user.click(screen.getByRole("button", { name: "Открыть вкладкой в группе" }));

    expect(calls.onOpen).toHaveBeenCalledTimes(1);
    expect(calls.onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "tab" });
    expect(pickerDialog()).toBeNull();
  });

  it("shows and closes hidden panels", async () => {
    const { user, calls } = setup();

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.click(screen.getByRole("button", { name: "Показать «Zoom: Планёрка»" }));
    await user.click(screen.getByRole("button", { name: "Закрыть «Zoom: Планёрка»" }));

    expect(calls.onShow).toHaveBeenLastCalledWith("p1");
    expect(calls.onClose).toHaveBeenLastCalledWith("p1");
  });

  it("moves between its controls with the left and right arrows", async () => {
    const { user } = setup();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Добавить панель" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Раскладка: Разработка" }));
  });
});

describe("WorkspaceToolbar: the focused control disappears from the picker dialog", () => {
  const unused = () => {
    throw new Error("This callback is not part of the test");
  };
  function open(tileCount: number) {
    const onOpen = vi.fn<(choice: ContentChoice) => void>();
    const toolbar = (sections: ContentSection[]) => (
      <WorkspaceToolbar
        layouts={{
          layouts: [{ id: "l1", name: "Разработка" }],
          activeLayoutId: "l1",
          presets: [],
          saveStatus: "saved",
          onSwitch: unused,
          onCreateFromCurrent: unused,
          onCreateFromPreset: unused,
          onRename: unused,
          onDuplicate: unused,
          onDelete: unused,
          onReload: unused,
        }}
        content={{ sections, tileCount, tileLimit: 8, onOpen, onFocusExisting: unused }}
        hiddenPanels={{ panels: [], onShow: unused, onClose: unused }}
      />
    );
    const view = render(toolbar(SECTIONS));
    const denied: ContentSection[] = [{ ...SECTIONS[0], state: "denied" }];
    return { user: userEvent.setup(), onOpen, deny: () => view.rerender(toolbar(denied)) };
  }
  const dialog = () => screen.getByRole("dialog", { name: "Добавить панель" });

  it("keeps the focus in the dialog when the limit question goes away, and Escape still closes it", async () => {
    const { user, onOpen, deny } = open(8);
    const add = screen.getByRole("button", { name: "Добавить панель" });

    await user.click(add);
    await user.click(screen.getByRole("button", { name: /Исполнитель/ }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Открыть вкладкой в группе" }));
    deny();

    await waitFor(() => expect(document.activeElement).toBe(dialog()));
    expect(screen.queryByRole("group", { name: "Свободных мест нет" })).toBeNull();

    await user.keyboard("{Escape}");
    expect(pickerDialog()).toBeNull();
    expect(document.activeElement).toBe(add);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog after the focused control went away", async () => {
    const { user, deny } = open(8);

    await user.click(screen.getByRole("button", { name: "Добавить панель" }));
    await user.click(screen.getByRole("button", { name: /Исполнитель/ }));
    deny();
    await waitFor(() => expect(document.activeElement).toBe(dialog()));

    const search = screen.getByRole("searchbox", { name: "Поиск" });
    await user.tab();
    expect(document.activeElement).toBe(search);
    await user.tab();
    expect(document.activeElement).toBe(search);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(search);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("keeps the focus in the dialog when the focused item's provider loses access", async () => {
    const { user, deny } = open(3);

    await user.click(screen.getByRole("button", { name: "Добавить панель" }));
    screen.getByRole("button", { name: /Исполнитель/ }).focus();
    deny();

    await waitFor(() => expect(document.activeElement).toBe(dialog()));
    await user.keyboard("{Escape}");
    expect(pickerDialog()).toBeNull();
  });
});
