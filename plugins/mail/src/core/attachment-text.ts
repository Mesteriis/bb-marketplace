// Attachment text (slice 3h, #84): which attachments the indexer extracts
// text from, within which caps, how text attachments are decoded, and the
// excerpt a search hit shows. Pure; extraction runs in
// src/adapters/bb/attachment-indexer.ts (PDFs in a worker thread,
// src/adapters/bb/pdf-text.ts). The text is owner-only: only the page's
// search with `attachments: true` reads it (spec resolution 4).
import { truncateText } from "./html-entities.ts";
import type { FileKind, KeptState, SpecialUse } from "./model.ts";

const MB = 1024 * 1024;

/**
 * Per round, per day of raw fetch, per file, per PDF file, per message, and
 * characters kept per file. PDFs have a lower file cap than text because a
 * worker's heap limit does not bound its buffer memory (Task 0 result).
 */
export const ATTACHMENT_TEXT_CAPS = {
  perRound: 50,
  rawPerDay: 200 * MB,
  file: 10 * MB,
  pdfFile: 5 * MB,
  message: 25 * MB,
  chars: 200_000,
} as const;

/** Characters of text across the whole table; indexing stops there (spec resolution 15). */
export const ATTACHMENT_TEXT_TOTAL_MAX = 50_000_000;

/** Characters of an excerpt in a search hit. */
export const ATTACHMENT_EXCERPT_CHARS = 120;

/** Control characters; whitespace is collapsed separately. */
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

/**
 * A text attachment's bytes as one line of searchable text: decoded with
 * its charset (UTF-8 when absent or unknown; invalid bytes become U+FFFD),
 * control characters removed, whitespace runs collapsed, at most 200 000
 * characters.
 */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8", { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  const text = decoder.decode(bytes).replace(CONTROLS, "").replace(/[\s\u0085]+/g, " ").trim();
  return truncateText(text, ATTACHMENT_TEXT_CAPS.chars);
}

/** One attachment the indexer could extract, with what the caps need. */
export type AttachmentCandidate = {
  messageId: string;
  partId: string;
  kind: FileKind;
  size: number;
  /** The whole message's raw size (one fetch per message). */
  messageSize: number;
  date: string | null;
  folderUse: SpecialUse | null;
  kept: KeptState | null;
  inline: boolean;
};

function eligible(candidate: AttachmentCandidate): boolean {
  if (candidate.inline || candidate.kept === "search") return false;
  if (candidate.folderUse === "junk" || candidate.folderUse === "trash") return false;
  if (candidate.kind !== "text" && candidate.kind !== "pdf") return false;
  const fileCap = candidate.kind === "pdf" ? ATTACHMENT_TEXT_CAPS.pdfFile : ATTACHMENT_TEXT_CAPS.file;
  return candidate.size <= fileCap && candidate.messageSize <= ATTACHMENT_TEXT_CAPS.message;
}

/**
 * This round's attachments: non-inline text and PDF parts of rows in the
 * window or loaded history (not server hits), outside Spam and Trash,
 * within the file and message caps, newest first, at most 50, and messages
 * whose raw fetch still fits today's budget (`fetchedToday` bytes so far).
 * A message's attachments go together; its raw size counts once.
 */
export function indexCandidates(
  candidates: readonly AttachmentCandidate[],
  fetchedToday: number,
): { candidates: AttachmentCandidate[]; rawBytes: number } {
  const sorted = candidates
    .filter(eligible)
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const ad = a.candidate.date;
      const bd = b.candidate.date;
      if (ad !== bd) {
        if (ad === null) return 1;
        if (bd === null) return -1;
        return ad < bd ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
  const picked: AttachmentCandidate[] = [];
  const counted = new Set<string>();
  let budget = ATTACHMENT_TEXT_CAPS.rawPerDay - fetchedToday;
  let rawBytes = 0;
  for (const candidate of sorted) {
    if (picked.length >= ATTACHMENT_TEXT_CAPS.perRound) break;
    if (!counted.has(candidate.messageId)) {
      if (candidate.messageSize > budget) continue;
      counted.add(candidate.messageId);
      budget -= candidate.messageSize;
      rawBytes += candidate.messageSize;
    }
    picked.push(candidate);
  }
  return { candidates: picked, rawBytes };
}

/**
 * `width` characters of `body` around the first case-insensitive match of
 * `phrase` (from the start when there is none), with an ellipsis where the
 * body was cut.
 */
export function excerptAround(body: string, phrase: string, width = ATTACHMENT_EXCERPT_CHARS): string {
  const at = phrase === "" ? -1 : body.toLowerCase().indexOf(phrase.toLowerCase());
  const start = at <= 0 ? 0 : Math.max(0, Math.min(at - Math.floor((width - phrase.length) / 2), body.length - width));
  const end = Math.min(body.length, start + width);
  return `${start > 0 ? "\u2026" : ""}${body.slice(start, end)}${end < body.length ? "\u2026" : ""}`;
}
