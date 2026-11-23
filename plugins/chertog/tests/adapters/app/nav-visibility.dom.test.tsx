// The nav entry follows the «Тайловое пространство» switch, and only when it changes.
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerChertogApp } from "../../../src/adapters/bb/app/register.tsx";
import { FakeWorkspaceRpc } from "./support.ts";

const store = new FakeWorkspaceRpc();
const sdk = { plugins: { list: async () => ({ plugins: [] }) }, environments: {}, files: {}, threads: { tabs: {} }, experimental_desktopBrowsers: {}, terminals: {} };
const host = {
  values: undefined as Record<string, boolean> | undefined,
  items: [] as { id: string; pluginId: string | null; isVisible: boolean }[],
  setVisible: vi.fn(),
};
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<object>()),
  useComposers: () => [], useBbNavigate: () => ({}), useSdk: () => sdk,
  experimental_usePluginId: () => "chertog",
  useRealtime: () => undefined,
  useSettings: () => ({ values: host.values }),
  experimental_useSidebarThreads: () => ({ status: "ready", threads: [], projects: [] }),
  experimental_useSidebarNavigation: () => ({ items: host.items, actions: { setVisible: host.setVisible } }),
  useRpc: () => ({ call: (method: string) => (method === "load_workspace" ? store.load() : Promise.reject(new Error(method))) }),
}));

function overlay(): ComponentType {
  let Overlay!: ComponentType;
  registerChertogApp({
    slots: { navPanel() {}, experimental_appOverlay: (slot: { component: ComponentType }) => { Overlay = slot.component; }, homepageSection() {} },
    commands: { register() {} },
  } as unknown as PluginAppBuilder);
  return Overlay;
}

const ITEM = "chertog/chertog-home";
beforeEach(() => {
  localStorage.clear();
  host.values = undefined;
  host.items = [{ id: ITEM, pluginId: "chertog", isVisible: true }, { id: "other/chertog-home", pluginId: "other", isVisible: true }];
  host.setVisible.mockClear();
});
afterEach(() => vi.clearAllMocks());

it("hides the entry when the switch goes off, once, not on re-render, and shows it when it is on again", () => {
  host.values = { tileSpace: true };
  const Overlay = overlay();
  const view = render(<Overlay />);
  expect(host.setVisible).not.toHaveBeenCalled();

  host.values = { tileSpace: false };
  view.rerender(<Overlay />);
  expect(host.setVisible).toHaveBeenCalledTimes(1);
  expect(host.setVisible).toHaveBeenLastCalledWith(ITEM, false);
  host.items = [{ ...host.items[0]!, isVisible: false }, host.items[1]!];
  view.rerender(<Overlay />);
  view.rerender(<Overlay />);
  expect(host.setVisible).toHaveBeenCalledTimes(1);

  host.values = { tileSpace: true };
  view.rerender(<Overlay />);
  expect(host.setVisible).toHaveBeenCalledTimes(2);
  expect(host.setVisible).toHaveBeenLastCalledWith(ITEM, true);
});

it("first run with the switch off hides the entry, even though the overlay mounts nothing", () => {
  host.values = { tileSpace: false };
  const Overlay = overlay();
  render(<Overlay />);
  expect(host.setVisible).toHaveBeenCalledWith(ITEM, false);
});

it("does nothing while the values are not delivered, and never fights a hand choice on a later start", () => {
  const Overlay = overlay();
  const view = render(<Overlay />);
  expect(host.setVisible).not.toHaveBeenCalled();
  host.values = { tileSpace: true };
  view.rerender(<Overlay />);
  expect(host.setVisible).not.toHaveBeenCalled();
  // The owner hid it by hand; a new window with the switch still on leaves it hidden.
  host.items = [{ ...host.items[0]!, isVisible: false }];
  render(<Overlay />);
  expect(host.setVisible).not.toHaveBeenCalled();
});
