// A local archive (slice 3p, #95): old mail read from an mbox or .eml file
// on this machine and kept apart from every mailbox. It is never uploaded,
// never synced, never sent from, and no agent surface reads it. The store
// keeps what reading and search need; attachments are read from the source
// file by the place recorded here.
import type { MailAddress } from "./model.ts";

export const ARCHIVES_MAX = 20;
export const ARCHIVE_MESSAGES_MAX = 200_000;
export const ARCHIVE_SOURCE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
/** A message larger than this is counted and skipped. */
export const ARCHIVE_MESSAGE_MAX_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_NAME_MAX = 80;
export const ARCHIVE_PAGE = 50;
export const ARCHIVE_PAGE_MAX = 200;
/** The HTML kept per message, as for live mail. */
export const ARCHIVE_HTML_CAP = 1_000_000;
/** The text kept per message for reading and search. */
export const ARCHIVE_TEXT_CAP = 1_000_000;
export const ARCHIVE_QUERY_MAX = 200;

/** One mbox file, one .eml file, or a directory of .eml files. */
export type ArchiveKind = "mbox" | "eml" | "eml_dir";

export type ArchiveRecord = {
  id: string;
  name: string;
  /** The absolute path the owner gave. Shown to the owner only. */
  sourcePath: string;
  kind: ArchiveKind;
  sourceSize: number;
  messages: number;
  /** Messages left out: over the size cap, or not readable as mail. */
  skipped: number;
  /** False while an import was stopped before the end of the source. */
  complete: boolean;
  /** Where an unfinished import of an mbox goes on (a byte offset); for a directory, how many files are done. */
  resumeAt: number;
  createdAt: string;
  updatedAt: string;
};

export type ArchiveAttachment = { partId: string; filename: string | null; mimeType: string; size: number; isInline: boolean };

/** One message as the import hands it to the store. */
export type NewArchiveMessage = {
  /** For a directory: the file's name in it; otherwise "". */
  file: string;
  /** The message's bytes in the source file. */
  offset: number;
  length: number;
  /** SHA-256 of the message's bytes, so a changed source file is noticed. */
  rawHash: string;
  messageId: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date: string | null;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  htmlTruncated: boolean;
  attachments: ArchiveAttachment[];
  size: number;
};

export type ArchiveSummary = {
  id: string;
  archiveId: string;
  date: string | null;
  from: MailAddress;
  subject: string;
  snippet: string;
  hasAttachments: boolean;
};

export type ArchiveMessage = ArchiveSummary & {
  to: MailAddress[];
  cc: MailAddress[];
  text: string | null;
  html: string | null;
  htmlTruncated: boolean;
  attachments: ArchiveAttachment[];
};

/** Where a stored message sits in its source. */
export type ArchivePlace = { archiveId: string; file: string; offset: number; length: number; rawHash: string };

/** The list's keyset cursor: `date IS NULL, date DESC, seq DESC`. */
export type ArchiveCursor = { date: string | null; id: string };

/** A name for an archive: one line, trimmed, at most ARCHIVE_NAME_MAX characters; null when nothing is left. */
export function archiveName(text: string): string | null {
  const name = Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, ARCHIVE_NAME_MAX).join("");
  return name === "" ? null : name;
}

/** The default name: the source's file name without its extension. */
export function archiveNameFromPath(path: string): string {
  const base = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  return archiveName(base.replace(/\.(mbox|mbx|eml)$/i, "")) ?? "Archive";
}
