import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../../core/threading.ts";
import type { NewDraft, NewOutboxRow, RemoteFolder } from "../../core/model.ts";
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

/** Attached uids of the folder with a pending desired \Seen = true. */
function pendingSeen(store: MailStore, accountId: string, folder: string): number[] {
  return store
    .pendingFlagIntents(accountId, folder)
    .filter((intent) => intent.seen === true)
    .map((intent) => intent.uid);
}

/** Clears a pushed \Seen = true on the uids (as sync does after a STORE). */
function clearSeen(store: MailStore, accountId: string, folder: string, uids: number[]): void {
  store.clearFlagIntents(
    accountId,
    folder,
    uids.map((uid) => ({ uid, seen: true, flagged: null })),
  );
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
    const detail = store.getThread(threadId, INBOX)!;
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
      flagged: false,
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
      draftId: null,
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
      store.getThread(store.getMessage(id)!.threadId, INBOX)!.thread.snippet;
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
    expect(pendingSeen(store, "acc_1", INBOX)).toEqual([]);
    expect(store.finishFolderReset("acc_1", INBOX)).toBe(1);
    expect(store.getMessage(gone)).toBeNull();
    expect(count(db, "attachments")).toBe(0);
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH).map((e) => e.uid)).toEqual([202]);
  });

  it("applyFlags keeps a pending local read", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idOf(store, 1);
    expect(store.markOpened(id)).toEqual({ accountId: "acc_1" });
    expect(pendingSeen(store, "acc_1", INBOX)).toEqual([1]);

    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(1);
    expect(store.getMessage(id)).toMatchObject({ isRead: true, isFlagged: true });
    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(0);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: false })]);
    expect(store.getMessage(id)?.isRead).toBe(true);

    clearSeen(store, "acc_1", INBOX, [1]);
    expect(pendingSeen(store, "acc_1", INBOX)).toEqual([]);
    expect(store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: true }])).toBe(1);
    expect(store.getMessage(id)?.isRead).toBe(false);
  });

  it("markOpened returns null for an unknown id", () => {
    expect(store.markOpened("m_0000000000000000")).toBeNull();
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true })]);
    expect(store.markOpened(idOf(store, 1))).toEqual({ accountId: "acc_1" });
    expect(pendingSeen(store, "acc_1", INBOX)).toEqual([]);
  });

  it("markOpened keeps the thread's unread count current", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.assignThreads("acc_1", new Map());
    const id = idOf(store, 1);
    store.markOpened(id);
    expect(store.getThread(store.getMessage(id)!.threadId, INBOX)?.thread.unreadCount).toBe(0);
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
      pendingSeen(store, "acc_1", INBOX),
      store.markOpened(id),
      store.threadingInputs("acc_1"),
      store.listThreads("acc_1", "INBOX", null, 10),
      store.getThread(threadId, INBOX),
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
    expect(MIGRATIONS.slice(0, 4).map(sha)).toEqual([
      "023f294a929e0c6d2aea10f38acb89287dbeba167e67f2b31c85103fd74ec5b4",
      "e34d0e9cbe94c27a6da39809436d656dcf4f787e1d35dd82fef86889bb22758f",
      "9430a1b0edb5ab94a14189c472a81384b3869786c2c5c56a00a56c2b02097396",
      "d32d0c6bafc6b6259c1bf6448fe0a24ee944f1c46dd8cf87e0e443eb7301103c",
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

  it("a thread row is flagged when a message of it in the viewed folder is flagged", () => {
    gmail();
    // A second Inbox message of the same thread, flagged but waiting to move out.
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(2, { messageId: "g2@example.org", gmMsgId: "102", gmThreadId: "900", flagged: true }),
    ]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    s.queueMove([idIn(s, INBOX, 2)], "Trash");
    // Flag only the All Mail copy (uid 50) of the Inbox message (uid 1).
    s.applyFlags("acc_1", ALL_MAIL, [{ uid: 50, seen: false, flagged: true }]);
    const inbox = s.listThreads("acc_1", INBOX, null, 10).threads;
    expect(inbox.map((t) => t.flagged)).toEqual([false]);
    const threadId = inbox[0]!.id;
    const all = s.listThreads("acc_1", ALL_MAIL, null, 10).threads;
    expect(all.filter((t) => t.flagged).map((t) => t.id)).toEqual([threadId]);
    expect(s.getThread(threadId, ALL_MAIL)!.thread.flagged).toBe(true);
    expect(s.getThread(threadId, INBOX)!.thread.flagged).toBe(false);
  });

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
    const detail = s.getThread(inbox[0]!.id, INBOX)!;
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
    expect(pendingSeen(s, "acc_1", INBOX)).toEqual([1]);
    expect(pendingSeen(s, "acc_1", ALL_MAIL)).toEqual([50]);
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
    expect(pendingSeen(s, "acc_1", ALL_MAIL)).toEqual([]);
    expect(pendingSeen(s, "acc_1", INBOX)).toEqual([1]);
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
    expect(pendingSeen(s, "acc_1", "Archive")).toEqual([77]);
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
    clearSeen(s, "acc_1", INBOX, [1]);
    s.queueMove([moving], "Archive");
    s.completeMove("acc_1", INBOX, "Archive", null, [1]);
    expect(s.getMessage(copy)).toBeNull();
    expect(s.localFolderIndex("acc_1", "Archive", EPOCH)).toEqual([{ uid: 40, id: moving }]);
    expect(pendingSeen(s, "acc_1", "Archive")).toEqual([40]);
  });

  it("getThread prefers a copy that is not waiting to move", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(ALL_MAIL, "all")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { gmMsgId: "5", gmThreadId: "T" })]);
    s.upsertMessages("acc_1", ALL_MAIL, [makeFetchedMessage(60, { gmMsgId: "5", gmThreadId: "T" })]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    const inboxCopy = idIn(s, INBOX, 1);
    const threadId = s.getMessage(inboxCopy)!.threadId;
    expect(s.getThread(threadId, INBOX)!.messages.map((m) => m.id)).toEqual([inboxCopy]);
    s.queueMove([inboxCopy], "Spam");
    // Even viewed from the Inbox, the copy waiting to move gives way.
    expect(s.getThread(threadId, INBOX)!.messages.map((m) => m.id)).toEqual([idIn(s, ALL_MAIL, 60)]);
  });

  it("getThread shows each message's copy in the viewed folder (Gmail Sent, All Mail)", () => {
    const SENT = "[Gmail]/Sent Mail";
    s.saveFolders("acc_1", [
      remoteFolder(INBOX, "inbox"),
      remoteFolder(SENT, "sent"),
      remoteFolder(ALL_MAIL, "all"),
    ]);
    const received = { gmMsgId: "5", gmThreadId: "T", messageId: "r@example.org", date: "2026-11-10T09:00:00.000Z" };
    const reply = { gmMsgId: "6", gmThreadId: "T", messageId: "s@example.org", date: "2026-11-11T09:00:00.000Z" };
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, received)]);
    s.upsertMessages("acc_1", SENT, [makeFetchedMessage(3, reply)]);
    // All Mail is stored last, so "most recently stored" alone would pick it.
    s.upsertMessages("acc_1", ALL_MAIL, [makeFetchedMessage(60, received), makeFetchedMessage(61, reply)]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    const threadId = s.getMessage(idIn(s, INBOX, 1))!.threadId;
    const shown = (folder: string) =>
      s.getThread(threadId, folder)!.messages.map((m) => [m.id, m.folder]);

    expect(shown(SENT)).toEqual([
      [idIn(s, INBOX, 1), INBOX],
      [idIn(s, SENT, 3), SENT],
    ]);
    expect(shown(ALL_MAIL)).toEqual([
      [idIn(s, ALL_MAIL, 60), ALL_MAIL],
      [idIn(s, ALL_MAIL, 61), ALL_MAIL],
    ]);
    // Elsewhere: the Inbox copy, then a copy outside All Mail.
    expect(shown(INBOX)).toEqual([
      [idIn(s, INBOX, 1), INBOX],
      [idIn(s, SENT, 3), SENT],
    ]);
  });

  it("a folder named INBOX is the Inbox without a saved special use", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, null), remoteFolder(INBOX, null, { name: "Inbox" })]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    expect(s.unreadCount("acc_1")).toBe(1);
    expect(s.listFolders("acc_1").map((f) => [f.path, f.name, f.specialUse])).toEqual([[INBOX, "Inbox", "inbox"]]);
  });
});

// ---------------------------------------------------------------------------
// Slice 3a: desired flag state, all accounts, roles, raw refs.
// ---------------------------------------------------------------------------

describe("slice-3a migration (SQLite)", () => {
  it("element 3 adds desired-state columns, backfills pending reads and indexes thread dates", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 3).forEach((s) => old.exec(s)))();
    old
      .prepare(
        `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
         VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner', 'sealed', 'other', ?)`,
      )
      .run(EPOCH);
    const insert = old.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, from_address, subject, date,
         snippet, is_read, seen_pending, dedup_key)
       VALUES (?, 'acc_1', 'INBOX', ?, ?, ?, 'sender@example.org', 'Invented', '2026-11-10T00:00:00.000Z',
         'Invented', ?, ?, ?)`,
    );
    insert.run("m_a", 1, "a@example.org", "t_m_a", 1, 1, "mid:a@example.org:0");
    insert.run("m_b", 2, "b@example.org", "t_m_b", 0, 0, "mid:b@example.org:0");
    insert.run("m_c", null, "c@example.org", "t_m_c", 1, 1, "mid:c@example.org:0");

    old.transaction(() => MIGRATIONS.slice(3).forEach((s) => old.exec(s)))();

    // Element 3 shipped with slice 3a; later slices only append.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
    expect(
      old.prepare("SELECT id, seen_pending, seen_desired, flag_desired FROM messages ORDER BY id").all(),
    ).toEqual([
      { id: "m_a", seen_pending: 1, seen_desired: 1, flag_desired: null },
      { id: "m_b", seen_pending: 0, seen_desired: null, flag_desired: null },
      { id: "m_c", seen_pending: 1, seen_desired: 1, flag_desired: null },
    ]);
    const index = old
      .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'threads_last_date'")
      .get() as { tbl_name: string; sql: string };
    expect(index.tbl_name).toBe("threads");
    expect(index.sql).toMatch(/threads\s*\(last_date, id\)/);

    const migrated = createSqliteStore(old);
    // Only the attached row is pushed; the backfilled read still wins over the server.
    expect(migrated.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: true, flagged: null }]);
    migrated.applyFlags("acc_1", INBOX, [{ uid: 1, seen: false, flagged: false }]);
    expect(migrated.getMessage("m_a")?.isRead).toBe(true);
  });

  it("seen_pending is frozen: opening and pushing leave it alone", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idOf(store, 1);
    store.markOpened(id);
    store.setDesired([id], { flagged: true });
    const row = () =>
      db.prepare("SELECT seen_pending, seen_desired, flag_desired FROM messages WHERE id = ?").get(id);
    expect(row()).toEqual({ seen_pending: 0, seen_desired: 1, flag_desired: 1 });
    clearSeen(store, "acc_1", INBOX, [1]);
    expect(row()).toEqual({ seen_pending: 0, seen_desired: null, flag_desired: 1 });
  });

  it("listThreadsAll scans the (last_date, id) index without a temp B-tree, first page and after a cursor", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    for (const accountId of ["acc_1", "acc_2"]) {
      store.upsertMessages(
        accountId,
        INBOX,
        Array.from({ length: 1_500 }, (_, i) =>
          makeFetchedMessage(i + 1, {
            messageId: `perf-${accountId}-${i}@example.org`,
            date: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
          }),
        ),
      );
      store.assignThreads(accountId, new Map());
    }
    // Capture the store's own statements.
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;

    const started = performance.now();
    let cursor: string | null = null;
    let listed = 0;
    do {
      const page = store.listThreadsAll("inbox", cursor, 50);
      listed += page.threads.length;
      cursor = page.nextCursor;
    } while (cursor !== null && listed < 200);
    expect(performance.now() - started).toBeLessThan(500);
    expect(listed).toBe(200);
    db.prepare = prepare;

    const listing = [...new Set(statements.filter((sql) => /FROM threads/.test(sql)))];
    const first = listing.find((sql) => !sql.includes("@afterId"));
    const after = listing.find((sql) => sql.includes("@afterDate"));
    expect(first).toBeDefined();
    expect(after).toBeDefined();
    const params = { role: "inbox", limit: 51, afterDate: "2026-10-02T00:00:00.000Z", afterId: "t_x" };
    for (const sql of [first!, after!]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[])
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toMatch(/SCAN threads USING INDEX threads_last_date/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it("listThreadsAll keyset pages through equal dates across accounts without gaps or repeats", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    const same = "2026-11-10T09:00:00.000Z";
    for (const accountId of ["acc_1", "acc_2"]) {
      store.upsertMessages(
        accountId,
        INBOX,
        [1, 2, 3].map((uid) => makeFetchedMessage(uid, { messageId: `tie-${accountId}-${uid}@example.org`, date: same })),
      );
      store.assignThreads(accountId, new Map());
    }
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(4, { messageId: "newer@example.org", date: "2026-11-11T09:00:00.000Z" }),
      makeFetchedMessage(5, { messageId: "older@example.org", date: "2026-11-09T09:00:00.000Z" }),
    ]);
    store.assignThreads("acc_1", new Map());
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = store.listThreadsAll("inbox", cursor, 2);
      ids.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    const expected = (
      db.prepare("SELECT id FROM threads ORDER BY last_date DESC, id DESC").all() as { id: string }[]
    ).map((r) => r.id);
    expect(expected).toHaveLength(8);
    expect(ids).toEqual(expected);
    expect(pages).toBe(4);
  });
});

describe.each(storeKinds)("slice-3a store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
  });

  const flags = (id: string) => {
    const message = s.getMessage(id)!;
    return [message.isRead, message.isFlagged];
  };

  /** acc_1 as Gmail: message g in INBOX (uid 1) and All Mail (uid 50), a copy in Old (uid 7). */
  const gmail = () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(ALL_MAIL, "all"), remoteFolder("Old")]);
    const g = { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" };
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, g)]);
    s.upsertMessages("acc_1", ALL_MAIL, [
      makeFetchedMessage(50, g),
      makeFetchedMessage(51, { messageId: "other@example.org", gmMsgId: "101" }),
    ]);
    s.upsertMessages("acc_1", "Old", [makeFetchedMessage(7, g)]);
    s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
  };

  it("setDesired changes every copy at once and records intents on attached copies", () => {
    gmail();
    const detached = idIn(s, "Old", 7);
    s.beginFolderReset("acc_1", "Old");
    const inboxCopy = idIn(s, INBOX, 1);
    expect(s.setDesired([inboxCopy, "m_unknown", inboxCopy], { flagged: true })).toEqual([
      { accountId: "acc_1" },
    ]);
    expect(flags(inboxCopy)).toEqual([false, true]);
    expect(flags(idIn(s, ALL_MAIL, 50))).toEqual([false, true]);
    expect(flags(detached)).toEqual([false, true]);
    expect(flags(idIn(s, ALL_MAIL, 51))).toEqual([false, false]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: null, flagged: true }]);
    expect(s.pendingFlagIntents("acc_1", ALL_MAIL)).toEqual([{ uid: 50, seen: null, flagged: true }]);
    expect(s.pendingFlagIntents("acc_1", "Old")).toEqual([]);
    expect(s.setDesired(["m_unknown"], { seen: true })).toEqual([]);
  });

  it("setDesired stays inside each account and returns each touched account once", () => {
    // Same Message-ID and size in both accounts: the same dedup key text.
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    expect(s.setDesired([idIn(s, INBOX, 1, "acc_2"), idIn(s, INBOX, 2, "acc_2")], { seen: true })).toEqual([
      { accountId: "acc_2" },
    ]);
    expect(flags(idIn(s, INBOX, 1))).toEqual([false, false]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
    expect(
      s.setDesired([idIn(s, INBOX, 1, "acc_2"), idIn(s, INBOX, 1), idIn(s, INBOX, 2, "acc_2")], { seen: false }),
    ).toEqual([{ accountId: "acc_2" }, { accountId: "acc_1" }]);
  });

  it("setDesired reaches rows waiting to move, overwrites an opposite intent and pushes an equal value", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true }), makeFetchedMessage(2)]);
    const [id1, id2] = [idIn(s, INBOX, 1), idIn(s, INBOX, 2)];
    // Already read locally and nothing pending: still pushed.
    s.setDesired([id1], { seen: true });
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: true, flagged: null }]);
    s.queueMove([id2], "Trash");
    s.setDesired([id2], { seen: true, flagged: true });
    s.setDesired([id2], { seen: false });
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([
      { uid: 1, seen: true, flagged: null },
      { uid: 2, seen: false, flagged: true },
    ]);
    expect(flags(id2)).toEqual([false, true]);
  });

  it("a pending desired value wins over reconcile and refetch until cleared", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true })]);
    const id = idIn(s, INBOX, 1);
    s.setDesired([id], { seen: false, flagged: true });
    const server = [{ uid: 1, seen: true, flagged: false }];
    expect(s.applyFlags("acc_1", INBOX, server)).toBe(0);
    expect(flags(id)).toEqual([false, true]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true, flagged: false })]);
    expect(flags(id)).toEqual([false, true]);

    s.clearFlagIntents("acc_1", INBOX, [{ uid: 1, seen: false, flagged: null }]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: null, flagged: true }]);
    expect(s.applyFlags("acc_1", INBOX, server)).toBe(1);
    expect(flags(id)).toEqual([true, true]);

    s.clearFlagIntents("acc_1", INBOX, [{ uid: 1, seen: null, flagged: true }]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
    expect(s.applyFlags("acc_1", INBOX, server)).toBe(1);
    expect(flags(id)).toEqual([true, false]);
  });

  it("clearFlagIntents clears only values that still equal what was pushed", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    const [id1, id2] = [idIn(s, INBOX, 1), idIn(s, INBOX, 2)];
    s.setDesired([id1, id2], { seen: true, flagged: true });
    const pushed = s.pendingFlagIntents("acc_1", INBOX);
    // The owner clicks again while the push is in flight.
    s.setDesired([id1], { flagged: false });
    s.clearFlagIntents("acc_1", "Other", pushed);
    s.clearFlagIntents("acc_1", INBOX, pushed);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: null, flagged: false }]);
  });

  it("pendingFlagIntents lists attached rows only; a reattached row is pushed again", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idIn(s, INBOX, 1);
    s.setDesired([id], { flagged: true });
    s.beginFolderReset("acc_1", INBOX);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(9, { messageId: "msg-1@example.org" })]);
    expect(idIn(s, INBOX, 9)).toBe(id);
    expect(flags(id)).toEqual([false, true]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 9, seen: null, flagged: true }]);
  });

  it("completeMove re-homes rows carrying both intents (non-null wins)", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { messageId: "keep@example.org" })]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(77, { messageId: "keep@example.org" })]);
    const [moving, early] = [idIn(s, INBOX, 1), idIn(s, "Archive", 77)];
    // The moving row ends with a read intent, the destination copy with a flag intent.
    s.setDesired([moving], { seen: true, flagged: true });
    s.clearFlagIntents("acc_1", INBOX, [{ uid: 1, seen: null, flagged: true }]);
    s.clearFlagIntents("acc_1", "Archive", [{ uid: 77, seen: true, flagged: null }]);
    s.queueMove([moving], "Archive");

    s.completeMove("acc_1", INBOX, "Archive", new Map([[1, 77]]), [1]);

    expect(s.getMessage(early)).toBeNull();
    expect(s.getMessage(moving)).toMatchObject({ folder: "Archive", isRead: true, isFlagged: true });
    expect(s.pendingFlagIntents("acc_1", "Archive")).toEqual([{ uid: 77, seen: true, flagged: true }]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
  });

  it("a detached row named in setDesired keeps its intent and is pushed after reattach", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true })]);
    const id = idIn(s, INBOX, 1);
    s.beginFolderReset("acc_1", INBOX);
    expect(s.setDesired([id], { seen: false, flagged: true })).toEqual([{ accountId: "acc_1" }]);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(9, { messageId: "msg-1@example.org", seen: true })]);
    expect(idIn(s, INBOX, 9)).toBe(id);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 9, seen: false, flagged: true }]);
    expect(s.applyFlags("acc_1", INBOX, [{ uid: 9, seen: true, flagged: false }])).toBe(0);
    expect(flags(id)).toEqual([false, true]);
  });

  it("a detached opened row keeps its read intent and is pushed after reattach", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idIn(s, INBOX, 1);
    s.beginFolderReset("acc_1", INBOX);
    s.markOpened(id);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(9, { messageId: "msg-1@example.org" })]);
    expect(idIn(s, INBOX, 9)).toBe(id);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 9, seen: true, flagged: null }]);
    expect(s.applyFlags("acc_1", INBOX, [{ uid: 9, seen: false, flagged: false }])).toBe(0);
    expect(flags(id)).toEqual([true, false]);
  });

  it("another detached copy keeps a same-value intent and drops a differing one", () => {
    gmail();
    const [inboxCopy, oldCopy] = [idIn(s, INBOX, 1), idIn(s, "Old", 7)];
    s.setDesired([inboxCopy], { seen: true, flagged: true });
    s.beginFolderReset("acc_1", "Old");
    s.setDesired([inboxCopy], { seen: true, flagged: false });
    s.upsertMessages("acc_1", "Old", [
      makeFetchedMessage(8, { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" }),
    ]);
    expect(idIn(s, "Old", 8)).toBe(oldCopy);
    expect(s.pendingFlagIntents("acc_1", "Old")).toEqual([{ uid: 8, seen: true, flagged: null }]);
    expect(flags(oldCopy)).toEqual([true, false]);
  });

  it("markOpened reads every copy and records a read intent on attached unread copies only", () => {
    gmail();
    s.beginFolderReset("acc_1", "Old");
    const inboxCopy = idIn(s, INBOX, 1);
    expect(s.markOpened(inboxCopy)).toEqual({ accountId: "acc_1" });
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([{ uid: 1, seen: true, flagged: null }]);
    expect(s.pendingFlagIntents("acc_1", ALL_MAIL)).toEqual([{ uid: 50, seen: true, flagged: null }]);
    // The detached copy was read locally only; reattached, it follows the server.
    s.upsertMessages("acc_1", "Old", [
      makeFetchedMessage(8, { messageId: "g@example.org", gmMsgId: "100", gmThreadId: "900" }),
    ]);
    expect(flags(idIn(s, "Old", 8))).toEqual([false, false]);
    expect(s.pendingFlagIntents("acc_1", "Old")).toEqual([]);
    // A read copy gets no new intent.
    s.clearFlagIntents("acc_1", INBOX, [{ uid: 1, seen: true, flagged: null }]);
    s.markOpened(inboxCopy);
    expect(s.pendingFlagIntents("acc_1", INBOX)).toEqual([]);
  });

  /**
   * acc_1 (Gmail-like): INBOX uids 1 (11-10) and 2 (11-12), uid 1 also in All
   * Mail (uid 60); All Mail-only uid 61 (11-13); Archive uid 3 (11-09).
   * acc_2: INBOX uids 1 (11-11, seen) and 2 (11-14); Archive uid 3 (11-08).
   */
  const twoAccounts = () => {
    s.saveFolders("acc_1", [
      remoteFolder(INBOX, "inbox"),
      remoteFolder(ALL_MAIL, "all"),
      remoteFolder("Archive", "archive"),
      remoteFolder("Spam", "junk"),
    ]);
    s.saveFolders("acc_2", [remoteFolder(INBOX), remoteFolder("Archived", "archive")]);
    const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}T09:00:00.000Z`;
    const first = { gmMsgId: "1", date: day(10), subject: "a1 inbox old" };
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, first),
      makeFetchedMessage(2, { gmMsgId: "2", date: day(12), subject: "a1 inbox new" }),
    ]);
    s.upsertMessages("acc_1", ALL_MAIL, [
      makeFetchedMessage(60, first),
      makeFetchedMessage(61, { gmMsgId: "61", date: day(13), subject: "a1 all mail only" }),
    ]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(3, { gmMsgId: "3", date: day(9), subject: "a1 archived" })]);
    s.upsertMessages("acc_2", INBOX, [
      makeFetchedMessage(1, { date: day(11), subject: "a2 inbox old", seen: true }),
      makeFetchedMessage(2, { date: day(14), subject: "a2 inbox new" }),
    ]);
    s.upsertMessages("acc_2", "Archived", [makeFetchedMessage(3, { date: day(8), subject: "a2 archived" })]);
    s.assignThreads("acc_1", new Map());
    s.assignThreads("acc_2", new Map());
  };

  const allSubjects = (role: Parameters<MailStore["listThreadsAll"]>[0], limit = 10) => {
    const out: [string, string, boolean][] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = s.listThreadsAll(role, cursor, limit);
      out.push(...page.threads.map((t): [string, string, boolean] => [t.accountId, t.subject, t.flagged]));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    return out;
  };

  it("listThreadsAll merges accounts newest first across pages", () => {
    twoAccounts();
    const firstPage = s.listThreadsAll("inbox", null, 2);
    expect(firstPage.threads.map((t) => t.subject)).toEqual(["a2 inbox new", "a1 inbox new"]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(allSubjects("inbox", 2)).toEqual([
      ["acc_2", "a2 inbox new", false],
      ["acc_1", "a1 inbox new", false],
      ["acc_2", "a2 inbox old", false],
      ["acc_1", "a1 inbox old", false],
    ]);
    expect(s.listThreadsAll("inbox", null, 4).nextCursor).toBeNull();
    expect(allSubjects("sent")).toEqual([]);
  });

  it("the Archive role merges archive folders only, never Gmail All Mail", () => {
    twoAccounts();
    expect(allSubjects("archive", 1)).toEqual([
      ["acc_1", "a1 archived", false],
      ["acc_2", "a2 archived", false],
    ]);
    expect(s.listThreadsAll("all", null, 10)).toEqual({ threads: [], nextCursor: null });
  });

  it("listThreadsAll leaves out rows waiting to move and flags threads per role", () => {
    twoAccounts();
    s.queueMove([idIn(s, INBOX, 2, "acc_2")], "Archived");
    // The All Mail copy of an Inbox message is flagged: starred in All Mail only.
    s.applyFlags("acc_1", ALL_MAIL, [{ uid: 60, seen: false, flagged: true }]);
    s.setDesired([idIn(s, "Archive", 3)], { flagged: true });
    expect(allSubjects("inbox")).toEqual([
      ["acc_1", "a1 inbox new", false],
      ["acc_2", "a2 inbox old", false],
      ["acc_1", "a1 inbox old", false],
    ]);
    expect(allSubjects("archive")).toEqual([
      ["acc_1", "a1 archived", true],
      ["acc_2", "a2 archived", false],
    ]);
    expect(s.listThreads("acc_1", ALL_MAIL, null, 10).threads.find((t) => t.subject === "a1 inbox old")?.flagged).toBe(
      true,
    );
  });

  it("listRoles sums distinct messages per role across accounts, zeros included", () => {
    twoAccounts();
    s.queueMove([idIn(s, INBOX, 2)], "Spam");
    expect(s.listRoles()).toEqual([
      // acc_1 uid 1, acc_2 uids 1 (read) and 2; acc_1 uid 2 waits to move.
      { role: "inbox", unreadCount: 2, totalCount: 3 },
      { role: "sent", unreadCount: 0, totalCount: 0 },
      { role: "drafts", unreadCount: 0, totalCount: 0 },
      { role: "junk", unreadCount: 0, totalCount: 0 },
      { role: "archive", unreadCount: 2, totalCount: 2 },
      { role: "trash", unreadCount: 0, totalCount: 0 },
    ]);
  });

  it("rawRef points at an attached row with its folder's UIDVALIDITY", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { size: 321 })]);
    s.upsertMessages("acc_1", "Other", [makeFetchedMessage(4, { messageId: null })]);
    s.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 1, syncedSince: EPOCH });
    const id = idIn(s, INBOX, 1);
    expect(s.rawRef(id)).toEqual({
      accountId: "acc_1",
      folder: INBOX,
      uid: 1,
      size: 321,
      messageId: "msg-1@example.org",
      uidValidity: 7,
    });
    expect(s.rawRef(idIn(s, "Other", 4))).toEqual({
      accountId: "acc_1",
      folder: "Other",
      uid: 4,
      size: 100,
      messageId: null,
      uidValidity: null,
    });
    expect(s.rawRef("m_unknown")).toBeNull();
    s.queueMove([idIn(s, "Other", 4)], "Trash");
    expect(s.rawRef(idIn(s, "Other", 4))).toBeNull();
    s.beginFolderReset("acc_1", INBOX);
    expect(s.rawRef(id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 3b: SMTP columns, Reply-To, drafts, attachments, outbox.
// ---------------------------------------------------------------------------

const T0 = "2026-11-15T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function newDraft(overrides: Partial<NewDraft> = {}): NewDraft {
  return {
    id: "d_1",
    kind: "new",
    accountId: "acc_1",
    sourceMessageId: null,
    messageId: "<d1@example.org>",
    inReplyTo: null,
    references: [],
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    bcc: [{ name: null, address: "hidden@example.net" }],
    subject: "Invented draft",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
    serverCopy: null,
    importHtml: null,
    origin: "owner",
    createdAt: T0,
    ...overrides,
  };
}

function newOutbox(overrides: Partial<NewOutboxRow> = {}): NewOutboxRow {
  return {
    id: "out_1",
    accountId: "acc_1",
    draftId: "d_1",
    messageId: "<d1@example.org>",
    subject: "Invented draft",
    envelopeFrom: "owner@example.org",
    envelopeTo: ["bob@example.com", "hidden@example.net"],
    mime: new TextEncoder().encode("Subject: Invented\r\n\r\nBody"),
    bccHeader: "Bcc: hidden@example.net\r\n",
    sendAfter: later(10_000),
    origin: "owner",
    createdAt: T0,
    ...overrides,
  };
}

const FIELDS = {
  accountId: "acc_1",
  to: [{ name: null, address: "carl@example.com" }],
  cc: [],
  bcc: [],
  subject: "Changed",
  doc: { type: "doc" as const, content: [{ type: "paragraph" as const }] },
};

const file = (data: number[], overrides: { contentId?: string | null; fileName?: string } = {}) => ({
  fileName: overrides.fileName ?? "notes.txt",
  mimeType: "text/plain",
  size: data.length,
  sha256: "a".repeat(64),
  data: new Uint8Array(data),
  contentId: overrides.contentId ?? null,
});

describe("slice-3b migration (SQLite)", () => {
  it("element 4 backfills SMTP per preset and leaves old Reply-To unknown", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 4).forEach((s) => old.exec(s)))();
    const account = old.prepare(
      `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
       VALUES (?, ?, 'imap.example.org', 993, ?, 'sealed', ?, ?)`,
    );
    account.run("acc_i", "i@example.org", "i@example.org", "icloud", EPOCH);
    account.run("acc_g", "g@example.com", "g@example.com", "gmail", EPOCH);
    account.run("acc_o", "o@example.net", "o@example.net", "other", EPOCH);
    old.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, from_address, subject, date, snippet, dedup_key)
       VALUES ('m_a', 'acc_i', 'INBOX', 1, 'a@example.org', 't_m_a', 'sender@example.org', 'Invented',
         '2026-11-10T00:00:00.000Z', 'Invented', 'mid:a@example.org:0')`,
    ).run();

    old.transaction(() => MIGRATIONS.slice(4).forEach((s) => old.exec(s)))();

    const migrated = createSqliteStore(old);
    expect(migrated.getAccount("acc_i")).toMatchObject({
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", username: null },
      sentCopy: "append",
    });
    expect(migrated.getAccount("acc_g")).toMatchObject({
      smtp: { host: "smtp.gmail.com", port: 465, security: "tls", username: null },
      sentCopy: "server",
    });
    expect(migrated.getAccount("acc_o")).toMatchObject({ smtp: null, sentCopy: "append" });
    expect(migrated.replySource("m_a")).toMatchObject({ replyTo: [], replyToKnown: false });
    expect(migrated.getMessage("m_a")!.draftId).toBeNull();

    const names = (
      old.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "compose_drafts",
        "compose_attachments",
        "outbox",
        "outbox_state",
        "outbox_draft_live",
        "compose_drafts_account",
      ]),
    );
    const columns = (old.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("reply_to_json");
    expect(columns).not.toContain("is_deleted");
    const outboxColumns = (old.prepare("PRAGMA table_info(outbox)").all() as { name: string }[]).map((c) => c.name);
    expect(outboxColumns).toContain("bcc_header");
    expect(outboxColumns).not.toContain("sent_copy_mime");
  });

  it("one outbox row per draft, enforced by the database", () => {
    store.createDraft(newDraft());
    store.queueOutbox(newOutbox(), 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO outbox (id, account_id, draft_id, message_id, subject, envelope_from, envelope_to_json,
             mime, state, send_after, created_at, updated_at)
           VALUES ('out_2', 'acc_1', 'd_1', '<x@example.org>', 's', 'a@example.org', '[]', x'00', 'queued', ?, ?, ?)`,
        )
        .run(T0, T0, T0),
    ).toThrow(/UNIQUE/);
  });

  it("saveAccount stays an upsert: mail, drafts and outbox survive an update", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.createDraft(newDraft());
    store.addAttachment("d_1", file([1, 2]));
    store.queueOutbox(newOutbox(), 1);
    store.saveAccount(
      makeStoredAccount({
        displayName: "Renamed",
        smtp: { host: "smtp.example.org", port: 465, security: "tls", username: "login" },
      }),
    );
    expect(store.getAccount("acc_1")).toMatchObject({
      displayName: "Renamed",
      smtp: { host: "smtp.example.org", port: 465, security: "tls", username: "login" },
      sentCopy: "append",
    });
    expect(count(db, "messages")).toBe(1);
    expect(count(db, "compose_drafts")).toBe(1);
    expect(count(db, "compose_attachments")).toBe(1);
    expect(count(db, "outbox")).toBe(1);
  });

  it("deleting the account deletes its drafts, attachments and outbox rows", () => {
    store.createDraft(newDraft());
    store.addAttachment("d_1", file([1, 2]));
    store.queueOutbox(newOutbox(), 1);
    store.deleteAccount("acc_1");
    for (const table of ["compose_drafts", "compose_attachments", "outbox", "accounts"]) {
      expect(count(db, table)).toBe(0);
    }
  });

  it("completeOutbox gives the blob pages back with incremental auto_vacuum", () => {
    const vacuumed = new Database(":memory:");
    vacuumed.pragma("auto_vacuum = INCREMENTAL");
    migrate(vacuumed);
    const s = createSqliteStore(vacuumed);
    s.saveAccount(makeStoredAccount());
    s.createDraft(newDraft());
    s.addAttachment("d_1", file(Array.from({ length: 300_000 }, (_, i) => i % 251)));
    s.queueOutbox(newOutbox({ mime: new Uint8Array(400_000).fill(7) }), 1);
    const pages = () => vacuumed.pragma("page_count", { simple: true }) as number;
    const before = pages();
    s.completeOutbox("out_1");
    expect(vacuumed.pragma("freelist_count", { simple: true })).toBe(0);
    expect(pages()).toBeLessThan(before);
  });

  it("stores Reply-To from sync", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { replyTo: [{ name: "List", address: "list@example.net" }] }),
    ]);
    expect(store.replySource(idOf(store, 1))).toMatchObject({
      replyTo: [{ name: "List", address: "list@example.net" }],
      replyToKnown: true,
    });
  });
});

describe.each(storeKinds)("slice-3b store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.com", createdAt: "2026-02-01T00:00:00.000Z" }));
  });

  describe("drafts", () => {
    it("create and read back at revision 1", () => {
      const created = s.createDraft(newDraft({ importHtml: { html: "<p>q</p>", into: "quote" }, references: ["<r@example.org>"] }));
      expect(created).toEqual({
        ...newDraft({ importHtml: { html: "<p>q</p>", into: "quote" }, references: ["<r@example.org>"] }),
        revision: 1,
        serverState: "none",
        updatedAt: T0,
      });
      expect(s.getDraft("d_1")).toEqual(created);
      expect(s.getDraft("nope")).toBeNull();
    });

    it("a draft continuing a foreign copy starts saved, pointing at it", () => {
      const copy = { folder: "Drafts", uidValidity: 7, uid: 41, revision: 1, size: 321 };
      expect(s.createDraft(newDraft({ serverCopy: copy }))).toMatchObject({ serverCopy: copy, serverState: "saved" });
      expect(s.draftForServerCopy("acc_1", "Drafts", 41)).toBe("d_1");
      expect(s.draftForServerCopy("acc_2", "Drafts", 41)).toBeNull();
      expect(s.draftForServerCopy("acc_1", "Drafts", 42)).toBeNull();
    });

    it("saveDraft is a compare-and-swap on the revision and clears the import", () => {
      s.createDraft(newDraft({ importHtml: { html: "<p>q</p>", into: "quote" } }));
      expect(s.saveDraft("d_1", 1, FIELDS, later(1000))).toEqual({ revision: 2 });
      expect(s.getDraft("d_1")).toMatchObject({ ...FIELDS, revision: 2, importHtml: null, updatedAt: later(1000) });
      expect(s.saveDraft("d_1", 1, { ...FIELDS, subject: "Stale" }, later(2000))).toEqual({ conflict: true, revision: 2 });
      expect(s.getDraft("d_1")!.subject).toBe("Changed");
      expect(() => s.saveDraft("nope", 1, FIELDS, T0)).toThrow();
    });

    it("saveImport stores the loaded import without bumping the revision or updatedAt, once", () => {
      s.createDraft(newDraft({ importHtml: { html: "<p>q</p>", into: "body" } }));
      const doc = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "q" }] }] };
      expect(s.saveImport("d_1", 1, doc)).toEqual({ revision: 1 });
      expect(s.getDraft("d_1")).toMatchObject({ doc, revision: 1, importHtml: null, updatedAt: T0 });
      expect(s.saveImport("d_1", 1, doc)).toEqual({ conflict: true, revision: 1 });
      s.createDraft(newDraft({ id: "d_2", importHtml: { html: "<p>q</p>", into: "body" } }));
      expect(s.saveImport("d_2", 0, doc)).toEqual({ conflict: true, revision: 1 });
      expect(() => s.saveImport("nope", 1, doc)).toThrow();
    });

    it("saveDraft answers conflict while a send of the draft is queued", () => {
      s.createDraft(newDraft());
      s.queueOutbox(newOutbox(), 1);
      expect(s.saveDraft("d_1", 1, FIELDS, T0)).toEqual({ conflict: true, revision: 1 });
      s.deleteOutbox("out_1", ["queued"]);
      expect(s.saveDraft("d_1", 1, FIELDS, T0)).toEqual({ revision: 2 });
    });

    it("lists an account's drafts oldest first", () => {
      s.createDraft(newDraft({ id: "d_b", createdAt: later(5) }));
      s.createDraft(newDraft({ id: "d_a", createdAt: later(1) }));
      s.createDraft(newDraft({ id: "d_c", accountId: "acc_2" }));
      expect(s.listDrafts("acc_1").map((d) => d.id)).toEqual(["d_a", "d_b"]);
      expect(s.listDrafts("acc_2").map((d) => d.id)).toEqual(["d_c"]);
    });

    it("records, clears and marks the server copy", () => {
      s.createDraft(newDraft());
      const copy = { folder: "Drafts", uidValidity: 7, uid: 3, revision: 1, size: 99 };
      s.recordServerCopy("d_1", copy);
      expect(s.getDraft("d_1")).toMatchObject({ serverCopy: copy, serverState: "saved" });
      s.setServerCopyState("d_1", "failed");
      expect(s.getDraft("d_1")).toMatchObject({ serverCopy: copy, serverState: "failed" });
      s.recordServerCopy("d_1", null);
      expect(s.getDraft("d_1")).toMatchObject({ serverCopy: null, serverState: "none" });
    });

    it("the synced copy of a draft's server copy carries its draftId", () => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Drafts", "drafts")]);
      s.upsertMessages("acc_1", "Drafts", [makeFetchedMessage(3, { messageId: "d1@example.org" })]);
      s.createDraft(newDraft());
      const id = idIn(s, "Drafts", 3);
      expect(s.getMessage(id)!.draftId).toBeNull();
      s.recordServerCopy("d_1", { folder: "Drafts", uidValidity: 7, uid: 3, revision: 1, size: 100 });
      expect(s.getMessage(id)!.draftId).toBe("d_1");
      s.assignThreads("acc_1", new Map());
      const threadId = s.getMessage(id)!.threadId;
      expect(s.getThread(threadId, "Drafts")!.messages.map((m) => m.draftId)).toEqual(["d_1"]);
    });

    it("deleting a draft deletes its attachments", () => {
      s.createDraft(newDraft());
      s.addAttachment("d_1", file([1]));
      s.deleteDraft("d_1");
      expect(s.getDraft("d_1")).toBeNull();
      expect(s.listAttachments("d_1")).toEqual([]);
    });
  });

  describe("attachments", () => {
    it("keep their order, bytes, hash and Content-ID; remove takes one", () => {
      s.createDraft(newDraft());
      const a = s.addAttachment("d_1", file([1, 2, 3], { fileName: "a.txt" }));
      const b = s.addAttachment("d_1", file([4], { fileName: "logo.png", contentId: "logo@example.org" }));
      expect(a).toEqual({ id: expect.any(String), fileName: "a.txt", mimeType: "text/plain", size: 3 });
      expect(s.listAttachments("d_1")).toEqual([a, b]);
      expect(s.attachmentData("d_1")).toEqual([
        { ...a, sha256: "a".repeat(64), contentId: null, data: new Uint8Array([1, 2, 3]) },
        { ...b, sha256: "a".repeat(64), contentId: "logo@example.org", data: new Uint8Array([4]) },
      ]);
      expect(s.removeAttachment("d_1", a.id)).toBe(true);
      expect(s.removeAttachment("d_1", a.id)).toBe(false);
      expect(s.removeAttachment("other", b.id)).toBe(false);
      const c = s.addAttachment("d_1", file([5], { fileName: "c.txt" }));
      expect(s.listAttachments("d_1").map((x) => x.id)).toEqual([b.id, c.id]);
    });

    it("are refused for a draft that does not exist", () => {
      expect(() => s.addAttachment("nope", file([1]))).toThrow();
    });
  });

  describe("outbox", () => {
    beforeEach(() => {
      s.createDraft(newDraft());
    });

    it("queues once per requestId and returns the existing row on a repeat", () => {
      const first = s.queueOutbox(newOutbox(), 1);
      expect(first).toEqual({
        created: true,
        row: {
          id: "out_1",
          accountId: "acc_1",
          draftId: "d_1",
          messageId: "<d1@example.org>",
          subject: "Invented draft",
          envelopeFrom: "owner@example.org",
          envelopeTo: ["bob@example.com", "hidden@example.net"],
          sendAfter: later(10_000),
          origin: "owner",
          createdAt: T0,
          state: "queued",
          attempts: 0,
          errorKind: null,
          rejected: [],
          updatedAt: T0,
        },
      });
      const again = s.queueOutbox(newOutbox({ subject: "Ignored" }), 7);
      expect(again).toEqual({ created: false, row: (first as { row: unknown }).row });
      expect(s.listOutbox(null)).toHaveLength(1);
      expect(s.outboxPayload("out_1")).toEqual({
        mime: newOutbox().mime,
        bccHeader: "Bcc: hidden@example.net\r\n",
      });
    });

    it("refuses a stale revision and a second live row for the draft", () => {
      expect(s.queueOutbox(newOutbox(), 0)).toEqual({ conflict: true });
      s.queueOutbox(newOutbox(), 1);
      expect(s.queueOutbox(newOutbox({ id: "out_2" }), 1)).toEqual({ conflict: true });
      expect(s.queueOutbox(newOutbox({ id: "out_3", draftId: "nope" }), 1)).toEqual({ conflict: true });
      expect(s.queueOutbox(newOutbox({ id: "out_4", draftId: null }), 0)).toMatchObject({ created: true });
      expect(s.listOutbox(null).map((r) => r.id)).toEqual(["out_1", "out_4"]);
    });

    it("lists rows without blobs, per account or all", () => {
      s.queueOutbox(newOutbox(), 1);
      s.queueOutbox(newOutbox({ id: "out_2", accountId: "acc_2", draftId: null, createdAt: later(1) }), 0);
      expect(s.listOutbox("acc_2").map((r) => r.id)).toEqual(["out_2"]);
      expect(s.listOutbox(null).map((r) => r.id)).toEqual(["out_1", "out_2"]);
      expect(Object.keys(s.listOutbox(null)[0]!)).not.toEqual(expect.arrayContaining(["mime"]));
      expect(Object.keys(s.listOutbox(null)[0]!)).not.toEqual(expect.arrayContaining(["bccHeader"]));
      expect(s.outboxPayload("nope")).toBeNull();
    });

    it("transitions only from the given states, with the patch", () => {
      s.queueOutbox(newOutbox(), 1);
      expect(s.transitionOutbox("out_1", ["sending"], "sent")).toBe(false);
      expect(
        s.transitionOutbox("out_1", ["queued", "held"], "failed", {
          errorKind: "connect",
          rejected: ["x@example.com"],
          sendAfter: later(99),
          countAttempt: true,
          updatedAt: later(5),
        }),
      ).toBe(true);
      expect(s.getOutbox("out_1")).toMatchObject({
        state: "failed",
        errorKind: "connect",
        rejected: ["x@example.com"],
        sendAfter: later(99),
        attempts: 1,
        updatedAt: later(5),
      });
      expect(s.transitionOutbox("out_1", ["failed"], "queued", { errorKind: null })).toBe(true);
      expect(s.getOutbox("out_1")).toMatchObject({ state: "queued", errorKind: null, updatedAt: later(5) });
      expect(s.transitionOutbox("nope", ["queued"], "sending")).toBe(false);
    });

    it("deletes only from the given states", () => {
      s.queueOutbox(newOutbox(), 1);
      expect(s.deleteOutbox("out_1", ["held"])).toBe(false);
      expect(s.deleteOutbox("out_1", ["queued", "held"])).toBe(true);
      expect(s.getOutbox("out_1")).toBeNull();
      expect(s.getDraft("d_1")).not.toBeNull();
    });

    it("claims the oldest due row of an account not busy, once", () => {
      s.createDraft(newDraft({ id: "d_2", accountId: "acc_2" }));
      s.createDraft(newDraft({ id: "d_3" }));
      s.queueOutbox(newOutbox({ id: "future", draftId: "d_3", sendAfter: later(60_000) }), 1);
      s.queueOutbox(newOutbox({ id: "late", sendAfter: later(9_000) }), 1);
      s.queueOutbox(newOutbox({ id: "early", accountId: "acc_2", draftId: "d_2", sendAfter: later(8_000) }), 1);
      const now = later(10_000);
      expect(s.claimDueOutbox(now, ["acc_2"])).toMatchObject({ id: "late", state: "sending", attempts: 1, updatedAt: now });
      expect(s.claimDueOutbox(now, ["acc_2"])).toBeNull();
      expect(s.claimDueOutbox(now, [])).toMatchObject({ id: "early", state: "sending" });
      expect(s.claimDueOutbox(now, [])).toBeNull();
      expect(s.getOutbox("future")!.state).toBe("queued");
    });

    it("peeks the next due row without claiming it, and claims one chosen row only while it is due", () => {
      s.createDraft(newDraft({ id: "d_3" }));
      s.queueOutbox(newOutbox({ id: "future", draftId: "d_3", sendAfter: later(60_000) }), 1);
      s.queueOutbox(newOutbox({ id: "late", sendAfter: later(9_000) }), 1);
      const now = later(10_000);
      expect(s.nextDueOutbox(now, [])).toMatchObject({ id: "late", state: "queued", attempts: 0 });
      expect(s.nextDueOutbox(now, ["acc_1"])).toBeNull();
      expect(s.claimDueOutbox(now, [], "future")).toBeNull();
      expect(s.getOutbox("future")!.state).toBe("queued");
      expect(s.claimDueOutbox(now, [], "late")).toMatchObject({ id: "late", state: "sending", attempts: 1 });
      expect(s.claimDueOutbox(now, [], "late")).toBeNull();
      expect(s.nextDueOutbox(now, [])).toBeNull();
    });

    it("recovers on start: sending → unknown, overdue queued → held, appending → sent", () => {
      for (const id of ["d_2", "d_3", "d_4", "d_5"]) s.createDraft(newDraft({ id }));
      s.queueOutbox(newOutbox({ id: "sending", sendAfter: later(1) }), 1);
      s.queueOutbox(newOutbox({ id: "overdue", draftId: "d_2", sendAfter: later(2) }), 1);
      s.queueOutbox(newOutbox({ id: "fresh", draftId: "d_3", sendAfter: later(60_000) }), 1);
      s.queueOutbox(newOutbox({ id: "appending", draftId: "d_4", sendAfter: later(1) }), 1);
      s.queueOutbox(newOutbox({ id: "failed", draftId: "d_5", sendAfter: later(1) }), 1);
      s.transitionOutbox("sending", ["queued"], "sending");
      s.transitionOutbox("appending", ["queued"], "appending");
      s.transitionOutbox("failed", ["queued"], "failed", { errorKind: "auth" });
      expect(s.hasSendingOutbox("acc_1")).toBe(true);
      expect(s.recoverOutboxOnStart(later(10_000))).toEqual({ unknown: 1, held: 1 });
      expect(
        Object.fromEntries(s.listOutbox(null).map((r) => [r.id, r.state])),
      ).toEqual({ sending: "unknown", overdue: "held", fresh: "queued", appending: "sent", failed: "failed" });
      expect(s.getOutbox("sending")!.errorKind).toBe("unknown_after_data");
      expect(s.hasSendingOutbox("acc_1")).toBe(false);
    });

    it("completeOutbox deletes the row and its draft with attachments", () => {
      s.addAttachment("d_1", file([1]));
      s.queueOutbox(newOutbox(), 1);
      s.completeOutbox("out_1");
      expect(s.getOutbox("out_1")).toBeNull();
      expect(s.getDraft("d_1")).toBeNull();
      expect(s.listAttachments("d_1")).toEqual([]);
      s.completeOutbox("out_1");
    });

    it("hasSendingOutbox is per account", () => {
      s.queueOutbox(newOutbox(), 1);
      expect(s.hasSendingOutbox("acc_1")).toBe(false);
      s.claimDueOutbox(later(10_000), []);
      expect(s.hasSendingOutbox("acc_1")).toBe(true);
      expect(s.hasSendingOutbox("acc_2")).toBe(false);
    });

    it("deleting the account deletes its drafts and rows, not another account's", () => {
      s.createDraft(newDraft({ id: "d_2", accountId: "acc_2" }));
      s.queueOutbox(newOutbox(), 1);
      s.queueOutbox(newOutbox({ id: "out_2", accountId: "acc_2", draftId: "d_2" }), 1);
      s.deleteAccount("acc_1");
      expect(s.getDraft("d_1")).toBeNull();
      expect(s.listOutbox(null).map((r) => r.id)).toEqual(["out_2"]);
      expect(s.getDraft("d_2")).not.toBeNull();
    });
  });

  describe("replySource", () => {
    it("returns the stored header fields of the message", () => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, {
          from: { name: "Anna", address: "anna@example.org" },
          to: [{ name: null, address: "owner@example.org" }],
          cc: [{ name: "Carl", address: "carl@example.com" }],
          replyTo: [{ name: null, address: "list@example.net" }],
          subject: "Garden",
          date: "Sat, 14 Nov 2026 09:05:00 +0000",
          messageId: "m1@example.org",
          inReplyTo: "p@example.org",
          references: ["r@example.org", "p@example.org"],
        }),
      ]);
      expect(s.replySource(idOf(s, 1))).toEqual({
        accountId: "acc_1",
        folder: INBOX,
        from: { name: "Anna", address: "anna@example.org" },
        to: [{ name: null, address: "owner@example.org" }],
        cc: [{ name: "Carl", address: "carl@example.com" }],
        replyTo: [{ name: null, address: "list@example.net" }],
        replyToKnown: true,
        subject: "Garden",
        date: "2026-11-14T09:05:00.000Z",
        messageId: "m1@example.org",
        inReplyTo: "p@example.org",
        references: ["r@example.org", "p@example.org"],
      });
      expect(s.replySource("nope")).toBeNull();
    });
  });

  describe("recipientSuggestions", () => {
    beforeEach(() => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Sent", "sent")]);
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { from: { name: "Bella Stone", address: "bella@example.com" }, date: "2026-11-01T00:00:00.000Z" }),
        makeFetchedMessage(2, { from: { name: "Ben", address: "ben@example.org" }, date: "2026-11-10T00:00:00.000Z" }),
        makeFetchedMessage(3, { from: { name: null, address: "BEN@example.org" }, date: "2026-11-02T00:00:00.000Z" }),
        makeFetchedMessage(4, { from: { name: "Otto", address: "otto@example.net" }, cc: [{ name: "Bram", address: "bram@example.net" }], date: "2026-11-11T00:00:00.000Z" }),
      ]);
      s.upsertMessages("acc_1", "Sent", [
        makeFetchedMessage(1, {
          from: { name: "Owner", address: "owner@example.org" },
          to: [{ name: "Bob Sent", address: "bob@example.com" }],
          date: "2026-10-01T00:00:00.000Z",
        }),
      ]);
    });

    it("puts addresses the owner sent to first, then the most recent, case-folded and deduped", () => {
      expect(s.recipientSuggestions("b", 10)).toEqual([
        { name: "Bob Sent", address: "bob@example.com" },
        { name: "Bram", address: "bram@example.net" },
        { name: "Ben", address: "ben@example.org" },
        { name: "Bella Stone", address: "bella@example.com" },
      ]);
    });

    it("matches a word of the display name and honours the limit", () => {
      expect(s.recipientSuggestions("sto", 10)).toEqual([{ name: "Bella Stone", address: "bella@example.com" }]);
      expect(s.recipientSuggestions("B", 2)).toHaveLength(2);
      expect(s.recipientSuggestions("zz", 10)).toEqual([]);
      expect(s.recipientSuggestions("%", 10)).toEqual([]);
    });
  });
});
