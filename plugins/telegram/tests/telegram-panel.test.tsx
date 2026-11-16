// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, test, vi } from "vitest";
import type { connectTdJson, TdObject } from "../src/adapters/bb/tdjson.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";

test("keeps a new QR visible after a stale status poll and signs in through BB", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find(({ id }) => id === "telegram");
  if (!panel) throw new Error("Expected the Telegram panel");
  let releaseStatus!: (value: { state: "idle" }) => void;
  const status = vi.fn()
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
