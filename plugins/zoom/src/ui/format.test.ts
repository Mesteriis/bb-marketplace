import { describe, expect, it } from "vitest";
import type { ZoomMeeting } from "../core/model.ts";
import { dayLabel, formatTime, nextMeeting, relativeStart, weekRangeLabel } from "./format.ts";

const at = (iso: string) => Date.parse(iso);
const meeting = (id: string, startTime: string | null, durationMinutes = 30): ZoomMeeting => ({
  id,
  topic: id,
  startTime,
  durationMinutes,
  joinUrl: `https://zoom.us/j/${id}`,
  passcode: null,
});

describe("formatTime", () => {
  it("shows 24-hour local time", () => {
    expect(formatTime("2026-11-23T10:05:00Z", "Europe/Moscow")).toBe("13:05");
    expect(formatTime("2026-11-23T21:00:00Z", "Europe/Moscow")).toBe("00:00");
  });
});

describe("dayLabel", () => {
  it("names the weekday and day of month", () => {
    expect(dayLabel("2026-11-23")).toEqual({ weekday: "пн", day: 23 });
    expect(dayLabel("2026-11-29")).toEqual({ weekday: "вс", day: 29 });
  });
});

describe("weekRangeLabel", () => {
  it.each([
    ["2026-11-23", "23–29 ноября 2026"],
    ["2026-11-30", "30 ноября – 6 декабря 2026"],
    ["2026-12-28", "28 декабря 2026 – 3 января 2027"],
  ])("week of %s reads %s", (weekStart, label) => {
    expect(weekRangeLabel(weekStart)).toBe(label);
  });
});

describe("relativeStart", () => {
  const start = at("2026-11-23T10:00:00Z");
  it.each([
    [start - 1, "через 1 мин"],
    [start - 59 * 60_000, "через 59 мин"],
    [start - 60 * 60_000, "через 1 ч"],
    [start - (23 * 60 + 59) * 60_000, "через 23 ч"],
    [start - 24 * 60 * 60_000, null],
    [start, "идёт сейчас"],
    [start + 30 * 60_000 - 1, "идёт сейчас"],
    [start + 30 * 60_000, null],
  ])("at %i reads %s", (now, expected) => {
    expect(relativeStart(start, now, 30)).toBe(expected);
  });
});

describe("nextMeeting", () => {
  const now = at("2026-11-23T10:00:00Z");
  it("picks the earliest meeting that has not ended", () => {
    const ended = meeting("ended", "2026-11-23T09:00:00Z", 60); // ends exactly now
    const running = meeting("running", "2026-11-23T09:45:00Z", 30);
    const later = meeting("later", "2026-11-23T12:00:00Z");
    expect(nextMeeting([later, ended, running], now)?.id).toBe("running");
  });

  it("ignores meetings with no fixed time and returns null when nothing is left", () => {
    expect(nextMeeting([meeting("open", null)], now)).toBeNull();
    expect(nextMeeting([], now)).toBeNull();
  });

  it("gives a meeting without a duration one hour", () => {
    expect(nextMeeting([meeting("m", "2026-11-23T09:00:01Z", 0)], now)?.id).toBe("m");
    expect(nextMeeting([meeting("m", "2026-11-23T09:00:00Z", 0)], now)).toBeNull();
  });
});
