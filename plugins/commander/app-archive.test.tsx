// @vitest-environment jsdom
// S14a: the app starts with a saved archive panel whose copy is gone (after a restart). The panel stays, the owner
// is asked for a new estimate, and only after the owner confirms is the archive copied again.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComponentType } from "react";
import type { Entry } from "./src/core/model.ts";
import type { UiState } from "./src/core/wire/rpc.ts";

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

import app from "./app.tsx";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const ARCHIVE = "archive:" + ID;
const ESTIMATE = "223e4567-e89b-42d3-a456-426614174000";
const local = { id: "host:fixture", provider: "local", label: "Стенд", machine: "Стенд", hostId: "fixture", readOnly: false, caseSensitive: true };
const archiveView = { id: ARCHIVE, provider: "archive", label: "site.zip", machine: "Стенд", hostId: null, readOnly: true, caseSensitive: true };
const file = (t: string): Entry => ({ name: { t }, kind: "file", size: "16", mtimeNs: null, mtimePrecision: "unknown", mode: null, linkTarget: null, hidden: false });
const tab = { sort: { by: "name", direction: "asc" } as const, selection: [], filter: "", scrollTop: 0 };
const cold = (): UiState => ({
  left: { activeTab: 0, tabs: [{ ...tab, endpoint: ARCHIVE, path: { segments: [] } }] },
  right: { activeTab: 0, tabs: [{ ...tab, endpoint: "host:fixture", path: { segments: [{ t: "приёмник" }] } }] },
  activePane: "left", layout: "horizontal", split: 0.5,
});
const refusal = Object.assign(new Error(JSON.stringify({ code: "consent_required", message: "The archive must be estimated again", retryable: false })), { code: "forbidden" });

let open = false;
let saved: UiState;
beforeEach(() => {
  open = false;
  saved = cold();
  host.sdk.environments.get.mockResolvedValue({ hostId: "fixture", path: "/x" });
  host.call.mockImplementation(async (method, input) => {
    switch (method) {
      case "ui_state_get": return { state: saved };
      case "ui_state_set": saved = structuredClone(input.state); return {};
      case "endpoint_home": return { path: { segments: [{ t: "дом" }] } };
      case "endpoints_list": return { endpoints: open ? [local, archiveView] : [local] };
      case "job_list": return { jobs: [] };
      case "dir_list":
        if (input.ref.endpoint === ARCHIVE && !open) throw refusal;
        return { entries: input.ref.endpoint === ARCHIVE ? [file("внутри.txt")] : [], cursor: null };
      case "archive_resume":
        if (input.estimateOnly) return { estimateId: ESTIMATE, bytesPlanned: "2147483648" };
        open = true;
        return { archiveId: ID, endpoint: ARCHIVE, entries: 1, encrypted: false };
      default: throw new Error("Unexpected RPC " + method);
    }
  });
});
afterEach(cleanup);

function mount() {
  let Page!: ComponentType;
  (app as unknown as (api: unknown) => void)({ slots: {
    navPanel: ({ component }: { component: ComponentType }) => { Page = component; },
    experimental_tab: () => {},
  } });
  return render(<Page />);
}

test("a saved archive panel survives the start, asks for a new estimate, and reads nothing before the owner agrees", async () => {
  mount();
  expect(await screen.findByText(/2 ГБ/)).toBeTruthy();
  // The panel was not swapped for a home directory, and the copy was not asked for with an estimate yet.
  expect(saved.left.tabs[0]!.endpoint).toBe(ARCHIVE);
  expect(host.call).not.toHaveBeenCalledWith("endpoint_home", expect.objectContaining({ endpoint: ARCHIVE }));
  expect(host.call.mock.calls.filter(([method]) => method === "archive_resume")).toEqual([["archive_resume", { archiveId: ID, estimateOnly: true }]]);
  fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
  await waitFor(() => expect(host.call).toHaveBeenCalledWith("archive_resume", { archiveId: ID, estimateId: ESTIMATE }));
  const grid = await screen.findByRole("grid", { name: "Левая панель" });
  expect(await within(grid).findByRole("row", { name: /внутри\.txt/ })).toBeTruthy();
  expect(saved.left.tabs[0]!.endpoint).toBe(ARCHIVE);
});

test("two cold panels: confirming one does not make the other ask a second time", async () => {
  const ID2 = "999e4567-e89b-42d3-a456-426614174000", B = "archive:" + ID2, ESTIMATE2 = "333e4567-e89b-42d3-a456-426614174000";
  saved = {
    left: { activeTab: 0, tabs: [{ ...tab, endpoint: ARCHIVE, path: { segments: [] } }] },
    right: { activeTab: 0, tabs: [{ ...tab, endpoint: B, path: { segments: [] } }] },
    activePane: "left", layout: "horizontal", split: 0.5,
  };
  const views = { [ARCHIVE]: archiveView, [B]: { ...archiveView, id: B, label: "other.zip" } };
  const opened = new Set<string>();
  const where = (id: string) => ({ endpoint: "host:fixture", path: { segments: [{ t: id === ID ? "site.zip" : "other.zip" }] } });
  host.call.mockImplementation(async (method, input) => {
    switch (method) {
      case "ui_state_get": return { state: saved };
      case "ui_state_set": saved = structuredClone(input.state); return {};
      case "endpoint_home": return { path: { segments: [] } };
      case "endpoints_list": return { endpoints: [local, ...[...opened].map((id) => views["archive:" + id as keyof typeof views])] };
      case "job_list": return { jobs: [] };
      case "dir_list":
        if (input.ref.endpoint.startsWith("archive:") && !opened.has(input.ref.endpoint.slice(8))) throw refusal;
        return { entries: [], cursor: null };
      case "archive_resume":
        if (input.estimateOnly) return { estimateId: input.archiveId === ID ? ESTIMATE : ESTIMATE2, bytesPlanned: "2147483648", source: where(input.archiveId) };
        opened.add(input.archiveId);
        return { archiveId: input.archiveId, endpoint: "archive:" + input.archiveId, entries: 0, encrypted: false };
      default: throw new Error("Unexpected RPC " + method);
    }
  });
  mount();
  expect(await screen.findByText("site.zip")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
  await waitFor(() => expect(host.call).toHaveBeenCalledWith("archive_resume", { archiveId: ID, estimateId: ESTIMATE }));
  expect(await screen.findByText("other.zip")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  await waitFor(() => expect(screen.queryByText("other.zip")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("heading", { name: "Скопировать архив для открытия" })).toBeNull();
  const estimatesOfB = host.call.mock.calls.filter(([method, input]) => method === "archive_resume" && input.archiveId === ID2 && input.estimateOnly);
  expect(estimatesOfB).toHaveLength(1);
});
