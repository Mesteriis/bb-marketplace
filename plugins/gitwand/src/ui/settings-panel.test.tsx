// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitWandStatus } from "../core/contract.ts";
import { SettingsPanel } from "./settings-panel.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const STATUS: GitWandStatus = {
  platform: "darwin-arm64",
  runtime: { version: "3.14.0+bb1", source: "dev", commit: "436b9684f096e8edd35b6a36e3b4d3af0fd7e084" },
  runtimeError: null,
  bridge: { state: "running", detail: null },
  tools: { git: true, gh: false, glab: true },
  update: { state: "disabled", detail: null },
  notice: null,
};

const handlers = () => ({ onRestart: vi.fn(), onRollback: vi.fn(), onCheckUpdates: vi.fn(), onInstall: vi.fn() });

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

describe("SettingsPanel install", () => {
  it("offers to install an available build and installs that version", () => {
    const h = handlers();
    render(<SettingsPanel status={{ ...STATUS, update: { state: "available", detail: "3.14.0+bb2" } }} error={null} busy={false} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Установить 3.14.0+bb2" }));
    expect(h.onInstall).toHaveBeenCalledWith("3.14.0+bb2");
  });

  it("offers no install without an available build", () => {
    render(<SettingsPanel status={STATUS} error={null} busy={false} {...handlers()} />);
    expect(screen.queryByRole("button", { name: /^Установить/ })).toBeNull();
  });

  it("says where a runtime comes from while none is installed and updates are off", () => {
    render(<SettingsPanel status={{ ...STATUS, runtime: null, update: { state: "disabled", detail: null } }} error={null} busy={false} {...handlers()} />);
    expect(screen.getByRole("note").textContent).toBe(
      "Чтобы запустить GitWand, укажите каталог рантайма разработки или канал обновлений с ключом подписи в настройках выше.",
    );
  });
});

describe("SettingsPanel notice", () => {
  it("shows what the user has to do", () => {
    render(<SettingsPanel status={{ ...STATUS, notice: "Перезагрузите плагин: bb plugin reload makosh-gitwand" }} error={null} busy={false} {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Перезагрузите плагин: bb plugin reload makosh-gitwand");
  });
});
