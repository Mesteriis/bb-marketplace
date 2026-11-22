// The left side of the title bar: the focused tile, or the product name when no tile has content.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TileTitle } from "../../../src/ui/chrome/index.ts";

describe("TileTitle", () => {
  it("shows the product name when there is no tile with content", () => {
    render(<TileTitle tile={null} fallback="Чертог" menuLabel="Действия тайла" menuItems={[]} />);

    expect(screen.getByText("Чертог")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Действия тайла" })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows the state dot, the name and the context of the tile", () => {
    render(
      <TileTitle
        tile={{ title: "Ревьюер", context: "bb-main · chertog", status: { tone: "busy", label: "Работает" } }}
        fallback="Чертог"
        menuLabel="Действия тайла"
        menuItems={[]}
      />,
    );

    expect(screen.getByText("Ревьюер")).toBeTruthy();
    expect(screen.getByText("bb-main · chertog")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Работает" })).toBeTruthy();
    expect(screen.queryByText("Чертог")).toBeNull();
  });

  it("opens the menu of the tile and runs the chosen item", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<TileTitle tile={{ title: "Исполнитель" }} fallback="Чертог" menuLabel="Действия тайла" menuItems={[{ label: "Убрать тайл из раскладки", onSelect }]} />);

    await user.click(screen.getByRole("button", { name: "Действия тайла" }));
    await user.click(screen.getByRole("menuitem", { name: "Убрать тайл из раскладки" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
