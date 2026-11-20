import { expect, test, vi } from "vitest";
import { createOpenChatViews } from "../src/adapters/bb/open-chat-views.ts";
import type { TdObject } from "../src/adapters/bb/tdjson.ts";

test("opens a group once across views, publishes counts and closes when the last view expires", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => query["@type"] === "getChat"
    ? { "@type": "chat", id: query.chat_id, type: Number(query.chat_id) > 0 ? { "@type": "chatTypePrivate", user_id: query.chat_id }
      : { "@type": "chatTypeSupergroup", is_channel: query.chat_id === -43 } }
    : { "@type": "ok" });
  const emit = vi.fn();
  const groups = createOpenChatViews(request, () => true, emit);
  try {

    await expect(groups.set("-42", "first", true)).resolves.toBeNull();
    groups.update({ "@type": "updateChatOnlineMemberCount", chat_id: -42, online_member_count: 7 });
    groups.update({ "@type": "updateChatOnlineMemberCount", chat_id: -43, online_member_count: 20 });
    await expect(groups.set("-42", "second", true)).resolves.toBe(7);
    groups.update({ "@type": "updateChatOnlineMemberCount", chat_id: -42, online_member_count: 0 });
    expect(emit.mock.calls).toEqual([["-42", 7], ["-42", null]]);
    await groups.set("-42", "first", false);
    expect(request.mock.calls.filter(([query]) => query["@type"] !== "getChat")).toEqual([
      [{ "@type": "openChat", chat_id: -42 }],
    ]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(request.mock.calls.filter(([query]) => query["@type"] !== "getChat")).toEqual([
      [{ "@type": "openChat", chat_id: -42 }], [{ "@type": "closeChat", chat_id: -42 }],
    ]);
  } finally {
    groups.clear();
    vi.useRealTimers();
  }
});

test("opens private chats and channels without emitting group counts or read receipts", async () => {
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => query["@type"] === "getChat"
    ? { "@type": "chat", id: query.chat_id, type: Number(query.chat_id) > 0
      ? { "@type": "chatTypePrivate", user_id: query.chat_id }
      : { "@type": "chatTypeSupergroup", is_channel: true } }
    : { "@type": "ok" });
  const emit = vi.fn();
  const chats = createOpenChatViews(request, () => true, emit);
  try {
    await expect(chats.set("42", "private", true)).resolves.toBeNull();
    await expect(chats.set("-43", "channel", true)).resolves.toBeNull();
    chats.update({ "@type": "updateChatOnlineMemberCount", chat_id: -43, online_member_count: 17 });
    expect(emit).not.toHaveBeenCalled();
    await chats.set("42", "private", false);
    await chats.set("-43", "channel", false);
    expect(request.mock.calls.map(([query]) => [query["@type"], query.chat_id])).toEqual([
      ["getChat", 42], ["openChat", 42], ["getChat", -43], ["openChat", -43],
      ["closeChat", 42], ["closeChat", -43],
    ]);
  } finally { chats.clear(); }
});
