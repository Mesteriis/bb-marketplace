// The states a panel shows instead of live content. Each one has to be told
// apart by text and by look, and none of them retries on its own.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PANEL_STATES, PanelStateView, type PanelState } from "../../../src/ui/live-hosts/index.ts";

function view(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-panel-state]");
  if (found === null) throw new Error("no panel state rendered");
  return found;
}

describe("PanelStateView", () => {
  it("knows exactly the five states", () => {
    expect(PANEL_STATES).toEqual(["loading", "provider-missing", "session-ended", "access-denied", "lost"]);
  });

  it.each([
    ["loading", "Загружается", "Панель открывается."],
    ["provider-missing", "Поставщик отсутствует", "Плагин этой панели выключен или не установлен. Ссылка на панель сохранена."],
    ["session-ended", "Сессия завершена", "Сеанс этой панели закрыт. Повтор откроет новый сеанс."],
    ["access-denied", "Нет доступа", "У вас нет прав на эту панель."],
    ["lost", "Потеряна", "Живое содержимое панели утрачено и не восстановлено."],
  ] satisfies [PanelState, string, string][])("%s shows its own title and explanation", (state, title, description) => {
    const { container } = render(<PanelStateView state={state} />);
    const element = view(container);

    expect(element.getAttribute("data-panel-state")).toBe(state);
    expect(element.getAttribute("role")).toBe("status");
    expect(element.querySelector("[data-panel-state-title]")?.textContent).toBe(title);
    expect(element.querySelector("[data-panel-state-description]")?.textContent).toBe(description);
  });

  it("draws every state with a different icon and a different tone", () => {
    const icons = new Set<string>();
    const tones = new Set<string>();
    for (const state of PANEL_STATES) {
      const { container, unmount } = render(<PanelStateView state={state} />);
      const icon = view(container).querySelector("[data-panel-state-icon]");
      icons.add(icon?.innerHTML ?? "");
      tones.add(icon?.getAttribute("class") ?? "");
      unmount();
    }

    expect(icons.size).toBe(5);
    expect(icons.has("")).toBe(false);
    expect(tones.size).toBe(5);
  });

  it("names the panel when a title is given", () => {
    const { container } = render(<PanelStateView state="lost" panelTitle="Созвон" />);

    expect(view(container).querySelector("[data-panel-state-panel]")?.textContent).toBe("Созвон");
  });

  it("uses the caller's texts when they are given", () => {
    const { container } = render(
      <PanelStateView state="access-denied" title="No access" description="Ask the owner." retryLabel="Again" onRetry={() => {}} />,
    );
    const element = view(container);

    expect(element.querySelector("[data-panel-state-title]")?.textContent).toBe("No access");
    expect(element.querySelector("[data-panel-state-description]")?.textContent).toBe("Ask the owner.");
    expect(element.querySelector("button")?.textContent).toBe("Again");
  });

  it("offers no retry without a handler", () => {
    for (const state of PANEL_STATES) {
      const { container, unmount } = render(<PanelStateView state={state} />);
      expect(container.querySelector("button"), state).toBeNull();
      unmount();
    }
  });

  it("offers no retry while loading, even with a handler", () => {
    const onRetry = vi.fn();
    const { container } = render(<PanelStateView state="loading" onRetry={onRetry} />);

    expect(container.querySelector("button")).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(0);
  });

  it.each(["provider-missing", "session-ended", "access-denied", "lost"] satisfies PanelState[])(
    "%s retries once per click and never on render",
    (state) => {
      const onRetry = vi.fn();
      const { container, rerender } = render(<PanelStateView state={state} onRetry={onRetry} />);
      rerender(<PanelStateView state={state} onRetry={onRetry} />);
      expect(onRetry).toHaveBeenCalledTimes(0);

      const button = container.querySelector("button") as HTMLButtonElement;
      expect(button.getAttribute("type")).toBe("button");
      expect(button.textContent).toBe("Повторить");

      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(1);

      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(2);
    },
  );
});
