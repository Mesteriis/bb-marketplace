// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilterInput, FilterView } from "../core/contract.ts";
import type { Account, Folder } from "../core/model.ts";
import { FiltersSettings, filterActionsText, filterMatchText, type SettingsFilterPorts } from "./filters-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

// Radix's checkbox measures itself inside a <form>; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const account = (id: string, email: string): Account => ({
  id,
  email,
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: email,
  createdAt: "2026-11-16T08:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: true,
});
const ACCOUNTS = [account("acc_1", "owner@example.org"), account("acc_2", "second@example.net")];

const folder = (path: string, specialUse: Folder["specialUse"] = null, selectable = true): Folder => ({
  accountId: "acc_1",
  path,
  name: path,
  specialUse,
  selectable,
  unreadCount: 0,
  totalCount: 0,
  subscribed: true,
});

const FILTER: FilterView = {
  id: "flt_1",
  name: "Invented newsletters",
  enabled: true,
  match: { domains: ["news.example.com"], accounts: ["acc_1"] },
  actions: { move: "folder", folder: "Lists", markRead: true, flag: false },
};

function fakePorts(initial: FilterView[] = []) {
  let filters = [...initial];
  const ports = {
    list: vi.fn(async () => filters),
    save: vi.fn(async (input: FilterInput) => {
      const saved = { ...input, id: input.id ?? `flt_${filters.length + 1}` } as FilterView;
      filters = filters.some((f) => f.id === saved.id) ? filters.map((f) => (f.id === saved.id ? saved : f)) : [...filters, saved];
    }),
    remove: vi.fn(async (id: string) => {
      filters = filters.filter((f) => f.id !== id);
    }),
    folders: vi.fn(async () => [folder("INBOX", "inbox"), folder("Lists"), folder("Work/Reports"), folder("[Gmail]", null, false)]),
  } satisfies SettingsFilterPorts;
  return ports;
}

describe("FiltersSettings (slice 3m)", () => {
  it("lists filters in order with what they match and do; turns one off and deletes it", async () => {
    const ports = fakePorts([FILTER, { ...FILTER, id: "flt_2", name: "Invoices", match: { subjectWords: ["invoice"] }, actions: { move: "archive", folder: null, markRead: false, flag: true } }]);
    render(<FiltersSettings ports={ports} accounts={ACCOUNTS} />);
    const items = within(await screen.findByRole("list", { name: "Mail filters" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("span span")?.textContent)).toEqual(["Invented newsletters", "Invoices"]);
    expect(items[0]!.textContent).toContain("from the domain news.example.com; in owner@example.org \u2192 move to Lists, mark read");
    expect(items[1]!.textContent).toContain("subject has invoice \u2192 archive, flag");
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(ports.save).toHaveBeenCalledWith({ ...FILTER, enabled: false }));
    expect(await screen.findByText("Off")).toBeTruthy();
    fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(ports.remove).toHaveBeenCalledWith("flt_2"));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });

  it("a new filter: the form checks it, offers the account's folders without the Inbox, and saves", async () => {
    const ports = fakePorts();
    render(<FiltersSettings ports={ports} accounts={ACCOUNTS} />);
    expect(await screen.findByText("No filters yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New filter" }));
    const form = screen.getByRole("form", { name: "New filter" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Reports" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("A filter needs a sender, domain, list or subject words to match");
    fireEvent.change(within(form).getByLabelText("From addresses"), { target: { value: "Reports@Example.com, ana@example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("A filter needs something to do");

    fireEvent.change(within(form).getByLabelText("Move"), { target: { value: "folder" } });
    expect(within(form).getByText("Choose one account above: folders belong to an account.")).toBeTruthy();
    expect(ports.folders).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Account"), { target: { value: "acc_1" } });
    const select = (await within(form).findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options, (o) => o.value)).toEqual(["", "Lists", "Work/Reports"]));
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Choose a folder to move to");
    fireEvent.change(select, { target: { value: "Work/Reports" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: "Flag" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    await waitFor(() =>
      expect(ports.save).toHaveBeenCalledWith({
        name: "Reports",
        enabled: true,
        match: { from: ["Reports@Example.com", "ana@example.com"], domains: [], list: null, subjectWords: [], accounts: ["acc_1"] },
        actions: { move: "folder", folder: "Work/Reports", markRead: false, flag: true },
      }),
    );
    expect(await screen.findByRole("list", { name: "Mail filters" })).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("editing keeps the id and the on/off state, and shows a refusal from the server", async () => {
    const ports = fakePorts([{ ...FILTER, enabled: false }]);
    ports.save.mockRejectedValueOnce(new Error("Choose a folder of the chosen account to move to"));
    render(<FiltersSettings ports={ports} accounts={ACCOUNTS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit Invented newsletters" });
    expect((within(form).getByLabelText("Sender domains") as HTMLInputElement).value).toBe("news.example.com");
    const folderSelect = (await within(form).findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(folderSelect.value).toBe("Lists"));
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Choose a folder of the chosen account to move to");
    fireEvent.click(within(form).getByRole("button", { name: "Save filter" }));
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(2));
    expect(ports.save.mock.calls[1]![0]).toMatchObject({ id: "flt_1", enabled: false, actions: FILTER.actions });
  });
});

describe("filter texts", () => {
  it("say what a filter matches and does", () => {
    expect(filterActionsText({ move: "trash", folder: null, markRead: true, flag: true })).toBe("move to Trash, mark read, flag");
    expect(filterMatchText({ from: ["ana@example.com"], list: "updates.example.com", accounts: ["acc_2", "gone"] }, ACCOUNTS)).toBe(
      "from ana@example.com; list updates.example.com; in second@example.net",
    );
  });
});
