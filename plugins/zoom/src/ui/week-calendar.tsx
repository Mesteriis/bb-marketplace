// The week as seven agenda columns (one stacked list on a narrow page).
// Meetings are sparse, so days list their meetings instead of an hour grid.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CalendarWeek } from "../core/calendar.ts";
import type { ZoomMeeting } from "../core/model.ts";
import { dayLabel, formatTime, relativeStart } from "./format.ts";

interface WeekCalendarProps {
  week: CalendarWeek;
  /** Today's date key in the page's time zone. */
  today: string;
  timeZone: string;
  now: number;
  busyMeetingId: string | null;
  /** The meeting to lead with: the next one that has not ended. */
  nextMeetingId: string | null;
  onJoin: (meeting: ZoomMeeting) => void;
}

function durationText(minutes: number): string | null {
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes} мин`;
  const rest = minutes % 60;
  return rest === 0 ? `${minutes / 60} ч` : `${Math.floor(minutes / 60)} ч ${rest} мин`;
}

function MeetingCard({ meeting, timeZone, now, busy, primary, onJoin }: {
  meeting: ZoomMeeting;
  timeZone: string;
  now: number;
  busy: boolean;
  primary: boolean;
  onJoin: (meeting: ZoomMeeting) => void;
}) {
  const start = meeting.startTime === null ? null : Date.parse(meeting.startTime);
  const soon = start === null ? null : relativeStart(start, now, meeting.durationMinutes);
  const duration = durationText(meeting.durationMinutes);
  return (
    <li className="rounded-md border border-border bg-card p-2">
      <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
        {meeting.startTime !== null && <span className="font-medium tabular-nums text-foreground">{formatTime(meeting.startTime, timeZone)}</span>}
        {duration !== null && <span>{duration}</span>}
      </div>
      <p className="mt-0.5 break-words text-sm">{meeting.topic === "" ? "Без темы" : meeting.topic}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-xs", soon === "идёт сейчас" ? "font-medium text-foreground" : "text-muted-foreground")}>{soon ?? ""}</span>
        <Button size="sm" variant={primary ? "default" : "outline"} disabled={busy} onClick={() => onJoin(meeting)} aria-label={`Войти: ${meeting.topic}`}>
          {busy ? "Вхожу…" : "Войти"}
        </Button>
      </div>
    </li>
  );
}

export function WeekCalendar({ week, today, timeZone, now, busyMeetingId, nextMeetingId, onJoin }: WeekCalendarProps) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-7 md:gap-2">
        {week.days.map((day) => {
          const label = dayLabel(day.date);
          const isToday = day.date === today;
          return (
            <section
              key={day.date}
              aria-label={`${label.weekday} ${label.day}`}
              className={cn("min-w-0", day.events.length === 0 && !isToday && "hidden md:block")}
            >
              <h2 className={cn("mb-1.5 flex items-baseline gap-1.5 border-b pb-1 text-xs", isToday ? "border-foreground font-semibold" : "border-border text-muted-foreground")}>
                <span className="uppercase">{label.weekday}</span>
                <span className="tabular-nums">{label.day}</span>
                {isToday && <span className="ml-auto font-normal">сегодня</span>}
              </h2>
              {day.events.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">Нет встреч</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {day.events.map((event) => (
                    <MeetingCard key={event.meeting.id + (event.meeting.startTime ?? "")} meeting={event.meeting} timeZone={timeZone} now={now} busy={busyMeetingId === event.meeting.id} primary={nextMeetingId === event.meeting.id} onJoin={onJoin} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {week.unscheduled.length > 0 && (
        <section aria-label="Без времени">
          <h2 className="mb-1.5 border-b border-border pb-1 text-xs text-muted-foreground">Без времени</h2>
          <ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 md:grid-cols-3">
            {week.unscheduled.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} timeZone={timeZone} now={now} busy={busyMeetingId === meeting.id} primary={false} onJoin={onJoin} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
