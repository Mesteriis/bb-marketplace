import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKFILL_BUDGET,
  LIST_HEADER_FIELDS,
  UNSUBSCRIBE_BACKFILL_BUDGET,
  backfillBulk,
  backfillUnsubscribe,
  bulkHeadersOf,
  cursorKey,
  unsubscribeCursorKey,
  type BackfillCursors,
} from "./bulk-backfill.ts";
import { UNSUBSCRIBE_HEADER_FIELDS, type HeaderLine } from "./unsubscribe.ts";
import { NO_BULK_HEADERS, classifyBulk } from "./contacts.ts";
import { ImapAuthError, type SyncState } from "./index.ts";
import {
  IdentityVault,
  InMemoryMailStore,
  ScriptedImapGateway,
  imapError,
  makeFetchedMessage,
  makeStoredAccount,
} from "./testing/fakes.ts";

const enc = new TextEncoder();
const block = (...lines: string[]) => enc.encode([...lines, "", ""].join("\r\n"));

describe("bulkHeadersOf", () => {
  it.each<[string, Uint8Array, Partial<typeof NO_BULK_HEADERS>]>([
    ["an empty block", enc.encode("\r\n"), {}],
    ["no bytes at all", new Uint8Array(), {}],
    ["one field", block("List-Id: Invented <news.example.net>"), { listId: "Invented <news.example.net>" }],
    [
      "every field, any case",
      block("list-id: <a.example.net>", "LIST-UNSUBSCRIBE: <mailto:u@example.net>", "precedence: bulk", "Auto-submitted: auto-generated"),
      {
        listId: "<a.example.net>",
        listUnsubscribe: "<mailto:u@example.net>",
        precedence: "bulk",
        autoSubmitted: "auto-generated",
      },
    ],
    [
      "a folded value is unfolded",
      block("List-Unsubscribe: <mailto:u@example.net>,", "\t<https://example.net/u>"),
      { listUnsubscribe: "<mailto:u@example.net>, <https://example.net/u>" },
    ],
    ["the first of several values wins", block("Precedence: list", "Precedence: first-class"), { precedence: "list" }],
    ["LF line ends", enc.encode("Auto-Submitted: no\n\n"), { autoSubmitted: "no" }],
    ["a field not asked for is ignored", block("Subject: Invented"), {}],
    ["an empty value stays empty", block("Precedence:"), { precedence: "" }],
  ])("%s", (_name, raw, expected) => {
    expect(bulkHeadersOf(raw)).toEqual({ ...NO_BULK_HEADERS, ...expected });
  });

  it("feeds the same classifier sync uses", () => {
    expect(classifyBulk(bulkHeadersOf(block("List-Id: <a.example.net>")), "anna@example.net")).toBe(true);
    expect(classifyBulk(bulkHeadersOf(block("Auto-Submitted: no")), "anna@example.net")).toBe(false);
    expect(classifyBulk(bulkHeadersOf(block("Precedence:")), "anna@example.net")).toBe(false);
    expect(classifyBulk(bulkHeadersOf(enc.encode("\r\n")), "no-reply@example.net")).toBe(true);
  });

  it("asks for exactly the four bulk fields", () => {
    expect(LIST_HEADER_FIELDS).toEqual(["List-Id", "List-Unsubscribe", "Precedence", "Auto-Submitted"]);
  });
});

const LIST = { ...NO_BULK_HEADERS, listId: "<news.example.net>" };

describe("backfillBulk", () => {
  let store: InMemoryMailStore;
  let gateway: ScriptedImapGateway;
  let cursors: BackfillCursors;
  const deps = () => ({ store, gateway, vault: new IdentityVault() });
  const state: SyncState = { uidValidity: 1, lastUid: 0, syncedSince: "2026-10-01T00:00:00.000Z" };

  /** A message on the server with its list headers, stored as before the mark existed (NULL). */
  function oldMessage(path: string, bulkHeaders = NO_BULK_HEADERS, from = "anna@example.net") {
    const message = gateway.deliver({ bulkHeaders, from: { name: null, address: from } }, path);
    const { bulkHeaders: _dropped, ...withoutHeaders } = message;
    store.upsertMessages("acc_1", path, [withoutHeaders]);
    return message.uid;
  }
  const marks = (path = "INBOX") => store.bulkMarks("acc_1", path);

  beforeEach(() => {
    store = new InMemoryMailStore();
    gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
    cursors = new Map();
    store.saveAccount(makeStoredAccount());
    store.saveFolders("acc_1", [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true }]);
    store.saveSyncState("acc_1", "INBOX", state);
  });

  it("fills NULL marks from the list headers, read-only, through fetchListHeaders only", async () => {
    const list = oldMessage("INBOX", LIST);
    const person = oldMessage("INBOX");
    const robot = oldMessage("INBOX", NO_BULK_HEADERS, "no-reply@example.net");

    const outcome = await backfillBulk(deps(), "acc_1", { cursors });

    expect(outcome).toEqual({ marked: 3, unanswered: 0, folders: 1, skipped: 0, failed: 0 });
    expect(marks()).toEqual(new Map([[list, true], [person, false], [robot, true]]));
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.sessions[0]!.readOnly).toBe(true);
    expect(gateway.sessions[0]!.closed).toBe(true);
    expect(gateway.sessions[0]!.calls.map((c) => c.method)).toEqual(["status", "fetchListHeaders"]);
  });

  it("never overwrites a mark sync set, and skips folders without NULL rows", async () => {
    gateway.addFolder({ path: "Archive" });
    store.saveFolders("acc_1", [
      { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
      { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true },
    ]);
    store.saveSyncState("acc_1", "Archive", state);
    // Synced with headers: the stored mark is personal although the server now says list.
    const synced = gateway.deliver({ bulkHeaders: NO_BULK_HEADERS }, "Archive");
    store.upsertMessages("acc_1", "Archive", [synced]);
    gateway.mailboxes.get("Archive")!.messages[0]!.bulkHeaders = LIST;
    const old = oldMessage("INBOX", LIST);

    await backfillBulk(deps(), "acc_1", { cursors });

    expect(marks("Archive")).toEqual(new Map([[synced.uid, false]]));
    expect(marks()).toEqual(new Map([[old, true]]));
    expect(gateway.sessions.map((s) => s.path)).toEqual(["INBOX"]);
  });

  it("fetches in batches and stops at the budget; later rounds finish the rest, newest first", async () => {
    const uids = Array.from({ length: 7 }, () => oldMessage("INBOX"));

    const first = await backfillBulk(deps(), "acc_1", { cursors, budget: 5, batchSize: 2 });
    expect(first.marked).toBe(5);
    const fetched = gateway.sessions[0]!.calls.filter((c) => c.method === "fetchListHeaders").map((c) => c.uids);
    expect(fetched).toEqual([[7, 6], [5, 4], [3]]);
    expect([...marks().entries()].filter(([, bulk]) => bulk === null).map(([uid]) => uid)).toEqual([1, 2]);

    const second = await backfillBulk(deps(), "acc_1", { cursors, budget: 5, batchSize: 2 });
    expect(second.marked).toBe(2);
    expect([...marks().values()].every((bulk) => bulk === false)).toBe(true);
    expect(uids).toHaveLength(7);

    const third = await backfillBulk(deps(), "acc_1", { cursors, budget: 5, batchSize: 2 });
    expect(third).toEqual({ marked: 0, unanswered: 0, folders: 0, skipped: 0, failed: 0 });
    expect(gateway.sessions).toHaveLength(2);
  });

  it("the default budget is BACKFILL_BUDGET rows a round", async () => {
    for (let i = 0; i < BACKFILL_BUDGET + 3; i++) oldMessage("INBOX");
    expect((await backfillBulk(deps(), "acc_1", { cursors })).marked).toBe(BACKFILL_BUDGET);
  });

  it("a uid gone from the server stays NULL and is not asked again in this process", async () => {
    const gone = oldMessage("INBOX");
    const kept = oldMessage("INBOX");
    gateway.mailbox.messages = gateway.mailbox.messages.filter((m) => m.uid !== gone);

    const first = await backfillBulk(deps(), "acc_1", { cursors });
    expect(first).toMatchObject({ marked: 1, unanswered: 1 });
    expect(marks()).toEqual(new Map([[gone, null], [kept, false]]));

    const second = await backfillBulk(deps(), "acc_1", { cursors });
    expect(second).toMatchObject({ marked: 0, unanswered: 0, folders: 0 });
    expect(gateway.sessions).toHaveLength(1);
  });

  it("a changed UIDVALIDITY leaves the rows NULL and fetches nothing", async () => {
    oldMessage("INBOX", LIST);
    gateway.mailbox.uidValidity = 2;

    const outcome = await backfillBulk(deps(), "acc_1", { cursors });

    expect(outcome).toEqual({ marked: 0, unanswered: 0, folders: 0, skipped: 1, failed: 0 });
    expect([...marks().values()]).toEqual([null]);
    expect(gateway.sessions[0]!.calls.map((c) => c.method)).toEqual(["status"]);
    expect(gateway.sessions[0]!.closed).toBe(true);
  });

  it("a folder never synced is left alone", async () => {
    const fresh = new InMemoryMailStore();
    fresh.saveAccount(makeStoredAccount());
    fresh.saveFolders("acc_1", [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true }]);
    fresh.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(1)]);
    const outcome = await backfillBulk({ store: fresh, gateway, vault: new IdentityVault() }, "acc_1", { cursors });
    expect(outcome.folders).toBe(0);
    expect(gateway.sessions).toHaveLength(0);
  });

  it("stops when aborted, between batches", async () => {
    for (let i = 0; i < 6; i++) oldMessage("INBOX");
    const controller = new AbortController();
    const session = gateway.openFolder.bind(gateway);
    gateway.openFolder = async (...args) => {
      const opened = await session(...args);
      const fetch = opened.fetchListHeaders.bind(opened);
      opened.fetchListHeaders = async (uids) => {
        const found = await fetch(uids);
        controller.abort();
        return found;
      };
      return opened;
    };

    const outcome = await backfillBulk(deps(), "acc_1", { cursors, batchSize: 2, signal: controller.signal });

    expect(outcome.marked).toBe(2);
    expect(gateway.sessions[0]!.closed).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    expect(await backfillBulk(deps(), "acc_1", { cursors, signal: aborted.signal })).toMatchObject({ marked: 0, folders: 0 });
    expect(gateway.sessions).toHaveLength(1);
  });

  it("a failing folder is counted and the next one still runs; a rejected login stops the account", async () => {
    gateway.addFolder({ path: "Archive" });
    store.saveFolders("acc_1", [
      { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
      { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true },
    ]);
    store.saveSyncState("acc_1", "Archive", state);
    oldMessage("INBOX");
    const archived = oldMessage("Archive", LIST);
    gateway.failNext("fetchListHeaders", imapError("Unknown"), "INBOX");

    const outcome = await backfillBulk(deps(), "acc_1", { cursors });
    expect(outcome).toMatchObject({ marked: 1, failed: 1, folders: 2 });
    expect(marks("Archive")).toEqual(new Map([[archived, true]]));

    gateway.failOpen(new ImapAuthError());
    const stopped = await backfillBulk(deps(), "acc_1", { cursors: new Map() });
    expect(stopped).toMatchObject({ marked: 0, failed: 1 });
  });

  it("does nothing for an unknown or locked account, or one whose password does not open", async () => {
    oldMessage("INBOX");
    expect((await backfillBulk(deps(), "acc_missing", { cursors })).folders).toBe(0);
    store.saveAccount(makeStoredAccount({ authFailed: true }));
    expect((await backfillBulk(deps(), "acc_1", { cursors })).folders).toBe(0);
    store.saveAccount(makeStoredAccount());
    const broken = { seal: (p: string) => p, open: () => { throw new Error("no key"); } };
    expect((await backfillBulk({ store, gateway, vault: broken }, "acc_1", { cursors })).folders).toBe(0);
    expect(gateway.sessions).toHaveLength(0);
  });

  it("never throws, even when the store does", async () => {
    oldMessage("INBOX");
    store.bulkUnknown = () => {
      throw new Error("database is locked");
    };
    await expect(backfillBulk(deps(), "acc_1", { cursors })).resolves.toMatchObject({ marked: 0, failed: 1 });
  });
});

describe("backfillUnsubscribe", () => {
  let store: InMemoryMailStore;
  let gateway: ScriptedImapGateway;
  let cursors: BackfillCursors;
  const deps = () => ({ store, gateway, vault: new IdentityVault() });
  const state: SyncState = { uidValidity: 1, lastUid: 0, syncedSince: "2026-10-01T00:00:00.000Z" };
  const line = (key: string, value: string): HeaderLine => ({ key, value });
  const LIST_LINES = [
    line("From", "News <news@example.com>"),
    line("List-Id", "Weekly News <weekly.example.com>"),
    line("List-Unsubscribe", "<mailto:leave@example.com?subject=stop>"),
  ];

  /** A bulk message on the server with list headers, stored without unsubscribe info (as before element 8). */
  function oldBulk(path: string, unsubscribeHeaders: HeaderLine[] = LIST_LINES) {
    const message = gateway.deliver(
      { bulkHeaders: LIST, from: { name: "News", address: "news@example.com" }, unsubscribeHeaders },
      path,
    );
    const { unsubscribeHeaders: _dropped, ...withoutHeaders } = message;
    store.upsertMessages("acc_1", path, [withoutHeaders]);
    return message.uid;
  }
  const infoOf = (path: string, uid: number) => {
    const id = store.localFolderIndex("acc_1", path, "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
    return store.getUnsubscribeInfo(id);
  };

  beforeEach(() => {
    store = new InMemoryMailStore();
    gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
    cursors = new Map();
    store.saveAccount(makeStoredAccount());
    gateway.addFolder({ path: "Archive" });
    store.saveFolders("acc_1", [
      { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
      { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true },
    ]);
    store.saveSyncState("acc_1", "INBOX", state);
    store.saveSyncState("acc_1", "Archive", state);
  });

  it("fills Inbox bulk rows from exactly the unsubscribe fields, read-only, and never other folders", async () => {
    const inbox = oldBulk("INBOX");
    const archived = oldBulk("Archive");

    const outcome = await backfillUnsubscribe(deps(), "acc_1", { cursors });

    expect(outcome).toEqual({ marked: 1, unanswered: 0, folders: 1, skipped: 0, failed: 0 });
    expect(infoOf("INBOX", inbox)).toMatchObject({
      listKey: "id:weekly.example.com",
      listName: "Weekly News",
      mailto: { address: "leave@example.com", subject: "stop" },
      trust: "untrusted_provider",
    });
    expect(infoOf("Archive", archived)).toBeNull();
    expect(gateway.sessions.map((s) => [s.path, s.readOnly])).toEqual([["INBOX", true]]);
    const call = gateway.sessions[0]!.calls.find((c) => c.method === "fetchHeaderFields")!;
    expect(call.fields).toEqual([...UNSUBSCRIBE_HEADER_FIELDS]);
    expect(gateway.sessions[0]!.calls.map((c) => c.method)).toEqual(["status", "fetchHeaderFields"]);
  });

  it("takes personal rows never, and rows whose info is known never", async () => {
    const personal = gateway.deliver({ bulkHeaders: NO_BULK_HEADERS, unsubscribeHeaders: LIST_LINES });
    const { unsubscribeHeaders: _p, ...personalStored } = personal;
    store.upsertMessages("acc_1", "INBOX", [personalStored]);
    const known = gateway.deliver({ bulkHeaders: LIST, unsubscribeHeaders: LIST_LINES });
    store.upsertMessages("acc_1", "INBOX", [
      {
        ...known,
        unsubscribe: {
          listKey: "kept.example.com",
          listName: null,
          https: null,
          oneClick: false,
          mailto: null,
          trust: "no_dkim",
        },
      },
    ]);

    const outcome = await backfillUnsubscribe(deps(), "acc_1", { cursors });

    expect(outcome.folders).toBe(0);
    expect(gateway.sessions).toHaveLength(0);
    expect(infoOf("INBOX", known.uid)).toMatchObject({ listKey: "kept.example.com" });
    expect(infoOf("INBOX", personal.uid)).toBeNull();
  });

  it("goes newest first within its budget, with its own cursor beside the bulk pass's", async () => {
    const uids = Array.from({ length: 5 }, () => oldBulk("INBOX"));
    expect(UNSUBSCRIBE_BACKFILL_BUDGET).toBe(200);

    const first = await backfillUnsubscribe(deps(), "acc_1", { cursors, budget: 3, batchSize: 2 });
    expect(first.marked).toBe(3);
    const fetched = gateway.sessions[0]!.calls.filter((c) => c.method === "fetchHeaderFields").map((c) => c.uids);
    expect(fetched).toEqual([[5, 4], [3]]);
    expect(cursors.get(unsubscribeCursorKey("acc_1", "INBOX"))).toEqual({ uidValidity: 1, belowUid: 3 });
    expect(cursors.has(cursorKey("acc_1", "INBOX"))).toBe(false);

    const second = await backfillUnsubscribe(deps(), "acc_1", { cursors, budget: 3, batchSize: 2 });
    expect(second.marked).toBe(2);
    expect(uids.every((uid) => infoOf("INBOX", uid) !== null)).toBe(true);
  });

  it("a message without List-Unsubscribe stays NULL and is not asked again", async () => {
    const bare = oldBulk("INBOX", [line("From", "News <news@example.com>")]);

    const first = await backfillUnsubscribe(deps(), "acc_1", { cursors });
    expect(first).toMatchObject({ marked: 0, unanswered: 0, folders: 1 });
    expect(infoOf("INBOX", bare)).toBeNull();

    await backfillUnsubscribe(deps(), "acc_1", { cursors });
    expect(gateway.sessions).toHaveLength(1);
  });

  it("skips a folder whose UIDVALIDITY changed and fills only while the stored one matches", async () => {
    const uid = oldBulk("INBOX");
    gateway.mailboxes.get("INBOX")!.uidValidity = 2;

    const outcome = await backfillUnsubscribe(deps(), "acc_1", { cursors });

    expect(outcome).toMatchObject({ marked: 0, skipped: 1, folders: 0 });
    expect(infoOf("INBOX", uid)).toBeNull();
    expect(gateway.sessions[0]!.calls.map((c) => c.method)).toEqual(["status"]);
    expect(store.fillUnsubscribe("acc_1", "INBOX", 2, [{ uid, info: null }])).toBe(0);
  });
});
