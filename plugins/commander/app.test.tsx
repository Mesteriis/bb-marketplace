// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Entry } from "./src/core/model.ts";
import type { UiState } from "./src/core/wire/rpc.ts";

const host = vi.hoisted(() => ({
  call: vi.fn(),
  navigate: {},
  sdk: {},
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
let jobs: unknown[];

beforeEach(() => {
  files = [entry("вложенный", "dir"), entry("пример.txt")];
  jobs = [];
  const tab = { endpoint: "host:fixture", sort: { by: "name", direction: "asc" } as const, selection: [], filter: "", scrollTop: 0 };
  saved = { left: { activeTab: 0, tabs: [{ ...tab, path: path("данные") }] },
    right: { activeTab: 0, tabs: [{ ...tab, path: path("приёмник") }] }, activePane: "left", layout: "horizontal", split: 0.5 };
  host.call.mockImplementation(async (method, input) => {
    switch (method) {
      case "ui_state_get": return { state: saved };
      case "ui_state_set": saved = structuredClone(input.state); return {};
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

function mount() {
  let Page!: ComponentType;
  const register = app as unknown as (api: unknown) => void;
  register({ slots: {
    navPanel: ({ component }: { component: ComponentType }) => { Page = component; },
    experimental_tab: () => {},
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
