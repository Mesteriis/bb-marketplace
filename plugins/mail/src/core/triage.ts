// Agent triage (slice 3e), the pure part: the mail_triage tool's parameters,
// validation at propose time, the caps, the content hash the card binds to,
// and the text the agent gets back. Every refusal names the item's position
// only, never a subject, an address or other message text.
import { z } from "zod";
import { refusedHidden } from "./agent-propose.ts";
import { sha256Hex } from "./compose.ts";
import { noLineBreaks, type SpecialUse } from "./model.ts";
import { validUntil } from "./snooze.ts";
import { offeredMethods, type UnsubscribeInfo } from "./unsubscribe.ts";

export const TRIAGE_ACTIONS = ["archive", "reply", "snooze", "mark_read", "spam", "unsubscribe"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const TRIAGE_ITEMS_MAX = 50;
export const TRIAGE_NOTE_MAX = 200;
export const TRIAGE_SUMMARY_MAX = 160;

export const TRIAGE_CAPS = {
  pendingPerThread: 1,
  pendingTotal: 3,
  perThreadPerHour: 6,
  totalPerDay: 30,
  cancelledInARow: 3,
  coolDownMs: 10 * 60_000,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The mail_triage tool's parameters. Notes are checked per position by validateTriage. */
export const mailTriageParamsSchema = z.object({
  items: z
    .array(
      z.object({
        messageId: z.string().min(1).max(200),
        action: z.enum(TRIAGE_ACTIONS),
        snoozeUntil: z.string().max(64).optional(),
        note: z.string().max(2_000).optional(),
      }),
    )
    .min(1)
    .max(TRIAGE_ITEMS_MAX),
  summary: z
    .string()
    .max(TRIAGE_SUMMARY_MAX)
    .refine(noLineBreaks, { message: "The summary must be one line" })
    .refine((text) => !refusedHidden(text), { message: "The summary holds invisible tag or filler characters" })
    .optional(),
});
export type MailTriageParams = z.output<typeof mailTriageParamsSchema>;
export type MailTriageItem = MailTriageParams["items"][number];

/** What validation needs to know about a message, from the store. */
export type TriageRowState = {
  id: string;
  accountId: string;
  /** The mail conversation. */
  threadId: string;
  folderRole: SpecialUse | null;
  /** null: detached, waiting for reattach. */
  uid: number | null;
  movePending: string | null;
  fromAddress: string;
  /** `messages.unsubscribe_json`; null: not known (not fetched, or no List-Unsubscribe). */
  unsubscribe: UnsubscribeInfo | null;
};

/** One frozen item; `position` is 0-based, texts say "Item position+1". */
export type ValidatedItem = {
  position: number;
  messageId: string;
  accountId: string;
  threadId: string;
  action: TriageAction;
  snoozeUntil: string | null;
  note: string | null;
};

export type TriageErrorKind =
  | "unknown"
  | "duplicate"
  | "not_inbox"
  | "detached"
  | "moving"
  | "snooze_time_missing"
  | "snooze_time_window"
  | "time_not_allowed"
  | "unsubscribe_unknown"
  | "unsubscribe_none"
  | "reply_off"
  | "note_line"
  | "note_long"
  | "note_hidden";

const TEXTS: Record<TriageErrorKind, (n: number) => string> = {
  unknown: (n) => `Item ${n} is not a message id from mail_inbox.`,
  duplicate: (n) => `Item ${n} repeats an earlier message id; give each message once.`,
  not_inbox: (n) => `Item ${n} is not in an Inbox; triage takes Inbox mail only.`,
  detached: (n) => `Item ${n} is not synced yet; leave it out.`,
  moving: (n) => `Item ${n} is being moved already; leave it out.`,
  snooze_time_missing: (n) => `Item ${n}: snooze needs snoozeUntil.`,
  snooze_time_window: (n) => `Item ${n}: snoozeUntil must be an ISO time from 5 minutes to 365 days from now.`,
  time_not_allowed: (n) => `Item ${n}: only snooze items take snoozeUntil.`,
  unsubscribe_unknown: (n) =>
    `Unsubscribe options of item ${n} are not known yet; leave it out or ask the owner to open it`,
  unsubscribe_none: (n) => `Item ${n} offers no unsubscribe method; leave it out.`,
  reply_off: (n) => `Item ${n}: replies need the owner's 'Let agents propose mail' setting; leave reply items out`,
  note_line: (n) => `Item ${n}: the note must be one line.`,
  note_long: (n) => `Item ${n}: the note must be at most ${TRIAGE_NOTE_MAX} characters.`,
  note_hidden: (n) => `Item ${n}: the note holds invisible tag or filler characters; write it without them.`,
};

/** A refusal of the whole call with a fixed text naming the item's position. */
export class TriageError extends Error {
  readonly kind: TriageErrorKind;
  readonly position: number;
  constructor(kind: TriageErrorKind, position: number) {
    super(TEXTS[kind](position + 1));
    this.name = "TriageError";
    this.kind = kind;
    this.position = position;
  }
}

export type TriageContext = {
  rows: ReadonlyMap<string, TriageRowState>;
  /** The owner's "Let agents propose mail" setting (spec resolution 2). */
  agentPropose: boolean;
  now: Date;
};

/** The frozen items, or a TriageError for the first item that is refused. */
export function validateTriage(items: readonly MailTriageItem[], ctx: TriageContext): ValidatedItem[] {
  const seen = new Set<string>();
  return items.map((item, position) => {
    const fail = (kind: TriageErrorKind): never => {
      throw new TriageError(kind, position);
    };
    const row = ctx.rows.get(item.messageId);
    if (row === undefined) fail("unknown");
    const state = row as TriageRowState;
    if (seen.has(item.messageId)) fail("duplicate");
    seen.add(item.messageId);
    if (state.folderRole !== "inbox") fail("not_inbox");
    if (state.uid === null) fail("detached");
    if (state.movePending !== null) fail("moving");

    let snoozeUntil: string | null = null;
    if (item.action === "snooze") {
      if (item.snoozeUntil === undefined) fail("snooze_time_missing");
      const until = item.snoozeUntil as string;
      if (!validUntil(until, ctx.now)) fail("snooze_time_window");
      snoozeUntil = new Date(Date.parse(until)).toISOString();
    } else if (item.snoozeUntil !== undefined) {
      fail("time_not_allowed");
    }
    if (item.action === "reply" && !ctx.agentPropose) fail("reply_off");
    if (item.action === "unsubscribe") {
      if (state.unsubscribe === null) fail("unsubscribe_unknown");
      const offered = offeredMethods(state.unsubscribe as UnsubscribeInfo, state.fromAddress);
      if (offered.oneClick === null && offered.mailto === null) fail("unsubscribe_none");
    }

    let note: string | null = null;
    if (item.note !== undefined && item.note.trim() !== "") {
      if (!noLineBreaks(item.note) || /[\u2028\u2029\u0085]/.test(item.note)) fail("note_line");
      if ([...item.note].length > TRIAGE_NOTE_MAX) fail("note_long");
      if (refusedHidden(item.note)) fail("note_hidden");
      note = item.note.trim();
    }
    return {
      position,
      messageId: item.messageId,
      accountId: state.accountId,
      threadId: state.threadId,
      action: item.action,
      snoozeUntil,
      note,
    };
  });
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

/** SHA-256 hex over the canonical JSON of the items (position, ids, action, time, note) and the summary. */
export function triageContentHash(items: readonly ValidatedItem[], summary: string | null): Promise<string> {
  const content = {
    items: items.map((item) => ({
      position: item.position,
      messageId: item.messageId,
      accountId: item.accountId,
      action: item.action,
      snoozeUntil: item.snoozeUntil,
      note: item.note,
    })),
    summary,
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(sortKeys(content))));
}

export type TriageBatchState =
  | "pending"
  | "confirming"
  | "applying"
  | "applied"
  | "cancelled"
  | "changed"
  | "expired"
  | "interrupted";

/** A batch as the caps count it: the last 24 hours plus every unsettled one. */
export type TriageHistoryRow = { threadId: string; state: TriageBatchState; createdAt: string; updatedAt: string };

const CAP_TEXT = {
  pendingThread: "A triage card is already waiting for the owner in this thread.",
  pendingTotal: "Too many triage cards are waiting for the owner.",
  threadHour: "Too many triage batches from this thread; ask the owner.",
  totalDay: "Too many triage batches today; ask the owner.",
  coolDown: "The owner cancelled recent triage cards; stop and ask.",
} as const;

/** The refusal text of the first cap a new batch in `threadId` would hit, or null. */
export function checkTriageCaps(history: readonly TriageHistoryRow[], threadId: string, now: Date): string | null {
  const at = now.getTime();
  const waiting = (row: TriageHistoryRow) => row.state === "pending" || row.state === "confirming";
  const since = (iso: string, ms: number) => Date.parse(iso) > at - ms;
  const thread = history.filter((row) => row.threadId === threadId);
  if (thread.filter(waiting).length >= TRIAGE_CAPS.pendingPerThread) return CAP_TEXT.pendingThread;
  if (history.filter(waiting).length >= TRIAGE_CAPS.pendingTotal) return CAP_TEXT.pendingTotal;
  if (thread.filter((row) => since(row.createdAt, HOUR_MS)).length >= TRIAGE_CAPS.perThreadPerHour) {
    return CAP_TEXT.threadHour;
  }
  if (history.filter((row) => since(row.createdAt, DAY_MS)).length >= TRIAGE_CAPS.totalPerDay) return CAP_TEXT.totalDay;
  const latest = [...thread]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, TRIAGE_CAPS.cancelledInARow);
  if (
    latest.length === TRIAGE_CAPS.cancelledInARow &&
    latest.every((row) => row.state === "cancelled") &&
    latest.some((row) => since(row.updatedAt, TRIAGE_CAPS.coolDownMs))
  ) {
    return CAP_TEXT.coolDown;
  }
  return null;
}

export type TriageItemOutcome = "done" | "reply_approved" | "not_approved" | "skipped" | "rate_limited" | "failed";

export type TriageResult = {
  state: Extract<TriageBatchState, "applied" | "cancelled" | "changed" | "expired" | "interrupted">;
  items: { messageId: string; action: TriageAction; outcome: TriageItemOutcome }[];
};

const DONE_PARTS: [Exclude<TriageAction, "reply">, (n: number) => string][] = [
  ["archive", (n) => `archived ${n}`],
  ["mark_read", (n) => `marked read ${n}`],
  ["snooze", (n) => `snoozed ${n}`],
  ["spam", (n) => `moved ${n} to Spam`],
  ["unsubscribe", (n) => `unsubscribe requested for ${n}`],
];

/** The agent's result (spec "Agent result"): fixed sentences, counts and the message ids the agent already had. */
export function triageResultText(result: TriageResult): string {
  switch (result.state) {
    case "cancelled":
      return "The owner did not approve these actions; nothing ran. Do not propose them again unless the owner asks.";
    case "changed":
      return "Not applied: the batch changed before the owner approved it; nothing ran.";
    case "expired":
      return "The owner did not answer in time; nothing ran.";
    case "interrupted":
      return "A restart interrupted this batch; nothing more runs. Ask the owner to check their Inbox.";
    case "applied":
      break;
  }
  const ids = (outcome: TriageItemOutcome) =>
    result.items.filter((item) => item.outcome === outcome).map((item) => item.messageId);
  const total = result.items.length;
  const approved = total - ids("not_approved").length;
  const done = result.items.filter((item) => item.outcome === "done");
  const parts = DONE_PARTS.flatMap(([action, text]) => {
    const count = done.filter((item) => item.action === action).length;
    return count === 0 ? [] : [text(count)];
  });
  const sentences = [`The owner approved ${approved} of ${total} actions.`];
  sentences.push(`Done: ${parts.length === 0 ? "nothing" : parts.join(", ")}.`);
  const notApproved = ids("not_approved");
  if (notApproved.length > 0) {
    sentences.push(`Not approved: ${notApproved.join(", ")}. Do not propose those again unless the owner asks.`);
  }
  const replies = ids("reply_approved");
  if (replies.length > 0) {
    sentences.push(
      `Replies approved for: ${replies.join(", ")} — draft each with mail_propose; the owner reviews every reply separately.`,
    );
  }
  const skipped = ids("skipped");
  if (skipped.length > 0) sentences.push(`Skipped (moved since): ${skipped.join(", ")}.`);
  const limited = ids("rate_limited");
  if (limited.length > 0) sentences.push(`Rate-limited, try later: ${limited.join(", ")}.`);
  const failed = ids("failed");
  if (failed.length > 0) sentences.push(`Failed: ${failed.join(", ")}.`);
  return sentences.join(" ");
}
