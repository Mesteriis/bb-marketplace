import { describe, expect, it, vi } from "vitest";
import { ImapAuthError } from "./ports.ts";
import { INBOX, prepareMessage, syncAccount, type SyncDeps } from "./sync.ts";
import { planSnoozes } from "./snooze.ts";
import {
  FixedClock,
  IdentityVault,
  InMemoryMailStore,
  makeFetchedMessage,
  makeStoredAccount,
  RecordingNotifier,
  imapError,
  ScriptedImapGateway,
  type FakeMailbox,
} from "./testing/fakes.ts";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const OPTIONS = { windowDays: 30, batchSize: 50 };
const PASSWORD = "Pa55-word-very-secret";
const ACCOUNT_ID = "acc_1";

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function mailbox(count: number, uidValidity = 7): FakeMailbox {
  const messages = Array.from({ length: count }, (_, i) =>
    makeFetchedMessage(i + 1, { date: hoursAgo(count - i) }),
  );
  return { uidValidity, uidNext: count + 1, messages };
}

function setup(box: FakeMailbox) {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: ACCOUNT_ID, passwordSealed: PASSWORD }));
  const gateway = new ScriptedImapGateway(box);
  const notifier = new RecordingNotifier();
  const deps: SyncDeps = {
    store,
    gateway,
    vault: new IdentityVault(),
    clock: new FixedClock(NOW),
    notifier,
  };
  return { store, gateway, notifier, deps };
}

function fetchBatches(gateway: ScriptedImapGateway): number[][] {
  return gateway.sessions.flatMap((s) =>
    s.calls.filter((c) => c.method === "fetchMessages").map((c) => c.uids!),
  );
}

function uidOf(store: InMemoryMailStore, id: string): number | undefined {
  return store
    .localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")
    .find((entry) => entry.id === id)?.uid;
}

/** Attached uids of the folder with a pending desired \Seen = true. */
function pendingSeen(store: InMemoryMailStore, folder: string): number[] {
  return store
    .pendingFlagIntents(ACCOUNT_ID, folder)
    .filter((intent) => intent.seen === true)
    .map((intent) => intent.uid);
}

describe("syncAccount", () => {
  it("initial sync of 120 messages fetches 3 batches newest first and saves state after each", async () => {
    const { store, gateway, deps } = setup(mailbox(120));
    const saved: number[] = [];
    const save = store.saveSyncState.bind(store);
    vi.spyOn(store, "saveSyncState").mockImplementation((accountId, folder, state) => {
      saved.push(state.lastUid);
      save(accountId, folder, state);
    });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({
      status: "ok",
      fetched: 120,
      removed: 0,
      flagsChanged: 0,
      pushedSeen: 0,
      pushedFlags: 0,
      folders: 1,
      movesCancelled: [],
      newInbox: [],
      returning: [],
      inserted: expect.any(Array),
    });
    if (outcome.status === "ok") expect(outcome.inserted).toHaveLength(120);
    const batches = fetchBatches(gateway);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches[0]![0]).toBe(120);
    expect(batches.flat()).toEqual([...Array.from({ length: 120 }, (_, i) => 120 - i)]);
    // After each batch, then once more when the whole window is stored.
    expect(saved).toEqual([120, 120, 120, 120]);
    expect(store.getSyncState(ACCOUNT_ID, INBOX)).toEqual({
      uidValidity: 7,
      lastUid: 120,
      syncedSince: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
    });
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.sessions[0]!.readOnly).toBe(true);
    expect(gateway.sessions[0]!.config.password).toBe(PASSWORD);
    expect(store.unreadCount(ACCOUNT_ID)).toBe(120);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastSyncAt: NOW.toISOString(),
      lastError: null,
      authFailed: false,
    });
  });

  it("incremental sync fetches only uids after lastUid", async () => {
    const { store, gateway, deps } = setup(mailbox(5));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    gateway.deliver({ date: hoursAgo(0.5) });
    gateway.deliver({ date: hoursAgo(0.25) });

    const outcome = await syncAccount(deps, ACCOUNT_ID, { windowDays: 30, batchSize: 1 });

    const second = gateway.sessions[1]!;
    expect(second.calls.find((c) => c.method === "uidsAfter")?.uid).toBe(5);
    expect(
      second.calls.filter((c) => c.method === "fetchMessages").map((c) => c.uids),
    ).toEqual([[6], [7]]);
    expect(outcome).toMatchObject({ status: "ok", fetched: 2 });
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(7);
  });

  it("uidvalidity change keeps ids of messages that reappear and deletes the rest", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const before = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    const idOfOldUid = (uid: number) => before.find((e) => e.uid === uid)!.id;
    const keptId = idOfOldUid(1);
    const droppedId = idOfOldUid(2);

    // The server renumbers: message 1 reappears as uid 10, message 3 as uid 11,
    // message 2 is gone.
    const [m1, , m3] = gateway.mailbox.messages;
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 12,
      messages: [
        { ...m1!, uid: 10 },
        { ...m3!, uid: 11 },
      ],
    };

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", fetched: 2, removed: 1 });
    expect(uidOf(store, keptId)).toBe(10);
    expect(store.getMessage(droppedId)).toBeNull();
    expect(store.getSyncState(ACCOUNT_ID, INBOX)).toMatchObject({ uidValidity: 8, lastUid: 11 });
    // The second round searched the window again instead of asking for uids after 3.
    expect(gateway.sessions[1]!.calls.some((c) => c.method === "uidsAfter")).toBe(false);
  });

  it("reconcile deletes messages gone from the server", async () => {
    const { store, gateway, deps } = setup(mailbox(4));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    gateway.mailbox.messages = gateway.mailbox.messages.filter((m) => m.uid !== 2);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", fetched: 0, removed: 1 });
    expect(
      store
        .localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")
        .map((e) => e.uid)
        .sort(),
    ).toEqual([1, 3, 4]);
  });

  it("does not delete a message whose header date is inside the window but whose internal date is outside", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    // Delivered now (so the incremental fetch picks it up), but the server's
    // INTERNALDATE, which SEARCH SINCE uses, is older than the window.
    const late = gateway.deliver({ date: hoursAgo(1) });
    gateway.mailbox.internalDates = new Map([[late.uid, hoursAgo(24 * 40)]]);

    const second = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const third = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(second).toMatchObject({ status: "ok", fetched: 1, removed: 0 });
    expect(third).toMatchObject({ status: "ok", fetched: 0, removed: 0 });
    const uids = store
      .localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")
      .map((e) => e.uid)
      .sort();
    expect(uids).toEqual([1, 2, 3]);
  });

  it("a spurious empty search does not delete local mail", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const open = gateway.openFolder.bind(gateway);
    vi.spyOn(gateway, "openFolder").mockImplementation(async (config, path, options) => {
      const session = await open(config, path, options);
      session.searchSince = async () => [];
      return session;
    });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", removed: 0 });
    expect(store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")).toHaveLength(3);
  });

  it("an initial round that fetches nothing for its search hits never leaves lastUid at 0", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    const open = gateway.openFolder.bind(gateway);
    const openFolder = vi.spyOn(gateway, "openFolder").mockImplementation(async (config, path, options) => {
      const session = await open(config, path, options);
      // The hits are expunged before the fetch, and the round then fails in reconcile.
      const searchSince = session.searchSince;
      let searches = 0;
      session.fetchMessages = async () => [];
      session.searchSince = async (date) => {
        if (++searches === 2) throw new Error("connection lost");
        return searchSince(date);
      };
      return session;
    });

    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "error" });
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(3);
    openFolder.mockRestore();

    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    // Incremental from 3, not from 0 (which would pull the whole mailbox);
    // the window is backfilled by reconcile.
    expect(gateway.sessions[1]!.calls.find((c) => c.method === "uidsAfter")?.uid).toBe(3);
    expect(next).toMatchObject({ status: "ok", fetched: 3 });
  });

  it("a completed initial round starts incremental sync at the end of the mailbox", async () => {
    const box = mailbox(2);
    // Older mail outside the window ends at uid 9.
    box.uidNext = 10;
    const { store, gateway, deps } = setup(box);
    const open = gateway.openFolder.bind(gateway);
    vi.spyOn(gateway, "openFolder").mockImplementationOnce(async (config, path, options) => {
      const session = await open(config, path, options);
      session.fetchMessages = async () => [];
      return session;
    });

    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok" });

    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(9);
  });

  it("reconcile applies server flags but keeps a pending local read", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    const idOf = (uid: number) => ids.find((e) => e.uid === uid)!.id;

    // The owner opens message 3 in BB, but the push of pending reads fails.
    store.markOpened(idOf(3));
    gateway.failNext("setFlags", new Error("connection reset"));
    // Meanwhile on the server: message 1 read, message 2 flagged.
    gateway.mailbox.messages[0]!.seen = true;
    gateway.mailbox.messages[1]!.flagged = true;

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", flagsChanged: 2, pushedSeen: 0 });
    expect(store.getMessage(idOf(1))).toMatchObject({ isRead: true, isFlagged: false });
    expect(store.getMessage(idOf(2))).toMatchObject({ isRead: false, isFlagged: true });
    expect(store.getMessage(idOf(3))).toMatchObject({ isRead: true });
    expect(pendingSeen(store, INBOX)).toEqual([3]);
  });

  it("pushes pending seen with a writable session before syncing", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    store.markOpened(ids.find((e) => e.uid === 2)!.id);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 1 });
    const [, push, main] = gateway.sessions;
    expect(push!.readOnly).toBe(false);
    expect(push!.calls).toEqual([{ method: "status" }, { method: "setFlags", uids: [2], change: { seen: true } }]);
    expect(push!.closed).toBe(true);
    expect(main!.readOnly).toBe(true);
    expect(main!.calls.some((c) => c.method === "setFlags")).toBe(false);
    expect(gateway.mailbox.messages[1]!.seen).toBe(true);
    expect(pendingSeen(store, INBOX)).toEqual([]);
    expect(gateway.sessions).toHaveLength(3);
  });

  it("a failed seen push keeps the pending flag", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    store.markOpened(ids.find((e) => e.uid === 1)!.id);
    gateway.failNext("setFlags", new Error("connection reset"));

    const failedPush = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(failedPush).toMatchObject({ status: "ok", pushedSeen: 0 });
    expect(gateway.sessions[1]!.closed).toBe(true);
    expect(pendingSeen(store, INBOX)).toEqual([1]);
    // The failed push shows, while the folder itself synced.
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe("INBOX: Sync failed");

    const retried = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(retried).toMatchObject({ status: "ok", pushedSeen: 1 });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
    expect(pendingSeen(store, INBOX)).toEqual([]);
    expect(gateway.mailbox.messages[0]!.seen).toBe(true);
  });

  it("auth failure marks the account and stops retrying", async () => {
    const { store, gateway, notifier, deps } = setup(mailbox(2));
    gateway.failOpen(new ImapAuthError());

    const first = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(first).toEqual({ status: "error", error: "Authentication failed", authFailed: true });
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastError: "Authentication failed",
      authFailed: true,
      lastSyncAt: null,
    });

    const openFolder = vi.spyOn(gateway, "openFolder");
    const second = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(second).toMatchObject({ status: "error", authFailed: true });
    expect(openFolder).not.toHaveBeenCalled();
    expect(notifier.changes).toEqual([]);
  });

  it("a folder that cannot be opened records lastError without authFailed", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const network = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:993"), {
      code: "ECONNREFUSED",
    });
    gateway.failOpenFolder(INBOX, network);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "error", authFailed: false });
    if (outcome.status !== "error") throw new Error("expected an error outcome");
    expect(outcome.error).toContain("ECONNREFUSED");
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastError: outcome.error,
      authFailed: false,
      lastSyncAt: NOW.toISOString(),
    });

    // The next round is attempted again.
    gateway.failOpenFolder(INBOX, null);
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok" });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
  });

  it("a failed folder listing fails the round and saves nothing", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    gateway.failOpen(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const saveFolders = vi.spyOn(store, "saveFolders");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({
      status: "error",
      error: "Sync failed (ECONNREFUSED)",
      authFailed: false,
    });
    expect(saveFolders).not.toHaveBeenCalled();
    expect(gateway.sessions).toHaveLength(1);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastError: "Sync failed (ECONNREFUSED)",
      lastSyncAt: NOW.toISOString(),
    });
  });

  it("error text never contains the password", async () => {
    const leakyErrors = [
      new ImapAuthError(`LOGIN owner@example.org ${PASSWORD} rejected`),
      Object.assign(new Error(`AUTHENTICATE failed for ${PASSWORD}`), { code: "EAUTH" }),
      new Error(`socket closed while sending ${PASSWORD}`),
    ];
    const cases = leakyErrors.flatMap((leaky) => [
      { leaky, at: "openFolder" as const },
      { leaky, at: "listFolders" as const },
    ]);
    for (const { leaky, at } of cases) {
      // A naive String(error) would leak it.
      expect(String(leaky)).toContain(PASSWORD);
      const { store, gateway, deps } = setup(mailbox(1));
      if (at === "openFolder") gateway.failOpenFolder(INBOX, leaky);
      else gateway.failOpen(leaky);

      const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

      expect(outcome.status).toBe("error");
      expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
      expect(store.getAccount(ACCOUNT_ID)?.lastError).not.toContain(PASSWORD);
      expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeTruthy();
    }
  });

  it("notifies mailChanged after a successful round", async () => {
    const { gateway, notifier, deps } = setup(mailbox(2));

    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(notifier.changes).toEqual([ACCOUNT_ID]);

    gateway.failAlways("status", new Error("timeout"));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(notifier.changes).toEqual([ACCOUNT_ID]);
  });

  it("closes the session when fetch throws", async () => {
    const { store, gateway, deps } = setup(mailbox(60));
    let fetches = 0;
    const open = gateway.openFolder.bind(gateway);
    vi.spyOn(gateway, "openFolder").mockImplementation(async (config, path, options) => {
      const session = await open(config, path, options);
      const fetchMessages = session.fetchMessages;
      session.fetchMessages = async (uids) => {
        if (++fetches === 2) throw new Error("connection lost");
        return fetchMessages(uids);
      };
      return session;
    });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "error", authFailed: false });
    expect(gateway.sessions.every((s) => s.closed)).toBe(true);
    // The first batch was persisted before the failure.
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(60);
    expect(store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")).toHaveLength(50);
  });

  it("an interrupted initial sync backfills the older window messages on the next round", async () => {
    const { store, gateway, deps } = setup(mailbox(120));
    const open = gateway.openFolder.bind(gateway);
    let fetches = 0;
    const openFolder = vi.spyOn(gateway, "openFolder").mockImplementation(async (config, path, options) => {
      const session = await open(config, path, options);
      const fetchMessages = session.fetchMessages;
      session.fetchMessages = async (uids) => {
        if (++fetches === 2) throw new Error("connection lost");
        return fetchMessages(uids);
      };
      return session;
    });

    const interrupted = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(interrupted).toMatchObject({ status: "error" });
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(120);
    openFolder.mockRestore();

    const resumed = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(resumed).toMatchObject({ status: "ok", fetched: 70, removed: 0 });
    const roundTwo = gateway.sessions[1]!.calls
      .filter((c) => c.method === "fetchMessages")
      .map((c) => c.uids!);
    expect(roundTwo.map((b) => b.length)).toEqual([50, 20]);
    expect(roundTwo.flat()).toEqual(Array.from({ length: 70 }, (_, i) => 70 - i));
    expect(store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")).toHaveLength(120);
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(120);
  });

  it("reconcile removes an undated message gone from the server", async () => {
    const box = mailbox(3);
    box.messages[1]!.date = null;
    const { store, gateway, deps } = setup(box);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const undatedId = store
      .localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")
      .find((e) => e.uid === 2)!.id;

    // While it is on the server it stays and takes the server's flags.
    gateway.mailbox.messages[1]!.flagged = true;
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({
      status: "ok",
      removed: 0,
      flagsChanged: 1,
    });
    expect(store.getMessage(undatedId)).toMatchObject({ isFlagged: true });

    gateway.mailbox.messages = gateway.mailbox.messages.filter((m) => m.uid !== 2);
    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", removed: 1 });
    expect(store.getMessage(undatedId)).toBeNull();
  });

  it("does not push pending seen when uidvalidity changed", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    const openedId = ids.find((e) => e.uid === 2)!.id;
    store.markOpened(openedId);

    // The server renumbers: old uid 2 now names a different message.
    const [m1, m2, m3] = gateway.mailbox.messages;
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 4,
      messages: [
        { ...m3!, uid: 1 },
        { ...m1!, uid: 2 },
        { ...m2!, uid: 3 },
      ],
    };

    const reset = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(reset).toMatchObject({ status: "ok", pushedSeen: 0 });
    expect(gateway.sessions[1]!.readOnly).toBe(false);
    expect(gateway.sessions[1]!.calls).toEqual([{ method: "status" }]);
    expect(gateway.mailbox.messages.every((m) => !m.seen)).toBe(true);
    expect(pendingSeen(store, INBOX)).toEqual([3]);
    expect(store.getMessage(openedId)).toMatchObject({ isRead: true });

    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", pushedSeen: 1 });
    expect(gateway.sessions[3]!.calls).toContainEqual({ method: "setFlags", uids: [3], change: { seen: true } });
    expect(gateway.mailbox.messages.map((m) => [m.uid, m.seen])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(pendingSeen(store, INBOX)).toEqual([]);
  });

  it("an interrupted folder reset is finished by the next successful round", async () => {
    const { store, gateway, deps } = setup(mailbox(60));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const idByMessageId = new Map(
      store.threadingInputs(ACCOUNT_ID).map((input) => [input.messageId, input.id]),
    );

    // Renumbered: messages 1..59 come back as uids 101..159, message 60 is gone.
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 160,
      messages: gateway.mailbox.messages.slice(0, 59).map((m) => ({ ...m, uid: m.uid + 100 })),
    };
    const open = gateway.openFolder.bind(gateway);
    let fetches = 0;
    const openFolder = vi.spyOn(gateway, "openFolder").mockImplementation(async (config, path, options) => {
      const session = await open(config, path, options);
      const fetchMessages = session.fetchMessages;
      session.fetchMessages = async (uids) => {
        if (++fetches === 2) throw new Error("connection lost");
        return fetchMessages(uids);
      };
      return session;
    });
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "error" });
    openFolder.mockRestore();

    const finished = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(finished).toMatchObject({ status: "ok", fetched: 9, removed: 1 });
    const inputs = store.threadingInputs(ACCOUNT_ID);
    expect(inputs).toHaveLength(59);
    expect(store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z")).toHaveLength(59);
    for (const input of inputs) expect(input.id).toBe(idByMessageId.get(input.messageId));
    expect(store.getMessage(idByMessageId.get("msg-60@example.org")!)).toBeNull();
  });

  it("returns an error outcome even when recording the error fails", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    gateway.failOpen(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    vi.spyOn(store, "recordSyncResult").mockImplementation(() => {
      throw new Error("database is locked");
    });

    await expect(syncAccount(deps, ACCOUNT_ID, OPTIONS)).resolves.toEqual({
      status: "error",
      error: "Sync failed (ECONNREFUSED)",
      authFailed: false,
    });
  });

  it("an auth failure on the writable push session stops the round before the read-only session", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    store.markOpened(ids.find((e) => e.uid === 1)!.id);
    // The folder listing logs in; the writable INBOX session is rejected.
    gateway.failOpenFolder(INBOX, new ImapAuthError());
    const openFolder = vi.spyOn(gateway, "openFolder");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({ status: "error", error: "Authentication failed", authFailed: true });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder.mock.calls[0]!.slice(1)).toEqual([INBOX, { readOnly: false }]);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: true });
    expect(pendingSeen(store, INBOX)).toEqual([1]);
  });
});

const EPOCH = "1970-01-01T00:00:00.000Z";

function idsIn(store: InMemoryMailStore, folder: string): { uid: number; id: string }[] {
  return store.localFolderIndex(ACCOUNT_ID, folder, EPOCH).sort((a, b) => a.uid - b.uid);
}

function idByUid(store: InMemoryMailStore, folder: string, uid: number): string {
  return idsIn(store, folder).find((e) => e.uid === uid)!.id;
}

function folderCounts(store: InMemoryMailStore): Record<string, number> {
  return Object.fromEntries(store.listFolders(ACCOUNT_ID).map((f) => [f.path, f.totalCount]));
}

function sessionsFor(gateway: ScriptedImapGateway, path: string, readOnly: boolean) {
  return gateway.sessions.filter((s) => s.path === path && s.readOnly === readOnly);
}

function fetchedUids(gateway: ScriptedImapGateway, path: string, from = 0): number[] {
  return gateway.sessions
    .slice(from)
    .filter((s) => s.path === path)
    .flatMap((s) => s.calls.filter((c) => c.method === "fetchMessages").flatMap((c) => c.uids!));
}

/** INBOX with `count` messages plus an Archive folder with `archived` messages. */
function setupWithArchive(count: number, archived = 0) {
  const ctx = setup(mailbox(count));
  const archive = mailbox(archived, 3);
  for (const message of archive.messages) {
    message.messageId = `archived-${message.uid}@example.org`;
  }
  ctx.gateway.addFolder({ path: "Archive", name: "Archive", specialUse: "archive" }, archive);
  return ctx;
}

describe("syncAccount over folders", () => {
  it("syncs every selectable folder with its own state", async () => {
    const { store, gateway, deps } = setupWithArchive(3, 2);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({
      status: "ok",
      fetched: 5,
      removed: 0,
      flagsChanged: 0,
      pushedSeen: 0,
      pushedFlags: 0,
      folders: 2,
      movesCancelled: [],
      newInbox: [],
      returning: [],
      inserted: expect.any(Array),
    });
    if (outcome.status === "ok") expect(outcome.inserted).toHaveLength(5);
    expect(gateway.listFoldersCalls).toBe(1);
    expect(store.getSyncState(ACCOUNT_ID, INBOX)).toMatchObject({ uidValidity: 7, lastUid: 3 });
    expect(store.getSyncState(ACCOUNT_ID, "Archive")).toMatchObject({ uidValidity: 3, lastUid: 2 });
    expect(folderCounts(store)).toEqual({ INBOX: 3, Archive: 2 });

    gateway.deliver({ date: hoursAgo(0.5) }, "Archive");
    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", fetched: 1, folders: 2 });
    const archiveRound = sessionsFor(gateway, "Archive", true)[1]!;
    expect(archiveRound.calls.find((c) => c.method === "uidsAfter")?.uid).toBe(2);
    expect(store.getSyncState(ACCOUNT_ID, "Archive")?.lastUid).toBe(3);
    expect(store.getSyncState(ACCOUNT_ID, INBOX)?.lastUid).toBe(3);
  });

  it("folders are synced in store order and threads rebuilt once", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    gateway.folders = [];
    gateway.addFolder({ path: "Zeta" });
    gateway.addFolder({ path: "Trash", specialUse: "trash" });
    gateway.addFolder({ path: "INBOX", name: "INBOX", specialUse: "inbox" }, gateway.mailbox);
    gateway.addFolder({ path: "Sent", specialUse: "sent" });
    const assign = vi.spyOn(store, "assignThreads");

    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", folders: 4 });

    expect(gateway.sessions.map((s) => s.path)).toEqual(["INBOX", "Sent", "Trash", "Zeta"]);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("a folder removed on the server is dropped locally", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const archivedId = idByUid(store, "Archive", 1);

    gateway.removeFolder("Archive");
    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", folders: 1 });
    expect(store.listFolders(ACCOUNT_ID).map((f) => f.path)).toEqual([INBOX]);
    expect(store.getSyncState(ACCOUNT_ID, "Archive")).toBeNull();
    expect(store.getMessage(archivedId)).toBeNull();
    expect(gateway.sessions.slice(2).map((s) => s.path)).toEqual([INBOX]);
  });

  it("noselect folders are not opened", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    gateway.addFolder({ path: "[Gmail]", selectable: false });
    gateway.addFolder({ path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "sent" });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", folders: 2 });
    expect(gateway.sessions.map((s) => s.path)).toEqual([INBOX, "[Gmail]/Sent Mail"]);
    expect(store.listFolders(ACCOUNT_ID).find((f) => f.path === "[Gmail]")).toMatchObject({
      selectable: false,
    });
  });

  it("one failing folder does not stop the others", async () => {
    const { store, gateway, notifier, deps } = setupWithArchive(1, 1);
    gateway.addFolder({ path: "Zeta" }, mailbox(2, 9));
    gateway.failAlways("searchSince", new Error("connection reset"), "Archive");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", folders: 2, fetched: 3 });
    expect(store.getSyncState(ACCOUNT_ID, "Zeta")).toMatchObject({ lastUid: 2 });
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastSyncAt: NOW.toISOString(),
      lastError: "Archive: Sync failed",
      authFailed: false,
    });
    expect(notifier.changes).toEqual([ACCOUNT_ID]);
    expect(gateway.sessions.every((s) => s.closed)).toBe(true);
  });

  it("an auth failure in one folder stops the account", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 1);
    gateway.addFolder({ path: "Zeta" }, mailbox(2, 9));
    gateway.failOpenFolder("Archive", new ImapAuthError());

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({ status: "error", error: "Authentication failed", authFailed: true });
    expect(gateway.sessions.map((s) => s.path)).toEqual([INBOX]);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: true });
  });
});

describe("syncAccount moves", () => {
  it("pushes reads before moves", async () => {
    const { store, gateway, deps } = setupWithArchive(3);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.markOpened(idByUid(store, INBOX, 1));
    store.queueMove([idByUid(store, INBOX, 2)], "Archive");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 1, movesCancelled: [] });
    const [push] = sessionsFor(gateway, INBOX, false);
    expect(push!.calls).toEqual([
      { method: "status" },
      { method: "setFlags", uids: [1], change: { seen: true } },
      { method: "moveMessages", uids: [2], destination: "Archive" },
    ]);
    expect(push!.closed).toBe(true);
    // The read-only sync of INBOX follows the push.
    expect(gateway.sessions.slice(2).map((s) => [s.path, s.readOnly])).toEqual([
      [INBOX, false],
      [INBOX, true],
      ["Archive", true],
    ]);
  });

  it("a successful move re-homes and the next round does not refetch or delete it", async () => {
    const { store, gateway, deps } = setupWithArchive(3, 1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 2);
    store.queueMove([movedId], "Archive");
    const before = gateway.sessions.length;

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", fetched: 0, removed: 0, movesCancelled: [] });
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
    expect(idsIn(store, "Archive")).toEqual([
      { uid: 1, id: idByUid(store, "Archive", 1) },
      { uid: 2, id: movedId },
    ]);
    expect(idsIn(store, INBOX).map((e) => e.uid)).toEqual([1, 3]);
    expect(fetchedUids(gateway, "Archive", before)).toEqual([]);
    expect(store.getSyncState(ACCOUNT_ID, "Archive")?.lastUid).toBe(2);
    expect(folderCounts(store)).toEqual({ INBOX: 2, Archive: 2 });

    const after = gateway.sessions.length;
    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", fetched: 0, removed: 0 });
    expect(fetchedUids(gateway, "Archive", after)).toEqual([]);
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
    expect(sessionsFor(gateway, INBOX, false)).toHaveLength(1);
  });

  it("without a uid map the moved row is reattached by the destination's sync with its id", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    gateway.moveUidMap = false;

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", removed: 0 });
    expect(idsIn(store, "Archive")).toEqual([{ uid: 1, id: movedId }]);
    expect(idsIn(store, INBOX).map((e) => e.uid)).toEqual([2]);
    expect(folderCounts(store)).toEqual({ INBOX: 1, Archive: 1 });
  });

  it("a move refused 3 times is cancelled and reported", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    gateway.failAlways("moveMessages", imapError("MoveFailed"));

    for (let round = 0; round < 2; round++) {
      expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({
        status: "ok",
        movesCancelled: [],
      });
      expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toHaveLength(1);
      expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
    }

    const third = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(third).toMatchObject({ status: "ok", movesCancelled: [movedId] });
    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([]);
    expect(store.getMessage(movedId)).toMatchObject({ folder: INBOX });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "Could not move 1 message(s); they were returned to INBOX",
    );
    expect(folderCounts(store)).toEqual({ INBOX: 2, Archive: 0 });
  });

  it("MoveUnsupported cancels at once", async () => {
    const { store, gateway, deps } = setupWithArchive(3);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = [idByUid(store, INBOX, 1), idByUid(store, INBOX, 3)];
    store.queueMove(ids, "Archive");
    gateway.failAlways("moveMessages", imapError("MoveUnsupported"));

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", movesCancelled: ids });
    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([]);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "Could not move 2 message(s); they were returned to INBOX",
    );
    expect(folderCounts(store)).toEqual({ INBOX: 3, Archive: 0 });
    expect(gateway.mailbox.messages).toHaveLength(3);

    // Nothing is pending, so the next round opens no writable session.
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(sessionsFor(gateway, INBOX, false)).toHaveLength(1);
  });

  it("a connection error during a move does not count as a failure", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 2);
    store.queueMove([movedId], "Archive");

    for (let round = 0; round < 4; round++) {
      // Rounds alternate a thrown reset and the gateway's dropped-MOVE code.
      gateway.failNext(
        "moveMessages",
        round % 2 === 0 ? new Error("connection reset") : imapError("ConnectionLost"),
      );
      expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({
        status: "ok",
        movesCancelled: [],
      });
      expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([
        { uid: 2, id: movedId, destination: "Archive" },
      ]);
      expect(store.getAccount(ACCOUNT_ID)?.lastError).toMatch(/^INBOX: Sync failed/);
    }

    await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([]);
  });

  it("a moved message's pending read survives the move", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.markOpened(movedId);
    store.queueMove([movedId], "Archive");
    gateway.failNext("setFlags", imapError("StoreFailed"), INBOX);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 1 });
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive", isRead: true });
    const [archivePush] = sessionsFor(gateway, "Archive", false);
    expect(archivePush!.calls).toEqual([{ method: "status" }, { method: "setFlags", uids: [1], change: { seen: true } }]);
    const archived = gateway.mailboxes.get("Archive")!.messages;
    expect(archived.map((m) => [m.messageId, m.seen])).toEqual([["msg-1@example.org", true]]);
    expect(pendingSeen(store, "Archive")).toEqual([]);
  });

  it("a uidvalidity change skips the move push", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 2);
    store.queueMove([movedId], "Archive");
    // The server renumbers INBOX: old uid 2 now names message 1.
    const [m1, m2] = gateway.mailbox.messages;
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 3,
      messages: [
        { ...m2!, uid: 1 },
        { ...m1!, uid: 2 },
      ],
    };

    const reset = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(reset).toMatchObject({ status: "ok", movesCancelled: [] });
    expect(sessionsFor(gateway, INBOX, false)[0]!.calls).toEqual([{ method: "status" }]);
    expect(gateway.mailboxes.get("Archive")!.messages).toEqual([]);
    // Still waiting, now under the message's new uid.
    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([
      { uid: 1, id: movedId, destination: "Archive" },
    ]);

    await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(sessionsFor(gateway, INBOX, false)[1]!.calls).toContainEqual({
      method: "moveMessages",
      uids: [1],
      destination: "Archive",
    });
    expect(gateway.mailbox.messages.map((m) => m.messageId)).toEqual(["msg-1@example.org"]);
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
  });

  it("a partial COPY left in the destination by a failed UIDPLUS move does not duplicate in counts", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    // COPY succeeded, the \Deleted STORE did not: the server refuses the move
    // but a copy is already in Archive.
    const archive = gateway.mailboxes.get("Archive")!;
    archive.messages.push({ ...structuredClone(gateway.mailbox.messages[0]!), uid: archive.uidNext++ });
    gateway.failNext("moveMessages", imapError("MoveFailed"));

    await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toHaveLength(1);
    expect(folderCounts(store)).toEqual({ INBOX: 1, Archive: 1 });

    // The retry succeeds: a second server copy lands in Archive.
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
    expect(archive.messages).toHaveLength(2);
    expect(folderCounts(store)).toEqual({ INBOX: 1, Archive: 1 });
    expect(store.unreadCount(ACCOUNT_ID)).toBe(1);
    const threads = store.listThreads(ACCOUNT_ID, "Archive", null, 10).threads;
    expect(threads.map((t) => t.messageCount)).toEqual([1]);
  });
});

describe("syncAccount fix round 1", () => {
  it("a store failure after the server moved the mail fails the folder visibly", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    vi.spyOn(store, "completeMove").mockImplementationOnce(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    // INBOX failed, Archive synced (and fetched the moved message itself).
    expect(outcome).toMatchObject({ status: "ok", folders: 1 });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe("INBOX: Sync failed (SQLITE_BUSY)");
    expect(gateway.mailboxes.get("Archive")!.messages).toHaveLength(1);
    // The INBOX read-only sync did not run.
    expect(sessionsFor(gateway, INBOX, true)).toHaveLength(1);
  });

  it("a queued move whose row a uidvalidity reset deletes is reported as dropped", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    // Renumbered, and message 1 is gone from the server.
    const [, m2] = gateway.mailbox.messages;
    gateway.mailbox = { uidValidity: 8, uidNext: 3, messages: [{ ...m2!, uid: 2 }] };

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", movesCancelled: [movedId] });
    expect(store.getMessage(movedId)).toBeNull();
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "INBOX was renumbered by the server; 1 queued move(s) were dropped",
    );
  });

  it("a queued move whose row a uidvalidity reset pushes out of the window keeps its row and its move", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    // Renumbered, and message 1 is now outside the window by its internal date.
    const [m1, m2] = gateway.mailbox.messages;
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 6,
      messages: [
        { ...m1!, uid: 4, date: hoursAgo(24 * 40) },
        { ...m2!, uid: 5 },
      ],
    };

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", movesCancelled: [] });
    expect(uidOf(store, movedId)).toBe(4);
    expect(store.pendingMoves(ACCOUNT_ID, INBOX).map((m) => m.id)).toEqual([movedId]);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
  });

  it("a never-synced folder holding re-homed rows starts with a reset", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    // Archive cannot be read in the first two rounds.
    gateway.failOpenFolder("Archive", new Error("connection reset"));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getSyncState(ACCOUNT_ID, "Archive")).toBeNull();
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    // The move session works; only Archive's own sessions fail.
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(idsIn(store, "Archive")).toEqual([{ uid: 1, id: movedId }]);

    // Archive is renumbered: uid 1 now names a new message, the moved one is 2.
    const [moved] = gateway.mailboxes.get("Archive")!.messages;
    const fresh = makeFetchedMessage(1, { messageId: "fresh@example.org", date: hoursAgo(1) });
    gateway.mailboxes.set("Archive", {
      uidValidity: 4,
      uidNext: 3,
      messages: [fresh, { ...moved!, uid: 2 }],
    });
    gateway.failOpenFolder("Archive", null);

    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", folders: 2 });

    const archive = idsIn(store, "Archive");
    expect(archive).toHaveLength(2);
    expect(archive.find((e) => e.uid === 2)?.id).toBe(movedId);
    expect(store.getMessage(archive.find((e) => e.uid === 1)!.id)?.subject).toBe(fresh.subject);
  });

  it("queued moves in a folder removed on the server are reported as dropped", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = [idByUid(store, "Archive", 1), idByUid(store, "Archive", 2)];
    store.queueMove(ids, INBOX);
    gateway.removeFolder("Archive");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", movesCancelled: ids });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "Archive no longer exists; 2 queued move(s) were dropped",
    );
  });

  it("when every folder fails the round is an error and lastSyncAt stays", async () => {
    const { store, gateway, deps } = setupWithArchive(2, 1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const earlier = store.getAccount(ACCOUNT_ID)!.lastSyncAt;
    const movedId = idByUid(store, INBOX, 1);
    store.queueMove([movedId], "Archive");
    gateway.failAlways("moveMessages", imapError("MoveUnsupported"));
    gateway.failAlways("searchSince", new Error("connection reset"));
    (deps.clock as FixedClock).set(new Date(NOW.getTime() + 60_000));

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    const error =
      "Could not move 1 message(s); they were returned to INBOX; INBOX: Sync failed; Archive: Sync failed";
    expect(outcome).toEqual({
      status: "error",
      error,
      authFailed: false,
      movesCancelled: [movedId],
    });
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastSyncAt: earlier,
      lastError: error,
      authFailed: false,
    });
  });

  it("a folder listing without INBOX fails the round and keeps the local folders", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    gateway.removeFolder(INBOX);
    const saveFolders = vi.spyOn(store, "saveFolders");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({
      status: "error",
      error: "Folder list from the server is missing INBOX",
      authFailed: false,
    });
    expect(saveFolders).not.toHaveBeenCalled();
    expect(store.listFolders(ACCOUNT_ID).map((f) => f.path)).toEqual([INBOX, "Archive"]);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "Folder list from the server is missing INBOX",
    );
  });
});

describe("syncAccount flag push", () => {
  function intents(store: InMemoryMailStore, folder: string) {
    return store.pendingFlagIntents(ACCOUNT_ID, folder);
  }

  it("pushes the four flag sets with one STORE each, then clears them", async () => {
    const box = mailbox(4);
    box.messages[1]!.seen = true;
    box.messages[3]!.flagged = true;
    const { store, gateway, deps } = setup(box);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.setDesired([idByUid(store, INBOX, 1)], { seen: true, flagged: true });
    store.setDesired([idByUid(store, INBOX, 2)], { seen: false });
    store.setDesired([idByUid(store, INBOX, 3)], { flagged: true });
    store.setDesired([idByUid(store, INBOX, 4)], { flagged: false });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 1, pushedFlags: 4 });
    const [push] = sessionsFor(gateway, INBOX, false);
    expect(push!.calls).toEqual([
      { method: "status" },
      { method: "setFlags", uids: [1], change: { seen: true } },
      { method: "setFlags", uids: [2], change: { seen: false } },
      { method: "setFlags", uids: [1, 3], change: { flagged: true } },
      { method: "setFlags", uids: [4], change: { flagged: false } },
    ]);
    expect(push!.closed).toBe(true);
    expect(gateway.mailbox.messages.map((m) => [m.uid, m.seen, m.flagged])).toEqual([
      [1, true, true],
      [2, false, false],
      [3, false, true],
      [4, false, false],
    ]);
    expect(intents(store, INBOX)).toEqual([]);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
  });

  it("a click during the push stays pending and wins in the next round", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const id = idByUid(store, INBOX, 1);
    store.setDesired([id], { seen: true });
    const gate = gateway.gateStore();

    const round = syncAccount(deps, ACCOUNT_ID, OPTIONS);
    await gate.entered;
    // The owner marks it unread again while the STORE \Seen is in flight.
    store.setDesired([id], { seen: false });
    gate.release();
    const first = await round;

    expect(first).toMatchObject({ status: "ok", pushedSeen: 1, pushedFlags: 0 });
    expect(gateway.mailbox.messages[0]!.seen).toBe(true);
    expect(intents(store, INBOX)).toEqual([{ uid: 1, seen: false, flagged: null }]);
    // The server's \Seen does not override the pending local value.
    expect(store.getMessage(id)).toMatchObject({ isRead: false });

    const second = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(second).toMatchObject({ status: "ok", pushedSeen: 0, pushedFlags: 1 });
    expect(sessionsFor(gateway, INBOX, false)[1]!.calls).toContainEqual({
      method: "setFlags",
      uids: [1],
      change: { seen: false },
    });
    expect(gateway.mailbox.messages[0]!.seen).toBe(false);
    expect(intents(store, INBOX)).toEqual([]);
    expect(store.getMessage(id)).toMatchObject({ isRead: false });
  });

  it("a refused STORE keeps its intents while the other sets and the moves still run", async () => {
    const { store, gateway, deps } = setupWithArchive(3);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.setDesired([idByUid(store, INBOX, 1)], { seen: true });
    store.setDesired([idByUid(store, INBOX, 2)], { flagged: true });
    const movedId = idByUid(store, INBOX, 3);
    store.queueMove([movedId], "Archive");
    gateway.failNext("setFlags", imapError("StoreFailed"), INBOX);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 0, pushedFlags: 1 });
    expect(sessionsFor(gateway, INBOX, false)[0]!.calls).toEqual([
      { method: "status" },
      { method: "setFlags", uids: [1], change: { seen: true } },
      { method: "setFlags", uids: [2], change: { flagged: true } },
      { method: "moveMessages", uids: [3], destination: "Archive" },
    ]);
    expect(intents(store, INBOX)).toEqual([{ uid: 1, seen: true, flagged: null }]);
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive" });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe(
      "INBOX: could not update flags on the server",
    );

    const retried = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(retried).toMatchObject({ status: "ok", pushedSeen: 1, pushedFlags: 0 });
    expect(intents(store, INBOX)).toEqual([]);
    expect(gateway.mailbox.messages.find((m) => m.uid === 1)!.seen).toBe(true);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
  });

  it("a dropped connection during a STORE leaves every flag change and move pending", async () => {
    const { store, gateway, deps } = setupWithArchive(3);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.setDesired([idByUid(store, INBOX, 1)], { seen: true });
    store.setDesired([idByUid(store, INBOX, 2)], { flagged: true });
    const movedId = idByUid(store, INBOX, 3);
    store.queueMove([movedId], "Archive");
    gateway.failNext("setFlags", new Error("connection reset"), INBOX);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedSeen: 0, pushedFlags: 0 });
    expect(sessionsFor(gateway, INBOX, false)[0]!.calls).toEqual([
      { method: "status" },
      { method: "setFlags", uids: [1], change: { seen: true } },
    ]);
    expect(intents(store, INBOX)).toEqual([
      { uid: 1, seen: true, flagged: null },
      { uid: 2, seen: null, flagged: true },
    ]);
    expect(store.pendingMoves(ACCOUNT_ID, INBOX)).toEqual([
      { uid: 3, id: movedId, destination: "Archive" },
    ]);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe("INBOX: Sync failed");
  });

  it("does not push flags when uidvalidity changed", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const starredId = idByUid(store, INBOX, 2);
    store.setDesired([starredId], { flagged: true });
    // The server renumbers: old uid 2 now names message 1.
    const [m1, m2] = gateway.mailbox.messages;
    gateway.mailbox = {
      uidValidity: 8,
      uidNext: 3,
      messages: [
        { ...m2!, uid: 1 },
        { ...m1!, uid: 2 },
      ],
    };

    const reset = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(reset).toMatchObject({ status: "ok", pushedFlags: 0 });
    expect(sessionsFor(gateway, INBOX, false)[0]!.calls).toEqual([{ method: "status" }]);
    expect(gateway.mailbox.messages.every((m) => !m.flagged)).toBe(true);
    // Still pending, now under the message's new uid.
    expect(intents(store, INBOX)).toEqual([{ uid: 1, seen: null, flagged: true }]);
    expect(store.getMessage(starredId)).toMatchObject({ isFlagged: true });

    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", pushedFlags: 1 });
    expect(gateway.mailbox.messages.map((m) => [m.uid, m.flagged])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(intents(store, INBOX)).toEqual([]);
  });

  it("a row waiting to move gets its flags pushed before the move", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const movedId = idByUid(store, INBOX, 2);
    store.setDesired([movedId], { flagged: true });
    store.queueMove([movedId], "Archive");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", pushedFlags: 1, movesCancelled: [] });
    expect(sessionsFor(gateway, INBOX, false)[0]!.calls).toEqual([
      { method: "status" },
      { method: "setFlags", uids: [2], change: { flagged: true } },
      { method: "moveMessages", uids: [2], destination: "Archive" },
    ]);
    const archived = gateway.mailboxes.get("Archive")!.messages;
    expect(archived.map((m) => [m.messageId, m.flagged])).toEqual([["msg-2@example.org", true]]);
    expect(store.getMessage(movedId)).toMatchObject({ folder: "Archive", isFlagged: true });
    expect(intents(store, "Archive")).toEqual([]);
    expect(sessionsFor(gateway, "Archive", false)).toEqual([]);
  });

  it("a store failure while clearing pushed flags fails the folder", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.setDesired([idByUid(store, INBOX, 1)], { flagged: true });
    vi.spyOn(store, "clearFlagIntents").mockImplementation(() => {
      throw new Error("disk full");
    });

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "error", authFailed: false });
    expect(sessionsFor(gateway, INBOX, true)).toHaveLength(1);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBe("INBOX: Sync failed");
  });
});

// ---------------------------------------------------------------------------
// Slice 3e: Inbox-only rounds, new Inbox mail and unsubscribe info at sync
// ---------------------------------------------------------------------------

/** A synthetic Gmail-shaped header set whose DKIM signature covers both list headers. */
function gmailListHeaders(): { key: string; value: string }[] {
  const h = (key: string, value: string) => ({ key: key.toLowerCase(), value });
  return [
    h("Delivered-To", "owner@example.org"),
    h("Received", "by 2002:a05:0000:0000 with SMTP id x"),
    h("Authentication-Results", "mx.google.com;\r\n dkim=pass header.i=@example.com header.s=sel1 header.b=AbCdEf12"),
    h("Return-Path", "<bounce@example.com>"),
    h(
      "DKIM-Signature",
      "v=1; a=rsa-sha256; d=example.com; s=sel1; h=from:subject:list-unsubscribe:list-unsubscribe-post; bh=AAAA; b=AbCdEf12xyz",
    ),
    h("From", "News <news@example.com>"),
    h("List-Unsubscribe", "<https://u.example.com/x>, <mailto:leave@example.com>"),
    h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
  ];
}

describe("slice-3e sync", () => {
  it("an Inbox-only round lists nothing and pushes and fetches only the Inbox", async () => {
    const { store, gateway, deps } = setupWithArchive(2, 1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const archived = idByUid(store, "Archive", 1);
    store.setDesired([archived], { flagged: true });
    gateway.deliver({}, INBOX);
    gateway.deliver({ messageId: "late-archive@example.org" }, "Archive");
    const listings = gateway.listFoldersCalls;
    const before = gateway.sessions.length;
    const threads = vi.spyOn(store, "assignThreads");

    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });

    expect(outcome).toMatchObject({ status: "ok", folders: 1, fetched: 1, pushedFlags: 0 });
    expect(gateway.listFoldersCalls).toBe(listings);
    expect(gateway.sessions.slice(before).map((s) => s.path)).toEqual([INBOX]);
    expect(store.pendingFlagIntents(ACCOUNT_ID, "Archive")).toHaveLength(1);
    expect(threads).toHaveBeenCalledTimes(1);
  });

  it("an Inbox-only round keeps lastSyncAt and the full round's lastError, appending its own problem", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const synced = store.getAccount(ACCOUNT_ID)!.lastSyncAt;
    store.recordSyncResult(ACCOUNT_ID, { lastSyncAt: synced, lastError: "Archive: Sync failed (X)", authFailed: false });
    store.setDesired([idByUid(store, INBOX, 1)], { flagged: true });
    gateway.failNext("setFlags", imapError("StoreFailed"), INBOX);
    (deps.clock as FixedClock).set(new Date(NOW.getTime() + 60_000));

    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });

    expect(outcome.status).toBe("ok");
    const account = store.getAccount(ACCOUNT_ID)!;
    expect(account.lastSyncAt).toBe(synced);
    expect(account.lastError).toBe("Archive: Sync failed (X); INBOX: could not update flags on the server");

    // A clean Inbox-only round never clears it; a full round does.
    await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });
    expect(store.getAccount(ACCOUNT_ID)!.lastError).toBe(
      "Archive: Sync failed (X); INBOX: could not update flags on the server",
    );
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getAccount(ACCOUNT_ID)!.lastError).toBeNull();
    expect(store.getAccount(ACCOUNT_ID)!.lastSyncAt).not.toBe(synced);
  });

  it("an Inbox-only round whose Inbox fails merges the error and keeps lastSyncAt", async () => {
    const { store, gateway, deps } = setupWithArchive(1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const synced = store.getAccount(ACCOUNT_ID)!.lastSyncAt;
    store.recordSyncResult(ACCOUNT_ID, { lastSyncAt: synced, lastError: "Archive: Sync failed (X)", authFailed: false });
    gateway.failOpenFolder(INBOX, imapError("Busy"));

    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });

    expect(outcome.status).toBe("error");
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({
      lastSyncAt: synced,
      lastError: "Archive: Sync failed (X); INBOX: Sync failed (Busy)",
      authFailed: false,
    });
  });

  it("an Inbox-only round still records an authentication failure", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    gateway.failOpenFolder(INBOX, new ImapAuthError());

    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });

    expect(outcome).toMatchObject({ status: "error", authFailed: true });
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: true, lastError: "Authentication failed" });
  });

  it("newInbox has the incremental fetch's inserted Inbox rows, never an initial sync's", async () => {
    const { store, gateway, deps } = setupWithArchive(3);
    const initial = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(initial).toMatchObject({ status: "ok", fetched: 3, newInbox: [], returning: [] });

    const fresh = gateway.deliver({}, INBOX);
    gateway.deliver({ messageId: "archive-new@example.org" }, "Archive");
    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", newInbox: [idByUid(store, INBOX, fresh.uid)], returning: [] });
  });

  it("inserted lists every row inserted this round in any folder, reconcile backfill included", async () => {
    const { store, gateway, deps } = setupWithArchive(2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const inbox = gateway.deliver({}, INBOX);
    const archive = gateway.deliver({ messageId: "archive-new@example.org" }, "Archive");
    store.deleteByUids(ACCOUNT_ID, INBOX, [1]);
    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    if (next.status !== "ok") throw new Error("round failed");
    expect(new Set(next.inserted)).toEqual(
      new Set([idByUid(store, INBOX, inbox.uid), idByUid(store, "Archive", archive.uid), idByUid(store, INBOX, 1)]),
    );
    const quiet = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(quiet).toMatchObject({ status: "ok", inserted: [] });
  });

  it("newInbox leaves out a UIDVALIDITY reset and a reconcile backfill", async () => {
    const { store, gateway, deps } = setup(mailbox(3));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    // Lost locally but inside the window on the server: reconcile backfills it.
    store.deleteByUids(ACCOUNT_ID, INBOX, [2]);
    const backfilled = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(backfilled).toMatchObject({ status: "ok", fetched: 1, newInbox: [] });

    const box = gateway.mailboxes.get(INBOX)!;
    box.uidValidity = 99;
    gateway.deliver({}, INBOX);
    const reset = await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(reset).toMatchObject({ status: "ok", newInbox: [] });
  });

  it("newInbox leaves out a row a move re-homed into the Inbox, with or without a uid map", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 2);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const rehomed = idByUid(store, "Archive", 1);
    store.queueMove([rehomed], INBOX);
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", newInbox: [] });
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", newInbox: [] });
    expect(store.getMessage(rehomed)).toMatchObject({ folder: INBOX });

    gateway.moveUidMap = false;
    const reattached = idByUid(store, "Archive", 2);
    store.queueMove([reattached], INBOX);
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", newInbox: [] });
    // The Inbox comes first in the round, so its sync reattaches the row in the next one.
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", newInbox: [] });
    expect(store.getMessage(reattached)).toMatchObject({ folder: INBOX });
  });

  it("a new Inbox row whose dedup key another row already had is returning", async () => {
    const { store, gateway, deps } = setupWithArchive(1, 1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const copy = gateway.deliver({ messageId: "archived-1@example.org" }, INBOX);
    const fresh = gateway.deliver({}, INBOX);

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    const copyId = idByUid(store, INBOX, copy.uid);
    expect(outcome).toMatchObject({
      status: "ok",
      newInbox: [copyId, idByUid(store, INBOX, fresh.uid)],
      returning: [copyId],
    });
  });

  it("an Inbox-only round collects newInbox too", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const fresh = gateway.deliver({}, INBOX);

    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });

    expect(outcome).toMatchObject({ status: "ok", newInbox: [idByUid(store, INBOX, fresh.uid)] });
  });

  it("stores unsubscribe info judged by the account's preset, and none without headers", async () => {
    for (const [preset, trust] of [["gmail", "covered"], ["other", "untrusted_provider"]] as const) {
      const { store, gateway, deps } = setup(mailbox(0));
      store.saveAccount(makeStoredAccount({ id: ACCOUNT_ID, passwordSealed: PASSWORD, preset }));
      const listed = gateway.deliver({
        from: { name: "News", address: "news@example.com" },
        unsubscribeHeaders: gmailListHeaders(),
      });
      const plain = gateway.deliver();

      await syncAccount(deps, ACCOUNT_ID, OPTIONS);

      expect(store.getUnsubscribeInfo(idByUid(store, INBOX, listed.uid)), preset).toMatchObject({
        listKey: "from:news@example.com",
        https: "https://u.example.com/x",
        oneClick: true,
        mailto: { address: "leave@example.com" },
        trust,
      });
      expect(store.getUnsubscribeInfo(idByUid(store, INBOX, plain.uid)), preset).toBeNull();
    }
  });

  it("a fetch without headers leaves stored unsubscribe info alone", () => {
    const store = new InMemoryMailStore();
    const withHeaders = makeFetchedMessage(1, {
      unsubscribe: {
        listKey: "from:news@example.com",
        listName: "News",
        https: null,
        oneClick: false,
        mailto: { address: "leave@example.com", subject: "unsubscribe", body: "" },
        trust: "untrusted_provider",
      },
    });
    store.upsertMessages(ACCOUNT_ID, INBOX, [withHeaders]);
    const { unsubscribe: _info, ...without } = withHeaders;
    store.upsertMessages(ACCOUNT_ID, INBOX, [without]);
    const id = store.localFolderIndex(ACCOUNT_ID, INBOX, EPOCH)[0]!.id;
    expect(store.getUnsubscribeInfo(id)).toMatchObject({ listKey: "from:news@example.com" });
  });

  it("a listing without the snooze folder clears it; a listing with it keeps it", async () => {
    const { store, gateway, deps } = setupWithArchive(1);
    store.saveAccount({ ...store.getAccount(ACCOUNT_ID)!, snoozeFolder: "Archive" });
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getAccount(ACCOUNT_ID)!.snoozeFolder).toBe("Archive");

    gateway.removeFolder("Archive");
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getAccount(ACCOUNT_ID)!.snoozeFolder).toBeNull();
  });

  it("an Inbox-only round never clears the snooze folder (it lists nothing)", async () => {
    const { store, gateway, deps } = setupWithArchive(1);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    store.saveAccount({ ...store.getAccount(ACCOUNT_ID)!, snoozeFolder: "Archive" });
    gateway.removeFolder("Archive");
    await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, only: "inbox" });
    expect(store.getAccount(ACCOUNT_ID)!.snoozeFolder).toBe("Archive");
  });
});

describe("snoozed mail outside the sync window (review item 1)", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(NOW.getTime() + days * DAY);
  const depsAt = (base: SyncDeps, now: Date): SyncDeps => ({ ...base, clock: new FixedClock(now) });

  /** One stored Inbox message that is 60 days old by the time it is snoozed. */
  async function snoozedOldMessage(options: { uidMap?: boolean } = {}) {
    const old = makeFetchedMessage(1, { date: new Date(NOW.getTime() - 20 * DAY).toISOString() });
    const { store, gateway, deps } = setup({ uidValidity: 7, uidNext: 2, messages: [old] });
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const id = idByUid(store, INBOX, 1);
    const later = at(40);
    expect((await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS)).status).toBe("ok");
    expect(store.getMessage(id)).not.toBeNull();
    // The owner confirms the folder: CREATE, the listing saved, the path stored.
    gateway.addFolder({ path: "Snoozed", name: "Snoozed", specialUse: null }, { uidValidity: 3, uidNext: 1, messages: [] });
    store.saveFolders(ACCOUNT_ID, await gateway.listFolders({} as never));
    store.setSnoozeFolder(ACCOUNT_ID, "Snoozed");
    if (options.uidMap === false) gateway.moveUidMap = false;
    expect(store.queueMove([id], "Snoozed")).not.toBeNull();
    const dueAt = new Date(later.getTime() + DAY).toISOString();
    store.createSnoozes([{ messageId: id, accountId: ACCOUNT_ID, returnTo: INBOX, dueAt, state: "moving" }], later.toISOString());
    return { store, gateway, deps, id, later };
  }

  const ctxAt = (store: InMemoryMailStore, now: Date) => ({
    snoozeFolder: "Snoozed",
    inbox: INBOX,
    folders: store.listFolders(ACCOUNT_ID),
    now,
  });

  it("a never-synced snooze folder keeps the re-homed row and its snooze, and the message returns on time", async () => {
    const { store, gateway, deps, id, later } = await snoozedOldMessage();

    expect(await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", removed: 0 });
    expect(store.getMessage(id)).toMatchObject({ folder: "Snoozed" });
    expect(idsIn(store, "Snoozed")).toEqual([{ uid: 1, id }]);
    expect(store.listSnoozes(ACCOUNT_ID, { limit: 10 })).toHaveLength(1);
    expect(planSnoozes(store.snoozeViews(ACCOUNT_ID, 10), ctxAt(store, later)).map((s) => s.kind)).toEqual(["to_snoozed"]);
    store.updateSnooze(id, { state: "snoozed" }, later.toISOString());

    // More rounds before it is due: still tracked.
    const hourLater = new Date(later.getTime() + 3_600_000);
    expect(await syncAccount(depsAt(deps, hourLater), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", removed: 0 });
    expect(planSnoozes(store.snoozeViews(ACCOUNT_ID, 10), ctxAt(store, hourLater)).map((s) => s.kind)).toEqual(["wait"]);

    // Due: the return is planned and the move back lands it in the Inbox.
    const due = new Date(later.getTime() + 86_400_000);
    const [step] = planSnoozes(store.snoozeViews(ACCOUNT_ID, 10), ctxAt(store, due));
    expect(step).toMatchObject({ kind: "return", to: INBOX });
    store.queueMove([id], INBOX);
    store.updateSnooze(id, { state: "returning" }, due.toISOString());
    expect(await syncAccount(depsAt(deps, due), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok" });
    expect(store.getMessage(id)).toMatchObject({ folder: INBOX });
    expect(planSnoozes(store.snoozeViews(ACCOUNT_ID, 10), ctxAt(store, due)).map((s) => s.kind)).toEqual(["done"]);
    expect(gateway.mailbox.messages).toHaveLength(1);
  });

  it("a snoozed row moved without a uid map is reattached by Message-ID outside the window", async () => {
    const { store, deps, id, later } = await snoozedOldMessage({ uidMap: false });

    expect(await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", removed: 0 });
    expect(idsIn(store, "Snoozed")).toEqual([{ uid: 1, id }]);
    expect(store.listSnoozes(ACCOUNT_ID, { limit: 10 })).toHaveLength(1);
  });

  it("a later UIDVALIDITY change of the snooze folder keeps the snoozed row by Message-ID", async () => {
    const { store, gateway, deps, id, later } = await snoozedOldMessage();
    await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS);
    store.updateSnooze(id, { state: "snoozed" }, later.toISOString());
    const box = gateway.mailboxes.get("Snoozed")!;
    // The server renumbers the folder; an unrelated old message takes uid 1.
    const moved = box.messages[0]!;
    box.uidValidity = 4;
    box.messages = [
      makeFetchedMessage(1, { messageId: "other@example.org", date: moved.date }),
      { ...moved, uid: 9 },
    ];
    box.uidNext = 10;

    expect(await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", removed: 0 });
    expect(idsIn(store, "Snoozed")).toEqual([{ uid: 9, id }]);
    expect(store.listSnoozes(ACCOUNT_ID, { limit: 10 })).toMatchObject([{ messageId: id, state: "snoozed" }]);
  });

  it("a snoozed row the server no longer has still goes with its snooze after a reset", async () => {
    const { store, gateway, deps, id, later } = await snoozedOldMessage();
    await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS);
    const box = gateway.mailboxes.get("Snoozed")!;
    box.uidValidity = 4;
    box.messages = [];
    expect(await syncAccount(depsAt(deps, later), ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok", removed: 1 });
    expect(store.getMessage(id)).toBeNull();
  });
});

describe("slice 3g: dev classification and List-Id at sync", () => {
  const CLASSIFY = { ...OPTIONS, classify: true };
  const githubCi = {
    from: { name: "GitHub", address: "notifications@github.com" },
    subject: "[example-org/demo] Run failed: CI - main (abc1234)",
    bulkHeaders: { listId: "Example <demo.example-org.github.com>", listUnsubscribe: null, precedence: "list", autoSubmitted: null },
    devHeaders: [{ key: "x-github-reason", value: "ci_activity" }],
  };
  /** Session calls that could change the server. */
  const WRITES = new Set(["setFlags", "markSeen", "moveMessages", "copyMessages", "appendMessage", "expungeOwn"]);

  it("classifies a new GitHub CI failure at insert and keeps its List-Id", async () => {
    const { store, gateway, deps } = setup(mailbox(1));
    await syncAccount(deps, ACCOUNT_ID, CLASSIFY);
    const ci = gateway.deliver(githubCi);
    const outcome = await syncAccount(deps, ACCOUNT_ID, CLASSIFY);

    const id = idByUid(store, INBOX, ci.uid);
    expect(outcome).toMatchObject({ status: "ok", newInbox: [id], returning: [] });
    expect(store.getMessage(id)!.dev).toEqual({ source: "github", repo: "github.com/example-org/demo", kind: "ci", state: "failed", ref: null });
    expect(store.listUnknown(ACCOUNT_ID, INBOX, null, 10).map((r) => r.uid)).not.toContain(ci.uid);
    store.addBinding({ kind: "list", value: "demo.example-org.github.com", projectId: "p_api", createdAt: NOW.toISOString() });
    expect(store.listThreads(ACCOUNT_ID, INBOX, null, 10, { projectId: "p_api" }).threads.map((t) => t.id)).toEqual([
      store.getMessage(id)!.threadId,
    ]);
    // The first message was fetched without headers: its List-Id stays unknown.
    expect(store.listUnknown(ACCOUNT_ID, INBOX, null, 10)).toEqual([{ uid: 1 }]);
    const calls = gateway.sessions.flatMap((s) => s.calls.map((c) => c.method));
    expect(calls.filter((method) => WRITES.has(method))).toEqual([]);
  });

  it("reads GitLab's headers", async () => {
    const { store, gateway, deps } = setup(mailbox(0));
    await syncAccount(deps, ACCOUNT_ID, CLASSIFY);
    const pipeline = gateway.deliver({
      from: { name: null, address: "gitlab@gitlab.example.com" },
      subject: "Failed pipeline for main | demo | abc1234",
      devHeaders: [
        { key: "x-gitlab-project-path", value: "Group/Sub/Demo" },
        { key: "x-gitlab-pipeline-status", value: "failed" },
        { key: "x-gitlab-pipeline-id", value: "88" },
      ],
    });
    // A self-hosted GitLab counts only from a project remote's host (review).
    await syncAccount(deps, ACCOUNT_ID, { ...CLASSIFY, devHosts: ["GitLab.example.com"] });
    expect(store.getMessage(idByUid(store, INBOX, pipeline.uid))!.dev).toEqual({
      source: "gitlab",
      repo: "gitlab.example.com/group/sub/demo",
      kind: "ci",
      state: "failed",
      ref: "88",
    });
    const unknown = gateway.deliver({
      from: { name: null, address: "gitlab@git.unknown.example" },
      subject: "Failed pipeline for main | demo | abc1234",
      devHeaders: [{ key: "x-gitlab-project-path", value: "group/demo" }],
    });
    await syncAccount(deps, ACCOUNT_ID, { ...CLASSIFY, devHosts: ["gitlab.example.com"] });
    expect(store.getMessage(idByUid(store, INBOX, unknown.uid))!.dev).toBeNull();
  });

  it("leaves Spam rows unclassified, and classifies nothing with classification off", async () => {
    const { store, gateway, deps } = setup(mailbox(0));
    gateway.addFolder({ path: "Spam", name: "Spam", specialUse: "junk" }, { uidValidity: 4, uidNext: 1, messages: [] });
    await syncAccount(deps, ACCOUNT_ID, CLASSIFY);
    const spam = gateway.deliver(githubCi, "Spam");
    const off = gateway.deliver(githubCi);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.getMessage(idByUid(store, INBOX, off.uid))!.dev).toBeNull();
    expect(store.devUnclassified(10).map((r) => r.id)).toEqual([idByUid(store, INBOX, off.uid)]);
    const later = gateway.deliver({ ...githubCi, messageId: "later@example.org" }, "Spam");
    await syncAccount(deps, ACCOUNT_ID, CLASSIFY);
    expect(store.getMessage(idByUid(store, "Spam", spam.uid))!.dev).toBeNull();
    expect(store.getMessage(idByUid(store, "Spam", later.uid))!.dev).toBeNull();
    // Spam rows are not offered to the backfill either.
    expect(store.devUnclassified(10).map((r) => r.id)).toEqual([idByUid(store, INBOX, off.uid)]);
  });
});

describe("slice 3h: kept rows, history check and Gmail labels", () => {
  const DAY = 86_400_000;
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
  const EPOCH = "1970-01-01T00:00:00.000Z";

  /** INBOX with three recent messages and two from 60 and 61 days ago (outside the 30-day window). */
  function withHistory() {
    const box: FakeMailbox = {
      uidValidity: 7,
      uidNext: 6,
      messages: [
        makeFetchedMessage(1, { date: daysAgo(61), messageId: "<old-1@example.org>" }),
        makeFetchedMessage(2, { date: daysAgo(60), messageId: "<old-2@example.org>" }),
        makeFetchedMessage(3, { date: hoursAgo(3) }),
        makeFetchedMessage(4, { date: hoursAgo(2) }),
        makeFetchedMessage(5, { date: hoursAgo(1) }),
      ],
    };
    const env = setup(box);
    return { ...env, box };
  }

  /** Loads the two old messages as history, as a history job would. */
  function loadHistory(store: InMemoryMailStore, box: FakeMailbox) {
    store.upsertMessages(ACCOUNT_ID, INBOX, box.messages.slice(0, 2).map((m) => structuredClone(m)), { kept: "history" });
    store.setHistorySince(ACCOUNT_ID, INBOX, daysAgo(65));
  }

  const flagUids = (gateway: ScriptedImapGateway, from = 0) =>
    gateway.sessions.slice(from).flatMap((s) => s.calls.filter((c) => c.method === "fetchFlags").flatMap((c) => c.uids!));

  const idAt = (store: InMemoryMailStore, uid: number) =>
    store.localFolderIndex(ACCOUNT_ID, INBOX, EPOCH).find((e) => e.uid === uid)?.id;

  it("prepareMessage is exported and judges unsubscribe info and the dev class as sync does", async () => {
    const message = makeFetchedMessage(1, {
      unsubscribeHeaders: [{ key: "list-unsubscribe", value: "<https://example.org/u>" }],
    });
    const prepared = prepareMessage(message, { preset: "other", classifyDev: false, devHosts: new Set(), folderRole: "inbox" });
    expect(prepared.unsubscribe).not.toBeUndefined();
    expect(prepared).not.toHaveProperty("dev");
    expect(prepareMessage(makeFetchedMessage(2), { preset: "other", classifyDev: false, devHosts: new Set(), folderRole: "inbox" })).toEqual(makeFetchedMessage(2));
    expect(prepareMessage(makeFetchedMessage(3), { preset: "other", classifyDev: true, devHosts: new Set(), folderRole: "inbox" })).toHaveProperty("dev");
  });

  it("checks history rows only with historyCheck, then at most once a day", async () => {
    const { store, gateway, deps, box } = withHistory();
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    loadHistory(store, box);
    // An incremental round never fetches the flags of history rows.
    let from = gateway.sessions.length;
    expect((await syncAccount(deps, ACCOUNT_ID, OPTIONS)).status).toBe("ok");
    expect(flagUids(gateway, from).sort()).toEqual([3, 4, 5]);
    expect(store.historyState(ACCOUNT_ID, INBOX)!.historyCheckedAt).toBeNull();

    // A full round with historyCheck checks them; a message gone from the server leaves.
    box.messages = box.messages.filter((m) => m.uid !== 1);
    box.messages[0]!.seen = true;
    from = gateway.sessions.length;
    const outcome = await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, historyCheck: true });
    expect(outcome).toMatchObject({ status: "ok", removed: 1, newInbox: [], returning: [], inserted: [] });
    expect(flagUids(gateway, from).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(idAt(store, 1)).toBeUndefined();
    expect(store.getMessage(idAt(store, 2)!)!.isRead).toBe(true);
    expect(store.getMessage(idAt(store, 2)!)!.kept).toBe("history");
    expect(store.historyState(ACCOUNT_ID, INBOX)!.historyCheckedAt).toBe(NOW.toISOString());

    // Checked less than a day ago: not again.
    from = gateway.sessions.length;
    await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, historyCheck: true });
    expect(flagUids(gateway, from).sort()).toEqual([3, 4, 5]);
    const later = { ...deps, clock: new FixedClock(new Date(NOW.getTime() + DAY + 1)) };
    from = gateway.sessions.length;
    await syncAccount(later, ACCOUNT_ID, { ...OPTIONS, historyCheck: true });
    expect(flagUids(gateway, from)).toContain(2);
  });

  it("checks nothing outside the window when no history was loaded", async () => {
    const { store, gateway, deps } = withHistory();
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const from = gateway.sessions.length;
    await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, historyCheck: true });
    expect(flagUids(gateway, from).sort()).toEqual([3, 4, 5]);
    expect(store.historyState(ACCOUNT_ID, INBOX)!.historyCheckedAt).toBeNull();
  });

  it("clears kept on rows inside the window", async () => {
    const { store, deps, box } = withHistory();
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    // A server hit that turned out to be inside the window (the window grew).
    store.upsertMessages(ACCOUNT_ID, INBOX, [structuredClone(box.messages[1]!)], { kept: "search" });
    const id = idAt(store, 2)!;
    expect(store.getMessage(id)!.kept).toBe("search");
    await syncAccount(deps, ACCOUNT_ID, { ...OPTIONS, windowDays: 90 });
    expect(store.getMessage(id)!.kept).toBeNull();
  });

  it("a UIDVALIDITY reset keeps opened rows it finds, deletes the rest, and clears history_since", async () => {
    const { store, deps, box } = withHistory();
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    // uid 1 loaded and opened, uid 2 loaded as history, plus an opened row the server no longer has.
    store.upsertMessages(ACCOUNT_ID, INBOX, box.messages.slice(0, 2).map((m) => structuredClone(m)), { kept: "history" });
    store.upsertMessages(ACCOUNT_ID, INBOX, [makeFetchedMessage(9, { date: daysAgo(70), messageId: "<gone@example.org>" })], {
      kept: "history",
    });
    const opened = idAt(store, 1)!;
    const history = idAt(store, 2)!;
    const goneOpened = idAt(store, 9)!;
    store.promoteKept([opened, goneOpened]);
    store.setHistorySince(ACCOUNT_ID, INBOX, daysAgo(75));

    // The server renumbers the folder: same messages, new uids.
    box.uidValidity = 8;
    box.messages = box.messages.map((m, i) => ({ ...m, uid: 101 + i }));
    box.uidNext = 106;
    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome.status).toBe("ok");
    expect(store.getMessage(opened)).toMatchObject({ kept: "opened" });
    expect(idAt(store, 101)).toBe(opened);
    expect(store.getMessage(goneOpened)).toBeNull();
    expect(store.getMessage(history)).toBeNull();
    expect(store.historyState(ACCOUNT_ID, INBOX)!.historySince).toBeNull();
  });

  it("stores Gmail labels at sync and refreshes them in the flag pass", async () => {
    const box = mailbox(2);
    box.messages[0]!.gmLabels = ["\\Inbox", "Receipts"];
    box.messages[1]!.gmLabels = ["\\Inbox"];
    const { store, gateway, deps } = setup(box);
    gateway.gmail = true;
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const first = idAt(store, 1)!;
    expect(store.gmLabels([first]).get(first)).toEqual(["\\Inbox", "Receipts"]);
    box.messages[0]!.gmLabels = ["\\Inbox", "Travel"];
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    expect(store.gmLabels([first]).get(first)).toEqual(["\\Inbox", "Travel"]);
  });

  it("the fake store keeps a message's Gmail labels on every copy, as SQLite does", () => {
    const store = new InMemoryMailStore();
    const shared = { messageId: "every@example.org", gmMsgId: "1789000000000000301", size: 10 };
    store.upsertMessages(ACCOUNT_ID, INBOX, [makeFetchedMessage(1, shared)]);
    store.upsertMessages(ACCOUNT_ID, "[Gmail]/All Mail", [makeFetchedMessage(5, shared)]);
    store.setGmLabels(ACCOUNT_ID, INBOX, [{ uid: 1, labels: ["\\Inbox", "Receipts"] }]);
    store.setGmLabels(ACCOUNT_ID, "[Gmail]/All Mail", [{ uid: 5, labels: ["\\Inbox"] }]);
    const inboxCopy = idByUid(store, INBOX, 1);
    expect(store.gmLabels([inboxCopy]).get(inboxCopy)).toEqual(["\\Inbox"]);
  });

  it("stores no labels off Gmail", async () => {
    const box = mailbox(1);
    box.messages[0]!.gmLabels = ["Receipts"];
    const { store, deps } = setup(box);
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const id = idAt(store, 1)!;
    expect(store.gmLabels([id]).get(id)).toEqual([]);
  });
});

describe("slice 3i: sender check, crypto and receipt at sync", () => {
  const GMAIL = { preset: "gmail" as const, classifyDev: false, devHosts: new Set<string>() };
  const line = (key: string, value: string) => ({ key: key.toLowerCase(), value });
  /** Gmail's top block with one trusted Authentication-Results header, synthetic values. */
  const gmailHeaders = (results: string, fromValue: string) => [
    line("Received", "by 2002:a05:6000:1:b0:1 with SMTP id x; Mon, 16 Nov 2026 10:00:00 -0800"),
    line("X-Google-Smtp-Source", "AGHT+synthetic"),
    line("Authentication-Results", `mx.google.com;\r\n       ${results}`),
    line("From", fromValue),
  ];
  const DMARC_FAIL = "dkim=none; spf=fail smtp.mailfrom=bounce@example.com; dmarc=fail (p=REJECT) header.from=example.com";
  const githubCiFailed = {
    from: { name: "GitHub", address: "notifications@github.com" },
    subject: "[example-org/demo] Run failed: CI - main (abc1234)",
    bulkHeaders: { listId: "Example <demo.example-org.github.com>", listUnsubscribe: null, precedence: "list", autoSubmitted: null },
    devHeaders: [{ key: "x-github-reason", value: "ci_activity" }],
    unsubscribeHeaders: gmailHeaders(
      "dkim=none; spf=fail smtp.mailfrom=notifications@github.com; dmarc=fail (p=REJECT) header.from=github.com",
      "GitHub <notifications@github.com>",
    ),
  };

  it("judges the check, receipt and crypto only when the fetch read headers", () => {
    expect(prepareMessage(makeFetchedMessage(1), { ...GMAIL, folderRole: "inbox" })).toEqual(makeFetchedMessage(1));
    const prepared = prepareMessage(
      makeFetchedMessage(2, {
        from: { name: "Billing", address: "billing@example.com" },
        unsubscribeHeaders: gmailHeaders("dmarc=pass header.from=example.com", "Billing <billing@example.com>"),
        receiptRequested: true,
        contentType: "text/plain; charset=utf-8",
      }),
      { ...GMAIL, folderRole: "inbox" },
    );
    expect(prepared.senderCheck).toMatchObject({ state: "ok", basis: "results", authserv: "mx.google.com" });
    expect(prepared.receiptRequested).toBe(true);
    expect(prepared.crypto).toBeNull();
  });

  it("gives a failed row no dev class, even with classification on", () => {
    const prepared = prepareMessage(makeFetchedMessage(1, githubCiFailed), { ...GMAIL, classifyDev: true, folderRole: "inbox" });
    expect(prepared.senderCheck?.state).toBe("failed");
    expect(prepared.dev).toBeNull();
    // The same mail with a passing check is a dev notification.
    const passing = prepareMessage(
      makeFetchedMessage(2, {
        ...githubCiFailed,
        unsubscribeHeaders: gmailHeaders("dkim=pass header.i=@github.com; dmarc=pass header.from=github.com", "GitHub <notifications@github.com>"),
      }),
      { ...GMAIL, classifyDev: true, folderRole: "inbox" },
    );
    expect(passing.dev).toMatchObject({ source: "github", kind: "ci" });
  });

  it("drops an encrypted message's bodies before the store, by type or by inline armor", () => {
    const pgp = prepareMessage(
      makeFetchedMessage(1, {
        bodyText: "Invented readable text",
        bodyHtml: "<p>Invented</p>",
        contentType: 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
        unsubscribeHeaders: [],
      }),
      { ...GMAIL, folderRole: "inbox" },
    );
    expect(pgp.crypto).toEqual({ kind: "pgp_encrypted", opaque: false });
    expect(pgp.bodyText).toBeNull();
    expect(pgp.bodyHtml).toBeNull();
    const armor = prepareMessage(
      makeFetchedMessage(2, { bodyText: "\n  -----BEGIN PGP MESSAGE-----\nhQEMA0invented\n", contentType: null, unsubscribeHeaders: [] }),
      { ...GMAIL, folderRole: "inbox" },
    );
    expect(armor.crypto?.kind).toBe("pgp_encrypted");
    expect(armor.bodyText).toBeNull();
    // Signed mail keeps its text.
    const signed = prepareMessage(
      makeFetchedMessage(3, { contentType: 'multipart/signed; protocol="application/pgp-signature"', unsubscribeHeaders: [] }),
      { ...GMAIL, folderRole: "inbox" },
    );
    expect(signed.crypto?.kind).toBe("pgp_signed");
    expect(signed.bodyText).toBe("Invented body 3");
  });

  it("does not judge a Sent copy, but judges mail forged from an owner address into the Inbox", () => {
    const own = { name: "Owner", address: "owner@example.com" };
    const headers = gmailHeaders(DMARC_FAIL, "Owner <owner@example.com>");
    const sent = prepareMessage(makeFetchedMessage(1, { from: own, unsubscribeHeaders: headers }), { ...GMAIL, folderRole: "sent" });
    expect(sent.senderCheck).toMatchObject({ state: "unchecked", basis: "own" });
    const forged = prepareMessage(makeFetchedMessage(2, { from: own, unsubscribeHeaders: headers }), { ...GMAIL, folderRole: "inbox" });
    expect(forged.senderCheck).toMatchObject({ state: "failed", decidedBy: "dmarc" });
  });

  it("syncAccount passes each folder's role", async () => {
    const { store, gateway, deps } = setup(mailbox(0));
    store.saveAccount(makeStoredAccount({ id: ACCOUNT_ID, passwordSealed: PASSWORD, preset: "gmail" }));
    gateway.addFolder({ path: "Sent", name: "Sent", specialUse: "sent" }, { uidValidity: 9, uidNext: 1, messages: [] });
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const from = { name: "Billing", address: "billing@example.com" };
    const headers = gmailHeaders(DMARC_FAIL, "Billing <billing@example.com>");
    const inboxCopy = gateway.deliver({ from, unsubscribeHeaders: headers });
    const sentCopy = gateway.deliver({ from, unsubscribeHeaders: headers, messageId: "sent-1@example.org" }, "Sent");
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const [inboxRow] = store.senderCheckRows([idByUid(store, INBOX, inboxCopy.uid)]);
    const [sentRow] = store.senderCheckRows([idByUid(store, "Sent", sentCopy.uid)]);
    expect(JSON.parse(inboxRow!.senderCheckJson!)).toMatchObject({ state: "failed" });
    expect(JSON.parse(sentRow!.senderCheckJson!)).toMatchObject({ state: "unchecked", basis: "own" });
  });
});
