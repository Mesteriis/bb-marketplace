// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder } from "../core/index.ts";
import { MOVE_TYPE } from "./drag-move.ts";
import { folderMenuEntries, MailSidebar, type MailSidebarState, type RailCommand } from "./mail-sidebar.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const account: Account = {
  id: "acc-1",
  email: "owner@example.org",
  displayName: null,
  preset: "gmail",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-14T09:00:00.000Z",
  lastError: null,
  authFailed: false,
  smtpConfigured: false,
};

const folder = (path: string, overrides: Partial<Folder> = {}): Folder => ({
  accountId: "acc-1",
  path,
  name: path,
  specialUse: null,
  selectable: true,
  unreadCount: 0,
  totalCount: 0,
  subscribed: true,
  ...overrides,
});

const FOLDERS = [
  folder("INBOX", { specialUse: "inbox", name: "Inbox" }),
  folder("Trash", { specialUse: "trash" }),
  folder("Projects"),
  folder("Old stuff", { subscribed: false }),
];

function state(overrides: Partial<MailSidebarState> = {}): MailSidebarState {
  return {
    vaultReady: true,
    accounts: [account],
    unified: false,
    account,
    folders: FOLDERS,
    roles: [],
    foldersError: null,
    view: { kind: "folder", accountId: "acc-1", path: "INBOX" },
    outbox: [],
    pages: { today: null, tasks: null, current: null, files: true },
    saved: { searches: [{ id: "ss-1", name: "Invoices", query: "subject:invoice", accountId: null, unread: 2, capped: false }], currentId: null },
    grouped: () => true,
    dragAccounts: null,
    gmailAccounts: ["acc-1"],
    ...overrides,
  };
}

function setup(overrides: Partial<MailSidebarState> = {}) {
  const commands: RailCommand[] = [];
  const onSelectPage = vi.fn();
  render(
    <MailSidebar
      state={state(overrides)}
      onCompose={vi.fn()}
      onSelectAccount={vi.fn()}
      onSelectView={vi.fn()}
      onSelectPage={onSelectPage}
      onRailCommand={(command) => commands.push(command)}
    />,
  );
  return { commands, onSelectPage };
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!;
}

function drop(target: HTMLElement, data: Record<string, string>) {
  const types = Object.keys(data);
  const dataTransfer = { types, getData: (type: string) => data[type] ?? "", dropEffect: "none" };
  const over = createEvent.dragOver(target);
  Object.defineProperty(over, "dataTransfer", { value: dataTransfer });
  fireEvent(target, over);
  const event = createEvent.drop(target);
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(target, event);
  return over;
}

describe("MailSidebar slice 3h", () => {
  it("shows Files and the Saved section", () => {
    const { commands, onSelectPage } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onSelectPage).toHaveBeenCalledWith("files");
    fireEvent.click(screen.getByRole("button", { name: "Invoices 2 unread" }));
    expect(commands).toEqual([{ kind: "saved_open", id: "ss-1" }]);
  });

  it("puts unsubscribed folders under More folders", () => {
    setup();
    expect(screen.queryByRole("button", { name: /^Old stuff/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More folders (1)" }));
    expect(screen.getByRole("button", { name: /^Old stuff/ })).toBeTruthy();
  });

  it("a folder's menu sends its commands; a Gmail label says Delete label", () => {
    const { commands } = setup();
    fireEvent.click(within(rowOf("Projects")).getByRole("button", { name: "Folder options" }));
    const menu = screen.getByRole("dialog");
    expect(within(menu).getByRole("button", { name: "Delete label\u2026" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Rename\u2026" }));
    expect(commands.at(-1)).toEqual({ kind: "folder_rename", accountId: "acc-1", path: "Projects" });
    fireEvent.click(within(rowOf("Projects")).getByRole("button", { name: "Folder options" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Subscribed" }));
    expect(commands.at(-1)).toEqual({ kind: "folder_subscribe", accountId: "acc-1", path: "Projects", subscribed: false });
  });

  it("system folders offer no rename or delete", () => {
    const entries = folderMenuEntries(FOLDERS[0]!, true, false).map((e) => e.id);
    expect(entries).toEqual(["new", "subscribe", "grouping", "forget"]);
    expect(folderMenuEntries(FOLDERS[2]!, false, false).find((e) => e.id === "grouping")).toMatchObject({ checked: false });
  });

  it("the account menu offers New folder", () => {
    const { commands } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "New folder\u2026" }));
    expect(commands).toEqual([{ kind: "folder_new", accountId: "acc-1", parent: null }]);
  });

  it("a folder takes a drop of the private type only", () => {
    const { commands } = setup();
    drop(rowOf("Projects"), { "text/plain": "3 conversations" });
    expect(commands).toEqual([]);
    const over = drop(rowOf("Projects"), { [MOVE_TYPE]: "payload", "text/plain": "1 conversation" });
    expect(over.defaultPrevented).toBe(true);
    expect(commands).toEqual([{ kind: "drop", accountId: "acc-1", path: "Projects", raw: "payload" }]);
  });

  it("another account's folder does not take the drag", () => {
    const { commands } = setup({ dragAccounts: ["acc-2"] });
    const over = drop(rowOf("Projects"), { [MOVE_TYPE]: "payload" });
    expect(over.defaultPrevented).toBe(false);
    expect(commands).toEqual([]);
  });
});
