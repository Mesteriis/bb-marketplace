// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

afterEach(() => vi.restoreAllMocks());

const sessionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.7";

async function openTab(params: { sessionId: string } | null) {
  const plugin = await loadPluginApp(() => import("./app.tsx"));
  const tab = plugin.tabs.find((item) => item.id === "remote-session-live");
  if (tab?.context.kind !== "thread" || tab.availability !== "action") {
    throw new Error("Remote Hub thread action is missing");
  }
  return renderSlot<{ params: typeof params } & ExperimentalThreadTabProps>(
    tab,
    { params, threadId: "thread-test", environment: null },
    { rpc: {
      profile_list: () => [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Test gateway", protocol: "ssh", executionHostId: "local",
        host: "gateway.example.test", port: null, username: "dev", domain: null, authType: "agent", identityFile: null,
        credentialRef: null, rdpWidth: null, rdpHeight: null, group: null, tags: [], favorite: false, color: null,
        origin: "manual", createdAt: "", updatedAt: "", lastOpenedAt: null, recentErrors: [],
      }],
      pve_console_tabs_list: () => ({ tabs: [] }),
      session_list: () => [],
    } },
  );
}

describe("Remote Hub thread tab", () => {
  it("opens the connection list and desk when launched from the side-panel menu", async () => {
    const tab = await openTab(null);
    try {
      expect(await tab.findByText("Test gateway")).toBeTruthy();
      expect(tab.getByTestId("desk-empty")).toBeTruthy();
      fireEvent.click(tab.getByRole("button", { name: "Изменить: Test gateway" }));
      expect(await tab.findByTestId("hub-screen")).toBeTruthy();
      expect(tab.inspection.rpcCalls.some((call) => call.method === "session_attach")).toBe(false);
    } finally {
      tab.lifecycle.unmount();
    }
  });

  it("keeps showing the requested session state when opened with an explicit session key", async () => {
    const tab = await openTab({ sessionId });
    try {
      expect(await tab.findByRole("status")).toBeTruthy();
      expect(tab.inspection.rpcCalls.map((call) => call.method)).toEqual(["session_list"]);
    } finally {
      tab.lifecycle.unmount();
    }
  });
});
