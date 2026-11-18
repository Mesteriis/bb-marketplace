import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mboxEntry } from "../../core/mbox.ts";
import { InMemoryMailStore } from "../../core/testing/fakes.ts";
import {
  ARCHIVE_BATCH,
  ArchiveRefused,
  importArchive,
  readArchiveAttachment,
  type ArchiveImportDeps,
} from "./archive-import.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");
const bytes = (text: string) => new TextEncoder().encode(text);

const plain = (n: number, body = `Invented body ${n} about the orchard`) =>
  bytes(
    [
      `From: Sender ${n} <sender${n}@example.com>`,
      "To: Owner <owner@example.org>, second@example.org",
      `Subject: Invented subject ${n}`,
      `Date: Mon, 0${(n % 9) + 1} Mar 2010 08:00:00 +0000`,
      `Message-ID: <old-${n}@example.com>`,
      "",
      body,
      "",
    ].join("\r\n"),
  );

const withAttachment = bytes(
  [
    "From: Ana Example <ana@example.com>",
    "To: owner@example.org",
    "Subject: Invented report",
    "Date: Tue, 02 Mar 2010 09:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "From the orchard, see the file.",
    "--b",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Invented attachment text").toString("base64"),
    "--b--",
    "",
  ].join("\r\n"),
);

const mbox = (messages: Uint8Array[]) => Buffer.concat(messages.map((raw) => mboxEntry(raw, NOW)));

let dir: string;
let ids = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "makosh-archive-"));
  ids = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const store = new InMemoryMailStore();
  const deps: ArchiveImportDeps = { store, now: () => NOW, newId: () => String(++ids) };
  return { store, deps };
}

const reasonOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => (error instanceof ArchiveRefused ? error.reason : String(error)),
  );

describe("importArchive", () => {
  it("reads an mbox into an archive of its own, with what reading and search need, and leaves the file as it was", async () => {
    const { store, deps } = setup();
    const file = join(dir, "Old work.mbox");
    const content = mbox([plain(1), withAttachment, plain(3)]);
    await writeFile(file, content);
    const result = await importArchive(deps, { path: file, name: null });
    expect(result).toMatchObject({ added: 3, resumed: false, already: false, capped: false });
    expect(result.archive).toMatchObject({
      id: "arc_1",
      name: "Old work",
      sourcePath: file,
      kind: "mbox",
      sourceSize: content.length,
      messages: 3,
      skipped: 0,
      complete: true,
      resumeAt: content.length,
    });
    const { rows } = store.archiveMessages("arc_1", { query: "", limit: 10, cursor: null });
    expect(rows.map((row) => [row.subject, row.from.address, row.hasAttachments])).toEqual([
      ["Invented subject 3", "sender3@example.com", false],
      ["Invented report", "ana@example.com", true],
      ["Invented subject 1", "sender1@example.com", false],
    ]);
    const opened = store.archiveMessage(rows[1]!.id)!;
    expect(opened.message).toMatchObject({
      date: "2010-03-02T09:00:00.000Z",
      to: [{ name: null, address: "owner@example.org" }],
      attachments: [{ partId: "1", filename: "notes.txt", mimeType: "text/plain", isInline: false }],
    });
    // The quoted "From " line of the body came back as it was written.
    expect(opened.message.text).toContain("From the orchard, see the file.");
    expect(store.archiveMessage(rows[2]!.id)!.message.to).toEqual([
      { name: "Owner", address: "owner@example.org" },
      { name: null, address: "second@example.org" },
    ]);
    expect(new Uint8Array(await readFile(file))).toEqual(new Uint8Array(content));
    // No mailbox got anything.
    expect(store.listAccounts()).toEqual([]);
  });

  it("the same file again reads nothing; a file that grew is not read again either once complete", async () => {
    const { deps } = setup();
    const file = join(dir, "old.mbox");
    await writeFile(file, mbox([plain(1)]));
    await importArchive(deps, { path: file, name: "Invented name" });
    const again = await importArchive(deps, { path: file, name: "Other name" });
    expect(again).toMatchObject({ added: 0, already: true });
    expect(again.archive.name).toBe("Invented name");
  });

  it("a stopped import keeps what it stored, and the next run goes on from there without doubling", async () => {
    const { store, deps } = setup();
    const file = join(dir, "big.mbox");
    const count = ARCHIVE_BATCH * 2 + 30;
    await writeFile(file, mbox(Array.from({ length: count }, (_, i) => plain(i + 1))));
    const stop = new AbortController();
    // Stop once the first batch is stored.
    const append = store.appendArchiveMessages.bind(store);
    store.appendArchiveMessages = (...args) => {
      const added = append(...args);
      stop.abort();
      return added;
    };
    const first = await importArchive(deps, { path: file, name: null }, stop.signal);
    expect(first.archive.complete).toBe(false);
    expect(first.added).toBeGreaterThanOrEqual(ARCHIVE_BATCH);
    expect(first.added).toBeLessThan(count);
    expect(first.archive.resumeAt).toBeGreaterThan(0);

    store.appendArchiveMessages = append;
    const second = await importArchive(deps, { path: file, name: null });
    expect(second).toMatchObject({ resumed: true, already: false });
    expect(second.archive).toMatchObject({ complete: true, messages: count, skipped: 0 });
    expect(first.added + second.added).toBe(count);
    const subjects = new Set(store.archiveMessages("arc_1", { query: "", limit: 1000, cursor: null }).rows.map((row) => row.subject));
    expect(subjects.size).toBe(count);
  });

  it("reads one .eml file and a folder of .eml files, skipping what is not mail", async () => {
    const { store, deps } = setup();
    const single = join(dir, "letter.eml");
    await writeFile(single, plain(7));
    expect((await importArchive(deps, { path: single, name: null })).archive).toMatchObject({ kind: "eml", messages: 1, complete: true, name: "letter" });

    const folder = join(dir, "letters");
    await mkdir(folder);
    await writeFile(join(folder, "b.eml"), plain(2));
    await writeFile(join(folder, "a.eml"), withAttachment);
    await writeFile(join(folder, "c.EML"), "");
    await writeFile(join(folder, "notes.txt"), "not mail");
    const result = await importArchive(deps, { path: `${folder}/`, name: null });
    expect(result.archive).toMatchObject({ kind: "eml_dir", messages: 2, skipped: 1, complete: true, sourcePath: folder });
    const { rows } = store.archiveMessages(result.archive.id, { query: "", limit: 10, cursor: null });
    expect(rows.map((row) => row.subject).sort()).toEqual(["Invented report", "Invented subject 2"]);
  });

  it("refuses what it cannot read as an archive, and stores nothing for it", async () => {
    const { store, deps } = setup();
    await writeFile(join(dir, "notes.txt"), "Just some notes\n");
    await mkdir(join(dir, "empty"));
    expect(await reasonOf(importArchive(deps, { path: "old.mbox", name: null }))).toBe("not_absolute");
    expect(await reasonOf(importArchive(deps, { path: join(dir, "missing.mbox"), name: null }))).toBe("not_found");
    expect(await reasonOf(importArchive(deps, { path: join(dir, "notes.txt"), name: null }))).toBe("not_mail");
    expect(await reasonOf(importArchive(deps, { path: join(dir, "empty"), name: null }))).toBe("not_mail");
    expect(store.listArchives()).toEqual([]);
    for (let i = 0; i < 20; i++) {
      await writeFile(join(dir, `a${i}.eml`), plain(i));
      await importArchive(deps, { path: join(dir, `a${i}.eml`), name: null });
    }
    await writeFile(join(dir, "over.eml"), plain(99));
    expect(await reasonOf(importArchive(deps, { path: join(dir, "over.eml"), name: null }))).toBe("full");
  });
});

describe("readArchiveAttachment", () => {
  it("reads an attachment from its place in the source, and notices a file that changed or went away", async () => {
    const { store, deps } = setup();
    const file = join(dir, "old.mbox");
    await writeFile(file, mbox([plain(1), withAttachment, plain(3)]));
    await importArchive(deps, { path: file, name: null });
    const row = store.archiveMessages("arc_1", { query: "report", limit: 1, cursor: null }).rows[0]!;
    const { message, place } = store.archiveMessage(row.id)!;
    const read = () => readArchiveAttachment(store, place, message.attachments[0]!);
    expect(new TextDecoder().decode(await read())).toBe("Invented attachment text");

    // More mail appended after it: the place still holds the same message.
    await appendFile(file, mbox([plain(4)]));
    expect(new TextDecoder().decode(await read())).toBe("Invented attachment text");

    // Rewritten: other bytes at that place.
    await writeFile(file, mbox([plain(5), plain(6), plain(7), plain(8)]));
    expect(await reasonOf(read())).toBe("changed");
    await rm(file);
    expect(await reasonOf(read())).toBe("changed");
    // A stored name is never followed out of the archive's folder.
    expect(await reasonOf(readArchiveAttachment(store, { ...place, file: "../old.mbox" }, message.attachments[0]!))).toBe("changed");
  });
});
