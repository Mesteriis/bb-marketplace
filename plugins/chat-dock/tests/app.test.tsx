// @vitest-environment jsdom
// The BB entry itself: what it registers, that a selection reaches the page,
// that the page talks to the window only through RPC, and that taking the
// plugin's UI down drops the staged text.
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

const MARK = "SYNTHETIC-MARKER-app-3e1f";
const OPEN = { window: "open", reason: null, proposal: "none", last: null };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the BB entry", () => {
  it("registers one page, one message action, one lifetime script, and no Browser control", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));

    expect(app.navPanels.map((panel) => [panel.id, panel.title, panel.path])).toEqual([["chat-dock", "ChatGPT", "chat"]]);
    expect(app.messageActions.map((action) => [action.id, action.title])).toEqual([["stage-selection", "Вставить в ChatGPT…"]]);
    expect(app.browserToolbarActions).toEqual([]);
    expect(app.contentScripts.map((script) => script.id)).toEqual(["lifetime"]);
  });

  it("stages a selection, hands it to the window through RPC, and drops it when the UI is taken down", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "chat-dock", generation: 1 });
    const run = app.messageActions[0]!.run as (context: { threadId: string; selectedText?: string }) => void;
    const proposed: unknown[] = [];

    run({ threadId: "thr_1", selectedText: MARK });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => OPEN,
          open: () => OPEN,
          attach: () => ({ ok: true }),
          propose: (input: unknown) => (proposed.push(input), { ok: true, proposalId: "p-1" }),
        },
      },
    );
    expect((slot.getByLabelText("Текст для передачи") as HTMLTextAreaElement).value).toBe(MARK);
    await slot.findByText("ChatGPT открыт.");
    fireEvent.click(slot.getByRole("button", { name: "Передать в ChatGPT" }));
    await vi.waitFor(() => expect(proposed).toEqual([{ text: MARK, source: "message-selection" }]));
    slot.lifecycle.unmount();

    await scripts.lifecycle.dispose();

    const second = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { status: () => OPEN, open: () => OPEN, attach: () => ({ ok: true }) } });
    expect((second.getByLabelText("Текст для передачи") as HTMLTextAreaElement).value).toBe("");
    second.lifecycle.unmount();
  });
});
