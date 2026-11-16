import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_TEXT_CAPS, ATTACHMENT_TEXT_TOTAL_MAX } from "../../core/attachment-text.ts";
import type { MailStore, RemoteFolder, SpecialUse } from "../../core/index.ts";
import { FixedClock, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { createAttachmentIndexer, matchingPart, RetryLater, type ParsedPart } from "./attachment-indexer.ts";
import { parseMail } from "./imapflow-gateway.ts";
import type { PdfTextResult } from "./pdf-text.ts";
import { MIGRATIONS, createSqliteStore } from "./sqlite-store.ts";

const NOW = new Date("2026-11-16T10:00:00.000Z");
const MB = 1024 * 1024;

let db: Database.Database;
let store: MailStore;
let clock: FixedClock;

function folder(path: string, specialUse: SpecialUse | null = null): RemoteFolder {
  return { path, name: path, delimiter: "/", specialUse, selectable: true, subscribed: true };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
  store = createSqliteStore(db);
  store.saveAccount(makeStoredAccount());
  store.saveFolders("acc_1", [folder("INBOX", "inbox"), folder("Junk", "junk"), folder("Trash", "trash"), folder("Work")]);
  clock = new FixedClock(NOW);
});

const encode = (text: string) => new TextEncoder().encode(text);

/** A stored message with attachments; returns its id and the parts the parser will give. */
function seed(
  uid: number,
  parts: { filename: string; mimeType: string; bytes: Uint8Array; isInline?: boolean }[],
  options: { folder?: string; size?: number; date?: string; kept?: "search" | "history" } = {},
): { id: string; parsed: ParsedPart[] } {
  const message = makeFetchedMessage(uid, {
    size: options.size ?? 1_000,
    date: options.date ?? `2026-11-${String(10 + (uid % 5)).padStart(2, "0")}T09:00:00.000Z`,
    attachments: parts.map((part, i) => ({
      partId: String(i + 1),
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.bytes.byteLength,
      isInline: part.isInline ?? false,
    })),
  });
  store.upsertMessages("acc_1", options.folder ?? "INBOX", [message], options.kept === undefined ? undefined : { kept: options.kept });
  const id = (db.prepare("SELECT id FROM messages WHERE folder = ? AND uid = ?").get(options.folder ?? "INBOX", uid) as { id: string }).id;
  return { id, parsed: parts.map((part) => ({ filename: part.filename, mimeType: part.mimeType, content: part.bytes })) };
}

function harness(extractPdf: ((bytes: Uint8Array) => Promise<PdfTextResult>) | null = async () => ({ text: "Invented PDF words" })) {
  const parsedBy = new Map<string, ParsedPart[]>();
  const fetched: string[] = [];
  const pdfCalls: number[] = [];
  let failFetch: Error | null = null;
  const indexer = createAttachmentIndexer({
    store,
    clock,
    fetchRaw: async (messageId) => {
      fetched.push(messageId);
      if (failFetch !== null) throw failFetch;
      return encode(messageId);
    },
    parse: async (raw) => ({ attachments: parsedBy.get(new TextDecoder().decode(raw)) ?? [] }),
    extractPdf:
      extractPdf === null
        ? null
        : async (bytes) => {
            pdfCalls.push(bytes.byteLength);
            return extractPdf(bytes);
          },
  });
  return {
    indexer,
    fetched,
    pdfCalls,
    add(entry: { id: string; parsed: ParsedPart[] }) {
      parsedBy.set(entry.id, entry.parsed);
      return entry.id;
    },
    failFetch(error: Error | null) {
      failFetch = error;
    },
  };
}

function rows(): { message_id: string; part_id: string; state: string; reason: string | null; body: string | null }[] {
  return db.prepare("SELECT message_id, part_id, state, reason, body FROM attachment_text ORDER BY message_id, part_id").all() as never;
}

describe("attachment indexer", () => {
  it("decodes UTF-8 and Latin-1 text, extracts PDFs and finds them by search with attachments only", async () => {
    const h = harness();
    const latin = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6c, 0x65, 0x64, 0x67, 0x65, 0x72]); // "Caf\u00e9 ledger" in Latin-1
    const id = h.add(
      seed(1, [
        { filename: "notes.txt", mimeType: "text/plain", bytes: encode("Invented   quarterly\u0007 notes\n\nINV-2041") },
        { filename: "latin.txt", mimeType: "text/plain", bytes: latin },
        { filename: "plan.pdf", mimeType: "application/pdf", bytes: encode("%PDF-1.4 invented") },
      ]),
    );
    const result = await h.indexer.runRound();
    expect(result).toMatchObject({ indexed: 3, failed: 0, skipped: 0, full: false });
    expect(rows()).toEqual([
      { message_id: id, part_id: "1", state: "indexed", reason: null, body: "Invented quarterly notes INV-2041" },
      { message_id: id, part_id: "2", state: "indexed", reason: null, body: "Caf\u00e9 ledger" },
      { message_id: id, part_id: "3", state: "indexed", reason: null, body: "Invented PDF words" },
    ]);
    expect(h.fetched).toEqual([id]);
    expect(h.pdfCalls).toHaveLength(1);
  });

  it("writes encrypted, timeout and unreadable PDFs as skipped or failed rows, not retried until Retry", async () => {
    const answers: PdfTextResult[] = [{ skipped: "encrypted" }, { failed: "timeout" }, { failed: "unreadable" }];
    const h = harness(async () => answers.shift()!);
    const pdf = (name: string) => ({ filename: name, mimeType: "application/pdf", bytes: encode("%PDF") });
    h.add(seed(1, [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]));
    await h.indexer.runRound();
    expect(rows().map((r) => [r.state, r.reason])).toEqual([
      ["skipped", "encrypted"],
      ["failed", "timeout"],
      ["failed", "unreadable"],
    ]);
    expect(await h.indexer.runRound()).toMatchObject({ indexed: 0, failed: 0 });
    expect(h.pdfCalls).toHaveLength(3);
    expect(store.retryAttachmentText()).toBe(2);
    answers.push({ text: "later" }, { text: "later too" });
    expect(await h.indexer.runRound()).toMatchObject({ indexed: 2 });
  });

  it("a part whose name, type or size changed fails as unreadable; a fetch refusal fails the message, RetryLater writes nothing", async () => {
    const h = harness();
    const entry = seed(1, [{ filename: "a.txt", mimeType: "text/plain", bytes: encode("Invented") }]);
    h.add({ ...entry, parsed: [{ filename: "other.txt", mimeType: "text/plain", content: encode("Invented") }] });
    const second = h.add(seed(2, [{ filename: "b.txt", mimeType: "text/plain", bytes: encode("x") }]));
    h.failFetch(new RetryLater());
    await h.indexer.runRound();
    expect(rows()).toEqual([]);
    h.failFetch(new Error("stale"));
    await h.indexer.runRound();
    expect(rows().map((r) => [r.message_id, r.state, r.reason])).toEqual(
      expect.arrayContaining([
        [entry.id, "failed", "unreadable"],
        [second, "failed", "unreadable"],
      ]),
    );
  });

  it("skips Spam, Trash, server hits, inline parts and other kinds; files over a cap get skipped/too_large", async () => {
    const h = harness();
    const text = { filename: "t.txt", mimeType: "text/plain", bytes: encode("Invented") };
    h.add(seed(1, [text], { folder: "Junk" }));
    h.add(seed(2, [text], { folder: "Trash" }));
    h.add(seed(3, [text], { kept: "search" }));
    h.add(seed(4, [{ ...text, isInline: true }, { filename: "p.png", mimeType: "image/png", bytes: encode("png") }]));
    const big = h.add(seed(5, [{ filename: "big.pdf", mimeType: "application/pdf", bytes: new Uint8Array(ATTACHMENT_TEXT_CAPS.pdfFile + 1) }]));
    const huge = h.add(seed(6, [text], { size: ATTACHMENT_TEXT_CAPS.message + 1 }));
    await h.indexer.runRound();
    expect(h.fetched).toEqual([]);
    expect(rows().map((r) => [r.message_id, r.state, r.reason])).toEqual(
      expect.arrayContaining([
        [big, "skipped", "too_large"],
        [huge, "skipped", "too_large"],
      ]),
    );
    expect(rows()).toHaveLength(2);
  });

  it("without the PDF worker, PDFs produce no row", async () => {
    const h = harness(null);
    h.add(seed(1, [{ filename: "a.pdf", mimeType: "application/pdf", bytes: encode("%PDF") }, { filename: "a.txt", mimeType: "text/plain", bytes: encode("Invented") }]));
    await h.indexer.runRound();
    expect(rows().map((r) => r.part_id)).toEqual(["2"]);
    expect(store.attachmentTextStatus().pending).toBe(1);
  });

  it("keeps the round, daily and total budgets", async () => {
    const h = harness();
    const text = { filename: "t.txt", mimeType: "text/plain", bytes: encode("Invented") };
    for (let uid = 1; uid <= ATTACHMENT_TEXT_CAPS.perRound + 5; uid++) h.add(seed(uid, [text]));
    expect((await h.indexer.runRound()).indexed).toBe(ATTACHMENT_TEXT_CAPS.perRound);
    expect((await h.indexer.runRound()).indexed).toBe(5);

    // Daily raw budget: ten 24 MB messages, eight fit in 200 MB today; the rest wait for tomorrow.
    db.prepare("DELETE FROM attachment_text").run();
    db.prepare("DELETE FROM attachments").run();
    db.prepare("DELETE FROM messages").run();
    const day = harness();
    for (let uid = 1; uid <= 10; uid++) day.add(seed(uid, [text], { size: 24 * MB }));
    await day.indexer.runRound();
    expect(day.fetched).toHaveLength(8);
    await day.indexer.runRound();
    expect(day.fetched).toHaveLength(8);
    clock.set(new Date(NOW.getTime() + 86_400_000));
    await day.indexer.runRound();
    expect(day.fetched).toHaveLength(10);

    // Total cap: at the cap nothing more is written, and the round says full.
    db.prepare("DELETE FROM attachment_text").run();
    const filler = "x".repeat(1000);
    db.prepare(
      "INSERT INTO attachment_text (message_id, part_id, state, reason, body, extracted_at) VALUES ('m_filler', '1', 'indexed', NULL, ?, ?)",
    ).run(filler.repeat(ATTACHMENT_TEXT_TOTAL_MAX / 1000), NOW.toISOString());
    const capped = harness();
    expect(await capped.indexer.runRound()).toMatchObject({ indexed: 0, full: true });
    expect(capped.fetched).toEqual([]);
  });

  it("runs one round at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async () => {
      await gate;
      return { text: "Invented" };
    });
    h.add(seed(1, [{ filename: "a.pdf", mimeType: "application/pdf", bytes: encode("%PDF") }]));
    const first = h.indexer.runRound();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.indexer.running()).toBe(true);
    expect(await h.indexer.runRound()).toMatchObject({ busy: true });
    release();
    expect(await first).toMatchObject({ indexed: 1 });
    expect(h.indexer.running()).toBe(false);
  });

  it("clear deletes everything", async () => {
    const h = harness();
    h.add(seed(1, [{ filename: "t.txt", mimeType: "text/plain", bytes: encode("Invented") }]));
    await h.indexer.runRound();
    expect(store.clearAttachmentText()).toBe(1);
    expect(rows()).toEqual([]);
  });

  it("matchingPart reads the part from a real parsed message", async () => {
    const raw = encode(
      [
        "From: sender@example.org",
        "To: owner@example.org",
        "Subject: Invented",
        "Message-ID: <m1@example.org>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body",
        "--b1",
        'Content-Type: text/plain; charset=utf-8; name="n.txt"',
        'Content-Disposition: attachment; filename="n.txt"',
        "",
        "Invented ledger",
        "--b1--",
        "",
      ].join("\r\n"),
    );
    const parsed = await parseMail(raw);
    const bytes = matchingPart(parsed.attachments, "1", { filename: "n.txt", mimeType: "text/plain", size: parsed.attachments[0]!.content instanceof ArrayBuffer ? parsed.attachments[0]!.content.byteLength : 0 });
    expect(new TextDecoder().decode(bytes!)).toContain("Invented ledger");
    expect(matchingPart(parsed.attachments, "1", { filename: "other.txt", mimeType: "text/plain", size: 15 })).toBeNull();
    expect(matchingPart(parsed.attachments, "2", { filename: "n.txt", mimeType: "text/plain", size: 15 })).toBeNull();
  });
});
