import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { channelPostReceiptMigrations, createChannelPostReceipts, type ChannelPostReceipts } from "../src/adapters/bb/channel-post-receipts.ts";
import { agentHistoryTool, registerAgentHistory } from "../src/adapters/bb/agent-read.ts";
import { agentSendTool, registerAgentSend } from "../src/adapters/bb/agent-send.ts";
import { createReplyTokens } from "../src/adapters/bb/reply-tokens.ts";
import { createPrivateHistory, privateHistoryMigration, privateMediaMigration } from "../src/adapters/bb/private-history.ts";
import { videoNoteAudio } from "../src/adapters/bb/local-transcription.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";
import { findTdjsonLibrary, TdError, type TdObject, type connectTdJson } from "../src/adapters/bb/tdjson.ts";

function harness(respond: (query: TdObject) => TdObject, onDelete = vi.fn(), directory = "fixture", onChatChanged = vi.fn(),
  channelPosts?: ChannelPostReceipts, privateHistory?: ReturnType<typeof createPrivateHistory>, notifyMessage?: Parameters<typeof createTelegram>[4]) {
  let update!: (event: TdObject) => void;
  const request = vi.fn(async (query: TdObject) => respond(query));
  const open: typeof connectTdJson = (_, onUpdate) => {
    update = onUpdate;
    return { request, close: async () => {} };
  };
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture", channelPosts, privateHistory }, open, onChatChanged, onDelete, notifyMessage);
  function auth(type: string, fields: Record<string, unknown> = {}) {
    update({ "@type": "updateAuthorizationState", authorization_state: { "@type": type, ...fields } });
  }
  return { session, request, auth, update };
}

test("keeps observed incoming private messages through deletion, expiry and reconnect", async () => {
  const db = new Database(":memory:");
  db.exec(privateHistoryMigration);
  db.exec(privateMediaMigration);
  const key = Buffer.alloc(32, 7).toString("base64");
  const incoming: TdObject = {
    "@type": "message", id: 12, chat_id: 42, is_outgoing: false, date: 42,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Private fixture" } },
  };
  const picture: TdObject = { ...incoming, id: 13, self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" },
    content: { "@type": "messagePhoto", caption: { "@type": "formattedText", text: "Disappearing caption fixture" } } };
  let history: TdObject[] = [picture, incoming];
  const respond = (query: TdObject): TdObject => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 7 };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture", type: { "@type": "chatTypePrivate" } };
      case "getChatHistory": return { "@type": "messages", messages: history };
      default: throw new Error("Unexpected test query");
    }
  };
  const onDelete = vi.fn();
  const open = () => harness(respond, onDelete, undefined, undefined, undefined, createPrivateHistory(db, key));
  const { session, update } = open();
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await session.history("42");
    update({ "@type": "updateDeleteMessages", chat_id: 42, message_ids: [12, 999], is_permanent: true });
    update({ "@type": "updateMessageContent", chat_id: 42, message_id: 13, new_content: { "@type": "messageExpiredPhoto" } });
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
    expect(onDelete).toHaveBeenNthCalledWith(1, {
      id: "42", messageIds: ["999"], retained: [expect.objectContaining({ id: "12", text: "Private fixture", retained: "deleted" })],
    });
    expect(onDelete).toHaveBeenNthCalledWith(2, {
      id: "42", messageIds: [], retained: [expect.objectContaining({ id: "13", text: "Disappearing media", retained: "expired" })],
    });
    history = [];
    await session.close();
    const reopened = open().session;
    try {
      await vi.waitFor(() => expect(reopened.status().state).toBe("ready"));
      await expect(reopened.history("42")).resolves.toMatchObject({ messages: [
        { id: "12", text: "Private fixture", retained: "deleted" }, { id: "13", text: "Disappearing media", retained: "expired" },
      ] });
      expect((await reopened.history("43")).messages).toEqual([]);
    } finally { await reopened.close(); }
    const persisted = db.prepare<[], { snapshot: Buffer }>("SELECT snapshot FROM telegram_private_history").all();
    expect(persisted.every(({ snapshot }) => !snapshot.includes(Buffer.from("fixture")))).toBe(true);
  } finally {
    await session.close();
    db.close();
  }
});

test.each(["photo", "video"] as const)("saves one-view %s on explicit view and reopens it after expiry and reconnect", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "bb-telegram-once-"));
  const path = join(directory, "media");
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("synthetic one-view media fixture")]);
  await writeFile(path, bytes);
  const db = new Database(":memory:");
  db.exec(privateHistoryMigration);
  db.exec(privateMediaMigration);
  const key = Buffer.alloc(32, 8).toString("base64");
  const file = { "@type": "file", id: 51, size: bytes.length };
  const photo = { "@type": "messagePhoto", photo: { "@type": "photo", sizes: [
    { "@type": "photoSize", width: 20, height: 20, photo: file },
  ] } };
  const video = { "@type": "messageVideo", video: { "@type": "video", video: file, mime_type: "video/mp4" } };
  const raw: TdObject = {
    "@type": "message", id: 15, chat_id: 42, is_outgoing: false, can_be_saved: false,
    self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" },
    content: { ...(kind === "photo" ? photo : video), is_secret: true },
  };
  let expired = false;
  let refuse = true;
  const respond = (query: TdObject): TdObject => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 7 };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": query.chat_id === 42 ? "chatTypePrivate" : "chatTypeSecret" } };
      case "getChatHistory": return { "@type": "messages", messages: expired ? [] : [raw] };
      case "getMessage": if (!expired) return raw; throw new Error("Media expired");
      case "downloadFile": return { ...file, local: { "@type": "localFile", is_downloading_completed: true, path } };
      case "openMessageContent":
        if (refuse) throw new Error("View refused");
        expired = true;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  };
  const open = () => harness(respond, undefined, directory, undefined, undefined, createPrivateHistory(db, key));
  const { session, request } = open();
  const signal = new AbortController().signal;
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const preview = await session.history("42");
    expect(preview).toMatchObject({ messages: [{ id: "15", oneView: kind }] });
    expect(preview).toStrictEqual(JSON.parse(JSON.stringify(preview)));
    expect(request.mock.calls.map(([query]) => query["@type"])).not.toContain("downloadFile");
    await expect(session.openOneView("43", "15", signal)).rejects.toThrow("unavailable");
    await expect(session.openOneView("42", "15", signal)).rejects.toThrow("View refused");
    expect(db.prepare("SELECT media FROM telegram_private_history").get()).toEqual({ media: null });
    refuse = false;
    const mime = kind === "photo" ? "image/jpeg" : "video/mp4";
    await expect(session.openOneView("42", "15", signal)).resolves.toEqual({ bytes, mime });
    expect(request.mock.calls.map(([query]) => query["@type"])).not.toContain("sendChatScreenshotTakenNotification");
    const persisted = db.prepare<[], { media: Buffer }>("SELECT media FROM telegram_private_history").get();
    expect(persisted?.media.includes(bytes)).toBe(false);
    await session.close();
    await rm(path);
    const reopened = open();
    try {
      await vi.waitFor(() => expect(reopened.session.status().state).toBe("ready"));
      await expect(reopened.session.history("42")).resolves.toMatchObject({ messages: [{ oneView: kind, retained: "expired" }] });
      await expect(reopened.session.openOneView("42", "15", signal)).resolves.toEqual({ bytes, mime });
      expect(reopened.request.mock.calls.map(([query]) => query["@type"])).not.toContain("openMessageContent");
    } finally { await reopened.session.close(); }
  } finally {
    await session.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("counts cached media without database bytes and clears through TDLib without reconnecting", async () => {
  let bytes = 900 * 1024 * 1024;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getStorageStatistics": return { "@type": "storageStatistics", size: bytes, count: 3 };
      case "optimizeStorage":
        bytes = Number(query.size);
        return { "@type": "storageStatistics", size: bytes, count: 0 };
      default: throw new Error("Unexpected TDLib request");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.cacheBytes()).toBe(900 * 1024 * 1024);
  await session.optimizeCache(512 * 1024 * 1024);
  await session.optimizeCache(0);
  expect(await session.cacheBytes()).toBe(0);
  const optimizations = request.mock.calls.filter(([query]) => query["@type"] === "optimizeStorage").map(([query]) => query);
  expect(optimizations).toEqual([
    expect.objectContaining({ size: 512 * 1024 * 1024, immunity_delay: 60 }),
    expect.objectContaining({ size: 0, immunity_delay: 0,
      file_types: expect.arrayContaining([{ "@type": "fileTypePhoto" }, { "@type": "fileTypeProfilePhoto" }, { "@type": "fileTypeThumbnail" }]) }),
  ]);
  expect(request.mock.calls.some(([query]) => ["logOut", "close", "destroy"].includes(query["@type"]))).toBe(false);
  expect(session.status()).toEqual({ state: "ready" });
});

test("requests QR once, accepts rotations, and handles two-step verification", async () => {
  const { session, request, auth } = harness((query) => query["@type"] === "getAuthorizationState"
    ? { "@type": "authorizationStateWaitPhoneNumber" } : { "@type": "ok" });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({
    "@type": "requestQrCodeAuthentication", other_user_ids: [],
  }));
  auth("authorizationStateWaitPhoneNumber");
  expect(request.mock.calls.filter(([query]) => query["@type"] === "requestQrCodeAuthentication")).toHaveLength(1);
  auth("authorizationStateWaitOtherDeviceConfirmation", { link: "tg://login?token=fixture-one" });
  auth("authorizationStateWaitOtherDeviceConfirmation", { link: "tg://login?token=fixture-two" });
  expect(session.status()).toEqual({ state: "qr", link: "tg://login?token=fixture-two" });
  auth("authorizationStateWaitPassword");
  expect(session.status()).toEqual({ state: "password" });
  await session.password("fixture");
  expect(request).toHaveBeenCalledWith({ "@type": "checkAuthenticationPassword", password: "fixture" });
  auth("authorizationStateReady");
  expect(session.status()).toEqual({ state: "ready" });
});

test("loads a bounded main chat list and returns chronological history", async () => {
  const content = (text: string) => ({ "@type": "messageText", text: { "@type": "formattedText", text } });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "loadChats": throw new TdError(404);
      case "getChats": return { "@type": "chats", chat_ids: [-42] };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture Group", unread_count: 3, chat_lists: [
        { "@type": "chatListMain" }, { "@type": "chatListFolder", chat_folder_id: 4 },
        { "@type": "chatListFolder", chat_folder_id: 4 }, { "@type": "chatListFolder", chat_folder_id: 0 },
      ] };
      case "getChatHistory": return { "@type": "messages", messages: [
        { "@type": "message", id: 2, content: content("second"), is_outgoing: true },
        { "@type": "message", id: 1, content: content("first") },
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await expect(session.history("-42")).rejects.toThrow("Connect Telegram first");
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.chats()).toMatchObject([{ id: "-42", name: "Fixture Group", unread: 3, folderIds: [4] }]);
  expect(await session.history("-42")).toMatchObject({ messages: [{ text: "first" }, { text: "second", outgoing: true }], before: "1" });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChatHistory", chat_id: -42, only_local: false, limit: 50 }));
});

test("maps TDLib account folders and archive to their own chat lists", async () => {
  const { session, request, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChats") return { "@type": "chats", chat_ids: [] };
    return { "@type": "ok" };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  update({ "@type": "updateChatFilters", chat_filters: [{ "@type": "chatFilterInfo", id: 7, title: "Fixture" }] });
  expect(session.folders()).toEqual([{ id: 7, title: "Fixture" }]);
  await session.chats(7);
  await session.chats("archive");
  await expect(session.chats(8)).rejects.toThrow("Unknown folder");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChats", chat_list: { "@type": "chatListFilter", chat_filter_id: 7 } }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChats", chat_list: { "@type": "chatListArchive" } }));
  update({ "@type": "updateChatFolders", chat_folders: [{
    "@type": "chatFolderInfo", id: 7, name: { "@type": "chatFolderName", text: { "@type": "formattedText", text: "Renamed" } },
  }] });
  expect(session.folders()).toEqual([{ id: 7, title: "Renamed" }]);
  await session.chats(7);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChats", chat_list: { "@type": "chatListFolder", chat_folder_id: 7 } }));
});

test("waits for delivery and matches the update to chat and temporary message", async () => {
  const { session, request, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id };
    if (query["@type"] === "sendMessage") {
      return { "@type": "message", id: 8, chat_id: 42, sending_state: { "@type": "messageSendingStatePending" } };
    }
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const send = session.sendText("42", "fixture").then((result) => result);
  await Promise.resolve();
  update({ "@type": "updateMessageSendFailed", old_message_id: 8, message: { "@type": "message", chat_id: 99 } });
  update({ "@type": "updateMessageSendSucceeded", old_message_id: 8, message: {
    "@type": "message", id: 9, chat_id: 42, is_outgoing: true,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "fixture" } },
  } });
  await expect(send).resolves.toMatchObject({ state: "sent", message: { id: "9", text: "fixture" } });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
});

test("searches known chats outside the loaded list and resolves Saved Messages by own account ID", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatsOnServer": return { "@type": "chats", chat_ids: [82, 82] };
      case "getChat": return { "@type": "chat", id: 82, title: "Search result" };
      case "getMe": return { "@type": "user", id: 42 };
      case "createPrivateChat": return { "@type": "chat", id: 42, title: "Own profile" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.search("Search")).toMatchObject([{ id: "82", name: "Search result" }]);
  expect(await session.chats("saved")).toMatchObject([{ id: "42", name: "Saved Messages" }]);
  expect(request).toHaveBeenCalledWith({ "@type": "createPrivateChat", user_id: 42, force: true });
});

test("agent note candidates only include original outgoing text by the signed-in account", async () => {
  const original = {
    "@type": "message", id: 1, chat_id: 42, is_outgoing: true,
    sender_id: { "@type": "messageSenderUser", user_id: 42 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture" } },
  };
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id };
      case "getMe": return { "@type": "user", id: 42 };
      case "createPrivateChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        { ...original, id: 2, forward_info: { "@type": "messageForwardInfo" } },
        { ...original, id: 3, import_info: { "@type": "messageImportInfo" } },
        { ...original, id: 4, reply_to_message_id: 21 },
        { ...original, id: 5, chat_id: 99 },
        { ...original, id: 6, via_bot_user_id: 44 },
        { ...original, id: 7, sender_id: { "@type": "messageSenderUser", user_id: 99 } },
        original,
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.ownSavedNotes()).toStrictEqual([
    { id: "4", text: "Original fixture", time: "" }, { id: "1", text: "Original fixture", time: "" },
  ]);
});

test("history continues after a short page and excludes the repeated cursor", async () => {
  const makeMessage = (id: number) => ({
    "@type": "message", id,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: `Fixture ${id}` } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, title: "Fixture" };
      case "getChatHistory": {
        const ids = query.from_message_id === 0 ? [30, 20] : query.from_message_id === 20 ? [20, 10, 10] : [10];
        return { "@type": "messages", messages: ids.map(makeMessage) };
      }
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.history("42")).resolves.toMatchObject({ messages: [{ id: "20" }, { id: "30" }], before: "20" });
  await expect(session.history("42", "20")).resolves.toMatchObject({ messages: [{ id: "10" }], before: "10" });
  await expect(session.history("42", "10")).resolves.toEqual({ messages: [], before: null });
  await expect(session.history("42", "-1")).rejects.toThrow("Invalid history cursor");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChatHistory", from_message_id: 20 }));
});

test("a scoped agent read excludes channel identities and messages from other chats", async () => {
  const original = {
    "@type": "message", id: 1, chat_id: -42, is_outgoing: true,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
    sender_id: { "@type": "messageSenderUser", user_id: 99 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture" } },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id };
      case "getMe": return { "@type": "user", id: 99 };
      case "searchChatMessages": return { "@type": "messages", messages: [
        { ...original, id: 2, sender_id: { "@type": "messageSenderChat", chat_id: -42 } },
        { ...original, id: 3, chat_id: -43 },
        ...(query.topic_id ? [{ ...original, id: 4, topic_id: { "@type": "messageTopicForum", forum_topic_id: 18 } }] : []),
        original,
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownChatNotes("-42")).resolves.toMatchObject([{ id: "1" }]);
  await expect(session.ownChatNotes("-42", "", 17)).resolves.toMatchObject([{ id: "1", forumTopicId: 17 }]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    "@type": "searchChatMessages", chat_id: -42, topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
  }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    "@type": "searchChatMessages", chat_id: -42, sender_id: { "@type": "messageSenderUser", user_id: 99 },
  }));
});

test("replies only when TDLib resolves the target in the same destination", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id };
      case "getMessage":
        return { "@type": "message", id: 25, chat_id: query.chat_id === 42 ? 42 : 99 };
      case "sendMessage": return {
        "@type": "message", id: 30, chat_id: 42, reply_in_chat_id: 42, reply_to_message_id: 25,
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Reply fixture" } },
      };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendText("43", "Reply fixture", "25")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(0);
  await expect(session.sendText("42", "Reply fixture", "25")).resolves.toMatchObject({
    state: "sent", message: { replyTo: "25" },
  });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    "@type": "sendMessage", chat_id: 42, reply_to_message_id: 25,
    reply_to: { "@type": "inputMessageReplyToMessage", message_id: 25 },
  }));
});

test("editing rechecks ownership, permission and the original text before any write", async () => {
  const raw = {
    "@type": "message", id: 25, chat_id: 42, is_outgoing: true, can_be_edited: true,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture", entities: [] } },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { ...raw, is_outgoing: query.chat_id !== 43, chat_id: query.chat_id };
      case "editMessageText": return { ...raw, edit_date: 1700000000,
        content: query.input_message_content as object };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.editText("43", "25", "Edit fixture", "Original fixture")).resolves.toEqual({ state: "failed" });
  await expect(session.editText("42", "25", "Edit fixture", "Stale fixture")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "editMessageText")).toHaveLength(0);
  await expect(session.editText("42", "25", "Edit fixture", "Original fixture")).resolves.toMatchObject({
    state: "sent", message: { id: "25", text: "Edit fixture", edited: true },
  });
});

test("chat pages only resolve the next window and stop when Telegram reports the end", async () => {
  let loaded = 40;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChats": return {
        "@type": "chats", chat_ids: Array.from({ length: Math.min(loaded, Number(query.limit)) }, (_, index) => index + 1),
      };
      case "loadChats":
        if (loaded === 43) throw new TdError(404);
        loaded = 43;
        return { "@type": "ok" };
      case "getChat": return { "@type": "chat", id: Number(query.chat_id), title: "Fixture" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const first = await session.chatPage("main", 0);
  expect(first.chats).toHaveLength(40);
  expect(first.nextOffset).toBe(40);
  request.mockClear();
  const last = await session.chatPage("main", 40);
  expect(last.chats.map(({ id }) => id)).toEqual(["41", "42", "43"]);
  expect(last.nextOffset).toBeNull();
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getChat")).toHaveLength(3);
});

test("conversation search asks TDLib for matches and discards results from another chat", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "searchChatMessages") return {
      "@type": "messages", messages: [42, 99].map((chat_id) => ({
        "@type": "message", chat_id, id: chat_id,
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Search fixture" } },
      })),
    };
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.searchMessages("42", "fixture")).toMatchObject({ messages: [{ id: "42", text: "Search fixture" }] });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "searchChatMessages", chat_id: 42, query: "fixture", limit: 40 }));
});

test("marks unread without viewing messages, and marks read through the verified latest message", async () => {
  let unreadCount = 3;
  let marked = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, title: "Fixture", unread_count: unreadCount,
        is_marked_as_unread: marked, last_message: { "@type": "message", id: 50, chat_id: 42 } };
      case "toggleChatIsMarkedAsUnread": marked = query.is_marked_as_unread === true; return { "@type": "ok" };
      case "viewMessages": unreadCount = 0; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.markChat("42", true)).resolves.toMatchObject({ unread: 3, markedUnread: true });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "viewMessages")).toHaveLength(0);
  await expect(session.markChat("42", false)).resolves.toMatchObject({ unread: 0, markedUnread: false });
  expect(request).toHaveBeenCalledWith({ "@type": "viewMessages", chat_id: 42, message_ids: [50], force_read: true });
});

test("refuses an invalid JPEG before submitting a Telegram send request", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendPhoto("42", "Fixture", Buffer.from("<svg/>").toString("base64")))
    .resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(0);
});

test("rejects a channel subscriber and permits an administrator with publishing rights", async () => {
  let status: TdObject = { "@type": "chatMemberStatusMember" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: true } };
      case "getSupergroup": return { "@type": "supergroup", id: 77, is_channel: true, status };
      case "sendMessage": return { "@type": "message", id: 25, chat_id: -42 };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendText("-42", "Fixture")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(0);
  status = { "@type": "chatMemberStatusAdministrator", rights: {
    "@type": "chatAdministratorRights", can_post_messages: true,
  } };
  await expect(session.sendText("-42", "Fixture")).resolves.toMatchObject({ state: "sent" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
});

test("revoking approval while TDLib checks the destination prevents the send command", async () => {
  let releaseChat!: (result: TdObject) => void;
  let chatRequested = false;
  const controller = new AbortController();
  const open: typeof connectTdJson = () => ({
    close: async () => {},
    request: async (query) => {
      if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
      if (query["@type"] === "getChat") {
        chatRequested = true;
        return new Promise((resolve) => { releaseChat = resolve; });
      }
      throw new Error("Unexpected test query");
    },
  });
  const session = createTelegram({ library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const canSend = vi.fn(() => !controller.signal.aborted);
  const result = session.sendText("42", "Fixture", undefined, undefined, canSend);
  expect(chatRequested).toBe(true);
  controller.abort();
  releaseChat({ "@type": "chat", id: 42 });
  await expect(result).resolves.toEqual({ state: "failed" });
  expect(canSend).toHaveBeenCalledOnce();
});

test("searches Saved Messages without TDLib's sender filter but verifies each candidate locally", async () => {
  const row = (id: number, text: string, date: number) => ({
    "@type": "message", id, date, chat_id: 42, is_outgoing: true, can_be_saved: true,
    sender_id: { "@type": "messageSenderUser", user_id: id === 99 ? 99 : 42 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text } },
  });
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id };
    if (query["@type"] === "getMe") return { "@type": "user", id: 42 };
    if (query["@type"] === "createPrivateChat") return { "@type": "chat", id: 42 };
    if (query["@type"] === "getChatMessageByDate") return Number(query.date) >= 300 ? row(42, "Fixture", 300) : row(41, "Other text", 250);
    if (query["@type"] === "searchChatMessages") return { "@type": "messages", messages: query.from_message_id ? [] :
      [106, 105, 104, 103, 102, 101, 99, 42].map((id) => row(id, id >= 101 ? "Other text" : "Fixture", id === 42 ? 300 : 200)) };
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownSavedNotes("Fixture")).resolves.toMatchObject([{ id: "42" }]);
  await expect(session.ownSavedNotes("Fixture", { from: 300, until: 301 })).resolves.toMatchObject([{ id: "42" }]);
  await expect(session.ownSavedNotes("Fixture", { until: 300 })).resolves.toEqual([]);
  const search = request.mock.calls.find(([query]) => query["@type"] === "searchChatMessages")?.[0];
  expect(search).toMatchObject({ chat_id: 42, query: "Fixture" });
  expect(search).not.toHaveProperty("sender_id");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "searchChatMessages", from_message_id: 42 }));
});

test("reads a dated conversation page across authors and excludes protected content", async () => {
  const text = (id: number, date: number, user_id: number, extra = {}) => ({
    "@type": "message", id, date, chat_id: -42,
    sender_id: { "@type": "messageSenderUser", user_id },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: `Fixture ${id}` } },
    ...extra,
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture group" };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: `Author ${query.user_id}` };
      case "getChatMessageByDate": return text(50, 499, 7);
      case "getChatHistory": return { "@type": "messages", messages: query.from_message_id === 50
        ? [text(51, 500, 7), text(50, 499, 7), text(40, 400, 8), text(30, 300, 8, { can_be_saved: false })]
        : [text(30, 300, 8, { can_be_saved: false }), text(20, 200, 8), text(10, 199, 7)] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const range = { from: 200, until: 500 };
  const first = await session.historyInDateRange("-42", range);
  expect(first).toEqual({ before: "30", messages: [
    { id: "50", date: 499, author: "Author 7", text: "Fixture 50" },
    { id: "40", date: 400, author: "Author 8", text: "Fixture 40" },
    { id: "30", date: 300, withheld: true },
  ] });
  expect(await session.historyInDateRange("-42", range, first.before!)).toEqual({ before: null, messages: [
    { id: "20", date: 200, author: "Author 8", text: "Fixture 20" },
  ] });
  expect(request).toHaveBeenCalledWith({ "@type": "getChatMessageByDate", chat_id: -42, date: 499 });
});

test("pages one forum topic by date across authors and excludes other topics and protected text", async () => {
  const row = (id: number, date: number, user_id: number, topic: number, can_be_saved = true) => ({
    "@type": "message", chat_id: -42, id, date, can_be_saved,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: topic },
    sender_id: { "@type": "messageSenderUser", user_id },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: `Fixture ${id}` } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: `Author ${query.user_id}` };
      case "getForumTopicHistory": return { "@type": "messages", messages: query.from_message_id === 0
        ? [row(60, 500, 7, 17), row(50, 499, 7, 17), row(40, 400, 8, 18), row(30, 300, 8, 17)]
        : [row(30, 300, 8, 17), row(20, 200, 8, 17, false), row(10, 199, 8, 17)] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const range = { from: 200, until: 500 };
  const first = await session.historyInDateRange("-42", range, undefined, undefined, 17);
  expect(first).toEqual({ before: "30", messages: [
    { id: "50", date: 499, author: "Author 7", text: "Fixture 50", forumTopicId: 17 },
    { id: "30", date: 300, author: "Author 8", text: "Fixture 30", forumTopicId: 17 },
  ] });
  expect(await session.historyInDateRange("-42", range, first.before!, undefined, 17)).toEqual({
    before: null, messages: [{ id: "20", date: 200, withheld: true }],
  });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    "@type": "getForumTopicHistory", chat_id: -42, forum_topic_id: 17, from_message_id: 30,
  }));
});

test("shares a forum message from another author and dispatches its reply once after BB approval", async () => {
  const topic = { "@type": "messageTopicForum", forum_topic_id: 17 };
  const original = {
    "@type": "message", chat_id: -42, id: 12, date: 300, topic_id: topic, is_outgoing: false,
    sender_id: { "@type": "messageSenderUser", user_id: 7 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original from another participant" } },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture group" };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: "Fixture participant" };
      case "getForumTopicHistory": return { "@type": "messages", messages: [original] };
      case "getForumTopic": return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17, name: "Fixture topic",
      } };
      case "getMessage": return original;
      case "sendMessage": return { "@type": "message", chat_id: -42, id: 13, topic_id: topic, reply_to_message_id: 12 };
      default: throw new Error("Unexpected TDLib request");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  type Context = Pick<PluginAgentToolContext, "threadId" | "signal">;
  type Input = { chatId: string; dateFrom: string; dateTo: string; forumTopicId: number } | { replyToken: string; text: string };
  const tools = new Map<string, (input: Input, context: Context) => Promise<string>>();
  const requestInput = vi.fn<BbPluginApi["ui"]["requestInput"]>();
  const bb = { agents: { registerTool: (tool: { name: string; execute: (input: Input, context: Context) => Promise<string> }) => {
    tools.set(tool.name, tool.execute);
  } }, ui: { requestInput } } as unknown as BbPluginApi;
  const tokens = createReplyTokens();
  const context = { threadId: "fixture", signal: new AbortController().signal };
  registerAgentHistory(bb, async () => ["-42"], () => session, () => context.signal, tokens);
  registerAgentSend(bb, async () => true, () => session, tokens);
  const result = JSON.parse(await tools.get(agentHistoryTool)!({
    chatId: "-42", dateFrom: "1970-01-01", dateTo: "1970-01-01", forumTopicId: 17,
  }, context));
  expect(result.messages).toEqual([{
    id: "12", text: "Original from another participant", author: "Fixture participant", date: 300, forumTopicId: 17,
    replyToken: expect.any(String),
  }]);
  expect(requestInput).not.toHaveBeenCalled();
  const dispatches = () => request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
  const reply = () => tools.get(agentSendTool)!({ replyToken: result.messages[0].replyToken, text: "Reviewed reply" }, context);
  requestInput.mockResolvedValueOnce({ outcome: "cancelled", reason: "user" });
  await expect(reply()).resolves.toContain("Nothing was sent");
  expect(dispatches()).toHaveLength(0);
  requestInput.mockImplementationOnce(async ({ payload }) => {
    expect(payload).toMatchObject({ text: "Reviewed reply", replyPreview: "Original from another participant",
      forumTopic: { id: 17, name: "Fixture topic" }, recipients: [{ id: "-42", kind: "Group" }] });
    expect(dispatches()).toHaveLength(0);
    return { outcome: "submitted", value: { id: "-42" } };
  });
  await expect(reply()).resolves.toBe("Telegram confirmed the message was sent.");
  await expect(reply()).resolves.toContain("invalid or expired");
  expect(dispatches()).toEqual([[expect.objectContaining({ chat_id: -42, topic_id: topic,
    reply_to: { "@type": "inputMessageReplyToMessage", message_id: 12 },
    input_message_content: expect.objectContaining({ text: { "@type": "formattedText", text: "Reviewed reply", entities: [] } }),
  })]]);
});

test("keeps large Telegram history pages below the response budget without losing messages", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    "@type": "message", id: 30 - index, date: 499 - index, chat_id: -42,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Я".repeat(4096) } },
  }));
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture group" };
      case "getChatMessageByDate": return rows[0]!;
      case "getChatHistory": return { "@type": "messages", messages: rows.filter((row) => row.id <= Number(query.from_message_id)) };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const ids: string[] = [];
  let before: string | null | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await session.historyInDateRange("-42", { from: 200, until: 500 }, before ?? undefined);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(49 * 1024);
    ids.push(...result.messages.map(({ id }) => id));
    before = result.before;
    if (!before) break;
  }
  expect(before).toBeNull();
  expect(ids).toEqual(rows.map(({ id }) => String(id)));
});

test.each(["modern", "legacy"] as const)("searches only granted chats using a %s cursor", async (mode) => {
  const hit = (id: number, chat_id: number, date: number) => ({
    "@type": "message", id, chat_id, date,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Private fixture" } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id,
        title: query.chat_id === -41 ? "Fixture group" : "Other title", has_protected_content: query.chat_id === -43 };
      case "getChatMessageByDate": return {
        ...hit(60, Number(query.chat_id), 499), content: { "@type": "messageText", text: { "@type": "formattedText", text: "Nonmatching anchor" } },
      };
      case "searchChatMessages": return { "@type": mode === "modern" ? "foundChatMessages" : "messages",
        next_from_message_id: 50, messages: query.from_message_id === 60 ? [hit(50, -42, 500)] : [hit(40, -42, 400)] };
      default: throw new Error("Unexpected TDLib query outside the granted chats");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const range = { from: 200, until: 500 };
  const granted = ["-41", "-42", "-43"];
  const first = await session.findRelatedChats("Fixture", range, granted);
  expect(first.chats).toMatchObject([{ id: "-41", matchedName: true }]);
  expect(first.next).toEqual({ chatId: "-42", before: "50" });
  const second = await session.findRelatedChats("Fixture", range, granted, first.next!);
  expect(second).toMatchObject({ chats: [{ id: "-42", matchedMessages: true }], next: null });
  expect(JSON.stringify(second)).not.toContain("Private fixture");
  expect(request.mock.calls.filter(([query]) => query["@type"] === "searchChatMessages")
    .map(([query]) => [query.chat_id, query.from_message_id])).toEqual([[-42, 60], [-42, 50]]);
});

test.each(["legacy", "modern"])("archives and restores only between TDLib-authorized lists (%s)", async (mode) => {
  let list = "chatListMain";
  let allow = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return {
        "@type": "chat", id: 42, title: "Archive fixture",
        ...(mode === "modern" ? { chat_lists: [{ "@type": list }] } : {}), positions: [
          { "@type": "chatPosition", list: { "@type": list }, order: "100" },
          { "@type": "chatPosition", list: { "@type": "chatListArchive" }, order: mode === "modern" ? "100" : "0" },
        ],
      };
      case "getChatListsToAddChat": return { "@type": "chatLists", chat_lists: allow
        ? [{ "@type": list === "chatListMain" ? "chatListArchive" : "chatListMain" }] : [] };
      case "addChatToList": list = (query.chat_list as TdObject)["@type"]; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.archiveChat("42", true)).rejects.toThrow("does not allow");
  expect(request.mock.calls.filter(([query]) => query["@type"] === "addChatToList")).toHaveLength(0);
  allow = true;
  await expect(session.archiveChat("42", true)).resolves.toMatchObject({ archived: true });
  await expect(session.archiveChat("42", false)).resolves.toMatchObject({ archived: false });
});

test("reads the latest pinned message and distinguishes missing and mismatched results", async () => {
  let ownerChat = -42;
  let missing = false;
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "getChatPinnedMessage") throw new Error("Unexpected test query");
    if (missing) throw new TdError(404);
    return { "@type": "message", id: 12, chat_id: ownerChat,
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "Pinned fixture" } } };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.pinnedMessage("-42")).resolves.toMatchObject({ id: "12", text: "Pinned fixture" });
  expect(request).toHaveBeenLastCalledWith({ "@type": "getChatPinnedMessage", chat_id: -42 });
  ownerChat = -99;
  await expect(session.pinnedMessage("-42")).rejects.toThrow("different chat");
  missing = true;
  await expect(session.pinnedMessage("-42")).resolves.toBeNull();
});

test("reports deleted messages and ignores cache-only removals", async () => {
  const onDelete = vi.fn();
  const { session, update } = harness(() => ({ "@type": "authorizationStateReady" }), onDelete);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  update({ "@type": "updateDeleteMessages", chat_id: -42, message_ids: [50], from_cache: true });
  expect(onDelete).not.toHaveBeenCalled();
  update({ "@type": "updateDeleteMessages", chat_id: -42, message_ids: [50, null, "51"], from_cache: false });
  expect(onDelete).toHaveBeenCalledExactlyOnceWith({ id: "-42", messageIds: ["50"] });
});

test("checks supergroup member restrictions again before dispatching text", async () => {
  let status: TdObject = { "@type": "chatMemberStatusMember" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: false },
        permissions: { "@type": "chatPermissions", can_send_basic_messages: true } };
      case "getSupergroup": return { "@type": "supergroup", id: 77, is_channel: false, status };
      case "sendMessage": return { "@type": "message", id: 25, chat_id: -42 };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.postingAllowed("-42")).resolves.toBe(true);
  status = { "@type": "chatMemberStatusRestricted", is_member: true,
    permissions: { "@type": "chatPermissions", can_send_basic_messages: false, can_send_photos: true } };
  await expect(session.postingPermissions("-42")).resolves.toEqual({ text: false, photo: true, document: false });
  await expect(session.sendText("-42", "Fixture")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(0);
  status = { "@type": "chatMemberStatusAdministrator" };
  await expect(session.sendText("-42", "Fixture")).resolves.toMatchObject({ state: "sent" });
});

test("does not report delivery when TDLib returns a message for another chat", async () => {
  const { session } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id };
    return { "@type": "message", id: 12, chat_id: 99 };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendText("42", "Fixture")).resolves.toEqual({ state: "unknown" });
});

test("closing a session releases pending delivery with an unknown outcome and no retry", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id };
    return { "@type": "message", id: 8, chat_id: 42, sending_state: { "@type": "messageSendingStatePending" } };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  vi.useFakeTimers();
  try {
    const result = session.sendText("42", "Fixture");
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
    await expect(result).resolves.toEqual({ state: "unknown" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("loads the exact approved note by ID and rechecks its authorship", async () => {
  let sender = 7;
  let exists = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id };
      case "getMe": return { "@type": "user", id: 7 };
      case "getMessage": {
        if (!exists) throw new TdError(404);
        return { "@type": "message", id: 123, chat_id: -42, is_outgoing: true,
          sender_id: { "@type": "messageSenderUser", user_id: sender },
          content: { "@type": "messageText", text: { "@type": "formattedText", text: "Approved fixture" } } };
      }
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownNote("-42", "123")).resolves.toMatchObject({ id: "123", text: "Approved fixture" });
  expect(request).toHaveBeenCalledWith({ "@type": "getMessage", chat_id: -42, message_id: 123 });
  await expect(session.ownNote("-42", "124")).resolves.toBeUndefined();
  sender = 99;
  await expect(session.ownNote("-42", "123")).resolves.toBeUndefined();
  exists = false;
  await expect(session.ownNote("-42", "123")).resolves.toBeUndefined();
});

test("uses the same sender identities in history and conversation search", async () => {
  const rows = [
    { id: 5, sender_id: { "@type": "messageSenderUser", user_id: 7 } },
    { id: 4, sender_id: { "@type": "messageSenderUser", user_id: 7 } },
    { id: 3, sender_id: { "@type": "messageSenderChat", chat_id: -99 } },
    { id: 2, sender_id: { "@type": "messageSenderChat", chat_id: -42 }, author_signature: "Signed fixture" },
    { id: 1, is_outgoing: true },
  ].map((row) => ({ "@type": "message", chat_id: -42, ...row }));
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: query.chat_id === -99 ? "Channel fixture" : "Group fixture" };
      case "getUser": return { "@type": "user", id: 7, first_name: "Member", last_name: "Fixture",
        profile_photo: { "@type": "profilePhoto", small: { "@type": "file", id: 55 } } };
      case "getChatHistory":
      case "searchChatMessages": return { "@type": "messages", messages: rows };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const expected = ["Member Fixture", "Member Fixture", "Channel fixture", "Signed fixture", "You"];
  const history = await session.history("-42");
  expect(history.messages.map(({ author }) => author)).toEqual([...expected].reverse());
  expect(history.messages.at(-1)?.authorAvatar).toEqual({ id: "7", user: true, fileId: 55 });
  const matches = await session.searchMessages("-42", "fixture");
  expect(matches.messages.map(({ author }) => author)).toEqual(expected);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getUser")).toHaveLength(2);
});

test("does not dispatch an approved send after the selected Telegram sender changes", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: 42,
      message_sender_id: { "@type": "messageSenderChat", chat_id: -99 } };
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendText("42", "Fixture", undefined, undefined, () => true, "account")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(0);
});

test("merges local and server chat search and still returns local matches after server failure", async () => {
  let serverAvailable = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChats": return { "@type": "chats", chat_ids: [42, 43] };
      case "searchChatsOnServer":
        if (!serverAvailable) throw new TdError(500);
        return { "@type": "chats", chat_ids: [43, 44] };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.search("Fixture")).map(({ id }) => id)).toEqual(["42", "43", "44"]);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getChat" && query.chat_id === 43)).toHaveLength(1);
  serverAvailable = false;
  expect((await session.search("Fixture")).map(({ id }) => id)).toEqual(["42", "43"]);
});

test("finds Intel Homebrew TDLib and respects a configured library path", () => {
  const intel = "/usr/local/opt/tdlib/lib/libtdjson.dylib";
  const custom = "/fixture/libtdjson.dylib";
  const exists = (path: string) => path === intel || path === custom;
  expect(findTdjsonLibrary(undefined, exists)).toBe(intel);
  expect(findTdjsonLibrary(custom, exists)).toBe(custom);
  expect(findTdjsonLibrary("/missing/libtdjson.dylib", exists)).toBeUndefined();
});

test("preserves the actionable TDLib load error when the worker exits", async () => {
  let emit!: (event: TdObject) => void;
  let stop!: () => void;
  const open: typeof connectTdJson = (_, onUpdate, onStop) => {
    emit = onUpdate;
    stop = onStop;
    return { close: async () => {}, request: async () => { throw new Error("worker stopped"); } };
  };
  const session = createTelegram({ library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  emit({ "@type": "makoshTdlibLoadFailed" });
  stop();
  await Promise.resolve();
  expect(session.status()).toMatchObject({ state: "error", message: expect.stringContaining("Python could not load TDLib") });
});

test("preserves allowed web links at Telegram UTF-16 offsets and ignores unsafe targets", async () => {
  const text = "😀 Details example.org reject";
  const { session } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: 42 };
    if (query["@type"] === "getChatHistory") return { "@type": "messages", messages: [{
      "@type": "message", chat_id: 42, id: 1,
      content: { "@type": "messageText", text: { "@type": "formattedText", text, entities: [
        { "@type": "textEntity", offset: 3, length: 7, type: { "@type": "textEntityTypeTextUrl", url: "https://example.com/path" } },
        { "@type": "textEntity", offset: 11, length: 11, type: { "@type": "textEntityTypeUrl" } },
        { "@type": "textEntity", offset: 23, length: 6, type: { "@type": "textEntityTypeTextUrl", url: "javascript:alert(1)" } },
      ] } },
    }] };
    throw new Error("Unexpected request");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).messages[0]?.links).toEqual([
    { offset: 3, length: 7, url: "https://example.com/path", hidden: true },
    { offset: 11, length: 11, url: "https://example.org/" },
  ]);
});

test("loads chronological context for a search result and excludes messages from other chats", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "getChatHistory") throw new Error("Unexpected request");
    return { "@type": "messages", messages: [
      { "@type": "message", id: 22, chat_id: 42 },
      { "@type": "message", id: 12, chat_id: 42 },
      { "@type": "message", id: 3, chat_id: 99 },
      { "@type": "message", id: 2, chat_id: 42 },
    ] };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.messageContext("42", "12")).map(({ id }) => id)).toEqual(["2", "12", "22"]);
  expect(request).toHaveBeenLastCalledWith({
    "@type": "getChatHistory", chat_id: 42, from_message_id: 12, offset: -6, limit: 13, only_local: false,
  });
  await expect(session.messageContext("42", "3")).resolves.toEqual([]);
});

test("exposes the outgoing read cursor in a direct chat only", async () => {
  const { session } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id, last_read_outbox_message_id: 12,
      type: { "@type": query.chat_id === 42 ? "chatTypePrivate" : "chatTypeSupergroup" } };
    return { "@type": "messages", messages: [] };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).readOutbox).toBe(12);
  expect((await session.history("-42")).readOutbox).toBeUndefined();
});

test("removes a replaced temporary message ID when Telegram confirms the send", async () => {
  const removed = vi.fn();
  const { session, update } = harness(() => ({ "@type": "authorizationStateReady" }), removed);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  update({ "@type": "updateMessageSendSucceeded", old_message_id: 8,
    message: { "@type": "message", chat_id: -42, id: 22, is_outgoing: true } });
  expect(removed).toHaveBeenCalledExactlyOnceWith({ id: "-42", messageIds: ["8"] });
  update({ "@type": "updateMessageSendSucceeded", old_message_id: 22,
    message: { "@type": "message", chat_id: -42, id: 22, is_outgoing: true } });
  expect(removed).toHaveBeenCalledOnce();
});

test("checks chat-level protection before listing notes and again before releasing the selected text", async () => {
  let protectedChat = true;
  const note = { "@type": "message", id: 123, chat_id: -42, is_outgoing: true,
    sender_id: { "@type": "messageSenderUser", user_id: 7 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Fixture" } } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, has_protected_content: protectedChat };
      case "getMe": return { "@type": "user", id: 7 };
      case "searchChatMessages": return { "@type": "messages", messages: [note] };
      case "getMessage": protectedChat = true; return note;
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownChatNotes("-42")).resolves.toEqual([]);
  expect(request.mock.calls.some(([query]) => query["@type"] === "searchChatMessages")).toBe(false);
  protectedChat = false;
  await expect(session.ownChatNotes("-42")).resolves.toMatchObject([{ id: "123" }]);
  await expect(session.ownNote("-42", "123")).resolves.toBeUndefined();
});

test("rechecks protection before an agent replies to a previously shared note", async () => {
  let protectOnRead = Infinity;
  let chatReads = 0;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, has_protected_content: ++chatReads >= protectOnRead };
      case "getMe": return { "@type": "user", id: 7 };
      case "getMessage": return { "@type": "message", id: 12, chat_id: 42, is_outgoing: true,
        sender_id: { "@type": "messageSenderUser", user_id: 7 },
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture" } } };
      case "sendMessage": return { "@type": "message", id: 13, chat_id: 42, reply_to_message_id: query.reply_to_message_id };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.sendText("42", "Agent reply", "12", "Original fixture", () => true, "account"))
    .resolves.toMatchObject({ state: "sent" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
  protectOnRead = chatReads + 3;
  await expect(session.sendText("42", "Agent reply", "12", "Original fixture", () => true, "account"))
    .resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
  await expect(session.sendText("42", "Manual reply", "12")).resolves.toMatchObject({ state: "sent" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(2);
});

test("downloads a document by its verified message and denies protected chats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-doc-test-"));
  try {
    const path = join(directory, "local");
    await writeFile(path, "Fixture");
    let locked = true;
    let fileId = 77;
    let replaceOnDownload = false;
    const { session, request } = harness((query) => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getChat": return { "@type": "chat", id: 42, has_protected_content: locked };
        case "getMessage": return { "@type": "message", chat_id: 42, id: 12, content: {
          "@type": "messageDocument", document: { "@type": "document", file_name: "../Fixture.txt",
            document: { "@type": "file", id: fileId, size: 7 } },
        } };
        case "downloadFile": {
          if (replaceOnDownload) fileId++;
          return { "@type": "file", id: query.file_id,
            local: { "@type": "localFile", path, is_downloading_completed: true } };
        }
        default: throw new Error("Unexpected request");
      }
    }, undefined, directory);
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    await expect(session.document("42", "12")).rejects.toThrow("unavailable");
    expect(request.mock.calls.some(([q]) => q["@type"] === "downloadFile")).toBe(false);
    locked = false;
    await expect(session.document("42", "13")).rejects.toThrow("unavailable");
    const download = await session.document("42", "12");
    expect(download).toMatchObject({ name: "_Fixture.txt", size: 7 });
    await expect(new Response(download.body).text()).resolves.toBe("Fixture");
    replaceOnDownload = true;
    await expect(session.document("42", "12")).rejects.toThrow("document changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["1.8.0", "1.8.70"])("sends a document with its safe basename and caption using TDLib %s only when allowed", async (version) => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-upload-test-"));
  let canSendDocuments = false;
  try {
    const { session, request } = harness((query) => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getOption": return { "@type": "optionValueString", value: version };
        case "getChat": return { "@type": "chat", id: -42, type: { "@type": "chatTypeBasicGroup", basic_group_id: 42 },
          permissions: { "@type": "chatPermissions", can_send_basic_messages: false, can_send_documents: canSendDocuments } };
        case "getBasicGroup": return { "@type": "basicGroup", id: 42, is_active: true, status: { "@type": "chatMemberStatusMember" } };
        case "sendMessage": return { "@type": "message", id: 13, chat_id: -42 };
        default: throw new Error("Unexpected request");
      }
    }, undefined, directory);
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    await expect(session.sendDocument("-42", "../Fixture.txt", "Caption", "Rml4dHVyZQ==")).resolves.toEqual({ state: "failed" });
    expect(request.mock.calls.some(([q]) => q["@type"] === "sendMessage")).toBe(false);
    canSendDocuments = true;
    await expect(session.sendDocument("-42", "../Fixture.txt", "Caption", "Rml4dHVyZQ==")).resolves.toMatchObject({ state: "sent" });
    const document = { "@type": "inputFileLocal", path: expect.stringMatching(/\/_Fixture\.txt$/) };
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      "@type": "sendMessage", chat_id: -42, input_message_content: expect.objectContaining({
        "@type": "inputMessageDocument",
        ...(version === "1.8.0"
          ? { document, disable_content_type_detection: true }
          : { document: { "@type": "inputDocument", document, disable_content_type_detection: true } }),
        caption: { "@type": "formattedText", text: "Caption", entities: [] },
      }),
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("checks TDLib compatibility and account limits before staging a large upload", async () => {
  let version = "1.8.0";
  let premium = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: version };
      case "getMe": return { "@type": "user", id: 42, is_premium: premium };
      default: throw new Error("Unexpected request");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const standard = 2000 * 1024 ** 2;
  const premiumLimit = 4000 * 1024 ** 2;
  await expect(session.checkDocumentUpload(standard)).resolves.toBeUndefined();
  expect(request.mock.calls.some(([query]) => query["@type"] === "getOption")).toBe(false);
  await expect(session.checkDocumentUpload(standard + 1)).resolves.toBe("legacy_tdlib");
  await expect(session.runtimeInfo()).resolves.toMatchObject({ tdlibVersion: "1.8.0" });
  version = "1.8.70";
  await expect(session.checkDocumentUpload(standard + 1)).resolves.toBe("premium_required");
  premium = true;
  await expect(session.checkDocumentUpload(premiumLimit)).resolves.toBeUndefined();
  request.mockClear();
  await expect(session.checkDocumentUpload(premiumLimit + 1)).resolves.toBe("file_too_large");
  expect(request).not.toHaveBeenCalled();
});

test("uses modern TDLib message properties to display and recheck edit permission", async () => {
  let allowed = true;
  const original = { "@type": "message", id: 25, chat_id: 42, is_outgoing: true,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture", entities: [] } } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [original] };
      case "getMessage": return original;
      case "getMessageProperties": return { "@type": "messageProperties", can_be_edited: allowed };
      case "editMessageText": return { ...original, content: query.input_message_content };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).messages[0]?.editable).toBe(true);
  allowed = false;
  await expect(session.editText("42", "25", "Updated fixture", "Original fixture")).resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.some(([query]) => query["@type"] === "editMessageText")).toBe(false);
  allowed = true;
  await expect(session.editText("42", "25", "Updated fixture", "Original fixture"))
    .resolves.toMatchObject({ state: "sent", message: { text: "Updated fixture" } });
});

test("cancels a TDLib document download when its HTTP request is aborted", async () => {
  const request = vi.fn(async (query: TdObject, _timeout?: number, signal?: AbortSignal): Promise<TdObject> => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getMessage": return { "@type": "message", chat_id: 42, id: 12, content: {
        "@type": "messageDocument", document: { "@type": "document", file_name: "Fixture.txt",
          document: { "@type": "file", id: 77, size: 7 } },
      } };
      case "downloadFile": return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      });
      case "cancelDownloadFile": return { "@type": "ok" };
      default: throw new Error("Unexpected request");
    }
  });
  const open: typeof connectTdJson = () => ({ request, close: async () => {} });
  const session = createTelegram({ library: "fixture", directory: "fixture", key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const controller = new AbortController();
  const download = session.document("42", "12", controller.signal);
  const rejected = expect(download).rejects.toThrow("Cancelled");
  await vi.waitFor(() => expect(request.mock.calls.some(([query]) => query["@type"] === "downloadFile")).toBe(true));
  controller.abort();
  await rejected;
  expect(request).toHaveBeenLastCalledWith({ "@type": "cancelDownloadFile", file_id: 77, only_if_pending: false });
});

test.each(["legacy", "modern"])("checks %s TDLib deletion scope again before writing", async (version) => {
  let everyone = true;
  const onDelete = vi.fn();
  const { session, request } = harness((query) => {
    const permissions = { can_be_deleted_only_for_self: true, can_be_deleted_for_all_users: everyone };
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return {
        "@type": "message", id: 25, chat_id: 42, ...(version === "legacy" ? permissions : {}),
      };
      case "getMessageProperties": return { "@type": "messageProperties", ...permissions };
      case "deleteMessages": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  }, onDelete);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.deletionOptions("42", "25")).resolves.toEqual(["self", "everyone"]);
  everyone = false;
  await expect(session.deleteMessage("42", "25", "everyone")).resolves.toBe("refused");
  await expect(session.deleteMessage("42", "26", "self")).resolves.toBe("refused");
  expect(request.mock.calls.some(([query]) => query["@type"] === "deleteMessages")).toBe(false);
  expect(onDelete).not.toHaveBeenCalled();
  await expect(session.deleteMessage("42", "25", "self")).resolves.toBe("deleted");
  expect(request).toHaveBeenCalledWith({ "@type": "deleteMessages", chat_id: 42, message_ids: [25], revoke: false });
  everyone = true;
  await expect(session.deleteMessage("42", "25", "everyone")).resolves.toBe("deleted");
  expect(request).toHaveBeenCalledWith({ "@type": "deleteMessages", chat_id: 42, message_ids: [25], revoke: true });
  expect(onDelete).toHaveBeenCalledTimes(2);
  expect(onDelete).toHaveBeenCalledWith({ id: "42", messageIds: ["25"] });
});

test.each([["Group", false], ["Channel", true]] as const)("creates a private %s without members or a username", async (kind, is_channel) => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "createNewSupergroupChat") return {
      "@type": "chat", id: -42, title: "Fixture",
      type: { "@type": "chatTypeSupergroup", supergroup_id: 7, is_channel },
    };
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.createPrivateChatSpace("Fixture", kind)).resolves.toMatchObject({ id: "-42", subtitle: kind });
  expect(request).toHaveBeenCalledWith({
    "@type": "createNewSupergroupChat", title: "Fixture", is_channel, description: "", for_import: false,
  });
});

test.each([["Group", false], ["Channel", true]] as const)("deletes a %s only after checking its exact title and ownership", async (kind, is_channel) => {
  let owner = false;
  let version = "1.8.70";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture", can_be_deleted_for_all_users: false,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 7, is_channel } };
      case "getSupergroup": return { "@type": "supergroup", id: 7,
        status: { "@type": owner ? "chatMemberStatusCreator" : "chatMemberStatusAdministrator" } };
      case "getOption": return { "@type": "optionValueString", value: version };
      case "deleteChat": return { "@type": "ok" };
      default: throw new Error("Unexpected TDLib request");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.deleteOwnedChatSpace("-42", "Wrong title", kind)).resolves.toBe("refused");
  await expect(session.deleteOwnedChatSpace("-42", "Fixture", kind)).resolves.toBe("not_owner");
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ "@type": "deleteChat" }));
  owner = true;
  await expect(session.deleteOwnedChatSpace("-42", "Fixture", kind)).resolves.toBe("not_deletable");
  version = "1.8.0";
  await expect(session.deleteOwnedChatSpace("-42", "Fixture", kind)).resolves.toBe("deleted");
  expect(request).toHaveBeenCalledWith({ "@type": "deleteChat", chat_id: -42 });
});

test.each([["Group", false], ["Channel", true]] as const)(
  "sends an approved agent draft through TDLib to a %s and rechecks rights",
  async (kind, is_channel) => {
    let allowed = true;
    let revokeOnApproval = false;
    const title = `Synthetic ${kind}`;
    const { session, request } = harness((query) => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getChat": return { "@type": "chat", id: -42, title,
          type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel },
          permissions: { "@type": "chatPermissions", can_send_basic_messages: allowed },
        };
        case "getSupergroup": return { "@type": "supergroup", id: 77, is_channel, status: is_channel
          ? { "@type": "chatMemberStatusAdministrator", rights: { "@type": "chatAdministratorRights", can_post_messages: allowed } }
          : { "@type": "chatMemberStatusMember" } };
        case "sendMessage": return { "@type": "message", id: 25, chat_id: -42, content: query.input_message_content };
        default: throw new Error("Unexpected test query");
      }
    });
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));

    let execute!: (input: { text: string; recipientId: string }, context: Pick<PluginAgentToolContext, "threadId" | "signal">) => Promise<string>;
    const dispatches = () => request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
    const requestInput = vi.fn<BbPluginApi["ui"]["requestInput"]>().mockImplementation(async ({ payload }) => {
      expect(payload).toEqual({ text: "Synthetic draft", recipients: [{
        id: "-42", name: title, kind, sender: is_channel ? title : "Your Telegram account",
      }], showRecipientId: true });
      expect(dispatches()).toHaveLength(0);
      if (revokeOnApproval) allowed = false;
      return { outcome: "submitted", value: { id: "-42" } };
    });
    const bb = {
      agents: { registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } },
      ui: { requestInput },
    } as unknown as BbPluginApi;
    registerAgentSend(bb, async () => true, () => session);
    const run = () => execute({ text: "Synthetic draft", recipientId: "-42" }, {
      threadId: "fixture", signal: new AbortController().signal,
    });

    revokeOnApproval = true;
    await expect(run()).resolves.toBe("Telegram rejected the message.");
    expect(dispatches()).toHaveLength(0);
    await expect(run()).resolves.toBe("No Telegram recipient is available for approval.");
    expect(requestInput).toHaveBeenCalledTimes(1);

    allowed = true;
    revokeOnApproval = false;
    await expect(run()).resolves.toBe("Telegram confirmed the message was sent.");
    expect(requestInput).toHaveBeenCalledTimes(2);
    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]?.[0]).toMatchObject({
      chat_id: -42,
      input_message_content: { "@type": "inputMessageText", text: { text: "Synthetic draft" } },
    });
  },
);

test("excludes chats that TDLib did not resolve to the requested ID", async () => {
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChats":
      case "searchChatsOnServer": return { "@type": "chats", chat_ids: [-42, -43] };
      case "getChat": return { "@type": "chat", id: -43, title: "Synthetic group" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.search("Synthetic group")).map(({ id }) => id)).toEqual(["-43"]);
});

test("downloads the sized Telegram preview and larger photo by different file IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-photo-sizes-"));
  const path = join(directory, "photo.jpg");
  try {
    await writeFile(path, Buffer.from("ffd8ffe00000000000000000", "hex"));
    const { session, request } = harness((query) => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getMessage": return { "@type": "message", id: 25, chat_id: 42, content: {
          "@type": "messagePhoto", photo: { "@type": "photo", sizes: [
            { "@type": "photoSize", width: 90, height: 90, photo: { "@type": "file", id: 1 } },
            { "@type": "photoSize", width: 640, height: 480, photo: { "@type": "file", id: 2 } },
            { "@type": "photoSize", width: 1280, height: 960, photo: { "@type": "file", id: 3 } },
          ] },
        } };
        case "downloadFile": return { "@type": "file", id: query.file_id,
          local: { "@type": "localFile", is_downloading_completed: true, path } };
        default: throw new Error("Unexpected test query");
      }
    }, undefined, directory);
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    await expect(session.photo("42", "25")).resolves.toMatchObject({ mime: "image/jpeg", hasLarger: true });
    await expect(session.photo("42", "25", "large")).resolves.toMatchObject({ mime: "image/jpeg" });
    const downloads = request.mock.calls.filter(([query]) => query["@type"] === "downloadFile");
    expect(downloads.map(([query]) => query.file_id)).toEqual([2, 3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["messageVideo", "video", "video", "fixture.mp4", "fixture.mp4"],
  ["messageAudio", "audio", "audio", "fixture.mp3", "fixture.mp3"],
  ["messageAnimation", "animation", "animation", "fixture.gif", "fixture.gif"],
  ["messageVideoNote", "video_note", "video", "", "Telegram video note.mp4"],
  ["messageVoiceNote", "voice_note", "voice", "", "Telegram voice message.ogg"],
])("downloads the original file from %s, with Telegram's protection applied", async (type, field, fileField, filename, expectedName) => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-media-"));
  try {
    const path = join(directory, "file");
    await writeFile(path, "Fixture");
    let protectedContent = true;
    let size = 7;
    const mime = type === "messageVoiceNote" ? "audio/ogg" : type === "messageAudio" ? "audio/mpeg"
      : type === "messageAnimation" ? "image/gif" : "video/mp4";
    const { session, request } = harness((query) => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getChat": return { "@type": "chat", id: 42 };
        case "getMessage": return { "@type": "message", chat_id: 42, id: 12, content: {
          "@type": type,
          is_secret: protectedContent,
          [field]: { "@type": field, file_name: filename, mime_type: mime,
            [fileField]: { "@type": "file", id: 77, size } },
        } };
        case "downloadFile": return { "@type": "file", id: 77,
          local: { "@type": "localFile", path, is_downloading_completed: true } };
        default: throw new Error("Unexpected request");
      }
    }, undefined, directory);
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    await expect(session.document("42", "12")).rejects.toThrow("unavailable");
    await expect(session.documentName("42", "12", true)).rejects.toThrow("unavailable");
    expect(request.mock.calls.some(([query]) => query["@type"] === "downloadFile")).toBe(false);
    protectedContent = false;
    const download = await session.document("42", "12");
    expect(download).toMatchObject({ name: expectedName, size: 7 });
    await expect(new Response(download.body).text()).resolves.toBe("Fixture");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "downloadFile"))
      .toEqual([[{ "@type": "downloadFile", file_id: 77, priority: 16, limit: 0, synchronous: true }, 7200000]]);
    {
      await expect(session.documentName("42", "12", true)).resolves.toBe(expectedName);
      const playback = await session.document("42", "12", undefined, true);
      await expect(new Response(playback.body).text()).resolves.toBe("Fixture");
      expect(request).toHaveBeenCalledWith({
        "@type": "downloadFile", file_id: 77, priority: 16, limit: 32 * 1024 ** 2 + 1, synchronous: true,
      }, 7200000);
      size = 32 * 1024 ** 2 + 1;
      await expect(session.documentName("42", "12", true)).rejects.toThrow("unavailable");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pins silently and unpins only the selected message after rechecking its rights", async () => {
  let pinned = false;
  let allowed = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { "@type": "message", id: 25, chat_id: -42, is_pinned: pinned };
      case "getMessageProperties": return { "@type": "messageProperties", can_be_pinned: allowed };
      case "pinChatMessage": pinned = true; return { "@type": "ok" };
      case "unpinChatMessage": pinned = false; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.pinStatus("-42", "25")).resolves.toBe(false);
  allowed = false;
  await expect(session.setMessagePinned("-42", "25", true)).resolves.toBe("refused");
  allowed = true;
  await expect(session.setMessagePinned("-42", "26", true)).resolves.toBe("refused");
  await expect(session.setMessagePinned("-42", "25", true)).resolves.toBe("updated");
  await expect(session.setMessagePinned("-42", "25", true)).resolves.toBe("updated");
  await expect(session.pinStatus("-42", "25")).resolves.toBe(true);
  await expect(session.setMessagePinned("-42", "25", false)).resolves.toBe("updated");
  expect(request.mock.calls.map(([query]) => query).filter(({ "@type": type }) => /^(unpin|pin)ChatMessage$/.test(type)))
    .toEqual([
      { "@type": "pinChatMessage", chat_id: -42, message_id: 25, disable_notification: true, only_for_self: false },
      { "@type": "unpinChatMessage", chat_id: -42, message_id: 25 },
    ]);
});

test("leaves legacy pin permission enforcement to TDLib", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { "@type": "message", id: 25, chat_id: -42, is_pinned: false, can_be_edited: false };
      case "pinChatMessage": throw new TdError(400);
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.pinStatus("-42", "25")).resolves.toBe(false);
  await expect(session.setMessagePinned("-42", "25", true)).resolves.toBe("refused");
  expect(request.mock.calls.some(([query]) => query["@type"] === "getMessageProperties")).toBe(false);
});

test("passes bounded Telegram avatar previews to chat views and refreshes when a chat photo changes", async () => {
  const avatar = "/9j/AA==";
  let data = avatar;
  const onChatChanged = vi.fn();
  const { session, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture", photo: {
        "@type": "chatPhotoInfo", minithumbnail: { "@type": "minithumbnail", data },
      } };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, undefined, onChatChanged);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.chatById("-42")).toHaveProperty("avatarJpeg", avatar);
  for (const invalid of ["data:image/svg+xml,fixture", `/9j/${"A".repeat(8192)}`]) {
    data = invalid;
    update({ "@type": "updateChatPhoto", chat_id: -42 });
    expect(await session.chatById("-42")).not.toHaveProperty("avatarJpeg");
  }
  expect(onChatChanged).toHaveBeenCalledTimes(2);
});

test("maps Telegram formatting ranges in UTF-16 and excludes invalid ranges", async () => {
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        { "@type": "message", id: 25, chat_id: 42, content: {
          "@type": "messageText", text: { "@type": "formattedText", text: "🌿 Fixture code", entities: [
            { "@type": "textEntity", offset: 3, length: 7, type: { "@type": "textEntityTypeBold" } },
            { "@type": "textEntity", offset: 11, length: 4, type: { "@type": "textEntityTypeCode" } },
            { "@type": "textEntity", offset: 15, length: 1, type: { "@type": "textEntityTypeItalic" } },
          ] },
        } },
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).messages[0]).toMatchObject({
    text: "🌿 Fixture code",
    styles: [{ offset: 3, length: 7, style: "bold" }, { offset: 11, length: 4, style: "code" }],
  });
});

test("keeps a spoiler hidden when the displayed message ends inside its range", async () => {
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        { "@type": "message", id: 25, chat_id: 42, content: {
          "@type": "messageText", text: { "@type": "formattedText", text: "A".repeat(8194), entities: [
            { "@type": "textEntity", offset: 8190, length: 4, type: { "@type": "textEntityTypeSpoiler" } },
          ] },
        } },
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).messages[0]?.styles).toEqual([{ offset: 8190, length: 2, style: "spoiler" }]);
});

test("preserves Telegram photo, video and GIF spoiler and caption placement metadata", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        { "@type": "message", id: 25, chat_id: 42, content: {
          "@type": "messagePhoto", show_caption_above_media: true, has_spoiler: true,
          caption: { "@type": "formattedText", text: "Caption fixture" },
          photo: { "@type": "photo", sizes: [
            { "@type": "photoSize", width: 320, height: 240, photo: { "@type": "file", id: 2 } },
          ] },
        } },
        ...["messageVideo", "messageAnimation"].map((type, index) => ({
          "@type": "message", id: 24 - index, chat_id: 42, content: {
            "@type": type, has_spoiler: true,
          },
        })),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const { messages } = await session.history("42");
  expect(messages.find(({ id }) => id === "25")).toMatchObject({
    hasPhoto: true, photoDimensions: { width: 320, height: 240 },
    photoSpoiler: true, photoCaption: "Caption fixture", captionAboveMedia: true,
  });
  for (const id of ["24", "23"]) expect(messages.find((row) => row.id === id)?.videoSpoiler).toBe(true);
  expect(request.mock.calls.some(([query]) => query["@type"] === "downloadFile")).toBe(false);
});

test("routes a manual or approved agent reply to the exact Telegram forum topic", async () => {
  let forumTopicId = 17;
  let parentTopicId = 17;
  let topicName = "Fixture topic";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 7 };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getForumTopic": return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: forumTopicId, name: topicName,
      } };
      case "getMessage": return {
        "@type": "message", id: 12, chat_id: -42, is_outgoing: true,
        sender_id: { "@type": "messageSenderUser", user_id: 7 },
        topic_id: { "@type": "messageTopicForum", forum_topic_id: parentTopicId },
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture" } },
      };
      case "sendMessage": return { "@type": "message", id: 13, chat_id: -42, topic_id: query.topic_id,
        reply_to_message_id: query.reply_to_message_id, content: query.input_message_content };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownNote("-42", "12")).resolves.toMatchObject({ forumTopicId: 17 });
  await expect(session.sendText("-42", "Manual fixture", "12")).resolves.toMatchObject({ state: "sent" });
  const reply = () => session.sendText("-42", "Agent fixture", "12", "Original fixture", () => true, "account", { id: 17, name: "Fixture topic" });
  forumTopicId = 18;
  await expect(reply()).resolves.toEqual({ state: "failed" });
  forumTopicId = 17;
  topicName = "Renamed topic";
  await expect(reply()).resolves.toEqual({ state: "failed" });
  topicName = "Fixture topic";
  await expect(reply()).resolves.toMatchObject({ state: "sent" });
  const writes = request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
  expect(writes).toHaveLength(2);
  for (const [query] of writes) expect(query).toMatchObject({
    chat_id: -42,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
    reply_to: { "@type": "inputMessageReplyToMessage", message_id: 12 },
  });
  await expect(session.sendText("-42", "New topic post", undefined, undefined, undefined, undefined,
    { id: 17, name: "Fixture topic" })).resolves.toMatchObject({ state: "sent", message: { forumTopicId: 17 } });
  const last = request.mock.lastCall?.[0];
  expect(last).toMatchObject({ chat_id: -42, topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 } });
  expect(last).not.toHaveProperty("reply_to");
  const source = { id: 17, name: "Fixture topic" };
  await expect(session.sendText("-42", "Topic reply", "12", undefined, undefined, undefined, source, undefined,
    { styles: [{ offset: 0, length: 5, style: "italic" }], quote: { text: "fixture", position: 9 } }))
    .resolves.toMatchObject({ state: "sent", message: { forumTopicId: 17 } });
  expect(request.mock.lastCall?.[0]).toMatchObject({
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
    reply_to: { "@type": "inputMessageReplyToMessage", message_id: 12,
      quote: { "@type": "inputTextQuote", position: 9, text: { text: "fixture" } } },
    input_message_content: { text: { entities: [
      { "@type": "textEntity", offset: 0, length: 5, type: { "@type": "textEntityTypeItalic" } },
    ] } },
  });
  const commandCount = request.mock.calls.filter(([query]) => query["@type"] === "sendMessage").length;
  parentTopicId = 18;
  await expect(session.sendText("-42", "Mismatched reply", "12", undefined, undefined, undefined, source, undefined,
    { quote: { text: "fixture", position: 9 } }))
    .resolves.toEqual({ state: "failed" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(commandCount);
});

test("lists only topics in the requested forum and rejects history from a different topic", async () => {
  const item = (id: number, topic: number) => ({
    "@type": "message", id, chat_id: -42,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: topic },
  });
  const topic = (id: number, chatId: number) => ({ "@type": "forumTopic", info: {
    "@type": "forumTopicInfo", forum_topic_id: id, chat_id: chatId, name: "Fixture topic", is_closed: false,
  } });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: {
        "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: query.chat_id === -43,
      } };
      case "getSupergroup": return { "@type": "supergroup", id: 77, is_forum: true, is_channel: false };
      case "getForumTopics": return { "@type": "forumTopics", topics: [topic(17, -42), topic(99, -43)] };
      case "getForumTopicHistory": return { "@type": "messages", messages: [item(25, 17), item(20, 18), item(19, 17)] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.forumTopics("-43", "")).resolves.toBeNull();
  await expect(session.forumTopics("-42", "Fixture")).resolves.toEqual([{ id: 17, name: "Fixture topic", closed: false }]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getForumTopics", chat_id: -42, query: "Fixture" }));
  const page = await session.history("-42", "25", 17);
  expect(page.before).toBe("19");
  expect(page.messages.map(({ id }) => id)).toEqual(["19"]);
  expect(request).toHaveBeenCalledWith({
    "@type": "getForumTopicHistory", chat_id: -42, forum_topic_id: 17, from_message_id: 25, offset: 0, limit: 50,
  });
});

test("reviews and searches only the unchanged channel posts recorded for a manual send by the current account", async () => {
  const db = new Database(":memory:");
  db.exec(channelPostReceiptMigrations[0]!);
  const receipts = createChannelPostReceipts(db, "fixture");
  let account = 7;
  let text = "Synthetic channel post";
  let editDate = 0;
  let protectedChat = false;
  let signed = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: account };
      case "getChat": return { "@type": "chat", id: -42, has_protected_content: protectedChat,
        type: { "@type": "chatTypeSupergroup", is_channel: true, supergroup_id: 42 } };
      case "searchChatMessages": return { "@type": "foundChatMessages", messages: [] };
      case "getMessage": return { "@type": "message", id: query.message_id, chat_id: -42, is_outgoing: false,
        is_channel_post: true, edit_date: editDate,
        sender_id: signed ? { "@type": "messageSenderUser", user_id: 7 } : { "@type": "messageSenderChat", chat_id: -42 },
        author_signature: "Unverified display signature",
        content: { "@type": "messageText", text: { "@type": "formattedText", text } },
      };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, undefined, undefined, receipts);
  try {
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    await expect(session.ownNote("-42", "25")).resolves.toBeUndefined();
    await session.recordManualChannelPost("-42", { id: "25", text, author: "Fixture", time: "", isChannelPost: true }, text);
    await expect(session.ownNote("-42", "25")).resolves.toMatchObject({ id: "25", text });
    await expect(session.ownNote("-42", "26")).resolves.toBeUndefined();
    receipts.record("8", "-42", "27", text);
    receipts.record("7", "-43", "28", text);
    request.mockClear();
    await expect(session.ownChatNotes("-42", "CHANNEL POST")).resolves.toMatchObject([{ id: "25", text }]);
    const fetched = request.mock.calls.map(([query]) => query).filter((query) => query["@type"] === "getMessage");
    expect(fetched).toEqual([{ "@type": "getMessage", chat_id: -42, message_id: 25 }]);
    await expect(session.ownChatNotes("-42", "unrelated")).resolves.toEqual([]);
    expect(JSON.stringify(db.prepare("SELECT * FROM telegram_channel_post_receipts").all())).not.toContain(text);

    account = 8;
    await expect(session.ownNote("-42", "25")).resolves.toBeUndefined();
    account = 7;
    text = "A different synthetic text";
    await expect(session.ownNote("-42", "25")).resolves.toBeUndefined();
    await expect(session.ownChatNotes("-42")).resolves.toEqual([]);
    text = "Synthetic channel post";
    editDate = 123;
    await expect(session.ownNote("-42", "25")).resolves.toBeUndefined();
    editDate = 0;
    protectedChat = true;
    await expect(session.ownNote("-42", "25")).resolves.toBeUndefined();
    protectedChat = false;

    signed = true;
    await expect(session.ownNote("-42", "26")).resolves.toMatchObject({ id: "26", text });
    editDate = 123;
    await expect(session.ownNote("-42", "26")).resolves.toBeUndefined();
  } finally {
    db.close();
  }
});

test("searches shared photos and videos without a caption query and filters unrelated messages", async () => {
  const photo = { "@type": "message", id: 12, chat_id: 42, content: { "@type": "messagePhoto" } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatMessages": return { "@type": "messages", messages: [
        { ...photo, id: 15, chat_id: 43 }, { ...photo, id: 14, content: { "@type": "messageText" } },
        { ...photo, id: 13, content: { "@type": "messageVideo" } }, photo,
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const pictures = await session.searchMessages("42", "", "photo");
  expect(pictures.messages.map(({ id }) => id)).toEqual(["12"]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    "@type": "searchChatMessages", chat_id: 42, query: "", filter: { "@type": "searchMessagesFilterPhoto" },
  }));
  const shared = await session.searchMessages("42", "", "photoVideo");
  expect(shared.messages.map(({ id }) => id)).toEqual(["13", "12"]);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
    "@type": "searchChatMessages", chat_id: 42, query: "", filter: { "@type": "searchMessagesFilterPhotoAndVideo" },
  }));
  await session.close();
});

test("signs out only when TDLib acknowledges logout and closes the authenticated session", async () => {
  let refuse = true;
  const { session, request, auth } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "logOut") {
      if (refuse) throw new TdError(400);
      return { "@type": "ok" };
    }
    throw new Error("Unexpected test query");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.signOut()).rejects.toBeInstanceOf(TdError);
  expect(session.status()).toEqual({ state: "ready" });

  refuse = false;
  const finished = vi.fn();
  const signingOut = session.signOut().then(finished);
  expect(session.status()).toEqual({ state: "disconnecting" });
  auth("authorizationStateLoggingOut");
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  auth("authorizationStateClosed");
  await signingOut;
  expect(finished).toHaveBeenCalledOnce();
  expect(request.mock.calls.filter(([query]) => query["@type"] === "logOut")).toHaveLength(2);
});

test("prefers TDLib's exact 64-bit document size and marks estimates", async () => {
  const document = (id: number, size: number, expected_size: number) => ({
    "@type": "message", id, chat_id: 42, content: { "@type": "messageDocument",
      document: { "@type": "document", file_name: "fixture.bin",
        document: { "@type": "file", id, size, expected_size } },
    },
  });
  const bytes = 4 * 1024 ** 3;
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        document(14, bytes + 1, 0), document(13, 0, 1024), document(12, bytes, bytes + 1),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("42")).messages.map(({ document }) => document)).toEqual([
    { name: "fixture.bin", sizeBytes: bytes, downloadable: true },
    { name: "fixture.bin", sizeBytes: 1024, approximateSize: true, downloadable: true },
    { name: "fixture.bin", sizeBytes: bytes + 1, downloadable: false },
  ]);
});

test("resolves forwarded sources on old and new TDLib without confusing them with the sender", async () => {
  const forwarded = (id: number, origin: TdObject) => ({
    "@type": "message", id, chat_id: 42, is_outgoing: true,
    forward_info: { "@type": "messageForwardInfo", origin },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Forwarded fixture" } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture channel" };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: "Fixture author" };
      case "getChatHistory": return { "@type": "messages", messages: [
        forwarded(13, { "@type": "messageOriginChannel", chat_id: -97 }),
        forwarded(12, { "@type": "messageOriginHiddenUser", sender_name: " Hidden fixture " }),
        forwarded(11, { "@type": "messageForwardOriginUser", sender_user_id: 9 }),
        forwarded(10, { "@type": "messageOriginUser", sender_user_id: 9 }),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const page = await session.history("42");
  expect(page.messages.map(({ author, forwardedFrom }) => [author, forwardedFrom])).toEqual([
    ["You", "Fixture author"], ["You", "Fixture author"], ["You", "Hidden fixture"], ["You", "Fixture channel"],
  ]);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getUser")).toHaveLength(1);
});

test("rejects an agent send if the reviewed group name changed before dispatch", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "New fixture name",
        type: { "@type": "chatTypeBasicGroup", basic_group_id: 77 } };
      case "getBasicGroup": return { "@type": "basicGroup", id: 77, status: { "@type": "chatMemberStatusAdministrator" } };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const authorize = vi.fn(() => true);
  await expect(session.sendText("-42", "Synthetic draft", undefined, undefined, authorize,
    { key: "account", name: "Reviewed fixture name", kind: "Group" })).resolves.toEqual({ state: "failed" });
  expect(authorize).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessage")).toBe(false);
});

test("scopes chat search to the selected folder or archive across TDLib formats", async () => {
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChats":
      case "searchChatsOnServer": return { "@type": "chats", chat_ids: [1, 2, 3, 4] };
      case "getChat": {
        const id = query.chat_id;
        const folder = { "@type": "chatListFolder", chat_folder_id: 7 };
        const legacy = { "@type": "chatListFilter", chat_filter_id: 7 };
        const archive = { "@type": "chatListArchive" };
        const lists = id === 1 ? { chat_lists: [folder] }
          : id === 2 ? { positions: [{ "@type": "chatPosition", list: legacy, order: "1" }] }
          : id === 3 ? { chat_lists: [archive] }
          : { positions: [{ "@type": "chatPosition", list: legacy, order: "0" }] };
        return { "@type": "chat", id, title: "Fixture", ...lists };
      }
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.search("Fixture", 7)).map(({ id }) => id)).toEqual(["1", "2"]);
  expect((await session.search("Fixture", "archive")).map(({ id }) => id)).toEqual(["3"]);
});

test("copies a TDLib message link that resolves to the same chat and message", async () => {
  const url = "https://t.me/c/123/45";
  let messageChat = -42;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessageLink": return { "@type": "messageLink", link: url };
      case "getMessageLinkInfo": return { "@type": "messageLinkInfo", chat_id: -42,
        message: { "@type": "message", id: 25, chat_id: messageChat } };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.messageLink("-42", "25")).resolves.toBe(url);
  await expect(session.messageLinkReference(url)).resolves.toStrictEqual({ chatId: "-42", messageId: "25" });
  messageChat = -43;
  await expect(session.messageLinkReference(url)).resolves.toBeUndefined();
  await expect(session.messageLinkReference("https://example.com/c/123/45")).resolves.toBeUndefined();
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getMessageLinkInfo")).toHaveLength(2);
});

test("maps legacy polls and respects explicit result visibility in modern TDLib", async () => {
  const formatted = (text: string) => ({ "@type": "formattedText", text });
  const legacy = {
    "@type": "poll",
    question: "Legacy poll",
    options: [{ "@type": "pollOption", text: "Choice A", is_chosen: true, vote_percentage: 100 }],
    total_voter_count: 1,
    type: { "@type": "pollTypeRegular", allow_multiple_answers: true },
  };
  const modern = {
    "@type": "poll",
    question: formatted("Modern quiz"),
    options: [{ "@type": "pollOption", text: formatted("Choice B"), is_chosen: false, vote_percentage: 0 }],
    total_voter_count: 0,
    type: { "@type": "pollTypeQuiz" },
    is_closed: true,
  };
  const onChatChanged = vi.fn();
  const { session, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: -42 };
    if (query["@type"] === "getChatHistory") return {
      "@type": "messages",
      messages: [
        { ...modern, can_see_results: true },
        { ...modern, can_see_results: false },
        legacy,
      ].map((poll, index) => ({
        "@type": "message", id: 3 - index, content: { "@type": "messagePoll", poll },
      })),
    };
    throw new Error("Unexpected test query");
  }, undefined, undefined, onChatChanged);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));

  const { messages } = await session.history("-42");
  expect(messages.map(({ text, poll }) => ({ text, poll }))).toEqual([
    { text: "Legacy poll", poll: {
      question: "Legacy poll", options: [{ index: 0, text: "Choice A", chosen: true, percentage: 100 }],
      canVote: true, multiple: true, closed: false, quiz: false, voters: 1,
    } },
    { text: "Modern quiz", poll: {
      question: "Modern quiz", options: [{ index: 0, text: "Choice B", chosen: false }],
      canVote: false, multiple: false, closed: true, quiz: true,
    } },
    { text: "Modern quiz", poll: {
      question: "Modern quiz", options: [{ index: 0, text: "Choice B", chosen: false, percentage: 0 }],
      canVote: false, multiple: false, closed: true, quiz: true, voters: 0,
    } },
  ]);
  onChatChanged.mockClear();
  update({ "@type": "updatePoll", poll: modern });
  await vi.waitFor(() => expect(onChatChanged).toHaveBeenCalledOnce());
});

test("votes using the TDLib index after checking the current poll options", async () => {
  const option = (id: string, text: string) => ({ "@type": "pollOption", id, text });
  const poll = {
    "@type": "poll", question: "Fixture poll", options: [option("a", "First"), option("b", "Second")],
    option_order: [1, 0], allows_multiple_answers: false,
  };
  const current = {
    "@type": "message", id: 9, chat_id: -42, content: { "@type": "messagePoll", poll },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getChatHistory": return { "@type": "messages", messages: [current] };
      case "getMessage": return current;
      case "setPollAnswer": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const { messages } = await session.history("-42");
  const options = messages[0]?.poll?.options;
  expect(options?.map(({ index }) => index)).toEqual([1, 0]);
  await expect(session.voteInPoll("-42", "9", [{ index: 1, id: "old", text: "Second" }])).resolves.toBe(false);
  await expect(session.voteInPoll("-42", "9", options!)).resolves.toBe(false);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "setPollAnswer")).toHaveLength(0);
  await expect(session.voteInPoll("-42", "9", [options![0]!])).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith({
    "@type": "setPollAnswer", chat_id: -42, message_id: 9, option_ids: [1],
  });
});

test("rechecks the reviewed direct chat name and accepts the Saved Messages alias only for the owner", async () => {
  let ownerId = 42;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: ownerId };
      case "getChat": return {
        "@type": "chat", id: 42, title: "Current fixture name",
        type: { "@type": "chatTypePrivate", user_id: 42 },
      };
      case "sendMessage": return { "@type": "message", id: 25, chat_id: 42 };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const authorize = vi.fn(() => true);
  const send = (name: string) => session.sendText("42", "Synthetic draft", undefined, undefined, authorize,
    { key: "account", name, kind: "Direct message" });
  await expect(send("Old fixture name")).resolves.toEqual({ state: "failed" });
  ownerId = 43;
  await expect(send("Saved Messages")).resolves.toEqual({ state: "failed" });
  expect(authorize).not.toHaveBeenCalled();
  ownerId = 42;
  await expect(send("Saved Messages")).resolves.toMatchObject({ state: "sent" });
  await expect(send("Current fixture name")).resolves.toMatchObject({ state: "sent" });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(2);
});

test.each(["1.8.0", "1.8.70"])("sends a photo only to the selected still-matching forum topic with TDLib %s", async (version) => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-topic-photo-"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]).toString("base64");
  let parentTopic = 18;
  let topicName = "Renamed topic";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: version };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getForumTopic": return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17, name: topicName,
      } };
      case "getMessage": return { "@type": "message", id: 12, chat_id: -42,
        topic_id: { "@type": "messageTopicForum", forum_topic_id: parentTopic } };
      case "sendMessage": return { "@type": "message", id: 13, chat_id: -42, topic_id: query.topic_id, reply_to_message_id: query.reply_to_message_id };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, directory);
  try {
    await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
    const send = () => session.sendPhoto("-42", "Fixture caption", jpeg, { id: 17, name: "Fixture topic" }, "12",
      { spoiler: true, captionAbove: true });
    await expect(send()).resolves.toEqual({ state: "failed" });
    expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessage")).toBe(false);
    topicName = "Fixture topic";
    await expect(send()).resolves.toEqual({ state: "failed", uploadRejection: "reply_unavailable" });
    expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessage")).toBe(false);
    await expect(session.attachmentReplyAvailable("-42", "12", 17)).resolves.toBe(false);
    parentTopic = 17;
    await expect(session.attachmentReplyAvailable("-42", "12", 17)).resolves.toBe(true);
    await expect(send()).resolves.toMatchObject({ state: "sent", message: { forumTopicId: 17 } });
    const photo = { "@type": "inputFileLocal", path: expect.stringMatching(/\/photo\.jpg$/) };
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      "@type": "sendMessage", chat_id: -42, topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
      reply_to: { "@type": "inputMessageReplyToMessage", message_id: 12 },
      input_message_content: expect.objectContaining({
        "@type": "inputMessagePhoto", caption: { "@type": "formattedText", text: "Fixture caption", entities: [] },
        has_spoiler: true, show_caption_above_media: true,
        ...(version === "1.8.0" ? { photo, width: 1, height: 1 } : { photo: { "@type": "inputPhoto", photo, width: 1, height: 1 } }),
      }),
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads reply context from the forum topic and rejects context from a different topic", async () => {
  const row = (id: number, topic: number, chat_id = -42) => ({
    "@type": "message", id, chat_id, topic_id: { "@type": "messageTopicForum", forum_topic_id: topic },
  });
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "getForumTopicHistory") throw new Error("Unexpected request");
    return { "@type": "messages", messages: [row(15, 17), row(14, 18), row(12, 17), row(11, 17, -99), row(10, 17)] };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.messageContext("-42", "12", 17)).map(({ id }) => id)).toEqual(["10", "12", "15"]);
  expect(request).toHaveBeenLastCalledWith({
    "@type": "getForumTopicHistory", chat_id: -42, forum_topic_id: 17, from_message_id: 12, offset: -6, limit: 13,
  });
  await expect(session.messageContext("-42", "14", 17)).resolves.toEqual([]);
});

test("searches a specific forum topic and drops matches outside it", async () => {
  const row = (id: number, chat_id: number, forum_topic_id: number) => ({
    "@type": "message", id, chat_id, topic_id: { "@type": "messageTopicForum", forum_topic_id },
  });
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "searchChatMessages") throw new Error("Unexpected request");
    return { "@type": "foundChatMessages", messages: [row(9, -42, 17), row(7, -42, 18), row(3, -99, 17)] };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.searchMessages("-42", "Fixture", undefined, 17)).messages.map(({ id }) => id)).toEqual(["9"]);
  expect(request).toHaveBeenCalledWith({
    "@type": "searchChatMessages", chat_id: -42, query: "Fixture", from_message_id: 0, offset: 0, limit: 40,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
  });
});

test.each(["foundChatMessages", "messages"])("paginates search results returned as %s", async (type) => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "searchChatMessages") throw new Error("Unexpected request");
    const ids = query.from_message_id === 0 ? [10, 8] : query.from_message_id === 8 ? [8, 5] : [5];
    return {
      "@type": type, next_from_message_id: query.from_message_id === 0 ? 8 : 0,
      messages: ids.map((id) => ({ "@type": "message", id, chat_id: -42 })),
    };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.searchMessages("-42", "Fixture")).toMatchObject({ messages: [{ id: "10" }, { id: "8" }], before: "8" });
  const next = await session.searchMessages("-42", "Fixture", undefined, undefined, "8");
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ from_message_id: 8 }));
  if (type === "foundChatMessages") {
    expect(next).toMatchObject({ messages: [{ id: "8" }, { id: "5" }], before: null });
  } else {
    expect(next).toMatchObject({ messages: [{ id: "5" }], before: "5" });
    expect(await session.searchMessages("-42", "Fixture", undefined, undefined, "5")).toEqual({ messages: [], before: null });
  }
});

test("maps Telegram reactions without exposing the identities of people who reacted", async () => {
  const interaction = { "@type": "messageInteractionInfo", reactions: {
    "@type": "messageReactions", are_tags: false, reactions: [
      { "@type": "messageReaction", type: { "@type": "reactionTypeEmoji", emoji: "👍" }, total_count: 3, is_chosen: true,
        recent_sender_ids: [{ "@type": "messageSenderUser", user_id: 7 }] },
      { "@type": "messageReaction", type: { "@type": "reactionTypeCustomEmoji", custom_emoji_id: "9007199254740993" }, total_count: 2 },
      { "@type": "messageReaction", type: { "@type": "reactionTypePaid" }, total_count: 10 },
      { "@type": "messageReaction", type: { "@type": "reactionTypeEmoji", emoji: "👎" }, total_count: -1 },
    ],
  } };
  const onChatChanged = vi.fn();
  const { session, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: -42 };
    if (query["@type"] === "getChatHistory") return { "@type": "messages", messages: [{
      "@type": "message", chat_id: -42, id: 28, interaction_info: interaction,
    }] };
    throw new Error("Unexpected test query");
  }, undefined, undefined, onChatChanged);
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("-42")).messages[0]?.reactions).toEqual({ tags: false, items: [
    { type: { kind: "emoji", emoji: "👍" }, count: 3, chosen: true },
    { type: { kind: "custom", id: "9007199254740993" }, count: 2, chosen: false },
    { type: { kind: "paid" }, count: 10, chosen: false },
  ] });
  onChatChanged.mockClear();
  const details = (interaction_info: TdObject) =>
    update({ "@type": "updateMessageInteractionInfo", chat_id: -42, message_id: 28, interaction_info });
  details({ ...interaction, view_count: 25 });
  expect(onChatChanged).not.toHaveBeenCalled();
  details({ "@type": "messageInteractionInfo", view_count: 25 });
  await vi.waitFor(() => expect(onChatChanged).toHaveBeenCalledOnce());
});

test("sets or removes only allowed standard emoji reactions for the exact Telegram message", async () => {
  const emoji = (value: string) => ({ "@type": "reactionTypeEmoji", emoji: value });
  const entry = (type: TdObject, needs_premium = false) => ({ "@type": "availableReaction", type, needs_premium });
  let chosen = false;
  let wrongChat = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { "@type": "message", chat_id: wrongChat ? -99 : -42, id: 13,
        interaction_info: { "@type": "messageInteractionInfo", reactions: {
          "@type": "messageReactions", reactions: chosen ? [{
            "@type": "messageReaction", type: emoji("👍"), total_count: 1, is_chosen: true,
          }] : [],
        } } };
      case "getMessageAvailableReactions": return { "@type": "availableReactions",
        top_reactions: [entry(emoji("👍")), entry({ "@type": "reactionTypePaid" }), entry(emoji("🎉"), true)],
        popular_reactions: [entry(emoji("👍")), entry(emoji("❤️"))],
      };
      case "addMessageReaction": chosen = true; return { "@type": "ok" };
      case "removeMessageReaction": chosen = false; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect(await session.listReactions("-42", "13")).toEqual(["👍", "❤️"]);
  await expect(session.setReaction("-42", "13", "🎉", true)).resolves.toBe(false);
  wrongChat = true;
  await expect(session.setReaction("-42", "13", "👍", true)).resolves.toBe(false);
  wrongChat = false;
  await expect(session.setReaction("-42", "13", "👍", true)).resolves.toBe(true);
  await expect(session.setReaction("-42", "13", "👍", true)).resolves.toBe(true);
  await expect(session.setReaction("-42", "13", "👍", false)).resolves.toBe(true);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "addMessageReaction" || query["@type"] === "removeMessageReaction")).toEqual([
    [{ "@type": "addMessageReaction", chat_id: -42, message_id: 13, reaction_type: emoji("👍"),
      is_big: false, update_recent_reactions: true }],
    [{ "@type": "removeMessageReaction", chat_id: -42, message_id: 13, reaction_type: emoji("👍") }],
  ]);
});

test("resolves an exact public Telegram handle or link in All chats without joining", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "searchPublicChat") return {
      "@type": "chat", id: -42, title: "Public fixture",
      type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: true },
    };
    if (query["@type"] === "searchChats" || query["@type"] === "searchChatsOnServer") return { "@type": "chats", chat_ids: [] };
    throw new Error("Unexpected request");
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.search("@Fixture_channel")).resolves.toMatchObject([{ id: "-42", subtitle: "Channel" }]);
  await expect(session.search("https://t.me/fixture_channel")).resolves.toMatchObject([{ id: "-42", subtitle: "Channel" }]);
  await expect(session.search("https://t.me/+fixture")).resolves.toEqual([]);
  await expect(session.search("https://t.me/fixture_channel/12")).resolves.toEqual([]);
  await expect(session.search("@fixture_channel", "archive")).resolves.toEqual([]);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "searchPublicChat")).toEqual([
    [{ "@type": "searchPublicChat", username: "fixture_channel" }],
    [{ "@type": "searchPublicChat", username: "fixture_channel" }],
  ]);
});

test("joins only a verified public group and distinguishes requests from confirmed membership", async () => {
  let username: string | undefined = "fixture_group";
  let requestRequired = true;
  let result: TdObject = { "@type": "chatJoinResultRequestSent" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture group",
        type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: false } };
      case "getSupergroup": return {
        "@type": "supergroup", id: 77, is_channel: false,
        ...(requestRequired ? { usernames: { "@type": "usernames", active_usernames: username ? [username] : [] },
          join_by_request: true } : { username }),
        status: { "@type": "chatMemberStatusLeft" },
      };
      case "joinChat": return result;
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "joinChat");
  expect(await session.postingPermissions("-42")).toEqual({ text: false, photo: false, document: false, join: "request" });
  await expect(session.joinChat("-42", "Old fixture group")).resolves.toBe("refused");
  username = undefined;
  await expect(session.joinChat("-42", "Fixture group")).resolves.toBe("refused");
  expect(writes()).toHaveLength(0);
  username = "fixture_group";
  await expect(session.joinChat("-42", "Fixture group")).resolves.toBe("requested");
  result = { "@type": "chatJoinResultSuccess", chat_id: -42 };
  await expect(session.joinChat("-42", "Fixture group")).resolves.toBe("joined");
  requestRequired = false;
  expect(await session.postingPermissions("-42")).toHaveProperty("join", "join");
  result = { "@type": "ok" };
  await expect(session.joinChat("-42", "Fixture group")).resolves.toBe("joined");
  expect(writes()).toEqual(Array.from({ length: 3 }, () => [{ "@type": "joinChat", chat_id: -42 }]));
});

test("previews private invitations and rejects changed or paid invitations before joining", async () => {
  const url = "https://t.me/+fixture_invite";
  let title = "Fixture invitation";
  let subscription = false;
  let result: TdObject = { "@type": "chatJoinResultRequestSent" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "checkChatInviteLink": return {
        "@type": "chatInviteLinkInfo", title, chat_id: 0, creates_join_request: true, member_count: 42,
        type: { "@type": "inviteLinkChatTypeChannel" },
        ...(subscription ? { subscription_info: { "@type": "chatInviteLinkSubscriptionInfo" } } : {}),
        member_user_ids: [123],
      };
      case "joinChatByInviteLink": return result;
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "joinChatByInviteLink");
  await expect(session.previewInvite("https://example.com/+fixture_invite")).resolves.toBeNull();
  const preview = await session.previewInvite(url);
  expect(preview).toStrictEqual({ title, kind: "Channel", mode: "request", memberCount: 42 });
  expect(writes()).toHaveLength(0);
  title = "Different fixture";
  await expect(session.joinInvite(url, preview!)).resolves.toBe("refused");
  title = "Fixture invitation";
  subscription = true;
  const paid = await session.previewInvite(url);
  expect(paid).toMatchObject({ mode: "subscription" });
  await expect(session.joinInvite(url, paid!)).resolves.toBe("refused");
  expect(writes()).toHaveLength(0);
  subscription = false;
  await expect(session.joinInvite(url, preview!)).resolves.toBe("requested");
  result = { "@type": "chat", id: -42 };
  await expect(session.joinInvite(url, preview!)).resolves.toBe("joined");
  expect(writes()).toEqual([[{ "@type": "joinChatByInviteLink", invite_link: url }],
    [{ "@type": "joinChatByInviteLink", invite_link: url }]]);
});

test("looks beyond the first page for eligible owner-authored group messages", async () => {
  const own = (id: number, user_id = 99) => ({
    "@type": "message", id, chat_id: -42, is_outgoing: true,
    sender_id: { "@type": "messageSenderUser", user_id },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Original fixture text" } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getMe": return { "@type": "user", id: 99 };
      case "searchChatMessages": return query.from_message_id === 0
        ? { "@type": "foundChatMessages", next_from_message_id: 90, messages: [
          own(99, 81), { ...own(96), forward_info: { "@type": "messageForwardInfo" } },
        ] }
        : { "@type": "foundChatMessages", next_from_message_id: 0, messages: [own(89), own(87, 81), own(86)] };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.ownChatNotes("-42", "FIXTURE")).map(({ id }) => id)).toEqual(["89", "86"]);
  const searches = request.mock.calls.flatMap(([query]) => query["@type"] === "searchChatMessages" ? [query] : []);
  expect(searches.map(({ from_message_id }) => from_message_id)).toEqual([0, 90]);
  for (const query of searches) expect(query).toMatchObject({
    chat_id: -42, sender_id: { "@type": "messageSenderUser", user_id: 99 }, query: "FIXTURE",
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(session.ownChatNotes("-42", "FIXTURE", undefined, cancelled.signal)).resolves.toEqual([]);
  expect(request.mock.calls.filter(([query]) => query["@type"] === "searchChatMessages")).toHaveLength(2);
});

test.each([42, 99])("accepts pending reply delivery only for the verified source chat (%s)", async (replyChatId) => {
  const { session, update, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getMessage": return { "@type": "message", id: 12, chat_id: 42 };
      case "sendMessage": return { "@type": "message", id: 8, chat_id: 42,
        sending_state: { "@type": "messageSendingStatePending" } };
      default: throw new Error("Unexpected test query");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const sending = session.sendText("42", "Fixture reply", "12");
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "sendMessage" })));
  update({ "@type": "updateMessageSendSucceeded", old_message_id: 8, message: {
    "@type": "message", id: 15, chat_id: 42, is_outgoing: true,
    reply_to: { "@type": "messageReplyToMessage", chat_id: replyChatId, message_id: 12 },
    reply_to_message_id: 12,
  } });
  if (replyChatId === 42) {
    await expect(sending).resolves.toMatchObject({ state: "sent", message: { replyTo: "12" } });
  } else {
    await expect(sending).resolves.toEqual({ state: "unknown" });
  }
  expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(1);
});

test.each([false, true])("changes a chat pin only in the selected Telegram folder (%s)", async (modern) => {
  let member = true;
  let pinned = false;
  const folderType = modern ? "chatListFolder" : "chatListFilter";
  const folderField = modern ? "chat_folder_id" : "chat_filter_id";
  const folder = { "@type": folderType, [folderField]: 7 };
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42,
        ...(modern ? { chat_lists: member ? [folder] : [] }
          : { positions: member ? [{ "@type": "chatPosition", list: folder, order: "1" }] : [] }),
      };
      case "getChatFolder":
      case "getChatFilter": return { "@type": modern ? "chatFolder" : "chatFilter", pinned_chat_ids: pinned ? [-42] : [] };
      case "toggleChatIsPinned": pinned = query.is_pinned === true; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  update(modern ? { "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name: "Fixture" }] }
    : { "@type": "updateChatFilters", chat_filters: [{ "@type": "chatFilterInfo", id: 7, title: "Fixture" }] });
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "toggleChatIsPinned");
  await expect(session.chatPinStatus("-42", 7)).resolves.toBe(false);
  await expect(session.setChatPinned("-42", 7, true)).resolves.toBe("updated");
  await expect(session.setChatPinned("-42", "main", false)).resolves.toBe("refused");
  expect(writes()).toEqual([[{ "@type": "toggleChatIsPinned", chat_list: folder, chat_id: -42, is_pinned: true }]]);
  member = false;
  await expect(session.setChatPinned("-42", 7, false)).resolves.toBe("refused");
  expect(writes()).toHaveLength(1);
});

test("changes only the selected Telegram chat's notification mute fields", async () => {
  const initial = { "@type": "chatNotificationSettings", use_default_mute_for: true, mute_for: 0,
    use_default_sound: false, sound: "legacy tone", sound_id: "42", show_preview: false, mute_stories: true };
  let settings: TdObject = initial;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, notification_settings: settings };
      case "getSavedNotificationSounds": return { "@type": "notificationSounds", notification_sounds: [] };
      case "setChatNotificationSettings":
        settings = query.notification_settings as TdObject;
        return { "@type": "ok" };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ mode: "default" });
  await expect(session.setChatNotificationMode("99", "muted")).resolves.toBe("refused");
  await expect(session.setChatNotificationMode("42", "muted")).resolves.toBe("updated");
  expect(request).toHaveBeenCalledWith({
    "@type": "setChatNotificationSettings", chat_id: 42,
    notification_settings: { ...initial, use_default_mute_for: false, mute_for: 367 * 24 * 60 * 60 },
  });
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ mode: "muted" });
  await expect(session.setChatNotificationMode("42", "default", 3600)).resolves.toBe("refused");
  await expect(session.setChatNotificationMode("42", "muted", 28800)).resolves.toBe("updated");
  expect(settings).toEqual({ ...initial, use_default_mute_for: false, mute_for: 28800 });
  const beforeRead = Math.floor(Date.now() / 1000);
  const deadline = (await session.chatNotificationState("42"))?.muteUntil;
  expect(deadline).toBeGreaterThanOrEqual(beforeRead + 28800);
  expect(deadline).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 28800);
  await expect(session.setChatNotificationMode("42", "unmuted")).resolves.toBe("updated");
  expect(settings).toEqual({ ...initial, use_default_mute_for: false, mute_for: 0 });
  await expect(session.setChatNotificationMode("42", "default")).resolves.toBe("updated");
  expect(settings).toEqual(initial);
  settings = { ...initial, use_default_show_preview: true };
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ mode: "default", preview: "default" });
  await expect(session.setChatNotificationOverride("42", "preview", "hide", "show")).resolves.toBe("refused");
  await expect(session.setChatNotificationOverride("42", "preview", "show", "default")).resolves.toBe("updated");
  expect(settings).toEqual({ ...initial, use_default_show_preview: false, show_preview: true });
  await expect(session.setChatNotificationOverride("42", "preview", "hide", "show")).resolves.toBe("updated");
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ mode: "default", preview: "hide" });
  settings = { ...settings, use_default_disable_pinned_message_notifications: true, disable_pinned_message_notifications: false,
    use_default_disable_mention_notifications: true, disable_mention_notifications: true };
  const withActivity = settings;
  await expect(session.setChatNotificationOverride("42", "pinned", "hide", "default")).resolves.toBe("updated");
  expect(settings).toEqual({ ...withActivity, use_default_disable_pinned_message_notifications: false,
    disable_pinned_message_notifications: true });
  await expect(session.setChatNotificationOverride("42", "mentions", "show", "default")).resolves.toBe("updated");
  expect(settings).toMatchObject({ use_default_disable_mention_notifications: false, disable_mention_notifications: false });
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ preview: "hide", pinned: "hide", mentions: "show" });
  settings = { ...settings, use_default_mute_stories: true, use_default_show_story_poster: true,
    show_story_poster: true, use_default_story_sound: false, story_sound_id: "73" };
  const storyDefaults = settings;
  await expect(session.setChatNotificationOverride("42", "stories", "hide", "default")).resolves.toBe("updated");
  await expect(session.setChatNotificationOverride("42", "storyPoster", "hide", "default")).resolves.toBe("updated");
  expect(settings).toEqual({ ...storyDefaults, use_default_mute_stories: false, mute_stories: true,
    use_default_show_story_poster: false, show_story_poster: false });
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ stories: "hide", storyPoster: "hide", storySound: "73" });
  const beforeSound = settings;
  await expect(session.setChatNotificationSound("42", "0", "73", 7, true)).resolves.toBe("refused");
  await expect(session.setChatNotificationSound("42", "0", "73", undefined, true)).resolves.toBe("updated");
  expect(settings).toEqual({ ...beforeSound, story_sound_id: "0" });
  await expect(session.setChatNotificationSound("42", "inherit", "0", undefined, true)).resolves.toBe("updated");
  await expect(session.chatNotificationState("42")).resolves.toMatchObject({ storySound: "inherit", sound: "42" });
});

test("forwards a Telegram message with attribution only to the verified destination", async () => {
  let protectedSource = false;
  let destinationName = "Destination fixture";
  const target = { id: "-43", name: destinationName, kind: "Channel" as const };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return query.chat_id === -42
        ? { "@type": "chat", id: -42, has_protected_content: protectedSource }
        : { "@type": "chat", id: -43, title: destinationName, type: { "@type": "chatTypeSupergroup", is_channel: true } };
      case "getMessage": return { "@type": "message", id: 12, chat_id: -42 };
      case "getMessageProperties": return { "@type": "messageProperties", can_be_forwarded: true };
      case "forwardMessages": return { "@type": "messages", messages: [{ "@type": "message", id: 25, chat_id: -43 }] };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "forwardMessages");
  expect(await session.forwardOptions("-42", "12")).toBe(true);
  protectedSource = true;
  expect(await session.forwardOptions("-42", "12")).toBe(false);
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("refused");
  protectedSource = false;
  destinationName = "Changed fixture";
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("refused");
  expect(writes()).toHaveLength(0);
  destinationName = target.name;
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("sent");
  expect(writes()).toEqual([[{ "@type": "forwardMessages", chat_id: -43, from_chat_id: -42,
    message_ids: [12], send_copy: false, remove_caption: false, only_preview: false }]]);
});

test("binds the reviewed forum topic to forwarding and verifies Telegram's delivered topic", async () => {
  let name = "Renamed fixture topic";
  let returnedTopic = 18;
  const target = { id: "-43", name: "Destination fixture", kind: "Group" as const, topic: { id: 17, name: "Fixture topic" } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Destination fixture" };
      case "getMessage": return { "@type": "message", id: 12, chat_id: -42, can_be_forwarded: true };
      case "getForumTopic": return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: -43, forum_topic_id: 17, name,
      } };
      case "forwardMessages": return { "@type": "messages", messages: [{
        "@type": "message", id: 25, chat_id: -43,
        topic_id: { "@type": "messageTopicForum", forum_topic_id: returnedTopic },
      }] };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "forwardMessages");
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("refused");
  expect(writes()).toHaveLength(0);
  name = "Fixture topic";
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("unknown");
  returnedTopic = 17;
  await expect(session.forwardMessage("-42", "12", target)).resolves.toBe("sent");
  expect(writes()).toHaveLength(2);
  for (const [query] of writes()) expect(query).toMatchObject({
    from_chat_id: -42, chat_id: -43, message_ids: [12],
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
  });
});

test("projects only the owner's reply body and drops quoted or linked third-party content", async () => {
  const original = {
    "@type": "message", id: 12, chat_id: -42, is_outgoing: true,
    sender_id: { "@type": "messageSenderUser", user_id: 99 },
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
    reply_to: { "@type": "messageReplyToMessage", chat_id: -42, message_id: 8,
      quote: { "@type": "textQuote", text: { "@type": "formattedText", text: "Quoted third-party fixture" } },
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "Parent fixture" } },
    },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Own reply fixture" } },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 99 };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getMessage": return original;
      default: throw new Error("Unexpected request");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.ownNote("-42", "12")).resolves.toStrictEqual({
    id: "12", text: "Own reply fixture", time: "", forumTopicId: 17,
  });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "getMessage")).toEqual([
    [{ "@type": "getMessage", chat_id: -42, message_id: 12 }],
  ]);
});

test.each(["draftMessageContentText", "inputMessageText"])("loads plain Telegram drafts from %s without restoring reply context", async (type) => {
  const text = { "@type": "formattedText", text: "Saved fixture draft" };
  let draft: TdObject = { "@type": "draftMessage",
    ...(type === "inputMessageText" ? { input_message_text: { "@type": type, text }, reply_to_message_id: 0 }
      : { content: { "@type": type, text }, effect_id: "0" }),
  };
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, draft_message: draft };
      case "getChatHistory": return { "@type": "messages", messages: [] };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  await expect(session.history("42")).resolves.toStrictEqual({ messages: [], before: null, draft: text.text });
  draft = { ...draft, reply_to_message_id: 8 };
  await expect(session.history("42")).resolves.toStrictEqual({ messages: [], before: null });
});

test.each(["1.8.0", "1.8.70"])("creates an anonymous regular poll with the TDLib %s format", async (version) => {
  let canSend = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: version };
      case "getChat": return { "@type": "chat", id: -42,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: false },
        permissions: { "@type": "chatPermissions", can_send_polls: canSend },
      };
      case "getSupergroup": return { "@type": "supergroup", id: 77, is_channel: false,
        status: { "@type": "chatMemberStatusMember" },
      };
      case "getForumTopic": return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17, name: "Fixture topic",
      } };
      case "sendMessage": return { "@type": "message", id: 25, chat_id: -42, topic_id: query.topic_id };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  const draft = { question: "Fixture question", options: ["First", "Second"], multiple: true };
  const topic = version === "1.8.0" ? undefined : { id: 17, name: "Fixture topic" };
  const writes = () => request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
  await expect(session.sendPoll("-42", draft, topic)).resolves.toEqual({ state: "failed" });
  canSend = true;
  await expect(session.sendPoll("-42", { ...draft, options: ["Same", "same"] }, topic)).resolves.toEqual({ state: "failed" });
  expect(writes()).toHaveLength(0);
  await expect(session.sendPoll("-42", draft, topic)).resolves.toMatchObject({ state: "sent" });
  expect(writes()).toHaveLength(1);
  if (version === "1.8.0") {
    expect(writes()[0]?.[0]).toMatchObject({ input_message_content: {
      "@type": "inputMessagePoll", question: "Fixture question", options: ["First", "Second"],
      is_anonymous: true, type: { "@type": "pollTypeRegular", allow_multiple_answers: true },
    } });
  } else {
    expect(writes()[0]?.[0]).toMatchObject({
      topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
      input_message_content: {
        "@type": "inputMessagePoll", question: { text: "Fixture question" }, is_anonymous: true, allows_multiple_answers: true,
        type: { "@type": "inputPollTypeRegular" }, options: [{ text: { text: "First" } }, { text: { text: "Second" } }],
      },
    });
  }
});

test("stops an open poll only while Telegram still grants edit permission", async () => {
  let canEdit = true;
  let closed = false;
  const { session, request } = harness((query) => {
    const message = {
      "@type": "message", id: 12, chat_id: -42, is_outgoing: true,
      content: { "@type": "messagePoll", poll: {
        "@type": "poll", question: "Fixture poll", is_closed: closed,
        options: [{ "@type": "pollOption", text: "First" }, { "@type": "pollOption", text: "Second" }],
      } },
    };
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getChatHistory": return { "@type": "messages", messages: [message] };
      case "getMessage": return message;
      case "getMessageProperties": return { "@type": "messageProperties", can_be_edited: canEdit };
      case "stopPoll": closed = true; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture call");
    }
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.history("-42")).messages[0]?.canStopPoll).toBe(true);
  canEdit = false;
  await expect(session.stopPoll("-42", "12")).resolves.toBe(false);
  canEdit = true;
  await expect(session.stopPoll("-42", "12")).resolves.toBe(true);
  await expect(session.stopPoll("-42", "12")).resolves.toBe(false);
  expect((await session.history("-42")).messages[0]).toMatchObject({ poll: { closed: true } });
  expect(request.mock.calls.filter(([query]) => query["@type"] === "stopPoll")).toEqual([
    [{ "@type": "stopPoll", chat_id: -42, message_id: 12 }],
  ]);
});

test.each([
  ["audio", "searchMessagesFilterAudio", ["13"]],
  ["video", "searchMessagesFilterVideo", ["12"]],
  ["voiceVideoNotes", "searchMessagesFilterVoiceAndVideoNote", ["11", "10"]],
  ["gif", "searchMessagesFilterAnimation", ["8"]],
] as const)("searches the exact Telegram media type for %s", async (filter, tdType, expected) => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] !== "searchChatMessages") throw new Error("Unexpected fixture call");
    return { "@type": "foundChatMessages", next_from_message_id: 0, messages:
      ["messageAudio", "messageVideo", "messageVoiceNote", "messageVideoNote", "messageText", "messageAnimation"].map((type, index) => ({
        "@type": "message", id: 13 - index, chat_id: -42, content: { "@type": type },
      })),
    };
  });
  await vi.waitFor(() => expect(session.status()).toEqual({ state: "ready" }));
  expect((await session.searchMessages("-42", "", filter)).messages.map(({ id }) => id)).toEqual(expected);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ filter: { "@type": tdType } }));
});

test("paginates global Telegram search and keeps protected snippets out of results", async () => {
  const row: TdObject = { "@type": "message", id: 15, chat_id: -42, date: 123,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Fixture match" } },
    topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 },
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture group",
        type: { "@type": "chatTypeSupergroup" } };
      case "searchMessages": return query.offset
        ? { "@type": "foundMessages", messages: [{ ...row, id: 14, can_be_saved: false }], next_offset: "" }
        : { "@type": "foundMessages", messages: [row, row], next_offset: "next-page" };
      case "searchPublicPosts": return { "@type": "foundPublicPosts", messages: [], next_offset: "", are_limits_exceeded: true };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const first = await session.globalSearch("Fixture", "messages");
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0]).toMatchObject({ chat: { id: "-42", messages: [] },
      message: { id: "15", text: "Fixture match", forumTopicId: 17 } });
    expect(first.next).toBe("next-page");
    const next = await session.globalSearch("Fixture", "messages", first.next!);
    expect(next.hits[0]?.message.text).toBe("Protected message");
    expect(next.next).toBeNull();
    await expect(session.globalSearch("Fixture", "public")).rejects.toThrow("limit");
    expect(request).toHaveBeenCalledWith({ "@type": "searchPublicPosts", query: "Fixture", offset: "", limit: 30, star_count: 0 });
  } finally { await session.close(); }
});

test("uses Telegram scheduling and silent delivery, and guards cancellation against ordinary messages", async () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  const scheduled = { "@type": "messageSchedulingStateSendAtDate", send_date: at };
  const row: TdObject = { "@type": "message", id: 22, chat_id: 42, is_outgoing: true, scheduling_state: scheduled,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Synthetic reminder" } },
  };
  let available = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate" } };
      case "sendMessage": return row;
      case "getChatScheduledMessages": return { "@type": "messages", messages: available ? [row] : [] };
      case "getMessage": return available ? row : { ...row, scheduling_state: null };
      case "deleteMessages": available = false; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const send = (time: number) => session.sendText("42", "Synthetic reminder", undefined, undefined, undefined,
      undefined, undefined, undefined, { at: time, silent: true });
    await expect(send(at)).resolves.toMatchObject({ state: "sent", message: { id: "22" } });
    await expect(send(1)).resolves.toMatchObject({ state: "failed" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toEqual([[expect.objectContaining({
      options: { "@type": "messageSendOptions", disable_notification: true, scheduling_state: scheduled },
    })]]);
    await expect(session.scheduledMessages("42")).resolves.toEqual([{ id: "22", at, text: "Synthetic reminder" }]);
    await expect(session.cancelScheduledMessage("42", "22")).resolves.toBe(true);
    await expect(session.cancelScheduledMessage("42", "22")).resolves.toBe(false);
    await expect(session.scheduledMessages("42")).resolves.toEqual([]);
  } finally { await session.close(); }
});

test("edits Telegram folder metadata while preserving existing included, excluded and pinned chats", async () => {
  const folderName = (title: string) => ({ "@type": "chatFolderName", text: { "@type": "formattedText", text: title } });
  let folder: TdObject = { "@type": "chatFolder", name: folderName("Fixture"), color_id: 4,
    pinned_chat_ids: [42], included_chat_ids: [43], excluded_chat_ids: [44],
  };
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolder": return folder;
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypePrivate" } };
      case "editChatFolder":
        folder = query.folder as TdObject;
        return { "@type": "chatFolderInfo", id: 7, name: folder.name };
      case "deleteChatFolder": return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name: folder.name }] });
    await expect(session.saveFolder({ title: "Renamed", rules: ["include_groups"] }, 7)).resolves.toEqual({ id: 7, title: "Renamed" });
    expect(folder).toMatchObject({ color_id: 4, pinned_chat_ids: [42], included_chat_ids: [43], excluded_chat_ids: [44], include_groups: true });
    await expect(session.folderMemberships("42")).resolves.toMatchObject([{ id: 7, mode: "include" }]);
    await expect(session.setFolderMembership(7, "42", "exclude")).resolves.toBe(true);
    expect(folder).toMatchObject({ pinned_chat_ids: [], included_chat_ids: [43], excluded_chat_ids: [44, 42], include_groups: true });
    await expect(session.deleteFolder(7, "Fixture")).resolves.toBe(false);
    await expect(session.deleteFolder(7, "Renamed")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ "@type": "deleteChatFolder", chat_folder_id: 7, leave_chat_ids: [] });
  } finally { await session.close(); }
});

test("syncs a plain-text Telegram draft only if the last seen draft still matches", async () => {
  const draft = (text: string) => ({ "@type": "draftMessage",
    content: { "@type": "draftMessageContentText", text: { "@type": "formattedText", text, entities: [] } },
  });
  let remote: unknown = draft("Original fixture");
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: "1.8.70" };
      case "getChat": return { "@type": "chat", id: 42, draft_message: remote };
      case "setChatDraftMessage": remote = query.draft_message; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.saveChatDraft("42", "New fixture", null)).resolves.toBe("changed");
    await expect(session.saveChatDraft("42", "New fixture", "Original fixture")).resolves.toBe("saved");
    expect(remote).toEqual(draft("New fixture"));
    await expect(session.saveChatDraft("42", "", "New fixture")).resolves.toBe("saved");
    expect(remote).toBeNull();
    remote = { ...draft("Reply fixture"), reply_to: { "@type": "inputMessageReplyToMessage", message_id: 22 } };
    await expect(session.saveChatDraft("42", "Overwrite", null)).resolves.toBe("unsupported");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatDraftMessage")).toHaveLength(2);
  } finally { await session.close(); }
});

test("creates and updates only topics belonging to a verified Telegram forum", async () => {
  let name = "Fixture";
  let closed = false;
  let pinned = false;
  const info = () => ({ "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17, name, is_closed: closed });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup", supergroup_id: 4 } };
      case "getSupergroup": return { "@type": "supergroup", id: 4, is_forum: true };
      case "createForumTopic": name = String(query.name); return info();
      case "getForumTopic": return { "@type": "forumTopic", info: info(), is_pinned: pinned };
      case "getForumTopics": return query.offset_forum_topic_id === 17
        ? { "@type": "forumTopics", topics: [] }
        : { "@type": "forumTopics", topics: [{ "@type": "forumTopic", info: info(), is_pinned: pinned }],
          next_offset_date: 5, next_offset_message_id: 9, next_offset_forum_topic_id: 17 };
      case "toggleForumTopicIsPinned": pinned = query.is_pinned === true; return { "@type": "ok" };
      case "editForumTopic": name = String(query.name); return { "@type": "ok" };
      case "toggleForumTopicIsClosed": closed = query.is_closed === true; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.manageForumTopic("-42", { kind: "create", name: "Fixture" }))
      .resolves.toEqual({ id: 17, name: "Fixture", closed: false });
    await expect(session.manageForumTopic("-43", { kind: "rename", topic: 17, name: "Wrong chat" })).rejects.toThrow("confirm");
    await expect(session.manageForumTopic("-42", { kind: "rename", topic: 17, name: "Updated" }))
      .resolves.toEqual({ id: 17, name: "Updated", closed: false });
    await expect(session.manageForumTopic("-42", { kind: "close", topic: 17, closed: true }))
      .resolves.toEqual({ id: 17, name: "Updated", closed: true });
    await expect(session.manageForumTopic("-42", { kind: "close", topic: 17, closed: false }))
      .resolves.toEqual({ id: 17, name: "Updated", closed: false });
    await expect(session.manageForumTopic("-42", { kind: "pin", topic: 17, pinned: true }))
      .resolves.toEqual({ id: 17, name: "Updated", closed: false, pinned: true });
    const first = await session.forumTopicPage("-42", "");
    expect(first).toMatchObject({ topics: [{ id: 17, pinned: true }], next: { date: 5, message: 9, topic: 17 } });
    await expect(session.forumTopicPage("-42", "", first!.next!)).resolves.toEqual({ topics: [], next: null });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editForumTopic")).toHaveLength(1);
  } finally { await session.close(); }
});

test("pages a supergroup member search with verified profile names and roles", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, type: { "@type": "chatTypeSupergroup", supergroup_id: 4 } };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: "Fixture", last_name: "Account", phone_number: "private fixture" };
      case "getSupergroupMembers": return { "@type": "chatMembers", total_count: 32,
        members: [{ "@type": "chatMember", member_id: { "@type": "messageSenderUser", user_id: 42 },
          status: { "@type": "chatMemberStatusAdministrator" }, tag: "Moderator" }],
      };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.chatMembers("-42", "Fixture", 30)).resolves.toEqual({
      members: [{ id: "42", name: "Fixture Account", role: "admin", tag: "Moderator" }], next: 31,
    });
    expect(request).toHaveBeenCalledWith({
      "@type": "getSupergroupMembers", supergroup_id: 4, filter: { "@type": "supergroupMembersFilterSearch", query: "Fixture" }, offset: 30, limit: 30,
    });
    await expect(session.chatMembers("42", "")).resolves.toBeNull();
  } finally { await session.close(); }
});

test("manages only invite links owned by the active account for the selected chat", async () => {
  const link = "https://t.me/+TestOnlyToken_42";
  const own = { "@type": "chatInviteLink", invite_link: link, creator_user_id: 5,
    name: "Fixture", date: 123, creates_join_request: true, pending_join_request_count: 2 };
  let creator = 5;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 5 };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup" } };
      case "getChatInviteLinks": return { "@type": "chatInviteLinks", invite_links: [own, { ...own, creator_user_id: 6 }] };
      case "createChatInviteLink": return own;
      case "getChatInviteLink": return { ...own, creator_user_id: creator };
      case "revokeChatInviteLink": return { "@type": "chatInviteLinks", invite_links: [{ ...own, is_revoked: true }] };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.managedInvites("-42")).resolves.toMatchObject({ links: [{ link, pending: 2 }], next: null });
    expect((await session.managedInvites("-42"))?.links).toHaveLength(1);
    await expect(session.createManagedInvite("-42", { name: "Fixture", expires: 0, limit: 0, approval: true }))
      .resolves.toMatchObject({ link, approval: true });
    creator = 6;
    await expect(session.revokeManagedInvite("-42", link)).resolves.toBe(false);
    creator = 5;
    await expect(session.revokeManagedInvite("-42", link)).resolves.toBe(true);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "revokeChatInviteLink")).toEqual([[
      { "@type": "revokeChatInviteLink", chat_id: -42, invite_link: link },
    ]]);
  } finally { await session.close(); }
});

test("pages Telegram join requests and submits the selected review for the exact group", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: {
        "@type": query.chat_id === -42 ? "chatTypeSupergroup" : "chatTypePrivate",
      } };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: "Fixture" };
      case "getChatJoinRequests": return { "@type": "chatJoinRequests", total_count: 2, requests: [
        { "@type": "chatJoinRequest", user_id: query.offset_request ? 5 : 4, date: 123, bio: "Test bio" },
      ] };
      case "processChatJoinRequest": return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const first = await session.joinRequests("-42", "Fixture");
    expect(first).toEqual({ requests: [{ userId: "4", name: "Fixture", date: 123, bio: "Test bio" }], next: { userId: "4", date: 123 } });
    await expect(session.joinRequests("-42", "Fixture", first!.next!)).resolves.toMatchObject({ requests: [{ userId: "5" }], next: null });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ offset_request: { "@type": "chatJoinRequest", user_id: 4, date: 123 } }));
    await expect(session.reviewJoinRequest("42", "4", true)).rejects.toThrow("unavailable");
    await expect(session.reviewJoinRequest("-42", "4", true)).resolves.toBe(true);
    await expect(session.reviewJoinRequest("-42", "5", false)).resolves.toBe(true);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "processChatJoinRequest")).toEqual([
      [{ "@type": "processChatJoinRequest", chat_id: -42, user_id: 4, approve: true }],
      [{ "@type": "processChatJoinRequest", chat_id: -42, user_id: 5, approve: false }],
    ]);
  } finally { await session.close(); }
});

test("patches group permissions against the current Telegram state with admin rights", async () => {
  let editable = true;
  const permissions = { "@type": "chatPermissions", can_send_photos: true, can_send_polls: false, some_future_permission: true };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, permissions, type: { "@type": "chatTypeSupergroup", supergroup_id: 4 } };
      case "getSupergroup": return { "@type": "supergroup", id: 4,
        status: { "@type": "chatMemberStatusAdministrator", rights: { "@type": "chatAdministratorRights", can_restrict_members: editable } } };
      case "setChatPermissions": return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.groupPermissions("-42")).resolves.toEqual({ editable: true,
      values: { can_send_photos: true, can_send_polls: false } });
    const change = { key: "can_send_photos" as const, expected: true, enabled: false };
    await expect(session.saveGroupPermissions("-42", [{ ...change, expected: false }])).resolves.toBe("changed");
    await expect(session.saveGroupPermissions("-42", [change])).resolves.toBe("saved");
    editable = false;
    await expect(session.saveGroupPermissions("-42", [change])).resolves.toBe("unavailable");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatPermissions")).toEqual([[
      { "@type": "setChatPermissions", chat_id: -42, permissions: { ...permissions, can_send_photos: false } },
    ]]);
  } finally { await session.close(); }
});

test("paginates recent actions without losing precision in Telegram event IDs", async () => {
  const firstId = 9_007_199_254_741_050n;
  const entries = Array.from({ length: 30 }, (_, index) => ({ "@type": "chatEvent",
    id: String(firstId - BigInt(index)), date: 123, member_id: { "@type": "messageSenderUser", user_id: 42 },
    action: { "@type": "chatEventTitleChanged", new_title: "Fixture group" },
  }));
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup" } };
      case "getUser": return { "@type": "user", id: 42, first_name: "Fixture" };
      case "getChatEventLog": return { "@type": "chatEvents", events: query.from_event_id === "0" ? entries
        : [entries[29], { ...entries[29], id: String(firstId - 30n) }] };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const first = await session.chatEvents("-42", "");
    expect(first?.events).toHaveLength(30);
    expect(first?.events[0]).toEqual({ id: String(firstId), actor: "Fixture", date: 123, action: "Title Changed", detail: "Fixture group" });
    expect(first?.next).toBe(String(firstId - 29n));
    await expect(session.chatEvents("-42", "", first?.next ?? undefined)).resolves.toMatchObject({
      events: [{ id: String(firstId - 30n) }], next: null,
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "getChatEventLog", from_event_id: String(firstId - 29n) }));
  } finally { await session.close(); }
});

test("loads channel comments only from the verified linked discussion and paginates without the root post", async () => {
  const make = (id: number, chat_id: number) => ({ "@type": "message", id, chat_id,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Fixture" } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture",
        type: { "@type": "chatTypeSupergroup", is_channel: query.chat_id === -42 } };
      case "getMessage": return { ...make(77, -42), is_channel_post: true };
      case "getMessageThread": return { "@type": "messageThreadInfo", chat_id: -43, message_thread_id: 10 };
      case "getMessageThreadHistory": return { "@type": "messages", messages: query.from_message_id
        ? [make(20, -43), make(15, -43), make(10, -43)] : [make(20, -43), make(19, -44)] };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const first = await session.channelDiscussion("-42", "77");
    expect(first.chat.id).toBe("-43");
    expect(first.messages.map(({ id }) => id)).toEqual(["20"]);
    expect(first.before).toBe("20");
    const next = await session.channelDiscussion("-42", "77", first.before!);
    expect(next.messages.map(({ id }) => id)).toEqual(["15"]);
    expect(next.before).toBeNull();
    await expect(session.channelDiscussion("-43", "77")).rejects.toThrow("channel post");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getMessageThreadHistory")).toHaveLength(2);
  } finally { await session.close(); }
});

test("sends a channel comment only to the group and thread shown by BB", async () => {
  const content = { "@type": "messageText", text: { "@type": "formattedText", text: "Fixture" } };
  const topic = { "@type": "messageTopicThread", message_thread_id: 10 };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id,
        type: { "@type": "chatTypeSupergroup", is_channel: query.chat_id === -42, supergroup_id: 4 } };
      case "getSupergroup": return { "@type": "supergroup", id: 4,
        status: { "@type": "chatMemberStatusCreator", is_member: true } };
      case "getMessage": return { "@type": "message", id: 77, chat_id: -42, is_channel_post: true, content };
      case "getMessageThread": return { "@type": "messageThreadInfo", chat_id: -43, message_thread_id: 10 };
      case "sendMessage": return { "@type": "message", id: 20, chat_id: -43, topic_id: topic, is_outgoing: true, content };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.sendChannelComment("-42", "77", "-44", "10", "Fixture")).resolves.toEqual({ state: "failed" });
    await expect(session.sendChannelComment("-42", "77", "-43", "11", "Fixture")).resolves.toEqual({ state: "failed" });
    await expect(session.sendChannelComment("-42", "77", "-43", "10", "Fixture")).resolves.toMatchObject({
      state: "sent", message: { id: "20", threadRoot: "10" },
    });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toEqual([[
      expect.objectContaining({ chat_id: -43, topic_id: topic }),
    ]]);
  } finally { await session.close(); }
});

test("finds contacts and opens only the private chat belonging to the selected contact", async () => {
  let target = 42;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchContacts": return { "@type": "users", user_ids: [42, 43, 42] };
      case "getUser": return { "@type": "user", id: query.user_id, is_contact: query.user_id === 42, first_name: "Fixture", phone_number: "private fixture" };
      case "createPrivateChat": return { "@type": "chat", id: 50, title: "Fixture", type: { "@type": "chatTypePrivate", user_id: target } };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.contacts("Fixture")).resolves.toEqual({ contacts: [{ id: "42", name: "Fixture" }], next: null });
    await expect(session.openContact("43")).rejects.toThrow("unavailable");
    await expect(session.openContact("42")).resolves.toMatchObject({ id: "50", subtitle: "Direct message" });
    target = 43;
    await expect(session.openContact("42")).rejects.toThrow("unavailable");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "createPrivateChat")).toHaveLength(2);
  } finally { await session.close(); }
});

test("edits the contact in the selected private conversation and preserves its note", async () => {
  const note = { "@type": "formattedText", text: "Synthetic note", entities: [] };
  let saved = true;
  let first = "Fixture";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypePrivate", user_id: query.chat_id } };
      case "getMe": return { "@type": "user", id: 5 };
      case "getUser": return { "@type": "user", id: query.user_id, is_contact: saved, first_name: first };
      case "getUserFullInfo": return { "@type": "userFullInfo", note };
      case "getOption": return { "@type": "optionValueString", value: "1.8.70" };
      case "addContact": first = String((query.contact as TdObject).first_name); return { "@type": "ok" };
      case "removeContacts": saved = false; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const expected = { id: "42", first: "Fixture", last: "", saved: true };
    await expect(session.contactDetails("42")).resolves.toEqual(expected);
    await expect(session.contactDetails("5")).resolves.toBeNull();
    await expect(session.saveContact("43", "42", expected, { first: "Renamed", last: "" })).resolves.toBe(false);
    await expect(session.saveContact("42", "42", expected, { first: "Renamed", last: "" })).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ "@type": "addContact", user_id: 42, share_phone_number: false,
      contact: { "@type": "importedContact", phone_number: "", first_name: "Renamed", last_name: "", note } });
    await expect(session.removeContact("42", "42", expected)).resolves.toBe(false);
    await expect(session.removeContact("42", "42", { ...expected, first: "Renamed" })).resolves.toBe(true);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "removeContacts")).toEqual([[
      { "@type": "removeContacts", user_ids: [42] },
    ]]);
  } finally { await session.close(); }
});

test("checks the exact int64 device ID and cannot terminate the current session", async () => {
  const current = "0";
  const other = "-9007199254741022";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getActiveSessions": return { "@type": "sessions", sessions: [
        { "@type": "session", id: other, is_current: false, application_name: "Fixture", device_model: "Other", ip: "private fixture" },
        { "@type": "session", id: current, is_current: true, application_name: "BB", device_model: "Local" },
      ] };
      case "terminateSession": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.activeDevices()).resolves.toEqual([
      { id: current, current: true, application: "BB", device: "Local", platform: "", activeAt: 0 },
      { id: other, current: false, application: "Fixture", device: "Other", platform: "", activeAt: 0 },
    ]);
    await expect(session.terminateDevice(current, "BB", "Local")).resolves.toBe(false);
    await expect(session.terminateDevice(other, "Fixture", "Wrong")).resolves.toBe(false);
    await expect(session.terminateDevice(other, "Fixture", "Other")).resolves.toBe(true);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "terminateSession")).toEqual([[
      { "@type": "terminateSession", session_id: other },
    ]]);
  } finally { await session.close(); }
});

test("updates a known Telegram privacy audience while preserving exceptions and refusing stale rules", async () => {
  const exception = { "@type": "userPrivacySettingRuleRestrictUsers", user_ids: [42] };
  let rules = [exception, { "@type": "userPrivacySettingRuleAllowContacts" }, { "@type": "userPrivacySettingRuleRestrictAll" }];
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getUserPrivacySettingRules": return { "@type": "userPrivacySettingRules", rules };
      case "setUserPrivacySettingRules":
        rules = (query.rules as TdObject).rules as typeof rules;
        return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const before = await session.telegramPrivacy("phone");
    expect(before).toMatchObject({ audience: "contacts", exceptions: 1 });
    expect(before).not.toHaveProperty("rules");
    await expect(session.saveTelegramPrivacy("phone", "nobody", before.version)).resolves.toBe("saved");
    expect(rules).toEqual([exception, { "@type": "userPrivacySettingRuleRestrictAll" }]);
    await expect(session.saveTelegramPrivacy("phone", "everyone", before.version)).resolves.toBe("changed");
    rules = [{ "@type": "userPrivacySettingRuleRestrictContacts" }, { "@type": "userPrivacySettingRuleAllowAll" }] as typeof rules;
    const custom = await session.telegramPrivacy("phone");
    expect(custom.audience).toBeNull();
    await expect(session.saveTelegramPrivacy("phone", "everyone", custom.version)).resolves.toBe("unsupported");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setUserPrivacySettingRules")).toHaveLength(1);
  } finally { await session.close(); }
});

test("edits only the selected profile field and checks for conflicting or formatted bios", async () => {
  let first = "Fixture";
  let bio = "Old fixture";
  let formatted = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42, first_name: first, last_name: "User" };
      case "getUserFullInfo": return { "@type": "userFullInfo", bio: {
        "@type": "formattedText", text: bio, entities: formatted ? [{ "@type": "textEntity" }] : [],
      } };
      case "getOption": return { "@type": "optionValueInteger", value: "70" };
      case "setName": first = String(query.first_name); return { "@type": "ok" };
      case "setBio": bio = String(query.bio); return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.telegramProfile()).resolves.toMatchObject({ first, bio, bioLimit: 70, bioEditable: true });
    await expect(session.saveTelegramProfile({ kind: "name", first: "Updated", last: "User", expectedFirst: "Old", expectedLast: "User" }))
      .resolves.toBe("changed");
    await expect(session.saveTelegramProfile({ kind: "name", first: "Updated", last: "User", expectedFirst: first, expectedLast: "User" }))
      .resolves.toBe("saved");
    await expect(session.saveTelegramProfile({ kind: "bio", bio: "Updated fixture", expectedBio: bio })).resolves.toBe("saved");
    formatted = true;
    await expect(session.saveTelegramProfile({ kind: "bio", bio: "Another fixture", expectedBio: bio })).resolves.toBe("unsupported");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setName" || query["@type"] === "setBio")).toEqual([
      [{ "@type": "setName", first_name: "Updated", last_name: "User" }],
      [{ "@type": "setBio", bio: "Updated fixture" }],
    ]);
  } finally { await session.close(); }
});

test("checks username availability and preserves changes made in another client", async () => {
  let username = "fixture_current";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42, usernames: {
        "@type": "usernames", editable_username: username, active_usernames: ["fixture_collectible"],
      } };
      case "getUserFullInfo": return { "@type": "userFullInfo" };
      case "getOption": return { "@type": "optionValueInteger", value: "70" };
      case "createPrivateChat": return { "@type": "chat", id: 42, title: "Fixture" };
      case "checkChatUsername":
        expect(query.chat_id).toBe(42);
        return { "@type": query.username === "fixture_taken"
          ? "checkChatUsernameResultUsernameOccupied" : "checkChatUsernameResultOk" };
      case "setUsername": username = String(query.username); return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.telegramProfile()).resolves.toMatchObject({ username });
    await expect(session.checkTelegramUsername("bad!")).resolves.toBe("invalid");
    await expect(session.checkTelegramUsername("fixture_taken")).resolves.toBe("taken");
    await expect(session.saveTelegramProfile({
      kind: "username", username: "fixture_new", expectedUsername: "fixture_old",
    })).resolves.toBe("changed");
    await expect(session.saveTelegramProfile({
      kind: "username", username: "fixture_taken", expectedUsername: username,
    })).resolves.toBe("unsupported");
    await expect(session.saveTelegramProfile({
      kind: "username", username: "fixture_new", expectedUsername: username,
    })).resolves.toBe("saved");
    await expect(session.saveTelegramProfile({
      kind: "username", username: "", expectedUsername: "fixture_new",
    })).resolves.toBe("saved");
    await expect(session.telegramProfile()).resolves.toMatchObject({ username: "" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setUsername")).toEqual([
      [{ "@type": "setUsername", username: "fixture_new" }],
      [{ "@type": "setUsername", username: "" }],
    ]);
  } finally { await session.close(); }
});

test("edits and clears a birthday without requiring a birth year", async () => {
  const original = { day: 29, month: 2, year: 0 };
  const updated = { day: 10, month: 4, year: 2000 };
  let birthdate: unknown = { "@type": "birthdate", ...original };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42 };
      case "getUserFullInfo": return { "@type": "userFullInfo", birthdate };
      case "getOption": return { "@type": "optionValueInteger", value: "70" };
      case "setBirthdate": birthdate = query.birthdate; return { "@type": "ok" };
      case "getUserPrivacySettingRules":
        expect(query.setting).toEqual({ "@type": "userPrivacySettingShowBirthdate" });
        return { "@type": "userPrivacySettingRules", rules: [{ "@type": "userPrivacySettingRuleAllowContacts" }] };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.telegramPrivacy("birthday")).resolves.toMatchObject({ audience: "contacts" });
    await expect(session.telegramProfile()).resolves.toMatchObject({ birthdate: original });
    await expect(session.saveTelegramProfile({
      kind: "birthdate", birthdate: updated, expectedBirthdate: null,
    })).resolves.toBe("changed");
    await expect(session.saveTelegramProfile({
      kind: "birthdate", birthdate: updated, expectedBirthdate: original,
    })).resolves.toBe("saved");
    await expect(session.saveTelegramProfile({
      kind: "birthdate", birthdate: null, expectedBirthdate: updated,
    })).resolves.toBe("saved");
    await expect(session.telegramProfile()).resolves.toMatchObject({ birthdate: null });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setBirthdate")).toEqual([
      [{ "@type": "setBirthdate", birthdate: { "@type": "birthdate", ...updated } }],
      [{ "@type": "setBirthdate", birthdate: null }],
    ]);
  } finally { await session.close(); }
});

test("routes additional privacy settings and rejects unsupported phone lookup audiences", async () => {
  const settings = {
    bio: "userPrivacySettingShowBio",
    profileAudio: "userPrivacySettingShowProfileAudio",
    forwardedLink: "userPrivacySettingShowLinkInForwardedMessages",
    invites: "userPrivacySettingAllowChatInvites",
    findByPhone: "userPrivacySettingAllowFindingByPhoneNumber",
  } as const;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getUserPrivacySettingRules":
        return { "@type": "userPrivacySettingRules", rules: [{ "@type": "userPrivacySettingRuleAllowAll" }] };
      case "setUserPrivacySettingRules": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
      const view = await session.telegramPrivacy(key);
      expect(view.audience).toBe("everyone");
      expect(request.mock.lastCall?.[0].setting).toEqual({ "@type": settings[key] });
    }
    const before = await session.telegramPrivacy("findByPhone");
    await expect(session.saveTelegramPrivacy("findByPhone", "nobody", before.version)).resolves.toBe("unsupported");
    await expect(session.saveTelegramPrivacy("findByPhone", "contacts", before.version)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setUserPrivacySettingRules")).toEqual([[
      { "@type": "setUserPrivacySettingRules", setting: { "@type": settings.findByPhone },
        rules: { "@type": "userPrivacySettingRules", rules: [{ "@type": "userPrivacySettingRuleAllowContacts" }] } },
    ]]);
  } finally { await session.close(); }
});

test("updates read time privacy without overwriting a conflicting change", async () => {
  let show = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getReadDatePrivacySettings": return { "@type": "readDatePrivacySettings", show_read_date: show };
      case "setReadDatePrivacySettings":
        show = (query.settings as TdObject).show_read_date === true;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.readDatePrivacy()).resolves.toBe(true);
    await expect(session.saveReadDatePrivacy(false, true)).resolves.toBe("saved");
    await expect(session.readDatePrivacy()).resolves.toBe(false);
    await expect(session.saveReadDatePrivacy(false, false)).resolves.toBe("saved");
    await expect(session.saveReadDatePrivacy(true, true)).resolves.toBe("changed");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setReadDatePrivacySettings")).toEqual([[
      { "@type": "setReadDatePrivacySettings", settings: { "@type": "readDatePrivacySettings", show_read_date: false } },
    ]]);
  } finally { await session.close(); }
});

test("requests outgoing message read time only when TDLib allows it", async () => {
  let outgoing = false;
  let allowed = false;
  let readResult: TdObject = { "@type": "messageReadDateUserPrivacyRestricted" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { "@type": "message", id: 127, chat_id: 42, is_outgoing: outgoing };
      case "getMessageProperties": return { "@type": "messageProperties", can_get_read_date: allowed };
      case "getMessageReadDate": return readResult;
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.messageReadTime("-42", "127")).resolves.toBe("unavailable");
    await expect(session.messageReadTime("42", "128")).resolves.toBe("unavailable");
    await expect(session.messageReadTime("42", "127")).resolves.toBe("unavailable");
    outgoing = true;
    await expect(session.messageReadTime("42", "127")).resolves.toBe("unavailable");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getMessageReadDate")).toHaveLength(0);
    allowed = true;
    await expect(session.messageReadTime("42", "127")).resolves.toBe("recipientPrivacy");
    readResult = { "@type": "messageReadDateMyPrivacyRestricted" };
    await expect(session.messageReadTime("42", "127")).resolves.toBe("ownPrivacy");
    readResult = { "@type": "messageReadDateRead", read_date: 1700000000 };
    await expect(session.messageReadTime("42", "127")).resolves.toBe(1700000000);
  } finally { await session.close(); }
});

test("loads and deduplicates group message viewers only when TDLib permits it", async () => {
  let allowed = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessageProperties": return { "@type": "messageProperties", can_get_viewers: allowed };
      case "getMessageViewers": return { "@type": "messageViewers", viewers: [
        { "@type": "messageViewer", user_id: 7, view_date: 1700000000 },
        { "@type": "messageViewer", user_id: 8, view_date: 0 },
        { "@type": "messageViewer", user_id: 7, view_date: 1700000001 },
        { "@type": "messageViewer", user_id: -9, view_date: 1700000002 },
      ] };
      case "getUser": return query.user_id === 7
        ? { "@type": "user", id: 7, first_name: "Fixture", last_name: "Viewer" }
        : { "@type": "user", id: 8 };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.messageViewers("42", "127")).resolves.toBeNull();
    await expect(session.messageViewers("-42", "127")).resolves.toBeNull();
    expect(request.mock.calls.some(([query]) => query["@type"] === "getMessageViewers")).toBe(false);
    allowed = true;
    await expect(session.messageViewers("-42", "127")).resolves.toEqual([
      { id: "7", name: "Fixture Viewer", viewedAt: 1700000001 },
      { id: "8", name: "Telegram user", viewedAt: 0 },
    ]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getMessageViewers")).toEqual([[
      { "@type": "getMessageViewers", chat_id: -42, message_id: 127 },
    ]]);
  } finally { await session.close(); }
});

test("shows channel view counts and refreshes when Telegram changes the count", async () => {
  let viewCount = 18;
  const onChatChanged = vi.fn();
  const interaction = () => ({ "@type": "messageInteractionInfo", view_count: viewCount });
  const { session, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getChatHistory": return { "@type": "messages", messages: [
        { "@type": "message", chat_id: -42, id: 28, is_channel_post: true, is_outgoing: true,
          author_signature: " Fixture Author ", edit_date: 1700000000, interaction_info: interaction() },
        { "@type": "message", chat_id: -42, id: 27, author_signature: "Fixture Moderator",
          edit_date: 0, interaction_info: interaction() },
      ] };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, undefined, onChatChanged);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const before = (await session.history("-42")).messages;
    expect(before.find(({ id }) => id === "28")).toMatchObject({
      author: "You", viewCount: 18, channelSignature: "Fixture Author", edited: true, editedAt: 1700000000,
    });
    expect(before.find(({ id }) => id === "27")).toMatchObject({ author: "Fixture Moderator", edited: false });
    expect(before.find(({ id }) => id === "27")?.channelSignature).toBeUndefined();
    expect(before.find(({ id }) => id === "27")?.viewCount).toBeUndefined();
    onChatChanged.mockClear();
    const reportCount = () => update({ "@type": "updateMessageInteractionInfo",
      chat_id: -42, message_id: 28, interaction_info: interaction() });
    await reportCount();
    expect(onChatChanged).not.toHaveBeenCalled();
    viewCount = 21;
    await reportCount();
    await vi.waitFor(() => expect(onChatChanged).toHaveBeenCalledOnce());
    expect((await session.history("-42")).messages.find(({ id }) => id === "28")?.viewCount).toBe(21);
  } finally { await session.close(); }
});

test("edits post signatures only for the verified channel and an administrator with change-info rights", async () => {
  let isChannel = true;
  let editable = false;
  let sign = false;
  let showProfile = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42,
        type: { "@type": "chatTypeSupergroup", is_channel: isChannel, supergroup_id: 21 } };
      case "getSupergroup": return { "@type": "supergroup", id: 21, is_channel: true, sign_messages: sign,
        show_message_sender: showProfile,
        status: { "@type": "chatMemberStatusAdministrator",
          rights: { "@type": "chatAdministratorRights", can_change_info: editable } } };
      case "toggleSupergroupSignMessages":
        sign = query.sign_messages === true;
        showProfile = query.show_message_sender === true;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const before = { sign: false, showProfile: false };
    const after = { sign: true, showProfile: true };
    await expect(session.channelSignatures("-42")).resolves.toEqual({ editable: false, values: before });
    await expect(session.saveChannelSignatures("-42", after, before)).resolves.toBe("unavailable");
    editable = true;
    await expect(session.saveChannelSignatures("-42", after, before)).resolves.toBe("saved");
    await expect(session.channelSignatures("-42")).resolves.toEqual({ editable: true, values: after });
    await expect(session.saveChannelSignatures("-42", after, after)).resolves.toBe("saved");
    await expect(session.saveChannelSignatures("-42", before, before)).resolves.toBe("changed");
    isChannel = false;
    await expect(session.channelSignatures("-42")).resolves.toBeNull();
    await expect(session.saveChannelSignatures("-42", before, after)).resolves.toBe("unavailable");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "toggleSupergroupSignMessages")).toEqual([[
      { "@type": "toggleSupergroupSignMessages", supergroup_id: 21, sign_messages: true, show_message_sender: true },
    ]]);
  } finally { await session.close(); }
});

test("locates a chat message no later than the requested date and rejects an unrelated anchor", async () => {
  let chat = -42;
  let date = 1700000000;
  const row = (id: number, forum_topic_id: number, chat_id = -42, timestamp = date) =>
    ({ "@type": "message", id, chat_id, date: timestamp, topic_id: { "@type": "messageTopicForum", forum_topic_id } });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatMessageByDate": return row(27, 19, chat);
      case "getForumTopicHistory": return { "@type": "messages", messages: [
        row(29, 17), row(26, 19), row(25, 17, -43), row(24, 17, -42, date + 1), row(23, 17), row(20, 17),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.messageAtDate("-42", 1700000000)).resolves.toBe("27");
    expect(request).toHaveBeenLastCalledWith({ "@type": "getChatMessageByDate", chat_id: -42, date: 1700000000 });
    await expect(session.messageAtDate("-42", 1700000000, 19)).resolves.toBe("27");
    await expect(session.messageAtDate("-42", 1700000000, 17)).resolves.toBe("23");
    expect(request).toHaveBeenLastCalledWith({ "@type": "getForumTopicHistory", chat_id: -42,
      forum_topic_id: 17, from_message_id: 27, offset: 0, limit: 20 });
    await expect(session.messageAtDate("-42", 1700000000, 18)).resolves.toBeNull();
    date++;
    await expect(session.messageAtDate("-42", 1700000000)).rejects.toThrow("Unexpected Telegram message date");
    chat = -43;
    await expect(session.messageAtDate("-42", 1700000002)).rejects.toThrow("Unexpected Telegram history date anchor");
  } finally { await session.close(); }
});

test("extends message context in both directions without crossing chat or topic boundaries", async () => {
  const item = (id: number, chat_id = -42, forum_topic_id = 17) => ({
    "@type": "message", id, chat_id, topic_id: { "@type": "messageTopicForum", forum_topic_id },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getForumTopicHistory": return { "@type": "messages", messages: [
        item(34, -43), item(33, -42, 18), item(32), item(31), item(30), item(29), item(28),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    expect((await session.messageContextPage("-42", "30", "older", 17)).map(({ id }) => id)).toEqual(["28", "29"]);
    expect((await session.messageContextPage("-42", "30", "newer", 17)).map(({ id }) => id)).toEqual(["31", "32"]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getForumTopicHistory")).toEqual([
      [{ "@type": "getForumTopicHistory", chat_id: -42, forum_topic_id: 17, from_message_id: 30, offset: 0, limit: 21 }],
      [{ "@type": "getForumTopicHistory", chat_id: -42, forum_topic_id: 17, from_message_id: 30, offset: -20, limit: 21 }],
    ]);
  } finally { await session.close(); }
});

test("searches current pins inside the requested forum topic", async () => {
  const row = (id: number, is_pinned: boolean, forum_topic_id = 17, chat_id = -42) => ({
    "@type": "message", id, chat_id, is_pinned, topic_id: { "@type": "messageTopicForum", forum_topic_id },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatMessages": return { "@type": "foundChatMessages", next_from_message_id: 22, messages: [
        row(26, true, 17, -43), row(25, true, 18), row(24, false), row(23, true), row(22, true),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const page = await session.searchMessages("-42", "", "pinned", 17);
    expect(page.messages.map(({ id }) => id)).toEqual(["23", "22"]);
    expect(page.before).toBe("22");
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      "@type": "searchChatMessages", chat_id: -42, query: "",
      topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 }, filter: { "@type": "searchMessagesFilterPinned" },
    }));
  } finally { await session.close(); }
});

test("filters forum search by the exact Telegram sender identity", async () => {
  const message = (id: number, sender_id: TdObject, forum_topic_id = 17) => ({
    "@type": "message", id, chat_id: -42, sender_id, topic_id: { "@type": "messageTopicForum", forum_topic_id },
  });
  const person = { "@type": "messageSenderUser", user_id: 7 };
  const channel = { "@type": "messageSenderChat", chat_id: -7 };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getUser": return { "@type": "user", id: query.user_id, first_name: "Fixture" };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: "Fixture" };
      case "searchChatMessages": return { "@type": "foundChatMessages", next_from_message_id: 18, messages: [
        message(23, person, 18), message(22, { "@type": "messageSenderUser", user_id: 8 }),
        message(21, channel), message(20, person),
      ] };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.searchMessages("-42", "", undefined, 17, undefined, { kind: "user", id: "7" }))
      .resolves.toMatchObject({ messages: [{ id: "20", sender: { kind: "user", id: "7" } }], before: "18" });
    await expect(session.searchMessages("-42", "example", undefined, 17, undefined, { kind: "chat", id: "-7" }))
      .resolves.toMatchObject({ messages: [{ id: "21", sender: { kind: "chat", id: "-7" } }] });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "searchChatMessages").map(([query]) => query.sender_id))
      .toEqual([person, channel]);
  } finally { await session.close(); }
});

test("requests unread mentions without text or sender filters and follows chat count updates", async () => {
  const updateChat = vi.fn();
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatMessages": return { "@type": "foundChatMessages", next_from_message_id: 0, messages: [
        { "@type": "message", id: 28, chat_id: -42, contains_unread_mention: false },
        { "@type": "message", id: 27, chat_id: -42, contains_unread_mention: true },
      ] };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, undefined, updateChat);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.searchMessages("-42", "text", "unreadMentions")).rejects.toThrow();
    await expect(session.searchMessages("-42", "", "unreadMentions", undefined, undefined, { kind: "user", id: "7" }))
      .rejects.toThrow();
    const page = await session.searchMessages("-42", "", "unreadMentions");
    expect(page.messages.map(({ id }) => id)).toEqual(["27"]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "searchChatMessages")).toEqual([[
      { "@type": "searchChatMessages", chat_id: -42, query: "", from_message_id: 0, offset: 0, limit: 40,
        filter: { "@type": "searchMessagesFilterUnreadMention" } },
    ]]);
    updateChat.mockClear();
    await update({ "@type": "updateChatUnreadMentionCount", chat_id: -42, unread_mention_count: 2 });
    await vi.waitFor(() => expect(updateChat).toHaveBeenCalledOnce());
  } finally { await session.close(); }
});

test("finds only messages with unread reactions and refreshes their chat count", async () => {
  const changed = vi.fn();
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "searchChatMessages": return { "@type": "foundChatMessages", next_from_message_id: 0, messages: [
        { "@type": "message", id: 28, chat_id: -42, unread_reactions: [] },
        { "@type": "message", id: 27, chat_id: -42, unread_reactions: [{ "@type": "unreadReaction" }] },
      ] };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, undefined, changed);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.searchMessages("-42", "text", "unreadReactions")).rejects.toThrow();
    expect((await session.searchMessages("-42", "", "unreadReactions")).messages.map(({ id }) => id)).toEqual(["27"]);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      "@type": "searchChatMessages", filter: { "@type": "searchMessagesFilterUnreadReaction" },
    }));
    changed.mockClear();
    await update({ "@type": "updateMessageUnreadReactions", chat_id: -42, message_id: 27,
      unread_reactions: [], unread_reaction_count: 0 });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  } finally { await session.close(); }
});

test("marks only the selected unread activity and uses the requested topic scope", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    return { "@type": "ok" };
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    expect(await session.markActivityRead("-42", "unreadMentions")).toBe(true);
    expect(await session.markActivityRead("-42", "unreadReactions")).toBe(true);
    expect(await session.markActivityRead("-42", "unreadMentions", 17)).toBe(true);
    expect(await session.markActivityRead("-42", "unreadReactions", 17)).toBe(true);
    expect(await session.markActivityRead("-42", "unreadReactions", 0)).toBe(false);
    expect(request.mock.calls.filter(([query]) => query["@type"].startsWith("readAll"))).toEqual([
      [{ "@type": "readAllChatMentions", chat_id: -42 }],
      [{ "@type": "readAllChatReactions", chat_id: -42 }],
      [{ "@type": "readAllForumTopicMentions", chat_id: -42, forum_topic_id: 17 }],
      [{ "@type": "readAllForumTopicReactions", chat_id: -42, forum_topic_id: 17 }],
    ]);
  } finally { await session.close(); }
});

test("maps Telegram link cards and enables previews only on opt-in manual sends", async () => {
  const text = "See https://example.com/fixture";
  const item = { "@type": "message", id: 42, chat_id: 7, content: {
    "@type": "messageText", text: { "@type": "formattedText", text },
    link_preview: { "@type": "linkPreview", url: "https://example.com/fixture", site_name: "Fixture site",
      title: "Fixture title", description: { "@type": "formattedText", text: "Fixture summary" }, show_above_text: true },
  } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 7, title: "Fixture", type: { "@type": "chatTypePrivate", user_id: 7 },
        permissions: { "@type": "chatPermissions", can_send_basic_messages: true } };
      case "getChatHistory": return { "@type": "messages", messages: [item] };
      case "sendMessage": return item;
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    expect((await session.history("7")).messages[0]?.linkPreview).toEqual({
      url: "https://example.com/fixture", site: "Fixture site", title: "Fixture title",
      description: "Fixture summary", above: true,
    });
    await expect(session.sendText("7", text)).resolves.toMatchObject({ state: "sent" });
    await expect(session.sendText("7", text, undefined, undefined, undefined, undefined, undefined, undefined,
      { linkPreview: true, linkPreviewAbove: true, styles: [{ offset: 0, length: 3, style: "bold" }] })).resolves.toMatchObject({ state: "sent" });
    await expect(session.sendText("7", text, undefined, undefined, () => true, undefined, undefined, undefined,
      { linkPreview: true, linkPreviewAbove: true, styles: [{ offset: 0, length: 3, style: "bold" }] })).resolves.toMatchObject({ state: "sent" });
    await expect(session.sendText("7", `${text} https://example.org`, undefined, undefined, undefined, undefined, undefined, undefined,
      { linkPreview: true, linkPreviewUrl: "https://example.org/" })).resolves.toMatchObject({ state: "sent" });
    await expect(session.sendText("7", text, undefined, undefined, undefined, undefined, undefined, undefined,
      { linkPreview: true, linkPreviewUrl: "https://example.org/" })).resolves.toEqual({ state: "failed" });
    const options = request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")
      .map(([query]) => (query.input_message_content as TdObject).link_preview_options);
    expect(options).toEqual([
      { "@type": "linkPreviewOptions", is_disabled: true },
      { "@type": "linkPreviewOptions", is_disabled: false, show_above_text: true },
      { "@type": "linkPreviewOptions", is_disabled: true },
      { "@type": "linkPreviewOptions", is_disabled: false, url: "https://example.org/" },
    ]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")
      .map(([query]) => ((query.input_message_content as TdObject).text as TdObject).entities)).toEqual([
      [], [{ "@type": "textEntity", offset: 0, length: 3, type: { "@type": "textEntityTypeBold" } }], [], [],
    ]);
    await expect(session.sendText("7", "🙂", undefined, undefined, undefined, undefined, undefined, undefined,
      { styles: [{ offset: 1, length: 1, style: "bold" }] })).resolves.toEqual({ state: "failed" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toHaveLength(4);
  } finally { await session.close(); }
});

test("preserves styles when editing text and rejects a format conflict with the same plain text", async () => {
  let style = "textEntityTypeBold";
  const text = "Fixture text";
  const raw = {
    "@type": "message", id: 25, chat_id: 42, is_outgoing: true, can_be_edited: true,
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { ...raw, content: { "@type": "messageText",
        text: { "@type": "formattedText", text, entities: [
          { "@type": "textEntity", offset: 0, length: 7, type: { "@type": style } },
        ] } } };
      case "editMessageText": return { ...raw, content: {
        "@type": "messageText", text: (query.input_message_content as TdObject).text,
      } };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const styles = [{ offset: 0, length: 7, style: "bold" as const }];
    style = "textEntityTypeItalic";
    await expect(session.editText("42", "25", "New text", text, styles)).resolves.toEqual({ state: "failed" });
    style = "textEntityTypePre";
    await expect(session.editText("42", "25", "New text", text, styles)).resolves.toEqual({ state: "failed" });
    style = "textEntityTypeBold";
    await expect(session.editText("42", "25", "New text", text, styles)).resolves.toMatchObject({
      state: "sent", message: { text: "New text", editable: true, styles: [{ offset: 0, length: 3, style: "bold" }] },
    });
    await expect(session.editText("42", "25", text, text, styles, [])).resolves.toMatchObject({
      state: "sent", message: { text },
    });
    const edits = request.mock.calls.filter(([query]) => query["@type"] === "editMessageText");
    expect(edits).toHaveLength(2);
    expect(edits[1]?.[0]).toMatchObject({ input_message_content: { text: { text, entities: [] } } });
  } finally { await session.close(); }
});

test("sends an exact quote in a manual reply, retaining source formatting and rejecting stale excerpts", async () => {
  const source = { "@type": "message", id: 24, chat_id: 42, content: {
    "@type": "messageText", text: { "@type": "formattedText", text: "🙂 Fixture quote", entities: [
      { "@type": "textEntity", offset: 3, length: 7, type: { "@type": "textEntityTypeBold" } },
    ] },
  } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return source;
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "sendMessage": return { ...source, id: 25, reply_to: {
        "@type": "messageReplyToMessage", chat_id: 42, message_id: 24,
        quote: { "@type": "textQuote", is_manual: true, text: {
          "@type": "formattedText", text: "Fixture", entities: [
            { "@type": "textEntity", offset: 0, length: 7, type: { "@type": "textEntityTypeSpoiler" } },
          ],
        } },
      } };
      default: throw new Error("Unexpected test query");
    }
  });
  const send = (position: number) => session.sendText("42", "Reply fixture", "24", undefined, undefined, undefined,
    undefined, undefined, { quote: { text: "Fixture", position } });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(send(2)).resolves.toEqual({ state: "failed" });
    await expect(send(3)).resolves.toMatchObject({ state: "sent", message: { replyTo: "24", replyQuote: "[Spoiler]" } });
    const writes = request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatchObject({ reply_to: { "@type": "inputMessageReplyToMessage", message_id: 24,
      quote: { "@type": "inputTextQuote", position: 3, text: { text: "Fixture", entities: [
        { "@type": "textEntity", offset: 0, length: 7, type: { "@type": "textEntityTypeBold" } },
      ] } },
    } });
  } finally { await session.close(); }
});

test("reschedules or releases only the unchanged scheduled message selected in BB", async () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  const next = at + 3600;
  const row = { id: "22", text: "Synthetic reminder", at, repeatEvery: 604800 };
  let scheduledAt = at;
  let currentText = row.text;
  let permitted = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { "@type": "message", id: 22, chat_id: 42, is_outgoing: true,
        scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: scheduledAt, repeat_period: 604800 },
        content: { "@type": "messageText", text: { "@type": "formattedText", text: currentText } } };
      case "getMessageProperties": return { "@type": "messageProperties", can_edit_scheduling_state: permitted };
      case "editMessageSchedulingState":
        if (query.scheduling_state) scheduledAt = Number((query.scheduling_state as TdObject).send_date);
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    permitted = false;
    await expect(session.changeScheduledMessage("42", row, next)).resolves.toBe("unavailable");
    permitted = true;
    await expect(session.changeScheduledMessage("42", row, next)).resolves.toBe("updated");
    await expect(session.changeScheduledMessage("42", row, null)).resolves.toBe("changed");
    await expect(session.changeScheduledMessage("42", { ...row, at: next, repeatEvery: 86400 }, null)).resolves.toBe("changed");
    currentText = "Changed externally";
    await expect(session.changeScheduledMessage("42", { ...row, at: next }, null)).resolves.toBe("changed");
    currentText = row.text;
    await expect(session.changeScheduledMessage("42", { ...row, at: next }, null)).resolves.toBe("updated");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editMessageSchedulingState")).toEqual([
      [{ "@type": "editMessageSchedulingState", chat_id: 42, message_id: 22,
        scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: next, repeat_period: 604800 } }],
      [{ "@type": "editMessageSchedulingState", chat_id: 42, message_id: 22, scheduling_state: null }],
    ]);
  } finally { await session.close(); }
});

test("only schedules a manual message for online delivery with verified exact recipient status", async () => {
  let own = 7;
  let status: TdObject = { "@type": "userStatusRecently" };
  const schedule = { "@type": "messageSchedulingStateSendWhenOnline" };
  const row = { "@type": "message", id: 22, chat_id: 42, is_outgoing: true, scheduling_state: schedule,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Synthetic greeting" } } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getMe": return { "@type": "user", id: own, type: { "@type": "userTypeRegular" } };
      case "getUser": return { "@type": "user", id: 42, type: { "@type": "userTypeRegular" }, status };
      case "sendMessage": return row;
      case "getChatScheduledMessages": return { "@type": "messages", messages: [row] };
      default: throw new Error("Unexpected test query");
    }
  });
  const send = (authorize?: () => boolean) => session.sendText("42", "Synthetic greeting", undefined, undefined,
    authorize, undefined, undefined, undefined, { whenOnline: true });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(send()).resolves.toEqual({ state: "failed" });
    status = { "@type": "userStatusOffline", was_online: 1700000000 };
    await expect(session.canScheduleWhenOnline("42")).resolves.toBe(true);
    own = 42;
    await expect(send()).resolves.toEqual({ state: "failed" });
    own = 7;
    await expect(send(() => true)).resolves.toEqual({ state: "failed" });
    await expect(send()).resolves.toMatchObject({ state: "sent" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toEqual([[
      expect.objectContaining({ options: { "@type": "messageSendOptions", disable_notification: false, scheduling_state: schedule } }),
    ]]);
    await expect(session.scheduledMessages("42")).resolves.toEqual([{ id: "22", text: "Synthetic greeting", whenOnline: true }]);
  } finally { await session.close(); }
});

test("lists and modifies scheduled messages only within the selected forum topic", async () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  const row = (id: number, forum_topic_id: number) => ({
    "@type": "message", id, chat_id: -42, is_outgoing: true,
    topic_id: { "@type": "messageTopicForum", forum_topic_id },
    scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: at },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Synthetic schedule" } },
  });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatScheduledMessages": return { "@type": "messages", messages: [row(22, 17), row(23, 18)] };
      case "getMessage": return Number(query.message_id) === 22 ? row(22, 17) : row(23, 18);
      case "getMessageProperties": return { "@type": "messageProperties", can_edit_scheduling_state: true };
      case "editMessageSchedulingState":
      case "deleteMessages": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const expected = { id: "22", text: "Synthetic schedule", at };
    await expect(session.scheduledMessages("-42", 17)).resolves.toEqual([expected]);
    await expect(session.changeScheduledMessage("-42", expected, null, 18)).resolves.toBe("changed");
    await expect(session.cancelScheduledMessage("-42", "23", 17)).resolves.toBe(false);
    await expect(session.changeScheduledMessage("-42", expected, at + 1000, 17)).resolves.toBe("updated");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editMessageSchedulingState" || query["@type"] === "deleteMessages"))
      .toEqual([[{ "@type": "editMessageSchedulingState", chat_id: -42, message_id: 22,
        scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: at + 1000 } }]]);
  } finally { await session.close(); }
});

test("creates repeated schedules only for manual Premium messages and reads the repeat interval", async () => {
  let premium = false;
  const at = Math.floor(Date.now() / 1000) + 3600;
  const schedule = { "@type": "messageSchedulingStateSendAtDate", send_date: at, repeat_period: 604800 };
  const row = { "@type": "message", id: 22, chat_id: 42, is_outgoing: true, scheduling_state: schedule,
    content: { "@type": "messageText", text: { "@type": "formattedText", text: "Synthetic repeated message" } } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42 };
      case "getMe": return { "@type": "user", id: 7, is_premium: premium };
      case "sendMessage": return row;
      case "getChatScheduledMessages": return { "@type": "messages", messages: [row] };
      default: throw new Error("Unexpected test query");
    }
  });
  const send = (authorize?: () => boolean) => session.sendText("42", "Synthetic repeated message", undefined, undefined,
    authorize, undefined, undefined, undefined, { at, repeatEvery: 604800 });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(send()).resolves.toEqual({ state: "failed" });
    premium = true;
    await expect(send(() => true)).resolves.toEqual({ state: "failed" });
    await expect(send()).resolves.toMatchObject({ state: "sent" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toEqual([[
      expect.objectContaining({ options: expect.objectContaining({ scheduling_state: schedule }) }),
    ]]);
    await expect(session.scheduledMessages("42")).resolves.toEqual([
      { id: "22", text: "Synthetic repeated message", at, repeatEvery: 604800 },
    ]);
  } finally { await session.close(); }
});

test("reads slow mode for supergroups and verifies rights and the previous delay before saving", async () => {
  let channel = false;
  let editable = false;
  let delay = 30;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 7, is_channel: channel },
        permissions: { "@type": "chatPermissions" } };
      case "getSupergroup": return { "@type": "supergroup", id: 7, is_channel: channel,
        status: { "@type": "chatMemberStatusAdministrator",
          rights: { "@type": "chatAdministratorRights", can_restrict_members: editable } } };
      case "getSupergroupFullInfo": return { "@type": "supergroupFullInfo", slow_mode_delay: delay };
      case "setChatSlowModeDelay": delay = Number(query.slow_mode_delay); return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.groupSlowMode("-42")).resolves.toEqual({ delay: 30, editable: false });
    await expect(session.saveGroupSlowMode("-42", 60, 30)).resolves.toBe("unavailable");
    editable = true;
    await expect(session.saveGroupSlowMode("-42", 60, 10)).resolves.toBe("changed");
    await expect(session.saveGroupSlowMode("-42", 60, 30)).resolves.toBe("saved");
    await expect(session.groupSlowMode("-42")).resolves.toEqual({ delay: 60, editable: true });
    channel = true;
    await expect(session.groupSlowMode("-42")).resolves.toBeNull();
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatSlowModeDelay")).toEqual([[
      { "@type": "setChatSlowModeDelay", chat_id: -42, slow_mode_delay: 60 },
    ]]);
  } finally { await session.close(); }
});

test("updates one group information field and refuses stale values or missing permission", async () => {
  let title = "Fixture Group";
  let description = "Initial description";
  let canChange = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title,
        type: { "@type": "chatTypeBasicGroup", basic_group_id: 17 },
        permissions: { "@type": "chatPermissions", can_change_info: canChange } };
      case "getBasicGroup": return { "@type": "basicGroup", id: 17, is_active: true, status: { "@type": "chatMemberStatusMember" } };
      case "getBasicGroupFullInfo": return { "@type": "basicGroupFullInfo", description };
      case "setChatTitle": title = String(query.title); return { "@type": "ok" };
      case "setChatDescription": description = String(query.description); return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.chatInfo("-42")).resolves.toEqual({ title, description, editable: false, photoVersion: null });
    const name = { field: "title" as const, value: "Updated fixture", expected: title };
    await expect(session.saveChatInfo("-42", name)).resolves.toBe("unavailable");
    canChange = true;
    await expect(session.saveChatInfo("-42", { ...name, expected: "Stale fixture" })).resolves.toBe("changed");
    await expect(session.saveChatInfo("-42", name)).resolves.toBe("saved");
    await expect(session.saveChatInfo("-42", { field: "description", value: "", expected: description })).resolves.toBe("saved");
    await expect(session.chatInfo("-42")).resolves.toEqual({ title: "Updated fixture", description: "", editable: true, photoVersion: null });
    expect(request.mock.calls.filter(([query]) => ["setChatTitle", "setChatDescription"].includes(query["@type"]))).toEqual([
      [{ "@type": "setChatTitle", chat_id: -42, title: "Updated fixture" }],
      [{ "@type": "setChatDescription", chat_id: -42, description: "" }],
    ]);
  } finally { await session.close(); }
});

test("updates a chat photo only with unchanged photo identity and Telegram permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-chat-photo-"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]);
  let photoId = 0;
  let allowed = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42, title: "Fixture", photo: photoId
        ? { "@type": "chatPhotoInfo", small: { "@type": "file", id: photoId } } : null,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 17, is_channel: true } };
      case "getSupergroup": return { "@type": "supergroup", id: 17, is_channel: true,
        status: { "@type": "chatMemberStatusAdministrator", rights: { "@type": "chatAdministratorRights", can_change_info: allowed } } };
      case "getSupergroupFullInfo": return { "@type": "supergroupFullInfo", description: "" };
      case "setChatPhoto": photoId = query.photo === null ? 0 : 2; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, directory);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const base64 = jpeg.toString("base64");
    await expect(session.saveChatPhoto("-42", base64, null)).resolves.toBe("unavailable");
    allowed = true;
    photoId = 1;
    await expect(session.saveChatPhoto("-42", base64, null)).resolves.toBe("changed");
    const info = (await session.chatInfo("-42"))!;
    expect(info.photoVersion).toMatch(/^[0-9a-f]{64}$/);
    await expect(session.saveChatPhoto("-42", base64, info.photoVersion!)).resolves.toBe("saved");
    const writes = request.mock.calls.filter(([query]) => query["@type"] === "setChatPhoto");
    expect(writes).toHaveLength(1);
    const photo = writes[0]?.[0].photo as TdObject;
    expect(photo).toMatchObject({ "@type": "inputChatPhotoStatic", photo: { "@type": "inputFileLocal" } });
    await expect(readFile(String((photo.photo as TdObject).path))).rejects.toMatchObject({ code: "ENOENT" });
    const current = (await session.chatInfo("-42"))!.photoVersion!;
    expect(current).not.toBe(info.photoVersion);
    await expect(session.removeChatPhoto("-42", info.photoVersion!)).resolves.toBe("changed");
    allowed = false;
    await expect(session.removeChatPhoto("-42", current)).resolves.toBe("unavailable");
    allowed = true;
    await expect(session.removeChatPhoto("-42", current)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatPhoto").slice(1)).toEqual([
      [{ "@type": "setChatPhoto", chat_id: -42, photo: null }],
    ]);
    expect((await session.chatInfo("-42"))?.photoVersion).toBeNull();
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates the main account photo without changing the public fallback or overwriting a newer photo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-profile-photo-"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]).toString("base64");
  let photo = 1;
  const mainPhotoId = "9007199254740993";
  let mainPhoto = mainPhotoId;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42, profile_photo: {
        "@type": "profilePhoto", id: mainPhotoId, small: { "@type": "file", id: photo },
      } };
      case "getUserFullInfo": return { "@type": "userFullInfo", photo: { "@type": "chatPhoto", id: mainPhoto }, public_photo: { "@type": "chatPhoto", id: "12" } };
      case "deleteProfilePhoto": return { "@type": "ok" };
      case "getOption": return { "@type": "optionValueInteger", value: "70" };
      case "setProfilePhoto": photo++; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, directory);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const before = (await session.telegramProfile()).photoVersion!;
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await expect(session.saveProfilePhoto(jpeg, null)).resolves.toBe("changed");
    await expect(session.saveProfilePhoto(jpeg, before)).resolves.toBe("saved");
    await expect(session.saveProfilePhoto(jpeg, before)).resolves.toBe("changed");
    const updates = request.mock.calls.filter(([query]) => query["@type"] === "setProfilePhoto");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toMatchObject({ "@type": "setProfilePhoto", is_public: false,
      photo: { "@type": "inputChatPhotoStatic", photo: { "@type": "inputFileLocal" } } });
    expect((await session.telegramProfile()).canRemovePhoto).toBe(true);
    const current = (await session.telegramProfile()).photoVersion!;
    await expect(session.removeProfilePhoto(before)).resolves.toBe("changed");
    mainPhoto = "12";
    await expect(session.removeProfilePhoto(current)).resolves.toBe("changed");
    mainPhoto = mainPhotoId;
    await expect(session.removeProfilePhoto(current)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "deleteProfilePhoto")).toEqual([
      [{ "@type": "deleteProfilePhoto", profile_photo_id: mainPhotoId }],
    ]);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks and unblocks private peers only against the expected Telegram block list", async () => {
  let blockList: TdObject | null = { "@type": "blockListStories" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42 };
      case "getChat": return { "@type": "chat", id: query.chat_id,
        type: { "@type": "chatTypePrivate", user_id: query.chat_id }, block_list: blockList };
      case "setMessageSenderBlockList":
        blockList = query.block_list as TdObject | null;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.senderBlockState("42")).resolves.toBeNull();
    await expect(session.senderBlockState("71")).resolves.toBe("stories");
    await expect(session.setSenderBlockState("42", "stories", "main")).resolves.toBe(false);
    await expect(session.setSenderBlockState("71", "none", "main")).resolves.toBe(false);
    await expect(session.setSenderBlockState("71", "stories", "stories")).resolves.toBe(true);
    await expect(session.setSenderBlockState("71", "stories", "main")).resolves.toBe(true);
    await expect(session.senderBlockState("71")).resolves.toBe("main");
    await expect(session.setSenderBlockState("71", "main", "stories")).resolves.toBe(false);
    await expect(session.setSenderBlockState("71", "main", "none")).resolves.toBe(true);
    await expect(session.senderBlockState("71")).resolves.toBe("none");
    await expect(session.setSenderBlockState("71", "none", "stories")).resolves.toBe(true);
    await expect(session.senderBlockState("71")).resolves.toBe("stories");
    await expect(session.setSenderBlockState("71", "stories", "none")).resolves.toBe(true);
    await expect(session.senderBlockState("71")).resolves.toBe("none");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setMessageSenderBlockList")).toEqual([
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderUser", user_id: 71 },
        block_list: { "@type": "blockListMain" } }],
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderUser", user_id: 71 },
        block_list: null }],
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderUser", user_id: 71 },
        block_list: { "@type": "blockListStories" } }],
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderUser", user_id: 71 }, block_list: null }],
    ]);
  } finally { await session.close(); }
});

test("lists blocked users and chats and only unblocks senders still on the main list", async () => {
  const user = { kind: "user", id: "71" } as const;
  const chat = { kind: "chat", id: "-10099" } as const;
  let userBlockList = "blockListStories";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getBlockedMessageSenders":
        if ((query.block_list as TdObject)["@type"] === "blockListStories") {
          return { "@type": "messageSenders", total_count: 1, senders: [{ "@type": "messageSenderUser", user_id: 71 }] };
        }
        return { "@type": "messageSenders", total_count: 3,
        senders: query.offset === 0 ? [{ "@type": "messageSenderUser", user_id: 71 },
          { "@type": "messageSenderChat", chat_id: -10099 }] : [] };
      case "getUser": return { "@type": "user", first_name: "Fixture", last_name: "User" };
      case "getUserFullInfo": return { "@type": "userFullInfo", block_list: { "@type": userBlockList } };
      case "createPrivateChat": return { "@type": "chat", id: 71, title: "Fixture User",
        type: { "@type": "chatTypePrivate", user_id: 71 } };
      case "getChat": return { "@type": "chat", id: -10099, title: "Fixture Chat",
        type: { "@type": "chatTypeSupergroup", supergroup_id: 99, is_channel: true },
        block_list: { "@type": "blockListMain" } };
      case "setMessageSenderBlockList": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.blockedSenders("main", 0)).resolves.toEqual({
      entries: [{ sender: user, name: "Fixture User" }, { sender: chat, name: "Fixture Chat" }], next: 2,
    });
    await expect(session.blockedSenders("main", 2)).resolves.toEqual({ entries: [], next: null });
    await expect(session.openBlockedSender(user)).resolves.toMatchObject({ id: "71", name: "Fixture User" });
    await expect(session.openBlockedSender(chat)).resolves.toMatchObject({ id: "-10099", name: "Fixture Chat" });
    await expect(session.openBlockedSender({ kind: "user", id: "72" })).rejects.toThrow("Telegram conversation is unavailable.");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setMessageSenderBlockList")).toEqual([]);
    await expect(session.blockedSenders("stories", 0)).resolves.toEqual({
      entries: [{ sender: user, name: "Fixture User" }], next: null,
    });
    await expect(session.unblockListedSender(user, "main")).resolves.toBe(false);
    userBlockList = "blockListMain";
    await expect(session.unblockListedSender(user, "stories")).resolves.toBe(false);
    userBlockList = "blockListStories";
    await expect(session.unblockListedSender(user, "stories")).resolves.toBe(true);
    await expect(session.unblockListedSender(chat, "main")).resolves.toBe(true);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setMessageSenderBlockList")).toEqual([
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderUser", user_id: 71 }, block_list: null }],
      [{ "@type": "setMessageSenderBlockList", sender_id: { "@type": "messageSenderChat", chat_id: -10099 }, block_list: null }],
    ]);
  } finally { await session.close(); }
});

test("preserves archive preferences and checks account availability before enabling automatic archiving", async () => {
  let available = false;
  const settings = {
    "@type": "archiveChatListSettings", archive_and_mute_new_chats_from_unknown_users: false,
    keep_unmuted_chats_archived: false, keep_chats_from_folders_archived: true,
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getArchiveChatListSettings": return settings;
      case "getOption":
        expect(query.name).toBe("can_archive_and_mute_new_chats_from_unknown_users");
        return { "@type": "optionValueBoolean", value: available };
      case "setArchiveChatListSettings": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  const original = { muteUnknown: false, keepUnmuted: false, keepFolderChats: true };
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.archiveSettings()).resolves.toEqual({ ...original, canMuteUnknown: false });
    await expect(session.saveArchiveSettings({ ...original, muteUnknown: true }, original)).resolves.toBe("unavailable");
    await expect(session.saveArchiveSettings(original, { ...original, keepFolderChats: false })).resolves.toBe("changed");
    available = true;
    await expect(session.saveArchiveSettings({ ...original, muteUnknown: true, keepUnmuted: true }, original)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setArchiveChatListSettings")).toEqual([
      [{ "@type": "setArchiveChatListSettings", settings: { ...settings,
        archive_and_mute_new_chats_from_unknown_users: true, keep_unmuted_chats_archived: true } }],
    ]);
  } finally { await session.close(); }
});

test("validates the default auto-delete timer and refuses stale account settings", async () => {
  let seconds = 7 * 86400;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getDefaultMessageAutoDeleteTime": return { "@type": "messageAutoDeleteTime", time: seconds };
      case "setDefaultMessageAutoDeleteTime":
        seconds = Number((query.message_auto_delete_time as TdObject).time);
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.defaultAutoDeleteDays()).resolves.toBe(7);
    await expect(session.saveDefaultAutoDeleteDays(366, 7)).resolves.toBe("unavailable");
    await expect(session.saveDefaultAutoDeleteDays(0, 1)).resolves.toBe("changed");
    await expect(session.saveDefaultAutoDeleteDays(365, 7)).resolves.toBe("saved");
    await expect(session.defaultAutoDeleteDays()).resolves.toBe(365);
    await expect(session.saveDefaultAutoDeleteDays(0, 365)).resolves.toBe("saved");
    await expect(session.defaultAutoDeleteDays()).resolves.toBe(0);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setDefaultMessageAutoDeleteTime")).toEqual(
      [365 * 86400, 0].map((time) => [{ "@type": "setDefaultMessageAutoDeleteTime",
        message_auto_delete_time: { "@type": "messageAutoDeleteTime", time } }]),
    );
  } finally { await session.close(); }
});

test("changes a chat auto-delete timer only for supported chats with current settings and permission", async () => {
  let groupCanEdit = false;
  let seconds = 86400;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42 };
      case "getChat": return { "@type": "chat", id: query.chat_id, message_auto_delete_time: seconds,
        type: Number(query.chat_id) < 0 ? { "@type": "chatTypeSupergroup", supergroup_id: 99 }
          : { "@type": "chatTypePrivate", user_id: query.chat_id } };
      case "getSupergroup": return { "@type": "supergroup", id: 99,
        status: { "@type": "chatMemberStatusAdministrator",
          rights: { "@type": "chatAdministratorRights", can_change_info: groupCanEdit } } };
      case "setChatMessageAutoDeleteTime":
        seconds = Number(query.message_auto_delete_time);
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.chatAutoDelete("42")).resolves.toBeNull();
    await expect(session.chatAutoDelete("777000")).resolves.toBeNull();
    await expect(session.chatAutoDelete("71")).resolves.toEqual({ days: 1, editable: true });
    await expect(session.chatAutoDelete("-10099")).resolves.toEqual({ days: 1, editable: false });
    await expect(session.saveChatAutoDelete("-10099", 7, 1)).resolves.toBe("unavailable");
    groupCanEdit = true;
    await expect(session.saveChatAutoDelete("-10099", 7, 0)).resolves.toBe("changed");
    await expect(session.saveChatAutoDelete("-10099", 7, 1)).resolves.toBe("saved");
    await expect(session.chatAutoDelete("-10099")).resolves.toEqual({ days: 7, editable: true });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatMessageAutoDeleteTime")).toEqual([
      [{ "@type": "setChatMessageAutoDeleteTime", chat_id: -10099, message_auto_delete_time: 7 * 86400 }],
    ]);
  } finally { await session.close(); }
});

test("renders Telegram service events with their values and keeps ordinary messages distinct", async () => {
  const contents = [
    { "@type": "messageChatSetMessageAutoDeleteTime", message_auto_delete_time: 7 * 86400 },
    { "@type": "messageChatSetMessageAutoDeleteTime", message_auto_delete_time: 0 },
    { "@type": "messageChatChangeTitle", title: "Fixture Group" },
    { "@type": "messageForumTopicIsClosedToggled", is_closed: false },
    { "@type": "messagePinMessage", message_id: 6 },
    { "@type": "messagePinMessage", message_id: 0 },
    { "@type": "messageText", text: { "@type": "formattedText", text: "Message pinned" } },
  ];
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: -42 };
      case "getChatHistory": return { "@type": "messages", messages: contents.map((content, index) =>
        ({ "@type": "message", chat_id: -42, id: index + 1, content })).reverse() };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const { messages } = await session.history("-42");
    expect(messages.map(({ text, service, pinnedTargetId }) => [text, service, pinnedTargetId])).toEqual([
      ["Message auto-delete set to 7 days", true, undefined],
      ["Message auto-delete turned off", true, undefined],
      ["Chat renamed to “Fixture Group”", true, undefined],
      ["Topic reopened", true, undefined],
      ["Message pinned", true, "6"],
      ["Message pinned", true, undefined],
      ["Message pinned", undefined, undefined],
    ]);
  } finally { await session.close(); }
});

test("preserves the link card and its layout when editing a message with the same URL", async () => {
  const url = "https://example.com/fixture";
  const text = `Original ${url}`;
  const raw = { "@type": "message", id: 25, chat_id: 42, is_outgoing: true, can_be_edited: true };
  let disabled = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return { ...raw, content: { "@type": "messageText",
        text: { "@type": "formattedText", text },
        link_preview: { "@type": "linkPreview", url, show_above_text: true },
        link_preview_options: { "@type": "linkPreviewOptions", url, is_disabled: disabled,
          force_small_media: true, show_above_text: true },
      } };
      case "editMessageText": return { ...raw, content: { "@type": "messageText", text: (query.input_message_content as TdObject).text } };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.editText("42", "25", `Updated https://example.org ${url}`, text)).resolves.toMatchObject({ state: "sent" });
    await expect(session.editText("42", "25", "Updated https://example.org", text)).resolves.toMatchObject({ state: "sent" });
    await expect(session.editText("42", "25", text, text, [], undefined, "https://example.org/")).resolves.toEqual({ state: "failed" });
    await expect(session.editText("42", "25", text, text, [], undefined, url)).resolves.toMatchObject({ state: "sent" });
    disabled = true;
    await expect(session.editText("42", "25", `Updated ${url}`, text)).resolves.toMatchObject({ state: "sent" });
    const edits = request.mock.calls.filter(([query]) => query["@type"] === "editMessageText")
      .map(([query]) => query.input_message_content);
    expect(edits).toMatchObject([
      { disable_web_page_preview: true, link_preview_options: { "@type": "linkPreviewOptions", is_disabled: false,
        url, force_small_media: true, force_large_media: false, show_above_text: true } },
      { link_preview_options: { "@type": "linkPreviewOptions", is_disabled: true } },
      { disable_web_page_preview: true, text: { text }, link_preview_options: { "@type": "linkPreviewOptions", is_disabled: true } },
      { link_preview_options: { "@type": "linkPreviewOptions", is_disabled: true } },
    ]);
  } finally { await session.close(); }
});

test("saves and clears a topic draft without touching the chat draft or replacing rich content", async () => {
  const plain = (text: string) => ({ "@type": "draftMessage", content: {
    "@type": "draftMessageContentText", text: { "@type": "formattedText", text, entities: [] },
  } });
  let remote: unknown = plain("Original fixture");
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: "1.8.70" };
      case "getForumTopic": return { "@type": "forumTopic", info: { "@type": "forumTopicInfo", chat_id: -42,
        forum_topic_id: 17, name: "Fixture" }, draft_message: remote };
      case "setChatDraftMessage": remote = query.draft_message; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.topicDraft("-42", 17)).resolves.toEqual({ text: "Original fixture", writable: true });
    await expect(session.saveChatDraft("-42", "Updated fixture", null, 17)).resolves.toBe("changed");
    await expect(session.saveChatDraft("-42", "Updated fixture", "Original fixture", 17)).resolves.toBe("saved");
    await expect(session.saveChatDraft("-42", "", "Updated fixture", 17)).resolves.toBe("saved");
    expect(remote).toBeNull();
    remote = { ...plain("Reply fixture"), reply_to: { "@type": "inputMessageReplyToMessage", message_id: 22 } };
    await expect(session.saveChatDraft("-42", "Overwrite", null, 17)).resolves.toBe("unsupported");
    await expect(session.saveChatDraft("-42", "Wrong topic", null, 18)).resolves.toBe("unsupported");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setChatDraftMessage")).toEqual(
      [plain("Updated fixture"), null].map((draft_message) => [{ "@type": "setChatDraftMessage", chat_id: -42,
        topic_id: { "@type": "messageTopicForum", forum_topic_id: 17 }, draft_message }]),
    );
  } finally { await session.close(); }
});

test("adds a fresh Telegram recommendation with its original folder rules exactly once", async () => {
  const name = { "@type": "chatFolderName", text: { "@type": "formattedText", text: "Fixture" } };
  const folder = { "@type": "chatFolder", name, include_groups: true, exclude_muted: true, color_id: 4 };
  let description = "Fixture recommendation";
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getRecommendedChatFolders": return { "@type": "recommendedChatFolders", chat_folders: [
        { "@type": "recommendedChatFolder", folder, description },
      ] };
      case "createChatFolder": return { "@type": "chatFolderInfo", id: 7, name };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [] });
    const first = (await session.recommendedFolders())[0]!;
    expect(first).toMatchObject({ title: "Fixture", description });
    description = "Changed fixture recommendation";
    await expect(session.addRecommendedFolder(first.token)).rejects.toThrow("no longer available");
    const current = (await session.recommendedFolders())[0]!;
    await expect(session.addRecommendedFolder(current.token)).resolves.toEqual({ id: 7, title: "Fixture" });
    await expect(session.recommendedFolders()).resolves.toEqual([]);
    await expect(session.addRecommendedFolder(current.token)).rejects.toThrow("no longer available");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "createChatFolder")).toEqual([
      [{ "@type": "createChatFolder", folder }],
    ]);
  } finally { await session.close(); }
});

test("reorders the current folder permutation and preserves the position of All Chats", async () => {
  const { session, request, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "reorderChatFolders") return { "@type": "ok" };
    throw new Error("Unexpected test query");
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", main_chat_list_position: 1, chat_folders: [7, 8, 9].map((id) =>
      ({ "@type": "chatFolderInfo", id, name: { "@type": "chatFolderName",
        text: { "@type": "formattedText", text: `Fixture ${id}` } } })) });
    await expect(session.reorderFolders([9, 8, 7], [8, 9, 7])).resolves.toBe("changed");
    await expect(session.reorderFolders([9, 9, 7], [7, 8, 9])).resolves.toBe("unavailable");
    await expect(session.reorderFolders([9, 8, 7], [7, 8, 9])).resolves.toBe("saved");
    expect(session.folders().map(({ id }) => id)).toEqual([9, 8, 7]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "reorderChatFolders")).toEqual([
      [{ "@type": "reorderChatFolders", chat_folder_ids: [9, 8, 7], main_chat_list_position: 1 }],
    ]);
  } finally { await session.close(); }
});

test("reads folder colors only when tags are enabled and changes them only for Premium accounts", async () => {
  const name = { "@type": "chatFolderName", text: { "@type": "formattedText", text: "Fixture" } };
  let premium = false;
  let folder: TdObject = { "@type": "chatFolder", name, color_id: 4, included_chat_ids: [42] };
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42, is_premium: premium };
      case "getChatFolder": return folder;
      case "editChatFolder":
        folder = query.folder as TdObject;
        return { "@type": "chatFolderInfo", id: 7, name: folder.name, color_id: folder.color_id };
      default: throw new Error("Unexpected test query");
    }
  });
  const tags = (enabled: boolean) => update({ "@type": "updateChatFolders", are_tags_enabled: enabled,
    chat_folders: [{ "@type": "chatFolderInfo", id: 7, name, color_id: 4 }] });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    tags(false);
    expect(session.folders()[0]?.color).toBeUndefined();
    tags(true);
    expect(session.folders()[0]?.color).toBe(4);
    await expect(session.saveFolder({ title: "Fixture", rules: [], color: 2 }, 7)).rejects.toThrow("color cannot be changed");
    premium = true;
    await expect(session.folderEditor(7)).resolves.toMatchObject({ color: 4, canEditColor: true });
    await expect(session.saveFolder({ title: "Fixture", rules: [], color: 2 }, 7)).resolves.toMatchObject({ color: 2 });
    expect(folder).toMatchObject({ color_id: 2, included_chat_ids: [42] });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editChatFolder")).toHaveLength(1);
  } finally { await session.close(); }
});

test("keeps folder rules and custom icons on unrelated edits and can restore the automatic icon", async () => {
  const name = { "@type": "chatFolderName", text: { "@type": "formattedText", text: "Fixture" } };
  const icon = { "@type": "chatFolderIcon", name: "Work" };
  let folder: TdObject = { "@type": "chatFolder", name, icon, included_chat_ids: [42] };
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolder": return folder;
      case "editChatFolder":
        folder = query.folder as TdObject;
        return { "@type": "chatFolderInfo", id: 7, name: folder.name,
          icon: folder.icon ?? { "@type": "chatFolderIcon", name: "Custom" } };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name, icon }] });
    expect(session.folders()[0]?.icon).toBe("Work");
    await expect(session.folderEditor(7)).resolves.toMatchObject({ icon: "Work" });
    await expect(session.saveFolder({ title: "Fixture", rules: ["include_groups"] }, 7)).resolves.toMatchObject({ icon: "Work" });
    await expect(session.saveFolder({ title: "Fixture", rules: ["include_groups"], icon: "Cat" }, 7)).resolves.toMatchObject({ icon: "Cat" });
    await expect(session.saveFolder({ title: "Fixture", rules: ["include_groups"], icon: null }, 7)).resolves.toMatchObject({ icon: "Custom" });
    expect(folder).toMatchObject({ icon: null, include_groups: true, included_chat_ids: [42] });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editChatFolder")
      .map(([query]) => (query.folder as TdObject).icon)).toEqual([icon, { "@type": "chatFolderIcon", name: "Cat" }, null]);
  } finally { await session.close(); }
});

test("changes the account folder-tag setting only with Premium and a current expected state", async () => {
  let premium = false;
  const folder = { "@type": "chatFolderInfo", id: 7, name: "Fixture", color_id: 4 };
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 42, is_premium: premium };
      case "toggleChatFolderTags":
        update({ "@type": "updateChatFolders", chat_folders: [folder], are_tags_enabled: query.are_tags_enabled });
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [folder], are_tags_enabled: false });
    await expect(session.folderTags()).resolves.toEqual({ enabled: false, editable: false });
    await expect(session.setFolderTags(true, false)).resolves.toBe("unavailable");
    premium = true;
    await expect(session.setFolderTags(false, true)).resolves.toBe("changed");
    await expect(session.setFolderTags(true, false)).resolves.toBe("saved");
    expect(session.folders()[0]?.color).toBe(4);
    await expect(session.folderTags()).resolves.toEqual({ enabled: true, editable: true });
    await expect(session.setFolderTags(false, true)).resolves.toBe("saved");
    expect(session.folders()[0]?.color).toBeUndefined();
    expect(request.mock.calls.filter(([query]) => query["@type"] === "toggleChatFolderTags")).toEqual([
      [{ "@type": "toggleChatFolderTags", are_tags_enabled: true }],
      [{ "@type": "toggleChatFolderTags", are_tags_enabled: false }],
    ]);
  } finally { await session.close(); }
});

test("previews a shared folder and imports only the explicitly selected chats from the current invitation", async () => {
  const url = "https://t.me/addlist/fixture";
  let title = "Fixture folder";
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "checkChatFolderInviteLink": return { "@type": "chatFolderInviteLinkInfo",
        chat_folder_info: { "@type": "chatFolderInfo", id: 0, name: title },
        missing_chat_ids: [-42, -43, -44], added_chat_ids: [-44, -44] };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: `Fixture ${query.chat_id}` };
      case "addChatFolderByInviteLink": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [] });
    await expect(session.previewFolderInvite("https://example.org/addlist/fixture")).resolves.toBeNull();
    const first = (await session.previewFolderInvite(url))!;
    expect(first).toMatchObject({ title, alreadyAdded: 1, chats: [{ id: "-42", title: "Fixture -42" }, { id: "-43", title: "Fixture -43" }] });
    await expect(session.importFolderInvite(url, first.token, ["-44"])).resolves.toBe("unavailable");
    title = "Updated";
    await expect(session.importFolderInvite(url, first.token, ["-43"])).resolves.toBe("changed");
    const current = (await session.previewFolderInvite(url))!;
    await expect(session.importFolderInvite(url, current.token, ["-43"])).resolves.toBe("added");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "addChatFolderByInviteLink")).toEqual([
      [{ "@type": "addChatFolderByInviteLink", invite_link: url, chat_ids: [-43] }],
    ]);
  } finally { await session.close(); }
});

test("lists own folder links and revokes only a current link for the chosen folder", async () => {
  const url = "https://t.me/addlist/fixture";
  let name = "Fixture invite";
  let active = true;
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolderInviteLinks": return { "@type": "chatFolderInviteLinks", invite_links: active ? [
        { "@type": "chatFolderInviteLink", invite_link: url, name, chat_ids: [-42, -43] },
        { "@type": "chatFolderInviteLink", invite_link: "https://example.org/addlist/fixture", name: "", chat_ids: [-43] },
      ] : [] };
      case "editChatFolderInviteLink":
        name = String(query.name);
        return { "@type": "chatFolderInviteLink", invite_link: url, name, chat_ids: query.chat_ids };
      case "deleteChatFolderInviteLink": active = false; return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name: "Fixture" }] });
    await expect(session.folderInviteLinks(7)).resolves.toEqual([{ url, name, chatCount: 2 }]);
    await expect(session.revokeFolderInvite(8, url, name)).resolves.toBe(false);
    await expect(session.renameFolderInvite(7, url, "Unrelated", "Ignored")).resolves.toBeNull();
    await expect(session.renameFolderInvite(7, url, name, "Renamed fixture invite"))
      .resolves.toEqual({ url, name: "Renamed fixture invite", chatCount: 2 });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editChatFolderInviteLink")).toEqual([
      [{ "@type": "editChatFolderInviteLink", chat_folder_id: 7, invite_link: url, name: "Renamed fixture invite", chat_ids: [-42, -43] }],
    ]);
    await expect(session.revokeFolderInvite(7, url, "Fixture invite")).resolves.toBe(false);
    await expect(session.revokeFolderInvite(7, url, name)).resolves.toBe(true);
    await expect(session.folderInviteLinks(7)).resolves.toEqual([]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "deleteChatFolderInviteLink")).toEqual([
      [{ "@type": "deleteChatFolderInviteLink", chat_folder_id: 7, invite_link: url }],
    ]);
  } finally { await session.close(); }
});

test("creates a folder invitation only for explicitly selected currently shareable chats", async () => {
  const url = "https://t.me/addlist/fixture";
  let rules = true;
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolder": return { "@type": "chatFolder", include_groups: rules };
      case "getChatsForChatFolderInviteLink": return { "@type": "chats", chat_ids: [-42, -43, 44] };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: `Fixture ${query.chat_id}`,
        type: { "@type": query.chat_id === -42 ? "chatTypeBasicGroup" : "chatTypeSupergroup" } };
      case "createChatFolderInviteLink": return { "@type": "chatFolderInviteLink", invite_link: url,
        name: query.name, chat_ids: query.chat_ids };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name: "Fixture" }] });
    await expect(session.folderShareChats(7)).resolves.toBeNull();
    rules = false;
    await expect(session.folderShareChats(7)).resolves.toEqual([
      { id: "-42", title: "Fixture -42", upgradesGroup: true },
      { id: "-43", title: "Fixture -43", upgradesGroup: false },
    ]);
    await expect(session.createFolderInvite(7, "Fixture", ["44"])).resolves.toBeNull();
    await expect(session.createFolderInvite(7, "Fixture", ["-43"])).resolves.toEqual({ url, name: "Fixture", chatCount: 1 });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "createChatFolderInviteLink")).toEqual([
      [{ "@type": "createChatFolderInviteLink", chat_folder_id: 7, name: "Fixture", chat_ids: [-43] }],
    ]);
  } finally { await session.close(); }
});

test("edits the chats on an existing folder link only against the current invitation", async () => {
  const url = "https://t.me/addlist/fixture";
  const name = "Fixture link";
  let linkedChats = [-42];
  const link = () => ({ "@type": "chatFolderInviteLink", invite_link: url, name, chat_ids: linkedChats });
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolder": return { "@type": "chatFolder" };
      case "getChatsForChatFolderInviteLink": return { "@type": "chats", chat_ids: [-42, -43] };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: `Fixture ${query.chat_id}`,
        type: { "@type": "chatTypeSupergroup" } };
      case "getChatFolderInviteLinks": return { "@type": "chatFolderInviteLinks", invite_links: [link()] };
      case "editChatFolderInviteLink": linkedChats = query.chat_ids as number[]; return link();
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [{ "@type": "chatFolderInfo", id: 7, name: "Fixture" }] });
    const first = (await session.folderInviteEditor(7, url))!;
    expect(first.selected).toEqual(["-42"]);
    await expect(session.saveFolderInviteChats(7, url, first.token, ["-99"])).resolves.toBeNull();
    linkedChats = [-43];
    await expect(session.saveFolderInviteChats(7, url, first.token, ["-42"])).resolves.toBeNull();
    const current = (await session.folderInviteEditor(7, url))!;
    await expect(session.saveFolderInviteChats(7, url, current.token, ["-42", "-43"]))
      .resolves.toEqual({ url, name, chatCount: 2 });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editChatFolderInviteLink")).toEqual([
      [{ "@type": "editChatFolderInviteLink", chat_folder_id: 7, invite_link: url, name, chat_ids: [-42, -43] }],
    ]);
  } finally { await session.close(); }
});

test("checks shared-folder updates once per Telegram interval and applies only a reviewed selection", async () => {
  const { session, request, update } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChatFolder": return { "@type": "chatFolder", name: "Fixture", is_shareable: true };
      case "getOption": return { "@type": "optionValueInteger", value: "60" };
      case "getChatFolderNewChats": return { "@type": "chats", chat_ids: [-42, -43] };
      case "getChat": return { "@type": "chat", id: query.chat_id, title: `Fixture ${query.chat_id}` };
      case "processChatFolderNewChats": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    update({ "@type": "updateChatFolders", chat_folders: [7, 8].map((id) => ({ "@type": "chatFolderInfo", id, name: "Fixture" })) });
    const [preview, cached] = await Promise.all([session.newFolderChats(7), session.newFolderChats(7)]);
    expect(preview?.chats.map(({ id }) => id)).toEqual(["-42", "-43"]);
    expect(cached).toEqual(preview);
    await expect(session.processFolderUpdates(7, preview!.token, ["-44"])).resolves.toBe(false);
    await expect(session.processFolderUpdates(7, preview!.token, ["-43"])).resolves.toBe(true);
    await expect(session.processFolderUpdates(7, preview!.token, ["-43"])).resolves.toBe(false);
    expect((await session.newFolderChats(7))?.chats).toEqual([]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getChatFolderNewChats")).toHaveLength(1);
    const other = (await session.newFolderChats(8))!;
    await expect(session.processFolderUpdates(8, preview!.token, [])).resolves.toBe(false);
    await expect(session.processFolderUpdates(8, other.token, [])).resolves.toBe(true);
    await expect(session.processFolderUpdates(8, other.token, [])).resolves.toBe(false);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "processChatFolderNewChats")).toEqual([
      [{ "@type": "processChatFolderNewChats", chat_folder_id: 7, added_chat_ids: [-43] }],
      [{ "@type": "processChatFolderNewChats", chat_folder_id: 8, added_chat_ids: [] }],
    ]);
  } finally { await session.close(); }
});

test("changes notification defaults for one scope while preserving its current mute duration and sound", async () => {
  const notifications = { "@type": "scopeNotificationSettings", mute_for: 3600, show_preview: true,
    sound_id: "42", mute_stories: true, disable_pinned_message_notifications: false, disable_mention_notifications: true };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getScopeNotificationSettings": return notifications;
      case "getSavedNotificationSounds": return { "@type": "notificationSounds",
        notification_sounds: [{ "@type": "notificationSound", id: "9223372036854775807", title: "Fixture ringtone" }] };
      case "setScopeNotificationSettings": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const { savedSounds, ...original } = await session.scopeNotifications("groups");
    expect(original).toEqual({ muted: true, preview: true, pinned: true, mentions: false, sound: "42" });
    expect(savedSounds).toEqual([{ id: "9223372036854775807", title: "Fixture ringtone" }]);
    await expect(session.saveScopeNotifications("groups", { ...original, preview: false }, { ...original, muted: false })).resolves.toBe("changed");
    await expect(session.saveScopeNotifications("groups", { ...original, preview: false }, original)).resolves.toBe("saved");
    await expect(session.saveScopeNotifications("groups", { ...original, sound: "77" }, original)).resolves.toBe("unavailable");
    await expect(session.saveScopeNotifications("groups", { ...original, sound: "0" }, { ...original, sound: "-1" })).resolves.toBe("changed");
    await expect(session.saveScopeNotifications("groups", { ...original, sound: "9223372036854775807" }, original)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setScopeNotificationSettings")).toEqual([
      [{ "@type": "setScopeNotificationSettings", scope: { "@type": "notificationSettingsScopeGroupChats" },
        notification_settings: { ...notifications, show_preview: false } }],
      [{ "@type": "setScopeNotificationSettings", scope: { "@type": "notificationSettingsScopeGroupChats" },
        notification_settings: { ...notifications, sound_id: "9223372036854775807" } }],
    ]);
  } finally { await session.close(); }
});

test("reads reaction notification updates and preserves the Telegram sound on edits", async () => {
  const settings = { "@type": "reactionNotificationSettings",
    message_reaction_source: { "@type": "reactionNotificationSourceAll" },
    story_reaction_source: { "@type": "reactionNotificationSourceContacts" },
    poll_vote_source: { "@type": "reactionNotificationSourceNone" }, sound_id: "123", show_preview: true };
  const { session, request, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getSavedNotificationSounds") return { "@type": "notificationSounds",
      notification_sounds: [{ "@type": "notificationSound", id: "9223372036854775807", title: "Fixture ringtone" }] };
    if (query["@type"] === "setReactionNotificationSettings") return { "@type": "ok" };
    throw new Error("Unexpected test query");
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.reactionNotifications()).resolves.toBeNull();
    update({ "@type": "updateReactionNotificationSettings", notification_settings: settings });
    const { savedSounds, ...old } = (await session.reactionNotifications())!;
    expect(old).toEqual({ messages: "all", stories: "contacts", votes: "none", preview: true, sound: "123" });
    expect(savedSounds).toEqual([{ id: "9223372036854775807", title: "Fixture ringtone" }]);
    await expect(session.saveReactionNotifications({ ...old, messages: "none" }, { ...old, preview: false })).resolves.toBe("changed");
    await expect(session.saveReactionNotifications({ ...old, messages: "none", votes: "contacts" }, old)).resolves.toBe("saved");
    await expect(session.saveReactionNotifications({ ...old, sound: "99" }, old)).resolves.toBe("unavailable");
    await expect(session.saveReactionNotifications({ ...old, sound: "0" }, { ...old, sound: "-1" })).resolves.toBe("changed");
    await expect(session.saveReactionNotifications({ ...old, sound: "9223372036854775807" }, old)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setReactionNotificationSettings")).toEqual([
      [{ "@type": "setReactionNotificationSettings", notification_settings: { ...settings,
        message_reaction_source: { "@type": "reactionNotificationSourceNone" },
        poll_vote_source: { "@type": "reactionNotificationSourceContacts" } } }],
      [{ "@type": "setReactionNotificationSettings", notification_settings: { ...settings, sound_id: "9223372036854775807" } }],
    ]);
  } finally { await session.close(); }
});

test("updates forum notifications only on the verified topic and preserves its other settings", async () => {
  let settings: TdObject = {
    "@type": "chatNotificationSettings", use_default_mute_for: true, mute_for: 0,
    use_default_show_preview: true, show_preview: true, sound_id: "456",
    use_default_mute_stories: true, mute_stories: false,
  };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getForumTopic": return { "@type": "forumTopic",
        info: { "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17 },
        notification_settings: settings };
      case "setForumTopicNotificationSettings":
        settings = query.notification_settings as TdObject;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.chatNotificationState("-42", 17)).resolves.toEqual({ mode: "default", preview: "default" });
    await expect(session.setChatNotificationMode("-42", "muted", 3600, 18)).resolves.toBe("refused");
    await expect(session.setChatNotificationOverride("-42", "stories", "hide", "default", 17)).resolves.toBe("refused");
    await expect(session.setChatNotificationMode("-42", "muted", 3600, 17)).resolves.toBe("updated");
    await expect(session.chatNotificationState("-42", 17)).resolves.toMatchObject({ mode: "muted", muteUntil: expect.any(Number) });
    await expect(session.setChatNotificationOverride("-42", "preview", "hide", "default", 17)).resolves.toBe("updated");
    expect(settings).toMatchObject({ mute_for: 3600, sound_id: "456", use_default_show_preview: false, show_preview: false });
    const writes = request.mock.calls.map(([query]) => query).filter((query) => String(query["@type"]).startsWith("set"));
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write).toMatchObject({
      "@type": "setForumTopicNotificationSettings", chat_id: -42, forum_topic_id: 17,
    });
  } finally { await session.close(); }
});

test("selects a saved forum sound without rounding its Telegram identifier or changing the mute", async () => {
  const id = "9223372036854775807";
  let settings: TdObject = { "@type": "chatNotificationSettings", use_default_sound: true, sound_id: "-1",
    use_default_mute_for: false, mute_for: 3600 };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getSavedNotificationSounds": return { "@type": "notificationSounds", notification_sounds: [
        { "@type": "notificationSound", id, title: "Fixture ringtone" },
      ] };
      case "getForumTopic": return { "@type": "forumTopic", notification_settings: settings,
        info: { "@type": "forumTopicInfo", chat_id: -42, forum_topic_id: 17 } };
      case "setForumTopicNotificationSettings":
        settings = query.notification_settings as TdObject;
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.chatNotificationState("-42", 17)).resolves.toMatchObject({
      sound: "inherit", savedSounds: [{ id, title: "Fixture ringtone" }],
    });
    await expect(session.setChatNotificationSound("-42", "42", "inherit", 17)).resolves.toBe("refused");
    await expect(session.setChatNotificationSound("-42", "0", "-1", 17)).resolves.toBe("refused");
    await expect(session.setChatNotificationSound("-42", id, "inherit", 17)).resolves.toBe("updated");
    expect(request).toHaveBeenCalledWith({
      "@type": "setForumTopicNotificationSettings", chat_id: -42, forum_topic_id: 17,
      notification_settings: { "@type": "chatNotificationSettings", use_default_sound: false, sound_id: id,
        use_default_mute_for: false, mute_for: 3600 },
    });
    await expect(session.setChatNotificationSound("-42", "0", id, 17)).resolves.toBe("updated");
    await expect(session.setChatNotificationSound("-42", "-1", "0", 17)).resolves.toBe("updated");
    await expect(session.setChatNotificationSound("-42", "inherit", "-1", 17)).resolves.toBe("updated");
  } finally { await session.close(); }
});

test("changes private story defaults independently of message notifications", async () => {
  const settings = { "@type": "scopeNotificationSettings", mute_for: 3600, sound_id: "12", show_preview: false,
    disable_pinned_message_notifications: true, disable_mention_notifications: false,
    use_default_mute_stories: true, mute_stories: false, show_story_poster: true, story_sound_id: "-1" };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getScopeNotificationSettings": return settings;
      case "getSavedNotificationSounds": return { "@type": "notificationSounds", notification_sounds: [] };
      case "setScopeNotificationSettings": return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const original = await session.scopeNotifications("private");
    expect(original.stories).toEqual({ audience: "frequent", showAuthor: true, sound: "-1" });
    expect((await session.scopeNotifications("groups")).stories).toBeUndefined();
    const values = { ...original, stories: { audience: "none" as const, showAuthor: false, sound: "0" } };
    await expect(session.saveScopeNotifications("groups", values, original)).resolves.toBe("unavailable");
    await expect(session.saveScopeNotifications("private", values,
      { ...original, stories: { ...original.stories!, audience: "all" } })).resolves.toBe("changed");
    await expect(session.saveScopeNotifications("private", values, original)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "setScopeNotificationSettings")).toEqual([
      [{ "@type": "setScopeNotificationSettings", scope: { "@type": "notificationSettingsScopePrivateChats" },
        notification_settings: { ...settings, use_default_mute_stories: false, mute_stories: true,
          show_story_poster: false, story_sound_id: "0" } }],
    ]);
  } finally { await session.close(); }
});

test("saves an MP3 by staged file and removes only a verified saved sound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-sound-test-"));
  const id = "9223372036854775807";
  const sound = { "@type": "notificationSound", id, title: "Fixture ringtone" };
  let stagedPath = "";
  let sounds: TdObject[] = [];
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getSavedNotificationSounds": return { "@type": "notificationSounds", notification_sounds: sounds };
      case "addSavedNotificationSound":
        stagedPath = String((query.sound as TdObject).path);
        sounds = [sound];
        return sound;
      case "removeSavedNotificationSound":
        sounds = sounds.filter((entry) => entry.id !== query.notification_sound_id);
        return { "@type": "ok" };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, directory);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.addNotificationSound(Buffer.from("Fixture text").toString("base64"))).resolves.toBe("unavailable");
    await expect(session.removeNotificationSound(id)).resolves.toBe("unavailable");
    await expect(session.addNotificationSound(Buffer.from("ID3\x04\0\0\0\0\0\0").toString("base64"))).resolves.toBe("saved");
    expect(stagedPath).toMatch(/\/notification\.mp3$/);
    await expect(readFile(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.savedNotificationSounds()).resolves.toEqual([{ id, title: "Fixture ringtone" }]);
    await expect(session.removeNotificationSound(id)).resolves.toBe("saved");
    await expect(session.savedNotificationSounds()).resolves.toEqual([]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "removeSavedNotificationSound")).toEqual([
      [{ "@type": "removeSavedNotificationSound", notification_sound_id: id }],
    ]);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("previews only the requested saved notification sound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-sound-preview-"));
  const path = join(directory, "test.ogg");
  const id = "9223372036854775807";
  const bytes = Buffer.from("OggS fixture bytes");
  let resolvedId = id;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getSavedNotificationSound": return { "@type": "notificationSound", id: resolvedId,
        sound: { "@type": "file", id: 7, size: bytes.length } };
      case "downloadFile": return { "@type": "file", id: 7, local: { "@type": "localFile", path, is_downloading_completed: true } };
      default: throw new Error("Unexpected test query");
    }
  }, undefined, directory);
  try {
    await writeFile(path, bytes);
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.previewNotificationSound(id)).resolves.toEqual({ mime: "audio/ogg", base64: bytes.toString("base64") });
    expect(request).toHaveBeenCalledWith({ "@type": "getSavedNotificationSound", notification_sound_id: id });
    resolvedId = "42";
    await expect(session.previewNotificationSound(id)).rejects.toThrow("Saved sound is unavailable.");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "downloadFile")).toHaveLength(1);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes fresh incoming TDLib notifications without leaking hidden previews", async () => {
  const notify = vi.fn();
  const { session, request, update } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "setOption") return { "@type": "ok" };
    throw new Error("Unexpected test query");
  }, undefined, undefined, undefined, undefined, undefined, notify);
  const date = Math.floor(Date.now() / 1000);
  const event = (id: number, options: { preview?: boolean; outgoing?: boolean; date?: number; chat?: number } = {}) => ({
    "@type": "updateNotificationGroup", notification_group_id: 9, chat_id: 42,
    added_notifications: [{ "@type": "notification", id, date: options.date ?? Math.floor(Date.now() / 1000),
      type: { "@type": "notificationTypeNewMessage", show_preview: options.preview,
        message: { "@type": "message", id: 100, is_outgoing: options.outgoing ?? false, date, chat_id: options.chat ?? 42,
          content: { "@type": "messageText", text: { "@type": "formattedText", text: "Hello secret",
            entities: [{ "@type": "textEntity", offset: 6, length: 6, type: { "@type": "textEntityTypeSpoiler" } }] } } } } }],
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    expect(request).toHaveBeenCalledWith({ "@type": "setOption", name: "notification_group_count_max",
      value: { "@type": "optionValueInteger", value: "20" } });
    update(event(1, { date: date - 100 }));
    update(event(2, { outgoing: true }));
    update(event(3, { chat: 43 }));
    update(event(4));
    update(event(4));
    update(event(5, { preview: true }));
    expect(notify.mock.calls).toEqual([
      [{ chatId: "42", key: "9:4", messageId: "100" }],
      [{ chatId: "42", key: "9:5", messageId: "100", preview: "Hello [Spoiler]" }],
    ]);
  } finally { await session.close(); }
});

test("searches public stickers by keyword or emoji and refuses to send a file outside the returned results", async () => {
  const { session, request } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "searchStickers") return { "@type": "stickers", stickers: [
      { "@type": "sticker", emoji: "🐈", sticker: { "@type": "file", id: 123 } },
    ] };
    throw new Error("Unexpected fixture query");
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.mediaChoices("sticker", "cat")).resolves.toEqual([{ id: 123, label: "🐈" }]);
    await expect(session.mediaChoices("sticker", "🐈")).resolves.toEqual([{ id: 123, label: "🐈" }]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "searchStickers", query: "cat", emojis: "", limit: 20 }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "searchStickers", query: "", emojis: "🐈", limit: 20 }));
    await expect(session.sendMediaChoice("42", "sticker", 124, "cat")).resolves.toEqual({ state: "failed" });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ "@type": "sendMessage" }));
  } finally { await session.close(); }
});

test("sends a GIF search result only once and only to its original chat", async () => {
  const at = Math.floor(Date.now() / 1000) + 600;
  const topic = { id: 17, name: "Fixture topic" };
  const topicRef = { "@type": "messageTopicForum", forum_topic_id: 17 };
  const queryId = "-9223372036854775808";
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getOption": return { "@type": "optionValueString", value: "fixturegifbot" };
      case "searchPublicChat": return { "@type": "chat", id: 65, type: { "@type": "chatTypePrivate", user_id: 65 } };
      case "getUser": return { "@type": "user", id: 65, type: { "@type": "userTypeBot", is_inline: true } };
      case "getInlineQueryResults": return { "@type": "inlineQueryResults", inline_query_id: queryId, results: [
        { "@type": "inlineQueryResultArticle", id: "ignored" },
        { "@type": "inlineQueryResultAnimation", id: "fixture-result", animation: { "@type": "animation", file_name: "fixture.gif" } },
      ] };
      case "getForumTopic": return { "@type": "forumTopic", info: { "@type": "forumTopicInfo",
        chat_id: 42, forum_topic_id: topic.id, name: topic.name } };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getMessage": return { "@type": "message", id: 99, chat_id: 42, topic_id: topicRef,
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "Fixture quoted text", entities: [] } } };
      case "sendInlineQueryResultMessage":
        return { "@type": "message", id: 101, chat_id: 42, is_outgoing: true, date: 1700000000, ...(query.topic_id ? { topic_id: query.topic_id } : {}),
          ...(query.options ? { scheduling_state: (query.options as TdObject).scheduling_state } : {}),
          ...(query.reply_to ? { reply_to_message_id: (query.reply_to as TdObject).message_id } : {}),
          content: { "@type": "messageAnimation", animation: { "@type": "animation" } } };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const hits = await session.searchGifs("42", "fixture");
    expect(hits).toEqual([{ id: 2, label: "fixture.gif", gifToken: expect.any(String) }]);
    expect(request).toHaveBeenCalledWith({ "@type": "getInlineQueryResults", bot_user_id: 65, chat_id: 42, query: "fixture", offset: "" });
    const token = hits[0]!.gifToken;
    await expect(session.sendFoundGif("43", token)).resolves.toEqual({ state: "failed" });
    await expect(session.sendFoundGif("42", token)).resolves.toMatchObject({ state: "sent" });
    await expect(session.sendFoundGif("42", token)).resolves.toEqual({ state: "failed" });
    const topicToken = (await session.searchGifs("42", "fixture", topic))[0]!.gifToken;
    await expect(session.sendFoundGif("42", topicToken)).resolves.toEqual({ state: "failed" });
    await expect(session.sendFoundGif("42", topicToken, { id: 18, name: "Other topic" })).resolves.toEqual({ state: "failed" });
    const reply = { messageId: "99", quote: { text: "quoted", position: 8 } };
    const staleToken = (await session.searchGifs("42", "fixture", topic))[0]!.gifToken;
    await expect(session.sendFoundGif("42", staleToken, topic, { messageId: "99", quote: { text: "stale", position: 8 } }))
      .resolves.toEqual({ state: "failed" });
    await expect(session.sendFoundGif("42", topicToken, topic, reply, { silent: true, at })).resolves.toMatchObject({
      state: "sent", message: { forumTopicId: topic.id, replyTo: "99" },
    });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendInlineQueryResultMessage")).toEqual([
      [{ "@type": "sendInlineQueryResultMessage", chat_id: 42, query_id: queryId, result_id: "fixture-result", hide_via_bot: false }],
      [{ "@type": "sendInlineQueryResultMessage", chat_id: 42, topic_id: topicRef,
        reply_to: { "@type": "inputMessageReplyToMessage", message_id: 99, quote: {
          "@type": "inputTextQuote", position: 8, rich_texts: [], text: { "@type": "formattedText", text: "quoted", entities: [] },
        } }, options: { "@type": "messageSendOptions", disable_notification: true,
          scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: at },
        }, query_id: queryId, result_id: "fixture-result", hide_via_bot: false }],
    ]);
  } finally { await session.close(); }
});

test("updates saved GIFs from a shareable message and refuses protected copies", async () => {
  let saved = false;
  let protectedChat = false;
  const file = { "@type": "file", id: 70, remote: { "@type": "remoteFile", unique_id: "fixture-gif" } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, has_protected_content: protectedChat };
      case "getMessage": return { "@type": "message", chat_id: 42, id: 101,
        content: { "@type": "messageAnimation", animation: { "@type": "animation", animation: file } } };
      case "getSavedAnimations": return { "@type": "animations", animations: saved ? [
        { "@type": "animation", animation: { ...file, id: 71 } },
      ] : [] };
      case "addSavedAnimation": saved = true; return { "@type": "ok" };
      case "removeSavedAnimation": saved = false; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.mediaCollectionState("42", "101", "gif")).resolves.toBe(false);
    await expect(session.setMediaCollection("42", "101", "gif", true, false)).resolves.toBe("saved");
    await expect(session.mediaCollectionState("42", "101", "gif")).resolves.toBe(true);
    await expect(session.setMediaCollection("42", "101", "gif", true, false)).resolves.toBe("changed");
    protectedChat = true;
    await expect(session.setMediaCollection("42", "101", "gif", false, true)).resolves.toBe("unavailable");
    protectedChat = false;
    await expect(session.setMediaCollection("42", "101", "gif", false, true)).resolves.toBe("saved");
    expect(request.mock.calls.filter(([query]) => ["addSavedAnimation", "removeSavedAnimation"].includes(query["@type"]))).toEqual([
      [{ "@type": "addSavedAnimation", animation: { "@type": "inputFileId", id: 70 } }],
      [{ "@type": "removeSavedAnimation", animation: { "@type": "inputFileId", id: 70 } }],
    ]);
  } finally { await session.close(); }
});

test("paginates an installed sticker pack and refuses an uninstalled or unrelated sticker", async () => {
  const id = "9223372036854775807";
  const pack = { id, title: "Fixture pack", is_installed: true, is_archived: false, sticker_type: { "@type": "stickerTypeRegular" } };
  let installed = true;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getInstalledStickerSets": return { "@type": "stickerSets", sets: installed ? [{ "@type": "stickerSetInfo", ...pack }] : [] };
      case "getStickerSet": return { "@type": "stickerSet", ...pack,
        stickers: Array.from({ length: 21 }, (_, index) => ({
          "@type": "sticker", emoji: "🐱", sticker: { "@type": "file", id: index + 1 },
        })) };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.installedStickerPacks()).resolves.toEqual([{ id, title: "Fixture pack" }]);
    const page = await session.stickerPackPage(id, 0);
    expect(page.choices).toHaveLength(20);
    expect(page.next).toBe(20);
    await expect(session.stickerPackPage(id, 20)).resolves.toEqual({ choices: [{ id: 21, label: "🐱" }], next: null });
    expect(request).toHaveBeenCalledWith({ "@type": "getStickerSet", set_id: id });
    await expect(session.sendMediaChoice("42", "sticker", 999, undefined, id)).resolves.toEqual({ state: "failed" });
    installed = false;
    await expect(session.sendMediaChoice("42", "sticker", 21, undefined, id)).resolves.toEqual({ state: "failed" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "getStickerSet")).toHaveLength(3);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ "@type": "sendMessage" }));
  } finally { await session.close(); }
});

test("opens and installs the sticker pack linked by a verified message", async () => {
  const id = "9223372036854775807";
  let installed = false;
  let protectedChat = false;
  const sticker = { "@type": "sticker", set_id: id, emoji: "🐱", sticker: { "@type": "file", id: 71 } };
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, has_protected_content: protectedChat };
      case "getMessage": return { "@type": "message", chat_id: 42, id: 101,
        content: { "@type": "messageSticker", sticker } };
      case "searchStickerSet":
      case "getStickerSet": return { "@type": "stickerSet", id, name: "fixture_pack", title: "Fixture pack", is_installed: installed,
        is_archived: false, sticker_type: { "@type": "stickerTypeRegular" }, stickers: [sticker] };
      case "changeStickerSet": installed = true; return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.messageStickerPack("42", "101", 0)).resolves.toEqual({
      id, title: "Fixture pack", installed: false, link: "https://t.me/addstickers/fixture_pack", choices: [{ id: 71, label: "🐱" }], next: null,
    });
    await expect(session.linkedStickerPack("https://example.org/addstickers/fixture_pack", 0)).resolves.toBeNull();
    await expect(session.linkedStickerPack("https://t.me/addstickers/fixture_pack", 0)).resolves.toMatchObject({ id, installed: false });
    await expect(session.installLinkedStickerPack("https://t.me/addstickers/other_pack", id)).resolves.toBe("unavailable");
    await expect(session.installMessageStickerPack("42", "101", "99")).resolves.toBe("unavailable");
    protectedChat = true;
    await expect(session.installMessageStickerPack("42", "101", id)).resolves.toBe("unavailable");
    protectedChat = false;
    await expect(session.installMessageStickerPack("42", "101", id)).resolves.toBe("installed");
    await expect(session.installMessageStickerPack("42", "101", id)).resolves.toBe("installed");
    await expect(session.installLinkedStickerPack("https://t.me/addstickers/fixture_pack", id)).resolves.toBe("installed");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "changeStickerSet")).toEqual([
      [{ "@type": "changeStickerSet", set_id: id, is_installed: true, is_archived: false }],
    ]);
  } finally { await session.close(); }
});

test("reorders only the exact current list of installed regular sticker packs", async () => {
  const first = "9223372036854775807";
  const second = "9223372036854775806";
  let order = [first, second];
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getInstalledStickerSets": return { "@type": "stickerSets", sets: order.map((id) => ({
        "@type": "stickerSetInfo", id, title: "Fixture pack", is_installed: true, is_archived: false,
        sticker_type: { "@type": "stickerTypeRegular" },
      })) };
      case "reorderInstalledStickerSets":
        order = query.sticker_set_ids as string[];
        return { "@type": "ok" };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.reorderStickerPacks([second, first], [second, first])).resolves.toBe("changed");
    await expect(session.reorderStickerPacks([first, first], [first, second])).resolves.toBe("unavailable");
    await expect(session.reorderStickerPacks([second, first], [first, second])).resolves.toBe("saved");
    expect((await session.installedStickerPacks()).map(({ id }) => id)).toEqual([second, first]);
    expect(request.mock.calls.filter(([query]) => query["@type"] === "reorderInstalledStickerSets")).toEqual([
      [{ "@type": "reorderInstalledStickerSets", sticker_type: { "@type": "stickerTypeRegular" }, sticker_set_ids: [second, first] }],
    ]);
  } finally { await session.close(); }
});

test("returns scheduled media for its topic without exposing protected attachments", async () => {
  const at = Math.floor(Date.now() / 1000) + 600;
  const item = (id: number, topic: number, protectedContent: boolean) => ({
    "@type": "message", id, chat_id: -42, is_outgoing: true, has_protected_content: protectedContent,
    topic_id: { "@type": "messageTopicForum", forum_topic_id: topic },
    scheduling_state: { "@type": "messageSchedulingStateSendAtDate", send_date: at },
    content: { "@type": "messageVoiceNote", voice_note: { "@type": "voiceNote", mime_type: "audio/ogg",
      voice: { "@type": "file", id: 70, size: 7500 } } },
  });
  const { session } = harness((query) => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChatScheduledMessages") return { "@type": "messages",
      messages: [item(22, 17, false), item(23, 18, false), item(24, 17, true)] };
    throw new Error("Unexpected fixture query");
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const rows = await session.scheduledMessages("-42", 17);
    expect(rows.map(({ id }) => id)).toEqual(["22", "24"]);
    expect(rows[0]?.media).toMatchObject({ id: "22", forumTopicId: 17, voiceNote: true,
      document: { playbackMime: "audio/ogg" } });
    expect(rows[1]?.media).toBeUndefined();
  } finally { await session.close(); }
});

const videoTestBin = ["/opt/homebrew/bin", "/usr/local/bin"].find((bin) =>
  existsSync(`${bin}/ffmpeg`) && existsSync(`${bin}/ffprobe`));

test.skipIf(!videoTestBin)("normalizes a synthetic clip to a square Telegram video note", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-video-note-"));
  const clip = join(directory, "fixture.mp4");
  let output: { path: string; length: number; duration: number; width: number; height: number } | undefined;
  const { session } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getOption": return { "@type": "optionValueString", value: "1.8.99" };
      case "sendMessage": {
        const content = query.input_message_content as TdObject;
        expect(content["@type"]).toBe("inputMessageVideoNote");
        const video = content.video_note as TdObject;
        expect(video["@type"]).toBe("inputVideoNote");
        const path = String((video.video_note as TdObject).path);
        const probe = JSON.parse(execFileSync(`${videoTestBin}/ffprobe`, ["-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=width,height", "-of", "json", path], { encoding: "utf8" }));
        output = { path, length: Number(video.length), duration: Number(video.duration),
          width: probe.streams[0].width, height: probe.streams[0].height };
        return { "@type": "message", id: 7, chat_id: 42, is_outgoing: true,
          content: { "@type": "messageVideoNote" } };
      }
      default: throw new Error("Unexpected fixture query");
    }
  }, undefined, directory);
  try {
    execFileSync(`${videoTestBin}/ffmpeg`, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=15",
      "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.sendVideoNote("42", (await readFile(clip)).toString("base64"), "mp4")).resolves.toMatchObject({ state: "sent" });
    expect(output).toMatchObject({ length: 384, duration: 1, width: 384, height: 384 });
    await expect(readFile(output!.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(!videoTestBin)("extracts audio from a video note for local transcription", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-video-speech-"));
  const clip = join(directory, "clip.mp4");
  try {
    execFileSync(`${videoTestBin}/ffmpeg`, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=15",
      "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.5", "-c:v", "libx264", "-c:a", "aac", clip]);
    const audio = await videoNoteAudio(await readFile(clip));
    expect(audio.subarray(0, 4).toString()).toBe("OggS");
    expect(audio.subarray(0, 128).includes(Buffer.from("OpusHead"))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("checks the previous media caption and keeps its placement when changing or clearing it", async () => {
  let text = "Fixture caption";
  let allowed = true;
  let above = true;
  const row = () => ({ "@type": "message", id: 9, chat_id: 42, is_outgoing: true, can_be_edited: allowed,
    content: { "@type": "messageVideo", show_caption_above_media: above,
      video: { "@type": "video", mime_type: "video/mp4", video: { "@type": "file", id: 7, size: 100 } },
      caption: { "@type": "formattedText", text, entities: [] } } });
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMessage": return row();
      case "editMessageCaption":
        text = String((query.caption as TdObject).text);
        above = query.show_caption_above_media === true;
        return row();
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.editCaption("42", "9", "Next caption", "Stale caption")).resolves.toEqual({ state: "failed" });
    await expect(session.editCaption("42", "9", "Next caption", "Fixture caption")).resolves.toMatchObject({
      state: "sent", message: { editableCaption: true, captionAboveMedia: true, document: { caption: "Next caption" } },
    });
    await expect(session.editCaption("42", "9", "Next caption", "Next caption", [], undefined,
      { above: false, expected: false })).resolves.toEqual({ state: "failed" });
    const moved = await session.editCaption("42", "9", "Next caption", "Next caption", [], undefined,
      { above: false, expected: true });
    expect(moved).toMatchObject({ state: "sent", message: { canMoveCaption: true, document: { caption: "Next caption" } } });
    if (moved.state === "sent") expect(moved.message.captionAboveMedia).toBeUndefined();
    allowed = false;
    await expect(session.editCaption("42", "9", "", "Next caption")).resolves.toEqual({ state: "failed" });
    allowed = true;
    const cleared = await session.editCaption("42", "9", "", "Next caption");
    expect(cleared.state).toBe("sent");
    if (cleared.state === "sent") expect(cleared.message.document?.caption).toBeUndefined();
    expect(request.mock.calls.filter(([query]) => query["@type"] === "editMessageCaption")).toEqual([
      [{ "@type": "editMessageCaption", chat_id: 42, message_id: 9,
        caption: { "@type": "formattedText", text: "Next caption", entities: [] }, show_caption_above_media: true }],
      [{ "@type": "editMessageCaption", chat_id: 42, message_id: 9,
        caption: { "@type": "formattedText", text: "Next caption", entities: [] }, show_caption_above_media: false }],
      [{ "@type": "editMessageCaption", chat_id: 42, message_id: 9,
        caption: { "@type": "formattedText", text: "", entities: [] }, show_caption_above_media: false }],
    ]);
  } finally { await session.close(); }
});

test.skipIf(!videoTestBin)("sends an uploaded MP4 using video metadata and refuses files without a video track", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-upload-video-"));
  const clip = join(directory, "fixture.mp4");
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getOption": return { "@type": "optionValueString", value: "1.8.99" };
      case "sendMessage": return { "@type": "message", id: 7, chat_id: 42, is_outgoing: true, content: { "@type": "messageVideo" } };
      default: throw new Error("Unexpected fixture query");
    }
  }, undefined, directory);
  const send = (bytes: Buffer) => session.sendDocumentStream("42", "fixture.mp4", "Fixture caption", bytes.length,
    new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    () => true, undefined, undefined, true, { spoiler: true, captionAbove: true });
  try {
    execFileSync(`${videoTestBin}/ffmpeg`, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=15",
      "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(send(Buffer.from("Not an MP4"))).resolves.toEqual({ state: "failed" });
    await expect(send(await readFile(clip))).resolves.toMatchObject({ state: "sent" });
    const calls = request.mock.calls.filter(([query]) => query["@type"] === "sendMessage");
    expect(calls).toEqual([[expect.objectContaining({ input_message_content: {
      "@type": "inputMessageVideo", video: { "@type": "inputVideo", width: 160, height: 90, duration: 1, supports_streaming: true,
        video: { "@type": "inputFileLocal", path: expect.stringMatching(/fixture\.mp4$/) } },
      caption: { "@type": "formattedText", text: "Fixture caption", entities: [] },
      has_spoiler: true, show_caption_above_media: true,
    } })]]);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sends an animation from Saved GIFs with its spoiler and caption placement", async () => {
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getOption": return { "@type": "optionValueString", value: "1.8.99" };
      case "getSavedAnimations": return { "@type": "animations", animations: [
        { "@type": "animation", animation: { "@type": "file", id: 71 }, width: 80, height: 60, duration: 1 },
      ] };
      case "sendMessage": return { "@type": "message", id: 7, chat_id: 42, is_outgoing: true, content: { "@type": "messageAnimation" } };
      default: throw new Error("Unexpected fixture query");
    }
  });
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const options = { caption: "GIF caption fixture", spoiler: true, captionAbove: true };
    const send = (fileId: number) => session.sendMediaChoice("42", "gif", fileId,
      undefined, undefined, undefined, undefined, undefined, options);
    await expect(send(70)).resolves.toEqual({ state: "failed" });
    await expect(send(71)).resolves.toMatchObject({ state: "sent" });
    expect(request.mock.calls.filter(([query]) => query["@type"] === "sendMessage")).toEqual([[
      expect.objectContaining({ input_message_content: {
        "@type": "inputMessageAnimation",
        animation: { "@type": "inputAnimation", animation: { "@type": "inputFileId", id: 71 }, width: 80, height: 60, duration: 1 },
        caption: { "@type": "formattedText", text: options.caption, entities: [] },
        has_spoiler: true, show_caption_above_media: true,
      } }),
    ]]);
  } finally { await session.close(); }
});

test("sends all photos in one album under spoilers with one caption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-album-"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]).toString("base64");
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
      case "getOption": return { "@type": "optionValueString", value: "1.8.99" };
      case "sendMessageAlbum": return { "@type": "messages", messages: [7, 8].map((id) => ({
        "@type": "message", id, chat_id: 42, media_album_id: "99",
      })) };
      default: throw new Error("Unexpected fixture query");
    }
  }, undefined, directory);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    await expect(session.sendPhotoAlbum("42", "Album fixture", [jpeg, jpeg],
      undefined, undefined, undefined, { spoiler: true, captionAbove: true })).resolves.toBe("sent");
    const calls = request.mock.calls.filter(([query]) => query["@type"] === "sendMessageAlbum");
    expect(calls).toHaveLength(1);
    const photos = calls[0]![0].input_message_contents as TdObject[];
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({
      "@type": "inputMessagePhoto", has_spoiler: true, show_caption_above_media: true, caption: { text: "Album fixture" },
    });
    expect(photos[1]).toMatchObject({
      "@type": "inputMessagePhoto", has_spoiler: true, show_caption_above_media: true, caption: { text: "" },
    });
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exports the largest regular photo and denies protected or disappearing media", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-photo-download-"));
  const path = join(directory, "photo.jpg");
  let chatProtected = false;
  let messageProtected = false;
  let disappearing = false;
  const { session, request } = harness((query) => {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getChat": return { "@type": "chat", id: 42, has_protected_content: chatProtected };
      case "getMessage": return { "@type": "message", chat_id: 42, id: 12, can_be_saved: !messageProtected,
        ...(disappearing ? { self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" } } : {}),
        content: { "@type": "messagePhoto", photo: { "@type": "photo", sizes: [320, 2400].map((width) => ({
          "@type": "photoSize", width, height: width, photo: { "@type": "file", id: width, size: width === 2400 ? 1024 * 1024 : 1024 },
        })) } },
      };
      case "downloadFile": return { "@type": "file", id: query.file_id,
        local: { "@type": "localFile", path, is_downloading_completed: true } };
      default: throw new Error("Unexpected fixture query");
    }
  }, undefined, directory);
  try {
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const download = await session.document("42", "12");
    expect(download).toMatchObject({ name: "telegram-photo-12.jpg", size: 4 });
    expect(new Uint8Array(await new Response(download.body).arrayBuffer())).toEqual(Uint8Array.of(255, 216, 255, 217));
    expect(request.mock.calls.map(([query]) => query)).toContainEqual(expect.objectContaining({ "@type": "downloadFile", file_id: 2400 }));
    chatProtected = true;
    await expect(session.document("42", "12")).rejects.toThrow("unavailable");
    chatProtected = false;
    messageProtected = true;
    await expect(session.document("42", "12")).rejects.toThrow("unavailable");
    messageProtected = false;
    disappearing = true;
    await expect(session.document("42", "12")).rejects.toThrow("unavailable");
    expect(request.mock.calls.filter(([query]) => query["@type"] === "downloadFile")).toHaveLength(1);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
