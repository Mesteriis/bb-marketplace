import { describe, expect, it } from "vitest";
import { layoutWeek, localDate, shiftWeek, weekStartOf } from "./calendar.ts";
import type { ZoomMeeting } from "./model.ts";

const meeting = (id: string, startTime: string | null, topic = id): ZoomMeeting => ({
  id,
  topic,
  startTime,
  durationMinutes: 30,
  joinUrl: `https://zoom.us/j/${id}`,
  passcode: null,
});

describe("weekStartOf", () => {
  it.each([
    ["2026-11-21T12:00:00Z", "UTC", "2026-11-16"], // Saturday
    ["2026-11-16T00:00:00Z", "UTC", "2026-11-16"], // Monday itself
    ["2026-11-22T23:59:59Z", "UTC", "2026-11-16"], // Sunday
    ["2026-11-22T21:30:00Z", "Europe/Moscow", "2026-11-23"], // already Monday in Moscow
    ["2027-01-01T05:00:00Z", "America/New_York", "2026-12-28"], // week spans the new year
  ])("%s in %s starts on %s", (instant, zone, expected) => {
    expect(weekStartOf(instant, zone)).toBe(expected);
  });
});

describe("localDate", () => {
  it("gives the calendar date of an instant in a zone", () => {
    expect(localDate(Date.parse("2026-11-22T21:30:00Z"), "Europe/Moscow")).toBe("2026-11-23");
    expect(localDate(Date.parse("2026-11-22T21:30:00Z"), "UTC")).toBe("2026-11-22");
  });
});

describe("shiftWeek", () => {
  it("moves across month and year ends", () => {
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftWeek("2026-03-02", -1)).toBe("2026-02-23");
    expect(shiftWeek("2026-11-16", 0)).toBe("2026-11-16");
  });
});

describe("layoutWeek", () => {
  it("returns seven days from the week start", () => {
    const week = layoutWeek([], "2026-11-23", "UTC");
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
    ]);
    expect(week.unscheduled).toEqual([]);
  });

  it("places a meeting on its local day and minute", () => {
    const late = meeting("1", "2026-11-22T21:30:00Z");
    const moscow = layoutWeek([late], "2026-11-23", "Europe/Moscow");
    expect(moscow.days[0]!.events).toEqual([{ meeting: late, startMinutes: 30 }]);
    // The same instant is still Sunday of the previous week in UTC.
    const utc = layoutWeek([late], "2026-11-23", "UTC");
    expect(utc.days.flatMap((day) => day.events)).toEqual([]);
  });

  it("keeps the last minute of Sunday and drops the first of next Monday", () => {
    const lastMinute = meeting("1", "2026-11-29T20:59:00Z");
    const nextWeek = meeting("2", "2026-11-29T21:00:00Z");
    const week = layoutWeek([lastMinute, nextWeek], "2026-11-23", "Europe/Moscow");
    expect(week.days[6]!.events).toEqual([{ meeting: lastMinute, startMinutes: 1439 }]);
    expect(week.days.flatMap((day) => day.events)).toHaveLength(1);
  });

  it("orders a day by start, then by topic", () => {
    const b = meeting("1", "2026-11-24T10:00:00Z", "Б");
    const a = meeting("2", "2026-11-24T10:00:00Z", "А");
    const early = meeting("3", "2026-11-24T08:00:00Z", "Я");
    const week = layoutWeek([b, a, early], "2026-11-23", "UTC");
    expect(week.days[1]!.events.map((event) => event.meeting.id)).toEqual(["3", "2", "1"]);
  });

  it("lists meetings with no fixed time separately", () => {
    const open = meeting("1", null);
    expect(layoutWeek([open], "2026-11-23", "UTC").unscheduled).toEqual([open]);
  });
});
