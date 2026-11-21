// The content picker: sections by provider, search, the states a provider
// can be in, panels that are already open, and the tile limit.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContentPicker,
  type ContentChoice,
  type ContentSection,
  type ContentTarget,
} from "../../../src/ui/chrome/index.ts";

const SECTIONS: ContentSection[] = [
  {
    providerId: "threads",
    title: "Треды",
    state: "ready",
    items: [
      { id: "t1", title: "Исполнитель", context: "bb-main", status: "Работает" },
      { id: "t2", title: "Ревьюер", context: "bb-main", status: "Ждёт ответа", openInTileId: "tile-2" },
      { id: "t3", title: "Черновик релиза", context: "infra", status: "Готово" },
    ],
  },
  { providerId: "telegram", title: "Telegram", state: "loading", items: [] },
  { providerId: "zoom", title: "Zoom", state: "missing", items: [] },
  { providerId: "remote", title: "Remote Hub", state: "ready", items: [] },
  { providerId: "mail", title: "Почта", state: "denied", items: [] },
];

function setup(options: { target?: ContentTarget; tileCount?: number; tileLimit?: number; sections?: ContentSection[] } = {}) {
  const onOpen = vi.fn<(choice: ContentChoice) => void>();
  const onFocusExisting = vi.fn<(tileId: string) => void>();
  render(
    <ContentPicker
      target={options.target ?? "empty-tile"}
      sections={options.sections ?? SECTIONS}
      tileCount={options.tileCount ?? 3}
      tileLimit={options.tileLimit ?? 8}
      onOpen={onOpen}
      onFocusExisting={onFocusExisting}
    />,
  );
  return { user: userEvent.setup(), onOpen, onFocusExisting };
}

const item = (title: RegExp) => screen.getByRole("button", { name: title });
const titles = () =>
  within(screen.getByRole("region", { name: "Треды" }))
    .getAllByRole("button")
    .map((button) => button.querySelector("[data-item-title]")?.textContent);

describe("ContentPicker: sections and states", () => {
  it.each([
    ["empty-tile", "Выберите содержимое"],
    ["tab", "Добавить вкладку"],
    ["new-tile", "Добавить панель"],
  ] as const)("is headed for the %s target", (target, heading) => {
    setup({ target });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(heading);
  });

  it("lists a provider's items with their project and status", () => {
    setup();

    expect(titles()).toEqual(["Исполнитель", "Ревьюер", "Черновик релиза"]);
    const first = item(/Исполнитель/);
    expect(first.textContent).toContain("bb-main");
    expect(first.textContent).toContain("Работает");
  });

  it("tells loading, missing, no access and empty apart", () => {
    setup();

    expect(within(screen.getByRole("region", { name: "Telegram" })).getByRole("status").textContent).toBe("Загружается…");
    expect(screen.getByRole("region", { name: "Zoom" }).textContent).toContain("Поставщик отсутствует");
    expect(screen.getByRole("region", { name: "Почта" }).textContent).toContain("Нет доступа");
    expect(screen.getByRole("region", { name: "Remote Hub" }).textContent).toContain("Здесь пока ничего нет");
    for (const name of ["Telegram", "Zoom", "Почта", "Remote Hub"]) {
      expect(within(screen.getByRole("region", { name })).queryAllByRole("button")).toEqual([]);
    }
  });

  it("says so when there is no provider at all", () => {
    setup({ sections: [] });

    expect(screen.getByText("Нет поставщиков содержимого")).toBeTruthy();
  });
});

describe("ContentPicker: choosing", () => {
  it("opens the chosen item in the default place", async () => {
    const { user, onOpen, onFocusExisting } = setup();

    await user.click(item(/Исполнитель/));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "default" });
    expect(onFocusExisting).not.toHaveBeenCalled();
  });

  it("marks an item that is already open and focuses its tile instead of opening a second one", async () => {
    const { user, onOpen, onFocusExisting } = setup();

    expect(item(/Ревьюер/).textContent).toContain("Уже открыто");
    expect(item(/Исполнитель/).textContent).not.toContain("Уже открыто");

    await user.click(item(/Ревьюер/));

    expect(onFocusExisting).toHaveBeenCalledTimes(1);
    expect(onFocusExisting).toHaveBeenLastCalledWith("tile-2");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("ContentPicker: search", () => {
  it("filters by title, project and status, whatever the case", async () => {
    const { user } = setup();
    const search = screen.getByRole("searchbox", { name: "Поиск" });

    await user.type(search, "INFRA");
    expect(titles()).toEqual(["Черновик релиза"]);

    await user.clear(search);
    await user.type(search, "ждёт");
    expect(titles()).toEqual(["Ревьюер"]);

    await user.clear(search);
    await user.type(search, "исполн");
    expect(titles()).toEqual(["Исполнитель"]);

    await user.clear(search);
    expect(titles()).toEqual(["Исполнитель", "Ревьюер", "Черновик релиза"]);
  });

  it("says nothing was found, and keeps the other providers' states out of the way", async () => {
    const { user } = setup();

    await user.type(screen.getByRole("searchbox", { name: "Поиск" }), "нет такого");

    expect(within(screen.getByRole("region", { name: "Треды" })).getByText("Ничего не найдено")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Треды" })).queryAllByRole("button")).toEqual([]);
    // An empty provider is not a failed search.
    expect(screen.getByRole("region", { name: "Remote Hub" }).textContent).toContain("Здесь пока ничего нет");
  });
});

describe("ContentPicker: at the tile limit", () => {
  const atLimit = { target: "new-tile", tileCount: 8, tileLimit: 8 } as const;
  const limitStep = () => screen.getByRole("group", { name: "Свободных мест нет" });

  it("offers a tab in the group or an explicit place instead of opening a ninth tile", async () => {
    const { user, onOpen } = setup(atLimit);

    await user.click(item(/Исполнитель/));

    expect(onOpen).not.toHaveBeenCalled();
    expect(limitStep().textContent).toContain(
      "Открыто панелей: 8 из 8. «Исполнитель» можно открыть вкладкой в текущей группе или выбрать, какое место занять.",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Открыть вкладкой в группе" }));

    await user.click(screen.getByRole("button", { name: "Открыть вкладкой в группе" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "tab" });
  });

  it("passes on the explicit choice of a place", async () => {
    const { user, onOpen } = setup(atLimit);

    await user.click(item(/Черновик релиза/));
    await user.click(screen.getByRole("button", { name: "Выбрать место…" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t3", placement: "pick-place" });
  });

  it.each([
    ["the Cancel button", "click"],
    ["Escape", "escape"],
  ] as const)("%s changes nothing and returns to the list", async (_case, how) => {
    const { user, onOpen, onFocusExisting } = setup(atLimit);

    await user.click(item(/Исполнитель/));
    if (how === "click") await user.click(screen.getByRole("button", { name: "Отмена" }));
    else await user.keyboard("{Escape}");

    expect(onOpen).not.toHaveBeenCalled();
    expect(onFocusExisting).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Свободных мест нет" })).toBeNull();
    expect(document.activeElement).toBe(item(/Исполнитель/));
  });

  it("still focuses a panel that is already open: that needs no place", async () => {
    const { user, onOpen, onFocusExisting } = setup(atLimit);

    await user.click(item(/Ревьюер/));

    expect(onFocusExisting).toHaveBeenLastCalledWith("tile-2");
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Свободных мест нет" })).toBeNull();
  });

  it("opens without a question one tile below the limit", async () => {
    const { user, onOpen } = setup({ target: "new-tile", tileCount: 7, tileLimit: 8 });

    await user.click(item(/Исполнитель/));

    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "default" });
  });

  it.each(["empty-tile", "tab"] as const)("does not apply the limit to the %s target, which adds no tile", async (target) => {
    const { user, onOpen } = setup({ target, tileCount: 8, tileLimit: 8 });

    await user.click(item(/Исполнитель/));

    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "default" });
  });
});

describe("ContentPicker: keyboard", () => {
  it("moves from the search field through the items with arrows and chooses with Enter", async () => {
    const { user, onOpen, onFocusExisting } = setup();

    await user.tab();
    const search = screen.getByRole("searchbox", { name: "Поиск" });
    expect(document.activeElement).toBe(search);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item(/Исполнитель/));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(item(/Черновик релиза/));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item(/Черновик релиза/));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(search);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith({ providerId: "threads", itemId: "t1", placement: "default" });
    expect(onFocusExisting).not.toHaveBeenCalled();
  });
});

describe("ContentPicker: the sections change while the limit question is open", () => {
  const withFirst = (change: (items: ContentSection["items"]) => ContentSection["items"]): ContentSection[] => [
    { ...SECTIONS[0], items: change(SECTIONS[0].items) },
    ...SECTIONS.slice(1),
  ];

  function open() {
    const onOpen = vi.fn<(choice: ContentChoice) => void>();
    const onFocusExisting = vi.fn<(tileId: string) => void>();
    const picker = (sections: ContentSection[]) => (
      <ContentPicker target="new-tile" sections={sections} tileCount={8} tileLimit={8} onOpen={onOpen} onFocusExisting={onFocusExisting} />
    );
    const view = render(picker(SECTIONS));
    return { user: userEvent.setup(), onOpen, onFocusExisting, update: (sections: ContentSection[]) => view.rerender(picker(sections)) };
  }

  it.each(["Открыть вкладкой в группе", "Выбрать место…"])(
    "«%s» focuses the tile when the item got opened meanwhile, instead of opening a duplicate",
    async (button) => {
      const { user, onOpen, onFocusExisting, update } = open();

      await user.click(item(/Исполнитель/));
      update(withFirst((items) => items.map((entry) => (entry.id === "t1" ? { ...entry, openInTileId: "tile-9" } : entry))));
      await user.click(screen.getByRole("button", { name: button }));

      expect(onFocusExisting).toHaveBeenCalledTimes(1);
      expect(onFocusExisting).toHaveBeenLastCalledWith("tile-9");
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it("returns to the list when the item is gone, and opens nothing", async () => {
    const { user, onOpen, onFocusExisting, update } = open();

    await user.click(item(/Исполнитель/));
    update(withFirst((items) => items.filter((entry) => entry.id !== "t1")));

    expect(screen.queryByRole("group", { name: "Свободных мест нет" })).toBeNull();
    expect(titles()).toEqual(["Ревьюер", "Черновик релиза"]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onFocusExisting).not.toHaveBeenCalled();
  });

  it("names the item by its current title", async () => {
    const { user, update } = open();

    await user.click(item(/Исполнитель/));
    update(withFirst((items) => items.map((entry) => (entry.id === "t1" ? { ...entry, title: "Исполнитель 2" } : entry))));

    expect(screen.getByRole("group", { name: "Свободных мест нет" }).textContent).toContain("«Исполнитель 2»");
  });
});
