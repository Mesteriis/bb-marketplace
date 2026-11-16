// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedSearchView } from "../core/index.ts";
import { SavedSearchesRail, savedCount, SaveSearchDialog } from "./saved-searches.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const saved = (overrides: Partial<SavedSearchView> = {}): SavedSearchView => ({
  id: "ss-1",
  name: "Invoices",
  query: "subject:invoice",
  accountId: null,
  unread: 3,
  capped: false,
  ...overrides,
});

describe("SavedSearchesRail", () => {
  it("lists saved searches with unread counts and opens one", () => {
    const onOpen = vi.fn();
    const onMenu = vi.fn();
    render(
      <SavedSearchesRail
        searches={[saved(), saved({ id: "ss-2", name: "Big", unread: 500, capped: true }), saved({ id: "ss-3", name: "Quiet", unread: 0 })]}
        currentId="ss-1"
        onOpen={onOpen}
        onMenu={onMenu}
      />,
    );
    const list = screen.getByRole("list", { name: "Saved searches" });
    expect(within(list).getAllByRole("button", { current: "page" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Invoices 3 unread" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Big 499+ unread" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quiet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invoices 3 unread" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "ss-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Quiet options" }));
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "ss-3" }));
    expect(savedCount({ unread: 0, capped: false })).toBeNull();
  });

  it("renders nothing without saved searches", () => {
    const { container } = render(<SavedSearchesRail searches={[]} currentId={null} onOpen={vi.fn()} onMenu={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SaveSearchDialog", () => {
  it("prefills the name with the query and saves", async () => {
    const onSave = vi.fn(async () => {});
    render(<SaveSearchDialog request={{ kind: "save", query: "from:anna", accountId: "acc-1" }} onSave={onSave} onCancel={vi.fn()} />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("from:anna");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: " Anna " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: "Anna", query: "from:anna", accountId: "acc-1" }));
  });

  it("edits the query of a saved search, keeping its id", async () => {
    const onSave = vi.fn(async () => {});
    render(<SaveSearchDialog request={{ kind: "edit", search: saved() }} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "subject:invoice -in:trash" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ id: "ss-1", name: "Invoices", query: "subject:invoice -in:trash", accountId: null }),
    );
  });

  it("refuses an empty name", () => {
    render(<SaveSearchDialog request={{ kind: "rename", search: saved() }} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Use a name of 1 to 60 characters");
  });
});
