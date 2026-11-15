// Agent proposals (slice 3c), the pure part: the canonical content the owner
// confirms and its hash, how the agent's recipients merge with the Reply
// rules, the card's warning flags (new address, added by the agent, outside
// own domains, hidden characters), links in the agent's text, the caps, the
// proposal state machine, the card's submit value and the plain-text quote
// the server builds for replies and forwards. Everything the agent wrote is
// untrusted: these functions only describe it, they never act on it.
import { z } from "zod";
import { dedupeAddresses, toAsciiDomain, type OutgoingAddress } from "./compose-address.ts";
import { quoteHeaderText, type ReplySource } from "./compose-reply.ts";
import { sha256Hex } from "./compose.ts";
import { htmlToText } from "./agent-text.ts";
import type { ComposeAttachment, ComposeKind, DraftRecord } from "./model.ts";

/** A card waits this long for the owner. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Settled proposal rows are kept this long (the caps count them), then purged. */
export const PROPOSAL_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_BODY_MAX_CHARS = 50_000;
/** The card's submit value, serialized as JSON. */
export const SUBMIT_VALUE_MAX_BYTES = 1024;
/** A recipient row on the card shows this many before "and N more". */
export const RECIPIENT_ROW_COLLAPSE = 10;
export const PROPOSAL_CAPS = {
  pendingPerThread: 1,
  pendingTotal: 3,
  perThreadPerHour: 5,
  totalPerDay: 30,
  refusedInARow: 3,
  coolDownMs: 60 * 60 * 1000,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type ProposalState = "pending" | "confirming" | "queued" | "opened" | "cancelled" | "expired" | "refused";
export type ProposalEvent = "confirm" | "queue" | "open" | "queue_failed" | "cancel" | "expire" | "refuse" | "undo";

const TRANSITIONS: Partial<Record<ProposalState, Partial<Record<ProposalEvent, ProposalState>>>> = {
  pending: { confirm: "confirming", open: "opened", cancel: "cancelled", expire: "expired", refuse: "refused" },
  confirming: { queue: "queued", open: "opened", queue_failed: "opened", expire: "expired", refuse: "refused" },
  queued: { undo: "opened" },
};

/** The state an event leads to, or null when the event does not apply in that state. */
export function nextProposalState(from: ProposalState, event: ProposalEvent): ProposalState | null {
  return TRANSITIONS[from]?.[event] ?? null;
}

// ---------------------------------------------------------------------------
// Canonical content
// ---------------------------------------------------------------------------

type ContentAddress = { address: string; name: string | null };

/** What the owner confirms. Serialized with sorted keys by proposalContent. */
export type ProposalContent = {
  accountId: string;
  fromName: string | null;
  fromAddress: string;
  kind: ComposeKind;
  sourceMessageId: string | null;
  to: ContentAddress[];
  cc: ContentAddress[];
  bcc: ContentAddress[];
  subject: string;
  doc: unknown;
  inReplyTo: string | null;
  references: string[];
  attachments: { fileName: string; mimeType: string; size: number; sha256: string }[];
};

/**
 * The canonical content of a draft as JSON with sorted keys (nested ones
 * too), addresses lowercased in their given order. The From display name is
 * part of it. Row id, revision, timestamps and server-copy state are not.
 */
export function proposalContent(
  draft: DraftRecord,
  fromName: string | null,
  fromAddress: string,
  attachments: readonly (ComposeAttachment & { sha256: string })[],
): string {
  const addresses = (list: readonly { name: string | null; address: string }[]): ContentAddress[] =>
    list.map((a) => ({ address: a.address.trim().toLowerCase(), name: a.name }));
  const content: ProposalContent = {
    accountId: draft.accountId,
    fromName,
    fromAddress: fromAddress.trim().toLowerCase(),
    kind: draft.kind,
    sourceMessageId: draft.sourceMessageId,
    to: addresses(draft.to),
    cc: addresses(draft.cc),
    bcc: addresses(draft.bcc),
    subject: draft.subject,
    doc: draft.doc,
    inReplyTo: draft.inReplyTo,
    references: [...draft.references],
    attachments: attachments.map((a) => ({
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      sha256: a.sha256,
    })),
  };
  return canonicalJson(content);
}

/** SHA-256 hex of the canonical content's UTF-8 bytes. */
export function contentHash(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = sortKeys(entry);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * The proposal's recipients. `new` and `forward`: the agent's lists. Replies:
 * the computed ones (names from the store kept) plus the agent's; a computed
 * recipient is never removed, and `added` lists the agent's addresses beyond
 * the Reply rules. Agent display names are always dropped. Each address
 * appears once across To, Cc and Bcc, in that order of precedence.
 */
export function mergeAgentRecipients(
  kind: ComposeKind,
  computed: { to: OutgoingAddress[]; cc: OutgoingAddress[] },
  agent: { to: OutgoingAddress[]; cc: OutgoingAddress[]; bcc: OutgoingAddress[] },
): { to: OutgoingAddress[]; cc: OutgoingAddress[]; bcc: OutgoingAddress[]; added: string[] } {
  const bare = (list: OutgoingAddress[]): OutgoingAddress[] => list.map((a) => ({ name: null, address: a.address }));
  const reply = kind === "reply" || kind === "reply_all";
  const base = reply ? computed : { to: [], cc: [] };

  const seen = new Set<string>();
  const take = (list: OutgoingAddress[]): OutgoingAddress[] =>
    dedupeAddresses(list).filter((a) => {
      const key = a.address.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const computedKeys = new Set([...base.to, ...base.cc].map((a) => a.address.trim().toLowerCase()));
  const to = take([...base.to, ...bare(agent.to)]);
  const cc = take([...base.cc, ...bare(agent.cc)]);
  const bcc = take(bare(agent.bcc));
  const added = reply
    ? [...to, ...cc, ...bcc].map((a) => a.address).filter((a) => !computedKeys.has(a.trim().toLowerCase()))
    : [];
  return { to, cc, bcc, added };
}

export type RecipientFlag = "new" | "added" | "outside" | "hidden_chars";

/**
 * The card's flags for one recipient. `new`: the owner never sent to it
 * (`sentTo` holds lowercased addresses from To/Cc of Sent mail; mail received
 * from it does not count). `added`: the agent added it beyond the Reply
 * rules. `outside`: its domain is none of the owner's account domains.
 * `hidden_chars`: it holds bidi or zero-width characters.
 */
export function recipientFlags(
  address: string,
  ctx: { sentTo: ReadonlySet<string>; ownDomains: readonly string[]; added: readonly string[] },
): RecipientFlag[] {
  const key = address.trim().toLowerCase();
  const flags: RecipientFlag[] = [];
  if (!ctx.sentTo.has(key)) flags.push("new");
  if (ctx.added.some((a) => a.trim().toLowerCase() === key)) flags.push("added");
  const domain = key.slice(key.lastIndexOf("@") + 1);
  if (!ctx.ownDomains.some((d) => d.trim().toLowerCase() === domain)) flags.push("outside");
  if (revealHidden(address).hidden > 0) flags.push("hidden_chars");
  return flags;
}

// ---------------------------------------------------------------------------
// Hidden characters and links
// ---------------------------------------------------------------------------

/** Bidi controls and zero-width characters (spec resolution 13). */
const HIDDEN = /[‪-‮⁦-⁩‎‏؜​-‍⁠﻿]/g;

/** The text as the card shows it, without bidi and zero-width characters, and how many were removed. */
export function revealHidden(text: string): { shown: string; hidden: number } {
  let hidden = 0;
  const shown = text.replace(HIDDEN, () => {
    hidden += 1;
    return "";
  });
  return { shown, hidden };
}

/** Longest token looked at as a link; longer ones are skipped. */
const LINK_TOKEN_MAX = 2048;
const HOST_MAX = 253;
const TOKEN = /[^\s<>"'`()[\]{}]+/g;
const EDGE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "*", "_", "~", "'", '"']);
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD = /^(?:\p{L}{2,24}|xn--[a-z0-9-]{1,59})$/iu;

/**
 * Links in plain text, deduped in order: `http:`, `https:` and `mailto:`,
 * plus scheme-less `www.…`, `host.tld/path` and a bare `host.tld` (a TLD of
 * 2–24 letters or punycode). Hosts lowercased, in ASCII (IDN as punycode).
 * Addresses, abbreviations like "e.g." and version numbers are not links.
 */
export function linksIn(text: string): { url: string; host: string }[] {
  const found: { url: string; host: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    if (raw.length > LINK_TOKEN_MAX || !raw.includes(".")) continue;
    const token = trimEdges(raw);
    const host = linkHost(token);
    if (host === null || seen.has(token)) continue;
    seen.add(token);
    found.push({ url: token, host });
  }
  return found;
}

function trimEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_PUNCTUATION.has(token[start] as string)) start += 1;
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1] as string)) end -= 1;
  return token.slice(start, end);
}

function linkHost(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      const host = new URL(token).hostname;
      return host === "" ? null : host;
    } catch {
      return null;
    }
  }
  if (lower.startsWith("mailto:")) {
    const address = token.slice("mailto:".length).split("?")[0] ?? "";
    const at = address.lastIndexOf("@");
    return at <= 0 ? null : asciiHost(address.slice(at + 1));
  }
  if (token.includes("@") || token.includes("://")) return null;
  const end = firstIndexOf(token, ["/", "?", "#", ":"]);
  const host = end === -1 ? token : token.slice(0, end);
  if (host.length > HOST_MAX) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  if (!TLD.test(labels[labels.length - 1] as string)) return null;
  return asciiHost(host);
}

function asciiHost(host: string): string | null {
  try {
    return toAsciiDomain(host);
  } catch {
    return null;
  }
}

function firstIndexOf(text: string, needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export type ProposalCapRow = { threadId: string; state: ProposalState; createdAt: string; updatedAt: string };
export type ProposalCapHit = "pending_thread" | "pending_total" | "thread_hour" | "total_day" | "cool_down";

/**
 * Which cap a new proposal in `threadId` would hit, or null. `rows` are the
 * proposals of the last 24 hours plus every unsettled one. A card being
 * confirmed still counts as waiting.
 */
export function checkProposalCaps(rows: readonly ProposalCapRow[], threadId: string, now: Date): ProposalCapHit | null {
  const at = now.getTime();
  const waiting = (row: ProposalCapRow) => row.state === "pending" || row.state === "confirming";
  const since = (iso: string, ms: number) => Date.parse(iso) > at - ms;
  const thread = rows.filter((row) => row.threadId === threadId);

  if (thread.filter(waiting).length >= PROPOSAL_CAPS.pendingPerThread) return "pending_thread";
  if (rows.filter(waiting).length >= PROPOSAL_CAPS.pendingTotal) return "pending_total";
  if (thread.filter((row) => since(row.createdAt, HOUR_MS)).length >= PROPOSAL_CAPS.perThreadPerHour) {
    return "thread_hour";
  }
  if (rows.filter((row) => since(row.createdAt, DAY_MS)).length >= PROPOSAL_CAPS.totalPerDay) return "total_day";

  const latest = [...thread]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, PROPOSAL_CAPS.refusedInARow);
  if (
    latest.length === PROPOSAL_CAPS.refusedInARow &&
    latest.every((row) => row.state === "refused" || row.state === "cancelled") &&
    latest.some((row) => since(row.updatedAt, PROPOSAL_CAPS.coolDownMs))
  ) {
    return "cool_down";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Submit value
// ---------------------------------------------------------------------------

export const submitValueSchema = z
  .object({
    action: z.enum(["send", "open"]),
    proposalId: z.string().min(1).max(256),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** 32 random bytes as unpadded base64url. */
    viewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SubmitValue = z.infer<typeof submitValueSchema>;

/** The card's submit value, or null when it is not exactly that shape or over SUBMIT_VALUE_MAX_BYTES as JSON. */
export function parseSubmitValue(value: unknown): SubmitValue | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined || new TextEncoder().encode(json).length > SUBMIT_VALUE_MAX_BYTES) return null;
  const parsed = submitValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/**
 * The plain-text quote of a proposal's reply or forward (spec resolution 3):
 * the attribution or forwarded-message lines, then the original's stored
 * text, else its HTML as text. The server builds it, so the card shows and
 * the message carries the same lines.
 */
export function agentQuoteLines(
  source: ReplySource,
  kind: "reply" | "reply_all" | "forward",
  body: { text: string | null; html: string | null },
): string[] {
  const header = quoteHeaderText(source, kind);
  const plain = body.text !== null && body.text !== ""
    ? body.text
    : body.html !== null
      ? htmlToText(body.html)
      : "";
  if (plain === "") return header;
  return [...header, ...plain.replace(/\r\n?/g, "\n").split("\n")];
}
