import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../../core/threading.ts";
import type { AccountScope, AiScope } from "../../core/ai-scope.ts";
import type { LogEntry } from "../../core/agent-log.ts";
import { CATEGORY_RULES_MAX } from "../../core/categories.ts";
import { dismissalKey } from "../../core/digest.ts";
import type { NewDraft, NewOutboxRow, ParsedQuery, RemoteFolder } from "../../core/model.ts";
import {
  AI_RESULT_MAX_BYTES,
  BINDINGS_MAX,
  TASKS_OPEN_MAX,
  type AiResultRecord,
  type BbLinkRow,
  type NewRuleRun,
  type MailStore,
  type SearchOptions,
  type NewProposal,
  type NewReminder,
  type NewTask,
  type TranslationRecord,
} from "../../core/ports.ts";
import { REMINDERS_LIVE_MAX, dueAt } from "../../core/reminders.ts";
import { parseQuery } from "../../core/search.ts";
import { fileKindOf } from "../../core/file-kinds.ts";
import type { SearchCursor } from "../../core/model.ts";
import { RULES_MAX, type Rule } from "../../core/mail-rules.ts";
import { TRANSLATION_CACHE_ROWS } from "../../core/translate.ts";
import type { UnsubscribeInfo } from "../../core/unsubscribe.ts";
import {
  InMemoryMailStore,
  makeFetchedMessage,
  makeStoredAccount,
} from "../../core/testing/fakes.ts";
import { MIGRATIONS, createSqliteStore, hardenDatabase } from "./sqlite-store.ts";
import { senderCheckOf, type SenderCheck } from "../../core/sender-check.ts";

const INBOX = "INBOX";
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Bound for one timed store call (one page); generous against parallel load (spec 3f resolution 19). */
const PAGE_MS = 250;
/** Test timeout for tests that seed thousands of rows; seeding is never inside a timed span. */
const SEEDING_TIMEOUT_MS = 60_000;
/** Bound for the store's part of one sync round at scale (slice 3j). */
const ROUND_MS = 1_500;

/** Times one call alone. */
function timeOne<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

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
      snoozedUntil: null,
      category: null,
      categorySuggestion: null,
      projectId: null,
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
      kept: null,
      labels: [],
      to: [{ name: null, address: "owner@example.org" }],
      cc: [{ name: "Copy", address: "copy@example.org" }],
      attachments: [
        { partId: "2", filename: "plan.txt", mimeType: "text/plain", size: 12, isInline: false, kind: "text" },
      ],
      draftId: null,
      agentSubject: "Re: Invented plan",
      inAiScope: true,
      devLinks: [],
      dev: null,
      patch: null,
      alert: false,
      bbLinks: [],
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

  it("detachedRows lists the folder's detached rows with their Message-ID and Gmail id", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { messageId: "a@example.org", gmMsgId: "77" }),
      makeFetchedMessage(2, { messageId: null }),
    ]);
    const [a, b] = [idOf(store, 1), idOf(store, 2)];
    expect(store.detachedRows("acc_1", INBOX)).toEqual([]);
    store.beginFolderReset("acc_1", INBOX);
    expect(store.detachedRows("acc_1", INBOX).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: a, messageId: "a@example.org", gmMsgId: "77" },
        { id: b, messageId: null, gmMsgId: null },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(store.detachedRows("acc_1", "Archive")).toEqual([]);
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
    expect(store.search(parseQuery("Invented"), null, 50)).toEqual([]);
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
    const results = store.search(parseQuery("квартал"), "acc_1", 50);
    expect(results.map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(results[0]).toMatchObject({ subject: "Отчёт за квартал", accountId: "acc_1" });
    expect(store.search(parseQuery("ОТЧЁТ"), null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
  });

  it("search follows content updates and survives flag-only updates", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented alpha" })]);
    const id = idOf(store, 1);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented omega" })]);
    store.markOpened(id);
    store.applyFlags("acc_1", INBOX, [{ uid: 1, seen: true, flagged: true }]);
    store.assignThreads("acc_1", new Map([[id, "t_other"]]));
    expect(store.search(parseQuery("alpha"), null, 50)).toEqual([]);
    expect(store.search(parseQuery("omega"), null, 50).map((r) => r.id)).toEqual([id]);
  });

  it("search ignores control characters in the text", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Invented hello" })]);
    expect(store.search(parseQuery("hel\u0000lo\u001f\u007f"), null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(() => store.search(parseQuery("\u0000\u0001"), null, 50)).not.toThrow();
  });

  it("subject: filter matches Cyrillic regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Отчёт за квартал" }),
      makeFetchedMessage(2, { subject: "Invented other" }),
    ]);
    expect(store.search(parseQuery("subject:отчёт"), null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(store.search(parseQuery("subject:КВАРТАЛ"), null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
  });

  it("from: filter matches Cyrillic regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { from: { name: "Иван Петров", address: "ivan@example.org" } }),
      makeFetchedMessage(2),
    ]);
    expect(store.search(parseQuery("from:иван"), null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
    expect(store.search(parseQuery("from:ПЕТРОВ"), null, 50).map((r) => r.id)).toEqual([
      idOf(store, 1),
    ]);
  });

  it("2-character Cyrillic query matches regardless of case", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Юг и север" }),
      makeFetchedMessage(2, { subject: "Invented other" }),
    ]);
    expect(store.search(parseQuery("юг"), null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(store.search(parseQuery("ЮГ"), null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
  });

  it("search with a 2-character query falls back to LIKE", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Hi there" }),
      makeFetchedMessage(2, { subject: "Invented", bodyText: "hi in the body only" }),
      makeFetchedMessage(3, { subject: "Invented", from: { name: "Hilda", address: "h@example.org" } }),
    ]);
    const ids = store.search(parseQuery("hi"), null, 50).map((r) => r.id);
    expect(ids.sort()).toEqual([idOf(store, 1), idOf(store, 3)].sort());
    expect(store.search(parseQuery("%"), null, 50)).toEqual([]);
  });

  it("search escapes quotes in the query", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: 'Say "hello" now' })]);
    expect(store.search(parseQuery('"hello"'), null, 50).map((r) => r.id)).toEqual([idOf(store, 1)]);
    expect(() => store.search(parseQuery('a"b OR c'), null, 50)).not.toThrow();
    // "zzzz" occurs nowhere: a live OR operator would still match on "hello".
    expect(store.search(parseQuery("hello OR zzzz"), null, 50)).toEqual([]);
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
    expect(ids(parseQuery("budget"))).toEqual([idOf(store, 3), idOf(store, 2), idOf(store, 1)]);
    expect(ids(parseQuery("budget"), 1)).toEqual([idOf(store, 3)]);
    expect(ids(parseQuery("from:boss"))).toEqual([idOf(store, 3)]);
    expect(ids(parseQuery("subject:budget is:unread"))).toEqual([idOf(store, 3), idOf(store, 1)]);
    expect(ids(parseQuery("is:read"))).toEqual([idOf(store, 2)]);
    expect(ids(parseQuery("after:2026-11-05 before:2026-11-09"))).toEqual([idOf(store, 2)]);
    expect(store.search(parseQuery("budget"), "acc_other", 50)).toEqual([]);
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
      store.search(parseQuery("Invented"), null, 10),
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
  return { path, name: path.split("/").pop()!, delimiter: "/", specialUse, selectable: true, subscribed: true, ...overrides };
}

function idIn(target: MailStore, folder: string, uid: number, accountId = "acc_1"): string {
  const entry = target.localFolderIndex(accountId, folder, EPOCH).find((e) => e.uid === uid);
  if (!entry) throw new Error(`uid ${uid} not stored in ${folder}`);
  return entry.id;
}

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * The account of makeStoredAccount() in a database that is not fully
 * migrated: written as SQL, because the store's own saveAccount names the
 * columns of the newest schema.
 */
function seedLegacyAccount(db: Database.Database): void {
  db.prepare(
    `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
     VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner@example.org', 'sealed-password', 'other', '2026-01-01T00:00:00.000Z')`,
  ).run();
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
    expect(MIGRATIONS.slice(0, 19).map(sha)).toEqual([
      "023f294a929e0c6d2aea10f38acb89287dbeba167e67f2b31c85103fd74ec5b4",
      "e34d0e9cbe94c27a6da39809436d656dcf4f787e1d35dd82fef86889bb22758f",
      "9430a1b0edb5ab94a14189c472a81384b3869786c2c5c56a00a56c2b02097396",
      "d32d0c6bafc6b6259c1bf6448fe0a24ee944f1c46dd8cf87e0e443eb7301103c",
      "910621e83320dbef912d682fbb78f4016bb53ea56704075fd1e578a7890a538f",
      // Element 5 (slice 3c: proposals and translations).
      "4f2e79c7b40711c0a250c3b9ff33cf72bddaa9d70add62c0f55987f31a30159a",
      // Element 6 (contacts for agents: the bulk mark).
      "9a3600bb2258106be36ee09df0c166b054fd998f4bc790be89966fc2877fac4c",
      // Element 7 (slice 3d: identities, templates, sent recipients, Delivered-To).
      "b068f80717cecc2be2da1c37047e165dc457f94ce76a60dd90177b6544b76bfa",
      // Element 8 (slice 3e: unsubscribe, snooze, block, spam seen, triage).
      "309cd3824aec0944be980f7eb7ee1a7ae0b11f23c8f796fc425900f21f25e2f2",
      // Element 9 (slice 3e review: namespaced unsubscribe list keys).
      "3879e176864850515f3b6b28845843c8cd4bdbf96a05b268e21bbe086c89aa19",
      // Element 10 (slice 3f: AI access, the agent log, AI results, tasks, categories, Today, reminders).
      "7fb5168f63a78ec868ee8302d7f4b24f565b6c22a018ce01e6635857a52ecb2f",
      // Element 11 (slice 3g: dev columns, list_id, BB links, bindings, incidents, mail rules and runs).
      "fc77dbcbd543d0c12209f9e3a00560ed06a257fdc34fd8d8433886d16c8b26dd",
      // Element 12 (slice 3g review: the rule-thread gate and caps outlive the mail).
      "e4714d9efb12775f4b66b49f5d831a93df288b19004a05c29ab72cf73cf2d3d8",
      // Element 13 (slice 3h: kept rows, Gmail labels, attachment kinds and text, saved searches, folder prefs).
      "9308a59ee243d1fcd946a94f35d8c86665cafd9d5ea6bb822af0f47b936ad4ba",
      // Element 14 (slice 3i: sender check, read receipt request, crypto kind).
      "85e10b2409d979ca08535d7c9a7b495375e014126b9b16ab645be6f16c189d79",
      // Element 15 (slice 3k: OpenPGP keys).
      "692137cda01ae3f12987900d2ec20feae427352122f78ddb1b5a515c73c1b93a",
      // Element 16 (slice 3l: the scheduled mark of a "Send later" row).
      "62597e0677e25aefadc475f6a6afadbc30e89474c48400d85c576bc82b14e929",
      // Element 17 (slice 3m: filters).
      "32a4f62febff3500b7c877687dc2defc39bc8ab3a4fc4620b1761953fa1f380c",
      // Element 18 (slice 3p: local archives).
      "484e585d5c158287c94e3370663b0c697d3fcdd065de9a9decbc1ca1e054e3a7",
    ]);
  });

  describe("credential kind (migration 19)", () => {
    it("keeps an account's kind and granted scopes", () => {
      const db = new Database(":memory:");
      db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
      const s = createSqliteStore(db);
      s.saveAccount(makeStoredAccount({ authKind: "google", grantedScopes: ["openid", "email"] }));
      expect(s.getAccount("acc_1")).toMatchObject({ authKind: "google", grantedScopes: ["openid", "email"] });
      s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
      expect(s.getAccount("acc_2")).toMatchObject({ authKind: "password", grantedScopes: [] });
    });

    it("an account from before the migration is a password account", () => {
      const db = new Database(":memory:");
      db.transaction(() => MIGRATIONS.slice(0, 19).forEach((statement) => db.exec(statement)))();
      db.prepare(
        `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
         VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner', 'sealed', 'other', ?)`,
      ).run("2026-01-01T00:00:00.000Z");
      db.transaction(() => MIGRATIONS.slice(19).forEach((statement) => db.exec(statement)))();
      expect(MIGRATIONS).toHaveLength(21);
      expect(createSqliteStore(db).getAccount("acc_1")).toMatchObject({ authKind: "password", grantedScopes: [], passwordSealed: "sealed" });
    });
  });

  describe("plugin access", () => {
    const at = "2026-11-19T10:00:00.000Z";
    const later = "2026-11-19T11:00:00.000Z";
    const open = () => {
      const db = new Database(":memory:");
      db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
      seedLegacyAccount(db);
      return { db, store: createSqliteStore(db) };
    };

    it("a grant is set once, listed, and removed", () => {
      const { store } = open();
      const grant = { pluginId: "crm", right: "mail.read", accountId: "acc_1", grantedAt: at } as const;
      store.setPluginGrant(grant, true);
      store.setPluginGrant({ ...grant, grantedAt: later }, true);
      expect(store.listPluginGrants()).toEqual([grant]);
      store.setPluginGrant(grant, false);
      expect(store.listPluginGrants()).toEqual([]);
    });

    it("removing an account removes its grants and leaves the others", () => {
      const { db, store } = open();
      db.prepare(
        `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
         VALUES ('acc_2', 'second@example.net', 'imap.example.net', 993, 'second', 'sealed', 'other', ?)`,
      ).run(at);
      store.setPluginGrant({ pluginId: "crm", right: "mail.read", accountId: "acc_1", grantedAt: at }, true);
      store.setPluginGrant({ pluginId: "crm", right: "mail.read", accountId: "acc_2", grantedAt: at }, true);
      store.deleteAccount("acc_1");
      expect(store.listPluginGrants().map((grant) => grant.accountId)).toEqual(["acc_2"]);
    });

    it("a plugin has one pending request; both times are kept for the limit", () => {
      const { store } = open();
      store.putPluginRequest({ pluginId: "calendar", rights: ["mail.read"], reason: "First", askedAt: at });
      store.putPluginRequest({ pluginId: "calendar", rights: ["invites.read", "mail.propose"], reason: "Second", askedAt: later });
      expect(store.getPluginRequests()).toEqual([
        { pluginId: "calendar", rights: ["invites.read", "mail.propose"], reason: "Second", askedAt: later },
      ]);
      expect(store.pluginRequestTimes("calendar")).toEqual([later, at]);
      expect(store.pluginRequestTimes("crm")).toEqual([]);
      store.dismissPluginRequest("calendar");
      expect(store.getPluginRequests()).toEqual([]);
      expect(store.pluginRequestTimes("calendar")).toEqual([later, at]);
    });

    it("revoking a plugin drops its grants and its request, not another plugin's", () => {
      const { store } = open();
      store.setPluginGrant({ pluginId: "crm", right: "mail.read", accountId: "acc_1", grantedAt: at }, true);
      store.setPluginGrant({ pluginId: "calendar", right: "invites.read", accountId: "acc_1", grantedAt: at }, true);
      store.putPluginRequest({ pluginId: "crm", rights: ["contacts.read"], reason: "", askedAt: at });
      store.revokePluginGrants("crm");
      expect(store.listPluginGrants().map((grant) => grant.pluginId)).toEqual(["calendar"]);
      expect(store.getPluginRequests()).toEqual([]);
    });

    it("element 20 on a database from before it adds the tables and the draft column", () => {
      const db = new Database(":memory:");
      db.transaction(() => MIGRATIONS.slice(0, 20).forEach((statement) => db.exec(statement)))();
      seedLegacyAccount(db);
      db.transaction(() => MIGRATIONS.slice(20).forEach((statement) => db.exec(statement)))();
      expect(MIGRATIONS).toHaveLength(21);
      expect(createSqliteStore(db).listPluginGrants()).toEqual([]);
      const columns = db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('compose_drafts')").all();
      expect(columns.map((column) => column.name)).toContain("prepared_by");
    });
  });

  describe("local archives (slice 3p)", () => {
    const at = "2026-11-17T10:00:00.000Z";
    const open = () => {
      const db = new Database(":memory:");
      db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
      return { db, s: createSqliteStore(db) };
    };
    const archive = (id: string, sourcePath = `/invented/${id}.mbox`) => ({
      id,
      name: `Invented ${id}`,
      sourcePath,
      kind: "mbox" as const,
      sourceSize: 1000,
      messages: 0,
      skipped: 0,
      complete: false,
      resumeAt: 0,
      createdAt: at,
      updatedAt: at,
    });
    const message = (offset: number, overrides: Record<string, unknown> = {}) => ({
      file: "",
      offset,
      length: 100,
      rawHash: `hash-${offset}`,
      messageId: `<m-${offset}@example.org>`,
      from: { name: "Ana Example", address: "ana@example.com" },
      to: [{ name: null, address: "owner@example.org" }],
      cc: [],
      subject: `Invented subject ${offset}`,
      date: `2020-01-${String(10 + offset).padStart(2, "0")}T08:00:00.000Z`,
      snippet: "Invented snippet",
      bodyText: `Invented body ${offset} about the orchard`,
      bodyHtml: "<p>Invented</p>",
      htmlTruncated: false,
      attachments: [],
      size: 100,
      ...overrides,
    });
    const progress = (overrides: Record<string, unknown> = {}) => ({ resumeAt: 0, skipped: 0, complete: false, nowIso: at, ...overrides });

    it("keeps archives apart from mailboxes: no message, thread, unread count or search hit of live mail", () => {
      const { db, s } = open();
      s.createArchive(archive("arc_1"));
      expect(s.appendArchiveMessages("arc_1", [message(1), message(2)], progress({ complete: true, resumeAt: 1000 }))).toBe(2);
      expect(s.getArchive("arc_1")).toMatchObject({ messages: 2, complete: true, resumeAt: 1000 });
      expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 0 });
      expect(s.unreadCount(null)).toBe(0);
      expect(s.search(parseQuery("orchard"), null, 10)).toEqual([]);
    });

    it("pages newest first with undated rows last, and searches the subject, the sender and the text", () => {
      const { s } = open();
      s.createArchive(archive("arc_1"));
      s.createArchive(archive("arc_2"));
      s.appendArchiveMessages(
        "arc_1",
        [message(1), message(2, { date: null }), message(3), message(4, { subject: "Quarterly zebra report", attachments: [{ partId: "1", filename: "a.pdf", mimeType: "application/pdf", size: 5, isInline: false }] })],
        progress(),
      );
      s.appendArchiveMessages("arc_2", [message(5, { from: { name: "Bob", address: "bob@example.net" }, bodyText: "pelican" })], progress());
      const first = s.archiveMessages("arc_1", { query: "", limit: 2, cursor: null });
      expect(first.rows.map((r) => r.subject)).toEqual(["Quarterly zebra report", "Invented subject 3"]);
      expect(first.rows[0]).toMatchObject({ archiveId: "arc_1", hasAttachments: true, from: { name: "Ana Example", address: "ana@example.com" } });
      const second = s.archiveMessages("arc_1", { query: "", limit: 2, cursor: first.nextCursor });
      expect(second.rows.map((r) => r.subject)).toEqual(["Invented subject 1", "Invented subject 2"]);
      expect(second.nextCursor).toBeNull();
      expect(s.archiveMessages(null, { query: "", limit: 10, cursor: null }).rows).toHaveLength(5);
      expect(s.archiveMessages(null, { query: "zebra", limit: 10, cursor: null }).rows.map((r) => r.subject)).toEqual(["Quarterly zebra report"]);
      expect(s.archiveMessages(null, { query: "pelican", limit: 10, cursor: null }).rows.map((r) => r.archiveId)).toEqual(["arc_2"]);
      expect(s.archiveMessages("arc_1", { query: "pelican", limit: 10, cursor: null }).rows).toEqual([]);
      expect(s.archiveMessages(null, { query: "bob@example.net", limit: 10, cursor: null }).rows).toHaveLength(1);
      // Two characters: a plain match on the subject and the sender, and no syntax of the index gets through.
      expect(s.archiveMessages(null, { query: "Bo", limit: 10, cursor: null }).rows).toHaveLength(1);
      expect(s.archiveMessages(null, { query: 'zebra" OR subject:*', limit: 10, cursor: null }).rows).toEqual([]);
    });

    it("gives one message with its place in the source, and continues an import without doubling", () => {
      const { s } = open();
      s.createArchive(archive("arc_1"));
      s.appendArchiveMessages("arc_1", [message(1), message(2)], progress({ resumeAt: 250 }));
      // The same batch again (an import that was stopped and run again), plus one new message.
      expect(s.appendArchiveMessages("arc_1", [message(2), message(3)], progress({ resumeAt: 400, skipped: 1, complete: true }))).toBe(1);
      expect(s.getArchive("arc_1")).toMatchObject({ messages: 3, skipped: 1, complete: true, resumeAt: 400 });
      const [newest] = s.archiveMessages("arc_1", { query: "", limit: 1, cursor: null }).rows;
      expect(s.archiveMessage(newest!.id)).toEqual({
        message: {
          id: newest!.id,
          archiveId: "arc_1",
          date: "2020-01-13T08:00:00.000Z",
          from: { name: "Ana Example", address: "ana@example.com" },
          subject: "Invented subject 3",
          snippet: "Invented snippet",
          hasAttachments: false,
          to: [{ name: null, address: "owner@example.org" }],
          cc: [],
          text: "Invented body 3 about the orchard",
          html: "<p>Invented</p>",
          htmlTruncated: false,
          attachments: [],
        },
        place: { archiveId: "arc_1", file: "", offset: 3, length: 100, rawHash: "hash-3" },
      });
      expect(s.archiveMessage("nope")).toBeNull();
      expect(s.archiveMessage("999")).toBeNull();
    });

    it("removes an archive with its messages and its search entries, caps the number of archives, and finds one by its source", () => {
      const { db, s } = open();
      s.createArchive(archive("arc_1"));
      s.createArchive(archive("arc_2"));
      s.appendArchiveMessages("arc_1", [message(1)], progress());
      s.appendArchiveMessages("arc_2", [message(1, { subject: "Kept zebra" })], progress());
      expect(s.findArchiveBySource("/invented/arc_2.mbox")?.id).toBe("arc_2");
      expect(s.findArchiveBySource("/invented/nope.mbox")).toBeNull();
      expect(s.removeArchive("arc_1")).toBe(true);
      expect(s.removeArchive("arc_1")).toBe(false);
      expect(s.listArchives().map((a) => a.id)).toEqual(["arc_2"]);
      expect(s.archiveMessages(null, { query: "Invented subject", limit: 10, cursor: null }).rows).toEqual([]);
      expect(s.archiveMessages(null, { query: "zebra", limit: 10, cursor: null }).rows).toHaveLength(1);
      expect(db.prepare("SELECT count(*) AS n FROM archive_messages").get()).toEqual({ n: 1 });
      for (let i = 3; i <= 21; i++) s.createArchive(archive(`arc_${i}`));
      expect(s.listArchives()).toHaveLength(20);
      expect(s.createArchive(archive("arc_over"))).toEqual({ full: true });
    });
  });

  it("filters keep the order they were made in, an edit keeps its place, and the list is capped (slice 3m)", () => {
    const db = new Database(":memory:");
    db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
    const s = createSqliteStore(db);
    const at = "2026-11-17T10:00:00.000Z";
    const make = (id: string, name = id) => ({
      id,
      name,
      enabled: true,
      match: { domains: ["news.example.com"], accounts: ["acc_1"] },
      actions: { move: "folder" as const, folder: "Lists", markRead: true, flag: false },
    });
    // Ids out of order, all made in one instant.
    for (const id of ["flt_z", "flt_a", "flt_m"]) expect(s.saveMailFilter(make(id), at)).toEqual({ filter: make(id) });
    expect(s.listMailFilters().map((f) => f.id)).toEqual(["flt_z", "flt_a", "flt_m"]);
    s.saveMailFilter({ ...make("flt_z", "Renamed"), enabled: false }, "2026-11-18T10:00:00.000Z");
    expect(s.listMailFilters().map((f) => [f.id, f.name, f.enabled])).toEqual([
      ["flt_z", "Renamed", false],
      ["flt_a", "flt_a", true],
      ["flt_m", "flt_m", true],
    ]);
    expect(s.deleteMailFilter("flt_a")).toBe(true);
    expect(s.deleteMailFilter("flt_a")).toBe(false);
    for (let i = 0; i < 48; i++) s.saveMailFilter(make(`flt_${i}`), at);
    expect(s.listMailFilters()).toHaveLength(50);
    expect(s.saveMailFilter(make("flt_over"), at)).toEqual({ full: true });
    // An edit of an existing one still goes through at the cap.
    expect(s.saveMailFilter(make("flt_m", "Edited"), at)).toMatchObject({ filter: { name: "Edited" } });
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

    // Each page call is timed alone (spec 3f resolution 19); seeding never is.
    for (const [folder, n] of folders) {
      let cursor: string | null = null;
      let listed = 0;
      do {
        const after: string | null = cursor;
        const { value: page, ms } = timeOne((): ReturnType<MailStore["listThreads"]> => store.listThreads("acc_1", folder, after, 50));
        // Generous bound against parallel load; measured locally in single-digit ms per page.
        expect(ms, `${folder} page`).toBeLessThan(PAGE_MS);
        listed += page.threads.length;
        cursor = page.nextCursor;
      } while (cursor !== null && listed < 200);
      expect(listed).toBe(Math.min(n, 200));
    }
    expect(timeOne(() => store.listFolders("acc_1")).ms).toBeLessThan(PAGE_MS);
    expect(timeOne(() => store.unreadCount(null)).ms).toBeLessThan(PAGE_MS);
  }, SEEDING_TIMEOUT_MS);

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
      subscribed: true,
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
    expect(s.search(parseQuery("Invented subject 1"), "acc_1", 10)).toEqual([]);
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
    const hits = s.search(parseQuery("Invented"), null, 10);
    expect(hits.map((h) => h.folder).sort()).toEqual([ALL_MAIL, INBOX].sort());
    expect(hits.find((h) => h.subject === "Invented subject 1")?.folder).toBe(INBOX);
    expect(s.search(parseQuery("Invented"), "acc_1", 1)).toHaveLength(1);
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
    expect(s.search(parseQuery('subject:"Invented subject"'), "acc_1", 10)).toHaveLength(2);
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

    let cursor: string | null = null;
    let listed = 0;
    do {
      const after: string | null = cursor;
      const { value: page, ms } = timeOne((): ReturnType<MailStore["listThreadsAll"]> => store.listThreadsAll("inbox", after, 50));
      expect(ms).toBeLessThan(PAGE_MS);
      listed += page.threads.length;
      cursor = page.nextCursor;
    } while (cursor !== null && listed < 200);
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
  }, SEEDING_TIMEOUT_MS);

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
    fromAddress: null,
    origin: "owner",
    proposalId: null,
    purpose: null,
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
  fromAddress: null,
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
        preparedBy: null,
        revision: 1,
        serverState: "none",
        updatedAt: T0,
      });
      expect(s.getDraft("d_1")).toEqual(created);
      expect(s.getDraft("nope")).toBeNull();
    });

    it("stores an agent origin", () => {
      expect(s.createDraft(newDraft({ origin: "agent" }))).toMatchObject({ origin: "agent", proposalId: null });
      expect(s.getDraft("d_1")?.origin).toBe("agent");
    });

    it("a draft continuing a foreign copy starts saved, pointing at it", () => {
      const copy = { folder: "Drafts", uidValidity: 7, uid: 41, revision: 1, size: 321 };
      expect(s.createDraft(newDraft({ serverCopy: copy }))).toMatchObject({ serverCopy: copy, serverState: "saved" });
      expect(s.draftForServerCopy("acc_1", "Drafts", 41)).toBe("d_1");
      expect(s.draftForServerCopy("acc_2", "Drafts", 41)).toBeNull();
      expect(s.draftForServerCopy("acc_1", "Drafts", 42)).toBeNull();
    });

    it("finds the draft continuing a foreign message, never a reply or forward of it", () => {
      s.createDraft(newDraft({ id: "d_r", kind: "reply", sourceMessageId: "m_9" }));
      expect(s.draftContinuing("m_9")).toBeNull();
      s.createDraft(newDraft({ sourceMessageId: "m_9" }));
      expect(s.draftContinuing("m_9")).toBe("d_1");
      expect(s.draftContinuing("m_8")).toBeNull();
      s.deleteDraft("d_1");
      expect(s.draftContinuing("m_9")).toBeNull();
    });

    it("renewMessageId gives the draft another Message-ID and nothing else", () => {
      s.createDraft(newDraft());
      s.renewMessageId("d_1", "<fresh@example.org>");
      expect(s.getDraft("d_1")).toEqual({
        ...newDraft({ messageId: "<fresh@example.org>" }),
        preparedBy: null,
        revision: 1,
        serverState: "none",
        updatedAt: T0,
      });
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
      expect(a).toEqual({ id: expect.any(String), fileName: "a.txt", mimeType: "text/plain", size: 3, origin: null });
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
          scheduled: false,
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

    it("claims a waiting row once it is due, and leaves it alone on a restart (slice 3j)", () => {
      s.queueOutbox(newOutbox({ sendAfter: later(1_000) }), 1);
      expect(s.claimDueOutbox(later(1_000), [])).toMatchObject({ state: "sending", attempts: 1 });
      expect(
        s.transitionOutbox("out_1", ["sending"], "waiting", { errorKind: "connect", sendAfter: later(61_000) }),
      ).toBe(true);
      expect(s.nextDueOutbox(later(60_000), [])).toBeNull();
      expect(s.recoverOutboxOnStart(later(70_000))).toEqual({ unknown: 0, held: 0 });
      expect(s.getOutbox("out_1")).toMatchObject({ state: "waiting", errorKind: "connect" });
      expect(s.claimDueOutbox(later(70_000), [])).toMatchObject({ id: "out_1", state: "sending", attempts: 2 });
      expect(s.claimDueOutbox(later(70_000), [])).toBeNull();
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

    it("a scheduled send survives a restart: under a day late it stays queued, later it is held (slice 3l)", () => {
      const DAY = 86_400_000;
      for (const id of ["d_2", "d_3"]) s.createDraft(newDraft({ id }));
      s.queueOutbox(newOutbox({ id: "late", sendAfter: later(1_000), scheduled: true }), 1);
      s.queueOutbox(newOutbox({ id: "stale", draftId: "d_2", sendAfter: later(500), scheduled: true }), 1);
      s.queueOutbox(newOutbox({ id: "ahead", draftId: "d_3", sendAfter: later(3 * DAY), scheduled: true }), 1);
      expect(s.getOutbox("late")).toMatchObject({ state: "queued", scheduled: true });
      expect(s.recoverOutboxOnStart(later(DAY + 700))).toEqual({ unknown: 0, held: 1 });
      expect(Object.fromEntries(s.listOutbox(null).map((r) => [r.id, r.state]))).toEqual({
        late: "queued",
        stale: "held",
        ahead: "queued",
      });
      expect(s.transitionOutbox("stale", ["held"], "queued", { sendAfter: later(DAY + 800), scheduled: false })).toBe(true);
      expect(s.getOutbox("stale")).toMatchObject({ state: "queued", scheduled: false });
      expect(s.getOutbox("fresh")).toBeNull();
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

// ---- Slice 3c: agent proposals and translations ----

function newProposal(overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    id: "p_1",
    threadId: "th_1",
    draftId: "d_1",
    accountId: "acc_1",
    kind: "new",
    sourceMessageId: null,
    added: [],
    contentSha256: "c".repeat(64),
    leftOut: 0,
    templateName: null,
    expiresAt: later(24 * 60 * 60 * 1000),
    createdAt: T0,
    ...overrides,
  };
}

/** A hidden draft d_1 with one attachment and its pending proposal p_1. */
function hiddenProposal(s: MailStore, overrides: Partial<NewProposal> = {}): void {
  const id = overrides.id ?? "p_1";
  const draftId = overrides.draftId ?? "d_1";
  s.createDraft(newDraft({ id: draftId, origin: "agent", proposalId: id }));
  s.addAttachment(draftId, file([1, 2]));
  s.createProposal(newProposal({ id, draftId, ...overrides }));
}

function translation(messageId: string, overrides: Partial<TranslationRecord> = {}): TranslationRecord {
  return {
    messageId,
    targetLanguage: "de",
    providerId: "provider-a",
    model: "model-a",
    text: "Erfundener Text",
    truncated: false,
    sourceSha256: "s".repeat(64),
    createdAt: T0,
    ...overrides,
  };
}

describe("slice-3c migration (SQLite)", () => {
  it("element 5 on a 3b database: drafts get proposal_id NULL and stay ordinary; new tables carry no REFERENCES", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 5).forEach((s) => old.exec(s)))();
    old.prepare(
      `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
       VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner@example.org', 'sealed', 'other', ?)`,
    ).run(EPOCH);
    old.prepare(
      `INSERT INTO compose_drafts (id, account_id, kind, message_id, refs_json, to_json, cc_json, bcc_json,
         subject, doc_json, revision, created_at, updated_at)
       VALUES ('d_old', 'acc_1', 'new', '<old@example.org>', '[]', '[]', '[]', '[]', 'Invented', '{"type":"doc","content":[]}', 3, ?, ?)`,
    ).run(T0, T0);

    old.transaction(() => MIGRATIONS.slice(5).forEach((s) => old.exec(s)))();

    const migrated = createSqliteStore(old);
    expect(migrated.getDraft("d_old")).toMatchObject({ proposalId: null, origin: "owner", revision: 3 });
    expect(migrated.listDrafts("acc_1").map((d) => d.id)).toEqual(["d_old"]);
    const objects = old
      .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('agent_proposals', 'translations', 'agent_proposals_thread', 'translations_created')")
      .all() as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([
      "agent_proposals",
      "agent_proposals_thread",
      "translations",
      "translations_created",
    ]);
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
  });

  it("releaseProposalDraft is atomic: a failed draft update leaves the proposal pending", () => {
    hiddenProposal(store);
    db.exec(`CREATE TRIGGER fail_draft BEFORE UPDATE ON compose_drafts BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    expect(() => store.releaseProposalDraft("p_1", "d_1", later(1))).toThrow(/forced/);
    expect(store.getProposal("p_1")!.state).toBe("pending");
    expect(store.getDraft("d_1")!.proposalId).toBe("p_1");
  });

  it("undoAgentSend is atomic: a failed proposal update keeps the outbox row and the hidden draft", () => {
    hiddenProposal(store);
    store.queueOutbox(newOutbox({ id: "p_1", origin: "agent" }), 1);
    store.transitionProposal("p_1", ["pending"], "queued", later(1), { outboxId: "p_1" });
    db.exec(`CREATE TRIGGER fail_proposal BEFORE UPDATE ON agent_proposals BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    expect(() => store.undoAgentSend("p_1", ["queued"], later(2))).toThrow(/forced/);
    expect(store.getOutbox("p_1")).not.toBeNull();
    expect(store.getDraft("d_1")!.proposalId).toBe("p_1");
    expect(store.getProposal("p_1")!.state).toBe("queued");
  });

  it("account removal deletes its proposals and translations; message removal its translations", () => {
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox")]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    store.putTranslation(translation(idOf(store, 1)));
    store.putTranslation(translation(idOf(store, 2)));
    hiddenProposal(store);
    store.deleteByUids("acc_1", INBOX, [1]);
    expect(count(db, "translations")).toBe(1);
    store.deleteAccount("acc_1");
    for (const table of ["translations", "agent_proposals", "compose_drafts", "compose_attachments"]) {
      expect(count(db, table)).toBe(0);
    }
  });
});

describe.each(storeKinds)("slice-3c store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
  });

  it("createDraft round-trips origin and proposalId; getDraft and listDrafts return hidden drafts raw", () => {
    const created = s.createDraft(newDraft({ origin: "agent", proposalId: "p_1" }));
    expect(created).toMatchObject({ origin: "agent", proposalId: "p_1" });
    expect(s.getDraft("d_1")).toEqual(created);
    expect(s.listDrafts("acc_1").map((d) => d.proposalId)).toEqual(["p_1"]);
  });

  it("createProposal starts pending with nothing viewed", () => {
    expect(s.createProposal(newProposal({ added: ["extra@example.net"], leftOut: 2 }))).toEqual({
      ...newProposal({ added: ["extra@example.net"], leftOut: 2 }),
      state: "pending",
      viewTokenSha256: null,
      viewedAt: null,
      outboxId: null,
      updatedAt: T0,
    });
    expect(s.getProposal("p_1")!.added).toEqual(["extra@example.net"]);
    expect(s.getProposal("nope")).toBeNull();
  });

  it("createProposal runs its admission check in the same transaction, over the cap rows including earlier proposals", () => {
    s.createProposal(newProposal({ id: "p_1", threadId: "th_1" }));
    const seen: unknown[] = [];
    expect(() =>
      s.createProposal(newProposal({ id: "p_2", threadId: "th_1", draftId: "d_2" }), (rows) => {
        seen.push(rows);
        throw new Error("cap");
      }),
    ).toThrow("cap");
    expect(seen).toEqual([[{ threadId: "th_1", state: "pending", createdAt: T0, updatedAt: T0 }]]);
    expect(s.getProposal("p_2")).toBeNull();
    expect(s.createProposal(newProposal({ id: "p_3", threadId: "th_2", draftId: "d_3" }), () => undefined).state).toBe("pending");
  });

  it("transitionProposal is a compare-and-swap recording updatedAt and the patch", () => {
    s.createProposal(newProposal());
    expect(s.transitionProposal("p_1", ["confirming"], "queued", later(1))).toBe(false);
    expect(s.transitionProposal("p_1", ["pending"], "confirming", later(2))).toBe(true);
    expect(s.transitionProposal("p_1", ["pending"], "confirming", later(3))).toBe(false);
    expect(s.transitionProposal("p_1", ["pending", "confirming"], "queued", later(4), { outboxId: "p_1" })).toBe(true);
    expect(s.getProposal("p_1")).toMatchObject({ state: "queued", outboxId: "p_1", updatedAt: later(4) });
    expect(s.transitionProposal("nope", ["pending"], "cancelled", later(5))).toBe(false);
  });

  it("setViewToken replaces the token only while pending", () => {
    s.createProposal(newProposal());
    expect(s.setViewToken("p_1", "a".repeat(64), later(1))).toBe(true);
    expect(s.setViewToken("p_1", "b".repeat(64), later(2))).toBe(true);
    expect(s.getProposal("p_1")).toMatchObject({ viewTokenSha256: "b".repeat(64), viewedAt: later(2), updatedAt: T0 });
    s.transitionProposal("p_1", ["pending"], "confirming", later(3));
    expect(s.setViewToken("p_1", "c".repeat(64), later(4))).toBe(false);
    expect(s.getProposal("p_1")!.viewTokenSha256).toBe("b".repeat(64));
  });

  it("releaseProposalDraft makes the draft an owner draft and the proposal opened, only for its own hidden draft", () => {
    hiddenProposal(s);
    expect(s.releaseProposalDraft("p_1", "d_other", later(1))).toBe(false);
    expect(s.releaseProposalDraft("p_1", "d_1", later(1))).toBe(true);
    expect(s.getDraft("d_1")).toMatchObject({ proposalId: null, origin: "agent" });
    expect(s.getProposal("p_1")).toMatchObject({ state: "opened", draftId: "d_1", updatedAt: later(1) });
    expect(s.releaseProposalDraft("p_1", "d_1", later(2))).toBe(false);
  });

  it("undoAgentSend deletes the row, releases the draft and opens the proposal; not from another state", () => {
    hiddenProposal(s);
    s.queueOutbox(newOutbox({ id: "p_1", origin: "agent" }), 1);
    s.transitionProposal("p_1", ["pending"], "queued", later(1), { outboxId: "p_1" });
    expect(s.undoAgentSend("p_1", ["held"], later(2))).toEqual({ cancelled: false, draftId: "d_1" });
    expect(s.getOutbox("p_1")).not.toBeNull();
    expect(s.undoAgentSend("p_1", ["queued"], later(3))).toEqual({ cancelled: true, draftId: "d_1" });
    expect(s.getOutbox("p_1")).toBeNull();
    expect(s.getDraft("d_1")!.proposalId).toBeNull();
    expect(s.getProposal("p_1")).toMatchObject({ state: "opened", updatedAt: later(3) });
    expect(s.undoAgentSend("p_1", ["queued"], later(4))).toEqual({ cancelled: false, draftId: null });
  });

  it("dropProposalDraft deletes only a still hidden draft and clears the draft id", () => {
    hiddenProposal(s);
    s.dropProposalDraft("p_1");
    expect(s.getDraft("d_1")).toBeNull();
    expect(s.listAttachments("d_1")).toEqual([]);
    expect(s.getProposal("p_1")!.draftId).toBeNull();

    hiddenProposal(s, { id: "p_2", draftId: "d_2" });
    s.releaseProposalDraft("p_2", "d_2", later(1));
    s.dropProposalDraft("p_2");
    expect(s.getDraft("d_2")).not.toBeNull();
  });

  it("recoverProposalsOnStart: pending expires with its draft; confirming is queued with its row, else expires", () => {
    hiddenProposal(s, { id: "p_pending", draftId: "d_pending" });
    hiddenProposal(s, { id: "p_row", draftId: "d_row" });
    hiddenProposal(s, { id: "p_lost", draftId: "d_lost" });
    s.transitionProposal("p_row", ["pending"], "confirming", later(1));
    s.transitionProposal("p_lost", ["pending"], "confirming", later(1));
    s.queueOutbox(newOutbox({ id: "p_row", draftId: "d_row", origin: "agent" }), 1);
    s.createProposal(newProposal({ id: "p_done", draftId: null as never }));
    s.transitionProposal("p_done", ["pending"], "cancelled", later(1));

    expect(s.recoverProposalsOnStart(later(5))).toEqual({ expired: 2, queued: 1 });
    expect(s.getProposal("p_pending")).toMatchObject({ state: "expired", draftId: null });
    expect(s.getDraft("d_pending")).toBeNull();
    expect(s.getProposal("p_row")).toMatchObject({ state: "queued", outboxId: "p_row", draftId: "d_row" });
    expect(s.getDraft("d_row")).not.toBeNull();
    expect(s.getProposal("p_lost")).toMatchObject({ state: "expired", draftId: null });
    expect(s.getProposal("p_done")!.state).toBe("cancelled");
  });

  it("purgeProposals deletes settled rows last updated before the cut, never unsettled ones", () => {
    s.createProposal(newProposal({ id: "p_old" }));
    s.transitionProposal("p_old", ["pending"], "cancelled", later(1));
    s.createProposal(newProposal({ id: "p_new" }));
    s.transitionProposal("p_new", ["pending"], "cancelled", later(10_000));
    s.createProposal(newProposal({ id: "p_wait" }));
    expect(s.purgeProposals(later(5_000))).toBe(1);
    expect(s.getProposal("p_old")).toBeNull();
    expect(s.getProposal("p_new")).not.toBeNull();
    expect(s.getProposal("p_wait")).not.toBeNull();
  });

  it("proposalCapRows: the last 24 hours plus every unsettled proposal", () => {
    const day = 24 * 60 * 60 * 1000;
    s.createProposal(newProposal({ id: "p_old_settled", createdAt: later(0) }));
    s.transitionProposal("p_old_settled", ["pending"], "refused", later(1));
    s.createProposal(newProposal({ id: "p_old_pending", threadId: "th_2", createdAt: later(1) }));
    s.createProposal(newProposal({ id: "p_recent", threadId: "th_3", createdAt: later(day) }));
    s.transitionProposal("p_recent", ["pending"], "cancelled", later(day + 1));
    expect(s.proposalCapRows(later(day + 10))).toEqual([
      { threadId: "th_2", state: "pending", createdAt: later(1), updatedAt: later(1) },
      { threadId: "th_3", state: "cancelled", createdAt: later(day), updatedAt: later(day + 1) },
    ]);
  });

  it("addressesSentTo counts To and Cc of Sent mail only, lowercased", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Sent", "sent")]);
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { from: { name: null, address: "inbound@example.com" }, to: [{ name: null, address: "owner@example.org" }] }),
    ]);
    s.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(1, {
        from: { name: null, address: "owner@example.org" },
        to: [{ name: "Bob", address: "Bob@Example.com" }],
        cc: [{ name: null, address: "carol@example.net" }],
      }),
    ]);
    expect([...s.addressesSentTo(["bob@example.com", "CAROL@example.net", "inbound@example.com", "owner@example.org"])].sort()).toEqual([
      "bob@example.com",
      "carol@example.net",
    ]);
    expect(s.addressesSentTo([]).size).toBe(0);
  });

  it("inboxMessages lists attached Inbox mail not moving, once per message, newest first", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Archive", "archive")]);
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { messageId: "a@example.org", date: "2026-11-10T08:00:00.000Z", seen: true }),
      makeFetchedMessage(2, { messageId: "b@example.org", date: "2026-11-12T08:00:00.000Z", unsubscribe: null }),
      makeFetchedMessage(3, { messageId: "c@example.org", date: "2026-11-11T08:00:00.000Z" }),
    ]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1, { messageId: "d@example.org", date: "2026-11-13T08:00:00.000Z" })]);
    const id = (uid: number) => s.localFolderIndex("acc_1", INBOX, "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
    s.queueMove([id(3)], "Archive");
    const all = s.inboxMessages(null, { unreadOnly: false, limit: 10 });
    expect(all.map((m) => m.id)).toEqual([id(2), id(1)]);
    expect(all[0]).toMatchObject({ accountId: "acc_1", isRead: false, unsubscribe: null, snoozedUntil: null });
    expect(s.inboxMessages("acc_1", { unreadOnly: true, limit: 10 }).map((m) => m.id)).toEqual([id(2)]);
    expect(s.inboxMessages("acc_2", { unreadOnly: false, limit: 10 })).toEqual([]);
    expect(s.inboxMessages(null, { unreadOnly: false, limit: 1 })).toHaveLength(1);
  });

  it("sentToCount counts Sent mail with the address in To or Cc, once per message", () => {
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Sent", "sent")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { to: [{ name: null, address: "bob@example.com" }] })]);
    s.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(1, { messageId: "s1@example.org", to: [{ name: "Bob", address: "Bob@Example.com" }] }),
      makeFetchedMessage(2, { messageId: "s2@example.org", cc: [{ name: null, address: "bob@example.com" }] }),
      makeFetchedMessage(3, { messageId: "s3@example.org", to: [{ name: null, address: "carol@example.net" }] }),
    ]);
    expect(s.sentToCount("BOB@example.com")).toBe(2);
    expect(s.sentToCount("nobody@example.com")).toBe(0);
    expect(s.sentToCount("")).toBe(0);
  });

  describe("translations", () => {
    beforeEach(() => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Old")]);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2), makeFetchedMessage(3)]);
      s.upsertMessages("acc_1", "Old", [makeFetchedMessage(1)]);
    });
    const id = (uid: number, folder = INBOX) => s.localFolderIndex("acc_1", folder, EPOCH).find((e) => e.uid === uid)!.id;

    it("put, get and upsert by message and language", () => {
      s.putTranslation(translation(id(1)));
      s.putTranslation(translation(id(1), { targetLanguage: "fr", truncated: true }));
      s.putTranslation(translation(id(1), { text: "Neuer Text", createdAt: later(1) }));
      expect(s.getTranslation(id(1), "de")).toEqual(translation(id(1), { text: "Neuer Text", createdAt: later(1) }));
      expect(s.getTranslation(id(1), "fr")!.truncated).toBe(true);
      expect(s.getTranslation(id(1), "es")).toBeNull();
      expect(s.clearTranslations()).toBe(2);
      expect(s.getTranslation(id(1), "de")).toBeNull();
    });

    it("go with deleteByUids, a vanished message after a reset, a removed folder and the account", () => {
      for (const uid of [1, 2, 3]) s.putTranslation(translation(id(uid)));
      s.putTranslation(translation(id(1, "Old")));
      const [m1, m2, m3, old] = [id(1), id(2), id(3), id(1, "Old")];
      s.deleteByUids("acc_1", INBOX, [1]);
      expect(s.getTranslation(m1, "de")).toBeNull();
      expect(s.getTranslation(m2, "de")).not.toBeNull();

      s.beginFolderReset("acc_1", INBOX);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(30, { messageId: "msg-3@example.org" })]);
      s.finishFolderReset("acc_1", INBOX);
      expect(s.getTranslation(m2, "de")).toBeNull();
      expect(s.getTranslation(m3, "de")).not.toBeNull();

      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox")]);
      expect(s.getTranslation(old, "de")).toBeNull();
      expect(s.getTranslation(m3, "de")).not.toBeNull();

      s.deleteAccount("acc_1");
      expect(s.getTranslation(m3, "de")).toBeNull();
    });

    it("evicts the oldest beyond the cache cap", () => {
      s.transaction(() => {
        for (let i = 0; i < TRANSLATION_CACHE_ROWS + 1; i++) {
          s.putTranslation(translation(`m_${String(i).padStart(5, "0")}`, { createdAt: later(i) }));
        }
      });
      expect(s.getTranslation("m_00000", "de")).toBeNull();
      expect(s.getTranslation("m_00001", "de")).not.toBeNull();
      expect(s.getTranslation(`m_${String(TRANSLATION_CACHE_ROWS).padStart(5, "0")}`, "de")).not.toBeNull();
      expect(s.clearTranslations()).toBe(TRANSLATION_CACHE_ROWS);
    });
  });

  it("deleteAccount deletes the account's proposals only", () => {
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.com" }));
    s.createProposal(newProposal());
    s.createProposal(newProposal({ id: "p_2", accountId: "acc_2", draftId: null as never }));
    s.deleteAccount("acc_1");
    expect(s.getProposal("p_1")).toBeNull();
    expect(s.getProposal("p_2")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contacts for agents: bulk marking (migration 6), mail_contacts, account pick
// ---------------------------------------------------------------------------

const SENT = "Sent";
const SPAM = "Spam";
const TRASH = "Trash";
const LIST_HEADERS = { listId: "<news.example.net>", listUnsubscribe: null, precedence: null, autoSubmitted: null };
const PERSONAL_HEADERS = { listId: null, listUnsubscribe: null, precedence: null, autoSubmitted: null };

describe.each(storeKinds)("contacts (%s)", (_kind, make) => {
  let s: MailStore;
  let uid = 0;
  beforeEach(() => {
    uid = 0;
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org", username: "second@example.org" }));
    for (const account of ["acc_1", "acc_2"]) {
      s.saveFolders(account, [
        remoteFolder(INBOX, "inbox"),
        remoteFolder(SENT, "sent"),
        remoteFolder(SPAM, "junk"),
        remoteFolder(TRASH, "trash"),
      ]);
    }
  });

  const put = (folder: string, overrides: Parameters<typeof makeFetchedMessage>[1], account = "acc_1") => {
    uid++;
    s.upsertMessages(account, folder, [
      makeFetchedMessage(uid, { bulkHeaders: PERSONAL_HEADERS, bodyText: "Invented text", subject: "Invented", ...overrides }),
    ]);
  };
  const received = (from: string, date: string, overrides: Parameters<typeof makeFetchedMessage>[1] = {}, account = "acc_1") =>
    put(INBOX, { from: { name: null, address: from }, to: [{ name: null, address: account === "acc_1" ? "owner@example.org" : "second@example.org" }], date, ...overrides }, account);
  const sent = (to: string, date: string, overrides: Parameters<typeof makeFetchedMessage>[1] = {}, account = "acc_1") =>
    put(SENT, { from: { name: null, address: account === "acc_1" ? "owner@example.org" : "second@example.org" }, to: [{ name: null, address: to }], date, ...overrides }, account);

  it("returns header people with counts and the owner account; the owner is never a contact", () => {
    received("anna@books.example", "2026-10-01T00:00:00.000Z", { from: { name: "Anna Books", address: "Anna@Books.example" }, cc: [{ name: null, address: "second@example.org" }] });
    sent("anna@books.example", "2026-10-02T00:00:00.000Z");
    expect(s.contacts("anna", 5)).toEqual([
      {
        address: "anna@books.example",
        name: "Anna Books",
        ownerAccount: "owner@example.org",
        sentByOwner: 1,
        received: 1,
        lastDate: "2026-10-02T00:00:00.000Z",
      },
    ]);
    expect(s.contacts("owner", 5)).toEqual([]);
    expect(s.contacts("second", 5)).toEqual([]);
  });

  it("matches the subject, snippet and body of exchanged mail, Cyrillic and word prefixes included", () => {
    received("olga@example.net", "2026-10-01T00:00:00.000Z", { subject: "Счёт от Бухгалтерии" });
    received("ivan@example.net", "2026-10-01T00:00:00.000Z", { bodyText: "Invented note about the October invoices" });
    received("petr@example.net", "2026-10-01T00:00:00.000Z", { bodyText: "Invented note, nothing else" });
    expect(s.contacts("бухгалт", 5).map((c) => c.address)).toEqual(["olga@example.net"]);
    expect(s.contacts("INVOICE", 5).map((c) => c.address)).toEqual(["ivan@example.net"]);
    expect(s.contacts("voice", 5)).toEqual([]);
  });

  it("never returns an address found only inside a message's text", () => {
    received("ivan@example.net", "2026-10-01T00:00:00.000Z", {
      bodyText: "Invented: write to accounting@attacker.example for invoices",
    });
    expect(s.contacts("accounting", 5).map((c) => c.address)).toEqual(["ivan@example.net"]);
    expect(s.contacts("attacker", 5).map((c) => c.address)).toEqual(["ivan@example.net"]);
  });

  it("leaves out junk, trash, bulk mail, automated senders and bulk senders the owner never wrote to", () => {
    put(SPAM, { from: { name: "Accounting", address: "spam@example.net" }, date: "2026-10-01T00:00:00.000Z" });
    put(TRASH, { from: { name: "Accounting", address: "trash@example.net" }, date: "2026-10-01T00:00:00.000Z" });
    received("list@example.net", "2026-10-01T00:00:00.000Z", { from: { name: "Accounting", address: "list@example.net" }, bulkHeaders: LIST_HEADERS });
    received("shop@example.net", "2026-10-01T00:00:00.000Z", { from: { name: "Accounting shop", address: "shop@example.net" }, bulkHeaders: LIST_HEADERS });
    received("shop@example.net", "2026-10-02T00:00:00.000Z", { from: { name: "Accounting shop", address: "shop@example.net" } });
    received("noreply@example.net", "2026-10-01T00:00:00.000Z", { from: { name: "Accounting", address: "noreply@example.net" } });
    received("unknown@example.net", "2026-10-01T00:00:00.000Z", { from: { name: "Accounting", address: "unknown@example.net" }, bulkHeaders: undefined });
    received("anna@example.net", "2026-10-01T00:00:00.000Z", { from: { name: "Accounting Anna", address: "anna@example.net" } });
    expect(s.contacts("accounting", 10).map((c) => c.address).sort()).toEqual(["anna@example.net", "unknown@example.net"]);
  });

  it("ranks people the owner wrote to first and counts a message once across folders", () => {
    received("recent@x.example", "2026-11-01T00:00:00.000Z");
    sent("written@x.example", "2025-01-01T00:00:00.000Z");
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(SENT, "sent"), remoteFolder(ALL_MAIL, "all")]);
    const copy = { from: { name: null, address: "copy@x.example" }, gmMsgId: "777", date: "2026-06-01T00:00:00.000Z" };
    put(INBOX, copy);
    put(ALL_MAIL, copy);
    const found = s.contacts("x", 10);
    expect(found.map((c) => c.address)).toEqual(["written@x.example", "recent@x.example", "copy@x.example"]);
    expect(found[2]!.received).toBe(1);
    expect(s.contacts("x", 1)).toHaveLength(1);
  });

  it("contacts of one account count, name and match nothing from another account", () => {
    received("anna@example.net", "2026-01-01T00:00:00.000Z", { from: { name: "Anna", address: "anna@example.net" } });
    received("anna@example.net", "2026-05-01T00:00:00.000Z", { from: { name: "Anna Elsewhere", address: "anna@example.net" }, subject: "Invented merger" }, "acc_2");
    received("anna@example.net", "2026-06-01T00:00:00.000Z", { subject: "Invented merger again" }, "acc_2");
    expect(s.contacts("anna", 5, { scoped: true, accountId: "acc_1" })).toEqual([
      { address: "anna@example.net", name: "Anna", ownerAccount: "owner@example.org", sentByOwner: 0, received: 1, lastDate: "2026-01-01T00:00:00.000Z" },
    ]);
    // A topic that exists only in the other account finds nobody here.
    expect(s.contacts("merger", 5, { scoped: true, accountId: "acc_1" })).toEqual([]);
    expect(s.contacts("merger", 5, { scoped: true, accountId: "acc_2" }).map((c) => [c.address, c.received])).toEqual([["anna@example.net", 2]]);
  });

  it("the owner account is the account that exchanged mail with them most recently", () => {
    received("anna@example.net", "2026-01-01T00:00:00.000Z");
    received("anna@example.net", "2026-05-01T00:00:00.000Z", {}, "acc_2");
    expect(s.contacts("anna", 5)[0]!.ownerAccount).toBe("second@example.org");
  });

  it("correspondence: per account, the latest mail received from and sent to the addresses", () => {
    received("anna@example.net", "2026-01-01T00:00:00.000Z");
    sent("ANNA@example.net", "2026-06-01T00:00:00.000Z", {}, "acc_2");
    received("anna@example.net", "2026-07-01T00:00:00.000Z", { bulkHeaders: LIST_HEADERS }, "acc_2");
    put(SPAM, { from: { name: null, address: "anna@example.net" }, date: "2026-08-01T00:00:00.000Z" }, "acc_2");
    expect(s.correspondence(["anna@example.net"])).toEqual([
      { accountId: "acc_1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: null },
      { accountId: "acc_2", lastReceived: null, lastSent: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(s.correspondence(["nobody@example.net"])).toEqual([]);
    expect(s.correspondence([])).toEqual([]);
  });
});

describe("bulk mark (SQLite)", () => {
  it("upsert stores 1 for bulk, 0 for personal, NULL when the fetch read no headers", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { bulkHeaders: LIST_HEADERS }),
      makeFetchedMessage(2, { bulkHeaders: PERSONAL_HEADERS }),
      makeFetchedMessage(3, { bulkHeaders: PERSONAL_HEADERS, from: { name: null, address: "no-reply@example.net" } }),
      makeFetchedMessage(4),
    ]);
    expect(db.prepare("SELECT uid, bulk FROM messages ORDER BY uid").all()).toEqual([
      { uid: 1, bulk: 1 },
      { uid: 2, bulk: 0 },
      { uid: 3, bulk: 1 },
      { uid: 4, bulk: null },
    ]);
  });

  it("element 6 on a 3c database: old rows get NULL and count by their sender only", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 6).forEach((s) => old.exec(s)))();
    old.prepare(
      `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
       VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner@example.org', 'sealed', 'other', ?)`,
    ).run(EPOCH);
    const insert = old.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, from_name, from_address, to_json, subject, date, snippet, dedup_key)
       VALUES (?, 'acc_1', 'INBOX', ?, NULL, ?, 'Invented', ?, '[{"name":null,"address":"owner@example.org"}]', 'Invented accounting', '2026-11-10T00:00:00.000Z', 'Invented', ?)`,
    );
    insert.run("m_a", 1, "t_m_a", "anna@example.net", "id:m_a");
    insert.run("m_b", 2, "t_m_b", "newsletter@example.net", "id:m_b");

    old.transaction(() => MIGRATIONS.slice(6).forEach((s) => old.exec(s)))();

    expect(old.prepare("SELECT id, bulk FROM messages ORDER BY id").all()).toEqual([
      { id: "m_a", bulk: null },
      { id: "m_b", bulk: null },
    ]);
    expect(createSqliteStore(old).contacts("accounting", 5).map((c) => c.address)).toEqual(["anna@example.net"]);
  });
});

describe.each(storeKinds)("bulk backfill store methods (%s)", (_kind, make) => {
  let s: MailStore;
  const STATE = { uidValidity: 7, lastUid: 9, syncedSince: EPOCH };
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Archive", "archive")]);
    s.saveSyncState("acc_1", INBOX, STATE);
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1),
      makeFetchedMessage(2, { bulkHeaders: PERSONAL_HEADERS }),
      makeFetchedMessage(3, { from: { name: null, address: "no-reply@example.net" } }),
      makeFetchedMessage(4),
      makeFetchedMessage(5, { bulkHeaders: LIST_HEADERS }),
    ]);
    s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1)]);
  });

  it("bulkUnknown lists attached NULL rows of one folder, highest uid first, below the cursor, at most limit", () => {
    expect(s.bulkUnknown("acc_1", INBOX, null, 10)).toEqual([
      { uid: 4, fromAddress: "sender@example.org" },
      { uid: 3, fromAddress: "no-reply@example.net" },
      { uid: 1, fromAddress: "sender@example.org" },
    ]);
    expect(s.bulkUnknown("acc_1", INBOX, null, 2).map((r) => r.uid)).toEqual([4, 3]);
    expect(s.bulkUnknown("acc_1", INBOX, 3, 10).map((r) => r.uid)).toEqual([1]);
    expect(s.bulkUnknown("acc_1", INBOX, null, 0)).toEqual([]);
    expect(s.bulkUnknown("acc_2", INBOX, null, 10)).toEqual([]);
    s.beginFolderReset("acc_1", INBOX);
    expect(s.bulkUnknown("acc_1", INBOX, null, 10)).toEqual([]);
  });

  it("fillBulk writes only NULL marks, only while the folder's UIDVALIDITY matches", () => {
    expect(
      s.fillBulk("acc_1", INBOX, 7, [
        { uid: 4, bulk: true },
        { uid: 2, bulk: true },
        { uid: 5, bulk: false },
        { uid: 99, bulk: true },
      ]),
    ).toBe(1);
    expect(s.bulkUnknown("acc_1", INBOX, null, 10).map((r) => r.uid)).toEqual([3, 1]);
    expect(s.fillBulk("acc_1", INBOX, 8, [{ uid: 3, bulk: true }])).toBe(0);
    expect(s.fillBulk("acc_1", "Archive", 7, [{ uid: 1, bulk: true }])).toBe(0);
    expect(s.fillBulk("acc_1", INBOX, 7, [])).toBe(0);
    expect(s.bulkUnknown("acc_1", INBOX, null, 10).map((r) => r.uid)).toEqual([3, 1]);
    s.fillBulk("acc_1", INBOX, 7, [{ uid: 3, bulk: false }, { uid: 1, bulk: true }]);
    expect(s.bulkUnknown("acc_1", INBOX, null, 10)).toEqual([]);
  });
});

describe("bulk backfill (SQLite)", () => {
  it("fillBulk stores 1 and 0 and leaves sync's marks alone", () => {
    store.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 3, syncedSince: EPOCH });
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1),
      makeFetchedMessage(2),
      makeFetchedMessage(3, { bulkHeaders: LIST_HEADERS }),
    ]);
    expect(store.fillBulk("acc_1", INBOX, 7, [{ uid: 1, bulk: true }, { uid: 2, bulk: false }, { uid: 3, bulk: false }])).toBe(2);
    expect(db.prepare("SELECT uid, bulk FROM messages ORDER BY uid").all()).toEqual([
      { uid: 1, bulk: 1 },
      { uid: 2, bulk: 0 },
      { uid: 3, bulk: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Slice 3d: identities, send checks, templates, undo rows, sent_recipients
// ---------------------------------------------------------------------------

const SIG = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Invented Name" }] }] };
const TEMPLATE_DOC = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Invented template" }] }] };

describe("slice-3d migration (SQLite)", () => {
  it("element 7 on a 3c database: existing rows get NULLs and drafts send from the own address; new tables carry no REFERENCES", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 7).forEach((s) => old.exec(s)))();
    old.prepare(
      `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
       VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner@example.org', 'sealed', 'other', ?)`,
    ).run(EPOCH);
    old.prepare(
      `INSERT INTO compose_drafts (id, account_id, kind, message_id, refs_json, to_json, cc_json, bcc_json,
         subject, doc_json, revision, created_at, updated_at)
       VALUES ('d_old', 'acc_1', 'new', '<old@example.org>', '[]', '[]', '[]', '[]', 'Invented', '{"type":"doc","content":[]}', 2, ?, ?)`,
    ).run(T0, T0);

    old.transaction(() => MIGRATIONS.slice(7).forEach((s) => old.exec(s)))();

    const migrated = createSqliteStore(old);
    expect(migrated.getAccount("acc_1")!.signature).toBeNull();
    expect(migrated.getDraft("d_old")).toMatchObject({ fromAddress: null, revision: 2 });
    expect(migrated.listIdentities(null)).toEqual([]);
    expect(migrated.listTemplates()).toEqual([]);
    const objects = old
      .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('identities', 'templates', 'sent_recipients', 'identities_account_address')")
      .all() as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["identities", "identities_account_address", "sent_recipients", "templates"]);
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
  });

  it("delivered_to_json is written from upsert, lower case and at most 10, and left alone when absent", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { deliveredTo: ["Alias@Example.org", ...Array.from({ length: 12 }, (_, i) => `x${i}@example.org`)] }),
    ]);
    const id = idOf(store, 1);
    expect(store.deliveredToOf(id)).toEqual(["alias@example.org", ...Array.from({ length: 9 }, (_, i) => `x${i}@example.org`)]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { subject: "Again" })]);
    expect(store.deliveredToOf(id)[0]).toBe("alias@example.org");
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2)]);
    expect(store.deliveredToOf(idOf(store, 2))).toEqual([]);
    expect(db.prepare("SELECT delivered_to_json AS d FROM messages WHERE uid = 2").get()).toEqual({ d: null });
  });

  it("sent_recipients is written with the sent transition and rolled back with it", () => {
    store.createDraft(newDraft());
    store.queueOutbox(newOutbox(), 1);
    store.transitionOutbox("out_1", ["queued"], "sending");
    db.exec(`CREATE TRIGGER fail_recipients BEFORE INSERT ON sent_recipients BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    expect(() => store.transitionOutbox("out_1", ["sending"], "sent", { updatedAt: later(1) })).toThrow(/forced/);
    expect(store.getOutbox("out_1")!.state).toBe("sending");
    db.exec("DROP TRIGGER fail_recipients");
    expect(store.transitionOutbox("out_1", ["sending"], "sent", { rejected: ["hidden@example.net"], updatedAt: later(1) })).toBe(true);
    expect(db.prepare("SELECT account_id, address, last_sent_at FROM sent_recipients").all()).toEqual([
      { account_id: "acc_1", address: "bob@example.com", last_sent_at: later(1) },
    ]);
  });

  it("deleteAccount removes identities and sent_recipients; templates stay", () => {
    store.upsertIdentity({ accountId: "acc_1", address: "alias@example.org", displayName: null }, T0);
    store.dismissIdentity("acc_1", "other@example.org", T0);
    store.createDraft(newDraft());
    store.queueOutbox(newOutbox(), 1);
    store.transitionOutbox("out_1", ["queued"], "sent");
    store.saveTemplate({ id: null, name: "Thanks", nameKey: "thanks", doc: TEMPLATE_DOC }, "tpl_1", T0);
    expect(count(db, "sent_recipients")).toBe(2);
    store.deleteAccount("acc_1");
    expect(count(db, "identities")).toBe(0);
    expect(count(db, "sent_recipients")).toBe(0);
    expect(count(db, "templates")).toBe(1);
  });
});

describe.each(storeKinds)("slice-3d store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.com", username: "second-login", createdAt: "2026-02-01T00:00:00.000Z" }));
  });

  describe("accounts and drafts", () => {
    it("saveAccount keeps the signature; setAccountSignature sets and clears it", () => {
      s.saveAccount(makeStoredAccount({ signature: SIG }));
      expect(s.getAccount("acc_1")!.signature).toEqual(SIG);
      expect(s.setAccountSignature("acc_1", null)).toBe(true);
      expect(s.getAccount("acc_1")!.signature).toBeNull();
      expect(s.setAccountSignature("acc_1", SIG)).toBe(true);
      expect(s.listAccounts()[0]!.signature).toEqual(SIG);
      expect(s.setAccountSignature("nope", SIG)).toBe(false);
    });

    it("from_address round-trips through createDraft and saveDraft", () => {
      expect(s.createDraft(newDraft({ fromAddress: "alias@example.org" })).fromAddress).toBe("alias@example.org");
      expect(s.getDraft("d_1")!.fromAddress).toBe("alias@example.org");
      s.saveDraft("d_1", 1, { ...FIELDS, fromAddress: null }, later(1));
      expect(s.getDraft("d_1")!.fromAddress).toBeNull();
      s.saveDraft("d_1", 2, { ...FIELDS, fromAddress: "other@example.org" }, later(2));
      expect(s.getDraft("d_1")!.fromAddress).toBe("other@example.org");
    });

    it("createProposal records templateName", () => {
      s.createDraft(newDraft({ origin: "agent", proposalId: "p_1" }));
      expect(s.createProposal(newProposal({ templateName: "Thanks" })).templateName).toBe("Thanks");
      expect(s.getProposal("p_1")!.templateName).toBe("Thanks");
    });
  });

  describe("identities", () => {
    it("upsert adds, updates the name, and turns a dismissed row active", () => {
      const added = s.upsertIdentity({ accountId: "acc_1", address: " Alias@Example.org ", displayName: "Alias" }, T0);
      expect(added).toMatchObject({
        accountId: "acc_1",
        address: "alias@example.org",
        displayName: "Alias",
        signature: null,
        state: "active",
        sendCheck: "unknown",
        checkMessageId: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const renamed = s.upsertIdentity({ accountId: "acc_1", address: "alias@example.org", displayName: null }, later(1));
      expect(renamed).toMatchObject({ id: added.id, displayName: null, updatedAt: later(1), createdAt: T0 });
      s.dismissIdentity("acc_1", "maybe@example.org", T0);
      expect(s.listIdentities("acc_1").map((r) => [r.address, r.state])).toEqual([
        ["alias@example.org", "active"],
        ["maybe@example.org", "dismissed"],
      ]);
      s.dismissIdentity("acc_1", "alias@example.org", later(2));
      expect(s.listIdentities("acc_1")[0]!.state).toBe("active");
      expect(s.upsertIdentity({ accountId: "acc_1", address: "maybe@example.org", displayName: null }, later(3)).state).toBe("active");
      expect(s.listIdentities(null)).toHaveLength(2);
      expect(s.listIdentities("acc_2")).toEqual([]);
    });

    it("upsert refuses another account's address, username or active alias, the own address, and an unknown account", () => {
      s.upsertIdentity({ accountId: "acc_2", address: "taken@example.org", displayName: null }, T0);
      for (const address of ["second@example.com", "second-login", "taken@example.org", "owner@example.org"]) {
        expect(() => s.upsertIdentity({ accountId: "acc_1", address, displayName: null }, T0)).toThrow(
          expect.objectContaining({ kind: "conflict" }),
        );
      }
      expect(() => s.upsertIdentity({ accountId: "nope", address: "x@example.org", displayName: null }, T0)).toThrow(
        expect.objectContaining({ kind: "not_found" }),
      );
      expect(s.listIdentities("acc_1")).toEqual([]);
    });

    it("upsert caps active aliases at 50 per account", () => {
      for (let i = 0; i < 50; i++) s.upsertIdentity({ accountId: "acc_1", address: `a${i}@example.org`, displayName: null }, T0);
      expect(() => s.upsertIdentity({ accountId: "acc_1", address: "one-more@example.org", displayName: null }, T0)).toThrow(
        expect.objectContaining({ kind: "conflict" }),
      );
      // Updating an existing active alias is not an addition.
      expect(s.upsertIdentity({ accountId: "acc_1", address: "a3@example.org", displayName: "Three" }, T0).displayName).toBe("Three");
    });

    it("update, send check and remove act on active aliases only", () => {
      s.upsertIdentity({ accountId: "acc_1", address: "alias@example.org", displayName: "Alias" }, T0);
      s.dismissIdentity("acc_1", "gone@example.org", T0);
      expect(s.updateIdentity("acc_1", "alias@example.org", { signature: SIG }, later(1))).toMatchObject({ displayName: "Alias", signature: SIG });
      expect(s.updateIdentity("acc_1", "ALIAS@example.org", { displayName: null }, later(2))).toMatchObject({ displayName: null, signature: SIG });
      expect(s.updateIdentity("acc_1", "gone@example.org", { displayName: "X" }, later(2))).toBeNull();
      s.setSendCheck("acc_1", "alias@example.org", "pending", "<m1@example.org>", later(3));
      expect(s.listIdentities("acc_1")[0]).toMatchObject({ sendCheck: "pending", checkMessageId: "<m1@example.org>" });
      expect(s.removeIdentity("acc_1", "gone@example.org")).toBe(false);
      expect(s.removeIdentity("acc_1", "alias@example.org")).toBe(true);
      expect(s.removeIdentity("acc_1", "alias@example.org")).toBe(false);
      expect(s.listIdentities("acc_1").map((r) => r.address)).toEqual(["gone@example.org"]);
    });

    it("resolveSendChecks: confirmed, rewritten and still pending from Sent-role rows", () => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(SENT, "sent")]);
      for (const address of ["kept@example.org", "rewritten@example.org", "waiting@example.org"]) {
        s.upsertIdentity({ accountId: "acc_1", address, displayName: null }, T0);
      }
      s.setSendCheck("acc_1", "kept@example.org", "pending", "<k1@example.org>", T0);
      s.setSendCheck("acc_1", "rewritten@example.org", "pending", "<r1@example.org>", T0);
      s.setSendCheck("acc_1", "waiting@example.org", "pending", "<w1@example.org>", T0);
      s.upsertMessages("acc_1", SENT, [
        makeFetchedMessage(1, { messageId: "<k1@example.org>", from: { name: null, address: "Kept@example.org" } }),
        makeFetchedMessage(2, { messageId: "<r1@example.org>", from: { name: null, address: "owner@example.org" } }),
      ]);
      // A copy outside Sent does not count.
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(3, { messageId: "<w1@example.org>", from: { name: null, address: "waiting@example.org" } })]);
      expect(s.resolveSendChecks("acc_1", later(1))).toBe(2);
      expect(Object.fromEntries(s.listIdentities("acc_1").map((r) => [r.address, r.sendCheck]))).toEqual({
        "kept@example.org": "confirmed",
        "rewritten@example.org": "rewritten",
        "waiting@example.org": "pending",
      });
      expect(s.resolveSendChecks("acc_1", later(2))).toBe(0);
    });
  });

  describe("message reads", () => {
    beforeEach(() => {
      s.saveFolders("acc_1", [
        remoteFolder(INBOX, "inbox"),
        remoteFolder(SENT, "sent"),
        remoteFolder("Drafts", "drafts"),
        remoteFolder(SPAM, "junk"),
        remoteFolder(TRASH, "trash"),
        remoteFolder("Archive", "archive"),
      ]);
    });

    it("inboundAddressRows leaves out Sent, Drafts, Spam, Trash and bulk rows", () => {
      const to = (address: string) => ({ to: [{ name: null, address }] });
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { ...to("in@example.org"), deliveredTo: ["alias@example.org"], date: "2026-11-01T00:00:00.000Z" }),
        makeFetchedMessage(2, { ...to("bulk@example.org"), bulkHeaders: LIST_HEADERS }),
      ]);
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(3, { ...to("arch@example.org"), cc: [{ name: null, address: "cc@example.org" }], date: "2026-11-02T00:00:00.000Z" })]);
      s.upsertMessages("acc_1", SENT, [makeFetchedMessage(4, to("sent@example.org"))]);
      s.upsertMessages("acc_1", "Drafts", [makeFetchedMessage(5, to("draft@example.org"))]);
      s.upsertMessages("acc_1", SPAM, [makeFetchedMessage(6, to("spam@example.org"))]);
      s.upsertMessages("acc_1", TRASH, [makeFetchedMessage(7, to("trash@example.org"))]);
      const rows = s.inboundAddressRows("acc_1").sort((a, b) => (a.date < b.date ? -1 : 1));
      expect(rows).toEqual([
        { to: ["in@example.org"], cc: [], deliveredTo: ["alias@example.org"], date: "2026-11-01T00:00:00.000Z" },
        { to: ["arch@example.org"], cc: ["cc@example.org"], deliveredTo: null, date: "2026-11-02T00:00:00.000Z" },
      ]);
      expect(s.inboundAddressRows("acc_2")).toEqual([]);
    });

    it("conversationAddresses collects From, To, Cc and Reply-To of the source's thread; null when gone", () => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, {
          messageId: "<t1@example.org>",
          from: { name: null, address: "Ann@example.com" },
          cc: [{ name: null, address: "cc@example.com" }],
          replyTo: [{ name: null, address: "reply@example.com" }],
        }),
        makeFetchedMessage(2, {
          messageId: "<t2@example.org>",
          inReplyTo: "<t1@example.org>",
          references: ["<t1@example.org>"],
          from: { name: null, address: "bob@example.com" },
        }),
        makeFetchedMessage(3, { messageId: "<other@example.org>", from: { name: null, address: "stranger@example.com" } }),
      ]);
      s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
      const first = idIn(s, INBOX, 1);
      expect([...s.conversationAddresses(first)!].sort()).toEqual([
        "ann@example.com",
        "bob@example.com",
        "cc@example.com",
        "owner@example.org",
        "reply@example.com",
      ]);
      expect(s.conversationAddresses("m_nope")).toBeNull();
    });

    it("undoRows reports where each id is now; cancelMove is a compare-and-swap", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true }), makeFetchedMessage(2, { flagged: true }), makeFetchedMessage(3)]);
      const [a, b, c] = [1, 2, 3].map((uid) => idIn(s, INBOX, uid));
      s.queueMove([a!, b!], "Archive");
      expect(s.undoRows([a!, b!, c!, "m_nope"]).sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
        [
          { id: a, accountId: "acc_1", folder: INBOX, uid: 1, movePending: "Archive", isRead: true, isFlagged: false },
          { id: b, accountId: "acc_1", folder: INBOX, uid: 2, movePending: "Archive", isRead: false, isFlagged: true },
          { id: c, accountId: "acc_1", folder: INBOX, uid: 3, movePending: null, isRead: false, isFlagged: false },
        ].sort((x, y) => (x.id! < y.id! ? -1 : 1)),
      );
      // Wrong destination or wrong folder: nothing cleared.
      expect(s.cancelMove([a!], INBOX, TRASH)).toEqual([]);
      expect(s.cancelMove([a!], "Archive", "Archive")).toEqual([]);
      expect(s.cancelMove([a!, c!], INBOX, "Archive")).toEqual([a]);
      expect(s.pendingMoves("acc_1", INBOX).map((m) => m.id)).toEqual([b]);
      // Once pushed (the row is in the destination) the swap is a no-op.
      s.completeMove("acc_1", INBOX, "Archive", new Map([[2, 20]]), [2]);
      expect(s.cancelMove([b!], INBOX, "Archive")).toEqual([]);
      expect(s.undoRows([b!])[0]).toMatchObject({ folder: "Archive", uid: 20, movePending: null });
    });
  });

  describe("sent recipients", () => {
    it("addressesSentTo unions Sent-role rows and sent_recipients", () => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder(SENT, "sent")]);
      s.upsertMessages("acc_1", SENT, [makeFetchedMessage(1, { to: [{ name: null, address: "Synced@example.com" }] })]);
      s.createDraft(newDraft());
      s.queueOutbox(newOutbox({ envelopeTo: ["Bob@example.com", "refused@example.com"] }), 1);
      s.transitionOutbox("out_1", ["queued"], "sending");
      expect([...s.addressesSentTo(["bob@example.com", "synced@example.com"])]).toEqual(["synced@example.com"]);
      s.transitionOutbox("out_1", ["sending"], "sent", { rejected: ["refused@example.com"], updatedAt: later(1) });
      expect([...s.addressesSentTo(["BOB@example.com", "synced@example.com", "refused@example.com", "nobody@example.com"])].sort()).toEqual([
        "bob@example.com",
        "synced@example.com",
      ]);
    });

    it("contacts and correspondence treat active aliases as the owner's own", () => {
      s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox")]);
      s.upsertIdentity({ accountId: "acc_1", address: "alias@example.org", displayName: null }, T0);
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { from: { name: "Invented Ann", address: "ann@example.com" }, to: [{ name: null, address: "alias@example.org" }], bulkHeaders: PERSONAL_HEADERS }),
      ]);
      expect(s.contacts("alias", 10)).toEqual([]);
      expect(s.correspondence(["ann@example.com"]).map((c) => c.accountId)).toEqual(["acc_1"]);
    });
  });

  describe("templates", () => {
    it("save inserts, rename keeps the id, a duplicate key conflicts, an unknown id creates it", () => {
      expect(s.saveTemplate({ id: null, name: "Thanks", nameKey: "thanks", doc: TEMPLATE_DOC }, "tpl_1", T0)).toEqual({ id: "tpl_1" });
      expect(s.saveTemplate({ id: "tpl_1", name: "Thank you", nameKey: "thank you", doc: TEMPLATE_DOC }, "tpl_x", later(1))).toEqual({ id: "tpl_1" });
      expect(s.getTemplateByKey("thank you")).toEqual({
        id: "tpl_1",
        name: "Thank you",
        nameKey: "thank you",
        doc: TEMPLATE_DOC,
        createdAt: T0,
        updatedAt: later(1),
      });
      expect(s.getTemplateByKey("thanks")).toBeNull();
      expect(s.saveTemplate({ id: null, name: "THANK YOU", nameKey: "thank you", doc: TEMPLATE_DOC }, "tpl_2", T0)).toEqual({ conflict: true });
      expect(s.saveTemplate({ id: "tpl_9", name: "Later", nameKey: "later", doc: TEMPLATE_DOC }, "tpl_3", T0)).toEqual({ id: "tpl_9" });
      expect(s.listTemplates().map((t) => t.nameKey)).toEqual(["later", "thank you"]);
      expect(s.deleteTemplate("tpl_9")).toBe(true);
      expect(s.deleteTemplate("tpl_9")).toBe(false);
      expect(s.listTemplates().map((t) => t.id)).toEqual(["tpl_1"]);
    });

    it("caps templates at 200; an update at the cap still saves", () => {
      for (let i = 0; i < 200; i++) s.saveTemplate({ id: null, name: `T${i}`, nameKey: `t${i}`, doc: TEMPLATE_DOC }, `tpl_${i}`, T0);
      expect(() => s.saveTemplate({ id: null, name: "More", nameKey: "more", doc: TEMPLATE_DOC }, "tpl_more", T0)).toThrow(
        expect.objectContaining({ kind: "conflict" }),
      );
      expect(s.saveTemplate({ id: "tpl_5", name: "Five", nameKey: "five", doc: TEMPLATE_DOC }, "tpl_x", T0)).toEqual({ id: "tpl_5" });
      expect(s.listTemplates()).toHaveLength(200);
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 3e: migration element 8 and the inbox-triage store methods
// ---------------------------------------------------------------------------

const FOLDERS_3E: RemoteFolder[] = [
  { path: INBOX, name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
  { path: "Spam", name: "Spam", delimiter: "/", specialUse: "junk", selectable: true, subscribed: true },
  { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true, subscribed: true },
  { path: "Snoozed", name: "Snoozed", delimiter: "/", specialUse: null, selectable: true, subscribed: true },
];

const INFO: UnsubscribeInfo = {
  listKey: "weekly.example.com",
  listName: "Weekly",
  https: "https://u.example.com/x",
  oneClick: true,
  mailto: { address: "leave@example.com", subject: "unsubscribe", body: "" },
  trust: "covered",
};

describe("slice-3e migration (SQLite)", () => {
  it("element 8 on a 3d database: existing rows get NULLs and no new table carries REFERENCES", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 8).forEach((s) => old.exec(s)))();
    old.prepare(
      `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
       VALUES ('acc_1', 'owner@example.org', 'imap.example.org', 993, 'owner@example.org', 'sealed', 'other', ?)`,
    ).run(EPOCH);
    old.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, thread_id, from_address, subject, snippet, date, dedup_key)
       VALUES ('m_old', 'acc_1', 'INBOX', 1, 't_m_old', 'sender@example.org', 'Invented', 'Text', ?, 'id:m_old')`,
    ).run(T0);
    old.prepare(
      `INSERT INTO compose_drafts (id, account_id, kind, message_id, refs_json, to_json, cc_json, bcc_json,
         subject, doc_json, revision, created_at, updated_at)
       VALUES ('d_old', 'acc_1', 'new', '<old@example.org>', '[]', '[]', '[]', '[]', 'Invented', '{"type":"doc","content":[]}', 2, ?, ?)`,
    ).run(T0, T0);

    old.transaction(() => MIGRATIONS.slice(8).forEach((s) => old.exec(s)))();

    const migrated = createSqliteStore(old);
    migrated.assignThreads("acc_1", new Map());
    expect(migrated.getAccount("acc_1")!.snoozeFolder).toBeNull();
    expect(migrated.getDraft("d_old")).toMatchObject({ purpose: null, proposalId: null, revision: 2 });
    expect(migrated.getUnsubscribeInfo("m_old")).toBeNull();
    expect(migrated.listThreads("acc_1", INBOX, null, 10).threads).toEqual([
      expect.objectContaining({ id: "t_m_old", snoozedUntil: null }),
    ]);
    const tables = ["snoozes", "block_rules", "unsubscribes", "spam_seen", "triage_batches", "triage_items"];
    const objects = old
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`)
      .all(...tables) as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([...tables].sort());
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
  });

  it("element 9 namespaces stored list keys: id: for a List-Id, from: for a From fallback (review item 8)", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 9).forEach((s) => old.exec(s)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    legacy.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { unsubscribe: INFO }),
      makeFetchedMessage(2, { unsubscribe: { ...INFO, listKey: "news@example.com" } }),
      makeFetchedMessage(3),
    ]);
    legacy.putUnsubscribe({ accountId: "acc_1", listKey: "weekly.example.com", method: "one_click", state: "done", outboxId: null, requestedAt: T0 });
    legacy.putUnsubscribe({ accountId: "acc_1", listKey: "news@example.com", method: "mailto", state: "sent", outboxId: null, requestedAt: T0 });
    const ids = [1, 2, 3].map((uid) => idOf(legacy, uid));

    old.transaction(() => MIGRATIONS.slice(9).forEach((s) => old.exec(s)))();

    expect(MIGRATIONS).toHaveLength(21);
    const migrated = createSqliteStore(old);
    expect(migrated.getUnsubscribeInfo(ids[0]!)).toEqual({ ...INFO, listKey: "id:weekly.example.com" });
    expect(migrated.getUnsubscribeInfo(ids[1]!)?.listKey).toBe("from:news@example.com");
    expect(migrated.getUnsubscribeInfo(ids[2]!)).toBeNull();
    expect(migrated.getUnsubscribe("acc_1", "id:weekly.example.com")).toMatchObject({ state: "done" });
    expect(migrated.getUnsubscribe("acc_1", "from:news@example.com")).toMatchObject({ state: "sent" });
    expect(migrated.getUnsubscribe("acc_1", "weekly.example.com")).toBeNull();
  });

  it("saveAccount and setSnoozeFolder store the snooze folder", () => {
    store.saveAccount(makeStoredAccount({ snoozeFolder: "Snoozed" }));
    expect(store.getAccount("acc_1")!.snoozeFolder).toBe("Snoozed");
    store.setSnoozeFolder("acc_1", null);
    expect(store.getAccount("acc_1")!.snoozeFolder).toBeNull();
    store.setSnoozeFolder("acc_1", "Snoozed (Makosh)");
    expect(store.getAccount("acc_1")!.snoozeFolder).toBe("Snoozed (Makosh)");
  });

  it("deleteAccount deletes its snoozes, unsubscribes, spam_seen and triage rows explicitly, never block rules", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org" }));
    store.saveFolders("acc_1", FOLDERS_3E);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.upsertMessages("acc_1", "Spam", [makeFetchedMessage(2, { messageId: "spam@example.org" })]);
    store.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "other@example.org" })]);
    const id = idOf(store, 1);
    const other = idOf(store, 1, "acc_2");
    store.createSnoozes([{ messageId: id, accountId: "acc_1", returnTo: INBOX, dueAt: later(3_600_000), state: "moving" }], T0);
    store.putUnsubscribe({ accountId: "acc_1", listKey: "weekly.example.com", method: "mailto", state: "queued", outboxId: null, requestedAt: T0 });
    store.addBlockRule("address", "news@example.com", "br_1", T0);
    const batch = (batchId: string, items: [string, string][]) =>
      store.createTriageBatch(
        { id: batchId, threadId: "bb_t", contentHash: "a".repeat(64), summary: null, createdAt: T0, expiresAt: later(86_400_000) },
        items.map(([messageId, accountId], position) => ({
          batchId,
          position,
          messageId,
          accountId,
          action: "archive",
          snoozeUntil: null,
          note: null,
          outcome: null,
        })),
      );
    batch("tb_only_1", [[id, "acc_1"]]);
    batch("tb_mixed", [[id, "acc_1"], [other, "acc_2"]]);
    expect(count(db, "spam_seen")).toBe(1);

    store.deleteAccount("acc_1");

    for (const table of ["snoozes", "unsubscribes", "spam_seen"]) expect(count(db, table), table).toBe(0);
    expect(count(db, "block_rules")).toBe(1);
    expect(store.getTriageBatch("tb_only_1")).toBeNull();
    expect(store.getTriageBatch("tb_mixed")!.items.map((i) => i.accountId)).toEqual(["acc_2"]);
  });

  it("caps stored unsubscribe info at 4 KiB", () => {
    const big = { ...INFO, listName: "x".repeat(5_000) };
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { unsubscribe: big }), makeFetchedMessage(2, { unsubscribe: INFO })]);
    expect(store.getUnsubscribeInfo(idOf(store, 1))).toBeNull();
    expect(store.getUnsubscribeInfo(idOf(store, 2))).toEqual(INFO);
  });

  it("the filtered membership list stays uncorrelated and on the folder index", () => {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM threads WHERE account_id = 'acc_1'
             AND threads.id IN (SELECT m.thread_id FROM messages m
               WHERE m.account_id = 'acc_1' AND m.folder = 'INBOX' AND m.move_pending IS NULL
                 AND ((m.is_read = 0 AND m.is_flagged = 1) OR m.thread_id = 't_keep'))
           ORDER BY last_date DESC, id DESC LIMIT 51`,
        )
        .all() as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.join("\n")).not.toMatch(/CORRELATED/);
    expect(plan.join("\n")).toMatch(/messages_folder_pending/);
  });
});

describe.each(storeKinds)("slice-3e store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org", username: "second@example.org" }));
    s.saveFolders("acc_1", FOLDERS_3E);
    s.saveFolders("acc_2", FOLDERS_3E);
  });
  const idIn = (folder: string, uid: number, accountId = "acc_1") =>
    s.localFolderIndex(accountId, folder, EPOCH).find((e) => e.uid === uid)!.id;

  describe("upsertMessages", () => {
    it("reports inserted rows, not updated, reattached or re-homed ones", () => {
      const first = s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
      expect(first).toEqual({ inserted: [idIn(INBOX, 1), idIn(INBOX, 2)], returning: [] });
      expect(s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { seen: true })])).toEqual({ inserted: [], returning: [] });

      // A folder reset detaches, the same Message-ID reattaches with its id.
      const kept = idIn(INBOX, 2);
      s.beginFolderReset("acc_1", INBOX);
      expect(s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(7, { messageId: "msg-2@example.org" })])).toEqual({
        inserted: [],
        returning: [],
      });
      expect(idIn(INBOX, 7)).toBe(kept);
      s.finishFolderReset("acc_1", INBOX);

      // A move without a uid map detaches in the destination; its sync reattaches it.
      const moving = idIn(INBOX, 7);
      s.queueMove([moving], "Archive");
      s.completeMove("acc_1", INBOX, "Archive", null, [7]);
      expect(s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(30, { messageId: "msg-2@example.org" })])).toEqual({
        inserted: [],
        returning: [],
      });
      expect(idIn("Archive", 30)).toBe(moving);
    });

    it("marks an inserted row returning when its dedup key already had a row in the account", () => {
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1, { messageId: "same@example.org" })]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "elsewhere@example.org" })]);
      const result = s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(5, { messageId: "same@example.org" }),
        makeFetchedMessage(6, { messageId: "elsewhere@example.org" }),
        makeFetchedMessage(7, { messageId: "same@example.org", size: 999 }),
      ]);
      expect(result.inserted).toEqual([idIn(INBOX, 5), idIn(INBOX, 6), idIn(INBOX, 7)]);
      expect(result.returning).toEqual([idIn(INBOX, 5)]);
    });

    it("round-trips unsubscribe info and leaves it alone on a fetch without headers", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { unsubscribe: INFO }), makeFetchedMessage(2)]);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 1))).toEqual(INFO);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 2))).toBeNull();
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 1))).toEqual(INFO);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { unsubscribe: null })]);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 1))).toBeNull();
      expect(s.getUnsubscribeInfo("m_unknown")).toBeNull();
    });
  });

  describe("spam_seen", () => {
    it("is written by upsert into Spam and by a completed move into Spam, and pruned by time", () => {
      s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(1, { messageId: "junk@example.org" })]);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2, { messageId: "moved@example.org" }), makeFetchedMessage(3)]);
      const keys = ["mid:junk@example.org:100", "mid:moved@example.org:100", "mid:msg-3@example.org:100"];
      s.queueMove([idIn(INBOX, 2)], "Spam");
      s.completeMove("acc_1", INBOX, "Spam", new Map([[2, 40]]), [2]);
      // Out of Spam again (the owner rescued it): the key stays seen.
      s.queueMove([idIn("Spam", 40)], INBOX);
      s.completeMove("acc_1", "Spam", INBOX, new Map([[40, 9]]), [40]);
      s.deleteByUids("acc_1", "Spam", [1]);

      expect(s.spamSeen("acc_1", keys)).toEqual(new Set(keys.slice(0, 2)));
      expect(s.spamSeen("acc_2", keys)).toEqual(new Set());
      expect(s.pruneSpamSeen("2000-01-01T00:00:00.000Z")).toBe(0);
      expect(s.pruneSpamSeen("2999-01-01T00:00:00.000Z")).toBe(2);
      expect(s.spamSeen("acc_1", keys)).toEqual(new Set());
    });

    it("also counts a key held by a junk-role row now", () => {
      s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(1, { messageId: "junk@example.org" })]);
      s.pruneSpamSeen("2999-01-01T00:00:00.000Z");
      expect(s.spamSeen("acc_1", ["mid:junk@example.org:100"])).toEqual(new Set(["mid:junk@example.org:100"]));
    });
  });

  describe("blockMatches", () => {
    const rule = (kind: "address" | "domain", value: string) => ({ id: "br", kind, value, createdAt: T0 });
    const from = (address: string) => ({ from: { name: null, address } });

    it("lists attached Inbox-role rows of every account, not moving, never Spam-seen or own mail", () => {
      s.upsertIdentity({ accountId: "acc_1", address: "alias@news.example.com", displayName: null }, T0);
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, from("news@news.example.com")),
        makeFetchedMessage(2, from("Promo@News.Example.com")),
        makeFetchedMessage(3, from("friend@example.org")),
        makeFetchedMessage(4, from("alias@news.example.com")),
        makeFetchedMessage(5, { ...from("news@news.example.com"), messageId: "rescued@example.org" }),
        makeFetchedMessage(6, from("news@news.example.com")),
      ]);
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1, { ...from("news@news.example.com"), messageId: "arch@example.org" })]);
      s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(1, { ...from("news@news.example.com"), messageId: "rescued@example.org" })]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { ...from("news@sub.news.example.com"), messageId: "b@example.org" })]);
      s.queueMove([idIn(INBOX, 6)], "Archive");

      const matches = s.blockMatches(rule("domain", "news.example.com"));
      expect(matches.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [
          { id: idIn(INBOX, 1), accountId: "acc_1", folder: INBOX },
          { id: idIn(INBOX, 2), accountId: "acc_1", folder: INBOX },
          { id: idIn(INBOX, 1, "acc_2"), accountId: "acc_2", folder: INBOX },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(s.blockMatches(rule("address", "promo@news.example.com"))).toEqual([
        { id: idIn(INBOX, 2), accountId: "acc_1", folder: INBOX },
      ]);
      expect(s.blockMatches(rule("address", "owner@example.org"))).toEqual([]);
    });
  });

  describe("quick filters", () => {
    /** Five threads in the Inbox, newest first t5..t1, with one row each unless noted. */
    function seed(): void {
      const at = (h: number) => later(h * 3_600_000);
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { date: at(1), seen: false }),
        makeFetchedMessage(2, { date: at(2), seen: true, flagged: true }),
        makeFetchedMessage(3, {
          date: at(3),
          seen: true,
          attachments: [{ partId: "2", filename: "a.pdf", mimeType: "application/pdf", size: 10, isInline: false }],
        }),
        makeFetchedMessage(4, { date: at(4), seen: false, flagged: true }),
        makeFetchedMessage(5, { date: at(5), seen: true }),
        // Thread of 5: an unread reply in Archive does not make it unread in the Inbox.
      ]);
      s.upsertMessages("acc_1", "Archive", [
        makeFetchedMessage(9, { date: at(6), seen: false, flagged: true, messageId: "reply-5@example.org", inReplyTo: "msg-5@example.org" }),
      ]);
      s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
    }
    const listed = (filter?: Parameters<MailStore["listThreads"]>[4], limit = 50) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = s.listThreads("acc_1", INBOX, cursor, limit, filter);
        ids.push(...page.threads.map((t) => t.subject));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    };
    const subject = (uid: number) => `Invented subject ${uid}`;

    it("narrows by each flag, and by flags together on the same row only", () => {
      seed();
      expect(listed()).toEqual([5, 4, 3, 2, 1].map(subject));
      expect(listed({ unread: true })).toEqual([4, 1].map(subject));
      expect(listed({ flagged: true })).toEqual([4, 2].map(subject));
      expect(listed({ attachments: true })).toEqual([3].map(subject));
      expect(listed({ unread: true, flagged: true })).toEqual([4].map(subject));
      expect(listed({ unread: true, attachments: true })).toEqual([]);
    });

    it("pages across a filtered page boundary", () => {
      seed();
      expect(listed({ unread: true }, 1)).toEqual([4, 1].map(subject));
      expect(listed({ flagged: true }, 1)).toEqual([4, 2].map(subject));
    });

    it("ignores rows waiting to move, and keeps the open thread listed", () => {
      seed();
      s.queueMove([idIn(INBOX, 4)], "Archive");
      expect(listed({ unread: true })).toEqual([1].map(subject));
      s.markOpened(idIn(INBOX, 1));
      expect(listed({ unread: true })).toEqual([]);
      const open = s.getMessage(idIn(INBOX, 1))!.threadId;
      expect(listed({ unread: true, keep: open })).toEqual([1].map(subject));
      expect(listed({ keep: open })).toEqual([5, 3, 2, 1].map(subject));
    });

    it("filters a merged role across accounts", () => {
      seed();
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { date: later(10 * 3_600_000), seen: false, messageId: "b@example.org" })]);
      s.assignThreads("acc_2", buildThreads(s.threadingInputs("acc_2")));
      const all = (filter: Parameters<MailStore["listThreadsAll"]>[3], limit = 50) => {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const page = s.listThreadsAll("inbox", cursor, limit, filter);
          ids.push(...page.threads.map((t) => `${t.accountId}:${t.subject}`));
          cursor = page.nextCursor;
        } while (cursor !== null);
        return ids;
      };
      expect(all({ unread: true })).toEqual(["acc_2:Invented subject 1", "acc_1:Invented subject 4", "acc_1:Invented subject 1"]);
      expect(all({ unread: true }, 1)).toEqual(["acc_2:Invented subject 1", "acc_1:Invented subject 4", "acc_1:Invented subject 1"]);
      expect(all({ flagged: true, unread: true })).toEqual(["acc_1:Invented subject 4"]);
    });
  });

  describe("snoozes", () => {
    const row = (messageId: string, dueAt: string, state: "moving" | "snoozed" | "returning" = "moving", accountId = "acc_1") => ({
      messageId,
      accountId,
      returnTo: INBOX,
      dueAt,
      state,
    });

    it("create, list by due time, update, delete", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2), makeFetchedMessage(3)]);
      const [a, b, c] = [1, 2, 3].map((uid) => idIn(INBOX, uid)) as [string, string, string];
      expect(s.createSnoozes([row(a, later(3_000)), row(b, later(1_000)), row(c, later(2_000), "snoozed")], T0)).toEqual({ created: 3 });
      expect(s.listSnoozes("acc_1", { limit: 10 }).map((z) => z.messageId)).toEqual([b, c, a]);
      expect(s.listSnoozes("acc_1", { dueBefore: later(2_000), limit: 10 }).map((z) => z.messageId)).toEqual([b, c]);
      expect(s.listSnoozes("acc_1", { limit: 1 }).map((z) => z.messageId)).toEqual([b]);
      expect(s.listSnoozes("acc_2", { limit: 10 })).toEqual([]);

      expect(s.updateSnooze(a, { state: "returning", returnTo: "Archive" }, later(5))).toBe(true);
      expect(s.updateSnooze("m_none", { state: "snoozed" }, later(5))).toBe(false);
      expect(s.listSnoozes("acc_1", { limit: 10 }).find((z) => z.messageId === a)).toEqual({
        ...row(a, later(3_000), "returning"),
        returnTo: "Archive",
      });
      expect(s.deleteSnoozes([a, b, "m_none"])).toBe(2);
      expect(s.deleteSnoozes([])).toBe(0);
      expect(s.listSnoozes("acc_1", { limit: 10 }).map((z) => z.messageId)).toEqual([c]);
    });

    it("caps live snoozes per account, counting a replaced row once", () => {
      const many = Array.from({ length: 2_000 }, (_, i) => row(`m_${i}`, later(i)));
      expect(s.createSnoozes(many, T0)).toEqual({ created: 2_000 });
      expect(s.createSnoozes([row("m_more", later(1))], T0)).toEqual({ full: true });
      expect(s.listSnoozes("acc_1", { limit: 3_000 })).toHaveLength(2_000);
      expect(s.createSnoozes([row("m_0", later(99))], T0)).toEqual({ created: 1 });
      expect(s.createSnoozes([row("m_other", later(1), "moving", "acc_2")], T0)).toEqual({ created: 1 });
    });

    it("snoozeViews: in-flight rows first, then snoozed by due time, with where each message is", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
      s.upsertMessages("acc_1", "Snoozed", [makeFetchedMessage(1, { messageId: "z@example.org" })]);
      const [a, b] = [idIn(INBOX, 1), idIn(INBOX, 2)];
      const z = idIn("Snoozed", 1);
      s.queueMove([b], "Snoozed");
      s.createSnoozes([row(z, later(1_000), "snoozed"), row(a, later(9_000), "returning"), row(b, later(5_000)), row("m_gone", later(1), "snoozed")], T0);

      const views = s.snoozeViews("acc_1", 10);
      expect(views.map((v) => v.snooze.messageId)).toEqual([b, a, "m_gone", z]);
      expect(views[0]!.row).toEqual({ folder: INBOX, uid: 2, movePending: "Snoozed" });
      expect(views[1]!.row).toEqual({ folder: INBOX, uid: 1, movePending: null });
      expect(views[2]!.row).toBeNull();
      expect(s.snoozeViews("acc_1", 2).map((v) => v.snooze.messageId)).toEqual([b, a]);
    });

    it("snoozedUntil is the earliest due time of the thread's rows in the viewed folder", () => {
      s.upsertMessages("acc_1", "Snoozed", [
        makeFetchedMessage(1, { date: later(1) }),
        makeFetchedMessage(2, { date: later(2), inReplyTo: "msg-1@example.org" }),
      ]);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(3, { date: later(3) })]);
      s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));
      const [one, two] = [idIn("Snoozed", 1), idIn("Snoozed", 2)];
      s.createSnoozes([row(one, later(9_000), "snoozed"), row(two, later(4_000), "snoozed")], T0);

      const [thread] = s.listThreads("acc_1", "Snoozed", null, 10).threads;
      expect(thread!.snoozedUntil).toBe(later(4_000));
      expect(s.getThread(thread!.id, "Snoozed")!.thread.snoozedUntil).toBe(later(4_000));
      expect(s.getThread(thread!.id, INBOX)!.thread.snoozedUntil).toBeNull();
      expect(s.listThreads("acc_1", INBOX, null, 10).threads[0]!.snoozedUntil).toBeNull();
    });

    it("every message removal deletes the rows' snoozes", () => {
      s.upsertMessages("acc_1", "Snoozed", [makeFetchedMessage(1), makeFetchedMessage(2), makeFetchedMessage(3)]);
      const [a, b, c] = [1, 2, 3].map((uid) => idIn("Snoozed", uid)) as [string, string, string];
      s.createSnoozes([row(a, later(1), "snoozed"), row(b, later(2), "snoozed"), row(c, later(3), "snoozed")], T0);
      s.deleteByUids("acc_1", "Snoozed", [1]);
      s.beginFolderReset("acc_1", "Snoozed");
      s.upsertMessages("acc_1", "Snoozed", [makeFetchedMessage(8, { messageId: "msg-2@example.org" })]);
      s.finishFolderReset("acc_1", "Snoozed");
      expect(s.listSnoozes("acc_1", { limit: 10 }).map((z) => z.messageId)).toEqual([b]);
      s.saveFolders("acc_1", FOLDERS_3E.filter((f) => f.path !== "Snoozed"));
      expect(s.listSnoozes("acc_1", { limit: 10 })).toEqual([]);
    });
  });

  describe("block rules", () => {
    it("are global: added once per kind and value, listed oldest first, removed by id", () => {
      expect(s.addBlockRule("address", "news@example.com", "br_1", T0)).toEqual({
        rule: { id: "br_1", kind: "address", value: "news@example.com", createdAt: T0 },
        created: true,
      });
      expect(s.addBlockRule("address", "news@example.com", "br_2", later(1))).toEqual({
        rule: { id: "br_1", kind: "address", value: "news@example.com", createdAt: T0 },
        created: false,
      });
      s.addBlockRule("domain", "news@example.com", "br_3", later(2));
      expect(s.listBlockRules().map((r) => r.id)).toEqual(["br_1", "br_3"]);
      expect(s.removeBlockRule("br_1")).toBe(true);
      expect(s.removeBlockRule("br_1")).toBe(false);
      expect(s.listBlockRules().map((r) => r.id)).toEqual(["br_3"]);
    });
  });

  describe("unsubscribe", () => {
    it("fills info only where NULL and only for the stored UIDVALIDITY; lists unknown bulk rows newest first", () => {
      const state = { uidValidity: 4, lastUid: 9, syncedSince: EPOCH };
      s.saveSyncState("acc_1", INBOX, state);
      const list = { listId: "<l.example.com>", listUnsubscribe: "<mailto:x@example.com>", precedence: null, autoSubmitted: null };
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { bulkHeaders: list, from: { name: "News", address: "news@example.com" } }),
        makeFetchedMessage(2, { bulkHeaders: list }),
        makeFetchedMessage(3, { bulkHeaders: list, unsubscribe: INFO }),
        makeFetchedMessage(4, { bulkHeaders: { ...list, listId: null, listUnsubscribe: null } }),
      ]);
      expect(s.unsubscribeUnknown("acc_1", INBOX, null, 10)).toEqual([
        { uid: 2, from: { name: "Sender", address: "sender@example.org" } },
        { uid: 1, from: { name: "News", address: "news@example.com" } },
      ]);
      expect(s.unsubscribeUnknown("acc_1", INBOX, 2, 10).map((r) => r.uid)).toEqual([1]);
      expect(s.unsubscribeUnknown("acc_1", INBOX, null, 1).map((r) => r.uid)).toEqual([2]);

      const other = { ...INFO, listKey: "other.example.com" };
      expect(s.fillUnsubscribe("acc_1", INBOX, 5, [{ uid: 1, info: other }])).toBe(0);
      expect(s.fillUnsubscribe("acc_1", INBOX, 4, [{ uid: 1, info: other }, { uid: 2, info: null }, { uid: 3, info: other }])).toBe(1);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 1))).toEqual(other);
      expect(s.getUnsubscribeInfo(idIn(INBOX, 2))).toBeNull();
      expect(s.getUnsubscribeInfo(idIn(INBOX, 3))).toEqual(INFO);
    });

    it("keeps one request per account and list", () => {
      const request = { accountId: "acc_1", listKey: "l.example.com", method: "mailto" as const, state: "queued" as const, outboxId: "out_1", requestedAt: T0 };
      s.putUnsubscribe(request);
      s.putUnsubscribe({ ...request, state: "sent" });
      expect(s.getUnsubscribe("acc_1", "l.example.com")).toEqual({ ...request, state: "sent" });
      expect(s.getUnsubscribe("acc_2", "l.example.com")).toBeNull();
    });

    it("a mailto request follows its outbox row by outbox id", () => {
      const request = { accountId: "acc_1", listKey: "l.example.com", method: "mailto" as const, state: "queued" as const, outboxId: "out_1", requestedAt: T0 };
      s.putUnsubscribe(request);
      expect(s.setUnsubscribeStateByOutbox("out_1", "sent")).toBe(true);
      expect(s.setUnsubscribeStateByOutbox("out_2", "failed")).toBe(false);
      expect(s.getUnsubscribe("acc_1", "l.example.com")).toEqual({ ...request, state: "sent" });
    });
  });

  describe("notifyRows", () => {
    it("reads the rows notify and block judge, in the order asked", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bulkHeaders: { listId: null, listUnsubscribe: null, precedence: null, autoSubmitted: null } })]);
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1, { messageId: "a@example.org", seen: true })]);
      const [inbox, archived] = [idIn(INBOX, 1), idIn("Archive", 1)];
      expect(s.notifyRows([archived, "m_none", inbox], later(5))).toEqual([
        expect.objectContaining({ id: archived, folderRole: "archive", isRead: true, bulk: null, fetchedAt: later(5) }),
        {
          id: inbox,
          accountId: "acc_1",
          threadId: s.getMessage(inbox)!.threadId,
          folderRole: "inbox",
          isRead: false,
          movePending: null,
          uid: 1,
          bulk: false,
          fromName: "Sender",
          fromAddress: "sender@example.org",
          date: "2026-11-10T09:00:00.000Z",
          fetchedAt: later(5),
          dedupKey: "mid:msg-1@example.org:100",
        },
      ]);
      expect(s.notifyRows([], T0)).toEqual([]);
    });
  });

  describe("triage batches", () => {
    const batch = (id: string, threadId = "bb_t", createdAt = T0) => ({
      id,
      threadId,
      contentHash: "b".repeat(64),
      summary: "Invented summary",
      createdAt,
      expiresAt: later(86_400_000),
    });
    const items = (batchId: string) =>
      [0, 1].map((position) => ({
        batchId,
        position,
        messageId: `m_${position}`,
        accountId: "acc_1",
        action: position === 0 ? ("archive" as const) : ("snooze" as const),
        snoozeUntil: position === 0 ? null : later(3_600_000),
        note: position === 0 ? "Invented note" : null,
        outcome: null,
      }));

    it("stores a pending batch with its items and moves it by compare-and-swap", () => {
      s.createTriageBatch(batch("tb_1"), items("tb_1"));
      expect(s.getTriageBatch("tb_1")).toEqual({
        batch: {
          ...batch("tb_1"),
          state: "pending",
          viewTokenHash: null,
          approved: null,
          createSnoozeFolder: null,
          updatedAt: T0,
        },
        items: items("tb_1"),
      });
      expect(s.getTriageBatch("tb_none")).toBeNull();

      expect(s.transitionTriageBatch("tb_1", ["pending"], "pending", { viewTokenHash: "c".repeat(64) }, later(1))).toBe(true);
      expect(s.transitionTriageBatch("tb_1", ["confirming"], "applying", {}, later(2))).toBe(false);
      expect(
        s.transitionTriageBatch("tb_1", ["pending"], "confirming", { approved: [1], createSnoozeFolder: ["acc_1"] }, later(3)),
      ).toBe(true);
      expect(s.getTriageBatch("tb_1")!.batch).toMatchObject({
        state: "confirming",
        viewTokenHash: "c".repeat(64),
        approved: [1],
        createSnoozeFolder: ["acc_1"],
        updatedAt: later(3),
      });
      expect(s.transitionTriageBatch("tb_1", ["confirming"], "confirming", { viewTokenHash: null }, later(4))).toBe(true);
      expect(s.getTriageBatch("tb_1")!.batch.viewTokenHash).toBeNull();

      s.setTriageOutcomes("tb_1", [{ position: 0, outcome: "done" }, { position: 1, outcome: "not_approved" }, { position: 7, outcome: "done" }]);
      expect(s.getTriageBatch("tb_1")!.items.map((i) => i.outcome)).toEqual(["done", "not_approved"]);
    });

    it("history has the day's batches and every unsettled one; start settles applying, pending and confirming", () => {
      s.createTriageBatch(batch("tb_old", "bb_a", "2026-11-01T00:00:00.000Z"), items("tb_old"));
      s.createTriageBatch(batch("tb_old_done", "bb_a", "2026-11-01T00:00:00.000Z"), items("tb_old_done"));
      s.transitionTriageBatch("tb_old_done", ["pending"], "applied", {}, "2026-11-01T00:01:00.000Z");
      s.createTriageBatch(batch("tb_new", "bb_b", later(1)), items("tb_new"));
      s.createTriageBatch(batch("tb_apply", "bb_b", later(2)), items("tb_apply"));
      s.transitionTriageBatch("tb_apply", ["pending"], "applying", {}, later(3));
      s.createTriageBatch(batch("tb_confirm", "bb_c", later(2)), items("tb_confirm"));
      s.transitionTriageBatch("tb_confirm", ["pending"], "confirming", {}, later(3));

      const history = s.triageHistory(T0);
      expect(history.map((h) => `${h.threadId}:${h.state}`).sort()).toEqual(
        ["bb_a:pending", "bb_b:pending", "bb_b:applying", "bb_c:confirming"].sort(),
      );

      expect(s.settleTriageAtStart(later(10))).toEqual({ interrupted: 1, expired: 3 });
      expect(s.getTriageBatch("tb_apply")!.batch).toMatchObject({ state: "interrupted", updatedAt: later(10) });
      expect(s.getTriageBatch("tb_confirm")!.batch.state).toBe("expired");
      expect(s.getTriageBatch("tb_old_done")!.batch.state).toBe("applied");
      expect(s.settleTriageAtStart(later(11))).toEqual({ interrupted: 0, expired: 0 });
    });
  });

  describe("deleteAccount", () => {
    it("drops the account's snoozes, unsubscribes and triage items, keeps block rules", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "b@example.org" })]);
      const [a, b] = [idIn(INBOX, 1), idIn(INBOX, 1, "acc_2")];
      s.createSnoozes(
        [
          { messageId: a, accountId: "acc_1", returnTo: INBOX, dueAt: later(1), state: "moving" },
          { messageId: b, accountId: "acc_2", returnTo: INBOX, dueAt: later(1), state: "moving" },
        ],
        T0,
      );
      s.putUnsubscribe({ accountId: "acc_1", listKey: "l", method: "mailto", state: "sent", outboxId: null, requestedAt: T0 });
      s.addBlockRule("address", "news@example.com", "br_1", T0);
      s.createTriageBatch(
        { id: "tb_1", threadId: "bb", contentHash: "a".repeat(64), summary: null, createdAt: T0, expiresAt: later(1) },
        [{ batchId: "tb_1", position: 0, messageId: a, accountId: "acc_1", action: "archive", snoozeUntil: null, note: null, outcome: null }],
      );

      s.deleteAccount("acc_1");

      expect(s.listSnoozes("acc_1", { limit: 10 })).toEqual([]);
      expect(s.listSnoozes("acc_2", { limit: 10 }).map((z) => z.messageId)).toEqual([b]);
      expect(s.getUnsubscribe("acc_1", "l")).toBeNull();
      expect(s.getTriageBatch("tb_1")).toBeNull();
      expect(s.listBlockRules().map((r) => r.id)).toEqual(["br_1"]);
    });
  });

  describe("cancelSendPurpose", () => {
    it("deletes a purpose draft's outbox row and the draft in one go; refuses other drafts and states", () => {
      s.createDraft(newDraft({ id: "d_unsub", purpose: "unsubscribe" }));
      s.queueOutbox(newOutbox({ id: "out_unsub", draftId: "d_unsub" }), 1);
      s.createDraft(newDraft({ id: "d_owner", messageId: "<owner@example.org>" }));
      s.queueOutbox(newOutbox({ id: "out_owner", draftId: "d_owner", messageId: "<owner@example.org>" }), 1);

      expect(s.cancelSendPurpose("out_owner", ["queued"])).toEqual({ cancelled: false });
      expect(s.getOutbox("out_owner")).not.toBeNull();
      expect(s.cancelSendPurpose("out_unsub", ["held"])).toEqual({ cancelled: false });
      expect(s.getDraft("d_unsub")).toMatchObject({ purpose: "unsubscribe" });
      expect(s.cancelSendPurpose("out_unsub", ["queued"])).toEqual({ cancelled: true });
      expect(s.getOutbox("out_unsub")).toBeNull();
      expect(s.getDraft("d_unsub")).toBeNull();
      expect(s.cancelSendPurpose("out_none", ["queued"])).toEqual({ cancelled: false });
    });
  });
});

// ---- Slice 3f: AI scope, agent log, AI results, tasks, categories, Today, reminders ----

const FOLDERS_3F: RemoteFolder[] = [
  { path: INBOX, name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
  { path: "Spam", name: "Spam", delimiter: "/", specialUse: "junk", selectable: true, subscribed: true },
  { path: "Trash", name: "Trash", delimiter: "/", specialUse: "trash", selectable: true, subscribed: true },
  { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true, subscribed: true },
  { path: "Sent", name: "Sent", delimiter: "/", specialUse: "sent", selectable: true, subscribed: true },
  { path: "Projects", name: "Projects", delimiter: "/", specialUse: null, selectable: true, subscribed: true },
];

function aiScope(
  accounts: [string, AccountScope][] = [],
  senders: { addresses?: string[]; domains?: string[] } = {},
): AiScope {
  return {
    accounts: new Map(accounts),
    senders: { addresses: new Set(senders.addresses ?? []), domains: new Set(senders.domains ?? []) },
  };
}

const ALL_TEXT: ParsedQuery = parseQuery("");

function logInput(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    at: T0,
    actor: "agent",
    threadId: null,
    tool: "search",
    outcome: "ok",
    messageIds: [],
    count: 0,
    hiddenCount: 0,
    refId: null,
    provider: null,
    model: null,
    ...overrides,
  };
}

function reminderRow(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    id: "r_1",
    accountId: "acc_1",
    outboxId: "out_1",
    rfcMessageId: "<sent-1@example.org>",
    threadId: null,
    days: 3,
    sentAt: null,
    dueAt: null,
    state: "queued",
    createdAt: T0,
    ...overrides,
  };
}

describe("slice-3f migration (SQLite)", () => {
  it("element 10 on a 3e database adds the tables without REFERENCES; summaries have no category", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 10).forEach((s) => old.exec(s)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    legacy.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);

    old.transaction(() => MIGRATIONS.slice(10).forEach((s) => old.exec(s)))();

    expect(MIGRATIONS).toHaveLength(21);
    const migrated = createSqliteStore(old);
    migrated.assignThreads("acc_1", new Map());
    expect(migrated.listThreads("acc_1", INBOX, null, 10).threads).toEqual([
      expect.objectContaining({ category: null, categorySuggestion: null }),
    ]);
    const tables = [
      "ai_scope_accounts",
      "ai_scope_senders",
      "agent_log",
      "ai_results",
      "mail_tasks",
      "message_categories",
      "category_suggestions",
      "category_rules",
      "digests",
      "reply_dismissals",
      "reply_reminders",
    ];
    const objects = old
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`)
      .all(...tables) as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([...tables].sort());
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
    const columns = (table: string) => (old.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("digests")).toContain("notified_at");
    expect(columns("reply_reminders")).toContain("notified_at");
  });

  it(
    "one category-filter page stays fast at 5 000+ threads",
    () => {
      store.saveFolders("acc_1", FOLDERS_3F);
      store.upsertMessages(
        "acc_1",
        INBOX,
        Array.from({ length: 5_200 }, (_, i) =>
          makeFetchedMessage(i + 1, {
            messageId: `perf-${i}@example.org`,
            date: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
          }),
        ),
      );
      store.assignThreads("acc_1", new Map());
      const ids = store.localFolderIndex("acc_1", INBOX, EPOCH).map((e) => e.id);
      store.setCategories(ids.filter((_, i) => i % 7 === 0), "bills", "owner", T0);
      const first = store.listThreads("acc_1", INBOX, null, 50, { category: "bills" });
      const { value: page, ms } = timeOne(() => store.listThreads("acc_1", INBOX, first.nextCursor, 50, { category: "bills" }));
      expect(ms).toBeLessThan(PAGE_MS);
      expect(page.threads).toHaveLength(50);
      expect(page.threads.every((t) => t.category === "bills")).toBe(true);
      const { value: merged, ms: mergedMs } = timeOne(() => store.listThreadsAll("inbox", null, 50, { category: "bills" }));
      expect(mergedMs).toBeLessThan(PAGE_MS);
      expect(merged.threads).toHaveLength(50);
    },
    SEEDING_TIMEOUT_MS,
  );

  it("the SQL scope function picks up a new scope at once", () => {
    store.saveFolders("acc_1", FOLDERS_3F);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    expect(store.search(ALL_TEXT, null, 10, { scoped: true })).toHaveLength(1);
    store.setAiScope(aiScope([["acc_1", { mode: "none" }]]));
    expect(store.search(ALL_TEXT, null, 10, { scoped: true })).toHaveLength(0);
    store.setAiScope(aiScope());
    expect(store.search(ALL_TEXT, null, 10, { scoped: true })).toHaveLength(1);
  });
});

describe.each(storeKinds)("slice-3f store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org", username: "second@example.org" }));
    s.saveFolders("acc_1", FOLDERS_3F);
    s.saveFolders("acc_2", FOLDERS_3F);
  });
  const idIn = (folder: string, uid: number, accountId = "acc_1") =>
    s.localFolderIndex(accountId, folder, EPOCH).find((e) => e.uid === uid)!.id;
  const thread = (accountId = "acc_1") => s.assignThreads(accountId, buildThreads(s.threadingInputs(accountId)));
  const ids = (summaries: { id: string }[]) => summaries.map((m) => m.id).sort();

  describe("AI access scope", () => {
    beforeEach(() => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { from: { name: "Ada", address: "ada@example.org" } }),
        makeFetchedMessage(5, { from: { name: "Ex", address: "ex@example.net" }, messageId: "ex-1@example.net" }),
        makeFetchedMessage(6, { cc: [{ name: null, address: "someone@sub.blocked.example.com" }] }),
        // A reply in the excluded sender's conversation, from someone else.
        makeFetchedMessage(7, {
          from: { name: "Bo", address: "bo@example.org" },
          inReplyTo: "ex-1@example.net",
          references: ["ex-1@example.net"],
          subject: "Re: Invented subject 5",
        }),
      ]);
      s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(2)]);
      s.upsertMessages("acc_1", "Trash", [makeFetchedMessage(3)]);
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(4)]);
      // One message in Archive and in Trash: the dedup must pick the in-scope copy.
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(10, { messageId: "dup@example.org" })]);
      s.upsertMessages("acc_1", "Trash", [makeFetchedMessage(11, { messageId: "dup@example.org" })]);
      s.upsertMessages("acc_1", "Projects", [makeFetchedMessage(8)]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "other-account@example.org" })]);
      thread("acc_1");
      thread("acc_2");
    });

    it("leaves Spam and Trash out in every mode and keeps unscoped calls unchanged", () => {
      s.setAiScope(aiScope());
      const scoped = ids(s.search(ALL_TEXT, null, 50, { scoped: true }));
      expect(scoped).not.toContain(idIn("Spam", 2));
      expect(scoped).not.toContain(idIn("Trash", 3));
      expect(scoped).toContain(idIn("Archive", 4));
      expect(ids(s.search(ALL_TEXT, null, 50))).toContain(idIn("Spam", 2));
      expect(s.getMessage(idIn("Spam", 2))!.inAiScope).toBe(false);
      expect(s.getMessage(idIn(INBOX, 1))!.inAiScope).toBe(true);
    });

    it("applies the account modes and fails closed on a stale folder path", () => {
      s.setAiScope(aiScope([["acc_1", { mode: "folders", folders: ["Archive", "Renamed"] }], ["acc_2", { mode: "none" }]]));
      const scoped = ids(s.search(ALL_TEXT, null, 50, { scoped: true }));
      expect(scoped).toEqual([idIn("Archive", 4), idIn("Archive", 10)].sort());
      expect(s.scopedMessage(idIn(INBOX, 1, "acc_2"))).toBeNull();
      s.setAiScope(aiScope([["acc_1", { mode: "folders", folders: ["Renamed"] }]]));
      expect(s.search(ALL_TEXT, "acc_1", 50, { scoped: true })).toEqual([]);
      expect(s.search(ALL_TEXT, "acc_2", 50, { scoped: true })).toHaveLength(1);
    });

    it("excludes a sender over From, To, Cc and the whole conversation", () => {
      s.setAiScope(aiScope([], { addresses: ["ex@example.net"], domains: ["blocked.example.com"] }));
      const scoped = ids(s.search(ALL_TEXT, "acc_1", 50, { scoped: true }));
      expect(scoped).toContain(idIn(INBOX, 1));
      expect(scoped).not.toContain(idIn(INBOX, 5));
      expect(scoped).not.toContain(idIn(INBOX, 6));
      expect(scoped).not.toContain(idIn(INBOX, 7));
      expect(s.scopedMessage(idIn(INBOX, 7))).toBeNull();
      expect(s.getMessage(idIn(INBOX, 7))!.inAiScope).toBe(false);
      const inbox = s.inboxMessages("acc_1", { unreadOnly: false, limit: 50, scoped: true }).map((m) => m.id);
      expect(inbox).toEqual([idIn(INBOX, 1)]);
      expect(s.inboxMessages("acc_1", { unreadOnly: false, limit: 50 })).toHaveLength(4);
    });

    it("lists a Gmail Inbox message whose in-scope copy is its All Mail copy (chosen folders)", () => {
      s.saveFolders("acc_2", [...FOLDERS_3F, { path: "[Gmail]/All Mail", name: "All Mail", delimiter: "/", specialUse: "all", selectable: true, subscribed: true }]);
      s.upsertMessages("acc_2", "[Gmail]/All Mail", [makeFetchedMessage(9, { messageId: "other-account@example.org" })]);
      thread("acc_2");
      s.setAiScope(aiScope([["acc_2", { mode: "folders", folders: ["[Gmail]/All Mail"] }]]));
      const inboxCopy = idIn(INBOX, 1, "acc_2");
      expect(s.scopedMessage(inboxCopy)).not.toBeNull();
      expect(s.inboxMessages("acc_2", { unreadOnly: false, limit: 50, scoped: true }).map((m) => m.id)).toEqual([inboxCopy]);
      // A copy in Spam or Trash never lends its scope: only All Mail does.
      s.setAiScope(aiScope([["acc_2", { mode: "folders", folders: ["Archive"] }]]));
      expect(s.inboxMessages("acc_2", { unreadOnly: false, limit: 50, scoped: true })).toEqual([]);
    });

    it("picks the in-scope copy before the dedup and answers an out-of-scope id as unknown", () => {
      s.setAiScope(aiScope());
      const archived = idIn("Archive", 10);
      const trashed = idIn("Trash", 11);
      expect(ids(s.search(parseQuery(""), "acc_1", 50))).toContain(trashed);
      const scoped = ids(s.search(ALL_TEXT, "acc_1", 50, { scoped: true }));
      expect(scoped).toContain(archived);
      expect(scoped).not.toContain(trashed);
      expect(s.scopedMessage(trashed)!.id).toBe(archived);
      expect(s.scopedMessage(archived)!.id).toBe(archived);
      expect(s.getMessage(trashed)!.inAiScope).toBe(true);
      expect(s.scopedMessage(idIn("Spam", 2))).toBeNull();
      expect(s.scopedMessage("m_unknown")).toBeNull();
    });

    it("rebuilds the excluded conversations on refresh after new rows", () => {
      s.setAiScope(aiScope([], { addresses: ["late@example.net"] }));
      expect(s.scopedMessage(idIn(INBOX, 1))).not.toBeNull();
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(20, {
          from: { name: "Late", address: "late@example.net" },
          inReplyTo: "msg-1@example.org",
          references: ["msg-1@example.org"],
        }),
      ]);
      thread("acc_1");
      s.refreshExcludedThreads();
      expect(s.scopedMessage(idIn(INBOX, 1))).toBeNull();
    });

    it("new rows from an excluded sender close their conversation before any refresh (a round still running or failed)", () => {
      s.setAiScope(aiScope([], { addresses: ["late@example.net"] }));
      expect(s.scopedMessage(idIn(INBOX, 1))).not.toBeNull();
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(20, {
          from: { name: "Late", address: "late@example.net" },
          inReplyTo: "msg-1@example.org",
          references: ["msg-1@example.org"],
        }),
      ]);
      thread("acc_1");
      expect(s.scopedMessage(idIn(INBOX, 1))).toBeNull();
      expect(s.getMessage(idIn(INBOX, 1))!.inAiScope).toBe(false);
      expect(ids(s.search(ALL_TEXT, "acc_1", 50, { scoped: true }))).not.toContain(idIn(INBOX, 1));
      expect(s.inboxMessages("acc_1", { unreadOnly: false, limit: 50, scoped: true }).map((m) => m.id)).not.toContain(idIn(INBOX, 1));
    });

    it("stores the scope rows and loads them back", () => {
      s.putAiScope(
        [
          { accountId: "acc_1", scope: { mode: "folders", folders: [INBOX, "Archive"] } },
          { accountId: "acc_2", scope: { mode: "none" } },
        ],
        [
          { kind: "address", value: "ex@example.net" },
          { kind: "domain", value: "blocked.example.com" },
        ],
        T0,
      );
      const loaded = s.loadAiScope();
      expect([...loaded.accounts]).toEqual([
        ["acc_1", { mode: "folders", folders: [INBOX, "Archive"] }],
        ["acc_2", { mode: "none" }],
      ]);
      expect([...loaded.senders.addresses]).toEqual(["ex@example.net"]);
      expect([...loaded.senders.domains]).toEqual(["blocked.example.com"]);
      expect(s.getAiScope().accounts.size).toBe(0);
      s.setAiScope(loaded);
      expect(s.getAiScope()).toBe(loaded);
      s.putAiScope([], [], T0);
      expect(s.loadAiScope().accounts.size).toBe(0);
    });
  });

  describe("scoped contacts", () => {
    beforeEach(() => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { from: { name: "Ada Planner", address: "ada@example.org" }, subject: "Garden plan" }),
        makeFetchedMessage(2, { from: { name: "Ex Planner", address: "ex@example.net" }, subject: "Garden tools" }),
        makeFetchedMessage(3, {
          from: { name: "Code Sender", address: "codes@example.org" },
          subject: "Sign in",
          bodyText: "Your verification code is 482913. It expires soon.",
        }),
      ]);
      s.upsertMessages("acc_1", "Archive", [
        makeFetchedMessage(4, { from: { name: "Archive Friend", address: "friend@example.org" }, subject: "Garden party" }),
      ]);
      thread("acc_1");
    });

    it("neither returns nor counts excluded or out-of-scope correspondence", () => {
      expect(s.contacts("garden", 10).map((c) => c.address).sort()).toEqual(
        ["ada@example.org", "ex@example.net", "friend@example.org"].sort(),
      );
      s.setAiScope(aiScope([["acc_1", { mode: "folders", folders: [INBOX] }]], { domains: ["example.net"] }));
      expect(s.contacts("garden", 10, { scoped: true }).map((c) => c.address)).toEqual(["ada@example.org"]);
      expect(s.contacts("planner", 10, { scoped: true }).map((c) => c.address)).toEqual(["ada@example.org"]);
      expect(s.contacts("garden", 10).map((c) => c.address)).toHaveLength(3);
    });

    it("never finds a contact by a secret in their mail", () => {
      s.setAiScope(aiScope());
      expect(s.contacts("482913", 10, { scoped: true })).toEqual([]);
      expect(s.contacts("verification", 10, { scoped: true }).map((c) => c.address)).toEqual(["codes@example.org"]);
    });
  });

  describe("agent log", () => {
    it("appends content-free rows, updates by refId, pages by thread, clears and purges", () => {
      const first = s.appendAgentLog(logInput({ threadId: "th_1", messageIds: ["m_1", "m_2"], count: 2 }));
      const proposal = s.appendAgentLog(logInput({ tool: "propose", outcome: "proposed", refId: "p_1", threadId: "th_1" }));
      s.appendAgentLog(logInput({ threadId: "th_2", messageIds: Array.from({ length: 60 }, (_, i) => `m_${i}`) }));
      expect(proposal).toBeGreaterThan(first);
      expect(s.updateAgentLog("p_1", "sent", 1)).toBe(1);
      expect(s.updateAgentLog("p_unknown", "sent", 1)).toBe(0);

      const page1 = s.listAgentLog({ threadId: "th_1", limit: 1 });
      expect(page1.entries).toEqual([expect.objectContaining({ seq: proposal, outcome: "sent", count: 1, refId: "p_1" })]);
      const page2 = s.listAgentLog({ threadId: "th_1", cursor: page1.next, limit: 1 });
      expect(page2.entries).toEqual([expect.objectContaining({ seq: first, messageIds: ["m_1", "m_2"], count: 2 })]);
      expect(page2.next).toBeNull();
      const all = s.listAgentLog({ limit: 10 }).entries;
      expect(all.map((e) => e.threadId)).toEqual(["th_2", "th_1", "th_1"]);
      expect(all[0]!.messageIds).toHaveLength(50);

      expect(s.clearAgentLog()).toBe(3);
      expect(s.listAgentLog({ limit: 10 }).entries).toEqual([]);
    });

    it("purges by age and by count", () => {
      s.appendAgentLog(logInput({ at: "2026-01-01T00:00:00.000Z" }));
      for (let i = 0; i < 4; i++) s.appendAgentLog(logInput({ at: later(i * 1000), count: i }));
      expect(s.purgeAgentLog(T0, 3)).toBe(2);
      expect(s.listAgentLog({ limit: 10 }).entries.map((e) => e.count)).toEqual([3, 2, 1]);
    });
  });

  describe("AI results", () => {
    const result = (overrides: Partial<AiResultRecord> = {}): AiResultRecord => ({
      kind: "summary",
      subjectId: "th_1",
      accountId: "acc_1",
      sourceSha256: "a".repeat(64),
      provider: "provider-x",
      model: "model-y",
      resultJson: '{"decisions":[]}',
      notesJson: '{"hidden":0}',
      createdAt: T0,
      ...overrides,
    });

    it("round-trips, replaces by (kind, subject) and refuses more than 64 KiB", () => {
      expect(s.getAiResult("summary", "th_1")).toBeNull();
      s.putAiResult(result());
      expect(s.getAiResult("summary", "th_1")).toEqual(result());
      s.putAiResult(result({ sourceSha256: "b".repeat(64) }));
      expect(s.getAiResult("summary", "th_1")!.sourceSha256).toBe("b".repeat(64));
      expect(() => s.putAiResult(result({ resultJson: "x".repeat(AI_RESULT_MAX_BYTES + 1) }))).toThrow();
      expect(s.getAiResult("summary", "th_1")!.sourceSha256).toBe("b".repeat(64));
    });
  });

  describe("tasks", () => {
    const task = (id: string, due: string | null, messageId = "m_x"): NewTask => ({
      id,
      accountId: "acc_1",
      messageId,
      dedupKey: `k_${id}`,
      title: `Task ${id}`,
      due,
      createdAt: T0,
    });

    it("keeps, orders open tasks overdue, dated, undated, pages and counts", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      thread("acc_1");
      const message = idIn(INBOX, 1);
      expect(s.keepTasks([task("t_undated", null), task("t_late", "2026-11-10", message), task("t_today", "2026-11-15")])).toEqual({
        kept: 3,
      });
      s.keepTasks([task("t_next", "2026-11-20")]);
      const first = s.listTasks({ done: false, limit: 2 });
      expect(first.tasks.map((t) => t.id)).toEqual(["t_late", "t_today"]);
      expect(first.tasks[0]).toMatchObject({ messageId: message, threadId: s.getMessage(message)!.threadId, doneAt: null });
      const second = s.listTasks({ done: false, cursor: first.next, limit: 2 });
      expect(second.tasks.map((t) => t.id)).toEqual(["t_next", "t_undated"]);
      expect(second.next).toBeNull();
      expect(s.taskCounts("2026-11-15")).toEqual({ overdue: 1, today: 1 });
    });

    it("updates, marks done, deletes and nulls the message when the row goes", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      const message = idIn(INBOX, 1);
      s.keepTasks([task("t_1", "2026-11-10", message)]);
      expect(s.updateTask("t_1", { title: "Renamed", due: null }, later(1000))).toBe(true);
      expect(s.getTask("t_1")).toMatchObject({ title: "Renamed", due: null, updatedAt: later(1000) });
      expect(s.updateTask("t_1", { done: true }, later(2000))).toBe(true);
      expect(s.listTasks({ done: false, limit: 10 }).tasks).toEqual([]);
      expect(s.listTasks({ done: true, limit: 10 }).tasks.map((t) => t.doneAt)).toEqual([later(2000)]);
      expect(s.updateTask("t_1", { done: false }, later(3000))).toBe(true);
      expect(s.getTask("t_1")!.doneAt).toBeNull();
      s.deleteByUids("acc_1", INBOX, [1]);
      expect(s.getTask("t_1")).toMatchObject({ messageId: null, threadId: null });
      expect(s.deleteTask("t_1")).toBe(true);
      expect(s.deleteTask("t_1")).toBe(false);
      expect(s.updateTask("t_1", { done: true }, T0)).toBe(false);
    });

    it("refuses to keep past the open cap", () => {
      const many = Array.from({ length: TASKS_OPEN_MAX }, (_, i) => task(`t_${i}`, null));
      expect(s.keepTasks(many)).toEqual({ kept: TASKS_OPEN_MAX });
      expect(s.keepTasks([task("t_over", null)])).toEqual({ full: true });
      expect(s.getTask("t_over")).toBeNull();
    });
  });

  describe("categories", () => {
    beforeEach(() => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2), makeFetchedMessage(3)]);
      // The same message in Archive: labels key on (account, dedup key).
      s.upsertMessages("acc_1", "Archive", [makeFetchedMessage(9, { messageId: "msg-1@example.org" })]);
      thread("acc_1");
    });

    it("labels by dedup key, returns the previous labels and restores them", () => {
      const first = s.setCategories([idIn(INBOX, 1), idIn("Archive", 9), "m_unknown"], "bills", "owner", T0);
      expect(first.previous).toEqual([
        { accountId: "acc_1", dedupKey: expect.any(String), category: null, source: null },
      ]);
      expect(s.categoriesOf([idIn("Archive", 9)]).get(idIn("Archive", 9))).toEqual({
        category: "bills",
        source: "owner",
        suggestion: null,
      });
      const second = s.setCategories([idIn(INBOX, 1)], "personal", "owner", T0);
      expect(second.previous).toEqual([expect.objectContaining({ category: "bills", source: "owner" })]);
      s.restoreCategories(second.previous, T0);
      expect(s.categoriesOf([idIn(INBOX, 1)]).get(idIn(INBOX, 1))!.category).toBe("bills");
      s.restoreCategories(first.previous, T0);
      expect(s.categoriesOf([idIn(INBOX, 1)]).get(idIn(INBOX, 1))!.category).toBeNull();
      s.setCategories([idIn(INBOX, 2)], "newsletters", "owner", T0);
      s.setCategories([idIn(INBOX, 2)], null, "owner", T0);
      expect(s.categoriesOf([idIn(INBOX, 2)]).get(idIn(INBOX, 2))!.category).toBeNull();
      expect(s.categoriesOf(["m_unknown"]).size).toBe(0);
    });

    it("never lets a rule override the owner's label", () => {
      s.setCategories([idIn(INBOX, 1)], "personal", "owner", T0);
      const ruled = s.setCategories([idIn(INBOX, 1), idIn(INBOX, 2)], "newsletters", "rule", T0);
      expect(ruled.previous).toHaveLength(1);
      expect(s.categoriesOf([idIn(INBOX, 1)]).get(idIn(INBOX, 1))).toMatchObject({ category: "personal", source: "owner" });
      expect(s.categoriesOf([idIn(INBOX, 2)]).get(idIn(INBOX, 2))).toMatchObject({ category: "newsletters", source: "rule" });
      s.setCategories([idIn(INBOX, 2)], "bills", "owner", T0);
      expect(s.categoriesOf([idIn(INBOX, 2)]).get(idIn(INBOX, 2))).toMatchObject({ category: "bills", source: "owner" });
    });

    it("stores model suggestions and shows the latest member row's label and suggestion on the thread", () => {
      s.putCategorySuggestions(
        [
          { messageId: idIn(INBOX, 1), category: "notifications" },
          { messageId: idIn(INBOX, 2), category: "none" },
        ],
        T0,
      );
      s.setCategories([idIn(INBOX, 1)], "bills", "owner", T0);
      expect(s.categoriesOf([idIn(INBOX, 1)]).get(idIn(INBOX, 1))!.suggestion).toBe("notifications");
      expect(s.categoriesOf([idIn(INBOX, 2)]).get(idIn(INBOX, 2))!.suggestion).toBe("none");
      const byId = new Map(s.listThreads("acc_1", INBOX, null, 10).threads.map((t) => [t.id, t]));
      expect(byId.get(s.getMessage(idIn(INBOX, 1))!.threadId)).toMatchObject({ category: "bills", categorySuggestion: "notifications" });
      expect(byId.get(s.getMessage(idIn(INBOX, 2))!.threadId)).toMatchObject({ category: null, categorySuggestion: null });
      const merged = new Map(s.listThreadsAll("inbox", null, 10).threads.map((t) => [t.id, t]));
      expect(merged.get(s.getMessage(idIn(INBOX, 1))!.threadId)!.category).toBe("bills");
    });

    it("filters threads by category across a page boundary, in a folder and the merged role", () => {
      s.upsertMessages(
        "acc_2",
        INBOX,
        [1, 2, 3, 4].map((uid) => makeFetchedMessage(uid, { messageId: `two-${uid}@example.org`, date: later(uid * 60_000) })),
      );
      thread("acc_2");
      s.setCategories([idIn(INBOX, 1), idIn(INBOX, 3)], "bills", "owner", T0);
      s.setCategories([1, 2, 4].map((uid) => idIn(INBOX, uid, "acc_2")), "bills", "owner", T0);
      const page1 = s.listThreads("acc_1", INBOX, null, 1, { category: "bills" });
      const page2 = s.listThreads("acc_1", INBOX, page1.nextCursor, 1, { category: "bills" });
      expect(page2.nextCursor).toBeNull();
      expect([...page1.threads, ...page2.threads].map((t) => t.id).sort()).toEqual(
        [s.getMessage(idIn(INBOX, 1))!.threadId, s.getMessage(idIn(INBOX, 3))!.threadId].sort(),
      );
      expect(s.listThreads("acc_1", INBOX, null, 10, { category: "personal" }).threads).toEqual([]);
      const listed: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ReturnType<MailStore["listThreadsAll"]> = s.listThreadsAll("inbox", cursor, 2, { category: "bills" });
        listed.push(...page.threads.map((t) => t.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(listed).toHaveLength(5);
      expect(new Set(listed).size).toBe(5);
    });

    it("keeps rules unique per (kind, value), capped at 500, and removes them", () => {
      const added = s.addCategoryRule("domain", "shop.example.com", "bills", "cr_1", T0);
      expect(added).toEqual({
        rule: { id: "cr_1", kind: "domain", value: "shop.example.com", category: "bills", createdAt: T0 },
        created: true,
      });
      expect(s.addCategoryRule("domain", "shop.example.com", "personal", "cr_2", T0)).toMatchObject({
        rule: { id: "cr_1", category: "bills" },
        created: false,
      });
      for (let i = 1; i < CATEGORY_RULES_MAX; i++) s.addCategoryRule("address", `a${i}@example.org`, "personal", `cr_x${i}`, later(i));
      expect(s.listCategoryRules()).toHaveLength(CATEGORY_RULES_MAX);
      expect(s.addCategoryRule("address", "over@example.org", "personal", "cr_over", T0)).toEqual({ full: true });
      expect(s.listCategoryRules()[0]!.id).toBe("cr_1");
      expect(s.removeCategoryRule("cr_1")).toBe(true);
      expect(s.removeCategoryRule("cr_1")).toBe(false);
      expect(s.listCategoryRules()).toHaveLength(CATEGORY_RULES_MAX - 1);
    });
  });

  describe("Today", () => {
    it("answers each conversation's latest message with its role and the newest Sent row", () => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { date: later(60_000), to: [{ name: null, address: "owner@example.org" }] }),
        makeFetchedMessage(2, { date: later(120_000), messageId: "two@example.org", subject: "Topic" }),
        makeFetchedMessage(3, { date: "2026-10-01T00:00:00.000Z", messageId: "old@example.org", subject: "Old" }),
      ]);
      s.upsertMessages("acc_1", "Sent", [
        makeFetchedMessage(4, {
          date: later(180_000),
          messageId: "reply@example.org",
          inReplyTo: "two@example.org",
          references: ["two@example.org"],
          subject: "Re: Topic",
          from: { name: null, address: "owner@example.org" },
        }),
      ]);
      thread("acc_1");
      const candidates = s.replyCandidates(T0, 10);
      expect(candidates.map((c) => c.messageId)).toEqual([idIn("Sent", 4), idIn(INBOX, 1)]);
      expect(candidates[1]).toMatchObject({
        accountId: "acc_1",
        threadId: s.getMessage(idIn(INBOX, 1))!.threadId,
        folderRole: "inbox",
        fromAddress: "sender@example.org",
        to: ["owner@example.org"],
        cc: [],
        bulk: null,
        lastSentAt: null,
        date: later(60_000),
      });
      expect(candidates[0]).toMatchObject({ folderRole: "sent", lastSentAt: later(180_000) });
      expect(s.replyCandidates(T0, 1)).toHaveLength(1);
    });

    it("stores dismissals by the latest message's dedup key", () => {
      expect(s.replyDismissals().size).toBe(0);
      s.dismissReply("acc_1", "mid:a@example.org:100", T0);
      s.dismissReply("acc_1", "mid:a@example.org:100", later(1000));
      expect([...s.replyDismissals()]).toEqual([dismissalKey("acc_1", "mid:a@example.org:100")]);
    });

    it("builds a digest once per day and marks it notified once", () => {
      const digest = { day: "2026-11-15", builtAt: T0, since: later(-86_400_000), replyCount: 2, noticeCount: 1, notifiedAt: null };
      expect(s.getDigest("2026-11-15")).toBeNull();
      expect(s.putDigest(digest)).toBe(true);
      expect(s.putDigest({ ...digest, replyCount: 9 })).toBe(false);
      expect(s.getDigest("2026-11-15")).toEqual(digest);
      expect(s.markDigestNotified("2026-11-15", later(1000))).toBe(true);
      expect(s.markDigestNotified("2026-11-15", later(2000))).toBe(false);
      expect(s.getDigest("2026-11-15")!.notifiedAt).toBe(later(1000));
      expect(s.markDigestNotified("2026-11-16", later(1000))).toBe(false);
    });
  });

  describe("reply reminders", () => {
    it("creates queued, binds at send, deletes for a cancelled outbox row and caps live rows", () => {
      expect(s.createReminder(reminderRow())).toEqual({ created: true });
      expect(s.createReminder(reminderRow({ id: "r_2", outboxId: "out_2" }))).toEqual({ created: true });
      const bound = s.bindReminder("out_1", T0)!;
      expect(bound).toMatchObject({ id: "r_1", state: "waiting", outboxId: null, sentAt: T0, updatedAt: T0 });
      expect(bound.dueAt).toBe(dueAt(T0, 3));
      expect(s.bindReminder("out_1", T0)).toBeNull();
      expect(s.deleteReminderForOutbox("out_2")).toBe(1);
      expect(s.getReminder("r_2")).toBeNull();
      expect(s.deleteReminderForOutbox("out_1")).toBe(0);

      for (let i = 1; i < REMINDERS_LIVE_MAX; i++) s.createReminder(reminderRow({ id: `r_x${i}`, outboxId: null, state: "waiting" }));
      expect(s.createReminder(reminderRow({ id: "r_over" }))).toEqual({ full: true });
      s.updateReminder("r_x1", { state: "dismissed" }, T0);
      expect(s.createReminder(reminderRow({ id: "r_room" }))).toEqual({ created: true });
    });

    it("a queued reminder of a permanently failed send does not count toward the live cap", () => {
      s.createDraft(newDraft({ id: "d_f" }));
      s.queueOutbox(newOutbox({ id: "out_f", draftId: "d_f", sendAfter: later(1) }), 1);
      s.transitionOutbox("out_f", ["queued"], "failed", { errorKind: "auth" });
      s.createReminder(reminderRow({ id: "r_failed", outboxId: "out_f" }));
      for (let i = 1; i < REMINDERS_LIVE_MAX; i++) s.createReminder(reminderRow({ id: `r_x${i}`, outboxId: null, state: "waiting" }));
      expect(s.createReminder(reminderRow({ id: "r_room", outboxId: null, state: "waiting" }))).toEqual({ created: true });
      expect(s.createReminder(reminderRow({ id: "r_over", outboxId: null, state: "waiting" }))).toEqual({ full: true });
      // A retry makes it live again; it is still there to bind.
      expect(s.getReminder("r_failed")).toMatchObject({ state: "queued", outboxId: "out_f" });
    });

    it("lists by state and due time and updates fields", () => {
      s.createReminder(reminderRow({ id: "r_a", outboxId: null, state: "waiting", dueAt: later(3000), sentAt: T0 }));
      s.createReminder(reminderRow({ id: "r_b", outboxId: null, state: "waiting", dueAt: later(1000), sentAt: T0 }));
      s.createReminder(reminderRow({ id: "r_c", outboxId: "out_c", state: "queued" }));
      expect(s.listReminders({ states: ["waiting", "queued"], limit: 10 }).map((r) => r.id)).toEqual(["r_b", "r_a", "r_c"]);
      expect(s.listReminders({ states: ["waiting"], dueBefore: later(2000), limit: 10 }).map((r) => r.id)).toEqual(["r_b"]);
      expect(s.listReminders({ states: [], limit: 10 })).toEqual([]);
      expect(s.updateReminder("r_b", { state: "due", notifiedAt: later(5000), threadId: "th_9" }, later(5000))).toBe(true);
      expect(s.getReminder("r_b")).toMatchObject({ state: "due", notifiedAt: later(5000), threadId: "th_9", updatedAt: later(5000) });
      expect(s.updateReminder("r_b", { state: "waiting", days: 5, dueAt: later(9000) }, later(6000))).toBe(true);
      expect(s.getReminder("r_b")).toMatchObject({ state: "waiting", days: 5, dueAt: later(9000), notifiedAt: later(5000) });
      expect(s.updateReminder("r_unknown", { state: "due" }, T0)).toBe(false);
    });

    it("finds answering rows by In-Reply-To and References after the sent time, and the sent copy's thread", () => {
      s.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1, { messageId: "sent-1@example.org", date: T0 })]);
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(2, { inReplyTo: "<sent-1@example.org>", date: later(60_000) }),
        makeFetchedMessage(3, { references: ["other@example.org", "sent-1@example.org"], date: later(120_000) }),
        makeFetchedMessage(4, { inReplyTo: "sent-1@example.org", date: later(-60_000) }),
        makeFetchedMessage(5, { inReplyTo: "unrelated@example.org", date: later(60_000) }),
      ]);
      thread("acc_1");
      const rows = s.answeringRows(["<sent-1@example.org>"], T0);
      expect(rows.map((r) => r.id)).toEqual([idIn(INBOX, 2), idIn(INBOX, 3)]);
      expect(rows[1]).toMatchObject({
        accountId: "acc_1",
        messageId: "msg-3@example.org",
        references: ["other@example.org", "sent-1@example.org"],
        bulk: null,
        fromAddress: "sender@example.org",
      });
      expect(s.answeringRows([], T0)).toEqual([]);
      expect(s.sentCopyThread("acc_1", "<sent-1@example.org>")).toBe(s.getMessage(idIn("Sent", 1))!.threadId);
      expect(s.sentCopyThread("acc_2", "sent-1@example.org")).toBeNull();
    });
  });

  describe("deletes and the daily purge", () => {
    it("deleteAccount drops the account's 3f rows and keeps the global ones", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1)]);
      thread("acc_1");
      thread("acc_2");
      const one = idIn(INBOX, 1);
      const two = idIn(INBOX, 1, "acc_2");
      for (const [accountId, id] of [["acc_1", one], ["acc_2", two]] as const) {
        s.setCategories([id], "bills", "owner", T0);
        s.putCategorySuggestions([{ messageId: id, category: "notifications" }], T0);
        s.keepTasks([{ id: `t_${accountId}`, accountId, messageId: id, dedupKey: "k", title: "T", due: null, createdAt: T0 }]);
        s.putAiResult({
          kind: "summary",
          subjectId: s.getMessage(id)!.threadId,
          accountId,
          sourceSha256: "a".repeat(64),
          provider: "p",
          model: "m",
          resultJson: "{}",
          notesJson: "{}",
          createdAt: T0,
        });
        s.dismissReply(accountId, "k", T0);
        s.createReminder(reminderRow({ id: `r_${accountId}`, accountId }));
      }
      s.putAiScope([{ accountId: "acc_1", scope: { mode: "none" } }, { accountId: "acc_2", scope: { mode: "none" } }], [{ kind: "address", value: "x@example.org" }], T0);
      s.appendAgentLog(logInput());
      s.addCategoryRule("address", "x@example.org", "bills", "cr_1", T0);
      s.putDigest({ day: "2026-11-15", builtAt: T0, since: T0, replyCount: 0, noticeCount: 0, notifiedAt: null });
      const twoThread = s.getMessage(two)!.threadId;

      s.deleteAccount("acc_1");

      expect(s.getTask("t_acc_1")).toBeNull();
      expect(s.getTask("t_acc_2")).not.toBeNull();
      expect(s.getReminder("r_acc_1")).toBeNull();
      expect(s.getReminder("r_acc_2")).not.toBeNull();
      expect([...s.replyDismissals()]).toEqual([dismissalKey("acc_2", "k")]);
      expect(s.getAiResult("summary", twoThread)).not.toBeNull();
      expect(s.categoriesOf([two]).get(two)).toEqual({ category: "bills", source: "owner", suggestion: "notifications" });
      expect([...s.loadAiScope().accounts.keys()]).toEqual(["acc_2"]);
      expect([...s.loadAiScope().senders.addresses]).toEqual(["x@example.org"]);
      expect(s.listAgentLog({ limit: 10 }).entries).toHaveLength(1);
      expect(s.listCategoryRules()).toHaveLength(1);
      expect(s.getDigest("2026-11-15")).not.toBeNull();
    });

    it("prunes orphan labels, gone summaries, old digests, dismissals, answered reminders and the log", () => {
      const now = "2026-11-15T10:00:00.000Z";
      const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
      thread("acc_1");
      const kept = idIn(INBOX, 1);
      const gone = idIn(INBOX, 2);
      const goneThread = s.getMessage(gone)!.threadId;
      s.setCategories([kept, gone], "bills", "owner", now);
      s.putCategorySuggestions([{ messageId: kept, category: "personal" }, { messageId: gone, category: "personal" }], now);
      const summary = (subjectId: string): AiResultRecord => ({
        kind: "summary",
        subjectId,
        accountId: "acc_1",
        sourceSha256: "a".repeat(64),
        provider: "p",
        model: "m",
        resultJson: "{}",
        notesJson: "{}",
        createdAt: now,
      });
      s.putAiResult(summary(s.getMessage(kept)!.threadId));
      s.putAiResult(summary(goneThread));
      s.deleteByUids("acc_1", INBOX, [2]);
      thread("acc_1");
      s.putDigest({ day: "2026-09-01", builtAt: daysAgo(61), since: daysAgo(62), replyCount: 0, noticeCount: 0, notifiedAt: null });
      s.putDigest({ day: "2026-11-14", builtAt: daysAgo(1), since: daysAgo(2), replyCount: 0, noticeCount: 0, notifiedAt: null });
      s.dismissReply("acc_1", "old", daysAgo(61));
      s.dismissReply("acc_1", "new", daysAgo(1));
      s.createReminder(reminderRow({ id: "r_old", outboxId: null, state: "answered", createdAt: daysAgo(31) }));
      s.createReminder(reminderRow({ id: "r_new", outboxId: null, state: "answered", createdAt: daysAgo(1) }));
      s.createReminder(reminderRow({ id: "r_live", outboxId: null, state: "waiting", createdAt: daysAgo(90) }));
      s.createReminder(reminderRow({ id: "r_dismissed_old", outboxId: null, state: "dismissed", createdAt: daysAgo(31) }));
      s.createReminder(reminderRow({ id: "r_dismissed_new", outboxId: null, state: "dismissed", createdAt: daysAgo(1) }));
      s.appendAgentLog(logInput({ at: daysAgo(91) }));
      s.appendAgentLog(logInput({ at: daysAgo(1) }));

      expect(s.purgeDaily(now)).toBe(8);

      expect(s.categoriesOf([kept]).get(kept)).toEqual({ category: "bills", source: "owner", suggestion: "personal" });
      expect(s.getAiResult("summary", s.getMessage(kept)!.threadId)).not.toBeNull();
      expect(s.getAiResult("summary", goneThread)).toBeNull();
      expect(s.getDigest("2026-09-01")).toBeNull();
      expect(s.getDigest("2026-11-14")).not.toBeNull();
      expect([...s.replyDismissals()]).toEqual([dismissalKey("acc_1", "new")]);
      expect(s.getReminder("r_old")).toBeNull();
      expect(s.getReminder("r_new")).not.toBeNull();
      expect(s.getReminder("r_live")).not.toBeNull();
      expect(s.getReminder("r_dismissed_old")).toBeNull();
      expect(s.getReminder("r_dismissed_new")).not.toBeNull();
      expect(s.listAgentLog({ limit: 10 }).entries).toHaveLength(1);
      expect(s.purgeDaily(now)).toBe(0);
    });
  });
});

// ---- Slice 3g: dev classes, List-Id, BB links, project binding, incidents, mail rules ----

const T3G = "2026-11-16T10:00:00.000Z";
const at3g = (ms: number) => new Date(Date.parse(T3G) + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CAPS = { perRuleHour: 3, perRuleDay: 10, allDay: 20 };
const CI_FAILED = { source: "github", repo: "github.com/example-org/demo", kind: "ci", state: "failed", ref: "17" } as const;

function ruleOf(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    match: { dev: { kind: "ci" } },
    projectId: "p_api",
    template: "Find the failing test.",
    mode: "start",
    ...overrides,
  };
}

function runOf(id: string, overrides: Partial<NewRuleRun> = {}): NewRuleRun {
  return { id, ruleId: "r1", accountId: "acc_1", messageId: `m_${id}`, threadId: `t_${id}`, state: "starting", createdAt: T3G, ...overrides };
}

function linkOf(id: string, overrides: Partial<BbLinkRow> = {}): BbLinkRow {
  return {
    id,
    accountId: "acc_1",
    messageId: "m_x",
    threadId: "t_x",
    kind: "thread",
    targetId: `bb_${id}`,
    projectId: "p_api",
    extra: null,
    createdAt: T3G,
    ...overrides,
  };
}

describe("slice-3g migration (SQLite)", () => {
  it("element 11 on a 3f database adds the columns and tables without REFERENCES; old rows stay unknown", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 11).forEach((s) => old.exec(s)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    legacy.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);

    old.transaction(() => MIGRATIONS.slice(11).forEach((s) => old.exec(s)))();

    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12);
    expect(old.prepare("SELECT list_id, dev_source, dev_repo, dev_kind, dev_state, dev_ref FROM messages").get()).toEqual({
      list_id: null,
      dev_source: null,
      dev_repo: null,
      dev_kind: null,
      dev_state: null,
      dev_ref: null,
    });
    const tables = ["bb_links", "conversation_projects", "project_bindings", "incident_threads", "mail_rules", "rule_runs"];
    const objects = old
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`)
      .all(...tables) as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([...tables].sort());
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
    const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["messages_dev", "bb_links_target", "rule_runs_bb_thread", "rule_runs_rule"]));
    const columns = (table: string) => (old.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("compose_attachments")).toContain("origin");
    expect(columns("mail_tasks")).toContain("note");

    const migrated = createSqliteStore(old);
    migrated.assignThreads("acc_1", new Map());
    const id = idOf(migrated, 1);
    expect(migrated.getMessage(id)).toMatchObject({ dev: null, bbLinks: [] });
    expect(migrated.devUnclassified(10).map((r) => r.id)).toEqual([id]);
    expect(migrated.listUnknown("acc_1", INBOX, null, 10)).toEqual([{ uid: 1 }]);
  });

  it("element 12 keeps rule runs with a message key and the rule's project, and copies started rule threads", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 12).forEach((s) => old.exec(s)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    legacy.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const messageId = idOf(legacy, 1);
    old.prepare(
      `INSERT INTO mail_rules (id, name, enabled, match_json, project_id, template, mode, created_at, updated_at)
       VALUES ('r1', 'Invented', 1, '{}', 'p_api', '', 'start', ?, ?)`,
    ).run(T3G, T3G);
    const insertRun = old.prepare(
      `INSERT INTO rule_runs (id, rule_id, account_id, message_id, thread_id, state, bb_thread_id, notified_at, created_at, updated_at)
       VALUES (?, ?, 'acc_1', ?, NULL, ?, ?, NULL, ?, ?)`,
    );
    insertRun.run("a1", "r1", messageId, "started", "bb_rule", T3G, T3G);
    insertRun.run("a2", "r_gone", "m_gone", "failed", "bb_failed", T3G, T3G);

    old.transaction(() => MIGRATIONS.slice(12).forEach((s) => old.exec(s)))();

    expect(MIGRATIONS).toHaveLength(21);
    const runs = old.prepare("SELECT id, message_id, message_key, project_id FROM rule_runs ORDER BY id").all();
    expect(runs).toEqual([
      { id: "a1", message_id: messageId, message_key: expect.stringMatching(/^acc_1:/), project_id: "p_api" },
      { id: "a2", message_id: "m_gone", message_key: "id:m_gone", project_id: null },
    ]);
    expect(old.prepare("SELECT bb_thread_id, rule_id, run_id FROM rule_threads").all()).toEqual([
      { bb_thread_id: "bb_rule", rule_id: "r1", run_id: "a1" },
    ]);
    const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["rule_runs_state", "rule_runs_rule", "rule_runs_bb_thread", "rule_runs_message"]));
    const migrated = createSqliteStore(old);
    expect(migrated.isRuleThread("bb_rule")).toBe(true);
    expect(migrated.isRuleThread("bb_failed")).toBe(false);
    legacy.deleteByUids("acc_1", INBOX, [1]);
    expect(migrated.isRuleThread("bb_rule")).toBe(true);
    expect(migrated.getRuleRun("a1")).toMatchObject({ messageId: null, projectId: "p_api" });
  });

  it("one projectId page among 5 000+ conversations is fast (timed alone)", () => {
    store.upsertMessages(
      "acc_1",
      INBOX,
      Array.from({ length: 5_200 }, (_, i) =>
        makeFetchedMessage(i + 1, {
          messageId: `bind-${i}@example.org`,
          from: { name: null, address: i % 7 === 0 ? `dev${i}@example.com` : `person${i}@example.net` },
          date: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
        }),
      ),
    );
    store.assignThreads("acc_1", new Map());
    store.addBinding({ kind: "domain", value: "example.com", projectId: "p_api", createdAt: T3G });
    store.addBinding({ kind: "address", value: "person5@example.net", projectId: "p_web", createdAt: T3G });
    const { value: page, ms } = timeOne(() =>
      store.listThreads("acc_1", INBOX, null, 50, { projectId: "p_api" }),
    );
    expect(ms).toBeLessThan(PAGE_MS);
    expect(page.threads).toHaveLength(50);
    expect(page.threads.every((t) => t.projectId === "p_api")).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  }, SEEDING_TIMEOUT_MS);
});

describe.each(storeKinds)("slice-3g store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.org", username: "second@example.org" }));
    s.saveFolders("acc_1", FOLDERS_3F);
    s.saveFolders("acc_2", FOLDERS_3F);
  });
  const idIn = (folder: string, uid: number, accountId = "acc_1") =>
    s.localFolderIndex(accountId, folder, EPOCH).find((e) => e.uid === uid)!.id;
  const thread = (accountId = "acc_1") => s.assignThreads(accountId, buildThreads(s.threadingInputs(accountId)));
  const day = (n: number) => new Date(Date.UTC(2026, 10, n, 9)).toISOString();

  describe("dev classes and List-Id", () => {
    it("writes classes, marks checked rows and pages unclassified rows newest first outside Spam and Trash", () => {
      s.upsertMessages("acc_1", INBOX, [1, 2, 3].map((uid) => makeFetchedMessage(uid, { date: day(uid) })));
      s.upsertMessages("acc_1", "Spam", [makeFetchedMessage(4, { date: day(9) })]);
      s.upsertMessages("acc_1", "Trash", [makeFetchedMessage(5, { date: day(9) })]);
      expect(s.devUnclassified(10).map((r) => r.id)).toEqual([idIn(INBOX, 3), idIn(INBOX, 2), idIn(INBOX, 1)]);
      expect(s.devUnclassified(1)).toEqual([
        { id: idIn(INBOX, 3), accountId: "acc_1", from: "sender@example.org", subject: "Invented subject 3" },
      ]);
      expect(s.setDevClass([{ id: idIn(INBOX, 3), dev: { ...CI_FAILED } }, { id: idIn(INBOX, 2), dev: null }])).toBe(2);
      expect(s.devUnclassified(10).map((r) => r.id)).toEqual([idIn(INBOX, 1)]);
      expect(s.getMessage(idIn(INBOX, 3))!.dev).toEqual(CI_FAILED);
      expect(s.getMessage(idIn(INBOX, 2))!.dev).toBeNull();
      expect(s.devUnclassified(0)).toEqual([]);
    });

    it("fills List-Ids only where unknown and only while UIDVALIDITY matches", () => {
      s.upsertMessages("acc_1", INBOX, [1, 2, 3].map((uid) => makeFetchedMessage(uid)));
      s.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 3, syncedSince: T3G });
      expect(s.listUnknown("acc_1", INBOX, null, 10)).toEqual([{ uid: 3 }, { uid: 2 }, { uid: 1 }]);
      expect(s.listUnknown("acc_1", INBOX, 3, 1)).toEqual([{ uid: 2 }]);
      expect(s.fillListIds("acc_1", INBOX, 8, [{ uid: 1, listId: "demo.example-org.github.com" }])).toBe(0);
      expect(s.fillListIds("acc_1", INBOX, 7, [{ uid: 1, listId: "demo.example-org.github.com" }, { uid: 2, listId: "" }])).toBe(2);
      expect(s.fillListIds("acc_1", INBOX, 7, [{ uid: 1, listId: "other.example.com" }])).toBe(0);
      expect(s.listUnknown("acc_1", INBOX, null, 10)).toEqual([{ uid: 3 }]);
    });

    it("reads List-Ids by message id for rule matching", () => {
      s.upsertMessages("acc_1", INBOX, [1, 2, 3].map((uid) => makeFetchedMessage(uid)));
      s.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 3, syncedSince: T3G });
      s.fillListIds("acc_1", INBOX, 7, [{ uid: 1, listId: "demo.example-org.github.com" }, { uid: 2, listId: "" }]);
      const ids = s.listIds([idIn(INBOX, 1), idIn(INBOX, 2), idIn(INBOX, 3), "m_gone"]);
      expect([...ids]).toEqual(
        expect.arrayContaining([
          [idIn(INBOX, 1), "demo.example-org.github.com"],
          [idIn(INBOX, 2), ""],
          [idIn(INBOX, 3), null],
        ]),
      );
      expect(ids.size).toBe(3);
      expect(s.listIds([]).size).toBe(0);
    });

    it("upsert keeps the List-Id of read headers ('' when absent) and a judged dev class, never overwriting them", () => {
      const headers = { listId: "Demo <demo.example-org.github.com>", listUnsubscribe: null, precedence: null, autoSubmitted: null };
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { bulkHeaders: headers, dev: { ...CI_FAILED } }),
        makeFetchedMessage(2, { bulkHeaders: { ...headers, listId: null }, dev: null }),
        makeFetchedMessage(3),
      ]);
      expect(s.listUnknown("acc_1", INBOX, null, 10)).toEqual([{ uid: 3 }]);
      expect(s.getMessage(idIn(INBOX, 1))!.dev).toEqual(CI_FAILED);
      expect(s.devUnclassified(10).map((r) => r.id)).toEqual([idIn(INBOX, 3)]);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bulkHeaders: { ...headers, listId: "<other.example.com>" }, dev: null })]);
      expect(s.getMessage(idIn(INBOX, 1))!.dev).toEqual(CI_FAILED);
      s.addBinding({ kind: "list", value: "demo.example-org.github.com", projectId: "p_demo", createdAt: T3G });
      thread();
      expect(s.listThreads("acc_1", INBOX, null, 10, { projectId: "p_demo" }).threads).toHaveLength(1);
    });

    it("groups dev mail by (source, repo) with counts, the latest failure and unread, paged by group", () => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { date: day(10), subject: "Run failed: build" }),
        makeFetchedMessage(2, { date: day(12), subject: "Run failed: test", seen: true }),
        makeFetchedMessage(3, { date: day(11), subject: "PR opened", seen: true }),
        makeFetchedMessage(4, { date: day(13), subject: "Alert firing" }),
        makeFetchedMessage(5, { date: day(1), subject: "Too old" }),
      ]);
      s.upsertMessages("acc_1", "Trash", [makeFetchedMessage(6, { date: day(14) })]);
      const repo = "github.com/example-org/demo";
      s.setDevClass([
        { id: idIn(INBOX, 1), dev: { ...CI_FAILED } },
        { id: idIn(INBOX, 2), dev: { ...CI_FAILED, ref: "18" } },
        { id: idIn(INBOX, 3), dev: { source: "github", repo, kind: "pr", state: null, ref: "42" } },
        { id: idIn(INBOX, 4), dev: { source: "monitoring", repo: "grafana", kind: "alert", state: "firing", ref: null } },
        { id: idIn(INBOX, 5), dev: { ...CI_FAILED } },
        { id: idIn("Trash", 6), dev: { ...CI_FAILED } },
      ]);
      const all = s.devGroups({ sinceIso: day(5), limit: 50 });
      expect(all.next).toBeNull();
      expect(all.groups).toEqual([
        {
          source: "monitoring",
          repo: "grafana",
          counts: { alert: 1 },
          ciFailed: 0,
          firing: 1,
          latestFailure: null,
          unread: 1,
          total: 1,
          latestDate: day(13),
          messageIds: [idIn(INBOX, 4)],
        },
        {
          source: "github",
          repo,
          counts: { ci: 2, pr: 1 },
          ciFailed: 2,
          firing: 0,
          latestFailure: { messageId: idIn(INBOX, 2), subject: "Run failed: test", date: day(12) },
          unread: 1,
          total: 3,
          latestDate: day(12),
          messageIds: [idIn(INBOX, 2), idIn(INBOX, 3), idIn(INBOX, 1)],
        },
      ]);
      const first = s.devGroups({ sinceIso: day(5), limit: 1 });
      expect(first.groups.map((g) => g.source)).toEqual(["monitoring"]);
      const second = s.devGroups({ sinceIso: day(5), limit: 1, cursor: first.next });
      expect(second.groups.map((g) => g.source)).toEqual(["github"]);
      expect(second.next).toBeNull();
      expect(s.devGroups({ sinceIso: day(5), accountId: "acc_2", limit: 50 }).groups).toEqual([]);
    });

    it("hides dev notifications with notDev, keeping the open conversation", () => {
      s.upsertMessages("acc_1", INBOX, [1, 2, 3].map((uid) => makeFetchedMessage(uid, { date: day(uid) })));
      thread();
      s.setDevClass([{ id: idIn(INBOX, 2), dev: { ...CI_FAILED } }, { id: idIn(INBOX, 3), dev: null }]);
      const listed = s.listThreads("acc_1", INBOX, null, 10, { notDev: true }).threads.map((t) => t.subject);
      expect(listed).toEqual(["Invented subject 3", "Invented subject 1"]);
      const devThread = s.getMessage(idIn(INBOX, 2))!.threadId;
      expect(s.listThreads("acc_1", INBOX, null, 10, { notDev: true, keep: devThread }).threads).toHaveLength(3);
      expect(s.listThreadsAll("inbox", null, 10, { notDev: true }).threads).toHaveLength(2);
    });
  });

  describe("project binding", () => {
    beforeEach(() => {
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(1, { date: day(1), from: { name: null, address: "Anna@Example.com" } }),
        makeFetchedMessage(2, { date: day(2), from: { name: null, address: "bot@lists.example.org" } }),
        makeFetchedMessage(3, { date: day(3), from: { name: null, address: "notifications@example.net" } }),
        makeFetchedMessage(4, { date: day(4), from: { name: null, address: "bo@example.com" } }),
        makeFetchedMessage(5, { date: day(5), from: { name: null, address: "other@example.info" } }),
      ]);
      s.saveSyncState("acc_1", INBOX, { uidValidity: 1, lastUid: 5, syncedSince: T3G });
      s.fillListIds("acc_1", INBOX, 1, [{ uid: 2, listId: "demo.lists.example.org" }]);
      s.setDevClass([{ id: idIn(INBOX, 3), dev: { ...CI_FAILED } }]);
      thread();
    });
    const projectOf = (uid: number) => {
      const threadId = s.getMessage(idIn(INBOX, uid))!.threadId;
      return s.listThreads("acc_1", INBOX, null, 50).threads.find((t) => t.id === threadId)!.projectId;
    };

    it("resolves address, list, repo and domain rules at read time, the owner's choice winning", () => {
      expect([1, 2, 3, 4, 5].map(projectOf)).toEqual([null, null, null, null, null]);
      expect(s.addBinding({ kind: "domain", value: "example.com", projectId: "p_domain", createdAt: T3G })).toEqual({ created: true });
      expect(s.addBinding({ kind: "address", value: "anna@example.com", projectId: "p_address", createdAt: T3G })).toEqual({ created: true });
      s.addBinding({ kind: "list", value: "demo.lists.example.org", projectId: "p_list", createdAt: T3G });
      s.addBinding({ kind: "repo", value: "github.com/example-org/demo", projectId: "p_repo", createdAt: T3G });
      expect([1, 2, 3, 4, 5].map(projectOf)).toEqual(["p_address", "p_list", "p_repo", "p_domain", null]);
      const annaThread = s.getMessage(idIn(INBOX, 1))!.threadId;
      s.setConversationProject("acc_1", annaThread, "p_owner", T3G);
      expect(s.conversationProject("acc_1", annaThread)).toBe("p_owner");
      expect(projectOf(1)).toBe("p_owner");
      expect(s.getThread(annaThread, INBOX)!.thread.projectId).toBe("p_owner");
      s.setConversationProject("acc_1", annaThread, null, T3G);
      expect(projectOf(1)).toBe("p_address");
      expect(s.addBinding({ kind: "domain", value: "example.com", projectId: "p_moved", createdAt: T3G })).toEqual({ created: false });
      expect(projectOf(4)).toBe("p_moved");
      expect(s.removeBinding("domain", "example.com")).toBe(true);
      expect(s.removeBinding("domain", "example.com")).toBe(false);
      expect(projectOf(4)).toBeNull();
      expect(s.listBindings().map((b) => `${b.kind}:${b.value}:${b.projectId}`)).toEqual([
        "address:anna@example.com:p_address",
        "list:demo.lists.example.org:p_list",
        "repo:github.com/example-org/demo:p_repo",
      ]);
    });

    it("filters by project across a filtered page boundary and lists a project's conversations", () => {
      s.addBinding({ kind: "domain", value: "example.com", projectId: "p_api", createdAt: T3G });
      s.addBinding({ kind: "repo", value: "github.com/example-org/demo", projectId: "p_api", createdAt: T3G });
      s.setConversationProject("acc_1", s.getMessage(idIn(INBOX, 5))!.threadId, "p_api", T3G);
      // Address wins over domain for uid 1: it leaves p_api.
      s.addBinding({ kind: "address", value: "anna@example.com", projectId: "p_other", createdAt: T3G });
      const first = s.listThreads("acc_1", INBOX, null, 2, { projectId: "p_api" });
      expect(first.threads.map((t) => t.subject)).toEqual(["Invented subject 5", "Invented subject 4"]);
      const second = s.listThreads("acc_1", INBOX, first.nextCursor, 2, { projectId: "p_api" });
      expect(second.threads.map((t) => t.subject)).toEqual(["Invented subject 3"]);
      expect(second.nextCursor).toBeNull();
      expect(s.projectThreads("p_api", { cursor: null, limit: 50 }).threads.map((t) => t.subject)).toEqual([
        "Invented subject 5",
        "Invented subject 4",
        "Invented subject 3",
      ]);
      expect(s.projectThreads("p_other", { cursor: null, limit: 50 }).threads.map((t) => t.projectId)).toEqual(["p_other"]);
      expect(s.listThreadsAll("inbox", null, 10, { projectId: "p_other" }).threads).toHaveLength(1);
    });

    it("stops at BINDINGS_MAX new rules", () => {
      for (let i = 0; i < BINDINGS_MAX; i++) {
        expect(s.addBinding({ kind: "address", value: `a${i}@example.com`, projectId: "p", createdAt: T3G })).toEqual({ created: true });
      }
      expect(s.addBinding({ kind: "address", value: "over@example.com", projectId: "p", createdAt: T3G })).toEqual({ full: true });
      expect(s.addBinding({ kind: "address", value: "a1@example.com", projectId: "q", createdAt: T3G })).toEqual({ created: false });
    });
  });

  describe("BB links and incidents", () => {
    it("lists links by message, conversation and target, shows them on the header and prunes by target", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
      thread();
      const m1 = s.getMessage(idIn(INBOX, 1))!;
      s.addBbLink(linkOf("l1", { messageId: m1.id, threadId: m1.threadId }));
      s.addBbLink(linkOf("l2", { messageId: m1.id, threadId: m1.threadId, kind: "project_file", targetId: "mail-attachments/a.pdf", extra: "s".repeat(64), createdAt: at3g(1) }));
      s.addBbLink(linkOf("l3", { messageId: idIn(INBOX, 2), threadId: "t_other", kind: "incident", targetId: "bb_l1", createdAt: at3g(2) }));
      expect(s.listBbLinks({ messageIds: [m1.id] }).map((l) => l.id)).toEqual(["l1", "l2"]);
      expect(s.listBbLinks({ messageIds: [] })).toEqual([]);
      expect(s.listBbLinks({ accountId: "acc_1", threadId: m1.threadId }).map((l) => l.id)).toEqual(["l1", "l2"]);
      expect(s.listBbLinks({ targetId: "bb_l1" }).map((l) => l.id)).toEqual(["l1", "l3"]);
      expect(s.listBbLinks({ targetId: "bb_l1" })[0]).toEqual(linkOf("l1", { messageId: m1.id, threadId: m1.threadId }));
      expect(s.getMessage(m1.id)!.bbLinks).toEqual([
        { kind: "thread", targetId: "bb_l1", projectId: "p_api", title: null, createdAt: T3G },
        { kind: "project_file", targetId: "mail-attachments/a.pdf", projectId: "p_api", title: null, createdAt: at3g(1) },
      ]);
      expect(s.pruneBbLinks("thread", ["bb_l1"])).toBe(1);
      expect(s.listBbLinks({ targetId: "bb_l1" }).map((l) => l.id)).toEqual(["l3"]);
      expect(s.pruneBbLinks("thread", [])).toBe(0);
    });

    it("reserves an incident start in one step: compare with the row the caller saw, then hold it pending", () => {
      const at = T3G;
      expect(s.reserveIncident("f1", null, { token: "k1", projectId: "p_api", at })).toBe(true);
      // Pending is no incident to readers, and a second start is refused while it is held.
      expect(s.incidentFor("f1")).toBeNull();
      expect(s.reserveIncident("f1", null, { token: "k2", projectId: "p_api", at: at3g(1) })).toBe(false);
      s.putIncident({ fingerprint: "f1", bbThreadId: "bb_1", projectId: "p_api", createdAt: at3g(2), lastAt: at3g(2) });
      expect(s.incidentFor("f1")!.bbThreadId).toBe("bb_1");
      // A caller that saw no incident (or another thread) loses to the one that started.
      expect(s.reserveIncident("f1", null, { token: "k3", projectId: "p_api", at: at3g(3) })).toBe(false);
      expect(s.reserveIncident("f1", "bb_1", { token: "k4", projectId: "p_api", at: at3g(4) })).toBe(true);
      s.releaseIncident("f1", "k_other");
      expect(s.reserveIncident("f1", "bb_1", { token: "k5", projectId: "p_api", at: at3g(5) })).toBe(false);
      s.releaseIncident("f1", "k4");
      expect(s.incidentFor("f1")).toBeNull();
      expect(s.reserveIncident("f1", null, { token: "k6", projectId: "p_api", at: at3g(6) })).toBe(true);
      // A reservation older than 10 minutes is stale and may be taken over.
      expect(s.reserveIncident("f1", null, { token: "k7", projectId: "p_api", at: at3g(6 + 11 * 60_000) })).toBe(true);
    });

    it("keeps one incident per fingerprint and touches it", () => {
      expect(s.incidentFor("f1")).toBeNull();
      s.putIncident({ fingerprint: "f1", bbThreadId: "bb_1", projectId: "p_api", createdAt: T3G, lastAt: T3G });
      expect(s.touchIncident("f1", at3g(HOUR))).toBe(true);
      expect(s.touchIncident("f2", at3g(HOUR))).toBe(false);
      expect(s.incidentFor("f1")).toEqual({ fingerprint: "f1", bbThreadId: "bb_1", projectId: "p_api", createdAt: T3G, lastAt: at3g(HOUR) });
    });
  });

  describe("mail rules and runs", () => {
    it("saves, edits keeping the id, lists, deletes and stops at RULES_MAX", () => {
      expect(s.saveRule(ruleOf("r1"), T3G)).toEqual({ rule: { ...ruleOf("r1"), createdAt: T3G, updatedAt: T3G } });
      expect(s.saveRule(ruleOf("r1", { name: "Renamed", mode: "prepare" }), at3g(1))).toEqual({
        rule: { ...ruleOf("r1", { name: "Renamed", mode: "prepare" }), createdAt: T3G, updatedAt: at3g(1) },
      });
      for (let i = 2; i <= RULES_MAX; i++) expect(s.saveRule(ruleOf(`r${i}`), at3g(i))).toHaveProperty("rule");
      expect(s.saveRule(ruleOf("r_over"), at3g(99))).toEqual({ full: true });
      expect(s.listRules()).toHaveLength(RULES_MAX);
      expect(s.listRules()[0]!.name).toBe("Renamed");
      expect(s.deleteRule("r2")).toBe(true);
      expect(s.deleteRule("r2")).toBe(false);
      expect(s.saveRule(ruleOf("r_over"), at3g(99))).toHaveProperty("rule");
    });

    it("pauses every enabled rule and resumes exactly those", () => {
      s.saveRule(ruleOf("r1"), T3G);
      s.saveRule(ruleOf("r2", { enabled: false }), T3G);
      s.saveRule(ruleOf("r3"), T3G);
      expect(s.pauseRules(at3g(1))).toEqual(["r1", "r3"]);
      expect(s.listRules().map((r) => r.enabled)).toEqual([false, false, false]);
      expect(s.pauseRules(at3g(2))).toEqual([]);
      expect(s.resumeRules(["r1", "r3", "r_gone"], at3g(3))).toBe(2);
      expect(s.listRules().map((r) => r.enabled)).toEqual([true, false, true]);
    });

    it("caps starts at 3 per rule per hour", () => {
      for (let i = 0; i < 3; i++) expect(s.insertRuleRun(runOf(`a${i}`, { createdAt: at3g(i) }), CAPS)).toBe("inserted");
      expect(s.insertRuleRun(runOf("a3", { createdAt: at3g(10) }), CAPS)).toBe("capped");
      expect(s.getRuleRun("a3")!.state).toBe("capped");
      // An hour later the hourly cap is free again.
      expect(s.insertRuleRun(runOf("a4", { createdAt: at3g(HOUR + 10) }), CAPS)).toBe("inserted");
      // Another rule is not capped by this one's hour.
      expect(s.insertRuleRun(runOf("b1", { ruleId: "r2", createdAt: at3g(20) }), CAPS)).toBe("inserted");
    });

    it("caps starts at 10 per rule per day and 20 in all per day, deleted rules' runs included", () => {
      for (let i = 0; i < 10; i++) {
        expect(s.insertRuleRun(runOf(`a${i}`, { createdAt: at3g(i * 2 * HOUR) }), CAPS)).toBe("inserted");
      }
      expect(s.insertRuleRun(runOf("a10", { createdAt: at3g(20 * HOUR) }), CAPS)).toBe("capped");
      s.deleteRule("r1");
      for (let i = 0; i < 10; i++) {
        expect(s.insertRuleRun(runOf(`b${i}`, { ruleId: `r_b${i}`, createdAt: at3g(20 * HOUR + i) }), CAPS)).toBe("inserted");
      }
      expect(s.insertRuleRun(runOf("c0", { ruleId: "r_c", createdAt: at3g(20 * HOUR + 50) }), CAPS)).toBe("capped");
      // A day after the first run, the oldest drop out of the window.
      expect(s.insertRuleRun(runOf("c1", { ruleId: "r_c", createdAt: at3g(DAY + 3 * HOUR) }), CAPS)).toBe("inserted");
    });

    it("counts only starting and started runs, and allows one per conversation per rule per day", () => {
      expect(s.insertRuleRun(runOf("a0", { threadId: "t_same" }), CAPS)).toBe("inserted");
      expect(s.insertRuleRun(runOf("a1", { threadId: "t_same", createdAt: at3g(1) }), CAPS)).toBe("capped");
      expect(s.insertRuleRun(runOf("a2", { threadId: "t_same", ruleId: "r2", createdAt: at3g(2) }), CAPS)).toBe("inserted");
      expect(s.insertRuleRun(runOf("a3", { threadId: "t_same", accountId: "acc_2", createdAt: at3g(3) }), CAPS)).toBe("inserted");
      s.updateRuleRun("a0", { state: "failed" }, at3g(4));
      expect(s.insertRuleRun(runOf("a4", { threadId: "t_same", createdAt: at3g(5) }), CAPS)).toBe("inserted");
      // Prepare runs are not capped.
      for (let i = 0; i < 25; i++) expect(s.insertRuleRun(runOf(`p${i}`, { state: "ready", createdAt: at3g(10 + i) }), CAPS)).toBe("inserted");
    });

    it("refuses a second run for the same rule and message", () => {
      expect(s.insertRuleRun(runOf("a0"), CAPS)).toBe("inserted");
      expect(s.insertRuleRun(runOf("a1", { messageId: "m_a0" }), CAPS)).toBe("duplicate");
      expect(s.insertRuleRun(runOf("a2", { messageId: "m_a0", ruleId: "r2" }), CAPS)).toBe("inserted");
    });

    it("finds a rule thread by its BB thread only while starting or started, pages runs and fails stale starts", () => {
      s.insertRuleRun(runOf("a0"), CAPS);
      s.insertRuleRun(runOf("a1", { state: "ready", createdAt: at3g(1) }), CAPS);
      s.insertRuleRun(runOf("a2", { createdAt: at3g(20 * 60_000) }), CAPS);
      expect(s.updateRuleRun("a0", { state: "started", bbThreadId: "bb_rule" }, at3g(2))).toBe(true);
      expect(s.updateRuleRun("nope", { state: "started" }, at3g(2))).toBe(false);
      expect(s.ruleRunByBbThread("bb_rule")).toMatchObject({ id: "a0", state: "started", bbThreadId: "bb_rule", updatedAt: at3g(2) });
      expect(s.ruleRunByBbThread("bb_other")).toBeNull();
      const page = s.listRuleRuns({ limit: 2 });
      expect(page.runs.map((r) => r.id)).toEqual(["a2", "a1"]);
      expect(s.listRuleRuns({ limit: 2, cursor: page.next }).runs.map((r) => r.id)).toEqual(["a0"]);
      expect(s.listRuleRuns({ state: "ready", limit: 10 }).runs.map((r) => r.id)).toEqual(["a1"]);
      expect(s.failStaleStarts(at3g(10 * 60_000), at3g(30 * 60_000))).toBe(0);
      expect(s.failStaleStarts(at3g(30 * 60_000), at3g(31 * 60_000))).toBe(1);
      expect(s.getRuleRun("a2")!.state).toBe("failed");
      expect(s.updateRuleRun("a0", { state: "dismissed" }, at3g(3))).toBe(true);
      expect(s.ruleRunByBbThread("bb_rule")).toBeNull();
    });
  });

  describe("tasks and attachments", () => {
    it("keeps a local task's note and an attachment's origin", () => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      const task: NewTask = { id: "task_1", accountId: "acc_1", messageId: idIn(INBOX, 1), dedupKey: "k", title: "Fix it", due: null, createdAt: T3G, note: "From mail: Ada" };
      expect(s.keepTasks([task, { ...task, id: "task_2", note: undefined }])).toEqual({ kept: 2 });
      expect(s.getTask("task_1")!.note).toBe("From mail: Ada");
      expect(s.getTask("task_2")!.note).toBeNull();
      s.createDraft(newDraft());
      const attached = s.addAttachment("d_1", { ...file([1, 2]), origin: "bb:project:p_api" });
      expect(attached.origin).toBe("bb:project:p_api");
      expect(s.listAttachments("d_1")[0]!.origin).toBe("bb:project:p_api");
      expect(s.attachmentData("d_1")[0]!.origin).toBe("bb:project:p_api");
      expect(s.addAttachment("d_1", file([3])).origin).toBeNull();
    });
  });

  describe("deletes and prunes", () => {
    beforeEach(() => {
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
      s.upsertMessages("acc_2", INBOX, [makeFetchedMessage(1, { messageId: "acc2@example.org" })]);
      thread("acc_1");
      thread("acc_2");
    });

    it("deleteAccount deletes the account's links, bindings and runs; rules, rule bindings and incidents stay", () => {
      const m1 = s.getMessage(idIn(INBOX, 1))!;
      const other = s.getMessage(idIn(INBOX, 1, "acc_2"))!;
      s.addBbLink(linkOf("l1", { messageId: m1.id, threadId: m1.threadId }));
      s.addBbLink(linkOf("l2", { accountId: "acc_2", messageId: other.id, threadId: other.threadId }));
      s.setConversationProject("acc_1", m1.threadId, "p_api", T3G);
      s.setConversationProject("acc_2", other.threadId, "p_api", T3G);
      s.insertRuleRun(runOf("a1", { messageId: m1.id }), CAPS);
      s.insertRuleRun(runOf("a2", { accountId: "acc_2", messageId: other.id }), CAPS);
      s.saveRule(ruleOf("r1"), T3G);
      s.addBinding({ kind: "domain", value: "example.org", projectId: "p_api", createdAt: T3G });
      s.putIncident({ fingerprint: "f1", bbThreadId: "bb_1", projectId: "p_api", createdAt: T3G, lastAt: T3G });

      s.deleteAccount("acc_1");

      expect(s.listBbLinks({ targetId: "bb_l1" })).toEqual([]);
      expect(s.listBbLinks({ targetId: "bb_l2" }).map((l) => l.id)).toEqual(["l2"]);
      expect(s.conversationProject("acc_1", m1.threadId)).toBeNull();
      expect(s.conversationProject("acc_2", other.threadId)).toBe("p_api");
      // The run outlives the account for the caps, without its message (review C1).
      expect(s.getRuleRun("a1")).toMatchObject({ messageId: null, state: "starting" });
      expect(s.getRuleRun("a2")).toMatchObject({ messageId: other.id });
      expect(s.listRules()).toHaveLength(1);
      expect(s.listBindings()).toHaveLength(1);
      expect(s.incidentFor("f1")).not.toBeNull();
    });

    it("removing messages deletes their links; rule runs stay without the message and still count", () => {
      const m1 = idIn(INBOX, 1);
      const m2 = idIn(INBOX, 2);
      s.addBbLink(linkOf("l1", { messageId: m1 }));
      s.addBbLink(linkOf("l2", { messageId: m2 }));
      s.insertRuleRun(runOf("a1", { messageId: m1 }), CAPS);
      s.insertRuleRun(runOf("a2", { messageId: m2 }), CAPS);
      s.deleteByUids("acc_1", INBOX, [1]);
      expect(s.listBbLinks({ messageIds: [m1, m2] }).map((l) => l.id)).toEqual(["l2"]);
      expect(s.getRuleRun("a1")).toMatchObject({ messageId: null, state: "starting" });
      expect(s.getRuleRun("a2")).toMatchObject({ messageId: m2 });
      // Not offered in the strip any more: nothing to review.
      expect(s.listRuleRuns({ limit: 10 }).runs.map((r) => r.id)).toEqual(["a2"]);
      // The hourly cap (3) still counts the run of the deleted mail.
      expect(s.insertRuleRun(runOf("a3", { createdAt: at3g(1) }), CAPS)).toBe("inserted");
      expect(s.insertRuleRun(runOf("a4", { createdAt: at3g(2) }), CAPS)).toBe("capped");
    });

    it("the same mail synced again is still a duplicate for its rule", () => {
      const m1 = idIn(INBOX, 1);
      expect(s.insertRuleRun(runOf("a1", { messageId: m1 }), CAPS)).toBe("inserted");
      s.deleteByUids("acc_1", INBOX, [1]);
      s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
      expect(s.insertRuleRun(runOf("a2", { messageId: idIn(INBOX, 1), createdAt: at3g(1) }), CAPS)).toBe("duplicate");
    });

    it("a rule thread stays gated after its mail, folder or account is gone, until 180 days", () => {
      const m1 = idIn(INBOX, 1);
      s.insertRuleRun(runOf("a1", { messageId: m1 }), CAPS);
      s.updateRuleRun("a1", { state: "started", bbThreadId: "bb_rule" }, at3g(1));
      s.addRuleThread({ bbThreadId: "bb_rule", ruleId: "r1", runId: "a1", createdAt: at3g(1) });
      s.addRuleThread({ bbThreadId: "bb_rule", ruleId: "r1", runId: "a1", createdAt: at3g(2) });
      expect(s.isRuleThread("bb_rule")).toBe(true);
      expect(s.isRuleThread("bb_other")).toBe(false);
      s.deleteByUids("acc_1", INBOX, [1]);
      expect(s.isRuleThread("bb_rule")).toBe(true);
      s.finishFolderReset("acc_1", INBOX);
      s.deleteAccount("acc_1");
      s.purgeDaily(at3g(91 * DAY), []);
      expect(s.isRuleThread("bb_rule")).toBe(true);
      s.purgeDaily(at3g(181 * DAY), []);
      expect(s.isRuleThread("bb_rule")).toBe(false);
    });

    it("lists starting runs older than a time for reconciliation, with the rule's project", () => {
      s.insertRuleRun(runOf("a1", { projectId: "p_api" }), CAPS);
      s.insertRuleRun(runOf("a2", { createdAt: at3g(30 * 60_000) }), CAPS);
      s.insertRuleRun(runOf("a3", { state: "ready" }), CAPS);
      expect(s.staleStartingRuns(at3g(10 * 60_000)).map((r) => [r.id, r.projectId])).toEqual([["a1", "p_api"]]);
    });

    it("the daily purge drops gone conversations' and unknown projects' bindings, old runs and incidents, and expires ready runs", () => {
      const m1 = s.getMessage(idIn(INBOX, 1))!;
      const m2 = s.getMessage(idIn(INBOX, 2))!;
      s.setConversationProject("acc_1", m1.threadId, "p_api", T3G);
      s.setConversationProject("acc_1", m2.threadId, "p_removed", T3G);
      s.setConversationProject("acc_1", "t_gone", "p_api", T3G);
      s.insertRuleRun(runOf("old", { createdAt: T3G }), CAPS);
      s.insertRuleRun(runOf("ready_old", { state: "ready", createdAt: at3g(25 * DAY) }), CAPS);
      s.insertRuleRun(runOf("ready_new", { state: "ready", createdAt: at3g(30 * DAY) }), CAPS);
      s.putIncident({ fingerprint: "f_old", bbThreadId: "bb_1", projectId: "p_api", createdAt: T3G, lastAt: T3G });
      s.putIncident({ fingerprint: "f_new", bbThreadId: "bb_2", projectId: "p_api", createdAt: at3g(30 * DAY), lastAt: T3G });
      const now = at3g(91 * DAY);

      s.purgeDaily(now, ["p_api"]);

      expect(s.conversationProject("acc_1", m1.threadId)).toBe("p_api");
      expect(s.conversationProject("acc_1", m2.threadId)).toBeNull();
      expect(s.conversationProject("acc_1", "t_gone")).toBeNull();
      expect(s.getRuleRun("old")).toBeNull();
      expect(s.getRuleRun("ready_old")).toBeNull();
      expect(s.incidentFor("f_old")).toBeNull();
      expect(s.incidentFor("f_new")).not.toBeNull();
    });

    it("expires ready runs after 7 days and keeps unknown-project bindings without a project list", () => {
      const m1 = s.getMessage(idIn(INBOX, 1))!;
      s.setConversationProject("acc_1", m1.threadId, "p_removed", T3G);
      s.insertRuleRun(runOf("ready_old", { state: "ready", createdAt: T3G }), CAPS);
      s.insertRuleRun(runOf("ready_new", { state: "ready", createdAt: at3g(5 * DAY) }), CAPS);
      s.purgeDaily(at3g(8 * DAY));
      expect(s.getRuleRun("ready_old")!.state).toBe("expired");
      expect(s.getRuleRun("ready_new")!.state).toBe("ready");
      expect(s.conversationProject("acc_1", m1.threadId)).toBe("p_removed");
      s.purgeDaily(at3g(40 * DAY), []);
      expect(s.conversationProject("acc_1", m1.threadId)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 3h
// ---------------------------------------------------------------------------

const NOW_3H = new Date("2026-11-16T12:00:00.000Z");
const q3h = (raw: string) => parseQuery(raw, NOW_3H);
const hitIds = (target: MailStore, raw: string, opts: SearchOptions = {}, accountId: string | null = null) =>
  target.search(q3h(raw), accountId, 50, opts).map((hit) => hit.id);

function seedFolders(target: MailStore, accountId = "acc_1"): void {
  target.saveFolders(accountId, [
    remoteFolder(INBOX, "inbox"),
    remoteFolder("Trash", "trash"),
    remoteFolder("Junk", "junk"),
    remoteFolder("Archive", "archive"),
    remoteFolder("Work"),
    remoteFolder("Work/Sub"),
    remoteFolder("Work2"),
  ]);
}

describe("slice-3h migration (SQLite)", () => {
  it("element 13 on a 3g database adds the columns, backfills kinds per CASE arm and indexes attachment text", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 13).forEach((s) => old.exec(s)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    const arms: [string, string | null, string][] = [
      ["application/pdf", "a.bin", "pdf"],
      ["application/octet-stream", "scan.PDF", "pdf"],
      ["image/png", "a.png", "image"],
      ["text/calendar", "invite", "calendar"],
      ["application/octet-stream", "x.ics", "calendar"],
      ["text/plain", "a.txt", "text"],
      ["application/json", "a.json", "text"],
      ["application/zip", "a.zip", "archive"],
      ["application/vnd.oasis.opendocument.text", "a.odt", "document"],
      ["application/msword", "a.doc", "document"],
      ["application/octet-stream", null, "other"],
    ];
    legacy.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        attachments: arms.map(([mimeType, filename], i) => ({ partId: String(i + 2), filename, mimeType, size: 10, isInline: false })),
      }),
    ]);

    old.transaction(() => MIGRATIONS.slice(13).forEach((s) => old.exec(s)))();

    expect(MIGRATIONS).toHaveLength(21);
    const kinds = old.prepare("SELECT part_id, kind FROM attachments ORDER BY CAST(part_id AS INTEGER)").all() as {
      part_id: string;
      kind: string;
    }[];
    expect(kinds.map((row) => row.kind)).toEqual(arms.map(([, , kind]) => kind));
    // fileKindOf and the CASE agree on every arm.
    for (const [mimeType, filename, kind] of arms) expect(fileKindOf(mimeType, filename)).toBe(kind);

    const columns = (table: string) => (old.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("sync_state")).toEqual(expect.arrayContaining(["history_since", "history_checked_at"]));
    expect(columns("messages")).toEqual(expect.arrayContaining(["kept", "kept_at", "gm_labels"]));
    expect(columns("attachments")).toContain("kind");
    expect(columns("folders")).toContain("subscribed");
    const tables = ["attachment_text", "saved_searches", "folder_prefs"];
    const objects = old
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`)
      .all(...tables) as { name: string; sql: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([...tables].sort());
    for (const object of objects) expect(object.sql).not.toMatch(/REFERENCES/i);
    const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["messages_kept", "messages_from", "attachments_kind"]));

    // New attachments get their kind from the same CASE (trigger).
    const migrated = createSqliteStore(old);
    migrated.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(2, { attachments: [{ partId: "2", filename: "r.pdf", mimeType: "application/octet-stream", size: 5, isInline: false }] }),
    ]);
    expect(migrated.getMessage(idOf(migrated, 2))!.attachments).toEqual([expect.objectContaining({ partId: "2", kind: "pdf" })]);

    // The trigram index follows inserts, updates and deletes.
    const id = idOf(migrated, 1);
    const fts = (phrase: string) =>
      (old.prepare("SELECT rowid FROM attachment_text_fts WHERE attachment_text_fts MATCH ?").all(`"${phrase}"`) as unknown[]).length;
    migrated.insertAttachmentText({ messageId: id, partId: "2", state: "indexed", reason: null, body: "Invented ledger INV-2041", extractedAt: T0 });
    expect(fts("ledger")).toBe(1);
    old.prepare("UPDATE attachment_text SET body = 'Invented quarterly notes'").run();
    expect(fts("ledger")).toBe(0);
    expect(fts("quarterly")).toBe(1);
    old.prepare("DELETE FROM attachment_text").run();
    expect(fts("quarterly")).toBe(0);
  });
});

describe("slice-3h search (SQLite)", () => {
  beforeEach(() => seedFolders(store));

  it("matches each condition with bound parameters", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        to: [{ name: "Ann", address: "ann@example.org" }],
        cc: [{ name: null, address: "carl@example.org" }],
        size: 5000,
        attachments: [{ partId: "2", filename: "Invoice.PDF", mimeType: "application/pdf", size: 10, isInline: false }],
        flagged: true,
      }),
      makeFetchedMessage(2, { from: { name: null, address: "other@example.org" }, size: 50, seen: true }),
    ]);
    const one = idOf(store, 1);
    const two = idOf(store, 2);
    expect(hitIds(store, "to:ann@example.org")).toEqual([one]);
    expect(hitIds(store, "cc:carl")).toEqual([one]);
    expect(hitIds(store, "filename:pdf")).toEqual([one]);
    expect(hitIds(store, "filename:invoice.p")).toEqual([one]);
    expect(hitIds(store, "has:attachment")).toEqual([one]);
    expect(hitIds(store, "-has:attachment")).toEqual([two]);
    expect(hitIds(store, "larger:1K")).toEqual([one]);
    expect(hitIds(store, "smaller:100")).toEqual([two]);
    expect(hitIds(store, "is:starred")).toEqual([one]);
    expect(hitIds(store, "is:read")).toEqual([two]);
    // A negated from: with a NULL name still matches (NULL-safe NOT).
    expect(hitIds(store, "-from:sender@example.org")).toEqual([two]);
    expect(hitIds(store, "account:owner@example.org")).toHaveLength(2);
    expect(hitIds(store, "account:nobody@example.org")).toEqual([]);
    expect(hitIds(store, "in:inbox -in:inbox")).toEqual([]);
  });

  it("finds a Trash copy with in:trash before the dedup picks the Inbox copy", () => {
    const shared = { messageId: "shared@example.org", size: 300 };
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared)]);
    store.upsertMessages("acc_1", "Trash", [makeFetchedMessage(7, shared)]);
    expect(hitIds(store, "Invented")).toEqual([idOf(store, 1)]);
    expect(hitIds(store, "in:trash")).toEqual([idIn(store, "Trash", 7)]);
    expect(hitIds(store, "in:work in:trash")).toEqual([idIn(store, "Trash", 7)]);
  });

  it("matches label: by Gmail labels of any copy and by folder name elsewhere", () => {
    const shared = { messageId: "lab@example.org", gmMsgId: "17", size: 10 };
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("[Gmail]/All Mail", "all"), remoteFolder("Work")]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared)]);
    store.upsertMessages("acc_1", "[Gmail]/All Mail", [makeFetchedMessage(1, shared)]);
    store.upsertMessages("acc_1", "Work", [makeFetchedMessage(2)]);
    store.setGmLabels("acc_1", "[Gmail]/All Mail", [{ uid: 1, labels: ["\\Inbox", "Receipts"] }]);
    expect(hitIds(store, "label:receipts")).toEqual([idOf(store, 1)]);
    expect(hitIds(store, "label:work")).toEqual([idIn(store, "Work", 2)]);
    // The Inbox copy shows the All Mail copy's owner labels.
    expect(store.getMessage(idOf(store, 1))!.labels).toEqual(["Receipts"]);
    expect(store.gmLabels([idOf(store, 1)]).get(idOf(store, 1))).toEqual(["\\Inbox", "Receipts"]);
    expect(store.accountLabels("acc_1")).toEqual(["\\Inbox", "Receipts"]);
  });

  it("stores a message's Gmail labels on every copy of it", () => {
    const shared = { messageId: "every@example.org", gmMsgId: "1789000000000000301", size: 10 };
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("[Gmail]/All Mail", "all")]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared), makeFetchedMessage(2)]);
    store.upsertMessages("acc_1", "[Gmail]/All Mail", [makeFetchedMessage(5, shared)]);
    store.setGmLabels("acc_1", INBOX, [{ uid: 1, labels: ["\\Inbox", "Receipts"] }]);
    store.setGmLabels("acc_1", "[Gmail]/All Mail", [{ uid: 5, labels: ["\\Inbox"] }]);
    // The change stored on All Mail reaches the Inbox copy: chips and the next change's deltas.
    expect(store.getMessage(idOf(store, 1))!.labels).toEqual([]);
    expect(store.gmLabels([idOf(store, 1)]).get(idOf(store, 1))).toEqual(["\\Inbox"]);
    expect(store.gmLabels([idOf(store, 2)]).get(idOf(store, 2))).toEqual([]);
  });

  it("finds a message's copy in a folder by dedup key, with its uid", () => {
    const shared = { messageId: "copy@example.org", gmMsgId: "21", size: 10 };
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("[Gmail]/All Mail", "all")]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared), makeFetchedMessage(2)]);
    store.upsertMessages("acc_1", "[Gmail]/All Mail", [makeFetchedMessage(5, shared)]);
    const copies = store.copiesIn("[Gmail]/All Mail", [idOf(store, 1), idOf(store, 2), "m_unknown"]);
    expect([...copies.keys()]).toEqual([idOf(store, 1)]);
    expect(copies.get(idOf(store, 1))).toEqual({ id: idIn(store, "[Gmail]/All Mail", 5), accountId: "acc_1", uid: 5 });
  });

  it("pages across equal and NULL dates without gaps or repeats", () => {
    const dates = [null, null, "2026-11-10T09:00:00.000Z", "2026-11-10T09:00:00.000Z", "2026-11-10T09:00:00.000Z", "2026-11-09T09:00:00.000Z"];
    store.upsertMessages(
      "acc_1",
      INBOX,
      dates.map((date, i) => makeFetchedMessage(i + 1, { date })),
    );
    const all = store.searchPage(q3h("Invented"), null, 50).hits.map((h) => h.id);
    expect(all).toHaveLength(6);
    const seen: string[] = [];
    let cursor: SearchCursor | null = null;
    for (let i = 0; i < 6; i++) {
      const page: ReturnType<MailStore["searchPage"]> = store.searchPage(q3h("Invented"), null, 2, { cursor });
      seen.push(...page.hits.map((h) => h.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(all);
  });

  it("joins attachment text only with attachments: true, scoped or not, with an excerpt", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { attachments: [{ partId: "2", filename: "ledger.txt", mimeType: "text/plain", size: 10, isInline: false }] }),
    ]);
    const id = idOf(store, 1);
    store.insertAttachmentText({ messageId: id, partId: "2", state: "indexed", reason: null, body: "Quarterly zebracorn totals", extractedAt: T0 });
    expect(hitIds(store, "zebracorn")).toEqual([]);
    expect(hitIds(store, "zebracorn", { scoped: true })).toEqual([]);
    expect(store.searchPage(q3h("zebracorn"), null, 50).attachmentMatches).toEqual([]);
    expect(hitIds(store, "zebracorn", { attachments: true })).toEqual([id]);
    expect(store.searchPage(q3h("zebracorn"), null, 50, { attachments: true }).attachmentMatches).toEqual([
      { messageId: id, filename: "ledger.txt", excerpt: "Quarterly zebracorn totals" },
    ]);
  });
});

describe("slice-3h kept rows (SQLite)", () => {
  it("keeps job rows, never downgrades, and promotes on open, flag, move and snooze", () => {
    seedFolders(store);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)], { kept: "search" });
    expect(store.getMessage(idOf(store, 1))!.kept).toBeNull();
    expect(store.getMessage(idOf(store, 2))!.kept).toBe("search");
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2), makeFetchedMessage(3)], { kept: "history" });
    expect(store.getMessage(idOf(store, 2))!.kept).toBe("history");
    expect(store.getMessage(idOf(store, 3))!.kept).toBe("history");
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(4)], { kept: "search" });
    store.markOpened(idOf(store, 4));
    expect(store.getMessage(idOf(store, 4))!.kept).toBe("opened");
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(4)], { kept: "history" });
    expect(store.getMessage(idOf(store, 4))!.kept).toBe("opened");
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(5), makeFetchedMessage(6), makeFetchedMessage(7)], { kept: "search" });
    store.setDesired([idOf(store, 5)], { flagged: true });
    store.queueMove([idOf(store, 6)], "Archive");
    store.createSnoozes([{ messageId: idOf(store, 7), accountId: "acc_1", returnTo: INBOX, dueAt: T0, state: "snoozed" }], T0);
    for (const uid of [5, 6, 7]) expect(store.getMessage(idOf(store, uid))!.kept, String(uid)).toBe("opened");
    expect(store.promoteKept([idOf(store, 3)])).toEqual([idOf(store, 3)]);
  });

  it("expires old server hits with their attachments and attachment text", () => {
    store.upsertMessages(
      "acc_1",
      INBOX,
      [makeFetchedMessage(1, { attachments: [{ partId: "2", filename: "a.txt", mimeType: "text/plain", size: 5, isInline: false }] })],
      { kept: "search" },
    );
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2)], { kept: "history" });
    const id = idOf(store, 1);
    store.insertAttachmentText({ messageId: id, partId: "2", state: "indexed", reason: null, body: "Invented", extractedAt: T0 });
    const later = new Date(Date.now() + 15 * DAY).toISOString();
    expect(store.expireSearchRows(new Date().toISOString(), 14)).toEqual({ removed: 0, accounts: [] });
    expect(store.expireSearchRows(later, 14)).toEqual({ removed: 1, accounts: ["acc_1"] });
    expect(store.getMessage(id)).toBeNull();
    expect(count(db, "attachments")).toBe(0);
    expect(count(db, "attachment_text")).toBe(0);
    expect(store.getMessage(idOf(store, 2))).not.toBeNull();
  });

  it("forgets loaded history before the window, not opened rows", () => {
    store.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 10, syncedSince: "2026-10-17T00:00:00.000Z" });
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(9, { date: "2026-11-01T00:00:00.000Z" })]);
    store.upsertMessages(
      "acc_1",
      INBOX,
      [makeFetchedMessage(1, { date: "2026-09-01T00:00:00.000Z" }), makeFetchedMessage(2, { date: "2026-09-02T00:00:00.000Z" })],
      { kept: "history" },
    );
    store.markOpened(idOf(store, 2));
    store.setHistorySince("acc_1", INBOX, "2026-09-01T00:00:00.000Z");
    store.historyChecked("acc_1", INBOX, T0);
    expect(store.historyState("acc_1", INBOX)).toEqual({ historySince: "2026-09-01T00:00:00.000Z", historyCheckedAt: T0 });
    expect(store.historyForgetCount("acc_1", INBOX)).toBe(1);
    expect(store.historyForget("acc_1", INBOX)).toBe(1);
    expect(store.historyState("acc_1", INBOX)!.historySince).toBeNull();
    expect(store.localFolderIndex("acc_1", INBOX, EPOCH).map((e) => e.uid)).toEqual([2, 9]);
    expect(store.historyState("acc_1", "Nowhere")).toBeNull();
  });

  it("clears kept on window rows (dated inside or undated) and lists ids by kept state", () => {
    store.upsertMessages(
      "acc_1",
      INBOX,
      [
        makeFetchedMessage(1, { date: "2026-09-01T00:00:00.000Z" }),
        makeFetchedMessage(2, { date: "2026-11-01T00:00:00.000Z" }),
        makeFetchedMessage(3, { date: null }),
      ],
      { kept: "history" },
    );
    store.markOpened(idOf(store, 1));
    expect(store.keptIds("acc_1", INBOX, "opened")).toEqual([idOf(store, 1)]);
    expect(store.keptIds("acc_1", INBOX, "history")).toEqual([idOf(store, 2), idOf(store, 3)].sort());
    expect(store.clearWindowKept("acc_1", INBOX, "2026-10-17T00:00:00.000Z")).toBe(2);
    expect(store.keptIds("acc_1", INBOX, "history")).toEqual([]);
    expect(store.getMessage(idOf(store, 2))!.kept).toBeNull();
    expect(store.getMessage(idOf(store, 1))!.kept).toBe("opened");
    expect(store.clearWindowKept("acc_1", INBOX, "2026-10-17T00:00:00.000Z")).toBe(0);
  });

  it("finds one stored id per dedup key of the account", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { gmMsgId: "1789000000000000301" })]);
    const found = store.idsByDedupKey("acc_1", ["gm:1789000000000000301", "gm:1789000000000000302"]);
    expect([...found]).toEqual([["gm:1789000000000000301", idOf(store, 1)]]);
    expect(store.idsByDedupKey("acc_2", ["gm:1789000000000000301"]).size).toBe(0);
  });
});

describe("slice-3h folders (SQLite)", () => {
  /** Every column a folder path can live in: the names folder, path, *_folder, return_to and move_pending, plus folders_json. */
  function pathColumns(target: Database.Database): string[] {
    const tables = (target.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    return tables.flatMap((table) =>
      (target.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
        .map((c) => c.name)
        .filter(
          (name) =>
            name === "folder" ||
            name === "path" ||
            name.endsWith("_folder") ||
            name === "return_to" ||
            name === "move_pending" ||
            name === "folders_json",
        )
        .map((name) => `${table}.${name}`),
    );
  }

  it("re-homes every path column, children included, never a sibling prefix (schema scan)", () => {
    // Fails when a new column can hold a folder path and rehomeFolder does not cover it.
    expect(pathColumns(db).sort()).toEqual(
      [
        "accounts.snooze_folder",
        "ai_scope_accounts.folders_json",
        "compose_drafts.server_folder",
        "folder_prefs.path",
        "folders.path",
        "messages.folder",
        "messages.move_pending",
        "snoozes.return_to",
        "sync_state.folder",
      ].sort(),
    );
    seedFolders(store);
    for (const path of ["Work", "Work/Sub", "Work2"]) {
      store.upsertMessages("acc_1", path, [makeFetchedMessage(1, { messageId: `${path}@example.org` })]);
      store.saveSyncState("acc_1", path, { uidValidity: 1, lastUid: 1, syncedSince: EPOCH });
      store.setFolderGrouping("acc_1", path, false);
    }
    store.setSnoozeFolder("acc_1", "Work/Sub");
    store.createSnoozes([{ messageId: idIn(store, "Work2", 1), accountId: "acc_1", returnTo: "Work", dueAt: T0, state: "snoozed" }], T0);
    store.createDraft(newDraft());
    db.prepare("UPDATE compose_drafts SET server_folder = 'Work/Sub'").run();
    store.putAiScope([{ accountId: "acc_1", scope: { mode: "folders", folders: [INBOX, "Work", "Work/Sub", "Work2"] } }], [], T0);
    // A queued move into a child of the renamed folder follows it.
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(9, { messageId: "queued@example.org" })]);
    db.prepare("UPDATE messages SET move_pending = 'Work/Sub' WHERE folder = ? AND uid = 9").run(INBOX);

    store.rehomeFolder("acc_1", "Work", "Jobs", "/");

    const values = (column: string) => {
      const [table, name] = column.split(".");
      return (db.prepare(`SELECT ${name} AS v FROM ${table}`).all() as { v: string | null }[]).map((r) => r.v ?? "");
    };
    for (const column of pathColumns(db)) {
      for (const value of values(column)) {
        const paths = column.endsWith("folders_json") ? (JSON.parse(value || "[]") as string[]) : [value];
        for (const path of paths) expect(path === "Work" || path.startsWith("Work/"), `${column} ${path}`).toBe(false);
      }
    }
    expect(store.listFolders("acc_1").map((f) => [f.path, f.name])).toEqual(
      expect.arrayContaining([["Jobs", "Jobs"], ["Jobs/Sub", "Sub"], ["Work2", "Work2"]]),
    );
    expect(store.loadAiScope().accounts.get("acc_1")).toEqual({ mode: "folders", folders: [INBOX, "Jobs", "Jobs/Sub", "Work2"] });
    expect(store.getAccount("acc_1")!.snoozeFolder).toBe("Jobs/Sub");
    expect(store.listSnoozes("acc_1", { limit: 10 })[0]!.returnTo).toBe("Jobs");
    expect(store.folderGrouping("acc_1", "Jobs/Sub")).toBe(false);
    expect(store.getSyncState("acc_1", "Jobs")).not.toBeNull();
    expect(store.localFolderIndex("acc_1", "Work2", EPOCH)).toHaveLength(1);
    expect(db.prepare("SELECT move_pending AS v FROM messages WHERE folder = ? AND uid = 9").get(INBOX)).toEqual({ v: "Jobs/Sub" });
  });

  it("drops a deleted folder with its rows, prefs and AI scope entry", () => {
    seedFolders(store);
    store.upsertMessages("acc_1", "Work2", [makeFetchedMessage(1)]);
    store.setFolderGrouping("acc_1", "Work2", false);
    store.putAiScope([{ accountId: "acc_1", scope: { mode: "folders", folders: [INBOX, "Work2"] } }], [], T0);
    store.dropFolder("acc_1", "Work2");
    expect(store.listFolders("acc_1").map((f) => f.path)).not.toContain("Work2");
    expect(store.localFolderIndex("acc_1", "Work2", EPOCH)).toEqual([]);
    expect(store.folderGrouping("acc_1", "Work2")).toBe(true);
    expect(store.loadAiScope().accounts.get("acc_1")).toEqual({ mode: "folders", folders: [INBOX] });
  });

  it("saveFolders stores subscribed and drops removed paths from folders_json", () => {
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Old", null, { subscribed: false })]);
    expect(store.listFolders("acc_1").find((f) => f.path === "Old")!.subscribed).toBe(false);
    store.putAiScope([{ accountId: "acc_1", scope: { mode: "folders", folders: [INBOX, "Old"] } }], [], T0);
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox")]);
    expect(store.loadAiScope().accounts.get("acc_1")).toEqual({ mode: "folders", folders: [INBOX] });
  });

  it("counts pending moves out of and into a folder", () => {
    seedFolders(store);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2)]);
    store.queueMove([idOf(store, 1)], "Work");
    expect(store.movePendingCount("acc_1", "Work")).toBe(1);
    expect(store.movePendingCount("acc_1", INBOX)).toBe(1);
    expect(store.movePendingCount("acc_1", "Work2")).toBe(0);
  });
});

describe("slice-3h saved searches, prefs and attachment text (SQLite)", () => {
  it("saves, updates, moves and deletes saved searches, at most 50", () => {
    const save = (id: string | null, name: string, newId: string) =>
      store.saveSavedSearch({ id, name, query: "from:a@example.org", accountId: null, nowIso: T0 }, newId);
    expect(save(null, "A", "s1")).toEqual({ id: "s1" });
    expect(save(null, "B", "s2")).toEqual({ id: "s2" });
    expect(save("s1", "A2", "unused")).toEqual({ id: "s1" });
    expect(save("missing", "X", "unused")).toBe("not_found");
    expect(store.moveSavedSearch("s2", 0)).toBe(true);
    expect(store.listSavedSearches().map((s) => [s.id, s.name, s.position])).toEqual([
      ["s2", "B", 0],
      ["s1", "A2", 1],
    ]);
    expect(store.deleteSavedSearch("s2")).toBe(true);
    expect(store.listSavedSearches().map((s) => [s.id, s.position])).toEqual([["s1", 0]]);
    for (let i = 0; i < 49; i++) save(null, `N${i}`, `n${i}`);
    expect(save(null, "Full", "z")).toBe("full");
    store.deleteAccount("acc_1");
    expect(store.listSavedSearches()).toHaveLength(50);
  });

  it("lists an Inbox attachment behind 1,001 newer pending ones in Spam", () => {
    seedFolders(store);
    const attachment = { partId: "2", filename: "a.txt", mimeType: "text/plain", size: 10, isInline: false };
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { date: "2026-01-01T00:00:00.000Z", attachments: [attachment] })]);
    store.upsertMessages(
      "acc_1",
      "Junk",
      Array.from({ length: 1_001 }, (_, i) => makeFetchedMessage(i + 1, { date: "2026-11-01T00:00:00.000Z", messageId: `junk-${i}@example.org`, attachments: [attachment] })),
    );
    expect(store.attachmentTextCandidates(1_000).map((c) => c.messageId)).toEqual([idOf(store, 1)]);
  });

  it("deletes the account's saved searches, prefs and attachment text with it", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    store.saveSavedSearch({ id: null, name: "Mine", query: "x", accountId: "acc_1", nowIso: T0 }, "s1");
    store.setFolderGrouping("acc_1", INBOX, false);
    store.insertAttachmentText({ messageId: idOf(store, 1), partId: "2", state: "failed", reason: "timeout", body: null, extractedAt: T0 });
    store.deleteAccount("acc_1");
    expect(count(db, "saved_searches")).toBe(0);
    expect(count(db, "folder_prefs")).toBe(0);
    expect(count(db, "attachment_text")).toBe(0);
  });

  it("lists candidates, reports status with the total characters, retries and clears", () => {
    seedFolders(store);
    const attachment = (partId: string, filename: string, mimeType: string) => ({ partId, filename, mimeType, size: 10, isInline: false });
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { attachments: [attachment("2", "a.txt", "text/plain"), attachment("3", "b.pdf", "application/pdf"), attachment("4", "c.png", "image/png")] }),
    ]);
    store.upsertMessages("acc_1", "Junk", [makeFetchedMessage(2, { attachments: [attachment("2", "s.txt", "text/plain")] })]);
    const id = idOf(store, 1);
    expect(store.attachmentTextCandidates(10).filter((c) => c.messageId === id).map((c) => [c.partId, c.kind])).toEqual([
      ["2", "text"],
      ["3", "pdf"],
    ]);
    // Spam and Trash are never candidates, so 1,000 pending parts there cannot starve the rest.
    expect(store.attachmentTextCandidates(10).find((c) => c.folderUse === "junk")).toBeUndefined();
    store.insertAttachmentText({ messageId: id, partId: "2", state: "indexed", reason: null, body: "12345", extractedAt: T0 });
    store.insertAttachmentText({ messageId: id, partId: "3", state: "failed", reason: "timeout", body: "ignored", extractedAt: T0 });
    expect(store.attachmentTextStatus()).toEqual({ indexed: 1, skipped: 0, failed: 1, pending: 0, totalChars: 5 });
    expect(store.retryAttachmentText()).toBe(1);
    expect(store.attachmentTextStatus()).toMatchObject({ failed: 0, pending: 1 });
    expect(store.clearAttachmentText()).toBe(1);
    expect(store.attachmentTextStatus()).toEqual({ indexed: 0, skipped: 0, failed: 0, pending: 2, totalChars: 0 });
  });

  it("keeps a folder grouping preference, '*' for All accounts", () => {
    expect(store.folderGrouping("acc_1", INBOX)).toBe(true);
    store.setFolderGrouping("*", "inbox", false);
    expect(store.folderGrouping("*", "inbox")).toBe(false);
    store.setFolderGrouping("*", "inbox", true);
    expect(store.folderGrouping("*", "inbox")).toBe(true);
  });
});

describe("slice-3h files, sender card, related and message lists (SQLite)", () => {
  const pdf = (partId = "2", filename = "plan.pdf") => ({ partId, filename, mimeType: "application/pdf", size: 10, isInline: false });

  it("lists files once per message copy and part, without Spam and Trash unless asked, paging by keyset", () => {
    seedFolders(store);
    const shared = { messageId: "f@example.org", size: 77, attachments: [pdf()] };
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared), makeFetchedMessage(2, { date: null, attachments: [pdf("2", "n.pdf")] })]);
    store.upsertMessages("acc_1", "Archive", [makeFetchedMessage(1, shared)]);
    store.upsertMessages("acc_1", "Junk", [makeFetchedMessage(3, { attachments: [pdf("2", "spam.pdf")] })]);
    store.upsertMessages("acc_1", "Work", [
      makeFetchedMessage(4, { date: "2026-11-01T00:00:00.000Z", attachments: [pdf("2", "a.pdf"), pdf("3", "b.pdf"), { ...pdf("4", "i.png"), mimeType: "image/png", isInline: true }] }),
    ]);
    const all = store.filesList({}, null, 100).files;
    expect(all.map((f) => f.filename)).toEqual(["n.pdf", "plan.pdf", "a.pdf", "b.pdf"]);
    expect(all[1]!.messageId).toBe(idOf(store, 1));
    expect(store.filesList({ includeJunk: true }, null, 100).files.map((f) => f.filename)).toContain("spam.pdf");
    expect(store.filesList({ name: "PLAN" }, null, 100).files.map((f) => f.filename)).toEqual(["plan.pdf"]);
    expect(store.filesList({ kind: "image" }, null, 100).files).toEqual([]);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<MailStore["filesList"]> = store.filesList({}, cursor, 1);
      paged.push(...page.files.map((f) => f.filename ?? ""));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(["n.pdf", "plan.pdf", "a.pdf", "b.pdf"]);
  });

  it("builds the sender card counts by equality on From, outside Spam and Trash", () => {
    seedFolders(store);
    const boss = { name: "Invented Boss", address: "Boss@Example.org" };
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { from: boss, date: "2026-11-01T00:00:00.000Z", attachments: [pdf()] }),
      makeFetchedMessage(2, { from: { ...boss, address: "boss@example.org" }, date: "2026-11-05T00:00:00.000Z" }),
      makeFetchedMessage(3, { to: [{ name: null, address: "boss@example.org" }] }),
    ]);
    store.upsertMessages("acc_1", "Trash", [makeFetchedMessage(4, { from: boss })]);
    store.assignThreads("acc_1", new Map());
    const card = store.senderStats("boss@example.org", null);
    expect(card).toMatchObject({
      name: "Invented Boss",
      fromCount: 2,
      toCount: 1,
      toCapped: false,
      firstDate: "2026-11-01T00:00:00.000Z",
      lastDate: "2026-11-05T00:00:00.000Z",
    });
    expect(card.conversations).toHaveLength(2);
    expect(card.files.map((f) => f.filename)).toEqual(["plan.pdf"]);
    expect(store.senderStats("boss@example.org", "acc_other").fromCount).toBe(0);
  });

  it("finds related candidates by term, participant and reference, outside the open conversation", () => {
    seedFolders(store);
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Ledger review", from: { name: null, address: "ann@example.org" }, references: ["root@example.org"] }),
      makeFetchedMessage(2, { subject: "Other ledger notes", from: { name: null, address: "zed@example.org" } }),
      makeFetchedMessage(3, { subject: "Lunch", from: { name: null, address: "ann@example.org" } }),
      makeFetchedMessage(4, { subject: "Root", messageId: "root@example.org", from: { name: null, address: "x@example.org" } }),
      makeFetchedMessage(5, { subject: "Unrelated", from: { name: null, address: "y@example.org" } }),
    ]);
    store.upsertMessages("acc_1", "Junk", [makeFetchedMessage(6, { subject: "ledger spam" })]);
    store.assignThreads("acc_1", new Map());
    const byId = new Map(store.relatedCandidates(idOf(store, 1), ["ledger"]).map((c) => [c.messageId, c]));
    expect(byId.get(idOf(store, 2))).toMatchObject({ terms: ["ledger"], participants: 0, reference: false });
    expect(byId.get(idOf(store, 3))).toMatchObject({ terms: [], participants: 1 });
    expect(byId.get(idOf(store, 4))).toMatchObject({ reference: true });
    expect(byId.has(idOf(store, 5))).toBe(false);
    expect(byId.has(idOf(store, 1))).toBe(false);
    expect(byId.has(idIn(store, "Junk", 6))).toBe(false);
    expect(store.relatedCandidates("missing", ["ledger"])).toEqual([]);
  });

  it("lists one row per message of a folder and of a role, paging across NULL dates", () => {
    seedFolders(store);
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { date: null }),
      makeFetchedMessage(2, { date: "2026-11-10T00:00:00.000Z" }),
      makeFetchedMessage(3, { date: "2026-11-10T00:00:00.000Z", seen: true }),
    ]);
    const all = store.listMessages("acc_1", INBOX, null, 10).messages.map((m) => m.id);
    expect(all).toEqual([idOf(store, 1), idOf(store, 3), idOf(store, 2)]);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<MailStore["listMessages"]> = store.listMessages("acc_1", INBOX, cursor, 1);
      paged.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(all);
    expect(store.listMessages("acc_1", INBOX, null, 10, { unread: true }).messages).toHaveLength(2);
    expect(store.listMessagesAll("inbox", null, 10).messages).toHaveLength(3);
    expect(store.listMessagesAll("all", null, 10).messages).toEqual([]);
    expect(store.summaries([idOf(store, 2), "missing"]).map((m) => m.id)).toEqual([idOf(store, 2)]);
  });

  it(
    "pages search, files, sender card, related candidates and the message list fast at 20 000 messages (each timed alone)",
    () => {
      seedFolders(store);
      const messages = Array.from({ length: 20_000 }, (_, i) =>
        makeFetchedMessage(i + 1, {
          date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
          from: { name: null, address: `sender${i % 50}@example.org` },
          subject: `Invented ledger ${i % 97}`,
          attachments: i % 10 === 0 ? [pdf("2", `f${i}.pdf`)] : [],
        }),
      );
      store.transaction(() => store.upsertMessages("acc_1", INBOX, messages));
      const one = idOf(store, 1);
      const search = timeOne(() => store.searchPage(q3h("ledger has:attachment -is:starred"), null, 50));
      const files = timeOne(() => store.filesList({ kind: "pdf" }, null, 100));
      const card = timeOne(() => store.senderStats("sender7@example.org", null));
      const related = timeOne(() => store.relatedCandidates(one, ["ledger", "invented"]));
      const list = timeOne(() => store.listMessages("acc_1", INBOX, null, 100));
      expect(search.value.hits).toHaveLength(50);
      expect(files.value.files).toHaveLength(100);
      expect(card.value.fromCount).toBe(400);
      expect(related.value.length).toBeLessThanOrEqual(200);
      expect(list.value.messages).toHaveLength(100);
      for (const [name, entry] of Object.entries({ search, files, card, related, list })) {
        expect(entry.ms, name).toBeLessThan(PAGE_MS);
      }
    },
    SEEDING_TIMEOUT_MS,
  );
});

describe.each(storeKinds)("slice-3h store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    seedFolders(s);
  });

  it("applies conditions before the dedup, ORs in:, and negates NULL-safely", () => {
    const shared = {
      messageId: "shared@example.org",
      size: 300,
      attachments: [{ partId: "2", filename: "a.pdf", mimeType: "application/pdf", size: 1, isInline: false }],
    };
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, shared),
      makeFetchedMessage(2, { from: { name: null, address: "other@example.org" } }),
    ]);
    s.upsertMessages("acc_1", "Trash", [makeFetchedMessage(7, shared)]);
    expect(hitIds(s, "in:trash")).toEqual([idIn(s, "Trash", 7)]);
    expect(hitIds(s, "in:trash in:Work")).toEqual([idIn(s, "Trash", 7)]);
    expect(hitIds(s, "filename:pdf")).toEqual([idOf(s, 1)]);
    expect(hitIds(s, "-has:attachment")).toEqual([idOf(s, 2)]);
    expect(hitIds(s, "-from:sender@example.org")).toEqual([idOf(s, 2)]);
  });

  it("joins attachment text only on request and pages with a cursor", () => {
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { attachments: [{ partId: "2", filename: "l.txt", mimeType: "text/plain", size: 1, isInline: false }] }),
      makeFetchedMessage(2, { date: "2026-11-09T00:00:00.000Z" }),
    ]);
    s.insertAttachmentText({ messageId: idOf(s, 1), partId: "2", state: "indexed", reason: null, body: "Invented zebracorn", extractedAt: T0 });
    expect(hitIds(s, "zebracorn")).toEqual([]);
    expect(s.searchPage(q3h("zebracorn"), null, 5, { attachments: true }).attachmentMatches).toEqual([
      { messageId: idOf(s, 1), filename: "l.txt", excerpt: "Invented zebracorn" },
    ]);
    const first = s.searchPage(q3h("Invented"), null, 1);
    expect(first.hits.map((h) => h.id)).toEqual([idOf(s, 1)]);
    expect(s.searchPage(q3h("Invented"), null, 1, { cursor: first.nextCursor }).hits.map((h) => h.id)).toEqual([idOf(s, 2)]);
  });

  it("keeps job rows without downgrading and promotes what the owner touches", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2), makeFetchedMessage(3)], { kept: "search" });
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2)], { kept: "history" });
    expect([1, 2, 3].map((uid) => s.getMessage(idOf(s, uid))!.kept)).toEqual([null, "history", "search"]);
    s.markOpened(idOf(s, 3));
    expect(s.getMessage(idOf(s, 3))!.kept).toBe("opened");
    expect(s.expireSearchRows(new Date(Date.now() + 30 * DAY).toISOString(), 14)).toEqual({ removed: 0, accounts: [] });
  });

  it("re-homes a rename, keeps prefs and saved searches, and drops a deleted folder", () => {
    s.upsertMessages("acc_1", "Work/Sub", [makeFetchedMessage(1)]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2)]);
    s.queueMove([idIn(s, INBOX, 2)], "Work/Sub");
    s.setFolderGrouping("acc_1", "Work", false);
    s.putAiScope([{ accountId: "acc_1", scope: { mode: "folders", folders: ["Work", "Work/Sub", "Work2"] } }], [], T0);
    s.rehomeFolder("acc_1", "Work", "Jobs", "/");
    expect(s.localFolderIndex("acc_1", "Jobs/Sub", EPOCH)).toHaveLength(1);
    // A queued move into a child follows the rename.
    expect(s.pendingMoves("acc_1", INBOX).map((move) => move.destination)).toEqual(["Jobs/Sub"]);
    expect(s.folderGrouping("acc_1", "Jobs")).toBe(false);
    expect(s.loadAiScope().accounts.get("acc_1")).toEqual({ mode: "folders", folders: ["Jobs", "Jobs/Sub", "Work2"] });
    expect(s.listFolders("acc_1").find((f) => f.path === "Jobs")?.name).toBe("Jobs");
    s.dropFolder("acc_1", "Work2");
    expect(s.loadAiScope().accounts.get("acc_1")).toEqual({ mode: "folders", folders: ["Jobs", "Jobs/Sub"] });
    expect(s.saveSavedSearch({ id: null, name: "A", query: "x", accountId: null, nowIso: T0 }, "s1")).toEqual({ id: "s1" });
    expect(s.listSavedSearches().map((row) => row.position)).toEqual([0]);
  });

  it("stores Gmail labels and shows owner labels on every copy", () => {
    const shared = { messageId: "g@example.org", gmMsgId: "5", size: 1 };
    s.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("[Gmail]/All Mail", "all")]);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, shared)]);
    s.upsertMessages("acc_1", "[Gmail]/All Mail", [makeFetchedMessage(9, shared)]);
    s.setGmLabels("acc_1", "[Gmail]/All Mail", [{ uid: 9, labels: ["\\Important", "Plans"] }]);
    expect(s.getMessage(idOf(s, 1))!.labels).toEqual(["Plans"]);
    expect(s.accountLabels("acc_1")).toEqual(["\\Important", "Plans"]);
    expect(hitIds(s, "label:plans")).toEqual([idOf(s, 1)]);
  });
});

// ---- Slice 3i ----

/** A stored sender check of this state, built by the core from synthetic header lines. */
function checkOf(state: "ok" | "failed" | "unchecked"): SenderCheck {
  const results =
    state === "ok" ? "dmarc=pass header.from=example.com" : state === "failed" ? "dmarc=fail header.from=example.com" : "spf=none";
  return senderCheckOf(
    [
      { key: "received", value: "by mx.google.com" },
      { key: "authentication-results", value: `mx.google.com; ${results}` },
      { key: "from", value: "billing@example.com" },
    ],
    "gmail",
    { name: null, address: "billing@example.com" },
    { folderRole: "inbox" },
  );
}
const FTS_BODY_WORD = "zebracrossing";

describe("slice-3i migration (SQLite)", () => {
  it("element 14 on a 3h database adds the three columns, NULL on old rows", () => {
    const old = new Database(":memory:");
    old.transaction(() => MIGRATIONS.slice(0, 14).forEach((statement) => old.exec(statement)))();
    const legacy = createSqliteStore(old);
    seedLegacyAccount(old);
    legacy.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);

    old.transaction(() => MIGRATIONS.slice(14).forEach((statement) => old.exec(statement)))();

    expect(MIGRATIONS).toHaveLength(21);
    const columns = (old.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["sender_check_json", "receipt_requested", "crypto"]));
    expect(old.prepare("SELECT sender_check_json, receipt_requested, crypto FROM messages").all()).toEqual([
      { sender_check_json: null, receipt_requested: null, crypto: null },
    ]);
    const migrated = createSqliteStore(old);
    const [row] = migrated.senderCheckRows([idOf(migrated, 1)]);
    expect(row).toMatchObject({ senderCheckJson: null, receiptRequested: null, crypto: null });
  });

  it("element 14 holds only the three ALTERs", () => {
    const statements = (MIGRATIONS[14] ?? "")
      .split(";")
      .map((part) => part.replace(/--[^\n]*/g, "").trim())
      .filter((part) => part !== "");
    expect(statements).toEqual([
      "ALTER TABLE messages ADD COLUMN sender_check_json TEXT",
      "ALTER TABLE messages ADD COLUMN receipt_requested INTEGER",
      "ALTER TABLE messages ADD COLUMN crypto TEXT",
    ]);
  });
});

describe("hardenDatabase (SQLite)", () => {
  it("turns on secure_delete and the FTS5 secure-delete option of both indexes", () => {
    expect(db.pragma("secure_delete", { simple: true })).toBe(0);
    expect(hardenDatabase(db)).toEqual({ pragma: true, fts: true });
    expect(db.pragma("secure_delete", { simple: true })).toBe(1);
    for (const table of ["messages_fts", "attachment_text_fts"]) {
      expect(db.prepare(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).get(), table).toEqual({ v: 1 });
    }
    // Repeating it each load is harmless.
    expect(hardenDatabase(db)).toEqual({ pragma: true, fts: true });
  });

  it("reports an FTS option it could not set without throwing", () => {
    const bare = new Database(":memory:");
    expect(hardenDatabase(bare)).toEqual({ pragma: true, fts: false });
  });
});

describe("slice-3i store (SQLite)", () => {
  beforeEach(() => {
    store.saveFolders("acc_1", [remoteFolder(INBOX, "inbox"), remoteFolder("Sent", "sent"), remoteFolder("Spam", "junk")]);
  });

  it("stores the check, receipt and crypto on upsert and leaves them alone when a fetch has none", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { senderCheck: checkOf("ok"), receiptRequested: true, crypto: { kind: "smime_signed", opaque: true } }),
    ]);
    const id = idOf(store, 1);
    const [row] = store.senderCheckRows([id]);
    expect(JSON.parse(row!.senderCheckJson!)).toEqual(checkOf("ok"));
    expect(row).toMatchObject({ receiptRequested: true, crypto: { kind: "smime_signed", opaque: true }, folderRole: "inbox", uid: 1 });
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    expect(store.senderCheckRows([id])[0]).toMatchObject({ receiptRequested: true, crypto: { kind: "smime_signed", opaque: true } });
    expect(store.senderCheckRows([id])[0]!.senderCheckJson).not.toBeNull();
  });

  it("stores a failed row's dev class as checked-none and keeps it out of devUnclassified", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { senderCheck: checkOf("failed"), dev: { source: "github", repo: null, kind: "ci", state: "failed", ref: null } }),
      makeFetchedMessage(2, { senderCheck: checkOf("failed") }),
      makeFetchedMessage(3),
    ]);
    expect(db.prepare("SELECT dev_source FROM messages WHERE id = ?").get(idOf(store, 1))).toEqual({ dev_source: "" });
    expect(store.getMessage(idOf(store, 1))!.dev).toBeNull();
    expect(store.devUnclassified(10).map((r) => r.id)).toEqual([idOf(store, 3)]);
  });

  it("writeSenderCheck writes only an unknown row unless forced, and clears the dev class of a row turned failed", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { dev: { source: "github", repo: null, kind: "ci", state: "failed", ref: null } }),
    ]);
    const id = idOf(store, 1);
    expect(store.getMessage(id)!.dev).not.toBeNull();
    expect(store.writeSenderCheck(id, { check: checkOf("ok"), receipt: false, crypto: null, force: false })).toBe(true);
    expect(store.writeSenderCheck(id, { check: checkOf("failed"), receipt: true, crypto: null, force: false })).toBe(false);
    expect(JSON.parse(store.senderCheckRows([id])[0]!.senderCheckJson!).state).toBe("ok");
    expect(store.senderCheckRows([id])[0]!.receiptRequested).toBe(false);
    expect(store.writeSenderCheck(id, { check: checkOf("failed"), receipt: true, crypto: null, force: true })).toBe(true);
    expect(JSON.parse(store.senderCheckRows([id])[0]!.senderCheckJson!).state).toBe("failed");
    expect(store.senderCheckRows([id])[0]!.receiptRequested).toBe(true);
    expect(store.getMessage(id)!.dev).toBeNull();
    expect(store.devUnclassified(10)).toEqual([]);
    expect(store.writeSenderCheck("m_missing", { check: checkOf("ok"), receipt: null, crypto: null, force: true })).toBe(false);
  });

  it("writeSenderCheck holds to the folder's UIDVALIDITY when given one", () => {
    store.saveSyncState("acc_1", INBOX, { uidValidity: 7, lastUid: 1, syncedSince: EPOCH });
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    const id = idOf(store, 1);
    expect(store.writeSenderCheck(id, { check: checkOf("ok"), receipt: null, crypto: null, force: false, guard: { uidValidity: 8 } })).toBe(false);
    expect(store.writeSenderCheck(id, { check: checkOf("ok"), receipt: null, crypto: null, force: false, guard: { uidValidity: 7 } })).toBe(true);
  });

  it("a refresh that finds an encrypted row nulls its body and the search index forgets it", () => {
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bodyText: `Hello ${FTS_BODY_WORD} there`, bodyHtml: null })]);
    const id = idOf(store, 1);
    expect(store.search(parseQuery(FTS_BODY_WORD), null, 10).map((hit) => hit.id)).toEqual([id]);
    expect(
      store.writeSenderCheck(id, { check: checkOf("unchecked"), receipt: false, crypto: { kind: "pgp_encrypted", opaque: false }, force: false }),
    ).toBe(true);
    expect(db.prepare("SELECT body_text, body_html, snippet, crypto FROM messages WHERE id = ?").get(id)).toEqual({
      body_text: null,
      body_html: null,
      snippet: "",
      crypto: "pgp_encrypted",
    });
    expect(store.search(parseQuery(FTS_BODY_WORD), null, 10)).toEqual([]);
  });

  it("never stores the body of a message upserted as encrypted", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { bodyText: `Hi ${FTS_BODY_WORD}`, bodyHtml: "<p>x</p>", crypto: { kind: "smime_encrypted", opaque: false } }),
    ]);
    expect(db.prepare("SELECT body_text, body_html, snippet FROM messages").get()).toEqual({ body_text: null, body_html: null, snippet: "" });
    expect(store.search(parseQuery(FTS_BODY_WORD), null, 10)).toEqual([]);
    // A refetch that did not judge crypto keeps it out too.
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { bodyText: `Hi ${FTS_BODY_WORD}`, bodyHtml: null })]);
    expect(db.prepare("SELECT body_text, snippet, crypto FROM messages").get()).toEqual({ body_text: null, snippet: "", crypto: "smime_encrypted" });
    expect(store.search(parseQuery(FTS_BODY_WORD), null, 10)).toEqual([]);
  });

  it("keeps encrypted rows out of attachment text", () => {
    const part = { partId: "2", filename: "notes.txt", mimeType: "text/plain", size: 10, isInline: false };
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { attachments: [part] }),
      makeFetchedMessage(2, { attachments: [part], crypto: { kind: "pgp_encrypted", opaque: false } }),
      makeFetchedMessage(3, { attachments: [part], crypto: { kind: "pgp_signed", opaque: false } }),
    ]);
    expect(store.attachmentTextCandidates(10).map((c) => c.messageId).sort()).toEqual([idOf(store, 1), idOf(store, 3)].sort());
  });

  it("reads what the sender check and header view need", () => {
    store.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, {
        from: { name: "Billing", address: "billing@example.com" },
        replyTo: [{ name: null, address: "help@example.net" }],
        bodyText: "\n\n  -----BEGIN PGP MESSAGE-----\nabc",
      }),
    ]);
    store.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1, { messageId: "s@example.org" })]);
    const sentId = store.localFolderIndex("acc_1", "Sent", EPOCH)[0]!.id;
    const rows = store.senderCheckRows([idOf(store, 1), sentId, "m_missing"]);
    expect(rows).toHaveLength(2);
    const inbox = rows.find((row) => row.id === idOf(store, 1))!;
    expect(inbox).toMatchObject({
      accountId: "acc_1",
      folder: INBOX,
      folderRole: "inbox",
      from: { name: "Billing", address: "billing@example.com" },
      replyTo: [{ name: null, address: "help@example.net" }],
      firstLine: "-----BEGIN PGP MESSAGE-----",
    });
    expect(rows.find((row) => row.id === sentId)!.folderRole).toBe("sent");
  });

  it("knownDomainList joins own, sent-to and Sent-folder domains, deduplicated and capped", () => {
    db.prepare("INSERT INTO sent_recipients (account_id, address, last_sent_at) VALUES (?, ?, ?)").run("acc_1", "a@news.example.net", EPOCH);
    db.prepare("INSERT INTO sent_recipients (account_id, address, last_sent_at) VALUES (?, ?, ?)").run("acc_1", "b@example.net", EPOCH);
    store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(1, { to: [{ name: null, address: "x@Partner.Example.com" }], cc: [{ name: null, address: "y@example.co.uk" }] }),
    ]);
    store.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1, { to: [{ name: null, address: "z@inbound-only.example" }] })]);
    const all = store.knownDomainList(5_000);
    expect([...all].sort()).toEqual(["example.co.uk", "example.com", "example.net", "example.org"]);
    expect(all[0]).toBe("example.org");
    expect(store.knownDomainList(2)).toHaveLength(2);
    expect(store.knownDomainList(0)).toEqual([]);
  });
});

describe.each(storeKinds)("slice-3i store semantics (%s)", (_kind, make) => {
  let s: MailStore;
  beforeEach(() => {
    s = make();
    s.saveAccount(makeStoredAccount());
    s.saveFolders("acc_1", FOLDERS_3F);
  });
  const idIn = (folder: string, uid: number) => s.localFolderIndex("acc_1", folder, EPOCH).find((e) => e.uid === uid)!.id;

  // Slice 3i review, finding 3: a check over 2 KB is cut to fit, never dropped.
  const longDomain = (i: number) => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(50)}.s${i}.example.org`;
  const bigFailed = (): SenderCheck => ({
    ...checkOf("failed"),
    spf: { result: "temperror", domain: longDomain(9) },
    dkim: Array.from({ length: 5 }, (_, i) => ({ result: "temperror" as const, domain: longDomain(i), aligned: false })),
    otherDmarc: Array.from({ length: 3 }, (_, i) => ({ result: "pass" as const, domain: longDomain(i + 5) })),
  });
  const storedBytes = (id: string) => new TextEncoder().encode(s.senderCheckRows([id])[0]!.senderCheckJson!).length;

  it("shrinks a check over 2 KB to fit and keeps a failure, clearing the dev class", () => {
    expect(new TextEncoder().encode(JSON.stringify(bigFailed())).length).toBeGreaterThan(2_048);
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { senderCheck: bigFailed(), dev: { source: "github", repo: null, kind: "ci", state: "failed", ref: null } }),
      makeFetchedMessage(2, { dev: { source: "github", repo: null, kind: "ci", state: "failed", ref: null } }),
    ]);
    const first = idIn(INBOX, 1);
    expect(JSON.parse(s.senderCheckRows([first])[0]!.senderCheckJson!)).toMatchObject({ state: "failed", decidedBy: "dmarc" });
    expect(storedBytes(first)).toBeLessThanOrEqual(2_048);
    expect(s.getMessage(first)!.dev).toBeNull();

    const second = idIn(INBOX, 2);
    expect(s.writeSenderCheck(second, { check: bigFailed(), receipt: null, crypto: null, force: false })).toBe(true);
    expect(JSON.parse(s.senderCheckRows([second])[0]!.senderCheckJson!).state).toBe("failed");
    expect(storedBytes(second)).toBeLessThanOrEqual(2_048);
    expect(s.getMessage(second)!.dev).toBeNull();
  });

  it("a forced refresh never turns a stored encrypted kind back to none once the body is gone (finding 8)", () => {
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { bodyText: "-----BEGIN PGP MESSAGE-----", bodyHtml: null, crypto: { kind: "pgp_encrypted", opaque: false } }),
      makeFetchedMessage(2, { crypto: { kind: "smime_signed", opaque: false } }),
    ]);
    // The refresh judges inline armor from the stored body's first line, which is NULL now.
    expect(s.writeSenderCheck(idIn(INBOX, 1), { check: checkOf("unchecked"), receipt: false, crypto: null, force: true })).toBe(true);
    expect(s.senderCheckRows([idIn(INBOX, 1)])[0]!.crypto).toEqual({ kind: "pgp_encrypted", opaque: false });
    // Anything else is still overwritten with force.
    expect(s.writeSenderCheck(idIn(INBOX, 2), { check: checkOf("unchecked"), receipt: false, crypto: null, force: true })).toBe(true);
    expect(s.senderCheckRows([idIn(INBOX, 2)])[0]!.crypto).toBeNull();
  });

  it("writes checks where unknown, forces on request and drops failed rows from dev backfill", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1), makeFetchedMessage(2, { senderCheck: checkOf("failed") })]);
    expect(s.devUnclassified(10).map((r) => r.id)).toEqual([idIn(INBOX, 1)]);
    expect(s.writeSenderCheck(idIn(INBOX, 1), { check: checkOf("ok"), receipt: true, crypto: null, force: false })).toBe(true);
    expect(s.writeSenderCheck(idIn(INBOX, 1), { check: checkOf("failed"), receipt: null, crypto: null, force: false })).toBe(false);
    expect(s.writeSenderCheck(idIn(INBOX, 1), { check: checkOf("failed"), receipt: null, crypto: null, force: true })).toBe(true);
    expect(s.devUnclassified(10)).toEqual([]);
    const [row] = s.senderCheckRows([idIn(INBOX, 1)]);
    expect(row).toMatchObject({ receiptRequested: true, folderRole: "inbox" });
    expect(JSON.parse(row!.senderCheckJson!).state).toBe("failed");
  });

  it("knows the domains the owner writes to and owns", () => {
    s.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1, { to: [{ name: null, address: "x@mail.example.com" }] })]);
    expect([...s.knownDomainList(100)].sort()).toEqual(["example.com", "example.org"]);
  });
});

describe("slice 3j: rethreading only what changed", () => {
  let db: Database.Database;
  let s: MailStore;
  const threadRows = () =>
    db.prepare("SELECT * FROM threads ORDER BY id").all() as Record<string, unknown>[];
  const rethread = () => s.assignThreads("acc_1", buildThreads(s.threadingInputs("acc_1")));

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    s = createSqliteStore(db);
    s.saveAccount(makeStoredAccount());
  });

  it("is stale until threads are assigned, and again after an insert or a delete", () => {
    expect(s.threadsStale("acc_1")).toBe(true);
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    rethread();
    expect(s.threadsStale("acc_1")).toBe(false);

    s.applyFlags("acc_1", INBOX, [{ uid: 1, seen: true, flagged: false }]);
    expect(s.threadsStale("acc_1")).toBe(false);

    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(2)]);
    expect(s.threadsStale("acc_1")).toBe(true);
    rethread();
    s.deleteByUids("acc_1", INBOX, [2]);
    expect(s.threadsStale("acc_1")).toBe(true);
  });

  it("keeps the thread rows equal to a full rebuild as rows join, leave and change", () => {
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(1, { subject: "Invented plan", date: "2026-11-11T10:00:00.000Z" }),
      makeFetchedMessage(2, { subject: "Invented lunch", date: "2026-11-11T11:00:00.000Z" }),
    ]);
    rethread();
    // Second assignment is incremental: a reply joins the first thread.
    s.upsertMessages("acc_1", INBOX, [
      makeFetchedMessage(3, {
        subject: "Re: Invented plan",
        date: "2026-11-12T10:00:00.000Z",
        inReplyTo: "msg-1@example.org",
        references: ["msg-1@example.org"],
      }),
    ]);
    rethread();
    s.applyFlags("acc_1", INBOX, [{ uid: 3, seen: true, flagged: true }]);
    s.deleteByUids("acc_1", INBOX, [2]);
    rethread();

    const incremental = threadRows();
    expect(incremental).toHaveLength(1);
    expect(incremental[0]).toMatchObject({ message_count: 2 });
    expect(s.repairThreads("acc_1")).toBe(1);
    expect(threadRows()).toEqual(incremental);
  });

  it(
    "rethreads one new message in a 20,000-row account without rewriting every thread row",
    () => {
      // 50,000 rows when MAIL_SCALE=1 is set (measured by hand, not in `npm run check`).
      const rows = process.env.MAIL_SCALE === "1" ? 50_000 : 20_000;
      const start = Date.UTC(2026, 0, 1);
      for (let from = 0; from < rows; from += 5_000) {
        s.upsertMessages(
          "acc_1",
          INBOX,
          Array.from({ length: 5_000 }, (_, i) =>
            makeFetchedMessage(from + i + 1, {
              messageId: `scale-${from + i}@example.org`,
              date: new Date(start + (from + i) * 60_000).toISOString(),
            }),
          ),
        );
      }
      rethread();
      s.upsertMessages("acc_1", INBOX, [
        makeFetchedMessage(rows + 1, {
          messageId: "scale-new@example.org",
          inReplyTo: "scale-7@example.org",
          references: ["scale-7@example.org"],
        }),
      ]);
      const inputs = s.threadingInputs("acc_1");
      const threadOf = buildThreads(inputs);
      const deletes: string[] = [];
      db.function("mail_test_note", (id: string) => {
        deletes.push(id);
        return 0;
      });
      db.exec(
        "CREATE TEMP TRIGGER note_thread_delete AFTER DELETE ON threads BEGIN SELECT mail_test_note(old.id); END",
      );
      const { ms } = timeOne(() => s.assignThreads("acc_1", threadOf));
      // The reply's own thread and the one it joined: nothing else is rewritten.
      expect(deletes.length).toBeLessThanOrEqual(2);
      expect(ms).toBeLessThan(ROUND_MS);
      expect(count(db, "threads")).toBe(rows);
      expect(timeOne(() => s.threadsStale("acc_1")).ms).toBeLessThan(PAGE_MS);
    },
    SEEDING_TIMEOUT_MS * 3,
  );

  it("rebuilds every thread row on the first assignment after a load", () => {
    s.upsertMessages("acc_1", INBOX, [makeFetchedMessage(1)]);
    rethread();
    db.prepare("UPDATE threads SET message_count = 99").run();
    const reloaded = createSqliteStore(db);
    reloaded.assignThreads("acc_1", buildThreads(reloaded.threadingInputs("acc_1")));
    expect(threadRows()[0]).toMatchObject({ message_count: 1 });
  });
});

describe("slice 3k: OpenPGP keys in the store", () => {
  let db: Database.Database;
  let s: MailStore;
  const key = (id: string, kind: "own" | "contact", fingerprint: string) => ({
    id,
    kind,
    fingerprint,
    addresses: ["owner@example.org"],
    userIds: ["Owner <owner@example.org>"],
    publicArmor: "invented public armor",
    createdAt: "2026-11-17T10:00:00.000Z",
    expiresAt: null,
    addedAt: "2026-11-17T10:00:00.000Z",
    source: "generated" as const,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    s = createSqliteStore(db);
  });

  it("keeps the private half out of every row and returns it sealed for an own key only", () => {
    expect(s.savePgpKey(key("pgp_1", "own", "AA"), "sealed-own")).toBe("saved");
    expect(s.savePgpKey(key("pgp_2", "contact", "AA"), "sealed-ignored")).toBe("saved");
    expect(s.savePgpKey(key("pgp_3", "own", "AA"), "x")).toBe("exists");
    expect(s.listPgpKeys().map((row) => row.id)).toEqual(["pgp_1", "pgp_2"]);
    expect(JSON.stringify(s.listPgpKeys())).not.toContain("sealed");
    expect(JSON.stringify(s.getPgpKey("pgp_1"))).not.toContain("sealed");
    expect(s.pgpPrivateSealed("pgp_1")).toBe("sealed-own");
    expect(s.pgpPrivateSealed("pgp_2")).toBeNull();
    expect(s.pgpPrivateSealed("nope")).toBeNull();
    expect(s.deletePgpKey("pgp_1")).toBe(true);
    expect(s.deletePgpKey("pgp_1")).toBe(false);
    expect(s.getPgpKey("pgp_1")).toBeNull();
  });
});
