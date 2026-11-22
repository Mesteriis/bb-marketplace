// The connected state: week navigation, join by link, new meeting, the week
// itself, and the call panel once a meeting is joined.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { layoutWeek, localDate, shiftWeek, weekStartOf } from "../core/calendar.ts";
import type { WindowCalls } from "./window-calls";
import { CallAnchor } from "./call-anchor";
import type { NewMeeting, ZoomMeeting } from "../core/model.ts";
import { messageOf, type Notify, type ZoomPageApi } from "./api.ts";
import { CreateMeetingDialog } from "./create-meeting-dialog.tsx";
import { JoinByLink } from "./join-by-link.tsx";
import { nextMeeting, weekRangeLabel } from "./format.ts";
import { WeekCalendar } from "./week-calendar.tsx";

/** How often "через 5 мин" is recomputed. */
const TICK_MS = 30_000;

interface CalendarScreenProps {
  calls: WindowCalls;
  api: ZoomPageApi;
  displayName: string | null;
  callPageUrl: string | null;
  openExternal: (url: string) => void;
  notify: Notify;
  now: () => number;
  timeZone: string;
  onAccountChanged: () => void;
}

type Meetings = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; list: ZoomMeeting[] };

export function CalendarScreen({ calls, api, displayName, callPageUrl, openExternal, notify, now, timeZone, onAccountChanged }: CalendarScreenProps) {
  const [meetings, setMeetings] = useState<Meetings>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [moment, setMoment] = useState(now);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(now(), timeZone));
  const [createOpen, setCreateOpen] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  useSyncExternalStore(calls.subscribe, calls.snapshot);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listMeetings().then(
      (list) => !cancelled && setMeetings({ kind: "ready", list }),
      (error: unknown) => !cancelled && setMeetings({ kind: "error", message: messageOf(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setMoment(now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [now]);

  const list = meetings.kind === "ready" ? meetings.list : null;
  const week = useMemo(() => (list === null ? null : layoutWeek(list, weekStart, timeZone)), [list, weekStart, timeZone]);
  const today = localDate(moment, timeZone);

  const join = useCallback(
    async (key: string, link: string, asHost: boolean, title: string) => {
      const revision = calls.revision;
      setJoining(key);
      setJoinError(null);
      try {
        const call = await api.prepareCall({ link, asHost });
        if (calls.revision !== revision) return;
        if (callPageUrl === null) {
          openExternal(call.fallbackUrl);
          notify("info", "Звонок внутри BB работает только при локальном адресе BB. Открываю встречу в Zoom");
        } else {
          calls.show({ call, title: title || "Встреча Zoom", callPageUrl, openExternal,
            openInBrowser: () => {
              void api.openCallInBrowser({link, asHost}).then(({ url, opened }) => {
                if (!opened) openExternal(url);
              }).catch(error => notify("error", messageOf(error)));
            },
          }, true);
        }
      } catch (error) {
        setJoinError(messageOf(error));
      } finally {
        setJoining(null);
      }
    },
    [api, calls, callPageUrl, openExternal, notify],
  );

  async function create(input: NewMeeting, joinNow: boolean) {
    const meeting = await api.createMeeting(input);
    setReload((value) => value + 1);
    if (joinNow) void join(meeting.id, meeting.joinUrl, true, meeting.topic);
    else notify("success", "Встреча запланирована");
  }

  async function disconnect() {
    if (!confirmDisconnect) return setConfirmDisconnect(true);
    try {
      await api.disconnect();
      onAccountChanged();
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setConfirmDisconnect(false);
    }
  }

  if (calls.calendarMeeting) return <CallAnchor calls={calls} id={calls.calendarMeeting} />;

  const empty = week !== null && week.unscheduled.length === 0 && week.days.every((day) => day.events.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Предыдущая неделя" onClick={() => setWeekStart((value) => shiftWeek(value, -1))}>
            ‹
          </Button>
          <Button size="sm" variant="outline" onClick={() => setWeekStart(weekStartOf(now(), timeZone))}>
            Сегодня
          </Button>
          <Button size="sm" variant="ghost" aria-label="Следующая неделя" onClick={() => setWeekStart((value) => shiftWeek(value, 1))}>
            ›
          </Button>
        </div>
        <h1 className="text-sm font-medium tabular-nums">{weekRangeLabel(weekStart)}</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <JoinByLink busy={joining === "link"} onJoin={(link) => void join("link", link, false, "Встреча Zoom")} />
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Новая встреча
          </Button>
        </div>
      </header>
      {joinError !== null && (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
          {joinError}
        </p>
      )}
      <main className="min-h-0 flex-1 overflow-auto">
        {meetings.kind === "loading" && <p className="p-8 text-center text-sm text-muted-foreground">Загружаю встречи…</p>}
        {meetings.kind === "error" && (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p role="alert" className="text-sm text-destructive">
              {meetings.message}
            </p>
            <Button variant="outline" size="sm" onClick={() => { setReload((value) => value + 1); onAccountChanged(); }}>
              Повторить
            </Button>
          </div>
        )}
        {week !== null && empty && <p className="p-8 text-center text-sm text-muted-foreground">На этой неделе встреч нет</p>}
        {week !== null && !empty && (
          <WeekCalendar
            week={week}
            today={today}
            timeZone={timeZone}
            now={moment}
            busyMeetingId={joining}
            nextMeetingId={nextMeeting(list ?? [], moment)?.id ?? null}
            onJoin={(meeting) => void join(meeting.id, meeting.joinUrl, true, meeting.topic)}
          />
        )}
      </main>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{displayName ?? "Zoom"} · {timeZone}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>
            Обновить
          </Button>
          <Button size="sm" variant="ghost" className={confirmDisconnect ? "text-destructive" : undefined} onClick={() => void disconnect()} onBlur={() => setConfirmDisconnect(false)}>
            {confirmDisconnect ? "Точно отключить?" : "Отключить аккаунт"}
          </Button>
        </div>
      </footer>
      <CreateMeetingDialog open={createOpen} onOpenChange={setCreateOpen} timeZone={timeZone} onCreate={create} />
    </div>
  );
}
