// The list of live panels that are in no tile: a counter, "show" and "close".
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HiddenPanelsList, type HiddenPanelEntry } from "../../../src/ui/chrome/index.ts";

const PANELS: HiddenPanelEntry[] = [
  { instanceId: "p1", title: "Zoom: Планёрка", context: "Идёт звонок" },
  { instanceId: "p2", title: "SSH: build-01" },
];

function setup(panels: HiddenPanelEntry[] = PANELS) {
  const onShow = vi.fn<(instanceId: string) => void>();
  const onClose = vi.fn<(instanceId: string) => void>();
  render(<HiddenPanelsList panels={panels} onShow={onShow} onClose={onClose} />);
  return { user: userEvent.setup(), onShow, onClose };
}

describe("HiddenPanelsList", () => {
  it("counts the hidden panels in its button", () => {
    setup();

    const trigger = screen.getByRole("button", { name: "Скрытые панели: 2" });
    expect(trigger.textContent).toBe("Скрытые панели2");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Скрытые панели" })).toBeNull();
  });

  it("shows a hidden panel", async () => {
    const { user, onShow, onClose } = setup();

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 2" }));
    expect(screen.getByRole("dialog", { name: "Скрытые панели" }).textContent).toContain("Идёт звонок");
    await user.click(screen.getByRole("button", { name: "Показать «Zoom: Планёрка»" }));

    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenLastCalledWith("p1");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks to close a hidden panel", async () => {
    const { user, onShow, onClose } = setup();

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 2" }));
    await user.click(screen.getByRole("button", { name: "Закрыть «SSH: build-01»" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenLastCalledWith("p2");
    expect(onShow).not.toHaveBeenCalled();
  });

  it("says there is nothing hidden when the list is empty", async () => {
    const { user } = setup([]);

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 0" }));

    const popover = screen.getByRole("dialog", { name: "Скрытые панели" });
    expect(popover.textContent).toContain("Скрытых панелей нет");
    expect(popover.querySelectorAll("button").length).toBe(0);
  });

  it("works from the keyboard: Enter opens, arrows move, Escape closes and returns focus", async () => {
    const { user, onShow } = setup();

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Скрытые панели: 2" });
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Показать «Zoom: Планёрка»" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Показать «SSH: build-01»" }));
    await user.keyboard("{Enter}");
    expect(onShow).toHaveBeenLastCalledWith("p2");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Скрытые панели" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when Tab takes the focus out of the list", async () => {
    const onShow = vi.fn<(instanceId: string) => void>();
    const onClose = vi.fn<(instanceId: string) => void>();
    const user = userEvent.setup();
    render(
      <>
        <HiddenPanelsList panels={[PANELS[0]]} onShow={onShow} onClose={onClose} />
        <button type="button">Снаружи</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Закрыть «Zoom: Планёрка»" }));
    expect(screen.queryByRole("dialog", { name: "Скрытые панели" })).not.toBeNull();

    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Снаружи" }));
    expect(screen.queryByRole("dialog", { name: "Скрытые панели" })).toBeNull();
    expect(onShow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("HiddenPanelsList: the focused row disappears", () => {
  it.each([
    ["another panel is left", [PANELS[1]]],
    ["the list becomes empty", []],
  ] as const)("keeps the focus in the list when %s, and Escape still closes it", async (_case, rest) => {
    const user = userEvent.setup();
    const onShow = vi.fn<(instanceId: string) => void>();
    const onClose = vi.fn<(instanceId: string) => void>();
    const view = render(<HiddenPanelsList panels={PANELS} onShow={onShow} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Скрытые панели: 2" }));
    await user.click(screen.getByRole("button", { name: "Показать «Zoom: Планёрка»" }));
    expect(onShow).toHaveBeenLastCalledWith("p1");
    view.rerender(<HiddenPanelsList panels={[...rest]} onShow={onShow} onClose={onClose} />);

    const popover = screen.getByRole("dialog", { name: "Скрытые панели" });
    await waitFor(() => expect(document.activeElement).toBe(popover));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Скрытые панели" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Скрытые панели: ${rest.length}` }));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
