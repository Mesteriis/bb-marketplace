import { describe, expect, it } from "vitest";
import type { Folder, SpecialUse } from "./model.ts";
import {
  SNOOZE_MAX_MS,
  SNOOZE_MIN_MS,
  SNOOZE_RETRY_MS,
  planSnoozes,
  snoozeFallbackName,
  snoozeFolderName,
  snoozePresets,
  validUntil,
  type SnoozeRow,
  type SnoozeView,
} from "./snooze.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const PAST = "2026-11-15T11:00:00.000Z";
const FUTURE = "2026-11-16T08:00:00.000Z";

function folder(path: string, specialUse: SpecialUse | null, selectable = true): Folder {
  return { accountId: "a1", path, name: path, specialUse, selectable, unreadCount: 0, totalCount: 0, subscribed: true };
}
const FOLDERS = [folder("INBOX", "inbox"), folder("Snoozed", null), folder("Work", null), folder("Old", null, false)];
const ctx = { snoozeFolder: "Snoozed", inbox: "INBOX", folders: FOLDERS, now: NOW };

function view(
  state: SnoozeRow["state"],
  dueAt: string,
  row: SnoozeView["row"],
  returnTo = "INBOX",
): SnoozeView {
  return { snooze: { messageId: "m1", accountId: "a1", returnTo, dueAt, state }, row };
}
const at = (folderPath: string, movePending: string | null = null, uid: number | null = 7) => ({
  folder: folderPath,
  uid,
  movePending,
});
const plan = (v: SnoozeView, c = ctx) => planSnoozes([v], c)[0];

describe("planSnoozes", () => {
  it("waits while the move to Snoozed is pending and not due", () => {
    expect(plan(view("moving", FUTURE, at("INBOX", "Snoozed")))).toEqual({ kind: "wait", messageId: "m1" });
  });

  it("cancels a pending move that became due: it never left", () => {
    expect(plan(view("moving", PAST, at("INBOX", "Snoozed")))).toEqual({
      kind: "cancel_move",
      messageId: "m1",
      accountId: "a1",
      folder: "INBOX",
      destination: "Snoozed",
    });
  });

  it("marks it snoozed once it sits in Snoozed", () => {
    expect(plan(view("moving", FUTURE, at("Snoozed")))).toEqual({ kind: "to_snoozed", messageId: "m1" });
  });

  it("waits for a detached row in Snoozed to be reattached", () => {
    expect(plan(view("moving", FUTURE, at("Snoozed", null, null)))).toEqual({ kind: "wait", messageId: "m1" });
    expect(plan(view("snoozed", PAST, at("Snoozed", null, null)))).toEqual({ kind: "wait", messageId: "m1" });
  });

  it("waits while snoozed and not due, and returns when due", () => {
    expect(plan(view("snoozed", FUTURE, at("Snoozed")))).toEqual({ kind: "wait", messageId: "m1" });
    expect(plan(view("snoozed", PAST, at("Snoozed"), "Work"))).toEqual({
      kind: "return",
      messageId: "m1",
      accountId: "a1",
      from: "Snoozed",
      to: "Work",
    });
  });

  it("returns to the Inbox when return_to is gone or not selectable", () => {
    expect(plan(view("snoozed", PAST, at("Snoozed"), "Gone"))).toMatchObject({ kind: "return", to: "INBOX" });
    expect(plan(view("snoozed", PAST, at("Snoozed"), "Old"))).toMatchObject({ kind: "return", to: "INBOX" });
  });

  it("is done when the row is back with nothing pending", () => {
    expect(plan(view("returning", PAST, at("INBOX")))).toEqual({ kind: "done", messageId: "m1" });
  });

  it("waits while the move back is pending", () => {
    expect(plan(view("returning", PAST, at("Snoozed", "INBOX")))).toEqual({ kind: "wait", messageId: "m1" });
  });

  it("re-arms in 15 minutes when the move back was cancelled", () => {
    expect(SNOOZE_RETRY_MS).toBe(15 * 60_000);
    expect(plan(view("returning", PAST, at("Snoozed")))).toEqual({
      kind: "rearm",
      messageId: "m1",
      dueAt: new Date(NOW.getTime() + SNOOZE_RETRY_MS).toISOString(),
    });
  });

  it("drops the snooze when the row went elsewhere or away", () => {
    expect(plan(view("moving", FUTURE, null))).toEqual({ kind: "drop", messageId: "m1" });
    expect(plan(view("moving", FUTURE, at("INBOX")))).toMatchObject({ kind: "drop" });
    expect(plan(view("moving", FUTURE, at("INBOX", "Archive")))).toMatchObject({ kind: "drop" });
    expect(plan(view("snoozed", FUTURE, at("Work")))).toMatchObject({ kind: "drop" });
    expect(plan(view("snoozed", FUTURE, at("Snoozed", "Trash")))).toMatchObject({ kind: "drop" });
    expect(plan(view("returning", PAST, at("Work")))).toMatchObject({ kind: "drop" });
    expect(plan(view("returning", PAST, null))).toMatchObject({ kind: "drop" });
  });

  it("plans every view in order", () => {
    const views = [view("snoozed", FUTURE, at("Snoozed")), { ...view("returning", PAST, at("INBOX")), snooze: { ...view("returning", PAST, null).snooze, messageId: "m2" } }];
    expect(planSnoozes(views, ctx).map((s) => [s.kind, s.messageId])).toEqual([["wait", "m1"], ["done", "m2"]]);
  });
});

describe("snooze folder names", () => {
  it("uses Snoozed (Makosh) on Gmail and Snoozed elsewhere", () => {
    expect(snoozeFolderName("gmail")).toBe("Snoozed (Makosh)");
    expect(snoozeFolderName("icloud")).toBe("Snoozed");
    expect(snoozeFolderName("other")).toBe("Snoozed");
    expect(snoozeFallbackName("gmail")).toBeNull();
    expect(snoozeFallbackName("icloud")).toBe("Snoozed (Makosh)");
    expect(snoozeFallbackName("other")).toBe("Snoozed (Makosh)");
  });
});

describe("snoozePresets", () => {
  const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
  const ids = (now: Date) => snoozePresets(now, "local").map((p) => p.id);
  const atOf = (now: Date, id: string) => snoozePresets(now, "local").find((p) => p.id === id)?.at;

  it("offers Later today until 18:00, three hours on rounded up to the hour", () => {
    // 2026-11-12 is a Thursday.
    expect(ids(local(2026, 11, 12, 17, 59))).toContain("later_today");
    expect(atOf(local(2026, 11, 12, 17, 59), "later_today")).toEqual(local(2026, 11, 12, 21));
    expect(atOf(local(2026, 11, 12, 9, 0), "later_today")).toEqual(local(2026, 11, 12, 12));
    expect(ids(local(2026, 11, 12, 18, 1))).not.toContain("later_today");
  });

  it("offers Tomorrow 08:00 and Next week Monday 08:00", () => {
    expect(atOf(local(2026, 11, 12, 10), "tomorrow")).toEqual(local(2026, 11, 13, 8));
    expect(atOf(local(2026, 11, 12, 10), "next_week")).toEqual(local(2026, 11, 16, 8));
    // On a Monday, next week is the Monday after.
    expect(atOf(local(2026, 11, 16, 10), "next_week")).toEqual(local(2026, 11, 23, 8));
    // On a Sunday, next week is tomorrow.
    expect(atOf(local(2026, 11, 15, 10), "next_week")).toEqual(local(2026, 11, 16, 8));
  });

  it("offers This weekend on weekdays only", () => {
    expect(atOf(local(2026, 11, 12, 10), "weekend")).toEqual(local(2026, 11, 14, 8));
    expect(atOf(local(2026, 11, 16, 10), "weekend")).toEqual(local(2026, 11, 21, 8));
    expect(ids(local(2026, 11, 14, 10))).not.toContain("weekend");
    expect(ids(local(2026, 11, 15, 10))).not.toContain("weekend");
  });

  it("labels each preset", () => {
    expect(snoozePresets(local(2026, 11, 12, 10), "local").map((p) => p.label)).toEqual([
      "Later today",
      "Tomorrow",
      "This weekend",
      "Next week",
    ]);
  });
});

describe("validUntil", () => {
  it("accepts five minutes to 365 days from now", () => {
    const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(validUntil(iso(SNOOZE_MIN_MS), NOW)).toBe(true);
    expect(validUntil(iso(SNOOZE_MIN_MS - 1), NOW)).toBe(false);
    expect(validUntil(iso(SNOOZE_MAX_MS), NOW)).toBe(true);
    expect(validUntil(iso(SNOOZE_MAX_MS + 1), NOW)).toBe(false);
    expect(validUntil("not a date", NOW)).toBe(false);
  });
});
