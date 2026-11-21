// @vitest-environment jsdom
// The BB entry itself: what it registers, that the Browser page is scripted
// only in the isolated world, and that taking the plugin's UI down drops the
// staged text.
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom cannot produce a trusted event, and `isTrusted` cannot be forged, so
// this file alone treats dispatched clicks as the user's. The guard itself is
// tested in ui.test.tsx.
vi.mock("../src/ui/services.ts", async (original) => ({
  ...(await original<typeof import("../src/ui/services.ts")>()),
  isTrustedEvent: () => true,
}));

const MARKER = "SYNTHETIC-MARKER-app-3e1f";
const URL_A = "https://chatgpt.com/c/aaaaaaaa-0000-4000-8000-00000000000a";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the BB entry", () => {
  it("registers one page, one message action, one toolbar control and no more", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));

    expect(app.navPanels.map((panel) => [panel.id, panel.title, panel.path])).toEqual([["chat-dock", "ChatGPT", "chat"]]);
    expect(app.messageActions.map((action) => [action.id, action.title])).toEqual([
      ["stage-selection", "Вставить в ChatGPT…"],
    ]);
    expect(app.browserToolbarActions.map((action) => action.id)).toEqual(["insert"]);
    expect(app.contentScripts.map((script) => script.id)).toEqual(["lifetime"]);
  });

  it("stages a selection for the page and drops it when the plugin's UI is taken down", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "chat-dock", generation: 1 });
    const run = app.messageActions[0]!.run as (context: { threadId: string; selectedText?: string }) => void;

    run({ threadId: "thr_1" });
    run({ threadId: "thr_1", selectedText: MARKER });
    const first = renderSlot(app.navPanels[0]!, { subPath: "" });
    expect((first.getByLabelText("Текст для передачи") as HTMLTextAreaElement).value).toBe(MARKER);
    first.lifecycle.unmount();

    await scripts.lifecycle.dispose();

    const second = renderSlot(app.navPanels[0]!, { subPath: "" });
    expect((second.getByLabelText("Текст для передачи") as HTMLTextAreaElement).value).toBe("");
    second.lifecycle.unmount();
  });

  it("scripts the Browser page only in the isolated world, and only after the mode is turned on", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "chat-dock", generation: 2 });
    const worlds: Array<string | undefined> = [];
    const page = {
      evaluate: async (_expression: string, options?: { world?: string }) => {
        worlds.push(options?.world);
        return null;
      },
      onMessage: () => () => {},
    };
    const props = { threadId: "thr_1", tabId: "tab_1", url: URL_A, isCompactViewport: false, experimental_page: page };

    const before = renderSlot(app.browserToolbarActions[0]!, props);
    expect(before.queryByRole("button", { name: "Вставить в ChatGPT…" })).toBeNull();
    before.lifecycle.unmount();

    const panel = renderSlot(app.navPanels[0]!, { subPath: "" });
    fireEvent.click(panel.getByRole("button", { name: "Я понимаю риск: включить встроенный режим" }));
    panel.lifecycle.unmount();

    const slot = renderSlot(app.browserToolbarActions[0]!, props);
    fireEvent.click(slot.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await slot.findByRole("dialog");
    expect(worlds).toEqual(["isolated"]);
    slot.lifecycle.unmount();

    // Taking the plugin's UI down turns the mode off again.
    await scripts.lifecycle.dispose();
    const after = renderSlot(app.browserToolbarActions[0]!, props);
    expect(after.queryByRole("button", { name: "Вставить в ChatGPT…" })).toBeNull();
    after.lifecycle.unmount();
  });
});
