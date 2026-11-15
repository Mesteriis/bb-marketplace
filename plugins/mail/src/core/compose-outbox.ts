// The outbox: queueing a send, Undo / Edit, the owner's Retry / Send now /
// Send again / Dismiss, and one worker step. Sending is owner-initiated and never
// repeated automatically once DATA may have been accepted: a claim moves a
// row queued → sending by compare-and-swap inside the account's write queue,
// immediately before SMTP is opened, a restart
// turns `sending` into `unknown`, and the only automatic retry is the
// idempotent Sent-copy APPEND (search by Message-ID first, 3 tries).
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
import type { OutboxRecord, OutboxState, SendErrorKind, StoredAccount } from "./model.ts";
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
/** How long after a send became unknown a Gmail account's Sent folder is searched for it. */
export const SETTLE_WINDOW_MS = 5 * 60_000;

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
  | "settle";

type Target = OutboxState | "deleted";

/** The state table. Every store transition is a compare-and-swap over these `from` states. */
const TRANSITIONS: Record<OutboxEvent, Partial<Record<OutboxState, Target>>> = {
  claim: { queued: "sending" },
  undo: { queued: "deleted", held: "deleted", failed: "deleted" },
  send_now: { held: "queued" },
  accepted: { sending: "sent" },
  failed: { sending: "failed" },
  lost: { sending: "unknown" },
  copy: { sent: "appending" },
  copied: { sent: "done", appending: "done" },
  copy_failed: { appending: "sent_no_copy" },
  retry: { failed: "queued", sent_no_copy: "sent" },
  resend: { unknown: "queued" },
  dismiss: { unknown: "deleted", sent_no_copy: "deleted", failed: "deleted" },
  recover: { sending: "unknown", queued: "held", appending: "sent" },
  settle: { unknown: "sent" },
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

export type QueueDeps = ComposeDeps & { notifier: OutboxNotifier; rate: SendRateLimit };
export type OutboxDeps = ComposeDeps & { notifier: OutboxNotifier; transport: MailTransport };

/**
 * Queues the saved draft. The requestId is the row id: the same id again
 * returns the row already queued (a double click or a retried RPC cannot
 * send twice). Validates at least one recipient, every chip, the
 * recipient count, the size cap, SMTP and the rate cap; builds the MIME
 * once (no Bcc) and stores the Bcc line for the Sent copy. The cap is
 * shared with Retry, Send again and Send now.
 */
export async function queueSend(
  deps: QueueDeps,
  input: { draftId: string; baseRevision: number; requestId: string; origin: "owner" },
): Promise<{ outboxId: string; sendAfter: string }> {
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
  const envelopeTo = uniqueAddresses([...message.to, ...message.cc, ...message.bcc].map((a) => a.address));
  if (envelopeTo.length === 0 || envelopeTo.length > MAX_RECIPIENTS) throw new ComposeError("invalid");
  const attached = message.attachments.reduce((sum, a) => sum + a.bytes.length, 0);
  if (attached > ATTACHMENT_CAP_BYTES) throw new ComposeError("too_large");
  if (!deps.rate.take(account.id)) throw new ComposeError("rate_limited");

  const mime = await deps.builder.build(message);
  const now = deps.clock.now();
  const queued = deps.store.queueOutbox(
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
  if ("conflict" in queued) throw new ComposeError("conflict");
  if (queued.created) publish(deps, queued.row, "queued");
  return { outboxId: queued.row.id, sendAfter: queued.row.sendAfter };
}

/**
 * Undo (queued) or Edit (held, failed): deletes the row; the draft stays,
 * unchanged, and can be saved and sent again.
 */
export function cancelSend(
  deps: Pick<QueueDeps, "store" | "notifier">,
  id: string,
): { cancelled: boolean; draftId: string | null } {
  const row = deps.store.getOutbox(id);
  if (row === null) return { cancelled: false, draftId: null };
  if (!deps.store.deleteOutbox(id, fromStates("undo"))) return { cancelled: false, draftId: row.draftId };
  deps.notifier.outboxChanged({ accountId: row.accountId, id, state: "cancelled" });
  return { cancelled: true, draftId: row.draftId };
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
    await copyStep(deps, pendingCopy);
    return true;
  }
  const due = deps.store.nextDueOutbox(deps.clock.now().toISOString(), []);
  if (due === null) return false;

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
        return { state: "failed", row: claimed, kind: account?.smtp === null ? "connect" : "auth" };
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
        return { row: claimed, ...classifySendError(error) };
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
    if (deps.store.transitionOutbox(claimed.id, ["sending"], "sent", { rejected: outcome.rejected, updatedAt })) {
      publish(deps, claimed, "sent");
      const row = deps.store.getOutbox(claimed.id);
      if (row !== null) await copyStep(deps, row);
    }
  } else {
    settle(deps, claimed, outcome.state, outcome.kind);
  }
  return true;
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
 * a 5xx after DATA, a 4xx, or anything before DATA is `failed`.
 */
export function classifySendError(error: unknown): { state: "failed" | "unknown"; kind: SendErrorKind } {
  if (!(error instanceof SendError)) return { state: "unknown", kind: "unknown_after_data" };
  if (error.kind === "unknown_after_data") return { state: "unknown", kind: "unknown_after_data" };
  if (error.afterData && !AFTER_DATA_FAILURES.has(error.kind)) {
    return { state: "unknown", kind: "unknown_after_data" };
  }
  return { state: "failed", kind: error.kind };
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

/** The Sent-copy step of a `sent` row: done for `server` accounts, else search-then-APPEND. */
async function copyStep(deps: OutboxDeps, row: OutboxRecord): Promise<void> {
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
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
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
  const updatedAt = deps.clock.now().toISOString();
  if (deps.store.transitionOutbox(row.id, ["sending"], state, { errorKind: kind, updatedAt })) {
    publish(deps, row, state);
  }
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
