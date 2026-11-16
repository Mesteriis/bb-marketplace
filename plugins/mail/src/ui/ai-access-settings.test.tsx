// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AiScopeView, Folder } from "../core/model.ts";
import { AiAccessSettings, GMAIL_SCOPE_NOTE, SPAM_TRASH_LINE, senderOf } from "./ai-access-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);
const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

const account = (id: string, preset: Account["preset"]): Account => ({
  id,
  email: `${id}@example.org`,
  displayName: null,
  preset,
  host: "imap.example.org",
  port: 993,
  username: `${id}@example.org`,
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: false,
});
const folder = (accountId: string, path: string, specialUse: Folder["specialUse"] = null): Folder => ({
  accountId,
  path,
  name: path,
  specialUse,
  selectable: true,
  unreadCount: 0,
  totalCount: 0,
});

const VIEW: AiScopeView = {
  accounts: [{ accountId: "work", mode: "folders", folders: [{ path: "INBOX", found: true }, { path: "Old", found: false }] }],
  senders: [{ kind: "domain", value: "bank.example.com" }],
};

function mount(view: AiScopeView = VIEW) {
  const props = {
    load: vi.fn(async () => view),
    save: vi.fn(async (input: unknown) => {
      void input;
      return view;
    }),
    folders: vi.fn(async (accountId: string) => [
      folder(accountId, "INBOX", "inbox"),
      folder(accountId, "Projects"),
      folder(accountId, "Junk", "junk"),
      folder(accountId, "Trash", "trash"),
    ]),
  };
  render(<AiAccessSettings accounts={[account("work", "other"), account("home", "gmail")]} {...props} />);
  return props;
}

describe("AiAccessSettings", () => {
  it("shows modes, the picker without Spam and Trash, stale paths and the notes", async () => {
    mount();
    expect(await screen.findByText(SPAM_TRASH_LINE)).toBeTruthy();
    const work = screen.getByRole("region", { name: "work@example.org" });
    const picker = await within(work).findByRole("list", { name: "Folders shared with AI" });
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(picker).queryByText("Junk")).toBeNull();
    expect(within(work).getByText("Old")).toBeTruthy();
    expect(within(work).getByText("not found")).toBeTruthy();
    const home = screen.getByRole("region", { name: "home@example.org" });
    expect(within(home).getByText(GMAIL_SCOPE_NOTE)).toBeTruthy();
    expect(within(work).queryByText(GMAIL_SCOPE_NOTE)).toBeNull();
  });

  it("saves the modes, the chosen folders and the senders", async () => {
    const props = mount();
    const work = await screen.findByRole("region", { name: "work@example.org" });
    const picker = await within(work).findByRole("list", { name: "Folders shared with AI" });
    fireEvent.click(within(picker).getAllByRole("checkbox")[1]!);
    fireEvent.click(within(work).getByRole("button", { name: "Remove" }));
    fireEvent.change(screen.getByLabelText("Address or domain"), { target: { value: "Ada@Example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.save).toHaveBeenCalled());
    expect(props.save.mock.calls[0]![0]).toEqual({
      accounts: [
        { accountId: "work", mode: "folders", folders: ["INBOX", "Projects"] },
        { accountId: "home", mode: "all" },
      ],
      senders: [
        { kind: "domain", value: "bank.example.com" },
        { kind: "address", value: "ada@example.org" },
      ],
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("a refusal is shown; senders parse as address or domain", async () => {
    const props = mount();
    props.save.mockRejectedValueOnce(new Error("Not a valid domain"));
    await screen.findByText(SPAM_TRASH_LINE);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not a valid domain");
    expect(senderOf("example.com")).toEqual({ kind: "domain", value: "example.com" });
    expect(senderOf("a@b.example")).toEqual({ kind: "address", value: "a@b.example" });
    expect(senderOf("not valid")).toBeNull();
    expect(senderOf("nodot")).toBeNull();
  });
});
