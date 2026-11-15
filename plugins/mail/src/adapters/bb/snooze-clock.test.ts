import { afterEach, describe, expect, it, vi } from "vitest";
import { SNOOZE_RETRY_MS, type SnoozeState } from "../../core/index.ts";
import { InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { createAccountQueue } from "./account-queue.ts";
import { SNOOZE_TICK_MS, createSnoozeClock } from "./snooze-clock.ts";

const NOW = new Date("2026-11-16T10:00:00.000Z");
const PAST = "2026-11-16T09:00:00.000Z";
const LATER = "2026-11-17T08:00:00.000Z";

function setup(options: { ready?: boolean } = {}) {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: "acc_1", snoozeFolder: "Snoozed" }));
  store.saveFolders("acc_1", [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
    { path: "Snoozed", name: "Snoozed", delimiter: "/", specialUse: null, selectable: true },
    { path: "Lists", name: "Lists", delimiter: "/", specialUse: null, selectable: true },
  ]);
  const wakes: string[] = [];
  const notified: { accountId: string; ids: string[] }[] = [];
  const lines: string[] = [];
  let now = NOW;
  const state = { ready: options.ready ?? true };
  const queue = createAccountQueue();
  const clock = createSnoozeClock({
    store,
    queue,
    wake: (accountId) => wakes.push(accountId),
    notify: (accountId, ids) => {
      notified.push({ accountId, ids });
    },
    clock: { now: () => now },
    isReady: () => state.ready,
    log: (line) => lines.push(line),
  });
  /** A message stored in `folder`, with a snooze in `snoozeState`. */
  const snoozed = (uid: number, folder: string, snoozeState: SnoozeState, dueAt: string, returnTo = "INBOX") => {
    const [id] = store.upsertMessages("acc_1", folder, [makeFetchedMessage(uid, { seen: true })]).inserted;
    store.createSnoozes([{ messageId: id!, accountId: "acc_1", returnTo, dueAt, state: snoozeState }], NOW.toISOString());
    return id!;
  };
  const snoozeOf = (id: string) => store.listSnoozes("acc_1", { limit: 100 }).find((row) => row.messageId === id) ?? null;
  const rowOf = (id: string) => store.undoRows([id])[0] ?? null;
  return { store, clock, wakes, notified, lines, state, snoozed, snoozeOf, rowOf, queue, setNow: (d: Date) => (now = d) };
}

describe("createSnoozeClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moving, not due: waits; moving, due and still pending: cancels the move by CAS and deletes the snooze", async () => {
    const t = setup();
    const waiting = t.snoozed(1, "INBOX", "moving", LATER);
    const due = t.snoozed(2, "INBOX", "moving", PAST);
    t.store.queueMove([waiting], "Snoozed");
    t.store.queueMove([due], "Snoozed");
    await t.clock.tick();
    expect(t.snoozeOf(waiting)?.state).toBe("moving");
    expect(t.snoozeOf(due)).toBeNull();
    expect(t.rowOf(due)?.movePending ?? null).toBeNull();
    expect(t.wakes).toEqual(["acc_1"]);
  });

  it("moving and arrived: becomes snoozed; snoozed and due: queues the move back unread and becomes returning", async () => {
    const t = setup();
    const arrived = t.snoozed(1, "Snoozed", "moving", LATER);
    const due = t.snoozed(2, "Snoozed", "snoozed", PAST, "Lists");
    await t.clock.tick();
    expect(t.snoozeOf(arrived)?.state).toBe("snoozed");
    expect(t.snoozeOf(due)).toMatchObject({ state: "returning", returnTo: "Lists" });
    expect(t.rowOf(due)?.movePending).toBe("Lists");
    expect(t.store.pendingFlagIntents("acc_1", "Snoozed").find((p) => p.uid === 2)?.seen).toBe(false);
    // A full wake (never Inbox-only) of the account it moved.
    expect(t.wakes).toEqual(["acc_1"]);
  });

  it("a return whose folder is gone goes to the Inbox", async () => {
    const t = setup();
    const due = t.snoozed(1, "Snoozed", "snoozed", PAST, "Removed folder");
    await t.clock.tick();
    expect(t.snoozeOf(due)).toMatchObject({ state: "returning", returnTo: "INBOX" });
  });

  it("returning and back: deletes the snooze and hands it to notify; a cancelled return re-arms", async () => {
    const t = setup();
    const back = t.snoozed(1, "INBOX", "returning", PAST);
    const stuck = t.snoozed(2, "Snoozed", "returning", PAST);
    await t.clock.tick();
    expect(t.snoozeOf(back)).toBeNull();
    expect(t.notified).toEqual([{ accountId: "acc_1", ids: [back] }]);
    expect(t.snoozeOf(stuck)).toMatchObject({
      state: "snoozed",
      dueAt: new Date(NOW.getTime() + SNOOZE_RETRY_MS).toISOString(),
    });
    expect(t.wakes).toEqual([]);
  });

  it("a message moved elsewhere or gone drops its snooze quietly, without notify", async () => {
    const t = setup();
    const elsewhere = t.snoozed(1, "Lists", "snoozed", PAST);
    await t.clock.tick();
    expect(t.snoozeOf(elsewhere)).toBeNull();
    expect(t.notified).toEqual([]);
    expect(t.lines.join("\n")).toBe("snooze acc_1: returning 0, back 0, cancelled 0, dropped 1");
  });

  it("does nothing while the vault is not ready, or for an authFailed account", async () => {
    const t = setup({ ready: false });
    const due = t.snoozed(1, "Snoozed", "snoozed", PAST);
    await t.clock.tick();
    expect(t.snoozeOf(due)?.state).toBe("snoozed");
    t.state.ready = true;
    t.store.saveAccount({ ...t.store.getAccount("acc_1")!, authFailed: true });
    await t.clock.tick();
    expect(t.snoozeOf(due)?.state).toBe("snoozed");
  });

  it("runs inside the account's queue task", async () => {
    const t = setup();
    const due = t.snoozed(1, "Snoozed", "snoozed", PAST);
    let release!: () => void;
    const held = t.queue.run("acc_1", () => new Promise<void>((resolve) => (release = resolve)));
    const ticking = t.clock.tick(["acc_1"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.snoozeOf(due)?.state).toBe("snoozed");
    release();
    await held;
    await ticking;
    expect(t.snoozeOf(due)?.state).toBe("returning");
  });

  it("start returns overdue snoozes at once, then ticks every minute and after a round end", async () => {
    vi.useFakeTimers();
    const t = setup();
    const overdue = t.snoozed(1, "Snoozed", "snoozed", PAST);
    const controller = new AbortController();
    const done = t.clock.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.snoozeOf(overdue)?.state).toBe("returning");

    const soon = t.snoozed(2, "Snoozed", "snoozed", "2026-11-16T10:00:30.000Z");
    t.setNow(new Date("2026-11-16T10:01:00.000Z"));
    await vi.advanceTimersByTimeAsync(SNOOZE_TICK_MS);
    expect(t.snoozeOf(soon)?.state).toBe("returning");

    // The sync moved the first one back; the round end finishes it.
    t.store.completeMove("acc_1", "Snoozed", "INBOX", new Map([[1, 50]]), [1]);
    t.clock.roundEnded("acc_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.snoozeOf(overdue)).toBeNull();
    expect(t.notified).toEqual([{ accountId: "acc_1", ids: [overdue] }]);
    controller.abort();
    await done;
  });
});
