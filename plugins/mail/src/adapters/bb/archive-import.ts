// Import into a local archive (slice 3p, #95): one mbox file, one .eml
// file, or a directory of .eml files on this machine. The source is read as
// a stream in one pass and never written to; each message is parsed with the
// parser sync uses and stored in batches, so a stopped import leaves a usable
// archive that the same command continues. Nothing is sent anywhere. Log
// lines carry an archive id and counts: never a path, a subject or a sender.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ARCHIVE_HTML_CAP,
  ARCHIVE_MESSAGES_MAX,
  ARCHIVE_MESSAGE_MAX_BYTES,
  ARCHIVE_SOURCE_MAX_BYTES,
  ARCHIVE_TEXT_CAP,
  archiveName,
  archiveNameFromPath,
  type ArchiveAttachment,
  type ArchiveKind,
  type ArchivePlace,
  type ArchiveRecord,
  type NewArchiveMessage,
} from "../../core/archive.ts";
import { MboxSplitter, mboxSliceMessage } from "../../core/mbox.ts";
import type { MailAddress } from "../../core/model.ts";
import type { MailStore } from "../../core/ports.ts";
import { snippetOf } from "../../core/snippet.ts";
import { parseMail } from "./imapflow-gateway.ts";

/** Messages stored per transaction. */
export const ARCHIVE_BATCH = 200;
/** Most .eml files read from one directory. */
export const ARCHIVE_DIR_FILES_MAX = ARCHIVE_MESSAGES_MAX;

export type ArchiveRefusal =
  | "not_absolute"
  | "not_found"
  | "not_mail"
  | "too_large"
  | "full"
  | "changed"
  | "failed";

export class ArchiveRefused extends Error {
  constructor(readonly reason: ArchiveRefusal) {
    super(reason);
    this.name = "ArchiveRefused";
  }
}

export const ARCHIVE_REFUSALS: Record<ArchiveRefusal, string> = {
  not_absolute: "Give the file as a full path, for example /Users/me/old-mail.mbox.",
  not_found: "There is no such file or folder, or it cannot be read.",
  not_mail: "This is not an mbox file, an .eml file or a folder of .eml files.",
  too_large: "The source is larger than 20 GB.",
  full: "There are 20 archives already; remove one first.",
  changed: "The archive's file has been moved or changed since the import; the message's text is kept, its attachments are not available.",
  failed: "The archive could not be read.",
};

export type ArchiveImportDeps = {
  store: MailStore;
  now: () => Date;
  newId: () => string;
};

export type ArchiveImportResult = {
  archive: ArchiveRecord;
  /** Messages this run added. */
  added: number;
  /** The run went on from an earlier, unfinished one. */
  resumed: boolean;
  /** Nothing was read: the archive was complete already. */
  already: boolean;
  /** The archive holds ARCHIVE_MESSAGES_MAX messages; the rest of the source was left out. */
  capped: boolean;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Parsed = Awaited<ReturnType<typeof parseMail>>;
type ParsedAddress = NonNullable<Parsed["from"]>;

function addressesOf(list: readonly ParsedAddress[] | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  for (const entry of list ?? []) {
    // A group lists its members; its own name is not an address.
    const members = "group" in entry && Array.isArray(entry.group) ? entry.group : [entry];
    for (const member of members) {
      const address = typeof member.address === "string" ? member.address.trim() : "";
      if (address !== "") out.push({ name: member.name?.trim() || null, address });
    }
  }
  return out.slice(0, 200);
}

function sizeOf(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  if (content instanceof ArrayBuffer) return content.byteLength;
  return ArrayBuffer.isView(content) ? content.byteLength : 0;
}

function attachmentsOf(parsed: Parsed): ArchiveAttachment[] {
  return parsed.attachments.slice(0, 200).map((attachment, index) => ({
    partId: String(index + 1),
    filename: attachment.filename ?? null,
    mimeType: attachment.mimeType,
    size: sizeOf(attachment.content),
    isInline: attachment.disposition === "inline" || attachment.related === true,
  }));
}

/** What the store keeps of one message; null when the bytes are not readable as mail. */
export async function archiveRowOf(raw: Uint8Array, place: { file: string; offset: number; length: number }): Promise<NewArchiveMessage | null> {
  let parsed: Parsed;
  try {
    parsed = await parseMail(raw);
  } catch {
    return null;
  }
  const from = addressesOf(parsed.from === undefined ? [] : [parsed.from])[0] ?? { name: parsed.from?.name?.trim() || null, address: "" };
  // Bytes with no header a message has are not mail (a stray file in a folder, a broken entry).
  if (from.address === "" && (parsed.subject ?? "") === "" && parsed.date === undefined && parsed.messageId === undefined) return null;
  const time = parsed.date === undefined ? NaN : Date.parse(parsed.date);
  const text = parsed.text ?? null;
  const html = parsed.html ?? null;
  return {
    ...place,
    rawHash: sha256(raw),
    messageId: parsed.messageId?.trim() || null,
    from,
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject: (parsed.subject ?? "").slice(0, 2_000),
    date: Number.isNaN(time) ? null : new Date(time).toISOString(),
    snippet: snippetOf(text, html),
    bodyText: text === null ? null : text.slice(0, ARCHIVE_TEXT_CAP),
    bodyHtml: html !== null && html.length > ARCHIVE_HTML_CAP ? null : html,
    htmlTruncated: html !== null && html.length > ARCHIVE_HTML_CAP,
    attachments: attachmentsOf(parsed),
    size: raw.byteLength,
  };
}

async function kindOf(path: string): Promise<{ kind: ArchiveKind; size: number; files: string[] }> {
  const info = await stat(path).catch(() => null);
  if (info === null) throw new ArchiveRefused("not_found");
  if (info.isDirectory()) {
    let names: string[];
    try {
      names = (await readdir(path)).filter((name) => /\.eml$/i.test(name)).sort();
    } catch {
      throw new ArchiveRefused("not_found");
    }
    if (names.length === 0) throw new ArchiveRefused("not_mail");
    return { kind: "eml_dir", size: 0, files: names.slice(0, ARCHIVE_DIR_FILES_MAX) };
  }
  if (!info.isFile()) throw new ArchiveRefused("not_mail");
  if (info.size > ARCHIVE_SOURCE_MAX_BYTES) throw new ArchiveRefused("too_large");
  const head = Buffer.alloc(5);
  const handle = await open(path, "r").catch(() => null);
  if (handle === null) throw new ArchiveRefused("not_found");
  try {
    await handle.read(head, 0, 5, 0);
  } finally {
    await handle.close();
  }
  if (head.toString("latin1") === "From ") return { kind: "mbox", size: info.size, files: [] };
  if (/\.eml$/i.test(path)) return { kind: "eml", size: info.size, files: [] };
  throw new ArchiveRefused("not_mail");
}

/**
 * Reads the source into its archive, making the archive when the path is
 * new and going on where an unfinished import stopped. `signal` stops it
 * between batches; what was stored stays.
 */
export async function importArchive(
  deps: ArchiveImportDeps,
  input: { path: string; name: string | null },
  signal?: AbortSignal,
): Promise<ArchiveImportResult> {
  const { store } = deps;
  if (!isAbsolute(input.path) || input.path.includes("\0")) throw new ArchiveRefused("not_absolute");
  const path = input.path.replace(/\/+$/, "") || "/";
  const source = await kindOf(path);
  const nowIso = () => deps.now().toISOString();

  let archive = store.findArchiveBySource(path);
  const resumed = archive !== null;
  if (archive !== null && archive.complete) return { archive, added: 0, resumed: false, already: true, capped: false };
  if (archive === null) {
    const created = store.createArchive({
      id: `arc_${deps.newId()}`,
      name: (input.name === null ? null : archiveName(input.name)) ?? archiveNameFromPath(path),
      sourcePath: path,
      kind: source.kind,
      sourceSize: source.size,
      messages: 0,
      skipped: 0,
      complete: false,
      resumeAt: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    if ("full" in created) throw new ArchiveRefused("full");
    archive = created.archive;
  }
  const id = archive.id;
  let skipped = archive.skipped;
  let added = 0;
  let stored = archive.messages;
  let batch: NewArchiveMessage[] = [];
  const flush = (resumeAt: number, complete: boolean) => {
    added += store.appendArchiveMessages(id, batch, { resumeAt, skipped, complete, nowIso: nowIso() });
    stored = store.getArchive(id)?.messages ?? stored;
    batch = [];
  };
  const full = () => stored + batch.length >= ARCHIVE_MESSAGES_MAX;
  let capped = false;

  try {
    if (source.kind === "mbox") {
      const start = Math.min(archive.resumeAt, source.size);
      const splitter = new MboxSplitter(ARCHIVE_MESSAGE_MAX_BYTES, start);
      let resumeAt = start;
      const take = async (messages: ReturnType<MboxSplitter["push"]>) => {
        for (const message of messages) {
          if (full()) {
            capped = true;
            return;
          }
          const row = message.raw === null ? null : await archiveRowOf(message.raw, { file: "", offset: message.offset, length: message.length });
          if (row === null) skipped += 1;
          else batch.push(row);
          resumeAt = message.offset + message.length;
          if (batch.length >= ARCHIVE_BATCH) flush(resumeAt, false);
        }
      };
      const stream = createReadStream(path, { start, highWaterMark: 1024 * 1024 });
      for await (const chunk of stream) {
        if (signal?.aborted || capped) break;
        await take(splitter.push(chunk as Uint8Array));
      }
      stream.destroy();
      if (!signal?.aborted && !capped) await take(splitter.end());
      flush(signal?.aborted ? resumeAt : source.size, !signal?.aborted);
    } else {
      const files = source.kind === "eml" ? [""] : source.files;
      let done = Math.min(archive.resumeAt, files.length);
      for (; done < files.length; done++) {
        if (signal?.aborted) break;
        if (full()) {
          capped = true;
          break;
        }
        const name = files[done]!;
        const file = name === "" ? path : join(path, name);
        const info = await stat(file).catch(() => null);
        if (info === null || !info.isFile() || info.size > ARCHIVE_MESSAGE_MAX_BYTES) {
          skipped += 1;
          continue;
        }
        const handle = await open(file, "r").catch(() => null);
        if (handle === null) {
          skipped += 1;
          continue;
        }
        let raw: Uint8Array;
        try {
          raw = new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
        const row = await archiveRowOf(raw, { file: name, offset: 0, length: raw.byteLength });
        if (row === null) skipped += 1;
        else batch.push(row);
        if (batch.length >= ARCHIVE_BATCH) flush(done + 1, false);
      }
      flush(done, !signal?.aborted);
    }
  } catch (error) {
    if (error instanceof ArchiveRefused) throw error;
    // Keep what was read; the next run goes on from the last stored batch.
    throw new ArchiveRefused("failed");
  }
  return { archive: store.getArchive(id)!, added, resumed, already: false, capped };
}

/**
 * The bytes of a stored message, read again from its place in the source
 * and checked against the hash taken at import. Throws `changed` when the
 * file is gone or holds something else there now.
 */
export async function readArchiveRaw(store: Pick<MailStore, "getArchive">, place: ArchivePlace): Promise<Uint8Array> {
  const archive = store.getArchive(place.archiveId);
  if (archive === null) throw new ArchiveRefused("changed");
  // The stored name is one path segment of the import's own listing.
  if (place.file.includes("/") || place.file.includes("\\") || place.file === ".." || place.file.includes("\0")) throw new ArchiveRefused("changed");
  const file = archive.kind === "eml_dir" ? join(archive.sourcePath, place.file) : archive.sourcePath;
  if (place.length < 0 || place.length > ARCHIVE_MESSAGE_MAX_BYTES * 2) throw new ArchiveRefused("changed");
  const handle = await open(file, "r").catch(() => null);
  if (handle === null) throw new ArchiveRefused("changed");
  let slice: Buffer;
  try {
    slice = Buffer.alloc(place.length);
    const { bytesRead } = await handle.read(slice, 0, place.length, place.offset);
    if (bytesRead !== place.length) throw new ArchiveRefused("changed");
  } catch (error) {
    if (error instanceof ArchiveRefused) throw error;
    throw new ArchiveRefused("changed");
  } finally {
    await handle.close();
  }
  const raw = archive.kind === "mbox" ? mboxSliceMessage(new Uint8Array(slice), ARCHIVE_MESSAGE_MAX_BYTES) : new Uint8Array(slice);
  if (raw === null || sha256(raw) !== place.rawHash) throw new ArchiveRefused("changed");
  return raw;
}

/** One attachment of a stored message, from the source file. */
export async function readArchiveAttachment(
  store: Pick<MailStore, "getArchive">,
  place: ArchivePlace,
  stored: ArchiveAttachment,
): Promise<Uint8Array> {
  const raw = await readArchiveRaw(store, place);
  const parsed = await parseMail(raw).catch(() => null);
  const part = parsed?.attachments[Number(stored.partId) - 1];
  if (part === undefined || part.mimeType !== stored.mimeType || (part.filename ?? null) !== stored.filename) throw new ArchiveRefused("changed");
  const content = part.content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof ArrayBuffer ? new Uint8Array(content) : content;
}
