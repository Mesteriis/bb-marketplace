// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_LANGUAGES } from "../core/translate.ts";
import { translateErrorKindSchema } from "../core/model.ts";
import {
  TRANSLATE_LANGUAGES,
  TRANSLATION_STARTING,
  TranslationBlock,
  translationErrorText,
  type TranslationState,
} from "./translation-block.tsx";

installTestPluginRuntime();
afterEach(cleanup);

// Radix Select needs these, which jsdom lacks.
const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

function state(overrides: Partial<TranslationState> = {}): TranslationState {
  return {
    ...TRANSLATION_STARTING("ru"),
    status: "done",
    text: "Made-up translated text",
    provider: "provider-x",
    model: "model-y",
    ...overrides,
  };
}

function mount(s: TranslationState) {
  const props = { onStop: vi.fn(), onAgain: vi.fn(), onLanguage: vi.fn(), onSettings: vi.fn() };
  const utils = render(<TranslationBlock state={s} {...props} />);
  return { ...utils, ...props };
}

describe("TranslationBlock", () => {
  it("offers exactly the languages the server takes", () => {
    expect(TRANSLATE_LANGUAGES.map((l) => l.tag)).toEqual(SUPPORTED_LANGUAGES.map((l) => l.tag));
    expect(TRANSLATE_LANGUAGES.map((l) => l.label)).toEqual(SUPPORTED_LANGUAGES.map((l) => l.english));
  });

  it("labels the translation with provider, model and language, and says a model wrote it", () => {
    mount(state({ cached: true }));
    expect(screen.getByText("Machine translation · provider-x · model-y · into Russian · cached")).toBeTruthy();
    expect(screen.getByText("Translated by a model; it may be wrong.")).toBeTruthy();
    expect(screen.getByText("Made-up translated text").className).toContain("whitespace-pre-wrap");
  });

  it.each([
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    "**bold** [link](https://evil.example) and `code`",
    "javascript:alert(1) https://evil.example/path",
  ])("renders %j as literal text: no element, no link", (text) => {
    const { container } = mount(state({ text }));
    const block = screen.getByRole("region", { name: "Translation" });
    expect(block.textContent).toContain(text);
    expect(container.querySelector("img, script, a, strong, em, code")).toBeNull();
  });

  it("while running shows progress and Stop", () => {
    const { onStop } = mount(state({ status: "running", text: "Partial" }));
    expect(screen.getByRole("status").textContent).toBe("Translating…");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Translate again" })).toBeNull();
  });

  it("offers Translate again and settings when done", () => {
    const { onAgain, onSettings } = mount(state());
    fireEvent.click(screen.getByRole("button", { name: "Translate again" }));
    fireEvent.click(screen.getByRole("button", { name: "AI settings…" }));
    expect(onAgain).toHaveBeenCalled();
    expect(onSettings).toHaveBeenCalled();
  });

  it("notes a long message and a cut-short translation", () => {
    mount(state({ truncatedInput: true, cutShort: true }));
    expect(screen.getByText("Translated the first part of a long message.")).toBeTruthy();
    expect(screen.getByText("The translation was cut short.")).toBeTruthy();
  });

  it("notes a stored translation that is not complete", () => {
    mount(state({ cached: true, incomplete: true }));
    expect(screen.getByText("This translation is not complete.")).toBeTruthy();
  });

  it.each([
    ["gateway_missing", "Translation needs the Makosh AI plugin."],
    ["pool_unavailable", "Makosh AI cannot reach Account Pooler right now."],
    ["provider_unknown", "The translation provider 'provider-x' is not available in Makosh AI. Choose another in AI settings."],
    ["model_unknown", "The model 'model-y' is not available for 'provider-x'. Choose another in AI settings."],
    ["auth", "The provider refused the request (sign-in). Try later or choose another provider."],
    ["quota", "The provider refused the request (quota). Try later or choose another provider."],
    ["refused", "The model declined to translate this message."],
    ["too_large", "The message is too large to translate."],
    ["busy", "Translation is busy; try again in a moment."],
    ["failed", "The translation failed."],
  ] as const)("says what %s means, with Retry", (error, text) => {
    const { onAgain } = mount(state({ status: "failed", error, text: "" }));
    expect(screen.getByRole("alert").textContent).toContain(text);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAgain).toHaveBeenCalled();
  });

  it("has a text for every error kind", () => {
    for (const kind of translateErrorKindSchema.options) {
      expect(translationErrorText(kind, "p", "m")).not.toBe("");
    }
  });

  it("shows makosh-ai's own refusal text for pool_unavailable", () => {
    mount(state({ status: "failed", error: "pool_unavailable", gatewayMessage: "Bridge is not connected", text: "" }));
    expect(screen.getByRole("alert").textContent).toContain("Makosh AI says: Bridge is not connected");
  });

  it("changes the language from the picker", async () => {
    const { onLanguage } = mount(state());
    const picker = screen.getByRole("combobox", { name: "Translate into" });
    picker.focus();
    fireEvent.keyDown(picker, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "Japanese" }), { key: "Enter", code: "Enter" });
    expect(onLanguage).toHaveBeenCalledWith("ja");
  });
});
