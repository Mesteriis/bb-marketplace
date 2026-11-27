// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Entry, OperationJob } from "./src/core/model.ts";
import type { UiState } from "./src/core/wire/rpc.ts";

const host = vi.hoisted(() => ({
  call: vi.fn(),
  navigate: { experimental_openFilePreview: vi.fn() },
  sdk: { environments: { get: vi.fn() }, files: { read: vi.fn() } },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (register: unknown) => register,
  useRpc: () => host,
  useRealtime: () => {},
  useBbNavigate: () => host.navigate,
  useSdk: () => host.sdk,
  experimental_Icon: () => null,
}));

import app from "./app.tsx";
import type { ComponentType } from "react";

const endpoint = { id: "host:fixture", provider: "local", label: "Стенд", machine: "Стенд", hostId: "fixture", readOnly: false, caseSensitive: true };
const path = (t: string) => ({ segments: [{ t }] });
const entry = (t: string, kind: Entry["kind"] = "file"): Entry => ({
  name: { t }, kind, size: "16", mtimeNs: null, mtimePrecision: "unknown", mode: null, linkTarget: null, hidden: false,
});
let saved: UiState | null;
let files: Entry[];
let threadStates: Map<string, UiState>;
let jobs: unknown[];

beforeEach(() => {
  files = [entry("вложенный", "dir"), entry("пример.txt")];
  jobs = [];
  threadStates = new Map();
  host.navigate.experimental_openFilePreview.mockClear().mockReturnValue(true);
  host.sdk.environments.get.mockResolvedValue({ hostId: "fixture", path: "/окружение" });
  host.sdk.files.read.mockImplementation(async ({ path }) => ({ content: path.startsWith("/данные") ? "исходный текст" : "текст назначения", contentEncoding: "utf8", sizeBytes: 20 }));
  const tab = { endpoint: "host:fixture", sort: { by: "name", direction: "asc" } as const, selection: [], filter: "", scrollTop: 0 };
  saved = { left: { activeTab: 0, tabs: [{ ...tab, path: path("данные") }] },
    right: { activeTab: 0, tabs: [{ ...tab, path: path("приёмник") }] }, activePane: "left", layout: "horizontal", split: 0.5 };
  host.call.mockImplementation(async (method, input) => {
    switch (method) {
      case "ui_state_get": return { state: input.threadId ? threadStates.get(input.threadId) ?? null : saved };
      case "ui_state_set":
        if (input.threadId) threadStates.set(input.threadId, structuredClone(input.state));
        else saved = structuredClone(input.state);
        return {};
      case "endpoint_home": return { path: path("дом") };
      case "entry_stat": return entry("пример.txt");
      case "job_decide": jobs = jobs.filter((job) => (job as OperationJob).id !== input.jobId); return {};
      case "endpoints_list": return { endpoints: [endpoint] };
      case "job_list": return { jobs };
      case "dir_list": {
        const start = Number(input.cursor ?? 0);
        return { entries: files.slice(start, start + 1000), cursor: start + 1000 < files.length ? String(start + 1000) : null };
      }
      case "plan_create": return {
        id: "eea413e3-f6a4-4590-97af-9fdf6701ecb5", digest: "1".repeat(64),
        kind: "copy", createdAt: "2026-11-27T10:00:00Z", initiator: { kind: "owner" },
        sourceEndpoint: endpoint.id, targetEndpoint: endpoint.id, targetDir: { endpoint: endpoint.id, path: path("приёмник") },
        items: [{ source: input.sources[0], target: { endpoint: endpoint.id, path: { segments: [{ t: "приёмник" }, { t: "пример.txt" }] } },
          kind: "file", fingerprint: { size: "16", mtimeNs: null }, expectTarget: "absent" }],
        conflictPolicy: "ask", route: "same-endpoint", verify: "size", totalBytes: "16",
      };
      default: throw new Error("Unexpected RPC " + method);
    }
  });
});
afterEach(cleanup);

function mount(thread = false) {
  let Page!: ComponentType;
  const register = app as unknown as (api: unknown) => void;
  register({ slots: {
    navPanel: ({ component }: { component: ComponentType }) => { Page = component; },
    experimental_tab: ({ component: Tab }: { component: ComponentType<{ threadId: string; environment: { id: string } }> }) => {
      if (thread) Page = () => <Tab threadId="проверка-треда" environment={{ id: "env-fixture" }} />;
    },
  } });
  return render(<><input aria-label="Чужое поле" /><Page /></>);
}
function grid(name = "Левая панель") {
  return screen.getByRole("grid", { name });
}
async function leftFile(name = "пример.txt") {
  await screen.findByRole("grid", { name: "Левая панель" });
  return within(grid()).findByRole("row", { name: new RegExp(name) });
}

test("F5 opens a copy plan from the grid and leaves foreign and address inputs alone", async () => {
  mount();
  fireEvent.click(await leftFile());
  expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Чужое поле" }), { key: "F5" })).toBe(true);
  expect(fireEvent.keyDown(within(grid().parentElement!).getByRole("textbox", { name: "Путь" }), { key: "F5" })).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fireEvent.keyDown(grid(), { key: "F5" })).toBe(false);
  const plan = await screen.findByRole("dialog", { name: "Копирование" });
  expect(within(plan).getByText("/приёмник")).toBeDefined();
});

test("Tab switches the focused grid and remount restores path and selection during debounce", async () => {
  const first = mount();
  fireEvent.doubleClick(await leftFile("вложенный"));
  fireEvent.click(await leftFile());
  fireEvent.keyDown(grid(), { key: "Insert" });
  expect((await leftFile()).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(grid(), { key: "Tab" });
  expect(document.activeElement).toBe(grid("Правая панель"));
  first.unmount();
  mount();
  expect((await leftFile()).getAttribute("aria-selected")).toBe("true");
  expect((within(grid().parentElement!).getByRole("textbox", { name: "Путь" }) as HTMLInputElement).value).toBe("/данные/вложенный");
});

test("loads all 10000 entries but limits the rendered rows", async () => {
  files = Array.from({ length: 10_000 }, (_, index) => entry("файл-" + String(index).padStart(5, "0")));
  mount();
  await waitFor(() => expect(grid().getAttribute("aria-rowcount")).toBe("10002"));
  expect(within(grid()).getAllByRole("row").length).toBeLessThanOrEqual(200);
  fireEvent.keyDown(grid(), { key: "End" });
  expect(await within(grid()).findByTitle("файл-09999")).toBeDefined();
});

test("a damaged job displays its date and id without operation, path or actions", async () => {
  const id = "36d0ecc8-504d-472b-a245-ea478c32a20d";
  jobs = [
    { id, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00Z" },
    { id: "28b229d8-e205-4b4f-a96f-35d380f5b086", state: "unknown", error: { code: "internal", message: "Stored job is damaged" },
      plan: { kind: "delete", targetDir: "/закрытый-путь" }, createdAt: "2026-11-27T10:00:00Z" },
  ];
  mount();
  const cards = await screen.findAllByRole("article", { name: "Задание повреждено, план недоступен" });
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain(id);
  for (const card of cards) {
    expect(card.querySelector("time")?.dateTime).toBe("2026-11-27T10:00:00Z");
    expect(card.textContent).not.toMatch(/Удаление|Удалить|закрытый-путь/);
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  }
});


test("scans through an empty unknown job page without altering the filter", async () => {
  const initial = host.call.getMockImplementation()!;
  host.call.mockImplementation((method, input) => {
    if (method !== "job_list") return initial(method, input);
    if (input.states === undefined) return Promise.resolve({ jobs: [] });
    expect(input.states).toEqual(["unknown"]);
    if (input.cursor === undefined) return Promise.resolve({ jobs: [], nextCursor: "201" });
    expect(input.cursor).toBe("201");
    return Promise.resolve({ jobs: [{
      id: "36d0ecc8-504d-472b-a245-ea478c32a20d", state: "unknown", damaged: true,
      message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00Z",
    }] });
  });
  mount();
  const card = await screen.findByRole("article", { name: "Задание повреждено, план недоступен" });
  expect(card.textContent).toContain("36d0ecc8-504d-472b-a245-ea478c32a20d");
});


test.each([["F5", "Копировать"], ["F8", "Удалить"]])("%s requires a selected entry or an explicitly positioned cursor", async (key, action) => {
  mount();
  await leftFile();
  host.call.mockClear();
  const command = () => screen.getByRole("button", { name: new RegExp(action) }) as HTMLButtonElement;
  expect(command().disabled).toBe(true);
  fireEvent.keyDown(grid(), { key });
  fireEvent.click(await leftFile());
  const filter = within(grid().parentElement!).getByRole("searchbox", { name: "Фильтр" });
  fireEvent.change(filter, { target: { value: "вложенный" } });
  const replacement = await leftFile("вложенный");
  expect(grid().getAttribute("aria-activedescendant")).toBe(replacement.id);
  expect(command().disabled).toBe(true);
  fireEvent.keyDown(grid(), { key });
  expect(host.call.mock.calls.filter(([method]) => method === "plan_create")).toEqual([]);
  fireEvent.click(replacement);
  expect(command().disabled).toBe(false);
});

function conflictFixture(id: string, conflictId: string, filename: string): OperationJob {
  const source = { endpoint: endpoint.id, path: { segments: [{ t: "данные" }, { t: filename }] } };
  const target = { endpoint: endpoint.id, path: { segments: [{ t: "приёмник" }, { t: filename }] } };
  const before = { size: "16", mtimeNs: "1000000000" };
  const after = { size: "24", mtimeNs: "2000000000" };
  return {
    id, state: "awaiting_decision", currentItem: 0, awaitsOwner: false, error: null,
    createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:00:00Z",
    items: [{ outcome: "pending", error: null }], progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "16" },
    pendingConflict: { id: conflictId, jobId: id, itemIndex: 0, reason: "exists", source: after, target: before },
    plan: {
      id, digest: "1".repeat(64), kind: "copy", createdAt: "2026-11-27T10:00:00Z", initiator: { kind: "owner" },
      sourceEndpoint: endpoint.id, targetEndpoint: endpoint.id, targetDir: { endpoint: endpoint.id, path: path("приёмник") },
      items: [{ source, target, kind: "file", fingerprint: after, expectTarget: before }],
      conflictPolicy: "ask", route: "same-endpoint", verify: "size", totalBytes: "16",
    },
  };
}
const firstConflict = () => conflictFixture("a49575e8-a22b-4fa8-a4e3-cd96ab734325", "74db46a5-bb94-4259-af37-2dd4547c1fb6", "пример.txt");
const nextConflict = () => conflictFixture("522b5f7f-3f4a-4ace-afb6-e2b57bc2f5c4", "70443f80-c1f2-473a-910e-e4a113208d3d", "второй.txt");

test("closing content comparison or cancellation confirmation restores the same checked conflict", async () => {
  jobs = [firstConflict()];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const original = await screen.findByRole("dialog", { name: /уже есть в назначении/ });
  fireEvent.click(within(original).getByRole("checkbox"));
  fireEvent.click(within(original).getByRole("button", { name: "Сравнить содержимое" }));
  const comparison = await screen.findByRole("dialog", { name: "Сравнить содержимое" });
  expect(within(comparison).getByText("исходный текст")).toBeDefined();
  fireEvent.keyDown(comparison, { key: "Escape" });
  let restored = await screen.findByRole("dialog", { name: /уже есть в назначении/ });
  expect(within(restored).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(restored).getByRole("button", { name: "Отменить задание" }));
  const confirmation = await screen.findByRole("dialog", { name: "Отменить задание" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Закрыть" }));
  restored = await screen.findByRole("dialog", { name: /уже есть в назначении/ });
  expect(within(restored).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
});

test.each([true, false])("returns keyboard focus after conflict resolution (next conflict: %s)", async (hasNext) => {
  jobs = hasNext ? [firstConflict(), nextConflict()] : [firstConflict()];
  mount();
  fireEvent.click(await leftFile());
  const [button] = await screen.findAllByRole("button", { name: "Сравнить и решить" });
  button.focus();
  fireEvent.click(button);
  const conflict = await screen.findByRole("dialog", { name: /уже есть в назначении/ });
  fireEvent.keyDown(conflict, { key: "s" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => {
    const focused = hasNext ? screen.getByRole("button", { name: "Сравнить и решить" }) : grid();
    expect(document.activeElement).toBe(focused);
  });
});

test("thread reopening restores its own path, tabs and selection instead of applying the environment twice", async () => {
  host.sdk.environments.get.mockClear();
  const view = mount(true);
  await leftFile();
  const pane = () => within(grid().parentElement!);
  expect((pane().getByRole("textbox", { name: "Путь" }) as HTMLInputElement).value).toBe("/окружение");
  fireEvent.click(pane().getByRole("button", { name: "Новая вкладка" }));
  fireEvent.doubleClick(await leftFile("вложенный"));
  fireEvent.click(await leftFile());
  fireEvent.keyDown(grid(), { key: "Insert" });
  view.unmount();
  mount(true);
  expect((await leftFile()).getAttribute("aria-selected")).toBe("true");
  expect((pane().getByRole("textbox", { name: "Путь" }) as HTMLInputElement).value).toBe("/окружение/вложенный");
  expect(pane().getByRole("button", { name: "окружение" })).toBeDefined();
  expect(host.sdk.environments.get).toHaveBeenCalledTimes(1);
  expect(saved?.left.tabs[0]?.path).toEqual({ segments: [{ t: "данные" }] });
});

test("the desktop inspector collapse setting survives remount", async () => {
  const view = mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Свернуть очередь" }));
  view.unmount();
  mount();
  await leftFile();
  expect(screen.getByRole("button", { name: "Очередь" }).getAttribute("aria-expanded")).toBe("false");
  expect(saved?.inspectorCollapsed).toBe(true);
});

test("when a selected file vanishes the closest remaining row is visible and F8 leaves it alone", async () => {
  files = [entry("аа.txt"), entry("бб.txt"), entry("вв.txt")];
  mount();
  fireEvent.click(await leftFile("бб.txt"));
  fireEvent.keyDown(grid(), { key: "Insert" });
  expect((await leftFile("бб.txt")).getAttribute("aria-selected")).toBe("true");
  files = [entry("аа.txt"), entry("вв.txt")];
  fireEvent.click(within(grid().parentElement!).getByRole("button", { name: "Обновить" }));
  const next = await leftFile("вв.txt");
  await waitFor(() => expect(grid().getAttribute("aria-activedescendant")).toBe(next.id));
  expect((screen.getByRole("button", { name: "Удалить (F8)" }) as HTMLButtonElement).disabled).toBe(true);
  host.call.mockClear();
  fireEvent.keyDown(grid(), { key: "F8" });
  expect(host.call.mock.calls.filter(([method]) => method === "plan_create")).toEqual([]);
});

test("filtering prefers the nearest former neighbor over a row at the same new index", async () => {
  files = [entry("01.txt"), entry("02-оставить.txt"), entry("03.txt"), entry("04-оставить.txt"),
    entry("05-оставить.txt"), entry("06-оставить.txt")];
  mount();
  fireEvent.click(await leftFile("03.txt"));
  const filter = within(grid().parentElement!).getByRole("searchbox", { name: "Фильтр" });
  fireEvent.change(filter, { target: { value: "оставить" } });
  const neighbor = await leftFile("04-оставить.txt");
  expect(grid().getAttribute("aria-activedescendant")).toBe(neighbor.id);
});


test.each([true, false])("keyboard activation of an inline skip restores focus (next: %s)", async (hasNext) => {
  jobs = hasNext ? [firstConflict(), nextConflict()] : [firstConflict()];
  mount();
  await leftFile();
  const [skip] = await screen.findAllByRole("button", { name: "Пропустить" });
  skip.focus();
  fireEvent.click(skip, { detail: 0 });
  await waitFor(() => {
    const next = hasNext ? screen.getByRole("button", { name: "Сравнить и решить" }) : grid();
    expect(document.activeElement).toBe(next);
  });
});

test("resolving the bottom conflict wraps focus to the first remaining conflict", async () => {
  jobs = [firstConflict(), nextConflict()];
  mount();
  const [, bottom] = await screen.findAllByRole("button", { name: "Сравнить и решить" });
  bottom.focus();
  fireEvent.click(bottom);
  const dialog = await screen.findByRole("dialog", { name: "второй.txt уже есть в назначении" });
  fireEvent.keyDown(dialog, { key: "s" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Сравнить и решить" })));
});

test("keyboard activation of the queue moves focus to its collapse button", async () => {
  saved = { ...saved!, inspectorCollapsed: true };
  mount();
  await leftFile();
  const toggle = screen.getByRole("button", { name: "Очередь" });
  toggle.focus();
  fireEvent.click(toggle, { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Свернуть очередь" })));
});

test("entering a directory places the cursor on the parent and file shortcuts follow an explicit file cursor", async () => {
  mount();
  fireEvent.doubleClick(await leftFile("вложенный"));
  await leftFile();
  const parent = within(grid()).getByText("..", { exact: true }).closest("[role=row]")!;
  expect(grid().getAttribute("aria-activedescendant")).toBe(parent.id);
  expect(parent.getAttribute("data-cursor")).toBe("true");
  for (const [key, label] of [["F5", "Копировать"], ["F6", "Переместить"], ["F8", "Удалить"]]) {
    const action = screen.getByRole("button", { name: new RegExp(label) }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe(label + " (" + key + ")");
    fireEvent.keyDown(grid(), { key });
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(await leftFile());
  fireEvent.keyDown(grid(), { key: "F3" });
  fireEvent.keyDown(grid(), { key: "F4" });
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledTimes(2);
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledWith({
    target: { kind: "host", hostId: "fixture", path: "/данные/вложенный/пример.txt" }, location: null,
  });
  fireEvent.keyDown(grid(), { key: "F6", shiftKey: true });
  expect(await screen.findByRole("dialog", { name: "Переименовать" })).toBeDefined();
});

test("returning from comparison re-reads the job and reports a conflict resolved elsewhere", async () => {
  jobs = [firstConflict()];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const conflict = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  fireEvent.click(within(conflict).getByRole("button", { name: "Сравнить содержимое" }));
  const comparison = await screen.findByRole("dialog", { name: "Сравнить содержимое" });
  jobs = [];
  fireEvent.keyDown(comparison, { key: "Escape" });
  expect(await screen.findByText("Конфликт больше не ожидает решения")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each([
  ["Сравнить содержимое", "Escape"],
  ["Сравнить содержимое", "Закрыть"],
  ["Отменить задание", "Escape"],
  ["Отменить задание", "Закрыть"],
])("a failed job read exits %s via %s and offers a read-only retry", async (title, dismissal) => {
  jobs = [firstConflict()];
  mount();
  const open = await screen.findByRole("button", { name: "Сравнить и решить" });
  open.focus();
  fireEvent.click(open);
  const conflict = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  fireEvent.click(within(conflict).getByRole("checkbox"));
  fireEvent.click(within(conflict).getByRole("button", { name: title }));
  const nested = await screen.findByRole("dialog", { name: title });
  const call = host.call.getMockImplementation()!;
  let fail = true;
  host.call.mockImplementation(async (method, input) => {
    if (fail && method === "job_list") throw Object.assign(new Error("fixture timeout"), { code: "timeout" });
    return call(method, input);
  });
  host.call.mockClear();
  if (dismissal === "Escape") fireEvent.keyDown(nested, { key: "Escape" });
  else fireEvent.click(within(nested).getByRole("button", { name: "Закрыть" }));
  const retry = await screen.findByRole("button", { name: "Проверить снова" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(open);
  expect(host.call.mock.calls.filter(([method]) => method === "job_decide" || method === "job_cancel")).toEqual([]);
  fail = false;
  fireEvent.click(retry);
  const restored = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  expect(within(restored).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
});

test("returning to a conflict checks its ID past 200 records and follows an empty page", async () => {
  const original = firstConflict();
  jobs = [original];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const conflict = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  fireEvent.click(within(conflict).getByRole("button", { name: "Сравнить содержимое" }));
  const content = await screen.findByRole("dialog", { name: "Сравнить содержимое" });
  const call = host.call.getMockImplementation()!;
  const other = nextConflict();
  host.call.mockImplementation(async (method, input) => {
    if (method !== "job_list" || input.states?.length === 1 && input.states[0] === "unknown" || !input.states) return call(method, input);
    if (!input.states.includes("unknown")) return { jobs: [] };
    if (input.cursor === undefined) return {
      jobs: Array.from({ length: 200 }, (_, index) => ({ ...other, id: "other-" + index })), nextCursor: "401",
    };
    if (input.cursor === "401") return { jobs: [], nextCursor: "201" };
    expect(input.cursor).toBe("201");
    return { jobs: [original], nextCursor: "1" };
  });
  fireEvent.keyDown(content, { key: "Escape" });
  expect(await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" })).toBeDefined();
  expect(screen.queryByText("Конфликт больше не ожидает решения")).toBeNull();
});

test("the next conflict scrolls into view before receiving focus after inline skip", async () => {
  jobs = [firstConflict(), nextConflict()];
  mount();
  const [, next] = await screen.findAllByRole("button", { name: "Сравнить и решить" });
  const [skip] = screen.getAllByRole("button", { name: "Пропустить" });
  const scroll = vi.fn(() => expect(document.activeElement).not.toBe(next));
  Object.defineProperty(next, "scrollIntoView", { value: scroll });
  skip.focus();
  fireEvent.click(skip, { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(next));
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
});

test("a same-server SFTP conflict identifies both distinct profiles", async () => {
  const incoming = "sftp:5c256831-3f21-4724-b7eb-1837a3d8f755";
  const outgoing = "sftp:ee4213b1-ca02-4d18-9588-438ef9c9113e";
  const original = firstConflict();
  const [{ source, target, ...item }] = original.plan.items;
  jobs = [{ ...original, plan: { ...original.plan, sourceEndpoint: incoming, targetEndpoint: outgoing,
    targetDir: { endpoint: outgoing, path: path("приёмник") },
    items: [{ ...item, source: { ...source!, endpoint: incoming }, target: { ...target!, endpoint: outgoing } }],
  } }];
  const call = host.call.getMockImplementation()!;
  const sftp = { provider: "sftp", machine: "fixture.test:22", hostId: null, readOnly: false, caseSensitive: true, consent: "granted" };
  host.call.mockImplementation(async (method, input) => method === "endpoints_list"
    ? { endpoints: [endpoint, { ...sftp, id: incoming, label: "Входящие" }, { ...sftp, id: outgoing, label: "Публикация" }] } : call(method, input));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const dialog = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  expect(within(within(dialog).getByRole("region", { name: "Копируемый" })).getByText("fixture.test:22 · Входящие")).toBeDefined();
  expect(within(within(dialog).getByRole("region", { name: "В назначении" })).getByText("fixture.test:22 · Публикация")).toBeDefined();
});

test("the thread copy button includes its visible wording and shortcut in its accessible name", async () => {
  mount(true);
  await leftFile();
  expect(screen.getByRole("button", { name: "Копировать в… (F5)" }).textContent).toContain("Копировать в…");
});

test("resolving a conflict clears its obsolete retry prompt", async () => {
  jobs = [firstConflict()];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const dialog = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Сравнить содержимое" }));
  const nested = await screen.findByRole("dialog", { name: "Сравнить содержимое" });
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementationOnce(async () => { throw new Error("fixture timeout"); });
  fireEvent.keyDown(nested, { key: "Escape" });
  await screen.findByRole("button", { name: "Проверить снова" });
  host.call.mockImplementation(call);
  fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Сравнить и решить" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Проверить снова" })).toBeNull();
});
