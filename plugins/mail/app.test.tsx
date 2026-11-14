// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Account,
  MessageHeader,
  StatusView,
  ThreadDetail,
  ThreadSummary,
} from "./src/core/index.ts";
import { MAIL_CHANGED_CHANNEL } from "./src/core/index.ts";

afterEach(cleanup);

const app = await loadPluginApp(() => import("./app.tsx"));
const panel = app.navPanels[0]!;

const account: Account = {
  id: "acc-1",
  email: "owner@example.org",
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-14T09:00:00.000Z",
  lastError: null,
  authFailed: false,
};

function status(overrides: Partial<StatusView> = {}): StatusView {
  return {
    vaultReady: true,
    agentTools: false,
    accounts: [account],
    unreadCount: 1,
    ...overrides,
  };
}

const threadA: ThreadSummary = {
  id: "th-a",
  accountId: "acc-1",
  subject: "Quarterly plan",
  lastDate: "2026-11-14T08:30:00.000Z",
  messageCount: 2,
  unreadCount: 1,
  participants: [
    { name: "Ada Example", address: "ada@example.org" },
    { name: null, address: "owner@example.org" },
  ],
  snippet: "Here is the draft we talked about",
};

const threadB: ThreadSummary = {
  id: "th-b",
  accountId: "acc-1",
  subject: "Lunch",
  lastDate: "2026-11-10T12:00:00.000Z",
  messageCount: 1,
  unreadCount: 0,
  participants: [{ name: "Bo Example", address: "bo@example.org" }],
  snippet: "Friday works",
};

function message(overrides: Partial<MessageHeader> & { id: string }): MessageHeader {
  return {
    accountId: "acc-1",
    threadId: "th-a",
    date: "2026-11-13T08:00:00.000Z",
    from: { name: "Ada Example", address: "ada@example.org" },
    subject: "Quarterly plan",
    snippet: "snippet",
    isRead: true,
    isFlagged: false,
    hasAttachments: false,
    to: [{ name: null, address: "owner@example.org" }],
    cc: [],
    attachments: [],
    ...overrides,
  };
}

const detailA: ThreadDetail = {
  thread: threadA,
  messages: [
    message({ id: "m-old", date: "2026-11-13T08:00:00.000Z", isRead: false, snippet: "First note" }),
    message({ id: "m-new", date: "2026-11-14T08:30:00.000Z", isRead: false, snippet: "Here is the draft" }),
  ],
};

function mailRpc(overrides: Record<string, (input: never) => unknown> = {}) {
  return {
    status_get: () => status(),
    threads_list: () => ({ threads: [threadA, threadB], nextCursor: null }),
    thread_get: () => detailA,
    message_body: ({ messageId }: { messageId: string }) => ({
      messageId,
      text: null,
      html: `<p>Body of ${messageId}</p>`,
      htmlTruncated: false,
    }),
    message_open: () => ({ ok: true }),
    ...overrides,
  };
}

function render(rpc: Record<string, unknown>) {
  return renderSlot(panel, { subPath: "" }, {
    rpc: rpc as never,
    composer: { scope: { kind: "new-thread", projectId: null } },
  });
}

function callsTo(slot: ReturnType<typeof render>, method: string) {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

describe("Mail page", () => {
  it("registers the Mail nav panel", () => {
    expect(panel).toMatchObject({ id: "mail", title: "Mail", icon: "Mail", path: "mail" });
  });

  it("shows the configure command when the vault is not ready", async () => {
    const slot = render(mailRpc({ status_get: () => status({ vaultReady: false, accounts: [] }) }));

    expect(
      await slot.findByText(/bb plugin config makosh-mail set vaultKey/),
    ).toBeTruthy();
    expect(callsTo(slot, "threads_list")).toHaveLength(0);
  });

  it("shows the account form when there are no accounts", async () => {
    const slot = render(mailRpc({ status_get: () => status({ accounts: [], unreadCount: 0 }) }));

    expect(await slot.findByLabelText("Email")).toBeTruthy();
    const password = slot.getByLabelText("App password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(slot.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("tests and saves an account, then clears the password", async () => {
    const slot = render(
      mailRpc({
        status_get: () => status({ accounts: [], unreadCount: 0 }),
        accounts_test: () => ({ ok: false, reason: "Server refused the login" }),
        accounts_add: () => account,
      }),
    );

    fireEvent.change(await slot.findByLabelText("Email"), {
      target: { value: "owner@example.org" },
    });
    const password = slot.getByLabelText("App password") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "app-secret-1" } });

    fireEvent.click(slot.getByRole("button", { name: "Test" }));
    expect(await slot.findByText("Server refused the login")).toBeTruthy();
    expect(callsTo(slot, "accounts_test")[0]?.input).toEqual({
      preset: "icloud",
      email: "owner@example.org",
      password: "app-secret-1",
    });

    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(slot, "accounts_add")).toHaveLength(1));
    await waitFor(() => expect(password.value).toBe(""));
    expect(slot.container.innerHTML).not.toContain("app-secret-1");
  });

  it("lists threads and opens one", async () => {
    const slot = render(mailRpc());

    expect(await slot.findByText("Lunch")).toBeTruthy();
    const row = await slot.findByRole("button", { name: /Quarterly plan/ });
    expect(callsTo(slot, "threads_list")[0]?.input).toMatchObject({ accountId: "acc-1", cursor: null });

    fireEvent.click(row);

    await waitFor(() => expect(callsTo(slot, "thread_get")).toHaveLength(1));
    expect(callsTo(slot, "thread_get")[0]?.input).toEqual({ threadId: "th-a" });
    expect(await slot.findByRole("heading", { name: "Quarterly plan" })).toBeTruthy();
    await waitFor(() =>
      expect(callsTo(slot, "message_body").map((call) => call.input)).toEqual([{ messageId: "m-new" }]),
    );
  });

  it("message frame has sandbox allow-same-origin and no allow-scripts", async () => {
    const slot = render(mailRpc());

    fireEvent.click(await slot.findByRole("button", { name: /Quarterly plan/ }));
    const frame = (await slot.findByTitle("Message from Ada Example")) as HTMLIFrameElement;

    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("Body of m-new");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("opening a message calls message_open", async () => {
    const slot = render(mailRpc());

    fireEvent.click(await slot.findByRole("button", { name: /Quarterly plan/ }));
    await waitFor(() =>
      expect(callsTo(slot, "message_open").map((call) => call.input)).toEqual([{ messageId: "m-new" }]),
    );

    fireEvent.click(await slot.findByRole("button", { name: /First note/ }));

    await waitFor(() =>
      expect(callsTo(slot, "message_open").map((call) => call.input)).toEqual([
        { messageId: "m-new" },
        { messageId: "m-old" },
      ]),
    );
    expect(callsTo(slot, "message_body").map((call) => call.input)).toEqual([
      { messageId: "m-new" },
      { messageId: "m-old" },
    ]);
  });

  it("hands a message to the agent as a mail mention", async () => {
    const slot = render(mailRpc());

    fireEvent.click(await slot.findByRole("button", { name: /Quarterly plan/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Hand to agent" }));

    expect(slot.inspection.composer.draft.mentions).toEqual([
      expect.objectContaining({ kind: "plugin", provider: "mail", id: "m-new", label: "Quarterly plan" }),
    ]);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: { focusPrompt: true },
    });
  });

  it("falls back to a prompt when the composer is not the new-thread draft", async () => {
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: mailRpc() as never,
      composer: { scope: { kind: "thread", threadId: "t-1" } },
    });

    fireEvent.click(await slot.findByRole("button", { name: /Quarterly plan/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Hand to agent" }));

    expect(slot.inspection.composer.draft.mentions).toEqual([]);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: {
        initialPrompt: "Read this email (Makosh Mail message m-new) and help me with it.",
        focusPrompt: true,
      },
    });
  });

  it("refetches the status and the list on mail-changed, not the open body", async () => {
    const slot = render(mailRpc());

    fireEvent.click(await slot.findByRole("button", { name: /Quarterly plan/ }));
    await waitFor(() => expect(callsTo(slot, "message_body")).toHaveLength(1));
    const statusBefore = callsTo(slot, "status_get").length;
    const listBefore = callsTo(slot, "threads_list").length;

    await slot.behavior.emitRealtime(MAIL_CHANGED_CHANNEL, { accountId: "acc-1" });

    await waitFor(() => expect(callsTo(slot, "status_get").length).toBe(statusBefore + 1));
    await waitFor(() => expect(callsTo(slot, "threads_list").length).toBe(listBefore + 1));
    expect(callsTo(slot, "message_body")).toHaveLength(1);

    await slot.behavior.emitRealtime(MAIL_CHANGED_CHANNEL, { accountId: "acc-other" });
    expect(callsTo(slot, "threads_list").length).toBe(listBefore + 1);
  });

  it("shows the account's last error", async () => {
    const slot = render(
      mailRpc({
        status_get: () => status({ accounts: [{ ...account, lastError: "Connection timed out" }] }),
      }),
    );

    expect(await slot.findByText("Connection timed out")).toBeTruthy();
  });
});
