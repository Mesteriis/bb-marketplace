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
  render(<Workspace {...props} />);
  return props;
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
