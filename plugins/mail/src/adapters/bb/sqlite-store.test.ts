import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../../core/threading.ts";
import type { MailStore } from "../../core/ports.ts";
import { makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { MIGRATIONS, createSqliteStore } from "./sqlite-store.ts";

const INBOX = "INBOX";
const EPOCH = "1970-01-01T00:00:00.000Z";

/** Mirrors bb.storage.migrate: every statement, in order, in one transaction. */
function migrate(db: Database.Database): void {
  db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function idOf(store: MailStore, uid: number, accountId = "acc_1"): string {
  const entry = store.localFolderIndex(accountId, INBOX, EPOCH).find((e) => e.uid === uid);
  if (!entry) throw new Error(`uid ${uid} not stored`);
  return entry.id;
}

let db: Database.Database;
let store: MailStore;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  store = createSqliteStore(db);
  store.saveAccount(makeStoredAccount());
});

describe("createSqliteStore", () => {
  it("migrations apply on an empty database", () => {
    const fresh = new Database(":memory:");
    migrate(fresh);
    const names = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "accounts",
        "sync_state",
        "messages",
        "attachments",
        "threads",
        "messages_fts",
        "messages_ai",
        "messages_ad",
        "messages_au",
      ]),
    );
    const fts = fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get() as {
      sql: string;
    };
    expect(fts.sql).toContain("tokenize='trigram'");
  });

  it("saveAccount updates in place without dropping the account's messages", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.saveAccount(makeStoredAccount({ displayName: "Renamed" }));
    expect(store.getAccount("acc_1")?.displayName).toBe("Renamed");
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH)).toHaveLength(1);
  });

  it("upserts and reads back a thread with headers oldest first", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(2, {
        date: "2026-11-12T10:00:00.000Z",
        subject: "Re: Invented plan",
        from: { name: "Second", address: "second@example.org" },
        inReplyTo: "msg-1@example.org",
        references: ["msg-1@example.org"],
        cc: [{ name: "Copy", address: "copy@example.org" }],
        attachments: [
          { partId: "2", filename: "plan.txt", mimeType: "text/plain", size: 12, isInline: false },
        ],
        bodyText: "  Second   reply\n\ntext ",
      }),
      makeFetchedMessage(1, { date: "2026-11-11T10:00:00.000Z", subject: "Invented plan", seen: true }),
    ]);
    const first = idOf(store, 1);
    const second = idOf(store, 2);
    expect(first).toMatch(/^m_[0-9a-f]{16}$/);
    store.assignThreads("acc_1", buildThreads(store.threadingInputs("acc_1")));

    const threadId = store.getMessage(first)!.threadId;
    expect(store.getMessage(second)!.threadId).toBe(threadId);
    const detail = store.getThread(threadId)!;
    expect(detail.messages.map((m) => m.id)).toEqual([first, second]);
    expect(detail.thread).toEqual({
      id: threadId,
      accountId: "acc_1",
      subject: "Invented plan",
      lastDate: "2026-11-12T10:00:00.000Z",
      messageCount: 2,
      unreadCount: 1,
      participants: [
        { name: "Sender", address: "sender@example.org" },
        { name: "Second", address: "second@example.org" },
      ],
      snippet: "Second reply text",
    });
    expect(detail.messages[1]).toEqual({
      id: second,
      accountId: "acc_1",
      threadId,
      date: "2026-11-12T10:00:00.000Z",
      from: { name: "Second", address: "second@example.org" },
      subject: "Re: Invented plan",
      snippet: "Second reply text",
      isRead: false,
      isFlagged: false,
      hasAttachments: true,
      to: [{ name: null, address: "owner@example.org" }],
      cc: [{ name: "Copy", address: "copy@example.org" }],
      attachments: [
        { partId: "2", filename: "plan.txt", mimeType: "text/plain", size: 12, isInline: false },
      ],
    });
    expect(store.threadingInputs("acc_1")).toContainEqual({
      id: second,
      messageId: "msg-2@example.org",
      inReplyTo: "msg-1@example.org",
      references: ["msg-1@example.org"],
      subject: "Re: Invented plan",
      date: "2026-11-12T10:00:00.000Z",
      gmThreadId: null,
    });
  });

  it("upserts a message with null message_id and null date", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(7, { messageId: null, date: null })]);
    const id = idOf(store, 7);
    expect(store.getMessage(id)?.date).toBeNull();
    expect(store.localFolderIndex("acc_1", INBOX, "2026-11-14T00:00:00.000Z")).toEqual([
      { uid: 7, id },
    ]);
    expect(store.threadingInputs("acc_1")[0]?.messageId).toBeNull();
  });

  it("caps html at 1,000,000 chars and flags it", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { bodyText: null, bodyHtml: "<p>Big</p>" + "x".repeat(1_000_000) }),
      makeFetchedMessage(2, { bodyHtml: "y".repeat(1_000_000) }),
    ]);
    const big = store.getBody(idOf(store, 1))!;
    expect(big).toMatchObject({ html: null, htmlTruncated: true, text: null });
    expect(store.getMessage(idOf(store, 1))!.snippet).toBe("Big " + "x".repeat(196));
    const fits = store.getBody(idOf(store, 2))!;
    expect(fits.html).toHaveLength(1_000_000);
    expect(fits.htmlTruncated).toBe(false);
  });

  it("snippet of pathological html is computed quickly", () => {
    for (const bodyHtml of ["<".repeat(200_000), "<script" + "x".repeat(200_000), "<b>" + "<i".repeat(100_000)]) {
      const started = performance.now();
      store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bodyText: null, bodyHtml })]);
      expect(performance.now() - started).toBeLessThan(200);
    }
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(2, {
        bodyText: null,
        bodyHtml: "<head><title>T</title></head><style>p{}</style><p>Visible &amp; kept</p><script>x()</script>",
      }),
    ]);
    expect(store.getMessage(idOf(store, 2))!.snippet).toBe("Visible & kept");
  });

  it("localFolderIndex excludes a dated row older than sinceIso", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { date: "2026-10-01T00:00:00.000Z" }),
      makeFetchedMessage(2, { date: "2026-11-10T00:00:00.000Z" }),
      makeFetchedMessage(3, { date: null }),
    ]);
    expect(
      store.localFolderIndex("acc_1", INBOX, "2026-11-01T00:00:00.000Z").map((e) => e.uid),
    ).toEqual([2, 3]);
  });

  it("returns attachments in fetch order", () => {
    const attachment = (partId: string) => ({
      partId,
      filename: `${partId}.txt`,
      mimeType: "text/plain",
      size: 1,
      isInline: false,
    });
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { attachments: [attachment("2"), attachment("10"), attachment("3")] }),
    ]);
    expect(store.getMessage(idOf(store, 1))!.attachments.map((a) => a.partId)).toEqual(["2", "10", "3"]);
  });

  it("a thread whose newest message is undated sorts by its latest dated message", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { date: "2026-11-09T00:00:00.000Z" }),
      makeFetchedMessage(2, { date: null }),
      makeFetchedMessage(3, { date: "2026-11-01T00:00:00.000Z" }),
      makeFetchedMessage(4, { date: null }),
    ]);
    const [m1, m2, m3, m4] = [1, 2, 3, 4].map((uid) => idOf(store, uid));
    store.assignThreads(
      "acc_1",
      new Map([
        [m1!, "t_mixed"],
        [m2!, "t_mixed"],
        [m3!, "t_older"],
        [m4!, "t_undated"],
      ]),
    );
    const { threads } = store.listThreads("acc_1", null, 10);
    expect(threads.map((t) => [t.id, t.lastDate])).toEqual([
      ["t_mixed", "2026-11-09T00:00:00.000Z"],
      ["t_older", "2026-11-01T00:00:00.000Z"],
      ["t_undated", null],
    ]);
  });

  it("folder reset reattaches a reappearing message under its old id", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: "keep@example.org" })]);
    const id = idOf(store, 1);
    store.beginFolderReset("acc_1", INBOX);
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH)).toEqual([]);
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(101, { messageId: "keep@example.org", subject: "Invented moved" }),
    ]);
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH)).toEqual([{ uid: 101, id }]);
    expect(store.getMessage(id)?.subject).toBe("Invented moved");
  });

  it("finishFolderReset deletes rows that did not reappear", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        attachments: [
          { partId: "2", filename: "a.txt", mimeType: "text/plain", size: 1, isInline: false },
        ],
      }),
      makeFetchedMessage(2),
    ]);
    const gone = idOf(store, 1);
    expect(store.finishFolderReset("acc_1", INBOX)).toBe(0);
    store.beginFolderReset("acc_1", INBOX);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(202, { messageId: "msg-2@example.org" })]);
    expect(store.pendingSeenUids("acc_1", INBOX)).toEqual([]);
    expect(store.finishFolderReset("acc_1", INBOX)).toBe(1);
    expect(store.getMessage(gone)).toBeNull();
    expect(count(db, "attachments")).toBe(0);
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH).map((e) => e.uid)).toEqual([202]);
  });

  it("applyFlags keeps a pending local read", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idOf(store, 1);
    expect(store.markOpened(id)).toEqual({ accountId: "acc_1" });
    expect(store.pendingSeenUids("acc_1", INBOX)).toEqual([1]);

    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(1);
    expect(store.getMessage(id)).toMatchObject({ isRead: true, isFlagged: true });
    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(0);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: false })]);
    expect(store.getMessage(id)?.isRead).toBe(true);

    store.clearSeenPending("acc_1", INBOX, [1]);
    expect(store.pendingSeenUids("acc_1", INBOX)).toEqual([]);
    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(1);
    expect(store.getMessage(id)?.isRead).toBe(false);
  });

  it("markOpened returns null for an unknown id", () => {
    expect(store.markOpened("m_0000000000000000")).toBeNull();
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true })]);
    expect(store.markOpened(idOf(store, 1))).toEqual({ accountId: "acc_1" });
    expect(store.pendingSeenUids("acc_1", INBOX)).toEqual([]);
  });

  it("markOpened keeps the thread's unread count current", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.assignThreads("acc_1", new Map());
    const id = idOf(store, 1);
    store.markOpened(id);
    expect(store.getThread(store.getMessage(id)!.threadId)?.thread.unreadCount).toBe(0);
  });

  it("deleteByUids removes the rows and their attachment metadata", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        attachments: [
          { partId: "2", filename: "a.txt", mimeType: "text/plain", size: 1, isInline: true },
        ],
      }),
      makeFetchedMessage(2),
    ]);
    expect(store.deleteByUids("acc_1", INBOX, [1, 99])).toBe(1);
    expect(count(db, "attachments")).toBe(0);
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH).map((e) => e.uid)).toEqual([2]);
  });

  it("deleteAccount removes messages, threads, attachments and fts rows", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        attachments: [
          { partId: "2", filename: "a.txt", mimeType: "text/plain", size: 1, isInline: false },
        ],
      }),
    ]);
    store.saveSyncState("acc_1", INBOX, { uidValidity: 1, lastUid: 1, syncedSince: EPOCH });
    store.assignThreads("acc_1", new Map());
    expect(count(db, "messages_fts_docsize")).toBe(1);

    store.deleteAccount("acc_1");
    for (const table of ["accounts", "sync_state", "messages", "attachments", "threads"]) {
      expect(count(db, table)).toBe(0);
    }
    expect(count(db, "messages_fts_docsize")).toBe(0);
    expect(store.search({ text: "Invented" }, null, 50)).toEqual([]);
  });

  it("listThreads pages with a cursor", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { date: "2026-11-01T00:00:00.000Z" }),
      makeFetchedMessage(2, { date: "2026-11-03T00:00:00.000Z" }),
      makeFetchedMessage(3, { date: "2026-11-03T00:00:00.000Z" }),
      makeFetchedMessage(4, { date: "2026-11-05T00:00:00.000Z" }),
      makeFetchedMessage(5, { date: null }),
    ]);
    store.assignThreads("acc_1", new Map());
    const threadOf = (uid: number) => `t_${idOf(store, uid)}`;
    const [tie1, tie2] = [threadOf(2), threadOf(3)].sort().reverse();
    const expected = [threadOf(4), tie1, tie2, threadOf(1), threadOf(5)];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = store.listThreads("acc_1", cursor, 2);
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
    expect(store.listThreads("acc_1", null, 5).nextCursor).toBeNull();
  });

  it("search finds a Cyrillic subject", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Отчёт за квартал" }),
      makeFetchedMessage(2, { subject: "Invented other" }),
    ]);
    const results = store.search({ text: "квартал" }, "acc_1", 50);
    expect(results.map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(results[0]).toMatchObject({ subject: "Отчёт за квартал", accountId: "acc_1" });
    expect(store.search({ text: "ОТЧЁТ" }, null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
  });

  it("search follows content updates and survives flag-only updates", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented alpha" })]);
    const id = idOf(store, 1);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented omega" })]);
    store.markOpened(id);
    store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: true, flagged: true }]);
    store.assignThreads("acc_1", new Map([[id, "t_other"]]));
    expect(store.search({ text: "alpha" }, null, 50)).toEqual([]);
    expect(store.search({ text: "omega" }, null, 50).map((r) => r.id)).toEqual([id]);
  });

  it("search ignores control characters in the text", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented hello" })]);
    expect(store.search({ text: "hel\u0000lo\u001f\u007f" }, null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(() => store.search({ text: "\u0000\u0001" }, null, 50)).not.toThrow();
  });

  it("subject: filter matches Cyrillic regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Отчёт за квартал" }),
      makeFetchedMessage(2, { subject: "Invented other" }),
    ]);
    expect(store.search({ text: "", subject: "отчёт" }, null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(store.search({ text: "", subject: "КВАРТАЛ" }, null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
  });

  it("from: filter matches Cyrillic regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { from: { name: "Иван Петров", address: "ivan@example.org" } }),
      makeFetchedMessage(2),
    ]);
    expect(store.search({ text: "", from: "иван" }, null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(store.search({ text: "", from: "ПЕТРОВ" }, null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
  });

  it("2-character Cyrillic query matches regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Юг и север" }),
      makeFetchedMessage(2, { subject: "Invented other" }),
    ]);
    expect(store.search({ text: "юг" }, null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(store.search({ text: "ЮГ" }, null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
  });

  it("search with a 2-character query falls back to LIKE", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Hi there" }),
      makeFetchedMessage(2, { subject: "Invented", bodyText: "hi in the body only" }),
      makeFetchedMessage(3, { subject: "Invented", from: { name: "Hilda", address: "h@example.org" } }),
    ]);
    const ids = store.search({ text: "hi" }, null, 50).map((r) => r.id);
    expect(ids.sort()).toEqual([idOf(store, 1), idOf(store, 3)].sort());
    expect(store.search({ text: "%" }, null, 50)).toEqual([]);
  });

  it("search escapes quotes in the query", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: 'Say "hello" now' })]);
    expect(store.search({ text: '"hello"' }, null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(() => store.search({ text: 'a"b OR c' }, null, 50)).not.toThrow();
    // "zzzz" occurs nowhere: a live OR operator would still match on "hello".
    expect(store.search({ text: "hello OR zzzz" }, null, 50)).toEqual([]);
  });

  it("search applies operators, orders newest first and honours the limit", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { date: "2026-11-01T00:00:00.000Z", subject: "Invented budget" }),
      makeFetchedMessage(2, { date: "2026-11-05T00:00:00.000Z", subject: "Invented budget", seen: true }),
      makeFetchedMessage(3, {
        date: "2026-11-09T00:00:00.000Z",
        subject: "Invented budget",
        from: { name: "Boss", address: "boss@example.org" },
      }),
    ]);
    const ids = (q: Parameters<MailStore["search"]>[0], limit = 50) =>
      store.search(q, "acc_1", limit).map((r) => r.id);
    expect(ids({ text: "budget" })).toEqual([idOf(store, 3), idOf(store, 2), idOf(store, 1)]);
    expect(ids({ text: "budget" }, 1)).toEqual([idOf(store, 3)]);
    expect(ids({ text: "", from: "boss" })).toEqual([idOf(store, 3)]);
    expect(ids({ text: "", subject: "budget", unread: true })).toEqual([idOf(store, 3), idOf(store, 1)]);
    expect(ids({ text: "", unread: false })).toEqual([idOf(store, 2)]);
    expect(ids({ text: "", after: "2026-11-05", before: "2026-11-09" })).toEqual([idOf(store, 2)]);
    expect(store.search({ text: "budget" }, "acc_other", 50)).toEqual([]);
  });

  it("unreadCount counts per account and overall", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2, { seen: true })]);
    store.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    expect(store.unreadCount("acc_1")).toBe(1);
    expect(store.unreadCount("acc_2")).toBe(2);
    expect(store.unreadCount(null)).toBe(3);
  });

  it("no column or returned object exposes passwordSealed except listAccounts/getAccount/findAccountByEmail", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (table !== "accounts") expect(columns.join(",")).not.toMatch(/password/i);
    }

    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.saveSyncState("acc_1", INBOX, { uidValidity: 1, lastUid: 1, syncedSince: EPOCH });
    store.assignThreads("acc_1", new Map());
    const id = idOf(store, 1);
    const threadId = store.getMessage(id)!.threadId;
    const outputs: unknown[] = [
      store.getSyncState("acc_1", INBOX),
      store.localFolderIndex("acc_1", INBOX, EPOCH),
      store.pendingSeenUids("acc_1", INBOX),
      store.markOpened(id),
      store.threadingInputs("acc_1"),
      store.listThreads("acc_1", null, 10),
      store.getThread(threadId),
      store.getMessage(id),
      store.getBody(id),
      store.search({ text: "Invented" }, null, 10),
      store.unreadCount(null),
    ];
    for (const output of outputs) {
      const json = JSON.stringify(output);
      expect(json).not.toContain("passwordSealed");
      expect(json).not.toContain("sealed-password");
    }
    expect(store.listAccounts()[0]?.passwordSealed).toBe("sealed-password");
    expect(store.getAccount("acc_1")?.passwordSealed).toBe("sealed-password");
    expect(store.findAccountByEmail("OWNER@example.org")?.passwordSealed).toBe("sealed-password");
  });

  it("records sync results and keeps sync state", () => {
    store.recordSyncResult("acc_1", { lastSyncAt: null, lastError: "Invented failure", authFailed: true });
    expect(store.getAccount("acc_1")).toMatchObject({
      lastSyncAt: null,
      lastError: "Invented failure",
      authFailed: true,
    });
    expect(store.getSyncState("acc_1", INBOX)).toBeNull();
    store.saveSyncState("acc_1", INBOX, { uidValidity: 9, lastUid: 4, syncedSince: EPOCH });
    store.saveSyncState("acc_1", INBOX, { uidValidity: 9, lastUid: 5, syncedSince: EPOCH });
    expect(store.getSyncState("acc_1", INBOX)).toEqual({ uidValidity: 9, lastUid: 5, syncedSince: EPOCH });
  });

  it("transaction rolls back on a throw", () => {
    expect(() =>
      store.transaction(() => {
        store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
        throw new Error("Invented abort");
      }),
    ).toThrow("Invented abort");
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH)).toEqual([]);
  });
});
