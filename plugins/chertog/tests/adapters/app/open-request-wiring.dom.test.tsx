// The overlay register.tsx mounts must answer chertog.open.v1 `not-shown` once
// the Chertog route has left the window, although the session keeps its document.
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OPEN_EVENT } from "../../../src/core/wire/index.ts";
import { registerChertogApp } from "../../../src/adapters/bb/app/register.tsx";
import { FakeWorkspaceRpc, type SaveCall } from "./support.ts";

const store = new FakeWorkspaceRpc();
const sdk = { plugins: { list: async () => ({ plugins: [] }) }, environments: {}, files: {}, threads: { tabs: {} }, experimental_desktopBrowsers: {}, terminals: {} };
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<object>()),
  useComposers: () => [], useBbNavigate: () => ({}), useSdk: () => sdk,
  experimental_usePluginId: () => "chertog",
  useRealtime: () => undefined,
  useSettings: () => ({ values: {} }),
  experimental_useSidebarThreads: () => ({ status: "ready", threads: [], projects: [] }),
  useRpc: () => ({ call: (method: string, input: SaveCall) =>
    method === "load_workspace" ? store.load() : store.save(input.document, input.expectedRevision) }),
}));

function ask() {
  const detail = { kind: "panel", ref: { provider: "terminals", params: {} }, accepted: false, outcome: null as string | null };
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
  return { accepted: detail.accepted, outcome: detail.outcome };
}

it("answers open requests only while the Chertog route is on screen", async () => {
  let Page!: ComponentType;
  let Overlay!: ComponentType;
  registerChertogApp({ slots: { navPanel: (slot: { component: ComponentType }) => { Page = slot.component; },
    experimental_appOverlay: (slot: { component: ComponentType }) => { Overlay = slot.component; }, homepageSection() {} },
    commands: { register() {} } } as unknown as PluginAppBuilder);
  render(<Overlay />);
  expect(ask()).toEqual({ accepted: false, outcome: "not-shown" });
  const page = render(<Page />);
  await screen.findByRole("button", { name: "Добавить панель" });
  expect(ask()).toMatchObject({ accepted: true, outcome: "opened" });
  page.unmount();
  expect(ask()).toEqual({ accepted: false, outcome: "not-shown" });
});
