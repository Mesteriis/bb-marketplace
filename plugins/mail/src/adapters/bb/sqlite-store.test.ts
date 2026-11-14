import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../../core/threading.ts";
import type { RemoteFolder } from "../../core/model.ts";
import type { MailStore } from "../../core/ports.ts";
import {
  InMemoryMailStore,
  makeFetchedMessage,
  makeStoredAccount,
} from "../../core/testing/fakes.ts";
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
      folder: "INBOX",
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

  it("snippet decodes entities and drops preheader padding", () => {
    const padding = "&zwnj;&nbsp;".repeat(40);
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        bodyText: null,
        bodyHtml: `<p>Всё о Чёрной пятнице и скидках &rarr; ${padding}&#8203;&shy;</p><p>Today&nbsp;only &mdash; &amp;zwnj; &bogus;</p>`,
      }),
      makeFetchedMessage(2, { bodyText: "Plain\u200c\u00a0\u200c\u00a0 text\ufeff" }),
    ]);
    expect(store.getMessage(idOf(store, 1))!.snippet).toBe(
      "Всё о Чёрной пятнице и скидках → Today only — &zwnj; &bogus;",
    );
    expect(store.getMessage(idOf(store, 2))!.snippet).toBe("Plain text");
  });

  it("snippet of entity-heavy html is computed quickly", () => {
    for (const bodyHtml of ["&".repeat(300_000), "&#".repeat(150_000)]) {
      const started = performance.now();
      store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bodyText: null, bodyHtml })]);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  it("repairSnippets fixes rows stored before full decoding and leaves clean rows alone", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        bodyText: null,
        bodyHtml: "<p>Sale &rarr; " + "&zwnj;&nbsp;".repeat(20) + "today</p>",
      }),
      makeFetchedMessage(2, { bodyText: "Clean & simple; text" }),
      makeFetchedMessage(3, { bodyText: null, bodyHtml: null }),
    ]);
    const stale = "Sale &rarr; " + "&zwnj; ".repeat(20) + "today";
    db.prepare("UPDATE messages SET snippet = ? WHERE id = ?").run(stale, idOf(store, 1));
    // A row whose body is no longer kept is cleaned from its own snippet.
    db.prepare("UPDATE messages SET snippet = ? WHERE id = ?").run("Old &mdash;\u200c gone", idOf(store, 3));
    db.prepare("UPDATE threads SET snippet = ?").run(stale);
    const cleanBefore = db
      .prepare("SELECT snippet FROM messages WHERE id = ?")
      .get(idOf(store, 2)) as { snippet: string };

    expect(store.repairSnippets()).toBe(2);

    expect(store.getMessage(idOf(store, 1))!.snippet).toBe("Sale \u2192 today");
    expect(store.getMessage(idOf(store, 3))!.snippet).toBe("Old \u2014 gone");
    expect(store.getMessage(idOf(store, 2))!.snippet).toBe(cleanBefore.snippet);
    const threadSnippet = (id: string) =>
      store.getThread(store.getMessage(id)!.threadId)!.thread.snippet;
    expect(threadSnippet(idOf(store, 1))).toBe("Sale \u2192 today");
    expect(threadSnippet(idOf(store, 3))).toBe("Old \u2014 gone");
    expect(store.repairSnippets()).toBe(0);
  });

  it("repairSnippets works through more rows than one batch", () => {
    store.upsertMessages(
      "acc_1",
      INBOX,
      Array.from({ length: 1_200 }, (_, i) => makeFetchedMessage(i + 1, { bodyText: `Row ${i}` })),
    );
    db.prepare("UPDATE messages SET snippet = snippet || ' &zwnj;'").run();
    expect(store.repairSnippets()).toBe(1_200);
    expect(store.getMessage(idOf(store, 1_200))!.snippet).toBe("Row 1199");
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
    const { threads } = store.listThreads("acc_1", "INBOX", null, 10);
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
      const page = store.listThreads("acc_1", "INBOX", cursor, 2);
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
    expect(store.listThreads("acc_1", "INBOX", null, 5).nextCursor).toBeNull();
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
      store.listThreads("acc_1", "INBOX", null, 10),
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

// ---------------------------------------------------------------------------
// Slice 2: folders, cross-folder dedup, moves, inline parts, image senders.
// ---------------------------------------------------------------------------

const ALL_MAIL = "[Gmail]/All Mail";

function remoteFolder(
  path: string,
  specialUse: RemoteFolder["specialUse"] = null,
  overrides: Partial<RemoteFolder> = {},
): RemoteFolder {
  return { path, name: path.split("/").pop()!, delimiter: "/", specialUse, selectable: true, ...overrides };
}

function idIn(target: MailStore, folder: string, uid: number, accountId = "acc_1"): string {
  const entry = target.localFolderIndex(accountId, folder, EPOCH).find((e) => e.uid === uid);
  if (!entry) throw new Error(`uid ${uid} not stored in ${folder}`);
  return entry.id;
}

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("slice-2 migrations (SQLite)", () => {
  it("migrations append and backfill dedup keys of slice-1 rows", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 2).forEach((s) => old.exec(s)))();
    old
      .prepare(
        `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
         VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner', 'sealed', 'other', ?)`,
      )
      .run(EPOCH);
    const insert = old.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, from_address, subject, date, snippet)
       VALUES (?, 'acc_1', 'INBOX', ?, ?, ?, 'sender@example.org', 'Invented', '2026-11-10T00:00:00.000Z', 'Invented')`,
    );
    insert.run("m_a", 1, "a@example.org", "t_m_a");
    insert.run("m_b", 2, null, "t_m_b");
    old.prepare(
      `INSERT INTO threads (id, account_id, subject, last_date, message_count, unread_count, participants_json, snippet)
       VALUES ('t_m_a', 'acc_1', 'Invented', NULL, 5, 4, '[]', ''), ('t_m_b', 'acc_1', 'Invented', NULL, 3, 3, '[]', '')`,
    ).run();
    old.prepare(
      "INSERT INTO sync_state (account_id, folder, uid_validity, last_uid, synced_since) VALUES ('acc_1', 'INBOX', 7, 2, ?)",
    ).run(EPOCH);

    old.transaction(() => MIGRATIONS.slice(2).forEach((s) => old.exec(s)))();

    const keys = old.prepare("SELECT id, dedup_key, gm_msgid, move_pending, move_failures FROM messages ORDER BY id").all();
    expect(keys).toEqual([
      { id: "m_a", dedup_key: "mid:a@example.org:0", gm_msgid: null, move_pending: null, move_failures: 0 },
      { id: "m_b", dedup_key: "id:m_b", gm_msgid: null, move_pending: null, move_failures: 0 },
    ]);
    const names = (
      old.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["folders", "image_senders", "inline_parts", "messages_dedup", "messages_folder_pending"]),
    );
    // Earlier elements are untouched: slice 1 shipped exactly two.
    expect(MIGRATIONS.length).toBeGreaterThan(2);

    const migrated = createSqliteStore(old);
    expect(migrated.getSyncState("acc_1", INBOX)).toEqual({ uidValidity: 7, lastUid: 2, syncedSince: EPOCH });
    expect(migrated.listThreads("acc_1", INBOX, null, 10).threads).toHaveLength(2);
    expect(migrated.unreadCount("acc_1")).toBe(2);
    // Thread rows written by slice 1 are derived data: the next threading pass rebuilds them.
    migrated.assignThreads("acc_1", new Map());
    expect(
      migrated.listThreads("acc_1", INBOX, null, 10).threads.map((t) => [t.messageCount, t.unreadCount]),
    ).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it("shipped migration elements are unchanged", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(MIGRATIONS.slice(0, 2).map(sha)).toEqual([
      "023f294a929e0c6d2aea10f38acb89287dbeba167e67f2b31c85103fd74ec5b4",
      "e34d0e9cbe94c27a6da39809436d656dcf4f787e1d35dd82fef86889bb22758f",
    ]);
  });

  it("listThreads by folder stays fast for a few thousand messages", () => {
    // An older mid-sized folder under thousands of newer threads is the worst
    // case for a per-thread membership check.
    const folders: [string, number, number][] = [
      [INBOX, 2_000, Date.UTC(2026, 9, 1)],
      [ALL_MAIL, 2_500, Date.UTC(2026, 9, 1)],
      ["Old", 1_500, Date.UTC(2025, 0, 1)],
      ["Spam", 20, Date.UTC(2026, 9, 1)],
    ];
    store.saveFolders(
      "acc_1",
      folders.map(([path]) => remoteFolder(path, path === INBOX ? "inbox" : null)),
    );
    for (const [index, [folder, n, start]] of folders.entries()) {
      store.upsertMessages(
        "acc_1",
        folder,
        Array.from({ length: n }, (_, i) =>
          makeFetchedMessage(i + 1, {
            messageId: `perf-${index}-${i}@example.org`,
            date: new Date(start + i * 60_000).toISOString(),
          }),
        ),
      );
    }
    store.assignThreads("acc_1", new Map());
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM threads WHERE account_id = 'acc_1'
             AND threads.id IN (SELECT m.thread_id FROM messages m
               WHERE m.account_id = 'acc_1' AND m.folder = 'Old' AND m.move_pending IS NULL)
           ORDER BY last_date DESC, id DESC LIMIT 51`,
        )
        .all() as { detail: string }[]
    ).map((r) => r.detail);
    // The membership list is built once, not re-run per thread.
    expect(plan.join("\n")).not.toMatch(/CORRELATED/);
    expect(plan.join("\n")).toMatch(/LIST SUBQUERY|messages_folder_pending/);

    for (const [folder, n] of folders) {
      const started = performance.now();
      let cursor: string | null = null;
      let listed = 0;
      do {
        const page = store.listThreads("acc_1", folder, cursor, 50);
        listed += page.threads.length;
        cursor = page.nextCursor;
      } while (cursor !== null && listed < 200);
      // Generous bound against CI jitter; measured locally in single-digit ms per page.
      expect(performance.now() - started).toBeLessThan(500);
      expect(listed).toBe(Math.min(n, 200));
    }
    const started = performance.now();
    store.listFolders("acc_1");
    store.unreadCount(null);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("inline parts cascade with their message and the account", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { inlineParts: [{ contentId: "a", mimeType: "image/png", data: bytes(10, 1) }] }),
      makeFetchedMessage(2, { inlineParts: [{ contentId: "b", mimeType: "image/png", data: bytes(10, 2) }] }),
    ]);
    store.allowImageSender("acc_1", "sender@example.org");
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox")]);
    expect(count(db, "inline_parts")).toBe(2);
    store.deleteByUids("acc_1", INBOX, [1]);
    expect(count(db, "inline_parts")).toBe(1);
    store.deleteAccount("acc_1");
    for (const table of ["inline_parts", "folders", "image_senders", "messages"]) {
      expect(count(db, table)).toBe(0);
    }
  });
});

const storeKinds: [string, () => MailStore][] = [
  [
    "SQLite",
    () => {
      const fresh = new Database(":memory:");
      migrate(fresh);
      return createSqliteStore(fresh);
    },
  ],
  ["in-memory fake", () => new InMemoryMailStore()],
];

describe.each(storeKinds)("slice-2 store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
  });

  const gmail = () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(ALL_MAIL, "all")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" })]);
    s.upsertMessages("acc_1", ALL_MAIL, [
      makeFetchedMessage(50, { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" }),
      makeFetchedMessage(51, { messageId: "other@example.org", gmMsgId: "101", subject: "Invented archived" }),
    ]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
  };

  it("gmail copies in INBOX and All Mail count once in thread, folder and badge counts", () => {
    gmail();
    const inbox = s.listThreads("acc_1", INBOX, null, 10).threads;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ messageCount: 1, unreadCount: 1 });
    expect(s.listThreads("acc_1", ALL_MAIL, null, 10).threads.map((t) => t.id)).toContain(inbox[0]!.id);
    const folders = s.listFolders("acc_1");
    expect(folders.map((f) => [f.path, f.totalCount, f.unreadCount])).toEqual([
      [INBOX, 1, 1],
      [ALL_MAIL, 2, 2],
    ]);
    expect(s.unreadCount("acc_1")).toBe(1);
    expect(s.unreadCount(null)).toBe(1);
    const detail = s.getThread(inbox[0]!.id)!;
    expect(detail.messages.map((m) => m.folder)).toEqual([INBOX]);
  });

  it("applyFlags backfills gmail ids and merges copies", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(ALL_MAIL, "all")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: null })]);
    s.upsertMessages("acc_1", ALL_MAIL, [makeFetchedMessage(9, { messageId: null })]);
    s.assignThreads("acc_1", new Map([[idIn(s, INBOX, 1), "t_x"], [idIn(s, ALL_MAIL, 9), "t_x"]]));
    expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]?.messageCount).toBe(2);
    expect(s.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: false, gmMsgId: "7" }])).toBe(1);
    expect(s.applyFlags("acc_1", ALL_MAIL, [{ uid: 9, seen: false, flagged: false, gmMsgId: "7" }])).toBe(1);
    expect(s.applyFlags("acc_1", ALL_MAIL, [{ uid: 9, seen: false, flagged: false, gmMsgId: "7" }])).toBe(0);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]?.messageCount).toBe(1);
    expect(s.listFolders("acc_1").find((f) => f.path === ALL_MAIL)?.totalCount).toBe(1);
    // A later fetch without the Gmail id keeps the backfilled one.
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: null })]);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]?.messageCount).toBe(1);
  });

  it("markOpened marks every copy read and pending where it is attached", () => {
    gmail();
    const inboxCopy = idIn(s, INBOX, 1);
    expect(s.markOpened(inboxCopy)).toEqual({ accountId: "acc_1" });
    expect(s.getMessage(idIn(s, ALL_MAIL, 50))?.isRead).toBe(true);
    expect(s.getMessage(idIn(s, ALL_MAIL, 51))?.isRead).toBe(false);
    expect(s.pendingSeenUids("acc_1", INBOX)).toEqual([1]);
    expect(s.pendingSeenUids("acc_1", ALL_MAIL)).toEqual([50]);
    expect(s.unreadCount(null)).toBe(0);
    expect(s.listFolders("acc_1").map((f) => f.unreadCount)).toEqual([0, 1]);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]?.unreadCount).toBe(0);
  });

  it("markOpened only marks a detached copy read", () => {
    gmail();
    s.beginFolderReset("acc_1", ALL_MAIL);
    s.markOpened(idIn(s, INBOX, 1));
    s.upsertMessages("acc_1", ALL_MAIL, [
      makeFetchedMessage(500, { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" }),
    ]);
    expect(s.getMessage(idIn(s, ALL_MAIL, 500))?.isRead).toBe(false);
    expect(s.pendingSeenUids("acc_1", ALL_MAIL)).toEqual([]);
    expect(s.pendingSeenUids("acc_1", INBOX)).toEqual([1]);
  });

  it("listThreads filters by folder", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented plan" })]);
    s.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(1, {
        messageId: "reply@example.org",
        inReplyTo: "msg-1@example.org",
        references: ["msg-1@example.org"],
        subject: "Re: Invented plan",
        date: "2026-11-11T09:00:00.000Z",
      }),
    ]);
    s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(2, { subject: "Invented spam" })]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    const subjects = (folder: string) =>
      s.listThreads("acc_1", folder, null, 10).threads.map((t) => [t.subject, t.messageCount]);
    expect(subjects(INBOX)).toEqual([["Invented plan", 2]]);
    expect(subjects("Sent")).toEqual([["Invented plan", 2]]);
    expect(subjects("Spam")).toEqual([["Invented spam", 1]]);
    expect(subjects("Nowhere")).toEqual([]);
  });

  it("listFolders orders system folders first", () => {
    s.saveFolders("acc_1", [
      remoteFolder("Zeta"),
      remoteFolder("Trash", "trash"),
      remoteFolder("All", "all"),
      remoteFolder("Archive", "archive"),
      remoteFolder("Alpha", null, { selectable: false }),
      remoteFolder("Junk", "junk"),
      remoteFolder("Drafts", "drafts"),
      remoteFolder("Sent", "sent"),
      remoteFolder("INBOX"),
    ]);
    const folders = s.listFolders("acc_1");
    expect(folders.map((f) => f.path)).toEqual([
      "INBOX", "Sent", "Drafts", "Junk", "Archive", "All", "Trash", "Alpha", "Zeta",
    ]);
    expect(folders[0]).toEqual({
      accountId: "acc_1",
      path: "INBOX",
      name: "INBOX",
      specialUse: "inbox",
      selectable: true,
      unreadCount: 0,
      totalCount: 0,
    });
    expect(folders.find((f) => f.path === "Alpha")?.selectable).toBe(false);
  });

  it("saveFolders drops removed folders with their rows", () => {
    expect(s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Old")])).toEqual({ removed: [] });
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    s.upsertMessages("acc_1", "Old", [makeFetchedMessage(1, { messageId: "old@example.org" })]);
    s.saveSyncState("acc_1", "Old", { uidValidity: 1, lastUid: 1, syncedSince: EPOCH });
    const oldId = idIn(s, "Old", 1);

    expect(
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox", { name: "Inbox" }), remoteFolder("New")]),
    ).toEqual({ removed: ["Old"] });
    expect(s.getMessage(oldId)).toBeNull();
    expect(s.getSyncState("acc_1", "Old")).toBeNull();
    expect(s.localFolderIndex("acc_1", INBOX, EPOCH)).toHaveLength(1);
    expect(s.listFolders("acc_1").map((f) => [f.path, f.name])).toEqual([
      [INBOX, "Inbox"],
      ["New", "New"],
    ]);
  });

  it("queueMove hides rows from the source folder without deleting them", () => {
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Sent", "sent"), remoteFolder("Spam", "junk")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    s.upsertMessages("acc_1", "Sent", [makeFetchedMessage(3)]);
    const inboxCounts = () => {
      const inbox = s.listFolders("acc_1").find((f) => f.path === INBOX)!;
      return [inbox.totalCount, inbox.unreadCount];
    };
    expect(inboxCounts()).toEqual([2, 2]);
    s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "x@example.org" })]);
    s.assignThreads("acc_1", new Map());
    const [id1, id2, id3] = [idIn(s, INBOX, 1), idIn(s, INBOX, 2), idIn(s, "Sent", 3)];

    expect(s.queueMove([id1], "Spam")).toEqual({ accountId: "acc_1", folder: INBOX });
    expect(s.listThreads("acc_1", INBOX, null, 10).threads.map((t) => t.id)).toEqual([`t_${id2}`]);
    expect(inboxCounts()).toEqual([1, 1]);
    expect(s.listFolders("acc_1").find((f) => f.path === "Spam")?.totalCount).toBe(0);
    expect(s.unreadCount("acc_1")).toBe(1);
    expect(s.search({ text: "Invented subject 1" }, "acc_1", 10)).toEqual([]);
    expect(s.getMessage(id1)?.folder).toBe(INBOX);
    expect(s.pendingMoves("acc_1", INBOX)).toEqual([{ uid: 1, id: id1, destination: "Spam" }]);

    // Refused batches change nothing.
    expect(s.queueMove([id1], "Trash")).toBeNull();
    expect(s.queueMove([id2, id1], "Trash")).toBeNull();
    expect(s.queueMove([id2, id3], "Trash")).toBeNull();
    expect(s.queueMove([id2, idIn(s, INBOX, 1, "acc_2")], "Trash")).toBeNull();
    expect(s.queueMove([id2, "m_unknown"], "Trash")).toBeNull();
    expect(s.queueMove([], "Trash")).toBeNull();
    expect(s.queueMove([id2], INBOX)).toBeNull();
    expect(s.pendingMoves("acc_1", INBOX)).toEqual([{ uid: 1, id: id1, destination: "Spam" }]);
    expect(s.pendingMoves("acc_1", "Sent")).toEqual([]);
  });

  it("completeMove re-homes rows with new uids keeping id and pending read", () => {
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        messageId: "keep@example.org",
        inlineParts: [{ contentId: "logo", mimeType: "image/png", data: bytes(4, 9) }],
      }),
      makeFetchedMessage(2),
    ]);
    // The destination copy was synced before the move completed.
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(77, { messageId: "keep@example.org" })]);
    const [id1, id2, early] = [idIn(s, INBOX, 1), idIn(s, INBOX, 2), idIn(s, "Archive", 77)];
    s.markOpened(id1);
    expect(s.queueMove([id1, id2], "Archive")).not.toBeNull();

    s.completeMove("acc_1", INBOX, "Archive", new Map([[1, 77]]), [1, 2]);

    expect(s.getMessage(id1)).toMatchObject({ folder: "Archive", isRead: true });
    expect(s.getMessage(early)).toBeNull();
    expect(s.localFolderIndex("acc_1", "Archive", EPOCH)).toEqual([{ uid: 77, id: id1 }]);
    expect(s.pendingSeenUids("acc_1", "Archive")).toEqual([77]);
    expect(s.inlineParts(id1).map((p) => p.contentId)).toEqual(["logo"]);
    // Uid 2 vanished from the source: done, left for reconcile.
    expect(s.pendingMoves("acc_1", INBOX)).toEqual([]);
    expect(s.localFolderIndex("acc_1", INBOX, EPOCH)).toEqual([{ uid: 2, id: id2 }]);
    s.assignThreads("acc_1", new Map());
    expect(s.listThreads("acc_1", INBOX, null, 10).threads.map((t) => t.id)).toEqual([`t_${id2}`]);
    expect(s.listThreads("acc_1", "Archive", null, 10).threads.map((t) => t.id)).toEqual([`t_${id1}`]);
  });

  it("completeMove without a uid map detaches rows into the destination", () => {
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { messageId: "a@example.org" }),
      makeFetchedMessage(2, { messageId: null, gmMsgId: "55" }),
      makeFetchedMessage(3, { messageId: "c@example.org" }),
    ]);
    const [id1, id2, id3] = [1, 2, 3].map((uid) => idIn(s, INBOX, uid));
    s.queueMove([id1, id2, id3], "Trash");
    s.completeMove("acc_1", INBOX, "Trash", null, [1, 2, 3]);

    expect(s.pendingMoves("acc_1", INBOX)).toEqual([]);
    expect(s.localFolderIndex("acc_1", INBOX, EPOCH)).toEqual([]);
    expect(s.localFolderIndex("acc_1", "Trash", EPOCH)).toEqual([]);
    expect(s.getMessage(id1)?.folder).toBe("Trash");

    // The destination's next round reattaches by Message-ID and by Gmail id.
    s.upsertMessages("acc_1", "Trash", [
      makeFetchedMessage(300, { messageId: "a@example.org" }),
      makeFetchedMessage(301, { messageId: null, gmMsgId: "55" }),
    ]);
    expect(s.localFolderIndex("acc_1", "Trash", EPOCH)).toEqual([
      { uid: 300, id: id1 },
      { uid: 301, id: id2 },
    ]);
    expect(s.finishFolderReset("acc_1", "Trash")).toBe(1);
    expect(s.getMessage(id3)).toBeNull();
  });

  it("failMove cancels after 3 refusals and the message reappears", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    s.assignThreads("acc_1", new Map());
    const id = idIn(s, INBOX, 1);
    s.queueMove([id], "Spam");
    expect(s.failMove("acc_1", INBOX, [1])).toEqual({ cancelled: [] });
    expect(s.failMove("acc_1", INBOX, [1])).toEqual({ cancelled: [] });
    expect(s.pendingMoves("acc_1", INBOX)).toHaveLength(1);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads).toEqual([]);
    expect(s.failMove("acc_1", INBOX, [1, 99])).toEqual({ cancelled: [id] });
    expect(s.pendingMoves("acc_1", INBOX)).toEqual([]);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads.map((t) => t.id)).toEqual([`t_${id}`]);
    // A new request starts counting from zero.
    s.queueMove([id], "Spam");
    expect(s.failMove("acc_1", INBOX, [1])).toEqual({ cancelled: [] });
    expect(s.failMove("acc_1", INBOX, [1])).toEqual({ cancelled: [] });
    expect(s.pendingMoves("acc_1", INBOX)).toHaveLength(1);
  });

  it("inline parts are stored within caps and dropped over caps", () => {
    const part = (contentId: string, size: number) => ({
      contentId,
      mimeType: "image/png",
      data: bytes(size, contentId.charCodeAt(0)),
    });
    const parts = [
      part("a", 100),
      part("big", 512 * 1024 + 1),
      ...["c1", "c2", "c3", "c4", "c5"].map((id) => part(id, 512_000)),
      part("f", 1_000),
      part("a", 5),
    ];
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { inlineParts: parts })]);
    const id = idIn(s, INBOX, 1);
    const stored = s.inlineParts(id);
    expect(stored.map((p) => p.contentId)).toEqual(["a", "c1", "c2", "c3", "c4", "f"]);
    expect(stored[0]).toEqual({ contentId: "a", mimeType: "image/png", data: bytes(100, 97) });
    expect(stored[0]!.data).toBeInstanceOf(Uint8Array);

    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { inlineParts: [part("z", 3)] })]);
    expect(s.inlineParts(id).map((p) => p.contentId)).toEqual(["z"]);
    expect(s.inlineParts("m_unknown")).toEqual([]);
  });

  it("image sender allowlist add/remove/check", () => {
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { from: { name: null, address: "News@Example.org" } })]);
    const id = idIn(s, INBOX, 1);
    expect(s.isImageSenderAllowed("acc_1", "news@example.org")).toBe(false);
    expect(s.getBody(id)?.remoteImagesAllowed).toBe(false);

    s.allowImageSender("acc_1", "NEWS@example.org");
    s.allowImageSender("acc_1", "news@example.org");
    expect(s.isImageSenderAllowed("acc_1", "news@EXAMPLE.org")).toBe(true);
    expect(s.isImageSenderAllowed("acc_2", "news@example.org")).toBe(false);
    expect(s.getBody(id)?.remoteImagesAllowed).toBe(true);

    expect(s.disallowImageSender("acc_1", "News@example.org")).toBe(true);
    expect(s.disallowImageSender("acc_1", "news@example.org")).toBe(false);
    expect(s.isImageSenderAllowed("acc_1", "news@example.org")).toBe(false);
    expect(s.getBody(id)?.remoteImagesAllowed).toBe(false);
  });

  it("search returns one hit per dedup key", () => {
    gmail();
    const hits = s.search({ text: "Invented" }, null, 10);
    expect(hits.map((h) => h.folder).sort()).toEqual([ALL_MAIL, INBOX].sort());
    expect(hits.find((h) => h.subject === "Invented subject 1")?.folder).toBe(INBOX);
    expect(s.search({ text: "Invented" }, "acc_1", 1)).toHaveLength(1);
  });

  it("Message-ID copies dedupe only when their sizes match", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Archive", "archive")]);
    // Two deliveries sharing one Message-ID in one folder stay two messages.
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { messageId: "same@example.org", size: 100 }),
      makeFetchedMessage(2, { messageId: "same@example.org", size: 250 }),
    ]);
    // An exact copy in another folder has the same size and counts once.
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(9, { messageId: "same@example.org", size: 100 })]);
    s.assignThreads("acc_1", new Map([1, 2].map((uid) => [idIn(s, INBOX, uid), "t_same"] as const).concat([[idIn(s, "Archive", 9), "t_same"]])));
    expect(s.listFolders("acc_1").map((f) => [f.path, f.totalCount])).toEqual([
      [INBOX, 2],
      ["Archive", 1],
    ]);
    expect(s.unreadCount("acc_1")).toBe(2);
    expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]?.messageCount).toBe(2);
    expect(s.search({ text: "", subject: "Invented subject" }, "acc_1", 10)).toHaveLength(2);
    s.markOpened(idIn(s, INBOX, 1));
    expect(s.getMessage(idIn(s, "Archive", 9))?.isRead).toBe(true);
    expect(s.getMessage(idIn(s, INBOX, 2))?.isRead).toBe(false);
  });

  it("completeMove only settles moves queued to that destination", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idIn(s, INBOX, 1);
    s.queueMove([id], "Spam");
    s.completeMove("acc_1", INBOX, "Trash", new Map([[1, 5]]), [1]);
    expect(s.getMessage(id)?.folder).toBe(INBOX);
    expect(s.pendingMoves("acc_1", INBOX)).toEqual([{ uid: 1, id, destination: "Spam" }]);
  });

  it("completeMove keeps an occupant that is itself waiting to move", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: "a@example.org" })]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(7, { messageId: "b@example.org" })]);
    const [moving, occupant] = [idIn(s, INBOX, 1), idIn(s, "Archive", 7)];
    s.queueMove([moving], "Archive");
    s.queueMove([occupant], "Trash");
    s.completeMove("acc_1", INBOX, "Archive", new Map([[1, 7]]), [1]);
    expect(s.getMessage(occupant)?.folder).toBe("Archive");
    expect(s.pendingMoves("acc_1", "Archive")).toEqual([{ uid: 7, id: occupant, destination: "Trash" }]);
    // The slot is taken, so the moved row waits detached for the folder's sync.
    expect(s.getMessage(moving)?.folder).toBe("Archive");
    expect(s.localFolderIndex("acc_1", "Archive", EPOCH)).toEqual([{ uid: 7, id: occupant }]);
  });

  it("completeMove without a uid map merges into a destination copy of the same message", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: "a@example.org" })]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(40, { messageId: "a@example.org" })]);
    const [moving, copy] = [idIn(s, INBOX, 1), idIn(s, "Archive", 40)];
    s.markOpened(copy);
    s.clearSeenPending("acc_1", INBOX, [1]);
    s.queueMove([moving], "Archive");
    s.completeMove("acc_1", INBOX, "Archive", null, [1]);
    expect(s.getMessage(copy)).toBeNull();
    expect(s.localFolderIndex("acc_1", "Archive", EPOCH)).toEqual([{ uid: 40, id: moving }]);
    expect(s.pendingSeenUids("acc_1", "Archive")).toEqual([40]);
  });

  it("getThread prefers a copy that is not waiting to move", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(ALL_MAIL, "all")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { gmMsgId: "5", gmThreadId: "T" })]);
    s.upsertMessages("acc_1", ALL_MAIL, [makeFetchedMessage(60, { gmMsgId: "5", gmThreadId: "T" })]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    const inboxCopy = idIn(s, INBOX, 1);
    const threadId = s.getMessage(inboxCopy)!.threadId;
    expect(s.getThread(threadId)!.messages.map((m) => m.id)).toEqual([inboxCopy]);
    s.queueMove([inboxCopy], "Spam");
    expect(s.getThread(threadId)!.messages.map((m) => m.id)).toEqual([idIn(s, ALL_MAIL, 60)]);
  });

  it("a folder named INBOX is the Inbox without a saved special use", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, null), remoteFolder(INBOX, null, { name: "Inbox" })]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    expect(s.unreadCount("acc_1")).toBe(1);
    expect(s.listFolders("acc_1").map((f) => [f.path, f.name, f.specialUse])).toEqual([[INBOX, "Inbox", "inbox"]]);
  });
});
