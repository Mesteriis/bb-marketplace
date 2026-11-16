import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentHistoryGrants, cacheLimitMiB, chatChangedChannel, defaultCacheLimitMiB, messageNotificationChannel, messagesDeletedChannel, schemas, type AgentAccess, type Auth } from "./src/core/contract.ts";
import { channelPostReceiptMigrations, createChannelPostReceipts } from "./src/adapters/bb/channel-post-receipts.ts";
import { readCredentials } from "./src/adapters/bb/credentials.ts";
import { registerDocumentUploads } from "./src/adapters/bb/document-uploads.ts";
import { registerDocumentDownloads } from "./src/adapters/bb/document-downloads.ts";
import { createApprovalQueue } from "./src/adapters/bb/approval-queue.ts";
import { createReplyTokens } from "./src/adapters/bb/reply-tokens.ts";
import { agentFindChatsTool, agentFindTopicsTool, agentHistoryTool, agentReadTool, registerAgentHistory, registerAgentRead } from "./src/adapters/bb/agent-read.ts";
import { agentSendTool, registerAgentSend } from "./src/adapters/bb/agent-send.ts";
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
    agentReadOwnNotes: { type: "boolean", label: "Allow agents to request my original Telegram messages", default: false },
    agentHistoryChats: { type: "string", label: "Telegram chat AI permissions", default: "", secret: true },
    agentSend: { type: "boolean", label: "Allow agents to request Telegram sends", default: false },
    cacheLimitMiB: { type: "number", label: "Telegram media cache limit (MiB)", default: defaultCacheLimitMiB, experimental_schema: cacheLimitMiB },
    sessionKey: { type: "string", label: "TDLib database key", secret: true },
  });
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
  }
  async function allowedChats(current: ReturnType<typeof createTelegram>) {
    const grants = historyGrants((await settings.get()).agentHistoryChats);
    if (!grants?.chatIds.length) return [];
    return grants.accountId === await current.accountId() ? [...new Set(grants.chatIds)].sort() : [];
  }
  function revoke(capability: keyof typeof permissions) {
    permissions[capability].abort();
    permissions[capability] = new AbortController();
    replyTokens.clear();
  }
  let configuredAccess: AgentAccess | undefined;
  settings.onChange((next, previous) => {
    configuredAccess = { read: next.agentReadOwnNotes === true, send: next.agentSend === true, history: !!historyGrants(next.agentHistoryChats)?.chatIds.length };
    if (previous.agentReadOwnNotes && !next.agentReadOwnNotes) revoke("read");
    if (previous.agentSend && !next.agentSend) revoke("send");
    if (previous.agentHistoryChats !== next.agentHistoryChats) {
      revoke("history");
      revoke("read");
    }
  });
  async function agentAccess() {
    const config = await settings.get();
    return { read: config.agentReadOwnNotes === true, send: config.agentSend === true, history: !!historyGrants(config.agentHistoryChats)?.chatIds.length };
  }
  let session: ReturnType<typeof createTelegram> | undefined;
  const uploads = registerDocumentUploads(bb, () => session);
  const downloads = registerDocumentDownloads(bb, () => session);
  let starting: Promise<Auth> | undefined;
  let stopping: Promise<Auth> | undefined;
  let signingOut: Promise<Auth> | undefined;
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
    if (session && session.status().state !== "error") return session.status();
    if (session) await session.close();
    session = undefined;
    if (disposed || attempt !== generation) return { state: "idle" };
    error = undefined;
    if (process.platform !== "darwin") return error = { state: "error", message: "Makosh Telegram requires a Mac running the BB server." };
    const library = findTdjsonLibrary(process.env.MAKOSH_TDJSON_PATH);
    if (!library) {
      return error = { state: "error", message: "Install TDLib on the Mac running BB, or set MAKOSH_TDJSON_PATH to libtdjson.dylib." };
    }
    if (!existsSync("/usr/bin/python3")) {
      return error = { state: "error", message: "The BB server needs Python 3 at /usr/bin/python3 to run TDLib." };
    }
    let credentials;
    try { credentials = readCredentials(process.env.MAKOSH_TELEGRAM_CREDENTIALS_FILE); }
    catch { return error = { state: "error", message: "Set MAKOSH_TELEGRAM_CREDENTIALS_FILE to a valid private Makosh credential file on the BB server." }; }

    try {
      let { sessionKey } = await settings.get();
      if (!sessionKey) {
        sessionKey = randomBytes(32).toString("base64");
        await settings.experimental_set({ sessionKey });
      }
      if (!/^[A-Za-z0-9+/]{43}=$/.test(sessionKey)) throw new Error("Invalid session key");
      if (disposed || attempt !== generation) return { state: "idle" };
      const database = bb.storage.database();
      const directory = join(dirname(database.name), "tdlib");
      bb.storage.migrate(database, [...channelPostReceiptMigrations, privateHistoryMigration, privateMediaMigration]);
      const channelPosts = createChannelPostReceipts(database, sessionKey);
      const privateHistory = createPrivateHistory(database, sessionKey);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      chmodSync(directory, 0o700);
      session = createTelegram({ ...credentials, library, directory, key: sessionKey, channelPosts, privateHistory }, undefined, notifyChatChanged, (event) => {
        if (!disposed && generation === attempt) bb.realtime.publish(messagesDeletedChannel, event);
      }, (event) => {
        if (!disposed && generation === attempt) bb.realtime.publish(messageNotificationChannel, event);
      });
      return session.status();
    } catch {
      return error = { state: "error", message: "Could not prepare the local Telegram session." };
    }
  }

  function disconnect(): Promise<Auth> {
    if (stopping) return stopping;
    generation++;
    revoke("read");
    revoke("send");
    revoke("history");
    downloads.clear();
    uploads.clear();
    clearTimeout(notification);
    notification = undefined;
    const previous = session;
    session = undefined;
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

  bb.onDispose(async () => { disposed = true; clearInterval(cacheTimer); await disconnect(); });
  function connected() {
    if (signingOut || !session || session.status().state !== "ready") {
      throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Connect Telegram first." });
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
  async function configuredCacheLimit() {
    return cacheLimitMiB.safeParse((await settings.get()).cacheLimitMiB).data ?? defaultCacheLimitMiB;
  }
  async function trimCache(current: ReturnType<typeof createTelegram>, limitMiB: number) {
    const bytes = await current.cacheBytes();
    const limitBytes = limitMiB * 1024 * 1024;
    if (bytes <= limitBytes) return bytes;
    await current.optimizeCache(limitBytes);
    return current.cacheBytes();
  }
  const cacheTimer = setInterval(() => {
    if (disposed || cacheWork || signingOut || session?.status().state !== "ready") return;
    void withCache(async (current) => trimCache(current, await configuredCacheLimit())).catch(() => {});
  }, 60_000);
  cacheTimer.unref?.();
  async function safe<T>(work: Promise<T>, message: string): Promise<T> {
    try { return await work; }
    catch { throw new experimental_PluginRpcRefusal({ code: "invalid", message }); }
  }

  const initialAccess = await agentAccess();
  configuredAccess ??= initialAccess;
  const readPreview = registerAgentRead(bb, async () => (await settings.get()).agentReadOwnNotes === true,
    () => signingOut ? undefined : session, replyTokens, () => permissions.read.signal, approvals, allowedChats);
  registerAgentHistory(bb, allowedChats, () => signingOut ? undefined : session, () => permissions.history.signal, replyTokens);
  registerAgentSend(bb, async () => (await settings.get()).agentSend === true, () => signingOut ? undefined : session, replyTokens, () => permissions.send.signal, approvals, () => permissions.read.signal);

  bb.agents.configure(() => ({
    tools: [
      ...(configuredAccess?.read && configuredAccess.history ? [agentReadTool] : []),
      agentFindChatsTool, agentFindTopicsTool, agentHistoryTool,
      ...(configuredAccess?.send ? [agentSendTool] : []),
    ],
    skills: [],
  }));

  bb.rpc.register(rpcContract, {
    readPreview: ({ requestId, id }, context) => { guard(context); return safe(readPreview(requestId, id), "This review is no longer available."); },
    runtimeInfo: (_, context) => { guard(context); return safe(connected().runtimeInfo(), "Could not read the Telegram runtime version."); },
    removeProfilePhoto: ({ expected }, context) => {
      guard(context); return safe(connected().removeProfilePhoto(expected), "Could not remove the profile photo.");
    },
    saveProfilePhoto: ({ base64, expected }, context) => {
      guard(context); return safe(connected().saveProfilePhoto(base64, expected), "Could not update the profile photo.");
    },
    telegramProfile: (_, context) => { guard(context); return safe(connected().telegramProfile(), "Could not load your Telegram profile."); },
    checkTelegramUsername: ({ username }, context) => { guard(context); return safe(connected().checkTelegramUsername(username), "Could not check this Telegram username."); },
    saveTelegramProfile: (change, context) => { guard(context); return safe(connected().saveTelegramProfile(change), "Telegram did not update your profile."); },
    telegramPrivacy: ({ key }, context) => { guard(context); return safe(connected().telegramPrivacy(key), "Could not load Telegram privacy."); },
    chatAutoDelete: ({ id }, context) => {
      guard(context); return safe(connected().chatAutoDelete(id), "Could not load the chat timer.");
    },
    saveChatAutoDelete: ({ id, days, expected }, context) => {
      guard(context); return safe(connected().saveChatAutoDelete(id, days, expected), "Could not save the chat timer.");
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
    readDatePrivacy: (_input, context) => { guard(context); return safe(connected().readDatePrivacy(), "Could not load read time privacy."); },
    saveReadDatePrivacy: ({ show, expected }, context) => {
      guard(context); return safe(connected().saveReadDatePrivacy(show, expected), "Telegram did not save read time privacy.");
    },
    saveTelegramPrivacy: ({ key, audience, expected }, context) => { guard(context); return safe(connected().saveTelegramPrivacy(key, audience, expected), "Telegram did not save privacy settings."); },
    activeDevices: (_, context) => { guard(context); return safe(connected().activeDevices(), "Could not load Telegram devices."); },
    terminateDevice: ({ id, application, device }, context) => { guard(context); return safe(connected().terminateDevice(id, application, device), "Telegram did not terminate this session."); },
    cacheInfo: (_, context) => {
      guard(context);
      return safe(withCache(async (current) => ({ bytes: await current.cacheBytes(), limitMiB: await configuredCacheLimit() })), "Could not read the Telegram cache.");
    },
    setCacheLimit: ({ limitMiB }, context) => {
      guard(context);
      return safe(withCache(async (current) => {
        const bytes = await trimCache(current, limitMiB);
        if (connected() !== current) throw new Error("Telegram session changed.");
        await settings.experimental_set({ cacheLimitMiB: limitMiB });
        return { bytes, limitMiB };
      }), "Could not save the Telegram cache limit.");
    },
    clearCache: (_, context) => {
      guard(context);
      return safe(withCache(async (current) => {
        await current.optimizeCache(0);
        return { bytes: await current.cacheBytes(), limitMiB: await configuredCacheLimit() };
      }), "Could not clear the Telegram cache.");
    },
    agentAccess: (_, context) => { guard(context); return agentAccess(); },
    setAgentAccess: async ({ capability, enabled }, context) => {
      guard(context);
      const setting = { read: "agentReadOwnNotes", send: "agentSend" } as const;
      await settings.experimental_set({ [setting[capability]]: enabled });
      return agentAccess();
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
        const ids = new Set(grants?.accountId === accountId ? grants.chatIds : []);
        if (enabled && !await current.canShareAgentHistory(id)) throw new Error("This conversation cannot be shared.");
        if (connected() !== current) throw new Error("Telegram session changed.");
        if (enabled) ids.add(id);
        else ids.delete(id);
        await settings.experimental_set({ agentHistoryChats: ids.size ? JSON.stringify({ accountId, chatIds: [...ids] }) : "" });
        // Cancel reads as soon as the write completes, even if settings notification is delayed.
        revoke("history");
        revoke("read");
        return enabled;
      });
      scopeChanges = change.catch(() => {});
      return safe(change, "Could not change this chat’s AI access.");
    },
    status: (_, context): Auth => { guard(context); return stopping || signingOut ? { state: "disconnecting" } : session?.status() ?? error ?? { state: "idle" }; },
    disconnect: (_, context) => { guard(context); return signingOut ? safe(signingOut, "Telegram did not confirm sign-out.") : disconnect(); },
    signOut: (_, context) => {
      guard(context);
      if (signingOut) return safe(signingOut, "Telegram did not confirm sign-out.");
      const previous = connected();
      revoke("read");
      revoke("send");
      revoke("history");
      downloads.clear();
      uploads.clear();
      signingOut = (async () => {
        await scopeChanges;
        await settings.experimental_set({ agentReadOwnNotes: false, agentSend: false, agentHistoryChats: "" });
        await previous.signOut();
        return disconnect();
      })().finally(() => { signingOut = undefined; });
      return safe(signingOut, "Telegram did not confirm sign-out.");
    },
    connect: (_, context) => {
      guard(context);
      if (stopping || signingOut) return { state: "disconnecting" as const };
      starting ??= start().finally(() => { starting = undefined; });
      return starting;
    },
    password: ({ password }, context) => {
      guard(context);
      if (!session) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Connect Telegram first." });
      return safe(session.password(password), "Telegram did not accept the password. Try again.");
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
    reorderFolders: ({ order, expected }, context) => {
      guard(context); return safe(connected().reorderFolders(order, expected), "Could not reorder Telegram folders.");
    },
    recommendedFolders: (_, context) => {
      guard(context); return safe(connected().recommendedFolders(), "Could not load recommended folders.");
    },
    addRecommendedFolder: ({ token }, context) => {
      guard(context); return safe(connected().addRecommendedFolder(token), "Could not add this recommended folder.");
    },
    folderEditor: ({ id }, context) => { guard(context); return safe(connected().folderEditor(id), "Could not open this folder."); },
    saveFolder: ({ id, ...draft }, context) => { guard(context); return safe(connected().saveFolder(draft, id), "Telegram did not save the folder."); },
    deleteFolder: ({ id, title }, context) => { guard(context); return safe(connected().deleteFolder(id, title), "Could not delete this folder."); },
    folderMemberships: ({ chatId }, context) => { guard(context); return safe(connected().folderMemberships(chatId), "Could not load folder membership."); },
    setFolderMembership: ({ id, chatId, mode }, context) => { guard(context); return safe(connected().setFolderMembership(id, chatId, mode), "Could not change folder membership."); },
    folders: (_, context) => { guard(context); return connected().folders(); },
    contacts: ({ query, offset }, context) => { guard(context); return safe(connected().contacts(query, offset), "Could not load contacts."); },
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
    saveContact: ({ id, userId, expected, names }, context) => { guard(context); return safe(connected().saveContact(id, userId, expected, names), "Could not save the contact."); },
    removeContact: ({ id, userId, expected }, context) => { guard(context); return safe(connected().removeContact(id, userId, expected), "Could not remove the contact."); },
    openContact: ({ id }, context) => { guard(context); return safe(connected().openContact(id), "Could not open this contact."); },
    search: ({ query, list }, context) => { guard(context); return safe(connected().search(query, list), "Telegram search failed."); },
    chatPage: ({ list, offset }, context) => { guard(context); return safe(connected().chatPage(list, offset), "Could not load Telegram chats."); },
    chats: ({ list }, context) => { guard(context); return safe(connected().chats(list), "Could not load Telegram chats."); },
    pinStatus: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().pinStatus(id, messageId), "Could not check Telegram pin permissions.");
    },
    setMessagePinned: ({ id, messageId, pinned }, context) => {
      guard(context);
      return connected().setMessagePinned(id, messageId, pinned);
    },
    pinnedMessage: ({ id }, context) => { guard(context); return safe(connected().pinnedMessage(id), "Could not load the pinned message."); },
    messageViewers: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().messageViewers(id, messageId), "Could not load Telegram message viewers.");
    },
    messageReadTime: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().messageReadTime(id, messageId), "Could not load Telegram read time.");
    },
    deletionOptions: ({ id, messageId }, context) => {
      guard(context);
      return safe(connected().deletionOptions(id, messageId), "Could not check Telegram deletion permissions.");
    },
    deleteMessage: ({ id, messageId, scope }, context) => {
      guard(context);
      return connected().deleteMessage(id, messageId, scope);
    },
    forwardOptions: ({ id, messageId }, context) => { guard(context); return safe(connected().forwardOptions(id, messageId), "Could not check whether Telegram allows forwarding this message."); },
    forwardMessage: ({ id, messageId, target }, context) => { guard(context); return connected().forwardMessage(id, messageId, target); },
    listReactions: ({ id, messageId }, context) => { guard(context); return safe(connected().listReactions(id, messageId), "Could not load Telegram reactions."); },
    setReaction: ({ id, messageId, emoji, chosen }, context) => { guard(context); return connected().setReaction(id, messageId, emoji, chosen); },
    sendPoll: ({ id, draft, topic }, context) => { guard(context); return connected().sendPoll(id, draft, topic); },
    stopPoll: ({ id, messageId }, context) => { guard(context); return connected().stopPoll(id, messageId); },
    voteInPoll: ({ id, messageId, choices }, context) => { guard(context); return connected().voteInPoll(id, messageId, choices); },
    editCaption: ({ id, messageId, text, original, originalStyles, styles, placement }, context) => {
      guard(context); return connected().editCaption(id, messageId, text, original, originalStyles, styles, placement);
    },
    edit: ({ id, messageId, text, original, originalStyles, styles, removeLinkPreview }, context) => { guard(context); return connected().editText(id, messageId, text, original, originalStyles, styles, removeLinkPreview); },
    prepareDocumentUpload: async (input, context) => {
      guard(context);
      const current = connected();
      if (input.topic && await safe(current.forumTopicName(input.id, input.topic.id), "Could not verify the Telegram topic.") !== input.topic.name) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The Telegram topic changed. Reopen it before attaching a document." });
      }
      const rejection = await safe(current.checkDocumentUpload(input.size), "Could not check the Telegram file size limit.");
      if (rejection) return { rejection };
      if (input.replyTo && !await safe(current.attachmentReplyAvailable(input.id, input.replyTo, input.topic?.id), "Could not verify the Telegram reply.")) {
        return { rejection: "reply_unavailable" as const };
      }
      if (connected() !== current) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Telegram session changed." });
      return uploads.issue(current, input);
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
    searchGifs: ({ id, query, topic }, context) => { guard(context); return safe(connected().searchGifs(id, query, topic), "Could not search Telegram GIFs."); },
    sendFoundGif: ({ id, token, topic, reply, delivery }, context) => { guard(context); return connected().sendFoundGif(id, token, topic, reply, delivery); },
    linkedStickerPack: ({ url, offset }, context) => {
      guard(context); return safe(connected().linkedStickerPack(url, offset), "Could not open the sticker pack.");
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
    reorderStickerPacks: ({ order, expected }, context) => {
      guard(context); return connected().reorderStickerPacks(order, expected);
    },
    stickerPackPage: ({ packId, offset }, context) => {
      guard(context); return safe(connected().stickerPackPage(packId, offset), "Could not load this sticker pack.");
    },
    mediaChoices: (input, context) => {
      guard(context);
      return safe(typeof input === "string" ? connected().mediaChoices(input) : connected().mediaChoices("sticker", input.stickerQuery),
        "Could not load Telegram media.");
    },
    sendMediaChoice: ({ id, kind, fileId, stickerQuery, packId, topic, reply, delivery, gif }, context) => { guard(context); return connected().sendMediaChoice(id, kind, fileId, stickerQuery, packId, topic, reply, delivery, gif); },
    sendVideoNote: ({ id, base64, format, topic, reply, delivery }, context) => {
      guard(context); return connected().sendVideoNote(id, base64, format, topic, reply, delivery);
    },
    sendVoice: ({ id, base64, duration, format, topic, reply, delivery }, context) => { guard(context); return connected().sendVoice(id, base64, duration, format, topic, reply, delivery); },
    sendPhotoAlbum: ({ id, caption, photos, topic, reply, delivery, options }, context) => { guard(context); return connected().sendPhotoAlbum(id, caption, photos, topic, reply, delivery, options); },
    sendPhoto: ({ id, caption, base64, topic, replyTo, options }, context) => { guard(context); return connected().sendPhoto(id, caption, base64, topic, replyTo, options); },
    sendTopicText: ({ id, text, topic, replyTo, styles, quote, delivery }, context) => {
      guard(context);
      return connected().sendText(id, text, replyTo, undefined, undefined, undefined, topic, undefined, { ...delivery, styles, quote });
    },
    topicDraft: ({ id, topicId }, context) => {
      guard(context); return safe(connected().topicDraft(id, topicId), "Could not load the Telegram topic draft.");
    },
    saveChatDraft: ({ id, text, expected, topicId }, context) => {
      guard(context);
      return safe(connected().saveChatDraft(id, text, expected, topicId), "Could not save the Telegram draft.");
    },
    chatEvents: ({ id, query, cursor }, context) => { guard(context); return safe(connected().chatEvents(id, query, cursor), "Could not load recent actions."); },
    channelSignatures: ({ id }, context) => {
      guard(context); return safe(connected().channelSignatures(id), "Could not load channel signatures.");
    },
    saveChannelSignatures: ({ id, values, expected }, context) => {
      guard(context); return safe(connected().saveChannelSignatures(id, values, expected), "Could not save channel signatures.");
    },
    chatInfo: ({ id }, context) => {
      guard(context); return safe(connected().chatInfo(id), "Could not load chat information.");
    },
    removeChatPhoto: ({ id, expected }, context) => {
      guard(context); return safe(connected().removeChatPhoto(id, expected), "Could not remove the chat photo.");
    },
    saveChatPhoto: ({ id, expected, base64 }, context) => {
      guard(context); return safe(connected().saveChatPhoto(id, base64, expected), "Could not update the chat photo.");
    },
    saveChatInfo: ({ id, ...change }, context) => {
      guard(context); return safe(connected().saveChatInfo(id, change), "Could not save chat information.");
    },
    groupSlowMode: ({ id }, context) => {
      guard(context); return safe(connected().groupSlowMode(id), "Could not load slow mode.");
    },
    saveGroupSlowMode: ({ id, delay, expected }, context) => {
      guard(context); return safe(connected().saveGroupSlowMode(id, delay, expected), "Could not save slow mode.");
    },
    groupPermissions: ({ id }, context) => { guard(context); return safe(connected().groupPermissions(id), "Could not load group permissions."); },
    saveGroupPermissions: ({ id, changes }, context) => { guard(context); return safe(connected().saveGroupPermissions(id, changes), "Telegram did not save these group permissions."); },
    joinRequests: ({ id, query, cursor }, context) => { guard(context); return safe(connected().joinRequests(id, query, cursor), "Could not load join requests."); },
    reviewJoinRequest: ({ id, userId, approve }, context) => { guard(context); return safe(connected().reviewJoinRequest(id, userId, approve), "Telegram did not process this join request."); },
    managedInvites: ({ id, cursor }, context) => { guard(context); return safe(connected().managedInvites(id, cursor), "Could not load invitations."); },
    createManagedInvite: ({ id, draft }, context) => { guard(context); return safe(connected().createManagedInvite(id, draft), "Could not create the invitation."); },
    revokeManagedInvite: ({ id, link }, context) => { guard(context); return safe(connected().revokeManagedInvite(id, link), "Could not revoke the invitation."); },
    chatMembers: ({ id, query, offset }, context) => { guard(context); return safe(connected().chatMembers(id, query, offset), "Could not load members."); },
    canScheduleWhenOnline: ({ id }, context) => {
      guard(context); return safe(connected().canScheduleWhenOnline(id), "Could not check online scheduling.");
    },
    scheduledMessages: ({ id, topicId }, context) => { guard(context); return safe(connected().scheduledMessages(id, topicId), "Could not load scheduled messages."); },
    changeScheduledMessage: ({ id, expected, at, topicId }, context) => {
      guard(context); return safe(connected().changeScheduledMessage(id, expected, at, topicId), "Could not update Telegram scheduling.");
    },
    cancelScheduledMessage: ({ id, messageId, topicId }, context) => { guard(context); return safe(connected().cancelScheduledMessage(id, messageId, topicId), "Could not cancel this scheduled message."); },
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
    chatPinStatus: ({ id, list }, context) => { guard(context); return safe(connected().chatPinStatus(id, list), "Could not check this chat pin."); },
    setChatPinned: ({ id, list, pinned }, context) => { guard(context); return connected().setChatPinned(id, list, pinned); },
    archiveChat: ({ id, archived }, context) => { guard(context); return safe(connected().archiveChat(id, archived), "Could not move this chat."); },
    previewInvite: ({ url }, context) => { guard(context); return safe(connected().previewInvite(url), "Could not check this Telegram invite."); },
    joinInvite: ({ url, expected }, context) => { guard(context); return connected().joinInvite(url, expected); },
    joinChat: ({ id, name }, context) => { guard(context); return connected().joinChat(id, name); },
    createPrivateChatSpace: ({ title, kind }, context) => {
      guard(context);
      return safe(connected().createPrivateChatSpace(title, kind), "Telegram did not confirm creation. Check the chat list before retrying.");
    },
    deleteOwnedChatSpace: ({ id, title, kind }, context) => {
      guard(context);
      return connected().deleteOwnedChatSpace(id, title, kind);
    },
    postingPermissions: ({ id }, context) => { guard(context); return safe(connected().postingPermissions(id), "Could not check posting permission."); },
    postingAllowed: ({ id }, context) => { guard(context); return safe(connected().postingAllowed(id), "Could not check posting permission."); },
    markActivityRead: ({ id, filter, topicId }, context) => {
      guard(context); return safe(connected().markActivityRead(id, filter, topicId), "Could not mark Telegram activity as read.");
    },
    markChat: ({ id, unread }, context) => { guard(context); return safe(connected().markChat(id, unread), "Could not update the read state."); },
    transcribeVoice: ({ id, messageId }, context) => { guard(context); return safe(connected().transcribeVoice(id, messageId), "Could not transcribe this note on this Mac."); },
    videoStream: ({ id, messageId }, context) => { guard(context); return safe(downloads.issueVideo(connected(), id, messageId), "Could not open this video."); },
    document: ({ id, messageId, playback, oneView }, context) => { guard(context); return safe(downloads.issue(connected(), id, messageId, playback, oneView), "Could not download this document."); },
    avatar: ({ id, fileId, user }, context) => { guard(context); return safe(connected().avatar(id, fileId, user), "Could not load this avatar."); },
    photo: ({ id, messageId, size }, context) => { guard(context); return safe(connected().photo(id, messageId, size), "Could not load this photo."); },
    notificationChat: ({ id }, context) => {
      guard(context);
      const session = connected();
      return safe((async () => {
        const chat = await session.chatById(id);
        return connected() === session && chat?.id === id ? chat : null;
      })(), "Could not open this Telegram chat.");
    },
    resolveMessageLink: ({ url }, context) => {
      guard(context);
      const current = connected();
      return safe((async () => {
        const reference = await current.messageLinkReference(url);
        if (!reference) return null;
        const { chatId, ...target } = reference;
        const chat = await current.chatById(chatId);
        if (!chat || chat.id !== chatId || connected() !== current) return null;
        return { chat, ...target };
      })(), "Could not open this Telegram link.");
    },
    messageLink: ({ id, messageId }, context) => { guard(context); return safe(connected().messageLink(id, messageId), "Could not get a Telegram link."); },
    sendChannelComment: ({ id, messageId, group, root, text }, context) => { guard(context); return connected().sendChannelComment(id, messageId, group, root, text); },
    channelDiscussion: ({ id, messageId, before }, context) => { guard(context); return safe(connected().channelDiscussion(id, messageId, before), "Could not load channel discussion."); },
    messageAtDate: ({ id, date, topicId }, context) => {
      guard(context); return safe(connected().messageAtDate(id, date, topicId), "Could not locate messages by date.");
    },
    messageContextPage: ({ id, messageId, direction, topicId }, context) => {
      guard(context); return safe(connected().messageContextPage(id, messageId, direction, topicId), "Could not extend Telegram message context.");
    },
    messageContext: ({ id, messageId, topicId }, context) => { guard(context); return safe(connected().messageContext(id, messageId, topicId), "Could not load messages around this result."); },
    globalSearch: ({ query, mode, cursor }, context) => { guard(context); return safe(connected().globalSearch(query, mode, cursor), "Could not search Telegram."); },
    searchMessages: ({ id, query, filter, topicId, before, sender }, context) => { guard(context); return safe(connected().searchMessages(id, query, filter, topicId, before, sender), "Could not search this conversation."); },
    manageForumTopic: ({ id, action }, context) => { guard(context); return safe(connected().manageForumTopic(id, action), "Telegram did not apply this topic change."); },
    forumTopicPage: ({ id, query, cursor }, context) => { guard(context); return safe(connected().forumTopicPage(id, query, cursor), "Could not load this forum."); },
    forumTopics: ({ id, query }, context) => { guard(context); return safe(connected().forumTopics(id, query), "Could not load this forum."); },
    history: ({ id, before, topicId }, context) => { guard(context); return safe(connected().history(id, before, topicId), "Could not load this conversation."); },
  }, { experimental_discoverable: false });
}
