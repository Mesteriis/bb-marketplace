// @vitest-environment jsdom
// F3 opens the Commander viewer when there is no native preview, loads the window through
// onView, switches representations and reports a file that changed during the read.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));
import type { Entry, Endpoint } from "../core/model.ts";
import { parsePosix } from "../core/path.ts";
import type { ViewResult } from "../core/preview.ts";
import { Workspace, type WorkspaceProps } from "./workspace.tsx";
import { newTab } from "./model.ts";
import type { UiState } from "../core/wire/rpc.ts";

const fileEntry: Entry = {
  name: { t: "a.txt" }, kind: "file", size: "5", mtimeNs: null, mtimePrecision: "unknown", mode: null,
  linkTarget: null, hidden: false,
} as Entry;
const endpoint: Endpoint = {
  id: "sftp:fixture", provider: "sftp", label: "Fixture", machine: "fixture", hostId: "fixture", readOnly: false, caseSensitive: true,
} as Endpoint;
const state: UiState = {
  left: { tabs: [newTab(endpoint.id, parsePosix("/data"))], activeTab: 0 },
  right: { tabs: [], activeTab: null },
  activePane: "left", layout: "horizontal", split: 0.5,
};
const fileRef = { endpoint: endpoint.id, path: parsePosix("/data/a.txt") };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const VERSION = { size: "5", mtimeNs: "1" };
// "hello" as the hex dump lays it out: offset, eight bytes, eight bytes, then the ASCII column.
const HEX_HELLO = "00000000  68 65 6c 6c 6f" + " ".repeat(36) + "|hello|";
function textResult(text: string): ViewResult {
  return { version: VERSION, modes: ["text", "binary"], model: { kind: "text", text, truncated: false } };
}
function hexResult(modes: ViewResult["modes"] = ["text", "binary"]): ViewResult {
  return { version: VERSION, modes, model: { kind: "binary", lines: [HEX_HELLO], truncated: false, shown: 5, total: "5" } };
}
function imageResult(): ViewResult {
  return { version: VERSION, modes: ["image", "binary"], model: { kind: "image", mime: "image/png", bytes: PNG, truncated: false } };
}

function mount(onView: WorkspaceProps["onView"]) {
  const props = {
    state, update: vi.fn(), endpoints: [endpoint],
    directories: { left: { entries: [fileEntry], loading: false, error: null }, right: undefined },
    queue: { jobs: [], error: null, loading: false }, problem: null, compact: false, bindings: {},
    onBindings: vi.fn(), onEndpoint: vi.fn(async () => undefined), onRefresh: vi.fn(), onAccess: vi.fn(async () => undefined),
    onCreate: vi.fn(), onRun: vi.fn(), onInspect: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onReloadConflict: vi.fn(async () => null),
    onDecide: vi.fn(), onCancel: vi.fn(), onPreview: vi.fn(() => { throw Object.assign(new Error("unsupported"), { code: "unsupported" }); }),
    onView, onCompare: vi.fn(), onTerminal: vi.fn(), onOpenThread: vi.fn(), onOpenPage: vi.fn(),
  } as unknown as WorkspaceProps;
  return render(<Workspace {...props} />);
}

function openF3OnFile() {
  const grid = screen.getByRole("grid", { name: "Левая панель" });
  fireEvent.click(within(grid).getByRole("row", { name: /a\.txt/ }));
  fireEvent.keyDown(grid, { key: "F3" });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:commander/view-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("F3 viewer dialog", () => {
  it("opens by F3 and asks the host for the automatic window of the file", async () => {
    const onView = vi.fn(async () => textResult("hello"));
    mount(onView);

    openF3OnFile();

    expect(await screen.findByRole("dialog", { name: "a.txt" })).toBeDefined();
    expect(onView).toHaveBeenCalledWith(fileRef, "auto");
    expect(await within(screen.getByRole("dialog")).findByText("hello")).toBeDefined();
  });

  it("switches the representation between Текст and Hex", async () => {
    const onView = vi.fn(async (_ref: unknown, mode: string): Promise<ViewResult> => mode === "binary" ? hexResult() : textResult("hello"));
    mount(onView);
    openF3OnFile();
    const dialog = await screen.findByRole("dialog", { name: "a.txt" });
    await within(dialog).findByText("hello");

    fireEvent.click(within(dialog).getByRole("button", { name: "Hex" }));

    expect(onView).toHaveBeenLastCalledWith(fileRef, "binary");
    await waitFor(() => expect(dialog.querySelector("pre")?.textContent).toBe(HEX_HELLO));
    expect(within(dialog).getByRole("button", { name: "Hex" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Текст" }));

    expect(onView).toHaveBeenLastCalledWith(fileRef, "text");
    expect(await within(dialog).findByText("hello")).toBeDefined();
  });

  it("switches to an image through an img with a blob URL, and back to hex", async () => {
    // The same file offers the same representations whichever one is requested.
    const onView = vi.fn(async (_ref: unknown, mode: string): Promise<ViewResult> => mode === "binary"
      ? hexResult(["image", "binary"]) : imageResult());
    mount(onView);
    openF3OnFile();
    const dialog = await screen.findByRole("dialog", { name: "a.txt" });

    await waitFor(() => expect(within(dialog).getByRole("img", { name: "a.txt" }).getAttribute("src")).toBe("blob:commander/view-1"));
    expect(within(dialog).getByRole("button", { name: "Изображение" })).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Hex" }));
    await waitFor(() => expect(dialog.querySelector("pre")?.textContent).toBe(HEX_HELLO));
    expect(within(dialog).queryByRole("img")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Изображение" }));
    expect(onView).toHaveBeenLastCalledWith(fileRef, "image");
  });

  it("says the file changed during the view and reloads it on Обновить", async () => {
    // The owner RPC reports the file change as a conflict whose message carries the internal code.
    const changed = Object.assign(new Error(JSON.stringify({ code: "changed_since_plan", message: "File changed while it was viewed" })), { code: "conflict" });
    const onView = vi.fn()
      .mockRejectedValueOnce(changed)
      .mockResolvedValueOnce(textResult("fresh"));
    mount(onView);
    openF3OnFile();
    const dialog = await screen.findByRole("dialog", { name: "a.txt" });

    expect(await within(dialog).findByText("Файл изменился во время просмотра")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Обновить" }));

    expect(onView).toHaveBeenCalledTimes(2);
    expect(onView).toHaveBeenLastCalledWith(fileRef, "auto");
    expect(await within(dialog).findByText("fresh")).toBeDefined();
  });
});
