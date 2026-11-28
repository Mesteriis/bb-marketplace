// @vitest-environment jsdom
// S14: Enter on a ZIP or TAR opens it as a read-only panel; an encrypted archive asks the owner for the
// password in a dialog whose field is a password field and whose answer goes only to the host.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));
import type { Endpoint, Entry } from "../core/model.ts";
import { parsePosix } from "../core/path.ts";
import { newTab } from "./model.ts";
import { Workspace, type WorkspaceProps } from "./workspace.tsx";
import type { UiState } from "../core/wire/rpc.ts";

const file = (name: string): Entry => ({
  name: { t: name }, kind: "file", size: "5", mtimeNs: null, mtimePrecision: "unknown", mode: null, linkTarget: null, hidden: false,
}) as Entry;
const endpoint: Endpoint = {
  id: "host:fixture", provider: "local", label: "Fixture", machine: "fixture", hostId: "fixture", readOnly: false, caseSensitive: true,
} as Endpoint;
const state: UiState = {
  left: { tabs: [newTab(endpoint.id, parsePosix("/data"))], activeTab: 0 },
  right: { tabs: [], activeTab: null },
  activePane: "left", layout: "horizontal", split: 0.5,
};
const ARCHIVE_ENDPOINT = "archive:123e4567-e89b-42d3-a456-426614174000";

function mount(over: Partial<WorkspaceProps> = {}) {
  const props = {
    state, update: vi.fn(), endpoints: [endpoint],
    directories: { left: { entries: [file("docs.zip"), file("notes.tar"), file("a.txt"), file("pack.tar.gz")], loading: false, error: null }, right: undefined },
    queue: { jobs: [], error: null, loading: false }, problem: null, compact: false, bindings: {},
    onBindings: vi.fn(), onEndpoint: vi.fn(async () => undefined), onRefresh: vi.fn(), onAccess: vi.fn(async () => undefined),
    onCreate: vi.fn(), onRun: vi.fn(), onInspect: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onReloadConflict: vi.fn(async () => null),
    onDecide: vi.fn(), onCancel: vi.fn(), onPreview: vi.fn(() => { throw new Error("no native preview"); }),
    onView: vi.fn(async () => { throw new Error("no view"); }), onCompare: vi.fn(), onTerminal: vi.fn(), onOpenThread: vi.fn(), onOpenPage: vi.fn(),
    onOpenArchive: vi.fn(async () => ({ endpoint: ARCHIVE_ENDPOINT })),
    ...over,
  } as unknown as WorkspaceProps;
  const view = render(<Workspace {...props} />);
  return Object.assign(props, { rerender: (next: WorkspaceProps) => view.rerender(<Workspace {...next} />), props });
}
const grid = () => screen.getByRole("grid", { name: "Левая панель" });
const enterOn = (name: RegExp) => {
  fireEvent.click(within(grid()).getByRole("row", { name }));
  fireEvent.keyDown(grid(), { key: "Enter" });
};
afterEach(() => cleanup());

describe("Enter on an archive", () => {
  it.each([["docs.zip", /docs\.zip/], ["notes.tar", /notes\.tar/]])("opens %s through the host and switches the pane to the archive endpoint", async (_name, row) => {
    const props = mount();
    enterOn(row);
    await waitFor(() => expect(props.onEndpoint).toHaveBeenCalledWith("left", ARCHIVE_ENDPOINT));
    expect(props.onOpenArchive).toHaveBeenCalledWith({ endpoint: "host:fixture", path: parsePosix("/data/" + _name) });
    expect(props.onView).not.toHaveBeenCalled();
  });

  it.each([[/a\.txt/], [/pack\.tar\.gz/]])("does not treat %s as an archive", async (row) => {
    const props = mount();
    enterOn(row);
    await new Promise((r) => setTimeout(r, 20));
    expect(props.onOpenArchive).not.toHaveBeenCalled();
  });

  it("shows the refusal of the host when the archive cannot be opened and leaves the pane alone", async () => {
    const failure = Object.assign(new Error("x"), { code: "invalid_archive" });
    const props = mount({ onOpenArchive: vi.fn(async () => { throw failure; }) } as never);
    enterOn(/docs\.zip/);
    await waitFor(() => expect(props.onOpenArchive).toHaveBeenCalled());
    expect(props.onEndpoint).not.toHaveBeenCalled();
  });
});

describe("a remote archive asks before it is copied", () => {
  const ESTIMATE = "223e4567-e89b-42d3-a456-426614174000";
  const remote = () => vi.fn(async (_ref: unknown, estimateId?: string) =>
    estimateId ? { endpoint: ARCHIVE_ENDPOINT } : { estimateId: ESTIMATE, bytesPlanned: "5368709120" });

  it("shows the size of the copy and opens only after the owner confirms, with the estimate id", async () => {
    const onOpenArchive = remote();
    const props = mount({ onOpenArchive } as never);
    enterOn(/docs\.zip/);
    expect(await screen.findByText(/5 ГБ/)).toBeTruthy();
    expect(onOpenArchive).toHaveBeenCalledTimes(1);
    expect(props.onEndpoint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
    await waitFor(() => expect(props.onEndpoint).toHaveBeenCalledWith("left", ARCHIVE_ENDPOINT));
    expect(onOpenArchive).toHaveBeenLastCalledWith(expect.anything(), ESTIMATE);
  });

  it("cancel leaves the pane alone and never opens", async () => {
    const onOpenArchive = remote();
    const props = mount({ onOpenArchive } as never);
    enterOn(/docs\.zip/);
    await screen.findByText(/5 ГБ/);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onOpenArchive).toHaveBeenCalledTimes(1);
    expect(props.onEndpoint).not.toHaveBeenCalled();
  });

  it("an estimate of zero bytes (a direct archive) opens without a question", async () => {
    const onOpenArchive = vi.fn(async (_ref: unknown, estimateId?: string) =>
      estimateId ? { endpoint: ARCHIVE_ENDPOINT } : { estimateId: ESTIMATE, bytesPlanned: "0" });
    const props = mount({ onOpenArchive } as never);
    enterOn(/docs\.zip/);
    await waitFor(() => expect(props.onEndpoint).toHaveBeenCalledWith("left", ARCHIVE_ENDPOINT));
  });
});

describe("a cold archive tab (after a restart)", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";
  const ESTIMATE = "223e4567-e89b-42d3-a456-426614174000";
  const cold = {
    left: { tabs: [newTab(ARCHIVE_ENDPOINT, parsePosix("/"))], activeTab: 0 }, right: { tabs: [], activeTab: null },
    activePane: "left", layout: "horizontal", split: 0.5,
  } as UiState;
  const coldDirs = { left: { entries: [], loading: false, error: { code: "consent_required", message: "Требуется разрешение" } }, right: undefined };

  it("asks for a new estimate by itself, once, and refreshes the pane after the owner confirms", async () => {
    const onResumeArchive = vi.fn(async (_id: string, estimateId?: string) =>
      estimateId ? { endpoint: ARCHIVE_ENDPOINT } : { estimateId: ESTIMATE, bytesPlanned: "2147483648" });
    const props = mount({ state: cold, directories: coldDirs, onResumeArchive } as never);
    expect(await screen.findByText(/2 ГБ/)).toBeTruthy();
    expect(onResumeArchive).toHaveBeenCalledTimes(1);
    expect(onResumeArchive).toHaveBeenCalledWith(ID);
    fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
    await waitFor(() => expect(onResumeArchive).toHaveBeenLastCalledWith(ID, ESTIMATE));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledWith("left"));
  });

  it("does not ask again after the owner cancels", async () => {
    const onResumeArchive = vi.fn(async () => ({ estimateId: ESTIMATE, bytesPlanned: "2147483648" }));
    mount({ state: cold, directories: coldDirs, onResumeArchive } as never);
    await screen.findByText(/2 ГБ/);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(onResumeArchive).toHaveBeenCalledTimes(1);
  });

  it("asks again after a cancel when the pane is refreshed, and after a failed attempt too", async () => {
    const answers: Array<() => Promise<unknown>> = [
      async () => { throw new Error("offline"); },
      async () => ({ estimateId: ESTIMATE, bytesPlanned: "2147483648" }),
    ];
    const onResumeArchive = vi.fn(async () => answers.shift()!());
    const props = {
      state: cold, directories: coldDirs, onResumeArchive,
    } as unknown as Partial<WorkspaceProps>;
    const view = mount(props as never);
    await waitFor(() => expect(onResumeArchive).toHaveBeenCalledTimes(1));
    // The failed attempt is released: the same directory is not asked about again by itself, a refreshed one is.
    await new Promise((r) => setTimeout(r, 30));
    expect(onResumeArchive).toHaveBeenCalledTimes(1);
    view.rerender({ ...view.props, directories: { ...coldDirs, left: { ...coldDirs.left } } });
    expect(await screen.findByText(/2 ГБ/)).toBeTruthy();
    expect(onResumeArchive).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(onResumeArchive).toHaveBeenCalledTimes(2);
    answers.push(async () => ({ estimateId: ESTIMATE, bytesPlanned: "2147483648" }));
    view.rerender({ ...view.props, directories: { ...coldDirs, left: { ...coldDirs.left } } });
    expect(await screen.findByText(/2 ГБ/)).toBeTruthy();
    expect(onResumeArchive).toHaveBeenCalledTimes(3);
  });

  it("does nothing for an ordinary endpoint with the same error", async () => {
    const onResumeArchive = vi.fn();
    mount({ directories: coldDirs, onResumeArchive } as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(onResumeArchive).not.toHaveBeenCalled();
  });
});

describe("confirming a copy from the queue, and several questions at once", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";
  const ID2 = "999e4567-e89b-42d3-a456-426614174000";
  const ESTIMATE = "223e4567-e89b-42d3-a456-426614174000";
  const waiting = (id: string) => ({
    id: "323e4567-e89b-42d3-a456-426614174000", state: "interrupted", awaitsOwner: false, pendingConflict: null, currentItem: 0,
    error: { code: "consent_required", reason: "archive_copy", message: "x", retryable: false },
    createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z",
    progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "3" }, items: [{ outcome: "pending", error: null }],
    plan: {
      id: "123e4567-e89b-42d3-a456-426614174001", kind: "copy", createdAt: "2026-11-27T00:00:00.000Z", initiator: { kind: "owner" },
      sourceEndpoint: "archive:" + id, targetEndpoint: "host:fixture", targetDir: { endpoint: "host:fixture", path: { segments: [] } },
      items: [{ source: { endpoint: "archive:" + id, path: parsePosix("/a") }, target: { endpoint: "host:fixture", path: parsePosix("/a") },
        kind: "file", fingerprint: { size: "1", mtimeNs: "1" }, expectTarget: "absent" }],
      conflictPolicy: "ask", route: "relay-server", verify: "size", totalBytes: "3", digest: "a".repeat(64),
    },
  });

  it("opens the question for the archive named in the job's plan, even though no archive tab is open", async () => {
    const onResumeArchive = vi.fn(async (_id: string, estimateId?: string) =>
      estimateId ? { endpoint: "archive:" + ID } : { estimateId: ESTIMATE, bytesPlanned: "1073741824" });
    const props = mount({ queue: { jobs: [waiting(ID)], error: null, loading: false }, onResumeArchive } as never);
    fireEvent.click(await screen.findByRole("button", { name: "Подтвердить копию" }));
    expect(await screen.findByText(/1 ГБ/)).toBeTruthy();
    expect(onResumeArchive).toHaveBeenCalledWith(ID);
    fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
    await waitFor(() => expect(onResumeArchive).toHaveBeenLastCalledWith(ID, ESTIMATE));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalled());
  });

  it("the dialog has a neutral title", async () => {
    const onResumeArchive = vi.fn(async () => ({ estimateId: ESTIMATE, bytesPlanned: "1073741824" }));
    mount({ queue: { jobs: [waiting(ID)], error: null, loading: false }, onResumeArchive } as never);
    fireEvent.click(await screen.findByRole("button", { name: "Подтвердить копию" }));
    expect(await screen.findByRole("heading", { name: "Скопировать архив для открытия" })).toBeTruthy();
  });

  it("two cold archive panels get their questions one after the other; answering one does not push the other away", async () => {
    const both = {
      left: { activeTab: 0, tabs: [{ ...newTab("archive:" + ID, parsePosix("/")) }] },
      right: { activeTab: 0, tabs: [{ ...newTab("archive:" + ID2, parsePosix("/")) }] },
      activePane: "left", layout: "horizontal", split: 0.5,
    } as UiState;
    const cold = { entries: [], loading: false, error: { code: "consent_required", message: "x" } };
    const onResumeArchive = vi.fn(async (id: string, estimateId?: string) =>
      estimateId ? { endpoint: "archive:" + id } : { estimateId: id === ID ? ESTIMATE : "333e4567-e89b-42d3-a456-426614174000", bytesPlanned: id === ID ? "1073741824" : "2147483648" });
    mount({ state: both, directories: { left: cold, right: cold }, onResumeArchive } as never);
    expect(await screen.findByText(/1 ГБ/)).toBeTruthy();
    expect(screen.queryByText(/2 ГБ/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Копировать и открыть" }));
    expect(await screen.findByText(/2 ГБ/)).toBeTruthy();
    await waitFor(() => expect(onResumeArchive).toHaveBeenCalledWith(ID, ESTIMATE));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText(/2 ГБ/)).toBeNull());
  });
});

describe("a file that changed after the estimate", () => {
  it("says to estimate again", async () => {
    const changed = Object.assign(new Error(JSON.stringify({ code: "changed_since_plan", message: "x", retryable: false })), { code: "conflict" });
    mount({ onOpenArchive: vi.fn(async () => { throw changed; }) } as never);
    enterOn(/docs\.zip/);
    expect(await screen.findByText(/Файл изменился — оцените снова/)).toBeTruthy();
  });
});

describe("the password dialog", () => {
  it("is a password field; the answer goes to onPassword with the archive id", async () => {
    const onPassword = vi.fn(async () => undefined);
    mount({ passwordFor: "123e4567-e89b-42d3-a456-426614174000", onPassword, onPasswordCancel: vi.fn() } as never);
    const field = await screen.findByLabelText("Пароль архива");
    expect(field).toHaveProperty("type", "password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(field, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await waitFor(() => expect(onPassword).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000", "s3cret"));
  });

  it("cancel tells the host and shows no password anywhere in the page", async () => {
    const onPasswordCancel = vi.fn();
    mount({ passwordFor: "123e4567-e89b-42d3-a456-426614174000", onPassword: vi.fn(), onPasswordCancel } as never);
    const field = await screen.findByLabelText("Пароль архива");
    fireEvent.change(field, { target: { value: "s3cret" } });
    expect(document.body.textContent).not.toContain("s3cret");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onPasswordCancel).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000");
  });

  it("is absent when no archive asks", () => {
    mount();
    expect(screen.queryByLabelText("Пароль архива")).toBeNull();
  });
});
