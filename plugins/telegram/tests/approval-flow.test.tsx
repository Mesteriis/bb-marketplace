// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, test, vi } from "vitest";
import { agentFindChatsTool, agentHistoryTool, registerAgentHistory, registerAgentRead } from "../src/adapters/bb/agent-read.ts";
import { registerAgentSend } from "../src/adapters/bb/agent-send.ts";
import { createApprovalQueue } from "../src/adapters/bb/approval-queue.ts";
import { createReplyTokens } from "../src/adapters/bb/reply-tokens.ts";
import type { connectTdJson, TdObject } from "../src/adapters/bb/tdjson.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";

test("finds a group, reads all authors without approval and requires approval to reply", async () => {
  const { bb, harness: host } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const start = Date.parse("2026-10-01") / 1000;
  const text = (id: number, days: number, user_id: number, value: string) => ({
    "@type": "message", id, date: start + days * 86400, chat_id: -42,
    sender_id: { "@type": "messageSenderUser", user_id },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: value } },
  });
  const mention = text(30, 2, 7, "Project fixture");
  const reply = text(20, 0, 8, "Please check the totals");
  const outside = text(10, -1, 7, "Outside the date range");
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatMessages": return { "@type": "messages", messages: [mention] };
      case "getChat": return { "@type": "chat", id: -42, title: "Project team", type: { "@type": "chatTypeBasicGroup", basic_group_id: 42 } };
      case "getBasicGroup": return { "@type": "basicGroup", id: 42, status: { "@type": "chatMemberStatusCreator", is_member: true } };
      case "getChatMessageByDate": return mention;
      case "getChatHistory": return { "@type": "messages", messages: query.from_message_id === 30
        ? (request.mock.calls.filter(([q]) => q["@type"] === "getChatHistory").length === 1 ? [mention] : [mention, reply, outside]) : [] };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: `Author ${query.user_id}` };
      case "getMessage": return query.message_id === 20 ? reply : mention;
      case "sendMessage": return { "@type": "message", id: 50, chat_id: query.chat_id,
        reply_to_message_id: query.reply_to_message_id, content: query.input_message_content };
      default: throw new Error("Unexpected TDLib fixture call");
    }
  });
  const session = createTelegram({
    library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture",
  }, () => ({ request, close: async () => {} }));
  const permission = new AbortController();
  const replyTokens = createReplyTokens();
  registerAgentHistory(bb, async () => ["-42"], () => session, () => permission.signal, replyTokens);
  registerAgentSend(bb, async () => true, () => session, replyTokens, undefined, undefined, () => permission.signal);
  const dates = { dateFrom: "2026-10-01", dateTo: "2026-10-03" };
  const thread = { threadId: "fixture-discovery-thread" };
  try {
    await waitFor(() => expect(session.status().state).toBe("ready"));
    const found = JSON.parse(await host.behavior.callAgentTool(agentFindChatsTool, { query: "Project fixture", ...dates }, thread) as string);
    expect(found.chats).toEqual([{ id: "-42", name: "Project team", kind: "Group", matchedName: false, matchedMessages: true }]);
    expect(JSON.stringify(found)).not.toContain("Project fixture");
    const first = JSON.parse(await host.behavior.callAgentTool(agentHistoryTool, { chatId: found.chats[0].id, ...dates }, thread) as string);
    expect(first).toMatchObject({ messages: [{ id: "30", author: "Author 7", text: "Project fixture" }], before: "30" });
    const last = JSON.parse(await host.behavior.callAgentTool(agentHistoryTool, {
      chatId: found.chats[0].id, before: first.before, ...dates,
    }, thread) as string);
    expect(last).toMatchObject({ messages: [{ id: "20", author: "Author 8", text: "Please check the totals" }], before: null });
    expect(JSON.stringify(last)).not.toContain("Outside the date range");
    expect(host.inspection.pendingInteractions).toHaveLength(0);
    const sending = host.behavior.callAgentTool("makosh_telegram_request_send", {
      text: "Totals checked", replyToken: last.messages[0].replyToken,
    }, thread);
    const confirmation = await waitFor(() => {
      expect(host.inspection.pendingInteractions).toHaveLength(1);
      return host.inspection.pendingInteractions[0]!;
    });
    expect(confirmation.payload).toMatchObject({ replyPreview: "Please check the totals", text: "Totals checked" });
    expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessage")).toBe(false);
    host.behavior.submitInteraction(confirmation.id, { id: "-42" });
    await expect(sending).resolves.toContain("confirmed");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      "@type": "sendMessage", chat_id: -42, reply_to_message_id: 20,
    }));
    await expect(host.behavior.callAgentTool("makosh_telegram_request_send", {
      text: "Totals checked", replyToken: last.messages[0].replyToken,
    }, thread)).resolves.toContain("invalid or expired");
  } finally {
    await session.close();
    await host.lifecycle.dispose();
  }
});

test.each([false, true])("BB forms authorize owner-authored notes and the exact reply token (batch=%s)", async (batch) => {
  const { bb, harness: host } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const replyTokens = createReplyTokens();
  const approvals = createApprovalQueue();
  const ownNote = { id: "12", text: "Original fixture", time: "10:30" };
  const second = { id: "13", text: "Second original fixture", time: "10:31" };
  const unrelated = { id: "14", text: "Unselected fixture", time: "10:32" };
  const target = batch ? second : ownNote;
  const thread = { threadId: "fixture-owner-thread" };
  const saved = { id: "42", name: "Saved Messages", subtitle: "Direct message" };
  const sendText = vi.fn(async (_id: string, _text: string, _reply?: string, _parent?: string, authorize?: () => boolean) =>
    ({ state: authorize?.() ? "sent" : "failed" }));
  const session = {
    status: () => ({ state: "ready" }),
    ownSavedNotes: async () => [ownNote, second, unrelated],
    ownNote: async (id: string, messageId: string) => id === saved.id
      ? [ownNote, second].find((note) => note.id === messageId) : undefined,
    saved: async () => saved,
    sendText,
  } as unknown as ReturnType<typeof createTelegram>;
  const readPreview = registerAgentRead(bb, async () => true, () => session, replyTokens, undefined, approvals);
  registerAgentSend(bb, async () => true, () => session, replyTokens, undefined, approvals);

  async function pendingForm() {
    const interaction = await waitFor(() => {
      const entry = host.inspection.pendingInteractions[0];
      expect(entry).toBeDefined();
      return entry!;
    });
    const renderer = app.pendingInteractions.find(({ id }) => id === interaction.rendererId);
    if (!renderer) throw new Error("Expected a registered BB renderer");
    return renderSlot(renderer, {
      interaction: { id: interaction.id, threadId: interaction.threadId, title: interaction.title,
        payload: interaction.payload, createdAt: Date.now(), expiresAt: Date.now() + 120_000 },
      submit: async (value) => { host.behavior.submitInteraction(interaction.id, value); },
      cancel: async () => { host.behavior.cancelInteraction(interaction.id); },
    }, { rpc: { readPreview: (input) => {
      const { requestId, id } = input as { requestId: string; id: string };
      return readPreview(requestId, id);
    } } });
  }

  try {
    const request = host.behavior.callAgentTool("makosh_telegram_request_read", batch ? { maxMessages: 2 } : {}, thread);
    const read = await pendingForm();
    expect(read.getByRole("timer").textContent).toMatch(/Time to confirm in BB/);
    await expect(host.behavior.callAgentTool("makosh_telegram_request_send", { text: "Concurrent fixture" }, thread))
      .resolves.toContain("already has");
    expect(host.inspection.pendingInteractions).toHaveLength(1);
    try {
      expect(JSON.stringify(host.inspection.pendingInteractions[0]?.payload)).not.toContain(ownNote.text);
      for (const note of batch ? [ownNote, second] : [ownNote]) {
        fireEvent.change(read.getByRole("combobox"), { target: { value: note.id } });
        await read.findByText(note.text);
        expect(read.queryByText(unrelated.text)).toBeNull();
        const checkbox = read.getByRole("checkbox") as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        fireEvent.click(checkbox);
      }
      fireEvent.click(read.getByRole("button", {
        name: batch ? "Approve 2" : "Approve",
      }));
    } finally { read.lifecycle.unmount(); }
    const result = await request;
    expect(typeof result).toBe("string");
    const shared = JSON.parse(String(result));
    expect(JSON.stringify(shared)).not.toContain(unrelated.text);
    const replies = batch ? shared.messages : [shared];
    expect(replies.map(({ untrustedNoteText }: { untrustedNoteText: string }) => untrustedNoteText))
      .toEqual(batch ? [ownNote.text, second.text] : [ownNote.text]);
    expect(new Set(replies.map(({ replyToken }: { replyToken: string }) => replyToken)).size)
      .toBe(batch ? 2 : 1);
    const token = replies.at(-1).replyToken;
    await expect(host.behavior.callAgentTool("makosh_telegram_request_send",
      { text: "Reply fixture", replyToken: token }, { threadId: "other-thread" })).resolves.toContain("invalid or expired");
    expect(host.inspection.pendingInteractions).toHaveLength(0);

    // Cancelling one request does not grant authority to send or consume the
    // reply token. A second request still needs a fresh affirmative decision.
    const cancelled = host.behavior.callAgentTool("makosh_telegram_request_send", { text: "Reply fixture", replyToken: token }, thread);
    const cancelForm = await pendingForm();
    try {
      expect(cancelForm.getByText(target.text)).toBeTruthy();
      fireEvent.click(cancelForm.getByRole("button", { name: "Cancel" }));
    } finally { cancelForm.lifecycle.unmount(); }
    await expect(cancelled).resolves.toContain("Nothing was sent");
    expect(sendText).not.toHaveBeenCalled();

    const sending = host.behavior.callAgentTool("makosh_telegram_request_send", { text: "Reply fixture", replyToken: token }, thread);
    const sendForm = await pendingForm();
    try {
      expect(sendForm.getByText("Reply fixture")).toBeTruthy();
      expect(sendForm.getByRole("option", { name: "Saved Messages · Direct message" })).toBeTruthy();
      fireEvent.click(sendForm.getByRole("button", { name: "Confirm send" }));
    } finally { sendForm.lifecycle.unmount(); }
    await expect(sending).resolves.toContain("confirmed");
    expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Reply fixture", target.id, target.text, expect.any(Function),
      { key: "account", kind: "Direct message", name: "Saved Messages" });
    expect(host.inspection.pendingInteractions).toHaveLength(0);
  } finally {
    await host.lifecycle.dispose();
  }
});

test.each([
  { destination: "Fixture group · Group", chatId: -42 },
  { destination: "Writable channel · Channel", chatId: -43 },
])("approves a Telegram send to $destination without listing read-only destinations", async ({ destination, chatId }) => {
  const { bb, harness: host } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const chats = new Map([
    [-42, { title: "Fixture group", type: { "@type": "chatTypeBasicGroup", basic_group_id: 42 } }],
    [-43, { title: "Writable channel", type: { "@type": "chatTypeSupergroup", is_channel: true, supergroup_id: 43 } }],
    [-45, { title: "Read-only group", type: { "@type": "chatTypeBasicGroup", basic_group_id: 45 } }],
    [-44, { title: "Subscriber-only channel", type: { "@type": "chatTypeSupergroup", is_channel: true, supergroup_id: 44 } }],
  ]);
  const request = vi.fn(async (q: TdObject): Promise<TdObject> => {
    switch (q["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChats": return { "@type": "chats", chat_ids: [...chats.keys()] };
      case "loadChats": return { "@type": "ok" };
      case "getChat": return { "@type": "chat", id: q.chat_id, ...chats.get(Number(q.chat_id)),
        permissions: { "@type": "chatPermissions", can_send_messages: q.chat_id === -42 } };
      case "getBasicGroup": return { "@type": "basicGroup", id: q.basic_group_id, is_active: true,
        status: { "@type": "chatMemberStatusMember" } };
      case "getSupergroup": return {
        "@type": "supergroup", id: q.supergroup_id, is_channel: true,
        status: q.supergroup_id === 43 ? { "@type": "chatMemberStatusAdministrator", can_post_messages: true }
          : { "@type": "chatMemberStatusMember" },
      };
      case "sendMessage": return { "@type": "message", id: 1024, chat_id: q.chat_id };
      default: throw new Error("Unexpected TDLib fixture call");
    }
  });
  const open: typeof connectTdJson = () => ({ request, close: async () => {} });
  const session = createTelegram({
    library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture",
  }, open);
  registerAgentSend(bb, async () => true, () => session);
  const writes = () => request.mock.calls.filter(([q]) => q["@type"] === "sendMessage");

  try {
    await waitFor(() => expect(session.status().state).toBe("ready"));
    const sending = host.behavior.callAgentTool("makosh_telegram_request_send", { text: "Synthetic publication" });
    const interaction = await waitFor(() => {
      const form = host.inspection.pendingInteractions[0];
      expect(form).toBeDefined();
      return form!;
    });
    const renderer = app.pendingInteractions.find(({ id }) => id === interaction.rendererId);
    if (!renderer) throw new Error("Expected an agent-send form");
    const form = renderSlot(renderer, {
      interaction: { id: interaction.id, threadId: interaction.threadId, title: interaction.title,
        payload: interaction.payload, createdAt: Date.now(), expiresAt: null },
      submit: async (value) => { host.behavior.submitInteraction(interaction.id, value); },
      cancel: async () => { host.behavior.cancelInteraction(interaction.id); },
    });
    try {
      expect(form.queryByRole("option", { name: /Subscriber-only channel/ })).toBeNull();
      expect(form.queryByRole("option", { name: /Read-only group/ })).toBeNull();
      expect(form.getByRole("option", { name: `${destination} · Chat ID ${chatId}` })).toBeTruthy();
      expect(writes()).toHaveLength(0);
      fireEvent.change(form.getByRole("combobox"), { target: { value: String(chatId) } });
      expect(form.getByText(chatId === -43 ? "Writable channel" : "Your Telegram account", { selector: "bdi" })).toBeTruthy();
      expect(writes()).toHaveLength(0);
      fireEvent.click(form.getByRole("button", { name: "Confirm send" }));
    } finally { form.lifecycle.unmount(); }
    await expect(sending).resolves.toContain("confirmed");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[0]).toMatchObject({
      chat_id: chatId, input_message_content: { text: { text: "Synthetic publication" } },
    });
    if (chatId === -43) {
      expect(request.mock.calls.filter(([q]) => q["@type"] === "getSupergroup" && q.supergroup_id === 43)).toHaveLength(2);
    }
  } finally {
    await host.lifecycle.dispose();
  }
});

test("keeps same-name chat destinations distinguishable and submits the selected identity", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const renderer = app.pendingInteractions.find(({ id }) => id === "telegram-send-review");
  if (!renderer) throw new Error("Expected a registered BB renderer");
  const submit = vi.fn(async () => {});
  const form = renderSlot(renderer, {
    interaction: {
      id: "fixture", threadId: "fixture", title: "Approve Telegram message",
      createdAt: 0, expiresAt: null,
      payload: { text: "Draft fixture", recipients: [
        { id: "-42", name: "Fixture", kind: "Group" },
        { id: "-43", name: "Fixture", kind: "Group", archived: true },
      ] },
    },
    submit,
    cancel: async () => {},
  });
  try {
    expect(form.getByRole("option", { name: "Fixture · Group · Chat ID -42" })).toBeTruthy();
    expect(form.getByRole("option", { name: "Fixture · Group · Archived · Chat ID -43" })).toBeTruthy();
    expect((form.getByRole("button", { name: "Confirm send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByRole("combobox"), { target: { value: "-43" } });
    fireEvent.click(form.getByRole("button", { name: "Confirm send" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ id: "-43" });
  } finally { form.lifecycle.unmount(); }
});

test("preselects Saved Messages without submitting the agent draft", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const renderer = app.pendingInteractions.find(({ id }) => id === "telegram-send-review");
  if (!renderer) throw new Error("Expected an agent-send form");
  const submit = vi.fn(async () => {});
  const form = renderSlot(renderer, {
    interaction: {
      id: "fixture", threadId: "fixture", title: "Approve Telegram message",
      createdAt: 0, expiresAt: null,
      payload: { text: "Draft fixture", recipients: [{ id: "42", name: "Saved Messages", kind: "Direct message" }] },
    },
    submit,
    cancel: async () => {},
  });
  try {
    expect((form.getByRole("combobox") as HTMLSelectElement).value).toBe("42");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole("button", { name: "Confirm send" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ id: "42" });
  } finally { form.lifecycle.unmount(); }
});
