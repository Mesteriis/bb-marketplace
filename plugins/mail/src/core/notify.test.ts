import { describe, expect, it } from "vitest";
import type { BlockRule } from "./blocking.ts";
import {
  NEW_MAIL_TOAST_ITEMS,
  NOTIFY_MAX_AGE_MS,
  inQuietHours,
  notifiable,
  parseQuietHours,
  toastName,
  type NotifyRow,
} from "./notify.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");

function row(id: string, extra: Partial<NotifyRow> = {}): NotifyRow {
  return {
    id,
    accountId: "a1",
    threadId: `t-${id}`,
    folderRole: "inbox",
    isRead: false,
    movePending: null,
    uid: 10,
    bulk: false,
    fromName: "Friend",
    fromAddress: "friend@example.com",
    date: "2026-11-15T11:50:00.000Z",
    fetchedAt: "2026-11-15T11:59:00.000Z",
    ...extra,
  };
}

const ctx = (extra: Partial<Parameters<typeof notifiable>[1]> = {}) => ({
  own: new Set(["owner@example.org"]),
  sentTo: new Set(["friend@example.com", "owner@example.org"]),
  rules: [] as BlockRule[],
  now: NOW,
  ...extra,
});
const ids = (rows: NotifyRow[]) => rows.map((r) => r.id);

describe("notifiable", () => {
  it("keeps unread Inbox mail from someone the owner wrote to", () => {
    expect(ids(notifiable([row("m1")], ctx()))).toEqual(["m1"]);
    expect(ids(notifiable([row("m1", { fromAddress: "Friend@Example.com" })], ctx()))).toEqual(["m1"]);
  });

  it("drops each excluded kind", () => {
    const rows = [
      row("read", { isRead: true }),
      row("bulk", { bulk: true }),
      row("automated", { bulk: null, fromAddress: "noreply@example.com" }),
      row("own", { fromAddress: "owner@example.org" }),
      row("stranger", { fromAddress: "stranger@example.com" }),
      row("blocked", { fromAddress: "friend@blocked.example" }),
      row("old", { date: "2026-11-15T05:59:00.000Z" }),
      row("moving", { movePending: "Archive" }),
      row("detached", { uid: null }),
      row("archive", { folderRole: "archive" }),
      row("plain", { folderRole: null }),
    ];
    const kept = notifiable(rows, ctx({
      sentTo: new Set(["friend@example.com", "owner@example.org", "noreply@example.com", "friend@blocked.example"]),
      rules: [{ id: "r1", kind: "domain", value: "blocked.example", createdAt: NOW.toISOString() }],
    }));
    expect(ids(kept)).toEqual([]);
  });

  it("measures age from the date, else the fetch time, at most six hours", () => {
    expect(NOTIFY_MAX_AGE_MS).toBe(6 * 3_600_000);
    expect(ids(notifiable([row("edge", { date: "2026-11-15T06:00:00.000Z" })], ctx()))).toEqual(["edge"]);
    expect(ids(notifiable([row("nodate", { date: null, fetchedAt: "2026-11-15T11:00:00.000Z" })], ctx()))).toEqual(["nodate"]);
    expect(ids(notifiable([row("oldfetch", { date: null, fetchedAt: "2026-11-14T11:00:00.000Z" })], ctx()))).toEqual([]);
    expect(ids(notifiable([row("bad", { date: "not a date", fetchedAt: "2026-11-15T11:00:00.000Z" })], ctx()))).toEqual(["bad"]);
  });

  it("lets a snooze return measure age from its return time", () => {
    const snoozed = row("s1", { date: "2026-11-01T09:00:00.000Z" });
    expect(ids(notifiable([snoozed], ctx()))).toEqual([]);
    expect(ids(notifiable([snoozed], ctx({ ageFrom: () => "2026-11-15T11:58:00.000Z" })))).toEqual(["s1"]);
  });
});

describe("quiet hours", () => {
  it("parses a range and refuses malformed text", () => {
    expect(parseQuietHours("22:00-08:00")).toEqual({ start: 22 * 60, end: 8 * 60 });
    expect(parseQuietHours(" 09:30\u201317:45 ")).toEqual({ start: 9 * 60 + 30, end: 17 * 60 + 45 });
    for (const text of ["", "  ", "24:00-08:00", "9:00-17:00", "22:00", "22:00-08:60", "x"]) {
      expect(parseQuietHours(text), text).toBeNull();
    }
  });

  it("is off with equal ends or no range", () => {
    expect(parseQuietHours("08:00-08:00")).toBeNull();
    expect(inQuietHours(null, 600)).toBe(false);
  });

  it("crosses midnight", () => {
    const night = parseQuietHours("22:00-08:00");
    expect(inQuietHours(night, 23 * 60)).toBe(true);
    expect(inQuietHours(night, 0)).toBe(true);
    expect(inQuietHours(night, 7 * 60 + 59)).toBe(true);
    expect(inQuietHours(night, 8 * 60)).toBe(false);
    expect(inQuietHours(night, 21 * 60 + 59)).toBe(false);
    expect(inQuietHours(night, 22 * 60)).toBe(true);
    const day = parseQuietHours("09:00-17:00");
    expect(inQuietHours(day, 9 * 60)).toBe(true);
    expect(inQuietHours(day, 17 * 60)).toBe(false);
    expect(inQuietHours(day, 3 * 60)).toBe(false);
  });
});

describe("toastName", () => {
  it("reveals hidden characters, keeps one line and caps at 60", () => {
    expect(toastName("Your\u200b Bank\u202e", "x@example.com")).toBe("Your Bank");
    expect(toastName("a\r\nb\tc", "x@example.com")).toBe("a b c");
    expect(toastName("N".repeat(100), "x@example.com")).toBe("N".repeat(60));
  });

  it("uses the address when the name is empty", () => {
    expect(toastName(null, "x@example.com")).toBe("x@example.com");
    expect(toastName(" \u200b ", "x@example.com")).toBe("x@example.com");
    expect(NEW_MAIL_TOAST_ITEMS).toBe(3);
  });
});
