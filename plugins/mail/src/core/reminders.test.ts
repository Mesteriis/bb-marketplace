import { describe, expect, it } from "vitest";
import { ANSWERED_KEEP_DAYS, REMINDER_DAYS, REMINDERS_LIVE_MAX, answers, dueAt, reminderToastName } from "./reminders.ts";

const reminder = { rfcMessageId: "<sent-1@example.com>", sentAt: "2026-11-10T10:00:00.000Z" };

function row(overrides: Partial<Parameters<typeof answers>[1]> = {}): Parameters<typeof answers>[1] {
  return {
    messageId: "<reply-1@example.org>",
    inReplyTo: null,
    references: [],
    date: "2026-11-11T09:00:00.000Z",
    bulk: false,
    fromAddress: "friend@example.org",
    ...overrides,
  };
}

describe("answers", () => {
  it("states the limits", () => {
    expect(REMINDER_DAYS).toEqual({ min: 1, max: 30 });
    expect(REMINDERS_LIVE_MAX).toBe(500);
    expect(ANSWERED_KEEP_DAYS).toBe(30);
  });

  it("is answered by In-Reply-To or References", () => {
    expect(answers(reminder, row({ inReplyTo: "<sent-1@example.com>" }))).toBe(true);
    expect(answers(reminder, row({ references: ["<other@example.com>", " <sent-1@example.com> "] }))).toBe(true);
    expect(answers(reminder, row({ inReplyTo: "sent-1@example.com" }))).toBe(true);
  });

  it("counts a reply from the owner's other address", () => {
    expect(answers(reminder, row({ fromAddress: "me@example.org", inReplyTo: "<sent-1@example.com>" }))).toBe(true);
  });

  it("is not answered by the sent message itself, bulk, automated or earlier rows", () => {
    expect(answers(reminder, row({ messageId: "<sent-1@example.com>", references: ["<sent-1@example.com>"] }))).toBe(false);
    expect(answers(reminder, row({ bulk: true, inReplyTo: "<sent-1@example.com>" }))).toBe(false);
    expect(answers(reminder, row({ fromAddress: "mailer-daemon@example.org", inReplyTo: "<sent-1@example.com>" }))).toBe(false);
    expect(answers(reminder, row({ fromAddress: "noreply@example.org", bulk: false, inReplyTo: "<sent-1@example.com>" }))).toBe(false);
    expect(answers(reminder, row({ date: "2026-11-09T10:00:00.000Z", inReplyTo: "<sent-1@example.com>" }))).toBe(false);
    expect(answers(reminder, row({ date: null, inReplyTo: "<sent-1@example.com>" }))).toBe(false);
  });

  it("is not answered by a same-thread message without references", () => {
    expect(answers(reminder, row())).toBe(false);
  });
});

describe("dueAt", () => {
  it("adds calendar days", () => {
    expect(dueAt("2026-11-10T10:00:00.000Z", 3)).toBe(new Date(Date.parse("2026-11-10T10:00:00.000Z") + 3 * 86_400_000).toISOString());
  });

  it("keeps the local time of day across a DST change", () => {
    const sent = new Date(2026, 2, 27, 9, 30);
    const due = new Date(dueAt(sent.toISOString(), 3));
    expect(due.getHours()).toBe(9);
    expect(due.getMinutes()).toBe(30);
    expect(due.getDate()).toBe(30);
  });
});

describe("reminderToastName", () => {
  it("removes hidden characters and falls back to the address", () => {
    expect(reminderToastName("Ann\u200b Example", "ann@example.com")).toBe("Ann Example");
    expect(reminderToastName(null, "ann@example.com")).toBe("ann@example.com");
    expect([...reminderToastName("x".repeat(80), "a@example.com")]).toHaveLength(60);
  });
});
