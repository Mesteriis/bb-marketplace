import { describe, expect, it } from "vitest";
import { parseQuery, syncAccount, type FolderSession, type ImapGateway, type SyncDeps } from "../../core/index.ts";
import {
  FixedClock,
  IdentityVault,
  InMemoryMailStore,
  RecordingNotifier,
  ScriptedImapGateway,
  imapError,
  makeFetchedMessage,
  makeStoredAccount,
  type FakeMailbox,
} from "../../core/testing/fakes.ts";
import { createServerJobs, type ServerJobsDeps } from "./server-search-jobs.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY = 86_400_000;
const ACCOUNT = "acc_1";
const EPOCH = "1970-01-01T00:00:00.000Z";
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
/** A query and a folder name that must never reach a log line. */
const CANARY_QUERY = "Zebracanary";
const CANARY_FOLDER = "Folder-canary-77";

const WRITES = ["markSeen", "setFlags", "moveMessages", "copyMessages", "appendMessage", "expungeOwn", "setLabels"] as const;

/**
 * The scripted gateway behind a guard that refuses any write and any
 * non-read-only open, recording each attempt.
 */
function readOnlyGuard(inner: ScriptedImapGateway, hooks: { beforeSearch?: (path: string) => Promise<void> | void } = {}) {
  const violations: string[] = [];
  const gateway: ImapGateway = {
    test: () => inner.test(),
    listFolders: (config) => inner.listFolders(config),
    watchFolder: (...args) => inner.watchFolder(...args),
    namedLikeSpecialUse: (name) => inner.namedLikeSpecialUse(name),
    createFolder: async () => {
      violations.push("createFolder");
      throw new Error("write");
    },
    renameFolder: async () => {
      violations.push("renameFolder");
      throw new Error("write");
    },
    folderStatus: async () => {
      violations.push("folderStatus");
      throw new Error("write");
    },
    deleteFolder: async () => {
      violations.push("deleteFolder");
      throw new Error("write");
    },
    setSubscribed: async () => {
      violations.push("setSubscribed");
      throw new Error("write");
    },
    async openFolder(config, path, options) {
      if (!options.readOnly) {
        violations.push(`open ${path} read-write`);
        throw new Error("write");
      }
      const session = await inner.openFolder(config, path, options);
      const guarded: FolderSession = { ...session };
      for (const method of WRITES) {
        (guarded as unknown as Record<string, unknown>)[method] = async () => {
          violations.push(method);
          throw new Error("write");
        };
      }
      guarded.searchServer = async (criteria) => {
        await hooks.beforeSearch?.(path);
        return session.searchServer(criteria);
      };
      return guarded;
    },
  };
  return { gateway, violations };
}

/** INBOX with three recent messages; old mail is added per test. */
function setup(options: { inbox?: FakeMailbox } = {}) {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: ACCOUNT }));
  const inbox: FakeMailbox = options.inbox ?? {
    uidValidity: 7,
    uidNext: 1,
    messages: [],
  };
  const scripted = new ScriptedImapGateway(inbox);
  const notifier = new RecordingNotifier();
  const syncDeps: SyncDeps = { store, gateway: scripted, vault: new IdentityVault(), clock: new FixedClock(NOW), notifier };
  return { store, scripted, notifier, syncDeps };
}

function deliverOld(scripted: ScriptedImapGateway, count: number, path = "INBOX", subject = "Invoice", fromDays = 45) {
  for (let i = 0; i < count; i++) {
    scripted.deliver({ date: daysAgo(fromDays + i * 0.01), subject: `${subject} ${i}`, messageId: `<old-${path}-${i}@example.org>` }, path);
  }
}

function jobsOf(env: ReturnType<typeof setup>, gateway: ImapGateway, extra: Partial<ServerJobsDeps> = {}) {
  const lines: string[] = [];
  let ids = 0;
  const jobs = createServerJobs({
    store: env.store,
    gateway,
    vault: new IdentityVault(),
    clock: new FixedClock(NOW),
    notifier: env.notifier,
    settings: () => ({ historyStepDays: 30 }),
    newId: () => `job_${++ids}`,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { jobs, lines };
}

const query = (text: string) => parseQuery(text, NOW);

const keptOf = (store: InMemoryMailStore, ids: readonly string[]) => ids.map((id) => store.getMessage(id)?.kept);

describe("server search jobs", () => {
  it("open only read-only sessions and never write", async () => {
    const env = setup();
    deliverOld(env.scripted, 5);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const { gateway, violations } = readOnlyGuard(env.scripted);
    const { jobs } = jobsOf(env, gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ state: "done", accounts: [{ fetched: 5, reason: null }] });
    expect(violations).toEqual([]);
    expect(env.scripted.sessions.every((s) => s.readOnly && s.closed)).toBe(true);
  });

  it("fetches 50 hits per batch, the rest with More, and keeps them as server hits", async () => {
    const env = setup();
    deliverOld(env.scripted, 130);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    let view = jobs.poll(jobId)!;
    expect(view).toMatchObject({ state: "done", moreAvailable: true, accounts: [{ fetched: 50, found: 130, searched: 1, total: 1 }] });
    expect(view.messageIds).toHaveLength(50);
    // The newest 50 first.
    const uids = view.messageIds.map((id) => env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH).find((e) => e.id === id)!.uid);
    expect(Math.min(...uids)).toBe(81);
    expect(new Set(keptOf(env.store, view.messageIds))).toEqual(new Set(["search"]));

    expect(jobs.more(jobId)).toBe("started");
    expect(jobs.more(jobId)).toBe("busy");
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ moreAvailable: true, accounts: [{ fetched: 100 }] });
    jobs.more(jobId);
    await jobs.settled(jobId);
    view = jobs.poll(jobId)!;
    expect(view).toMatchObject({ moreAvailable: false, accounts: [{ fetched: 130 }] });
    expect(jobs.more(jobId)).toBe("none");
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)).toHaveLength(130);
  });

  it("dedups against stored rows: by folder and uid, and by dedup key after the fetch", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Archive", specialUse: "archive" });
    // Recent Invoice mail is already in the window; an old one has a copy stored in Archive.
    env.scripted.deliver({ date: daysAgo(1), subject: "Invoice recent", messageId: "<recent@example.org>" });
    env.scripted.deliver({ date: daysAgo(50), subject: "Invoice copied", messageId: "<copied@example.org>", size: 900 });
    env.scripted.deliver({ date: daysAgo(50), subject: "Invoice copied", messageId: "<copied@example.org>", size: 900 }, "Archive");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    env.store.upsertMessages(ACCOUNT, "Archive", [makeFetchedMessage(1, { date: daysAgo(50), subject: "Invoice copied", messageId: "<copied@example.org>", size: 900 })], { kept: "history" });
    const archived = env.store.localFolderIndex(ACCOUNT, "Archive", EPOCH)[0]!.id;
    const before = env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH).length;
    const opened = env.scripted.sessions.length;
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    const view = jobs.poll(jobId)!;
    // The window row is not fetched again; the old INBOX copy matches the stored Archive copy.
    const fetched = env.scripted.sessions.slice(opened).flatMap((s) => s.calls.filter((c) => c.method === "fetchMessages").flatMap((c) => c.uids!));
    expect(fetched).toEqual([2]);
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)).toHaveLength(before);
    expect(view.messageIds).toEqual([archived]);
  });

  it("cancel stops between folders; what was fetched stays", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Archive", specialUse: "archive" });
    deliverOld(env.scripted, 3);
    deliverOld(env.scripted, 3, "Archive");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => (entered = resolve));
    const { gateway } = readOnlyGuard(env.scripted, {
      beforeSearch: async (path) => {
        if (path !== "Archive") return;
        entered();
        await gate;
      },
    });
    const { jobs } = jobsOf(env, gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await arrived;
    expect(jobs.poll(jobId)!.state).toBe("running");
    expect(jobs.cancel(jobId)).toBe(true);
    release();
    await jobs.settled(jobId);
    const view = jobs.poll(jobId)!;
    expect(view.state).toBe("cancelled");
    expect(view.accounts[0]).toMatchObject({ partial: true, reason: "cancelled", fetched: 3 });
    expect(env.store.localFolderIndex(ACCOUNT, "Archive", EPOCH)).toHaveLength(0);
    expect(view.messageIds).toHaveLength(3);
  });

  it("cancelAll stops every job (the plugin's shutdown)", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Archive", specialUse: "archive" });
    deliverOld(env.scripted, 2);
    deliverOld(env.scripted, 2, "Archive");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => (entered = resolve));
    const { gateway } = readOnlyGuard(env.scripted, {
      beforeSearch: async (path) => {
        if (path !== "Archive") return;
        entered();
        await gate;
      },
    });
    const { jobs } = jobsOf(env, gateway);
    const first = jobs.startSearch(query("Invoice"), [ACCOUNT]).jobId;
    const queued = jobs.startHistory(ACCOUNT, "INBOX");
    await arrived;
    jobs.cancelAll();
    release();
    await jobs.settled(first);
    expect(jobs.poll(first)!.state).toBe("cancelled");
    expect("jobId" in queued && jobs.poll(queued.jobId)!.state).toBe("cancelled");
  });

  it("the time budget ends an account's search as partial", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Archive", specialUse: "archive" });
    deliverOld(env.scripted, 2);
    deliverOld(env.scripted, 2, "Archive");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    let t = 0;
    const { gateway } = readOnlyGuard(env.scripted, {
      beforeSearch: () => {
        t += 61_000;
      },
    });
    const { jobs } = jobsOf(env, gateway, { now: () => t });
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ state: "done", accounts: [{ partial: true, reason: "time_budget", searched: 1, total: 2 }] });
  });

  it("reports a refused SEARCH as search_failed", async () => {
    const env = setup();
    deliverOld(env.scripted, 2);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    env.scripted.failNext("searchServer", imapError("SearchFailed"));
    const { jobs, lines } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ state: "failed", accounts: [{ reason: "search_failed", fetched: 0 }] });
    expect(lines.join("\n")).not.toContain("Invoice");
  });

  it("refuses a query the server cannot use before any connection", async () => {
    const env = setup();
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const opened = env.scripted.sessions.length;
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const { jobId, localOnly } = jobs.startSearch(query("list:example.org"), [ACCOUNT]);
    expect(localOnly).toEqual(["list"]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ accounts: [{ reason: "nothing_to_search" }] });
    // Only the one-time capability probe of the Inbox.
    expect(env.scripted.sessions.length - opened).toBeLessThanOrEqual(1);
  });

  it("never hides new mail: a uid above last_uid is skipped and the next round still reports it", async () => {
    const env = setup();
    deliverOld(env.scripted, 2);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const fresh = env.scripted.deliver({ date: NOW.toISOString(), subject: "Invoice new", messageId: "<new@example.org>" });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const { jobId } = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ accounts: [{ fetched: 2, skipped: 1 }] });
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH).some((e) => e.uid === fresh.uid)).toBe(false);
    const outcome = await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const newId = env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH).find((e) => e.uid === fresh.uid)!.id;
    expect(outcome).toMatchObject({ status: "ok", newInbox: [newId] });
    expect(env.store.getMessage(newId)!.kept).toBeNull();
  });

  it("skips a folder without sync_state and one whose UIDVALIDITY changed, with their reasons", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Archive", specialUse: "archive" });
    deliverOld(env.scripted, 2, "Archive");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    env.scripted.mailboxes.get("Archive")!.uidValidity = 99;
    let { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    let { jobId } = jobs.startSearch(query("Invoice in:archive"), [ACCOUNT]);
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ accounts: [{ fetched: 0, skipped: 2, reason: "changed" }] });

    // A folder listed but never synced.
    env.scripted.addFolder({ path: CANARY_FOLDER });
    deliverOld(env.scripted, 2, CANARY_FOLDER);
    env.store.saveFolders(ACCOUNT, await env.scripted.listFolders({ host: "", port: 0, user: "", password: "" }));
    ({ jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway));
    ({ jobId } = jobs.startSearch(query(`Invoice in:${CANARY_FOLDER}`), [ACCOUNT]));
    await jobs.settled(jobId);
    expect(jobs.poll(jobId)).toMatchObject({ accounts: [{ fetched: 0, skipped: 2, reason: "not_synced" }] });
    expect(env.store.localFolderIndex(ACCOUNT, CANARY_FOLDER, EPOCH)).toHaveLength(0);
  });

  it("runs at most one task per account and three in all", async () => {
    const env = setup();
    for (let i = 2; i <= 5; i++) env.store.saveAccount(makeStoredAccount({ id: `acc_${i}`, email: `a${i}@example.org` }));
    for (let i = 1; i <= 5; i++) {
      env.store.saveFolders(`acc_${i}`, [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true }]);
      env.store.saveSyncState(`acc_${i}`, "INBOX", { uidValidity: 7, lastUid: 0, syncedSince: daysAgo(30) });
    }
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const { gateway } = readOnlyGuard(env.scripted, {
      beforeSearch: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
      },
    });
    const { jobs } = jobsOf(env, gateway);
    const ids = ["acc_1", "acc_2", "acc_3", "acc_4", "acc_5"];
    const first = jobs.startSearch(query("Invoice"), ids).jobId;
    const second = jobs.startSearch(query("Receipt"), ["acc_1"]).jobId;
    const drain = async () => {
      while (jobs.poll(first)!.state === "running" || jobs.poll(second)!.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        releases.splice(0).forEach((release) => release());
      }
    };
    await drain();
    expect(peak).toBe(3);
  });

  it("names no query or folder in any log line", async () => {
    const env = setup();
    env.scripted.addFolder({ path: CANARY_FOLDER });
    deliverOld(env.scripted, 2, CANARY_FOLDER, CANARY_QUERY);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    env.scripted.failNext("searchServer", imapError("SearchFailed"));
    const { jobs, lines } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    for (const text of [CANARY_QUERY, `${CANARY_QUERY} in:${CANARY_FOLDER}`]) {
      const { jobId } = jobs.startSearch(query(text), [ACCOUNT]);
      await jobs.settled(jobId);
    }
    const history = jobs.startHistory(ACCOUNT, CANARY_FOLDER);
    if ("jobId" in history) await jobs.settled(history.jobId);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(CANARY_QUERY);
      expect(line.toLowerCase()).not.toContain("canary");
    }
  });
});

describe("history jobs", () => {
  it("loads the next step as history, moves history_since to the range start, and counts empty steps", async () => {
    const env = setup();
    deliverOld(env.scripted, 4, "INBOX", "Old", 40);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const syncedSince = env.store.getSyncState(ACCOUNT, "INBOX")!.syncedSince;
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const start = jobs.startHistory(ACCOUNT, "INBOX");
    if (!("jobId" in start)) throw new Error("refused");
    await jobs.settled(start.jobId);
    const view = jobs.poll(start.jobId)!;
    const rangeStart = new Date(Date.parse(syncedSince) - 30 * DAY).toISOString();
    expect(view).toMatchObject({ state: "done", historySince: rangeStart, emptySteps: 0, accounts: [{ fetched: 4 }] });
    expect(new Set(keptOf(env.store, view.messageIds))).toEqual(new Set(["history"]));
    expect(env.store.historyState(ACCOUNT, "INBOX")!.historySince).toBe(rangeStart);

    // Nothing older: three empty steps in a row, each moving history_since.
    for (let step = 1; step <= 3; step++) {
      const again = jobs.startHistory(ACCOUNT, "INBOX");
      if (!("jobId" in again)) throw new Error("refused");
      await jobs.settled(again.jobId);
      expect(jobs.poll(again.jobId)).toMatchObject({ emptySteps: step });
    }
    expect(env.store.historyState(ACCOUNT, "INBOX")!.historySince).toBe(new Date(Date.parse(syncedSince) - 120 * DAY).toISOString());
  });

  it("fetches at most 500 per step and runs the same range again until it is complete", async () => {
    const env = setup();
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    // 520 messages inside the next 30 days, delivered after the sync but numbered below last_uid.
    const box = env.scripted.mailbox;
    const state = env.store.getSyncState(ACCOUNT, "INBOX")!;
    for (let i = 0; i < 520; i++) {
      box.messages.push(makeFetchedMessage(1_000 + i, { date: daysAgo(55 - i * 0.04), messageId: `<h-${i}@example.org>` }));
    }
    env.store.saveSyncState(ACCOUNT, "INBOX", { ...state, lastUid: 5_000 });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const first = jobs.startHistory(ACCOUNT, "INBOX");
    if (!("jobId" in first)) throw new Error("refused");
    await jobs.settled(first.jobId);
    const view = jobs.poll(first.jobId)!;
    expect(view.accounts[0]!.fetched).toBe(500);
    // Not advanced: history_since never comes from a header date.
    expect(view).toMatchObject({ historySince: null, emptySteps: 0 });
    expect(env.store.historyState(ACCOUNT, "INBOX")!.historySince).toBeNull();
    const second = jobs.startHistory(ACCOUNT, "INBOX");
    if (!("jobId" in second)) throw new Error("refused");
    await jobs.settled(second.jobId);
    expect(jobs.poll(second.jobId)!.accounts[0]!.fetched).toBe(20);
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)).toHaveLength(520);
    expect(jobs.poll(second.jobId)!.historySince).toBe(new Date(Date.parse(state.syncedSince) - 30 * DAY).toISOString());
  });

  it("leaves no gap when uid order is not date order (newest dates on the lowest uids)", async () => {
    const env = setup();
    // 600 old messages 31 to 58 days old, the newest dates first (lowest uids), as in a folder filled by moves.
    for (let i = 0; i < 600; i++) env.scripted.deliver({ date: daysAgo(31 + i * 0.045), subject: `Old ${i}`, messageId: `<moved-${i}@example.org>` });
    env.scripted.deliver({ date: daysAgo(1), subject: "Recent", messageId: "<recent@example.org>" });
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    for (let step = 0; step < 3; step++) {
      const started = jobs.startHistory(ACCOUNT, "INBOX");
      if (!("jobId" in started)) throw new Error("refused");
      await jobs.settled(started.jobId);
    }
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)).toHaveLength(601);
  });

  it("a cancelled step does not move history_since and is not an empty step", async () => {
    const env = setup();
    deliverOld(env.scripted, 120, "INBOX", "Old", 40);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    let jobId = "";
    let fetches = 0;
    const guarded = readOnlyGuard(env.scripted).gateway;
    const gateway: ImapGateway = {
      ...guarded,
      async openFolder(config, path, options) {
        const session = await guarded.openFolder(config, path, options);
        return {
          ...session,
          fetchMessages: async (uids) => {
            if (++fetches === 2) jobs.cancel(jobId);
            return session.fetchMessages(uids);
          },
        };
      },
    };
    const { jobs } = jobsOf(env, gateway);
    const started = jobs.startHistory(ACCOUNT, "INBOX");
    if (!("jobId" in started)) throw new Error("refused");
    jobId = started.jobId;
    await jobs.settled(jobId);
    const view = jobs.poll(jobId)!;
    expect(view.accounts[0]).toMatchObject({ reason: "cancelled" });
    expect(view.accounts[0]!.fetched).toBeGreaterThan(0);
    expect(view.accounts[0]!.fetched).toBeLessThan(120);
    expect(view).toMatchObject({ historySince: null, emptySteps: 0 });
    expect(env.store.historyState(ACCOUNT, "INBOX")!.historySince).toBeNull();
  });

  it("turns a server hit the step covers into history and refuses an unsynced folder", async () => {
    const env = setup();
    deliverOld(env.scripted, 1, "INBOX", "Invoice", 40);
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const search = jobs.startSearch(query("Invoice"), [ACCOUNT]);
    await jobs.settled(search.jobId);
    const [hit] = jobs.poll(search.jobId)!.messageIds;
    expect(env.store.getMessage(hit!)!.kept).toBe("search");
    const history = jobs.startHistory(ACCOUNT, "INBOX");
    if (!("jobId" in history)) throw new Error("refused");
    await jobs.settled(history.jobId);
    expect(env.store.getMessage(hit!)!.kept).toBe("history");
    expect(env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)).toHaveLength(1);

    env.scripted.addFolder({ path: "Later" });
    env.store.saveFolders(ACCOUNT, await env.scripted.listFolders({ host: "", port: 0, user: "", password: "" }));
    expect(jobs.startHistory(ACCOUNT, "Later")).toEqual({ refused: "not_synced" });
    expect(jobs.startHistory(ACCOUNT, "Nowhere")).toEqual({ refused: "not_found" });
  });
});

describe("slice 3i: jobs judge rows with their folder's role", () => {
  it("a history step in Sent stores own checks, one in the Inbox judges the sender", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Sent", specialUse: "sent" });
    for (const path of ["INBOX", "Sent"]) {
      for (let i = 0; i < 2; i++) {
        env.scripted.deliver({ date: daysAgo(45 + i), subject: `Old ${i}`, messageId: `<old-${path}-${i}@example.org>`, unsubscribeHeaders: [] }, path);
      }
    }
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const basisOf = async (folder: string) => {
      const start = jobs.startHistory(ACCOUNT, folder);
      if (!("jobId" in start)) throw new Error("refused");
      await jobs.settled(start.jobId);
      const ids = jobs.poll(start.jobId)!.messageIds;
      expect(ids).toHaveLength(2);
      return new Set(env.store.senderCheckRows(ids).map((row) => JSON.parse(row.senderCheckJson!).basis));
    };
    expect(await basisOf("Sent")).toEqual(new Set(["own"]));
    // The preset trusts no authserv-id: the Inbox copies are judged, and read as "provider".
    expect(await basisOf("INBOX")).toEqual(new Set(["provider"]));
  });
});

describe("conversation jobs", () => {
  it("loads the rest of a conversation by its headers, at most 100 messages", async () => {
    const env = setup();
    env.scripted.addFolder({ path: "Sent", specialUse: "sent" });
    env.scripted.deliver({ date: daysAgo(1), subject: "Plan", messageId: "<root@example.org>" });
    for (let i = 0; i < 120; i++) {
      env.scripted.deliver({ date: daysAgo(60 + i * 0.01), subject: "Re: Plan", messageId: `<reply-${i}@example.org>`, references: ["<root@example.org>"] }, "Sent");
    }
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const rootId = env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)[0]!.id;
    const threadId = env.store.getMessage(rootId)!.threadId;
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const start = jobs.startConversation(threadId);
    if (!("jobId" in start)) throw new Error("refused");
    await jobs.settled(start.jobId);
    const view = jobs.poll(start.jobId)!;
    expect(view.accounts[0]!.fetched).toBe(100);
    // Kept as server hits: outside [history_since, window) they expire like them unless opened.
    expect(new Set(keptOf(env.store, view.messageIds))).toEqual(new Set(["search"]));
    expect(env.store.expireSearchRows(new Date(Date.now() + 100 * DAY).toISOString(), 30).removed).toBe(100);
    expect(env.store.getMessage(rootId)).not.toBeNull();
    const searched = env.scripted.sessions.flatMap((s) => s.calls.filter((c) => c.method === "searchServer").map((c) => c.criteria!));
    expect(searched[0]!.headers).toEqual([
      { name: "References", value: "<root@example.org>" },
      { name: "Message-ID", value: "<root@example.org>" },
    ]);
    expect(jobs.startConversation("t_unknown")).toEqual({ refused: "not_found" });
  });

  it("uses the Gmail thread id on All Mail", async () => {
    const env = setup();
    env.scripted.gmail = true;
    env.scripted.addFolder({ path: "[Gmail]/All Mail", specialUse: "all" });
    env.scripted.deliver({ date: daysAgo(1), subject: "Plan", messageId: "<g-root@example.org>", gmThreadId: "1789000000000000555", gmMsgId: "1789000000000000901" });
    env.scripted.deliver({ date: daysAgo(1), subject: "Plan", messageId: "<g-root@example.org>", gmThreadId: "1789000000000000555", gmMsgId: "1789000000000000901" }, "[Gmail]/All Mail");
    env.scripted.deliver({ date: daysAgo(70), subject: "Re: Plan", messageId: "<g-old@example.org>", gmThreadId: "1789000000000000555", gmMsgId: "1789000000000000902" }, "[Gmail]/All Mail");
    await syncAccount(env.syncDeps, ACCOUNT, { windowDays: 30, batchSize: 50 });
    const rootId = env.store.localFolderIndex(ACCOUNT, "INBOX", EPOCH)[0]!.id;
    const { jobs } = jobsOf(env, readOnlyGuard(env.scripted).gateway);
    const start = jobs.startConversation(env.store.getMessage(rootId)!.threadId);
    if (!("jobId" in start)) throw new Error("refused");
    await jobs.settled(start.jobId);
    expect(jobs.poll(start.jobId)!.accounts[0]!.fetched).toBe(1);
    const searched = env.scripted.sessions.flatMap((s) => s.calls.filter((c) => c.method === "searchServer").map((c) => [s.path, c.criteria]));
    expect(searched).toEqual([["[Gmail]/All Mail", { threadId: "1789000000000000555" }]]);
  });
});
