// @vitest-environment jsdom
// The sync action works on the two panels' directories, so it is off while the active panel shows
// search results (as the checksum action is) and on again outside search.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));
import type { Entry, Endpoint } from "../core/model.ts";
import { parsePosix } from "../core/path.ts";
import type { UiState } from "../core/wire/rpc.ts";
import { newTab } from "./model.ts";
import { Workspace, type WorkspaceProps } from "./workspace.tsx";

const endpoint: Endpoint = {
  id: "host:fixture", provider: "local", label: "Fixture", machine: "fixture", hostId: "fixture", readOnly: false, caseSensitive: true,
} as Endpoint;
const fileEntry: Entry = {
  name: { t: "a.txt" }, kind: "file", size: "5", mtimeNs: null, mtimePrecision: "unknown", mode: null,
  linkTarget: null, hidden: false,
} as Entry;
const base: UiState = {
  left: { tabs: [newTab(endpoint.id, parsePosix("/left"))], activeTab: 0 },
  right: { tabs: [newTab(endpoint.id, parsePosix("/right"))], activeTab: 0 },
  activePane: "left", layout: "horizontal", split: 0.5,
};
const inSearch: UiState = {
  ...base,
  searchPanels: { left: { scanId: "5b0f4f8e-6c2d-4c1e-9d43-2f6a9b8c7d10", root: { endpoint: endpoint.id, path: parsePosix("/left") } } },
};

function mount(state: UiState) {
  const listing = { entries: [fileEntry], loading: false, error: null };
  const props = {
    state, update: vi.fn(), endpoints: [endpoint],
    directories: { left: listing, right: listing },
    queue: { jobs: [], error: null, loading: false }, problem: null, compact: false, bindings: {},
    onBindings: vi.fn(), onEndpoint: vi.fn(async () => undefined), onRefresh: vi.fn(), onAccess: vi.fn(async () => undefined),
    onCreate: vi.fn(), onRun: vi.fn(), onInspect: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onReloadConflict: vi.fn(async () => null),
    onDecide: vi.fn(), onCancel: vi.fn(), onPreview: vi.fn(), onView: vi.fn(), onCompare: vi.fn(), onTerminal: vi.fn(),
    onOpenThread: vi.fn(), onOpenPage: vi.fn(),
    search: { start: vi.fn(), get: vi.fn(async () => null), cancel: vi.fn(async () => ({})), cancelRequest: vi.fn(async () => ({})) },
    sync: { estimate: vi.fn(), create: vi.fn(), run: vi.fn() },
  } as unknown as WorkspaceProps;
  return render(<Workspace {...props} />);
}

afterEach(cleanup);

it("enables Синхронизация when both panels show directories", () => {
  mount(base);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Синхронизация" }).disabled).toBe(false);
});

it("disables Синхронизация while the active panel shows search results", () => {
  mount(inSearch);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Синхронизация" }).disabled).toBe(true);
});
