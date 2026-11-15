// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationSettings, type TranslateSettingsData } from "./translation-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

function data(overrides: Partial<TranslateSettingsData> = {}): TranslateSettingsData {
  return {
    gateway: "ok",
    providers: [
      { id: "provider-a", displayName: "Provider A", available: true },
      { id: "provider-b", displayName: "Provider B", available: false },
    ],
    models: [
      { model: "model-1", displayName: "Model One" },
      { model: "model-2", displayName: "Model Two" },
    ],
    current: { providerId: "provider-a", model: "model-1", language: "ru" },
    ...overrides,
  };
}

function mount(d: TranslateSettingsData) {
  const save = vi.fn(async () => undefined);
  const clear = vi.fn(async () => 3);
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(
    <TranslationSettings open onOpenChange={onOpenChange} load={async () => d} save={save} clear={clear} onSaved={onSaved} />,
  );
  return { save, clear, onOpenChange, onSaved };
}

async function choose(name: RegExp | string, option: string) {
  const trigger = screen.getByRole("combobox", { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter", code: "Enter" });
}

describe("TranslationSettings", () => {
  it("lists providers with availability and the current provider's models, and saves the choice", async () => {
    const { save, onSaved } = mount(data());
    await screen.findByRole("combobox", { name: "Provider" });
    expect(screen.getByText("Other providers need a Makosh Mail update.")).toBeTruthy();
    await choose("Model", "Model Two");
    await choose("Translate into", "Japanese");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(save).toHaveBeenCalledWith({ providerId: "provider-a", model: "model-2", language: "ja" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("marks a provider that is not available", async () => {
    mount(data({ current: { providerId: "provider-b", model: "", language: "en" }, models: null }));
    await screen.findByRole("combobox", { name: "Provider" });
    expect(screen.getByText("This provider is not available in Makosh AI right now.")).toBeTruthy();
  });

  it.each([null, []])("falls back to a text field when there is no model list (%j)", async (models) => {
    const { save } = mount(data({ models }));
    const field = (await screen.findByLabelText("Model")) as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    fireEvent.change(field, { target: { value: " custom-model " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(save).toHaveBeenCalledWith({ providerId: "provider-a", model: "custom-model", language: "ru" });
  });

  it("a different provider than the saved one takes a typed model", async () => {
    mount(data());
    await screen.findByRole("combobox", { name: "Provider" });
    await choose("Provider", "Provider B (not available)");
    expect(((await screen.findByLabelText("Model")) as HTMLElement).tagName).toBe("INPUT");
  });

  it("clears stored translations and says how many", async () => {
    const { clear } = mount(data());
    await screen.findByRole("combobox", { name: "Provider" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear translations" }));
    });
    expect(clear).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Removed 3 stored translations.");
  });

  it("explains when Makosh AI is missing and does not save", async () => {
    mount(data({ gateway: "gateway_missing", providers: [], models: null }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Translation needs the Makosh AI plugin"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
