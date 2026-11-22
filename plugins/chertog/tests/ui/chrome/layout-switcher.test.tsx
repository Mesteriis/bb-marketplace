// The layout switcher, driven the way a user drives it: every expectation
// names the callback and the arguments the action must produce.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LayoutSwitcher, type LayoutEntry, type LayoutPresetEntry, type SaveStatus } from "../../../src/ui/chrome/index.ts";

function spies() {
  return {
    onSwitch: vi.fn<(layoutId: string) => void>(),
    onCreateFromCurrent: vi.fn<(name: string) => void>(),
    onCreateFromPreset: vi.fn<(presetId: string, name: string) => void>(),
    onRename: vi.fn<(layoutId: string, name: string) => void>(),
    onDuplicate: vi.fn<(layoutId: string, name: string) => void>(),
    onDelete: vi.fn<(layoutId: string) => void>(),
    onRetrySave: vi.fn<() => void>(),
    onReload: vi.fn<() => void>(),
  };
}

const PRESETS: LayoutPresetEntry[] = [
  { id: "agents", name: "Команда агентов" },
  { id: "call", name: "Созвон", description: "Звонок и заметки" },
];

interface HarnessProps {
  calls: ReturnType<typeof spies>;
  initial?: LayoutEntry[];
  saveStatus?: SaveStatus;
  presets?: LayoutPresetEntry[];
}

/** Owns the list the way the workspace adapter does: a created layout gets the next id and becomes active. */
function Harness({ calls, initial = [{ id: "l1", name: "Основная" }], saveStatus = "saved", presets = PRESETS }: HarnessProps) {
  const [layouts, setLayouts] = useState(initial);
  const [activeId, setActiveId] = useState(initial[0].id);
  const add = (name: string) => {
    const id = `l${layouts.length + 1}`;
    setLayouts([...layouts, { id, name }]);
    setActiveId(id);
  };
  return (
    <LayoutSwitcher
      layouts={layouts}
      activeLayoutId={activeId}
      presets={presets}
      saveStatus={saveStatus}
      onSwitch={(id) => {
        calls.onSwitch(id);
        setActiveId(id);
      }}
      onCreateFromCurrent={(name) => {
        calls.onCreateFromCurrent(name);
        add(name);
      }}
      onCreateFromPreset={(presetId, name) => {
        calls.onCreateFromPreset(presetId, name);
        add(name);
      }}
      onRename={(id, name) => {
        calls.onRename(id, name);
        setLayouts(layouts.map((layout) => (layout.id === id ? { id, name } : layout)));
      }}
      onDuplicate={(id, name) => {
        calls.onDuplicate(id, name);
        add(name);
      }}
      onDelete={(id) => {
        calls.onDelete(id);
        setLayouts(layouts.filter((layout) => layout.id !== id));
      }}
      onRetrySave={calls.onRetrySave}
      onReload={calls.onReload}
    />
  );
}

const TWO: LayoutEntry[] = [
  { id: "l1", name: "Разработка" },
  { id: "l2", name: "Ревью" },
];

const popover = () => screen.getByRole("dialog", { name: "Раскладки" });
const nameField = () => screen.getByRole("textbox", { name: "Имя новой раскладки" });

describe("LayoutSwitcher: creating and switching", () => {
  it("creates «Разработка» and «Ревью» from the current layout and switches between them", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.type(nameField(), "Разработка");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(calls.onCreateFromCurrent).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromCurrent).toHaveBeenLastCalledWith("Разработка");
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.type(nameField(), "Ревью{Enter}");

    expect(calls.onCreateFromCurrent).toHaveBeenCalledTimes(2);
    expect(calls.onCreateFromCurrent).toHaveBeenLastCalledWith("Ревью");

    await user.click(screen.getByRole("button", { name: "Раскладка: Ревью" }));
    const list = within(screen.getByRole("list", { name: "Сохранённые раскладки" }));
    expect(list.getByRole("button", { name: "Ревью" }).getAttribute("aria-current")).toBe("true");
    expect(list.getByRole("button", { name: "Разработка" }).getAttribute("aria-current")).toBeNull();

    await user.click(list.getByRole("button", { name: "Разработка" }));

    expect(calls.onSwitch).toHaveBeenCalledTimes(1);
    expect(calls.onSwitch).toHaveBeenLastCalledWith("l2");
    expect(screen.getByRole("button", { name: "Раскладка: Разработка" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
  });

  it("choosing the active layout closes the list without a switch", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(within(popover()).getByRole("button", { name: "Разработка" }));

    expect(calls.onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
  });

  it("stores the name without the spaces around it", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.type(nameField(), "  Ревью  {Enter}");

    expect(calls.onCreateFromCurrent).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromCurrent).toHaveBeenLastCalledWith("Ревью");
  });
});

describe("LayoutSwitcher: names it refuses", () => {
  it.each([
    ["an empty name", ""],
    ["a name of spaces", "   "],
  ])("refuses %s and says why", async (_case, typed) => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    if (typed !== "") await user.type(nameField(), typed);
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(calls.onCreateFromCurrent).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Введите имя раскладки");
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(popover()).toBeTruthy();
  });

  it("refuses a name another layout has, whatever its case and outer spaces", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.type(nameField(), " ревью {Enter}");

    expect(calls.onCreateFromCurrent).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Раскладка с таким именем уже есть");

    await user.type(nameField(), "2");
    expect(screen.queryByRole("alert")).toBeNull();

    await user.keyboard("{Enter}");
    expect(calls.onCreateFromCurrent).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromCurrent).toHaveBeenLastCalledWith("ревью 2");
  });

  it("cuts a pasted name at the 64 characters a stored name may have", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    expect(nameField().getAttribute("maxlength")).toBe("64");
    await user.click(nameField());
    await user.paste("я".repeat(70));
    await user.keyboard("{Enter}");

    // The field cuts the paste at its limit, so what is created is 64 characters long.
    expect(calls.onCreateFromCurrent).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromCurrent).toHaveBeenLastCalledWith("я".repeat(64));
  });
});

describe("LayoutSwitcher: rename, duplicate, delete, presets", () => {
  it("renames a layout from its row", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Переименовать «Ревью»" }));
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Новое имя раскладки «Ревью»" });
    expect(field.value).toBe("Ревью");
    expect(document.activeElement).toBe(field);

    await user.clear(field);
    await user.type(field, "Приёмка{Enter}");

    expect(calls.onRename).toHaveBeenCalledTimes(1);
    expect(calls.onRename).toHaveBeenLastCalledWith("l2", "Приёмка");
    expect(document.activeElement).toBe(within(popover()).getByRole("button", { name: "Приёмка" }));
  });

  it("refuses to rename to an empty or taken name, and Escape leaves the name as it was", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Переименовать «Ревью»" }));
    const field = screen.getByRole("textbox", { name: "Новое имя раскладки «Ревью»" });

    await user.clear(field);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Введите имя раскладки");

    await user.type(field, "РАЗРАБОТКА{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Раскладка с таким именем уже есть");
    expect(calls.onRename).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(calls.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Новое имя раскладки «Ревью»" })).toBeNull();
    // Escape left the rename, not the list.
    expect(within(popover()).getByRole("button", { name: "Ревью" })).toBeTruthy();
  });

  it("saving an unchanged name renames nothing", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Переименовать «Ревью»" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(calls.onRename).not.toHaveBeenCalled();
    expect(within(popover()).getByRole("button", { name: "Ревью" })).toBeTruthy();
  });

  it("duplicates under the first free copy name", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Дублировать «Ревью»" }));
    expect(calls.onDuplicate).toHaveBeenLastCalledWith("l2", "Ревью (копия)");

    await user.click(screen.getByRole("button", { name: "Дублировать «Ревью»" }));
    expect(calls.onDuplicate).toHaveBeenLastCalledWith("l2", "Ревью (копия 2)");
    expect(calls.onDuplicate).toHaveBeenCalledTimes(2);
  });

  it("asks before deleting, and cancelling deletes nothing", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Удалить «Ревью»" }));

    expect(calls.onDelete).not.toHaveBeenCalled();
    const question = screen.getByRole("group", { name: "Удалить раскладку «Ревью»? Панели останутся открытыми." });
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Отмена" }));

    await user.click(within(question).getByRole("button", { name: "Отмена" }));

    expect(calls.onDelete).not.toHaveBeenCalled();
    expect(within(popover()).getByRole("button", { name: "Ревью" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Удалить «Ревью»" }));
  });

  it("deletes after the confirmation", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Разработка" }));
    await user.click(screen.getByRole("button", { name: "Удалить «Ревью»" }));
    await user.click(screen.getByRole("button", { name: "Удалить" }));

    expect(calls.onDelete).toHaveBeenCalledTimes(1);
    expect(calls.onDelete).toHaveBeenLastCalledWith("l2");
    expect(within(popover()).queryByRole("button", { name: "Ревью" })).toBeNull();
  });

  it("does not offer to delete the only layout", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: "Удалить «Основная»" });

    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("Единственную раскладку удалить нельзя");
  });

  it("creates a layout from a preset, numbering the name when it is taken", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    expect(calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Созвон");

    await user.click(screen.getByRole("button", { name: "Раскладка: Созвон" }));
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    expect(calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Созвон 2");
    expect(calls.onCreateFromPreset).toHaveBeenCalledTimes(2);
  });

  it("shows no preset section when there are no presets", async () => {
    const user = userEvent.setup();
    render(<Harness calls={spies()} presets={[]} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));

    expect(screen.queryByText("Из пресета")).toBeNull();
  });
});

describe("LayoutSwitcher: save status", () => {
  it.each([
    ["saved", "Сохранено"],
    ["saving", "Сохраняется…"],
    ["off", "Сохранение выключено"],
  ] as const)("reports %s without a reload action", (saveStatus, text) => {
    render(<Harness calls={spies()} saveStatus={saveStatus} />);

    expect(screen.getByRole("status").textContent).toBe(text);
    expect(screen.queryByRole("button", { name: "Сохранить ещё раз" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
  });

  it("offers an explicit retry after failure", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} saveStatus="failed" />);
    expect(screen.getByRole("status").textContent).toBe("Не сохранено");
    expect(calls.onRetrySave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Сохранить ещё раз" }));
    expect(calls.onRetrySave).toHaveBeenCalledTimes(1);
  });

  it("reports a conflict with another window and reloads on request", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} saveStatus="conflict" />);

    expect(screen.getByRole("status").textContent).toBe("Раскладки изменены в другом окне");
    await user.click(screen.getByRole("button", { name: "Обновить" }));

    expect(calls.onReload).toHaveBeenCalledTimes(1);
  });
});

describe("LayoutSwitcher: keyboard", () => {
  it("opens from the keyboard, moves with arrows, switches with Enter and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(
      <Harness
        calls={calls}
        initial={[
          { id: "l1", name: "Разработка" },
          { id: "l2", name: "Ревью" },
          { id: "l3", name: "Созвон" },
        ]}
      />,
    );

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Раскладка: Разработка" });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = within(screen.getByRole("list", { name: "Сохранённые раскладки" }));
    expect(document.activeElement).toBe(list.getByRole("button", { name: "Разработка" }));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(list.getByRole("button", { name: "Ревью" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(list.getByRole("button", { name: "Созвон" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(list.getByRole("button", { name: "Созвон" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(list.getByRole("button", { name: "Ревью" }));

    await user.keyboard("{Enter}");
    expect(calls.onSwitch).toHaveBeenCalledTimes(1);
    expect(calls.onSwitch).toHaveBeenLastCalledWith("l2");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Раскладка: Ревью" }));
  });

  it("Escape closes the list, changes nothing and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness calls={calls} initial={TWO} />);

    const trigger = screen.getByRole("button", { name: "Раскладка: Разработка" });
    await user.click(trigger);
    await user.type(nameField(), "Черновик");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it("a press outside closes the list", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness calls={spies()} />
        <button type="button">Снаружи</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.click(screen.getByRole("button", { name: "Снаружи" }));

    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
  });
});

describe("LayoutSwitcher: the list changes while a row is being edited", () => {
  const THREE: LayoutEntry[] = [
    { id: "a", name: "Альфа" },
    { id: "b", name: "Бета" },
    { id: "c", name: "Гамма" },
  ];
  const props = (calls: ReturnType<typeof spies>, layouts: LayoutEntry[]) => ({
    layouts,
    activeLayoutId: "c",
    presets: [],
    saveStatus: "saved" as const,
    ...calls,
  });

  it("the delete question stays with its layout when another window removes a row above it", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...props(calls, THREE)} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Гамма" }));
    await user.click(screen.getByRole("button", { name: "Удалить «Бета»" }));
    view.rerender(<LayoutSwitcher {...props(calls, THREE.slice(1))} />);

    expect(screen.getByRole("group", { name: "Удалить раскладку «Бета»? Панели останутся открытыми." })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Удалить" }));

    expect(calls.onDelete).toHaveBeenCalledTimes(1);
    expect(calls.onDelete).toHaveBeenLastCalledWith("b");
  });

  it("drops the delete question when its layout is gone, and deletes nothing", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...props(calls, THREE)} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Гамма" }));
    await user.click(screen.getByRole("button", { name: "Удалить «Бета»" }));
    view.rerender(<LayoutSwitcher {...props(calls, [THREE[0], THREE[2]])} />);

    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Удалить «Гамма»" })).toBeTruthy();
    expect(calls.onDelete).not.toHaveBeenCalled();
  });

  it("the rename stays with its layout when a row above it is removed", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...props(calls, THREE)} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Гамма" }));
    await user.click(screen.getByRole("button", { name: "Переименовать «Бета»" }));
    view.rerender(<LayoutSwitcher {...props(calls, THREE.slice(1))} />);
    const field = screen.getByRole("textbox", { name: "Новое имя раскладки «Бета»" });
    await user.clear(field);
    await user.type(field, "Дельта{Enter}");

    expect(calls.onRename).toHaveBeenCalledTimes(1);
    expect(calls.onRename).toHaveBeenLastCalledWith("b", "Дельта");
  });
});

describe("LayoutSwitcher: presets and layouts change while the list is open", () => {
  const base = (calls: ReturnType<typeof spies>) => ({
    activeLayoutId: "l1",
    saveStatus: "saved" as const,
    ...calls,
  });
  const ONE: LayoutEntry[] = [{ id: "l1", name: "Основная" }];

  it("a preset that is no longer offered cannot be created from", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={PRESETS} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    screen.getByRole("button", { name: "Создать из пресета «Созвон»" }).focus();
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={[PRESETS[0]]} />);
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("button", { name: "Создать из пресета «Созвон»" })).toBeNull();
    expect(screen.getByRole("button", { name: "Создать из пресета «Команда агентов»" })).toBeTruthy();
    expect(calls.onCreateFromPreset).not.toHaveBeenCalled();
  });

  it("a preset replaced under the same id is created by its current name", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={PRESETS} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={[PRESETS[0], { id: "call", name: "Встреча" }]} />);
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Встреча»" }));

    expect(calls.onCreateFromPreset).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Встреча");
  });

  it("the preset name is numbered against the layouts as they are at the click", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={PRESETS} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={[...ONE, { id: "l2", name: "Созвон" }]} presets={PRESETS} />);
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));

    expect(calls.onCreateFromPreset).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Созвон 2");
  });

  it("a name typed before another window took it is refused at the submit", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={ONE} presets={[]} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.type(nameField(), "Ревью");
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={[...ONE, { id: "l2", name: "Ревью" }]} presets={[]} />);
    await user.keyboard("{Enter}");

    expect(calls.onCreateFromCurrent).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Раскладка с таким именем уже есть");
  });
});

describe("LayoutSwitcher: generated names keep to the length limit", () => {
  const AUTO_NAME_ERROR = "Не удалось подобрать свободное имя. Введите своё.";

  function setup(layouts: LayoutEntry[], maxNameLength: number, presets: LayoutPresetEntry[] = []) {
    const calls = spies();
    render(
      <LayoutSwitcher
        layouts={layouts}
        activeLayoutId={layouts[0].id}
        presets={presets}
        saveStatus="saved"
        maxNameLength={maxNameLength}
        {...calls}
      />,
    );
    return { user: userEvent.setup(), calls };
  }
  const openList = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /^Раскладка: / }));

  it("shortens the source name so that the copy suffix fits", async () => {
    const { user, calls } = setup(
      [
        { id: "l1", name: "Разработка" },
        { id: "l2", name: "Разр (копия)" },
      ],
      12,
    );

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Дублировать «Разработка»" }));

    expect(calls.onDuplicate).toHaveBeenCalledTimes(1);
    expect(calls.onDuplicate).toHaveBeenLastCalledWith("l1", "Ра (копия 2)");
  });

  it("does not leave a space before the suffix when the cut ends on one", async () => {
    const { user, calls } = setup([{ id: "l1", name: "Аб вг" }], 11);

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Дублировать «Аб вг»" }));

    expect(calls.onDuplicate).toHaveBeenLastCalledWith("l1", "Аб (копия)");
  });

  it("asks for a name instead of duplicating under one that is too long", async () => {
    const { user, calls } = setup([{ id: "l1", name: "Тест" }], 4);

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Дублировать «Тест»" }));

    expect(calls.onDuplicate).not.toHaveBeenCalled();
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Имя копии раскладки «Тест»" });
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Тест");
    expect(field.getAttribute("maxlength")).toBe("4");
    expect(screen.getByRole("alert").textContent).toBe(AUTO_NAME_ERROR);

    // The same checks as for a typed name: the source's own name is taken.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Раскладка с таким именем уже есть");
    await user.clear(field);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Введите имя раскладки");
    expect(calls.onDuplicate).not.toHaveBeenCalled();

    await user.type(field, "Т2{Enter}");
    expect(calls.onDuplicate).toHaveBeenCalledTimes(1);
    expect(calls.onDuplicate).toHaveBeenLastCalledWith("l1", "Т2");
    expect(screen.queryByRole("textbox", { name: "Имя копии раскладки «Тест»" })).toBeNull();
  });

  it("Escape leaves the copy-name form without duplicating", async () => {
    const { user, calls } = setup([{ id: "l1", name: "Тест" }], 4);

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Дублировать «Тест»" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Имя копии раскладки «Тест»" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Дублировать «Тест»" }));
    expect(calls.onDuplicate).not.toHaveBeenCalled();
  });

  it("cuts a preset name to the limit and numbers it within the limit", async () => {
    const preset = [{ id: "call", name: "Созвон" }];
    const first = setup([{ id: "l1", name: "Тест" }], 4, preset);
    await openList(first.user);
    await first.user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    expect(first.calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Созв");
    cleanup();

    const second = setup(
      [
        { id: "l1", name: "Тест" },
        { id: "l2", name: "Созв" },
      ],
      4,
      preset,
    );
    await openList(second.user);
    await second.user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    expect(second.calls.onCreateFromPreset).toHaveBeenCalledTimes(1);
    expect(second.calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Со 2");
  });

  it("asks for a name when no preset name fits the limit", async () => {
    const { user, calls } = setup([{ id: "l1", name: "С" }], 1, [{ id: "call", name: "Созвон" }]);

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));

    expect(calls.onCreateFromPreset).not.toHaveBeenCalled();
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Имя раскладки из пресета «Созвон»" });
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("С");
    expect(screen.getByRole("alert").textContent).toBe(AUTO_NAME_ERROR);

    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Раскладка с таким именем уже есть");
    expect(calls.onCreateFromPreset).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "Я{Enter}");
    expect(calls.onCreateFromPreset).toHaveBeenCalledTimes(1);
    expect(calls.onCreateFromPreset).toHaveBeenLastCalledWith("call", "Я");
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
  });

  it("Escape leaves the preset-name form without creating", async () => {
    const { user, calls } = setup([{ id: "l1", name: "С" }], 1, [{ id: "call", name: "Созвон" }]);

    await openList(user);
    await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Имя раскладки из пресета «Созвон»" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Создать из пресета «Созвон»" }));
    expect(screen.getByRole("dialog", { name: "Раскладки" })).toBeTruthy();
    expect(calls.onCreateFromPreset).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 16])(
    "at a limit of %i every generated name is trimmed, not empty, within the limit and unused",
    async (limit) => {
      const layouts: LayoutEntry[] = [
        { id: "l1", name: "Разработка и ревью".slice(0, limit).trim() },
        { id: "l2", name: "Со" .slice(0, limit) },
      ];
      const { user, calls } = setup(layouts, limit, [{ id: "call", name: "Созвон с командой" }]);
      const taken = layouts.map((layout) => layout.name.toLocaleLowerCase());
      const acceptable = (name: string) =>
        name.length >= 1 && name.length <= limit && name === name.trim() && !taken.includes(name.toLocaleLowerCase());

      await openList(user);
      await user.click(screen.getByRole("button", { name: `Дублировать «${layouts[0].name}»` }));
      for (const [, name] of calls.onDuplicate.mock.calls) expect(name).toSatisfy(acceptable);
      if (calls.onDuplicate.mock.calls.length === 0) {
        expect(screen.getByRole("textbox", { name: `Имя копии раскладки «${layouts[0].name}»` })).toBeTruthy();
        await user.keyboard("{Escape}");
      }

      await user.click(screen.getByRole("button", { name: "Создать из пресета «Созвон с командой»" }));
      for (const [, name] of calls.onCreateFromPreset.mock.calls) expect(name).toSatisfy(acceptable);
      if (calls.onCreateFromPreset.mock.calls.length === 0) {
        expect(screen.getByRole("textbox", { name: "Имя раскладки из пресета «Созвон с командой»" })).toBeTruthy();
      }
    },
  );
});

describe("LayoutSwitcher: the focused control disappears from the list", () => {
  const base = (calls: ReturnType<typeof spies>) => ({ activeLayoutId: "l1", saveStatus: "saved" as const, ...calls });
  const LAYOUTS: LayoutEntry[] = [
    { id: "l1", name: "Основная" },
    { id: "l2", name: "Ревью" },
  ];

  it("keeps the focus in the list when another window removes the focused layout, and Escape still closes it", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={LAYOUTS} presets={[]} />);
    const trigger = screen.getByRole("button", { name: "Раскладка: Основная" });

    await user.click(trigger);
    screen.getByRole("button", { name: "Ревью" }).focus();
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={[LAYOUTS[0]]} presets={[]} />);

    await waitFor(() => expect(document.activeElement).toBe(popover()));
    await user.keyboard("{Enter}");
    expect(calls.onSwitch).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the focus in the list when the focused preset is withdrawn", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={LAYOUTS} presets={PRESETS} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    screen.getByRole("button", { name: "Создать из пресета «Созвон»" }).focus();
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={LAYOUTS} presets={[]} />);

    await waitFor(() => expect(document.activeElement).toBe(popover()));
    await user.tab();
    expect(popover().contains(document.activeElement)).toBe(true);
    expect(calls.onCreateFromPreset).not.toHaveBeenCalled();
  });

  it("keeps the focus in the list when the layout whose delete question is open goes away", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const view = render(<LayoutSwitcher {...base(calls)} layouts={LAYOUTS} presets={[]} />);

    await user.click(screen.getByRole("button", { name: "Раскладка: Основная" }));
    await user.click(screen.getByRole("button", { name: "Удалить «Ревью»" }));
    view.rerender(<LayoutSwitcher {...base(calls)} layouts={[LAYOUTS[0]]} presets={[]} />);

    await waitFor(() => expect(document.activeElement).toBe(popover()));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Раскладки" })).toBeNull();
    expect(calls.onDelete).not.toHaveBeenCalled();
  });
});
