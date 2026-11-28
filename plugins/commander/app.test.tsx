// @vitest-environment jsdom
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localStand, pauseAfterWrite, waitForJob, waitForPart } from "./tests/s19b-fixture.ts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Entry, OperationJob } from "./src/core/model.ts";
import { CommanderError } from "./src/core/errors.ts";
import { parsePosix } from "./src/core/path.ts";
import { MAX_VIEW_BYTES, readForView, replyFor, type WireView } from "./src/core/preview.ts";
import { FakeProvider } from "./src/core/testing/fake-provider.ts";
import { ScanJobView, type UiState } from "./src/core/wire/rpc.ts";

const host = vi.hoisted(() => ({
  call: vi.fn(),
  navigate: { experimental_openFilePreview: vi.fn() },
  sdk: { environments: { get: vi.fn() }, files: { read: vi.fn() } },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (register: unknown) => register,
  useRpc: () => host,
  experimental_usePluginId: () => "commander:fixture",
  useRealtime: () => {},
  useBbNavigate: () => host.navigate,
  useSdk: () => host.sdk,
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));

// Counts how many times the panel merges arriving pages into its sorted rows.
const merges = vi.hoisted(() => ({ count: 0 }));
vi.mock("./src/ui/model.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./src/ui/model.ts")>();
  return { ...original, mergeVisible: (...args: Parameters<typeof original.mergeVisible>) => { merges.count++; return original.mergeVisible(...args); } };
});

import app from "./app.tsx";
import { ru } from "./src/ui/strings.ts";
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
      // S16: the editor opens a host-worker copy, with an explicit opener.
      case "edit_open": return {
        sessionId: "65fb3d47-752e-48d8-b4c4-7112e2e4f460", base: { size: "16", mtimeNs: null },
        opener: {
          id: "commander-private-editor", hostId: "fixture",
          path: "/worker/commander-edits/65fb3d47-752e-48d8-b4c4-7112e2e4f460/revision-0",
        },
      };
      case "job_decide": jobs = jobs.filter((job) => (job as OperationJob).id !== input.jobId); return {};
      case "endpoints_list": return { endpoints: [endpoint] };
      case "job_list": return { jobs };
      case "job_get": return jobs.find((job) => (job as OperationJob).id === input.jobId) ?? null;
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
    // S16
    fileOpener: () => {},
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

test("shows the first page of a long directory at once and keeps operations off until the last page arrives", async () => {
  files = Array.from({ length: 2500 }, (_, index) => entry("файл-" + String(index).padStart(4, "0")));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementation(async (method, input) => {
    if (method === "dir_list" && input.ref.path.segments.at(-1)?.t === "данные" && input.cursor !== null) await gate;
    return call(method, input);
  });

  mount();
  fireEvent.click(await leftFile("файл-0000"));
  const left = grid();
  expect(left.getAttribute("aria-busy")).toBe("true");
  // The pages after the first are still outstanding, so a plan would miss entries: F5 is not taken.
  fireEvent.keyDown(left, { key: "F5" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("dialog", { name: "Копирование" })).toBeNull();

  release();
  await waitFor(() => expect(grid().getAttribute("aria-busy")).toBe("false"));
  expect(Number(grid().getAttribute("aria-rowcount"))).toBeGreaterThanOrEqual(2500);
  fireEvent.click(await leftFile("файл-0000"));
  fireEvent.keyDown(grid(), { key: "F5" });
  expect(await screen.findByRole("dialog", { name: "Копирование" })).toBeDefined();
});

test("keeps the cursor and the view on the same entry while later pages merge in above it, and reports progress", async () => {
  // Page 1 holds the names that sort last, so every later page lands above the entries already shown.
  files = Array.from({ length: 3000 }, (_, index) => entry("файл-" + String(2999 - index).padStart(4, "0")));
  const gates = [Promise.resolve(), Promise.resolve()] as Promise<void>[];
  const releases: (() => void)[] = [];
  gates[0] = new Promise<void>((resolve) => releases.push(resolve));
  gates[1] = new Promise<void>((resolve) => releases.push(resolve));
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementation(async (method, input) => {
    if (method === "dir_list" && input.ref.path.segments.at(-1)?.t === "данные" && input.cursor !== null) {
      await gates[input.cursor === "1000" ? 0 : 1];
    }
    return call(method, input);
  });

  mount();
  const row = await leftFile("файл-2000");
  fireEvent.click(row);
  const cursorName = () => within(grid()).getByRole("row", { selected: false, name: /файл-2000/ }).getAttribute("data-cursor");
  expect(cursorName()).toBe("true");
  expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("Загружено 1000 записей…"))).toBe(true);
  const topBefore = grid().scrollTop;

  releases[0]!();
  await waitFor(() => expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("Загружено 2000 записей…"))).toBe(true));
  expect(cursorName()).toBe("true");
  // 1000 entries now sort above the cursor: the view moved down by their height, so the cursor row did not jump.
  expect(grid().scrollTop).toBeGreaterThan(topBefore);

  releases[1]!();
  await waitFor(() => expect(grid().getAttribute("aria-busy")).toBe("false"));
  expect(cursorName()).toBe("true");
  expect(screen.queryByText(/Загружено \d+ записей/)).toBeNull();
  expect(Number(grid().getAttribute("aria-rowcount"))).toBeGreaterThanOrEqual(3000);
});

test("hands 100 arriving pages to the sorted rows in at most 12 batches, with the cursor and order as for one full load", async () => {
  // Fake clock: every page arrives after its own 1 ms timer, so the page rate does not depend on machine load.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // 100 pages of 20 entries; later pages sort above earlier ones.
    const total = 2000;
    const all = Array.from({ length: total }, (_, index) => entry("файл-" + String(total - 1 - index).padStart(4, "0")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const call = host.call.getMockImplementation()!;
    host.call.mockImplementation(async (method, input) => {
      if (method !== "dir_list") return call(method, input);
      if (input.ref.path.segments.at(-1)?.t !== "данные") return { entries: [], cursor: null };
      const start = Number(input.cursor ?? 0);
      if (start === 20) await gate;
      if (start > 0) await new Promise((resolve) => setTimeout(resolve, 1));
      return { entries: all.slice(start, start + 20), cursor: start + 20 < total ? String(start + 20) : null };
    });

    mount();
    const first = await vi.waitFor(() => within(grid()).getByRole("row", { name: /файл-1980/ }));
    fireEvent.click(first);
    merges.count = 0;
    release();
    // The last batch is shown when the grid stops being busy; step the clock one page at a time until then.
    for (let step = 0; step < 400 && grid().getAttribute("aria-busy") === "true"; step++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    }
    expect(grid().getAttribute("aria-busy")).toBe("false");
    expect(merges.count).toBeLessThanOrEqual(12);
    expect(merges.count).toBeGreaterThan(0);
    expect(Number(grid().getAttribute("aria-rowcount"))).toBeGreaterThanOrEqual(total);
    expect(within(grid()).getByRole("row", { name: /файл-1980/ }).getAttribute("data-cursor")).toBe("true");
    // The rendered rows are in name order.
    const rendered = within(grid()).getAllByRole("row").map((row) => row.textContent ?? "").filter((text) => text.startsWith("файл-"));
    const names = rendered.map((text) => text.slice(0, 9));
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
  } finally { vi.useRealTimers(); }
});

test("a failing page shows the error even when an earlier batch is still waiting for its display timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    files = Array.from({ length: 3000 }, (_, index) => entry("файл-" + String(index).padStart(4, "0")));
    let fail!: () => void;
    const third = new Promise<void>((_, reject) => { fail = () => reject(new CommanderError("permission_denied", "private")); });
    third.catch(() => {});
    const call = host.call.getMockImplementation()!;
    host.call.mockImplementation(async (method, input) => {
      if (method === "dir_list" && input.ref.path.segments.at(-1)?.t === "данные") {
        if (input.cursor === "2000") await third;
        const start = Number(input.cursor ?? 0);
        return { entries: files.slice(start, start + 1000), cursor: String(start + 1000) };
      }
      return call(method, input);
    });
    mount();
    // Page 1 is shown at once, page 2 waits in the 100 ms batch timer, page 3 is still on its way.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    fail();
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => expect(within(grid()).queryAllByText("Доступ запрещён").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Загружено \d+ записей/)).toBeNull();
    expect(grid().getAttribute("aria-busy")).toBe("false");
  } finally { vi.useRealTimers(); }
});

test("a refresh of a directory after an error shows its first page at once and is not held by the old error", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    files = Array.from({ length: 3000 }, (_, index) => entry("файл-" + String(index).padStart(4, "0")));
    let attempt = 0;
    let holdSecond!: () => void;
    const second = new Promise<void>((resolve) => { holdSecond = resolve; });
    const call = host.call.getMockImplementation()!;
    host.call.mockImplementation(async (method, input) => {
      if (method === "dir_list" && input.ref.path.segments.at(-1)?.t === "данные") {
        if (input.cursor === null) attempt++;
        if (attempt === 1) throw new CommanderError("permission_denied", "private");
        const start = Number(input.cursor ?? 0);
        if (start === 1000) await second;
        return { entries: files.slice(start, start + 1000), cursor: start + 1000 < files.length ? String(start + 1000) : null };
      }
      return call(method, input);
    });
    mount();
    await vi.waitFor(() => expect(within(grid()).queryAllByText("Доступ запрещён").length).toBeGreaterThan(0));
    fireEvent.click(within(grid().parentElement!).getAllByRole("button", { name: /Обновить/ })[0]!);
    // The new attempt's first page is on screen at once; its second page is still held.
    await vi.waitFor(() => expect(within(grid()).queryAllByRole("row", { name: /файл-0000/ }).length).toBe(1));
    expect(within(grid()).queryAllByText("Доступ запрещён")).toHaveLength(0);
    expect(grid().getAttribute("aria-busy")).toBe("true");
    holdSecond();
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => expect(grid().getAttribute("aria-busy")).toBe("false"));
  } finally { vi.useRealTimers(); }
});

test("a read-only destination blocks copy and move, and its own panel blocks writes", async () => {
  const readOnly = { ...endpoint, id: "host:archive", hostId: "archive", label: "Архив", readOnly: true };
  saved!.right.tabs[0]!.endpoint = "host:archive";
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementation(async (method, input) =>
    method === "endpoints_list" ? { endpoints: [endpoint, readOnly] } : call(method, input));

  mount();
  fireEvent.click(await leftFile());
  const right = grid("Правая панель");
  const file = await within(right).findByRole("row", { name: /пример\.txt/ });
  const badge = within(right.parentElement!).getByRole("img", { name: "Только чтение" });
  expect(badge.textContent).toBe("Только чтение");
  const action = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  host.call.mockClear();

  expect(action("Копировать (F5)").disabled).toBe(true);
  expect(action("Переместить (F6)").disabled).toBe(true);
  fireEvent.keyDown(grid(), { key: "F5" });
  fireEvent.keyDown(grid(), { key: "F6" });
  fireEvent.click(file);

  expect(action("Копировать (F5)").disabled).toBe(false);
  expect(action("Переместить (F6)").disabled).toBe(true);
  expect(action("Каталог (F7)").disabled).toBe(true);
  expect(action("Удалить (F8)").disabled).toBe(true);
  fireEvent.keyDown(right, { key: "F6" });
  fireEvent.keyDown(right, { key: "F7" });
  fireEvent.keyDown(right, { key: "F8" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(host.call.mock.calls.filter(([method]) => method === "plan_create")).toEqual([]);
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

test.each([
  ["awaiting_decision", false, "Ждёт решения", "CircleQuestion"],
  ["pending", true, "Ждёт разрешения", "Lock"],
  ["running", false, "Выполняется", "Play"],
  ["completed", false, "Готово", "CircleCheck"],
  ["failed", false, "Ошибка", "AlertTriangle"],
] as const)("queue state %s uses a readable label and its own icon", async (state, awaitsOwner, label, icon) => {
  const job = firstConflict();
  jobs = [{ ...job, state, awaitsOwner, pendingConflict: state === "awaiting_decision" ? job.pendingConflict : null }];
  mount();
  const card = await screen.findByRole("article", { name: "Копирование" });
  expect(within(card).getByText(label)).toBeDefined();
  expect(within(card).getByRole("progressbar", { name: label })).toBeDefined();
  expect(card.querySelector(`[data-test-icon="${icon}"]`)).not.toBeNull();
});

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
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledTimes(1);
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledWith({
    target: { kind: "host", hostId: "fixture", path: "/данные/вложенный/пример.txt" }, location: null,
  });
  // S16: F4 never invokes the default opener, even when the explicit opener is refused.
  host.navigate.experimental_openFilePreview.mockClear().mockReturnValueOnce(false);
  fireEvent.keyDown(grid(), { key: "F4" });
  const fallback = await screen.findByRole("dialog", { name: "Редактор BB недоступен" });
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledTimes(1);
  expect(host.navigate.experimental_openFilePreview).toHaveBeenCalledWith({
    opener: "commander-private-editor", location: null,
    target: { kind: "host", hostId: "fixture", path: "/worker/commander-edits/65fb3d47-752e-48d8-b4c4-7112e2e4f460/revision-0" },
  });
  expect(host.navigate.experimental_openFilePreview.mock.calls.filter(([request]) => !request.opener)).toHaveLength(0);
  fireEvent.click(within(fallback).getByRole("button", { name: "Закрыть" }));
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
    if (fail && method === "job_get") throw Object.assign(new Error("fixture timeout"), { code: "timeout" });
    return call(method, input);
  });
  host.call.mockClear();
  if (dismissal === "Escape") fireEvent.keyDown(nested, { key: "Escape" });
  else fireEvent.click(within(nested).getByRole("button", { name: "Закрыть" }));
  const retry = await screen.findByRole("button", { name: "Проверить снова" });
  const heading = retry.closest("header");
  expect(heading).not.toBeNull();
  const alert = within(heading!).getByRole("alert");
  expect(within(alert).getByTitle("timeout Время ожидания истекло").textContent).toBe("timeout Время ожидания истекло");
  expect(alert.querySelector('[data-test-icon="AlertTriangle"]')).not.toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(open);
  expect(host.call.mock.calls.filter(([method]) => method === "job_decide" || method === "job_cancel")).toEqual([]);
  fail = false;
  fireEvent.click(retry);
  const restored = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  expect(within(restored).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
});

test("returning to a conflict reads that job directly by ID", async () => {
  jobs = [firstConflict()];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Сравнить и решить" }));
  const conflict = await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" });
  fireEvent.click(within(conflict).getByRole("button", { name: "Сравнить содержимое" }));
  const content = await screen.findByRole("dialog", { name: "Сравнить содержимое" });
  host.call.mockClear();

  fireEvent.keyDown(content, { key: "Escape" });
  expect(await screen.findByRole("dialog", { name: "пример.txt уже есть в назначении" })).toBeDefined();
  // The queue refreshes separately after the direct lookup.
  expect(host.call.mock.calls.filter(([method, input]) =>
    method === "job_get" || (method === "job_list" && input.states?.length > 1)))
    .toEqual([["job_get", { jobId: "a49575e8-a22b-4fa8-a4e3-cd96ab734325" }]]);
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

test("a refused job retry shows its problem on the page instead of failing silently", async () => {
  const job = firstConflict();
  jobs = [{ ...job, state: "failed", awaitsOwner: false, pendingConflict: null }];
  mount();
  const card = await screen.findByRole("article", { name: "Копирование" });
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementation(async (method, input) => method === "job_retry"
    ? Promise.reject(new Error("refused by the host")) : call(method, input));
  fireEvent.click(within(card).getByRole("button", { name: "Повторить невыполненное" }));
  expect(await screen.findByText(ru.unknownError)).toBeDefined();
  expect(host.call.mock.calls.some(([method]) => method === "plan_run")).toBe(false);
});

const scanId = "c38be723-5bd3-4377-b968-f2aa1ec7a5e1";
const remoteEstimateId = "cc187b4d-0b46-4b8a-b26f-a8dcdb8dae09";
const scanJob = { id: scanId, kind: "compare", initiator: { kind: "owner" }, endpoints: ["host:fixture"],
  state: "running", progress: { items: 2, bytes: "4", bytesPlanned: "16" }, partial: false, error: null };

test("directory comparison waits for confirmation of the remote estimate before starting", async () => {
  const remote = { ...endpoint, label: "Тестовый SFTP", provider: "sftp", id: "sftp:123e4567-e89b-42d3-a456-426614174000", hostId: null };
  saved!.right.tabs[0]!.endpoint = remote.id;
  const call = host.call.getMockImplementation()!;
  host.call.mockClear().mockImplementation(async (method, input) => {
    if (method === "endpoints_list") return { endpoints: [endpoint, remote] };
    if (method === "scan_start") return input.estimateOnly ? { estimateId: remoteEstimateId, bytesPlanned: "16",
      bytesByEndpoint: [{endpoint: endpoint.id, bytesPlanned: "4"}, {endpoint: remote.id, bytesPlanned: "12"}] } : scanJob;
    if (method === "scan_get") return { job: scanJob, result: null };
    return call(method, input);
  });
  mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  fireEvent.click(screen.getByRole("button", { name: "Сверить по SHA-256" }));
  expect(await screen.findByText("Прочитает до 4 Б локально и 12 Б с «Тестовый SFTP»")).toBeDefined();
  expect(host.call.mock.calls.filter(([method]) => method === "scan_start")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить чтение" }));
  await waitFor(() => expect(host.call).toHaveBeenCalledWith("scan_start",
    expect.objectContaining({ kind: "dirs", by: "sha256", estimateId: remoteEstimateId })));
  expect(await screen.findByRole("progressbar", { name: "Прогресс сканирования" })).toBeDefined();
});

test.each([
  ["interrupted", "Сканирование прервано", {}],
  ["done", "Результат недоступен", { reason: "result_expired" }],
] as const)("comparison shows %s and allows a fresh run", async (state, text, reason) => {
  const call = host.call.getMockImplementation()!;
  host.call.mockClear().mockImplementation(async (method, input) => {
    if (method === "scan_start") return scanJob;
    if (method === "scan_get") return { job: { ...scanJob, state, partial: state === "interrupted" }, result: null, ...reason };
    return call(method, input);
  });
  mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  fireEvent.click(screen.getByRole("button", { name: "Сравнить по размеру и времени" }));
  expect(await screen.findByText(text)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(host.call.mock.calls.filter(([method]) => method === "scan_start")).toHaveLength(2));
});

test("the selected file can be hashed and an active scan cancelled", async () => {
  const call = host.call.getMockImplementation()!;
  let cancelled = false;
  host.call.mockClear().mockImplementation(async (method, input) => {
    if (method === "scan_start") return { ...scanJob, kind: "checksum" };
    if (method === "scan_get") return { job: { ...scanJob, kind: "checksum", state: cancelled ? "cancelled" : "running" }, result: null };
    if (method === "scan_cancel") { cancelled = true; return {}; }
    return call(method, input);
  });
  mount();
  fireEvent.click(await leftFile());
  fireEvent.click(screen.getByRole("button", { name: "Хеш выбранного файла" }));
  fireEvent.click(screen.getByRole("button", { name: "Вычислить SHA-256" }));
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Отменить сканирование" }));
  await waitFor(() => expect(host.call).toHaveBeenCalledWith("scan_cancel", { scanId }));
  expect(await screen.findByText("Отменено")).toBeDefined();
});

test("directory results align entries and can hide equal pairs", async () => {
  const call = host.call.getMockImplementation()!;
  host.call.mockImplementation(async (method, input) => {
    if (method === "scan_start") return scanJob;
    if (method === "scan_get") return { job: { ...scanJob, state: "done" }, result: {
      onlyLeft: [entry("только-слева.txt")], onlyRight: [], differ: [],
      same: 1, equal: [[entry("совпадает.txt"), entry("совпадает.txt")]], partial: false,
    } };
    return call(method, input);
  });
  mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  fireEvent.click(screen.getByRole("button", { name: "Сравнить по размеру и времени" }));
  expect(await screen.findAllByText("совпадает.txt")).toHaveLength(2);
  fireEvent.click(screen.getByRole("checkbox", { name: "Скрыть одинаковые" }));
  expect(screen.queryByText("совпадает.txt")).toBeNull();
  expect(screen.getByText("только-слева.txt")).toBeDefined();
});

test.each([
  ["running", null], ["interrupted", "Сканирование прервано"], ["done", "Результат недоступен"],
] as const)("reopening comparison after remount restores %s from UI storage", async (state, text) => {
  const remote = { ...endpoint, provider: "sftp", id: "sftp:123e4567-e89b-42d3-a456-426614174000", hostId: null };
  saved!.right.tabs[0]!.endpoint = remote.id;
  const call = host.call.getMockImplementation()!;
  let reopened = false;
  host.call.mockClear().mockImplementation(async (method, input) => {
    if (method === "endpoints_list") return { endpoints: [endpoint, remote] };
    if (method === "scan_start") return input.estimateOnly ? {
      estimateId: remoteEstimateId, bytesPlanned: "16", bytesByEndpoint: [{ endpoint: remote.id, bytesPlanned: "16" }],
    } : scanJob;
    if (method === "scan_get") return { job: { ...scanJob, state: reopened ? state : "running" }, result: null,
      ...(reopened && state === "done" ? { reason: "result_expired" } : {}) };
    return call(method, input);
  });
  const page = mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  fireEvent.click(screen.getByRole("button", { name: "Сверить по SHA-256" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить чтение" }));
  await screen.findByRole("progressbar");
  page.unmount();
  reopened = true;
  mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  if (text) await screen.findByText(text);
  else await screen.findByRole("progressbar");
  expect(host.call.mock.calls.filter(([method]) => method === "scan_start")).toHaveLength(2);
  if (text) {
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("button", { name: "Подтвердить чтение" });
    expect(host.call.mock.calls.filter(([method]) => method === "scan_start").at(-1)?.[1])
      .toMatchObject({ kind: "dirs", by: "sha256", estimateOnly: true });
    expect(host.call.mock.calls.filter(([method]) => method === "scan_start").at(-1)?.[1]).not.toHaveProperty("estimateId");
  }
});

test("Escape closes comparison and returns focus to the active file panel", async () => {
  mount();
  fireEvent.click(await leftFile());
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  const title = screen.getByRole("heading", { name: "Сравнение каталогов", level: 1 });
  fireEvent.keyDown(title, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(grid()));
});

test("reopened comparison waits for the original delayed start and adopts its ID", async () => {
  const remote = { ...endpoint, provider: "sftp", id: "sftp:123e4567-e89b-42d3-a456-426614174000", hostId: null };
  saved!.right.tabs[0]!.endpoint = remote.id;
  const late = Promise.withResolvers<typeof scanJob>();
  const call = host.call.getMockImplementation()!;
  host.call.mockClear().mockImplementation(async (method, input) => {
    if (method === "endpoints_list") return { endpoints: [endpoint, remote] };
    if (method === "scan_start") return input.estimateOnly ? {
      estimateId: remoteEstimateId, bytesPlanned: "16", bytesByEndpoint: [{ endpoint: remote.id, bytesPlanned: "16" }],
    } : late.promise;
    if (method === "scan_get") return { job: scanJob, result: null };
    return call(method, input);
  });
  const actualStarts = () => host.call.mock.calls.filter(([method, input]) => method === "scan_start" && !input.estimateOnly);
  mount();
  await leftFile();
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  fireEvent.click(screen.getByRole("button", { name: "Сверить по SHA-256" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить чтение" }));
  expect(actualStarts()).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("heading", { name: "Сравнение каталогов", level: 1 }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Сравнить каталоги" }));
  const startAgain = screen.getByRole<HTMLButtonElement>("button", { name: "Сверить по SHA-256" });
  expect(startAgain.disabled).toBe(true);
  fireEvent.click(startAgain);
  late.resolve(scanJob);
  await screen.findByRole("progressbar");
  expect(host.call).toHaveBeenCalledWith("scan_get", { scanId });
  expect(actualStarts()).toHaveLength(1);
  expect(host.call.mock.calls.filter(([method, input]) => method === "scan_start" && input.estimateOnly)).toHaveLength(1);
});

// The owner's file_read, served by the same core code the RPC handler uses: a 3 MiB PNG on a fake host.
const PNG_3MIB = (() => {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let index = 8; index < bytes.length; index++) bytes[index] = index % 251;
  return bytes;
})();

function serveFileRead(provider: FakeProvider, file: ReturnType<typeof parsePosix>, input: Record<string, unknown>) {
  return (async () => {
    try {
      const window = await readForView(provider, file, {
        offset: BigInt((input.offset as string | undefined) ?? "0"),
        length: (input.length as number | undefined) ?? MAX_VIEW_BYTES,
        ...(input.expect ? { expect: input.expect as { size: string; mtimeNs: string | null } } : {}),
      }, new AbortController().signal);
      return JSON.parse(JSON.stringify(replyFor(window, (input.mode as "auto") ?? "auto", "owner"))) as WireView;
    } catch (error) {
      // The RPC handler sends changed_since_plan as a conflict whose message carries the code.
      if (error instanceof CommanderError && error.code === "changed_since_plan") {
        throw Object.assign(new Error(JSON.stringify({ code: error.code, message: error.message })), { code: "conflict" });
      }
      throw error;
    }
  })();
}

function serveOwnerFiles(provider: FakeProvider, file: ReturnType<typeof parsePosix>) {
  const base = host.call.getMockImplementation()!;
  const fileReads: Record<string, unknown>[] = [];
  host.call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    if (method !== "file_read") return base(method, input);
    fileReads.push(input);
    return serveFileRead(provider, file, input);
  });
  return fileReads;
}

async function openViewerOnPng() {
  host.navigate.experimental_openFilePreview.mockReturnValue(false);
  mount();
  fireEvent.click(await leftFile());
  fireEvent.keyDown(grid(), { key: "F3" });
  return screen.findByRole("dialog", { name: "пример.txt" });
}

test("F3 assembles a 3 MiB image from chunks that all carry the first version", async () => {
  const provider = new FakeProvider("host:fixture");
  const file = parsePosix("/данные/пример.png");
  provider.put(file, PNG_3MIB, "1");
  const fileReads = serveOwnerFiles(provider, file);
  const createObjectURL = vi.fn((_blob: Blob) => "blob:commander/assembled");
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();

  const dialog = await openViewerOnPng();

  await waitFor(() => expect(within(dialog).getByRole("img", { name: "пример.txt" }).getAttribute("src")).toBe("blob:commander/assembled"));
  const blob = createObjectURL.mock.calls[0]![0];
  expect(blob.size).toBe(3145728);
  expect(blob.type).toBe("image/png");
  expect(fileReads.length).toBeGreaterThan(1);
  for (const later of fileReads.slice(1)) {
    expect(later).toMatchObject({ mode: "image", expect: { size: "3145728", mtimeNs: "1" } });
  }
});

test("F3 reports the file changed between two chunks of one image", async () => {
  const provider = new FakeProvider("host:fixture");
  const file = parsePosix("/данные/пример.png");
  provider.put(file, PNG_3MIB, "1");
  const fileReads = serveOwnerFiles(provider, file);
  // The file is replaced after the second chunk has been served; the third chunk must fail.
  const served = host.call.getMockImplementation()!;
  let chunks = 0;
  host.call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    if (method !== "file_read") return served(method, input);
    chunks++;
    const reply = await served(method, input);
    if (chunks === 2) provider.put(file, PNG_3MIB.subarray(0, 2 * 1024 * 1024), "2");
    return reply;
  });

  const dialog = await openViewerOnPng();

  expect(await within(dialog).findByText("Файл изменился во время просмотра")).toBeDefined();
  expect(within(dialog).queryByRole("img")).toBeNull();
  expect(fileReads.length).toBe(3);
});

test("S11 panel cancellation aborts the HTTP scan_start call itself", async () => {
  const fetchScan = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetchScan);
  try {
    mount();
    await leftFile();
    fireEvent.click(within(grid().parentElement!).getByRole("button", { name: "Поиск" }));
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    const [url, request] = fetchScan.mock.calls[0];
    expect(url).toBe("/api/v1/plugins/commander%3Afixture/rpc/scan_start");
    expect(request.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть поиск" }));
    expect(request.signal?.aborted).toBe(true);
    expect(screen.queryByRole("grid", { name: "Найденные файлы" })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

test.each(["network", "response body", "truncated JSON", "empty JSON", 401, 404] as const)("S11 falls back to SDK RPC for %s and cancels by request id", async (failure) => {
  const serve = host.call.getMockImplementation()!;
  const sdkStart = vi.fn((_input: unknown) => new Promise<never>(() => {}));
  const cancel = vi.fn(async (_input: unknown) => ({}));
  host.call.mockImplementation((method, input) => method === "scan_start" ? sdkStart(input)
    : method === "scan_cancel" ? cancel(input) : serve(method, input));
  const fetchScan = vi.fn(async (_url: string, _init: RequestInit) => {
    if (failure === "network") throw new TypeError("Failed to fetch");
    if (failure === "response body") {
      const stream = new ReadableStream({ start(controller) { controller.error(new TypeError("Connection lost")); } });
      return new Response(stream);
    }
    if (failure === "truncated JSON" || failure === "empty JSON") {
      const body = failure === "truncated JSON" ? '{"ok":true,"result":' : "";
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: failure });
  });
  vi.stubGlobal("fetch", fetchScan);
  try {
    mount();
    await leftFile();
    fireEvent.click(within(grid().parentElement!).getByRole("button", { name: "Поиск" }));
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    await waitFor(() => expect(sdkStart).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(fetchScan.mock.calls[0][1].body));
    expect(request.clientRequestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(sdkStart).toHaveBeenCalledWith(request);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть поиск" }));
    expect(cancel).toHaveBeenCalledWith({ clientRequestId: request.clientRequestId });
  } finally { vi.unstubAllGlobals(); }
});

test("an App copy keeps the planned selection and survives unmount during staging", async () => {
  const { openStage, release } = pauseAfterWrite();
  const stand = await localStand({ openStage });
  const allowPlanReply = Promise.withResolvers<void>();
  const planCreated = Promise.withResolvers<unknown>();
  const firstSession = new AbortController();
  try {
    await writeFile(join(stand.root, "b.txt"), "other");
    const tab = { endpoint: "host:test", sort: { by: "name", direction: "asc" } as const, selection: [], filter: "", scrollTop: 0 };
    await stand.rpc("ui_state_set", { state: {
      left: { activeTab: 0, tabs: [{ ...tab, path: stand.ref().path }] },
      right: { activeTab: 0, tabs: [{ ...tab, path: stand.ref("out").path }] },
      activePane: "left", layout: "horizontal", split: 0.5,
    } });
    const job = Promise.withResolvers<OperationJob>();
    host.call.mockImplementation(async (method, input) => {
      const result = await stand.rpc(method, input, firstSession.signal);
      if (method === "plan_create") {
        planCreated.resolve(result);
        await allowPlanReply.promise;
      }
      if (method === "plan_run") job.resolve(OperationJob.parse(result));
      return result;
    });
    const view = mount();
    fireEvent.click(await leftFile("a.txt"));
    fireEvent.keyDown(grid(), { key: "F5" });
    await waitFor(() => expect(host.call).toHaveBeenCalledWith("plan_create", expect.objectContaining({
      sources: [stand.ref("a.txt")],
    })));
    expect(await planCreated.promise).toMatchObject({ items: [{ source: stand.ref("a.txt") }] });

    const other = await leftFile("b.txt");
    fireEvent.click(other, { ctrlKey: true });
    expect(other.getAttribute("aria-selected")).toBe("true");
    allowPlanReply.resolve();

    const dialog = await screen.findByRole("dialog", { name: "Копирование" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Запустить" }));
    await waitForPart(stand.out, 3);
    const { id: jobId } = await job.promise;
    view.unmount();
    firstSession.abort();
    release();

    const secondSession = new AbortController();
    const rpc = (method: Parameters<typeof stand.rpc>[0], input: unknown) => stand.rpc(method, input, secondSession.signal);
    await waitForJob(rpc, jobId, { state: "completed", progress: { bytesDone: "3" } });
    expect(await readdir(stand.out)).toEqual(["a.txt"]);
    const scan = ScanJobView.parse(await rpc("scan_start", { kind: "checksum", ref: stand.ref("out/a.txt") }));
    await vi.waitFor(async () => expect(await rpc("scan_get", { scanId: scan.id })).toMatchObject({
      job: { state: "done" }, result: { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    }));
  } finally {
    cleanup();
    allowPlanReply.resolve();
    release();
    firstSession.abort();
    await stand.close();
  }
});
