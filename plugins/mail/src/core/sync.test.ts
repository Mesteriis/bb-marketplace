import { describe, expect, it, vi } from "vitest";
import { ImapAuthError } from "./ports.ts";
import { INBOX, syncAccount, type SyncDeps } from "./sync.ts";
import {
  FixedClock,
  IdentityVault,
  InMemoryMailStore,
  makeFetchedMessage,
  makeStoredAccount,
  RecordingNotifier,
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
    });
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
    gateway.failNext("markSeen", new Error("connection reset"));
    // Meanwhile on the server: message 1 read, message 2 flagged.
    gateway.mailbox.messages[0]!.seen = true;
    gateway.mailbox.messages[1]!.flagged = true;

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toMatchObject({ status: "ok", flagsChanged: 2, pushedSeen: 0 });
    expect(store.getMessage(idOf(1))).toMatchObject({ isRead: true, isFlagged: false });
    expect(store.getMessage(idOf(2))).toMatchObject({ isRead: false, isFlagged: true });
    expect(store.getMessage(idOf(3))).toMatchObject({ isRead: true });
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([3]);
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
    expect(push!.calls).toEqual([{ method: "status" }, { method: "markSeen", uids: [2] }]);
    expect(push!.closed).toBe(true);
    expect(main!.readOnly).toBe(true);
    expect(main!.calls.some((c) => c.method === "markSeen")).toBe(false);
    expect(gateway.mailbox.messages[1]!.seen).toBe(true);
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([]);
    expect(gateway.sessions).toHaveLength(3);
  });

  it("failed markSeen keeps the pending flag", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    store.markOpened(ids.find((e) => e.uid === 1)!.id);
    gateway.failNext("markSeen", new Error("connection reset"));

    const failedPush = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(failedPush).toMatchObject({ status: "ok", pushedSeen: 0 });
    expect(gateway.sessions[1]!.closed).toBe(true);
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([1]);
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();

    const retried = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(retried).toMatchObject({ status: "ok", pushedSeen: 1 });
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([]);
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

  it("network error records lastError without authFailed", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const network = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:993"), {
      code: "ECONNREFUSED",
    });
    gateway.failOpen(network);

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
    gateway.failOpen(null);
    expect(await syncAccount(deps, ACCOUNT_ID, OPTIONS)).toMatchObject({ status: "ok" });
    expect(store.getAccount(ACCOUNT_ID)?.lastError).toBeNull();
  });

  it("error text never contains the password", async () => {
    const leakyErrors = [
      new ImapAuthError(`LOGIN owner@example.org ${PASSWORD} rejected`),
      Object.assign(new Error(`AUTHENTICATE failed for ${PASSWORD}`), { code: "EAUTH" }),
      new Error(`socket closed while sending ${PASSWORD}`),
    ];
    for (const leaky of leakyErrors) {
      // A naive String(error) would leak it.
      expect(String(leaky)).toContain(PASSWORD);
      const { store, gateway, deps } = setup(mailbox(1));
      gateway.failOpen(leaky);

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
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([3]);
    expect(store.getMessage(openedId)).toMatchObject({ isRead: true });

    const next = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(next).toMatchObject({ status: "ok", pushedSeen: 1 });
    expect(gateway.sessions[3]!.calls).toContainEqual({ method: "markSeen", uids: [3] });
    expect(gateway.mailbox.messages.map((m) => [m.uid, m.seen])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([]);
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

  it("auth failure during the pending push does not log in twice", async () => {
    const { store, gateway, deps } = setup(mailbox(2));
    await syncAccount(deps, ACCOUNT_ID, OPTIONS);
    const ids = store.localFolderIndex(ACCOUNT_ID, INBOX, "1970-01-01T00:00:00.000Z");
    store.markOpened(ids.find((e) => e.uid === 1)!.id);
    gateway.failOpen(new ImapAuthError());
    expect(await gateway.test()).toMatchObject({ ok: false, authFailed: true });
    const openFolder = vi.spyOn(gateway, "openFolder");

    const outcome = await syncAccount(deps, ACCOUNT_ID, OPTIONS);

    expect(outcome).toEqual({ status: "error", error: "Authentication failed", authFailed: true });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder.mock.calls[0]!.slice(1)).toEqual([INBOX, { readOnly: false }]);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: true });
    expect(store.pendingSeenUids(ACCOUNT_ID, INBOX)).toEqual([1]);
  });
});
