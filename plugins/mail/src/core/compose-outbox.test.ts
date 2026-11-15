import { beforeEach, describe, expect, it } from "vitest";
import { ComposeError, addComposeAttachment, newCompose, saveCompose } from "./compose.ts";
import {
  APPEND_ATTEMPTS,
  APPEND_BACKOFF_MS,
  SEND_RATE_PER_MINUTE,
  SendRateLimit,
  UNDO_MS,
  UNDONE_TTL_MS,
  UndoneSends,
  canTransition,
  cancelSend,
  classifySendError,
  dismissOutbox,
  nextOutboxState,
  outboxErrorText,
  queueSend,
  resendUnknown,
  retrySend,
  runOutboxOnce,
  sendNow,
  settleGmailUnknown,
} from "./compose-outbox.ts";
import type { SendErrorKind } from "./model.ts";
import { SendError } from "./ports.ts";
import { composeHarness, imapError, makeFetchedMessage } from "./testing/fakes.ts";

let h: ReturnType<typeof composeHarness>;
let rate: SendRateLimit;
let deps: ReturnType<typeof composeHarness>["deps"] & { rate: SendRateLimit; undone: UndoneSends };
const signal = new AbortController().signal;

beforeEach(() => {
  h = composeHarness();
  rate = new SendRateLimit(h.clock);
  deps = { ...h.deps, rate, undone: new UndoneSends(h.clock) };
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
let requests = 0;
const requestId = () => `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`;

/** A saved draft ready to send: To bob, Bcc hidden. */
async function readyDraft(overrides: { to?: string[]; bcc?: string[] } = {}): Promise<{ draftId: string; baseRevision: number }> {
  const { draftId } = newCompose(h.deps, "acc_1");
  const saved = await saveCompose(h.deps, {
    draftId,
    baseRevision: 1,
    accountId: "acc_1",
    to: overrides.to ?? ["Bob <bob@example.com>"],
    cc: [],
    bcc: overrides.bcc ?? ["hidden@example.net"],
    subject: "Invented plan",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
  });
  if ("conflict" in saved) throw new Error("conflict");
  return { draftId, baseRevision: saved.revision };
}

async function queued(id = requestId()) {
  const draft = await readyDraft();
  const result = await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
  return { ...draft, id, result };
}

/** Runs the worker until it has nothing to do. */
async function drain(): Promise<void> {
  while (await runOutboxOnce(h.deps, signal)) {
    // keep going
  }
}

const states = () => h.notifier.events.map((e) => e.state);

describe("queueSend", () => {
  it("queues one row for the same requestId sent twice, building the MIME once", async () => {
    const draft = await readyDraft();
    const id = requestId();
    const first = await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    const second = await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    expect(second).toEqual(first);
    expect(first).toEqual({ outboxId: id, sendAfter: new Date(Date.parse("2026-11-15T10:00:00.000Z") + UNDO_MS).toISOString() });
    expect(h.store.listOutbox(null)).toHaveLength(1);
    expect(h.builder.built).toHaveLength(1);
    expect(h.notifier.events).toEqual([{ accountId: "acc_1", id, state: "queued" }]);
  });

  it("refuses a second send of a draft already queued", async () => {
    const { draftId, baseRevision } = await queued();
    await expect(queueSend(deps, { draftId, baseRevision, requestId: requestId(), origin: "owner" })).rejects.toThrow(
      "This draft changed in another window",
    );
  });

  it("builds without Bcc, stores the Bcc line and sends to every recipient", async () => {
    const { id } = await queued();
    expect(h.builder.built[0]!.bcc).toEqual([{ name: null, address: "hidden@example.net" }]);
    const payload = h.store.outboxPayload(id)!;
    expect(text(payload.mime)).not.toMatch(/^Bcc:/im);
    expect(payload.bccHeader).toBe("Bcc: hidden@example.net\r\n");
    expect(h.store.getOutbox(id)!.envelopeTo).toEqual(["bob@example.com", "hidden@example.net"]);
    expect(h.store.getOutbox(id)!.envelopeFrom).toBe("owner@example.org");
  });

  it("refuses without recipients, with an invalid chip, without SMTP and on a stale revision", async () => {
    const none = await readyDraft({ to: [], bcc: [] });
    await expect(queueSend(deps, { ...none, requestId: requestId(), origin: "owner" })).rejects.toThrow(ComposeError);
    const bad = await readyDraft({ to: ["bob@example.com", "not an address"] });
    await expect(queueSend(deps, { ...bad, requestId: requestId(), origin: "owner" })).rejects.toMatchObject({ kind: "invalid" });
    const stale = await readyDraft();
    await expect(
      queueSend(deps, { draftId: stale.draftId, baseRevision: stale.baseRevision - 1, requestId: requestId(), origin: "owner" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    h.store.saveAccount({ ...h.store.getAccount("acc_1")!, smtp: null });
    const ok = await readyDraft();
    await expect(queueSend(deps, { ...ok, requestId: requestId(), origin: "owner" })).rejects.toMatchObject({ kind: "smtp_missing" });
    expect(h.store.listOutbox(null)).toEqual([]);
  });

  it("refuses with conflict when the From it would use is not the expected one", async () => {
    const draft = await readyDraft();
    await expect(
      queueSend(deps, { ...draft, requestId: requestId(), origin: "agent", expectFrom: { name: "Someone Else", address: "owner@example.org" } }),
    ).rejects.toMatchObject({ kind: "conflict" });
    const name = h.store.getAccount("acc_1")!.displayName?.trim() || null;
    await expect(
      queueSend(deps, { ...draft, requestId: requestId(), origin: "agent", expectFrom: { name, address: "other@example.org" } }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(h.store.listOutbox(null)).toEqual([]);
    await expect(
      queueSend(deps, { ...draft, requestId: requestId(), origin: "agent", expectFrom: { name, address: "Owner@Example.org" } }),
    ).resolves.toMatchObject({ outboxId: expect.any(String) });
  });

  it("refuses the 11th send in a minute, and allows it once the minute has passed", async () => {
    for (let i = 0; i < SEND_RATE_PER_MINUTE; i++) await queued();
    const extra = await readyDraft();
    await expect(queueSend(deps, { ...extra, requestId: requestId(), origin: "owner" })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    h.advance(60_000);
    await queueSend(deps, { ...extra, requestId: requestId(), origin: "owner" });
    expect(h.store.listOutbox(null)).toHaveLength(SEND_RATE_PER_MINUTE + 1);
  });

  it("Retry, Send again and Send now count against the same cap; Retry copy does not", async () => {
    const failed = await queued();
    const unknown = await queued();
    const held = await queued();
    const noCopy = await queued();
    h.store.transitionOutbox(failed.id, ["queued"], "failed", { errorKind: "auth" });
    h.store.transitionOutbox(unknown.id, ["queued"], "unknown", { errorKind: "unknown_after_data" });
    h.store.transitionOutbox(held.id, ["queued"], "held");
    h.store.transitionOutbox(noCopy.id, ["queued"], "sent_no_copy", { errorKind: "append_failed" });
    for (let i = 4; i < SEND_RATE_PER_MINUTE; i++) expect(rate.take("acc_1")).toBe(true);
    expect(() => retrySend(deps, failed.id)).toThrow(expect.objectContaining({ kind: "rate_limited" }));
    expect(() => resendUnknown(deps, unknown.id)).toThrow(expect.objectContaining({ kind: "rate_limited" }));
    expect(() => sendNow(deps, held.id)).toThrow(expect.objectContaining({ kind: "rate_limited" }));
    expect(retrySend(deps, noCopy.id)).toEqual({ ok: true });
    expect([failed, unknown, held].map((r) => h.store.getOutbox(r.id)!.state)).toEqual(["failed", "unknown", "held"]);
    h.advance(60_000);
    retrySend(deps, failed.id);
    resendUnknown(deps, unknown.id);
    sendNow(deps, held.id);
    expect([failed, unknown, held].map((r) => h.store.getOutbox(r.id)!.state)).toEqual(["queued", "queued", "queued"]);
  });

  it("a refused Retry does not use up the cap", async () => {
    const { id } = await queued();
    for (let i = 1; i < SEND_RATE_PER_MINUTE; i++) expect(rate.take("acc_1")).toBe(true);
    h.advance(60_000);
    expect(() => retrySend(deps, id)).toThrow(expect.objectContaining({ kind: "conflict" }));
    expect(() => sendNow(deps, id)).toThrow(expect.objectContaining({ kind: "conflict" }));
    for (let i = 0; i < SEND_RATE_PER_MINUTE; i++) expect(rate.take("acc_1")).toBe(true);
  });

  it("a queued draft cannot be saved over (conflict) until the send settles", async () => {
    const { draftId, baseRevision } = await queued();
    const result = await saveCompose(h.deps, {
      draftId,
      baseRevision,
      accountId: "acc_1",
      to: [],
      cc: [],
      bcc: [],
      subject: "Changed",
      doc: { type: "doc", content: [] },
    });
    expect(result).toEqual({ conflict: true, revision: baseRevision });
    expect(() =>
      addComposeAttachment(h.store, draftId, { fileName: "a", mimeType: "text/plain", size: 0, sha256: "0".repeat(64), data: new Uint8Array() }),
    ).toThrow(ComposeError);
  });
});

describe("Undo", () => {
  it("before the tick deletes the row, sends nothing and leaves the draft exactly as it was", async () => {
    const draft = await readyDraft();
    addComposeAttachment(h.store, draft.draftId, { fileName: "a.txt", mimeType: "text/plain", size: 2, sha256: "1".repeat(64), data: new Uint8Array([4, 5]) });
    const before = { draft: h.store.getDraft(draft.draftId), files: h.store.attachmentData(draft.draftId) };
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    expect(cancelSend(deps, id)).toEqual({ cancelled: true, draftId: draft.draftId });
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toEqual([]);
    expect(h.store.listOutbox(null)).toEqual([]);
    expect({ draft: h.store.getDraft(draft.draftId), files: h.store.attachmentData(draft.draftId) }).toEqual(before);
    expect(states()).toEqual(["queued", "cancelled"]);
  });

  /** Keeps the account's write queue busy (a sync round, an APPEND) until released. */
  function busyQueue(): () => void {
    let released = false;
    let resolveTask: (() => void) | null = null;
    void h.queue.run("acc_1", () => new Promise<void>((resolve) => (released ? resolve() : (resolveTask = resolve))));
    return () => {
      released = true;
      resolveTask?.();
    };
  }

  it("a late duplicate of an undone send (same requestId) is refused, never queued again", async () => {
    const draft = await readyDraft();
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    expect(cancelSend(deps, id).cancelled).toBe(true);
    await expect(queueSend(deps, { ...draft, requestId: id, origin: "owner" })).rejects.toMatchObject({
      kind: "undone",
      message: "This send was undone",
    });
    expect(h.store.listOutbox(null)).toEqual([]);
    // A new Send of the same draft is a new request id and goes through.
    await queueSend(deps, { ...draft, requestId: requestId(), origin: "owner" });
    expect(h.store.listOutbox(null)).toHaveLength(1);
  });

  it("forgets an undone request id after its time to live", () => {
    const undone = new UndoneSends(h.clock);
    undone.add("a");
    h.advance(UNDONE_TTL_MS - 1);
    expect(undone.has("a")).toBe(true);
    h.advance(1);
    expect(undone.has("a")).toBe(false);
  });

  it("still works while the send waits behind another write of the account", async () => {
    const { id, draftId } = await queued();
    h.advance(UNDO_MS);
    const release = busyQueue();
    const running = runOutboxOnce(h.deps, signal);
    await Promise.resolve();
    expect(h.store.getOutbox(id)!.state).toBe("queued");
    expect(cancelSend(deps, id)).toEqual({ cancelled: true, draftId });
    release();
    await running;
    await drain();
    expect(h.transport.sent).toEqual([]);
    expect(h.store.getDraft(draftId)).not.toBeNull();
    expect(states()).toEqual(["queued", "cancelled"]);
  });

  it("an abort while the send waits leaves the row queued and opens no SMTP", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    const release = busyQueue();
    const controller = new AbortController();
    const running = runOutboxOnce(h.deps, controller.signal);
    controller.abort();
    release();
    await running;
    expect(h.transport.sent).toEqual([]);
    expect(h.store.getOutbox(id)!.state).toBe("queued");
    expect(states()).toEqual(["queued"]);
  });

  it("is too late once the worker has claimed the row", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    const gate = h.transport.gateSend();
    const running = runOutboxOnce(h.deps, signal);
    await gate.entered;
    expect(cancelSend(deps, id)).toEqual({ cancelled: false, draftId: expect.any(String) });
    gate.release();
    await running;
    await drain();
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.getOutbox(id)).toBeNull();
  });
});

describe("runOutboxOnce", () => {
  it("waits for the Undo window, then sends once, copies to Sent with the Bcc line and completes", async () => {
    const { id, draftId } = await queued();
    expect(await runOutboxOnce(h.deps, signal)).toBe(false);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(1);
    const smtp = h.transport.sent[0]!;
    expect(smtp.config).toEqual({
      host: "smtp.example.org",
      port: 465,
      security: "tls",
      username: "owner@example.org",
      password: "invented-password",
    });
    expect(text(smtp.raw)).not.toContain("Bcc:");
    expect(smtp.raw).toEqual(h.store.outboxPayload(id) ?? smtp.raw);
    expect(h.gateway.appended).toHaveLength(1);
    const copy = h.gateway.appended[0]!;
    expect(copy.path).toBe("Sent");
    expect(copy.flags).toEqual(["\\Seen"]);
    expect(text(copy.raw)).toBe(text(smtp.raw).replace("\r\n\r\n", "\r\nBcc: hidden@example.net\r\n\r\n"));
    expect(h.store.getOutbox(id)).toBeNull();
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(states()).toEqual(["queued", "sending", "sent", "appending", "done"]);
    expect(h.notifier.events.every((e) => Object.keys(e).sort().join() === "accountId,id,state")).toBe(true);
  });

  it("two workers racing cannot both send a row", async () => {
    await queued();
    h.advance(UNDO_MS);
    const results = await Promise.all([runOutboxOnce(h.deps, signal), runOutboxOnce(h.deps, signal)]);
    await drain();
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(h.transport.sent).toHaveLength(1);
  });

  it("an aborted worker takes no row", async () => {
    await queued();
    h.advance(UNDO_MS);
    const controller = new AbortController();
    controller.abort();
    expect(await runOutboxOnce(h.deps, controller.signal)).toBe(false);
    expect(h.store.listOutbox(null)[0]!.state).toBe("queued");
  });

  it("removes the draft's server copy after the send", async () => {
    const { draftId } = await readyDraft();
    await saveCompose(h.deps, {
      draftId,
      baseRevision: 2,
      accountId: "acc_1",
      to: ["bob@example.com"],
      cc: [],
      bcc: [],
      subject: "Invented",
      doc: { type: "doc", content: [] },
      saveToServer: true,
    });
    const draftUid = h.gateway.appended[0]!.uid;
    await queueSend(deps, { draftId, baseRevision: 3, requestId: requestId(), origin: "owner" });
    h.advance(UNDO_MS);
    await drain();
    expect(h.gateway.expunged).toEqual([{ path: "Drafts", uid: draftUid }]);
    expect(h.drafts.messages).toEqual([]);
  });

  it("a server-kept Sent copy (Gmail) is done without an APPEND", async () => {
    h.store.saveAccount({ ...h.store.getAccount("acc_1")!, sentCopy: "server" });
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(h.gateway.appended).toEqual([]);
    expect(h.store.getOutbox(id)).toBeNull();
    expect(states()).toEqual(["queued", "sending", "sent", "done"]);
  });

  it("partly refused recipients: sent, with the refused ones kept", async () => {
    h.transport.answer({ accepted: ["bob@example.com"], rejected: ["hidden@example.net"] });
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.gateway.failAlways("appendMessage", imapError("AppendFailed"));
    await drain();
    expect(h.store.getOutbox(id)).toMatchObject({ state: "sent_no_copy", rejected: ["hidden@example.net"] });
  });
});

describe("failure matrix", () => {
  const cases: [string, Error, "failed" | "unknown", SendErrorKind][] = [
    ["DNS / connect", new SendError("connect", false), "failed", "connect"],
    ["TLS", new SendError("tls", false), "failed", "tls"],
    ["AUTH refused", new SendError("auth", false), "failed", "auth"],
    ["size refused", new SendError("too_large", false), "failed", "too_large"],
    ["all recipients refused", new SendError("rejected_all", false), "failed", "rejected_all"],
    ["timeout before DATA", new SendError("timeout_before_data", false), "failed", "timeout_before_data"],
    ["4xx at any stage", new SendError("temporary", true), "failed", "temporary"],
    ["5xx after DATA", new SendError("rejected_message", true), "failed", "rejected_message"],
    ["no reply after DATA", new SendError("unknown_after_data", true), "unknown", "unknown_after_data"],
    ["a before-DATA kind claimed after DATA", new SendError("connect", true), "unknown", "unknown_after_data"],
    ["an unclassified error", new Error("socket gone"), "unknown", "unknown_after_data"],
  ];

  for (const [situation, error, state, kind] of cases) {
    it(`${situation} → ${state} (${kind})`, async () => {
      h.transport.answer(error);
      const { id } = await queued();
      h.advance(UNDO_MS);
      await drain();
      expect(h.store.getOutbox(id)).toMatchObject({ state, errorKind: kind, attempts: 1 });
      expect(h.transport.sent).toHaveLength(1);
      expect(classifySendError(error)).toEqual({ state, kind });
    });
  }

  it("no recipient accepted is a failure", async () => {
    h.transport.answer({ accepted: [], rejected: ["bob@example.com"] });
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(h.store.getOutbox(id)).toMatchObject({ state: "failed", errorKind: "rejected_all" });
  });

  it("Retry is refused for unknown; Send again requeues it with a fresh Undo window", async () => {
    h.transport.answer(new SendError("unknown_after_data", true));
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(() => retrySend(deps, id)).toThrow(ComposeError);
    expect(resendUnknown(deps, id)).toEqual({ ok: true });
    expect(h.store.getOutbox(id)).toMatchObject({ state: "queued", errorKind: null });
    expect(await runOutboxOnce(h.deps, signal)).toBe(false);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(2);
    expect(h.transport.sent[1]!.raw).toEqual(h.transport.sent[0]!.raw);
  });

  it("Retry after a failure before DATA sends again", async () => {
    h.transport.answer(new SendError("connect", false));
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(() => resendUnknown(deps, id)).toThrow(ComposeError);
    retrySend(deps, id);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(2);
    expect(h.store.getOutbox(id)).toBeNull();
  });

  it("Edit from a failure removes the row and hands back the draft, editable and unchanged", async () => {
    h.transport.answer(new SendError("too_large", true));
    const { id, draftId, baseRevision } = await queued();
    h.advance(UNDO_MS);
    await drain();
    const before = h.store.getDraft(draftId);
    expect(cancelSend(deps, id)).toEqual({ cancelled: true, draftId });
    expect(h.store.getOutbox(id)).toBeNull();
    expect(h.store.getDraft(draftId)).toEqual(before);
    expect(states().at(-1)).toBe("cancelled");
    const saved = await saveCompose(h.deps, {
      draftId,
      baseRevision,
      accountId: "acc_1",
      to: ["Bob <bob@example.com>"],
      cc: [],
      bcc: [],
      subject: "Smaller",
      doc: { type: "doc", content: [] },
    });
    expect(saved).toMatchObject({ revision: baseRevision + 1 });
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(1);
  });

  it("Discard from a failure removes the row and its draft", async () => {
    h.transport.answer(new SendError("rejected_all", false));
    const { id, draftId } = await queued();
    h.advance(UNDO_MS);
    await drain();
    await dismissOutbox(h.deps, id);
    expect(h.store.getOutbox(id)).toBeNull();
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(states().at(-1)).toBe("cancelled");
  });

  it("Dismiss removes an unknown row and its draft, reopening nothing", async () => {
    h.transport.answer(new SendError("unknown_after_data", true));
    const { id, draftId } = await queued();
    h.advance(UNDO_MS);
    await drain();
    await dismissOutbox(h.deps, id);
    expect(h.store.getOutbox(id)).toBeNull();
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(states().at(-1)).toBe("cancelled");
  });
});

describe("restart", () => {
  it("sending becomes unknown with no transport call; overdue queued becomes held", async () => {
    const sending = await queued();
    h.advance(UNDO_MS);
    expect(h.store.claimDueOutbox(h.clock.now().toISOString(), [])?.id).toBe(sending.id);
    const late = await queued();
    h.advance(UNDO_MS);
    const fresh = await queued();
    expect(h.store.recoverOutboxOnStart(h.clock.now().toISOString())).toEqual({ unknown: 1, held: 1 });
    expect(h.store.getOutbox(sending.id)!.state).toBe("unknown");
    expect(h.store.getOutbox(late.id)!.state).toBe("held");
    expect(h.store.getOutbox(fresh.id)!.state).toBe("queued");
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(1); // only the fresh row
    expect(h.store.getOutbox(late.id)!.state).toBe("held");
  });

  it("a held row waits for Send now, which gives it a fresh Undo window", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.store.recoverOutboxOnStart(h.clock.now().toISOString());
    expect(() => retrySend(deps, id)).toThrow(ComposeError);
    sendNow(deps, id);
    expect(await runOutboxOnce(h.deps, signal)).toBe(false);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent).toHaveLength(1);
    expect(() => sendNow(deps, id)).toThrow(ComposeError);
  });

  it("a reload overlap: the old worker's accepted send is recorded sent even after recovery marked it unknown", async () => {
    const { id, draftId } = await queued();
    h.advance(UNDO_MS);
    const gate = h.transport.gateSend();
    const running = runOutboxOnce(h.deps, signal);
    await gate.entered;
    // The new worker starts while the old one is still in SMTP.
    expect(h.store.recoverOutboxOnStart(h.clock.now().toISOString())).toEqual({ unknown: 1, held: 0 });
    expect(h.store.getOutbox(id)!.state).toBe("unknown");
    gate.release();
    await running;
    await drain();
    expect(h.transport.sent).toHaveLength(1);
    expect(h.gateway.appended).toHaveLength(1);
    expect(h.store.getOutbox(id)).toBeNull();
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(states().slice(-3)).toEqual(["sent", "appending", "done"]);
  });

  it("a send accepted before the restart resumes at the copy step without sending again", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.store.claimDueOutbox(h.clock.now().toISOString(), []);
    h.store.transitionOutbox(id, ["sending"], "sent", {});
    await drain();
    expect(h.transport.sent).toEqual([]);
    expect(h.gateway.appended).toHaveLength(1);
    expect(h.store.getOutbox(id)).toBeNull();
  });
});

describe("Sent copy", () => {
  it("searches Sent first and does not append a copy that is already there", async () => {
    const { id, draftId } = await queued();
    const messageId = h.store.getDraft(draftId)!.messageId;
    h.sent.messages.push(makeFetchedMessage(1, { messageId: messageId.slice(1, -1) }));
    h.sent.uidNext = 2;
    h.advance(UNDO_MS);
    await drain();
    expect(h.gateway.appended).toEqual([]);
    expect(h.store.getOutbox(id)).toBeNull();
  });

  it(`gives up after ${APPEND_ATTEMPTS} failed tries; Retry copy runs the step again`, async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.gateway.failAlways("appendMessage", imapError("AppendFailed"));
    await drain();
    const appendCalls = h.gateway.sessions.flatMap((s) => s.calls).filter((c) => c.method === "appendMessage");
    const searches = h.gateway.sessions.flatMap((s) => s.calls).filter((c) => c.method === "findByMessageId");
    expect(appendCalls).toHaveLength(APPEND_ATTEMPTS);
    expect(searches).toHaveLength(APPEND_ATTEMPTS);
    // Backoff between tries, outside the account's write queue.
    expect(h.sleeps).toEqual(APPEND_BACKOFF_MS.slice(0, APPEND_ATTEMPTS - 1));
    expect(APPEND_BACKOFF_MS.slice(0, 2)).toEqual([1_000, 4_000]);
    expect(h.store.getOutbox(id)).toMatchObject({ state: "sent_no_copy", errorKind: "append_failed" });
    h.gateway.clearFailure("appendMessage");
    retrySend(deps, id);
    await drain();
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.getOutbox(id)).toBeNull();
  });

  it("a second try that lands after a backoff completes the send", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.gateway.failNext("appendMessage", imapError("AppendFailed"));
    await drain();
    expect(h.sleeps).toEqual([1_000]);
    expect(h.gateway.appended).toHaveLength(1);
    expect(h.store.getOutbox(id)).toBeNull();
  });

  it("an abort during the backoff stops retrying and leaves the row for recovery, not sent_no_copy", async () => {
    const { id } = await queued();
    h.advance(UNDO_MS);
    h.gateway.failAlways("appendMessage", imapError("AppendFailed"));
    const controller = new AbortController();
    h.onSleep = () => controller.abort();
    await runOutboxOnce(h.deps, controller.signal);
    expect(h.sleeps).toEqual([1_000]);
    expect(h.store.getOutbox(id)!.state).toBe("appending");
    expect(h.store.recoverOutboxOnStart(h.clock.now().toISOString())).toEqual({ unknown: 0, held: 0 });
    expect(h.store.getOutbox(id)!.state).toBe("sent");
  });

  it("without a Sent folder ends sent_no_copy, and Dismiss clears it", async () => {
    h.store.saveFolders("acc_1", h.gateway.folders.filter((f) => f.path !== "Sent"));
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(h.store.getOutbox(id)).toMatchObject({ state: "sent_no_copy", errorKind: "no_sent_folder" });
    await dismissOutbox(h.deps, id);
    expect(h.store.getOutbox(id)).toBeNull();
    expect(states().at(-1)).toBe("done");
  });
});

describe("settleGmailUnknown", () => {
  it("an unknown Gmail send found in Sent by Message-ID is done; one not found stays unknown", async () => {
    h.store.saveAccount({ ...h.store.getAccount("acc_1")!, sentCopy: "server" });
    h.transport.answer(new SendError("unknown_after_data", true), new SendError("unknown_after_data", true));
    const found = await queued();
    const missing = await queued();
    h.advance(UNDO_MS);
    await drain();
    const messageId = h.store.getOutbox(found.id)!.messageId;
    h.sent.messages.push(makeFetchedMessage(1, { messageId: messageId.slice(1, -1) }));
    expect(await settleGmailUnknown(h.deps)).toBe(1);
    expect(h.store.getOutbox(found.id)).toBeNull();
    expect(h.store.getOutbox(missing.id)!.state).toBe("unknown");
    expect(h.gateway.appended).toEqual([]);
  });

  it("leaves APPEND accounts alone: their Sent folder proves nothing", async () => {
    h.transport.answer(new SendError("unknown_after_data", true));
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(await settleGmailUnknown(h.deps)).toBe(0);
    expect(h.store.getOutbox(id)!.state).toBe("unknown");
  });
});

describe("state table", () => {
  it("allows exactly the documented moves", () => {
    expect(nextOutboxState("queued", "claim")).toBe("sending");
    expect(canTransition("held", "claim")).toBe(false);
    expect(canTransition("sending", "undo")).toBe(false);
    expect(nextOutboxState("held", "undo")).toBe("deleted");
    expect(canTransition("unknown", "retry")).toBe(false);
    expect(nextOutboxState("unknown", "resend")).toBe("queued");
    expect(nextOutboxState("sent_no_copy", "retry")).toBe("sent");
    expect(nextOutboxState("sending", "recover")).toBe("unknown");
    expect(nextOutboxState("failed", "undo")).toBe("deleted");
    expect(nextOutboxState("failed", "dismiss")).toBe("deleted");
    expect(canTransition("sending", "dismiss")).toBe(false);
    expect(canTransition("queued", "dismiss")).toBe(false);
    // SMTP accepted it: sent, also when a restart's recovery already called it unknown.
    expect(nextOutboxState("sending", "accepted")).toBe("sent");
    expect(nextOutboxState("unknown", "accepted")).toBe("sent");
    expect(canTransition("queued", "accepted")).toBe(false);
  });
});

// ---- Slice 3d: sending from an alias ----

describe("sending from an alias (slice 3d)", () => {
  const ALIAS = "alias@example.net";
  const T = "2026-11-15T09:00:00.000Z";

  async function aliasDraft(): Promise<{ draftId: string; baseRevision: number }> {
    h.store.upsertIdentity({ accountId: "acc_1", address: ALIAS, displayName: "Alias" }, T);
    const { draftId } = newCompose(h.deps, "acc_1", ALIAS);
    const saved = await saveCompose(h.deps, {
      draftId,
      baseRevision: 1,
      accountId: "acc_1",
      to: ["Bob <bob@example.com>"],
      cc: [],
      bcc: [],
      subject: "Invented plan",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
    });
    if ("conflict" in saved) throw new Error("conflict");
    return { draftId, baseRevision: saved.revision };
  }

  const alias = () => h.store.listIdentities("acc_1").find((row) => row.address === ALIAS)!;

  it("sends with the alias as header From and envelope sender, and marks the check accepted", async () => {
    const draft = await aliasDraft();
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    expect(h.store.getOutbox(id)!.envelopeFrom).toBe(ALIAS);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent[0]!.envelopeFrom).toBe(ALIAS);
    expect(text(h.transport.sent[0]!.raw)).toContain(`From: ${ALIAS}`);
    expect(alias()).toMatchObject({ sendCheck: "accepted" });
  });

  it("marks the check pending with the Message-ID when the server keeps the Sent copy", async () => {
    h.store.saveAccount({ ...h.store.getAccount("acc_1")!, sentCopy: "server" });
    const draft = await aliasDraft();
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    const messageId = h.store.getDraft(draft.draftId)!.messageId;
    h.advance(UNDO_MS);
    await drain();
    expect(alias()).toMatchObject({ sendCheck: "pending", checkMessageId: messageId });
  });

  it("leaves no check for a send from the own address", async () => {
    h.store.upsertIdentity({ accountId: "acc_1", address: ALIAS, displayName: null }, T);
    const { id } = await queued();
    h.advance(UNDO_MS);
    await drain();
    expect(h.store.getOutbox(id)).toBeNull();
    expect(alias()).toMatchObject({ sendCheck: "unknown" });
  });

  it("refuses a removed alias with from_unknown; a queued row keeps the alias", async () => {
    const draft = await aliasDraft();
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    h.store.removeIdentity("acc_1", ALIAS);
    h.advance(UNDO_MS);
    await drain();
    expect(h.transport.sent[0]!.envelopeFrom).toBe(ALIAS);

    h.store.upsertIdentity({ accountId: "acc_1", address: ALIAS, displayName: null }, T);
    const second = await aliasDraft();
    h.store.removeIdentity("acc_1", ALIAS);
    const refusal = await queueSend(deps, { ...second, requestId: requestId(), origin: "owner" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ComposeError);
    expect((refusal as ComposeError).kind).toBe("from_unknown");
  });

  it("a refusal at MAIL FROM from an alias is sender_refused and marks the check refused", async () => {
    h.transport.answer(new SendError("rejected_message", false, "MAIL FROM"));
    const draft = await aliasDraft();
    const id = requestId();
    await queueSend(deps, { ...draft, requestId: id, origin: "owner" });
    h.advance(UNDO_MS);
    await drain();
    expect(h.store.getOutbox(id)).toMatchObject({ state: "failed", errorKind: "sender_refused" });
    expect(alias()).toMatchObject({ sendCheck: "refused" });
  });

  it("decides sender_refused only for an alias From at MAIL FROM", () => {
    const account = { email: "Owner@example.org", username: "owner@example.org" };
    const fromAlias = { envelopeFrom: ALIAS };
    const fromOwn = { envelopeFrom: "owner@example.org" };
    const mailFrom = new SendError("rejected_message", false, "MAIL FROM");
    expect(classifySendError(mailFrom, fromAlias, account)).toEqual({ state: "failed", kind: "sender_refused" });
    expect(classifySendError(mailFrom, fromOwn, account)).toEqual({ state: "failed", kind: "rejected_message" });
    expect(classifySendError(mailFrom)).toEqual({ state: "failed", kind: "rejected_message" });
    // nodemailer's size refusal at MAIL FROM stays too_large.
    expect(classifySendError(new SendError("too_large", false, "MAIL FROM"), fromAlias, account)).toEqual({
      state: "failed",
      kind: "too_large",
    });
    expect(classifySendError(new SendError("rejected_message", false, "RCPT TO"), fromAlias, account)).toEqual({
      state: "failed",
      kind: "rejected_message",
    });
    expect(classifySendError(new SendError("rejected_message", true, "DATA"), fromAlias, account)).toEqual({
      state: "failed",
      kind: "rejected_message",
    });
  });

  it("records accepted envelope recipients so they count as sent to", async () => {
    h.transport.answer({ accepted: ["bob@example.com"], rejected: ["hidden@example.net"] });
    await queued();
    h.advance(UNDO_MS);
    await drain();
    expect([...h.store.addressesSentTo(["BOB@example.com", "hidden@example.net"])]).toEqual(["bob@example.com"]);
  });

  it("gives the Outbox texts for a refused alias and an unconfirmed one", () => {
    expect(outboxErrorText("sender_refused", ALIAS, "refused")).toBe(
      `The server refused to send from ${ALIAS}. Check that it is an alias of this account; then Edit and pick another From, or Retry.`,
    );
    expect(outboxErrorText("sender_refused", ALIAS, "refused", "iCloud")).toContain("alias of this account at iCloud;");
    expect(outboxErrorText("rejected_message", ALIAS, "unknown")).toBe(
      `If ${ALIAS} is not an alias of this account, the server may refuse it.`,
    );
    expect(outboxErrorText("rejected_message", ALIAS, "confirmed")).toBeNull();
    expect(outboxErrorText("rejected_message", ALIAS, "accepted")).toBeNull();
    expect(outboxErrorText("rejected_message", null, null)).toBeNull();
    expect(outboxErrorText("auth", ALIAS, "unknown")).toBeNull();
  });
});
