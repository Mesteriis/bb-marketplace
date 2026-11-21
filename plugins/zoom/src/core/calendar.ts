// Lays meetings out on a Monday-to-Sunday week in a given time zone.
// Dates are plain "YYYY-MM-DD" keys; instants are converted with Intl.
import type { ZoomMeeting } from "./model.ts";

export interface CalendarEvent {
  readonly meeting: ZoomMeeting;
  /** Minutes after local midnight. */
  readonly startMinutes: number;
}

export interface CalendarDay {
  readonly date: string;
  readonly events: CalendarEvent[];
}

export interface CalendarWeek {
  readonly days: CalendarDay[];
  /** Meetings with no fixed time (recurring without a schedule). */
  readonly unscheduled: ZoomMeeting[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localParts(instant: number, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/** Calendar-date arithmetic done in UTC, so daylight saving never shifts a date. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date ("YYYY-MM-DD") of an instant in `timeZone`. */
export function localDate(instant: number, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

/** The Monday of the week that holds `instant` in `timeZone`. */
export function weekStartOf(instant: string | number, timeZone: string): string {
  const { date } = localParts(typeof instant === "number" ? instant : Date.parse(instant), timeZone);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 is Sunday
  return addDays(date, -((weekday + 6) % 7));
}

export function shiftWeek(weekStart: string, weeks: number): string {
  return addDays(weekStart, weeks * 7);
}

export function layoutWeek(meetings: readonly ZoomMeeting[], weekStart: string, timeZone: string): CalendarWeek {
  const days: CalendarDay[] = Array.from({ length: 7 }, (_, index) => ({ date: addDays(weekStart, index), events: [] }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const unscheduled: ZoomMeeting[] = [];

  for (const meeting of meetings) {
    const instant = meeting.startTime === null ? Number.NaN : Date.parse(meeting.startTime);
    if (Number.isNaN(instant)) {
      unscheduled.push(meeting);
      continue;
    }
    const { date, minutes } = localParts(instant, timeZone);
    byDate.get(date)?.events.push({ meeting, startMinutes: minutes });
  }
  for (const day of days) {
    day.events.sort(
      (left, right) => left.startMinutes - right.startMinutes || left.meeting.topic.localeCompare(right.meeting.topic, "ru"),
    );
  }
  return { days, unscheduled };
}
