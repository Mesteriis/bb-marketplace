// @vitest-environment jsdom
// The BB entry itself: one ChatGPT tab and nothing else, talking to the
// window only through RPC.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it, vi } from "vitest";

const OPEN = { window: "open", reason: null };

describe("the BB entry", () => {
  it("registers only the ChatGPT tab: no message action, content script or Browser control", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));

    expect(app.navPanels.map((panel) => [panel.id, panel.title, panel.path])).toEqual([["chat-dock", "ChatGPT", "chat"]]);
    expect(app.messageActions).toEqual([]);
    expect(app.contentScripts).toEqual([]);
    expect(app.browserToolbarActions).toEqual([]);
  });

  it("the tab opens ChatGPT and places it through RPC", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const calls: string[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => (calls.push("status"), OPEN),
          open: () => (calls.push("open"), OPEN),
          attach: () => (calls.push("attach"), { ok: true }),
        },
      },
    );
    await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(["status", "open", "attach"])));
    slot.lifecycle.unmount();
  });
});
