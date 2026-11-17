// "Send later" (slice 3l): the owner picks the time a message goes out. The
// send waits in the Outbox as a `queued` row marked `scheduled`, with the
// picked time as its send time and as the message's Date. BB sends it while
// it runs; a send that came due while BB was closed still goes out on the
// next start when it is less than a day late, and is held for the owner
// after that.

/** The nearest time a send can be scheduled for. */
export const SCHEDULE_MIN_MS = 60_000;
/** The furthest. */
export const SCHEDULE_MAX_MS = 365 * 86_400_000;
/** How late a scheduled send may still go out on its own after BB was closed. */
export const SCHEDULE_LATE_MS = 86_400_000;

/** Whether `at` (ISO) is one minute to 365 days from now. */
export function validSendAt(at: string, now: Date): boolean {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return false;
  const ahead = time - now.getTime();
  return ahead >= SCHEDULE_MIN_MS && ahead <= SCHEDULE_MAX_MS;
}

export type SendLaterPresetId = "in_an_hour" | "this_evening" | "tomorrow_morning" | "tomorrow_afternoon" | "monday_morning";
export type SendLaterPreset = { id: SendLaterPresetId; label: string; at: Date };

/**
 * The composer's presets in local time: In an hour, This evening (18:00;
 * hidden from 17:00), Tomorrow morning (08:00), Tomorrow afternoon (13:00),
 * Monday morning (08:00; hidden on Sunday, when it is tomorrow morning).
 */
export function sendLaterPresets(now: Date): SendLaterPreset[] {
  const at = (dayOffset: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0, 0);
  const presets: SendLaterPreset[] = [{ id: "in_an_hour", label: "In an hour", at: new Date(now.getTime() + 3_600_000) }];
  if (now.getHours() < 17) presets.push({ id: "this_evening", label: "This evening", at: at(0, 18) });
  presets.push({ id: "tomorrow_morning", label: "Tomorrow morning", at: at(1, 8) });
  presets.push({ id: "tomorrow_afternoon", label: "Tomorrow afternoon", at: at(1, 13) });
  const day = now.getDay(); // 0 Sunday … 6 Saturday
  if (day !== 0) presets.push({ id: "monday_morning", label: "Monday morning", at: at(8 - day, 8) });
  return presets;
}
