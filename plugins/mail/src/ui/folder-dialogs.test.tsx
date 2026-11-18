// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeleteFolderDialog,
  deletePlan,
  FolderNameDialog,
  folderRefusalText,
  MOVE_NOT_UNDO_TEXT,
} from "./folder-dialogs.tsx";
import { forgetText, HistoryForgetDialog } from "./history-forget-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const REQUEST = { accountId: "acc-1", path: "Receipts 2019", name: "Receipts 2019" };

describe("deletePlan", () => {
  it("says what each check means", () => {
    expect(deletePlan("Receipts 2019", { messages: 0, children: 0, gmailLabel: false, refusal: null })).toEqual({
      kind: "empty",
      text: "Delete Receipts 2019? It is empty.",
    });
    expect(deletePlan("Receipts 2019", { messages: 41, children: 0, gmailLabel: false, refusal: null })).toEqual({
      kind: "move",
      messages: 41,
      text: "Receipts 2019 has 41 messages. Move them to Trash first?",
    });
    expect(deletePlan("Receipts", { messages: 41, children: 0, gmailLabel: true, refusal: null })).toEqual({
      kind: "gmail",
      messages: 41,
      text: "Delete the label Receipts? It is removed from 41 messages. The messages stay in All Mail and keep their other labels.",
    });
    expect(deletePlan("X", { messages: 3, children: 2, gmailLabel: false, refusal: "has_children" })).toEqual({
      kind: "refused",
      text: "Delete its subfolders first",
    });
  });

  it("has the refusal texts", () => {
    expect(folderRefusalText("inbox", "delete")).toBe("Inbox and system folders cannot be deleted");
    expect(folderRefusalText("special_use", "delete")).toBe("Inbox and system folders cannot be deleted");
    expect(folderRefusalText("special_use", "rename")).toBe("Inbox and system folders cannot be renamed");
    expect(folderRefusalText("has_children", "delete")).toBe("Delete its subfolders first");
  });
});

describe("DeleteFolderDialog", () => {
  it("waits for the check, then deletes an empty folder", async () => {
    const onDelete = vi.fn(async () => {});
    const { rerender } = render(
      <DeleteFolderDialog request={REQUEST} check={null} checkError={null} onDelete={onDelete} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Checking the folder on the server\u2026");
    rerender(
      <DeleteFolderDialog
        request={REQUEST}
        check={{ messages: 0, children: 0, gmailLabel: false, refusal: null }}
        checkError={null}
        onDelete={onDelete}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith({ moveToTrash: false, expectedMessages: 0 }));
  });

  it("offers the move step with the count and the non-undo note", async () => {
    const onDelete = vi.fn(() => Promise.reject(new Error("New mail arrived in the folder; it was not deleted")));
    render(
      <DeleteFolderDialog
        request={REQUEST}
        check={{ messages: 41, children: 0, gmailLabel: false, refusal: null }}
        checkError={null}
        onDelete={onDelete}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(MOVE_NOT_UNDO_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 41 to Trash, then delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith({ moveToTrash: true, expectedMessages: 41 }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("New mail arrived in the folder; it was not deleted"),
    );
  });

  it("deletes a Gmail label without moving mail", async () => {
    const onDelete = vi.fn(async () => {});
    render(
      <DeleteFolderDialog
        request={{ ...REQUEST, path: "Receipts", name: "Receipts" }}
        check={{ messages: 41, children: 0, gmailLabel: true, refusal: null }}
        checkError={null}
        onDelete={onDelete}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/The messages stay in All Mail and keep their other labels\./)).toBeTruthy();
    expect(screen.queryByText(MOVE_NOT_UNDO_TEXT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete label" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith({ moveToTrash: false, expectedMessages: 41 }));
  });

  it("shows a refusal with no delete button", () => {
    render(
      <DeleteFolderDialog
        request={REQUEST}
        check={{ messages: 0, children: 0, gmailLabel: false, refusal: "inbox" }}
        checkError={null}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Inbox and system folders cannot be deleted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});

describe("FolderNameDialog", () => {
  it("creates a subfolder with a trimmed, checked name", async () => {
    const onCreate = vi.fn(async () => {});
    render(
      <FolderNameDialog
        request={{ kind: "create", accountId: "acc-1", accountLabel: "owner@example.org", parent: { path: "Projects", name: "Projects" }, siblings: ["Alpha"] }}
        onCreate={onCreate}
        onRename={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("New subfolder")).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Folder name" });
    fireEvent.change(box, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert").textContent).toBe("A folder with that name is already here");
    fireEvent.change(box, { target: { value: "inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert").textContent).toBe("That name is reserved");
    fireEvent.change(box, { target: { value: "  Beta  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("acc-1", "Projects", "Beta"));
  });

  it("renames and shows the server's refusal", async () => {
    const onRename = vi.fn(() => Promise.reject(new Error("That name is used for system folders")));
    render(
      <FolderNameDialog
        request={{ kind: "rename", accountId: "acc-1", path: "Old", name: "Old", siblings: ["Old", "Other"] }}
        onCreate={vi.fn()}
        onRename={onRename}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Sent Items" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("acc-1", "Old", "Sent Items"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That name is used for system folders"));
  });
});

describe("HistoryForgetDialog", () => {
  it("shows the count first and forgets on confirm", async () => {
    const onConfirm = vi.fn(async () => {});
    const request = { accountId: "acc-1", folder: "INBOX", name: "Inbox" };
    const { rerender } = render(
      <HistoryForgetDialog request={request} count={null} error={null} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    expect((screen.getByRole("button", { name: "Forget" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<HistoryForgetDialog request={request} count={340} error={null} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByText(forgetText(340))).toBeTruthy();
    expect(forgetText(340)).toBe("Removes 340 messages older than the sync window from Mail. Nothing changes on the server.");
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  });
});
