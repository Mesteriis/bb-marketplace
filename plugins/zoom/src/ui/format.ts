// Text and ordering helpers for the calendar. Month and weekday names are
// our own tables, so labels do not depend on the browser's locale data.
import type { ZoomMeeting } from "../core/model.ts";

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
] as const;
const MINUTE_MS = 60_000;
/** Zoom reports no duration for some meetings; assume an hour so they stay joinable. */
const DEFAULT_DURATION_MINUTES = 60;

export function formatTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(
    Date.parse(instant),
  );
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function dayLabel(date: string): { weekday: string; day: number } {
  const value = utcDate(date);
  return { weekday: WEEKDAYS[value.getUTCDay()]!, day: value.getUTCDate() };
}

export function weekRangeLabel(weekStart: string): string {
  const first = utcDate(weekStart);
  const last = new Date(first.getTime() + 6 * 24 * 60 * MINUTE_MS);
  const month = (value: Date) => MONTHS[value.getUTCMonth()]!;
  if (first.getUTCFullYear() !== last.getUTCFullYear()) {
    return `${first.getUTCDate()} ${month(first)} ${first.getUTCFullYear()} – ${last.getUTCDate()} ${month(last)} ${last.getUTCFullYear()}`;
  }
  if (first.getUTCMonth() !== last.getUTCMonth()) {
    return `${first.getUTCDate()} ${month(first)} – ${last.getUTCDate()} ${month(last)} ${last.getUTCFullYear()}`;
  }
  return `${first.getUTCDate()}–${last.getUTCDate()} ${month(last)} ${last.getUTCFullYear()}`;
}

function endOf(meeting: ZoomMeeting, start: number): number {
  return start + (meeting.durationMinutes > 0 ? meeting.durationMinutes : DEFAULT_DURATION_MINUTES) * MINUTE_MS;
}

/** "через 5 мин", "через 2 ч", "идёт сейчас", or null when it is over or more than a day away. */
export function relativeStart(start: number, now: number, durationMinutes: number): string | null {
  if (now >= start) {
    const end = start + (durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MINUTES) * MINUTE_MS;
    return now < end ? "идёт сейчас" : null;
  }
  const minutes = Math.ceil((start - now) / MINUTE_MS);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `через ${hours} ч` : null;
}

/** The earliest scheduled meeting that has not ended yet. */
export function nextMeeting(meetings: readonly ZoomMeeting[], now: number): ZoomMeeting | null {
  let best: { meeting: ZoomMeeting; start: number } | null = null;
  for (const meeting of meetings) {
    if (meeting.startTime === null) continue;
    const start = Date.parse(meeting.startTime);
    if (Number.isNaN(start) || endOf(meeting, start) <= now) continue;
    if (best === null || start < best.start) best = { meeting, start };
  }
  return best?.meeting ?? null;
}
