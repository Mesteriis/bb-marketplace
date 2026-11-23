// The «Тайловое пространство» switch in a window: off mounts nothing of the
// workspace, leaves chertog.open.v1 unanswered, empties the title bar, and
// on again brings the saved layout back.
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPEN_EVENT } from "../../../src/core/wire/index.ts";
import { registerChertogApp } from "../../../src/adapters/bb/app/register.tsx";
import { FakeWorkspaceRpc, type SaveCall } from "./support.ts";

const store = new FakeWorkspaceRpc();
const sdk = { plugins: { list: async () => ({ plugins: [] }) }, environments: {}, files: {}, threads: { tabs: {} }, experimental_desktopBrowsers: {}, terminals: {} };
const host = { values: undefined as Record<string, boolean> | undefined, threadReads: 0, loads: 0 };
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<object>()),
  useComposers: () => [], useBbNavigate: () => ({}), useSdk: () => sdk,
  experimental_usePluginId: () => "chertog",
  experimental_useSidebarNavigation: () => ({ items: [], actions: { setVisible: () => undefined } }),
  useRealtime: () => undefined,
  useSettings: () => ({ values: host.values }),
  experimental_useSidebarThreads: () => { host.threadReads++; return { status: "ready", threads: [], projects: [] }; },
  useRpc: () => ({ call: (method: string, input: SaveCall) => {
    if (method === "load_workspace") { host.loads++; return store.load(); }
    return method === "save_workspace" ? store.save(input.document, input.expectedRevision) : Promise.reject(new Error(method));
  } }),
}));

interface Slots { Page: ComponentType; Overlay: ComponentType; Title: ComponentType; Actions: ComponentType; commands: Record<string, { isAvailable(): boolean; run(): Promise<void> }> }

function registered(): Slots {
  const slots = { commands: {} } as Slots;
  registerChertogApp({
    slots: {
      navPanel: (slot: { component: ComponentType; experimental_headerTitle: ComponentType; headerContent: ComponentType }) => {
        slots.Page = slot.component; slots.Title = slot.experimental_headerTitle; slots.Actions = slot.headerContent;
      },
      experimental_appOverlay: (slot: { component: ComponentType }) => { slots.Overlay = slot.component; },
      homepageSection() {},
    },
    commands: { register: (command: { id: string; isAvailable(): boolean; run(): Promise<void> }) => { slots.commands[command.id] = command; } },
  } as unknown as PluginAppBuilder);
  return slots;
}

function ask() {
  const detail = { kind: "panel", ref: { provider: "terminals", params: {} }, accepted: false, outcome: null as string | null };
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
  return { accepted: detail.accepted, outcome: detail.outcome };
}

beforeEach(() => { host.values = undefined; host.threadReads = 0; host.loads = 0; });
afterEach(() => vi.clearAllMocks());

it("mounts nothing while the values are not delivered", () => {
  const slots = registered();
  const view = render(<><slots.Overlay /><slots.Page /><slots.Title /><slots.Actions /></>);
  expect(view.container.innerHTML).toBe("");
  expect(host.threadReads).toBe(0);
  expect(host.loads).toBe(0);
  expect(ask()).toEqual({ accepted: false, outcome: null });
});

it("with the switch off: no overlay, no listener, no thread subscription, no workspace load", () => {
  host.values = { tileSpace: false };
  const slots = registered();
  render(<slots.Overlay />);
  render(<slots.Page />);
  expect(host.threadReads).toBe(0);
  expect(host.loads).toBe(0);
  // Nobody answers, so Makosh Sidebar opens the thread as usual.
  expect(ask()).toEqual({ accepted: false, outcome: null });
});

it("with the switch off: the page is one line, the title is the name, there are no buttons, the commands do nothing", () => {
  host.values = { tileSpace: false };
  const slots = registered();
  const page = render(<slots.Page />);
  expect(page.container.textContent).toContain("Тайловое пространство выключено в настройках Чертога");
  expect(page.container.querySelectorAll("button")).toHaveLength(0);
  const title = render(<slots.Title />);
  expect(title.container.textContent).toBe("Чертог");
  expect(title.container.querySelectorAll("button")).toHaveLength(0);
  const actions = render(<slots.Actions />);
  expect(actions.container.querySelectorAll("button")).toHaveLength(0);
  expect(actions.container.textContent).toBe("");
  for (const command of Object.values(slots.commands)) expect(command.isAvailable()).toBe(false);
});

it("switching off and on again returns the saved layout, and the open request is answered again", async () => {
  host.values = { tileSpace: true };
  const slots = registered();
  const overlay = render(<slots.Overlay />);
  const page = render(<slots.Page />);
  await waitFor(() => expect(document.querySelector("[data-chertog-surface-host]")).not.toBeNull());
  expect(ask()).toMatchObject({ accepted: true, outcome: "opened" });
  await waitFor(() => expect(store.saves.length).toBeGreaterThan(0));
  const saved = store.saves.at(-1)!.document;
  const panels = Object.values(saved.panels).map((panel) => panel.ref);

  host.values = { tileSpace: false };
  overlay.rerender(<slots.Overlay />);
  page.rerender(<slots.Page />);
  expect(document.querySelector("[data-chertog-surface-host]")).toBeNull();
  expect(screen.getByText(/выключено в настройках Чертога/)).toBeTruthy();
  expect(ask()).toEqual({ accepted: false, outcome: null });
  for (const command of Object.values(slots.commands)) {
    expect(command.isAvailable()).toBe(false);
    await expect(command.run()).resolves.toBeUndefined();
  }

  host.values = { tileSpace: true };
  overlay.rerender(<slots.Overlay />);
  page.rerender(<slots.Page />);
  await waitFor(() => expect(document.querySelector("[data-chertog-surface-host]")).not.toBeNull());
  expect(ask()).toMatchObject({ accepted: true });
  // The stored layout was not touched by the switch and is what the page draws now.
  expect(store.saves.at(-1)!.document.panels).toEqual(saved.panels);
  expect(Object.values(store.saves.at(-1)!.document.panels).map((panel) => panel.ref)).toEqual(expect.arrayContaining(panels));
});
