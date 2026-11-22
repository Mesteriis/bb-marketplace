import { isValidElement, type ComponentProps } from "react";
import type { EntryCard } from "../../../src/ui/panels/EntryCard.tsx";
import { PanelRegistry } from "../../../src/core/panels/registry.ts";
import { FakeClock, FakeDiagnostics, FakeProvider, SequentialIds } from "../../core/panels/fakes.ts";
import { expect, it, vi } from "vitest";
import { cardActions, createCardSource, type CardHost } from "../../../src/adapters/bb/app/card-source.ts";

function host() {
  return {
    navigate: {
      experimental_openTerminal: vi.fn(async () => false), experimental_openFilePreview: vi.fn(() => true),
      experimental_openFileExternally: vi.fn(() => true), toThread: vi.fn(),
    },
    plugins: { list: vi.fn(async () => ({ plugins: [] })) },
    threadTabs: { get: vi.fn(async () => ({ tabs: [] })) },
    desktop: {
      listInstances: vi.fn(async () => ({ instances: [{ hostId: "h", instanceId: "i", generation: "g", label: "Laptop" }] })),
      listTabs: vi.fn(async () => ({ tabs: [{ threadId: "t", tabId: "b", title: "Preview" }, { threadId: "other", tabId: "b", title: "Private" }] })),
      revealTab: vi.fn(async () => ({ ok: true as const })),
    },
  } satisfies CardHost;
}

it.each([
  ["telegram", "/plugins/makosh-telegram/telegram"], ["zoom", "/plugins/makosh-zoom/zoom"],
  ["remote-ssh", "/plugins/makosh-remote-hub/ssh"], ["remote-rdp", "/plugins/makosh-remote-hub/ssh"],
  ["remote-vnc", "/plugins/makosh-remote-hub/ssh"], ["terminals", "/plugins/terminals/terminals"],
] as const)("exposes a fixed route for %s", (provider, url) => {
  expect(cardActions(provider, { provider, params: {} }, host())[0].href).toBe(url);
});

it("restores and releases a terminal card without touching the terminal; an explicit refused open explains why", async () => {
  const bb = host();
  const ref = { provider: "bb-terminal", params: { terminalId: "tty" } };
  const source = createCardSource("bb-terminal", bb);
  expect(source.canEndSession).toBe(false);
  expect(source.provider.multipleViews).toBe(false);
  expect(source.provider.endsSessionOnLastClose(ref)).toBe(false);
  expect(await source.provider.open({ instanceId: "p", ref })).toEqual({ status: "entry" });
  source.render(ref, "p");
  await source.provider.release("p");
  expect(bb.navigate.experimental_openTerminal).toHaveBeenCalledTimes(0);
  await expect(cardActions("bb-terminal", ref, bb)[0].run()).rejects.toThrow("Терминал завершён или панель терминалов недоступна.");
  expect(bb.navigate.experimental_openTerminal.mock.calls).toEqual([[{ terminalId: "tty" }]]);
});

it("opens only the chosen file action and thread", async () => {
  const bb = host();
  const file = { kind: "workspace", environmentId: "e", path: "a%20b.md" };
  const actions = cardActions("bb-editor", { provider: "bb-editor", params: file }, bb);
  await actions[0].run();
  expect(bb.navigate.experimental_openFileExternally).toHaveBeenCalledTimes(0);
  await actions[1].run();
  const options = { target: { kind: "workspace", environmentId: "e", path: "a b.md" }, location: null };
  expect(bb.navigate.experimental_openFilePreview.mock.calls).toEqual([[options]]);
  expect(bb.navigate.experimental_openFileExternally.mock.calls).toEqual([[options]]);
  await cardActions("app-preview", { provider: "app-preview", params: { threadId: "t" } }, bb)[0].run();
  expect(bb.navigate.toThread.mock.calls).toEqual([["t"]]);
});

it("enumerates tabs in the selected Desktop, revealing only the explicitly selected instance and generation", async () => {
  const bb = host();
  const actions = cardActions("bb-desktop-tab", { provider: "bb-desktop-tab", params: { hostId: "h", threadId: "t" } }, bb);
  expect(bb.desktop.listInstances).toHaveBeenCalledTimes(0);
  const instances = await actions[0].run();
  if (typeof instances === "string") throw Error("Missing instances");
  expect(instances.map(i => i.label)).toEqual(["Laptop · i"]);
  expect(bb.desktop.listTabs).toHaveBeenCalledTimes(0);
  const options = await instances[0].run();
  if (typeof options === "string") throw Error("Missing tab choices");
  expect(options.map(o => o.label)).toEqual(["Preview · b"]);
  expect(bb.desktop.listInstances.mock.calls).toEqual([[{ hostId: "h" }]]);
  expect(bb.desktop.listTabs.mock.calls).toEqual([[{ hostId: "h", instanceId: "i", generation: "g", threadId: "t" }]]);
  expect(bb.desktop.revealTab).toHaveBeenCalledTimes(0);
  await options[0].run();
  expect(bb.desktop.revealTab.mock.calls).toEqual([[{ hostId: "h", instanceId: "i", generation: "g", threadId: "t", tabId: "b" }]]);
  expect(bb.navigate.toThread).toHaveBeenCalledTimes(0);
});


it("refuses a missing App Preview tab even if Desktop has a tab with the same ID", async () => {
  const bb = host();
  const actions = cardActions("app-preview", { provider: "app-preview", params: { threadId: "t", tabId: "b" } }, bb);
  await expect(actions[0].run()).rejects.toThrow("Вкладка предпросмотра в треде уже закрыта.");
  expect(bb.navigate.toThread).toHaveBeenCalledTimes(0);
  expect(bb.desktop.listInstances).toHaveBeenCalledTimes(0);
});

it.each([
  { handled: true, live: true, confirmed: false, prompts: 0, reloads: 0 },
  { handled: false, live: true, confirmed: false, prompts: 1, reloads: 0 },
  { handled: false, live: true, confirmed: true, prompts: 1, reloads: 1 },
  { handled: false, live: false, confirmed: false, prompts: 0, reloads: 1 },
])("guards document replacement ($handled, $live, $confirmed)", async ({handled, live, confirmed, prompts, reloads}) => {
  const routes = { inDocument: vi.fn(() => handled), confirm: vi.fn(() => confirmed), reload: vi.fn() };
  const ref = { provider: "terminals", params: {} };
  await cardActions("terminals", ref, { ...host(), routes }, () => live)[0].run();
  expect(routes.inDocument.mock.calls).toEqual([["/plugins/terminals/terminals"]]);
  expect(routes.confirm.mock.calls).toEqual(prompts ? [["Переход перезагрузит Чертог, живые панели закроются"]] : []);
  expect(routes.reload.mock.calls).toEqual(reloads ? [["/plugins/terminals/terminals"]] : []);
});

it("checks the current registry on each fallback, including parked live panels", async () => {
  const registry = new PanelRegistry({ clock: new FakeClock(1), ids: new SequentialIds(), diagnostics: new FakeDiagnostics() });
  const routes = { inDocument: () => false, confirm: vi.fn(() => false), reload: vi.fn() };
  const source = createCardSource("terminals", { ...host(), routes });
  source.connect?.(registry);
  const ref = { provider: "terminals", params: {} };
  registry.registerProvider(source.provider);
  const entry = registry.open(ref);
  if (!entry.ok) throw Error(entry.reason);
  await entry.settled;
  const rendered = source.render(ref, entry.instance.instanceId);
  if (!isValidElement<ComponentProps<typeof EntryCard>>(rendered)) throw Error("Missing entry card");
  const open = rendered.props.actions[0].run;
  await open();
  expect(routes.confirm).toHaveBeenCalledTimes(0);
  expect(routes.reload.mock.calls).toEqual([["/plugins/terminals/terminals"]]);
  registry.registerProvider(new FakeProvider("fixture-frame", []));
  const live = registry.open({ provider: "fixture-frame", params: {} });
  if (!live.ok) throw Error(live.reason);
  await live.settled;
  registry.removeFromLayout(live.instance.instanceId);
  expect(await open()).toBe("Переход отменён.");
  expect(routes.confirm).toHaveBeenCalledTimes(1);
  expect(routes.reload).toHaveBeenCalledTimes(1);
});
