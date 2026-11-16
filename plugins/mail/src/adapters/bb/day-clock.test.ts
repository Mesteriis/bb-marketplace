import { beforeEach, describe, expect, it } from "vitest";
import { localDay, type SyncOutcome } from "../../core/index.ts";
import { FixedClock, InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { DayNoticeBook, afterRoundAi, createDayClock, replyArrived, takeDayNotice, type DayClockSettings } from "./day-clock.ts";

/** Local time on 2026-11-16 (the digest and quiet hours follow the server's local clock). */
const at = (hours: number, minutes = 0, day = 16) => new Date(2026, 10, day, hours, minutes);

let store: InMemoryMailStore;
let clock: FixedClock;
let settings: DayClockSettings;
let published: string[];
let lines: string[];
let book: DayNoticeBook;

function idOf(folder: string, uid: number): string {
  return store.localFolderIndex("acc_1", folder, "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
}

beforeEach(() => {
  store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount());
  store.saveFolders("acc_1", [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
    { path: "Sent", name: "Sent", delimiter: "/", specialUse: "sent", selectable: true },
  ]);
  // A person writing to the owner, waiting for a reply.
  store.upsertMessages("acc_1", "INBOX", [
    makeFetchedMessage(1, { date: at(6).toISOString(), from: { name: "Ana Example", address: "ana@example.com" } }),
  ]);
  clock = new FixedClock(at(7, 59));
  settings = { morningDigest: true, digestTime: "08:00", quietHours: "", mailCategories: false };
  published = [];
  lines = [];
  let tokens = 0;
  book = new DayNoticeBook(() => `token-${++tokens}`);
});

function dayClock() {
  return createDayClock({
    store,
    settings: () => settings,
    publish: (token) => published.push(token),
    book,
    clock,
    isReady: () => true,
    log: (line) => lines.push(line),
  });
}

function reminder(id: string, overrides: Partial<Parameters<InMemoryMailStore["createReminder"]>[0]> = {}) {
  store.createReminder({
    id,
    accountId: "acc_1",
    outboxId: null,
    rfcMessageId: "<sent-1@example.org>",
    threadId: null,
    days: 3,
    sentAt: at(9, 0, 10).toISOString(),
    dueAt: at(9, 0, 13).toISOString(),
    state: "waiting",
    createdAt: at(9, 0, 10).toISOString(),
    ...overrides,
  });
}

describe("day clock", () => {
  it("builds today's digest once, at the first tick at or after the time; not before", () => {
    const tick = dayClock().tick;
    tick();
    expect(store.getDigest(localDay(at(7, 59)))).toBeNull();
    clock.set(at(8, 0));
    tick();
    const built = store.getDigest("2026-11-16")!;
    expect(built).toMatchObject({ replyCount: 1, notifiedAt: null });
    clock.set(at(9, 30));
    tick();
    expect(store.getDigest("2026-11-16")!.builtAt).toBe(built.builtAt);
    expect(published).toEqual(["token-1"]);
    expect(lines.filter((line) => line.startsWith("digest"))).toEqual(["digest 2026-11-16 built"]);
  });

  it("a late start builds the day at once; a missed day is not back-filled; off builds nothing", () => {
    clock.set(at(14, 0, 17));
    dayClock().tick();
    expect(store.getDigest("2026-11-17")).not.toBeNull();
    expect(store.getDigest("2026-11-16")).toBeNull();

    settings = { ...settings, morningDigest: false };
    clock.set(at(9, 0, 18));
    dayClock().tick();
    expect(store.getDigest("2026-11-18")).toBeNull();
  });

  it("inside quiet hours the digest is built but announced at the first tick after; kept until a window shows it", () => {
    settings = { ...settings, quietHours: "07:00-09:00" };
    clock.set(at(8, 0));
    const tick = dayClock().tick;
    tick();
    expect(store.getDigest("2026-11-16")).not.toBeNull();
    expect(published).toEqual([]);
    clock.set(at(9, 0));
    tick();
    expect(published).toEqual(["token-1"]);
    clock.set(at(9, 1));
    tick();
    expect(published).toEqual(["token-1"]);
    // A window opened later still gets it, once.
    expect(takeDayNotice(store, at(10, 0))).toEqual({ kind: "digest", day: "2026-11-16", replyCount: 1 });
    expect(takeDayNotice(store, at(10, 1))).toBeNull();
  });

  it("turns waiting reminders due at the tick, never answers them there, and announces each once", () => {
    reminder("r-due");
    reminder("r-later", { dueAt: at(9, 0, 20).toISOString() });
    // A stored reply would answer r-due, but the tick never scans references.
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(5, { date: at(9, 0, 11).toISOString(), inReplyTo: "<sent-1@example.org>", from: { name: null, address: "ana@example.com" } }),
    ]);
    settings = { ...settings, morningDigest: false };
    clock.set(at(10, 0));
    const tick = dayClock().tick;
    tick();
    tick();
    expect(store.getReminder("r-due")!.state).toBe("due");
    expect(store.getReminder("r-later")!.state).toBe("waiting");
    expect(published).toEqual(["token-1"]);
    const notice = takeDayNotice(store, at(10, 5));
    expect(notice).toMatchObject({ kind: "reminder", reminder: { id: "r-due" } });
    expect(takeDayNotice(store, at(10, 6))).toBeNull();
  });

  it("a snoozed reminder is announced again when it comes due a second time", () => {
    reminder("r-due");
    settings = { ...settings, morningDigest: false };
    clock.set(at(10, 0));
    const tick = dayClock().tick;
    tick();
    expect(published).toEqual(["token-1"]);
    expect(takeDayNotice(store, at(10, 1))).toMatchObject({ kind: "reminder", reminder: { id: "r-due" } });
    // The owner snoozes it for a day (as reminder_snooze does): waiting again, a new due time, unshown.
    store.updateReminder("r-due", { state: "waiting", days: 1, dueAt: at(10, 0, 14).toISOString(), notifiedAt: null }, at(10, 2).toISOString());
    clock.set(at(10, 0, 14));
    tick();
    expect(store.getReminder("r-due")!.state).toBe("due");
    expect(published).toEqual(["token-1", "token-2"]);
    tick();
    expect(published).toEqual(["token-1", "token-2"]);
  });

  it("a window asking inside quiet hours gets nothing and the notice stays unshown; it is announced again after", () => {
    settings = { ...settings, quietHours: "21:00-23:30" };
    clock.set(at(8, 0));
    const tick = dayClock().tick;
    tick();
    expect(published).toEqual(["token-1"]);
    // Nobody looked; the evening's quiet hours begin and a window opens.
    clock.set(at(22, 0));
    tick();
    expect(takeDayNotice(store, at(22, 0), settings.quietHours)).toBeNull();
    expect(store.getDigest("2026-11-16")!.notifiedAt).toBeNull();
    // After quiet hours the clock wakes the windows again, and the notice is shown once.
    clock.set(at(23, 30));
    tick();
    expect(published).toEqual(["token-1", "token-2"]);
    expect(takeDayNotice(store, at(23, 31), settings.quietHours)).toMatchObject({ kind: "digest" });
  });

  it("publishes tokens only and logs no address or subject", () => {
    reminder("r-due");
    clock.set(at(10, 0));
    dayClock().tick();
    expect(published.every((token) => /^token-\d+$/.test(token))).toBe(true);
    const log = lines.join("\n");
    expect(log).not.toContain("ana@example.com");
    expect(log).not.toContain("Invented");
  });

  it("does nothing while the vault is not ready", () => {
    clock.set(at(10, 0));
    createDayClock({ store, settings: () => settings, publish: (t) => published.push(t), book, clock, isReady: () => false }).tick();
    expect(store.getDigest("2026-11-16")).toBeNull();
  });
});

const ok = (fields: Partial<Extract<SyncOutcome, { status: "ok" }>>): Extract<SyncOutcome, { status: "ok" }> => ({
  status: "ok",
  fetched: 0,
  removed: 0,
  flagsChanged: 0,
  pushedSeen: 0,
  pushedFlags: 0,
  folders: 1,
  movesCancelled: [],
  newInbox: [],
  returning: [],
  inserted: [],
  ...fields,
});

describe("after a round", () => {
  const deps = (categoriesOn = true) => ({ store, clock, categoriesOn: () => categoriesOn, log: (line: string) => lines.push(line) });

  it("category rules label new, non-returning rows, never over the owner's label, and not while categories are off", () => {
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(2, { from: { name: null, address: "billing@example.net" } }),
      makeFetchedMessage(3, { from: { name: null, address: "billing@example.net" } }),
      makeFetchedMessage(4, { from: { name: null, address: "billing@example.net" } }),
    ]);
    const [fresh, returning, owned] = [idOf("INBOX", 2), idOf("INBOX", 3), idOf("INBOX", 4)];
    store.addCategoryRule("domain", "example.net", "bills", "rule-1", at(7).toISOString());
    store.setCategories([owned], "personal", "owner", at(7).toISOString());

    afterRoundAi(deps(false), "acc_1", ok({ newInbox: [fresh, returning, owned], returning: [returning] }));
    expect(store.categoriesOf([fresh]).get(fresh)!.category).toBeNull();

    afterRoundAi(deps(), "acc_1", ok({ newInbox: [fresh, returning, owned], returning: [returning] }));
    const labels = store.categoriesOf([fresh, returning, owned]);
    expect(labels.get(fresh)).toMatchObject({ category: "bills", source: "rule" });
    expect(labels.get(returning)!.category).toBeNull();
    expect(labels.get(owned)).toMatchObject({ category: "personal", source: "owner" });
  });

  it("answers reminders by In-Reply-To or References of the round's new rows, not the sent copy, not a bulk row", () => {
    reminder("r-1");
    reminder("r-2", { rfcMessageId: "<sent-2@example.org>" });
    reminder("r-3", { rfcMessageId: "<sent-3@example.org>" });
    store.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1, { messageId: "sent-1@example.org", date: at(9, 0, 10).toISOString() })]);
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(6, { date: at(9, 0, 11).toISOString(), inReplyTo: "sent-1@example.org" }),
      makeFetchedMessage(7, { date: at(9, 0, 11).toISOString(), references: ["<other@example.org>", "<sent-2@example.org>"] }),
      makeFetchedMessage(8, { date: at(9, 0, 11).toISOString(), inReplyTo: "<sent-3@example.org>", from: { name: null, address: "noreply@example.org" } }),
    ]);
    const inserted = [idOf("Sent", 1), idOf("INBOX", 6), idOf("INBOX", 7), idOf("INBOX", 8)];
    afterRoundAi(deps(false), "acc_1", ok({ inserted: [idOf("Sent", 1)] }));
    expect(store.getReminder("r-1")!.state).toBe("waiting");
    afterRoundAi(deps(false), "acc_1", ok({ inserted }));
    expect(store.getReminder("r-1")!.state).toBe("answered");
    expect(store.getReminder("r-2")!.state).toBe("answered");
    expect(store.getReminder("r-3")!.state).toBe("waiting");
  });

  it("replyArrived without a filter checks every stored row after the send (set and bind)", () => {
    reminder("r-1");
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(6, { date: at(9, 0, 9).toISOString(), inReplyTo: "<sent-1@example.org>" }),
    ]);
    expect(replyArrived(store, at(12).toISOString())).toBe(0);
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(9, { date: at(9, 0, 12).toISOString(), inReplyTo: "<sent-1@example.org>" }),
    ]);
    expect(replyArrived(store, at(12).toISOString())).toBe(1);
  });

  it("a referencing reply dated a few hours before the send (a skewed clock) still answers", () => {
    reminder("r-1");
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(6, { date: at(3, 0, 10).toISOString(), inReplyTo: "<sent-1@example.org>" }),
    ]);
    expect(replyArrived(store, at(12).toISOString())).toBe(1);
    expect(store.getReminder("r-1")!.state).toBe("answered");
  });
});

describe("rule notices (slice 3g)", () => {
  function rule(id: string, name: string) {
    store.saveRule(
      { id, name, enabled: true, match: { from: ["ana@example.com"] }, projectId: "p_api", template: "", mode: "prepare" },
      at(6).toISOString(),
    );
  }
  function run(id: string, ruleId: string, state: "ready" | "starting", minute: number) {
    const messageId = idOf("INBOX", 1);
    store.insertRuleRun(
      { id, ruleId, accountId: "acc_1", messageId: `${messageId}`, threadId: null, state, createdAt: at(9, minute).toISOString() },
      { perRuleHour: 3, perRuleDay: 10, allDay: 20 },
    );
  }

  it("announces each rule's new runs once and answers one notice per rule with its count", () => {
    rule("r_a", "Invented rule A");
    rule("r_b", "Invented rule B");
    store.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(2), makeFetchedMessage(3)]);
    store.insertRuleRun(
      { id: "run_1", ruleId: "r_a", accountId: "acc_1", messageId: idOf("INBOX", 1), threadId: null, state: "ready", createdAt: at(9, 0).toISOString() },
      { perRuleHour: 3, perRuleDay: 10, allDay: 20 },
    );
    store.insertRuleRun(
      { id: "run_2", ruleId: "r_a", accountId: "acc_1", messageId: idOf("INBOX", 2), threadId: null, state: "ready", createdAt: at(9, 1).toISOString() },
      { perRuleHour: 3, perRuleDay: 10, allDay: 20 },
    );
    store.insertRuleRun(
      { id: "run_3", ruleId: "r_b", accountId: "acc_1", messageId: idOf("INBOX", 3), threadId: null, state: "starting", createdAt: at(9, 2).toISOString() },
      { perRuleHour: 3, perRuleDay: 10, allDay: 20 },
    );
    store.updateRuleRun("run_3", { state: "started", bbThreadId: "bb_1" }, at(9, 2).toISOString());
    settings = { ...settings, morningDigest: false };
    clock.set(at(10, 0));
    const tick = dayClock().tick;
    tick();
    tick();
    expect(published).toEqual(["token-1", "token-2"]);
    expect(takeDayNotice(store, at(10, 1))).toEqual({ kind: "rule", ruleName: "Invented rule A", count: 2 });
    expect(takeDayNotice(store, at(10, 2))).toEqual({ kind: "rule", ruleName: "Invented rule B", count: 1 });
    expect(takeDayNotice(store, at(10, 3))).toBeNull();
    tick();
    expect(published).toHaveLength(2);
  });

  it("waits out quiet hours and skips runs of a deleted rule", () => {
    rule("r_a", "Invented rule A");
    run("run_1", "r_a", "ready", 0);
    expect(takeDayNotice(store, at(23, 0), "22:00-08:00")).toBeNull();
    store.deleteRule("r_a");
    expect(takeDayNotice(store, at(10, 0))).toBeNull();
    expect(store.getRuleRun("run_1")!.notifiedAt).not.toBeNull();
  });
});
