// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GuardView } from "../src/core/service.ts";
import { GuardButton } from "../src/ui/guard-button.tsx";
import { GuardPopup } from "../src/ui/guard-popup.tsx";
import { GuardToggle } from "../src/ui/guard-toggle.tsx";

const closed: GuardView = { configured: true, local: true, effective: null };
const openGlobal: GuardView = {
  configured: true,
  local: true,
  effective: { scope: "global", until: 2440, rootThreadId: null },
};

beforeAll(() => {
  // jsdom has no layout: the popover library only needs these to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function show(view: GuardView | null, busy = false) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const utils = render(<GuardPopup view={view} now={1000} busy={busy} error={null} onOpen={onOpen} onClose={onClose} />);
  return { onOpen, onClose, ...utils };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("opening", () => {
  it("a term opens at once with the default scope", () => {
    const { onOpen } = show(closed);
    fireEvent.click(screen.getByRole("button", { name: "30 мин" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("thread", 30);
  });
  it("a term opens with the segment chosen before it", () => {
    const { onOpen } = show(closed);
    fireEvent.click(radio("С субтредами"));
    expect(radio("С субтредами").getAttribute("aria-checked")).toBe("true");
    expect(radio("Этот чат").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "60 мин" }));
    expect(onOpen).toHaveBeenCalledWith("tree", 60);
  });
  it("choosing a segment opens nothing by itself", () => {
    const { onOpen } = show(closed);
    fireEvent.click(radio("Глобально"));
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("a term extends what is open, with the scope that is open", () => {
    const { onOpen } = show(openGlobal);
    fireEvent.click(screen.getByRole("button", { name: "10 мин" }));
    expect(onOpen).toHaveBeenCalledWith("global", 10);
  });
});

describe("closing", () => {
  it("the close button closes", () => {
    const { onClose, onOpen } = show(openGlobal);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("the scope segments as a radio group", () => {
  it("the right arrow selects and focuses the next segment", () => {
    show(closed);
    radio("Этот чат").focus();
    fireEvent.keyDown(radio("Этот чат"), { key: "ArrowRight" });
    expect(radio("С субтредами").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("С субтредами"));
    expect(radio("С субтредами").getAttribute("tabindex")).toBe("0");
    expect(radio("Этот чат").getAttribute("tabindex")).toBe("-1");
  });
  it("the left arrow wraps from the first segment to the last", () => {
    show(closed);
    radio("Этот чат").focus();
    fireEvent.keyDown(radio("Этот чат"), { key: "ArrowLeft" });
    expect(radio("Глобально").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Глобально"));
  });
  it("a term after the arrows uses the segment they selected", () => {
    const { onOpen } = show(closed);
    fireEvent.keyDown(radio("Этот чат"), { key: "ArrowDown" });
    fireEvent.keyDown(radio("С субтредами"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "10 мин" }));
    expect(onOpen).toHaveBeenCalledWith("global", 10);
  });
});

describe("while a request is running", () => {
  it("the terms and the close button do nothing", () => {
    const { onOpen, onClose } = show(openGlobal, true);
    fireEvent.click(screen.getByRole("button", { name: "10 мин" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the composer button", () => {
  it("opens the window", () => {
    const onOpen = vi.fn();
    render(<GuardButton view={closed} now={1000} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Секреты: Закрыто" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("names the remaining time for a screen reader when open", () => {
    render(<GuardButton view={openGlobal} now={1000} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Секреты: Открыто: глобально, осталось 24 мин" }).textContent).toBe("24 м");
  });
});

describe("the popover on the composer button", () => {
  const SCOPE = { "data-bb-plugin": "makosh-secrets-guard", "data-bb-plugin-root": "" } as const;

  function toggle(view: GuardView | null) {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const element = (current: GuardView | null) => (
      <GuardToggle
        view={current}
        now={1000}
        busy={false}
        error={null}
        onOpen={onOpen}
        onClose={onClose}
        scopeProps={SCOPE}
      />
    );
    const utils = render(element(view));
    return { onOpen, onClose, show: (next: GuardView | null) => utils.rerender(element(next)) };
  }

  const lock = () => screen.getByRole("button", { name: /^Секреты/ });

  it("is closed at first and says what the button opens", () => {
    toggle(closed);
    expect(lock().getAttribute("aria-haspopup")).toBe("dialog");
    expect(lock().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens on a click, with the focus on the selected scope", () => {
    toggle(closed);
    fireEvent.click(lock());
    expect(screen.getByRole("dialog", { name: "Секреты" })).toBeTruthy();
    expect(lock().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(radio("Этот чат"));
  });
  it("puts the focus on the scope that is open", () => {
    toggle({ configured: true, local: true, effective: { scope: "tree", until: 2440, rootThreadId: "a" } });
    fireEvent.click(lock());
    expect(document.activeElement).toBe(radio("С субтредами"));
  });
  it("closes on Escape and returns the focus to the button", async () => {
    toggle(closed);
    fireEvent.click(lock());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lock().getAttribute("aria-expanded")).toBe("false");
    // The library hands the focus back after the window has left the page.
    await waitFor(() => expect(document.activeElement).toBe(lock()));
  });
  it("closes on a second click on the button", () => {
    toggle(closed);
    fireEvent.click(lock());
    fireEvent.click(lock());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("closes on a press outside", async () => {
    toggle(closed);
    fireEvent.click(lock());
    // The library starts listening for outside presses one tick after opening,
    // so the press that opened the window does not close it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("stays open and shows the new state after the guard is opened", () => {
    const { onOpen, show } = toggle(closed);
    fireEvent.click(lock());
    fireEvent.click(screen.getByRole("button", { name: "30 мин" }));
    expect(onOpen).toHaveBeenCalledWith("thread", 30);
    show({ configured: true, local: true, effective: { scope: "thread", until: 2800, rootThreadId: "a" } });
    expect(screen.getByRole("dialog").textContent).toContain("Открыто ещё 30 мин");
    expect(lock().getAttribute("aria-expanded")).toBe("true");
  });
  it("stays open after the guard is closed", () => {
    const { onClose, show } = toggle(openGlobal);
    fireEvent.click(lock());
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    show(closed);
    expect(screen.getByRole("dialog").textContent).toContain("Открыть на");
  });
  it("marks the portaled window as the plugin's, so the plugin's styles reach it", () => {
    toggle(closed);
    fireEvent.click(lock());
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-bb-plugin")).toBe("makosh-secrets-guard");
    expect(dialog.hasAttribute("data-bb-plugin-root")).toBe(true);
  });
  it("does not open while the guard is not found", () => {
    toggle({ configured: false, local: true, effective: null });
    fireEvent.click(lock());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
