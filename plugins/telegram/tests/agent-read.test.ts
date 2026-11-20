import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import { agentFindChatsTool, agentFindTopicsTool, agentSearchMessagesTool, agentHistoryTool, registerAgentHistory, registerAgentRead } from "../src/adapters/bb/agent-read.ts";
import { createReplyTokens } from "../src/adapters/bb/reply-tokens.ts";

test("reads a dated page without a form and withholds results if access was revoked", async () => {
  let execute!: (_: { chatId: string; dateFrom: string; dateTo: string; before?: string; forumTopicId?: number }, context: Pick<PluginAgentToolContext, "signal">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentHistoryTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const historyInDateRange = vi.fn().mockResolvedValue({
    messages: [{ id: "9", date: 1794787200, author: "Fixture sender", text: "Fixture text" }], before: "9",
  });
  const permission = new AbortController();
  let state = "ready";
  const session = { status: () => ({ state }), historyInDateRange, canShareAgentHistory: async () => true };
  const enabled = vi.fn().mockResolvedValue([]);
  registerAgentHistory(bb, enabled, () => session as never, () => permission.signal);
  const run = (chatId = "-42", forumTopicId?: number) => execute({ chatId, forumTopicId, dateFrom: "2026-11-02", dateTo: "2026-11-15" },
    { signal: new AbortController().signal });
  await expect(run()).resolves.toContain("disabled");
  expect(historyInDateRange).not.toHaveBeenCalled();
  enabled.mockResolvedValue(["-42"]);
  await expect(run("-43", 17)).resolves.toContain("disabled for this Telegram conversation");
  expect(historyInDateRange).not.toHaveBeenCalled();
  expect(JSON.parse(await run("-42", 17))).toMatchObject({ messages: [{ text: "Fixture text" }], before: "9" });
  historyInDateRange.mockResolvedValueOnce({
    messages: [{ id: "10", date: 1794787200, author: "Fixture sender", text: "Synthetic transcript", voiceTranscript: "local" }], before: null,
  });
  expect(JSON.parse(await run("-42", 17))).toMatchObject({
    messages: [{ text: "Synthetic transcript", voiceTranscript: "local" }],
  });
  expect(historyInDateRange).toHaveBeenCalledWith("-42", {
    from: Date.parse("2026-11-02") / 1000, until: Date.parse("2026-11-16") / 1000,
  }, undefined, expect.any(AbortSignal), 17);
  enabled.mockResolvedValueOnce(["-42"]).mockImplementationOnce(async () => {
    state = "connecting";
    return ["-42"];
  });
  await expect(run()).resolves.toBe("Telegram history access changed. No messages were shared.");
  state = "ready";
  historyInDateRange.mockImplementationOnce(async () => {
    permission.abort();
    return { messages: [{ text: "Withheld fixture" }] };
  });
  await expect(run()).resolves.toBe("Telegram history access changed. No messages were shared.");
});

test("paginates topics only in granted groups and withholds drafts, hidden topics and revoked results", async () => {
  let execute!: (input: { chatId: string; query?: string; cursor?: string }, context: Pick<PluginAgentToolContext, "signal" | "threadId">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentFindTopicsTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const topics = [{ id: 17, name: "Fixture topic", closed: false, draft: "Private draft" },
    { id: 1, name: "Fixture hidden topic", hidden: true }];
  const nextNative = { date: 100, message: 99, topic: 17 };
  const forumTopicPage = vi.fn().mockResolvedValueOnce({ topics, next: nextNative })
    .mockResolvedValue({ topics: [], next: null });
  const session = { status: () => ({ state: "ready" }), forumTopicPage, canShareAgentHistory: async () => true };
  let granted = ["-42"];
  const controller = new AbortController();
  registerAgentHistory(bb, async () => granted, () => session as never, () => controller.signal);
  const run = (chatId: string, cursor?: string, threadId = "fixture") =>
    execute({ chatId, query: "Fixture", cursor }, { signal: controller.signal, threadId });
  await expect(run("-43")).resolves.toContain("AI access is disabled");
  expect(forumTopicPage).not.toHaveBeenCalled();
  const first = JSON.parse(await run("-42"));
  expect(first).toEqual({ topics: [{ forumTopicId: 17, name: "Fixture topic", closed: false }], next: expect.any(String) });
  expect(forumTopicPage).toHaveBeenCalledExactlyOnceWith("-42", "Fixture", undefined, expect.any(AbortSignal), true);
  await expect(run("-42", first.next, "another")).resolves.toContain("does not match");
  expect(JSON.parse(await run("-42", first.next))).toEqual({ topics: [], next: null });
  expect(forumTopicPage).toHaveBeenLastCalledWith("-42", "Fixture", nextNative, expect.any(AbortSignal), true);
  forumTopicPage.mockImplementationOnce(async () => { granted = []; return { topics, next: null }; });
  await expect(run("-42")).resolves.toContain("access changed");
});

test("message search confines its cursor to the granted chat, query, topic, dates, session and BB thread", async () => {
  type Input = { chatId: string; forumTopicId?: number; query: string; dateFrom: string; dateTo: string; cursor?: string };
  let execute!: (input: Input, context: Pick<PluginAgentToolContext, "threadId" | "signal">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentSearchMessagesTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const searchAgentMessages = vi.fn().mockResolvedValue({ messages: [], before: "50" });
  let session = { status: () => ({ state: "ready" }), searchAgentMessages, canShareAgentHistory: async () => true };
  let permission = new AbortController();
  registerAgentHistory(bb, async () => ["-42", "-43"], () => session as never, () => permission.signal);
  const input = { chatId: "-42", forumTopicId: 17, query: "Fixture", dateFrom: "2026-11-02", dateTo: "2026-11-15" };
  const run = (request: Input = input, threadId = "fixture") => execute(request, { threadId, signal: new AbortController().signal });
  await expect(run({ ...input, chatId: "-44" })).resolves.toContain("AI access is disabled");
  expect(searchAgentMessages).not.toHaveBeenCalled();
  const first = JSON.parse(await run());
  expect(first).toEqual({ messages: [], next: expect.stringMatching(/^[a-f\d-]{36}$/) });
  const subsequent = { ...input, cursor: first.next };
  for (const changed of [{ chatId: "-43" }, { forumTopicId: 18 }, { query: "Other" }, { dateTo: "2026-11-16" }]) {
    await expect(run({ ...subsequent, ...changed })).resolves.toContain("does not match");
  }
  await expect(run(subsequent, "another")).resolves.toContain("does not match");
  expect(searchAgentMessages).toHaveBeenCalledOnce();
  await run(subsequent);
  expect(searchAgentMessages).toHaveBeenLastCalledWith("-42", "Fixture", expect.any(Object), "50", 17, expect.any(AbortSignal));
  const original = session;
  session = { ...original };
  await expect(run(subsequent)).resolves.toContain("does not match");
  session = original;
  searchAgentMessages.mockImplementationOnce(async () => {
    permission.abort();
    permission = new AbortController();
    return { messages: [{ excerpt: "Fixture private result" }], before: null };
  });
  await expect(run()).resolves.toBe("Telegram history access changed. No messages were shared.");
  await expect(run(subsequent)).resolves.toContain("does not match");
  expect(searchAgentMessages).toHaveBeenCalledTimes(3);
});

test("only accepts a search cursor for its original query, thread and chat permissions", async () => {
  type Input = { query: string; dateFrom: string; dateTo: string; cursor?: string };
  let execute!: (input: Input, context: Pick<PluginAgentToolContext, "signal" | "threadId">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentFindChatsTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const rawCursor = { chatId: "-44", before: "30" };
  const findRelatedChats = vi.fn().mockResolvedValueOnce({ chats: [], next: rawCursor })
    .mockResolvedValueOnce({ chats: [], next: null });
  const session = { status: () => ({ state: "ready" }), findRelatedChats };
  let grants = ["-44"];
  const permission = new AbortController();
  registerAgentHistory(bb, async () => grants, () => session as never, () => permission.signal);
  const input = { query: "Fixture", dateFrom: "2026-11-02", dateTo: "2026-11-15" };
  const run = (request: Input, threadId = "fixture") => execute(request, { threadId, signal: new AbortController().signal });
  const { next } = JSON.parse(await run(input));
  expect(typeof next).toBe("string");
  await expect(run({ ...input, cursor: next }, "different")).resolves.toContain("does not match");
  await expect(run({ ...input, query: "Other", cursor: next })).resolves.toContain("does not match");
  grants = ["-44", "-45"];
  await expect(run({ ...input, cursor: next })).resolves.toContain("does not match");
  expect(findRelatedChats).toHaveBeenCalledOnce();
  grants = ["-44"];
  expect(JSON.parse(await run({ ...input, cursor: next }))).toEqual({ chats: [], next: null });
  expect(findRelatedChats).toHaveBeenLastCalledWith("Fixture", expect.any(Object), ["-44"], rawCursor, expect.any(AbortSignal));
});

test("continues agent history only with a cursor issued for the same chat, topic, dates and thread", async () => {
  type Input = { chatId: string; dateFrom: string; dateTo: string; before?: string; forumTopicId?: number };
  let execute!: (input: Input, context: Pick<PluginAgentToolContext, "signal" | "threadId">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentHistoryTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const historyInDateRange = vi.fn().mockResolvedValueOnce({ messages: [], before: "20" })
    .mockResolvedValueOnce({ messages: [{ id: "12", text: "Older fixture" }], before: "12" })
    .mockResolvedValueOnce({ messages: [], before: null });
  const session = { status: () => ({ state: "ready" }), historyInDateRange, canShareAgentHistory: async () => true };
  let permission = new AbortController();
  registerAgentHistory(bb, async () => ["-42", "-43"], () => session as never, () => permission.signal);
  const input = { chatId: "-42", forumTopicId: 17, dateFrom: "2026-11-02", dateTo: "2026-11-15" };
  const run = (request: Input, threadId = "fixture") => execute(request, { threadId, signal: new AbortController().signal });
  await expect(run({ ...input, before: "50" })).resolves.toContain("does not match");
  expect(historyInDateRange).not.toHaveBeenCalled();
  const first = JSON.parse(await run(input));
  expect(first).toEqual({ messages: [], before: "20" });
  const second = { ...input, before: first.before };
  for (const request of [{ ...second, chatId: "-43" }, { ...second, forumTopicId: 18 },
    { ...second, dateFrom: "2026-11-03" }, { ...second, dateTo: "2026-11-16" }]) {
    await expect(run(request)).resolves.toContain("does not match");
  }
  await expect(run(second, "different")).resolves.toContain("does not match");
  expect(historyInDateRange).toHaveBeenCalledOnce();
  const last = JSON.parse(await run(second));
  expect(last).toEqual({ messages: [{ id: "12", text: "Older fixture" }], before: "12" });
  expect(historyInDateRange).toHaveBeenLastCalledWith("-42", expect.any(Object), "20", expect.any(AbortSignal), 17);
  permission.abort();
  permission = new AbortController();
  await expect(run({ ...input, before: last.before })).resolves.toContain("does not match");
  expect(historyInDateRange).toHaveBeenCalledTimes(2);
});

test("rechecks content protection after resolving grant and reply metadata and publishes only verified pages", async () => {
  type Input = { chatId: string; dateFrom: string; dateTo: string; before?: string };
  let execute!: (input: Input, context: Pick<PluginAgentToolContext, "signal" | "threadId">) => Promise<string>;
  const bb = { agents: { registerTool: (tool: { name: string; execute: typeof execute }) => {
    if (tool.name === agentHistoryTool) execute = tool.execute;
  } } } as unknown as BbPluginApi;
  const permission = new AbortController();
  const tokens = createReplyTokens();
  const issue = vi.spyOn(tokens, "issue");
  const chat = { id: "-42", name: "Fixture group", subtitle: "Group" };
  let protect = false;
  const historyInDateRange = vi.fn(async () => ({ messages: [{ id: "20", text: "Fixture reply" }], before: "20" }));
  const session = {
    status: () => ({ state: "ready" }), historyInDateRange,
    chatById: async () => { protect = true; return chat; },
    canShareAgentHistory: vi.fn(async () => !protect),
  };
  registerAgentHistory(bb, async () => [chat.id], () => session as never, () => permission.signal, tokens);
  const input = { chatId: chat.id, dateFrom: "2026-11-02", dateTo: "2026-11-15" };
  const run = (request: Input = input) => execute(request, { threadId: "fixture", signal: new AbortController().signal });
  await expect(run()).resolves.toBe("Telegram history access changed. No messages were shared.");
  expect(issue).not.toHaveBeenCalled();
  protect = false;
  await expect(run({ ...input, before: "20" })).resolves.toContain("does not match");
  expect(historyInDateRange).toHaveBeenCalledOnce();
  session.chatById = async () => chat;
  const page = JSON.parse(await run());
  expect(page.messages).toEqual([{ id: "20", text: "Fixture reply", replyToken: expect.any(String) }]);
  expect(page.before).toBe("20");
  expect(issue).toHaveBeenCalledOnce();
  expect(session.canShareAgentHistory).toHaveBeenCalledWith(chat.id, expect.any(AbortSignal));
});

type ReadInput = { maxMessages?: number; messageLink?: string; chatQuery?: string; chatId?: string; forumTopicId?: number; textQuery?: string; messageId?: string; dateFrom?: string; dateTo?: string };

function harness() {
  let execute!: (_: ReadInput, context: Pick<PluginAgentToolContext, "threadId" | "signal">) => Promise<string>;
  const requestInput = vi.fn<BbPluginApi["ui"]["requestInput"]>();
  const agents = { registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } };
  const bb = { agents, ui: { requestInput } } as unknown as BbPluginApi;
  const ownSavedNotes = vi.fn().mockResolvedValue([
    { id: "1", time: "10:10", text: "First fixture" },
    { id: "2", time: "11:11", text: "Second fixture" },
  ]);
  const search = vi.fn().mockResolvedValue([{ id: "-42", name: "Fixture group", subtitle: "Group" }]);
  const ownChatNotes = vi.fn().mockResolvedValue([{ id: "9", time: "", text: "Own group message" }]);
  const ownNote = vi.fn(async (id: string, messageId: string) =>
    id === "-42" ? { id: messageId, text: "Own group message" } : { id: messageId, text: "Second fixture" });
  const saved = vi.fn().mockResolvedValue({ id: "42", name: "Saved Messages", subtitle: "Direct message" });
  const chatById = vi.fn().mockResolvedValue({ id: "-42", name: "Fixture group", subtitle: "Group" });
  const publicChat = vi.fn().mockResolvedValue({ id: "-42", name: "Fixture group", subtitle: "Group" });
  const messageLinkReference = vi.fn().mockResolvedValue({ chatId: "-42", messageId: "9" });
  const forumTopicName = vi.fn().mockResolvedValue("Fixture topic");
  const status = vi.fn(() => ({ state: "ready" }));
  const current = { status, ownSavedNotes, search, ownChatNotes, ownNote, saved, chatById, publicChat, messageLinkReference, forumTopicName };
  const preview = registerAgentRead(bb, async () => true, () => current as never);
  return {
    run: (input: ReadInput = {}) => execute(input, { threadId: "fixture", signal: new AbortController().signal }),
    requestInput, status, ownSavedNotes, ownNote, search, ownChatNotes, saved, chatById, publicChat, messageLinkReference, forumTopicName, preview,
  };
}

test("shares exactly one selected note following author consent in BB", async () => {
  const { run, requestInput, preview } = harness();
  requestInput.mockImplementation(async ({ payload }) => {
    await preview((payload as { requestId: string }).requestId, "2");
    return { outcome: "submitted", value: { id: "2", authorConsent: true } };
  });
  const result = await run();
  expect(JSON.parse(result)).toEqual({ source: "Telegram Saved Messages", untrustedNoteText: "Second fixture" });
});

test("does not open a read review or reveal a pending preview after Telegram disconnects", async () => {
  const { run, requestInput, status, preview } = harness();
  status.mockReturnValueOnce({ state: "ready" }).mockReturnValueOnce({ state: "idle" });
  await expect(run()).resolves.toBe("Telegram session or settings changed. No note was shared.");
  expect(requestInput).not.toHaveBeenCalled();

  requestInput.mockImplementation(async ({ payload }) => {
    status.mockReturnValue({ state: "idle" });
    await expect(preview((payload as { requestId: string }).requestId, "2")).rejects.toThrow("This review is no longer available.");
    return { outcome: "submitted", value: { id: "2", authorConsent: true } };
  });
  await expect(run()).resolves.toBe("Open the selected message preview in BB before approving.");
});

test("passes inclusive UTC days to Saved Messages and refuses a reversed range", async () => {
  const { run, requestInput, ownSavedNotes } = harness();
  await expect(run({ dateFrom: "2026-11-15", dateTo: "2026-11-02" }))
    .resolves.toBe("dateFrom must be on or before dateTo.");
  expect(ownSavedNotes).not.toHaveBeenCalled();

  requestInput.mockResolvedValueOnce({ outcome: "cancelled", reason: "user" });
  await expect(run({ dateFrom: "2026-11-02", dateTo: "2026-11-15" }))
    .resolves.toBe("Telegram note sharing was cancelled.");
  expect(ownSavedNotes).toHaveBeenCalledExactlyOnceWith(undefined, {
    from: Date.parse("2026-11-02") / 1000,
    until: Date.parse("2026-11-16") / 1000,
  }, expect.any(AbortSignal));
});

test("refuses missing consent and a changed note", async () => {
  const { run, requestInput, ownSavedNotes, ownNote, preview } = harness();
  requestInput.mockResolvedValueOnce({ outcome: "submitted", value: { id: "2" } });
  await expect(run()).resolves.toBe("Telegram note approval was invalid.");

  requestInput.mockImplementation(async ({ payload }) => {
    await preview((payload as { requestId: string }).requestId, "2");
    return { outcome: "submitted", value: { id: "2", authorConsent: true } };
  });
  ownSavedNotes.mockResolvedValueOnce([{ id: "2", text: "Approved fixture", time: "" }]);
  ownNote.mockResolvedValueOnce({ id: "2", text: "Changed fixture" });
  await expect(run()).resolves.toBe("The approved note changed or is no longer available.");
});

test("pins the exact matched chat and refuses duplicate names before fetching text", async () => {
  const { run, requestInput, search, ownChatNotes, ownNote, preview } = harness();
  search.mockResolvedValueOnce([{ id: "-42", name: "Fixture group" }, { id: "-43", name: "Fixture group" }]);
  await expect(run({ chatQuery: "Fixture group" })).resolves.toContain("one exact chat");
  expect(ownChatNotes).not.toHaveBeenCalled();
  requestInput.mockImplementation(async (request) => {
    expect(request.payload).toMatchObject({ source: "Fixture group · Group · Chat ID -42", notes: [{ id: "9" }] });
    await preview((request.payload as { requestId: string }).requestId, "9");
    return { outcome: "submitted", value: { id: "9", authorConsent: true } };
  });
  const result = JSON.parse(await run({ chatQuery: "Fixture group" }));
  expect(result).toEqual({ source: "Fixture group", untrustedNoteText: "Own group message" });
  expect(ownChatNotes).toHaveBeenCalledExactlyOnceWith("-42", undefined, undefined, expect.any(AbortSignal), undefined);
  expect(ownNote).toHaveBeenCalledExactlyOnceWith("-42", "9");
});

test("a text query exposes only matching metadata and a preview expires when its form closes", async () => {
  const { run, requestInput, ownSavedNotes, preview } = harness();
  let requestId = "";
  requestInput.mockImplementation(async (request) => {
    expect(request.payload).toMatchObject({ notes: [{ id: "2", time: "11:11" }] });
    expect(JSON.stringify(request.payload)).not.toContain("fixture");
    requestId = (request.payload as { requestId: string }).requestId;
    await expect(preview(requestId, "1")).rejects.toThrow("no longer available");
    await expect(preview(requestId, "2")).resolves.toBe("Second fixture");
    return { outcome: "submitted", value: { id: "1", authorConsent: true } };
  });
  await expect(run({ textQuery: "SECOND" })).resolves.toBe("Telegram note sharing was not verified.");
  await expect(preview(requestId, "2")).rejects.toThrow("no longer available");
  expect(ownSavedNotes).toHaveBeenCalledExactlyOnceWith("SECOND");
});

test("refuses approval for a different note or an unopened preview in a later request", async () => {
  const { run, requestInput, preview } = harness();
  requestInput.mockImplementationOnce(async ({ payload }) => {
    await preview((payload as { requestId: string }).requestId, "1");
    return { outcome: "submitted", value: { id: "2", authorConsent: true } };
  });
  requestInput.mockResolvedValueOnce({ outcome: "submitted", value: { id: "1", authorConsent: true } });
  for (const attempt of [1, 2]) {
    await expect(run()).resolves.toContain("Open the selected message preview");
    expect(requestInput).toHaveBeenCalledTimes(attempt);
  }
});

test("requests a specific old message without listing recent history", async () => {
  const { run, requestInput, ownSavedNotes, ownNote, preview } = harness();
  requestInput.mockImplementationOnce(async ({ payload }) => {
    expect(payload).toMatchObject({ notes: [{ id: "123" }] });
    await preview((payload as { requestId: string }).requestId, "123");
    return { outcome: "submitted", value: { id: "123", authorConsent: true } };
  });
  await expect(run({ messageId: "123" })).resolves.toContain("Second fixture");
  expect(ownSavedNotes).not.toHaveBeenCalled();
  expect(ownNote.mock.calls).toEqual([["42", "123"], ["42", "123"]]);
  await expect(run({ messageId: "123", textQuery: "fixture" })).resolves.toContain("either messageId or textQuery");
});

test("uses the exact copied chat and message IDs without searching by title", async () => {
  const { run, requestInput, search, chatById, ownNote, preview } = harness();
  requestInput.mockImplementationOnce(async ({ payload }) => {
    expect(payload).toMatchObject({ source: "Fixture group · Group · Chat ID -42", notes: [{ id: "123" }] });
    await preview((payload as { requestId: string }).requestId, "123");
    return { outcome: "submitted", value: { id: "123", authorConsent: true } };
  });
  expect(JSON.parse(await run({ chatId: "-42", messageId: "123" }))).toEqual({
    source: "Fixture group", untrustedNoteText: "Own group message",
  });
  expect(chatById.mock.calls).toEqual([["-42"], ["-42"]]);
  expect(ownNote.mock.calls).toEqual([["-42", "123"], ["-42", "123"]]);
  expect(search).not.toHaveBeenCalled();
});

test("shares only the selected owner note in the reviewed forum topic", async () => {
  const { run, requestInput, ownChatNotes, ownNote, forumTopicName, preview } = harness();
  ownChatNotes.mockResolvedValue([
    { id: "9", time: "09:00", text: "Other topic fixture", forumTopicId: 99 },
    { id: "10", time: "10:00", text: "Own group message", forumTopicId: 17 },
  ]);
  ownNote.mockResolvedValue({ id: "10", text: "Own group message", forumTopicId: 17 } as never);
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ source: "Fixture group · Group · Chat ID -42 · Topic: Fixture topic · ID 17",
      notes: [{ id: "10", time: "10:00" }],
    });
    const { requestId } = payload as { requestId: string };
    await expect(preview(requestId, "9")).rejects.toThrow("no longer available");
    await expect(preview(requestId, "10")).resolves.toBe("Own group message");
    return { outcome: "submitted", value: { id: "10", authorConsent: true } };
  });

  expect(JSON.parse(await run({ chatId: "-42", forumTopicId: 17 }))).toEqual({
    source: "Fixture group", untrustedNoteText: "Own group message",
  });
  expect(ownChatNotes).toHaveBeenCalledExactlyOnceWith("-42", undefined, 17, expect.any(AbortSignal), undefined);

  forumTopicName.mockResolvedValueOnce("Fixture topic").mockResolvedValueOnce("Renamed fixture");
  await expect(run({ chatId: "-42", forumTopicId: 17 })).resolves.toContain("approved topic changed");
});

test("does not release a message after the BB review deadline", async () => {
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { run, requestInput, ownNote, preview } = harness();
    requestInput.mockImplementation(async ({ payload }) => {
      await preview((payload as { requestId: string }).requestId, "2");
      now = 120_001;
      return { outcome: "submitted", value: { id: "2", authorConsent: true } };
    });
    const result = await run();
    expect(result).not.toContain("Second fixture");
    expect(ownNote).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

test("uses a public Telegram username for an exact approved read", async () => {
  const { run, requestInput, publicChat, search, preview } = harness();
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ source: "Fixture group · Group · Chat ID -42" });
    await preview((payload as { requestId: string }).requestId, "9");
    return { outcome: "submitted", value: { id: "9", authorConsent: true } };
  });
  expect(JSON.parse(await run({ chatQuery: "@FixtureGroup" }))).toMatchObject({ untrustedNoteText: "Own group message" });
  expect(publicChat).toHaveBeenCalledExactlyOnceWith("fixturegroup");
  expect(search).not.toHaveBeenCalled();
});

test("reviews the exact message resolved from a Telegram link", async () => {
  const { run, requestInput, messageLinkReference, ownNote, preview } = harness();
  const link = "https://t.me/c/123/45";
  await expect(run({ messageLink: link, chatId: "-42", messageId: "9" })).resolves.toContain("without other");
  expect(messageLinkReference).not.toHaveBeenCalled();
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ notes: [{ id: "9" }] });
    await preview((payload as { requestId: string }).requestId, "9");
    return { outcome: "submitted", value: { id: "9", authorConsent: true } };
  });
  expect(JSON.parse(await run({ messageLink: link }))).toMatchObject({ untrustedNoteText: "Own group message" });
  expect(messageLinkReference).toHaveBeenCalledExactlyOnceWith(link);
  expect(ownNote.mock.calls).toEqual([["-42", "9"], ["-42", "9"]]);
});

test("withholds a reviewed note when its named Telegram source changes during approval", async () => {
  const { run, requestInput, preview, chatById } = harness();
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ source: "Fixture group · Group · Chat ID -42" });
    await preview((payload as { requestId: string }).requestId, "9");
    chatById.mockResolvedValue({ id: "-42", name: "Changed fixture group", subtitle: "Group" });
    return { outcome: "submitted", value: { id: "9", authorConsent: true } };
  });
  expect(await run({ chatId: "-42", messageId: "9" })).toBe("The approved Telegram conversation changed or is no longer available.");
  expect(chatById.mock.calls).toEqual([["-42"], ["-42"]]);
});

test.each(["Saved Messages", "ИЗБРАННОЕ"])("uses the signed-in account's Saved Messages for %s", async (chatQuery) => {
  const { run, requestInput, saved, preview, ownSavedNotes, ownNote, search, chatById } = harness();
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ source: "Telegram Saved Messages", notes: [{ id: "2" }] });
    await preview((payload as { requestId: string }).requestId, "2");
    return { outcome: "submitted", value: { id: "2", authorConsent: true } };
  });
  expect(JSON.parse(await run({ chatQuery, textQuery: "Second" }))).toEqual({
    source: "Telegram Saved Messages", untrustedNoteText: "Second fixture",
  });
  expect(saved).toHaveBeenCalledOnce();
  expect(ownSavedNotes).toHaveBeenCalledExactlyOnceWith("Second");
  expect(ownNote).toHaveBeenCalledExactlyOnceWith("42", "2");
  expect(search).not.toHaveBeenCalled();
  expect(chatById).not.toHaveBeenCalled();
});

test("shares only the individually previewed messages from an approved batch", async () => {
  const { run, requestInput, preview, ownNote } = harness();
  ownNote.mockImplementation(async (_, id) => ({ id, text: id === "1" ? "First fixture" : "Second fixture" }));
  const entries = ["1", "2"].map((id) => ({ id, authorConsent: true }));
  requestInput.mockImplementationOnce(async ({ payload }) => {
    const requestId = (payload as { requestId: string }).requestId;
    await preview(requestId, "1");
    return { outcome: "submitted", value: { entries } };
  });
  await expect(run({ maxMessages: 2 })).resolves.toContain("Open the selected message preview");

  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ maxMessages: 2, notes: [{ id: "1" }, { id: "2" }] });
    const requestId = (payload as { requestId: string }).requestId;
    await preview(requestId, "1");
    await preview(requestId, "2");
    return { outcome: "submitted", value: { entries } };
  });
  expect(JSON.parse(await run({ maxMessages: 2 }))).toEqual({
    source: "Telegram Saved Messages",
    messages: [{ untrustedNoteText: "First fixture" }, { untrustedNoteText: "Second fixture" }],
  });

  ownNote.mockImplementation(async (_, id) => ({ id, text: id === "1" ? "First fixture" : "Edited fixture" }));
  expect(await run({ maxMessages: 2 })).toBe("The approved note changed or is no longer available.");
});
