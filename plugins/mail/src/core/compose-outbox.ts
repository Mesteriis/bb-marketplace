// The outbox: queueing a send, Undo / Edit, the owner's Retry / Send now /
// Send again / Dismiss, and one worker step. Sending is owner-initiated and never
// repeated automatically once DATA may have been accepted: a claim moves a
// row queued → sending by compare-and-swap inside the account's write queue,
// immediately before SMTP is opened, a restart
// turns `sending` into `unknown`, and the only automatic retry is the
// idempotent Sent-copy APPEND (search by Message-ID first, 3 tries with
// backoff).
import { parseAddress } from "./compose-address.ts";
import { bccHeaderLine, insertBccHeader } from "./compose-bcc.ts";
import {
  ATTACHMENT_CAP_BYTES,
  ComposeError,
  MAX_RECIPIENTS,
  imapConfigOf,
  outgoingOf,
  removeServerCopy,
  requireAccount,
  roleFolder,
  type ComposeDeps,
} from "./compose.ts";
import { sendCheckOnAccepted, type SendCheck } from "./identities.ts";
import type { DraftOrigin, OutboxRecord, OutboxState, SendErrorKind, StoredAccount } from "./model.ts";
import {
  SendError,
  type Clock,
  type MailTransport,
  type OutboxNotifier,
  type SmtpConfig,
} from "./ports.ts";

/** The Undo window: a queued send leaves this long after Send. */
export const UNDO_MS = 10_000;
/** Sends per account in any 60 s. */
export const SEND_RATE_PER_MINUTE = 10;
/** Tries of the Sent-copy step (each searches by Message-ID first). */
export const APPEND_ATTEMPTS = 3;
/** The wait before the 2nd, 3rd (and any later) Sent-copy try. */
export const APPEND_BACKOFF_MS = [1_000, 4_000, 15_000];
/** How long after a send became unknown a Gmail account's Sent folder is searched for it. */
export const SETTLE_WINDOW_MS = 5 * 60_000;

/** Slice 3j: how long after Send a send that never reached the server is tried again on its own. */
export const RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** The wait before each automatic try; the last one repeats. */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** The gap between waiting sends released together (a sync round came back, or the cap was hit). */
export const RETRY_STAGGER_MS = 7_000;
/**
 * Failures that prove the message never reached the server: no connection,
 * no answer before the data, or a 4xx reply (which refuses the message even
 * after the data). Only these retry on their own.
 */
const RETRYABLE = new Set<SendErrorKind>(["connect", "timeout_before_data", "temporary"]);

/** The wait before try number `attempts + 1`. */
export function retryBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index]!;
}

/** What moves an outbox row. "deleted": the row is removed. */
export type OutboxEvent =
  | "claim"
  | "undo"
  | "send_now"
  | "accepted"
  | "failed"
  | "lost"
  | "copy"
  | "copied"
  | "copy_failed"
  | "retry"
  | "resend"
  | "dismiss"
  | "recover"
  | "settle"
  | "wait"
  | "hasten";

type Target = OutboxState | "deleted";

/** The state table. Every store transition is a compare-and-swap over these `from` states. */
const TRANSITIONS: Record<OutboxEvent, Partial<Record<OutboxState, Target>>> = {
  claim: { queued: "sending", waiting: "sending" },
  undo: { queued: "deleted", held: "deleted", failed: "deleted", waiting: "deleted" },
  send_now: { held: "queued", waiting: "queued" },
  // From unknown too: a reload's recovery may have marked the row while the
  // old worker was still in SMTP; an accepted send is still a sent one.
  accepted: { sending: "sent", unknown: "sent" },
  failed: { sending: "failed" },
  lost: { sending: "unknown" },
  copy: { sent: "appending" },
  copied: { sent: "done", appending: "done" },
  copy_failed: { appending: "sent_no_copy" },
  retry: { failed: "queued", sent_no_copy: "sent" },
  resend: { unknown: "queued" },
  dismiss: { unknown: "deleted", sent_no_copy: "deleted", failed: "deleted", waiting: "deleted" },
  recover: { sending: "unknown", queued: "held", appending: "sent" },
  settle: { unknown: "sent" },
  // Slice 3j: a failed try that never reached the server waits for the next one.
  wait: { sending: "waiting" },
  hasten: { waiting: "waiting" },
};

/** Where `event` takes a row in `from`, or null when it does not apply. */
export function nextOutboxState(from: OutboxState, event: OutboxEvent): Target | null {
  return TRANSITIONS[event][from] ?? null;
}

export function canTransition(from: OutboxState, event: OutboxEvent): boolean {
  return nextOutboxState(from, event) !== null;
}

function fromStates(event: OutboxEvent): OutboxState[] {
  return Object.keys(TRANSITIONS[event]) as OutboxState[];
}

/** At most SEND_RATE_PER_MINUTE sends per account in any 60 s; in memory. */
export class SendRateLimit {
  private readonly times = new Map<string, number[]>();
  constructor(private readonly clock: Clock) {}

  take(accountId: string): boolean {
    const now = this.clock.now().getTime();
    const recent = (this.times.get(accountId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= SEND_RATE_PER_MINUTE) {
      this.times.set(accountId, recent);
      return false;
    }
    recent.push(now);
    this.times.set(accountId, recent);
    return true;
  }
}

/** How long an undone request id is remembered, so a late duplicate of that Send is refused. */
export const UNDONE_TTL_MS = 10 * 60_000;

/**
 * Request ids of sends the owner undid (or took back to Edit), in memory for
 * UNDONE_TTL_MS. The row is deleted on Undo, so without this a delayed or
 * retried compose_send carrying the same id would queue the send again.
 */
export class UndoneSends {
  private readonly ids = new Map<string, number>();
  constructor(private readonly clock: Clock) {}

  add(id: string): void {
    this.prune();
    this.ids.set(id, this.clock.now().getTime());
  }

  has(id: string): boolean {
    this.prune();
    return this.ids.has(id);
  }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [id, at] of this.ids) if (now - at >= UNDONE_TTL_MS) this.ids.delete(id);
  }
}

/** What the composer asked OpenPGP to do with one outgoing message (slice 3k). */
export type ProtectRequest = {
  sign: boolean;
  encrypt: boolean;
  /** The From address: its own key signs, and the message is also encrypted to it. */
  from: string;
  /** To and Cc addresses; Bcc is refused before this is called. */
  recipients: string[];
  /** Makes the MIME boundary unique. */
  seed: string;
};

/** Fixed refusals of a signed or encrypted send. */
export const PGP_SEND_TEXT = {
  unavailable: "Signing and encryption are not available for this message",
  bcc: "An encrypted message cannot have Bcc recipients: remove them, or send without encryption",
  no_own: "There is no OpenPGP key for this sending address; make one in Mail settings",
  missing: "Some recipients have no OpenPGP key in Mail; add their keys, or send without encryption",
  failed: "The message could not be signed or encrypted. Nothing was sent.",
} as const;

export type QueueDeps = ComposeDeps & {
  notifier: OutboxNotifier;
  rate: SendRateLimit;
  undone: UndoneSends;
  /** Slice 3k: the built message signed and/or encrypted; throws ComposeError with a PGP_SEND_TEXT. */
  protect?: (mime: Uint8Array, request: ProtectRequest) => Promise<Uint8Array>;
};
export type OutboxDeps = ComposeDeps & {
  notifier: OutboxNotifier;
  transport: MailTransport;
  /** Slice 3j: the per-account cap, shared with Retry and Send again, for automatic tries. */
  rate?: SendRateLimit;
  /** Waits between Sent-copy tries; resolves early when the signal aborts. Defaults to a timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** A timer that resolves after `ms`, or at once when the signal aborts. */
function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Queues the saved draft. The requestId is the row id: the same id again
 * returns the row already queued (a double click or a retried RPC cannot
 * send twice), and an id whose send was undone is refused (`undone`), so
 * a late duplicate cannot bring it back. Validates at least one recipient, every chip, the
 * recipient count, the size cap, SMTP and the rate cap; builds the MIME
 * once (no Bcc) and stores the Bcc line for the Sent copy. The cap is
 * shared with Retry, Send again and Send now.
 */
export async function queueSend(
  deps: QueueDeps,
  input: {
    draftId: string;
    baseRevision: number;
    requestId: string;
    origin: DraftOrigin;
    /** An agent send: the From the owner confirmed; a different From actually used is `conflict`. */
    expectFrom?: { name: string | null; address: string };
    /**
     * A reply reminder (slice 3f): created `queued` in the same transaction as
     * the outbox row; skipped (`reminder: false`) at the live cap.
     */
    remind?: { id: string; days: number };
    /** Slice 3k: sign or encrypt with OpenPGP. Only the owner's composer asks; an agent send never does. */
    protect?: { sign: boolean; encrypt: boolean };
  },
): Promise<{ outboxId: string; sendAfter: string; reminder?: boolean }> {
  if (deps.undone.has(input.requestId)) throw new ComposeError("undone");
  const repeated = deps.store.getOutbox(input.requestId);
  if (repeated !== null) {
    if (repeated.draftId !== input.draftId) throw new ComposeError("conflict");
    return { outboxId: repeated.id, sendAfter: repeated.sendAfter };
  }
  const draft = deps.store.getDraft(input.draftId);
  if (draft === null) throw new ComposeError("not_found");
  if (draft.revision !== input.baseRevision) throw new ComposeError("conflict");
  const account = requireAccount(deps.store, draft.accountId);
  if (account.smtp === null) throw new ComposeError("smtp_missing");

  const message = outgoingOf(deps, account, draft, true);
  if (input.expectFrom !== undefined) {
    const expected = parseAddress(input.expectFrom.address);
    if (
      !expected.ok ||
      expected.value.address.toLowerCase() !== message.from.address.toLowerCase() ||
      input.expectFrom.name !== message.from.name
    ) {
      throw new ComposeError("conflict");
    }
  }
  const envelopeTo = uniqueAddresses([...message.to, ...message.cc, ...message.bcc].map((a) => a.address));
  if (envelopeTo.length === 0 || envelopeTo.length > MAX_RECIPIENTS) throw new ComposeError("invalid");
  const attached = message.attachments.reduce((sum, a) => sum + a.bytes.length, 0);
  if (attached > ATTACHMENT_CAP_BYTES) throw new ComposeError("too_large");
  if (!deps.rate.take(account.id)) throw new ComposeError("rate_limited");

  const wantsPgp = input.protect !== undefined && (input.protect.sign || input.protect.encrypt);
  if (wantsPgp) {
    if (input.origin !== "owner" || deps.protect === undefined) throw new ComposeError("invalid", PGP_SEND_TEXT.unavailable);
    // Each recipient's key id is visible in an encrypted message: a hidden copy would not stay hidden.
    if (input.protect!.encrypt && message.bcc.length > 0) throw new ComposeError("invalid", PGP_SEND_TEXT.bcc);
  }
  const built = await deps.builder.build(message);
  const mime = wantsPgp
    ? await deps.protect!(built, {
        sign: input.protect!.sign,
        encrypt: input.protect!.encrypt,
        from: message.from.address,
        recipients: uniqueAddresses([...message.to, ...message.cc].map((a) => a.address)),
        seed: draft.messageId,
      })
    : built;
  const now = deps.clock.now();
  let reminder: boolean | undefined;
  const queued = deps.store.transaction(() => {
    const result = deps.store.queueOutbox(
    {
      id: input.requestId,
      accountId: account.id,
      draftId: draft.id,
      messageId: draft.messageId,
      subject: draft.subject,
      envelopeFrom: message.from.address,
      envelopeTo,
      mime,
      bccHeader: bccHeaderLine(message.bcc),
      sendAfter: new Date(now.getTime() + UNDO_MS).toISOString(),
      origin: input.origin,
      createdAt: now.toISOString(),
    },
    input.baseRevision,
    );
    if (input.remind !== undefined && !("conflict" in result) && result.created) {
      const created = deps.store.createReminder({
        id: input.remind.id,
        accountId: account.id,
        outboxId: result.row.id,
        rfcMessageId: result.row.messageId,
        threadId: null,
        days: input.remind.days,
        sentAt: null,
        dueAt: null,
        state: "queued",
        createdAt: now.toISOString(),
      });
      reminder = "created" in created;
    }
    return result;
  });
  if ("conflict" in queued) throw new ComposeError("conflict");
  if (queued.created) publish(deps, queued.row, "queued");
  return { outboxId: queued.row.id, sendAfter: queued.row.sendAfter, ...(reminder === undefined ? {} : { reminder }) };
}

/**
 * Undo (queued) or Edit (held, failed): deletes the row; the draft stays,
 * unchanged, and can be saved and sent again. An agent send whose draft is
 * still the proposal's hidden draft (slice 3c) is undone through
 * store.undoAgentSend instead: in one transaction the row goes, the draft
 * becomes an ordinary owner draft and the proposal moves to `opened`.
 */
export function cancelSend(
  deps: Pick<QueueDeps, "store" | "notifier" | "undone" | "clock">,
  id: string,
): { cancelled: boolean; draftId: string | null } {
  const row = deps.store.getOutbox(id);
  if (row === null) return { cancelled: false, draftId: null };
  const draft = row.draftId === null ? null : deps.store.getDraft(row.draftId);
  if (row.origin === "agent" && draft !== null && draft.proposalId !== null) {
    const undone = deps.store.undoAgentSend(id, fromStates("undo"), deps.clock.now().toISOString());
    if (!undone.cancelled) return { cancelled: false, draftId: row.draftId };
    deps.undone.add(id);
    dropReminder(deps, id);
    deps.notifier.outboxChanged({ accountId: row.accountId, id, state: "cancelled" });
    return { cancelled: true, draftId: undone.draftId ?? row.draftId };
  }
  // A purpose draft (an unsubscribe email) never becomes an owner draft:
  // the row and the draft go in one transaction (spec resolution 19).
  if (draft !== null && draft.purpose !== null) {
    if (!deps.store.cancelSendPurpose(id, fromStates("undo")).cancelled) return { cancelled: false, draftId: null };
    deps.undone.add(id);
    dropReminder(deps, id);
    deps.notifier.outboxChanged({ accountId: row.accountId, id, state: "cancelled" });
    return { cancelled: true, draftId: null };
  }
  if (!deps.store.deleteOutbox(id, fromStates("undo"))) return { cancelled: false, draftId: row.draftId };
  deps.undone.add(id);
  dropReminder(deps, id);
  deps.notifier.outboxChanged({ accountId: row.accountId, id, state: "cancelled" });
  return { cancelled: true, draftId: row.draftId };
}

/** Undo, Edit, a cancelled or dismissed send: its queued reply reminder goes too (slice 3f). A bound one stays. */
function dropReminder(deps: Pick<QueueDeps, "store">, outboxId: string): void {
  try {
    deps.store.deleteReminderForOutbox(outboxId);
  } catch {
    // The reminder stays queued; it never turns due without a send.
  }
}

/** Held → queued with a fresh Undo window. Counts against the send cap. */
export function sendNow(deps: Pick<QueueDeps, "store" | "notifier" | "clock" | "rate">, id: string): { ok: true } {
  return requeue(deps, id, "send_now");
}

/**
 * Failed → queued (fresh Undo window, counts against the send cap);
 * sent_no_copy → sent (the copy step runs again, sends nothing). Never unknown.
 */
export function retrySend(deps: Pick<QueueDeps, "store" | "notifier" | "clock" | "rate">, id: string): { ok: true } {
  const row = deps.store.getOutbox(id);
  if (row === null) throw new ComposeError("not_found");
  if (row.state === "sent_no_copy") {
    const updatedAt = deps.clock.now().toISOString();
    if (!deps.store.transitionOutbox(id, ["sent_no_copy"], "sent", { errorKind: null, updatedAt })) {
      throw new ComposeError("conflict");
    }
    publish(deps, row, "sent");
    return { ok: true };
  }
  if (row.state !== "failed") throw new ComposeError("conflict");
  return requeue(deps, id, "retry");
}

/** Unknown → queued: the owner accepts that a second copy may arrive. Counts against the send cap. */
export function resendUnknown(deps: Pick<QueueDeps, "store" | "notifier" | "clock" | "rate">, id: string): { ok: true } {
  return requeue(deps, id, "resend");
}

/** Removes a failed, unknown or sent_no_copy row and its draft. */
export async function dismissOutbox(
  deps: Pick<ComposeDeps, "store" | "gateway" | "vault" | "queue"> & { notifier: OutboxNotifier },
  id: string,
): Promise<{ ok: true }> {
  const row = deps.store.getOutbox(id);
  if (row === null) throw new ComposeError("not_found");
  if (!deps.store.deleteOutbox(id, fromStates("dismiss"))) throw new ComposeError("conflict");
  dropReminder(deps, id);
  await dropDraft(deps, row);
  deps.notifier.outboxChanged({
    accountId: row.accountId,
    id,
    state: row.state === "sent_no_copy" ? "done" : "cancelled",
  });
  return { ok: true };
}

/**
 * One worker step: a `sent` row's copy step if any, else the oldest due
 * queued row. The claim (CAS queued → sending) happens inside the
 * account's write queue, immediately before SMTP is opened: while the send
 * waits behind a sync or an APPEND the row stays `queued`, so Undo still
 * works, and an abort while waiting leaves it `queued` with no SMTP opened.
 * True when it did something (or the row it chose went away), so the
 * worker calls again. `signal` aborts the SMTP send itself; `stop` (the
 * worker stopping, which aborts `signal` only after a drain) also keeps a
 * send that has not started yet from starting.
 */
export async function runOutboxOnce(
  deps: OutboxDeps,
  signal: AbortSignal,
  stop: AbortSignal = signal,
): Promise<boolean> {
  const stopped = () => signal.aborted || stop.aborted;
  if (stopped()) return false;
  const pendingCopy = deps.store.listOutbox(null).find((row) => row.state === "sent");
  if (pendingCopy !== undefined) {
    await copyStep(deps, pendingCopy, stop);
    return true;
  }
  const due = deps.store.nextDueOutbox(deps.clock.now().toISOString(), []);
  if (due === null) return false;
  if (due.state === "waiting" && deps.rate !== undefined && !deps.rate.take(due.accountId)) {
    // Over the cap: this automatic try moves back instead of being sent.
    const now = deps.clock.now();
    deps.store.transitionOutbox(due.id, fromStates("hasten"), "waiting", {
      sendAfter: new Date(now.getTime() + 60_000).toISOString(),
    });
    return true;
  }

  type Outcome =
    | { state: "skipped" }
    | { state: "sent"; row: OutboxRecord; rejected: string[] }
    | { state: "failed" | "unknown"; row: OutboxRecord; kind: SendErrorKind };
  let outcome: Outcome;
  try {
    outcome = await deps.queue.run(due.accountId, async (): Promise<Outcome> => {
      if (stopped()) return { state: "skipped" };
      const claimed = deps.store.claimDueOutbox(deps.clock.now().toISOString(), [], due.id);
      if (claimed === null) return { state: "skipped" }; // undone, or no longer due
      publish(deps, claimed, "sending");
      const account = deps.store.getAccount(claimed.accountId);
      const payload = deps.store.outboxPayload(claimed.id);
      let config: SmtpConfig | null = null;
      try {
        if (account !== null && payload !== null) config = smtpConfigOf(account, deps);
      } catch {
        config = null;
      }
      if (account === null || payload === null || config === null) {
        // Nothing was sent: SMTP was never opened.
        return { state: "failed", row: claimed, kind: account?.smtp === null ? "no_smtp" : "auth" };
      }
      try {
        const result = await deps.transport.send(
          config,
          { envelopeFrom: claimed.envelopeFrom, envelopeTo: claimed.envelopeTo, raw: payload.mime },
          signal,
        );
        return result.accepted.length === 0
          ? { state: "failed", row: claimed, kind: "rejected_all" }
          : { state: "sent", row: claimed, rejected: result.rejected };
      } catch (error) {
        return { row: claimed, ...classifySendError(error, claimed, account) };
      } finally {
        config.password = "";
      }
    });
  } catch {
    // The queue itself failed: nothing was claimed, or the claim stays `sending` for recovery.
    return false;
  }
  if (outcome.state === "skipped") return !stopped();

  const claimed = outcome.row;
  if (outcome.state === "sent") {
    const updatedAt = deps.clock.now().toISOString();
    const accepted = { rejected: outcome.rejected, errorKind: null, updatedAt };
    if (deps.store.transitionOutbox(claimed.id, fromStates("accepted"), "sent", accepted)) {
      publish(deps, claimed, "sent");
      const account = deps.store.getAccount(claimed.accountId);
      if (account !== null && isAliasFrom(account, claimed.envelopeFrom)) {
        recordSendCheck(deps, claimed, sendCheckOnAccepted(account.sentCopy), claimed.messageId);
      }
      const row = deps.store.getOutbox(claimed.id);
      if (row !== null) await copyStep(deps, row, stop);
    }
  } else {
    settle(deps, claimed, outcome.state, outcome.kind);
    if (outcome.kind === "sender_refused") recordSendCheck(deps, claimed, "refused", null);
  }
  return true;
}

/** The send check is advisory: a store failure never disturbs the send. */
function recordSendCheck(deps: OutboxDeps, row: OutboxRecord, check: SendCheck, messageId: string | null): void {
  try {
    deps.store.setSendCheck(row.accountId, row.envelopeFrom, check, messageId, deps.clock.now().toISOString());
  } catch {
    // Left as it was.
  }
}

/** The envelope sender is one of the account's aliases, not its own address or username. */
function isAliasFrom(account: Pick<StoredAccount, "email" | "username">, envelopeFrom: string): boolean {
  const from = envelopeFrom.trim().toLowerCase();
  return from !== account.email.trim().toLowerCase() && from !== account.username.trim().toLowerCase();
}

/**
 * For accounts whose server keeps the Sent copy (Gmail): an unknown send
 * found in Sent by its Message-ID is done. Searched only within
 * SETTLE_WINDOW_MS of becoming unknown; afterwards the owner decides.
 */
export async function settleGmailUnknown(deps: OutboxDeps): Promise<number> {
  const now = deps.clock.now().getTime();
  let settled = 0;
  for (const row of deps.store.listOutbox(null)) {
    if (row.state !== "unknown" || now - Date.parse(row.updatedAt) > SETTLE_WINDOW_MS) continue;
    const account = deps.store.getAccount(row.accountId);
    if (account === null || account.sentCopy !== "server") continue;
    const sent = roleFolder(deps.store, account.id, "sent");
    if (sent === null) continue;
    let found = false;
    try {
      found = await deps.queue.run(account.id, async () => {
        const session = await deps.gateway.openFolder(imapConfigOf(account, deps.vault), sent, {
          readOnly: true,
        });
        try {
          return (await session.findByMessageId(row.messageId)).length > 0;
        } finally {
          await session.close().catch(() => undefined);
        }
      });
    } catch {
      found = false;
    }
    if (!found) continue;
    const updatedAt = deps.clock.now().toISOString();
    if (!deps.store.transitionOutbox(row.id, fromStates("settle"), "sent", { errorKind: null, updatedAt })) continue;
    await finish(deps, row);
    settled++;
  }
  return settled;
}

/**
 * A transport failure as a state: no reply after DATA (or anything the
 * transport could not classify) is `unknown`, never a retryable failure;
 * a 5xx after DATA, a 4xx, or anything before DATA is `failed`. A
 * `rejected_message` before DATA answering MAIL FROM, on a row sent from
 * an alias of the account, is `sender_refused` (spec resolution 13); from
 * the own address it stays `rejected_message`.
 */
export function classifySendError(
  error: unknown,
  row?: Pick<OutboxRecord, "envelopeFrom">,
  account?: Pick<StoredAccount, "email" | "username"> | null,
): { state: "failed" | "unknown"; kind: SendErrorKind } {
  if (!(error instanceof SendError)) return { state: "unknown", kind: "unknown_after_data" };
  if (error.kind === "unknown_after_data") return { state: "unknown", kind: "unknown_after_data" };
  if (error.afterData && !AFTER_DATA_FAILURES.has(error.kind)) {
    return { state: "unknown", kind: "unknown_after_data" };
  }
  if (
    error.kind === "rejected_message" &&
    !error.afterData &&
    error.command === "MAIL FROM" &&
    row !== undefined &&
    account != null &&
    isAliasFrom(account, row.envelopeFrom)
  ) {
    return { state: "failed", kind: "sender_refused" };
  }
  return { state: "failed", kind: error.kind };
}

/**
 * The Outbox row's added text for a send from an alias (page only, never
 * logged): `sender_refused`, and `rejected_message` while the alias's send
 * check is neither confirmed nor accepted. Null when the kind's own text
 * is enough. `provider` names the server, when the page knows it.
 */
export function outboxErrorText(
  kind: SendErrorKind,
  address: string | null,
  check: SendCheck | null,
  provider?: string,
): string | null {
  if (address === null) return null;
  if (kind === "sender_refused") {
    const where = provider === undefined ? "" : ` at ${provider}`;
    return `The server refused to send from ${address}. Check that it is an alias of this account${where}; then Edit and pick another From, or Retry.`;
  }
  if (kind === "rejected_message" && check !== null && check !== "confirmed" && check !== "accepted") {
    return `If ${address} is not an alias of this account, the server may refuse it.`;
  }
  return null;
}

/** Server replies after DATA that prove the message was not accepted. */
const AFTER_DATA_FAILURES = new Set<SendErrorKind>(["rejected_message", "temporary", "too_large", "rejected_all"]);

export function smtpConfigOf(account: StoredAccount, deps: Pick<ComposeDeps, "vault">): SmtpConfig {
  if (account.smtp === null) throw new ComposeError("smtp_missing");
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    security: account.smtp.security,
    username: account.smtp.username ?? account.username,
    password: deps.vault.open(account.passwordSealed),
  };
}

// ---------------------------------------------------------------------------

/**
 * The Sent-copy step of a `sent` row: done for `server` accounts, else
 * search-then-APPEND, up to APPEND_ATTEMPTS tries with a backoff between
 * them (outside the write queue). An abort during the backoff stops: the
 * row stays `appending`, which the next start turns back into `sent`.
 */
async function copyStep(deps: OutboxDeps, row: OutboxRecord, stop: AbortSignal): Promise<void> {
  const account = deps.store.getAccount(row.accountId);
  if (account === null) return;
  if (account.sentCopy === "server") {
    await finish(deps, row);
    return;
  }
  const at = () => deps.clock.now().toISOString();
  if (!deps.store.transitionOutbox(row.id, ["sent"], "appending", { updatedAt: at() })) return;
  publish(deps, row, "appending");
  const sent = roleFolder(deps.store, account.id, "sent");
  const payload = deps.store.outboxPayload(row.id);
  if (sent === null || payload === null) {
    deps.store.transitionOutbox(row.id, ["appending"], "sent_no_copy", {
      errorKind: "no_sent_folder",
      updatedAt: at(),
    });
    publish(deps, row, "sent_no_copy");
    return;
  }
  const raw = payload.bccHeader === null ? payload.mime : insertBccHeader(payload.mime, payload.bccHeader);
  const sleep = deps.sleep ?? timerSleep;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(APPEND_BACKOFF_MS[Math.min(attempt - 1, APPEND_BACKOFF_MS.length - 1)]!, stop);
      if (stop.aborted) return;
    }
    try {
      await deps.queue.run(account.id, async () => {
        const session = await deps.gateway.openFolder(imapConfigOf(account, deps.vault), sent, {
          readOnly: false,
        });
        try {
          if ((await session.findByMessageId(row.messageId)).length > 0) return;
          await session.appendMessage(raw, ["\\Seen"]);
        } finally {
          await session.close().catch(() => undefined);
        }
      });
      await finish(deps, row);
      return;
    } catch {
      // Try again: the next attempt searches first, so a copy that did land is not added twice.
    }
  }
  deps.store.transitionOutbox(row.id, ["appending"], "sent_no_copy", {
    errorKind: "append_failed",
    updatedAt: at(),
  });
  publish(deps, row, "sent_no_copy");
}

/** Sent and copied: the server draft goes (by the expunge exception), then the row and its draft. */
async function finish(deps: OutboxDeps, row: OutboxRecord): Promise<void> {
  await dropDraft(deps, row, false);
  deps.store.completeOutbox(row.id);
  publish(deps, row, "done");
}

/** Removes the draft's server copy, then (unless the row's completion does it) the local draft. */
async function dropDraft(
  deps: Pick<ComposeDeps, "store" | "gateway" | "vault" | "queue">,
  row: OutboxRecord,
  deleteLocal = true,
): Promise<void> {
  if (row.draftId === null) return;
  const draft = deps.store.getDraft(row.draftId);
  if (draft === null) return;
  if (draft.serverCopy !== null) {
    await removeServerCopy(deps, draft.accountId, draft.serverCopy, draft.messageId);
  }
  if (deleteLocal) deps.store.deleteDraft(draft.id);
}

function settle(
  deps: OutboxDeps,
  row: OutboxRecord,
  state: "failed" | "unknown",
  kind: SendErrorKind,
): void {
  const now = deps.clock.now();
  const updatedAt = now.toISOString();
  const retries =
    state === "failed" && RETRYABLE.has(kind) && now.getTime() < Date.parse(row.createdAt) + RETRY_WINDOW_MS;
  if (retries) {
    const sendAfter = new Date(now.getTime() + retryBackoffMs(row.attempts)).toISOString();
    if (deps.store.transitionOutbox(row.id, fromStates("wait"), "waiting", { errorKind: kind, sendAfter, updatedAt })) {
      publish(deps, row, "waiting");
    }
    return;
  }
  if (deps.store.transitionOutbox(row.id, ["sending"], state, { errorKind: kind, updatedAt })) {
    publish(deps, row, state);
  }
}

/**
 * Slice 3j: the account's server answered again (an ok sync round), so its
 * waiting sends are due now, a few seconds apart. Returns how many.
 */
export function hastenWaiting(deps: Pick<OutboxDeps, "store" | "clock">, accountId: string): number {
  const now = deps.clock.now().getTime();
  let hastened = 0;
  let slot = 0;
  for (const row of deps.store.listOutbox(accountId)) {
    if (row.state !== "waiting") continue;
    // Every waiting row takes a slot, so a second call moves nothing.
    const sendAfter = new Date(now + slot++ * RETRY_STAGGER_MS).toISOString();
    if (Date.parse(row.sendAfter) <= Date.parse(sendAfter)) continue;
    if (deps.store.transitionOutbox(row.id, fromStates("hasten"), "waiting", { sendAfter })) hastened++;
  }
  return hastened;
}

function requeue(
  deps: Pick<QueueDeps, "store" | "notifier" | "clock" | "rate">,
  id: string,
  event: "send_now" | "retry" | "resend",
): { ok: true } {
  const row = deps.store.getOutbox(id);
  if (row === null) throw new ComposeError("not_found");
  if (!canTransition(row.state, event)) throw new ComposeError("conflict");
  // Every path that leads to SMTP shares the one per-account cap (resolution 1).
  if (!deps.rate.take(row.accountId)) throw new ComposeError("rate_limited");
  const now = deps.clock.now();
  const moved = deps.store.transitionOutbox(id, fromStates(event), "queued", {
    errorKind: null,
    rejected: [],
    sendAfter: new Date(now.getTime() + UNDO_MS).toISOString(),
    updatedAt: now.toISOString(),
  });
  if (!moved) throw new ComposeError("conflict");
  publish(deps, row, "queued");
  return { ok: true };
}

function publish(deps: { notifier: OutboxNotifier }, row: OutboxRecord, state: OutboxState): void {
  deps.notifier.outboxChanged({ accountId: row.accountId, id: row.id, state });
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key) || !parseAddress(address).ok) return false;
    seen.add(key);
    return true;
  });
}
