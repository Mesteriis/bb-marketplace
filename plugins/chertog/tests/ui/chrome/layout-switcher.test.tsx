// The layout switcher, driven the way a user drives it: every expectation
// names the callback and the arguments the action must produce.
import { render, screen, within } from "@testing-library/react";
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
  ] as const)("reports %s without a reload action", (saveStatus, text) => {
    render(<Harness calls={spies()} saveStatus={saveStatus} />);

    expect(screen.getByRole("status").textContent).toBe(text);
    expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
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
