import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import { createReplyTokens } from "../src/adapters/bb/reply-tokens.ts";
import { registerAgentSend } from "../src/adapters/bb/agent-send.ts";

function harness(now = Date.now) {
  let readPermission = new AbortController();
  type Context = Pick<PluginAgentToolContext, "threadId" | "signal">;
  let execute!: (input: { text: string; replyToken?: string; recipientQuery?: string; recipientId?: string; forumTopicId?: number }, context: Context) => Promise<string>;
  const requestInput = vi.fn<BbPluginApi["ui"]["requestInput"]>();
  const agents = { registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } };
  const bb = { agents, ui: { requestInput } } as unknown as BbPluginApi;
  const sendText = vi.fn(async (_id: string, _text: string, _reply?: string, _parent?: string, authorize?: () => boolean) =>
    ({ state: authorize?.() ? "sent" : "failed" }));
  const chatById = vi.fn().mockResolvedValue({ id: "-43", name: "Exact fixture", subtitle: "Group" });
  const publicChat = vi.fn().mockResolvedValue({ id: "-43", name: "Exact fixture", subtitle: "Group" });
  const forumTopicName = vi.fn(async () => "Fixture topic");
  const status = vi.fn(() => ({ state: "ready" }));
  const current = { status, chats: async () => [
    { id: "42", name: "Fixture group", subtitle: "Group", messages: [{ text: "private fixture" }] },
  ], sendText, chatById, publicChat, forumTopicName, postingAllowed: async () => true };
  const enabled = vi.fn().mockResolvedValue(true);
  const tokens = createReplyTokens(now);
  registerAgentSend(bb, enabled, () => current as never, tokens, undefined, undefined, () => readPermission.signal);
  const controller = new AbortController();
  return {
    run: (input: { replyToken?: string; recipientQuery?: string; recipientId?: string; forumTopicId?: number } = {}, threadId = "fixture") =>
      execute({ text: "Original draft", ...input }, { threadId, signal: controller.signal }),
    issue: (forumTopicId?: number) => tokens.issue({ session: current as never, threadId: "fixture",
      chat: { id: "42", name: "Fixture group", subtitle: "Group" }, message: { id: "12", text: "Parent fixture", forumTopicId } }),
    requestInput, status, sendText, chatById, publicChat, enabled, controller,
    revokeRead: () => { readPermission.abort(); readPermission = new AbortController(); },
  };
}

test("sends exactly the displayed agent text after approval in BB", async () => {
  const { run, requestInput, sendText } = harness();
  requestInput.mockImplementation(async (request) => {
    expect(request.payload).toEqual({ text: "Original draft", recipients: [{ id: "42", name: "Fixture group", kind: "Group", sender: "Your Telegram account" }] });
    expect(sendText).not.toHaveBeenCalled();
    return { outcome: "submitted", value: { id: "42" } };
  });
  await expect(run()).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Original draft", undefined, undefined, expect.any(Function), { key: "account", name: "Fixture group", kind: "Group" });
});

test("does not send on expiry, substituted text, or cancellation", async () => {
  const { run, requestInput, sendText } = harness();
  requestInput.mockResolvedValueOnce({ outcome: "cancelled", reason: "timeout" });
  requestInput.mockResolvedValueOnce({ outcome: "submitted", value: { id: "42", text: "Substitution" } });
  requestInput.mockResolvedValueOnce({ outcome: "cancelled", reason: "user" });
  for (let i = 0; i < 3; i++) await expect(run()).resolves.toContain("Nothing was sent");
  expect(sendText).not.toHaveBeenCalled();
});

test("skips approval and dispatch when the Telegram session disconnects", async () => {
  const { run, requestInput, status, sendText } = harness();
  status.mockReturnValueOnce({ state: "ready" }).mockReturnValueOnce({ state: "idle" });
  await expect(run()).resolves.toBe("Telegram session or settings changed. Nothing was sent.");
  expect(requestInput).not.toHaveBeenCalled();

  requestInput.mockImplementation(async () => {
    status.mockReturnValue({ state: "idle" });
    return { outcome: "submitted", value: { id: "42" } };
  });
  await expect(run()).resolves.toBe("Telegram session or settings changed. Nothing was sent.");
  expect(sendText).not.toHaveBeenCalled();
});

test("an agent reply is confined to its approved thread, chat and message and cannot be replayed", async () => {
  const { run, requestInput, sendText, issue } = harness();
  const replyToken = issue();
  await expect(run({ replyToken }, "other")).resolves.toContain("invalid or expired");
  await expect(run({ replyToken, recipientQuery: "Other chat" })).resolves.toContain("invalid or expired");
  expect(requestInput).not.toHaveBeenCalled();

  requestInput.mockResolvedValueOnce({ outcome: "submitted", value: { id: "99" } });
  await expect(run({ replyToken })).resolves.toContain("approval was invalid");
  expect(sendText).not.toHaveBeenCalled();

  requestInput.mockImplementation(async (request) => {
    expect(request.payload).toMatchObject({ replyPreview: "Parent fixture", recipients: [{ id: "42" }] });
    return { outcome: "submitted", value: { id: "42" } };
  });
  await expect(run({ replyToken })).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Original draft", "12", "Parent fixture", expect.any(Function), { key: "account", name: "Fixture group", kind: "Group" });
  await expect(run({ replyToken })).resolves.toContain("invalid or expired");
});

test("a reply token expiring during the owner prompt cannot send", async () => {
  let clock = 0;
  const { run, requestInput, sendText, issue } = harness(() => clock);
  const replyToken = issue();
  requestInput.mockImplementation(async () => {
    clock = 10 * 60_000;
    return { outcome: "submitted", value: { id: "42" } };
  });
  await expect(run({ replyToken })).resolves.toContain("expired or was revoked");
  expect(sendText).toHaveBeenCalledOnce();
});

test("revoking permission while an approval is pending prevents the send", async () => {
  let execute!: (input: { text: string }, context: Pick<PluginAgentToolContext, "threadId" | "signal">) => Promise<string>;
  const permission = new AbortController();
  const requestInput = vi.fn<BbPluginApi["ui"]["requestInput"]>().mockImplementation(async (_, options) => {
    expect(options?.signal?.aborted).toBe(false);
    permission.abort();
    expect(options?.signal?.aborted).toBe(true);
    // Model a late approval racing cancellation.
    return { outcome: "submitted", value: { id: "42" } };
  });
  const bb = { agents: { registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } },
    ui: { requestInput } } as unknown as BbPluginApi;
  const sendText = vi.fn();
  const session = { status: () => ({ state: "ready" }), chats: async () => [{ id: "42" }], sendText };
  registerAgentSend(bb, async () => true, () => session as never, undefined, () => permission.signal);
  await expect(execute({ text: "Fixture" }, { threadId: "thread", signal: new AbortController().signal }))
    .resolves.toContain("Nothing was sent");
  expect(sendText).not.toHaveBeenCalled();
});

test("an exact recipient still requires selecting and approving that chat", async () => {
  const { run, requestInput, sendText, chatById } = harness();
  requestInput.mockImplementationOnce(async ({ payload }) => {
    expect(payload).toMatchObject({
      showRecipientId: true, recipients: [{ id: "-43", name: "Exact fixture", kind: "Group" }],
    });
    expect(sendText).not.toHaveBeenCalled();
    return { outcome: "submitted", value: { id: "-42" } };
  });
  await expect(run({ recipientId: "-43" })).resolves.toContain("approval was invalid");
  expect(sendText).not.toHaveBeenCalled();
  requestInput.mockResolvedValueOnce({ outcome: "submitted", value: { id: "-43" } });
  await expect(run({ recipientId: "-43" })).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("-43", "Original draft", undefined, undefined, expect.any(Function), { key: "account", name: "Exact fixture", kind: "Group" });
  expect(chatById.mock.calls).toEqual([["-43"], ["-43"]]);
});

test("revoking read access interrupts reply approval without blocking a separate text send", async () => {
  const { run, issue, requestInput, sendText, revokeRead } = harness();
  requestInput.mockResolvedValue({ outcome: "submitted", value: { id: "42" } });
  let pendingSignal!: AbortSignal;
  let finish!: (result: { outcome: "submitted"; value: { id: string } }) => void;
  requestInput.mockImplementationOnce((_, options) => {
    pendingSignal = options!.signal!;
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = run({ replyToken: issue() });
  await vi.waitFor(() => expect(requestInput).toHaveBeenCalledOnce());
  revokeRead();
  expect(pendingSignal.aborted).toBe(true);
  finish({ outcome: "submitted", value: { id: "42" } });
  await expect(pending).resolves.toContain("Nothing was sent");
  expect(sendText).not.toHaveBeenCalled();
  await expect(run()).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Original draft", undefined, undefined, expect.any(Function), { key: "account", name: "Fixture group", kind: "Group" });
});

test("shows the alternate sender name and ID without changing the approved identity", async () => {
  const { run, requestInput, sendText, chatById } = harness();
  chatById.mockResolvedValueOnce({ id: "-43", name: "Destination fixture", subtitle: "Group", senderKey: "chat:-44" })
    .mockResolvedValueOnce({ id: "-44", name: "Alternate fixture", subtitle: "Channel" });
  requestInput.mockImplementationOnce(async ({ payload }) => {
    expect(payload).toMatchObject({
      recipients: [{ id: "-43", name: "Destination fixture", sender: "Alternate fixture · ID -44" }],
    });
    expect(JSON.stringify(payload)).not.toContain("senderKey");
    return { outcome: "submitted", value: { id: "-43" } };
  });
  await expect(run({ recipientId: "-43" })).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("-43", "Original draft", undefined, undefined, expect.any(Function), { key: "chat:-44", name: "Destination fixture", kind: "Group" });
});

test("includes the exact forum topic in agent reply approval and dispatch", async () => {
  const { run, requestInput, sendText, issue } = harness();
  const replyToken = issue(17);
  requestInput.mockImplementation(async (request) => {
    expect(request.payload).toMatchObject({ forumTopic: { id: 17, name: "Fixture topic" }, replyPreview: "Parent fixture" });
    expect(sendText).not.toHaveBeenCalled();
    return { outcome: "submitted", value: { id: "42" } };
  });
  await expect(run({ replyToken })).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Original draft", "12", "Parent fixture",
    expect.any(Function), { key: "account", name: "Fixture group", kind: "Group" }, { id: 17, name: "Fixture topic" });
});

test("requires confirmation again before a new agent message can target a specific forum topic", async () => {
  const { run, requestInput, sendText } = harness();
  await expect(run({ forumTopicId: 17 })).resolves.toContain("Use forumTopicId with recipientId");
  expect(requestInput).not.toHaveBeenCalled();

  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({
      forumTopic: { id: 17, name: "Fixture topic" }, recipients: [{ id: "-43", kind: "Group" }],
    });
    expect(sendText).not.toHaveBeenCalled();
    return { outcome: "submitted", value: { id: "-43" } };
  });
  requestInput.mockResolvedValueOnce({ outcome: "cancelled", reason: "timeout" });
  await expect(run({ recipientId: "-43", forumTopicId: 17 })).resolves.toContain("Nothing was sent");
  expect(sendText).not.toHaveBeenCalled();

  await expect(run({ recipientId: "-43", forumTopicId: 17 })).resolves.toContain("confirmed");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("-43", "Original draft", undefined, undefined,
    expect.any(Function), { key: "account", name: "Exact fixture", kind: "Group" }, { id: 17, name: "Fixture topic" });
});

test("does not send after the BB review deadline", async () => {
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { run, requestInput, sendText } = harness();
    requestInput.mockImplementation(async () => {
      now = 120_001;
      return { outcome: "submitted", value: { id: "42" } };
    });
    await expect(run()).resolves.toContain("Nothing was sent");
    expect(sendText).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

test("resolves a public Telegram link to one reviewed target and rejects invite links", async () => {
  const { run, requestInput, publicChat, sendText } = harness();
  await expect(run({ recipientQuery: "https://t.me/+fixture" })).resolves.toContain("Nothing was sent");
  expect(publicChat).not.toHaveBeenCalled();
  expect(requestInput).not.toHaveBeenCalled();
  requestInput.mockImplementation(async ({ payload }) => {
    expect(payload).toMatchObject({ recipients: [{ id: "-43", name: "Exact fixture" }], showRecipientId: true });
    expect(sendText).not.toHaveBeenCalled();
    return { outcome: "submitted", value: { id: "-43" } };
  });
  await expect(run({ recipientQuery: "https://t.me/Fixture_Group" })).resolves.toContain("confirmed");
  expect(publicChat).toHaveBeenCalledExactlyOnceWith("fixture_group");
});
