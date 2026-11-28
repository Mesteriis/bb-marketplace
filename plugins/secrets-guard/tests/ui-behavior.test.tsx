// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardView } from "../src/core/service.ts";
import { GuardButton } from "../src/ui/guard-button.tsx";
import { GuardPopup } from "../src/ui/guard-popup.tsx";

const closed: GuardView = { configured: true, local: true, effective: null };
const openGlobal: GuardView = {
  configured: true,
  local: true,
  effective: { scope: "global", until: 2440, rootThreadId: null },
};

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
