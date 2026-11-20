import { miniAppAgentTool } from "../src/adapters/bb/mini-app-agent.ts";
import { miniAppDeviceStorageMigration, miniAppLocationAccessMigration } from "../src/adapters/bb/mini-app-device-storage.ts";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import activate from "../server.ts";
import { agentFindChatsTool, agentFindTopicsTool, agentSearchMessagesTool, agentHistoryTool, agentReadTool } from "../src/adapters/bb/agent-read.ts";
import { agentSendTool } from "../src/adapters/bb/agent-send.ts";
import { historyChatsForAccount, replaceAccountHistoryGrants } from "../src/core/agent-read.ts";
import { agentHistoryGrants } from "../src/core/contract.ts";
import * as telegram from "../src/adapters/bb/telegram.ts";
import * as tdjson from "../src/adapters/bb/tdjson.ts";
import * as credentials from "../src/adapters/bb/credentials.ts";
import { privateHistoryMigration, privateMediaMigration } from "../src/adapters/bb/private-history.ts";
import { channelPostReceiptMigrations } from "../src/adapters/bb/channel-post-receipts.ts";

const context: PluginAgentConfigurationContext = {
  pluginMetadata: {},
  thread: { id: "fixture", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "fixture", kind: "personal", name: "Fixture", gitRemoteUrl: null },
  environment: { id: "fixture", name: null, path: null, branchName: null, workspaceProvisionType: null },
  host: { id: "fixture", name: "Fixture" },
  provider: { id: "fixture", model: "fixture", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId: null },
};

test("reads existing automatic media settings into separate chat-type limits", async () => {
  const limits = { photo: 2, video: 8, file: 4 };
  const disabled = { photo: 0, video: 0, file: 0 };
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram",
    settings: { autoMediaPolicy: JSON.stringify({ ...limits, scopes: ["private", "channel"] }) } });
  try {
    await activate(bb);
    await expect(harness.behavior.callRpc("autoMediaPolicy", null)).resolves.toEqual({
      private: limits, group: disabled, channel: limits,
    });
    const configured = { private: limits, group: { ...limits, file: 1 }, channel: disabled };
    await harness.behavior.setSettings({ autoMediaPolicy: JSON.stringify(configured) });
    await expect(harness.behavior.callRpc("autoMediaPolicy", null)).resolves.toEqual(configured);
  } finally { await harness.lifecycle.dispose(); }
});

test("migrates single-account grants and changes one account without replacing the other", () => {
  const legacy = { accountId: "42", chatIds: ["-91", "-91"] };
  const original = agentHistoryGrants.parse(legacy);
  expect(historyChatsForAccount(original, "42")).toEqual(["-91"]);
  expect(historyChatsForAccount(original, "43")).toEqual([]);
  const both = agentHistoryGrants.parse(replaceAccountHistoryGrants(original, "43", ["-92"]));
  expect(historyChatsForAccount(both, "42")).toEqual(["-91"]);
  expect(historyChatsForAccount(both, "43")).toEqual(["-92"]);
  expect(replaceAccountHistoryGrants(both, "42", [])).toEqual([{ accountId: "43", chatIds: ["-92"] }]);
  expect(agentHistoryGrants.safeParse([legacy, legacy]).success).toBe(false);
});

test("keeps history tools available to existing threads while checking permissions on each call", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram", settings: { agentSend: true, agentReadHistory: true } });
  try {
    await activate(bb);
    async function offered() {
      return (await harness.behavior.resolveAgentConfiguration(context)).tools.map(({ name }) => name);
    }
    const historyTools = [agentFindChatsTool, agentFindTopicsTool, agentSearchMessagesTool, agentHistoryTool, miniAppAgentTool];
    await expect(offered()).resolves.toEqual([...historyTools, agentSendTool]);
    await harness.behavior.setSettings({ agentReadOwnNotes: true });
    await expect(offered()).resolves.toEqual([...historyTools, agentSendTool]);
    await harness.behavior.setSettings({ agentHistoryChats: JSON.stringify({ accountId: "42", chatIds: ["-42"] }) });
    await expect(offered()).resolves.toEqual([...historyTools, agentSendTool]);
    await harness.behavior.setSettings({ agentSend: false });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentSendTool, { text: "Fixture" })).resolves.toContain("disabled");
    await harness.behavior.setSettings({ agentReadOwnNotes: false });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentReadTool, {})).resolves.toContain("disabled");
    await harness.behavior.setSettings({ agentHistoryChats: "" });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentFindChatsTool, {
      query: "Fixture", dateFrom: "2026-11-02", dateTo: "2026-11-15",
    })).resolves.toContain("connect the account");
  } finally { await harness.lifecycle.dispose(); }
});

test("other plugins cannot use the manual RPC to bypass the agent review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  try {
    await activate(bb);
    const caller = { experimental_caller: { kind: "plugin", pluginId: "fixture-plugin" } } as const;
    await expect(harness.behavior.callRpc("setAgentAccess", { capability: "send", enabled: true }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("history", { id: "42" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("send", { id: "42", text: "Fixture" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("deleteMessage", { id: "42", messageId: "25", scope: "everyone" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("setChatAgentAccess", { id: "42", enabled: true }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    const scoped = { connectionId: "00000000-0000-4000-8000-000000000001", method: "send", payload: { id: "42", text: "Fixture" } };
    await expect(harness.behavior.callRpc("sessionRpc", scoped, caller)).rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("sessionRpc", scoped)).rejects.toMatchObject({ code: "conflict" });
    await expect(harness.behavior.callRpc("agentAccess", null)).resolves.toEqual({ read: false, send: false, history: false });
  } finally { await harness.lifecycle.dispose(); }
});

test("old agent sessions can use Telegram commands with the native validation and settings", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram", settings: { agentSend: false } });
  harness.sdk.stub("threads.get", () => ({ id: "fixture", projectId: "fixture" }));
  try {
    await activate(bb);
    const cliContext = { threadId: "fixture", signal: new AbortController().signal };
    const search = ["find-chats", "--input", '{"query":"Fixture","dateFrom":"2026-11-02","dateTo":"2026-11-15"}'];
    await expect(harness.behavior.runCli(search, cliContext)).resolves.toMatchObject({
      exitCode: 0, stdout: expect.stringContaining("connect the account"),
    });
    await expect(harness.behavior.runCli(["request-send", "--input", '{"text":"Fixture"}'], cliContext)).resolves.toMatchObject({
      exitCode: 0, stdout: expect.stringContaining("disabled"),
    });
    await expect(harness.behavior.runCli(["find-chats", "--input", '{"query":"Fixture"}'], cliContext))
      .resolves.toMatchObject({ exitCode: 1 });
    await expect(harness.behavior.runCli(search)).resolves.toMatchObject({ exitCode: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

test.runIf(process.platform === "darwin")("switches account databases and refuses a stale tab, including a pending read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-telegram-accounts-"));
  const database = new Database(join(directory, "plugin.sqlite"));
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const actual = telegram.createTelegram;
  const master = Buffer.alloc(32, 7).toString("base64");
  let unblockRead!: () => void;
  let startRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const pendingRead = new Promise<void>((resolve) => { unblockRead = resolve; });
  const opened: { path: string; key: string }[] = [];
  const closed: string[] = [];
  const cacheChecks: string[] = [];
  let holdAccountLookup = false;
  let accountLookupStarted!: () => void;
  let unblockAccountLookup!: () => void;
  const accountLookup = new Promise<void>((resolve) => { accountLookupStarted = resolve; });
  const pendingAccountLookup = new Promise<void>((resolve) => { unblockAccountLookup = resolve; });
  let secondAccountId = 8;
  let transcriptionSignal: AbortSignal | undefined;
  try {
    for (const sql of [...channelPostReceiptMigrations, privateHistoryMigration, privateMediaMigration, miniAppDeviceStorageMigration, miniAppLocationAccessMigration]) database.exec(sql);
    vi.spyOn(bb.storage, "database").mockReturnValue(database);
    vi.spyOn(bb.storage, "migrate").mockImplementation(() => {});
    vi.spyOn(tdjson, "findTdjsonLibrary").mockReturnValue("fixture");
    vi.spyOn(credentials, "readCredentials").mockReturnValue({ apiId: 1, apiHash: "fixture" });
    vi.spyOn(telegram, "createTelegram").mockImplementation((options) => {
      const path = basename(options.directory);
      opened.push({ path, key: options.key });
      return actual(options, () => ({
        close: async () => { closed.push(path); },
        request: async (query, _timeoutMs, signal) => {
          if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
          if (query["@type"] === "getMe") {
            if (path === "tdlib" && holdAccountLookup) { accountLookupStarted(); await pendingAccountLookup; }
            return { "@type": "user", id: path === "tdlib" ? 7 : secondAccountId };
          }
          if (query["@type"] === "getStorageStatistics") {
            cacheChecks.push(path);
            return { "@type": "storageStatistics", size: 0 };
          }
          if (query["@type"] === "getChat") return { "@type": "chat", id: 42 };
          if (query["@type"] === "getMessage" && query.message_id === 25 && signal) {
            transcriptionSignal = signal;
            signal.throwIfAborted();
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          if (query["@type"] === "getWebPageInstantView") return {
            "@type": "webPageInstantView", is_full: true, blocks: [
              { "@type": "pageBlockAuthorDate", author: { "@type": "richTextPlain", text: "Fixture author" }, publish_date: 0 },
            ],
          };
          if (query["@type"] === "getChatHistory") {
            if (path === "tdlib") { startRead(); await pendingRead; }
            return { "@type": "messages", messages: [] };
          }
          throw new Error("Unexpected fixture request");
        },
      }));
    });
    const intervals = vi.spyOn(globalThis, "setInterval");
    await activate(bb);
    const cacheTick = intervals.mock.calls.find(([, milliseconds]) => milliseconds === 60_000)?.[0];
    expect(cacheTick).toBeTypeOf("function");
    intervals.mockRestore();
    await harness.behavior.setSettings({ sessionKey: master, agentSend: true });
    async function readyAuth() {
      return vi.waitFor(async () => {
        const auth = await harness.behavior.callRpc("status", null) as {
          state: string; connectionId: string; draftScope: string; navigationScope: string;
        };
        expect(auth.state).toBe("ready");
        expect(auth.connectionId).toBeTruthy();
        expect(auth.draftScope).toBeTruthy();
        expect(auth.navigationScope).toMatch(/^[a-f0-9]{64}$/);
        return auth;
      });
    }
    await harness.behavior.callRpc("connect", null);
    const { connectionId: first, draftScope: firstScope, navigationScope: firstNavigation } = await readyAuth();
    const call = (connectionId: string, method: string, payload: unknown) =>
      harness.behavior.callRpc("sessionRpc", { connectionId, method, payload });
    const firstMedia = { photo: 2, video: 3, file: 0 };
    const secondMedia = { photo: 0, video: 0, file: 0 };
    const firstPlayback = { video: 0, gif: 0, videoNote: 0 };
    const secondPlayback = { video: 1, gif: 2, videoNote: 3 };
    await Promise.all([
      expect(call(first, "setChatAutoMediaOverride", { id: "42", limits: firstMedia })).resolves.toEqual(firstMedia),
      expect(call(first, "setChatAutoPlaybackOverride", { id: "42", limits: firstPlayback })).resolves.toEqual(firstPlayback),
    ]);
    await expect(call(first, "autoMediaOverrides", null)).resolves.toEqual({ "42": firstMedia });
    await expect(call(first, "autoPlaybackOverrides", null)).resolves.toEqual({ "42": firstPlayback });
    const articleInput = { url: "https://example.com/fixture" };
    const article = { rtl: false, partial: false, blocks: [{ kind: "byline", text: "Fixture author" }] };
    await expect(harness.behavior.callRpc("instantView", articleInput)).resolves.toStrictEqual(article);
    await expect(call(first, "instantView", articleInput)).resolves.toStrictEqual(article);
    const speech = { id: "42", messageId: "25" };
    const unused = await call(first, "prepareVoiceTranscription", speech);
    await expect(call(first, "cancelVoiceTranscription", { ticket: unused })).resolves.toBe(true);
    await expect(call(first, "transcribeVoice", { ...speech, ticket: unused })).rejects.toMatchObject({ code: "conflict" });
    const ticket = await call(first, "prepareVoiceTranscription", speech);
    await expect(call(first, "transcribeVoice", { ...speech, messageId: "26", ticket })).rejects.toMatchObject({ code: "conflict" });
    const transcription = expect(call(first, "transcribeVoice", { ...speech, ticket })).rejects.toMatchObject({ code: "invalid" });
    await vi.waitFor(() => expect(transcriptionSignal?.aborted).toBe(false));
    await expect(call(first, "transcribeVoice", { ...speech, ticket })).rejects.toMatchObject({ code: "conflict" });
    await expect(call(first, "cancelVoiceTranscription", { ticket })).resolves.toBe(true);
    await transcription;
    expect(transcriptionSignal?.aborted).toBe(true);
    await expect(call(first, "cancelVoiceTranscription", { ticket })).resolves.toBe(false);
    const read = expect(call(first, "history", { id: "42" })).rejects.toMatchObject({ code: "conflict" });
    await readStarted;
    holdAccountLookup = true;
    const switchAccount = call(first, "selectTelegramAccount", { expected: "primary", target: { label: "Fixture second" } });
    await accountLookup;
    expect(() => cacheTick!()).not.toThrow();
    expect(cacheChecks).toEqual([]);
    holdAccountLookup = false;
    unblockAccountLookup();
    await switchAccount;
    const { connectionId: second, draftScope: secondScope, navigationScope: secondNavigation } = await readyAuth();
    expect(secondScope).not.toBe(firstScope);
    expect(secondNavigation).not.toBe(firstNavigation);
    expect(second).not.toBe(first);
    await expect(call(second, "autoMediaOverrides", null)).resolves.toEqual({});
    await expect(call(second, "autoPlaybackOverrides", null)).resolves.toEqual({});
    await expect(call(second, "setChatAutoPlaybackOverride", { id: "42", limits: secondPlayback })).resolves.toEqual(secondPlayback);
    await expect(call(second, "setChatAutoMediaOverride", { id: "42", limits: secondMedia })).resolves.toEqual(secondMedia);
    await expect(call(second, "autoMediaOverrides", null)).resolves.toEqual({ "42": secondMedia });
    expect(opened[0]).toEqual({ path: "tdlib", key: master });
    expect(opened[1]?.path).toMatch(/^tdlib-[a-f0-9-]+$/);
    expect(opened[1]?.key).not.toBe(master);
    expect(closed).toEqual(["tdlib"]);
    cacheTick!();
    await vi.waitFor(() => expect(cacheChecks).toEqual([opened[1]?.path]));
    const selection = await harness.behavior.callRpc("accountSelection", null) as { selected: string };
    await expect(call(second, "renameTelegramAccount", { expected: selection.selected, previousLabel: "Fixture second", label: "Fixture work" }))
      .resolves.toMatchObject({ accounts: expect.arrayContaining([{ id: selection.selected, label: "Fixture work" }]) });
    expect(await readyAuth()).toMatchObject({ connectionId: second, draftScope: secondScope });
    await expect(call(second, "renameTelegramAccount", { expected: selection.selected, previousLabel: "Fixture second", label: "Stale" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(call(second, "agentAccess", null)).resolves.toEqual({ read: false, send: false, history: false });
    await expect(call(second, "setAgentAccess", { enabled: true, capability: "read" }))
      .resolves.toEqual({ read: true, send: false, history: false });
    unblockRead();
    await read;
    await expect(call(first, "history", { id: "42" })).rejects.toMatchObject({ code: "conflict" });
    await expect(harness.behavior.callRpc("history", { id: "42" })).rejects.toMatchObject({ code: "conflict" });
    await expect(call(second, "history", { id: "42" })).resolves.toMatchObject({ messages: [] });
    await call(second, "selectTelegramAccount", { expected: selection.selected, target: { id: "primary" } });
    const { connectionId: restored, draftScope: restoredScope, navigationScope: restoredNavigation } = await readyAuth();
    expect(restoredScope).toBe(firstScope);
    expect(restoredNavigation).toBe(firstNavigation);
    expect(restored).not.toBe(first);
    await expect(call(restored, "autoMediaOverrides", null)).resolves.toEqual({ "42": firstMedia });
    await expect(call(restored, "autoPlaybackOverrides", null)).resolves.toEqual({ "42": firstPlayback });
    await expect(call(restored, "setChatAutoPlaybackOverride", { id: "42", limits: null })).resolves.toBeNull();
    await expect(call(restored, "autoPlaybackOverrides", null)).resolves.toEqual({});
    await expect(call(restored, "setChatAutoMediaOverride", { id: "42", limits: null })).resolves.toBeNull();
    await expect(call(restored, "autoMediaOverrides", null)).resolves.toEqual({});
    expect(opened[2]).toEqual(opened[0]);
    await expect(call(restored, "agentAccess", null)).resolves.toEqual({ read: false, send: true, history: false });
    await call(restored, "selectTelegramAccount", { expected: "primary", target: { id: selection.selected } });
    const { connectionId: reopened, draftScope: reopenedScope } = await readyAuth();
    expect(reopenedScope).toBe(secondScope);
    await expect(call(reopened, "autoMediaOverrides", null)).resolves.toEqual({ "42": secondMedia });
    await expect(call(reopened, "autoPlaybackOverrides", null)).resolves.toEqual({ "42": secondPlayback });
    await expect(call(reopened, "agentAccess", null)).resolves.toEqual({ read: true, send: false, history: false });
    secondAccountId = 9;
    const replacement = await readyAuth();
    expect(replacement.draftScope).not.toBe(secondScope);
    expect(replacement.navigationScope).not.toBe(secondNavigation);
    await expect(call(reopened, "agentAccess", null)).resolves.toEqual({ read: false, send: false, history: false });
  } finally {
    unblockRead();
    unblockAccountLookup();
    await harness.lifecycle.dispose();
    vi.restoreAllMocks();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
