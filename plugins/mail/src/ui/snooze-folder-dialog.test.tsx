// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../core/model.ts";
import { SnoozeFolderDialog, snoozeFolderChoices, type SnoozeFolderRequest } from "./snooze-folder-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const folder = (path: string, specialUse: Folder["specialUse"] = null, selectable = true): Folder => ({
  accountId: "acc-1",
  path,
  name: path,
  specialUse,
  selectable,
  unreadCount: 0,
  totalCount: 0,
  subscribed: true,
});
const FOLDERS: Folder[] = [
  folder("INBOX", "inbox"),
  folder("Sent", "sent"),
  folder("Drafts", "drafts"),
  folder("Junk", "junk"),
  folder("Trash", "trash"),
  folder("Archive", "archive"),
  folder("Later"),
  folder("Group", null, false),
];
const ASK: SnoozeFolderRequest = { accountId: "acc-1", accountLabel: "owner@example.org", proposedName: "Snoozed", current: null };

describe("snoozeFolderChoices", () => {
  it("never offers a system folder, the Inbox, a non-selectable one or the current one", () => {
    expect(snoozeFolderChoices(FOLDERS, "acc-1", null).map((f) => f.path)).toEqual(["Archive", "Later"]);
    expect(snoozeFolderChoices(FOLDERS, "acc-1", "Later").map((f) => f.path)).toEqual(["Archive"]);
    expect(snoozeFolderChoices(FOLDERS, "acc-2", null)).toEqual([]);
  });
});

describe("SnoozeFolderDialog", () => {
  it("asks before creating, with the final name and the account", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<SnoozeFolderDialog request={ASK} folders={FOLDERS} onCreate={onCreate} onUse={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Create a folder 'Snoozed' in owner@example.org?" })).toBeTruthy();
    expect(screen.getByText(/comes back to the Inbox at the time you pick/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    });
    expect(onCreate).toHaveBeenCalledWith("acc-1");
  });

  it("Use an existing folder… opens the picker without system folders; a refusal shows its text", async () => {
    const onUse = vi.fn(async () => {
      throw new Error("This folder cannot hold snoozed mail");
    });
    render(<SnoozeFolderDialog request={ASK} folders={FOLDERS} onCreate={vi.fn()} onUse={onUse} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use an existing folder…" }));
    const list = within(screen.getByRole("list", { name: "Folders" }));
    expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual(["Archive", "Later"]);
    await act(async () => {
      fireEvent.click(list.getByRole("button", { name: "Later" }));
    });
    expect(onUse).toHaveBeenCalledWith("acc-1", "Later");
    expect(screen.getByRole("alert").textContent).toBe("This folder cannot hold snoozed mail");
  });

  it("Change… shows the folder in use and only the picker", () => {
    const onCancel = vi.fn();
    render(
      <SnoozeFolderDialog
        request={{ ...ASK, current: "Archive" }}
        folders={FOLDERS}
        onCreate={vi.fn()}
        onUse={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/waits in 'Archive'/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create folder" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Folders" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Later"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
