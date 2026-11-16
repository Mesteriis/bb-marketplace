// The pre-send check (slice 3d): advisory issues the composer shows in
// "Before you send" and the agent card lists. Slice 3g adds files attached
// from BB and text that looks like it holds a secret. Nothing here refuses a
// send. Pure.
import { renderDoc, type ComposeBlock, type ComposeDoc } from "./compose-doc.ts";
import { forwardSubject, replySubject } from "./compose-subjects.ts";
import type { ComposeKind } from "./model.ts";
import { hiddenTotal, redactSecrets } from "./redact.ts";

export type PresendIssue =
  /** `phrase`: the matched words, from the owner's own text or subject. */
  | { kind: "attachment_mentioned"; phrase: string }
  | { kind: "empty_subject" }
  | { kind: "outside_conversation"; addresses: string[] }
  | { kind: "new_recipients"; addresses: string[] }
  /** Slice 3g: files attached from BB projects or threads; `origins` de-duplicated, in order. */
  | { kind: "bb_files"; count: number; origins: string[] }
  /** Slice 3g: values redaction would hide in the owner's own text. */
  | { kind: "looks_secret"; count: number }
  /** Slice 3i: a reply still goes to the source's Reply-To that points away from its sender (ASCII addresses). */
  | { kind: "reply_to_elsewhere"; addresses: string[] };

export type PresendInput = {
  kind: ComposeKind;
  subject: string;
  doc: ComposeDoc;
  attachmentCount: number;
  /** To, Cc and Bcc. */
  recipients: string[];
  /** ownIdentityAddresses. */
  own: ReadonlySet<string>;
  /** Addresses sent to before: Sent-role rows and sent_recipients. */
  sentTo: ReadonlySet<string>;
  /** The source thread's From, To, Cc and Reply-To; reply / reply all with a stored source only. */
  conversation: ReadonlySet<string> | null;
  /**
   * Reply, reply all and forward: the Re:/Fwd: subject computed from the
   * source (`inheritedSubject`). The subject is searched for attachment
   * words only when the owner changed it; null (a new message, or a source
   * no longer stored) searches it always.
   */
  inheritedSubject: string | null;
  /** Slice 3g: one display label per attachment taken from BB ("project api"); absent or empty for none. */
  bbOrigins?: readonly string[];
  /**
   * Slice 3i: the source message's `reply_to_elsewhere` addresses (from
   * `disguiseWarnings`); reply and reply all only. Absent or empty for none.
   */
  replyToElsewhere?: readonly string[];
};

/** What quoteHeaderText writes above a forwarded message. */
const FORWARD_HEADER = "---------- Forwarded message ----------";

const BEFORE = "(?<!\\p{L})";
const AFTER = "(?!\\p{L})";
const word = (pattern: string) => `${BEFORE}(?:${pattern})${AFTER}`;

/**
 * The words that mean "there is a file" (spec "Forgotten attachment" and
 * resolution 15), matched on text normalized by `normalizeForMatch`. A bare
 * "приложение" is left out: it more often means an app.
 */
export const ATTACHMENT_PATTERNS: readonly string[] = [
  "attach(?:ed|ing|ments?)?",
  "enclos(?:ed|ure)",
  "find\\s+the\\s+file",
  "see\\s+the\\s+file",
  "here\\s+is\\s+the\\s+file",
  "прикрепл\\p{L}*",
  "прикрепил(?:а|и)?",
  "приложенн\\p{L}*",
  "приложен[оыа]",
  "вложени\\p{L}*",
  "аттач\\p{L}*",
  "прилага\\p{L}*",
  "прикладыва\\p{L}*",
  "приложил\\p{L}*",
  "отправляю\\s+файл",
  "высылаю\\s+файл",
];
const ATTACHMENT = new RegExp(ATTACHMENT_PATTERNS.map(word).join("|"), "u");
/** "в приложении" / "см. приложение": only with a file word within five words. */
const IN_APPENDIX = new RegExp(word("в\\s+приложении|см\\.?\\s*приложение"), "gu");
const FILE_WORDS = ["файл", "документ", "скан", "фото", "презентаци", "таблиц", "договор", "pdf", "doc", "xls"];
const NEAR_WORDS = 5;
const WORDS = /[\p{L}\p{N}]+/gu;

function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е");
}

/** The owner's own text: every top-level block but quotes and the signature; a forward's ends at the forward header. */
export function ownText(doc: ComposeDoc, kind: ComposeKind): string {
  const kept: ComposeBlock[] = [];
  for (const block of doc.content) {
    if (kind === "forward" && block.type === "paragraph" && paragraphText(block).trim() === FORWARD_HEADER) break;
    if (block.type === "blockquote" || block.type === "signature") continue;
    kept.push(block);
  }
  return renderDoc({ type: "doc", content: kept }).text;
}

function paragraphText(block: Extract<ComposeBlock, { type: "paragraph" }>): string {
  return (block.content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join("");
}

/** The subject a reply, reply all or forward starts with; null for a new message or no source subject. */
export function inheritedSubject(kind: ComposeKind, sourceSubject: string | null): string | null {
  if (sourceSubject === null) return null;
  if (kind === "forward") return forwardSubject(sourceSubject);
  if (kind === "reply" || kind === "reply_all") return replySubject(sourceSubject);
  return null;
}

const sameSubject = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** The attachment words found in the subject, else in the text; null for none. */
export function attachmentMention(subject: string, text: string): string | null {
  for (const source of [subject, text]) {
    const found = mentionIn(normalizeForMatch(source));
    if (found !== null) return found;
  }
  return null;
}

function mentionIn(text: string): string | null {
  const direct = ATTACHMENT.exec(text);
  if (direct !== null) return direct[0];
  for (const match of text.matchAll(IN_APPENDIX)) {
    const before = [...text.slice(0, match.index).matchAll(WORDS)].map((m) => m[0]).slice(-NEAR_WORDS);
    const after = [...text.slice(match.index + match[0].length).matchAll(WORDS)].map((m) => m[0]).slice(0, NEAR_WORDS);
    if ([...before, ...after].some((w) => FILE_WORDS.some((stem) => w.startsWith(stem)))) return match[0];
  }
  return null;
}

const lower = (address: string) => address.trim().toLowerCase();

/**
 * The issues, in the order attachment, subject, outside, new, Reply-To
 * elsewhere, BB files, secret-like text. A reply or
 * reply all with a stored source is checked against its conversation only:
 * its participants are never "new" (spec resolution 5). Own addresses are
 * never listed.
 */
export function presendIssues(input: PresendInput): PresendIssue[] {
  const issues: PresendIssue[] = [];
  if (input.attachmentCount === 0) {
    // An inherited Re:/Fwd: subject is the other side's words, not the owner's.
    const inherited = input.kind !== "new" && input.inheritedSubject !== null && sameSubject(input.subject, input.inheritedSubject);
    const phrase = attachmentMention(inherited ? "" : input.subject, ownText(input.doc, input.kind));
    if (phrase !== null) issues.push({ kind: "attachment_mentioned", phrase });
  }
  if (input.subject.trim() === "") issues.push({ kind: "empty_subject" });

  const own = new Set([...input.own].map(lower));
  const recipients = [...new Set(input.recipients.map(lower))].filter((address) => address !== "" && !own.has(address));
  const reply = input.kind === "reply" || input.kind === "reply_all";
  if (reply && input.conversation !== null) {
    const conversation = new Set([...input.conversation].map(lower));
    const outside = recipients.filter((address) => !conversation.has(address));
    if (outside.length > 0) issues.push({ kind: "outside_conversation", addresses: outside });
  } else {
    const sentTo = new Set([...input.sentTo].map(lower));
    const fresh = recipients.filter((address) => !sentTo.has(address));
    if (fresh.length > 0) issues.push({ kind: "new_recipients", addresses: fresh });
  }
  if (reply) {
    const flagged = new Set((input.replyToElsewhere ?? []).map(lower));
    const still = recipients.filter((address) => flagged.has(address));
    if (still.length > 0) issues.push({ kind: "reply_to_elsewhere", addresses: still });
  }
  const origins = input.bbOrigins ?? [];
  if (origins.length > 0) issues.push({ kind: "bb_files", count: origins.length, origins: [...new Set(origins)] });
  const hidden = hiddenTotal(redactSecrets(ownText(input.doc, input.kind)).counts);
  if (hidden > 0) issues.push({ kind: "looks_secret", count: hidden });
  return issues;
}

/**
 * The pre-send label of an attachment taken from BB (slice 3g): "project
 * <name>" (the project's name when known), "a BB thread", or null for an
 * upload. The origin itself is never sent.
 */
export function bbOriginLabel(origin: string | null | undefined, projectNames?: ReadonlyMap<string, string>): string | null {
  if (origin === null || origin === undefined) return null;
  if (origin.startsWith("bb:project:")) {
    const name = projectNames?.get(origin.slice("bb:project:".length));
    return name === undefined || name.trim() === "" ? "a BB project" : `project ${name}`;
  }
  if (origin.startsWith("bb:thread:")) return "a BB thread";
  return null;
}

/** The labels of a draft's attachments taken from BB, one per attachment. */
export function bbOriginLabels(
  attachments: readonly { origin?: string | null }[],
  projectNames?: ReadonlyMap<string, string>,
): string[] {
  return attachments.flatMap((attachment) => {
    const label = bbOriginLabel(attachment.origin, projectNames);
    return label === null ? [] : [label];
  });
}

/** The agent card's checks: it flags new addresses on its own (3c), so `new_recipients` is left out. */
export function cardChecks(issues: PresendIssue[]): PresendIssue[] {
  return issues.filter((issue) => issue.kind !== "new_recipients");
}
