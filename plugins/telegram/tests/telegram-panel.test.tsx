// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, test, vi } from "vitest";
import type { connectTdJson, TdObject } from "../src/adapters/bb/tdjson.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";
import { downloadActivityChannel, downloadProgressChannel, type DownloadQueueSnapshot } from "../src/core/contract.ts";

test.each([
  { mainPosition: 1, navigate: false, selected: "Fixture.default" },
  { mainPosition: 1, navigate: true, selected: "Archive" },
  { mainPosition: 0, navigate: false, selected: "All chats" },
])("uses $selected with Telegram's main list at $mainPosition and navigation set to $navigate", async ({ mainPosition, navigate, selected }) => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram")!;
  const layout = { folders: [{ id: 17, title: "Fixture.default" }], mainPosition };
  let finishLayout!: (result: typeof layout) => void;
  const request = new Promise<typeof layout>((resolve) => { finishLayout = resolve; });
  const folderLayout = vi.fn(() => request);
  const view = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready" }),
    folderLayout,
    chatPage: () => ({ chats: [], nextOffset: null }),
  } });
  try {
    const archive = await view.findByRole("button", { name: "Archive" });
    await waitFor(() => expect(folderLayout).toHaveBeenCalledOnce());
    if (navigate) fireEvent.click(archive);
    await act(async () => finishLayout(layout));
    await view.findByRole("button", { name: "Fixture.default" });
    expect(view.getByRole("button", { name: selected }).getAttribute("aria-pressed")).toBe("true");
  } finally {
    finishLayout(layout);
    view.lifecycle.unmount();
  }
});

test("keeps the restored folder when the first folder layout arrives before Telegram's order", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram")!;
  const navigationScope = "a".repeat(64);
  const key = `makosh.telegram.conversation.${navigationScope}`;
  localStorage.setItem(key, JSON.stringify({ id: "42", list: 17 }));
  let finishLayout!: (result: { folders: [] }) => void;
  const layout = new Promise<{ folders: [] }>((resolve) => { finishLayout = resolve; });
  const chatPage = vi.fn(async (_input: unknown) => ({ chats: [], nextOffset: null }));
  const chat = { initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [], id: "42", name: "Restored folder chat" };
  const view = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready", navigationScope }),
    folderLayout: () => layout,
    resumeConversation: () => ({ chat, list: 17 }),
    chatPage,
    history: () => ({ before: null, messages: [] }),
  } });
  try {
    await view.findByRole("heading", { name: chat.name });
    await waitFor(() => expect(chatPage).toHaveBeenLastCalledWith({ list: 17, offset: 0 }));
    await act(async () => finishLayout({ folders: [] }));
    expect(chatPage).toHaveBeenLastCalledWith({ list: 17, offset: 0 });
  } finally {
    finishLayout({ folders: [] });
    view.lifecycle.unmount();
    localStorage.removeItem(key);
  }
});

test("refreshes the badge of a chat retained from a later sidebar page", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram")!;
  const base = { initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] };
  const latest = { ...base, id: "41", name: "First page fixture" };
  const target = { ...base, id: "42", name: "Later page fixture" };
  const loadChat = vi.fn(async () => target);
  const mark = vi.fn(async () => true);
  const observers = new Map<Element, IntersectionObserverCallback>();
  class Observer {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(row: Element) { observers.set(row, this.callback); }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const view = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready" }),
    chatPage: (input) => (input as { offset: number }).offset === 0
      ? { chats: [latest], nextOffset: 1 } : { chats: [{ ...target, unread: 1 }], nextOffset: null },
    unreadHistory: () => ({ before: null, readInbox: 49, unreadCount: 1, messages: [
      { id: "50", author: "Fixture", time: "", text: "Unread later-page fixture" },
    ] }),
    markHistoryRead: mark,
    notificationChat: loadChat,
  } });
  try {
    const reveal = async (row: Element) => {
      const rect = row.getBoundingClientRect();
      await act(async () => observers.get(row)!([{ target: row, isIntersecting: true, intersectionRatio: 1,
        boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0 }], {} as IntersectionObserver));
    };
    const sentinel = await waitFor(() => {
      const row = view.container.querySelector(".mtg-chats .mtg-history-more");
      expect(row && observers.has(row)).toBe(true);
      return row!;
    });
    await reveal(sentinel);
    const button = await view.findByRole("button", { name: /Later page fixture/ });
    expect(button.querySelector('[aria-label="1 unread"]')).toBeTruthy();
    fireEvent.click(button);
    const row = (await within(view.getByRole("list", { name: "Messages" }))
      .findByText("Unread later-page fixture")).closest("li")!;
    await reveal(row);
    await waitFor(() => expect(mark).toHaveBeenCalledExactlyOnceWith({ id: "42", messageId: "50" }));
    expect(loadChat).toHaveBeenCalledExactlyOnceWith({ id: "42" });
    await waitFor(() => expect(view.getByRole("button", { name: /Later page fixture/ }).querySelector('[aria-label="1 unread"]')).toBeNull());
    await view.behavior.emitRealtime("telegram-chat-changed", {});
    expect(view.getByRole("button", { name: /Later page fixture/ }).querySelector('[aria-label="1 unread"]')).toBeNull();
  } finally {
    view.lifecycle.unmount();
    visibility.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("opens downloads from the rail and keeps the latest counts for the active account", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram")!;
  const connectionId = "00000000-0000-4000-8000-000000000001";
  let finishBootstrap!: (counts: DownloadQueueSnapshot) => void;
  const bootstrap = new Promise<DownloadQueueSnapshot>((resolve) => { finishBootstrap = resolve; });
  const queue = vi.fn(async () => ({ entries: [], next: null }));
  const view = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready", connectionId }),
    sessionRpc: (input) => {
      const { method } = input as { method: string };
      if (method === "downloadCounts") return bootstrap;
      if (method === "downloadQueue") return queue();
      if (method === "folderLayout") return { folders: [] };
      if (method === "chatPage") return { chats: [], nextOffset: null };
      return null;
    },
  } });
  try {
    const button = await view.findByRole("button", { name: "Downloads" });
    const staleConnection = "00000000-0000-4000-8000-000000000002";
    await view.behavior.emitRealtime(downloadActivityChannel, { connectionId: staleConnection, counts: { active: 9, paused: 0, completed: 0 } });
    await view.behavior.emitRealtime(downloadProgressChannel, { connectionId: staleConnection, progress: { totalBytes: 4096, downloadedBytes: 1 } });
    expect(button.getAttribute("aria-description")).toBeNull();
    expect(view.queryByRole("progressbar", { name: "Download progress" })).toBeNull();
    await view.behavior.emitRealtime(downloadActivityChannel, { connectionId, counts: { active: 2, paused: 1, completed: 0 } });
    await waitFor(() => expect(button.getAttribute("aria-description")).toBe("2 unfinished, 1 paused, 0 completed"));
    await view.behavior.emitRealtime(downloadProgressChannel, { connectionId, progress: { totalBytes: 4096, downloadedBytes: 2048 } });
    const progress = await view.findByRole("progressbar", { name: "Download progress" });
    expect(progress.getAttribute("value")).toBe("2048");
    await act(async () => finishBootstrap({ active: 0, paused: 0, completed: 0, progress: { totalBytes: 4096, downloadedBytes: 1024 } }));
    expect(button.getAttribute("aria-description")).toBe("2 unfinished, 1 paused, 0 completed");
    expect(progress.getAttribute("value")).toBe("2048");
    const dialog = view.container.querySelector<HTMLDialogElement>('dialog[aria-label="Telegram downloads"]')!;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event("close")); };
    fireEvent.click(button);
    expect(await within(dialog).findByText("No downloads on this page.")).toBeTruthy();
    expect(queue).toHaveBeenCalledOnce();
    await view.behavior.emitRealtime(downloadProgressChannel, { connectionId, progress: { totalBytes: 4096, downloadedBytes: 3072 } });
    expect(progress.getAttribute("value")).toBe("3072");
    expect(queue).toHaveBeenCalledOnce();
    await view.behavior.emitRealtime(downloadActivityChannel, { connectionId, counts: { active: 0, paused: 0, completed: 2 } });
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    expect(button.querySelector("[data-completed]")?.textContent).toBe("2");
    expect(view.queryByRole("progressbar", { name: "Download progress" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close downloads" }));
    expect(document.activeElement).toBe(button);
  } finally {
    finishBootstrap({ active: 0, paused: 0, completed: 0 });
    view.lifecycle.unmount();
  }
});

test("keeps a new QR visible after a stale status poll and signs in through BB", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  let resolveInitialStatus!: (value: { state: "error"; message: string }) => void;
  let releaseStatus!: (value: { state: "idle" }) => void;
  const status = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveInitialStatus = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { releaseStatus = resolve; }))
    .mockResolvedValue({ state: "password" });
  const password = vi.fn()
    .mockRejectedValueOnce(new Error("Wrong fixture password"))
    .mockResolvedValueOnce({ state: "ready" });
  const page = renderSlot(panel, { subPath: "" }, { rpc: {
    status,
    connect: () => ({ state: "qr", link: "tg://login?token=fixture" }),
    password,
    folders: () => [],
    chatPage: () => ({
      chats: [{ id: "42", name: "Chat fixture", initials: "CF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      nextOffset: null,
    }),
  } });
  try {
    await waitFor(() => expect(status).toHaveBeenCalledOnce());
    expect(page.getByRole("status").textContent).toContain("Checking Telegram connection");
    expect(page.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
    await act(async () => resolveInitialStatus({ state: "error", message: "Fixture retry required" }));
    expect(page.queryByRole("button", { name: "Open demo" })).toBeNull();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2), { timeout: 2500 });
    fireEvent.click(page.getByRole("button", { name: "Connect Telegram" }));
    await page.findByRole("img", { name: "Telegram sign-in QR code" });
    await act(async () => releaseStatus({ state: "idle" }));
    expect(page.getByRole("img", { name: "Telegram sign-in QR code" })).toBeTruthy();
    const field = await page.findByLabelText("Telegram two-step verification password", {}, { timeout: 2500 }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "wrong fixture" } });
    fireEvent.click(page.getByRole("button", { name: "Unlock" }));
    await page.findByText("Telegram did not accept the password. Try again.");
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "correct fixture" } });
    fireEvent.click(page.getByRole("button", { name: "Unlock" }));
    await page.findByRole("button", { name: /Chat fixture/ });
    expect(password).toHaveBeenNthCalledWith(2, { password: "correct fixture" });
  } finally { page.lifecycle.unmount(); }
});

test("opens the QR on first entry and leaves the connection stopped after cancel", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram")!;
  const connect = vi.fn(() => ({ state: "qr", link: "tg://login?token=fixture" }));
  const disconnect = vi.fn(() => ({ state: "idle" }));
  const status = vi.fn(() => ({ state: "idle" }));
  const page = renderSlot(panel, { subPath: "" }, { rpc: { status, connect, disconnect } });
  try {
    expect(await page.findByRole("img", { name: "Telegram sign-in QR code" })).toBeTruthy();
    expect(connect).toHaveBeenCalledOnce();
    expect(page.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
    fireEvent.click(page.getByRole("button", { name: "Cancel connection" }));
    expect(await page.findByRole("button", { name: "Connect Telegram" })).toBeTruthy();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally { page.lifecycle.unmount(); }
});

test("submits a manual reply through the Telegram panel with both agent tools disabled", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  let confirmDelivery!: (response: TdObject) => void;
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Saved fixture",
        type: { "@type": "chatTypePrivate" } };
      case "getChatHistory": return { "@type": "messages", messages: [{
        "@type": "message", id: 12, chat_id: 42,
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Parent fixture" } },
      }] };
      case "getMessage": return { "@type": "message", id: query.message_id, chat_id: query.chat_id };
      case "sendMessage": return new Promise((resolve) => { confirmDelivery = resolve; });
      default: throw new Error("Unexpected TDLib fixture call");
    }
  });
  const open: typeof connectTdJson = () => ({ request, close: async () => {} });
  const session = createTelegram({ library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  await waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const page = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => session.status(),
    folders: () => [],
    agentAccess: () => ({ read: false, send: false, history: false }),
    chatPage: () => ({
      chats: [{ id: "42", name: "Saved fixture", initials: "SF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      nextOffset: null,
    }),
    pinnedMessage: () => null,
    unreadHistory: () => session.unreadHistory("42"),
    history: () => session.history("42"),
    send: (input: unknown) => {
      const { id, text, replyTo } = input as { id: string; text: string; replyTo?: string };
      return session.sendText(id, text, replyTo);
    },
  } });
  try {
    fireEvent.click(await page.findByRole("button", { name: /Saved fixture/ }));
    fireEvent.click(await page.findByRole("button", { name: "Reply to message" }));
    const field = page.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
    const send = page.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    fireEvent.change(field, { target: { value: "Manual fixture reply" } });
    fireEvent.click(send);
    await waitFor(() => expect(confirmDelivery).toBeTypeOf("function"));
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      "@type": "sendMessage", chat_id: 42, reply_to_message_id: 12,
      input_message_content: expect.objectContaining({ text: expect.objectContaining({ text: "Manual fixture reply" }) }),
    }));
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
    expect(page.queryByRole("button", { name: "Confirm send" })).toBeNull();
    await act(async () => confirmDelivery({
      "@type": "message", id: 13, chat_id: 42, is_outgoing: true, reply_to_message_id: 12,
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "Manual fixture reply" } },
    }));
    expect(await within(page.getByRole("list", { name: "Messages" })).findByText("Manual fixture reply")).toBeTruthy();
    expect(field.value).toBe("");
  } finally {
    page.lifecycle.unmount();
    await session.close();
  }
});

test("removes a temporary message when its confirmed copy arrives through BB realtime", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  const original = { id: "8", text: "Delivery fixture", author: "You", time: "", outgoing: true, pendingDelivery: true };
  const history = vi.fn()
    .mockResolvedValueOnce({ before: null, messages: [original] })
    .mockResolvedValue({ before: null, messages: [{ ...original, id: "22", pendingDelivery: false }] });
  const page = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready" }),
    folders: () => [],
    chatPage: () => ({
      chats: [{ id: "42", name: "Delivery chat", initials: "DC", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      nextOffset: null,
    }),
    pinnedMessage: () => null,
    unreadHistory: () => null,
    history,
  } });
  try {
    fireEvent.click(await page.findByRole("button", { name: /^Delivery chat/ }));
    const list = within(page.getByRole("list", { name: "Messages" }));
    expect((await list.findByText("Delivery fixture")).closest("li")?.dataset.messageId).toBe("8");
    await page.behavior.emitRealtime("telegram-messages-deleted", { id: "42", messageIds: ["8"] });
    await page.behavior.emitRealtime("telegram-chat-changed", {});
    const confirmed = await list.findByText("Delivery fixture");
    expect(confirmed.closest("li")?.dataset.messageId).toBe("22");
    expect(list.getAllByText("Delivery fixture")).toHaveLength(1);
  } finally { page.lifecycle.unmount(); }
});

test("omits an unspecified photo size from the BB RPC payload", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  const photo = vi.fn((_input: unknown) => ({ mime: "image/jpeg", base64: "/9j/AA==" }));
  const page = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state: "ready" }),
    folders: () => [],
    chatPage: () => ({
      chats: [{ id: "42", name: "Saved fixture", initials: "SF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      nextOffset: null,
    }),
    pinnedMessage: () => null,
    unreadHistory: () => null,
    history: () => ({ before: null, messages: [{ id: "25", text: "Photo", author: "Fixture", time: "", hasPhoto: true }] }),
    photo,
  } });
  try {
    fireEvent.click(await page.findByRole("button", { name: /Saved fixture/ }));
    fireEvent.click(await page.findByRole("button", { name: "Show photo" }));
    await page.findByRole("img", { name: "Telegram photo" });
    expect(photo).toHaveBeenCalledExactlyOnceWith({ id: "42", messageId: "25" });
    expect(Object.keys(photo.mock.calls[0]?.[0] ?? {})).not.toContain("size");
  } finally { page.lifecycle.unmount(); }
});

test("asks before signing out of Telegram and returns to QR sign-in", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  let state: "ready" | "idle" = "ready";
  const signOut = vi.fn(() => { state = "idle"; return { state }; });
  const page = renderSlot(panel, { subPath: "" }, { rpc: {
    status: () => ({ state }),
    signOut,
    folders: () => [],
    chatPage: () => ({ chats: [], nextOffset: null }),
    agentAccess: () => ({ read: false, send: false, history: false }),
    runtimeInfo: () => ({ tdlibVersion: "1.8.0" }),
  } });
  try {
    const agents = await page.findByRole("button", { name: "Agents" });
    const dialog = page.container.querySelector<HTMLDialogElement>('dialog[aria-label="Telegram agent access"]')!;
    dialog.showModal = () => { dialog.open = true; };
    fireEvent.click(agents);
    await page.findByText("1.8.0");
    expect(page.getByText(/Update TDLib to use forum topics/)).toBeTruthy();
    fireEvent.click(page.getByRole("button", { name: "Sign out of Telegram" }));
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(page.getByRole("button", { name: "Confirm sign-out" }));
    await page.findByRole("heading", { name: "Connect Telegram" });
    expect(signOut).toHaveBeenCalledExactlyOnceWith(null);
  } finally { page.lifecycle.unmount(); }
});
