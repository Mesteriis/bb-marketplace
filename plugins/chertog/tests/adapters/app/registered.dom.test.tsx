import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { registerChertogApp } from "../../../src/adapters/bb/app/register.tsx";
import { FakeWorkspaceRpc, type SaveCall } from "./support.ts";

const store = new FakeWorkspaceRpc();
const composers: never[] = [];
const sdk = { plugins: { list: async () => ({ plugins: [] }) }, environments: {}, files: {}, threads: { tabs: {} }, experimental_desktopBrowsers: {}, terminals: {} };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useComposers: () => composers, useBbNavigate: () => ({}), useSdk: () => sdk,
  experimental_usePluginId: () => "chertog",
  useRpc: () => ({ call: (method: string, input: SaveCall) =>
    method === "load_workspace" ? store.load() : store.save(input.document, input.expectedRevision) }),
}));

it("offers Terminals on the registered workspace page and saves its reference", async () => {
  let Page!: ComponentType;
  let Actions!: ComponentType;
  registerChertogApp({ slots: { navPanel: (slot: { component: ComponentType; headerContent: ComponentType }) => { Page = slot.component; Actions = slot.headerContent; },
    experimental_appOverlay() {}, homepageSection() {} }, commands: { register() {} } } as unknown as PluginAppBuilder);
  const user = userEvent.setup();
  render(<><Actions /><Page /></>);
  await user.click(await screen.findByRole("button", { name: "Добавить панель" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Terminals" }));
  expect(Object.values(store.saves.at(-1)!.document.panels).map(p => p.ref)).toEqual([{ provider: "terminals", params: {} }]);
});
