import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SendRateLimit,
  UndoneSends,
  UNDO_MS,
  newCompose,
  queueSend,
  saveCompose,
  type SmtpConfig,
} from "../../core/index.ts";
import { composeHarness } from "../../core/testing/fakes.ts";
import { SERVER_COPY_IDLE_MS } from "../../core/compose-drafts.ts";
import { createOutboxWorker, type OutboxWorkerDeps } from "./outbox-worker.ts";

let h: ReturnType<typeof composeHarness>;
let requests = 0;
const requestId = () => `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`;

beforeEach(() => {
  h = composeHarness();
});

async function readyDraft(): Promise<{ draftId: string; baseRevision: number }> {
  const { draftId } = newCompose(h.deps, "acc_1");
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

async function queued(): Promise<string> {
  const draft = await readyDraft();
  const { outboxId } = await queueSend(
    { ...h.deps, rate: new SendRateLimit(h.clock), undone: new UndoneSends(h.clock) },
    { ...draft, requestId: requestId(), origin: "owner" },
  );
  return outboxId;
}

function worker(overrides: Partial<OutboxWorkerDeps> = {}, options = { intervalMs: 5, drainMs: 50 }) {
  const lines: string[] = [];
  const deps: OutboxWorkerDeps = { ...h.deps, isReady: () => true, log: (l) => lines.push(l), ...overrides };
  return { worker: createOutboxWorker(deps, options), lines };
}

const state = (id: string) => h.store.getOutbox(id)?.state ?? "gone";

describe("createOutboxWorker", () => {
  it("recovers before any work: a sending row becomes unknown and is never sent", async () => {
    const id = await queued();
    h.advance(UNDO_MS);
    h.store.claimDueOutbox(h.clock.now().toISOString(), []);
    expect(state(id)).toBe("sending");
    const { worker: w, lines } = worker();
    const controller = new AbortController();
    const running = w.start(controller.signal);
    await vi.waitFor(() => expect(state(id)).toBe("unknown"));
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await running;
    expect(h.transport.sent).toEqual([]);
    expect(lines).toContain("outbox: recovered 1 unknown, 0 held");
  });

  it("an overdue queued row is held and waits", async () => {
    const id = await queued();
    h.advance(UNDO_MS + 1);
    const controller = new AbortController();
    const running = worker().worker.start(controller.signal);
    await vi.waitFor(() => expect(state(id)).toBe("held"));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.transport.sent).toEqual([]);
    controller.abort();
    await running;
  });

  it("sends a due row after its Undo window, once", async () => {
    const controller = new AbortController();
    const { worker: w } = worker();
    const running = w.start(controller.signal);
    const id = await queued();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.transport.sent).toEqual([]);
    h.advance(UNDO_MS);
    w.wake("acc_1");
    await vi.waitFor(() => expect(state(id)).toBe("gone"));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.transport.sent).toHaveLength(1);
    expect(h.notifier.events.map((e) => e.state)).toEqual(["queued", "sending", "sent", "appending", "done"]);
    controller.abort();
    await running;
  });

  it("does nothing while the vault is not ready", async () => {
    const id = await queued();
    h.advance(UNDO_MS - 1);
    const controller = new AbortController();
    const running = worker({ isReady: () => false }).worker.start(controller.signal);
    h.advance(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(state(id)).toBe("queued");
    expect(h.transport.sent).toEqual([]);
    controller.abort();
    await running;
  });

  it("on abort takes no new row and lets the send in flight finish within the drain", async () => {
    const first = await queued();
    const second = await queued();
    const gate = h.transport.gateSend();
    const controller = new AbortController();
    const { worker: w } = worker({}, { intervalMs: 5, drainMs: 1_000 });
    const running = w.start(controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    h.advance(UNDO_MS);
    w.wake(null);
    await gate.entered;
    controller.abort();
    setTimeout(gate.release, 20);
    await running;
    expect(h.transport.sent).toHaveLength(1);
    expect(["gone", "sent", "appending"]).toContain(state(first));
    expect(state(second)).toBe("queued");
  });

  it("a send still waiting behind the account's queue at abort never opens SMTP and stays queued", async () => {
    const id = await queued();
    let releaseQueue: (() => void) | null = null;
    void h.queue.run("acc_1", () => new Promise<void>((resolve) => (releaseQueue = resolve)));
    const controller = new AbortController();
    const { worker: w } = worker({}, { intervalMs: 5, drainMs: 1_000 });
    const running = w.start(controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    h.advance(UNDO_MS);
    w.wake(null);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    setTimeout(() => releaseQueue?.(), 20);
    await running;
    await new Promise((r) => setTimeout(r, 10));
    expect(h.transport.sent).toEqual([]);
    expect(state(id)).toBe("queued");
  });

  it("a send still in flight after the drain is aborted and start resolves", async () => {
    await queued();
    const signals: AbortSignal[] = [];
    const hanging = {
      verify: async () => undefined,
      send: (_config: SmtpConfig, _message: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<never>(() => undefined);
      },
    };
    const controller = new AbortController();
    const { worker: w } = worker({ transport: hanging }, { intervalMs: 5, drainMs: 20 });
    const running = w.start(controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    h.advance(UNDO_MS);
    w.wake(null);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    await running;
    expect(signals[0]!.aborted).toBe(true);
  });

  it("copies an idle draft to Drafts on a tick and reports the mail change", async () => {
    const { draftId } = await readyDraft();
    h.advance(SERVER_COPY_IDLE_MS);
    const changed: string[] = [];
    const controller = new AbortController();
    const running = worker({ mailChanged: (a) => changed.push(a) }).worker.start(controller.signal);
    await vi.waitFor(() => expect(h.store.getDraft(draftId)!.serverState).toBe("saved"));
    controller.abort();
    await running;
    expect(h.drafts.messages).toHaveLength(1);
    expect(changed).toEqual(["acc_1"]);
  });

  it("logs ids, counts and kinds only", async () => {
    const id = await queued();
    h.advance(UNDO_MS);
    h.store.claimDueOutbox(h.clock.now().toISOString(), []);
    const { worker: w, lines } = worker();
    const controller = new AbortController();
    const running = w.start(controller.signal);
    await vi.waitFor(() => expect(state(id)).toBe("unknown"));
    controller.abort();
    await running;
    const all = lines.join("\n");
    for (const secret of ["bob@example.com", "Invented plan", "Hello", "invented-password", "owner@example.org"]) {
      expect(all).not.toContain(secret);
    }
  });
});
