import { embedMigration, embedResources } from "./src/adapters/bb/embed-resources.ts";
import { createMiniAppAgent, miniAppAgentTool } from "./src/adapters/bb/mini-app-agent.ts";
import { historyMessageChangedChannel, privateCallChangedChannel } from "./src/core/contract.ts";
import { privateCallPython } from "./src/adapters/bb/private-call-engine.ts";
import { privateCallFrameRoute, registerPrivateCallFrames } from "./src/adapters/bb/private-call-frames.ts";
import { channelInboxMessageChannel, channelInboxTopicsChangedChannel } from "./src/core/contract.ts";
import { downloadActivityChannel, downloadProgressChannel, type DownloadQueueProgress } from "./src/core/contract.ts";
import type { ZodType } from "zod";
import { omitUndefinedRpcFields } from "./src/adapters/bb/rpc-wire.ts";
import { createMiniAppSecureStorage } from "./src/adapters/bb/mini-app-secure-storage.ts";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlerContext, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { communityChangedChannel, contactBirthdaysChangedChannel, deviceSignInsChangedChannel, agentHistoryGrants, accountAutoMediaOverrides, accountAutoPlaybackOverrides, autoPlaybackPolicy, defaultAutoPlaybackPolicy, readableAutoMediaPolicy, defaultAutoMediaPolicy, type AutoMediaLimits, cacheLimitMiB, cacheRetentionDays, chatActivityChannel, groupOnlineChannel, peerPresenceChannel, chatChangedChannel, defaultCacheLimitMiB, messageNotificationChannel, messagesDeletedChannel, storyDeletedChannel, storyFeedChangedChannel, storyStealthChangedChannel, schemas, type AgentAccess, type Auth } from "./src/core/contract.ts";
import { miniAppClosedChannel } from "./src/core/contract.ts";
import { historyChatsForAccount, replaceAccountHistoryGrants } from "./src/core/agent-read.ts";
import { telegramAccountSelection, type TelegramAccountSelection } from "./src/core/contract.ts";
import { createMiniAppDeviceStorage, miniAppDeviceStorageMigration, createMiniAppLocationAccess, miniAppLocationAccessMigration } from "./src/adapters/bb/mini-app-device-storage.ts";
import { channelPostReceiptMigrations, createChannelPostReceipts } from "./src/adapters/bb/channel-post-receipts.ts";
import { readCredentials } from "./src/adapters/bb/credentials.ts";
import { inspectTgsUpload } from "./src/adapters/bb/tgs-sticker.ts";
import { registerDocumentUploads } from "./src/adapters/bb/document-uploads.ts";
import { registerStoryMedia } from "./src/adapters/bb/story-media.ts";
import { registerChatExports } from "./src/adapters/bb/chat-export.ts";
import { registerDocumentDownloads } from "./src/adapters/bb/document-downloads.ts";
import { createApprovalQueue } from "./src/adapters/bb/approval-queue.ts";
import { createReplyTokens } from "./src/adapters/bb/reply-tokens.ts";
import { agentFindChatsTool, agentFindTopicsTool, agentSearchMessagesTool, agentHistoryTool, registerAgentHistory, registerAgentRead } from "./src/adapters/bb/agent-read.ts";
import { agentSendTool, registerAgentSend } from "./src/adapters/bb/agent-send.ts";
import { createTelegramAgentCli } from "./src/adapters/bb/agent-cli.ts";
import { findTdjsonLibrary } from "./src/adapters/bb/tdjson.ts";
import { createTelegram } from "./src/adapters/bb/telegram.ts";
import { createPrivateHistory, privateHistoryMigration, privateMediaMigration } from "./src/adapters/bb/private-history.ts";

export const rpcContract = defineRpcContract(schemas);

function guard(context: ExperimentalPluginRpcHandlerContext) {
  if (context.experimental_caller.kind !== "client") {
    throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Open the Telegram page in BB." });
  }
}

export default async function activate(bb: BbPluginApi) {
  const settings = bb.settings.define({
    language: { type: "select", label: "Telegram interface language / Язык интерфейса Telegram", default: "auto",
      options: ["auto", "ru", "en"], experimental_optionLabels: { auto: "System / Как в системе", ru: "Русский", en: "English" } },
    defaultTranslationLanguage: { type: "string", label: "Telegram default translation language", default: "auto" },
    agentReadOwnNotes: { type: "boolean", label: "Legacy approval for reading my original Telegram messages", default: false },
    agentHistoryChats: { type: "string", label: "Telegram chat AI permissions", default: "", secret: true },
    agentSend: { type: "boolean", label: "Allow agents to request Telegram sends", default: false },
    autoMediaPolicy: { type: "string", label: "Telegram automatic media limits", default: "" },
    autoPlaybackPolicy: { type: "string", label: "Telegram automatic playback limits", default: "" },
    autoPlaybackOverrides: { type: "string", label: "Telegram automatic playback exceptions", default: "" },
    autoMediaOverrides: { type: "string", label: "Telegram automatic media exceptions", default: "" },
    cacheLimitMiB: { type: "number", label: "Telegram media cache limit (MiB)", default: defaultCacheLimitMiB, experimental_schema: cacheLimitMiB },
    cacheRetentionDays: { type: "number", label: "Telegram media cache retention (days)", default: 0, experimental_schema: cacheRetentionDays },
    tdlibPath: { type: "string", label: "Path to libtdjson on the BB server", default: "" },
    credentialsFile: { type: "string", label: "Path to the private Telegram API credentials file on the BB server", default: "" },
    sessionKey: { type: "string", label: "TDLib database key", secret: true },
    telegramAccounts: { type: "string", label: "Telegram account selection", default: "", secret: true },
  });
  const savedAccounts = (await settings.get()).telegramAccounts;
  let accounts: TelegramAccountSelection = savedAccounts
    ? telegramAccountSelection.parse(JSON.parse(savedAccounts))
    : { selected: "primary", accounts: [{ id: "primary", label: "Primary account" }] };
  function accountSelectionView() {
    return { selected: accounts.selected, accounts: accounts.accounts.map(({ id, label }) => ({ id, label })) };
  }
  const replyTokens = createReplyTokens();
  const approvals = createApprovalQueue();
  const permissions = { read: new AbortController(), send: new AbortController(), history: new AbortController() };
  let scopeChanges: Promise<unknown> = Promise.resolve();
  function historyGrants(value?: string) {
    try {
      const result = agentHistoryGrants.safeParse(JSON.parse(value || "null"));
      if (result.success) return result.data;
    } catch {
      // Invalid or absent settings grant no access.
    }
    return [];
  }
  async function allowedChats(current: ReturnType<typeof createTelegram>) {
    const grants = historyGrants((await settings.get()).agentHistoryChats);
    if (!grants.length) return [];
    return historyChatsForAccount(grants, await current.accountId());
  }
  function revoke(capability: keyof typeof permissions) {
    permissions[capability].abort();
    permissions[capability] = new AbortController();
    replyTokens.clear();
  }
  let configuredAccess: AgentAccess | undefined;
  settings.onChange((next, previous) => {
    configuredAccess = { read: next.agentReadOwnNotes === true, send: next.agentSend === true, history: historyGrants(next.agentHistoryChats).some(({ chatIds }) => chatIds.length > 0) };
    if (previous.agentReadOwnNotes && !next.agentReadOwnNotes) revoke("read");
    if (previous.agentSend && !next.agentSend) revoke("send");
    if (previous.agentHistoryChats !== next.agentHistoryChats) {
      revoke("history");
      revoke("read");
    }
  });
  async function agentAccess(requireIdentity = true) {
    const config = await settings.get();
    const history = historyGrants(config.agentHistoryChats);
    const flags = { read: config.agentReadOwnNotes === true, send: config.agentSend === true,
      history: history.some(({ chatIds }) => chatIds.length > 0) };
    if (!requireIdentity || accounts.accounts.length === 1) return flags;
    const current = switchingAccount || signingOut ? undefined : session;
    if (current?.status().state !== "ready") return { read: false, send: false, history: false };
    const accountId = await current.accountId().catch(() => undefined);
    if (!accountId || current !== session || switchingAccount || signingOut) return { read: false, send: false, history: false };
    const agent = accounts.accounts.find(({ id }) => id === accounts.selected)?.agent;
    const allowed = agent?.accountId === accountId;
    return { read: allowed && agent.read && flags.read, send: allowed && agent.send && flags.send,
      history: historyChatsForAccount(history, accountId).length > 0 };
  }
  const miniAppAgent = createMiniAppAgent();
  let session: ReturnType<typeof createTelegram> | undefined;
  let connectionId: string | undefined;
  const transcriptions = new Map<string, { session: NonNullable<typeof session>; chatId: string; messageId: string;
    expires: number; controller: AbortController; started: boolean }>();
  function clearTranscriptions() {
    for (const job of transcriptions.values()) job.controller.abort();
    transcriptions.clear();
  }
  const requestConnection = new AsyncLocalStorage<string>();
  function checkConnection(expected = requestConnection.getStore()) {
    if (expected && (expected !== connectionId || !session || signingOut || stopping || switchingAccount)) {
      throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram connection changed. Open the chat again." });
    }
  }
  function selectedAccountLabel() {
    const selected = accounts.accounts.find(({ id }) => id === accounts.selected);
    return selected && (accounts.accounts.length > 1 || selected.label !== "Primary account") ? selected.label : undefined;
  }

  const draftScopes = new Map<string, string>();
  let navigationKey: string | undefined;
  async function authView(auth: Auth): Promise<Auth> {
    const connection = connectionId;
    const current = session;
    if (!connection) return auth;
    if (auth.state !== "ready" || !current) return { ...auth, connectionId: connection };
    const selected = accounts.accounts.find(({ id }) => id === accounts.selected);
    const accountLabel = selectedAccountLabel();
    const accountId = await current.accountId(AbortSignal.timeout(1200)).catch(() => undefined);
    if (connection !== connectionId || session !== current || current.status().state !== "ready") return { state: "disconnecting" };
    let draftScope: string | undefined;
    let navigationScope: string | undefined;
    if (accountId && selected) {
      const key = `${selected.id}:${accountId}`;
      draftScope = draftScopes.get(key) ?? randomUUID();
      if (!draftScopes.has(key) && draftScopes.size >= 16) draftScopes.delete(draftScopes.keys().next().value!);
      draftScopes.set(key, draftScope);
      if (navigationKey) navigationScope = createHmac("sha256", Buffer.from(navigationKey, "base64"))
        .update(`makosh-telegram/navigation/${key}`).digest("hex");
    }
    return { ...auth, connectionId: connection, ...(accountLabel ? { accountLabel } : {}), ...(draftScope ? { draftScope } : {}),
      ...(navigationScope ? { navigationScope } : {}) };
  }
  const uploads = registerDocumentUploads(bb, () => session);
  registerPrivateCallFrames(bb, () => session?.privateCalls);
  const chatExports = registerChatExports(bb, () => session);
  const downloads = registerDocumentDownloads(bb, () => session);
  const storyMedia = registerStoryMedia(bb, () => session, Date.now,
    (current, id, story, fileId) => downloads.issueStoryVideo(current, id, story, fileId));
  let starting: Promise<Auth> | undefined;
  let stopping: Promise<Auth> | undefined;
  let signingOut: Promise<Auth> | undefined;
  let switchingAccount: Promise<Auth> | undefined;
  let generation = 0;
  let disposed = false;
  let error: Auth | undefined;
  let notification: ReturnType<typeof setTimeout> | undefined;
  function notifyChatChanged() {
    if (disposed || notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      if (!disposed) bb.realtime.publish(chatChangedChannel, {});
    }, 700);
  }

  async function start(): Promise<Auth> {
    const attempt = generation;
    if (session && session.status().state !== "error") return authView(session.status());
    if (session) await session.close();
    session = undefined;
    connectionId = undefined;
    if (disposed || attempt !== generation) return { state: "idle" };
    error = undefined;
    if (process.platform !== "darwin") return error = { state: "error", message: "Makosh Telegram requires a Mac running the BB server." };
    const { tdlibPath, credentialsFile } = await settings.get();
    const library = findTdjsonLibrary(process.env.MAKOSH_TDJSON_PATH || tdlibPath || undefined);
    if (!library) {
      return error = { state: "error", message: "Install TDLib on the Mac running BB, or set MAKOSH_TDJSON_PATH to libtdjson.dylib." };
    }
    if (!existsSync("/usr/bin/python3")) {
      return error = { state: "error", message: "The BB server needs Python 3 at /usr/bin/python3 to run TDLib." };
    }
    let credentials;
    try { credentials = readCredentials(process.env.MAKOSH_TELEGRAM_CREDENTIALS_FILE || credentialsFile || undefined); }
    catch { return error = { state: "error", message: "Set MAKOSH_TELEGRAM_CREDENTIALS_FILE to a valid private Makosh credential file on the BB server." }; }

    try {
      let { sessionKey } = await settings.get();
      if (!sessionKey) {
        sessionKey = randomBytes(32).toString("base64");
        await settings.experimental_set({ sessionKey });
      }
      if (!/^[A-Za-z0-9+/]{43}=$/.test(sessionKey)) throw new Error("Invalid session key");
      if (disposed || attempt !== generation) return { state: "idle" };
      navigationKey = sessionKey;
      const database = bb.storage.database();
      const selected = accounts.selected;
      const directory = join(dirname(database.name), selected === "primary" ? "tdlib" : `tdlib-${selected}`);
      const key = selected === "primary" ? sessionKey : createHmac("sha256", Buffer.from(sessionKey, "base64"))
        .update(`makosh-telegram/tdlib/${selected}`).digest("base64");
      bb.storage.migrate(database, [...channelPostReceiptMigrations, privateHistoryMigration, privateMediaMigration, miniAppDeviceStorageMigration, miniAppLocationAccessMigration, embedMigration]);
      const channelPosts = createChannelPostReceipts(database, sessionKey);
      const privateHistory = createPrivateHistory(database, sessionKey);
      const miniAppStorage = createMiniAppDeviceStorage(database);
      const miniAppSecureStorage = createMiniAppSecureStorage(directory);
      const miniAppLocation = createMiniAppLocationAccess(database);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      chmodSync(directory, 0o700);
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingProgress: DownloadQueueProgress | undefined;
      const flushDownloadProgress = () => {
        progressTimer = undefined;
        if (!disposed && generation === attempt && connectionId && pendingProgress) {
          bb.realtime.publish(downloadProgressChannel, { connectionId, progress: pendingProgress });
        }
        pendingProgress = undefined;
      };
      session = createTelegram({ ...credentials, library, directory, key, channelPosts, privateHistory, miniAppStorage, miniAppSecureStorage,
        callsPython: privateCallPython(), notifyPrivateCallChanged: () => {
          if (!disposed && generation === attempt) bb.realtime.publish(privateCallChangedChannel, {});
        },
        withMediaCacheTransfer: downloads.withCacheTransfer,
        miniAppLocation, notifyHistoryMessageChanged: (event) => {
          if (!disposed && generation === attempt && connectionId) {
            bb.realtime.publish(historyMessageChangedChannel, { connectionId, ...event });
          }
        }, notifyInboxMessage: (event) => {
          if (!disposed && generation === attempt) bb.realtime.publish(channelInboxMessageChannel, event);
        }, notifyInboxTopicsChanged: (id) => {
          if (!disposed && generation === attempt) bb.realtime.publish(channelInboxTopicsChangedChannel, { id });
        }, notifyContactBirthdaysChanged: () => {
          if (!disposed && generation === attempt) bb.realtime.publish(contactBirthdaysChangedChannel, {});
        }, notifyCommunityChanged: () => {
          if (!disposed && generation === attempt) bb.realtime.publish(communityChangedChannel, {});
        }, notifyStoryFeedChanged: () => {
          if (!disposed && generation === attempt) bb.realtime.publish(storyFeedChangedChannel, {});
        }, notifyStoryStealthChanged: (times) => {
          if (!disposed && generation === attempt) bb.realtime.publish(storyStealthChangedChannel, times);
        }, notifyDeviceSignInsChanged: () => {
          if (!disposed && generation === attempt) bb.realtime.publish(deviceSignInsChangedChannel, {});
        }, notifyDownloadCounts: (counts) => {
          if (!disposed && generation === attempt && connectionId) bb.realtime.publish(downloadActivityChannel, { connectionId, counts });
        }, notifyDownloadProgress: (progress) => {
          pendingProgress = progress;
          if (progress.downloadedBytes === progress.totalBytes) {
            clearTimeout(progressTimer);
            flushDownloadProgress();
          } else progressTimer ??= setTimeout(flushDownloadProgress, 250);
        }, notifyMiniAppClosed: (session) => {
          miniAppAgent.remove(session);
          if (!disposed && generation === attempt) bb.realtime.publish(miniAppClosedChannel, { session });
        } }, undefined, notifyChatChanged, (event) => {
        if (!disposed && generation === attempt) {
          bb.realtime.publish(messagesDeletedChannel, { ...event, connectionId });
        }
      }, (event) => {
        if (!disposed && generation === attempt && connectionId) {
          bb.realtime.publish(messageNotificationChannel, { connectionId, event });
        }
      }, (target) => {
        if (!disposed && generation === attempt) bb.realtime.publish(storyDeletedChannel, target);
      }, (activity) => {
        if (!disposed && generation === attempt) bb.realtime.publish(chatActivityChannel, activity);
      }, (presence) => {
        if (!disposed && generation === attempt) bb.realtime.publish(peerPresenceChannel, presence);
      }, (presence) => {
        if (!disposed && generation === attempt) bb.realtime.publish(groupOnlineChannel, presence);
      });
      connectionId = randomUUID();
      return authView(session.status());
    } catch {
      return error = { state: "error", message: "Could not prepare the local Telegram session." };
    }
  }

  function disconnect(): Promise<Auth> {
    miniAppAgent.clear();
    if (stopping) return stopping;
    generation++;
    revoke("read");
    revoke("send");
    revoke("history");
    storyMedia.clear();
    clearTranscriptions();
    chatExports.clear();
    downloads.clear();
    uploads.clear();
    clearTimeout(notification);
    notification = undefined;
    const previous = session;
    session = undefined;
    connectionId = undefined;
    error = undefined;
    stopping = (async (): Promise<Auth> => {
      try {
        await starting;
        await previous?.close();
      } finally {
        stopping = undefined;
      }
      return { state: "idle" };
    })();
    return stopping;
  }

  function connectCurrent() {
    starting ??= requestConnection.exit(start).finally(() => { starting = undefined; });
    return starting;
  }

  bb.onDispose(async () => {
    disposed = true;
    clearInterval(cacheTimer);
    await switchingAccount?.catch(() => {});
    await disconnect();
  });
  function connected() {
    checkConnection();
    if (signingOut || switchingAccount || !session || session.status().state !== "ready") {
      throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Connect Telegram first." });
    }
    return session;
  }

  async function startQueuedDownload(work: (current: ReturnType<typeof createTelegram>) => Promise<boolean>) {
    const current = connected();
    return await downloads.withCacheTransfer(async (signal) =>
      !signal.aborted && connected() === current && await work(current)) ?? false;
  }

  function proxySession() {
    checkConnection();
    if (signingOut || switchingAccount || !session || ["idle", "error", "disconnecting"].includes(session.status().state)) {
      throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Start connecting to Telegram first." });
    }
    return session;
  }

  let cacheWork: Promise<unknown> | undefined;
  function withCache<T>(work: (current: ReturnType<typeof createTelegram>) => Promise<T>) {
    const current = connected();
    const result = (cacheWork ?? Promise.resolve()).then(() => {
      if (connected() !== current) throw new Error("Telegram session changed.");
      return work(current);
    });
    const pending = result.catch(() => {});
    cacheWork = pending;
    void pending.then(() => { if (cacheWork === pending) cacheWork = undefined; });
    return result;
  }
  async function configuredCachePolicy(snapshot?: Awaited<ReturnType<typeof settings.get>>) {
    const values = snapshot ?? await settings.get();
    return {
      limitMiB: cacheLimitMiB.safeParse(values.cacheLimitMiB).data ?? defaultCacheLimitMiB,
      retentionDays: cacheRetentionDays.safeParse(values.cacheRetentionDays).data ?? 0,
    };
  }
  async function configuredAutoMedia(snapshot?: Awaited<ReturnType<typeof settings.get>>) {
    const values = snapshot ?? await settings.get();
    try {
      return readableAutoMediaPolicy.safeParse(JSON.parse(values.autoMediaPolicy || "")).data ?? defaultAutoMediaPolicy;
    } catch {
      return defaultAutoMediaPolicy;
    }
  }
  type ChatRuleKey = "autoMediaOverrides" | "autoPlaybackOverrides";
  type AccountChatRules<T> = Record<string, Record<string, T>>;
  function parseChatRules<T>(value: string, schema: ZodType<AccountChatRules<T>>): AccountChatRules<T> {
    try {
      return schema.safeParse(JSON.parse(value)).data ?? {};
    } catch {
      return {};
    }
  }

  async function readChatRules<T>(key: ChatRuleKey, schema: ZodType<AccountChatRules<T>>) {
    const current = connected();
    const [account, values] = await Promise.all([current.accountId(), settings.get()]);
    if (connected() !== current) throw new Error("Telegram session changed.");
    return parseChatRules(values[key], schema)[account] ?? {};
  }

  let chatRuleWrites = Promise.resolve();
  function writeChatRule<T>(key: ChatRuleKey, schema: ZodType<AccountChatRules<T>>, id: string, limits: T | null) {
    const current = connected();
    const change = chatRuleWrites.then(async () => {
      if (connected() !== current) throw new Error("Telegram session changed.");
      const [account, values, chat] = await Promise.all([
        current.accountId(), settings.get(), current.chatById(id),
      ]);
      if (!chat || chat.id !== id || connected() !== current) throw new Error("Telegram chat is unavailable.");
      const overrides = parseChatRules(values[key], schema);
      const selected = { ...overrides[account] };
      if (limits === null) delete selected[id];
      else selected[id] = limits;
      if (Object.keys(selected).length) overrides[account] = selected;
      else delete overrides[account];
      await settings.experimental_set({ [key]: JSON.stringify(overrides) });
      return limits;
    });
    chatRuleWrites = change.then(() => {}, () => {});
    return change;
  }
  const lastAgeCleanup = new WeakMap<ReturnType<typeof createTelegram>, { days: number; at: number }>();
  async function trimCache(current: ReturnType<typeof createTelegram>, { limitMiB, retentionDays }: { limitMiB: number; retentionDays: number }, includeChats = false) {
    const limitBytes = limitMiB * 1024 * 1024;
    const last = lastAgeCleanup.get(current);
    const now = Date.now();
    const ageDue = retentionDays && (last?.days !== retentionDays || now - last.at >= 3_600_000);
    if (!retentionDays) lastAgeCleanup.delete(current);
    const usage = await current.cacheUsage(includeChats);
    if (!ageDue && usage.bytes <= limitBytes) return usage;
    const cleaned = await downloads.cleanCache(() => current.optimizeCache(limitBytes, { includeChats, retentionDays }));
    if (!cleaned) return { ...usage, cleanupDeferred: true as const };
    if (retentionDays) lastAgeCleanup.set(current, { at: now, days: retentionDays });
    return cleaned;
  }
  const cacheTimer = setInterval(() => {
    if (disposed || cacheWork || signingOut || stopping || switchingAccount || session?.status().state !== "ready") return;
    void withCache(async (current) => {
      const policy = await configuredCachePolicy();
      if (connected() !== current) return;
      return trimCache(current, policy);
    }).catch(() => {});
  }, 60_000);
  cacheTimer.unref?.();
  async function safe<T>(work: Promise<T>, message: string): Promise<T> {
    try { return await work; }
    catch { throw new experimental_PluginRpcRefusal({ code: "invalid", message }); }
  }

  const initialAccess = await agentAccess(false);
  configuredAccess ??= initialAccess;
  const agentSession = () => signingOut || switchingAccount ? undefined : session;
  const readPreview = registerAgentRead(bb, async () => (await agentAccess()).read,
    agentSession, replyTokens, () => permissions.read.signal, approvals, allowedChats);
  const agentCli = createTelegramAgentCli(bb);
  registerAgentHistory({ agents: agentCli }, allowedChats, agentSession, () => permissions.history.signal, replyTokens);
  miniAppAgent.register(agentCli.registerTool, (token) => agentSession()?.hasMiniAppSession(token) === true);
  registerAgentSend({ agents: agentCli, ui: bb.ui }, async () => (await agentAccess()).send, agentSession, replyTokens,
    () => permissions.send.signal, approvals, () => permissions.read.signal, selectedAccountLabel, allowedChats);
  agentCli.publish();

  bb.agents.configure(() => ({
    tools: [
      agentFindChatsTool, agentFindTopicsTool, agentSearchMessagesTool, agentHistoryTool, miniAppAgentTool,
      ...(configuredAccess?.send ? [agentSendTool] : []),
    ],
    skills: [],
  }));

  function embedDenied(): never {
    throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Open an available Telegram conversation again." });
  }
  let resourceStore: ReturnType<typeof embedResources> | undefined;
  async function embedOwner() {
    if (!requestConnection.getStore()) return embedDenied();
    const current = connected();
    const account = JSON.stringify([accounts.selected, await current.accountId()]);
    if (connected() !== current) return embedDenied();
    resourceStore ??= embedResources(bb.storage.database());
    return { current, account, store: resourceStore };
  }
  async function resolveEmbed(resourceRef: string) {
    const { current, account, store } = await embedOwner();
    const location = store.resolve(account, resourceRef);
    if (!location) return embedDenied();
    const target = await current.resumeConversation(location.id, "main", location.topicId);
    if (connected() !== current || !target || target.chat.id !== location.id || target.topic?.id !== location.topicId) return embedDenied();
    return target;
  }

  const handlers: ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> = {
    setLanguagePreference: async ({ kind, value }, context) => {
      guard(context);
      if (kind === "interface") await settings.experimental_set({ language: value });
      else await settings.experimental_set({ defaultTranslationLanguage: value });
      return null;
    },
    readPreview: ({ requestId, id }, context) => { guard(context); return safe(readPreview(requestId, id), "This review is no longer available."); },
    runtimeInfo: (_, context) => { guard(context); return safe(connected().runtimeInfo(), "Could not read the Telegram runtime version."); },
    removeProfilePhoto: ({ expected }, context) => {
      guard(context); return safe(connected().removeProfilePhoto(expected), "Could not remove the profile photo.");
    },
    publicProfilePhoto: (_, context) => { guard(context); return safe(connected().publicProfilePhoto(), "Could not load the public profile photo."); },
    savePublicProfilePhoto: ({ expected, base64 }, context) => {
      guard(context); return safe(connected().changePublicProfilePhoto(expected, base64), "Could not save the public profile photo.");
    },
    removePublicProfilePhoto: ({ expected }, context) => {
      guard(context); return safe(connected().changePublicProfilePhoto(expected), "Could not remove the public profile photo.");
    },
    saveProfilePhoto: ({ base64, expected }, context) => {
      guard(context); return safe(connected().saveProfilePhoto(base64, expected), "Could not update the profile photo.");
    },
    saveProfileVideo: ({ base64, expected, coverSeconds, trim }, context) => {
      guard(context); return safe(connected().saveProfileVideo(base64, expected, coverSeconds, trim), "Could not update the profile video.");
    },
    ownProfilePhotos: ({ offset }, context) => { guard(context); return safe(connected().ownProfilePhotos(offset), "Could not load your Telegram photos."); },
    ownProfilePhoto: ({ offset, photoId }, context) => { guard(context); return safe(connected().ownProfilePhoto(offset, photoId), "Could not load your Telegram photo."); },
    restoreProfilePhoto: ({ offset, photoId, expected }, context) => { guard(context); return safe(connected().restoreProfilePhoto(offset, photoId, expected), "Could not restore the Telegram profile photo."); },
    removePreviousProfilePhoto: ({ offset, photoId, expected }, context) => { guard(context); return safe(connected().removePreviousProfilePhoto(offset, photoId, expected), "Could not remove that Telegram profile photo."); },
    telegramProfile: (_, context) => { guard(context); return safe(connected().telegramProfile(), "Could not load your Telegram profile."); },
    personalChannelSettings: (_, context) => {
      guard(context); return safe(connected().personalChannelSettings(), "Could not load personal channels.");
    },
    savePersonalChannel: (change, context) => {
      guard(context); return safe(connected().savePersonalChannel(change), "Telegram did not change your personal channel.");
    },
    temporaryProfileLink: (_, context) => {
      guard(context);
      const current = connected();
      return safe(current.temporaryProfileLink().then((link) => connected() === current ? link : null),
        "Could not generate a temporary Telegram profile link.");
    },
    checkTelegramUsername: ({ username }, context) => { guard(context); return safe(connected().checkTelegramUsername(username), "Could not check this Telegram username."); },
    chatEmojiChoices: ({ id }, context) => {
      guard(context); return safe(connected().chatEmojiChoices(id), "Could not load chat emoji statuses.");
    },
    saveChatEmojiStatus: ({ id, ...change }, context) => {
      guard(context); return safe(connected().saveChatEmojiStatus(id, change), "Could not update the chat emoji status.");
    },
    profileEmojiChoices: (_, context) => {
      guard(context); return safe(connected().profileEmojiChoices(), "Could not load Telegram emoji statuses.");
    },
    messageEmojiStatus: ({ emoji }, context) => {
      guard(context); return safe(connected().messageEmojiStatus(emoji), "Could not review this Telegram emoji status.");
    },
    saveMessageEmojiStatus: (change, context) => {
      guard(context); return safe(connected().saveMessageEmojiStatus(change), "Could not update your Telegram emoji status.");
    },
    saveProfileEmojiStatus: (change, context) => {
      guard(context); return safe(connected().saveProfileEmojiStatus(change), "Could not update your Telegram emoji status.");
    },
    saveTelegramProfile: (change, context) => { guard(context); return safe(connected().saveTelegramProfile(change), "Telegram did not update your profile."); },
    telegramPrivacy: ({ key }, context) => { guard(context); return safe(connected().telegramPrivacy(key), "Could not load Telegram privacy."); },
    chatAutoDelete: ({ id }, context) => {
      guard(context); return safe(connected().chatAutoDelete(id), "Could not load the chat timer.");
    },
    saveChatAutoDelete: ({ id, days, expected }, context) => {
      guard(context); return safe(connected().saveChatAutoDelete(id, days, expected), "Could not save the chat timer.");
    },
    clearChatDateScopes: ({ id }, context) => {
      guard(context); return safe(connected().clearChatDateScopes(id), "Could not check whether Telegram allows clearing this history.");
    },
    clearChatByDate: ({ id, range, scope }, context) => {
      guard(context); return connected().clearChatByDate(id, range, scope);
    },
    defaultAutoDeleteDays: (_input, context) => {
      guard(context); return safe(connected().defaultAutoDeleteDays(), "Could not load the default auto-delete timer.");
    },
    saveDefaultAutoDeleteDays: ({ days, expected }, context) => {
      guard(context); return safe(connected().saveDefaultAutoDeleteDays(days, expected), "Could not save the default auto-delete timer.");
    },
    archiveSettings: (_input, context) => {
      guard(context); return safe(connected().archiveSettings(), "Could not load archive settings.");
    },
    saveArchiveSettings: ({ values, expected }, context) => {
      guard(context); return safe(connected().saveArchiveSettings(values, expected), "Could not save archive settings.");
    },
    newChatPrivacy: (_, context) => { guard(context); return safe(connected().newChatPrivacy(), "Could not load new chat privacy."); },
    saveNewChatPrivacy: ({ audience, expected }, context) => {
      guard(context); return safe(connected().saveNewChatPrivacy(audience, expected), "Telegram did not save new chat privacy.");
    },
    sensitiveContentSettings: (_input, context) => {
      guard(context); return safe(connected().sensitiveContentSettings(), "Could not load sensitive content settings.");
    },
    saveSensitiveContentSettings: ({ show, expected }, context) => {
      guard(context); return safe(connected().saveSensitiveContentSettings(show, expected), "Could not save sensitive content settings.");
    },
    readDatePrivacy: (_input, context) => { guard(context); return safe(connected().readDatePrivacy(), "Could not load read time privacy."); },
    saveReadDatePrivacy: ({ show, expected }, context) => {
      guard(context); return safe(connected().saveReadDatePrivacy(show, expected), "Telegram did not save read time privacy.");
    },
    privacyExceptions: ({ key, offset, version }, context) => {
      guard(context); return safe(connected().privacyExceptions(key, offset, version), "Could not load Telegram privacy exceptions.");
    },
    searchPrivacyExceptionTargets: ({ query }, context) => {
      guard(context); return safe(connected().searchPrivacyExceptionTargets(query), "Could not search Telegram privacy targets.");
    },
    changePrivacyException: (change, context) => {
      guard(context); return safe(connected().changePrivacyException(change), "Telegram did not update this privacy exception.");
    },
    changePremiumInvites: ({ version, allowed }, context) => {
      guard(context); return safe(connected().changePremiumInvites(version, allowed), "Telegram did not update the Premium invitation exception.");
    },
    saveTelegramPrivacy: ({ key, audience, expected }, context) => { guard(context); return safe(connected().saveTelegramPrivacy(key, audience, expected), "Telegram did not save privacy settings."); },
    activeDevices: (_, context) => { guard(context); return safe(connected().activeDevices(), "Could not load Telegram devices."); },
    pendingDeviceSignIns: (_, context) => {
      guard(context); return safe(connected().pendingDeviceSignIns(), "Could not check for unconfirmed Telegram sign-ins.");
    },
    confirmDevice: ({ id, revision }, context) => {
      guard(context); return safe(connected().confirmDevice(id, revision), "Could not confirm this Telegram session.");
    },
    terminateOtherDevices: ({ expected }, context) => {
      guard(context); return safe(connected().terminateOtherDevices(expected), "Could not terminate Telegram sessions.");
    },
    sessionInactivity: (_, context) => { guard(context); return connected().sessionInactivity(); },
    setSessionInactivity: ({ days, expected }, context) => { guard(context); return connected().setSessionInactivity(days, expected); },
    incomingCalls: (_, context) => { guard(context); return safe(connected().incomingCalls(), "Could not load incoming call settings."); },
    setIncomingCalls: ({ enabled, expected }, context) => {
      guard(context); return safe(connected().setIncomingCalls(enabled, expected), "Could not save incoming call settings.");
    },
    privateCallStatus: (query, context) => {
      guard(context);
      const status = connected().privateCalls.status(query?.cameraClient);
      return { ...status, frameRoute: `/api/v1/plugins/${bb.pluginId}/http${privateCallFrameRoute}` };
    },
    startPrivateCall: ({ chatId, video, cameraClient }, context) => {
      guard(context); return safe(connected().privateCalls.start(Number(chatId), video, cameraClient), "Could not start this Telegram call.");
    },
    actOnPrivateCall: ({ id, action, cameraClient }, context) => {
      guard(context); return safe(connected().privateCalls.act(id, action, cameraClient), "Could not update this Telegram call.");
    },
    terminateDevice: ({ id, application, device }, context) => { guard(context); return safe(connected().terminateDevice(id, application, device), "Telegram did not terminate this session."); },
    proxies: (_, context) => { guard(context); return safe(proxySession().proxies(), "Could not load Telegram proxies."); },
    saveProxy: ({ id, draft }, context) => { guard(context); return safe(proxySession().saveProxy(draft, id), "Could not save the Telegram proxy."); },
    changeProxy: (input, context) => {
      guard(context); return safe(proxySession().changeProxy(input.action, "id" in input ? input.id : undefined), "Could not change the Telegram proxy.");
    },
    pingProxy: ({ id }, context) => { guard(context); return safe(proxySession().pingProxy(id), "Telegram did not respond through that proxy."); },
    storyFeed: ({ list, more }, context) => { guard(context); return safe(connected().storyFeed(list, more), "Could not load Telegram stories."); },
    joinedCommunities: (_, context) => { guard(context); return safe(connected().joinedCommunities(), "Could not load Telegram communities."); },
    communityFolderMemberships: ({ id }, context) => {
      guard(context); return safe(connected().communityFolderMemberships(id), "Could not load the community's folders.");
    },
    changeCommunityFolder: (input, context) => {
      guard(context); return safe(connected().changeCommunityFolder(input), "Could not update the community's folder.");
    },
    folderCommunities: ({ id }, context) => {
      guard(context); return safe(connected().folderCommunities(id), "Could not load communities in this folder.");
    },
    collapsedCommunities: (_, context) => {
      guard(context); return safe(connected().collapsedCommunities(), "Could not load collapsed communities.");
    },
    changeCommunityCollapse: (input, context) => {
      guard(context); return safe(connected().changeCommunityCollapse(input), "Could not change the community layout.");
    },
    communityChats: ({ id }, context) => { guard(context); return safe(connected().communityChats(id), "Could not load community chats."); },
    communityForwardChats: ({ id }, context) => {
      guard(context); return safe(connected().communityForwardChats(id), "Could not load community recipients.");
    },
    unbanFromCommunityList: (input, context) => {
      guard(context); return safe(connected().unbanFromCommunityList(input), "Could not remove the community ban.");
    },
    communityBannedMembers: ({ id, offset }, context) => {
      guard(context);
      return safe(connected().communityBannedMembers(id, offset), "Could not load community bans.");
    },
    communityModerationCounts: ({ id }, context) => {
      guard(context);
      return safe(connected().communityModerationCounts(id), "Could not load community moderation counts.");
    },
    communitySourceChats: (_, context) => { guard(context); return safe(connected().communitySourceChats(), "Could not load chats eligible for a community."); },
    createCommunity: (input, context) => { guard(context); return safe(connected().createCommunity(input), "Could not create the Telegram community."); },
    renameCommunity: (input, context) => { guard(context); return safe(connected().renameCommunity(input), "Could not rename the Telegram community."); },
    deleteCommunity: (input, context) => { guard(context); return safe(connected().deleteCommunity(input), "Could not delete the Telegram community."); },
    changeCommunityPermissions: (input, context) => {
      guard(context); return safe(connected().changeCommunityPermissions(input), "Could not update community permissions.");
    },
    communityPhotoState: ({ id }, context) => { guard(context); return safe(connected().communityPhotoState(id), "Could not load the community photo."); },
    communityAvatar: ({ id, fileId }, context) => { guard(context); return safe(connected().communityAvatar(id, fileId), "Could not load the community avatar."); },
    communityAvatarVideoInfo: ({ id }, context) => {
      guard(context);
      return safe(connected().communityAvatarVideoInfo(id), "Could not load the community video avatar.");
    },
    communityAvatarVideo: ({ id, photoId, fileId }, context) => {
      guard(context);
      return safe(downloads.issueCommunityAvatarVideo(connected(), id, photoId, fileId), "Could not stream the community video avatar.");
    },
    saveCommunityVideo: ({ id, expected, base64, coverSeconds, trim }, context) => {
      guard(context); return safe(connected().saveCommunityVideo(id, expected, base64, coverSeconds, trim), "Could not save the community video avatar.");
    },
    saveCommunityPhoto: ({ id, expected, base64 }, context) => {
      guard(context); return safe(connected().changeCommunityPhoto(id, expected, base64), "Could not save the community photo.");
    },
    removeCommunityPhoto: ({ id, expected }, context) => {
      guard(context); return safe(connected().changeCommunityPhoto(id, expected), "Could not remove the community photo.");
    },
    communityNotificationState: ({ id }, context) => { guard(context); return safe(connected().communityNotificationState(id), "Could not load community notifications."); },
    changeCommunityNotification: (input, context) => { guard(context); return safe(connected().changeCommunityNotification(input), "Could not update community notifications."); },
    changeCommunityChat: (input, context) => { guard(context); return safe(connected().changeCommunityChat(input), "Could not update the community chat list."); },
    communityAddRequests: ({ id, offset }, context) => { guard(context); return safe(connected().communityAddRequests(id, offset), "Could not load community chat requests."); },
    decideCommunityAddRequests: (input, context) => { guard(context); return safe(connected().decideCommunityAddRequests(input), "Could not process the community request queue."); },
    decideCommunityAddRequest: (input, context) => { guard(context); return safe(connected().decideCommunityAddRequest(input), "Could not process the community chat request."); },
    ownArchivedStories: ({ id, before }, context) => {
      guard(context); return safe(connected().ownArchivedStories(id, before), "Could not load your Telegram story archive.");
    },
    resolveStoryAlbumLink: ({ url }, context) => {
      guard(context); return safe(connected().resolveStoryAlbumLink(url), "Could not open this Telegram story album link.");
    },
    storyAlbumLink: ({ id, album }, context) => {
      guard(context); return safe(connected().storyAlbumLink(id, album), "Could not copy this Telegram story album link.");
    },
    storyAlbums: ({ id }, context) => {
      guard(context); return safe(connected().storyAlbums(id), "Could not load Telegram story albums.");
    },
    storyAlbumPage: ({ id, album, offset }, context) => {
      guard(context); return safe(connected().storyAlbumPage(id, album, offset), "Could not load this Telegram story album.");
    },
    storyProfileEditable: ({ id }, context) => {
      guard(context); return safe(connected().storyProfileEditable(id), "Could not check Telegram story permissions.");
    },
    setProfileStoryOrder: ({ id, expected, order }, context) => {
      guard(context); return safe(connected().setProfileStoryOrder(id, expected, order), "Could not update pinned Telegram stories.");
    },
    setStoryAlbumOrder: ({ id, expected, order }, context) => {
      guard(context); return safe(connected().setStoryAlbumOrder(id, expected, order), "Could not reorder Telegram story albums.");
    },
    setStoryAlbumStoryOrder: ({ id, album, expected, order }, context) => {
      guard(context); return safe(connected().setStoryAlbumStoryOrder(id, album, expected, order), "Could not reorder Telegram album stories.");
    },
    storyAlbumCandidates: ({ id, archive, before }, context) => {
      guard(context); return safe(connected().storyAlbumCandidates(id, archive, before), "Could not load stories for the album.");
    },
    createStoryAlbum: ({ id, name, stories }, context) => {
      guard(context); return safe(connected().createStoryAlbum(id, name, stories), "Could not create the Telegram story album.");
    },
    changeStoryAlbum: ({ id, album, change }, context) => {
      guard(context); return safe(connected().changeStoryAlbum(id, album, change), "Could not update the Telegram story album.");
    },
    profileStories: ({ id, before }, context) => {
      guard(context); return safe(connected().profileStories(id, before), "Could not load Telegram profile stories.");
    },
    storyMusicPlayback: ({ id, story, fileId }, context) => {
      guard(context); return safe(downloads.issueStoryMusic(connected(), id, story, fileId), "Could not open Telegram story music.");
    },
    storyAreaPostLink: ({ id, story, post }, context) => {
      guard(context); return safe(connected().storyAreaPostLink(id, story, post), "Could not open the story post.");
    },
    storyView: ({ id, story }, context) => { guard(context); return safe(storyMedia.issue(connected(), id, story), "Could not open this Telegram story."); },
    reportStory: ({ id, story, step }, context) => {
      guard(context); return connected().reportStory(id, story, step);
    },
    replyToStory: ({ id, story, text }, context) => {
      guard(context); return connected().replyToStory(id, story, text);
    },
    resolveStoryLink: ({ url }, context) => {
      guard(context); return safe(connected().resolveStoryLink(url), "Could not open the Telegram story link.");
    },
    storyLink: ({ id, story }, context) => {
      guard(context); return safe(connected().storyLink(id, story), "Could not load the Telegram story link.");
    },
    storyInteractions: ({ id, story, offset, filter }, context) => {
      guard(context); return safe(connected().storyInteractions(id, story, offset, filter), "Could not load Telegram story activity.");
    },
    changeStoryAudience: ({ id, story, expected, audience }, context) => {
      guard(context); return safe(connected().changeStoryAudience(id, story, expected, audience), "Could not change the story audience.");
    },
    editStoryCaption: ({ id, story, expected, caption }, context) => {
      guard(context); return safe(connected().editStoryCaption(id, story, expected, caption), "Could not edit the story caption.");
    },
    manageStory: ({ id, story, action }, context) => {
      guard(context); return safe(connected().manageStory(id, story, action), "Could not update the Telegram story.");
    },
    storyViewing: ({ id, story, opened }, context) => {
      guard(context); return safe(connected().storyViewing(id, story, opened), "Could not update the Telegram story view.");
    },
    setStorySuggestedReaction: ({ id, story, reaction, remove }, context) => {
      guard(context); return safe(connected().setStorySuggestedReaction(id, story, reaction, remove), "Could not update the suggested story reaction.");
    },
    setStoryReaction: ({ id, story, emoji }, context) => {
      guard(context); return safe(connected().setStoryReaction(id, story, emoji), "Could not update the Telegram story reaction.");
    },
    storyReactionCatalog: ({ id, story }, context) => {
      guard(context); return safe(connected().storyReactionCatalog(id, story), "Could not load Telegram story reactions.");
    },
    setStoryCatalogReaction: ({ id, story, reaction }, context) => {
      guard(context); return safe(connected().setStoryCatalogReaction(id, story, reaction), "Could not update the Telegram story reaction.");
    },
    moveStoryAuthor: ({ id, from }, context) => {
      guard(context); return safe(connected().moveStoryAuthor(id, from), "Could not move the Telegram story author.");
    },
    storyStealthStatus: (_input, context) => {
      guard(context); return safe(connected().storyStealthStatus(), "Could not read Telegram story stealth mode.");
    },
    activateStoryStealth: (_input, context) => {
      guard(context); return safe(connected().activateStoryStealth(), "Could not enable Telegram story stealth mode.");
    },
    exportTelegramAccount: (options, context) => {
      guard(context);
      return safe(chatExports.issue(connected(), undefined, options), "Could not export this Telegram account.");
    },
    exportChat: ({ id, options }, context) => {
      guard(context);
      return safe(chatExports.issue(connected(), id, options), "Could not export this Telegram chat.");
    },
    aiHistoryExcerpt: ({ id }, context) => {
      guard(context);
      return safe((async () => {
        const current = connected();
        const page = await current.chatExportPage(id, 0, AbortSignal.timeout(20_000));
        if (connected() !== current) throw new Error("Telegram session changed.");
        return page.messages.flatMap(({ message }) => message && !message.service && !message.textIsLabel
          && !message.oneView && !message.retained && !message.restricted && message.text.trim()
          ? [{ author: message.author, text: message.text, timestamp: message.timestamp }] : []).slice(0, 20).reverse();
      })(), "Could not include this Telegram chat.");
    },
    saveSelectedAttachments: ({ id, ids, format }, context) => {
      guard(context);
      return safe(chatExports.issue(connected(), id, { format: format ?? "json", media: true }, ids), "Could not save the selected attachments.");
    },
    saveChannelInboxAttachments: ({ format, ...scope }, context) => {
      guard(context);
      return safe(chatExports.issueInboxAttachments(connected(), scope, format), "Could not save the selected channel inbox attachments.");
    },
    networkUsage: (_, context) => { guard(context); return safe(connected().networkUsage(), "Could not load Telegram network usage."); },
    businessChatLinks: (_, context) => { guard(context); return safe(connected().businessChatLinks(), "Could not load Business chat links."); },
    changeBusinessChatLink: (change, context) => {
      guard(context); return safe(connected().changeBusinessChatLink(change), "Could not confirm the Business chat link update.");
    },
    businessStartPage: (_, context) => { guard(context); return safe(connected().businessStartPage(), "Could not load the Business start page."); },
    businessLocation: (_, context) => { guard(context); return safe(connected().businessLocation(), "Could not load the Business location."); },
    businessHours: (_, context) => { guard(context); return safe(connected().businessHours(), "Could not load the Business hours."); },
    businessBot: (_, context) => { guard(context); return safe(connected().businessBot(), "Could not load the Business bot."); },
    confirmBusinessBot: ({ revision }, context) => {
      guard(context); return safe(connected().confirmBusinessBot(revision), "Could not confirm the Business bot connection.");
    },
    chatBusinessBot: ({ id }, context) => { guard(context); return safe(connected().chatBusinessBot(id), "Could not load the chat’s Business bot."); },
    changeChatBusinessBot: ({ id, action, revision }, context) => {
      guard(context); return safe(connected().changeChatBusinessBot(id, action, revision), "Could not update access for this chat.");
    },
    findBusinessBot: ({ username }, context) => {
      guard(context); return safe(connected().findBusinessBot(username), "Could not find the Business bot.");
    },
    saveBusinessBot: ({ connection, revision }, context) => {
      guard(context); return safe(connected().saveBusinessBot(connection, revision), "Could not update the Business bot.");
    },
    businessGreeting: (_, context) => { guard(context); return safe(connected().businessGreeting(), "Could not load the Business greeting."); },
    businessAway: (_, context) => { guard(context); return safe(connected().businessAway(), "Could not load the Business away message."); },
    saveBusinessAway: ({ away, revision }, context) => {
      guard(context); return safe(connected().saveBusinessAway(away, revision), "Could not save the Business away message.");
    },
    saveBusinessGreeting: ({ greeting, revision }, context) => {
      guard(context); return safe(connected().saveBusinessGreeting(greeting, revision), "Could not save the Business greeting.");
    },
    saveBusinessHours: ({ hours, revision }, context) => {
      guard(context); return safe(connected().saveBusinessHours(hours, revision), "Could not save the Business hours.");
    },
    saveBusinessLocation: ({ location, revision }, context) => {
      guard(context); return safe(connected().saveBusinessLocation(location, revision), "Could not save the Business location.");
    },
    saveBusinessStartPage: ({ title, message, revision, sticker }, context) => {
      guard(context); return safe(connected().saveBusinessStartPage(title, message, revision, sticker), "Could not save the Business start page.");
    },
    quickReplies: (input, context) => { guard(context); return safe(connected().quickReplies(input?.chatId), "Could not load Telegram quick replies."); },
    quickReplyMessages: ({ id }, context) => {
      guard(context); return safe(connected().quickReplyMessages(id), "Could not load quick reply messages.");
    },
    quickReplyPhoto: ({ id, messageId, fileId, size, pollSlot }, context) => {
      guard(context); return safe(connected().quickReplyPhoto(id, messageId, fileId, size, pollSlot), "Could not open the quick reply photo.");
    },
    quickReplyPollSticker: ({ id, messageId, reference }, context) => {
      guard(context); return safe(connected().quickReplyPollSticker(id, messageId, reference), "Could not open the quick reply poll sticker.");
    },
    quickReplyTgsSticker: ({ id, messageId, fileId }, context) => {
      guard(context); return safe(connected().quickReplyTgsSticker(id, messageId, fileId), "Could not open the quick reply sticker.");
    },
    quickReplyDocument: ({ id, messageId, fileId, pollSlot }, context) => {
      guard(context); return safe(downloads.issueQuickReplyDocument(connected(), id, messageId, fileId, pollSlot), "Could not download the quick reply document.");
    },
    quickReplyPlayback: ({ id, messageId, fileId, pollSlot }, context) => {
      guard(context); return safe(downloads.issueQuickReplyPlayback(connected(), id, messageId, fileId, pollSlot), "Could not open the quick reply media.");
    },
    editQuickReplyText: ({ id, messageId, revision, text, styles, links, captionAbove, spoiler }, context) => {
      guard(context); return safe(connected().editQuickReplyText(id, messageId, revision, text, styles, links, captionAbove, spoiler), "Could not edit the quick reply message.");
    },
    retryQuickReplyMessage: ({ id, name, messageId, revision }, context) => {
      guard(context); return safe(connected().retryQuickReplyMessage(id, name, messageId, revision), "Could not confirm the retry.");
    },
    deleteQuickReplyMessage: ({ id, messageId, revision, messageCount }, context) => {
      guard(context); return safe(connected().deleteQuickReplyMessage(id, messageId, revision, messageCount), "Could not delete the quick reply message.");
    },
    renameQuickReply: ({ id, expected, name }, context) => {
      guard(context); return safe(connected().renameQuickReply(id, expected, name), "Could not rename the quick reply.");
    },
    addQuickReplyText: ({ id, name, text, styles, links }, context) => {
      guard(context); return safe(connected().addQuickReplyText(name, text, id, styles, links), "Could not add the quick reply message.");
    },
    addQuickReplyContact: ({ id, name, contact }, context) => {
      guard(context); return safe(connected().addQuickReplyContact(name, contact, id), "Could not add the quick reply contact.");
    },
    addQuickReplyPoll: ({ id, name, draft }, context) => {
      guard(context); return safe(connected().addQuickReplyPoll(name, draft, id), "Could not add the quick reply poll.");
    },
    addQuickReplyLocation: ({ id, name, point, venue }, context) => {
      guard(context); return safe(connected().addQuickReplyLocation(name, point, id, venue), "Could not add the quick reply location.");
    },
    addQuickReplySticker: ({ id, name, packId, fileId }, context) => {
      guard(context); return safe(connected().addQuickReplySticker(name, packId, fileId, id), "Could not add the quick reply sticker.");
    },
    addQuickReplyPhoto: ({ id, name, caption, base64, styles, links, media }, context) => {
      guard(context); return safe(connected().addQuickReplyPhoto(name, caption, base64, id, styles, links, media), "Could not add the quick reply photo.");
    },
    addQuickReplyPhotoAlbum: ({ id, name, caption, photos, styles, links, media }, context) => {
      guard(context);
      return safe(connected().addQuickReplyPhotoAlbum(name, caption, photos, id, styles, links, media), "Could not add the quick reply album.");
    },
    deleteQuickReply: ({ id, name, messageCount }, context) => {
      guard(context); return safe(connected().deleteQuickReply(id, name, messageCount), "Could not delete the quick reply.");
    },
    reorderQuickReplies: ({ ids, expected }, context) => {
      guard(context); return safe(connected().reorderQuickReplies(ids, expected), "Could not reorder quick replies.");
    },
    sendQuickReply: ({ chatId, id, name, messageCount, preview }, context) => {
      guard(context); return safe(connected().sendQuickReply(chatId, id, name, messageCount, preview), "Could not confirm the quick reply.");
    },
    resetNetworkUsage: (_, context) => { guard(context); return safe(connected().resetNetworkUsage(), "Could not reset Telegram network usage."); },
    autoMediaPolicy: (_, context) => { guard(context); return configuredAutoMedia(); },
    setAutoMediaPolicy: async (policy, context) => {
      guard(context);
      connected();
      await settings.experimental_set({ autoMediaPolicy: JSON.stringify(policy) });
      return policy;
    },
    autoPlaybackPolicy: async (_, context) => {
      guard(context);
      const values = await settings.get();
      try {
        return autoPlaybackPolicy.safeParse(JSON.parse(values.autoPlaybackPolicy)).data ?? defaultAutoPlaybackPolicy;
      } catch {
        return defaultAutoPlaybackPolicy;
      }
    },
    setAutoPlaybackPolicy: async (policy, context) => {
      guard(context);
      connected();
      await settings.experimental_set({ autoPlaybackPolicy: JSON.stringify(policy) });
      return policy;
    },
    autoMediaOverrides: (_, context) => {
      guard(context);
      return safe(readChatRules("autoMediaOverrides", accountAutoMediaOverrides), "Could not load automatic media exceptions.");
    },
    setChatAutoMediaOverride: ({ id, limits }, context) => {
      guard(context);
      return safe(writeChatRule("autoMediaOverrides", accountAutoMediaOverrides, id, limits),
        "Could not save this chat's automatic media settings.");
    },
    autoPlaybackOverrides: (_, context) => {
      guard(context);
      return safe(readChatRules("autoPlaybackOverrides", accountAutoPlaybackOverrides), "Could not load automatic playback exceptions.");
    },
    setChatAutoPlaybackOverride: ({ id, limits }, context) => {
      guard(context);
      return safe(writeChatRule("autoPlaybackOverrides", accountAutoPlaybackOverrides, id, limits),
        "Could not save this chat's automatic playback settings.");
    },
    prefetchVisibleMedia: async ({ id, messageId, topicId }, context) => {
      guard(context);
      const current = connected();
      let account: Promise<string> | undefined;
      const loadPolicy = async () => {
        const values = await settings.get();
        const [policy, cache] = await Promise.all([configuredAutoMedia(values), configuredCachePolicy(values)]);
        const overrides = parseChatRules(values.autoMediaOverrides, accountAutoMediaOverrides);
        const extra = Object.keys(overrides).length ? overrides[await (account ??= current.accountId())]?.[id] : undefined;
        if (connected() !== current) return defaultAutoMediaPolicy;
        const cap = (limits: AutoMediaLimits): AutoMediaLimits => ({
          photo: Math.min(limits.photo, cache.limitMiB), video: Math.min(limits.video, cache.limitMiB),
          file: Math.min(limits.file, cache.limitMiB),
        });
        return { private: cap(policy.private), group: cap(policy.group), channel: cap(policy.channel), override: extra && cap(extra) };
      };
      return await downloads.withCacheTransfer((signal) => current.prefetchVisibleMedia(id, messageId, topicId, loadPolicy, signal)) ?? false;
    },
    cacheInfo: (_, context) => {
      guard(context);
      return safe(withCache(async (current) => ({ ...await current.cacheUsage(true), ...await configuredCachePolicy() })), "Could not read the Telegram cache.");
    },
    setCacheLimit: ({ limitMiB, retentionDays }, context) => {
      guard(context);
      return safe(withCache(async (current) => {
        const policy = { limitMiB, retentionDays: retentionDays ?? (await configuredCachePolicy()).retentionDays };
        const usage = await trimCache(current, policy, true);
        if (connected() !== current) throw new Error("Telegram session changed.");
        await settings.experimental_set({ cacheLimitMiB: policy.limitMiB, cacheRetentionDays: policy.retentionDays });
        return { ...usage, ...policy };
      }), "Could not save the Telegram cache limit.");
    },
    clearCache: (input, context) => {
      guard(context);
      return safe(withCache(async (current) => {
        const usage = await downloads.cleanCache(() => current.optimizeCache(0, { ...input, includeChats: true }));
        const policy = await configuredCachePolicy();
        return usage ? { ...usage, ...policy }
          : { ...await current.cacheUsage(true), ...policy, cleanupDeferred: true as const };
      }), "Could not clear the Telegram cache.");
    },
    agentAccess: (_, context) => { guard(context); return agentAccess(); },
    setAgentAccess: async ({ capability, enabled }, context) => {
      guard(context);
      const setting = { read: "agentReadOwnNotes", send: "agentSend" } as const;
      const change = scopeChanges.then(async () => {
        checkConnection();
        if (accounts.accounts.length === 1) await settings.experimental_set({ [setting[capability]]: enabled });
        else {
          const current = connected();
          const { read, send, history } = await agentAccess();
          const accountId = await current.accountId();
          if (connected() !== current) throw new Error("Telegram session changed.");
          const agent = { accountId, read, send, [capability]: enabled };
          const updated = { ...accounts, accounts: accounts.accounts.map((entry) =>
            entry.id === accounts.selected ? { ...entry, agent } : entry) };
          await settings.experimental_set({ telegramAccounts: JSON.stringify(updated),
            agentReadOwnNotes: agent.read, agentSend: agent.send });
          accounts = updated;
          return { read: agent.read, send: agent.send, history };
        }
        return agentAccess();
      });
      scopeChanges = change.catch(() => {});
      return change;
    },
    chatAgentAccess: ({ id }, context) => {
      guard(context);
      return safe(allowedChats(connected()).then((ids) => ids.includes(id)), "Could not read this chat’s AI access.");
    },
    setChatAgentAccess: ({ id, enabled }, context) => {
      guard(context);
      const current = connected();
      const change = scopeChanges.then(async () => {
        const accountId = await current.accountId();
        const grants = historyGrants((await settings.get()).agentHistoryChats);
        const ids = new Set(historyChatsForAccount(grants, accountId));
        if (enabled && !await current.canShareAgentHistory(id)) throw new Error("This conversation cannot be shared.");
        if (connected() !== current) throw new Error("Telegram session changed.");
        if (enabled) ids.add(id);
        else ids.delete(id);
        const updated = replaceAccountHistoryGrants(grants, accountId, [...ids]);
        await settings.experimental_set({ agentHistoryChats: updated.length ? JSON.stringify(updated) : "" });
        // Cancel reads as soon as the write completes, even if settings notification is delayed.
        revoke("history");
        revoke("read");
        return enabled;
      });
      scopeChanges = change.catch(() => {});
      return safe(change, "Could not change this chat’s AI access.");
    },
    status: async (_, context): Promise<Auth> => {
      guard(context);
      if (stopping || signingOut || switchingAccount) return { state: "disconnecting" };
      const auth = await authView(session?.status() ?? error ?? { state: "idle" });
      return stopping || signingOut || switchingAccount ? { state: "disconnecting" } : auth;
    },
    accountSelection: (_, context) => { guard(context); return accountSelectionView(); },
    renameTelegramAccount: ({ expected, previousLabel, label }, context) => {
      guard(context);
      const change = scopeChanges.then(async () => {
        checkConnection();
        const current = accounts.accounts.find(({ id }) => id === expected);
        if (switchingAccount || signingOut || stopping || accounts.selected !== expected
          || (session && !requestConnection.getStore()) || current?.label !== previousLabel) {
          throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram account label changed. Refresh the account list." });
        }
        const updated = { ...accounts, accounts: accounts.accounts.map((entry) =>
          entry.id === expected ? { ...entry, label } : entry) };
        await settings.experimental_set({ telegramAccounts: JSON.stringify(updated) });
        accounts = updated;
        return accountSelectionView();
      });
      scopeChanges = change.catch(() => {});
      return change;
    },
    selectTelegramAccount: ({ expected, target }, context) => {
      guard(context);
      if (expected !== accounts.selected || switchingAccount || signingOut || stopping || starting
        || (session && !requestConnection.getStore())) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram account selection changed. Refresh the account list." });
      }
      const selected = "id" in target ? target.id : randomUUID();
      const next = telegramAccountSelection.safeParse({
        selected,
        accounts: "label" in target ? [...accounts.accounts, { id: selected, label: target.label }] : accounts.accounts,
      });
      if (!next.success) throw new experimental_PluginRpcRefusal({ code: "invalid", message: "This Telegram account is unavailable." });
      if (expected === selected) return authView(session?.status() ?? error ?? { state: "idle" });
      const previous = session;
      switchingAccount = (async () => {
        await scopeChanges;
        const selections = [...accounts.accounts];
        if ("label" in target) selections.push({ id: selected, label: target.label });
        if (accounts.accounts.length === 1 && previous?.status().state === "ready") {
          const config = await settings.get();
          const accountId = await previous.accountId().catch(() => undefined);
          if (accountId) selections[0] = { ...selections[0]!, agent: {
            accountId, read: config.agentReadOwnNotes === true, send: config.agentSend === true,
          } };
        }
        const picked = selections.find(({ id }) => id === selected);
        const updated = { selected, accounts: selections };
        await disconnect();
        if (disposed) return { state: "idle" as const };
        await settings.experimental_set({ telegramAccounts: JSON.stringify(updated),
          agentReadOwnNotes: picked?.agent?.read ?? false, agentSend: picked?.agent?.send ?? false });
        accounts = updated;
        return connectCurrent();
      })().finally(() => { switchingAccount = undefined; });
      return safe(switchingAccount, "Could not switch Telegram accounts.");
    },
    bindEmbedChat: async ({ id, list, topicId }, context) => {
      guard(context);
      const { current, account, store } = await embedOwner();
      const target = await current.resumeConversation(id, list, topicId);
      if (connected() !== current || !target || target.chat.id !== id || target.topic?.id !== topicId) return embedDenied();
      return store.bind(account, id, topicId);
    },
    resolveEmbedChat: async ({ resourceRef }, context) => { guard(context); return resolveEmbed(resourceRef); },
    embedChatAction: async ({ resourceRef, method, payload }, context) => {
      guard(context);
      const target = await resolveEmbed(resourceRef);
      checkConnection();
      if (payload.id !== target.chat.id) return embedDenied();
      const topic = target.topic;
      if (method !== "peerProfile") {
        if (topic && ["send", "chatDraft"].includes(method)) return embedDenied();
        if (["history", "topicDraft", "saveChatDraft"].includes(method) && payload.topicId !== topic?.id) return embedDenied();
        if (method === "sendTopicText" || method === "prepareDocumentUpload") {
          if (payload.topic !== undefined || topic) {
            const supplied = payload.topic as { id?: unknown; name?: unknown } | null;
            if (!topic || supplied?.id !== topic.id || supplied.name !== topic.name) return embedDenied();
          }
        }
      }
      const input = schemas[method].input.parse(payload);
      const result = await handlers[method](input as never, context);
      checkConnection();
      return schemas[method].output.parse(result);
    },
    sessionRpc: async ({ connectionId: expected, method, payload }, context) => {
      guard(context);
      checkConnection(expected);
      if (!Object.hasOwn(schemas, method) || ["sessionRpc", "status", "connect", "accountSelection", "readPreview"].includes(method)) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Invalid Telegram session action." });
      }
      const key = method as keyof typeof schemas;
      const parsed = schemas[key].input.safeParse(payload ?? null);
      if (!parsed.success) throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Invalid Telegram action input." });
      const result = await requestConnection.run(expected, () => handlers[key](parsed.data as never, context));
      if (key !== "disconnect" && key !== "signOut" && key !== "selectTelegramAccount") checkConnection(expected);
      const output = schemas[key].output.safeParse(result);
      if (!output.success) throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Invalid Telegram action response." });
      return output.data;
    },
    disconnect: (_, context) => { guard(context); return signingOut ? safe(signingOut, "Telegram did not confirm sign-out.") : disconnect(); },
    signOut: (_, context) => {
      guard(context);
      if (signingOut) return safe(signingOut, "Telegram did not confirm sign-out.");
      const previous = connected();
      revoke("read");
      revoke("send");
      revoke("history");
      storyMedia.clear();
      clearTranscriptions();
      chatExports.clear();
      downloads.clear();
      uploads.clear();
      signingOut = (async () => {
        await scopeChanges;
        const grants = historyGrants((await settings.get()).agentHistoryChats);
        const accountId = grants.length ? await previous.accountId().catch(() => undefined) : undefined;
        const retained = accountId ? replaceAccountHistoryGrants(grants, accountId, []) : [];
        const updated = { ...accounts, accounts: accounts.accounts.map((entry) =>
          entry.id === accounts.selected ? { id: entry.id, label: entry.label } : entry) };
        await settings.experimental_set({ agentReadOwnNotes: false, agentSend: false,
          agentHistoryChats: retained.length ? JSON.stringify(retained) : "",
          telegramAccounts: JSON.stringify(updated) });
        accounts = updated;
        await previous.signOut();
        for (const key of draftScopes.keys()) {
          if (key.startsWith(`${accounts.selected}:`)) draftScopes.delete(key);
        }
        return disconnect();
      })().finally(() => { signingOut = undefined; });
      return safe(signingOut, "Telegram did not confirm sign-out.");
    },
    connect: (_, context) => {
      guard(context);
      if (stopping || signingOut || switchingAccount) return { state: "disconnecting" as const };
      return connectCurrent();
    },
    password: ({ password }, context) => {
      guard(context);
      if (!session) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Connect Telegram first." });
      const current = session;
      return safe(current.password(password).then((auth) => current === session ? authView(auth) : { state: "idle" as const }),
        "Telegram did not accept the password. Try again.");
    },
    newFolderChats: ({ id }, context) => {
      guard(context); return safe(connected().newFolderChats(id), "Could not check for new chats in the folder.");
    },
    dismissFolderUpdates: ({ id, token }, context) => {
      guard(context); return safe(connected().processFolderUpdates(id, token, []), "Could not hide the folder updates.");
    },
    addNewFolderChats: ({ id, token, ids }, context) => {
      guard(context); return safe(connected().processFolderUpdates(id, token, ids), "Could not add the new chats.");
    },
    folderShareChats: ({ id }, context) => {
      guard(context); return safe(connected().folderShareChats(id), "Could not load shareable chats.");
    },
    createFolderInvite: ({ id, name, ids }, context) => {
      guard(context); return safe(connected().createFolderInvite(id, name, ids), "Could not create the folder link.");
    },
    folderInviteLinks: ({ id }, context) => {
      guard(context); return safe(connected().folderInviteLinks(id), "Could not load folder links.");
    },
    folderInviteEditor: ({ id, url }, context) => {
      guard(context); return safe(connected().folderInviteEditor(id, url), "Could not load the chats on this folder link.");
    },
    saveFolderInviteChats: ({ id, url, token, ids }, context) => {
      guard(context); return safe(connected().saveFolderInviteChats(id, url, token, ids), "Could not update the chats on this folder link.");
    },
    renameFolderInvite: ({ id, url, expected, name }, context) => {
      guard(context); return safe(connected().renameFolderInvite(id, url, expected, name), "Could not rename the folder link.");
    },
    revokeFolderInvite: ({ id, url, name }, context) => {
      guard(context); return safe(connected().revokeFolderInvite(id, url, name), "Could not revoke the folder link.");
    },
    previewFolderInvite: ({ url }, context) => {
      guard(context); return safe(connected().previewFolderInvite(url), "Could not check the folder invitation.");
    },
    importFolderInvite: ({ url, token, ids }, context) => {
      guard(context); return safe(connected().importFolderInvite(url, token, ids), "Could not add the shared folder.");
    },
    folderTags: (_, context) => { guard(context); return safe(connected().folderTags(), "Could not read folder tags."); },
    setFolderTags: ({ enabled, expected }, context) => {
      guard(context); return safe(connected().setFolderTags(enabled, expected), "Could not update folder tags.");
    },
    folderLimit: (_, context) => { guard(context); return safe(connected().folderLimit(), "Could not check the folder limit."); },
    reorderFolders: ({ order, expected, mainPosition, expectedMainPosition }, context) => {
      guard(context); return safe(connected().reorderFolders(order, expected, mainPosition, expectedMainPosition), "Could not reorder Telegram folders.");
    },
    recommendedFolders: (_, context) => {
      guard(context); return safe(connected().recommendedFolders(), "Could not load recommended folders.");
    },
    addRecommendedFolder: ({ token }, context) => {
      guard(context); return safe(connected().addRecommendedFolder(token), "Could not add this recommended folder.");
    },
    folderEditor: ({ id }, context) => { guard(context); return safe(connected().folderEditor(id), "Could not open this folder."); },
    saveFolder: ({ id, expectedRevision, ...draft }, context) => { guard(context); return safe(connected().saveFolder(draft, id, expectedRevision), "Telegram did not save the folder."); },
    deleteFolder: ({ id, title }, context) => { guard(context); return safe(connected().deleteFolder(id, title), "Could not delete this folder."); },
    folderMemberships: ({ chatId }, context) => { guard(context); return safe(connected().folderMemberships(chatId), "Could not load folder membership."); },
    setFolderMembership: ({ id, chatId, mode }, context) => { guard(context); return safe(connected().setFolderMembership(id, chatId, mode), "Could not change folder membership."); },
    folders: (_, context) => { guard(context); return connected().folders(); },
    folderLayout: (_, context) => { guard(context); return connected().folderLayout(); },
    contacts: ({ query, offset }, context) => { guard(context); return safe(connected().contacts(query, offset), "Could not load contacts."); },
    contactBirthdays: (_, context) => { guard(context); return safe(connected().contactBirthdays(), "Could not load contact birthdays."); },
    contactDirectory: ({ initial, offset }, context) => { guard(context); return safe(connected().contactDirectory(initial, offset), "Could not load the contact index."); },
    blockedSenders: ({ list, offset }, context) => {
      guard(context); return safe(connected().blockedSenders(list, offset), "Could not load blocked senders.");
    },
    openBlockedSender: ({ sender }, context) => {
      guard(context); return safe(connected().openBlockedSender(sender), "Could not open the Telegram conversation.");
    },
    unblockListedSender: ({ sender, list }, context) => {
      guard(context); return safe(connected().unblockListedSender(sender, list), "Could not unblock sender.");
    },
    senderBlockState: ({ id }, context) => {
      guard(context); return safe(connected().senderBlockState(id), "Could not load the block status.");
    },
    setSenderBlockState: ({ id, expected, next }, context) => {
      guard(context); return safe(connected().setSenderBlockState(id, expected, next), "Could not update the block status.");
    },
    contactDetails: ({ id }, context) => { guard(context); return safe(connected().contactDetails(id), "Could not load contact."); },
    personalContactPhoto: ({ id, userId }, context) => {
      guard(context); return safe(connected().personalContactPhoto(id, userId), "Could not load the personal contact photo.");
    },
    savePersonalContactPhoto: ({ id, userId, expected, base64 }, context) => {
      guard(context); return safe(connected().changePersonalContactPhoto(id, userId, expected, base64), "Could not save the personal contact photo.");
    },
    removePersonalContactPhoto: ({ id, userId, expected }, context) => {
      guard(context); return safe(connected().changePersonalContactPhoto(id, userId, expected), "Could not remove the personal contact photo.");
    },
    contactNote: ({ id }, context) => { guard(context); return safe(connected().contactNote(id), "Could not load the contact note."); },
    suggestContactProfilePhoto: ({ id, userId, base64 }, context) => {
      guard(context); return safe(connected().suggestContactProfilePhoto(id, userId, base64), "Could not suggest a profile photo.");
    },
    suggestedProfilePhoto: ({ id, messageId, photoId }, context) => {
      guard(context); return safe(connected().suggestedProfilePhoto(id, messageId, photoId), "Could not preview the suggested photo.");
    },
    acceptSuggestedProfilePhoto: ({ id, messageId, photoId, expected }, context) => {
      guard(context); return safe(connected().acceptSuggestedProfilePhoto(id, messageId, photoId, expected), "Could not apply the suggested photo.");
    },
    suggestContactBirthday: ({ id, userId, birthdate }, context) => {
      guard(context); return safe(connected().suggestContactBirthday(id, userId, birthdate), "Could not suggest a birthday.");
    },
    acceptBirthdaySuggestion: ({ id, messageId, birthdate }, context) => {
      guard(context); return safe(connected().acceptBirthdaySuggestion(id, messageId, birthdate), "Could not save the suggested birthday.");
    },
    saveContactNote: ({ id, revision, text }, context) => {
      guard(context); return safe(connected().saveContactNote(id, revision, text), "Could not save the contact note.");
    },
    saveContact: ({ id, userId, expected, names }, context) => { guard(context); return safe(connected().saveContact(id, userId, expected, names), "Could not save the contact."); },
    removeContact: ({ id, userId, expected }, context) => { guard(context); return safe(connected().removeContact(id, userId, expected), "Could not remove the contact."); },
    openSharedContact: ({ id, messageId, userId }, context) => {
      guard(context); return safe(connected().openSharedContact(id, messageId, userId), "Could not open this shared contact.");
    },
    openContact: ({ id }, context) => { guard(context); return safe(connected().openContact(id), "Could not open this contact."); },
    search: ({ query, list }, context) => { guard(context); return safe(connected().search(query, list), "Telegram search failed."); },
    recentSearchChats: (_, context) => {
      guard(context); return safe(connected().recentSearchChats(), "Could not load recent Telegram chats.");
    },
    frequentSearchContacts: (_, context) => {
      guard(context); return safe(connected().frequentSearchContacts(), "Could not load frequent Telegram contacts.");
    },
    updateRecentSearch: (change, context) => {
      guard(context); return safe(connected().updateRecentSearch(change), "Could not update recent Telegram chats.");
    },
    chatPage: ({ list, offset }, context) => {
      guard(context);
      const current = connected();
      return safe((async () => {
        const page = await current.chatPage(list, offset);
        if (connected() !== current) throw new Error("Telegram session changed.");
        return { ...page, ...(offset === 0 ? { unreadCounts: current.unreadCounts() } : {}) };
      })(), "Could not load Telegram chats.");
    },
    chats: ({ list }, context) => { guard(context); return safe(connected().chats(list), "Could not load Telegram chats."); },
    pinStatus: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().pinStatus(id, messageId), "Could not check Telegram pin permissions.");
    },
    setMessagePinned: ({ id, messageId, pinned, mode }, context) => {
      guard(context);
      return connected().setMessagePinned(id, messageId, pinned, mode);
    },
    unpinAllPreview: ({ id, topic }, context) => {
      guard(context);
      return safe(connected().unpinAllPreview(id, topic), "Could not check the Telegram pins.");
    },
    unpinAllMessages: ({ id, messageId, topic }, context) => {
      guard(context);
      return safe(connected().unpinAllMessages(id, messageId, topic), "Could not confirm the Telegram pin update.");
    },
    pinnedMessage: ({ id }, context) => { guard(context); return safe(connected().pinnedMessage(id), "Could not load the pinned message."); },
    messageViewers: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().messageViewers(id, messageId), "Could not load Telegram message viewers.");
    },
    messageViewerProfile: ({ id, messageId, userId }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const chat = await session.messageViewerProfile(id, messageId, userId);
        return connected() === session ? chat : null;
      })(), "Could not open the Telegram profile.");
    },
    messageReadTime: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().messageReadTime(id, messageId), "Could not load Telegram read time.");
    },
    deletionOptions: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().deletionOptions(id, messageId), "Could not check Telegram deletion permissions.");
    },
    batchDeletionOptions: ({ id, ids }, context) => {
      guard(context); return safe(connected().batchDeletionOptions(id, ids), "Could not check Telegram deletion permissions.");
    },
    deleteSelectedMessages: ({ id, ids, scope }, context) => {
      guard(context); return connected().deleteSelectedMessages(id, ids, scope);
    },
    deleteMessage: ({ id, messageId, scope }, context) => {
      guard(context);
      return connected().deleteMessage(id, messageId, scope);
    },
    copySelectedText: ({ id, ids, includeHtml }, context) => {
      guard(context);
      return safe(connected().copySelectedText(id, ids, includeHtml), "Could not copy text for this selection.");
    },
    copyChannelInboxSelection: ({ includeHtml, ...scope }, context) => {
      guard(context);
      return safe(connected().copyChannelInboxSelection(scope, includeHtml), "Could not copy text for this selection.");
    },
    forwardSelectionOptions: ({ id, ids }, context) => {
      guard(context);
      return safe(connected().forwardSelectionOptions(id, ids), "Could not check forwarding permissions for this selection.");
    },
    forwardSelectedMessages: ({ id, ids, target, presentation, delivery, comment }, context) => {
      guard(context);
      return connected().forwardSelectedMessages(id, ids, target, presentation, delivery, comment);
    },
    forwardOptions: ({ id, messageId, album }, context) => { guard(context); return safe(connected().forwardOptions(id, messageId, album), "Could not check whether Telegram allows forwarding this message."); },
    forwardMessage: ({ id, messageId, target, album, presentation, delivery, comment }, context) => { guard(context); return connected().forwardMessage(id, messageId, target, album, presentation, delivery, comment); },
    channelInboxForwardOptions: ({ album, ...scope }, context) => {
      guard(context);
      return safe(connected().channelInboxForwardOptions(scope, album), "Could not check whether Telegram allows forwarding this message.");
    },
    forwardChannelInboxMessage: ({ target, album, presentation, delivery, comment, ...scope }, context) => {
      guard(context);
      return connected().forwardChannelInboxMessage(scope, target, album, presentation, delivery, comment);
    },
    channelInboxForwardSelectionOptions: (scope, context) => {
      guard(context);
      return safe(connected().channelInboxForwardSelectionOptions(scope), "Could not check forwarding permissions for this selection.");
    },
    forwardChannelInboxSelection: ({ target, presentation, delivery, comment, ...scope }, context) => {
      guard(context);
      return connected().forwardChannelInboxSelection(scope, target, presentation, delivery, comment);
    },
    listReactions: ({ id, messageId }, context) => { guard(context); return safe(connected().listReactions(id, messageId), "Could not load Telegram reactions."); },
    paidReactionPeople: ({ id, messageId }, context) => {
      guard(context); return safe(connected().paidReactionPeople(id, messageId), "Could not load Stars reactions.");
    },
    paidReactionLimit: ({ id, messageId }, context) => {
      guard(context); return safe(connected().paidReactionLimit(id, messageId), "Could not load Stars reaction availability.");
    },
    paidReactionSenders: ({ id }, context) => {
      guard(context); return safe(connected().paidReactionSenders(id), "Could not load Stars reaction senders.");
    },
    sendPaidReaction: ({ id, messageId, stars, anonymous, asChat }, context) => {
      guard(context); return safe(connected().sendPaidReaction(id, messageId, stars, anonymous, asChat), "Could not verify the Stars reaction.");
    },
    setPaidReactionAnonymity: ({ id, messageId, expected, anonymous }, context) => {
      guard(context); return safe(connected().setPaidReactionAnonymity(id, messageId, expected, anonymous), "Could not update Stars reaction visibility.");
    },
    setReaction: ({ id, messageId, reaction, chosen }, context) => { guard(context); return connected().setReaction(id, messageId, reaction, chosen); },
    channelInboxReactions: (scope, context) => {
      guard(context); return safe(connected().channelInboxReactions(scope), "Could not load available reactions.");
    },
    setChannelInboxReaction: ({ reaction, chosen, ...scope }, context) => {
      guard(context); return connected().setChannelInboxReaction(scope, reaction, chosen);
    },
    channelInboxReactionPeople: ({ reaction, offset, ...scope }, context) => {
      guard(context); return safe(connected().channelInboxReactionPeople(scope, reaction, offset), "Could not load the people who reacted.");
    },
    channelInboxReactionPerson: ({ target, ...scope }, context) => {
      guard(context); return safe(connected().channelInboxReactionPerson(scope, target), "Could not open the Telegram profile.");
    },
    quickReaction: (_input, context) => { guard(context); return safe(connected().quickReaction(), "Could not load the quick reaction."); },
    setQuickReaction: ({ reaction }, context) => { guard(context); return connected().setQuickReaction(reaction); },
    chatReactionSettings: ({ id }, context) => {
      guard(context); return safe(connected().chatReactionSettings(id), "Could not load the chat's reaction settings.");
    },
    setChatReactionPolicy: ({ id, policy, expected }, context) => {
      guard(context); return connected().setChatReactionPolicy(id, policy, expected);
    },
    reactionPeople: ({ id, messageId, reaction, offset }, context) => {
      guard(context); return safe(connected().reactionPeople(id, messageId, reaction, offset), "Could not load the people who reacted.");
    },
    reactionPerson: ({ id, messageId, target }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const chat = await session.reactionPerson(id, messageId, target);
        return connected() === session ? chat : null;
      })(), "Could not open the Telegram profile.");
    },
    richMessageLimits: (_, context) => {
      guard(context); return safe(connected().richMessageLimits(), "Could not check rich message availability.");
    },
    editRichMessage: ({ id, messageId, revision, draft }, context) => {
      guard(context); return connected().editRichMessage(id, messageId, revision, draft);
    },
    sendRichMessage: ({ id, draft, topic, reply, delivery }, context) => {
      guard(context); return connected().sendRichMessage(id, draft, topic, reply, delivery);
    },
    checklistAvailability: ({ id }, context) => {
      guard(context); return safe(connected().checklistAvailability(id), "Could not check checklist availability.");
    },
    sendChecklist: ({ id, draft, topic, reply, delivery }, context) => {
      guard(context); return connected().sendChecklist(id, draft, topic, reply, delivery);
    },
    sendContactCard: ({ id, contact, topic, reply, delivery }, context) => {
      guard(context); return connected().sendContactCard(id, contact, topic, reply, delivery);
    },
    sendLocation: ({ id, point, topic, reply, delivery }, context) => {
      guard(context); return connected().sendLocation(id, point, topic, reply, delivery);
    },
    channelPollLimits: ({ id }, context) => {
      guard(context); return safe(connected().channelPollLimits(id), "Could not load channel poll settings.");
    },
    sendPoll: ({ id, draft, topic, reply }, context) => { guard(context); return connected().sendPoll(id, draft, topic, reply); },
    addPollOption: ({ id, messageId, text }, context) => { guard(context); return connected().addPollOption(id, messageId, text); },
    canRemovePollOption: ({ id, messageId, optionId, text }, context) => {
      guard(context); return safe(connected().canRemovePollOption(id, messageId, optionId, text), "Could not check the poll option.");
    },
    removePollOption: ({ id, messageId, optionId, text }, context) => {
      guard(context); return connected().removePollOption(id, messageId, optionId, text);
    },
    stopPoll: ({ id, messageId }, context) => { guard(context); return connected().stopPoll(id, messageId); },
    voteInPoll: ({ id, messageId, choices }, context) => { guard(context); return connected().voteInPoll(id, messageId, choices); },
    editChecklist: ({ id, messageId, expected, draft }, context) => {
      guard(context); return connected().editChecklist(id, messageId, expected, draft);
    },
    addChecklistTask: ({ id, messageId, task, expected }, context) => {
      guard(context); return connected().addChecklistTask(id, messageId, task, expected);
    },
    setChecklistTask: ({ id, messageId, taskId, expected, done }, context) => {
      guard(context); return connected().setChecklistTask(id, messageId, taskId, expected, done);
    },
    pollVoteHistory: ({ id, messageId, at }, context) => {
      guard(context); return safe(connected().pollVoteHistory(id, messageId, at), "Could not load the poll vote history.");
    },
    pollVoters: ({ id, messageId, choice, offset }, context) => { guard(context); return connected().pollVoters(id, messageId, choice, offset); },
    replaceMessagePhoto: ({ id, messageId, revision, base64, scheduled }, context) => { guard(context); return connected().replaceMessagePhoto(id, messageId, revision, base64, scheduled); },
    editCaption: ({ id, messageId, text, original, originalStyles, styles, placement, links, scheduled, customEmoji }, context) => {
      guard(context); return connected().editCaption(id, messageId, text, original, originalStyles, styles, placement, links, scheduled, customEmoji);
    },
    edit: ({ id, messageId, text, original, originalStyles, styles, removeLinkPreview, links, scheduled, customEmoji }, context) => { guard(context); return connected().editText(id, messageId, text, original, originalStyles, styles, removeLinkPreview, links, scheduled, customEmoji); },
    prepareChannelInboxDocument: async ({ id, inboxId, topicId, name, caption, size, replyTo, kind, captionFormat }, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (!await safe(current.channelInboxAttachmentAvailable(id, inboxId, topicId, replyTo), "Could not verify the channel inbox conversation.")) {
        if (replyTo) return { rejection: "reply_unavailable" as const };
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The channel inbox conversation is unavailable." });
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { id: inboxId, inbox: { channelId: id, topicId, kind }, name, caption, size, replyTo,
        ...(captionFormat && { options: { captionFormat } }) });
    },
    prepareDocumentUpload: async (input, context) => {
      guard(context);
      const current = connected();
      if (input.topic && await safe(current.forumTopicName(input.id, input.topic.id), "Could not verify the Telegram topic.") !== input.topic.name) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The Telegram topic changed. Reopen it before attaching a document." });
      }
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      const reply = input.reply ?? input.replyTo;
      if (reply && !await safe(current.attachmentReplyAvailable(input.id, reply, input.topic?.id), "Could not verify the Telegram reply.")) {
        return { rejection: "reply_unavailable" as const };
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, input);
    },
    prepareLivePhotoUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (input.reply && !await safe(current.attachmentReplyAvailable(input.id, input.reply, input.topic?.id), "Could not verify the Telegram reply.")) {
        return { rejection: "reply_unavailable" as const };
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { livePhoto: input,
        size: input.size + (typeof input.photo === "string" ? 0 : input.photo.heicBytes) });
    },
    prepareAttachmentReplacement: async (input, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { id: input.id, name: input.name, size: input.size, caption: "",
        replacement: { messageId: input.messageId, edit: input.edit, scheduled: input.scheduled } });
    },
    preparePollUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.files.map(({ size }) => size);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      const size = input.files.reduce((total, file) => total + file.size
        + (file.kind === "livePhoto" && typeof file.photo !== "string" ? file.photo.heicBytes : 0), 0);
      return uploads.issue(current, { size, poll: input });
    },
    prepareRichMessageUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.draft.flatMap((block) => "size" in block ? [block.size] : []);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { id: input.id, name: "formatted-message", caption: "",
        size: sizes.reduce((total, size) => total + size, 0), rich: input });
    },
    prepareRichMessageEditUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.draft.flatMap((block) => "size" in block ? [block.size] : []);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { richEdit: input, size: sizes.reduce((total, size) => total + size, 0) });
    },
    prepareQuickReplyDocument: async (input, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { shortcut: input, size: input.size });
    },
    prepareWelcomeMedia: async (input, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { welcome: input, size: input.size });
    },
    prepareWelcomeRichUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.draft.flatMap((block) => "size" in block ? [block.size] : []);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { welcomeRich: input, size: sizes.reduce((total, size) => total + size, 0) });
    },
    prepareQuickReplyAlbumUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.items.flatMap((item) => item.kind === "photo" ? [] : [item.size]);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      const size = input.items.reduce((total, item) => total + (item.kind === "photo" ? 0 : item.size)
        + (item.kind === "livePhoto" && typeof item.photo !== "string" ? item.photo.heicBytes : 0), 0);
      return uploads.issue(current, { shortcutAlbum: input, size });
    },
    prepareAlbumUpload: async (input, context) => {
      guard(context);
      const current = connected();
      const sizes = input.items.flatMap((item) => item.kind === "photo" ? [] : [item.size]);
      const rejection = await safe(current.checkDocumentUpload(Math.max(...sizes)), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (input.topic && await safe(current.forumTopicName(input.id, input.topic.id), "Could not verify the Telegram topic.") !== input.topic.name) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The Telegram topic changed. Reopen it before attaching an album." });
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      const size = input.items.reduce((total, item) => total + (item.kind === "photo" ? 0 : item.size)
        + (item.kind === "livePhoto" && typeof item.photo !== "string" ? item.photo.heicBytes : 0), 0);
      return uploads.issue(current, { id: input.id, name: "album", caption: input.caption, size, album: input });
    },
    prepareChannelInboxAlbum: async (input, context) => {
      guard(context);
      const current = connected();
      const rejection = await safe(current.checkDocumentUpload(Math.max(...input.items.map(({ size }) => size))),
        "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (!await safe(current.channelInboxAttachmentAvailable(input.id, input.inboxId, input.topicId, input.replyTo),
        "Could not verify the channel inbox conversation.")) {
        if (input.replyTo) return { rejection: "reply_unavailable" as const };
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The channel inbox conversation is unavailable." });
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, { inboxAlbum: input, size: input.items.reduce((total, { size }) => total + size, 0) });
    },
    sendDocument: ({ id, name, caption, base64 }, context) => { guard(context); return connected().sendDocument(id, name, caption, base64); },
    mediaCollectionState: ({ id, messageId, kind }, context) => {
      guard(context);
      return safe(connected().mediaCollectionState(id, messageId, kind), "Could not load the Telegram media collection.");
    },
    setMediaCollection: ({ id, messageId, kind, saved, expected }, context) => {
      guard(context);
      return connected().setMediaCollection(id, messageId, kind, saved, expected);
    },
    searchInlineBot: ({ id, username, query, offset, topic }, context) => {
      guard(context); return safe(connected().searchInlineBot(id, username, query, offset, topic), "Could not load inline bot results.");
    },
    launchInlineResultMiniApp: ({ id, token, topic }, context) => {
      guard(context); return safe(connected().launchInlineResultMiniApp(id, token, topic), "Could not open the inline Mini App.");
    },
    inlineBotPreview: ({ id, token }, context) => { guard(context); return connected().inlineBotPreview(id, token); },
    sendInlineBotResult: ({ id, token, topic, reply }, context) => {
      guard(context); return connected().sendInlineBotResult(id, token, topic, reply);
    },
    searchGifs: ({ id, query, topic }, context) => { guard(context); return safe(connected().searchGifs(id, query, topic), "Could not search Telegram GIFs."); },
    sendFoundGif: ({ id, token, topic, reply, delivery, gif }, context) => { guard(context); return connected().sendFoundGif(id, token, topic, reply, delivery, gif); },
    linkedStickerPack: ({ url, offset, refresh }, context) => {
      guard(context); return safe(connected().linkedStickerPack(url, offset, refresh), "Could not open the sticker pack.");
    },
    installLinkedStickerPack: ({ url, packId }, context) => {
      guard(context); return connected().installLinkedStickerPack(url, packId);
    },
    messageStickerPack: ({ id, messageId, offset }, context) => {
      guard(context); return safe(connected().messageStickerPack(id, messageId, offset), "Could not open the sticker pack.");
    },
    installMessageStickerPack: ({ id, messageId, packId }, context) => {
      guard(context); return connected().installMessageStickerPack(id, messageId, packId);
    },
    installedStickerPacks: (_, context) => { guard(context); return safe(connected().installedStickerPacks(), "Could not load installed sticker packs."); },
    discoverStickerPacks: (input, context) => {
      guard(context); return safe(connected().discoverStickerPacks(input), "Could not find sticker packs.");
    },
    archivedStickerPacks: ({ after, emoji }, context) => {
      guard(context); return safe(connected().archivedStickerPacks(after, emoji), "Could not load archived sticker packs.");
    },
    changeStickerPack: ({ id, action, emoji }, context) => {
      guard(context); return connected().changeStickerPack(id, action, emoji);
    },
    ownedStickerPacks: ({ after }, context) => {
      guard(context); return safe(connected().ownedStickerPacks(after), "Could not load your sticker packs.");
    },
    ownedStickerPack: ({ id }, context) => {
      guard(context); return safe(connected().ownedStickerPack(id), "Could not load this sticker pack.");
    },
    ownedStickerPreview: ({ id, fileId }, context) => {
      guard(context); return safe(connected().ownedStickerPreview(id, fileId), "Could not load the sticker preview.");
    },
    renameOwnedStickerPack: ({ id, expected, title }, context) => {
      guard(context); return connected().renameOwnedStickerPack(id, expected, title);
    },
    moveOwnedSticker: ({ id, fileId, direction, expected }, context) => {
      guard(context); return connected().moveOwnedSticker(id, fileId, direction, expected);
    },
    removeOwnedSticker: ({ id, fileId, title, expected }, context) => {
      guard(context); return connected().removeOwnedSticker(id, fileId, title, expected);
    },
    setOwnedStickerEmojis: ({ id, fileId, expected, emojis }, context) => {
      guard(context); return connected().setOwnedStickerEmojis(id, fileId, expected, emojis);
    },
    setOwnedEmojiPackCover: ({ id, expected, fileId }, context) => {
      guard(context); return connected().setOwnedEmojiPackCover(id, expected, fileId);
    },
    ownedStickerImageCover: ({ id, fileId }, context) => {
      guard(context); return safe(connected().ownedStickerImageCover(id, fileId), "Could not load the sticker pack cover.");
    },
    setOwnedStickerImageCover: ({ id, expected, base64 }, context) => {
      guard(context); return connected().setOwnedStickerImageCover(id, expected, base64);
    },
    deleteOwnedStickerPack: (target, context) => {
      guard(context); return connected().deleteOwnedStickerPack(target);
    },
    ownedStickerDestinations: ({ id, messageId, after }, context) => {
      guard(context); return safe(connected().ownedStickerDestinations(id, messageId, after), "Could not load your sticker packs.");
    },
    addMessageStickerToOwnedPack: ({ id, messageId, sourceFileId, packId, title }, context) => {
      guard(context); return connected().addMessageStickerToOwnedPack(id, messageId, sourceFileId, packId, title);
    },
    createOwnedPackFromMessage: ({ id, messageId, sourceFileId, name, title }, context) => {
      guard(context); return connected().createOwnedPackFromMessage(id, messageId, sourceFileId, name, title);
    },
    inspectOwnedTgsSticker: ({ base64 }, context) => {
      guard(context); return inspectTgsUpload(base64)?.json ?? null;
    },
    inspectOwnedWebmSticker: ({ base64 }, context) => {
      guard(context); return safe(connected().inspectOwnedWebmSticker(base64), "Could not inspect the video sticker.");
    },
    createOwnedPackFromImage: ({ name, title, emojis, base64, format }, context) => {
      guard(context); return connected().createOwnedPackFromImage(name, title, emojis, base64, format);
    },
    addImageToOwnedStickerPack: ({ target, emojis, base64, format }, context) => {
      guard(context); return connected().addImageToOwnedStickerPack(target, emojis, base64, format);
    },
    replaceImageInOwnedStickerPack: ({ target, fileId, emojis, base64, format }, context) => {
      guard(context); return connected().replaceImageInOwnedStickerPack(target, fileId, emojis, base64, format);
    },
    reorderStickerPacks: ({ order, expected, emoji }, context) => {
      guard(context); return connected().reorderStickerPacks(order, expected, emoji);
    },
    stickerPackPage: ({ packId, offset }, context) => {
      guard(context); return safe(connected().stickerPackPage(packId, offset), "Could not load this sticker pack.");
    },
    groupStickerPage: ({ id, offset, packId }, context) => {
      guard(context); return safe(connected().groupStickerPage(id, offset, packId), "Could not load the group sticker pack.");
    },
    groupEmojiPage: ({ id, offset, packId }, context) => {
      guard(context); return safe(connected().groupEmojiPage(id, offset, packId), "Could not load the group emoji pack.");
    },
    installedEmojiPacks: (_, context) => {
      guard(context); return safe(connected().installedEmojiPacks(), "Could not load your emoji packs.");
    },
    installedEmojiPage: ({ packId, offset }, context) => {
      guard(context); return safe(connected().installedEmojiPage(packId, offset), "Could not load the emoji pack.");
    },
    clearRecentStickers: (_, context) => {
      guard(context); return connected().clearRecentStickers();
    },
    mediaChoices: (input, context) => {
      guard(context);
      return safe(typeof input === "string" ? connected().mediaChoices(input) : connected().mediaChoices("sticker", input.stickerQuery),
        "Could not load Telegram media.");
    },
    sendMediaChoice: ({ id, kind, fileId, stickerQuery, packId, topic, reply, delivery, gif, groupPack }, context) => { guard(context); return connected().sendMediaChoice(id, kind, fileId, stickerQuery, packId, topic, reply, delivery, gif, groupPack); },
    sendChannelInboxMediaChoice: ({ id, inboxId, topicId, replyTo, ...selection }, context) => {
      guard(context); return connected().sendChannelInboxMediaChoice(id, inboxId, topicId, selection, replyTo);
    },
    sendVideoNote: ({ id, base64, format, topic, reply, delivery }, context) => {
      guard(context); return connected().sendVideoNote(id, base64, format, topic, reply, delivery);
    },
    sendChannelInboxVideoNote: ({ id, inboxId, topicId, replyTo, ...recording }, context) => {
      guard(context); return connected().sendChannelInboxVideoNote(id, inboxId, topicId, recording, replyTo);
    },
    sendVoice: ({ id, base64, duration, format, topic, reply, delivery, trim }, context) => { guard(context); return connected().sendVoice(id, base64, duration, format, topic, reply, delivery, trim); },
    sendChannelInboxVoice: ({ id, inboxId, topicId, replyTo, ...recording }, context) => {
      guard(context); return connected().sendChannelInboxVoice(id, inboxId, topicId, recording, replyTo);
    },
    sendPhotoAlbum: ({ id, caption, photos, topic, reply, delivery, options }, context) => { guard(context); return connected().sendPhotoAlbum(id, caption, photos, topic, reply, delivery, options); },
    paidMediaLimit: ({ id }, context) => { guard(context); return safe(connected().paidMediaLimit(id), "Could not check paid media availability."); },
    sendPhoto: ({ id, caption, base64, topic, replyTo, reply, options, delivery }, context) => { guard(context); return connected().sendPhoto(id, caption, base64, topic, reply ?? replyTo, options, delivery); },
    sendTopicText: ({ id, text, topic, replyTo, styles, quote, delivery }, context) => {
      guard(context);
      return connected().sendText(id, text, replyTo, undefined, undefined, undefined, topic, undefined, { ...delivery, styles, quote });
    },
    externalReplyChats: ({ query }, context) => {
      guard(context);
      return safe(connected().externalReplyChats(query), "Could not find Telegram reply destinations.");
    },
    externalReplyTopics: ({ id, query, cursor }, context) => {
      guard(context);
      return safe(connected().externalReplyTopics(id, query, cursor), "Could not find Telegram reply topics.");
    },
    reviewExternalReply: ({ id, messageId, destination, expectedName, sourceTopicId, quote, topic }, context) => {
      guard(context);
      return safe(connected().reviewExternalReply(id, messageId, destination, expectedName, sourceTopicId, quote, topic,
        context.experimental_signal), "Could not review the Telegram reply.");
    },
    externalReplyAllowed: ({ id, messageId }, context) => {
      guard(context); return safe(connected().externalReplyAllowed(id, messageId), "Could not check the Telegram reply.");
    },
    externalReplySource: ({ id, messageId }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const source = await session.externalReplySource(id, messageId);
        if (!source || connected() !== session || context.experimental_signal.aborted) return null;
        const { chatId, ...reference } = source;
        const chat = await session.chatById(chatId);
        return connected() === session && chat?.id === chatId && !context.experimental_signal.aborted ? { chat, ...reference } : null;
      })(), "Could not open the original Telegram message.");
    },
    chatDraft: ({ id }, context) => { guard(context); return safe(connected().chatDraft(id), "Could not load the Telegram chat draft."); },
    topicDraft: ({ id, topicId }, context) => {
      guard(context); return safe(connected().topicDraft(id, topicId), "Could not load the Telegram topic draft.");
    },
    saveChatDraft: ({ id, draft, expected, topicId }, context) => {
      guard(context);
      return safe(connected().saveChatDraft(id, draft, expected, topicId), "Could not save the Telegram draft.");
    },
    chatEvents: ({ id, query, cursor, filter, filters, actorId }, context) => {
      guard(context);
      return safe(connected().chatEvents(id, query, cursor, filters ?? (filter ? [filter] : undefined), actorId), "Could not load recent actions.");
    },
    chatEventActors: ({ id }, context) => { guard(context); return safe(connected().chatEventActors(id), "Could not load chat administrators."); },
    reportAntiSpamFalsePositive: ({ id, eventId }, context) => {
      guard(context); return safe(connected().reportAntiSpamFalsePositive(id, eventId), "Could not confirm the anti-spam report.");
    },
    channelSignatures: ({ id }, context) => {
      guard(context); return safe(connected().channelSignatures(id), "Could not load channel signatures.");
    },
    saveChannelSignatures: ({ id, values, expected }, context) => {
      guard(context); return safe(connected().saveChannelSignatures(id, values, expected), "Could not save channel signatures.");
    },
    chatPublicUsername: ({ id }, context) => {
      guard(context); return safe(connected().chatPublicUsername(id), "Could not load this chat's username.");
    },
    saveChatPublicUsername: ({ id, username, expected }, context) => {
      guard(context); return safe(connected().saveChatPublicUsername(id, username, expected), "Could not save this chat's username.");
    },
    saveChannelBoostSetting: ({ id, ...change }, context) => {
      guard(context); return safe(connected().saveChannelBoostSetting(id, change), "Could not update this channel setting.");
    },
    chatBoostHistory: ({ id, onlyGiftCodes, offset }, context) => {
      guard(context); return safe(connected().chatBoostHistory(id, onlyGiftCodes, offset), "Could not read this chat’s boosts.");
    },
    chatBoostSlots: ({ id }, context) => {
      guard(context); return safe(connected().chatBoostSlots(id), "Could not load account boost slots.");
    },
    applyChatBoosts: ({ id, title, slots }, context) => {
      guard(context); return connected().applyChatBoosts(id, title, slots);
    },
    chatInfo: ({ id }, context) => {
      guard(context); return safe(connected().chatInfo(id), "Could not load chat information.");
    },
    groupPacks: ({ id }, context) => {
      guard(context); return safe(connected().groupPacks(id), "Could not load group packs.");
    },
    previewGroupPack: ({ id, kind, reference }, context) => {
      guard(context); return safe(connected().previewGroupPack(id, kind, reference), "Could not find this group pack.");
    },
    setGroupPack: ({ id, kind, expected, pack }, context) => {
      guard(context); return safe(connected().setGroupPack(id, kind, expected, pack), "Could not change the group pack.");
    },
    discussionGroup: ({ id }, context) => {
      guard(context); return safe(connected().discussionGroup(id), "Could not load the discussion group.");
    },
    discussionGroupCandidates: ({ id }, context) => {
      guard(context); return safe(connected().discussionGroupCandidates(id), "Could not load eligible discussion groups.");
    },
    setDiscussionGroup: ({ id, target, expected }, context) => {
      guard(context); return safe(connected().setDiscussionGroup(id, target, expected), "Could not update the discussion group.");
    },
    enableDiscussionHistory: ({ id, target, title, expected }, context) => {
      guard(context); return safe(connected().enableDiscussionHistory(id, target, title, expected), "Could not open discussion group history.");
    },
    upgradeDiscussionGroup: ({ id, target, title, expected }, context) => {
      guard(context); return safe(connected().upgradeDiscussionGroup(id, target, title, expected), "Could not prepare the discussion supergroup.");
    },
    upgradeBasicGroup: ({ id, title }, context) => {
      guard(context); return safe(connected().upgradeBasicGroup(id, title), "Could not upgrade this Telegram group.");
    },
    chatWelcomeMessages: ({ id }, context) => {
      guard(context); return safe(connected().chatWelcomeMessages(id), "Could not load welcome messages.");
    },
    chatWelcomePhoto: ({ id, messageId, revision, size, attachment }, context) => {
      guard(context); return safe(connected().chatWelcomePhoto(id, messageId, revision, size, attachment), "Could not load the welcome photo.");
    },
    chatWelcomeSticker: ({ id, messageId, revision }, context) => {
      guard(context); return safe(connected().chatWelcomeSticker(id, messageId, revision), "Could not load the welcome sticker.");
    },
    chatWelcomePlayback: ({ id, messageId, revision, attachment }, context) => {
      guard(context); return safe(downloads.issueWelcomePlayback(connected(), id, messageId, revision, attachment), "Could not play the welcome media.");
    },
    chatWelcomeDocument: ({ id, messageId, revision, attachment }, context) => {
      guard(context); return safe(downloads.issueWelcomeDocument(connected(), id, messageId, revision, attachment), "Could not download the welcome document.");
    },
    changeChatWelcomeMessage: (input, context) => {
      guard(context); return safe(connected().changeChatWelcomeMessage(input), "Could not update welcome messages.");
    },
    removeChatPhoto: ({ id, expected }, context) => {
      guard(context); return safe(connected().removeChatPhoto(id, expected), "Could not remove the chat photo.");
    },
    saveChatPhoto: ({ id, expected, base64 }, context) => {
      guard(context); return safe(connected().saveChatPhoto(id, base64, expected), "Could not update the chat photo.");
    },
    saveChatVideo: ({ id, expected, base64, coverSeconds, trim }, context) => {
      guard(context); return safe(connected().saveChatVideo(id, base64, expected, coverSeconds, trim), "Could not update the chat profile video.");
    },
    saveChatInfo: ({ id, ...change }, context) => {
      guard(context); return safe(connected().saveChatInfo(id, change), "Could not save chat information.");
    },
    groupSlowMode: ({ id }, context) => {
      guard(context); return safe(connected().groupSlowMode(id), "Could not load slow mode.");
    },
    groupMemberVisibility: ({ id }, context) => {
      guard(context); return safe(connected().groupMemberVisibility(id), "Could not load member visibility.");
    },
    saveGroupMemberVisibility: ({ id, hidden, expected }, context) => {
      guard(context); return safe(connected().saveGroupMemberVisibility(id, hidden, expected), "Could not save member visibility.");
    },
    groupAntiSpam: ({ id }, context) => {
      guard(context); return safe(connected().groupAntiSpam(id), "Could not load aggressive anti-spam.");
    },
    saveGroupAntiSpam: ({ id, enabled, expected }, context) => {
      guard(context); return safe(connected().saveGroupAntiSpam(id, enabled, expected), "Could not save aggressive anti-spam.");
    },
    groupHistoryVisibility: ({ id }, context) => {
      guard(context); return safe(connected().groupHistoryVisibility(id), "Could not load group history visibility.");
    },
    saveGroupHistoryVisibility: ({ id, enabled, expected }, context) => {
      guard(context); return safe(connected().saveGroupHistoryVisibility(id, enabled, expected), "Could not save group history visibility.");
    },
    chatContentProtection: ({ id }, context) => {
      guard(context); return safe(connected().chatContentProtection(id), "Could not load content protection.");
    },
    saveChatContentProtection: ({ id, enabled, expected }, context) => {
      guard(context); return safe(connected().saveChatContentProtection(id, enabled, expected), "Could not save content protection.");
    },
    saveGroupSlowMode: ({ id, delay, expected }, context) => {
      guard(context); return safe(connected().saveGroupSlowMode(id, delay, expected), "Could not save slow mode.");
    },
    groupEntrySetting: ({ id, setting }, context) => {
      guard(context); return safe(connected().groupEntrySetting(id, setting), "Could not load this group entry setting.");
    },
    saveGroupEntrySetting: ({ id, setting, enabled, expected }, context) => {
      guard(context); return safe(connected().saveGroupEntrySetting(id, setting, enabled, expected), "Could not save this group entry setting.");
    },
    groupPermissions: ({ id }, context) => { guard(context); return safe(connected().groupPermissions(id), "Could not load group permissions."); },
    saveGroupPermissions: ({ id, changes }, context) => { guard(context); return safe(connected().saveGroupPermissions(id, changes), "Telegram did not save these group permissions."); },
    joinRequests: ({ id, query, cursor }, context) => { guard(context); return safe(connected().joinRequests(id, query, cursor), "Could not load join requests."); },
    reviewJoinRequest: ({ id, userId, approve }, context) => { guard(context); return safe(connected().reviewJoinRequest(id, userId, approve), "Telegram did not process this join request."); },
    managedInvites: ({ id, cursor, revoked }, context) => { guard(context); return safe(connected().managedInvites(id, cursor, revoked), "Could not load invitations."); },
    managedInviteMembers: ({ id, link, cursor, expired }, context) => { guard(context); return safe(connected().managedInviteMembers(id, link, cursor, expired), "Could not load members for this invitation."); },
    createManagedInvite: ({ id, draft }, context) => { guard(context); return safe(connected().createManagedInvite(id, draft), "Could not create the invitation."); },
    subscriptionInviteLimit: ({ id }, context) => {
      guard(context); return safe(connected().subscriptionInviteLimit(id), "Could not check the subscription price limit.");
    },
    createSubscriptionInvite: ({ id, name, stars }, context) => {
      guard(context); return safe(connected().createSubscriptionInvite(id, name, stars), "Could not create the subscription invitation.");
    },
    editManagedInvite: ({ id, link, expected, draft }, context) => { guard(context); return safe(connected().editManagedInvite(id, link, expected, draft), "Could not edit the invitation."); },
    deleteRevokedManagedInvite: ({ id, link }, context) => { guard(context); return safe(connected().deleteRevokedManagedInvite(id, link), "Could not delete the revoked invitation."); },
    revokeManagedInvite: ({ id, link }, context) => { guard(context); return safe(connected().revokeManagedInvite(id, link), "Could not revoke the invitation."); },
    chatSendAs: ({ id }, context) => { guard(context); return safe(connected().chatSendAs(id), "Could not load posting identities."); },
    setChatSendAs: ({ id, key, expected }, context) => {
      guard(context); return safe(connected().setChatSendAs(id, key, expected), "Could not change the posting identity.");
    },
    chatBackground: ({ id }, context) => { guard(context); return safe(connected().chatBackground(id), "Could not load the Telegram chat background."); },
    chatBackgroundPhoto: ({ id, revision }, context) => { guard(context); return safe(connected().chatBackgroundPhoto(id, revision), "Could not load the chat background photo."); },
    chatBackgroundPattern: ({ id, revision }, context) => { guard(context); return safe(connected().chatBackgroundPattern(id, revision), "Could not load the chat background pattern."); },
    previewChatBackgroundLink: ({ id, link }, context) => { guard(context); return safe(connected().previewChatBackgroundLink(id, link), "Could not preview the Telegram wallpaper."); },
    setChatBackgroundLink: ({ id, expected, link, revision }, context) => { guard(context); return safe(connected().setChatBackgroundLink(id, expected, link, revision), "Could not set the Telegram wallpaper."); },
    setChatBackgroundPhoto: ({ id, expected, base64 }, context) => { guard(context); return safe(connected().setChatBackgroundPhoto(id, expected, base64), "Could not set the chat background photo."); },
    setChatBackground: ({ id, expected, color }, context) => { guard(context); return safe(connected().setChatBackground(id, expected, color), "Could not set the Telegram chat background."); },
    chatTheme: ({ id }, context) => { guard(context); return safe(connected().chatTheme(id), "Could not load Telegram chat themes."); },
    setChatTheme: ({ id, expected, name }, context) => { guard(context); return safe(connected().setChatTheme(id, expected, name), "Could not set the Telegram chat theme."); },
    reviewGiftResale: ({ id, payment }, context) => {
      guard(context); return safe(connected().reviewGiftResale(id, payment), "Could not check the resale price.");
    },
    confirmGiftResale: ({ id, confirmation }, context) => {
      guard(context); return safe(connected().confirmGiftResale(id, confirmation), "Could not confirm resale delivery.");
    },
    reviewGiftAuctionBid: ({ id, bid }, context) => {
      guard(context); return safe(connected().reviewGiftAuctionBid(id, bid), "Could not review the auction bid.");
    },
    confirmGiftAuctionBid: ({ id, confirmation }, context) => {
      guard(context); return safe(connected().confirmGiftAuctionBid(id, confirmation), "Could not confirm the auction bid.");
    },
    giftAuction: ({ id, giftId, auctionId }, context) => {
      guard(context); return safe(connected().giftAuction(id, giftId, auctionId), "Could not load the gift auction.");
    },
    searchGiftResale: ({ id, ...query }, context) => {
      guard(context); return safe(connected().searchGiftResale(id, query), "Could not load gift resale listings.");
    },
    confirmGiftSend: ({ id, giftId, confirmation, options }, context) => {
      guard(context); return safe(connected().confirmGiftSend(id, giftId, confirmation, options), "Could not confirm gift delivery.");
    },
    giftQuote: ({ id, giftId }, context) => {
      guard(context); return safe(connected().giftQuote(id, giftId), "Could not check gift availability.");
    },
    chatGiftButton: ({ id }, context) => {
      guard(context); return safe(connected().chatGiftButton(id), "Could not load the Telegram gift button setting.");
    },
    giftCatalog: ({ id }, context) => {
      guard(context); return safe(connected().giftCatalog(id), "Could not load the Telegram gift catalog.");
    },
    profileGiftAnimation: ({ id, fileId }, context) => {
      guard(context); return safe(connected().profileGiftAnimation(id, fileId), "Could not load gift animation.");
    },
    profileGiftArtwork: ({ id, fileId }, context) => {
      guard(context); return safe(connected().profileGiftArtwork(id, fileId), "Could not load gift artwork.");
    },
    setProfileGiftMembership: ({ id, membership }, context) => {
      guard(context); return safe(connected().setProfileGiftMembership(id, membership), "Could not update gift membership.");
    },
    editProfileGiftCollection: ({ id, change }, context) => {
      guard(context); return safe(connected().editProfileGiftCollection(id, change), "Could not update the gift collection.");
    },
    profileGiftCollections: ({ id }, context) => {
      guard(context); return safe(connected().profileGiftCollections(id), "Could not load Telegram gift collections.");
    },
    profileGifts: ({ id, collection, offset, includeHidden }, context) => {
      guard(context); return safe(connected().profileGifts(id, collection, offset, includeHidden), "Could not load Telegram profile gifts.");
    },
    setProfileGiftVisibility: ({ id, gift, expected }, context) => {
      guard(context);
      return safe(connected().setProfileGiftVisibility(id, gift, expected), "Could not update profile gift visibility.");
    },
    setProfileGiftPinned: ({ id, gift, expected }, context) => {
      guard(context);
      return safe(connected().setProfileGiftPinned(id, gift, expected), "Could not update pinned gifts.");
    },
    setChannelGiftNotifications: ({ id, expected, enabled }, context) => {
      guard(context);
      return safe(connected().setChannelGiftNotifications(id, expected, enabled), "Could not update gift notifications.");
    },
    reviewGiftListing: ({ id, gift, price }, context) => {
      guard(context); return safe(connected().reviewGiftListing(id, gift, price), "Could not review the resale listing.");
    },
    confirmGiftListing: ({ id, gift, confirmation }, context) => {
      guard(context); return safe(connected().confirmGiftListing(id, gift, confirmation), "Could not update the resale listing.");
    },
    reviewDropGiftDetails: ({ id, gift }, context) => {
      guard(context);
      return safe(connected().reviewDropGiftDetails(id, gift), "Could not check removal of gift details.");
    },
    confirmDropGiftDetails: ({ id, gift, confirmation }, context) => {
      guard(context);
      return safe(connected().confirmDropGiftDetails(id, gift, confirmation), "Could not confirm removal of gift details.");
    },
    reviewProfileGiftTransfer: ({ id, gift, recipient }, context) => {
      guard(context);
      return safe(connected().reviewProfileGiftTransfer(id, gift, recipient), "Could not check the gift transfer.");
    },
    confirmProfileGiftTransfer: ({ id, gift, confirmation }, context) => {
      guard(context);
      return safe(connected().confirmProfileGiftTransfer(id, gift, confirmation), "Could not confirm the gift transfer.");
    },
    reviewProfileGiftUpgrade: ({ id, gift }, context) => {
      guard(context);
      return safe(connected().reviewProfileGiftUpgrade(id, gift), "Could not check the gift upgrade.");
    },
    confirmProfileGiftUpgrade: ({ id, gift, confirmation, keepOriginalDetails }, context) => {
      guard(context);
      return safe(connected().confirmProfileGiftUpgrade(id, gift, confirmation, keepOriginalDetails), "Could not confirm the gift upgrade.");
    },
    reviewProfileGiftConversion: ({ id, gift }, context) => {
      guard(context);
      return safe(connected().reviewProfileGiftConversion(id, gift), "Could not check the gift conversion.");
    },
    confirmProfileGiftConversion: ({ id, gift, confirmation }, context) => {
      guard(context);
      return safe(connected().confirmProfileGiftConversion(id, gift, confirmation), "Could not confirm the gift conversion.");
    },
    profilePhotos: ({ id, offset }, context) => { guard(context); return safe(connected().profilePhotos(id, offset), "Could not load Telegram profile photos."); },
    profileAudio: ({ id, offset }, context) => {
      guard(context); return safe(connected().profileAudio(id, offset), "Could not load Telegram profile audio.");
    },
    profileAudioPlayback: ({ id, index, fileId }, context) => {
      guard(context); return safe(downloads.issueProfileAudio(connected(), id, index, fileId), "Could not play the profile audio.");
    },
    changeProfileAudio: ({ id, change }, context) => {
      guard(context); return safe(connected().changeProfileAudio(id, change), "Could not update Telegram profile audio.");
    },
    addMessageProfileAudio: ({ id, messageId, fileId }, context) => {
      guard(context); return safe(connected().addMessageProfileAudio(id, messageId, fileId), "Could not add the track to your Telegram profile.");
    },
    profilePhoto: ({ id, offset, photoId }, context) => { guard(context); return safe(connected().profilePhoto(id, offset, photoId), "Could not load this Telegram profile photo."); },
    profilePhotoVideo: ({ id, offset, photoId, fileId }, context) => {
      guard(context);
      return safe(downloads.issueProfilePhotoVideo(connected(), id, offset, photoId, fileId), "Could not load this Telegram profile video.");
    },
    revokeBotLocationAccess: ({ id }, context) => {
      guard(context); return safe(connected().revokeBotLocationAccess(id), "Could not revoke bot location access.");
    },
    revokeBotEmojiAccess: ({ id }, context) => {
      guard(context); return safe(connected().revokeBotEmojiAccess(id), "Could not revoke bot emoji status access.");
    },
    peerProfile: ({ id }, context) => { guard(context); return safe(connected().peerProfile(id), "Could not load the Telegram profile."); },
    commonGroups: ({ id, after }, context) => {
      guard(context); return safe(connected().commonGroups(id, after), "Could not load groups in common.");
    },
    chatMembers: ({ id, query, offset, filter }, context) => { guard(context); return safe(connected().chatMembers(id, query, offset, filter), "Could not load members."); },
    setChatMemberTag: ({ id, userId, expected, tag }, context) => { guard(context); return safe(connected().setChatMemberTag(id, userId, expected, tag), "Could not confirm the Telegram member tag."); },
    canAddChatMember: ({ id, title }, context) => { guard(context); return safe(connected().canAddChatMember(id, title), "Could not load Telegram invitation permissions."); },
    addChatMember: ({ id, title, userId, name }, context) => { guard(context); return safe(connected().addChatMember(id, title, userId, name), "Could not confirm adding the contact to the chat."); },
    addChatMembers: ({ id, title, contacts }, context) => {
      guard(context); return safe(connected().addChatMembers(id, title, contacts), "Could not confirm adding contacts to the chat.");
    },
    saveChatAdministrator: ({ id, userId, available, selected, expected }, context) => { guard(context); return safe(connected().saveChatAdministrator(id, userId, available, selected, expected), "Could not confirm the change to Telegram administrator rights."); },
    demoteChatAdministrator: ({ id, userId }, context) => { guard(context); return safe(connected().demoteChatAdministrator(id, userId), "Could not confirm the change to Telegram administrator rights."); },
    restrictChatMember: ({ id, userId, duration, expected, denied, previous }, context) => { guard(context); return safe(connected().restrictChatMember(id, userId, duration, expected, denied, previous), "Could not confirm the Telegram member restriction."); },
    liftChatMemberRestrictions: ({ id, userId, until, isMember }, context) => { guard(context); return safe(connected().liftChatMemberRestrictions(id, userId, until, isMember), "Could not confirm the change to Telegram member restrictions."); },
    previewCommunityBan: ({ id, userId }, context) => {
      guard(context); return safe(connected().previewCommunityBan(id, userId), "Could not review the community ban.");
    },
    previewCommunityUnban: ({ id, memberId, bannedUntil }, context) => {
      guard(context); return safe(connected().previewCommunityUnban(id, memberId, bannedUntil), "Could not review the community unban.");
    },
    unbanCommunityMember: (input, context) => {
      guard(context); return safe(connected().unbanCommunityMember(input), "Could not confirm the community unban.");
    },
    banCommunityMember: (input, context) => {
      guard(context); return safe(connected().banCommunityMember(input), "Could not confirm the community ban.");
    },
    banChatMember: ({ id, userId, role, duration }, context) => { guard(context); return safe(connected().banChatMember(id, userId, role, duration), "Could not confirm the Telegram ban."); },
    moderateChatMember: (input, context) => {
      guard(context); return safe(connected().moderateChatMember(input), "Telegram did not confirm the member change.");
    },
    banMessageChatSender: ({ id, messageId, senderChatId }, context) => {
      guard(context);
      return safe(connected().banMessageChatSender(id, messageId, senderChatId), "Could not confirm the Telegram sender ban.");
    },
    unbanChatMember: (input, context) => {
      guard(context);
      const target = "userId" in input ? input.userId : { kind: "chat" as const, id: input.senderChatId };
      return safe(connected().unbanChatMember(input.id, target, input.bannedUntil), "Could not confirm the change to the Telegram ban.");
    },
    canScheduleWhenOnline: ({ id }, context) => {
      guard(context); return safe(connected().canScheduleWhenOnline(id), "Could not check online scheduling.");
    },
    scheduledMessages: ({ id, topicId }, context) => { guard(context); return safe(connected().scheduledMessages(id, topicId), "Could not load scheduled messages."); },
    changeScheduledMessage: ({ id, expected, at, topicId }, context) => {
      guard(context); return safe(connected().changeScheduledMessage(id, expected, at, topicId), "Could not update Telegram scheduling.");
    },
    cancelScheduledMessage: ({ id, messageId, topicId, album }, context) => { guard(context); return safe(connected().cancelScheduledMessage(id, messageId, topicId, album), "Could not cancel this scheduled message."); },
    richBankCard: ({ id, messageId, reference, mode }, context) => {
      guard(context);
      return connected().richBankCard(id, messageId, reference, mode);
    },
    runRichBotCommand: ({ id, messageId, command }, context) => {
      guard(context);
      return connected().runRichBotCommand(id, messageId, command);
    },
    send: async ({ id, text, replyTo, delivery }, context) => {
      guard(context);
      const current = connected();
      const result = await current.sendText(id, text, replyTo, undefined, undefined, undefined, undefined, undefined, delivery);
      if (result.state === "sent" && result.message.isChannelPost && replyTo === undefined && delivery?.at === undefined && !delivery?.whenOnline) {
        await current.recordManualChannelPost(id, result.message, text).catch(() => {
          bb.log.warn("Could not record authorship for a sent Telegram channel post.");
        });
      }
      return result;
    },
    savedNotificationSounds: (_, context) => { guard(context); return safe(connected().savedNotificationSounds(), "Could not load saved notification sounds."); },
    previewNotificationSound: ({ id }, context) => { guard(context); return safe(connected().previewNotificationSound(id), "Could not load the notification sound."); },
    addNotificationSound: ({ base64 }, context) => { guard(context); return safe(connected().addNotificationSound(base64), "Could not add the notification sound."); },
    removeNotificationSound: ({ id }, context) => { guard(context); return connected().removeNotificationSound(id); },
    reactionNotifications: (_, context) => { guard(context); return safe(connected().reactionNotifications(), "Could not load reaction notifications."); },
    saveReactionNotifications: ({ values, expected }, context) => {
      guard(context); return safe(connected().saveReactionNotifications(values, expected), "Could not save reaction notifications.");
    },
    notificationExceptions: ({ scope, offset }, context) => {
      guard(context); return safe(connected().notificationExceptions(scope, offset), "Could not load notification exceptions.");
    },
    scopeNotifications: ({ scope }, context) => {
      guard(context); return safe(connected().scopeNotifications(scope), "Could not load notification defaults.");
    },
    saveScopeNotifications: ({ scope, expected, values }, context) => {
      guard(context); return safe(connected().saveScopeNotifications(scope, values, expected), "Could not save notification defaults.");
    },
    chatNotificationState: ({ id, topicId }, context) => { guard(context); return safe(connected().chatNotificationState(id, topicId), "Could not check this chat’s notification setting."); },
    setChatNotificationOverride: ({ id, field, value, expected, topicId }, context) => {
      guard(context); return connected().setChatNotificationOverride(id, field, value, expected, topicId);
    },
    setChatNotificationSound: ({ id, value, expected, topicId, story }, context) => { guard(context); return connected().setChatNotificationSound(id, value, expected, topicId, story); },
    setChatNotificationMode: ({ id, mode, muteFor, topicId }, context) => { guard(context); return connected().setChatNotificationMode(id, mode, muteFor, topicId); },
    pinnedChatOrder: ({ list }, context) => { guard(context); return safe(connected().pinnedChatOrder(list), "Could not load pinned chat order."); },
    movePinnedChat: ({ list, id, direction, expected }, context) => { guard(context); return connected().movePinnedChat(list, id, direction, expected); },
    chatPinStatus: ({ id, list }, context) => { guard(context); return safe(connected().chatPinStatus(id, list), "Could not check this chat pin."); },
    setChatPinned: ({ id, list, pinned }, context) => { guard(context); return connected().setChatPinned(id, list, pinned); },
    archiveChat: ({ id, archived }, context) => { guard(context); return safe(connected().archiveChat(id, archived), "Could not move this chat."); },
    previewInvite: ({ url }, context) => { guard(context); return safe(connected().previewInvite(url), "Could not check this Telegram invite."); },
    previewWebLink: ({ url }, context) => { guard(context); return safe(connected().previewWebLink(url), "Could not load the link preview."); },
    joinInvite: ({ url, expected }, context) => { guard(context); return connected().joinInvite(url, expected); },
    joinChat: ({ id, name }, context) => { guard(context); return connected().joinChat(id, name); },
    chatLeaveOptions: ({ id, name }, context) => {
      guard(context); return safe(connected().chatLeaveOptions(id, name), "Could not check whether you can leave this chat.");
    },
    botCommands: ({ id }, context) => { guard(context); return safe(connected().botCommands(id), "Could not load bot commands."); },
    setRecordingActivity: ({ id, activity, topicId }, context) => {
      guard(context);
      return safe(connected().setRecordingActivity(id, activity, topicId), "Could not update recording activity.");
    },
    openChatView: ({ id, view, open }, context) => {
      guard(context);
      return safe(connected().openChatView(id, view, open), "Could not update the open Telegram chat.");
    },
    peerPresence: ({ id }, context) => {
      guard(context);
      return safe(connected().peerPresence(id), "Could not load Telegram presence.");
    },
    retryFailedMessage: ({ id, messageId }, context) => {
      guard(context);
      return connected().retryFailedMessage(id, messageId);
    },
    setTypingActivity: ({ id, typing, topicId }, context) => {
      guard(context);
      return safe(connected().setTypingActivity(id, typing, topicId), "Could not update typing activity.");
    },
    replyBotKeyboard: ({ id, topicId }, context) => {
      guard(context);
      return safe(connected().replyBotKeyboard(id, topicId), "Could not load the bot keyboard.");
    },
    launchReplyMiniApp: ({ id, messageId, row, column, revision }, context) => {
      guard(context); return safe(connected().launchReplyMiniApp(id, messageId, row, column, revision), "Could not open the reply Mini App.");
    },
    sendReplyMiniAppData: ({ session, data }, context) => {
      guard(context); return safe(connected().sendReplyMiniAppData(session, data), "Could not send the Mini App data.");
    },
    pressReplyBotButton: ({ id, topicId, messageId, row, column, revision }, context) => {
      guard(context);
      return connected().pressReplyBotButton(id, messageId, row, column, revision, topicId);
    },
    pressInlineBotButton: ({ id, messageId, row, column, revision }, context) => {
      guard(context);
      return connected().pressInlineBotButton(id, messageId, row, column, revision);
    },
    inlineBotProfile: ({ id, messageId, row, column, revision }, context) => {
      guard(context);
      return safe(connected().inlineBotProfile(id, messageId, row, column, revision), "Could not open the Telegram profile.");
    },
    inlineBotDestinationChats: ({ id, messageId, row, column, revision, query }, context) => {
      guard(context);
      return safe(connected().inlineBotDestinationChats(id, messageId, row, column, revision, query), "Could not find eligible Telegram chats.");
    },
    inlineBotDestinationChat: ({ id, messageId, row, column, revision, destination }, context) => {
      guard(context);
      return safe(connected().inlineBotDestinationChat(id, messageId, row, column, revision, destination), "Could not check the selected Telegram chat.");
    },
    inlineBotDestinationTopics: ({ id, messageId, row, column, revision, destination, query, cursor }, context) => {
      guard(context);
      return safe(connected().inlineBotDestinationTopics(id, messageId, row, column, revision, destination, query, cursor), "Could not find eligible Telegram topics.");
    },
    inlineBotDestinationTopic: ({ id, messageId, row, column, revision, destination, topic }, context) => {
      guard(context);
      return safe(connected().inlineBotDestinationTopic(id, messageId, row, column, revision, destination, topic), "Could not check the selected Telegram topic.");
    },
    canReportChat: ({ id }, context) => { guard(context); return safe(connected().canReportChat(id), "Could not check report availability."); },
    reportChat: ({ id, name, step, messageIds }, context) => { guard(context); return connected().reportChat(id, name, step, messageIds); },
    leaveChat: ({ id, name, expectedOwner }, context) => { guard(context); return connected().leaveChat(id, name, expectedOwner); },
    createPrivateChatSpace: ({ title, kind }, context) => {
      guard(context);
      return safe(connected().createPrivateChatSpace(title, kind), "Telegram did not confirm creation. Check the chat list before retrying.");
    },
    deleteOwnedChatSpace: ({ id, title, kind }, context) => {
      guard(context);
      return connected().deleteOwnedChatSpace(id, title, kind);
    },
    postingPermissions: ({ id }, context) => { guard(context); return safe(connected().composerPostingPermissions(id), "Could not check posting permission."); },
    postingAllowed: ({ id }, context) => { guard(context); return safe(connected().postingAllowed(id), "Could not check posting permission."); },
    markActivityRead: ({ id, filter, topicId }, context) => {
      guard(context); return safe(connected().markActivityRead(id, filter, topicId), "Could not mark Telegram activity as read.");
    },
    markChat: ({ id, unread }, context) => { guard(context); return safe(connected().markChat(id, unread), "Could not update the read state."); },
    markHistoryRead: ({ id, messageId, topicId, clearUnreadMark }, context) => {
      guard(context); return safe(connected().markHistoryRead(id, messageId, topicId, clearUnreadMark), "Could not update the read state.");
    },
    markChatListRead: ({ list }, context) => {
      guard(context); return safe(connected().markChatListRead(list), "Could not mark the selected list as read.");
    },
    prepareVoiceTranscription: ({ id, messageId }, context) => {
      guard(context);
      const current = connected();
      const now = Date.now();
      for (const [ticket, job] of transcriptions) {
        if (!job.started && job.expires <= now) transcriptions.delete(ticket);
      }
      if (transcriptions.size >= 32) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Too many local transcription requests." });
      }
      const ticket = randomUUID();
      transcriptions.set(ticket, { session: current, chatId: id, messageId, expires: now + 60_000,
        controller: new AbortController(), started: false });
      return ticket;
    },
    transcribeVoice: ({ id, messageId, ticket, timed }, context) => {
      guard(context);
      const current = connected();
      const failure = "Could not transcribe this note on this Mac.";
      if (!ticket) return safe(current.transcribeVoice(id, messageId, context.experimental_signal, timed), failure);
      const job = transcriptions.get(ticket);
      if (!job || job.started || job.expires <= Date.now() || job.session !== current
        || job.chatId !== id || job.messageId !== messageId) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "This transcription request is unavailable." });
      }
      job.started = true;
      const signal = AbortSignal.any([job.controller.signal, context.experimental_signal]);
      return safe((async () => {
        try { return await current.transcribeVoice(id, messageId, signal, timed); }
        finally { transcriptions.delete(ticket); }
      })(), failure);
    },
    cancelVoiceTranscription: ({ ticket }, context) => {
      guard(context);
      const current = connected();
      const job = transcriptions.get(ticket);
      if (!job || job.session !== current || job.controller.signal.aborted) return false;
      job.controller.abort();
      if (!job.started) transcriptions.delete(ticket);
      return true;
    },
    markNotePlayed: ({ id, messageId }, context) => { guard(context); return safe(connected().markNotePlayed(id, messageId), "Could not update note playback status."); },
    tgsSticker: ({ id, messageId }, context) => {
      guard(context); return safe(connected().tgsSticker(id, messageId), "Could not load the Telegram sticker.");
    },
    messageEffect: ({ id, messageId, effect, animate }, context) => {
      guard(context); return safe(connected().messageEffect(id, messageId, effect, animate), "Could not load the Telegram message effect.");
    },
    messageEffects: ({ id }, context) => {
      guard(context); return safe(connected().messageEffects(id), "Could not load available Telegram message effects.");
    },
    customEmoji: ({ id }, context) => {
      guard(context); return safe(connected().customEmoji(id), "Could not load the Telegram emoji.");
    },
    customEmojiPack: ({ id, offset, packId }, context) => {
      guard(context); return safe(connected().customEmojiPack(id, offset, packId), "Could not open the Telegram emoji pack.");
    },
    queueDownload: ({ id, messageId }, context) => {
      guard(context); return startQueuedDownload((current) => current.queueDownload(id, messageId));
    },
    downloadCounts: (_, context) => {
      guard(context); return safe(connected().downloadCounts(), "Could not read Telegram download activity.");
    },
    downloadThumbnail: ({ id, messageId, fileId }, context) => {
      guard(context); return connected().downloadThumbnail(id, messageId, fileId);
    },
    downloadQueue: ({ filter, offset, query }, context) => {
      guard(context); return safe(connected().downloadQueue(filter, offset, query), "Could not load Telegram downloads.");
    },
    manageDownload: ({ fileId, action }, context) => {
      guard(context);
      if (action === "resume") return startQueuedDownload((current) => current.manageDownload(fileId, action));
      return connected().manageDownload(fileId, action);
    },
    pauseAllDownloads: ({ paused }, context) => {
      guard(context);
      if (!paused) return startQueuedDownload((current) => current.pauseAllDownloads(false));
      return connected().pauseAllDownloads(true);
    },
    clearCompletedDownloads: (_, context) => {
      guard(context); return safe(connected().clearCompletedDownloads(), "Could not clear completed Telegram downloads.");
    },
    videoStream: ({ id, messageId, attachment, motionFileId, qualityFileId, playbackFileId }, context) => {
      guard(context);
      const current = connected();
      return safe(qualityFileId === undefined ? downloads.issueVideo(current, id, messageId, attachment, motionFileId, playbackFileId)
        : downloads.issueVideoQuality(current, id, messageId, qualityFileId, playbackFileId), "Could not stream this media.");
    },
    document: ({ id, messageId, playback, oneView, attachment, playbackFileId }, context) => { guard(context); return safe(downloads.issue(connected(), id, messageId, playback, oneView, attachment, playbackFileId), "Could not download this document."); },
    preparePhotoDrag: ({ id, messageId }, context) => {
      guard(context);
      return safe(downloads.issuePhotoDrag(connected(), id, messageId), "Could not prepare this photo to drag.");
    },
    markdownDocument: ({ id, messageId, attachment, format }, context) => {
      guard(context); return safe(connected().markdownDocument(id, messageId, attachment, format), "Could not preview this file.");
    },
    avatar: ({ id, fileId, user }, context) => { guard(context); return safe(connected().avatar(id, fileId, user), "Could not load this avatar."); },
    translateMessage: ({ id, messageId, language }, context) => {
      guard(context); return safe(connected().translateMessage(id, messageId, language), "Could not translate this message.");
    },
    instantView: ({ url }, context) => {
      guard(context); return safe(connected().instantView(url), "Could not open Instant View.");
    },
    instantViewDocument: ({ url, fileId }, context) => {
      guard(context); return safe(downloads.issueArticleDocument(connected(), url, fileId), "Could not download the article document.");
    },
    instantViewMap: ({ url, point }, context) => {
      guard(context); return safe(connected().instantViewMap(url, point), "Could not load this article map.");
    },
    instantViewMention: ({ url, userId }, context) => {
      guard(context); return safe(connected().instantViewMention(url, userId), "Could not open the mentioned Telegram user.");
    },
    instantViewJoinTarget: ({ url, target }, context) => {
      guard(context); return safe(connected().instantViewJoinTarget(url, target), "Could not check channel membership.");
    },
    joinInstantViewChat: ({ url, target, expected }, context) => {
      guard(context); return connected().joinInstantViewChat(url, target, expected);
    },
    instantViewIcon: ({ url, fileId }, context) => {
      guard(context); return safe(connected().instantViewIcon(url, fileId), "Could not load this article icon.");
    },
    instantViewPhoto: ({ url, fileId, size }, context) => {
      guard(context); return safe(connected().instantViewPhoto(url, fileId, size), "Could not open the article photo.");
    },
    messageWidgetPreview: ({ id, messageId }, context) => {
      guard(context); return safe(connected().messageWidgetPreview(id, messageId), "Could not open the bot widget.");
    },
    messagePreviewCover: ({ id, messageId, fileId, size }, context) => {
      guard(context); return safe(connected().messagePreviewCover(id, messageId, fileId, size), "Could not open the message preview cover.");
    },
    messagePreviewPlayback: ({ id, messageId, fileId }, context) => {
      guard(context); return safe(downloads.issueMessagePreviewPlayback(connected(), id, messageId, fileId), "Could not open the message preview media.");
    },
    instantViewPlayback: ({ url, fileId }, context) => {
      guard(context); return safe(downloads.issueArticlePlayback(connected(), url, fileId), "Could not open the article media.");
    },
    locationMap: ({ id, messageId }, context) => {
      guard(context); return safe(connected().locationMap(id, messageId), "Could not load this map preview.");
    },
    pollDocument: ({ id, messageId, reference }, context) => {
      guard(context); return safe(downloads.issuePollDocument(connected(), id, messageId, reference), "Could not download this poll file.");
    },
    pollPlayback: ({ id, messageId, reference }, context) => {
      guard(context); return safe(downloads.issuePollPlayback(connected(), id, messageId, reference), "Could not play this poll file.");
    },
    pollStickerArtwork: ({ id, messageId, reference }, context) => {
      guard(context); return safe(connected().pollStickerArtwork(id, messageId, reference), "Could not load this sticker.");
    },
    pollPhoto: ({ id, messageId, reference, size }, context) => {
      guard(context); return safe(connected().pollPhoto(id, messageId, reference, size), "Could not load this poll photo.");
    },
    photo: ({ id, messageId, size, attachment }, context) => { guard(context); return safe(connected().photo(id, messageId, size, attachment), "Could not load this photo."); },
    recognizePhotoText: ({ id, messageId, size, sha256 }, context) => {
      guard(context);
      const current = connected();
      return safe(current.recognizePhotoText(id, messageId, size, sha256).then((result) => connected() === current ? result : null),
        "Could not recognize text in this photo.");
    },
    drawPhotoReplyTarget: ({ id, messageId, topicId }, context) => {
      guard(context); return safe(connected().drawPhotoReplyTarget(id, messageId, topicId), "Could not check photo availability.");
    },
    channelDirectMessages: ({ id }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const chat = await session.channelDirectMessages(id);
        return connected() === session ? chat : null;
      })(), "Could not open channel direct messages.");
    },
    channelInboxTopics: ({ id, inboxId, offset }, context) => {
      guard(context);
      return safe(connected().channelInboxTopics(id, inboxId, offset), "Could not load the channel inbox.");
    },
    channelInboxTopicsSnapshot: ({ id, inboxId, count, selected }, context) => {
      guard(context);
      return safe(connected().channelInboxTopicsSnapshot(id, inboxId, count, selected), "Could not refresh the channel inbox.");
    },
    channelInboxHistory: ({ id, inboxId, topicId, before, after }, context) => {
      guard(context);
      return safe(connected().channelInboxHistory(id, inboxId, topicId, before, after), "Could not load the channel inbox conversation.");
    },
    channelInboxMessage: ({ id, inboxId, topicId, messageId }, context) => {
      guard(context);
      return safe(connected().channelInboxMessage(id, inboxId, topicId, messageId), "Could not load the incoming channel inbox message.");
    },
    editChannelInboxText: ({ id, inboxId, topicId, messageId, text, original, originalStyles, styles, removeLinkPreview, links, customEmoji }, context) => {
      guard(context);
      return connected().editText(inboxId, messageId, text, original, originalStyles, styles, removeLinkPreview, links, undefined, customEmoji,
        { channelId: id, topicId });
    },
    editChannelInboxCaption: ({ id, inboxId, topicId, messageId, text, original, originalStyles, styles, placement, links, customEmoji }, context) => {
      guard(context);
      return connected().editCaption(inboxId, messageId, text, original, originalStyles, styles, placement, links, undefined, customEmoji,
        { channelId: id, topicId });
    },
    searchChannelInboxMessages: ({ id, inboxId, topicId, query, before, range, filter }, context) => {
      guard(context);
      return safe(connected().searchChannelInboxMessages(id, inboxId, topicId, query, before, range, filter), "Could not search the channel inbox conversation.");
    },
    channelInboxMessageAtDate: ({ id, inboxId, topicId, date }, context) => {
      guard(context);
      return safe(connected().channelInboxMessageAtDate(id, inboxId, topicId, date), "Could not locate messages by date in the channel inbox.");
    },
    channelInboxMessageContext: ({ id, inboxId, topicId, messageId, direction }, context) => {
      guard(context);
      return safe(connected().channelInboxMessageContext(id, inboxId, topicId, messageId, direction), "Could not load nearby channel inbox messages.");
    },
    markChannelInboxTopic: ({ id, inboxId, topicId, unread }, context) => {
      guard(context);
      return safe(connected().markChannelInboxTopic(id, inboxId, topicId, unread), "Could not update the inbox read state.");
    },
    markVisibleChannelInboxMessage: ({ id, inboxId, topicId, messageId, clearUnreadMark }, context) => {
      guard(context);
      return safe(connected().markVisibleChannelInboxMessage(id, inboxId, topicId, messageId, clearUnreadMark),
        "Could not mark the visible inbox message as read.");
    },
    channelInboxBan: ({ id, inboxId, topicId }, context) => {
      guard(context);
      return safe(connected().channelInboxBan(id, inboxId, topicId), "Could not check the channel ban.");
    },
    changeChannelInboxBan: ({ id, inboxId, topicId, expected }, context) => {
      guard(context);
      return connected().changeChannelInboxBan(id, inboxId, topicId, expected);
    },
    clearChannelInboxByDate: ({ id, inboxId, topicId, range }, context) => {
      guard(context);
      return connected().clearChannelInboxHistory(id, inboxId, topicId, range);
    },
    clearChannelInboxConversation: ({ id, inboxId, topicId }, context) => {
      guard(context);
      return connected().clearChannelInboxHistory(id, inboxId, topicId, null);
    },
    channelInboxMessageDeletable: ({ id, inboxId, topicId, messageId }, context) => {
      guard(context);
      return safe(connected().channelInboxMessageDeletable(id, inboxId, topicId, messageId), "Could not check Telegram deletion permissions.");
    },
    channelInboxSelectionDeletable: (scope, context) => {
      guard(context);
      return safe(connected().channelInboxSelectionDeletable(scope), "Could not check Telegram deletion permissions.");
    },
    channelInboxMessagePinStatus: ({ id, inboxId, topicId, messageId }, context) => {
      guard(context);
      return safe(connected().channelInboxMessagePinStatus(id, inboxId, topicId, messageId), "Could not check pin permissions.");
    },
    setChannelInboxMessagePinned: ({ id, inboxId, topicId, messageId, pinned }, context) => {
      guard(context);
      return connected().setChannelInboxMessagePinned(id, inboxId, topicId, messageId, pinned);
    },
    channelInboxBulkUnpinPreview: ({ id, inboxId, topicId }, context) => {
      guard(context);
      return safe(connected().channelInboxBulkUnpinPreview(id, inboxId, topicId), "Could not check the pinned messages.");
    },
    unpinChannelInboxMessages: ({ id, inboxId, topicId, messageId }, context) => {
      guard(context);
      return connected().unpinChannelInboxMessages(id, inboxId, topicId, messageId);
    },
    deleteChannelInboxMessage: ({ id, inboxId, topicId, messageId }, context) => {
      guard(context);
      return connected().deleteChannelInboxMessage(id, inboxId, topicId, messageId);
    },
    deleteChannelInboxSelection: (scope, context) => {
      guard(context);
      return connected().deleteChannelInboxSelection(scope);
    },
    runChannelInboxRichBotCommand: ({ id, inboxId, topicId, messageId, command }, context) => {
      guard(context);
      return connected().runChannelInboxRichBotCommand(id, inboxId, topicId, messageId, command);
    },
    sendChannelInboxText: ({ id, inboxId, topicId, text, replyTo, format }, context) => {
      guard(context);
      return connected().sendChannelInboxText(id, inboxId, topicId, text, replyTo, format);
    },
    notificationChat: ({ id }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const chat = await session.chatById(id);
        return connected() === session && chat?.id === id ? chat : null;
      })(), "Could not open this Telegram chat.");
    },
    resumeConversation: ({ id, list, topicId }, context) => {
      guard(context);
      const current = connected();
      return safe(current.resumeConversation(id, list, topicId).then((target) =>
        connected() === current ? target : null), "Could not reopen this Telegram conversation.");
    },
    botMiniAppMenu: ({ id }, context) => { guard(context); return safe(connected().botMiniAppMenu(id), "Could not load the bot menu."); },
    launchBotMiniAppMenu: ({ id, revision }, context) => {
      guard(context); return safe(connected().launchBotMiniAppMenu(id, revision), "Could not open the bot menu Mini App.");
    },
    attachmentMiniApps: ({ id, topic }, context) => {
      guard(context); return safe(connected().attachmentMiniApps(id, topic), "Could not load attachment Mini Apps.");
    },
    launchAttachmentMiniApp: ({ id, app, topic }, context) => {
      guard(context); return safe(connected().launchAttachmentMiniApp(id, app, topic), "Could not open the attachment Mini App.");
    },
    sideMenuMiniApps: (_, context) => {
      guard(context); return safe(connected().sideMenuMiniApps(), "Could not load sidebar Mini Apps.");
    },
    launchSideMenuMiniApp: ({ app, acceptedTerms }, context) => {
      guard(context); return safe(connected().launchSideMenuMiniApp(app, acceptedTerms), "Could not open the sidebar Mini App.");
    },
    installedMenuMiniApps: (_, context) => {
      guard(context); return safe(connected().installedMenuMiniApps(), "Could not load installed Mini Apps.");
    },
    removeMenuMiniApp: ({ app }, context) => {
      guard(context); return safe(connected().removeMenuMiniApp(app), "Could not remove the Mini App.");
    },
    previewAttachmentMiniAppLink: ({ url, id, topic }, context) => {
      guard(context); return safe(connected().previewAttachmentMiniAppLink(url, id, topic), "Could not check the attachment Mini App link.");
    },
    attachmentMiniAppLinkChats: ({ url, query }, context) => {
      guard(context); return safe(connected().attachmentMiniAppLinkChats(url, query), "Could not find eligible attachment Mini App chats.");
    },
    resolveAttachmentMiniAppDestination: ({ url }, context) => {
      guard(context); return safe(connected().resolveAttachmentMiniAppDestination(url), "Could not open the attachment Mini App destination.");
    },
    launchAttachmentMiniAppLink: ({ url, id, topic, expected, consent }, context) => {
      guard(context); return safe(connected().launchAttachmentMiniAppLink(url, id, expected, consent, topic), "Could not open the linked attachment Mini App.");
    },
    launchInlineMiniApp: ({ id, messageId, row, column, revision }, context) => {
      guard(context); return safe(connected().launchInlineMiniApp(id, messageId, row, column, revision), "Could not open the bot Mini App.");
    },
    previewMiniAppInvoice: ({ session, slug }, context) => {
      guard(context); return safe(connected().previewMiniAppInvoice(session, slug), "Could not load the Mini App invoice.");
    },
    starSubscriptions: ({ offset }, context) => {
      guard(context); return safe(connected().starSubscriptions(offset), "Could not load Stars subscriptions.");
    },
    starTransactions: ({ offset, direction, subscription, ownerChat }, context) => {
      guard(context); return safe(connected().starTransactions(offset, direction, subscription, ownerChat), "Could not load Stars transactions.");
    },
    channelStarRevenue: ({ id }, context) => {
      guard(context); return safe(connected().channelStarRevenue(id), "Could not load channel Stars revenue.");
    },
    editStarSubscription: ({ offset, expected, cancel }, context) => {
      guard(context); return safe(connected().editStarSubscription(offset, expected, cancel), "Could not update the Stars subscription.");
    },
    payMiniAppInvoice: ({ session, confirmation }, context) => {
      guard(context); return safe(connected().payMiniAppInvoice(session, confirmation), "Could not verify payment status.");
    },
    purchasePaidMedia: ({ id, messageId, stars }, context) => {
      guard(context); return safe(connected().purchasePaidMedia(id, messageId, stars), "Could not verify paid media purchase.");
    },
    previewMiniAppPhone: ({ session }, context) => {
      guard(context); return safe(connected().previewMiniAppPhone(session), "Could not verify the Mini App bot.");
    },
    shareMiniAppPhone: ({ session, confirmation }, context) => {
      guard(context); return safe(connected().shareMiniAppPhone(session, confirmation), "Could not confirm phone sharing.");
    },
    miniAppWriteAccess: ({ session, confirm }, context) => {
      guard(context); return safe(connected().miniAppWriteAccess(session, confirm), "Could not update bot messaging permission.");
    },
    previewMiniAppEmojiAccess: ({ session }, context) => {
      guard(context); return connected().previewMiniAppEmojiAccess(session);
    },
    confirmMiniAppEmojiAccess: ({ session, confirmation }, context) => {
      guard(context); return connected().confirmMiniAppEmojiAccess(session, confirmation);
    },
    previewMiniAppEmojiStatus: ({ session, emoji, duration }, context) => {
      guard(context); return connected().previewMiniAppEmojiStatus(session, emoji, duration);
    },
    confirmMiniAppEmojiStatus: ({ session, confirmation }, context) => {
      guard(context); return connected().confirmMiniAppEmojiStatus(session, confirmation);
    },
    miniAppLocationAccess: ({ session, decision }, context) => {
      guard(context); return connected().miniAppLocationAccess(session, decision);
    },
    miniAppSecureStorage: ({ session, operation }, context) => {
      guard(context); return connected().miniAppSecureStorage(session, operation);
    },
    miniAppDeviceStorage: ({ session, operation }, context) => {
      guard(context); return connected().miniAppDeviceStorage(session, operation);
    },
    miniAppClipboardAccess: ({ session }, context) => {
      guard(context); return safe(connected().miniAppClipboardAccess(session), "Could not check Mini App clipboard access.");
    },
    checkMiniAppDownload: ({ session, url, fileName }, context) => {
      guard(context); return safe(connected().checkMiniAppDownload(session, url, fileName), "Could not check the Mini App download.");
    },
    invokeMiniAppCustomMethod: ({ session, method, parameters }, context) => {
      guard(context);
      return safe(connected().invokeMiniAppCustomMethod(session, method, parameters), "Could not complete the Mini App request.");
    },
    previewMiniAppPreparedMessage: ({ session, id }, context) => {
      guard(context); return connected().previewMiniAppPreparedMessage(session, id);
    },
    miniAppPreparedThumbnail: ({ session, confirmation }, context) => {
      guard(context); return connected().miniAppPreparedThumbnail(session, confirmation);
    },
    miniAppPreparedChats: ({ session, confirmation, query }, context) => {
      guard(context); return connected().miniAppPreparedChats(session, confirmation, query);
    },
    miniAppPreparedTopics: ({ session, confirmation, id, query, cursor }, context) => {
      guard(context); return connected().miniAppPreparedTopics(session, confirmation, id, query, cursor);
    },
    sendMiniAppPreparedMessage: ({ session, confirmation, id, expectedName, topic }, context) => {
      guard(context); return connected().sendMiniAppPreparedMessage(session, confirmation, id, expectedName, topic);
    },
    miniAppInlineChats: ({ session, types, query }, context) => {
      guard(context); return safe(connected().miniAppInlineChats(session, types, query), "Could not find eligible Telegram chats.");
    },
    miniAppInlineTopics: ({ session, types, id, query, cursor }, context) => {
      guard(context); return safe(connected().miniAppInlineTopics(session, types, id, query, cursor), "Could not find eligible Telegram topics.");
    },
    miniAppInlineDestination: ({ session, types, id, topic }, context) => {
      guard(context); return safe(connected().miniAppInlineDestination(session, types, id, topic), "Could not check the selected Telegram destination.");
    },
    previewMiniAppChatRequest: ({ session, requestId }, context) => {
      guard(context); return connected().previewMiniAppChatRequest(session, requestId);
    },
    findMiniAppRequestedChats: ({ session, confirmation, query }, context) => {
      guard(context); return safe(connected().findMiniAppRequestedChats(session, confirmation, query), "Could not find eligible Telegram chats.");
    },
    shareMiniAppRequestedChats: ({ session, confirmation, selected }, context) => {
      guard(context); return connected().shareMiniAppRequestedChats(session, confirmation, selected);
    },
    createMiniAppRequestedChat: ({ session, confirmation, title, username }, context) => {
      guard(context); return connected().createMiniAppRequestedChat(session, confirmation, title, username);
    },
    createMiniAppManagedBot: ({ session, confirmation, draft }, context) => {
      guard(context); return connected().createMiniAppManagedBot(session, confirmation, draft);
    },
    previewManagedBotLink: ({ url }, context) => {
      guard(context); return safe(connected().previewManagedBotLink(url), "Could not open the Telegram managed bot link.");
    },
    createLinkedManagedBot: ({ confirmation, draft }, context) => {
      guard(context); return connected().createLinkedManagedBot(confirmation, draft);
    },
    closeMiniApp: ({ session }, context) => {
      guard(context);
      miniAppAgent.remove(session);
      return safe(connected().closeMiniApp(session), "Could not close the Mini App session.");
    },
    miniAppAgentGrant: async ({ session: token, threadId, mode, snapshot }, context) => {
      guard(context);
      const current = connected();
      if (!current.hasMiniAppSession(token) || !await bb.sdk.threads.get({ threadId })
        || agentSession() !== current || !current.hasMiniAppSession(token)) return false;
      miniAppAgent.grant(token, threadId, mode, snapshot);
      return true;
    },
    miniAppAgentRevoke: ({ session: token }, context) => {
      guard(context);
      miniAppAgent.revoke(token);
      return true;
    },
    miniAppAgentPoll: ({ session: token, snapshot, completed }, context) => {
      guard(context);
      return agentSession()?.hasMiniAppSession(token) ? miniAppAgent.poll(token, snapshot, completed) : null;
    },
    launchProfileMiniApp: ({ id }, context) => {
      guard(context); return safe(connected().launchProfileMiniApp(id), "Could not open the bot’s main Mini App.");
    },
    launchMiniApp: ({ url }, context) => {
      guard(context); return safe(connected().launchMiniApp(url), "Could not open the Telegram Mini App.");
    },
    launchAgeVerification: ({ expectedBot }, context) => {
      guard(context);
      return safe(connected().launchAgeVerification(expectedBot, context.experimental_signal), "Could not open Telegram age verification.");
    },
    resolveBotStartLink: ({ url }, context) => { guard(context); return safe(connected().resolveBotStartLink(url), "Could not open the Telegram bot link."); },
    resolveGameLink: ({ url }, context) => { guard(context); return safe(connected().resolveGameLink(url), "Could not open the Telegram game link."); },
    gameLinkChats: ({ query }, context) => { guard(context); return safe(connected().gameLinkChats(query), "Could not find chats for this game."); },
    gameLinkTopics: ({ id, query, cursor }, context) => { guard(context); return safe(connected().gameLinkTopics(id, query, cursor), "Could not find topics for this game."); },
    sendGameLink: ({ url, bot, target }, context) => {
      guard(context);
      const current = connected();
      return current.sendGameLink(url, bot, target, () => !context.experimental_signal.aborted && connected() === current);
    },
    resolveTemporaryContactLink: ({ url }, context) => {
      guard(context);
      const current = connected();
      return safe(current.resolveTemporaryContactLink(url).then((chat) => connected() === current ? chat : null),
        "Could not open this temporary Telegram profile.");
    },
    resolveBusinessChatLink: ({ url }, context) => {
      guard(context);
      const current = connected();
      return safe(current.resolveBusinessChatLink(url).then((result) => connected() === current ? result : null),
        "Could not open this Telegram Business chat link.");
    },
    startLinkedBot: ({ url, id, name }, context) => { guard(context); return connected().startLinkedBot(url, id, name); },
    resolveCollectibleGift: ({ url }, context) => {
      guard(context); return safe(connected().resolveCollectibleGift(url), "Could not load this Telegram collectible gift.");
    },
    resolveBoostLink: ({ url }, context) => {
      guard(context); return safe(connected().resolveBoostLink(url), "Could not resolve this Telegram boost link.");
    },
    resolveMessageLink: ({ url }, context) => {
      guard(context);
      const current = connected();
      return safe((async () => {
        const reference = await current.clientLinkReference(url);
        if (!reference) return null;
        const { chatId, ...target } = reference;
        const chat = await current.chatById(chatId);
        if (!chat || chat.id !== chatId || connected() !== current) return null;
        return { chat, ...target };
      })(), "Could not open this Telegram link.");
    },
    messageLink: ({ id, messageId, target }, context) => { guard(context); return safe(connected().messageLink(id, messageId, target), "Could not get a Telegram link."); },
    forumTopicLink: ({ id, topic }, context) => { guard(context); return safe(connected().forumTopicLink(id, topic), "Could not get a Telegram topic link."); },
    sendChannelComment: ({ id, messageId, group, root, text }, context) => { guard(context); return connected().sendChannelComment(id, messageId, group, root, text); },
    channelDiscussion: ({ id, messageId, before }, context) => { guard(context); return safe(connected().channelDiscussion(id, messageId, before), "Could not load channel discussion."); },
    firstUnreadMessage: ({ id, topicId }, context) => {
      guard(context); return safe(connected().firstUnreadMessage(id, topicId), "Could not find the unread boundary.");
    },
    messageAtDate: ({ id, date, topicId }, context) => {
      guard(context); return safe(connected().messageAtDate(id, date, topicId), "Could not locate messages by date.");
    },
    messageContextPage: ({ id, messageId, direction, topicId }, context) => {
      guard(context); return safe(connected().messageContextPage(id, messageId, direction, topicId), "Could not extend Telegram message context.");
    },
    historyMessage: ({ id, messageId, topicId }, context) => {
      guard(context);
      return safe(connected().historyMessage(id, messageId, topicId), "Could not refresh this message.");
    },
    messageContext: ({ id, messageId, topicId }, context) => { guard(context); return safe(connected().messageContext(id, messageId, topicId), "Could not load messages around this result."); },
    globalSearch: ({ query, mode, cursor, filter, range, scope }, context) => { guard(context); return safe(connected().globalSearch(query, mode, cursor, filter, range, scope), "Could not search Telegram."); },
    globalMediaThumbnail: ({ id, messageId, fileId }, context) => {
      guard(context); return connected().globalMediaThumbnail(id, messageId, fileId);
    },
    recentPublicTags: ({ prefix }, context) => {
      guard(context); return safe(connected().recentPublicTags(prefix), "Could not load recent search tags.");
    },
    removeRecentPublicTag: ({ tag }, context) => {
      guard(context); return safe(connected().removeRecentPublicTag(tag), "Could not remove the search tag.");
    },
    clearRecentPublicTags: ({ kind }, context) => {
      guard(context); return safe(connected().clearRecentPublicTags(kind), "Could not clear the recent search tags.");
    },
    searchPublicDiscovery: ({ query, mode }, context) => {
      guard(context); return safe(connected().searchPublicDiscovery(query, mode), "Could not search public Telegram chats.");
    },
    browsePublicDiscovery: ({ mode, offset }, context) => {
      guard(context); return safe(connected().browsePublicDiscovery(mode, offset), "Could not browse public Telegram chats.");
    },
    searchMessages: ({ id, query, filter, topicId, before, sender, range }, context) => { guard(context); return safe(connected().searchMessages(id, query, filter, topicId, before, sender, range), "Could not search this conversation."); },
    sharedContentCounts: ({ id }, context) => { guard(context); return connected().sharedContentCounts(id); },
    manageForumTopic: ({ id, action }, context) => { guard(context); return safe(connected().manageForumTopic(id, action), "Telegram did not apply this topic change."); },
    deleteForumTopic: ({ id, topic, name }, context) => { guard(context); return connected().deleteForumTopic(id, topic, name); },
    markForumTopicRead: ({ id, topic }, context) => {
      guard(context); return safe(connected().markForumTopicRead(id, topic), "Could not mark this topic as read.");
    },
    markForumRead: ({ id }, context) => {
      guard(context); return safe(connected().markForumRead(id), "Could not mark the forum as read.");
    },
    forumTopicPage: ({ id, query, cursor }, context) => { guard(context); return safe(connected().forumTopicPage(id, query, cursor), "Could not load this forum."); },
    pinnedForumTopicOrder: ({ id }, context) => { guard(context); return safe(connected().pinnedForumTopicOrder(id), "Could not load pinned topics."); },
    movePinnedForumTopic: ({ id, topic, direction, expected }, context) => {
      guard(context); return connected().movePinnedForumTopic(id, topic, direction, expected);
    },
    forumTopics: ({ id, query }, context) => { guard(context); return safe(connected().forumTopics(id, query), "Could not load this forum."); },
    savedSources: ({ offset }, context) => { guard(context); return safe(connected().savedSources(offset), "Could not load Saved Messages sources."); },
    savedSourceTags: ({ sourceId }, context) => {
      guard(context); return safe(connected().savedSourceTags(sourceId), "Could not load tags for this Saved Messages source.");
    },
    setSavedSourcePinned: ({ sourceId, pinned, expected }, context) => {
      guard(context);
      return safe(connected().setSavedSourcePinned(sourceId, pinned, expected), "Could not change this Saved Messages pin.");
    },
    reorderSavedSources: ({ order, expected }, context) => {
      guard(context);
      return safe(connected().reorderSavedSources(order, expected), "Could not reorder pinned Saved Messages sources.");
    },
    savedSourceHistory: ({ sourceId, before, query, date, filter, tag }, context) => { guard(context); return safe(connected().savedSourceHistory(sourceId, before, query, date, filter, tag), "Could not load this Saved Messages source."); },
    history: ({ id, before, topicId }, context) => { guard(context); return safe(connected().history(id, before, topicId), "Could not load this conversation."); },
    unreadHistory: ({ id, after, topicId }, context) => {
      guard(context); return safe(connected().unreadHistory(id, after, topicId), "Could not load unread messages.");
    },
  };
  const unscoped = new Set<keyof typeof schemas>(["status", "connect", "accountSelection", "selectTelegramAccount",
    "renameTelegramAccount", "sessionRpc", "readPreview"]);
  const registered = Object.fromEntries(Object.entries(handlers).map(([method, handle]) => [
    method,
    async (input: never, context: ExperimentalPluginRpcHandlerContext) => {
      guard(context);
      if (!unscoped.has(method as keyof typeof schemas) && (switchingAccount || accounts.accounts.length > 1)) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Open the current Telegram connection in BB." });
      }
      // An absent optional field has no representation on the JSON wire.
      return omitUndefinedRpcFields(await handle(input, context));
    },
  ])) as typeof handlers;
  bb.rpc.register(rpcContract, registered, { experimental_discoverable: false });
}
