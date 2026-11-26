// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitWandStatus } from "../core/contract.ts";
import { SettingsPanel } from "./settings-panel.tsx";

afterEach(cleanup);

const STATUS: GitWandStatus = {
  platform: "darwin-arm64",
  runtime: { version: "3.14.0+bb1", source: "dev", commit: "436b9684f096e8edd35b6a36e3b4d3af0fd7e084" },
  runtimeError: null,
  bridge: { state: "running", detail: null },
  tools: { git: true, gh: false, glab: true },
  update: { state: "disabled", detail: null },
};

const handlers = () => ({ onRestart: vi.fn(), onRollback: vi.fn(), onCheckUpdates: vi.fn() });

describe("SettingsPanel", () => {
  it("shows runtime, backend, tools and updates", () => {
    render(<SettingsPanel status={STATUS} error={null} busy={false} {...handlers()} />);
    const text = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(text("Рантайм")).toBe("3.14.0+bb1 (каталог разработки), GitWand 436b968");
    expect(text("Бэкенд")).toBe("работает");
    expect(text("Инструменты")).toBe("git — есть, gh — нет, glab — есть");
    expect(text("Обновления")).toBe("выключены: канал не настроен");
  });

  it("explains a missing runtime and a failed backend", () => {
    render(
      <SettingsPanel
        status={{ ...STATUS, runtime: null, runtimeError: "bin/gitwand-bridge is missing", bridge: { state: "failed", detail: "gitwand-bridge exited 3 times in a row" } }}
        error={null}
        busy={false}
        {...handlers()}
      />,
    );
    expect(screen.getByText("Рантайм").nextElementSibling?.textContent).toBe("не установлен: bin/gitwand-bridge is missing");
    expect(screen.getByText("Бэкенд").nextElementSibling?.textContent).toBe("остановлен после сбоев: gitwand-bridge exited 3 times in a row");
  });

  it("runs the actions and disables them while busy", () => {
    const h = handlers();
    const { rerender } = render(<SettingsPanel status={STATUS} error={null} busy={false} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    fireEvent.click(screen.getByRole("button", { name: "Откатить" }));
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));
    expect([h.onRestart.mock.calls.length, h.onRollback.mock.calls.length, h.onCheckUpdates.mock.calls.length]).toEqual([1, 1, 1]);
    rerender(<SettingsPanel status={STATUS} error={null} busy={true} {...h} />);
    expect(screen.getByRole("button", { name: "Перезапустить" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an action error", () => {
    render(<SettingsPanel status={STATUS} error="There is no previous GitWand runtime to roll back to" busy={false} {...handlers()} />);
    expect(screen.getByRole("alert").textContent).toBe("There is no previous GitWand runtime to roll back to");
  });
});
