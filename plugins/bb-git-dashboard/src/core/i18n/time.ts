import { format, type Language } from "./language.ts";

/** How long ago `at` was, short: "just now", "12 min", "2 h", "3 days"; empty for no time. */
export function ago(language: Language, now: number, at: string | null): string {
  const time = at ? Date.parse(at) : NaN;
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return format(language, "time.now");
  if (minutes < 60) return format(language, "time.minutes", {n: minutes});
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format(language, "time.hours", {n: hours});
  return format(language, "time.days", {n: Math.floor(hours / 24)});
}

/** A length of time in the words of the language: "8 s", "2 min 14 s", "1 h 2 min" (English "2m 14s"); empty for none. */
export function duration(language: Language, seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole % 3600 / 60), rest = whole % 60;
  if (hours) return format(language, "time.span-hours", {h: hours, m: minutes});
  if (minutes) return format(language, "time.span-minutes", {m: minutes, s: rest});
  return format(language, "time.span-seconds", {s: rest});
}
