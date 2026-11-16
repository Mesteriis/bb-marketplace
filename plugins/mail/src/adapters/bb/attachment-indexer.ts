// Attachment text indexer (slice 3h, #84; spec "Attachment text",
// resolutions 1, 4, 15). After an ok sync round, when the owner turned
// "Search inside attachments" on, text and PDF attachments of stored rows
// are extracted on this machine into attachment_text, which only the
// owner's page search reads.
//
// - Candidates: core `indexCandidates` (non-inline text and PDF parts of
//   window and history rows, no server hits, no Spam or Trash, within the
//   file and message caps, newest first, 50 per round, 200 MB of raw fetch
//   per day). Parts over a cap get a `skipped/too_large` row so they do not
//   stay pending.
// - One guarded raw fetch (read-only, BODY.PEEK) per message, then the part
//   by its index with the download route's name, type and size check.
// - Text is decoded with `decodeText` (UTF-8, else windows-1252: postal-mime
//   does not report the part's charset); PDFs go through one worker at a time
//   (pdf-text.ts). Without the PDF worker (`extractPdf: null`) PDFs get no
//   row at all.
// - Failures are rows (`failed` + reason) and are not tried again until the
//   owner presses Retry failed (the store deletes failed rows).
// - At ATTACHMENT_TEXT_TOTAL_MAX characters across the table indexing stops
//   and writes nothing more (spec resolution 15).
// - Logs carry counts only: never a file name, a message id's content or text.
import {
  ATTACHMENT_TEXT_CAPS,
  ATTACHMENT_TEXT_TOTAL_MAX,
  decodeText,
  indexCandidates,
  type AttachmentCandidate,
} from "../../core/attachment-text.ts";
import type { AttachmentTextRow, Clock, MailStore } from "../../core/index.ts";
import type { PdfTextResult } from "./pdf-text.ts";

/** Thrown by `fetchRaw` when the account cannot be reached now: no row is written, the part stays pending. */
export class RetryLater extends Error {
  constructor() {
    super("Retry later");
    this.name = "RetryLater";
  }
}

/** A parsed attachment as postal-mime gives it. */
export type ParsedPart = { filename: string | null; mimeType: string; content: ArrayBuffer | Uint8Array | string };
/** The stored metadata a part must still match. */
export type StoredPart = { filename: string | null; mimeType: string; size: number };

/**
 * The part at a stored part id (1-based index into the parsed attachments),
 * or null when it is missing or its name, type or size differ from what is
 * stored (the download route's rule).
 */
export function matchingPart(parts: readonly ParsedPart[], partId: string, stored: StoredPart): Uint8Array | null {
  const part = parts[Number(partId) - 1];
  if (part === undefined) return null;
  const bytes =
    part.content instanceof Uint8Array ? part.content : part.content instanceof ArrayBuffer ? new Uint8Array(part.content) : null;
  if (bytes === null) return null;
  if ((part.filename ?? null) !== stored.filename || part.mimeType !== stored.mimeType || bytes.byteLength !== stored.size) {
    return null;
  }
  return bytes;
}

/**
 * postal-mime does not report a part's charset: valid UTF-8 is read as
 * UTF-8, anything else as windows-1252 (a superset of Latin-1), so a
 * Latin-1 text file keeps its letters.
 */
export function charsetOf(bytes: Uint8Array): string | null {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null;
  } catch {
    return "windows-1252";
  }
}

export type AttachmentIndexerDeps = {
  store: MailStore;
  clock: Clock;
  /** The guarded raw fetch of one stored message; RetryLater when its account cannot be reached now. */
  fetchRaw: (messageId: string) => Promise<Uint8Array>;
  parse: (raw: Uint8Array) => Promise<{ attachments: readonly ParsedPart[] }>;
  /** PDF text in a worker; null when PDFs cannot be indexed (no row for them). */
  extractPdf: ((bytes: Uint8Array) => Promise<PdfTextResult>) | null;
  log?: (line: string) => void;
};

export type IndexRound = { indexed: number; skipped: number; failed: number; full: boolean; busy: boolean };

export interface AttachmentIndexer {
  /** One round; a second call while one runs returns at once with `busy`. */
  runRound(): Promise<IndexRound>;
  running(): boolean;
}

/** Candidates read per round before the core picks; Spam and Trash rows are among them. */
const CANDIDATE_SCAN = 1_000;

function overCap(candidate: AttachmentCandidate): boolean {
  const fileCap = candidate.kind === "pdf" ? ATTACHMENT_TEXT_CAPS.pdfFile : ATTACHMENT_TEXT_CAPS.file;
  return candidate.size > fileCap || candidate.messageSize > ATTACHMENT_TEXT_CAPS.message;
}

function indexable(candidate: AttachmentCandidate): boolean {
  return (
    !candidate.inline &&
    candidate.kept !== "search" &&
    candidate.folderUse !== "junk" &&
    candidate.folderUse !== "trash" &&
    (candidate.kind === "text" || candidate.kind === "pdf")
  );
}

export function createAttachmentIndexer(deps: AttachmentIndexerDeps): AttachmentIndexer {
  const { store } = deps;
  let busy = false;
  let day = "";
  let fetchedToday = 0;
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop indexing.
    }
  };

  async function round(): Promise<IndexRound> {
    const result: IndexRound = { indexed: 0, skipped: 0, failed: 0, full: false, busy: false };
    const nowIso = () => deps.clock.now().toISOString();
    const today = nowIso().slice(0, 10);
    if (today !== day) {
      day = today;
      fetchedToday = 0;
    }
    let total = store.attachmentTextStatus().totalChars;
    if (total >= ATTACHMENT_TEXT_TOTAL_MAX) return { ...result, full: true };
    const write = (row: Omit<AttachmentTextRow, "extractedAt">) => {
      store.insertAttachmentText({ ...row, extractedAt: nowIso() });
      result[row.state === "indexed" ? "indexed" : row.state === "skipped" ? "skipped" : "failed"]++;
    };

    const scanned = store
      .attachmentTextCandidates(CANDIDATE_SCAN)
      .filter((candidate) => indexable(candidate) && (candidate.kind !== "pdf" || deps.extractPdf !== null));
    for (const candidate of scanned.filter(overCap)) {
      write({ messageId: candidate.messageId, partId: candidate.partId, state: "skipped", reason: "too_large", body: null });
    }
    const { candidates } = indexCandidates(
      scanned.filter((candidate) => !overCap(candidate)),
      fetchedToday,
    );
    const byMessage = new Map<string, AttachmentCandidate[]>();
    for (const candidate of candidates) byMessage.set(candidate.messageId, [...(byMessage.get(candidate.messageId) ?? []), candidate]);

    for (const [messageId, parts] of byMessage) {
      const header = store.getMessage(messageId);
      if (header === null) continue;
      const failAll = () => {
        for (const part of parts) write({ messageId, partId: part.partId, state: "failed", reason: "unreadable", body: null });
      };
      fetchedToday += parts[0]!.messageSize;
      let parsed: { attachments: readonly ParsedPart[] };
      try {
        parsed = await deps.parse(await deps.fetchRaw(messageId));
      } catch (error) {
        if (error instanceof RetryLater) continue;
        failAll();
        continue;
      }
      for (const part of parts) {
        const stored = header.attachments.find((a) => a.partId === part.partId);
        const bytes = stored === undefined ? null : matchingPart(parsed.attachments, part.partId, stored);
        if (bytes === null) {
          write({ messageId, partId: part.partId, state: "failed", reason: "unreadable", body: null });
          continue;
        }
        let body: string;
        if (part.kind === "pdf") {
          const extracted = await deps.extractPdf!(bytes);
          if ("skipped" in extracted) {
            write({ messageId, partId: part.partId, state: "skipped", reason: "encrypted", body: null });
            continue;
          }
          if ("failed" in extracted) {
            write({ messageId, partId: part.partId, state: "failed", reason: extracted.failed, body: null });
            continue;
          }
          body = extracted.text;
        } else {
          body = decodeText(bytes, charsetOf(bytes));
        }
        if (total + body.length > ATTACHMENT_TEXT_TOTAL_MAX) {
          result.full = true;
          return result;
        }
        write({ messageId, partId: part.partId, state: "indexed", reason: null, body });
        total += body.length;
      }
    }
    return result;
  }

  return {
    async runRound() {
      if (busy) return { indexed: 0, skipped: 0, failed: 0, full: false, busy: true };
      busy = true;
      try {
        const result = await round();
        if (result.indexed + result.skipped + result.failed > 0 || result.full) {
          log(`attachment text: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed${result.full ? ", index full" : ""}`);
        }
        return result;
      } catch (error) {
        log(`attachment text: round failed (${error instanceof Error ? error.name : "error"})`);
        return { indexed: 0, skipped: 0, failed: 0, full: false, busy: false };
      } finally {
        busy = false;
      }
    },
    running: () => busy,
  };
}
